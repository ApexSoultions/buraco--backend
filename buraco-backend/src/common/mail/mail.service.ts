import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { SystemConfigService } from '../system-config/system-config.service';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private config: ConfigService,
    private sysConfig: SystemConfigService,
  ) {}

  private async getTransporter() {
    const [host, portStr, user, pass] = await Promise.all([
      this.sysConfig.get('smtp_host', this.config.get<string>('smtp.host') ?? 'smtp.gmail.com'),
      this.sysConfig.get('smtp_port', String(this.config.get<number>('smtp.port') ?? 587)),
      this.sysConfig.get('smtp_user', this.config.get<string>('smtp.user') ?? ''),
      this.sysConfig.get('smtp_pass', this.config.get<string>('smtp.pass') ?? ''),
    ]);
    const port = parseInt(portStr, 10) || 587;
    return nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
  }

  private async getFromAddress() {
    const from = await this.sysConfig.get('smtp_from', this.config.get<string>('smtp.from') ?? 'noreply@barasilian.game');
    return `"Barasilian Cards Game" <${from}>`;
  }

  async sendPasswordReset(email: string, otp: string): Promise<void> {
    try {
      const transporter = await this.getTransporter();
      await transporter.sendMail({
        from: await this.getFromAddress(),
        to: email,
        subject: 'Password Reset Code',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto;">
            <h2>Password Reset</h2>
            <p>Use the code below to reset your password. It expires in 10 minutes.</p>
            <div style="font-size: 32px; font-weight: bold; letter-spacing: 6px; text-align: center;
                        padding: 16px; background: #f4f4f4; border-radius: 8px; margin: 24px 0;">
              ${otp}
            </div>
            <p>If you did not request a password reset, please ignore this email.</p>
          </div>
        `,
      });
    } catch (err) {
      this.logger.error(`Failed to send password reset email to ${email}`, err);
    }
  }

  /** The answer to a player's message to Game Support. Everything from the player is escaped. */
  async sendSupportReply(email: string, name: string, original: string, reply: string): Promise<void> {
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    try {
      const transporter = await this.getTransporter();
      await transporter.sendMail({
        from: await this.getFromAddress(),
        to: email,
        subject: 'Your message to Game Support',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto;">
            <p>Hello ${esc(name)},</p>
            <p>${esc(reply)}</p>
            <hr style="border: none; border-top: 1px solid #ddd; margin: 24px 0;">
            <p style="color: #777; font-size: 13px;">Your message:<br>${esc(original)}</p>
          </div>
        `,
      });
    } catch (err) {
      this.logger.error(`Failed to send support reply email to ${email}`, err);
    }
  }

  async sendWelcome(email: string, username: string): Promise<void> {
    try {
      const transporter = await this.getTransporter();
      await transporter.sendMail({
        from: await this.getFromAddress(),
        to: email,
        subject: 'Welcome to Barasilian Cards Game!',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto;">
            <h2>Welcome, ${username}!</h2>
            <p>Your account has been created successfully. Get ready to play Barasilian Cards Game!</p>
            <p>Jump in and start your first game today.</p>
            <p>Good luck!</p>
          </div>
        `,
      });
    } catch (err) {
      this.logger.error(`Failed to send welcome email to ${email}`, err);
    }
  }
}
