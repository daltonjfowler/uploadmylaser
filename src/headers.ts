// What happens to every request and every response (static files too: `run_worker_first: true`).
//   1. http → https (301), and www.uploadmylaser.com → uploadmylaser.com, so a class phrase or
//      teacher key never crosses the school network in the clear.
//   2. Every response gets the security headers below; HTML also gets the CSP.
// Pure, so test/headers.test.mjs runs it under `node --test`.

export const CANONICAL_HOST = 'uploadmylaser.com';

export type ResponseKind = 'html' | 'json' | 'asset';

export const STRICT_TRANSPORT_SECURITY = 'max-age=31536000; includeSubDomains';

// serial=(self) is load-bearing: Web Serial is how the laser connects. Everything else is off.
export const PERMISSIONS_POLICY =
  'serial=(self), usb=(), camera=(), microphone=(), geolocation=(), payment=()';

// No inline scripts anywhere, so script-src stays strict. Fonts are self-hosted. blob: images are
// for previews the page draws itself.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

const COMMON_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['strict-transport-security', STRICT_TRANSPORT_SECURITY],
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
  ['permissions-policy', PERMISSIONS_POLICY],
  ['cross-origin-opener-policy', 'same-origin'],
  ['x-robots-tag', 'noindex, nofollow'],
];

function isHtml(r: Response): boolean {
  const type = r.headers.get('content-type') ?? '';
  return type.split(';')[0]!.trim().toLowerCase() === 'text/html';
}

// Asset responses have immutable headers, so copy into a new Response first.
export function withSecurityHeaders(response: Response, kind: ResponseKind): Response {
  const copy = new Response(response.body, response);
  for (const [name, value] of COMMON_HEADERS) copy.headers.set(name, value);
  if (kind === 'json') copy.headers.set('cache-control', 'no-store');
  if (kind === 'html' || (kind === 'asset' && isHtml(copy))) {
    copy.headers.set('content-security-policy', CONTENT_SECURITY_POLICY);
  }
  return copy;
}

function isLocal(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

// Where to send this request instead, or null to answer it. localhost is left alone for
// `wrangler dev`. The port is dropped: Cloudflare's alternate http ports do not speak https.
export function redirectTarget(requestUrl: string): string | null {
  const url = new URL(requestUrl);
  const host = url.hostname.toLowerCase();
  if (host === 'www.' + CANONICAL_HOST) {
    url.protocol = 'https:';
    url.hostname = CANONICAL_HOST;
    url.port = '';
    return url.toString();
  }
  if (url.protocol !== 'http:' || isLocal(host)) return null;
  url.protocol = 'https:';
  url.port = '';
  return url.toString();
}

export function canonicalRedirect(requestUrl: string): Response | null {
  const target = redirectTarget(requestUrl);
  if (target === null) return null;
  return withSecurityHeaders(new Response(null, { status: 301, headers: { location: target } }), 'asset');
}
