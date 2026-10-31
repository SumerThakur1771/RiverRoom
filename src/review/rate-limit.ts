// Sliding-window rate limiter, kept in memory.
//
// On Vercel each warm function instance keeps its own memory, so this limits requests per
// instance, not across all instances. That is enough to stop one browser from hammering
// the endpoint and to cap spend per instance; a limit that holds across instances needs a
// shared store (Redis or similar), which is not set up.

export interface LimitResult { allowed: boolean; retryAfterMs: number }

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(readonly limit: number, readonly windowMs: number, private readonly maxKeys = 10_000) {}

  /** Is a request for `key` under the limit? With `record`, also count it when allowed. */
  check(key: string, now: number = Date.now(), record = true): LimitResult {
    const from = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter(t => t > from);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return { allowed: false, retryAfterMs: list[0]! + this.windowMs - now };
    }
    if (!record) return { allowed: true, retryAfterMs: 0 };
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) this.prune(now);
    return { allowed: true, retryAfterMs: 0 };
  }

  private prune(now: number): void {
    for (const [k, list] of this.hits) if (!list.some(t => t > now - this.windowMs)) this.hits.delete(k);
  }
}

/** Per-IP limits for the review endpoint, plus a per-instance cap as a spend guard. */
export function reviewLimiters() {
  const perMinute = new SlidingWindowLimiter(5, 60_000);
  const perHour = new SlidingWindowLimiter(20, 3_600_000);
  const instanceHour = new SlidingWindowLimiter(300, 3_600_000);
  return (ip: string, now: number = Date.now()): LimitResult => {
    const checks = [[instanceHour, '*'], [perMinute, ip], [perHour, ip]] as const;
    // check every limit first, and only count the request if all of them allow it
    for (const [lim, key] of checks) {
      const r = lim.check(key, now, false);
      if (!r.allowed) return r;
    }
    for (const [lim, key] of checks) lim.check(key, now, true);
    return { allowed: true, retryAfterMs: 0 };
  };
}
