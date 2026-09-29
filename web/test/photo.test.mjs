import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pbmSize, runCount, toDots, toPbm } from '../src/photo.ts';

const LOOK = { brightness: 0, contrast: 0, invert: false, mode: 'dither' };

test('black burns, white does not, grey dithers to about half', () => {
  const w = 40, h = 40;
  const dots = (v, look = LOOK) => toDots(new Float32Array(w * h).fill(v), w, h, look);
  assert.equal(dots(0).reduce((a, b) => a + b, 0), w * h);
  assert.equal(dots(255).reduce((a, b) => a + b, 0), 0);
  const half = dots(128).reduce((a, b) => a + b, 0) / (w * h);
  assert.ok(half > 0.4 && half < 0.6, String(half));
  assert.equal(dots(255, { ...LOOK, invert: true }).reduce((a, b) => a + b, 0), w * h);
  assert.equal(dots(100, { ...LOOK, mode: 'threshold' }).reduce((a, b) => a + b, 0), w * h);
});

test('runs count engrave lines per row', () => {
  assert.equal(runCount(Uint8Array.from([1, 1, 0, 1, 0, 0, 0, 0]), 4, 2), 2);
});

test('the PBM carries its size, and bits are packed high bit first', () => {
  const s = toPbm(Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 1]), 9, 1, 0.2);
  assert.deepEqual(pbmSize(s), [9 * 0.2, 0.2]);
  const body = s.slice(s.indexOf('9 1\n') + 4);
  assert.deepEqual([...body].map((c) => c.charCodeAt(0)), [0x80, 0x80]);
});
