// Ungroup: split one file part into pieces, using the lines the server already made for it (bed mm).
// Every shape is its own piece, holes too (Dalton, 2026-09-29). The one exception is an
// engraved shape's holes: alone, the middle of an engraved "O" would fill solid. Loose lines that meet
// end to end (AutoCAD LINEs) are joined first, so a box drawn as four lines is one box. Each piece becomes a small SVG in the same black/red/blue as Box and Circle.
// No DOM, so Node tests can load it.
import type { OpKind } from '../../shared/contracts';

type Pt = [number, number];
/** `group`: the engrave fill group the server sent (PreviewLayer.groups). Only a shape in the SAME group is a
 *  hole; separate SVG shapes on top of each other are both filled. Missing (older server) = one group. */
export interface Line { kind: OpKind; pts: Pt[]; group?: number }
export interface Piece { lines: Line[]; box: [number, number, number, number] }

const NEAR = 0.02; // mm: ends this close meet (the server rounds to 0.01)

const key = (p: Pt) => `${Math.round(p[0] / NEAR)},${Math.round(p[1] / NEAR)}`;
const isClosed = (pts: Pt[]) => pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) <= NEAR;

function boxOf(pts: Pt[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}

function inside(p: Pt, poly: Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

interface Shape { lines: Line[]; box: [number, number, number, number]; poly: Pt[] | null; area: number }

/** Open lines that share ends, as groups; a group whose ends all pair up is a loop and gets its outline. */
function joinOpen(open: Line[]): Shape[] {
  const parent = open.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const at = new Map<string, number[]>();
  open.forEach((l, i) => {
    for (const k of [key(l.pts[0]), key(l.pts[l.pts.length - 1])]) {
      const list = at.get(k) ?? [];
      for (const j of list) parent[find(j)] = find(i);
      list.push(i);
      at.set(k, list);
    }
  });
  const groups = new Map<number, number[]>();
  open.forEach((_, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]); });
  const out: Shape[] = [];
  for (const ids of groups.values()) {
    const lines = ids.map((i) => open[i]);
    const loop = loopOf(lines);
    // One outline (a box drawn as four lines) stays one piece. A web of touching lines, like a floor plan's
    // walls, is split where three or more lines meet, or it would all be "one piece" (Dalton 2026-10-05).
    for (const run of loop ? [lines] : runs(lines)) {
      out.push({ lines: run, box: boxOf(run.flatMap((l) => l.pts)), poly: loop ?? loopOf(run), area: 0 });
    }
  }
  return out;
}

/** Touching lines as runs between junctions (where 1 or 3+ line ends meet); closed loops stay whole. */
function runs(lines: Line[]): Line[][] {
  const at = new Map<string, Line[]>();
  for (const l of lines) for (const k of [key(l.pts[0]), key(l.pts[l.pts.length - 1])]) at.set(k, [...(at.get(k) ?? []), l]);
  const used = new Set<Line>();
  const out: Line[][] = [];
  const walk = (first: Line, from: string) => {
    const run: Line[] = [];
    let l: Line | undefined = first;
    let node = from;
    while (l && !used.has(l)) {
      used.add(l);
      run.push(l);
      const [a, b] = [key(l.pts[0]), key(l.pts[l.pts.length - 1])];
      node = a === node ? b : a;
      const next: Line[] = at.get(node) ?? [];
      l = next.length === 2 ? next.find((x) => !used.has(x)) : undefined; // carry on only through a plain corner
    }
    out.push(run);
  };
  for (const [node, ls] of at) if (ls.length !== 2) for (const l of ls) if (!used.has(l)) walk(l, node);
  for (const l of lines) if (!used.has(l)) walk(l, key(l.pts[0])); // what is left are closed rings
  return out;
}

