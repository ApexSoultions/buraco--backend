import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SystemConfigService } from '../../common/system-config/system-config.service';
import { RedisService } from '../../common/redis/redis.service';
import { onlineSet } from '../../common/presence/presence';
import { isPremiumActive, isVoiceChatActive } from '../../common/premium/premium';
import { v4 as uuidv4 } from 'uuid';
import { existsSync } from 'fs';
import { join } from 'path';

/** Folder served at /avatars/predefined (see main.ts). */
export const PREDEFINED_AVATAR_DIR = join(process.cwd(), 'public', 'avatars', 'predefined');

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 30;
export const SEARCH_MAX_RESULTS = 20;

/** How the searching player is connected to a search result. */
export type SearchRelation = 'FRIEND' | 'REQUEST_SENT' | 'REQUEST_RECEIVED' | 'NONE';

const PREDEFINED_AVATARS = [
  { id: 'avatar_001', name: 'Classic Blue', url: '/avatars/predefined/001.png' },
  { id: 'avatar_002', name: 'Fire Red', url: '/avatars/predefined/002.png' },
  { id: 'avatar_003', name: 'Forest Green', url: '/avatars/predefined/003.png' },
  { id: 'avatar_004', name: 'Golden Star', url: '/avatars/predefined/004.png' },
  { id: 'avatar_005', name: 'Ocean Wave', url: '/avatars/predefined/005.png' },
];

