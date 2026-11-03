import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { CurrencyType, NotificationType, SubscriptionStatus, TransactionType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SystemConfigService } from '../../common/system-config/system-config.service';
import { SocketService } from '../../common/socket/socket.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { BanUserDto } from './dto/ban-user.dto';
import { CreditUserDto } from './dto/credit-user.dto';
import { BroadcastDto } from './dto/broadcast.dto';
import { CreatePromoDto } from './dto/create-promo.dto';
import { SystemConfigDto } from './dto/system-config.dto';
import { CreateShopItemDto } from './dto/create-shop-item.dto';
import { EditUserDto } from './dto/edit-user.dto';
import { CreateMissionDto } from './dto/create-mission.dto';

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private sysConfig: SystemConfigService,
    private socketService: SocketService,
  ) {}

  // ─── Auth ─────────────────────────────────────────────────────────────────

  async login(dto: AdminLoginDto) {
    const admin = await this.prisma.adminUser.findUnique({ where: { email: dto.email, isActive: true } });
    if (!admin) throw new UnauthorizedException('INVALID_CREDENTIALS');

    const valid = await bcrypt.compare(dto.password, admin.passwordHash);
    if (!valid) throw new UnauthorizedException('INVALID_CREDENTIALS');

    await this.prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });

    const token = this.jwt.sign(
      { sub: admin.id, email: admin.email, role: admin.role },
      { secret: this.config.get<string>('admin.jwtSecret') ?? '', expiresIn: '8h' },
    );

    const { passwordHash, ...safe } = admin;
    return { admin: safe, accessToken: token, expiresIn: 28800 };
  }

  // ─── Dashboard Stats ──────────────────────────────────────────────────────

  async getDashboard() {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [totalUsers, activeUsers, bannedUsers, totalGames, activeGames, totalRevenue, newUsersToday, gamesToday, topPlayerStats] = await Promise.all([
      this.prisma.user.count({ where: { isDeleted: false } }),
      this.prisma.user.count({ where: { isDeleted: false, lastSeenAt: { gte: since24h } } }),
      this.prisma.user.count({ where: { isBanned: true } }),
      this.prisma.gameSession.count(),
      this.prisma.gameSession.count({ where: { status: 'IN_PROGRESS' } }),
      this.prisma.transaction.aggregate({ _sum: { amount: true }, where: { type: TransactionType.PURCHASE } }),
      this.prisma.user.count({ where: { isDeleted: false, createdAt: { gte: since24h } } }),
      this.prisma.gameSession.count({ where: { createdAt: { gte: since24h } } }),
      this.prisma.playerStats.findMany({
        take: 5,
        orderBy: { points: 'desc' },
        include: { user: { select: { id: true, username: true, avatarUrl: true } } },
      }),
    ]);

    const topPlayers = topPlayerStats.map((s) => ({
      id: s.user.id,
      username: s.user.username,
      avatarUrl: s.user.avatarUrl,
      points: s.points,
      level: s.level,
      winPercentage: s.winPercentage,
    }));

    return {
      totalUsers,
      activeUsers,
      bannedUsers,
      totalGames,
      activeGames,
      totalRevenue: totalRevenue._sum.amount ?? 0,
      newUsersToday,
      gamesToday,
      topPlayers,
    };
  }

  // ─── User Management ─────────────────────────────────────────────────────

  async listUsers(page: number, limit: number, search?: string) {
    const where = search
      ? { isDeleted: false, OR: [{ username: { contains: search, mode: 'insensitive' as const } }, { email: { contains: search, mode: 'insensitive' as const } }] }
      : { isDeleted: false };

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: { id: true, username: true, email: true, coins: true, diamonds: true, subscriptionStatus: true, isBanned: true, createdAt: true, lastSeenAt: true },
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { stats: true, transactions: { take: 10, orderBy: { createdAt: 'desc' } }, adminNotes: { orderBy: { createdAt: 'desc' } } },
    });
    if (!user) throw new NotFoundException('User not found');
    const { passwordHash, googleId, appleId, ...safe } = user;
    return safe;
  }

  async banUser(adminId: string, userId: string, dto: BanUserDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    await this.prisma.user.update({ where: { id: userId }, data: { isBanned: dto.isBanned, banReason: dto.reason ?? null } });
    await this.audit(adminId, dto.isBanned ? 'BAN_USER' : 'UNBAN_USER', 'User', userId, { reason: dto.reason });
    return { message: dto.isBanned ? 'User banned' : 'User unbanned' };
  }

  async addNote(adminId: string, userId: string, content: string) {
    return this.prisma.adminNote.create({ data: { userId, adminId, content } });
  }

  async creditUser(adminId: string, userId: string, dto: CreditUserDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const isCoins = dto.currency === CurrencyType.COINS;
    const balanceBefore = isCoins ? user.coins : user.diamonds;
    const balanceAfter = balanceBefore + dto.amount;

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: isCoins ? { coins: balanceAfter } : { diamonds: balanceAfter } }),
      this.prisma.transaction.create({
        data: { userId, type: TransactionType.MANUAL_CREDIT, currency: dto.currency, amount: dto.amount, balanceBefore, balanceAfter, description: dto.reason, performedBy: adminId },
      }),
    ]);

    await this.audit(adminId, 'CREDIT_USER', 'User', userId, { currency: dto.currency, amount: dto.amount });
    return { message: `Credited ${dto.amount} ${dto.currency}` };
  }

  async deductUser(adminId: string, userId: string, dto: CreditUserDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const isCoins = dto.currency === CurrencyType.COINS;
    const balanceBefore = isCoins ? user.coins : user.diamonds;
    if (balanceBefore < dto.amount) throw new BadRequestException('Insufficient balance');
    const balanceAfter = balanceBefore - dto.amount;

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: isCoins ? { coins: balanceAfter } : { diamonds: balanceAfter } }),
      this.prisma.transaction.create({
        data: { userId, type: TransactionType.MANUAL_DEDUCT, currency: dto.currency, amount: dto.amount, balanceBefore, balanceAfter, description: dto.reason, performedBy: adminId },
      }),
    ]);

    await this.audit(adminId, 'DEDUCT_USER', 'User', userId, { currency: dto.currency, amount: dto.amount });
    return { message: `Deducted ${dto.amount} ${dto.currency}` };
  }

  // ─── Game Management ──────────────────────────────────────────────────────

  async listGames(page: number, limit: number, status?: string) {
    const where = status ? { status: status as any } : {};
    const [data, total] = await Promise.all([
      this.prisma.gameSession.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { players: { select: { userId: true, teamId: true, result: true } } },
      }),
      this.prisma.gameSession.count({ where }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async voidGame(adminId: string, gameId: string, reason: string) {
    const game = await this.prisma.gameSession.findUnique({ where: { id: gameId } });
    if (!game) throw new NotFoundException('Game not found');

    await this.prisma.gameSession.update({
      where: { id: gameId },
      data: { status: 'VOIDED', voidReason: reason, voidedBy: adminId, endedAt: new Date() },
    });

    await this.audit(adminId, 'VOID_GAME', 'GameSession', gameId, { reason });
    return { message: 'Game voided' };
  }

  // ─── Shop Management ──────────────────────────────────────────────────────

  async listShopItems(page: number, limit: number) {
    const [data, total] = await Promise.all([
      this.prisma.shopItem.findMany({ skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' } }),
      this.prisma.shopItem.count(),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async createShopItem(adminId: string, dto: CreateShopItemDto) {
    const item = await this.prisma.shopItem.create({ data: dto });
    await this.audit(adminId, 'CREATE_SHOP_ITEM', 'ShopItem', item.id, { name: dto.name });
    return item;
  }

  async toggleShopItem(adminId: string, itemId: string, isActive: boolean) {
    const item = await this.prisma.shopItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Item not found');
    const updated = await this.prisma.shopItem.update({ where: { id: itemId }, data: { isActive } });
    await this.audit(adminId, isActive ? 'ACTIVATE_SHOP_ITEM' : 'DEACTIVATE_SHOP_ITEM', 'ShopItem', itemId, {});
    return updated;
  }

  // ─── Promo Codes ──────────────────────────────────────────────────────────

  async createPromo(adminId: string, dto: CreatePromoDto) {
    const existing = await this.prisma.promoCode.findUnique({ where: { code: dto.code.toUpperCase() } });
    if (existing) throw new ConflictException('Promo code already exists');

    const promo = await this.prisma.promoCode.create({
      data: { ...dto, code: dto.code.toUpperCase(), expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null },
    });
    await this.audit(adminId, 'CREATE_PROMO', 'PromoCode', promo.id, { code: promo.code });
    return promo;
  }

  async listPromos(page: number, limit: number) {
    const [data, total] = await Promise.all([
      this.prisma.promoCode.findMany({ skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' } }),
      this.prisma.promoCode.count(),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async togglePromo(adminId: string, promoId: string, isActive: boolean) {
    const promo = await this.prisma.promoCode.findUnique({ where: { id: promoId } });
    if (!promo) throw new NotFoundException('Promo not found');
    const updated = await this.prisma.promoCode.update({ where: { id: promoId }, data: { isActive } });
    await this.audit(adminId, isActive ? 'ACTIVATE_PROMO' : 'DEACTIVATE_PROMO', 'PromoCode', promoId, {});
    return updated;
  }

  // ─── Broadcast ────────────────────────────────────────────────────────────

  async broadcast(adminId: string, dto: BroadcastDto) {
    const users = await this.prisma.user.findMany({ where: { isDeleted: false, isBanned: false }, select: { id: true } });

    await this.prisma.notification.createMany({
      data: users.map((u) => ({
        userId: u.id,
        type: NotificationType.BROADCAST,
        title: dto.title,
        body: dto.body,
        data: dto.data ?? {},
      })),
    });

    // One live event for everyone online instead of a per-user lookup; clients re-fetch
    // GET /notifications/unread-count for the badge.
    this.socketService.emitToAll('notification:new', {
      notification: { type: NotificationType.BROADCAST, title: dto.title, body: dto.body, data: dto.data ?? {}, createdAt: new Date().toISOString() },
      unreadCount: null,
    });

    await this.audit(adminId, 'BROADCAST', 'Notification', 'all', { title: dto.title, recipientCount: users.length });
    return { message: `Broadcast sent to ${users.length} users` };
  }

  // ─── System Config ────────────────────────────────────────────────────────

  async listConfig() {
    return this.prisma.systemConfig.findMany({ orderBy: { key: 'asc' } });
  }

  async setConfig(adminId: string, key: string, dto: SystemConfigDto) {
    const cfg = await this.prisma.systemConfig.upsert({
      where: { key },
      update: { value: dto.value, updatedBy: adminId },
      create: { key, value: dto.value, updatedBy: adminId },
    });
    this.sysConfig.invalidate(key);
    await this.audit(adminId, 'UPDATE_CONFIG', 'SystemConfig', key, { value: dto.value });
    return cfg;
  }

  // ─── Clubs ────────────────────────────────────────────────────────────────

  async listClubs(page: number, limit: number, search?: string) {
    const where = search
      ? { name: { contains: search, mode: 'insensitive' as const } }
      : {};
    const [data, total] = await Promise.all([
      this.prisma.club.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.club.count({ where }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getClub(clubId: string) {
    const club = await this.prisma.club.findUnique({
      where: { id: clubId },
      include: {
        members: {
          include: { user: { select: { username: true, email: true } } },
          orderBy: { joinedAt: 'asc' },
        },
      },
    });
    if (!club) throw new NotFoundException('Club not found');
    return club;
  }

  async deleteClub(adminId: string, clubId: string) {
    const club = await this.prisma.club.findUnique({ where: { id: clubId } });
    if (!club) throw new NotFoundException('Club not found');
    await this.prisma.club.delete({ where: { id: clubId } });
    await this.audit(adminId, 'DELETE_CLUB', 'Club', clubId, { name: club.name });
    return { message: `Club "${club.name}" deleted` };
  }

  async removeClubMember(adminId: string, clubId: string, userId: string) {
    const member = await this.prisma.clubMember.findUnique({ where: { clubId_userId: { clubId, userId } } });
    if (!member) throw new NotFoundException('Member not found');
    await this.prisma.clubMember.delete({ where: { clubId_userId: { clubId, userId } } });
    await this.prisma.club.update({ where: { id: clubId }, data: { memberCount: { decrement: 1 } } });
    await this.audit(adminId, 'REMOVE_CLUB_MEMBER', 'ClubMember', userId, { clubId });
    return { message: 'Member removed' };
  }

  // ─── Missions ─────────────────────────────────────────────────────────────

  async listMissions() {
    return this.prisma.mission.findMany({ orderBy: { type: 'asc' } });
  }

  async toggleMission(adminId: string, missionId: string, isActive: boolean) {
    const m = await this.prisma.mission.findUnique({ where: { id: missionId } });
    if (!m) throw new NotFoundException('Mission not found');
    const updated = await this.prisma.mission.update({ where: { id: missionId }, data: { isActive } });
    await this.audit(adminId, isActive ? 'ACTIVATE_MISSION' : 'DEACTIVATE_MISSION', 'Mission', missionId, {});
    return updated;
  }

  async createMission(adminId: string, dto: CreateMissionDto) {
    const mission = await this.prisma.mission.create({
      data: {
        title: dto.title,
        description: dto.description,
        type: dto.type,
        requirement: dto.requirement,
        targetValue: dto.targetValue,
        rewardCoins: dto.rewardCoins ?? 0,
        rewardDiamonds: dto.rewardDiamonds ?? 0,
      },
    });
    await this.audit(adminId, 'CREATE_MISSION', 'Mission', mission.id, { title: mission.title });
    return mission;
  }

  async updateMission(adminId: string, missionId: string, dto: Partial<CreateMissionDto>) {
    const m = await this.prisma.mission.findUnique({ where: { id: missionId } });
    if (!m) throw new NotFoundException('Mission not found');
    const updated = await this.prisma.mission.update({ where: { id: missionId }, data: dto });
    await this.audit(adminId, 'UPDATE_MISSION', 'Mission', missionId, { title: updated.title });
    return updated;
  }

  async deleteMission(adminId: string, missionId: string) {
    const m = await this.prisma.mission.findUnique({ where: { id: missionId } });
    if (!m) throw new NotFoundException('Mission not found');
    await this.prisma.missionProgress.deleteMany({ where: { missionId } });
    await this.prisma.mission.delete({ where: { id: missionId } });
    await this.audit(adminId, 'DELETE_MISSION', 'Mission', missionId, { title: m.title });
    return { message: `Mission "${m.title}" deleted` };
  }

  // ─── Edit User ────────────────────────────────────────────────────────────

  async editUser(adminId: string, userId: string, dto: EditUserDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (dto.username && dto.username !== user.username) {
      const taken = await this.prisma.user.findUnique({ where: { username: dto.username } });
      if (taken) throw new ConflictException('USERNAME_TAKEN');
    }
    if (dto.email && dto.email !== user.email) {
      const taken = await this.prisma.user.findUnique({ where: { email: dto.email } });
      if (taken) throw new ConflictException('EMAIL_TAKEN');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.username !== undefined && { username: dto.username }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.lives !== undefined && { lives: dto.lives }),
        ...(dto.subscriptionStatus !== undefined && { subscriptionStatus: dto.subscriptionStatus }),
        ...(dto.coins !== undefined && { coins: dto.coins }),
        ...(dto.diamonds !== undefined && { diamonds: dto.diamonds }),
      },
    });
    await this.audit(adminId, 'EDIT_USER', 'User', userId, dto);
    const { passwordHash, googleId, appleId, ...safe } = updated;
    return safe;
  }

  // ─── Send Item to User ────────────────────────────────────────────────────

  async sendItemToUser(adminId: string, userId: string, itemId: string) {
    const [user, item] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.shopItem.findUnique({ where: { id: itemId } }),
    ]);
    if (!user) throw new NotFoundException('User not found');
    if (!item) throw new NotFoundException('Shop item not found');

    await this.prisma.$transaction([
      this.prisma.inventory.upsert({
        where: { userId_itemId: { userId, itemId } },
        update: { quantity: { increment: 1 } },
        create: { userId, itemId, quantity: 1 },
      }),
      this.prisma.transaction.create({
        data: {
          userId,
          type: TransactionType.MANUAL_CREDIT,
          currency: CurrencyType.COINS,
          amount: 0,
          balanceBefore: user.coins,
          balanceAfter: user.coins,
          description: `Admin gift: ${item.name}`,
          referenceId: itemId,
          performedBy: adminId,
        },
      }),
    ]);

    await this.audit(adminId, 'SEND_ITEM', 'UserInventory', userId, { itemId, itemName: item.name });
    return { message: `Item "${item.name}" sent to ${user.username}` };
  }

  // ─── Leaderboard ──────────────────────────────────────────────────────────

  async getLeaderboard(page: number, limit: number, sort: 'points' | 'winPercentage' | 'gamesPlayed' | 'level' = 'points') {
    const validSorts = ['points', 'winPercentage', 'gamesPlayed', 'level'];
    const orderField = validSorts.includes(sort) ? sort : 'points';

    const [data, total] = await Promise.all([
      this.prisma.playerStats.findMany({
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { [orderField]: 'desc' },
        include: { user: { select: { id: true, username: true, email: true, avatarUrl: true, isBanned: true } } },
      }),
      this.prisma.playerStats.count(),
    ]);

    return {
      data: data.map((s, i) => ({
        rank: (page - 1) * limit + i + 1,
        userId: s.userId,
        username: s.user.username,
        email: s.user.email,
        avatarUrl: s.user.avatarUrl,
        isBanned: s.user.isBanned,
        level: s.level,
        points: s.points,
        gamesPlayed: s.gamesPlayed,
        winPercentage: s.winPercentage,
        winStreak: s.winStreak,
        bestStreak: s.bestWinStreak,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async resetPlayerStats(adminId: string, userId: string) {
    const stats = await this.prisma.playerStats.findUnique({ where: { userId } });
    if (!stats) throw new NotFoundException('Player stats not found');

    await this.prisma.playerStats.update({
      where: { userId },
      data: { points: 0, level: 1, gamesPlayed: 0, winPercentage: 0, winStreak: 0, bestWinStreak: 0 },
    });
    await this.audit(adminId, 'RESET_PLAYER_STATS', 'PlayerStats', userId, {});
    return { message: 'Player stats reset' };
  }

  async setPlayerScore(adminId: string, userId: string, points: number, level?: number) {
    const stats = await this.prisma.playerStats.findUnique({ where: { userId } });
    if (!stats) throw new NotFoundException('Player stats not found');

    await this.prisma.playerStats.update({
      where: { userId },
      data: { points, ...(level !== undefined && { level }) },
    });
    await this.audit(adminId, 'SET_PLAYER_SCORE', 'PlayerStats', userId, { points, level });
    return { message: 'Score updated' };
  }

  // ─── Audit Logs ───────────────────────────────────────────────────────────

  async getAuditLogs(page: number, limit: number) {
    const [data, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { admin: { select: { name: true, email: true, role: true } } },
      }),
      this.prisma.adminAuditLog.count(),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async audit(adminId: string, action: string, targetType: string, targetId: string, details: object) {
    await this.prisma.adminAuditLog.create({ data: { adminId, action, targetType, targetId, details } });
  }
}
