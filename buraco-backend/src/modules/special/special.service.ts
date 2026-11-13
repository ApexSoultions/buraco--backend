import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ClubRole, CurrencyType, MemberStatus, Prisma, TransactionType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SPECIAL, USERNAME_PATTERN } from './special.config';

type Tx = Prisma.TransactionClient;

/**
 * Special Features bought with coins: short usernames (1–3 characters), renames, club rename,
 * +10 club seats and +10 black list. Each purchase is one transaction: the coins are taken only
 * when the balance is enough and only together with the change itself.
 */
@Injectable()
export class SpecialService {
  constructor(private prisma: PrismaService) {}

  /** Prices and the player's current limits, for the Special Features page. */
  async features(userId: string) {
    const [user, membership] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { blockLimit: true, _count: { select: { blocksGiven: true } } } }),
      this.prisma.clubMember.findFirst({
        where: { userId, status: MemberStatus.ACTIVE },
        select: { role: true, club: { select: { id: true, name: true, memberCount: true, maxMembers: true } } },
      }),
    ]);
    return {
      shortNamePrice: SPECIAL.shortNamePrice,
      renamePrice: SPECIAL.renamePrice,
      clubRenamePrice: SPECIAL.clubRenamePrice,
      clubSeatsPrice: SPECIAL.clubSeatsPrice,
      clubSeatsStep: SPECIAL.clubSeatsStep,
      blockSlotsPrice: SPECIAL.blockSlotsPrice,
      blockSlotsStep: SPECIAL.blockSlotsStep,
      minFreeNameLength: SPECIAL.minFreeNameLength,
      blockLimit: user?.blockLimit ?? 0,
      blockedCount: user?._count.blocksGiven ?? 0,
      club: membership ? { ...membership.club, role: membership.role, isLeader: membership.role === ClubRole.LEADER } : null,
    };
  }

  /**
   * Short names for the "Buy N letters name" list: names of `length` characters starting with
   * `prefix`, in alphabet order, each with whether it can still be bought.
   */
  async listShortNames(length: number, prefix = '', limit = 30) {
    if (![1, 2, 3].includes(length)) throw new BadRequestException('length must be 1, 2 or 3');
    const start = (prefix ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, length);
    const names = this.generate(length, start, Math.min(Math.max(limit, 1), 60));
    if (names.length === 0) return { length, price: SPECIAL.shortNamePrice[length], names: [] };

    const taken = await this.prisma.user.findMany({
      where: { OR: names.map((n) => ({ username: { equals: n, mode: 'insensitive' as const } })) },
      select: { username: true },
    });
    const takenSet = new Set(taken.map((t) => t.username.toUpperCase()));
    return {
      length,
      price: SPECIAL.shortNamePrice[length],
      names: names.map((name) => ({ name, available: !takenSet.has(name) && !this.isReserved(name) })),
    };
  }

  /** Buys a 1–3 character username and makes it the player's name. */
  async buyShortName(userId: string, rawName: string) {
    const name = (rawName ?? '').trim().toUpperCase();
    const price = SPECIAL.shortNamePrice[name.length];
    if (!price || !/^[A-Z0-9]+$/.test(name)) throw new BadRequestException('INVALID_NAME');
    if (this.isReserved(name)) throw new ConflictException('USERNAME_TAKEN');
    // Buying the name you already have would just charge again.
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
    if (me?.username.toUpperCase() === name) throw new BadRequestException('That is already your name');
    await this.assertNameFree(name, userId);
    return this.chargeAndSetName(userId, name, price, `Special: ${name.length} letter name ${name}`);
  }

  /** "Change Your Name" (and Edit Name on the profile): a normal name, for the rename price. */
  async rename(userId: string, rawName: string) {
    const name = (rawName ?? '').trim();
    if (name.length < SPECIAL.minFreeNameLength || name.length > 20 || !USERNAME_PATTERN.test(name)) {
      throw new BadRequestException(`Names are ${SPECIAL.minFreeNameLength} to 20 letters, numbers or _ (shorter names are in Special Features)`);
    }
    if (this.isReserved(name)) throw new ConflictException('USERNAME_TAKEN');
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
    if (me?.username === name) throw new BadRequestException('That is already your name');
    await this.assertNameFree(name, userId);
    return this.chargeAndSetName(userId, name, SPECIAL.renamePrice, `Special: rename to ${name}`);
  }

  /** "Change Club Name": the club leader renames the club. */
  async renameClub(userId: string, clubId: string, rawName: string) {
    const name = (rawName ?? '').trim();
    if (name.length < 3 || name.length > 30) throw new BadRequestException('Club names are 3 to 30 characters');
    await this.requireLeader(userId, clubId);
    const taken = await this.prisma.club.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, NOT: { id: clubId } }, select: { id: true } });
    if (taken) throw new ConflictException('CLUB_NAME_TAKEN');

    return this.withCharge(userId, SPECIAL.clubRenamePrice, `Special: club name ${name}`, async (tx) => {
      try {
        await tx.club.update({ where: { id: clubId }, data: { name } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException('CLUB_NAME_TAKEN');
        throw err;
      }
      return { clubId, name };
    });
  }

  /** "+10 Clan Member": the club leader adds seats. */
  async addClubSeats(userId: string, clubId: string) {
    await this.requireLeader(userId, clubId);
    return this.withCharge(userId, SPECIAL.clubSeatsPrice, '+10 club seats', async (tx) => {
      const club = await tx.club.update({ where: { id: clubId }, data: { maxMembers: { increment: SPECIAL.clubSeatsStep } }, select: { maxMembers: true } });
      return { clubId, maxMembers: club.maxMembers };
    });
  }

  /** "+10 Black List". */
  async addBlockSlots(userId: string) {
    return this.withCharge(userId, SPECIAL.blockSlotsPrice, '+10 black list', async (tx) => {
      const user = await tx.user.update({ where: { id: userId }, data: { blockLimit: { increment: SPECIAL.blockSlotsStep } }, select: { blockLimit: true } });
      return { blockLimit: user.blockLimit };
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async chargeAndSetName(userId: string, name: string, price: number, description: string) {
    return this.withCharge(userId, price, description, async (tx) => {
      try {
        await tx.user.update({ where: { id: userId }, data: { username: name } });
      } catch (err) {
        // Someone took the name between the check and now.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException('USERNAME_TAKEN');
        throw err;
      }
      return { username: name };
    });
  }

  /** Takes `price` coins (only if the balance is enough) and runs `apply`, all in one transaction. */
  private async withCharge<T extends object>(userId: string, price: number, description: string, apply: (tx: Tx) => Promise<T>) {
    return this.prisma.$transaction(async (tx) => {
      const charged = await tx.user.updateMany({ where: { id: userId, coins: { gte: price } }, data: { coins: { decrement: price } } });
      if (charged.count === 0) throw new BadRequestException('INSUFFICIENT_BALANCE');
      const after = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { coins: true } });
      await tx.transaction.create({
        data: {
          userId, type: TransactionType.PURCHASE, currency: CurrencyType.COINS, amount: -price,
          balanceBefore: after.coins + price, balanceAfter: after.coins, description,
        },
      });
      const result = await apply(tx);
      return { ...result, price, balance: { coins: after.coins } };
    });
  }

  private async assertNameFree(name: string, userId: string) {
    const taken = await this.prisma.user.findFirst({
      where: { username: { equals: name, mode: 'insensitive' }, NOT: { id: userId } },
      select: { id: true },
    });
    if (taken) throw new ConflictException('USERNAME_TAKEN');
  }

  private async requireLeader(userId: string, clubId: string) {
    const member = await this.prisma.clubMember.findUnique({ where: { clubId_userId: { clubId, userId } }, select: { role: true, status: true } });
    if (!member || member.status !== MemberStatus.ACTIVE) throw new NotFoundException('Club not found');
    if (member.role !== ClubRole.LEADER) throw new ForbiddenException('ONLY_CLUB_LEADER');
  }

  private isReserved(name: string) {
    const lower = name.toLowerCase();
    return SPECIAL.reserved.some((r) => r === lower);
  }

  /** Names of `length` characters starting with `prefix`, in alphabet order. */
  private generate(length: number, prefix: string, limit: number): string[] {
    const abc = SPECIAL.nameAlphabet;
    const out: string[] = [];
    const rest = length - prefix.length;
    if (rest < 0) return out;
    if (rest === 0) return [prefix];
    const total = abc.length ** rest;
    for (let i = 0; i < total && out.length < limit; i++) {
      let n = i;
      let tail = '';
      for (let k = 0; k < rest; k++) {
        tail = abc[n % abc.length] + tail;
        n = Math.floor(n / abc.length);
      }
      out.push(prefix + tail);
    }
    return out;
  }
}
