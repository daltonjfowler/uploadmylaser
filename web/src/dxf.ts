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
  const flip = num(t, 230, 1) < 0; // drawn with the UCS flipped (MIRROR does this): mirror x
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
      const vs = (e.verts ?? []).filter((v) => !(num(v, 70) & 128)) // skip mesh face records
        .map((v) => ({ x: num(v, 10), y: num(v, 20), b: num(v, 42) }));
      return [f(bulgePts(vs, (num(t, 70) & 1) === 1))];
    }
    case 'ELLIPSE': {
      const [cx, cy, mx, my, ratio] = [num(t, 10), num(t, 20), num(t, 11), num(t, 21), num(t, 40, 1)];
      let [a0, a1] = [num(t, 41), num(t, 42, Math.PI * 2)];
      while (a1 <= a0) a1 += Math.PI * 2;
      const n = 64;
      const pts = Array.from({ length: n + 1 }, (_, i) => {
        const a = a0 + ((a1 - a0) * i) / n;
        const [c, s] = [Math.cos(a), Math.sin(a) * ratio];
        return [cx + mx * c - my * s, cy + my * c + mx * s] as Pt;
      });
      return [f(pts)];
    }
    case 'SPLINE': {
      const fit: Pt[] = [];
      const ctrl: Pt[] = [];
      for (let i = 0; i + 1 < t.length; i++) {
        if (t[i][0] === 11 && t[i + 1][0] === 21) fit.push([Number(t[i][1]), Number(t[i + 1][1])]);
        if (t[i][0] === 10 && t[i + 1][0] === 20) ctrl.push([Number(t[i][1]), Number(t[i + 1][1])]);
      }
      return [f(fit.length > 1 ? fit : ctrl)];
    }
    case 'SOLID':
    case 'TRACE':
    case '3DFACE': {
      const q: Pt[] = [[num(t, 10), num(t, 20)], [num(t, 11), num(t, 21)], [num(t, 13), num(t, 23)], [num(t, 12), num(t, 22)]];
      return [f([...q, q[0]])];
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
        const inner: Xf = ([x, y]) => {
          const [u, v] = [(x - b.base[0]) * sx, (y - b.base[1]) * sy];
          return xf([mirror * (px + u * c - v * s), py + u * s + v * c]);
        };
        walk(b.ents, inner, depth + 1, layer);
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
