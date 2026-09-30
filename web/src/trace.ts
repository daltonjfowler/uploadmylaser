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
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? ink[y * w + x] : 0);
  const W = w + 1;
  const out = new Map<number, number[]>(); // corner → corners its edges go to
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = y0 * W + x0;
    const list = out.get(k);
    const to = y1 * W + x1;
    if (list) list.push(to);
    else out.set(k, [to]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!ink[y * w + x]) continue;
      if (!at(x, y - 1)) add(x, y, x + 1, y); // top, going right
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1); // right, going down
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1); // bottom, going left
      if (!at(x - 1, y)) add(x, y + 1, x, y); // left, going up
    }
  }
  const loops: Pt[][] = [];
  for (const [start, list] of out) {
    while (list.length) {
      const loop: Pt[] = [];
      let prev = start;
      let cur = list.pop()!;
      loop.push([start % W, Math.floor(start / W)]);
      while (cur !== start) {
        loop.push([cur % W, Math.floor(cur / W)]);
        const next = out.get(cur)!;
        // where two blobs touch at a corner, turn right: that keeps them apart
        let pick = 0;
        if (next.length > 1) {
          const [px, py] = [cur % W - prev % W, Math.floor(cur / W) - Math.floor(prev / W)];
          pick = next.findIndex((n) => {
            const [nx, ny] = [n % W - cur % W, Math.floor(n / W) - Math.floor(cur / W)];
            return px * ny - py * nx > 0; // right turn on screen (y down)
          });
          if (pick < 0) pick = 0;
        }
        prev = cur;
        cur = next.splice(pick, 1)[0];
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

function dp(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  let worst = 0;
  let at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > worst) { worst = d; at = i; }
  }
  if (worst <= tol) return [pts[0], pts[pts.length - 1]];
  return [...dp(pts.slice(0, at + 1), tol).slice(0, -1), ...dp(pts.slice(at), tol)];
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

/** An R12 DXF (millimetres) with one closed POLYLINE per loop, y up like CAD. Opens in AutoCAD. */
export function toDxf(loops: Pt[][], layer = 'TRACE'): string {
  const maxY = Math.max(0, ...loops.flatMap((l) => l.map((p) => p[1])));
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
