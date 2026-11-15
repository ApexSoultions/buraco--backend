import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ClubInviteStatus, MemberStatus, NotificationType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OFFICERS, requireClubRole } from './club-access';
import { ClubsService } from './clubs.service';

const CLUB_SUMMARY = { id: true, name: true, iconUrl: true, mode: true, type: true, level: true, points: true, memberCount: true, maxMembers: true } as const;
const PLAYER_SUMMARY = { id: true, username: true, avatarUrl: true, country: true } as const;

/**
 * A club's leader or vice leader invites a player. The player accepts (joins the club,
 * even a "By Request" club, without the join-points minimum) or declines.
 */
@Injectable()
export class ClubInvitesService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private clubs: ClubsService,
  ) {}

  async invite(officerId: string, clubId: string, inviteeId: string) {
    await requireClubRole(this.prisma, officerId, clubId, OFFICERS);
    if (inviteeId === officerId) throw new BadRequestException('CANNOT_INVITE_SELF');

    const [club, invitee, inClub, block, pending] = await Promise.all([
      this.prisma.club.findUnique({ where: { id: clubId }, select: { name: true, memberCount: true, maxMembers: true } }),
      this.prisma.user.findFirst({ where: { id: inviteeId, isDeleted: false, isBanned: false }, select: { id: true } }),
      this.prisma.clubMember.findFirst({ where: { userId: inviteeId, status: MemberStatus.ACTIVE }, select: { id: true } }),
      this.prisma.block.findFirst({
        where: { OR: [{ blockerId: officerId, blockedId: inviteeId }, { blockerId: inviteeId, blockedId: officerId }] },
        select: { id: true },
      }),
      this.prisma.clubInvite.findFirst({ where: { clubId, inviteeId, status: ClubInviteStatus.PENDING }, select: { id: true } }),
    ]);
    if (!club) throw new NotFoundException('Club not found');
    if (!invitee || block) throw new NotFoundException('Player not found');
    if (inClub) throw new BadRequestException('PLAYER_ALREADY_IN_CLUB');
    if (club.memberCount >= club.maxMembers) throw new BadRequestException('CLUB_FULL');
    if (pending) throw new ConflictException('INVITE_ALREADY_SENT');

    const invite = await this.prisma.clubInvite.create({
      data: { clubId, inviterId: officerId, inviteeId },
      include: { invitee: { select: PLAYER_SUMMARY } },
    });

    const inviter = await this.prisma.user.findUnique({ where: { id: officerId }, select: { username: true } });
    await this.notifications.notifySafely(inviteeId, NotificationType.CLUB_INVITE, club.name,
      `${inviter?.username ?? 'A player'} invited you to join ${club.name}`,
      { event: 'CLUB_INVITE', clubId, inviteId: invite.id, inviterId: officerId });
    return invite;
  }

  /** Invites waiting for this player's answer. */
  async listMine(userId: string) {
    const data = await this.prisma.clubInvite.findMany({
      where: { inviteeId: userId, status: ClubInviteStatus.PENDING },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, createdAt: true,
        club: { select: CLUB_SUMMARY },
        inviter: { select: PLAYER_SUMMARY },
      },
    });
    return { data };
  }

  /** Invites this club has sent that are still unanswered (officers only). */
  async listForClub(officerId: string, clubId: string) {
    await requireClubRole(this.prisma, officerId, clubId, OFFICERS);
    const data = await this.prisma.clubInvite.findMany({
      where: { clubId, status: ClubInviteStatus.PENDING },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, createdAt: true,
        invitee: { select: PLAYER_SUMMARY },
        inviter: { select: { id: true, username: true } },
      },
    });
    return { data };
  }

  async accept(userId: string, inviteId: string) {
    const invite = await this.ownPendingInvite(userId, inviteId);
    // Joins first (seat, chat, mission, news); throws ALREADY_IN_CLUB / CLUB_FULL untouched.
    await this.clubs.admitMember(invite.clubId, userId);

    const now = new Date();
    await this.prisma.clubInvite.updateMany({ where: { id: inviteId, status: ClubInviteStatus.PENDING }, data: { status: ClubInviteStatus.ACCEPTED, respondedAt: now } });
    // One club per player: their other invites can no longer be accepted.
    await this.prisma.clubInvite.updateMany({
      where: { inviteeId: userId, status: ClubInviteStatus.PENDING, id: { not: inviteId } },
      data: { status: ClubInviteStatus.CANCELLED, respondedAt: now },
    });
    return { clubId: invite.clubId, joined: true };
  }

  async decline(userId: string, inviteId: string) {
    const invite = await this.ownPendingInvite(userId, inviteId);
    await this.prisma.clubInvite.updateMany({
      where: { id: invite.id, status: ClubInviteStatus.PENDING },
      data: { status: ClubInviteStatus.DECLINED, respondedAt: new Date() },
    });
    return { declined: true };
  }

  async cancel(officerId: string, clubId: string, inviteId: string) {
    await requireClubRole(this.prisma, officerId, clubId, OFFICERS);
    const res = await this.prisma.clubInvite.updateMany({
      where: { id: inviteId, clubId, status: ClubInviteStatus.PENDING },
      data: { status: ClubInviteStatus.CANCELLED, respondedAt: new Date() },
    });
    if (res.count === 0) throw new NotFoundException('Invite not found');
    return { cancelled: true };
  }

  private async ownPendingInvite(userId: string, inviteId: string) {
    const invite = await this.prisma.clubInvite.findUnique({ where: { id: inviteId } });
    if (!invite || invite.status !== ClubInviteStatus.PENDING) throw new NotFoundException('Invite not found');
    if (invite.inviteeId !== userId) throw new ForbiddenException('Not your invite');
    return invite;
  }
}
