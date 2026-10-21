// Auto arrange (Dalton 2026-10-21): pack pieces close together to save material. Each piece is drawn onto
// a grid by its real outline (holes count as filled, so nothing lands inside another piece's hole), then
// placed as near the home corner as it fits: along the first row, then the next. Quarter turns are tried
// when allowed. A grid cell is never shared, and placed pieces are grown by the gap first, so pieces end at
// least `gapMm` apart.
import type { Box } from './workspace';

/** One piece that moves as a whole. paths and rects in bed mm; box is the piece's bounds, turned about. */
export interface NestItem { box: Box; paths: [number, number][][]; rects: Box[] }
/** Counter-clockwise quarter turns about the item's box centre, then a move by dx, dy (bed mm). */
export interface NestMove { turns: number; dx: number; dy: number }
export interface NestOpts { gapMm: number; turns: boolean; fromRight: boolean; fromBottom: boolean }
export type NestResult = { ok: true; moves: NestMove[] } | { ok: false; left: number };

/** About this many grid cells over the whole area: fine enough for small parts, fast enough for a big bed. */
const CELLS = 250_000;

/** Turn a point counter-clockwise on screen (y points down) by q quarter turns about cx, cy, like rotateBy. */
export function spinQ(q: number, cx: number, cy: number, x: number, y: number): [number, number] {
  const dx = x - cx;
  const dy = y - cy;
  switch (((q % 4) + 4) % 4) {
    case 1: return [cx + dy, cy - dx];
    case 2: return [cx - dx, cy - dy];
    case 3: return [cx - dy, cy + dx];
    default: return [x, y];
  }
}

