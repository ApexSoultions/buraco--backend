import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ClubRole, ClubType, MemberStatus, NotificationType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateClubDto } from './dto/create-club.dto';

const ROLE_LABEL: Record<ClubRole, string> = {
  [ClubRole.LEADER]: 'leader',
  [ClubRole.VICE_LEADER]: 'vice leader',
  [ClubRole.MEMBER]: 'member',
};

@Injectable()
export class ClubsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  async createClub(userId: string, dto: CreateClubDto) {
    const existing = await this.prisma.club.findUnique({ where: { name: dto.name } });
    if (existing) throw new ConflictException('CLUB_NAME_TAKEN');

    const userClub = await this.prisma.clubMember.findFirst({ where: { userId, status: MemberStatus.ACTIVE } });
    if (userClub) throw new BadRequestException('ALREADY_IN_CLUB');

    return this.prisma.$transaction(async (tx) => {
      const club = await tx.club.create({
        data: { ...dto, memberCount: 1 },
      });
      await tx.clubMember.create({ data: { clubId: club.id, userId, role: ClubRole.LEADER, status: MemberStatus.ACTIVE } });
      await tx.conversation.create({ data: { type: 'CLUB', clubId: club.id } });
      return club;
    });
  }

  async updateClub(userId: string, clubId: string, dto: Partial<CreateClubDto>) {
    await this.requireRole(userId, clubId, [ClubRole.LEADER]);
    return this.prisma.club.update({ where: { id: clubId }, data: dto });
  }

  async deleteClub(userId: string, clubId: string) {
    await this.requireRole(userId, clubId, [ClubRole.LEADER]);
    return this.prisma.club.delete({ where: { id: clubId } });
  }

  async joinClub(userId: string, clubId: string) {
    const club = await this.prisma.club.findUnique({ where: { id: clubId } });
    if (!club) throw new NotFoundException('Club not found');
    if (club.type === ClubType.REQUEST_BASED) throw new ForbiddenException('CLUB_REQUEST_BASED');

    const stats = await this.prisma.playerStats.findUnique({ where: { userId } });
    if (stats && stats.points < club.minPoints) throw new BadRequestException('INSUFFICIENT_POINTS');

    await this.prisma.$transaction(async (tx) => {
      await tx.clubMember.upsert({
        where: { clubId_userId: { clubId, userId } },
        create: { clubId, userId, role: ClubRole.MEMBER, status: MemberStatus.ACTIVE },
        update: { status: MemberStatus.ACTIVE },
      });
      await tx.club.update({ where: { id: clubId }, data: { memberCount: { increment: 1 } } });
    });

    const username = await this.usernameOf(userId);
    await this.notifications.notifySafely(await this.officerIds(clubId, userId), NotificationType.CLUB_UPDATE,
      club.name, `${username} joined the club`, { clubId, event: 'MEMBER_JOINED', userId, username });
  }

  async requestToJoin(userId: string, clubId: string) {
    const existing = await this.prisma.clubMember.findUnique({ where: { clubId_userId: { clubId, userId } } });
    if (existing) throw new ConflictException('Already a member or request pending');

    await this.prisma.clubMember.create({ data: { clubId, userId, role: ClubRole.MEMBER, status: MemberStatus.PENDING } });

    const [club, username] = await Promise.all([this.clubName(clubId), this.usernameOf(userId)]);
    await this.notifications.notifySafely(await this.officerIds(clubId), NotificationType.CLUB_UPDATE,
      club, `${username} asked to join the club`, { clubId, event: 'JOIN_REQUEST', userId, username });
  }

  async respondToRequest(leaderId: string, clubId: string, memberId: string, accept: boolean) {
    await this.requireRole(leaderId, clubId, [ClubRole.LEADER, ClubRole.VICE_LEADER]);

    const member = await this.prisma.clubMember.findUnique({ where: { clubId_userId: { clubId, userId: memberId } } });
    if (!member || member.status !== MemberStatus.PENDING) throw new NotFoundException('Pending request not found');

    if (accept) {
      await this.prisma.$transaction(async (tx) => {
        await tx.clubMember.update({ where: { clubId_userId: { clubId, userId: memberId } }, data: { status: MemberStatus.ACTIVE } });
        await tx.club.update({ where: { id: clubId }, data: { memberCount: { increment: 1 } } });
      });
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
    await this.requireRole(leaderId, clubId, [ClubRole.LEADER, ClubRole.VICE_LEADER]);
    await this.prisma.$transaction(async (tx) => {
      await tx.clubMember.delete({ where: { clubId_userId: { clubId, userId: memberId } } });
      await tx.club.update({ where: { id: clubId }, data: { memberCount: { decrement: 1 } } });
    });

    const club = await this.clubName(clubId);
    await this.notifications.notifySafely(memberId, NotificationType.CLUB_UPDATE,
      club, `You were removed from ${club}`, { clubId, event: 'REMOVED' });
  }

  async assignRole(leaderId: string, clubId: string, memberId: string, role: ClubRole) {
    await this.requireRole(leaderId, clubId, [ClubRole.LEADER]);
    const updated = await this.prisma.clubMember.update({ where: { clubId_userId: { clubId, userId: memberId } }, data: { role } });

    const club = await this.clubName(clubId);
    await this.notifications.notifySafely(memberId, NotificationType.CLUB_UPDATE,
      club, `You are now ${ROLE_LABEL[role]} of ${club}`, { clubId, event: 'ROLE_CHANGED', role });
    return updated;
  }

  async leaveClub(userId: string, clubId: string) {
    const member = await this.prisma.clubMember.findUnique({ where: { clubId_userId: { clubId, userId } } });
    if (!member) throw new NotFoundException('Not a club member');
    if (member.role === ClubRole.LEADER) throw new BadRequestException('Leader must transfer leadership before leaving');

    await this.prisma.$transaction(async (tx) => {
      await tx.clubMember.delete({ where: { clubId_userId: { clubId, userId } } });
      await tx.club.update({ where: { id: clubId }, data: { memberCount: { decrement: 1 } } });
    });

    if (member.status === MemberStatus.ACTIVE) {
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

    const progress = club.level > 0 ? Math.round(((club.points % (club.level * 1000)) / (club.level * 1000)) * 100) : 0;
    return { ...club, myRole, progressToNextLevel: progress };
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

  async addClubPoints(clubId: string, points: number) {
    const club = await this.prisma.club.update({
      where: { id: clubId },
      data: { points: { increment: points } },
    });
    const nextLevelThreshold = club.level * 1000;
    if (club.points >= nextLevelThreshold) {
      await this.prisma.club.update({ where: { id: clubId }, data: { level: { increment: 1 } } });
    }
    return club;
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
    if (!member || !roles.includes(member.role)) throw new ForbiddenException('Insufficient club permissions');
    return member;
  }
}
