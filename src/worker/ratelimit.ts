// Rate limiting for the public HTTP routes, and a small token bucket the
// room uses to cap messages per WebSocket.
//
// In production the Worker uses Cloudflare's rate limiting bindings, which
// are declared in wrangler.jsonc and share their counters across a
// Cloudflare location. If a deployment leaves the bindings out, a simple
// in-memory counter takes over. That fallback only counts within one
// Worker isolate, so it is weaker, but it still stops a single client
// hammering one instance.

/** The part of Cloudflare's `RateLimit` binding this code uses. */
export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Policy {
  /** Requests allowed per period. */
  limit: number;
  /** Period in seconds. Cloudflare's binding accepts 10 or 60. */
  period: 10 | 60;
}

/**
 * Keep these in step with the `ratelimits` entries in wrangler.jsonc. They
 * are used as-is by the in-memory fallback.
 */
export const RATE_POLICIES = {
  /** POST /api/rooms, per client IP. */
  createRoom: { limit: 10, period: 60 },
  /**
   * Room lookups and WebSocket connections (joining, resuming, hosting and
   * the big screen), per client IP. Generous because a whole pub can share
   * one Wi-Fi address and phones reconnect every time they wake up.
   */
  connect: { limit: 120, period: 60 },
} as const satisfies Record<string, Policy>;

/** Fixed-window counter used when no binding is configured. */
export class MemoryLimiter implements Limiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly policy: Policy,
    private readonly clock: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const now = this.clock();
    const periodMs = this.policy.period * 1000;
    let w = this.windows.get(key);
    if (!w || now - w.start >= periodMs) {
      if (!w && this.windows.size >= this.maxKeys) this.prune(now, periodMs);
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count++;
    return { success: w.count <= this.policy.limit };
  }

  private prune(now: number, periodMs: number): void {
    for (const [key, w] of this.windows) if (now - w.start >= periodMs) this.windows.delete(key);
    // Still full of live windows: drop the oldest rather than grow without bound.
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }
}

// Fallbacks live for the life of the isolate, like the bindings would.
const fallbacks = new Map<string, MemoryLimiter>();

export function limiterFor(binding: Limiter | undefined, name: keyof typeof RATE_POLICIES): Limiter {
  if (binding) return binding;
  let fallback = fallbacks.get(name);
  if (!fallback) {
    fallback = new MemoryLimiter(RATE_POLICIES[name]);
    fallbacks.set(name, fallback);
  }
  return fallback;
}

/** The client's address as Cloudflare reports it. Local tools may not set it. */
export function clientKey(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

/**
 * Asks the limiter whether this request may go ahead. A limiter that fails
 * lets the request through: a broken counter should not stop a quiz.
 */
export async function allowed(limiter: Limiter, key: string): Promise<boolean> {
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Per-socket message rate

export interface BucketPolicy {
  /** Messages a socket may send in a burst. */
  burst: number;
  /** Messages per second the bucket refills by. */
  perSecond: number;
}

/**
 * Enough for a host clicking quickly through the running order or a team
 * changing its mind several times, far below what a script could send.
 */
export const SOCKET_MESSAGES: BucketPolicy = { burst: 20, perSecond: 5 };

/** Close a socket that sends this many messages in a row over its budget. */
export const SOCKET_DROP_LIMIT = 60;

export class TokenBucket {
  private tokens: number;
  private last: number;
  /** Messages dropped since the last one that was allowed. */
  dropped = 0;

  constructor(
    private readonly policy: BucketPolicy,
    now: number,
  ) {
    this.tokens = policy.burst;
    this.last = now;
  }

  /** Takes one token. Returns false, and counts a drop, if the bucket is empty. */
  take(now: number): boolean {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.policy.burst, this.tokens + elapsed * this.policy.perSecond);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.dropped = 0;
      return true;
    }
    this.dropped++;
    return false;
  }
}
