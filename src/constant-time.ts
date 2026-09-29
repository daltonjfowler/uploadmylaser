// Secret comparison that leaks nothing through timing. Both sides are hashed to 32 bytes first,
// so lengths always match (timingSafeEqual requires it). Workers-only: timingSafeEqual is a
// Cloudflare extension, so node --test does not load this file.

const encoder = new TextEncoder();

/** True when `given` equals any of `keys`. Every key is compared, so the time does not say which one. */
export async function anyKeyEquals(given: string, keys: string[]): Promise<boolean> {
  const hits = await Promise.all(keys.map((k) => constantTimeEquals(given, k)));
  return hits.some(Boolean);
}

export async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}
