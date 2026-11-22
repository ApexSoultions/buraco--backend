import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { CurrencyType, CustomCardStatus, NotificationType, TransactionType } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../common/prisma/prisma.service';
import { S3Service } from '../../common/s3/s3.service';
import { SPECIAL } from './special.config';

export const CUSTOM_CARD_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Custom Cards: a player uploads their own picture as a card back. It is paid when sent and
 * kept private in S3; an admin approves it (then the player can use it) or rejects it (the
 * coins come back). Only the owner sees their card back, through a short-lived signed link.
 */
@Injectable()
export class CustomCardsService {
  constructor(
    private prisma: PrismaService,
    private s3: S3Service,
    @Optional() private notifications?: NotificationsService,
  ) {}

  /** The player's custom cards, newest first, each with a 1-hour picture link. */
  async listMine(userId: string) {
    const cards = await this.prisma.customCard.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
    return this.withLinks(cards);
  }

  /** Upload a picture and pay for it; it waits for review. */
  async create(userId: string, file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('No picture provided');
    if (!CUSTOM_CARD_IMAGE_TYPES.includes(file.mimetype)) throw new BadRequestException('Pictures must be JPG, PNG or WebP');

    const price = SPECIAL.customCardPrice;
    const [user, pending] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { coins: true } }),
      this.prisma.customCard.count({ where: { userId, status: CustomCardStatus.PENDING } }),
    ]);
    if (!user) throw new NotFoundException('User not found');
    if (pending >= SPECIAL.customCardMaxPending) throw new ConflictException('CUSTOM_CARD_PENDING_LIMIT');
    // Checked again inside the charge; this just avoids uploading when it can't be paid.
    if (user.coins < price) throw new BadRequestException('INSUFFICIENT_BALANCE');

    const ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
    const key = `custom-cards/${userId}/${uuidv4()}.${ext}`;
    await this.s3.uploadPrivate(key, file.buffer, file.mimetype);

    const card = await this.prisma.$transaction(async (tx) => {
      const charged = await tx.user.updateMany({ where: { id: userId, coins: { gte: price } }, data: { coins: { decrement: price } } });
      if (charged.count === 0) throw new BadRequestException('INSUFFICIENT_BALANCE');
      const after = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { coins: true } });
      const created = await tx.customCard.create({ data: { userId, imageKey: key, pricePaid: price } });
      await tx.transaction.create({
        data: {
          userId, type: TransactionType.PURCHASE, currency: CurrencyType.COINS, amount: -price,
          balanceBefore: after.coins + price, balanceAfter: after.coins, referenceId: created.id, description: 'Special: custom card',
        },
      });
      return { created, coins: after.coins };
    });
    const [withLink] = await this.withLinks([card.created]);
    return { card: withLink, price, balance: { coins: card.coins } };
  }

  /** Use an approved custom card as the card back (instead of a Shop card back). */
  async equip(userId: string, id: string) {
    const card = await this.prisma.customCard.findFirst({ where: { id, userId } });
    if (!card) throw new NotFoundException('Card not found');
    if (card.status !== CustomCardStatus.APPROVED) throw new BadRequestException('CUSTOM_CARD_NOT_APPROVED');
    await this.prisma.$transaction([
      this.prisma.customCard.updateMany({ where: { userId, isEquipped: true }, data: { isEquipped: false } }),
      this.prisma.customCard.update({ where: { id }, data: { isEquipped: true } }),
      // One card back at a time: the Shop one is put away.
      this.prisma.inventory.updateMany({ where: { userId, isEquipped: true, item: { category: 'CARDS' } }, data: { isEquipped: false, equippedAt: null } }),
    ]);
    return { id, isEquipped: true };
  }

  // ── Admin review ────────────────────────────────────────────────────────

  /**
   * Cards to review: waiting ones oldest first (fair queue), decided ones newest first.
   * Each with a 1-hour picture link and the reviewing admin's name.
   */
  async listForReview(status: CustomCardStatus = CustomCardStatus.PENDING) {
    const cards = await this.prisma.customCard.findMany({
      where: { status },
      orderBy: { createdAt: status === CustomCardStatus.PENDING ? 'asc' : 'desc' },
      include: { user: { select: { id: true, username: true } } },
      take: 100,
    });
    const reviewerIds = [...new Set(cards.map((c) => c.reviewedBy).filter((v): v is string => !!v))];
    const reviewers = reviewerIds.length
      ? await this.prisma.adminUser.findMany({ where: { id: { in: reviewerIds } }, select: { id: true, name: true } })
      : [];
    const name = new Map(reviewers.map((r) => [r.id, r.name]));
    const withLinks = await this.withLinks(cards);
    return withLinks.map((c) => ({ ...c, reviewer: c.reviewedBy ? (name.get(c.reviewedBy) ?? 'Admin') : null }));
  }

  async approve(id: string, adminId: string) {
    const card = await this.prisma.customCard.findFirst({ where: { id, status: CustomCardStatus.PENDING }, select: { userId: true } });
    const updated = await this.prisma.customCard.updateMany({
      where: { id, status: CustomCardStatus.PENDING },
      data: { status: CustomCardStatus.APPROVED, reviewedBy: adminId, reviewedAt: new Date() },
    });
    if (!card || updated.count === 0) throw new NotFoundException('No card waiting for review with that id');
    await this.prisma.adminAuditLog.create({ data: { adminId, action: 'APPROVE_CUSTOM_CARD', targetType: 'CustomCard', targetId: id, details: { userId: card.userId } } });
    await this.notifications?.notifySafely(card.userId, NotificationType.SYSTEM, 'Custom card approved',
      'Your custom card back was approved. You can use it now in Shop → Special Features.', { customCardId: id, status: 'APPROVED' });
    return { id, status: CustomCardStatus.APPROVED };
  }

  /** Reject and give the coins back; the player is told why. */
  async reject(id: string, adminId: string, reason?: string) {
    const result = await this.rejectAndRefund(id, adminId, reason);
    await this.prisma.adminAuditLog.create({ data: { adminId, action: 'REJECT_CUSTOM_CARD', targetType: 'CustomCard', targetId: id, details: { userId: result.userId, reason: reason ?? null, refunded: result.refunded } } });
    const refund = result.refunded > 0 ? ` Your ${result.refunded.toLocaleString('en-US')} coins were refunded.` : '';
    await this.notifications?.notifySafely(result.userId, NotificationType.SYSTEM, 'Custom card not approved',
      `Your custom card back was not approved${reason ? `: ${reason.trim().replace(/[.!?]$/, '')}.` : '.'}${refund}`, { customCardId: id, status: 'REJECTED' });
    return { id: result.id, status: result.status, refunded: result.refunded };
  }

  private rejectAndRefund(id: string, adminId: string, reason?: string) {
    return this.prisma.$transaction(async (tx) => {
      const card = await tx.customCard.findFirst({ where: { id, status: CustomCardStatus.PENDING } });
      if (!card) throw new NotFoundException('No card waiting for review with that id');
      const updated = await tx.customCard.updateMany({
        where: { id, status: CustomCardStatus.PENDING },
        data: { status: CustomCardStatus.REJECTED, rejectReason: reason?.slice(0, 200) ?? null, reviewedBy: adminId, reviewedAt: new Date() },
      });
      if (updated.count === 0) throw new NotFoundException('No card waiting for review with that id');
      if (card.pricePaid > 0) {
        const after = await tx.user.update({ where: { id: card.userId }, data: { coins: { increment: card.pricePaid } }, select: { coins: true } });
        await tx.transaction.create({
          data: {
            userId: card.userId, type: TransactionType.REFUND, currency: CurrencyType.COINS, amount: card.pricePaid,
            balanceBefore: after.coins - card.pricePaid, balanceAfter: after.coins, referenceId: card.id, description: 'Refund: custom card rejected',
          },
        });
      }
      return { id, status: CustomCardStatus.REJECTED, refunded: card.pricePaid, userId: card.userId };
    });
  }

  private async withLinks<T extends { imageKey: string }>(cards: T[]) {
    const links = await this.s3.signUrls(cards.map((c) => c.imageKey));
    return cards.map(({ imageKey, ...rest }) => ({ ...rest, imageUrl: links.get(imageKey) ?? null }));
  }
}
