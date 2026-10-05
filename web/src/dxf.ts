// A quick outline of a DXF for the browser's sketch, so a DXF part shows its lines (in grey) before the
// server has checked it, instead of just its file name. The server's importer (container/app/geometry/
// dxf_import.py) is the real one: this only has to look about right. No dependencies, so Node tests can load it.

export const BINARY_DXF = 'AutoCAD Binary DXF';

/** What a file named .dxf really is, from its first bytes (or characters). */
export function dxfFlavour(head: string): 'ascii' | 'binary' | 'dwg' {
  const s = head.replace(/^﻿/, '');
  if (s.startsWith(BINARY_DXF)) return 'binary';
  if (/^AC\d{4}/.test(s)) return 'dwg'; // DWG files start with their version, e.g. AC1027
  return 'ascii';
}

/** Bytes → one char per byte, so a binary DXF survives being kept as a string (and in localStorage). */
export function bytesToBinaryString(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}

/** The $INSUNITS code an ASCII DXF claims (0: none), read straight from its header. */
export function dxfUnitsCode(text: string): number {
  const m = /\$INSUNITS\s*\r?\n\s*70\s*\r?\n\s*(\d+)/.exec(text.slice(0, 200_000));
  return m ? Number(m[1]) : 0;
}

export function binaryStringToBytes(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
}

// $INSUNITS → mm (unitless counts as mm, like the server)
export const UNIT_MM: Record<number, number> = { 0: 1, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 0.0000254, 9: 0.0254, 10: 914.4, 13: 0.001, 14: 100 };
const MAX_POINTS = 200_000; // a sketch, not the job: stop drawing well before a Chromebook struggles
const MAX_DEPTH = 8;

type Pt = [number, number];
type Tag = [number, string];
interface Ent { type: string; tags: Tag[]; verts?: Tag[][] }

export interface DxfSketch {
  /** SVG path, y down, in drawing units */
  d: string;
  vb: { x: number; y: number; w: number; h: number };
  mmPerUnit: number;
}

function num(tags: Tag[], code: number, dflt = 0): number {
  const t = tags.find((x) => x[0] === code);
  const v = t ? Number(t[1]) : NaN;
  return Number.isFinite(v) ? v : dflt;
}
function str(tags: Tag[], code: number): string {
  return tags.find((x) => x[0] === code)?.[1] ?? '';
}

function arcPts(cx: number, cy: number, r: number, a0: number, a1: number): Pt[] {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += Math.PI * 2;
  const n = Math.min(128, Math.max(4, Math.ceil(sweep / (Math.PI / 32))));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + (sweep * i) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt;
  });
}

