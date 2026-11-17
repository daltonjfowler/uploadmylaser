import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// fillarea.ts imports './trace' the Vite way (no extension); Node needs the .ts
registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx); } catch (e) { if (spec.startsWith('.') && !spec.endsWith('.ts')) return next(`${spec}.ts`, ctx); throw e; }
  },
});
const { fillArea, loopsD } = await import('../src/fillarea.ts');
const { area } = await import('../src/trace.ts');

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const boxOf = (loops) => {
  const xs = loops.flat().map((p) => p[0]), ys = loops.flat().map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

test('a square made of four loose lines fills to the middle of its lines', () => {
  const lines = [[[0, 0], [100, 0]], [[100, 0], [100, 100]], [[100, 100], [0, 100]], [[0, 100], [0, 0]]];
  const r = fillArea(lines, [50, 50]);
  assert.ok('loops' in r, JSON.stringify(r));
  assert.equal(r.loops.length, 1);
  const [x0, y0, x1, y1] = boxOf(r.loops);
  for (const [a, b] of [[x0, 0], [y0, 0], [x1, 100], [y1, 100]]) assert.ok(near(a, b, 0.3), `${a} vs ${b}`);
  assert.ok(near(r.areaMm2, 10000, 400), String(r.areaMm2));
});

test('the ship: a curve hanging off a bar line, closed by the bar, fills; the bar does not', () => {
  // bar from x 0..200 at y 50; a "hull" from (60,50) down round to (140,50)
  const hull = [];
  for (let k = 0; k <= 32; k++) { const t = Math.PI * (k / 32); hull.push([100 - 40 * Math.cos(t), 50 + 30 * Math.sin(t)]); }
  const lines = [[[0, 50], [200, 50]], hull, [[0, 0], [200, 0]], [[0, 0], [0, 100]], [[200, 0], [200, 100]], [[0, 100], [200, 100]]];
  const r = fillArea(lines, [100, 60]);
  assert.ok('loops' in r, JSON.stringify(r));
  const [x0, y0, x1, y1] = boxOf(r.loops);
  assert.ok(near(x0, 60, 1) && near(x1, 140, 1) && near(y0, 50, 1) && near(y1, 80, 1), String([x0, y0, x1, y1]));
});

test('islands stay out: a circle inside the area becomes a hole', () => {
  const circle = [];
  for (let k = 0; k <= 48; k++) { const t = (2 * Math.PI * k) / 48; circle.push([50 + 10 * Math.cos(t), 50 + 10 * Math.sin(t)]); }
  const r = fillArea([rect(0, 0, 100, 100), circle], [20, 20]);
  assert.ok('loops' in r);
  assert.equal(r.loops.length, 2); // the outside edge and the hole round the circle
  const areas = r.loops.map(area).sort((a, b) => a - b);
  assert.ok(areas[0] < 400 && areas[1] > 9000, String(areas));
  assert.ok(near(r.areaMm2, 10000 - Math.PI * 100, 500), String(r.areaMm2));
  assert.match(loopsD(r.loops), /^M[\d. ]+ L.* Z M.* Z$/);
});

test('a gap the flood can get out through: not closed in', () => {
  const lines = [[[0, 0], [100, 0]], [[100, 0], [100, 100]], [[100, 100], [0, 100]], [[0, 100], [0, 20]]]; // 20 mm gap
  assert.deepEqual(fillArea(lines, [50, 50]), { error: 'open' });
});

test('a hairline gap (smaller than the grid sees) is sealed', () => {
  const lines = [[[0, 0], [100, 0]], [[100, 0], [100, 100]], [[100, 100], [0, 100]], [[0, 100], [0, 0.02]]];
  assert.ok('loops' in fillArea(lines, [50, 50]));
});

test('outside the drawing, on a line, or nothing to fill', () => {
  assert.deepEqual(fillArea([rect(0, 0, 10, 10)], [50, 50]), { error: 'open' });
  assert.deepEqual(fillArea([rect(0, 0, 10, 10)], [0, 5]), { error: 'line' });
  assert.deepEqual(fillArea([], [0, 0]), { error: 'nothing' });
});

test('a ring that narrows to 0.6 mm on a big board fills all the way round, smoothly (Saturn)', () => {
  const circle = (cx, cy, r) => Array.from({ length: 361 }, (_, k) => [cx + r * Math.cos((k * Math.PI) / 180), cy + r * Math.sin((k * Math.PI) / 180)]);
  // outer r 20; inner r 17.7 shifted down: 4 mm of band at the top, 0.6 mm at the bottom
  const lines = [rect(0, 0, 600, 600), circle(300, 300, 20), circle(300, 301.7, 17.7)];
  const r = fillArea(lines, [300, 282]);
  assert.ok('loops' in r, JSON.stringify(r));
  const want = Math.PI * (20 * 20 - 17.7 * 17.7);
  assert.ok(Math.abs(r.areaMm2 - want) < want * 0.05, `${r.areaMm2} vs ${want}`);
  // smooth: every edge point within 0.1 mm of one of the two circles
  for (const l of r.loops) for (const [x, y] of l) {
    const d = Math.min(Math.abs(Math.hypot(x - 300, y - 300) - 20), Math.abs(Math.hypot(x - 300, y - 301.7) - 17.7));
    assert.ok(d < 0.1, `edge point ${x},${y} is ${d} mm off`);
  }
});

test('pieces that miss each other by 0.08 mm still fill on the fine grid', () => {
  const lines = [rect(0, 0, 600, 600), [[100, 100], [130, 100.08]], [[130, 100], [130, 130]], [[130.08, 130], [100, 130]], [[100, 130], [100, 100.08]]];
  const r = fillArea(lines, [115, 115]);
  assert.ok('loops' in r);
  for (const l of r.loops) for (const [x, y] of l) assert.ok(x > 99.8 && x < 130.3 && y > 99.8 && y < 130.3);
  assert.ok(Math.abs(r.areaMm2 - 900) < 20, String(r.areaMm2));
});

test('a small space on a big board comes out fine, not blocky (second, finer look)', () => {
  const lines = [rect(0, 0, 1000, 600), rect(500, 300, 4, 4)];
  const r = fillArea(lines, [502, 302]);
  assert.ok('loops' in r);
  const [x0, y0, x1, y1] = boxOf(r.loops);
  assert.ok(near(x0, 500, 0.1) && near(x1, 504, 0.1) && near(y0, 300, 0.1) && near(y1, 304, 0.1), String([x0, y0, x1, y1]));
});
