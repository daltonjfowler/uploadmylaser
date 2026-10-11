// The per-IP fuse on WRONG class phrases (src/wrong-ip.ts) and its wrangler.jsonc binding.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { recordWrongFromIp, WRONG_PHRASE_LIMIT_PER_MINUTE, wrongIpKey } from '../src/wrong-ip.ts';

const IP = '203.0.113.7';
const noSleep = async () => {};

function limiter(max) {
  const n = new Map();
  return { n, async limit({ key }) { n.set(key, (n.get(key) ?? 0) + 1); return { success: n.get(key) <= max }; } };
}

function wranglerConfig() {
  const text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  return JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*/g, (m, str) => str ?? ''));
}

test('wrong phrases past the limit are slowed and refused with a 429, per IP', async () => {
  const l = limiter(2);
  let slept = 0;
  const sleep = async (ms) => { slept += ms; };
  await recordWrongFromIp(l, IP, sleep);
  await recordWrongFromIp(l, IP, sleep);
  assert.equal(slept, 0);
  await assert.rejects(recordWrongFromIp(l, IP, sleep), (e) => e.status === 429 && e.headers['retry-after'] === '60' && /right phrase still works/.test(e.message));
  assert.ok(slept > 0);
  await recordWrongFromIp(l, '198.51.100.2', noSleep); // other networks are not affected
  assert.equal(wrongIpKey(''), 'wrong unknown');
});

test('falls open when the binding fails', async () => {
  await recordWrongFromIp({ async limit() { throw new Error('down'); } }, IP, noSleep);
});

test('wrangler: binding present, unique 91xx id, workers.dev off', () => {
  const c = wranglerConfig();
  const r = c.ratelimits.find((x) => x.name === 'WRONG_PHRASE_IP_LIMIT');
  assert.deepEqual(r.simple, { limit: WRONG_PHRASE_LIMIT_PER_MINUTE, period: 60 });
  assert.match(r.namespace_id, /^91\d\d$/);
  assert.equal(new Set(c.ratelimits.map((x) => x.namespace_id)).size, c.ratelimits.length);
  assert.equal(c.workers_dev, false);
});

test('a right phrase is never refused by the IP fuse: it is only spent after a failed compare', () => {
  const src = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function checkPhrase'), src.indexOf('// ALLOWED_CIDRS'));
  const cmp = fn.indexOf('constantTimeEquals');
  const wrong = fn.indexOf('recordWrongFromIp');
  assert.ok(cmp > 0 && wrong > cmp && wrong < fn.indexOf("'That class phrase is not right.'"));
  assert.equal(fn.split('recordWrongFromIp').length, 2, 'called once, in the wrong branch only');
});

test('uploads and JSON bodies need a declared size', () => {
  const src = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
  assert.ok(!/content-length'\) \?\? 0/.test(src), 'a missing content-length must not count as 0');
  assert.match(src, /function declaredLength[\s\S]*?411/);
});
