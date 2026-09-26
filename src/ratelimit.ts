// In-memory sliding-window rate limiter for POST /api/process (a port of uploadmycode's).
// These are a bill fuse, not the lock: the class phrase is the lock.
//
// Students re-process on every drag/edit (debounced ~400 ms), so the per-client budget is generous.
// Keyed by the browser's `x-client-id` because a school shares ONE public IP; a request without a
// usable id falls back to a per-IP bucket. Anyone can mint fresh ids, which is why there is also a
// site-wide ceiling. Lives in the Counters Durable Object; nothing is written to storage.
// Pure apart from the clock, which is passed in.

export const PROCESS_MAX_PER_MINUTE = 40;
export const GLOBAL_PROCESS_MAX_PER_MINUTE = 400;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const GLOBAL_PROCESS_KEY = 'everyone';

const SWEEP_ABOVE_KEYS = 512;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export interface RateVerdict {
  allowed: boolean;
  retryAfterSeconds: number; // 0 when allowed
}

// Prefixed so a hand-written id can never land in someone's IP bucket, or vice versa.
export function rateLimitKey(clientId: string | null | undefined, ip: string): string {
  if (typeof clientId === 'string' && CLIENT_ID_PATTERN.test(clientId)) return 'client ' + clientId;
  return 'anon ' + (ip === '' ? 'unknown' : ip);
}

export class RateLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #hits = new Map<string, number[]>(); // key -> hit times inside the window, oldest first

  constructor(max: number = PROCESS_MAX_PER_MINUTE, windowMs: number = RATE_LIMIT_WINDOW_MS) {
    this.#max = max;
    this.#windowMs = windowMs;
  }

  // A refused attempt is not recorded, so hammering never pushes the unlock further away.
  check(key: string, now: number): RateVerdict {
    const cutoff = now - this.#windowMs;
    const recent = (this.#hits.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length >= this.#max) {
      this.#hits.set(key, recent);
      const waitMs = recent[0]! + this.#windowMs - now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
    }
    recent.push(now);
    this.#hits.set(key, recent);
    if (this.#hits.size > SWEEP_ABOVE_KEYS) this.prune(now);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  prune(now: number): void {
    const cutoff = now - this.#windowMs;
    for (const [key, times] of this.#hits) {
      const recent = times.filter((at) => at > cutoff);
      if (recent.length === 0) this.#hits.delete(key);
      else this.#hits.set(key, recent);
    }
  }

  get size(): number {
    return this.#hits.size;
  }
}

// Per client first; the global bucket is only spent by requests the client bucket allowed.
// `scope` says which bucket refused, so the 429 can say whose fault it is.
export function checkProcessRate(
  client: RateLimiter, everyone: RateLimiter, key: string, now: number,
): RateVerdict & { scope: 'client' | 'everyone' } {
  const mine = client.check(key, now);
  if (!mine.allowed) return { ...mine, scope: 'client' };
  return { ...everyone.check(GLOBAL_PROCESS_KEY, now), scope: 'everyone' };
}