/** Walk a group of open lines end to end. Null unless every end meets exactly one other end. */
function loopOf(lines: Line[]): Pt[] | null {
  const ends = new Map<string, Line[]>();
  for (const l of lines) for (const k of [key(l.pts[0]), key(l.pts[l.pts.length - 1])]) ends.set(k, [...(ends.get(k) ?? []), l]);
  if ([...ends.values()].some((ls) => ls.length !== 2)) return null;
  const used = new Set<Line>();
  let pts: Pt[] = [...lines[0].pts];
  used.add(lines[0]);
  while (used.size < lines.length) {
    const next = ends.get(key(pts[pts.length - 1]))?.find((l) => !used.has(l));
    if (!next) return null;
    used.add(next);
    const fwd = key(next.pts[0]) === key(pts[pts.length - 1]);
    pts = pts.concat((fwd ? next.pts : [...next.pts].reverse()).slice(1));
  }
  return pts;
}

/** How far Ungroup goes. 'level' (the Ungroup button, Dalton 2026-11-12): peel one layer, like opening a box.
 *  Things side by side each become a piece with everything inside them; one outline around everything
 *  (a board game's frame) splits into the frame and each thing inside it, again with what is inside those.
 *  Press Ungroup again on a piece to go one layer deeper. 'all': every shape on its own at once. */
export type UngroupDepth = 'level' | 'all';

/** The pieces of one part, largest first. */
export function splitPieces(lines: Line[], depth: UngroupDepth = 'all'): Piece[] {
  const shapes: Shape[] = [];
  const open: Line[] = [];
  for (const l of lines) {
    if (l.pts.length < 2) continue;
    if (isClosed(l.pts)) shapes.push({ lines: [l], box: boxOf(l.pts), poly: l.pts, area: 0 });
    else open.push(l);
  }
  for (const s of joinOpen(open)) shapes.push(s); // not push(...): a floor plan has too many to spread
  for (const s of shapes) s.area = (s.box[2] - s.box[0]) * (s.box[3] - s.box[1]);
  shapes.sort((a, b) => b.area - a.area);

  // an engraved shape goes with the smallest engraved outline around it in its own fill group (the server
  // fills separate groups on top of each other, so there it is no hole); everything else is its own piece
  const engraved = (s: Shape) => s.lines.every((l) => l.kind === 'engrave');
  const groupOf = (s: Shape) => s.lines[0].group ?? -1;
  const owner = new Map<Shape, Shape>();
  shapes.forEach((s, i) => {
    if (!engraved(s)) return;
    for (let j = i - 1; j >= 0; j--) { // bigger ones come first, so the first hit going back is the smallest
      const t = shapes[j];
      if (!t.poly || t === s || !engraved(t) || groupOf(t) !== groupOf(s)) continue;
      const [a0, b0, a1, b1] = s.box;
      const [c0, d0, c1, d1] = t.box;
      if (a0 < c0 || b0 < d0 || a1 > c1 || b1 > d1) continue;
      if (inside(s.lines[0].pts[0], t.poly) || inside(s.lines[0].pts[Math.floor(s.lines[0].pts.length / 2)], t.poly)) {
        owner.set(s, t);
        break;
      }
    }
  });
  // Even-odd fill: an engraved shape inside another is a hole in it, and one inside that hole is filled again
  // (an island). A filled shape keeps only its own holes; an island is a shape of its own and can come apart.
  const nest = new Map<Shape, number>();
  const depthOf = (s: Shape): number => {
    let d = nest.get(s);
    if (d === undefined) { const o = owner.get(s); d = o ? depthOf(o) + 1 : 0; nest.set(s, d); }
    return d;
  };
  const top = (s: Shape): Shape => (depthOf(s) % 2 ? owner.get(s)! : s);
  const units = new Map<Shape, Line[]>(); // a shape and the engraved holes that must stay with it
  for (const s of shapes) {
    const t = top(s);
    let ls = units.get(t);
    if (!ls) units.set(t, ls = []);
    for (const l of s.lines) ls.push(l);
  }
  if (depth === 'all') {
    // One engraved shape with holes and nothing else: "all the way" breaks it apart, like LightBurn's Break Apart
    // (Dalton 2026-11-14: Ungroup kept saying "one piece"). The holes then engrave solid; main.ts says so.
    const each = units.size === 1 && shapes.length > 1 ? shapes.map((s) => s.lines) : [...units.values()];
    return each.map((ls) => ({ lines: ls, box: boxOf(ls.flatMap((l) => l.pts)) }));
  }
  return peel([...units.entries()].map(([t, ls]) => ({ shape: t, lines: ls })));
}