/** The box after q quarter turns about its own centre. */
function turnedBox(b: Box, q: number): Box {
  if (q % 2 === 0) return b;
  const cx = (b[0] + b[2]) / 2;
  const cy = (b[1] + b[3]) / 2;
  const hw = (b[3] - b[1]) / 2;
  const hh = (b[2] - b[0]) / 2;
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

/** A piece on the grid: per row, runs of filled cells [a, b] (inclusive), as flat arrays. */
interface Mask { w: number; h: number; start: Int32Array; a: Int32Array; b: Int32Array; cells: number }

/** Grid coordinates count from the home corner: u across, v down (or up, from a bottom corner). */
interface Frame { x0: number; y0: number; x1: number; y1: number; right: boolean; bottom: boolean; c: number }
const fu = (f: Frame, x: number) => (f.right ? f.x1 - x : x - f.x0);
const fv = (f: Frame, y: number) => (f.bottom ? f.y1 - y : y - f.y0);

/** Draw an item, turned q times, onto its own small grid; fill everything its outlines enclose. */
function maskOf(item: NestItem, q: number, f: Frame): { mask: Mask; u0: number; v0: number } {
  const { c } = f;
  const cx = (item.box[0] + item.box[2]) / 2;
  const cy = (item.box[1] + item.box[3]) / 2;
  const tb = turnedBox(item.box, q);
  const ua = fu(f, tb[0]), ub = fu(f, tb[2]), va = fv(f, tb[1]), vb = fv(f, tb[3]);
  const u0 = Math.min(ua, ub), v0 = Math.min(va, vb);
  const w = Math.floor((Math.max(ua, ub) - u0) / c) + 1;
  const h = Math.floor((Math.max(va, vb) - v0) / c) + 1;
  // one empty cell all round, so the outside is one connected region to flood
  const W = w + 2, H = h + 2;
  const g = new Uint8Array(W * H); // 1 = line, 2 = outside
  const mark = (x: number, y: number) => {
    const [rx, ry] = spinQ(q, cx, cy, x, y);
    const i = Math.min(Math.max(Math.floor((fu(f, rx) - u0) / c), 0), w - 1);
    const j = Math.min(Math.max(Math.floor((fv(f, ry) - v0) / c), 0), h - 1);
    g[(j + 1) * W + i + 1] = 1;
  };
  const step = c * 0.4; // short enough that a line leaves no diagonal gap the flood could slip through
  for (const path of item.paths) {
    if (path.length === 1) mark(path[0][0], path[0][1]);
    for (let k = 1; k < path.length; k++) {
      const [x0, y0] = path[k - 1];
      const [x1, y1] = path[k];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
      for (let s = 0; s <= n; s++) mark(x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n);
    }
  }
  for (const r of item.rects) {
    // a part with no lines yet: its whole box
    const [p, qq] = [spinQ(q, cx, cy, r[0], r[1]), spinQ(q, cx, cy, r[2], r[3])];
    const i0 = Math.floor((Math.min(fu(f, p[0]), fu(f, qq[0])) - u0) / c), i1 = Math.floor((Math.max(fu(f, p[0]), fu(f, qq[0])) - u0) / c);
    const j0 = Math.floor((Math.min(fv(f, p[1]), fv(f, qq[1])) - v0) / c), j1 = Math.floor((Math.max(fv(f, p[1]), fv(f, qq[1])) - v0) / c);
    for (let j = Math.max(j0, 0); j <= Math.min(j1, h - 1); j++) for (let i = Math.max(i0, 0); i <= Math.min(i1, w - 1); i++) g[(j + 1) * W + i + 1] = 1;
  }
  // flood the outside (4-way, so a line of cells touching only at corners still holds it back)
  const stack = new Int32Array(W * H);
  let top = 0;
  stack[top++] = 0;
  g[0] = 2;
  while (top) {
    const k = stack[--top];
    const x = k % W, y = (k - x) / W;
    if (x > 0 && !g[k - 1]) { g[k - 1] = 2; stack[top++] = k - 1; }
    if (x < W - 1 && !g[k + 1]) { g[k + 1] = 2; stack[top++] = k + 1; }
    if (y > 0 && !g[k - W]) { g[k - W] = 2; stack[top++] = k - W; }
    if (y < H - 1 && !g[k + W]) { g[k + W] = 2; stack[top++] = k + W; }
  }
  const start = new Int32Array(h + 1);
  const as: number[] = [];
  const bs: number[] = [];
  let cells = 0;
  for (let j = 0; j < h; j++) {
    start[j] = as.length;
    let i = 0;
    while (i < w) {
      while (i < w && g[(j + 1) * W + i + 1] === 2) i++;
      if (i >= w) break;
      const a = i;
      while (i < w && g[(j + 1) * W + i + 1] !== 2) i++;
      as.push(a);
      bs.push(i - 1);
      cells += i - a;
    }
  }
  start[h] = as.length;
  return { mask: { w, h, start, a: Int32Array.from(as), b: Int32Array.from(bs), cells }, u0, v0 };
}

/** Pack `items` into `region` (bed mm), around the `fixed` pieces that stay put. All fit, or nothing moves. */
export function nest(items: NestItem[], region: Box, opts: NestOpts, fixed: NestItem[] = []): NestResult {
  const [X0, Y0, X1, Y1] = region;
  const c = Math.max(0.5, Math.sqrt(((X1 - X0) * (Y1 - Y0)) / CELLS));
  const f: Frame = { x0: X0, y0: Y0, x1: X1, y1: Y1, right: opts.fromRight, bottom: opts.fromBottom, c };
  const GW = Math.floor((X1 - X0) / c);
  const GH = Math.floor((Y1 - Y0) / c);
  if (GW < 1 || GH < 1) return { ok: false, left: items.length };
  const grow = Math.ceil(opts.gapMm / c - 1e-9);
  const occ = new Uint8Array(GW * GH);
  /** last filled column at or left of each cell in its row, or -1: a clash says how far to jump */
  const prev = new Int32Array(GW * GH);
  const dirty = new Uint8Array(GH);
  const fill = (j0: number, j1: number, i0: number, i1: number) => {
    j0 = Math.max(j0, 0); j1 = Math.min(j1, GH - 1); i0 = Math.max(i0, 0); i1 = Math.min(i1, GW - 1);
    for (let j = j0; j <= j1; j++) {
      occ.fill(1, j * GW + i0, j * GW + i1 + 1);
      dirty[j] = 1;
    }
  };
  const settle = () => {
    for (let j = 0; j < GH; j++) {
      if (!dirty[j]) continue;
      dirty[j] = 0;
      let last = -1;
      for (let i = 0; i < GW; i++) { if (occ[j * GW + i]) last = i; prev[j * GW + i] = last; }
    }
  };
  const stamp = (m: Mask, gx: number, gy: number, pad: number) => {
    for (let r = 0; r < m.h; r++) {
      for (let s = m.start[r]; s < m.start[r + 1]; s++) fill(gy + r - pad, gy + r + pad, gx + m.a[s] - pad, gx + m.b[s] + pad);
    }
  };
  // half the gap at the material's edges, so the outer cuts stay on the board
  const edge = Math.ceil(opts.gapMm / 2 / c - 1e-9);
  if (edge > 0) {
    fill(0, edge - 1, 0, GW - 1);
    fill(GH - edge, GH - 1, 0, GW - 1);
    fill(0, GH - 1, 0, edge - 1);
    fill(0, GH - 1, GW - edge, GW - 1);
  }
  for (const it of fixed) {
    const { mask, u0, v0 } = maskOf(it, 0, f);
    // fixed pieces are not on grid lines: one cell more covers the rounding
    stamp(mask, Math.floor(u0 / c), Math.floor(v0 / c), grow + 1);
  }
  settle();

  /** The leftmost x where m fits on row gy, or -1. */
  const fitX = (m: Mask, gy: number): number => {
    let x = 0;
    scan: while (x <= GW - m.w) {
      for (let r = 0; r < m.h; r++) {
        const row = (gy + r) * GW;
        for (let s = m.start[r]; s < m.start[r + 1]; s++) {
          const p = prev[row + x + m.b[s]];
          if (p >= x + m.a[s]) { x = p - m.a[s] + 1; continue scan; }
        }
      }
      return x;
    }
    return -1;
  };

  const turns = opts.turns ? [0, 1, 2, 3] : [0];
  const masks = items.map((it) => turns.map((q) => ({ q, ...maskOf(it, q, f) })));
  // biggest first: small pieces then fill the gaps they leave
  const order = items.map((_, k) => k).sort((a, b) => masks[b][0].mask.cells - masks[a][0].mask.cells || a - b);
  const moves: NestMove[] = new Array(items.length);
  let left = 0;
  for (const k of order) {
    let best: { q: number; gx: number; gy: number; u0: number; v0: number; m: Mask } | null = null;
    let bestKey = Infinity;
    for (const t of masks[k]) {
      const m = t.mask;
      if (m.w > GW || m.h > GH) continue;
      for (let gy = 0; gy <= GH - m.h; gy++) {
        // rows fill from the corner: the far edge decides, then how far along the row
        if ((gy + m.h) * (GW + 1) >= bestKey) break;
        const gx = fitX(m, gy);
        if (gx < 0) continue;
        const key = (gy + m.h) * (GW + 1) + gx + m.w;
        if (key < bestKey) { bestKey = key; best = { q: t.q, gx, gy, u0: t.u0, v0: t.v0, m }; }
        break;
      }
    }
    if (!best) { left++; continue; }
    stamp(best.m, best.gx, best.gy, grow);
    settle();
    // back from the grid to the bed: the turned box's near corner goes to the chosen cell
    const du = best.gx * c - best.u0;
    const dv = best.gy * c - best.v0;
    moves[k] = { turns: best.q, dx: opts.fromRight ? -du : du, dy: opts.fromBottom ? -dv : dv };
  }
  return left ? { ok: false, left } : { ok: true, moves };
}
