import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpError } from '../src/http.ts';
import { validateTestCard } from '../src/testcard.ts';

const ok = { op: 'engrave', powers: [10, 20, 30], speeds: [100, 200] };

test('a sane test card is rebuilt from its own fields only', () => {
  assert.deepEqual(validateTestCard({ ...ok, machine: { absoluteMaxPowerPct: 100 }, extra: 1 }), ok);
  assert.deepEqual(validateTestCard({ ...ok, hatchMm: 0.2 }).hatchMm, 0.2);
});

test('bad test cards are refused', () => {
  for (const b of [null, { ...ok, op: 'burn' }, { ...ok, powers: [10] }, { ...ok, powers: [10, 101] }, { ...ok, speeds: [0, 10] },
    { ...ok, powers: Array(8).fill(10) }, { ...ok, speeds: 'fast' }, { ...ok, hatchMm: 5 }]) {
    assert.throws(() => validateTestCard(b), HttpError);
  }
});
