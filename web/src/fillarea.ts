/**
 * Fill area (Dalton 2026-11-17): a paint bucket for the bed. Board game drawings make shapes out of lines that
 * only touch (a ship whose top edge is a jail bar, a planet split by a ring), so nothing is a closed shape and
 * Engrave has nothing to fill. Here the lines on the bed are drawn onto a grid, the space around the click is
 * flooded, and its edge is traced back into closed outlines (holes and islands included) for a new Engrave
 * part. A gap smaller than about two grid cells is sealed; a bigger one lets the flood out of the drawing,
 * which is the "not closed in" answer.
 */
import { area, simplify, traceLoops, type Pt } from './trace';

export const FILL_GRID_PX = 2000; // the grid's long side, in cells
export const FILL_MIN_MM = 0.02; // finest cell
/** Lines are drawn at least this wide on the grid, whatever its cell size, so a gap this small between two
 *  pieces is sealed on the fine grid too (Dalton 2026-11-17: a board's pieces missed each other by 0.04-0.09 mm,
 *  the fine grid leaked through, and the blocky coarse fill was used instead). */
export const FILL_SEAL_MM = 0.3;
const PAD = 3; // empty cells round the window, so a flood that leaks out always reaches the edge

export type FillResult =
  | { loops: Pt[][]; areaMm2: number }
  | { error: 'nothing' | 'line' | 'open' };

type Box = [number, number, number, number];

function boundsOf(paths: Pt[][]): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of paths) for (const [x, y] of p) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return x0 <= x1 && y0 <= y1 ? [x0, y0, x1, y1] : null;
}

interface Flood { loops: Pt[][]; areaMm2: number; box: Box; cell: number }

/** One flood on a grid over `win` (bed mm) with cells of `cell` mm. Exported for tests. */
export function flood(paths: Pt[][], at: Pt, win: Box, cell: number): Flood | 'line' | 'open' {
  const w = Math.ceil((win[2] - win[0]) / cell) + 1 + 2 * PAD;
  const h = Math.ceil((win[3] - win[1]) / cell) + 1 + 2 * PAD;
  const grid = new Uint8Array(w * h); // 0 empty, 1 line, 2 flooded
  const cx = (x: number) => Math.floor((x - win[0]) / cell) + PAD;
  const cy = (y: number) => Math.floor((y - win[1]) / cell) + PAD;
  // a line at least three cells and FILL_SEAL_MM wide seals hairline gaps
  const r = Math.max(1, Math.ceil(FILL_SEAL_MM / 2 / cell));
  const disc: number[][] = [];
  for (let b = -r; b <= r; b++) for (let a = -r; a <= r; a++) if (a * a + b * b <= r * r + r) disc.push([a, b]);
  const stamp = (i: number, j: number) => {
    for (const [a, b] of disc) {
      const x = i + a, y = j + b;
      if (x >= 0 && x < w && y >= 0 && y < h) grid[y * w + x] = 1;
    }
  };
  const [wx0, wy0, wx1, wy1] = [win[0] - PAD * cell, win[1] - PAD * cell, win[2] + PAD * cell, win[3] + PAD * cell];
  for (const p of paths) {
    for (let k = 0; k + 1 < p.length; k++) {
      const [ax, ay] = p[k];
      const [bx, by] = p[k + 1];
      if (Math.max(ax, bx) < wx0 || Math.min(ax, bx) > wx1 || Math.max(ay, by) < wy0 || Math.min(ay, by) > wy1) continue;
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (cell * Math.max(0.5, r * 0.7))));
      for (let t = 0; t <= n; t++) stamp(cx(ax + ((bx - ax) * t) / n), cy(ay + ((by - ay) * t) / n));
    }
    if (p.length === 1) stamp(cx(p[0][0]), cy(p[0][1]));
  }
  const si = cx(at[0]), sj = cy(at[1]);
  if (si < 0 || sj < 0 || si >= w || sj >= h) return 'open';
  if (grid[sj * w + si] === 1) return 'line';
  // scanline flood: fill a whole run of a row, then queue the start of each empty run above and below it
  const stack = [sj * w + si];
  let minI = si, maxI = si, minJ = sj, maxJ = sj, count = 0;
  while (stack.length) {
    const idx = stack.pop()!;
    if (grid[idx] !== 0) continue;
    const j = Math.floor(idx / w);
    let l = idx - j * w, r = l;
    while (l > 0 && grid[j * w + l - 1] === 0) l--;
    while (r < w - 1 && grid[j * w + r + 1] === 0) r++;
    if (l === 0 || r === w - 1 || j === 0 || j === h - 1) return 'open'; // out past the drawing
    grid.fill(2, j * w + l, j * w + r + 1);
    count += r - l + 1;
    if (l < minI) minI = l;
    if (r > maxI) maxI = r;
    if (j < minJ) minJ = j;
    if (j > maxJ) maxJ = j;
    for (const row of [j - 1, j + 1]) {
      for (let i = l; i <= r; i++) {
        const c = row * w + i;
        if (grid[c] === 0 && (i === l || grid[c - 1] !== 0)) stack.push(c);
      }
    }
  }
  // Grow the flood into the line it stopped at, so the fill reaches the middle of that line.
  const ink = new Uint8Array(w * h);
  for (let c = 0; c < ink.length; c++) ink[c] = grid[c] === 2 ? 1 : 0;
  for (let pass = 0; pass < r + 1; pass++) {
    const grow: number[] = [];
    for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
      const c = j * w + i;
      if (!ink[c] && grid[c] === 1 && (ink[c - 1] || ink[c + 1] || ink[c - w] || ink[c + w])) grow.push(c);
    }
    for (const c of grow) ink[c] = 1;
    count += grow.length;
  }
  const toMm = ([x, y]: Pt): Pt => [
    Math.round((win[0] + (x - PAD) * cell) * 1000) / 1000,
    Math.round((win[1] + (y - PAD) * cell) * 1000) / 1000,
  ];
  const loops = traceLoops(ink, w, h)
    .filter((l) => area(l) >= 2)
    .map((l) => simplify(l, 0.5).map(toMm))
    .filter((l) => l.length >= 3);
  const box: Box = [win[0] + (minI - PAD) * cell, win[1] + (minJ - PAD) * cell, win[0] + (maxI + 1 - PAD) * cell, win[1] + (maxJ + 1 - PAD) * cell];
  return { loops, areaMm2: count * cell * cell, box, cell };
}

