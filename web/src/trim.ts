// Trim, like AutoCAD's: click a line and the bit of it between the nearest lines that cross it is cut
// away. A line nothing crosses goes completely. Works on bed-mm polylines (what the server drew).
// No DOM, so Node tests can load it.
import type { OpKind } from '../../shared/contracts';

export type Pt = [number, number];
export interface TrimLine { kind: OpKind; pts: Pt[] }
/** Where a click landed: which line, which segment of it, and how far along (0..1). */
export interface TrimHit { line: number; seg: number; t: number; d: number }

const EPS = 1e-9;
const CLOSE = 0.02; // mm: ends this close make a loop (the server rounds to 0.01)

const isLoop = (pts: Pt[]) => pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) <= CLOSE;

/** The line nearest to `p`, if one is within `tol` mm. */
export function nearestLine(lines: TrimLine[], p: Pt, tol: number): TrimHit | null {
  let best: TrimHit | null = null;
  lines.forEach((l, li) => {
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const [ax, ay] = l.pts[i];
      const [bx, by] = l.pts[i + 1];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.min(1, Math.max(0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2)) : 0;
      const d = Math.hypot(ax + t * dx - p[0], ay + t * dy - p[1]);
      if (d <= tol && (!best || d < best.d)) best = { line: li, seg: i, t, d };
    }
  });
  return best;
}

type Box = [number, number, number, number];
function boxOf(pts: Pt[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}
const overlaps = (a: Box, b: Box) => a[0] <= b[2] + EPS && b[0] <= a[2] + EPS && a[1] <= b[3] + EPS && b[1] <= a[3] + EPS;

/** How far along segment a-b the segment c-d crosses it (0..1), or null. Touching counts. */
function cross(a: Pt, b: Pt, c: Pt, d: Pt): number | null {
  const rx = b[0] - a[0], ry = b[1] - a[1];
  const sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < EPS) return null; // parallel (overlapping lines don't make a cut point)
  const qx = c[0] - a[0], qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  const slack = 1e-7;
  return t >= -slack && t <= 1 + slack && u >= -slack && u <= 1 + slack ? Math.min(1, Math.max(0, t)) : null;
}

/** Where along `pts` (segment index + fraction) the cutters cross it, sorted. Also where it crosses itself. */
export function crossings(pts: Pt[], cutters: Pt[][]): number[] {
  const out: number[] = [];
  const mine = boxOf(pts);
  const loop = isLoop(pts);
  for (const c of cutters) {
    const self = c === pts;
    if (!self && !overlaps(mine, boxOf(c))) continue;
    for (let i = 0; i + 1 < pts.length; i++) {
      const sb = boxOf([pts[i], pts[i + 1]]);
      for (let j = 0; j + 1 < c.length; j++) {
        if (self) { // its own neighbours always touch it; a loop's first and last segments too
          if (Math.abs(i - j) <= 1) continue;
          if (loop && ((i === 0 && j === pts.length - 2) || (j === 0 && i === pts.length - 2))) continue;
        }
        if (!overlaps(sb, boxOf([c[j], c[j + 1]]))) continue;
        const t = cross(pts[i], pts[i + 1], c[j], c[j + 1]);
        if (t !== null) out.push(i + t);
      }
    }
  }
  out.sort((a, b) => a - b);
  return out.filter((u, k) => !k || u - out[k - 1] > 1e-6);
}

function at(pts: Pt[], u: number): Pt {
  const i = Math.min(Math.floor(u), pts.length - 2);
  const t = u - i;
  const [a, b] = [pts[i], pts[i + 1]];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** The part of `pts` from position a to b (a < b). */
function piece(pts: Pt[], a: number, b: number): Pt[] {
  const out: Pt[] = [at(pts, a)];
  for (let k = Math.floor(a) + 1; k < b; k++) if (k > a) out.push(pts[k]);
  out.push(at(pts, b));
  return out;
}

const length = (pts: Pt[]) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

/** Cut the clicked bit out of `lines[hit.line]`. `cutters` are every line that can bound the cut, this
 *  part's and other parts'. Returns the lines left over and the bit that went (for the highlight). */
export function trim(lines: TrimLine[], hit: TrimHit, cutters: Pt[][]): { keep: TrimLine[]; removed: Pt[][] } {
  const l = lines[hit.line];
  const pts = l.pts;
  const n = pts.length - 1; // positions run 0..n
  const u0 = hit.seg + hit.t;
  const others = lines.filter((_, k) => k !== hit.line);
  const xs = crossings(pts, [pts, ...cutters.filter((c) => c !== pts)]);
  const parts: Pt[][] = [];
  let removed: Pt[][];
  if (isLoop(pts)) {
    const cuts = xs.filter((u) => u < n - 1e-6); // n is the same point as 0
    if (cuts.length < 2) return { keep: others, removed: [pts] };
    const lo = [...cuts].reverse().find((u) => u < u0) ?? cuts[cuts.length - 1];
    const hi = cuts.find((u) => u > u0) ?? cuts[0];
    if (lo < hi) {
      removed = [piece(pts, lo, hi)];
      parts.push([...piece(pts, hi, n), ...piece(pts, 0, lo).slice(1)]);
    } else { // the clicked bit runs over the loop's start
      removed = [[...piece(pts, lo, n), ...piece(pts, 0, hi).slice(1)]];
      parts.push(piece(pts, hi, lo));
    }
  } else {
    const inner = xs.filter((u) => u > 1e-6 && u < n - 1e-6);
    const lo = [...inner].reverse().find((u) => u < u0) ?? 0;
    const hi = inner.find((u) => u > u0) ?? n;
    removed = [piece(pts, lo, hi)];
    if (lo > 0) parts.push(piece(pts, 0, lo));
    if (hi < n) parts.push(piece(pts, hi, n));
  }
  const keep = [...others, ...parts.filter((p) => length(p) > 0.01).map((p) => ({ kind: l.kind, pts: p }))];
  return { keep, removed };
}
