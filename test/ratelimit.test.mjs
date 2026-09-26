// The /api/process rate limiter. The clock is passed in, so no real waiting.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkProcessRate, GLOBAL_PROCESS_MAX_PER_MINUTE, PROCESS_MAX_PER_MINUTE, RATE_LIMIT_WINDOW_MS, rateLimitKey,
  RateLimiter,
} from '../src/ratelimit.ts';

const T0 = 1_000_000;

test('the limits are what the plan says', () => {
  assert.equal(PROCESS_MAX_PER_MINUTE, 40);
  assert.equal(GLOBAL_PROCESS_MAX_PER_MINUTE, 400);
  assert.equal(RATE_LIMIT_WINDOW_MS, 60_000);
});

test('the 40th request passes and the 41st does not', () => {
  const l = new RateLimiter();
  for (let i = 0; i < 40; i++) assert.equal(l.check('k', T0 + i * 100).allowed, true, `request ${i + 1}`);
  const v = l.check('k', T0 + 4000);
  assert.equal(v.allowed, false);
  assert.equal(v.retryAfterSeconds, 56); // oldest hit at T0 leaves the window at T0 + 60 s
});

test('the window slides: the oldest hit ageing out frees one slot', () => {
  const l = new RateLimiter(2, 1000);
  assert.equal(l.check('k', 0).allowed, true);
  assert.equal(l.check('k', 500).allowed, true);
  assert.equal(l.check('k', 999).allowed, false);
  assert.equal(l.check('k', 1001).allowed, true);
  assert.equal(l.check('k', 1002).allowed, false);
});

test('refused attempts are not recorded', () => {
  const l = new RateLimiter(1, 1000);
  l.check('k', 0);
  for (let t = 1; t < 1000; t += 50) assert.equal(l.check('k', t).allowed, false);
  assert.equal(l.check('k', 1001).allowed, true);
});

test('retryAfterSeconds is never 0 while refused', () => {
  const l = new RateLimiter(1, 1000);
  l.check('k', 0);
  assert.equal(l.check('k', 999).retryAfterSeconds, 1);
});

test('keys are independent', () => {
  const l = new RateLimiter(1, 1000);
  assert.equal(l.check('a', 0).allowed, true);
  assert.equal(l.check('b', 0).allowed, true);
  assert.equal(l.check('a', 1).allowed, false);
});

test('rateLimitKey uses a valid client id, else the IP', () => {
  assert.equal(rateLimitKey('3f2c1b7e-1111-4a5b-9c8d-0123456789ab', '1.2.3.4'), 'client 3f2c1b7e-1111-4a5b-9c8d-0123456789ab');
  assert.equal(rateLimitKey(null, '1.2.3.4'), 'anon 1.2.3.4');
  assert.equal(rateLimitKey('short', '1.2.3.4'), 'anon 1.2.3.4');
  assert.equal(rateLimitKey('has space in it', '1.2.3.4'), 'anon 1.2.3.4');
  assert.equal(rateLimitKey('x'.repeat(65), '1.2.3.4'), 'anon 1.2.3.4');
  assert.equal(rateLimitKey('anon-1.2.3.4', ''), 'anon unknown');
  assert.notEqual(rateLimitKey('12345678', ''), rateLimitKey(null, '12345678'));
});

test('the global guard caps everyone together, and a refused client does not spend it', () => {
  const client = new RateLimiter(PROCESS_MAX_PER_MINUTE, RATE_LIMIT_WINDOW_MS);
  const everyone = new RateLimiter(GLOBAL_PROCESS_MAX_PER_MINUTE, RATE_LIMIT_WINDOW_MS);
  // One client hammering: 40 pass, the rest are refused by the client bucket only.
  for (let i = 0; i < 100; i++) checkProcessRate(client, everyone, 'client spammer', T0 + i);
  const r = checkProcessRate(client, everyone, 'client spammer', T0 + 200);
  assert.equal(r.allowed, false);
  assert.equal(r.scope, 'client');
  // 360 more from fresh ids fill the global bucket exactly.
  for (let i = 0; i < 360; i++) {
    assert.equal(checkProcessRate(client, everyone, `client id-${i}-xxxxxx`, T0 + 300).allowed, true, `fresh ${i}`);
  }
  const g = checkProcessRate(client, everyone, 'client newcomer', T0 + 400);
  assert.equal(g.allowed, false);
  assert.equal(g.scope, 'everyone');
  assert.ok(g.retryAfterSeconds >= 1);
});

test('prune drops expired keys', () => {
  const l = new RateLimiter(5, 1000);
  l.check('a', 0);
  l.check('b', 500);
  l.prune(1200);
  assert.equal(l.size, 1);
});
