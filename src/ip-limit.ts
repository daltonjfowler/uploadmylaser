// Per-IP fuse in front of the class-phrase check, so nobody can guess phrases without limit. Uses the
// Workers Rate Limiting bindings in wrangler.jsonc (PHRASE_IP_LIMIT, PROCESS_IP_LIMIT).
//
// A whole school shares ONE public IP, so each per-IP limit equals the site-wide limit for the route
// (GLOBAL_PROCESS_MAX_PER_MINUTE): the school is never limited harder than everyone together already
// is. test/ip-limit.test.mjs checks wrangler.jsonc against it. The counts are per Cloudflare
// location and only roughly exact, which is fine for a fuse. Pure: no cloudflare:* imports.

import { HttpError } from './http.ts';

export const IP_LIMIT_PERIOD_SECONDS = 60;

// The binding's shape (RateLimit in worker-configuration.d.ts), so tests can pass a fake.
export interface IpRateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export function ipLimitKey(ip: string): string {
  return 'ip ' + (ip === '' ? 'unknown' : ip);
}

export async function checkIpLimit(limiter: IpRateLimiter, ip: string): Promise<void> {
  const { success } = await limiter.limit({ key: ipLimitKey(ip) });
  if (!success) {
    throw new HttpError(429, 'Too many tries from this network. Wait a minute and try again.', {
      'retry-after': String(IP_LIMIT_PERIOD_SECONDS),
    });
  }
}
