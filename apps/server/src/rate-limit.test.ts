import { describe, expect, it, vi } from 'vitest';
import {
  ABUSE_LIMIT,
  createHttpLimiter,
  createSocketGuard,
  HTTP_RULES,
  RateLimiter,
  SOCKET_FALLBACK,
} from './rate-limit';

const clock = (start = 0) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe('RateLimiter', () => {
  it('allows a burst up to the capacity, then refuses', () => {
    const c = clock();
    const limiter = new RateLimiter({ x: { capacity: 3, perSecond: 1 } }, SOCKET_FALLBACK, c.now);
    expect([1, 2, 3, 4, 5].map(() => limiter.allow('x'))).toEqual([true, true, true, false, false]);
  });

  it('refills over time, but never beyond the capacity', () => {
    const c = clock();
    const limiter = new RateLimiter({ x: { capacity: 3, perSecond: 2 } }, SOCKET_FALLBACK, c.now);
    for (let i = 0; i < 3; i++) limiter.allow('x');
    expect(limiter.allow('x')).toBe(false);

    c.advance(500); // one token
    expect(limiter.allow('x')).toBe(true);
    expect(limiter.allow('x')).toBe(false);

    c.advance(60_000); // far more than a full refill
    expect([1, 2, 3, 4].map(() => limiter.allow('x'))).toEqual([true, true, true, false]);
  });

  it('keeps keys independent and uses the fallback for unknown rules', () => {
    const c = clock();
    const limiter = new RateLimiter({}, { capacity: 1, perSecond: 0 }, c.now);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
    expect(limiter.allow('b')).toBe(true);
  });

  it('applies a named rule to many keys', () => {
    const c = clock();
    const limiter = new RateLimiter(
      { upload: { capacity: 1, perSecond: 0 } },
      SOCKET_FALLBACK,
      c.now,
    );
    expect(limiter.allow('upload:1.1.1.1', 'upload')).toBe(true);
    expect(limiter.allow('upload:1.1.1.1', 'upload')).toBe(false);
    expect(limiter.allow('upload:2.2.2.2', 'upload')).toBe(true);
  });

  it('forgets fully refilled keys instead of growing without bound', () => {
    const c = clock();
    const limiter = new RateLimiter({ x: { capacity: 1, perSecond: 1 } }, SOCKET_FALLBACK, c.now);
    for (let i = 0; i < 10_000; i++) limiter.allow(`ip-${i}`, 'x');
    c.advance(5_000);
    limiter.allow('one-more', 'x'); // crosses the threshold and triggers the cleanup
    expect(limiter.size).toBeLessThan(10);
  });
});

describe('createHttpLimiter', () => {
  it('limits per route kind and per address', () => {
    const c = clock();
    const http = createHttpLimiter(c.now);
    const allowed = Array.from({ length: HTTP_RULES.createSession.capacity + 2 }, () =>
      http.allow('createSession', '1.2.3.4'),
    );
    expect(allowed.filter(Boolean)).toHaveLength(HTTP_RULES.createSession.capacity);
    expect(http.allow('createSession', '5.6.7.8')).toBe(true);
    expect(http.allow('upload', '1.2.3.4')).toBe(true);
  });
});

describe('createSocketGuard', () => {
  const run = (
    guard: ReturnType<typeof createSocketGuard>,
    event: string,
    ack?: (r: unknown) => void,
  ) => {
    const next = vi.fn();
    guard([event, ...(ack ? [ack] : [])], next);
    return next;
  };

  it('lets normal traffic through', () => {
    const guard = createSocketGuard({ now: clock().now, disconnect: vi.fn() });
    for (let i = 0; i < 10; i++) expect(run(guard, 'token.move')).toHaveBeenCalledOnce();
  });

  it('drops events over the limit and tells callers who wait for an answer', () => {
    const c = clock();
    const guard = createSocketGuard({ now: c.now, disconnect: vi.fn() });
    for (let i = 0; i < SOCKET_FALLBACK.capacity; i++) run(guard, 'token.move', vi.fn());

    const ack = vi.fn();
    const next = run(guard, 'token.move', ack);
    expect(next).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'rate_limited' });

    const silent = run(guard, 'token.drag'); // no ack: dropped without a reply
    for (let i = 0; i < 100; i++) run(guard, 'token.drag');
    expect(silent).toHaveBeenCalled(); // the first ones were still within the drag allowance
  });

  it('disconnects a connection that keeps flooding', () => {
    const disconnect = vi.fn();
    const guard = createSocketGuard({ now: clock().now, disconnect });
    for (let i = 0; i < SOCKET_FALLBACK.capacity + ABUSE_LIMIT.drops + 5; i++)
      run(guard, 'token.move');
    expect(disconnect).toHaveBeenCalled();
  });

  it('forgives a short burst of drops once the window has passed', () => {
    const c = clock();
    const disconnect = vi.fn();
    const guard = createSocketGuard({ now: c.now, disconnect });
    for (let i = 0; i < SOCKET_FALLBACK.capacity + 50; i++) run(guard, 'token.move'); // 50 drops
    c.advance(ABUSE_LIMIT.windowMs + 1_000);
    for (let i = 0; i < SOCKET_FALLBACK.capacity + 50; i++) run(guard, 'token.move'); // 50 more
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', () => {
    const guard = createSocketGuard({ now: clock().now, disconnect: vi.fn(), enabled: false });
    for (let i = 0; i < 500; i++) expect(run(guard, 'token.move')).toHaveBeenCalledOnce();
  });
});
