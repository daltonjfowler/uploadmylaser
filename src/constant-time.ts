// Secret comparison that leaks nothing through timing. Both sides are hashed to 32 bytes first,
// so lengths always match (timingSafeEqual requires it). Workers-only: timingSafeEqual is a
// Cloudflare extension, so node --test does not load this file.

const encoder = new TextEncoder();

export async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}