/** The closed area around `at` (bed mm) that `paths` fence in, as outlines for an even-odd fill. */
export function fillArea(paths: Pt[][], at: Pt): FillResult {
  const all = boundsOf(paths);
  if (!all) return { error: 'nothing' };
  if (at[0] < all[0] || at[0] > all[2] || at[1] < all[1] || at[1] > all[3]) return { error: 'open' };
  const long = Math.max(all[2] - all[0], all[3] - all[1], FILL_MIN_MM);
  const first = flood(paths, at, all, Math.max(FILL_MIN_MM, long / FILL_GRID_PX));
  if (typeof first === 'string') return { error: first };
  // A second, finer look at just that area (a small space on a big board would otherwise come out blocky). The
  // coarse grid's thick lines can close a narrow neck (Dalton 2026-11-17: Saturn's ring, where its two lines come
  // within a millimetre), so the space may be bigger than it looked: when the fine flood reaches the edge of its
  // window, the window grows (and its cells with it) until the space fits or the window is the whole drawing.
  const m = 3 * first.cell;
  let win: Box = [first.box[0] - m, first.box[1] - m, first.box[2] + m, first.box[3] + m];
  for (;;) {
    const fine = Math.max(FILL_MIN_MM, Math.max(win[2] - win[0], win[3] - win[1]) / FILL_GRID_PX);
    if (fine >= first.cell * 0.8) break;
    const second = flood(paths, at, win, fine);
    if (typeof second !== 'string') {
      if (second.loops.length) return { loops: second.loops, areaMm2: second.areaMm2 };
      break;
    }
    if (second === 'line') break;
    if (win[0] <= all[0] && win[1] <= all[1] && win[2] >= all[2] && win[3] >= all[3]) break; // it really leaks
    const gx = (win[2] - win[0]) / 2, gy = (win[3] - win[1]) / 2;
    win = [Math.max(all[0], win[0] - gx), Math.max(all[1], win[1] - gy), Math.min(all[2], win[2] + gx), Math.min(all[3], win[3] + gy)];
  }
  return first.loops.length ? { loops: first.loops, areaMm2: first.areaMm2 } : { error: 'line' };
}

/** SVG path data for the outlines (bed mm), for a closed Engrave path part. */
export function loopsD(loops: Pt[][]): string {
  const r = (v: number) => String(Math.round(v * 1000) / 1000);
  return loops.map((l) => `M${l.map(([x, y]) => `${r(x)} ${r(y)}`).join(' L')} Z`).join(' ');
}
