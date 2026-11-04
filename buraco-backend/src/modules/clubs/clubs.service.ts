import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ClubRole, ClubType, MemberStatus, MissionRequirement, NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MissionsService } from '../missions/missions.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateClubDto } from './dto/create-club.dto';
import { UpdateClubDto } from './dto/update-club.dto';

/** Every 1000 club points is one level: level = floor(points / 1000) + 1. */
export const CLUB_POINTS_PER_LEVEL = 1000;

export function clubLevelFor(points: number): number {
  return Math.floor(Math.max(0, points) / CLUB_POINTS_PER_LEVEL) + 1;
}

const ROLE_LABEL: Record<ClubRole, string> = {
  [ClubRole.LEADER]: 'leader',
  [ClubRole.VICE_LEADER]: 'vice leader',
  [ClubRole.MEMBER]: 'member',
};

type Tx = Prisma.TransactionClient;

@Injectable()
export class ClubsService {
  private readonly logger = new Logger(ClubsService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private missions: MissionsService,
  ) {}

  async createClub(userId: string, dto: CreateClubDto) {
    const existing = await this.prisma.club.findUnique({ where: { name: dto.name } });
    if (existing) throw new ConflictException('CLUB_NAME_TAKEN');

    await this.assertNotInAnyClub(userId);

    const created = await this.prisma.$transaction(async (tx) => {
      const club = await tx.club.create({
        data: { ...dto, memberCount: 1 },
      });
      await tx.clubMember.create({ data: { clubId: club.id, userId, role: ClubRole.LEADER, status: MemberStatus.ACTIVE } });
      // The leader is the club chat's first member; everyone who joins later is added too.
      await tx.conversation.create({ data: { type: 'CLUB', clubId: club.id, members: { create: { userId } } } });
      return club;
    });
    await this.missions.updateProgressSafely(userId, MissionRequirement.JOIN_CLUB);
    return created;
  }

  async updateClub(userId: string, clubId: string, dto: UpdateClubDto) {
    await this.requireRole(userId, clubId, [ClubRole.LEADER]);
    if (dto.name) {
      const taken = await this.prisma.club.findUnique({ where: { name: dto.name }, select: { id: true } });
      if (taken && taken.id !== clubId) throw new ConflictException('CLUB_NAME_TAKEN');
    }
    return this.prisma.club.update({ where: { id: clubId }, data: dto });
  }

  /**
   * Deleting used to fail every time: the club's chat (and its messages) referenced the
   * club with no cascade, so the database refused. Chat goes first, then the club; members
   * are removed by the club_members cascade.
   */
  async deleteClub(userId: string, clubId: string) {
    await this.requireRole(userId, clubId, [ClubRole.LEADER]);
    const club = await this.prisma.club.findUnique({ where: { id: clubId }, select: { name: true } });
    const members = await this.prisma.clubMember.findMany({
      where: { clubId, status: MemberStatus.ACTIVE, userId: { not: userId } },
      select: { userId: true },
    });

    await this.prisma.$transaction(async (tx) => {
      const conv = await tx.conversation.findUnique({ where: { clubId }, select: { id: true } });
      if (conv) {
        await tx.message.deleteMany({ where: { conversationId: conv.id } });
        await tx.conversationMember.deleteMany({ where: { conversationId: conv.id } });
        await tx.conversation.delete({ where: { id: conv.id } });
      }
      await tx.club.delete({ where: { id: clubId } });
    });

    await this.notifications.notifySafely(members.map((m) => m.userId), NotificationType.CLUB_UPDATE,
      club?.name ?? 'Your club', `${club?.name ?? 'Your club'} was closed by its leader`, { clubId, event: 'CLUB_DELETED' });
    return { deleted: true };
  }

