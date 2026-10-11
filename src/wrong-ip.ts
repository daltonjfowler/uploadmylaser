// Per-IP fuse on WRONG class phrases only (code review 2026-10-09). The per-device lockout
// (src/lockout.ts) keys on the client's own x-device-id, so a script that sends a fresh id with every
// try is never locked by it. This counts wrong phrases per IP with the WRONG_PHRASE_IP_LIMIT rate-limit
// binding. Past the limit, WRONG answers from that IP are slowed down and refused with a 429.
//
// A whole school shares one IP, and a student must never lock the teacher or the class out (Dalton,
// 2026-09-28). So this never blocks anything BEFORE the compare: every request is compared, and a
// right phrase always works, however many wrong ones came from the same IP. Right phrases never touch
// the counter. The cost, accepted on purpose: a script can still tell right from wrong and keep
// guessing at the PHRASE_IP_LIMIT rate (400 a minute per IP), only slowed by the delay below. The
// real lock is ALLOWED_CIDRS (school IPs only).
//
// Falls open: if the binding fails, a wrong phrase is just a plain 401. Pure apart from the binding
// and the sleep, so test/wrong-ip.test.mjs runs it with fakes.

import { HttpError } from './http.ts';
import type { IpRateLimiter } from './ip-limit.ts';

export const WRONG_PHRASE_LIMIT_PER_MINUTE = 60; // wrangler.jsonc WRONG_PHRASE_IP_LIMIT
export const WRONG_OVER_LIMIT_DELAY_MS = 2_000;
export const WRONG_IP_RETRY_SECONDS = 60;

export function wrongIpKey(ip: string): string {
  return 'wrong ' + (ip === '' ? 'unknown' : ip);
}

// Call ONLY after a phrase failed the compare. Throws the 429 (after a delay) once this IP has sent
// more wrong phrases this minute than the limit; otherwise returns and the caller sends its 401.
export async function recordWrongFromIp(limiter: IpRateLimiter, ip: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  let over = false;
  try {
    over = !(await limiter.limit({ key: wrongIpKey(ip) })).success;
  } catch (e) {
    console.error(JSON.stringify({ message: 'wrong-phrase IP fuse failed; falling open', error: String(e) }));
  }
  if (!over) return;
  await sleep(WRONG_OVER_LIMIT_DELAY_MS);
  throw new HttpError(429, 'Too many wrong class phrases from this network. Check the phrase with your teacher. The right phrase still works.', {
    'retry-after': String(WRONG_IP_RETRY_SECONDS),
  });
}
