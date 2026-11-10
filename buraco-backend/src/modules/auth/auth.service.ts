import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { MailService } from '../../common/mail/mail.service';
import { SystemConfigService } from '../../common/system-config/system-config.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { GoogleAuthDto } from './dto/google-auth.dto';
import { AppleAuthDto } from './dto/apple-auth.dto';

@Injectable()
export class AuthService {
  private googleClient: OAuth2Client;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private jwt: JwtService,
    private config: ConfigService,
    private mail: MailService,
    private sysConfig: SystemConfigService,
  ) {
    this.googleClient = new OAuth2Client();
  }

  async register(dto: RegisterDto) {
    const [existingEmail, existingUsername] = await Promise.all([
      dto.email ? this.prisma.user.findUnique({ where: { email: dto.email } }) : null,
      this.prisma.user.findUnique({ where: { username: dto.username } }),
    ]);

    if (existingEmail) throw new ConflictException('EMAIL_TAKEN');
    if (existingUsername) throw new ConflictException('USERNAME_TAKEN');

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const [coins, diamonds, lives] = await Promise.all([
      this.sysConfig.getNumber('new_user_coins', 1000),
      this.sysConfig.getNumber('new_user_diamonds', 0),
      this.sysConfig.getNumber('new_user_lives', 5),
    ]);

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: dto.email,
          passwordHash,
          username: dto.username.toLowerCase(),
          coins,
          diamonds,
          lives,
        },
      });
      await tx.playerStats.create({ data: { userId: created.id } });
      return created;
    });

    const tokens = await this.generateTokens(user.id, user.email ?? '');
    return { user: this.sanitizeUser(user), ...tokens };
  }

  async login(dto: LoginDto) {
    const emailProvided = !!dto.email?.trim();
    const usernameProvided = !!dto.username?.trim();

    if (!emailProvided && !usernameProvided) {
      throw new BadRequestException('EMAIL_OR_USERNAME_REQUIRED');
    }

    let user: any;

    if (emailProvided) {
      user = await this.prisma.user.findFirst({
        where: { email: dto.email, isDeleted: false },
      });
    } else {
      user = await this.prisma.user.findUnique({
        where: { username: dto.username!.toLowerCase() },
      });
      if (user?.isDeleted) user = null;
    }

    if (!user) throw new NotFoundException('ACCOUNT_NOT_FOUND');
    if (!user.passwordHash) throw new UnauthorizedException('INVALID_CREDENTIALS');
    if (user.isBanned) throw new ForbiddenException('ACCOUNT_BANNED');

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('INVALID_CREDENTIALS');

    await this.invalidateUserSessions(user.id);
    const tokens = await this.generateTokens(user.id, user.email ?? '');
    return { user: this.sanitizeUser(user), ...tokens };
  }

  async loginWithGoogle(dto: GoogleAuthDto) {
    const googleClientId = await this.sysConfig.get('google_client_id', this.config.get<string>('google.clientId') ?? '');
    const ticket = await this.googleClient.verifyIdToken({
      idToken: dto.idToken,
      audience: googleClientId,
    });
    const payload = ticket.getPayload();
    if (!payload) throw new UnauthorizedException('Invalid Google token');

    const { sub: googleId, email, picture, name } = payload;
    let user = await this.prisma.user.findUnique({ where: { googleId } });
    let isNewUser = false;

    if (!user) {
      const username = await this.generateUsername(name || (email ?? '').split('@')[0]);
      const [coins, diamonds, lives] = await Promise.all([
        this.sysConfig.getNumber('new_user_coins', 1000),
        this.sysConfig.getNumber('new_user_diamonds', 0),
        this.sysConfig.getNumber('new_user_lives', 5),
      ]);
      user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            googleId,
            email,
            username,
            avatarUrl: picture,
            coins,
            diamonds,
            lives,
          },
        });
        await tx.playerStats.create({ data: { userId: created.id } });
        return created;
      });
      isNewUser = true;
    }

    if (user.isBanned) throw new ForbiddenException('ACCOUNT_BANNED');
    await this.invalidateUserSessions(user.id);
    const tokens = await this.generateTokens(user.id, user.email ?? '');
    return { user: this.sanitizeUser(user), ...tokens, isNewUser };
  }

  async loginWithApple(dto: AppleAuthDto) {
    // Verify Apple identity token (simplified — production needs full JWT verification with Apple public keys)
    const parts = dto.identityToken.split('.');
    if (parts.length !== 3) throw new UnauthorizedException('Invalid Apple token');

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const appleId = payload.sub;
    const email = payload.email;

    if (!appleId) throw new UnauthorizedException('Invalid Apple token payload');

    let user = await this.prisma.user.findUnique({ where: { appleId } });
    let isNewUser = false;

    if (!user) {
      const firstName = dto.fullName?.firstName || '';
      const lastName = dto.fullName?.lastName || '';
      const baseName = `${firstName}${lastName}`.trim() || (email ? email.split('@')[0] : 'Player');
      const username = await this.generateUsername(baseName);
      const [coins, diamonds, lives] = await Promise.all([
        this.sysConfig.getNumber('new_user_coins', 1000),
        this.sysConfig.getNumber('new_user_diamonds', 0),
        this.sysConfig.getNumber('new_user_lives', 5),
      ]);

      user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            appleId,
            email: email || null,
            username,
            coins,
            diamonds,
            lives,
          },
        });
        await tx.playerStats.create({ data: { userId: created.id } });
        return created;
      });
      isNewUser = true;
    }

    if (user.isBanned) throw new ForbiddenException('ACCOUNT_BANNED');
    await this.invalidateUserSessions(user.id);
    const tokens = await this.generateTokens(user.id, user.email ?? '');
    return { user: this.sanitizeUser(user), ...tokens, isNewUser };
  }

  async refreshToken(token: string) {
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(token, {
        secret: this.config.get<string>('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('INVALID_REFRESH_TOKEN');
    }

    const hash = this.hashToken(token);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
    if (!stored || stored.expiresAt < new Date()) throw new UnauthorizedException('INVALID_REFRESH_TOKEN');

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.isBanned || user.isDeleted) throw new UnauthorizedException('INVALID_REFRESH_TOKEN');

    // Fully rotate: delete the consumed token, issue a fresh pair.
    await this.prisma.refreshToken.delete({ where: { tokenHash: hash } });
    const accessToken    = this.signAccessToken(payload.sub, payload.email ?? user.email ?? '');
    const newRefreshToken = this.signRefreshToken(payload.sub, payload.email ?? user.email ?? '');
    const newHash = this.hashToken(newRefreshToken);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    await this.prisma.refreshToken.create({ data: { userId: payload.sub, tokenHash: newHash, expiresAt } });

    return { accessToken, refreshToken: newRefreshToken, expiresIn: 900, user: this.sanitizeUser(user) };
  }

  async logout(userId: string, token: string) {
    const ttl = 900; // match access token TTL
    await this.redis.set(`blacklist:${token}`, '1', ttl);
  }

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email, isDeleted: false } });
    if (!user) return; // silent — don't leak user existence

    const otp = Math.random().toString(36).slice(2, 10).toUpperCase();
    await this.redis.set(`otp:${email}`, otp, 600); // 10 min TTL

    await this.mail.sendPasswordReset(email, otp);
  }

  async resetPassword(dto: ResetPasswordDto) {
    // Token format: base64(email):otp
    const decoded = Buffer.from(dto.token, 'base64').toString();
    const [email, otp] = decoded.split(':');
    if (!email || !otp) throw new BadRequestException('Invalid reset token');

    const stored = await this.redis.get(`otp:${email}`);
    if (!stored || stored !== otp) throw new BadRequestException('Invalid or expired reset token');

    const passwordHash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.user.update({ where: { email }, data: { passwordHash } });
    await this.redis.del(`otp:${email}`);
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.passwordHash) throw new BadRequestException('No password set on this account');

    const valid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    // 400, not 401: a mistyped password must not look like an expired login to the app.
    if (!valid) throw new BadRequestException('Current password is incorrect');

    const passwordHash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  }

  async updateEmail(userId: string, email: string) {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException('EMAIL_TAKEN');
    await this.prisma.user.update({ where: { id: userId }, data: { email } });
  }

  async deleteAccount(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { isDeleted: true, deletedAt: new Date() },
    });
    // Revoke all refresh tokens
    await this.prisma.refreshToken.deleteMany({ where: { userId } });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async invalidateUserSessions(userId: string) {
    await this.prisma.refreshToken.deleteMany({ where: { userId } });
    try {
      // 30-day TTL mirrors the refresh token lifetime
      await this.redis.set(`user:session:${userId}`, String(Math.floor(Date.now() / 1000)), 2592000);
    } catch (err) {
      console.error('[Auth] Redis session fence write failed — login continues:', err);
    }
  }

  private async generateTokens(userId: string, email: string) {
    const accessToken = this.signAccessToken(userId, email);
    const refreshToken = this.signRefreshToken(userId, email);

    const hash = await this.hashToken(refreshToken);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    await this.prisma.refreshToken.create({ data: { userId, tokenHash: hash, expiresAt } });
    return { accessToken, refreshToken, expiresIn: 900 };
  }

  private signAccessToken(userId: string, email: string) {
    return this.jwt.sign(
      { sub: userId, email },
      { secret: this.config.get<string>('jwt.secret'), expiresIn: '15m' },
    );
  }

  private signRefreshToken(userId: string, email: string) {
    return this.jwt.sign(
      { sub: userId, email },
      { secret: this.config.get<string>('jwt.refreshSecret'), expiresIn: '30d' },
    );
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private sanitizeUser(user: any) {
    const { passwordHash, googleId, appleId, ...safe } = user;
    return safe;
  }

  private async generateUsername(base: string): Promise<string> {
    const clean = base.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase().slice(0, 15) || 'player';
    let candidate = clean;
    let attempt = 0;
    while (await this.prisma.user.findUnique({ where: { username: candidate } })) {
      attempt++;
      candidate = `${clean}${Math.floor(Math.random() * 9000 + 1000)}`;
      if (attempt > 10) throw new ConflictException('Could not generate unique username');
    }
    return candidate;
  }
}