  async joinClub(userId: string, clubId: string) {
    const club = await this.prisma.club.findUnique({ where: { id: clubId } });
    if (!club) throw new NotFoundException('Club not found');
    if (club.type === ClubType.REQUEST_BASED) throw new ForbiddenException('CLUB_REQUEST_BASED');

    // Joining twice used to upsert the same row and still add 1 to memberCount.
    await this.assertNotInAnyClub(userId);

    const stats = await this.prisma.playerStats.findUnique({ where: { userId } });
    if (stats && stats.points < club.minPoints) throw new BadRequestException('INSUFFICIENT_POINTS');

    await this.prisma.$transaction(async (tx) => {
      await tx.clubMember.upsert({
        where: { clubId_userId: { clubId, userId } },
        create: { clubId, userId, role: ClubRole.MEMBER, status: MemberStatus.ACTIVE },
        update: { status: MemberStatus.ACTIVE, role: ClubRole.MEMBER },
      });
      await tx.club.update({ where: { id: clubId }, data: { memberCount: { increment: 1 } } });
      await this.addToClubChat(tx, clubId, userId);
    });

    await this.missions.updateProgressSafely(userId, MissionRequirement.JOIN_CLUB);

    const username = await this.usernameOf(userId);
    await this.notifications.notifySafely(await this.officerIds(clubId, userId), NotificationType.CLUB_UPDATE,
      club.name, `${username} joined the club`, { clubId, event: 'MEMBER_JOINED', userId, username });
  }

  async requestToJoin(userId: string, clubId: string) {
    const club = await this.prisma.club.findUnique({ where: { id: clubId }, select: { id: true } });
    if (!club) throw new NotFoundException('Club not found');

    const existing = await this.prisma.clubMember.findUnique({ where: { clubId_userId: { clubId, userId } } });
    if (existing) throw new ConflictException('Already a member or request pending');
    await this.assertNotInAnyClub(userId);

    await this.prisma.clubMember.create({ data: { clubId, userId, role: ClubRole.MEMBER, status: MemberStatus.PENDING } });

    const [name, username] = await Promise.all([this.clubName(clubId), this.usernameOf(userId)]);
    await this.notifications.notifySafely(await this.officerIds(clubId), NotificationType.CLUB_UPDATE,
      name, `${username} asked to join the club`, { clubId, event: 'JOIN_REQUEST', userId, username });
  }

  async respondToRequest(leaderId: string, clubId: string, memberId: string, accept: boolean) {
    await this.requireRole(leaderId, clubId, [ClubRole.LEADER, ClubRole.VICE_LEADER]);

    const member = await this.prisma.clubMember.findUnique({ where: { clubId_userId: { clubId, userId: memberId } } });
    if (!member || member.status !== MemberStatus.PENDING) throw new NotFoundException('Pending request not found');

    if (accept) {
      // They may have joined another club while this request was waiting.
      await this.assertNotInAnyClub(memberId);
      await this.prisma.$transaction(async (tx) => {
        await tx.clubMember.update({ where: { clubId_userId: { clubId, userId: memberId } }, data: { status: MemberStatus.ACTIVE } });
        await tx.club.update({ where: { id: clubId }, data: { memberCount: { increment: 1 } } });
        await this.addToClubChat(tx, clubId, memberId);
      });
      await this.missions.updateProgressSafely(memberId, MissionRequirement.JOIN_CLUB);
    } else {
      await this.prisma.clubMember.delete({ where: { clubId_userId: { clubId, userId: memberId } } });
    }

    const club = await this.clubName(clubId);
    await this.notifications.notifySafely(memberId,
      accept ? NotificationType.CLUB_REQUEST_ACCEPTED : NotificationType.CLUB_REQUEST_DECLINED,
      club, accept ? `Your request to join ${club} was accepted` : `Your request to join ${club} was declined`,
      { clubId });
  }

  async removeMember(leaderId: string, clubId: string, memberId: string) {
    const remover = await this.requireRole(leaderId, clubId, [ClubRole.LEADER, ClubRole.VICE_LEADER]);
    if (memberId === leaderId) throw new BadRequestException('Use leave to leave the club');

    const member = await this.prisma.clubMember.findUnique({ where: { clubId_userId: { clubId, userId: memberId } } });
    if (!member || member.status !== MemberStatus.ACTIVE) throw new NotFoundException('Member not found');
    // A vice leader may only remove plain members; nobody removes the leader.
    if (member.role === ClubRole.LEADER || (remover.role === ClubRole.VICE_LEADER && member.role !== ClubRole.MEMBER)) {
      throw new ForbiddenException('Insufficient club permissions');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.clubMember.delete({ where: { clubId_userId: { clubId, userId: memberId } } });
      await tx.club.update({ where: { id: clubId }, data: { memberCount: { decrement: 1 } } });
      await this.removeFromClubChat(tx, clubId, memberId);
    });