/** A polyline with bulges (arc segments) → points. */
function bulgePts(vs: { x: number; y: number; b: number }[], closed: boolean): Pt[] {
  const out: Pt[] = [];
  const n = closed ? vs.length : vs.length - 1;
  if (vs.length) out.push([vs[0].x, vs[0].y]);
  for (let i = 0; i < n; i++) {
    const p = vs[i];
    const q = vs[(i + 1) % vs.length];
    if (Math.abs(p.b) < 1e-9) {
      out.push([q.x, q.y]);
      continue;
    }
    const theta = 4 * Math.atan(p.b); // included angle, + is counter-clockwise
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const chord = Math.hypot(dx, dy);
    if (chord < 1e-12) continue;
    const off = chord / (2 * Math.tan(theta / 2)); // centre's distance left of the chord's midpoint
    const cx = (p.x + q.x) / 2 - (dy / chord) * off;
    const cy = (p.y + q.y) / 2 + (dx / chord) * off;
    const r = Math.hypot(p.x - cx, p.y - cy);
    const a0 = Math.atan2(p.y - cy, p.x - cx);
    const steps = Math.min(64, Math.max(2, Math.ceil(Math.abs(theta) / (Math.PI / 32))));
    for (let k = 1; k <= steps; k++) {
      const a = a0 + (theta * k) / steps;
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return out;
}

/** A NURBS curve (degree, knots, control points, optional weights) sampled with de Boor's algorithm. */
function nurbsPts(deg: number, knots: number[], ctrl: Pt[], weights: number[]): Pt[] | null {
  const n = ctrl.length;
  if (deg < 1 || n <= deg || knots.length !== n + deg + 1) return null;
  const w = weights.length === n ? weights : ctrl.map(() => 1);
  const [t0, t1] = [knots[deg], knots[n]];
  if (!(t1 > t0)) return null;
  const at = (t: number): Pt => {
    let k = deg;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    const d = Array.from({ length: deg + 1 }, (_, j) => {
      const i = k - deg + j;
      return [ctrl[i][0] * w[i], ctrl[i][1] * w[i], w[i]];
    });
    for (let r = 1; r <= deg; r++) {
      for (let j = deg; j >= r; j--) {
        const i = k - deg + j;
        const den = knots[i + deg + 1 - r] - knots[i];
        const a = den ? (t - knots[i]) / den : 0;
        for (let c = 0; c < 3; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c];
      }
    }
    const [x, y, h] = d[deg];
    return h ? [x / h, y / h] : [x, y];
  };
  const steps = Math.min(2000, Math.max(16, (n - deg) * 24));
  return Array.from({ length: steps + 1 }, (_, i) => at(t0 + ((t1 - t0) * i) / steps));
}

/** A smooth curve through fit points (centripetal Catmull-Rom): close to how CAD fits them, never straight. */
function throughPts(fit: Pt[]): Pt[] {
  if (fit.length < 3) return fit;
  const out: Pt[] = [fit[0]];
  const P = [fit[0], ...fit, fit[fit.length - 1]];
  for (let i = 1; i + 2 < P.length; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    const tj = (a: Pt, b: Pt) => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])) || 1e-6;
    const t1 = tj(p0, p1), t2 = t1 + tj(p1, p2), t3 = t2 + tj(p2, p3);
    for (let k = 1; k <= 16; k++) {
      const t = t1 + ((t2 - t1) * k) / 16;
      const lerp = (a: Pt, b: Pt, ta: number, tb: number): Pt => [((tb - t) * a[0] + (t - ta) * b[0]) / (tb - ta), ((tb - t) * a[1] + (t - ta) * b[1]) / (tb - ta)];
      const a1 = lerp(p0, p1, 0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, 0, t2), b2 = lerp(a2, a3, t1, t3);
      out.push(lerp(b1, b2, t1, t2));
    }
  }
  return out;
}

/** Group codes and values. Codes are on odd lines; a file that doesn't parse gives what it had so far. */
function readTags(text: string): Tag[] {
  const lines = text.split(/\r\n|\r|\n/);
  const tags: Tag[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isInteger(code)) break;
    tags.push([code, lines[i + 1].trim()]);
  }
  return tags;
}

interface Doc { units: number; hidden: Set<string>; blocks: Map<string, { base: Pt; ents: Ent[] }>; ents: Ent[] }

function parse(text: string): Doc {
  const tags = readTags(text);
  const doc: Doc = { units: 0, hidden: new Set(), blocks: new Map(), ents: [] };
  let section = '';
  let block: { name: string; base: Pt; ents: Ent[] } | null = null;
  let cur: Ent | null = null;
  let poly: Ent | null = null; // an open POLYLINE collecting VERTEXes
  let layer: Tag[] | null = null;
  const endLayer = () => {
    if (layer) {
      const name = str(layer, 2);
      if (num(layer, 62, 7) < 0 || (num(layer, 70) & 1)) doc.hidden.add(name);
    }
    layer = null;
  };
  const push = (e: Ent) => {
    if (block) block.ents.push(e);
    else if (section === 'ENTITIES') doc.ents.push(e);
  };
  for (let i = 0; i < tags.length; i++) {
    const [code, value] = tags[i];
    if (code === 9 && value === '$INSUNITS' && tags[i + 1]?.[0] === 70) doc.units = Number(tags[i + 1][1]) || 0;
    if (code !== 0) {
      if (layer) layer.push(tags[i]);
      else if (cur) cur.tags.push(tags[i]);
      continue;
    }
    // a new object starts: finish the last one
    endLayer();
    if (cur?.type === 'BLOCK' && block) {
      block.name = str(cur.tags, 2);
      block.base = [num(cur.tags, 10), num(cur.tags, 20)];
    }
    if (cur && cur.type !== 'BLOCK') {
      if (cur.type === 'VERTEX' && poly) poly.verts!.push(cur.tags);
      else if (cur.type === 'POLYLINE') { poly = cur; poly.verts = []; push(cur); }
      else if (cur.type !== 'SEQEND') push(cur);
    }
    if (value === 'SEQEND') poly = null;
    cur = null;
    if (value === 'SECTION') {
      section = tags[i + 1]?.[0] === 2 ? tags[i + 1][1] : '';
      i++;
    } else if (value === 'ENDSEC') section = '';
    else if (value === 'BLOCK') {
      block = { name: '', base: [0, 0], ents: [] };
      cur = { type: 'BLOCK', tags: [] };
    } else if (value === 'ENDBLK') {
      if (block?.name) doc.blocks.set(block.name, { base: block.base, ents: block.ents });
      block = null;
    } else if (section === 'TABLES' && value === 'LAYER') layer = [];
    else if (section === 'ENTITIES' || block) cur = { type: value, tags: [] };
  }
  return doc;
}

