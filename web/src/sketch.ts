// In-browser previews, so the tools work before the class phrase is entered (or while the server
// works). Boxes and circles are exact. Text and SVG files are close. DXF shows its size if the file
// records it. The server's preview replaces these as soon as it arrives.
import type { OpKind, Placement, TextSpec } from '../../shared/contracts';
import { TEXT_FONTS } from '../../shared/contracts';
import { OP_COLORS } from './ops';
import type { ShapeKind, ViewBox } from './shapes';
import type { Box, PartView } from './workspace';

export type Source =
  | { kind: 'file'; name: string; fileType: 'svg' | 'dxf'; data: string }
  | { kind: 'text'; text: TextSpec }
  | { kind: 'shape'; shape: ShapeKind; wMm: number; hMm: number; op: OpKind }
  /** Library shapes and the Line/Curve tools: an SVG path stretched from its bounds `vb` to wMm x hMm. */
  | { kind: 'path'; name: string; d: string; vb: ViewBox; closed: boolean; wMm: number; hMm: number; op: OpKind };
export interface DesignPart extends Placement { id: number; source: Source }

const PX_MM = 25.4 / 96;
const UNITS: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: PX_MM, '': PX_MM };

interface FileInfo { data: string; w: number; h: number; img: HTMLImageElement | null; known: boolean }
const files = new Map<number, FileInfo>();

/** Natural size in mm, before scale and rotation. */
function fileInfo(p: DesignPart & { source: { kind: 'file' } }, onLoad: () => void): FileInfo {
  const cached = files.get(p.id);
  if (cached && cached.data === p.source.data) return cached;
  const { data, fileType } = p.source;
  let info: FileInfo = { data, w: 50, h: 50, img: null, known: false };
  if (fileType === 'svg') {
    const size = svgSize(data);
    if (size) info = { ...info, w: size[0], h: size[1], known: true };
    const img = new Image();
    img.onload = onLoad;
    img.src = URL.createObjectURL(new Blob([data], { type: 'image/svg+xml' }));
    info.img = img;
  } else {
    const size = dxfSize(data);
    if (size) info = { ...info, w: size[0], h: size[1], known: true };
  }
  files.set(p.id, info);
  return info;
}

function svgSize(data: string): [number, number] | null {
  try {
    const root = new DOMParser().parseFromString(data, 'image/svg+xml').documentElement;
    if (root.nodeName.toLowerCase() !== 'svg') return null;
    const len = (v: string | null) => {
      const m = v?.trim().match(/^([\d.]+)\s*(mm|cm|in|pt|pc|px)?$/i);
      return m ? Number(m[1]) * UNITS[(m[2] ?? '').toLowerCase()] : null;
    };
    const vb = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    const w = len(root.getAttribute('width')) ?? (vb?.length === 4 ? vb[2] * PX_MM : null);
    const h = len(root.getAttribute('height')) ?? (vb?.length === 4 ? vb[3] * PX_MM : null);
    return w && h && w > 0 && h > 0 ? [w, h] : null;
  } catch {
    return null;
  }
}

function dxfSize(data: string): [number, number] | null {
  const pt = (name: string) => {
    const m = data.match(new RegExp(`\\$${name}\\s*\\r?\\n\\s*10\\s*\\r?\\n\\s*(\\S+)\\s*\\r?\\n\\s*20\\s*\\r?\\n\\s*(\\S+)`));
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const lo = pt('EXTMIN');
  const hi = pt('EXTMAX');
  if (!lo || !hi) return null;
  const w = hi[0] - lo[0];
  const h = hi[1] - lo[1];
  return w > 0 && h > 0 && w < 1e5 && h < 1e5 ? [w, h] : null;
}

let measurer: CanvasRenderingContext2D | null = null;

export function fontCss(font: string): string {
  const f = TEXT_FONTS.find((x) => x.id === font) ?? TEXT_FONTS[0];
  return (font === 'sans' || font === 'serif' ? 'bold ' : '') + `100px ${f.css.includes(',') ? f.css : `'${f.css}'`}`;
}

/** Text size in mm: the letter height is the height of a capital letter, like the server's. */
function textSize(t: TextSpec): [number, number] {
  measurer ??= document.createElement('canvas').getContext('2d');
  const g = measurer!;
  g.font = fontCss(t.font);
  const cap = g.measureText('H').actualBoundingBoxAscent || 70;
  const m = g.measureText(t.value || ' ');
  const k = t.heightMm / cap;
  return [Math.max(m.width * k, 1), Math.max((m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) * k, t.heightMm)];
}

/** What to draw for a part the server hasn't processed. */
export function localView(p: DesignPart, onLoad: () => void): PartView {
  const s = p.source;
  let w: number;
  let h: number;
  if (s.kind === 'shape' || s.kind === 'path') [w, h] = [s.wMm, s.hMm];
  else if (s.kind === 'text') {
    const [tw, th] = textSize(s.text);
    [w, h] = [tw * p.scale, th * (p.scaleY ?? p.scale)];
  } else {
    const info = fileInfo(p as DesignPart & { source: { kind: 'file' } }, onLoad);
    [w, h] = [info.w * p.scale, info.h * (p.scaleY ?? p.scale)];
  }
  const turned = p.rotateDeg === 90 || p.rotateDeg === 270;
  const [bw, bh] = turned ? [h, w] : [w, h];
  const box: Box = [p.xMm - bw, p.yMm, p.xMm, p.yMm + bh];
  const view: PartView = { id: p.id, box, layers: [] };

  if (s.kind === 'shape') {
    const [x0, y0, x1, y1] = box;
    const path: [number, number][] = s.shape === 'box'
      ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
      : Array.from({ length: 65 }, (_, i) => {
        const a = (i / 64) * Math.PI * 2;
        return [(x0 + x1) / 2 + Math.cos(a) * (x1 - x0) / 2, (y0 + y1) / 2 + Math.sin(a) * (y1 - y0) / 2] as [number, number];
      });
    view.layers = [{ kind: s.op, paths: [path] }];
  } else if (s.kind === 'path') {
    view.sketch = { kind: 'path', d: s.d, vb: s.vb, color: OP_COLORS[s.op], fill: s.op === 'engrave' && s.closed, rot: p.rotateDeg };
  } else if (s.kind === 'text') {
    view.sketch = { kind: 'text', value: s.text.value || ' ', font: fontCss(s.text.font), color: OP_COLORS[s.text.op], fill: s.text.op === 'engrave', rot: p.rotateDeg };
  } else {
    const info = files.get(p.id);
    view.sketch = info?.img && info.known
      ? { kind: 'image', img: info.img, rot: p.rotateDeg }
      : { kind: 'label', text: info?.known ? s.name : `${s.name} (size shown after checking)`, rot: p.rotateDeg };
  }
  return view;
}

/** Forget a deleted part's cached image. */
export function dropLocal(id: number): void {
  const f = files.get(id);
  if (f?.img) URL.revokeObjectURL(f.img.src);
  files.delete(id);
}
