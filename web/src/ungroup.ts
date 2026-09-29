// Ungroup: split one file part into pieces, using the lines the server already made for it (bed mm).
// Every shape is its own piece, holes too (Dalton, 2026-09-29). The one exception is an
// engraved shape's holes: alone, the middle of an engraved "O" would fill solid. Loose lines that meet
// end to end (AutoCAD LINEs) are joined first, so a box drawn as four lines is one box. Each piece becomes a small SVG in the same black/red/blue as Box and Circle.
// No DOM, so Node tests can load it.
import type { OpKind } from '../../shared/contracts';

type Pt = [number, number];
export interface Line { kind: OpKind; pts: Pt[] }
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
  return [...groups.values()].map((ids) => {
    const lines = ids.map((i) => open[i]);
    return { lines, box: boxOf(lines.flatMap((l) => l.pts)), poly: loopOf(lines), area: 0 };
  });
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

/** The pieces of one part, largest first. */
export function splitPieces(lines: Line[]): Piece[] {
  const shapes: Shape[] = [];
  const open: Line[] = [];
  for (const l of lines) {
    if (l.pts.length < 2) continue;
    if (isClosed(l.pts)) shapes.push({ lines: [l], box: boxOf(l.pts), poly: l.pts, area: 0 });
    else open.push(l);
  }
  shapes.push(...joinOpen(open));
  for (const s of shapes) s.area = (s.box[2] - s.box[0]) * (s.box[3] - s.box[1]);
  shapes.sort((a, b) => b.area - a.area);

  // an engraved shape goes with the smallest engraved outline around it; everything else is its own piece
  const engraved = (s: Shape) => s.lines.every((l) => l.kind === 'engrave');
  const owner = new Map<Shape, Shape>();
  shapes.forEach((s, i) => {
    if (!engraved(s)) return;
    for (let j = i - 1; j >= 0; j--) { // bigger ones come first, so the first hit going back is the smallest
      const t = shapes[j];
      if (!t.poly || t === s || !engraved(t)) continue;
      const [a0, b0, a1, b1] = s.box;
      const [c0, d0, c1, d1] = t.box;
      if (a0 < c0 || b0 < d0 || a1 > c1 || b1 > d1) continue;
      if (inside(s.lines[0].pts[0], t.poly) || inside(s.lines[0].pts[Math.floor(s.lines[0].pts.length / 2)], t.poly)) {
        owner.set(s, t);
        break;
      }
    }
  });
  const top = (s: Shape): Shape => { let t = s; while (owner.has(t)) t = owner.get(t)!; return t; };
  const pieces = new Map<Shape, Line[]>();
  for (const s of shapes) { const t = top(s); pieces.set(t, [...(pieces.get(t) ?? []), ...s.lines]); }
  return [...pieces.values()].map((ls) => ({ lines: ls, box: boxOf(ls.flatMap((l) => l.pts)) }));
}

const PAINT: Record<OpKind, string> = {
  cut: 'fill="none" stroke="#000000" stroke-width="0.1"',
  score: 'fill="none" stroke="#ff0000" stroke-width="0.1"',
  engrave: 'fill="#0000ff" fill-rule="evenodd" stroke="none"',
};

const r = (v: number) => Math.round(v * 100) / 100;

/** A piece as an SVG in mm, drawn from its own top-left corner. One path per colour, so engraved holes stay empty. */
export function pieceSvg(piece: Piece): string {
  const [x0, y0, x1, y1] = piece.box;
  const w = Math.max(r(x1 - x0), 0.01);
  const h = Math.max(r(y1 - y0), 0.01);
  const body = (['engrave', 'score', 'cut'] as OpKind[]).map((kind) => {
    const d = piece.lines.filter((l) => l.kind === kind).map((l) => {
      const pts = l.pts.map(([x, y]) => `${r(x - x0)} ${r(y - y0)}`);
      return `M${pts[0]}L${pts.slice(1).join(' ')}${isClosed(l.pts) ? 'Z' : ''}`;
    }).join('');
    return d ? `<path d="${d}" ${PAINT[kind]}/>` : '';
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">${body}</svg>`;
}
