// The class phrase: normalizing it and how long it lives. Stored in KV as `{ phrase, expiresAt }`.
// KV expiry is eventually consistent (a cached read can outlive it by ~60 s), so `expiresAt` is
// the real deadline and is checked on every read. Pure: test/phrase.test.mjs runs it.

export const PHRASE_KEY = 'phrase';
export const MIN_PHRASE_LENGTH = 4;
export const MAX_PHRASE_LENGTH = 64;
export const MIN_TTL_MINUTES = 15;
export const MAX_TTL_MINUTES = 7 * 24 * 60; // the teacher page offers up to 1 week
export const DEFAULT_TTL_MINUTES = 480;

export interface PhraseRecord {
  phrase: string; // already normalized
  expiresAt: number; // unix ms
}

// "Blue  Robot " and "blue robot" are the same phrase. Non-strings become "" (never valid).
export function normalizePhrase(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function isUsablePhrase(norm: string): boolean {
  return norm.length >= MIN_PHRASE_LENGTH && norm.length <= MAX_PHRASE_LENGTH;
}

// Missing or junk becomes the default rather than an error; the response echoes what was set.
export function clampTtlMinutes(raw: unknown): number {
  const asked = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(asked)) return DEFAULT_TTL_MINUTES;
  return Math.min(MAX_TTL_MINUTES, Math.max(MIN_TTL_MINUTES, Math.round(asked)));
}

// The phrase valid right now, or null. `value` is whatever KV returned.
export function activeRecord(value: unknown, now: number): PhraseRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as { phrase?: unknown; expiresAt?: unknown };
  const phrase = normalizePhrase(r.phrase);
  if (!isUsablePhrase(phrase)) return null;
  if (typeof r.expiresAt !== 'number' || !Number.isFinite(r.expiresAt)) return null;
  if (now >= r.expiresAt) return null;
  return { phrase, expiresAt: r.expiresAt };
}
