// The box maker's panels must fit: along every joint, each spot belongs to exactly one of the two panels.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boxPanels, fingerCount, outsideSize } from '../src/boxmaker.ts';

function points(d) {
  return d.replace(/[MZ]/g, '').split('L').map((p) => p.trim().split(/\s+/).map(Number));
}

function inside([x, y], poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const SPEC = { w: 120, d: 80, h: 60, t: 3.2, lid: true, kerf: 0, finger: 10 };

/** Sample spots along a joint, away from the finger changes (where the answer is on the line). */
function samples(len, finger) {
  const n = fingerCount(len, finger);
  const out = [];
  for (let s = 0.05; s < len; s += 0.37) {
    const k = (s * n) / len;
    if (Math.abs(k - Math.round(k)) * (len / n) > 0.05) out.push(s);
  }
  return out;
}

test('finger counts are odd and at least 3', () => {
  for (const [len, f] of [[10, 10], [60, 10], [61, 10], [200, 9.6], [30, 50]]) {
    const n = fingerCount(len, f);
    assert.ok(n >= 3 && n % 2 === 1, `${len}/${f} -> ${n}`);
  }
});

test('six panels with a lid, five without, each its full outside size', () => {
  const p = boxPanels(SPEC);
  assert.deepEqual(p.map((x) => x.name), ['Front', 'Back', 'Left side', 'Right side', 'Bottom', 'Lid']);
  assert.equal(boxPanels({ ...SPEC, lid: false }).length, 5);
  for (const panel of p) {
    const pts = points(panel.d);
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [0, panel.w, 0, panel.h], panel.name);
  }
});

test('every joint fits: each spot is in exactly one of the two panels', () => {
  const [front, , left, , bottom, lid] = boxPanels(SPEC).map((x) => points(x.d));
  const { w, d, h, t, finger } = SPEC;
  const m = t / 2;
  // front upright edge <-> side upright edge
  for (const s of samples(h, finger)) assert.equal(inside([m, s], front) + inside([m, s], left), 1, `upright at ${s}`);
  // front bottom edge <-> bottom panel's front edge
  for (const s of samples(w, finger)) assert.equal(inside([s, h - m], front) + inside([s, m], bottom), 1, `front/bottom at ${s}`);
  // side bottom edge <-> bottom panel's side edge
  // (the first and last t along the depth are the front and back walls' corners)
  for (const s of samples(d, finger)) {
    if (s < t || s > d - t) assert.equal(inside([s, h - m], left) + inside([m, s], bottom), 0, `corner at ${s}`);
    else assert.equal(inside([s, h - m], left) + inside([m, s], bottom), 1, `side/bottom at ${s}`);
  }
  // and the front owns that corner block
  assert.equal(inside([m, h - m], front), true);
  // front top edge <-> lid
  for (const s of samples(w, finger)) assert.equal(inside([s, m], front) + inside([s, m], lid), 1, `front/lid at ${s}`);
});

test('an open box has a straight top edge', () => {
  const [front] = boxPanels({ ...SPEC, lid: false }).map((x) => points(x.d));
  for (let s = 5; s < SPEC.w - 5; s += 1) assert.equal(inside([s, 0.5], front), true);
});

test('kerf widens fingers so the joint overlaps a little', () => {
  const tight = boxPanels({ ...SPEC, kerf: 0.2 }).map((x) => points(x.d));
  const [front, , left] = tight;
  let both = 0;
  for (let s = 0.05; s < SPEC.h; s += 0.01) if (inside([1.6, s], front) && inside([1.6, s], left)) both++;
  assert.ok(both > 0, 'some overlap with kerf');
});

test('inside sizes add the walls', () => {
  assert.deepEqual(outsideSize(100, 50, 40, 3, true, true), { w: 106, d: 56, h: 46 });
  assert.deepEqual(outsideSize(100, 50, 40, 3, true, false), { w: 106, d: 56, h: 43 });
  assert.deepEqual(outsideSize(100, 50, 40, 3, false, true), { w: 100, d: 50, h: 40 });
});