    const club = await this.clubName(clubId);
    await this.notifications.notifySafely(memberId, NotificationType.CLUB_UPDATE,
      club, `You were removed from ${club}`, { clubId, event: 'REMOVED' });
  }

  /**
   * Setting someone to LEADER hands leadership over: the old leader becomes vice leader,
   * so a club always has exactly one leader (and the old leader can then leave).
   */
  async assignRole(leaderId: string, clubId: string, memberId: string, role: ClubRole) {
    await this.requireRole(leaderId, clubId, [ClubRole.LEADER]);
    if (memberId === leaderId) throw new BadRequestException('Cannot change your own role');

    const member = await this.prisma.clubMember.findUnique({ where: { clubId_userId: { clubId, userId: memberId } } });
    if (!member || member.status !== MemberStatus.ACTIVE) throw new NotFoundException('Member not found');

    const updated = await this.prisma.$transaction(async (tx) => {
      if (role === ClubRole.LEADER) {
        await tx.clubMember.update({ where: { clubId_userId: { clubId, userId: leaderId } }, data: { role: ClubRole.VICE_LEADER } });
      }
      return tx.clubMember.update({ where: { clubId_userId: { clubId, userId: memberId } }, data: { role } });
    });

    const club = await this.clubName(clubId);
    await this.notifications.notifySafely(memberId, NotificationType.CLUB_UPDATE,
      club, `You are now ${ROLE_LABEL[role]} of ${club}`, { clubId, event: 'ROLE_CHANGED', role });
    return updated;
  }

  async leaveClub(userId: string, clubId: string) {
    const member = await this.prisma.clubMember.findUnique({ where: { clubId_userId: { clubId, userId } } });
    if (!member) throw new NotFoundException('Not a club member');
    if (member.role === ClubRole.LEADER && member.status === MemberStatus.ACTIVE) {
      throw new BadRequestException('Leader must transfer leadership before leaving');
    }

    const wasActive = member.status === MemberStatus.ACTIVE;
    await this.prisma.$transaction(async (tx) => {
      await tx.clubMember.delete({ where: { clubId_userId: { clubId, userId } } });
      // Withdrawing a pending request is not a member leaving: the count never included it.
      if (wasActive) {
        await tx.club.update({ where: { id: clubId }, data: { memberCount: { decrement: 1 } } });
        await this.removeFromClubChat(tx, clubId, userId);
      }
    });

    if (wasActive) {
      const [club, username] = await Promise.all([this.clubName(clubId), this.usernameOf(userId)]);
      await this.notifications.notifySafely(await this.officerIds(clubId, userId), NotificationType.CLUB_UPDATE,
        club, `${username} left the club`, { clubId, event: 'MEMBER_LEFT', userId, username });
    }
  }

  async getClub(clubId: string, requestingUserId?: string) {
    const club = await this.prisma.club.findUnique({
      where: { id: clubId },
      include: {
        members: {
          where: { status: MemberStatus.ACTIVE },
          include: { user: { select: { id: true, username: true, avatarUrl: true, stats: { select: { level: true } } } } },
        },
      },
    });
    if (!club) throw new NotFoundException('Club not found');

    let myRole: ClubRole | null = null;
    if (requestingUserId) {
      const membership = club.members.find((m) => m.userId === requestingUserId);
      myRole = membership?.role || null;
    }

    // Officers see who is waiting to join.
    const pendingRequests = myRole === ClubRole.LEADER || myRole === ClubRole.VICE_LEADER
      ? await this.prisma.clubMember.findMany({
          where: { clubId, status: MemberStatus.PENDING },
          include: { user: { select: { id: true, username: true, avatarUrl: true, stats: { select: { level: true, points: true } } } } },
          orderBy: { joinedAt: 'asc' },
        })
      : [];

    return { ...club, myRole, pendingRequests, ...this.levelProgress(club.points) };
  }

  /** Progress inside the current level; the old formula divided by level × 1000 and drifted. */
  levelProgress(points: number) {
    const pointsInLevel = Math.max(0, points) % CLUB_POINTS_PER_LEVEL;
    return {
      pointsPerLevel: CLUB_POINTS_PER_LEVEL,
      pointsInLevel,
      pointsToNextLevel: CLUB_POINTS_PER_LEVEL - pointsInLevel,
      progressToNextLevel: Math.floor((pointsInLevel / CLUB_POINTS_PER_LEVEL) * 100),
    };
  }

  async searchClubs(query?: string, mode?: string, type?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where: any = {};
    if (query) where.name = { contains: query, mode: 'insensitive' };
    if (mode) where.mode = mode;
    if (type) where.type = type;

    const [data, total] = await Promise.all([
      this.prisma.club.findMany({ where, skip, take: limit, orderBy: { memberCount: 'desc' } }),
      this.prisma.club.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  /**
   * Add points to a club and raise its level as far as the new total reaches (it used to
   * go up at most one level per call). Members are told when the club levels up.
   */
  async addClubPoints(clubId: string, points: number) {
    if (points <= 0) return null;
    const club = await this.prisma.club.update({
      where: { id: clubId },
      data: { points: { increment: points } },
    });

    const level = clubLevelFor(club.points);
    if (level > club.level) {
      // Conditional so two matches finishing together announce a level only once.
      const raised = await this.prisma.club.updateMany({ where: { id: clubId, level: { lt: level } }, data: { level } });
      if (raised.count === 1) {
        const members = await this.prisma.clubMember.findMany({
          where: { clubId, status: MemberStatus.ACTIVE },
          select: { userId: true },
        });
        await this.notifications.notifySafely(members.map((m) => m.userId), NotificationType.CLUB_UPDATE,
          club.name, `${club.name} reached level ${level}!`, { clubId, event: 'LEVEL_UP', level });
      }
      return { ...club, level };
    }
    return club;
  }

  /**
   * A finished match adds the points each player earned to that player's club.
   * Never throws: called right after a match is settled and paid.
   */
  async awardMatchPointsSafely(userId: string, pointsEarned: number) {
    if (pointsEarned <= 0) return;
    try {
      const membership = await this.prisma.clubMember.findFirst({
        where: { userId, status: MemberStatus.ACTIVE },
        select: { clubId: true },
      });
      if (membership) await this.addClubPoints(membership.clubId, pointsEarned);
    } catch (err) {
      this.logger.error(`Club points after match failed for ${userId}`, err as Error);
    }
  }

  /** One active club per player. */
  private async assertNotInAnyClub(userId: string) {
    const active = await this.prisma.clubMember.findFirst({ where: { userId, status: MemberStatus.ACTIVE }, select: { id: true } });
    if (active) throw new BadRequestException('ALREADY_IN_CLUB');
  }

  // Club chat membership follows club membership. Before, no one was ever added to a
  // club's conversation, so club chat refused every member, the leader included.
  private async addToClubChat(tx: Tx, clubId: string, userId: string) {
    const conv = await tx.conversation.findUnique({ where: { clubId }, select: { id: true } });
    const id = conv?.id ?? (await tx.conversation.create({ data: { type: 'CLUB', clubId }, select: { id: true } })).id;
    await tx.conversationMember.upsert({
      where: { conversationId_userId: { conversationId: id, userId } },
      create: { conversationId: id, userId },
      update: {},
    });
  }

  private async removeFromClubChat(tx: Tx, clubId: string, userId: string) {
    const conv = await tx.conversation.findUnique({ where: { clubId }, select: { id: true } });
    if (conv) await tx.conversationMember.deleteMany({ where: { conversationId: conv.id, userId } });
  }

  /** Active leader and vice leaders — the people who handle members — minus `exceptUserId`. */
  private async officerIds(clubId: string, exceptUserId?: string): Promise<string[]> {
    const officers = await this.prisma.clubMember.findMany({
      where: { clubId, status: MemberStatus.ACTIVE, role: { in: [ClubRole.LEADER, ClubRole.VICE_LEADER] } },
      select: { userId: true },
    });
    return officers.map((o) => o.userId).filter((id) => id !== exceptUserId);
  }

  private async clubName(clubId: string): Promise<string> {
    const club = await this.prisma.club.findUnique({ where: { id: clubId }, select: { name: true } });
    return club?.name ?? 'Your club';
  }

  private async usernameOf(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
    return user?.username ?? 'A player';
  }

  private async requireRole(userId: string, clubId: string, roles: ClubRole[]) {
    const member = await this.prisma.clubMember.findUnique({ where: { clubId_userId: { clubId, userId } } });
    if (!member || member.status !== MemberStatus.ACTIVE || !roles.includes(member.role)) {
      throw new ForbiddenException('Insufficient club permissions');
    }
    return member;
  }
}
