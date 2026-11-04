import { SlidingWindowLimiter } from '../rate-limit/sliding-window';
import { AppThrottlerGuard, clientIp, isSignedIn, trackerFor } from './app-throttler.guard';

// ThrottlerModule was configured but its guard was never registered, so no rate limit
// applied anywhere. These cover who a request is counted against, and the socket chat cap.

describe('trackerFor', () => {
  it('counts a signed-in player per player, not per IP (carrier NAT shares IPs)', () => {
    expect(trackerFor({ user: { id: 'u1' }, ip: '1.2.3.4' })).toBe('user:u1');
    expect(trackerFor({ user: { id: 'u2' }, ip: '1.2.3.4' })).toBe('user:u2');
  });

  it('counts a signed-out login per IP and email, case-insensitively', () => {
    expect(trackerFor({ ip: '1.2.3.4', body: { email: ' Bob@Example.com ' } })).toBe('ip:1.2.3.4|bob@example.com');
  });

  it('falls back to the IP alone', () => {
    expect(trackerFor({ ip: '1.2.3.4', body: {} })).toBe('ip:1.2.3.4');
    expect(trackerFor({ socket: { remoteAddress: '5.6.7.8' } })).toBe('ip:5.6.7.8');
  });

  it('clientIp prefers req.ip', () => {
    expect(clientIp({ ip: '9.9.9.9', socket: { remoteAddress: '1.1.1.1' } })).toBe('9.9.9.9');
  });

  it('isSignedIn reads the authenticated user from the HTTP request', () => {
    const ctx = (req: any) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as any;
    expect(isSignedIn(ctx({ user: { id: 'u1' } }))).toBe(true);
    expect(isSignedIn(ctx({}))).toBe(false);
  });
});

describe('AppThrottlerGuard', () => {
  it('skips socket events, which have no HTTP request to read', async () => {
    const guard = Object.create(AppThrottlerGuard.prototype) as AppThrottlerGuard;
    const shouldSkip = (type: string) => (guard as any).shouldSkip({ getType: () => type });
    await expect(shouldSkip('ws')).resolves.toBe(true);
    await expect(shouldSkip('http')).resolves.toBe(false);
  });
});

describe('SlidingWindowLimiter (socket chat)', () => {
  it('allows the limit within the window, refuses the next, and frees up as time passes', () => {
    let t = 0;
    const limiter = new SlidingWindowLimiter(3, 10_000, () => t);

    expect([1, 2, 3].map(() => limiter.tryAcquire('u1'))).toEqual([true, true, true]);
    expect(limiter.tryAcquire('u1')).toBe(false);
    expect(limiter.tryAcquire('u2')).toBe(true); // per player

    t = 9_999;
    expect(limiter.tryAcquire('u1')).toBe(false);
    t = 10_000;
    expect(limiter.tryAcquire('u1')).toBe(true);
  });

  it('a refused attempt does not extend the block', () => {
    let t = 0;
    const limiter = new SlidingWindowLimiter(1, 1_000, () => t);
    limiter.tryAcquire('u1');
    t = 500;
    expect(limiter.tryAcquire('u1')).toBe(false);
    t = 1_000;
    expect(limiter.tryAcquire('u1')).toBe(true);
  });
});