type Xf = (p: Pt) => Pt;

/** One entity → polylines in its block's coordinates. */
function shapes(e: Ent): Pt[][] {
  const t = e.tags;
  // MIRROR in AutoCAD turns an object's extrusion to -Z. Objects stored in their own plane (OCS: circles,
  // arcs, 2D polylines, solids) then read mirrored in x. LINE, SPLINE, ELLIPSE, 3D polylines and 3DFACE
  // are stored in world coordinates already, so they must NOT be flipped (that moved them across the drawing).
  const flip = num(t, 230, 1) < 0;
  const f = (ps: Pt[]): Pt[] => (flip ? ps.map(([x, y]) => [-x, y]) : ps);
  switch (e.type) {
    case 'LINE':
      return [[[num(t, 10), num(t, 20)], [num(t, 11), num(t, 21)]]];
    case 'CIRCLE':
      return [f(arcPts(num(t, 10), num(t, 20), num(t, 40), 0, Math.PI * 2))];
    case 'ARC':
      return [f(arcPts(num(t, 10), num(t, 20), num(t, 40), (num(t, 50) * Math.PI) / 180, (num(t, 51) * Math.PI) / 180))];
    case 'LWPOLYLINE': {
      const vs: { x: number; y: number; b: number }[] = [];
      for (const [c, v] of t) {
        if (c === 10) vs.push({ x: Number(v), y: 0, b: 0 });
        else if (c === 20 && vs.length) vs[vs.length - 1].y = Number(v);
        else if (c === 42 && vs.length) vs[vs.length - 1].b = Number(v);
      }
      return [f(bulgePts(vs, (num(t, 70) & 1) === 1))];
    }
    case 'POLYLINE': {
      const flags = num(t, 70);
      const vs = (e.verts ?? []).filter((v) => !(num(v, 70) & 128)) // skip mesh face records
        .map((v) => ({ x: num(v, 10), y: num(v, 20), b: num(v, 42) }));
      const pts = bulgePts(vs, (flags & 1) === 1);
      return [flags & (8 | 16 | 64) ? pts : f(pts)]; // 3D polylines and meshes are in world coordinates
    }
    case 'ELLIPSE': {
      const [cx, cy, mx, my, ratio] = [num(t, 10), num(t, 20), num(t, 11), num(t, 21), num(t, 40, 1)];
      let [a0, a1] = [num(t, 41), num(t, 42, Math.PI * 2)];
      while (a1 <= a0) a1 += Math.PI * 2;
      // minor axis = extrusion x major axis: turned the other way when the extrusion is -Z
      const [nx, ny] = flip ? [my * ratio, -mx * ratio] : [-my * ratio, mx * ratio];
      const n = Math.max(16, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 96));
      return [Array.from({ length: n + 1 }, (_, i) => {
        const a = a0 + ((a1 - a0) * i) / n;
        return [cx + mx * Math.cos(a) + nx * Math.sin(a), cy + my * Math.cos(a) + ny * Math.sin(a)] as Pt;
      })];
    }
    case 'SPLINE': {
      const fit: Pt[] = [];
      const ctrl: Pt[] = [];
      const knots: number[] = [];
      const weights: number[] = [];
      for (let i = 0; i < t.length; i++) {
        const [c, v] = t[i];
        if (c === 11 && t[i + 1]?.[0] === 21) fit.push([Number(v), Number(t[i + 1][1])]);
        else if (c === 10 && t[i + 1]?.[0] === 20) ctrl.push([Number(v), Number(t[i + 1][1])]);
        else if (c === 40) knots.push(Number(v));
        else if (c === 41) weights.push(Number(v));
      }
      const curve = ctrl.length > 1 ? nurbsPts(num(t, 71, 3), knots, ctrl, weights) : null;
      return [curve ?? (fit.length > 1 ? throughPts(fit) : ctrl)];
    }
    case 'SOLID':
    case 'TRACE':
    case '3DFACE': {
      const q: Pt[] = [[num(t, 10), num(t, 20)], [num(t, 11), num(t, 21)], [num(t, 13), num(t, 23)], [num(t, 12), num(t, 22)]];
      return [e.type === '3DFACE' ? [...q, q[0]] : f([...q, q[0]])];
    }
    default:
      return [];
  }
}

