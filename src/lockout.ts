// Growing per-IP lockout on wrong class phrases and wrong teacher keys (Dalton, 2026-09-28): 5 wrong
// tries in a row lock that IP for 5 s, and each further wrong try after a lock ends doubles it
// (5, 10, 20, 40, 80, 160, then 300 s at most). A right phrase or key from that IP clears it. While
// locked, tries are refused WITHOUT comparing, so a locked guesser learns nothing.
//
// One counter per (kind, IP), kept in the Cache API: free, no write quota, and per Cloudflare location,
// which is fine because one IP reaches one location. Every store call falls open: if the cache fails,
// the Worker behaves as if there were no lockout, so a cache problem never blocks a class. Pure apart
// from the store and the clock, so test/lockout.test.mjs runs it with an in-memory map.

import { HttpError } from './http.ts';

export const LOCKOUT_FREE_TRIES = 5; // wrong tries in a row before the first lock
export const LOCKOUT_BASE_SECONDS = 5;
export const LOCKOUT_MAX_SECONDS = 300;
export const LOCKOUT_CACHE_SECONDS = 900; // an idle counter is forgotten after this

export type LockoutKind = 'phrase' | 'teacher';

export interface LockoutState {
  failures: number; // wrong tries in a row
  lockedUntil: number; // unix ms, 0 when not locked
}

// Where the counters live. The Worker uses cacheStore(caches.default); tests pass a Map.
export interface LockoutStore {
  get(key: string): Promise<LockoutState | null>;
  put(key: string, state: LockoutState): Promise<void>;
  delete(key: string): Promise<void>;
}

export function lockoutKey(kind: LockoutKind, ip: string): string {
  return `https://lockout.internal/${kind}/${encodeURIComponent(ip === '' ? 'unknown' : ip)}`;
}

// How long the Nth wrong try in a row locks for: 0 below the threshold, then doubling to the cap.
export function lockSecondsFor(failures: number): number {
  if (failures < LOCKOUT_FREE_TRIES) return 0;
  return Math.min(LOCKOUT_MAX_SECONDS, LOCKOUT_BASE_SECONDS * 2 ** (failures - LOCKOUT_FREE_TRIES));
}

export function afterFailure(prior: LockoutState | null, now: number): LockoutState {
  const failures = (prior?.failures ?? 0) + 1;
  const seconds = lockSecondsFor(failures);
  return { failures, lockedUntil: seconds ? now + seconds * 1000 : 0 };
}

// Seconds left on the lock, never 0 while locked; 0 when not locked.
export function retryAfterSeconds(state: LockoutState | null, now: number): number {
  if (!state || state.lockedUntil <= now) return 0;
  return Math.max(1, Math.ceil((state.lockedUntil - now) / 1000));
}

export function lockedMessage(seconds: number): string {
  return `Too many wrong tries. Wait ${seconds} seconds and try again.`;
}

export function lockedError(seconds: number): HttpError {
  return new HttpError(429, lockedMessage(seconds), { 'retry-after': String(seconds) }, {
    error: 'locked', retryAfter: seconds, message: lockedMessage(seconds),
  });
}

function parseState(value: unknown): LockoutState | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as { failures?: unknown; lockedUntil?: unknown };
  if (typeof v.failures !== 'number' || !Number.isFinite(v.failures) || v.failures < 0) return null;
  if (typeof v.lockedUntil !== 'number' || !Number.isFinite(v.lockedUntil)) return null;
  return { failures: v.failures, lockedUntil: v.lockedUntil };
}

// Just the part of the Workers Cache the store needs, so this file needs no Workers types.
interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export function cacheStore(cache: CacheLike): LockoutStore {
  return {
    async get(key) {
      const r = await cache.match(key);
      return r ? parseState(await r.json()) : null;
    },
    async put(key, state) {
      await cache.put(key, new Response(JSON.stringify(state), {
        headers: { 'content-type': 'application/json', 'cache-control': `max-age=${LOCKOUT_CACHE_SECONDS}` },
      }));
    },
    async delete(key) {
      await cache.delete(key);
    },
  };
}

function logCacheError(what: string, e: unknown): void {
  console.error(JSON.stringify({ message: `lockout cache ${what} failed; falling open`, error: String(e) }));
}

// Call BEFORE comparing. Throws the 429 while locked; otherwise returns the counter (null when there
// is none or the cache failed) to hand to recordWrong / recordRight.
export async function checkLockout(store: LockoutStore, kind: LockoutKind, ip: string, now: number): Promise<LockoutState | null> {
  let state: LockoutState | null;
  try {
    state = await store.get(lockoutKey(kind, ip));
  } catch (e) {
    logCacheError('read', e);
    return null;
  }
  const seconds = retryAfterSeconds(state, now);
  if (seconds > 0) throw lockedError(seconds);
  return state;
}

export async function recordWrong(store: LockoutStore, kind: LockoutKind, ip: string, prior: LockoutState | null, now: number): Promise<LockoutState> {
  const next = afterFailure(prior, now);
  try {
    await store.put(lockoutKey(kind, ip), next);
  } catch (e) {
    logCacheError('write', e);
  }
  return next;
}

// Only touches the cache when there was something to clear, so right answers cost one read.
export async function recordRight(store: LockoutStore, kind: LockoutKind, ip: string, prior: LockoutState | null): Promise<void> {
  if (!prior) return;
  try {
    await store.delete(lockoutKey(kind, ip));
  } catch (e) {
    logCacheError('delete', e);
  }
}
