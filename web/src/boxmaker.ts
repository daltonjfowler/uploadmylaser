// Box maker: a finger-joint box as flat panels to cut out. No DOM, so Node tests can load it.
//
// Every panel is its outside rectangle with fingers along its edges. An edge is one of:
//   tab   fingers stick out at both ends (odd count, so the corners are solid)
//   slot  the opposite: it takes a tab edge's fingers
//   flat  a straight edge (the open top of a box with no lid)
// Front/back: all four edges tab (top flat when there is no lid). Left/right: top and bottom tab, the
// two upright edges slot (they take front/back). Bottom and lid: all slot. Matching edges always
// have the same length, so they get the same finger count and line up.
// `kerf` widens every finger by half the laser's cut width on each side, so joints press together.

export type EdgeKind = 'tab' | 'slot' | 'flat';

export interface BoxSpec {
  /** outside sizes, mm (x across, y deep, z tall) */
  w: number;
  d: number;
  h: number;
  /** material thickness, mm */
  t: number;
  lid: boolean;
  /** laser cut width, mm (0 = loose) */
  kerf: number;
  /** wanted finger width, mm */
  finger: number;
}

export interface Panel { name: string; w: number; h: number; d: string }

type Pt = [number, number];

/** Odd, at least 3, and close to the wanted finger width. */
export function fingerCount(len: number, finger: number): number {
  let n = Math.floor(len / Math.max(finger, 1));
  if (n % 2 === 0) n -= 1;
  return Math.max(3, n);
}

/** Depth (0 = on the outside line, t = pushed in) of each finger along an edge. */
function depths(kind: EdgeKind, n: number, t: number): number[] {
  if (kind === 'flat') return [0];
  return Array.from({ length: n }, (_, i) => ((i % 2 === 0) === (kind === 'tab') ? 0 : t));
}

/** Where the fingers change, with each finger (depth 0) widened by kerf/2 on both sides. */
function boundaries(len: number, deps: number[], kerf: number): number[] {
  const n = deps.length;
  const b = Array.from({ length: n + 1 }, (_, i) => (len * i) / n);
  for (let i = 1; i < n; i++) b[i] += deps[i - 1] === 0 ? kerf / 2 : -kerf / 2;
  return b;
}

/** One panel's outline, clockwise from the top-left, as an SVG path in mm (y down). */
export function panelPath(w: number, h: number, edges: [EdgeKind, EdgeKind, EdgeKind, EdgeKind], spec: Pick<BoxSpec, 't' | 'kerf' | 'finger'>): string {
  const { t, kerf, finger } = spec;
  // top, right, bottom, left: start corner, direction along the edge, inward normal, length
  const sides: { p: Pt; dir: Pt; n: Pt; len: number }[] = [
    { p: [0, 0], dir: [1, 0], n: [0, 1], len: w },
    { p: [w, 0], dir: [0, 1], n: [-1, 0], len: h },
    { p: [w, h], dir: [-1, 0], n: [0, -1], len: w },
    { p: [0, h], dir: [0, -1], n: [1, 0], len: h },
  ];
  const deps = sides.map((s, i) => depths(edges[i], fingerCount(s.len, finger), t));
  const pts: Pt[] = [];
  sides.forEach((s, i) => {
    const d = deps[i];
    const b = boundaries(s.len, d, kerf);
    const prevLast = deps[(i + 3) % 4].at(-1)!;
    const nextFirst = deps[(i + 1) % 4][0];
    const at = (along: number, depth: number): Pt => [s.p[0] + s.dir[0] * along + s.n[0] * depth, s.p[1] + s.dir[1] * along + s.n[1] * depth];
    d.forEach((depth, k) => {
      const a0 = k === 0 ? prevLast : b[k];
      const a1 = k === d.length - 1 ? s.len - nextFirst : b[k + 1];
      pts.push(at(a0, depth), at(a1, depth));
    });
  });
  // drop repeats (a step of zero where two neighbours share a depth)
  const clean = pts.filter((q, i) => i === 0 || Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) > 1e-6);
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return 'M' + clean.map(([x, y]) => `${r(x)} ${r(y)}`).join(' L') + ' Z';
}

export function boxPanels(spec: BoxSpec): Panel[] {
  const { w, d, h, lid } = spec;
  const top: EdgeKind = lid ? 'tab' : 'flat';
  const make = (name: string, pw: number, ph: number, e: [EdgeKind, EdgeKind, EdgeKind, EdgeKind]): Panel =>
    ({ name, w: pw, h: ph, d: panelPath(pw, ph, e, spec) });
  const panels = [
    make('Front', w, h, [top, 'tab', 'tab', 'tab']),
    make('Back', w, h, [top, 'tab', 'tab', 'tab']),
    make('Left side', d, h, [top, 'slot', 'tab', 'slot']),
    make('Right side', d, h, [top, 'slot', 'tab', 'slot']),
    make('Bottom', w, d, ['slot', 'slot', 'slot', 'slot']),
  ];
  if (lid) panels.push(make('Lid', w, d, ['slot', 'slot', 'slot', 'slot']));
  return panels;
}

/** Outside sizes from what was typed: inside sizes add the walls (no lid: no top wall). */
export function outsideSize(w: number, d: number, h: number, t: number, inside: boolean, lid: boolean): { w: number; d: number; h: number } {
  return inside ? { w: w + 2 * t, d: d + 2 * t, h: h + (lid ? 2 : 1) * t } : { w, d, h };
}