/** Polylines for the whole drawing, in drawing units (y up). */
function outlines(doc: Doc, ents: Ent[]): Pt[][] {
  const out: Pt[][] = [];
  let count = 0;
  const walk = (list: Ent[], xf: Xf, depth: number, parentLayer: string) => {
    for (const e of list) {
      if (count > MAX_POINTS) return;
      let layer = str(e.tags, 8) || '0';
      if (layer === '0' && parentLayer) layer = parentLayer;
      if (doc.hidden.has(layer)) continue;
      if (e.type === 'INSERT') {
        const b = doc.blocks.get(str(e.tags, 2));
        if (!b || depth >= MAX_DEPTH) continue;
        const [px, py] = [num(e.tags, 10), num(e.tags, 20)];
        const [sx, sy] = [num(e.tags, 41, 1), num(e.tags, 42, 1)];
        const r = (num(e.tags, 50) * Math.PI) / 180;
        const mirror = num(e.tags, 230, 1) < 0 ? -1 : 1;
        const [c, s] = [Math.cos(r), Math.sin(r)];
        // MINSERT: a grid of copies, spaced in the insert's own (rotated) directions
        const [cols, rows] = [Math.max(1, Math.min(100, num(e.tags, 70, 1))), Math.max(1, Math.min(100, num(e.tags, 71, 1)))];
        const [cs, rs] = [num(e.tags, 44), num(e.tags, 45)];
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            const inner: Xf = ([x, y]) => {
              const [u, v] = [(x - b.base[0]) * sx + col * cs, (y - b.base[1]) * sy + row * rs];
              return xf([mirror * (px + u * c - v * s), py + u * s + v * c]);
            };
            walk(b.ents, inner, depth + 1, layer);
          }
        }
        continue;
      }
      for (const p of shapes(e)) {
        if (p.length < 2) continue;
        count += p.length;
        out.push(p.map(xf));
      }
    }
  };
  walk(ents, (p) => p, 0, '');
  return out;
}

/** The drawing's outline, or null if we can't find any lines (the server then explains why). */
export function sketchDxf(text: string): DxfSketch | null {
  if (dxfFlavour(text.slice(0, 32)) !== 'ascii') return null;
  const doc = parse(text);
  const model = doc.ents.filter((e) => num(e.tags, 67) !== 1);
  let paths = outlines(doc, model);
  if (!paths.length) paths = outlines(doc, doc.ents.filter((e) => e.type !== 'VIEWPORT')); // drawn on a layout tab
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of paths) {
    for (const [x, y] of p) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  if (!paths.length) return null;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const d = paths.map((p) => p.map(([x, y], i) => `${i ? 'L' : 'M'}${r(x)} ${r(-y)}`).join('')).join('');
  return { d, vb: { x: x0, y: -y1, w: x1 - x0, h: y1 - y0 }, mmPerUnit: UNIT_MM[doc.units] ?? 1 };
}
