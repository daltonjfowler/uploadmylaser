// Class phrase normalizing, TTL clamping, and expiry enforced on read.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activeRecord, clampTtlMinutes, DEFAULT_TTL_MINUTES, isUsablePhrase, MAX_TTL_MINUTES, MIN_TTL_MINUTES, normalizePhrase,
} from '../src/phrase.ts';

test('normalizePhrase trims, lowercases and collapses spaces', () => {
  assert.equal(normalizePhrase('  Blue   Robot\tPancake '), 'blue robot pancake');
  assert.equal(normalizePhrase(undefined), '');
  assert.equal(normalizePhrase(42), '');
});

test('isUsablePhrase: 4 to 64 characters', () => {
  assert.equal(isUsablePhrase('abc'), false);
  assert.equal(isUsablePhrase('abcd'), true);
  assert.equal(isUsablePhrase('x'.repeat(64)), true);
  assert.equal(isUsablePhrase('x'.repeat(65)), false);
});

test('clampTtlMinutes', () => {
  assert.equal(clampTtlMinutes(60), 60);
  assert.equal(clampTtlMinutes('480'), 480);
  assert.equal(clampTtlMinutes(1), MIN_TTL_MINUTES);
  assert.equal(clampTtlMinutes(1e9), MAX_TTL_MINUTES);
  assert.equal(clampTtlMinutes(10080), 10080);
  for (const junk of [undefined, null, '', 'soon', NaN, Infinity, {}]) assert.equal(clampTtlMinutes(junk), DEFAULT_TTL_MINUTES);
});

test('activeRecord returns the phrase before expiresAt', () => {
  assert.deepEqual(activeRecord({ phrase: 'blue robot', expiresAt: 2000 }, 1000), { phrase: 'blue robot', expiresAt: 2000 });
});

test('activeRecord refuses an expired record even if KV still returns it', () => {
  assert.equal(activeRecord({ phrase: 'blue robot', expiresAt: 2000 }, 2000), null);
  assert.equal(activeRecord({ phrase: 'blue robot', expiresAt: 2000 }, 3000), null);
});

test('activeRecord refuses junk', () => {
  for (const v of [null, 'blue robot', 7, {}, { phrase: 'blue robot' }, { phrase: 'ab', expiresAt: 9e15 },
    { phrase: 'blue robot', expiresAt: '9999999999999' }, { phrase: 'blue robot', expiresAt: NaN }]) {
    assert.equal(activeRecord(v, 1000), null, JSON.stringify(v));
  }
});