/** One layer of Ungroup (see UngroupDepth). Each unit's parent is the smallest closed outline around it. */
function peel(units: { shape: Shape; lines: Line[] }[]): Piece[] {
  // units come largest first (shapes were sorted by box area), so the first container found going back is the smallest
  const parent = new Array<number>(units.length).fill(-1);
  units.forEach((u, i) => {
    const [a0, b0, a1, b1] = u.shape.box;
    const first = u.shape.lines[0].pts;
    const probes = [first[0], first[Math.floor(first.length / 2)]]; // two, in case one sits on a shared edge
    for (let j = i - 1; j >= 0; j--) {
      const t = units[j].shape;
      if (!t.poly || t.area <= u.shape.area) continue;
      const [c0, d0, c1, d1] = t.box;
      if (a0 < c0 || b0 < d0 || a1 > c1 || b1 > d1) continue;
      if (probes.some((p) => inside(p, t.poly!))) { parent[i] = j; break; }
    }
  });
  const kids: number[][] = units.map(() => []);
  const roots: number[] = [];
  parent.forEach((p, i) => (p < 0 ? roots : kids[p]).push(i));
  const subtree = (i: number): Line[] => {
    const out: Line[] = [];
    const stack = [i];
    while (stack.length) {
      const k = stack.pop()!;
      for (const l of units[k].lines) out.push(l);
      for (const c of kids[k]) stack.push(c);
    }
    return out;
  };
  let groups: Line[][];
  if (roots.length > 1) groups = roots.map(subtree); // side by side: each with what is inside it
  else if (kids[roots[0]].length) groups = [units[roots[0]].lines, ...kids[roots[0]].map(subtree)]; // open the outer box
  else groups = [units[roots[0]].lines]; // one shape (with its engraved holes): nothing to peel
  return groups.map((ls) => ({ lines: ls, box: boxOf(ls.flatMap((l) => l.pts)) }));
}

const PAINT: Record<OpKind, string> = {
  cut: 'fill="none" stroke="#000000" stroke-width="0.1"',
  score: 'fill="none" stroke="#ff0000" stroke-width="0.1"',
  engrave: 'fill="#0000ff" fill-rule="evenodd" stroke="none"',
};

const r = (v: number) => Math.round(v * 100) / 100;

/** A piece as an SVG in mm, drawn from its own top-left corner. One path per colour, so engraved holes stay
 *  empty, and one engrave path per fill group, so shapes drawn on top of each other stay filled. */
export function pieceSvg(piece: Piece): string {
  const [x0, y0, x1, y1] = piece.box;
  const w = Math.max(r(x1 - x0), 0.01);
  const h = Math.max(r(y1 - y0), 0.01);
  const pathOf = (ls: Line[], kind: OpKind) => {
    const d = ls.map((l) => {
      const pts = l.pts.map(([x, y]) => `${r(x - x0)} ${r(y - y0)}`);
      return `M${pts[0]}L${pts.slice(1).join(' ')}${isClosed(l.pts) ? 'Z' : ''}`;
    }).join('');
    return d ? `<path d="${d}" ${PAINT[kind]}/>` : '';
  };
  const body = (['engrave', 'score', 'cut'] as OpKind[]).map((kind) => {
    const mine = piece.lines.filter((l) => l.kind === kind);
    if (kind !== 'engrave') return pathOf(mine, kind);
    const byGroup = new Map<number, Line[]>();
    for (const l of mine) { const g = l.group ?? -1; let a = byGroup.get(g); if (!a) byGroup.set(g, a = []); a.push(l); }
    return [...byGroup.values()].map((ls) => pathOf(ls, kind)).join('');
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">${body}</svg>`;
}
