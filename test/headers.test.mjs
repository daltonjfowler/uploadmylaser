// https + canonical-host redirects and the security headers. Node runs src/headers.ts directly.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalRedirect, CONTENT_SECURITY_POLICY, PERMISSIONS_POLICY, redirectTarget, STRICT_TRANSPORT_SECURITY,
  withSecurityHeaders,
} from '../src/headers.ts';

test('plain http redirects to https, keeping path and query', () => {
  assert.equal(redirectTarget('http://uploadmylaser.com/teacher/?a=1&b=two%20words'), 'https://uploadmylaser.com/teacher/?a=1&b=two%20words');
});

test('https on the canonical host is answered normally', () => {
  assert.equal(redirectTarget('https://uploadmylaser.com/'), null);
  assert.equal(redirectTarget('https://uploadmylaser.example.workers.dev/api/materials'), null);
});

test('http on workers.dev also goes to https', () => {
  assert.equal(redirectTarget('http://uploadmylaser.x.workers.dev/a'), 'https://uploadmylaser.x.workers.dev/a');
});

test('www redirects to the bare domain on https, from http or https', () => {
  assert.equal(redirectTarget('https://www.uploadmylaser.com/teacher/?x=1'), 'https://uploadmylaser.com/teacher/?x=1');
  assert.equal(redirectTarget('http://www.uploadmylaser.com/'), 'https://uploadmylaser.com/');
  assert.equal(redirectTarget('http://WWW.UploadMyLaser.com/a'), 'https://uploadmylaser.com/a');
});

test('the port is dropped', () => {
  assert.equal(redirectTarget('http://uploadmylaser.com:8080/x'), 'https://uploadmylaser.com/x');
});

test('localhost is never redirected', () => {
  for (const u of ['http://localhost:8787/', 'http://127.0.0.1:8787/api/machine', 'http://[::1]:8787/', 'http://app.localhost/']) {
    assert.equal(redirectTarget(u), null, u);
  }
});

test('canonicalRedirect is a 301 with a location and the security headers', () => {
  const r = canonicalRedirect('http://uploadmylaser.com/');
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), 'https://uploadmylaser.com/');
  assert.equal(r.headers.get('strict-transport-security'), STRICT_TRANSPORT_SECURITY);
  assert.equal(canonicalRedirect('https://uploadmylaser.com/'), null);
});

test('every response gets the common headers', () => {
  const r = withSecurityHeaders(new Response('x', { headers: { 'content-type': 'text/css' } }), 'asset');
  assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(r.headers.get('permissions-policy'), PERMISSIONS_POLICY);
  assert.equal(r.headers.get('content-security-policy'), null, 'no CSP on a stylesheet');
});

test('Permissions-Policy allows Web Serial for this site (the laser connects over it)', () => {
  assert.match(PERMISSIONS_POLICY, /(^|, )serial=\(self\)/);
});

test('HTML assets get the exact CSP', () => {
  const r = withSecurityHeaders(new Response('<p>', { headers: { 'content-type': 'text/html; charset=utf-8' } }), 'asset');
  assert.equal(r.headers.get('content-security-policy'),
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; "
    + "connect-src 'self'; manifest-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; "
    + "frame-ancestors 'none'; upgrade-insecure-requests");
  assert.equal(r.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /googleapis|gstatic/);
});

test('API JSON gets no-store and no CSP', () => {
  const r = withSecurityHeaders(new Response('{}', { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' } }), 'json');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('content-security-policy'), null);
});

test('status, body and existing headers survive', async () => {
  const r = withSecurityHeaders(new Response('nope', { status: 404, headers: { 'x-a': '1' } }), 'asset');
  assert.equal(r.status, 404);
  assert.equal(r.headers.get('x-a'), '1');
  assert.equal(await r.text(), 'nope');
});