@Injectable()
export class ProfileService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private sysConfig: SystemConfigService,
    private redis?: RedisService,
  ) {}

  private async getS3Client() {
    const [region, accessKeyId, secretAccessKey] = await Promise.all([
      this.sysConfig.get('aws_region', this.config.get<string>('aws.region') ?? 'us-east-1'),
      this.sysConfig.get('aws_access_key_id', this.config.get<string>('aws.accessKeyId') ?? ''),
      this.sysConfig.get('aws_secret_access_key', this.config.get<string>('aws.secretAccessKey') ?? ''),
    ]);
    return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, isDeleted: false },
      include: { stats: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const { passwordHash, googleId, appleId, ...safe } = user;
    // Premium / voice chat only count until they run out.
    return { ...safe, isPremium: isPremiumActive(user), hasVoiceChat: isVoiceChatActive(user) };
  }

  /**
   * Another player's profile card (the player popup). With `viewerId`, it also says how the
   * viewer is connected to them (friend, request either way, blocked by the viewer). A player
   * who has blocked the viewer is not shown (404), the same as everywhere else.
   */
  /**
   * The player's country for the flag on their card and the Top Countries ranking:
   * a two-letter ISO code ("PK", "BR"), or null to remove it.
   */
  async setCountry(userId: string, raw: string | null) {
    const code = (raw ?? '').trim().toUpperCase();
    if (code && !/^[A-Z]{2}$/.test(code)) throw new BadRequestException('Country must be a two-letter code, e.g. PK or BR');
    const user = await this.prisma.user.update({ where: { id: userId }, data: { country: code || null }, select: { country: true } });
    return { country: user.country };
  }

  async getPublicProfile(userId: string, viewerId?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, isDeleted: false },
      select: {
        id: true,
        username: true,
        avatarUrl: true,
        country: true,
        registrationDate: true,
        lastSeenAt: true,
        subscriptionStatus: true,
        subscriptionExpiry: true,
        stats: {
          select: {
            level: true, points: true, classicPoints: true, gamesPlayed: true, wins: true, losses: true,
            gamesLeft: true, winPercentage: true, winStreak: true, bestWinStreak: true,
          },
        },
        clubMemberships: {
          where: { status: 'ACTIVE' },
          select: { role: true, club: { select: { id: true, name: true, iconUrl: true } } },
          take: 1,
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');

    let relation: SearchRelation = 'NONE';
    let requestId: string | null = null;
    let blockedByMe = false;
    if (viewerId && viewerId !== userId) {
      const [link, blocks] = await Promise.all([
        this.prisma.friendship.findFirst({
          where: { OR: [{ senderId: viewerId, receiverId: userId }, { senderId: userId, receiverId: viewerId }] },
          select: { id: true, senderId: true, status: true },
        }),
        this.prisma.block.findMany({
          where: { OR: [{ blockerId: viewerId, blockedId: userId }, { blockerId: userId, blockedId: viewerId }] },
          select: { blockerId: true },
        }),
      ]);
      if (blocks.some((b) => b.blockerId === userId)) throw new NotFoundException('User not found');
      blockedByMe = blocks.some((b) => b.blockerId === viewerId);
      if (link?.status === 'ACCEPTED') relation = 'FRIEND';
      else if (link?.status === 'PENDING') {
        relation = link.senderId === viewerId ? 'REQUEST_SENT' : 'REQUEST_RECEIVED';
        requestId = link.id;
      }
    }

    const online = (await onlineSet(this.redis, [user.id])).has(user.id);
    const membership = user.clubMemberships[0];
    return {
      ...user,
      online,
      isPremium: isPremiumActive(user),
      subscriptionStatus: undefined,
      subscriptionExpiry: undefined,
      club: membership ? { ...membership.club, role: membership.role } : null,
      clubMemberships: undefined,
      isMe: viewerId === userId,
      relation,
      requestId,
      blockedByMe,
    };
  }

  /**
   * Find players by username for the "Add new friend" screen. Case-insensitive; exact and
   * starts-with matches come first. Leaves out the searcher, deleted and banned accounts,
   * and anyone on either side of a block. Each result says whether the two are already
   * friends or have a pending request (with its id, so the app can accept it directly).
   */
  async searchPlayers(userId: string, rawQuery: string | undefined, rawLimit?: number) {
    const query = (rawQuery ?? '').trim();
    if (query.length < SEARCH_MIN_CHARS) {
      throw new BadRequestException(`Type at least ${SEARCH_MIN_CHARS} characters to search`);
    }
    if (query.length > SEARCH_MAX_CHARS) {
      throw new BadRequestException(`Search text can be at most ${SEARCH_MAX_CHARS} characters`);
    }
    const limit = Number.isInteger(rawLimit) && rawLimit! > 0 ? Math.min(rawLimit!, SEARCH_MAX_RESULTS) : SEARCH_MAX_RESULTS;

    const visible = {
      id: { not: userId },
      isDeleted: false,
      isBanned: false,
      blocksGiven: { none: { blockedId: userId } },
      blocksReceived: { none: { blockerId: userId } },
    };
    const select = {
      id: true,
      username: true,
      avatarUrl: true,
      stats: { select: { level: true, points: true } },
    } as const;

    // Starts-with first (alphabetical, so an exact match leads), then other matches.
    const startsWith = await this.prisma.user.findMany({
      where: { ...visible, username: { startsWith: query, mode: 'insensitive' } },
      select,
      orderBy: { username: 'asc' },
      take: limit,
    });
    const contains = startsWith.length < limit
      ? await this.prisma.user.findMany({
          where: {
            ...visible,
            username: { contains: query, mode: 'insensitive' },
            NOT: { id: { in: startsWith.map((u) => u.id) } },
          },
          select,
          orderBy: { username: 'asc' },
          take: limit - startsWith.length,
        })
      : [];
    const users = [...startsWith, ...contains];
    if (users.length === 0) return [];

    const ids = users.map((u) => u.id);
    const links = await this.prisma.friendship.findMany({
      where: {
        OR: [
          { senderId: userId, receiverId: { in: ids } },
          { receiverId: userId, senderId: { in: ids } },
        ],
      },
      select: { id: true, senderId: true, receiverId: true, status: true },
    });

    return users.map((u) => {
      const link = links.find((l) => l.senderId === u.id || l.receiverId === u.id);
      let relation: SearchRelation = 'NONE';
      if (link?.status === 'ACCEPTED') relation = 'FRIEND';
      else if (link?.status === 'PENDING') relation = link.senderId === userId ? 'REQUEST_SENT' : 'REQUEST_RECEIVED';
      return {
        id: u.id,
        username: u.username,
        avatarUrl: u.avatarUrl,
        level: u.stats?.level ?? 1,
        points: u.stats?.points ?? 0,
        relation,
        requestId: relation === 'REQUEST_SENT' || relation === 'REQUEST_RECEIVED' ? link!.id : null,
      };
    });
  }

  async updateUsername(userId: string, username: string) {
    const existing = await this.prisma.user.findUnique({ where: { username } });
    if (existing && existing.id !== userId) throw new ConflictException('USERNAME_TAKEN');
    try {
      return await this.prisma.user.update({ where: { id: userId }, data: { username }, select: { id: true, username: true } });
    } catch (err: any) {
      // Someone took the name between the check and the update.
      if (err?.code === 'P2002') throw new ConflictException('USERNAME_TAKEN');
      throw err;
    }
  }

  async uploadAvatar(userId: string, file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file provided');

    const ext = file.originalname.split('.').pop();
    const key = `avatars/${userId}/${uuidv4()}.${ext}`;
    const [s3, bucket, region] = await Promise.all([
      this.getS3Client(),
      this.sysConfig.get('aws_s3_bucket', this.config.get<string>('aws.s3Bucket') ?? ''),
      this.sysConfig.get('aws_region', this.config.get<string>('aws.region') ?? 'us-east-1'),
    ]);

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    }));

    const avatarUrl = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
    await this.prisma.user.update({ where: { id: userId }, data: { avatarUrl } });
    return { avatarUrl };
  }

  /** Only avatars whose picture file is actually on the server. */
  private availableAvatars() {
    return PREDEFINED_AVATARS.filter((a) => existsSync(join(PREDEFINED_AVATAR_DIR, a.url.split('/').pop()!)));
  }

  async setPredefinedAvatar(userId: string, predefinedId: string) {
    const avatar = this.availableAvatars().find((a) => a.id === predefinedId);
    if (!avatar) throw new NotFoundException('Predefined avatar not found');
    const appUrl = this.config.get<string>('appUrl');
    const avatarUrl = `${appUrl}${avatar.url}`;
    await this.prisma.user.update({ where: { id: userId }, data: { avatarUrl } });
    return { avatarUrl };
  }

  getPredefinedAvatars() {
    const appUrl = this.config.get<string>('appUrl');
    return this.availableAvatars().map((a) => ({ ...a, url: `${appUrl}${a.url}` }));
  }
}
