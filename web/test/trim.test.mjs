import assert from 'node:assert/strict';
import { test } from 'node:test';

import { crossings, nearestLine, trim } from '../src/trim.ts';

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
const near = (a, b) => Math.abs(a - b) < 1e-6;

test('the bit of a line between two crossing lines is cut away; the ends stay', () => {
  const lines = [{ kind: 'cut', pts: [[0, 0], [100, 0]] }];
  const cutters = [[[30, -10], [30, 10]], [[60, -10], [60, 10]]];
  const hit = nearestLine(lines, [45, 1], 2);
  assert.ok(hit);
  const { keep, removed } = trim(lines, hit, cutters);
  assert.equal(keep.length, 2);
  assert.deepEqual(keep.map((l) => l.pts), [[[0, 0], [30, 0]], [[60, 0], [100, 0]]]);
  assert.deepEqual(removed, [[[30, 0], [60, 0]]]);
});

test('clicking past the last crossing trims to the end of the line', () => {
  const lines = [{ kind: 'score', pts: [[0, 0], [100, 0]] }];
  const { keep } = trim(lines, nearestLine(lines, [80, 0], 1), [[[30, -10], [30, 10]]]);
  assert.deepEqual(keep, [{ kind: 'score', pts: [[0, 0], [30, 0]] }]);
});

test('a line nothing crosses is removed completely', () => {
  const lines = [{ kind: 'cut', pts: [[0, 0], [100, 0]] }, { kind: 'cut', pts: [[0, 50], [100, 50]] }];
  const { keep } = trim(lines, nearestLine(lines, [50, 0], 1), [lines[1].pts]);
  assert.deepEqual(keep, [lines[1]]);
});

test('a box crossed by a line loses only the side between the crossings', () => {
  const box = { kind: 'cut', pts: rect(0, 0, 40, 40) };
  const bar = [[20, -10], [20, 50]]; // crosses the top and bottom sides at x = 20
  const hit = nearestLine([box], [30, 0], 1); // the top side, right of the bar
  const { keep, removed } = trim([box], hit, [bar]);
  assert.equal(keep.length, 1);
  const left = keep[0].pts;
  // what stays runs from the bottom crossing round the left side to the top crossing
  assert.ok(near(left[0][0], 20) && near(left[0][1], 40));
  assert.ok(near(left.at(-1)[0], 20) && near(left.at(-1)[1], 0));
  assert.ok(left.some(([x, y]) => x === 0 && y === 0));
  assert.ok(removed[0].some(([x, y]) => x === 40 && y === 40));
});

test('a closed loop with fewer than two crossings goes completely', () => {
  const box = { kind: 'cut', pts: rect(0, 0, 40, 40) };
  const { keep } = trim([box], nearestLine([box], [20, 0], 1), [[[-10, 20], [10, 20]]]);
  assert.deepEqual(keep, []);
});

test('touching at a line end is not a crossing that splits it', () => {
  assert.deepEqual(crossings([[0, 0], [10, 0]], [[[10, 0], [10, 10]]]), [1]);
});

test('nothing within reach: no hit', () => {
  assert.equal(nearestLine([{ kind: 'cut', pts: [[0, 0], [10, 0]] }], [5, 5], 1), null);
});

// Dalton's rule: hidden colours still run on the laser, so Trim must keep them.
import { nearestShown } from '../src/trim.ts';

test('a hidden colour cannot be clicked, and trimming another line keeps it', () => {
  const lines = [
    { kind: 'score', pts: [[0, 1], [100, 1]] }, // hidden, right under the click
    { kind: 'cut', pts: [[0, 0], [100, 0]] },
    { kind: 'engrave', pts: [[0, 50], [100, 50]] }, // hidden, far away
  ];
  const hidden = new Set(['score', 'engrave']);
  const hit = nearestShown(lines, [45, 1], 2, hidden);
  assert.equal(hit.line, 1, 'the cut line, by its index among ALL lines');
  const { keep } = trim(lines, hit, [[[30, -10], [30, 10]], [[60, -10], [60, 10]]]);
  assert.deepEqual(keep.filter((l) => l.kind !== 'cut'), [lines[0], lines[2]], 'hidden lines kept as they were');
  assert.equal(keep.filter((l) => l.kind === 'cut').length, 2, 'the cut line lost its middle');
  assert.equal(nearestShown(lines, [45, 50], 2, hidden), null, 'only a hidden line there: nothing to click');
});
