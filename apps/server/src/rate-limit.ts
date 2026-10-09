/** A token bucket: `capacity` actions at once, refilled at `perSecond`. */
export interface Rule {
  capacity: number;
  perSecond: number;
}

interface State {
  tokens: number;
  at: number;
  rule: Rule;
}

/** Above this many tracked keys, buckets that have refilled completely are forgotten. */
const PRUNE_ABOVE = 10_000;

/** Counts actions per key (an event name, an IP address, ...) against a bucket rule each. */
export class RateLimiter {
  private readonly states = new Map<string, State>();

  constructor(
    private readonly rules: Readonly<Record<string, Rule>>,
    private readonly fallback: Rule,
    /** Milliseconds; injectable so tests do not have to wait. */
    private readonly now: () => number = Date.now,
  ) {}

  private refilled(state: State, now: number): number {
    const { capacity, perSecond } = state.rule;
    return Math.min(capacity, state.tokens + ((now - state.at) / 1000) * perSecond);
  }

  /**
   * Returns false (and spends nothing) when the key has used up its allowance.
   * `ruleName` picks the rule when it differs from the key (e.g. key "upload:1.2.3.4", rule "upload").
   */
  allow(key: string, ruleName: string = key): boolean {
    const now = this.now();
    const rule = this.rules[ruleName] ?? this.fallback;
    const state = this.states.get(key) ?? { tokens: rule.capacity, at: now, rule };

    const available = this.refilled(state, now);
    const allowed = available >= 1;
    state.tokens = allowed ? available - 1 : available;
    state.at = now;
    this.states.set(key, state);

    if (this.states.size > PRUNE_ABOVE) this.prune(now);
    return allowed;
  }

  private prune(now: number): void {
    for (const [key, state] of this.states) {
      if (this.refilled(state, now) >= state.rule.capacity) this.states.delete(key);
    }
  }

  get size(): number {
    return this.states.size;
  }
}

/** Limits per event name. The client sends at most ~20 drags and ~10 grid updates a second. */
export const SOCKET_RULES: Readonly<Record<string, Rule>> = {
  'token.drag': { capacity: 40, perSecond: 30 },
  'grid.update': { capacity: 20, perSecond: 20 },
  // A stroke is one message; a few quick ones in a row are fine, a stream of them is not.
  'line.draw': { capacity: 6, perSecond: 2 },
  'session.join': { capacity: 5, perSecond: 0.5 },
  'state.sync': { capacity: 5, perSecond: 1 },
  'system.ping': { capacity: 5, perSecond: 2 },
};
export const SOCKET_FALLBACK: Rule = { capacity: 30, perSecond: 15 };

/** A connection that keeps hammering after being told to stop is dropped. */
export const ABUSE_LIMIT = { drops: 200, windowMs: 10_000 };

type Packet = [event: string, ...args: unknown[]];

/**
 * Per-connection middleware for Socket.IO's `socket.use`. Over-limit events never reach their
 * handlers; if the sender expects an answer it gets `{ ok: false, error: 'rate_limited' }`.
 */
export function createSocketGuard(options: {
  now?: () => number;
  disconnect: () => void;
  enabled?: boolean;
}) {
  const now = options.now ?? Date.now;
  const limiter = new RateLimiter(SOCKET_RULES, SOCKET_FALLBACK, now);
  let windowStart = now();
  let drops = 0;

  return ([event, ...args]: Packet, next: (err?: Error) => void) => {
    if (options.enabled === false || limiter.allow(event)) return next();

    if (now() - windowStart > ABUSE_LIMIT.windowMs) {
      windowStart = now();
      drops = 0;
    }
    if (++drops > ABUSE_LIMIT.drops) return options.disconnect();

    const ack = args[args.length - 1];
    if (typeof ack === 'function')
      (ack as (r: unknown) => void)({ ok: false, error: 'rate_limited' });
  };
}

/** Per-IP limits for the HTTP routes that create things; `null` means unlimited. */
export const HTTP_RULES = {
  createSession: { capacity: 10, perSecond: 10 / 60 },
  upload: { capacity: 20, perSecond: 20 / 60 },
  lookup: { capacity: 60, perSecond: 1 },
} as const satisfies Record<string, Rule>;

export type HttpRuleName = keyof typeof HTTP_RULES;

export function createHttpLimiter(now?: () => number) {
  const limiter = new RateLimiter(
    Object.fromEntries(Object.entries(HTTP_RULES)) as Record<string, Rule>,
    SOCKET_FALLBACK,
    now,
  );
  return {
    /** One bucket per route kind and client address. */
    allow: (rule: HttpRuleName, ip: string) => limiter.allow(`${rule}:${ip}`, rule),
  };
}
