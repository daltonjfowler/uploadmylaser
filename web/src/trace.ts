// Image trace: black and white pixels → closed outlines (like Illustrator's Image Trace, black and white).
// Written for this project (MIT); no tracing library. No DOM, so Node tests can load it.
//
// 1. Edges: every border between an ink pixel and a blank one becomes a unit edge, oriented so the
//    ink is on its right (clockwise round each blob, on screen). Edges chain into closed loops; outer
//    shapes and holes come out turning opposite ways, so even-odd fill keeps holes as holes.
// 2. Clean up: loops smaller than `minAreaPx` go (specks, and pin holes inside ink).
// 3. Straighten: Douglas-Peucker removes the pixel staircase (`tolerancePx`).
// 4. Smooth: corner-keeping Chaikin rounds curves `smooth` times, but leaves sharp corners alone.

export type Pt = [number, number];

export interface TraceOptions {
  minAreaPx: number;
  tolerancePx: number;
  /** 0..3 */
  smooth: number;
}

/** Closed loops (first point not repeated), in pixel units. */
export function traceLoops(ink: Uint8Array, w: number, h: number): Pt[][] {
  const W = w + 1;
  // Each pixel corner has at most two edges leaving it (two, only where blobs touch at a corner).
  // Typed arrays, not a Map of lists: a busy 900 px photo has over a million edges.
  const n0 = new Int32Array(W * (h + 1)).fill(-1);
  const n1 = new Int32Array(W * (h + 1)).fill(-1);
  const add = (from: number, to: number) => { if (n0[from] < 0) n0[from] = to; else n1[from] = to; };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!ink[row + x]) continue;
      const c = y * W + x; // this pixel's top-left corner
      if (y === 0 || !ink[row - w + x]) add(c, c + 1); // top, going right
      if (x === w - 1 || !ink[row + x + 1]) add(c + 1, c + 1 + W); // right, going down
      if (y === h - 1 || !ink[row + w + x]) add(c + 1 + W, c + W); // bottom, going left
      if (x === 0 || !ink[row + x - 1]) add(c + W, c); // left, going up
    }
  }
  /** Take one edge leaving `k`: the only one, or (where blobs touch) the right turn coming from `prev`. */
  const take = (k: number, prev: number): number => {
    let useSecond = n1[k] >= 0;
    if (useSecond && prev >= 0) {
      const px = (k % W) - (prev % W);
      const py = Math.floor(k / W) - Math.floor(prev / W);
      const nx = (n0[k] % W) - (k % W);
      const ny = Math.floor(n0[k] / W) - Math.floor(k / W);
      useSecond = !(px * ny - py * nx > 0); // right turn on screen (y down) keeps touching blobs apart
    }
    if (useSecond) { const t = n1[k]; n1[k] = -1; return t; }
    const t = n0[k];
    n0[k] = n1[k];
    n1[k] = -1;
    return t;
  };
  const loops: Pt[][] = [];
  for (let start = 0; start < n0.length; start++) {
    while (n0[start] >= 0) {
      const loop: Pt[] = [[start % W, Math.floor(start / W)]];
      let prev = start;
      let cur = take(start, -1);
      while (cur !== start) {
        loop.push([cur % W, Math.floor(cur / W)]);
        const next = take(cur, prev);
        prev = cur;
        cur = next;
      }
      loops.push(dropStraight(loop));
    }
  }
  return loops;
}

/** Points in the middle of a straight run go. */
function dropStraight(loop: Pt[]): Pt[] {
  const n = loop.length;
  return loop.filter((p, i) => {
    const a = loop[(i + n - 1) % n];
    const b = loop[(i + 1) % n];
    return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
  });
}

export function area(loop: Pt[]): number {
  let s = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) s += (loop[j][0] + loop[i][0]) * (loop[j][1] - loop[i][1]);
  return Math.abs(s) / 2;
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Douglas-Peucker without recursion, so a long outline can't run out of stack. */
function dp(pts: Pt[], tol: number): Pt[] {
  const n = pts.length;
  if (n < 3) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [0, n - 1];
  while (stack.length) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    let worst = 0;
    let at = 0;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i], pts[a], pts[b]);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol) { keep[at] = 1; stack.push(a, at, at, b); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Douglas-Peucker on a closed loop: split at the point farthest from the first. */
export function simplify(loop: Pt[], tol: number): Pt[] {
  if (loop.length < 4 || tol <= 0) return loop;
  let far = 0;
  let best = -1;
  loop.forEach((p, i) => { const d = Math.hypot(p[0] - loop[0][0], p[1] - loop[0][1]); if (d > best) { best = d; far = i; } });
  const a = dp(loop.slice(0, far + 1), tol);
  const b = dp([...loop.slice(far), loop[0]], tol);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : loop;
}

/** Chaikin corner cutting that keeps sharp corners (turns over 60°) exactly where they are. */
export function smoothLoop(loop: Pt[], times: number): Pt[] {
  let pts = loop;
  for (let k = 0; k < times; k++) {
    const n = pts.length;
    if (n < 3) return pts;
    const sharp = pts.map((p, i) => {
      const a = pts[(i + n - 1) % n];
      const b = pts[(i + 1) % n];
      const v1 = [p[0] - a[0], p[1] - a[1]];
      const v2 = [b[0] - p[0], b[1] - p[1]];
      const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]) || 1);
      return cos < 0.5;
    });
    const next: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      next.push(sharp[i] ? a : [0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      if (!sharp[(i + 1) % n]) next.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    pts = next;
  }
  return pts;
}

/** The whole trace: loops in mm, cleaned, straightened and smoothed. */
export function trace(ink: Uint8Array, w: number, h: number, mmPerPx: number, o: TraceOptions): Pt[][] {
  return traceLoops(ink, w, h)
    .filter((l) => area(l) >= o.minAreaPx)
    .map((l) => smoothLoop(simplify(l, o.tolerancePx), o.smooth))
    .filter((l) => l.length >= 3)
    .map((l) => l.map(([x, y]) => [Math.round(x * mmPerPx * 1000) / 1000, Math.round(y * mmPerPx * 1000) / 1000] as Pt));
}

export function pointCount(loops: Pt[][]): number {
  return loops.reduce((n, l) => n + l.length, 0);
}

/** [x0, y0, x1, y1] round every point. A loop, not Math.min(...all): a big trace has too many points to spread. */
export function bounds(loops: Pt[][]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of loops) for (const [x, y] of l) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}

/** An R12 DXF (millimetres) with one closed POLYLINE per loop, y up like CAD. Opens in AutoCAD. */
export function toDxf(loops: Pt[][], layer = 'TRACE'): string {
  const maxY = Math.max(0, bounds(loops)[3]);
  const r = (v: number) => (Math.round(v * 1000) / 1000).toString();
  const out: string[] = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
  for (const l of loops) {
    out.push('0', 'POLYLINE', '8', layer, '66', '1', '70', '1', '10', '0', '20', '0', '30', '0');
    for (const [x, y] of l) out.push('0', 'VERTEX', '8', layer, '10', r(x), '20', r(maxY - y), '30', '0');
    out.push('0', 'SEQEND', '8', layer);
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\r\n') + '\r\n';
}
