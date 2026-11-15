import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ClubInviteStatus, ClubObjective, ClubRole, ClubType, MemberStatus, MissionRequirement, NotificationType, Prisma, TransactionType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MatchProgress, MissionsService, matchChanges } from '../missions/missions.service';
import { EconomyService } from '../economy/economy.service';
import { ClubFeedService } from './club-feed.service';
import { ClubObjectivesService } from './club-objectives.service';
import { requireClubRole } from './club-access';
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
    @Optional() private feed?: ClubFeedService,
    @Optional() private objectives?: ClubObjectivesService,
    @Optional() private economy?: EconomyService,
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
    await this.feed?.logSafely(created.id, 'CREATED', `${await this.usernameOf(userId)} created the club`, userId);
    return created;
  }

  async updateClub(userId: string, clubId: string, dto: UpdateClubDto) {
    await this.requireRole(userId, clubId, [ClubRole.LEADER]);
    if (dto.name) {
      // Renaming a club is a paid Special Feature (POST /special/clubs/:clubId/name).
      const club = await this.prisma.club.findUnique({ where: { id: clubId }, select: { name: true } });
      if (club && club.name !== dto.name) throw new BadRequestException('CLUB_RENAME_IN_SPECIAL_FEATURES');
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
      await this.takeSeat(tx, clubId);
      await tx.clubMember.upsert({
        where: { clubId_userId: { clubId, userId } },
        create: { clubId, userId, role: ClubRole.MEMBER, status: MemberStatus.ACTIVE },
        update: { status: MemberStatus.ACTIVE, role: ClubRole.MEMBER },
      });
      await this.addToClubChat(tx, clubId, userId);
    });

    await this.missions.updateProgressSafely(userId, MissionRequirement.JOIN_CLUB);

    const username = await this.usernameOf(userId);
    await this.feed?.logSafely(clubId, 'JOINED', `${username} joined the club`, userId);
    await this.notifications.notifySafely(await this.officerIds(clubId, userId), NotificationType.CLUB_UPDATE,
      club.name, `${username} joined the club`, { clubId, event: 'MEMBER_JOINED', userId, username });
  }

  /**
   * Join through an accepted invite: no "By Request" check and no join-points minimum, but
   * still one club per player and a free seat. A pending join request becomes membership.
   */
  async admitMember(clubId: string, userId: string) {
    const club = await this.prisma.club.findUnique({ where: { id: clubId }, select: { name: true } });
    if (!club) throw new NotFoundException('Club not found');
    await this.assertNotInAnyClub(userId);

    await this.prisma.$transaction(async (tx) => {
      await this.takeSeat(tx, clubId);
      await tx.clubMember.upsert({
        where: { clubId_userId: { clubId, userId } },
        create: { clubId, userId, role: ClubRole.MEMBER, status: MemberStatus.ACTIVE },
        update: { status: MemberStatus.ACTIVE, role: ClubRole.MEMBER },
      });
      await this.addToClubChat(tx, clubId, userId);
    });
    await this.missions.updateProgressSafely(userId, MissionRequirement.JOIN_CLUB);

    const username = await this.usernameOf(userId);
    await this.feed?.logSafely(clubId, 'JOINED', `${username} joined the club`, userId, { via: 'INVITE' });
    await this.notifications.notifySafely(await this.officerIds(clubId, userId), NotificationType.CLUB_UPDATE,
      club.name, `${username} accepted the invite and joined`, { clubId, event: 'MEMBER_JOINED', userId, username });
  }

  /** "Clear All" on the Invites tab: decline every waiting join request. */
  async declineAllRequests(officerId: string, clubId: string) {
    await this.requireRole(officerId, clubId, [ClubRole.LEADER, ClubRole.VICE_LEADER]);
    const pending = await this.prisma.clubMember.findMany({ where: { clubId, status: MemberStatus.PENDING }, select: { userId: true } });
    if (pending.length === 0) return { declined: 0 };
    await this.prisma.clubMember.deleteMany({ where: { clubId, status: MemberStatus.PENDING } });
    const name = await this.clubName(clubId);
    await this.notifications.notifySafely(pending.map((p) => p.userId), NotificationType.CLUB_REQUEST_DECLINED,
      name, `Your request to join ${name} was declined`, { clubId });
    return { declined: pending.length };
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
        await this.takeSeat(tx, clubId);
        await tx.clubMember.update({ where: { clubId_userId: { clubId, userId: memberId } }, data: { status: MemberStatus.ACTIVE } });
        await this.addToClubChat(tx, clubId, memberId);
      });
      await this.missions.updateProgressSafely(memberId, MissionRequirement.JOIN_CLUB);
      await this.feed?.logSafely(clubId, 'JOINED', `${await this.usernameOf(memberId)} joined the club`, memberId);
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
    await this.feed?.logSafely(clubId, 'REMOVED', `${await this.usernameOf(memberId)} was removed from the club`, memberId);
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
    await this.feed?.logSafely(clubId, 'ROLE_CHANGED', `${await this.usernameOf(memberId)} is now ${ROLE_LABEL[role]}`, memberId, { role });
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
      await this.feed?.logSafely(clubId, 'LEFT', `${username} left the club`, userId);
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
          include: { user: { select: { id: true, username: true, avatarUrl: true, country: true, stats: { select: { level: true } } } } },
        },
      },
    });
    if (!club) throw new NotFoundException('Club not found');

    // Leader, vice leaders, then members by the points they earned for the club.
    const order: Record<ClubRole, number> = { [ClubRole.LEADER]: 0, [ClubRole.VICE_LEADER]: 1, [ClubRole.MEMBER]: 2 };
    club.members.sort((a, b) => order[a.role] - order[b.role] || (b.points ?? 0) - (a.points ?? 0));

    let myRole: ClubRole | null = null;
    // ACTIVE (member), PENDING (asked to join) or null; myInviteId: an invite waiting for me.
    let myStatus: MemberStatus | null = null;
    let myInviteId: string | null = null;
    if (requestingUserId) {
      const membership = club.members.find((m) => m.userId === requestingUserId);
      myRole = membership?.role || null;
      myStatus = membership ? MemberStatus.ACTIVE : null;
      if (!membership) {
        const [request, invite] = await Promise.all([
          this.prisma.clubMember.findUnique({ where: { clubId_userId: { clubId, userId: requestingUserId } }, select: { status: true } }),
          this.prisma.clubInvite.findFirst({ where: { clubId, inviteeId: requestingUserId, status: ClubInviteStatus.PENDING }, select: { id: true } }),
        ]);
        myStatus = request?.status ?? null;
        myInviteId = invite?.id ?? null;
      }
    }

    // Officers see who is waiting to join.
    const pendingRequests = myRole === ClubRole.LEADER || myRole === ClubRole.VICE_LEADER
      ? await this.prisma.clubMember.findMany({
          where: { clubId, status: MemberStatus.PENDING },
          include: { user: { select: { id: true, username: true, avatarUrl: true, stats: { select: { level: true, points: true } } } } },
          orderBy: { joinedAt: 'asc' },
        })
      : [];

    return { ...club, myRole, myStatus, myInviteId, pendingRequests, nextLevel: club.level + 1, ...this.levelProgress(club.points) };
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
        await this.feed?.logSafely(clubId, 'LEVEL_UP', `The club reached level ${level}`, undefined, { level });
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
      if (membership) await this.addMemberPoints(membership.clubId, userId, pointsEarned);
    } catch (err) {
      this.logger.error(`Club points after match failed for ${userId}`, err as Error);
    }
  }

  /**
   * Everything a finished match gives the player's club: points (the club's, and the
   * member's own "Point" on their card) and progress on this week's Clan Objectives, paying
   * any objective it completes. Never throws: called right after a match is settled and paid.
   */
  async recordMatchSafely(userId: string, match: MatchProgress) {
    try {
      const membership = await this.prisma.clubMember.findFirst({
        where: { userId, status: MemberStatus.ACTIVE },
        select: { clubId: true },
      });
      if (!membership) return;
      if (match.pointsEarned > 0) await this.addMemberPoints(membership.clubId, userId, match.pointsEarned);
      const done = (await this.objectives?.advance(membership.clubId, matchChanges(match), match.mode)) ?? [];
      for (const objective of done) await this.payObjective(membership.clubId, objective);
    } catch (err) {
      this.logger.error(`Club progress after match failed for ${userId}`, err as Error);
    }
  }

  private async addMemberPoints(clubId: string, userId: string, points: number) {
    await this.addClubPoints(clubId, points);
    await this.prisma.clubMember.updateMany({ where: { clubId, userId, status: MemberStatus.ACTIVE }, data: { points: { increment: points } } });
  }

  /** A completed objective: coins to every active member, points to the club, news, notice. */
  private async payObjective(clubId: string, objective: ClubObjective) {
    const members = await this.prisma.clubMember.findMany({ where: { clubId, status: MemberStatus.ACTIVE }, select: { userId: true } });
    if (objective.rewardCoins > 0 && this.economy) {
      for (const m of members) {
        try {
          await this.economy.addCoins(m.userId, objective.rewardCoins, TransactionType.CLUB_OBJECTIVE_REWARD, objective.id, objective.title);
        } catch (err) {
          this.logger.error(`Objective reward failed for ${m.userId}`, err as Error);
        }
      }
    }
    if (objective.rewardClubPoints > 0) await this.addClubPoints(clubId, objective.rewardClubPoints);

    const name = await this.clubName(clubId);
    await this.feed?.logSafely(clubId, 'OBJECTIVE_COMPLETED', `The club completed "${objective.title}"`, undefined,
      { objectiveId: objective.id, rewardCoins: objective.rewardCoins, rewardClubPoints: objective.rewardClubPoints });
    await this.notifications.notifySafely(members.map((m) => m.userId), NotificationType.CLUB_UPDATE, name,
      objective.rewardCoins > 0
        ? `${name} completed "${objective.title}": +${objective.rewardCoins} coins for you`
        : `${name} completed "${objective.title}"`,
      { clubId, event: 'OBJECTIVE_COMPLETED', objectiveId: objective.id, rewardCoins: objective.rewardCoins });
  }

  /** One active club per player. */
  /**
   * Counts a new member in, only while the club has a free seat (maxMembers; Special Features
   * "+10 Clan Member" adds seats). In the same transaction as the join, so two joins at once
   * can't both take the last seat.
   */
  private async takeSeat(tx: Tx, clubId: string) {
    const club = await tx.club.findUnique({ where: { id: clubId }, select: { maxMembers: true } });
    const seated = await tx.club.updateMany({
      where: { id: clubId, memberCount: { lt: club?.maxMembers ?? 0 } },
      data: { memberCount: { increment: 1 } },
    });
    if (seated.count === 0) throw new BadRequestException('CLUB_FULL');
  }

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
    return requireClubRole(this.prisma, userId, clubId, roles);
  }
}
