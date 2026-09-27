// Class phrase normalizing, TTL clamping, and expiry enforced on read.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activeRecord, clampTtlMinutes, DEFAULT_TTL_MINUTES, isUsablePhrase, MAX_TTL_MINUTES, MIN_PHRASE_LENGTH, MIN_TTL_MINUTES,
  normalizePhrase, phraseLengthMessage,
} from '../src/phrase.ts';
import { generatePhrase, WORDS } from '../web/src/phrase-words.ts';

test('normalizePhrase trims, lowercases and collapses spaces', () => {
  assert.equal(normalizePhrase('  Blue   Robot\tPancake '), 'blue robot pancake');
  assert.equal(normalizePhrase(undefined), '');
  assert.equal(normalizePhrase(42), '');
});

test('isUsablePhrase: 12 to 64 characters', () => {
  assert.equal(MIN_PHRASE_LENGTH, 12);
  assert.equal(isUsablePhrase('robot'), false);
  assert.equal(isUsablePhrase('x'.repeat(11)), false);
  assert.equal(isUsablePhrase('x'.repeat(12)), true);
  assert.equal(isUsablePhrase('x'.repeat(64)), true);
  assert.equal(isUsablePhrase('x'.repeat(65)), false);
  assert.match(phraseLengthMessage(), /at least 12 characters/);
});

test('generated phrases: three different words and a 2-digit number, always long enough', () => {
  for (let i = 0; i < 500; i++) {
    const p = generatePhrase();
    const m = /^([a-z]+)-([a-z]+)-([a-z]+)-([1-9][0-9])$/.exec(p);
    assert.ok(m, p);
    assert.equal(new Set([m[1], m[2], m[3]]).size, 3, p);
    assert.ok([m[1], m[2], m[3]].every((w) => WORDS.includes(w)), p);
    assert.ok(isUsablePhrase(normalizePhrase(p)), p);
  }
});

test('the word list gives at least 2^28 phrases and stays plain and kid-safe', () => {
  const n = WORDS.length;
  assert.equal(new Set(WORDS).size, n, 'no repeated words');
  assert.ok(n * (n - 1) * (n - 2) * 90 >= 2 ** 28, `only ${n} words`);
  for (const w of WORDS) assert.match(w, /^[a-z]{3,9}$/, w);
  // A spot check, not the whole review: names and words with a second meaning stay out.
  const never = ['hazel', 'jasper', 'lily', 'ginger', 'olive', 'raven', 'willow', 'cherry', 'peach', 'melon', 'nuts',
    'balls', 'buns', 'booty', 'beaver', 'weed', 'pot', 'crack', 'pipe', 'needle', 'screw', 'kitty'];
  for (const w of never) assert.ok(!WORDS.includes(w), w);
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
  assert.deepEqual(activeRecord({ phrase: 'blue robot pancake', expiresAt: 2000 }, 1000), { phrase: 'blue robot pancake', expiresAt: 2000 });
});

test('activeRecord refuses an expired record even if KV still returns it', () => {
  assert.equal(activeRecord({ phrase: 'blue robot pancake', expiresAt: 2000 }, 2000), null);
  assert.equal(activeRecord({ phrase: 'blue robot pancake', expiresAt: 2000 }, 3000), null);
});

test('activeRecord refuses junk', () => {
  for (const v of [null, 'blue robot pancake', 7, {}, { phrase: 'blue robot pancake' }, { phrase: 'robots', expiresAt: 9e15 },
    { phrase: 'blue robot pancake', expiresAt: '9999999999999' }, { phrase: 'blue robot pancake', expiresAt: NaN }]) {
    assert.equal(activeRecord(v, 1000), null, JSON.stringify(v));
  }
});
