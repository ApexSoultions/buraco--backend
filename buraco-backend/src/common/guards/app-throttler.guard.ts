import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Who a request is counted against.
 *
 * Signed in: the player, not the IP. Many phones on mobile data share one public IP
 * (carrier NAT), so an IP-based limit would block real players for each other's traffic.
 *
 * Signed out (login, register, password reset): the IP plus the email being tried, so the
 * strict per-route limits on the auth endpoints cap guesses against one account without
 * locking out everyone behind the same IP. The separate `anon` throttler caps the IP as a
 * whole, so one IP cannot spray guesses across many accounts.
 */
export function trackerFor(req: Record<string, any>): string {
  const userId = req.user?.id;
  if (userId) return `user:${userId}`;
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return email ? `ip:${clientIp(req)}|${email}` : `ip:${clientIp(req)}`;
}

export function clientIp(req: Record<string, any>): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

/** True for requests JwtAuthGuard has already authenticated. */
export function isSignedIn(context: ExecutionContext): boolean {
  return !!context.switchToHttp().getRequest()?.user?.id;
}

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  // HTTP only. Socket events (chat, moves) are limited in the gateway; the base guard
  // reads an HTTP request and response, which a socket context does not have.
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    return context.getType() !== 'http';
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    return trackerFor(req);
  }
}
