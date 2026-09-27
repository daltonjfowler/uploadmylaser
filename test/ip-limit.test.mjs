// The per-IP fuse in front of the class phrase, and the wrangler.jsonc limits behind it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { HttpError } from '../src/http.ts';
import { checkIpLimit, ipLimitKey } from '../src/ip-limit.ts';
import { GLOBAL_PROCESS_MAX_PER_MINUTE } from '../src/ratelimit.ts';

// Stands in for the Workers Rate Limiting binding: `max` calls per key, then refusals.
function fakeLimiter(max) {
  const counts = new Map();
  return {
    keys: counts,
    async limit({ key }) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { success: counts.get(key) <= max };
    },
  };
}

function wranglerConfig() {
  const text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  // Drop // comments, leaving strings alone.
  return JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*/g, (m, str) => str ?? ''));
}

test('under the limit passes, over it is a friendly 429 with retry-after', async () => {
  const l = fakeLimiter(2);
  await checkIpLimit(l, '203.0.113.7');
  await checkIpLimit(l, '203.0.113.7');
  await assert.rejects(checkIpLimit(l, '203.0.113.7'), (e) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 429);
    assert.equal(e.headers['retry-after'], '60');
    assert.match(e.message, /Wait a minute/);
    return true;
  });
});

test('each IP has its own count; a missing IP shares one bucket', async () => {
  const l = fakeLimiter(1);
  await checkIpLimit(l, '203.0.113.7');
  await checkIpLimit(l, '198.51.100.2');
  await assert.rejects(checkIpLimit(l, '203.0.113.7'));
  assert.equal(ipLimitKey(''), 'ip unknown');
  assert.equal(ipLimitKey('2001:db8::1'), 'ip 2001:db8::1');
});

test('the per-IP limits equal the site-wide limit, never lower (a school shares one IP)', () => {
  const byName = Object.fromEntries(wranglerConfig().ratelimits.map((r) => [r.name, r]));
  for (const name of ['PROCESS_IP_LIMIT', 'PHRASE_IP_LIMIT']) {
    assert.ok(byName[name], `${name} binding is missing`);
    assert.deepEqual(byName[name].simple, { limit: GLOBAL_PROCESS_MAX_PER_MINUTE, period: 60 }, name);
  }
  assert.equal(byName.PROCESS_IP_LIMIT.namespace_id, '20260940');
  assert.equal(byName.PHRASE_IP_LIMIT.namespace_id, '20260941');
});

test('the Worker checks the per-IP limit BEFORE comparing the phrase, on both routes', () => {
  const src = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
  const phraseRoute = src.slice(src.indexOf("p === '/api/phrase/check'"), src.indexOf("p === '/api/process'"));
  assert.ok(phraseRoute.indexOf('checkIpLimit(env.PHRASE_IP_LIMIT') >= 0);
  assert.ok(phraseRoute.indexOf('checkIpLimit(env.PHRASE_IP_LIMIT') < phraseRoute.indexOf('checkPhrase('));
  const processFn = src.slice(src.indexOf('async function processDesign'), src.indexOf('const verdict'));
  assert.ok(processFn.indexOf('checkIpLimit(env.PROCESS_IP_LIMIT') >= 0);
  assert.ok(processFn.indexOf('checkIpLimit(env.PROCESS_IP_LIMIT') < processFn.indexOf('checkPhrase('));
  // and the phrase itself is compared in constant time
  assert.match(src, /constantTimeEquals\(got, rec\.phrase\)/);
});
