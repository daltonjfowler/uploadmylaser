// The growing per-IP lockout on wrong class phrases and teacher keys.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpError } from '../src/http.ts';
import {
  afterFailure, cacheStore, checkLockout, LOCKOUT_CACHE_SECONDS, LOCKOUT_FREE_TRIES, LOCKOUT_MAX_SECONDS, lockoutKey,
  lockSecondsFor, recordRight, recordWrong, retryAfterSeconds,
} from '../src/lockout.ts';

const T0 = 5_000_000;
const IP = '203.0.113.7';

// In-memory stand-in for the Cache API store.
function memStore() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.get(k) ?? null; },
    async put(k, s) { m.set(k, s); },
    async delete(k) { m.delete(k); },
  };
}

const brokenStore = {
  async get() { throw new Error('cache down'); },
  async put() { throw new Error('cache down'); },
  async delete() { throw new Error('cache down'); },
};

// One wrong try the way the Worker does it: check, then (not locked) compare fails, then record.
async function wrongTry(store, kind, now) {
  const prior = await checkLockout(store, kind, IP, now);
  return recordWrong(store, kind, IP, prior, now);
}

function isLocked(seconds) {
  return (e) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 429);
    assert.equal(e.headers['retry-after'], String(seconds));
    assert.deepEqual(e.body, {
      error: 'locked', retryAfter: seconds, message: `Too many wrong tries. Wait ${seconds} seconds and try again.`,
    });
    return true;
  };
}

test('4 wrong tries in a row are fine', async () => {
  const s = memStore();
  for (let i = 0; i < 4; i++) {
    const st = await wrongTry(s, 'phrase', T0 + i);
    assert.equal(st.lockedUntil, 0, `try ${i + 1}`);
  }
  assert.equal(await checkLockout(s, 'phrase', IP, T0 + 10).then((x) => x.failures), 4);
});

test('the 5th wrong try locks for 5 seconds', async () => {
  const s = memStore();
  for (let i = 0; i < LOCKOUT_FREE_TRIES - 1; i++) await wrongTry(s, 'phrase', T0);
  const st = await wrongTry(s, 'phrase', T0);
  assert.equal(st.lockedUntil, T0 + 5000);
  await assert.rejects(checkLockout(s, 'phrase', IP, T0 + 1), isLocked(5));
  assert.equal((await checkLockout(s, 'phrase', IP, T0 + 5000)).failures, 5); // lifted on time
});

test('a locked try is refused before any compare and does not count', async () => {
  const s = memStore();
  for (let i = 0; i < 5; i++) await wrongTry(s, 'phrase', T0);
  let compared = false;
  const attempt = async () => {
    await checkLockout(s, 'phrase', IP, T0 + 2000);
    compared = true; // the Worker's constantTimeEquals would run here
  };
  await assert.rejects(attempt(), isLocked(3));
  assert.equal(compared, false);
  assert.equal(s.m.get(lockoutKey('phrase', IP)).failures, 5);
});

test('each wrong try after a lock ends doubles it, capped at 300 s', async () => {
  assert.deepEqual([1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 50, 5000].map(lockSecondsFor), [0, 0, 5, 10, 20, 40, 80, 160, 300, 300, 300, 300]);
  const s = memStore();
  let now = T0;
  for (let i = 0; i < 4; i++) await wrongTry(s, 'teacher', now);
  const seen = [];
  for (let i = 0; i < 8; i++) {
    const st = await wrongTry(s, 'teacher', now);
    seen.push((st.lockedUntil - now) / 1000);
    now = st.lockedUntil; // the next try comes the moment the lock ends
  }
  assert.deepEqual(seen, [5, 10, 20, 40, 80, 160, 300, 300]);
  assert.ok(LOCKOUT_CACHE_SECONDS > LOCKOUT_MAX_SECONDS); // the counter outlives the longest lock
});

test('a right answer clears the counter; kinds and IPs are separate', async () => {
  const s = memStore();
  for (let i = 0; i < 4; i++) await wrongTry(s, 'phrase', T0);
  await wrongTry(s, 'teacher', T0);
  const prior = await checkLockout(s, 'phrase', IP, T0);
  await recordRight(s, 'phrase', IP, prior);
  assert.equal(await checkLockout(s, 'phrase', IP, T0), null);
  assert.equal((await checkLockout(s, 'teacher', IP, T0)).failures, 1);
  assert.equal(await checkLockout(s, 'phrase', '198.51.100.1', T0), null);
  assert.notEqual(lockoutKey('phrase', IP), lockoutKey('teacher', IP));
});

test('a right answer with no counter never touches the store', async () => {
  let deletes = 0;
  const s = { ...memStore(), async delete() { deletes++; } };
  await recordRight(s, 'phrase', IP, null);
  assert.equal(deletes, 0);
});

test('a cache failure falls open: nothing is refused, nothing throws', async () => {
  for (let i = 0; i < LOCKOUT_FREE_TRIES + 1; i++) {
    const prior = await checkLockout(brokenStore, 'phrase', IP, T0);
    assert.equal(prior, null);
    await recordWrong(brokenStore, 'phrase', IP, prior, T0);
  }
  await recordRight(brokenStore, 'phrase', IP, { failures: 3, lockedUntil: 0 });
});

test('retryAfterSeconds never reads 0 while locked', () => {
  const st = afterFailure({ failures: 4, lockedUntil: 0 }, T0);
  assert.equal(retryAfterSeconds(st, T0 + 4999), 1);
  assert.equal(retryAfterSeconds(st, T0 + 5000), 0);
  assert.equal(retryAfterSeconds(null, T0), 0);
});

test('cacheStore round-trips through a Cache-shaped object with a max-age', async () => {
  const saved = new Map();
  const cache = {
    async match(k) { return saved.get(k)?.clone(); },
    async put(k, r) { saved.set(k, r); },
    async delete(k) { return saved.delete(k); },
  };
  const store = cacheStore(cache);
  const key = lockoutKey('phrase', '2001:db8::1');
  assert.match(key, /^https:\/\/lockout\.internal\/phrase\//);
  await store.put(key, { failures: 5, lockedUntil: T0 });
  assert.equal(saved.get(key).headers.get('cache-control'), `max-age=${LOCKOUT_CACHE_SECONDS}`);
  assert.deepEqual(await store.get(key), { failures: 5, lockedUntil: T0 });
  await store.delete(key);
  assert.equal(await store.get(key), null);
  assert.equal(lockoutKey('phrase', ''), 'https://lockout.internal/phrase/unknown');
});
