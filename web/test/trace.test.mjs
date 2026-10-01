import assert from 'node:assert/strict';
import { test } from 'node:test';

import { area, bounds, pointCount, simplify, smoothLoop, toDxf, trace, traceLoops } from '../src/trace.ts';

/** A bitmap from rows of '#' (ink) and '.' (blank). */
function bits(rows) {
  const w = rows[0].length;
  return { w, h: rows.length, ink: Uint8Array.from(rows.join('').split('').map((c) => (c === '#' ? 1 : 0))) };
}

test('a filled square is one loop with four corners', () => {
  const { ink, w, h } = bits(['....', '.##.', '.##.', '....']);
  const loops = traceLoops(ink, w, h);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].length, 4);
  assert.equal(area(loops[0]), 4);
});

test('a ring gives an outer loop and a hole, turning opposite ways', () => {
  const { ink, w, h } = bits(['#####', '#...#', '#...#', '#...#', '#####']);
  const loops = traceLoops(ink, w, h);
  assert.equal(loops.length, 2);
  const signed = (l) => l.reduce((s, p, i) => { const q = l[(i + 1) % l.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0);
  assert.ok(Math.sign(signed(loops[0])) !== Math.sign(signed(loops[1])));
  assert.deepEqual(loops.map(area).sort((a, b) => a - b), [9, 25]);
});

test('two blobs touching at a corner stay two loops', () => {
  const { ink, w, h } = bits(['##..', '##..', '..##', '..##']);
  assert.equal(traceLoops(ink, w, h).length, 2);
});

test('specks are dropped, and the staircase of a slope is straightened', () => {
  const rows = [];
  for (let y = 0; y < 40; y++) rows.push(Array.from({ length: 40 }, (_, x) => (x <= y ? '#' : '.')).join(''));
  rows[2] = rows[2].slice(0, 30) + '#' + rows[2].slice(31); // a one-pixel speck
  const { ink, w, h } = bits(rows);
  const loops = trace(ink, w, h, 0.5, { minAreaPx: 4, tolerancePx: 0.8, smooth: 0 });
  assert.equal(loops.length, 1);
  assert.ok(loops[0].length <= 5, `triangle has ${loops[0].length} points`);
  assert.ok(pointCount(loops) < 10);
});

test('smoothing keeps sharp corners and rounds gentle ones', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.deepEqual(smoothLoop(square, 2), square);
  const octagon = Array.from({ length: 8 }, (_, i) => [Math.cos((i * Math.PI) / 4) * 10, Math.sin((i * Math.PI) / 4) * 10]);
  assert.ok(smoothLoop(octagon, 1).length === 16);
  assert.ok(simplify(square, 1).length === 4);
});

test('the DXF has one closed polyline per loop, in mm, y up', () => {
  const dxf = toDxf([[[0, 0], [10, 0], [10, 5]], [[1, 1], [2, 1], [2, 2]]]);
  assert.equal(dxf.match(/\r\nPOLYLINE\r\n/g).length, 2);
  assert.ok(dxf.includes('$INSUNITS\r\n70\r\n4'));
  assert.ok(dxf.startsWith('0\r\nSECTION') && dxf.trimEnd().endsWith('EOF'));
  assert.ok(dxf.includes('10\r\n10\r\n20\r\n5\r\n')); // (10, 0) becomes y = 5 - 0
});

test('a busy photo (hundreds of thousands of points) traces, and its DXF and size do not run out of stack', () => {
  const w = 600, h = 600;
  let seed = 1;
  const ink = Uint8Array.from({ length: w * h }, () => ((seed = (seed * 16807) % 2147483647) / 2147483647 < 0.5 ? 1 : 0));
  const loops = trace(ink, w, h, 0.1, { minAreaPx: 2, tolerancePx: 0.3, smooth: 0 });
  assert.ok(pointCount(loops) > 100_000, `only ${pointCount(loops)} points`);
  const [x0, y0, x1, y1] = bounds(loops);
  assert.ok(x0 >= 0 && y0 >= 0 && x1 <= 60 && y1 <= 60 && x1 > 50);
  assert.ok(toDxf(loops).trimEnd().endsWith('EOF'));
});

test('a long smooth outline simplifies without recursion trouble', () => {
  const circle = Array.from({ length: 200_000 }, (_, i) => [Math.cos(i / 31831) * 1000, Math.sin(i / 31831) * 1000]);
  const out = simplify(circle, 0.5);
  assert.ok(out.length > 20 && out.length < 2000, `${out.length} points`);
});

test('bounds of nothing is a zero box', () => {
  assert.deepEqual(bounds([]), [0, 0, 0, 0]);
});
