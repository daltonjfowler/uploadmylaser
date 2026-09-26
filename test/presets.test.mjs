// Teacher preset validation: banned materials (safety invariant 4) and power caps.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpError } from '../src/http.ts';
import { publicMaterials, validateMachine, validateMaterials } from '../src/presets.ts';
import { DEFAULT_MACHINE, SEED_MATERIALS } from '../src/seed.ts';

const mat = (over = {}) => ({
  id: 'birch', name: 'Birch ply', thicknessMm: 3, enabled: true,
  ops: { cut: { speedMmS: 20, powerMinPct: 50, powerMaxPct: 60, passes: 1 } }, ...over,
});

test('the seed materials pass their own validation', () => {
  assert.equal(validateMaterials(SEED_MATERIALS, DEFAULT_MACHINE).length, SEED_MATERIALS.length);
});

test('banned materials are refused', () => {
  for (const name of ['PVC sheet', 'Vinyl', 'clear polycarbonate', 'ABS', 'Coated board']) {
    assert.throws(() => validateMaterials([mat({ name })], DEFAULT_MACHINE), (e) => e instanceof HttpError && /not safe/.test(e.message), name);
  }
});

test('power above the machine cap and speed below the minimum are refused', () => {
  assert.throws(() => validateMaterials([mat({ ops: { cut: { speedMmS: 20, powerMinPct: 0, powerMaxPct: 81, passes: 1 } } })], DEFAULT_MACHINE), HttpError);
  assert.throws(() => validateMaterials([mat({ ops: { cut: { speedMmS: 1, powerMinPct: 0, powerMaxPct: 50, passes: 1 } } })], DEFAULT_MACHINE), HttpError);
});

test('junk input is a 400, not a crash', () => {
  for (const body of [null, {}, [null], [7], [mat({ ops: { cut: 'hot' } })]]) {
    assert.throws(() => validateMaterials(body, DEFAULT_MACHINE), HttpError);
  }
  for (const body of [null, 7, [], {}]) assert.throws(() => validateMachine(body), HttpError);
});

test('unknown fields are not stored', () => {
  const [m] = validateMaterials([{ ...mat(), evil: 1, ops: { cut: { ...mat().ops.cut, evil: 2 } } }], DEFAULT_MACHINE);
  assert.doesNotMatch(JSON.stringify(m), /evil/);
});

test('students never see speeds', () => {
  assert.doesNotMatch(JSON.stringify(publicMaterials(SEED_MATERIALS)), /speed/i);
});
