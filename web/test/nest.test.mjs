import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nest, spinQ } from '../src/nest.ts';

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
const item = (paths) => {
  const xs = paths.flat().map((p) => p[0]);
  const ys = paths.flat().map((p) => p[1]);
  return { box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], paths, rects: [] };
};
/** Where the item's lines end up after its move. */
const placed = (it, m) => {
  const cx = (it.box[0] + it.box[2]) / 2;
  const cy = (it.box[1] + it.box[3]) / 2;
  return it.paths.map((path) => path.map(([x, y]) => { const [a, b] = spinQ(m.turns, cx, cy, x, y); return [a + m.dx, b + m.dy]; }));
};
const bounds = (paths) => {
  const pts = paths.flat();
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
};
/** Gap between two boxes (0 when they touch or overlap). */
const boxGap = (a, b) => Math.max(a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3], 0);
const opts = { gapMm: 3, turns: false, fromRight: true, fromBottom: false };

test('boxes pack into the home corner, inside the region, at least the gap apart', () => {
  const items = [item([rect(500, 500, 100, 50)]), item([rect(10, 700, 80, 80)]), item([rect(900, 100, 40, 120)])];
  const region = [0, 0, 1219, 914];
  const r = nest(items, region, opts);
  assert.ok(r.ok);
  const boxes = items.map((it, k) => bounds(placed(it, r.moves[k])));
  for (const b of boxes) assert.ok(b[0] >= 0 && b[1] >= 0 && b[2] <= 1219 && b[3] <= 914, `inside: ${b}`);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(boxGap(boxes[i], boxes[j]) >= 3 - 1e-9, `gap ${i},${j}`);
  // everything sits in the top-right corner: one short row
  const all = bounds(boxes.map((b) => [[b[0], b[1]], [b[2], b[3]]]));
  assert.ok(all[2] > 1200 && all[1] < 10, `corner: ${all}`);
  assert.ok(all[3] < 140, `one row: ${all}`);
});

test('a small square tucks into the notch of an L (real shapes, not boxes)', () => {
  const L = item([[[0, 0], [100, 0], [100, 30], [30, 30], [30, 100], [0, 100], [0, 0]]]);
  const sq = item([rect(300, 300, 40, 40)]);
  const region = [0, 0, 110, 110]; // room for the L only: the square must use its notch
  const r = nest([L, sq], region, { ...opts, fromRight: false });
  assert.ok(r.ok);
  const lb = bounds(placed(L, r.moves[0]));
  const sb = bounds(placed(sq, r.moves[1]));
  assert.ok(sb[0] >= lb[0] && sb[2] <= lb[2] && sb[1] >= lb[1] && sb[3] <= lb[3], `square inside the L's box: ${sb} / ${lb}`);
});

test('nothing is put inside another piece\'s hole', () => {
  const frame = item([rect(0, 0, 100, 100), rect(20, 20, 60, 60)]);
  const small = item([rect(500, 500, 20, 20)]);
  const r = nest([frame, small], [0, 0, 300, 120], { ...opts, fromRight: false });
  assert.ok(r.ok);
  const fb = bounds(placed(frame, r.moves[0]));
  const sb = bounds(placed(small, r.moves[1]));
  assert.ok(boxGap(fb, sb) >= 3 - 1e-9, `outside the frame: ${sb} / ${fb}`);
});

test('a long bar turns to fit a tall narrow board, only when turning is allowed', () => {
  const bar = item([rect(0, 0, 500, 20)]);
  const region = [0, 0, 100, 600];
  assert.deepEqual(nest([bar], region, opts), { ok: false, left: 1 });
  const r = nest([bar], region, { ...opts, turns: true });
  assert.ok(r.ok);
  assert.equal(r.moves[0].turns % 2, 1);
  const b = bounds(placed(bar, r.moves[0]));
  assert.ok(b[0] >= 0 && b[2] <= 100 && b[1] >= 0 && b[3] <= 600, `${b}`);
});

test('too much for the board: says how many are left and moves nothing', () => {
  const items = [1, 2, 3].map((k) => item([rect(k * 100, 0, 60, 60)]));
  assert.deepEqual(nest(items, [0, 0, 130, 70], opts), { ok: false, left: 1 });
});

test('pieces that stay put are kept clear of', () => {
  const still = item([rect(0, 0, 50, 50)]); // in the home corner already (fromRight false)
  const mover = item([rect(400, 400, 30, 30)]);
  const r = nest([mover], [0, 0, 200, 200], { ...opts, fromRight: false }, [still]);
  assert.ok(r.ok);
  assert.ok(boxGap(bounds(placed(mover, r.moves[0])), still.box) >= 3 - 1e-9);
});

test('a part with no lines yet packs by its box', () => {
  const a = { box: [0, 0, 50, 50], paths: [], rects: [[0, 0, 50, 50]] };
  const b = { box: [300, 300, 350, 350], paths: [], rects: [[300, 300, 350, 350]] };
  const r = nest([a, b], [0, 0, 200, 100], { ...opts, fromRight: false });
  assert.ok(r.ok);
  const pa = [a.box[0] + r.moves[0].dx, a.box[1] + r.moves[0].dy, a.box[2] + r.moves[0].dx, a.box[3] + r.moves[0].dy];
  const pb = [b.box[0] + r.moves[1].dx, b.box[1] + r.moves[1].dy, b.box[2] + r.moves[1].dx, b.box[3] + r.moves[1].dy];
  assert.ok(boxGap(pa, pb) >= 3 - 1e-9);
});

test('500 mixed pieces on the full bed finish quickly', () => {
  const items = [];
  for (let k = 0; k < 500; k++) items.push(item([rect(0, 0, 10 + (k * 37) % 40, 10 + (k * 53) % 30)]));
  const t = performance.now();
  const r = nest(items, [0, 0, 1219, 914], { ...opts, turns: true });
  const ms = performance.now() - t;
  assert.ok(r.ok);
  assert.ok(ms < 8000, `${ms} ms`);
});
