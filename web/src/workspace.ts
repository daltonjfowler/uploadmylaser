// The workspace: laser bed with mm rulers, zoom/pan, and parts you can select, drag and resize.
// Geometry comes from the server. While dragging, the part is moved/scaled locally and the page
// re-processes when you let go.
import type { OpKind } from '../../shared/contracts';
import { OP_COLORS } from './ops';
import { smoothD } from './library';
import { isDark, onThemeChange } from './theme';

// The bed stays a light "material" colour in dark mode too, so black Cut through lines stay visible.
const THEMES = {
  light: { around: '#e3e6ea', bed: '#fdfbf6', grid: '#efe8d8', grid10: '#d9cfb6', edge: '#9ca3af', ruler: '#f3f4f6', rulerInk: '#5b6570', corner: '#f3f4f6' },
  dark: { around: '#0d1117', bed: '#d8d1c1', grid: '#cbc3b1', grid10: '#b3a98f', edge: '#6b7280', ruler: '#161b22', rulerInk: '#9198a1', corner: '#161b22' },
};
// Selection, handles and the draft line: the page's purple accent, dark enough to read on the light bed.
const SEL = '#7c3aed';

export type Box = [number, number, number, number]; // x0, y0, x1, y1 in bed mm

/** A browser-drawn stand-in for geometry the server hasn't sent yet (see sketch.ts). */
export type Sketch = { rot: number } & (
  | { kind: 'text'; value: string; font: string; color: string; fill: boolean }
  | { kind: 'image'; img: HTMLImageElement }
  | { kind: 'label'; text: string }
  | { kind: 'path'; d: string; vb: { x: number; y: number; w: number; h: number }; color: string; fill: boolean }
);

export interface PartView {
  id: number;
  box: Box | null;
  layers: { kind: OpKind; paths: [number, number][][] }[];
  sketch?: Sketch;
}

export interface WorkspaceEvents {
  onSelect(id: number | null): void;
  /** Shift+click: add a part to the selection, or take it out. */
  onToggle(id: number): void;
  /** One part, or every selected part, moved together. */
  onMove(ids: number[], dxMm: number, dyMm: number): void;
  /** Resized by a handle. fx/fy are screen-axis factors; `to` is the new box. */
  onResize(ids: number[], fx: number, fy: number, from: Box, to: Box): void;
  /** The lock button: resize keeps the shape unless it's off (Shift flips it while dragging). */
  isLocked(): boolean;
  /** A size label on the selection was clicked: `at` is where it sits (css px in the canvas), `mm` its value. */
  onDimClick(which: Dim, at: { x: number; y: number }, mm: number): void;
  /** The Line or Curve tool finished a drawing (bed mm). */
  onDrawn(tool: 'line' | 'curve', pts: [number, number][], closed: boolean): void;
}

/** A local, not-yet-processed change to one part: its geometry is drawn mapped from `from` onto `to`. */
interface Live { ids: number[]; from: Box; to: Box }

/** Size labels: width, height, a circle's diameter, a line's length. */
export type Dim = 'w' | 'h' | 'd' | 'len';
/** How the selected part is measured: a circle by its diameter, a line by its length. */
export type DimMode = 'box' | 'circle' | 'line';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CURSORS: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

const RULER = 22; // css px
const HANDLE = 10; // css px, drawn size of a resize square
const GRIP = 12; // css px, radius of the move grip under the selection

export class Workspace {
  private g: CanvasRenderingContext2D;
  private bed = { w: 914, h: 609 };
  private parts: PartView[] = [];
  private selected: number | null = null;
  /** Several parts selected (Ctrl+A, Shift+click): they move together; resizing is for one part. */
  private group: number[] = [];
  private jobBox: Box | null = null;
  private jobBad = false;
  private headDot = true;
  private zero = { right: true, bottom: false }; // which bed corner the rulers count from
  private busy = false;
  /** px per mm, and the screen position (css px) of bed 0,0 */
  private view = { s: 1, ox: RULER + 10, oy: RULER + 10 };
  private fitted = false;
  private live: Live | null = null;
  private gesture:
    | { kind: 'move'; ids: number[]; box: Box; startX: number; startY: number }
    | { kind: 'resize'; ids: number[]; box: Box; handle: Handle }
    | { kind: 'pan'; startX: number; startY: number; ox: number; oy: number }
    | { kind: 'pinch'; d0: number; mx: number; my: number; s0: number }
    | null = null;
  /** Fingers (or pens/mice) currently down, for pinch zoom. */
  private pointers = new Map<number, { x: number; y: number }>();
  private touchSlop = 0; // extra px of handle hit area for fingers
  private tool: 'select' | 'line' | 'curve' = 'select';
  private unit = { mm: 1, label: 'mm' }; // display units for rulers and the live length
  private draft: [number, number][] = []; // points placed so far with the Line/Curve tool
  private cursor: [number, number] | null = null;
  private pressAt: [number, number] | null = null; // where a Line drag started
  private dimMode: DimMode = 'box';
  /** Size labels drawn last frame (css px), so a click on one can edit it. */
  private dims: { which: Dim; x: number; y: number; w: number; h: number; mm: number }[] = [];

  constructor(private canvas: HTMLCanvasElement, private ev: WorkspaceEvents) {
    this.g = canvas.getContext('2d')!;
    new ResizeObserver(() => {
      if (!this.fitted) this.fit();
      this.clampView();
      this.draw();
    }).observe(canvas);
    canvas.addEventListener('pointerdown', this.down);
    canvas.addEventListener('pointermove', this.move);
    canvas.addEventListener('pointerup', this.up);
    canvas.addEventListener('pointercancel', this.up);
    canvas.addEventListener('wheel', this.wheel, { passive: false });
    canvas.addEventListener('dblclick', () => this.finishDraft());
    onThemeChange(() => this.draw());
  }

  setBed(w: number, h: number): void {
    this.bed = { w, h };
    this.fit();
  }

  /** Rulers and grid count from this corner (the machine's home corner), like LightBurn. */
  setZeroCorner(right: boolean, bottom: boolean): void {
    this.zero = { right, bottom };
    this.draw();
  }

  /** Relative jobs start at the laser head: show a dot on the job's top-right corner. */
  setHeadDot(on: boolean): void {
    this.headDot = on;
    this.draw();
  }

  setParts(parts: PartView[], jobBox: Box | null, jobBad: boolean): void {
    this.parts = parts;
    this.jobBox = jobBox;
    this.jobBad = jobBad;
    this.draw();
  }

  setSelected(id: number | null): void {
    this.selected = id;
    this.draw();
  }

  /** Select, or draw with the Line/Curve tool. */
  setTool(t: 'select' | 'line' | 'curve'): void {
    this.tool = t;
    this.draft = [];
    this.canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
    this.draw();
  }

  get drawing(): boolean {
    return this.tool !== 'select';
  }

  /** At least one point placed, so a typed length has somewhere to start from. */
  get hasDraft(): boolean {
    return this.draft.length > 0;
  }

  /** How far the pointer is from the last point placed (mm), for an angle typed without a length. */
  pointerLength(): number {
    const last = this.draft[this.draft.length - 1];
    return last && this.cursor ? Math.hypot(this.cursor[0] - last[0], this.cursor[1] - last[1]) : 0;
  }

  setUnits(mmPerUnit: number, label: string): void {
    this.unit = { mm: mmPerUnit, label };
    this.draw();
  }

  /** A typed length (mm): the next point goes that far toward the pointer, or at `angleDeg`
   *  (0 = right, 90 = up, as in CAD). A line finishes; a curve keeps going. */
  typedPoint(lenMm: number, angleDeg: number | null): void {
    const last = this.draft[this.draft.length - 1];
    if (!last) return;
    let dx = 1;
    let dy = 0;
    if (angleDeg !== null) {
      const a = (angleDeg * Math.PI) / 180;
      [dx, dy] = [Math.cos(a), -Math.sin(a)];
    } else if (this.cursor) {
      const l = Math.hypot(this.cursor[0] - last[0], this.cursor[1] - last[1]);
      if (l > 1e-9) [dx, dy] = [(this.cursor[0] - last[0]) / l, (this.cursor[1] - last[1]) / l];
    }
    this.draft.push([last[0] + dx * lenMm, last[1] + dy * lenMm]);
    if (this.tool === 'line') this.emitDraft(false);
    else this.draw();
  }

  /** Enter (or a double-click) ends a curve; a line needs its second point. */
  finishDraft(): void {
    if (this.tool === 'curve' && this.draft.length >= 2) this.emitDraft(false);
    else this.cancelDraft();
  }

  cancelDraft(): void {
    this.draft = [];
    this.draw();
  }

  private emitDraft(closed: boolean): void {
    const pts = this.draft.filter((q, i, a) => !i || Math.hypot(q[0] - a[i - 1][0], q[1] - a[i - 1][1]) > 0.3);
    const tool = this.tool as 'line' | 'curve';
    this.draft = [];
    if (pts.length >= 2) this.ev.onDrawn(tool, pts, closed);
    this.draw();
  }

  /** The tool point under the pointer: Shift snaps a line to 45°. */
  private toolPoint(mx: number, my: number, shift: boolean): [number, number] {
    const last = this.draft[this.draft.length - 1];
    if (!shift || !last) return [mx, my];
    const a = Math.round(Math.atan2(my - last[1], mx - last[0]) / (Math.PI / 4)) * (Math.PI / 4);
    const r = Math.hypot(mx - last[0], my - last[1]);
    return [last[0] + r * Math.cos(a), last[1] + r * Math.sin(a)];
  }

  setDimMode(m: DimMode): void {
    if (m === this.dimMode) return;
    this.dimMode = m;
    this.draw();
  }

  /** A length in the display unit, rounded like the size boxes. */
  private fmt(mm: number): string {
    const digits = this.unit.label === 'mm' ? 1 : this.unit.label === 'cm' ? 2 : 3;
    return `${Number((mm / this.unit.mm).toFixed(digits))} ${this.unit.label}`;
  }

  private dimAt(x: number, y: number): (typeof this.dims)[number] | undefined {
    const pad = this.touchSlop / 2;
    return this.dims.find((d) => x >= d.x - pad && x <= d.x + d.w + pad && y >= d.y - pad && y <= d.y + d.h + pad);
  }

  setGroup(ids: number[]): void {
    this.group = ids;
    this.draw();
  }

  setBusy(on: boolean): void {
    this.busy = on;
    this.draw();
  }

  // ---------- zoom ----------

  fit(): void {
    this.zoomTo([0, 0, this.bed.w, this.bed.h]);
    this.fitted = this.canvas.clientWidth > 0;
  }

  zoomTo(b: Box): void {
    const w = this.canvas.clientWidth - RULER - 20;
    const h = this.canvas.clientHeight - RULER - 20;
    if (w <= 0 || h <= 0) return;
    const bw = Math.max(b[2] - b[0], 10);
    const bh = Math.max(b[3] - b[1], 10);
    const s = Math.min(w / bw, h / bh);
    this.view = {
      s,
      ox: RULER + 10 + (w - bw * s) / 2 - b[0] * s,
      oy: RULER + 10 + (h - bh * s) / 2 - b[1] * s,
    };
    this.draw();
  }

  zoomBy(f: number, cx = this.canvas.clientWidth / 2, cy = this.canvas.clientHeight / 2): void {
    const s = Math.min(Math.max(this.view.s * f, this.fitScale() * 0.6), 60);
    const k = s / this.view.s;
    this.view = { s, ox: cx - (cx - this.view.ox) * k, oy: cy - (cy - this.view.oy) * k };
    this.clampView();
    this.draw();
  }

  private fitScale(): number {
    const w = this.canvas.clientWidth - RULER - 20;
    const h = this.canvas.clientHeight - RULER - 20;
    return w > 0 && h > 0 ? Math.min(w / this.bed.w, h / this.bed.h) : 0.2;
  }

  /** Keep part of the bed on screen, so nobody can pan off into nothing. */
  private clampView(): void {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (!cw || !ch) return;
    const bw = this.bed.w * this.view.s;
    const bh = this.bed.h * this.view.s;
    // css px of bed that must stay on screen: a good chunk of it, or all of it when zoomed out
    const kx = Math.min(bw, (cw - RULER) / 3);
    const ky = Math.min(bh, (ch - RULER) / 3);
    this.view.ox = Math.min(Math.max(this.view.ox, RULER + kx - bw), cw - kx);
    this.view.oy = Math.min(Math.max(this.view.oy, RULER + ky - bh), ch - ky);
  }

  // ---------- pointer ----------

  private pt(e: PointerEvent | WheelEvent): { x: number; y: number; mx: number; my: number } {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return { x, y, mx: (x - this.view.ox) / this.view.s, my: (y - this.view.oy) / this.view.s };
  }

  /** Screen positions of the selected part's handles and move grip. */
  private handlePoints(): { pts: Record<Handle, [number, number]>; grip: [number, number]; small: boolean; group: boolean } | null {
    const group = this.group.length > 1;
    const b = group ? this.groupBox(true) : (() => { const p = this.parts.find((x) => x.id === this.selected); return p ? this.liveBox(p) : null; })();
    if (!b) return null;
    const { s, ox, oy } = this.view;
    const x0 = ox + b[0] * s - 4;
    const y0 = oy + b[1] * s - 4;
    const x1 = ox + b[2] * s + 4;
    const y1 = oy + b[3] * s + 4;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    return {
      pts: { nw: [x0, y0], n: [cx, y0], ne: [x1, y0], e: [x1, cy], se: [x1, y1], s: [cx, y1], sw: [x0, y1], w: [x0, cy] },
      grip: [cx, y1 + GRIP + 12],
      small: x1 - x0 < 40 || y1 - y0 < 40, // edge squares hide on tiny parts so the corners stay grabbable
      group,
    };
  }

  /** The box around every selected part (optionally where a live drag has them). */
  private groupBox(live: boolean): Box | null {
    const bs = this.parts.filter((p) => this.group.includes(p.id)).map((p) => (live ? this.liveBox(p) : p.box)).filter((b): b is Box => !!b);
    if (!bs.length) return null;
    return [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))];
  }

  private hit(x: number, y: number): Handle | 'grip' | null {
    const hp = this.handlePoints();
    if (!hp) return null;
    const r = HANDLE / 2 + 3 + this.touchSlop;
    if (Math.hypot(x - hp.grip[0], y - hp.grip[1]) <= GRIP + 3 + this.touchSlop) return 'grip';
    for (const h of HANDLES) {
      if (hp.small && h.length === 1) continue;
      const [hx, hy] = hp.pts[h];
      if (Math.abs(x - hx) <= r && Math.abs(y - hy) <= r) return h;
    }
    return null;
  }

  private partAt(mx: number, my: number): PartView | undefined {
    const pad = 3 / this.view.s; // thin designs are still easy to grab
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const b = this.parts[i].box;
      if (b && mx >= b[0] - pad && mx <= b[2] + pad && my >= b[1] - pad && my <= b[3] + pad) return this.parts[i];
    }
    return undefined;
  }

  private down = (e: PointerEvent) => {
    const p = this.pt(e);
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: p.x, y: p.y });
    this.touchSlop = e.pointerType === 'touch' ? 8 : 0;
    if (this.pointers.size === 2) return this.startPinch();
    if (this.pointers.size > 2) return;
    if (this.tool !== 'select' && e.button === 0) {
      const pt = this.toolPoint(p.mx, p.my, e.shiftKey);
      if (this.tool === 'line') {
        if (!this.draft.length) {
          this.draft = [pt];
          this.pressAt = pt; // a drag-and-release also makes a line
        } else {
          this.draft.push(pt);
          this.emitDraft(false);
        }
      } else {
        const first = this.draft[0];
        const nearFirst = first && this.draft.length >= 3 && Math.hypot((first[0] - p.mx) * this.view.s, (first[1] - p.my) * this.view.s) < 10 + this.touchSlop;
        if (nearFirst) this.emitDraft(true);
        else this.draft.push(pt);
      }
      this.draw();
      return;
    }
    const dim = e.button === 0 && !e.shiftKey ? this.dimAt(p.x, p.y) : undefined;
    if (dim) {
      this.pointers.delete(e.pointerId);
      this.ev.onDimClick(dim.which, { x: dim.x + dim.w / 2, y: dim.y + dim.h / 2 }, dim.mm);
      return;
    }
    const sel = this.parts.find((x) => x.id === this.selected);
    const gbox = this.group.length > 1 ? this.groupBox(false) : null;
    const h = e.button === 0 ? this.hit(p.x, p.y) : null;
    if (h === 'grip' && gbox) {
      this.gesture = { kind: 'move', ids: [...this.group], box: gbox, startX: p.mx, startY: p.my };
      return;
    }
    if (sel?.box && h === 'grip') {
      this.gesture = { kind: 'move', ids: [sel.id], box: sel.box, startX: p.mx, startY: p.my };
      return;
    }
    if (gbox && h && h !== 'grip') {
      this.gesture = { kind: 'resize', ids: [...this.group], box: gbox, handle: h };
      return;
    }
    if (sel?.box && h && h !== 'grip') {
      this.gesture = { kind: 'resize', ids: [sel.id], box: sel.box, handle: h };
      return;
    }
    const part = e.button === 0 ? this.partAt(p.mx, p.my) : undefined;
    if (part?.box && e.shiftKey) {
      this.ev.onToggle(part.id);
      return;
    }
    if (part?.box && gbox && this.group.includes(part.id)) {
      this.gesture = { kind: 'move', ids: [...this.group], box: gbox, startX: p.mx, startY: p.my };
      return;
    }
    if (part?.box) {
      if (part.id !== this.selected) this.ev.onSelect(part.id);
      this.gesture = { kind: 'move', ids: [part.id], box: part.box, startX: p.mx, startY: p.my };
      return;
    }
    if (e.button === 0 && (this.selected !== null || this.group.length) && !e.shiftKey) this.ev.onSelect(null);
    this.gesture = { kind: 'pan', startX: p.x, startY: p.y, ox: this.view.ox, oy: this.view.oy };
  };

  /** Two fingers down: zoom about their midpoint and pan as it moves. Any drag in progress is dropped. */
  private startPinch(): void {
    const [a, b] = [...this.pointers.values()];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    this.live = null;
    this.gesture = {
      kind: 'pinch',
      d0: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1),
      mx: (mx - this.view.ox) / this.view.s,
      my: (my - this.view.oy) / this.view.s,
      s0: this.view.s,
    };
    this.draw();
  }

  private move = (e: PointerEvent) => {
    const p = this.pt(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: p.x, y: p.y });
    const gs = this.gesture;
    if (this.tool !== 'select' && !gs) {
      this.cursor = this.toolPoint(p.mx, p.my, e.shiftKey);
      this.draw();
      return;
    }
    if (!gs) {
      const h = this.hit(p.x, p.y);
      this.canvas.style.cursor = this.dimAt(p.x, p.y) ? 'text' : h === 'grip' ? 'move' : h ? CURSORS[h] : this.partAt(p.mx, p.my) ? 'move' : 'grab';
      return;
    }
    if (gs.kind === 'pinch') {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const s = Math.min(Math.max((gs.s0 * Math.hypot(a.x - b.x, a.y - b.y)) / gs.d0, this.fitScale() * 0.6), 60);
      // the bed point that started under the fingers' midpoint stays under it
      this.view = { s, ox: (a.x + b.x) / 2 - gs.mx * s, oy: (a.y + b.y) / 2 - gs.my * s };
      this.clampView();
    } else if (gs.kind === 'pan') {
      this.view.ox = gs.ox + p.x - gs.startX;
      this.view.oy = gs.oy + p.y - gs.startY;
      this.clampView();
    } else if (gs.kind === 'move') {
      const dx = p.mx - gs.startX;
      const dy = p.my - gs.startY;
      const [x0, y0, x1, y1] = gs.box;
      this.live = { ids: gs.ids, from: gs.box, to: [x0 + dx, y0 + dy, x1 + dx, y1 + dy] };
    } else {
      this.live = { ids: gs.ids, from: gs.box, to: resized(gs.box, gs.handle, p.mx, p.my, this.ev.isLocked() !== e.shiftKey) };
    }
    this.draw();
  };

  private up = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.tool === 'line' && this.pressAt && this.draft.length === 1 && this.cursor) {
      const moved = Math.hypot((this.cursor[0] - this.pressAt[0]) * this.view.s, (this.cursor[1] - this.pressAt[1]) * this.view.s);
      if (moved > 8) {
        this.draft.push(this.cursor);
        this.emitDraft(false);
      }
    }
    this.pressAt = null;
    const gs = this.gesture;
    const lv = this.live;
    if (gs?.kind === 'pinch') {
      if (this.pointers.size < 2) this.gesture = null; // lifting a finger ends the pinch, with no stray pan
      return;
    }
    this.gesture = null;
    if (!gs || gs.kind === 'pan' || !lv) {
      this.live = null;
      return;
    }
    const [f0, f1] = [lv.from, lv.to];
    const fx = (f1[2] - f1[0]) / Math.max(f0[2] - f0[0], 1e-6);
    const fy = (f1[3] - f1[1]) / Math.max(f0[3] - f0[1], 1e-6);
    const dx = f1[2] - f0[2];
    const dy = f1[1] - f0[1];
    // Keep showing the live change until the page calls clearLive() with the new geometry.
    if (gs.kind === 'move' && (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2)) this.ev.onMove(lv.ids, dx, dy);
    else if (gs.kind === 'resize' && (Math.abs(fx - 1) > 0.005 || Math.abs(fy - 1) > 0.005)) this.ev.onResize(lv.ids, fx, fy, f0, f1);
    else this.live = null;
    this.draw();
  };

  /** Drop any local preview (the server answered, or the change was cancelled). */
  clearLive(): void {
    this.live = null;
    this.draw();
  }

  /** Mouse wheel and touchpad: smooth zoom about the pointer. A touchpad pinch arrives as ctrl+wheel. */
  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = this.pt(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    this.zoomBy(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
  };

  // ---------- drawing ----------

  draw(): void {
    const c = this.canvas;
    const dpr = devicePixelRatio || 1;
    const cw = c.clientWidth;
    const ch = c.clientHeight;
    if (!cw || !ch) return;
    if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) {
      c.width = Math.round(cw * dpr);
      c.height = Math.round(ch * dpr);
    }
    const g = this.g;
    const { s, ox, oy } = this.view;
    const th = isDark() ? THEMES.dark : THEMES.light;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = th.around;
    g.fillRect(0, 0, cw, ch);

    // bed and grid
    const bw = this.bed.w * s;
    const bh = this.bed.h * s;
    g.fillStyle = th.bed;
    g.fillRect(ox, oy, bw, bh);
    const grid = gridFor(s, this.unit.mm);
    g.lineWidth = 1;
    for (let i = 0; i * grid.step <= this.bed.w + 1e-6; i++) {
      const x = ox + this.gridX(i * grid.step) * s;
      line(g, x, oy, x, oy + bh, i % grid.major === 0 ? th.grid10 : th.grid);
    }
    for (let i = 0; i * grid.step <= this.bed.h + 1e-6; i++) {
      const y = oy + this.gridY(i * grid.step) * s;
      line(g, ox, y, ox + bw, y, i % grid.major === 0 ? th.grid10 : th.grid);
    }
    g.strokeStyle = th.edge;
    g.strokeRect(ox + 0.5, oy + 0.5, bw, bh);

    // parts
    for (const p of this.parts) this.drawPart(p);

    // whole-job box and the laser head dot
    const jb = this.liveJobBox();
    if (jb) {
      const [x0, y0, x1, y1] = jb;
      g.setLineDash([5, 4]);
      g.strokeStyle = this.jobBad ? '#dc2626' : '#16a34a';
      g.lineWidth = 1;
      g.strokeRect(ox + x0 * s, oy + y0 * s, (x1 - x0) * s, (y1 - y0) * s);
      g.setLineDash([]);
      if (this.headDot) {
        const hx = ox + x1 * s;
        const hy = oy + y0 * s;
        g.fillStyle = '#16a34a';
        g.beginPath();
        g.arc(hx, hy, 6, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#fff';
        g.lineWidth = 2;
        g.stroke();
      }
    }

    this.drawSelection(); // last, so handles sit above the laser-head dot
    this.drawDraft();
    this.drawRulers(cw, ch, grid, th);

    if (this.busy) {
      g.fillStyle = 'rgba(17,24,39,.75)';
      g.font = '600 13px system-ui, sans-serif';
      const t = 'Working…';
      const tw = g.measureText(t).width + 20;
      g.fillRect(cw - tw - 10, ch - 34, tw, 24);
      g.fillStyle = '#fff';
      g.fillText(t, cw - tw, ch - 17);
    }
  }

  /** The Line/Curve tool's points so far, and a rubber band to the pointer. */
  private drawDraft(): void {
    if (this.tool === 'select') return;
    this.drawTip(this.tool === 'line'
      ? 'Click two points, or drag  ·  Type a number for an exact length  ·  Enter or Esc to stop'
      : 'Click to add points  ·  Click the first point to close  ·  Double-click, Enter or Esc to finish  ·  Type a number for an exact length');
    if (!this.draft.length) return;
    const g = this.g;
    const { s, ox, oy } = this.view;
    const last = this.draft[this.draft.length - 1];
    if (this.cursor) {
      const t = `${this.fmt(Math.hypot(this.cursor[0] - last[0], this.cursor[1] - last[1]))}  ·  ${cadAngle(last, this.cursor)}°`;
      g.font = '600 12px system-ui, sans-serif';
      const tx = ox + this.cursor[0] * s + 14;
      const ty = oy + this.cursor[1] * s - 12;
      g.fillStyle = 'rgba(17,24,39,.85)';
      g.fillRect(tx - 4, ty - 13, g.measureText(t).width + 8, 18);
      g.fillStyle = '#fff';
      g.fillText(t, tx, ty);
    }
    const pts = this.cursor ? [...this.draft, this.cursor] : this.draft;
    g.strokeStyle = SEL;
    g.lineWidth = 2;
    g.setLineDash(this.tool === 'line' ? [6, 4] : []);
    if (this.tool === 'curve' && pts.length > 2) {
      const path = new Path2D();
      path.addPath(new Path2D(smoothD(pts, false)), new DOMMatrix([s, 0, 0, s, ox, oy]));
      g.stroke(path);
    } else {
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(ox + x * s, oy + y * s) : g.moveTo(ox + x * s, oy + y * s)));
      g.stroke();
    }
    g.setLineDash([]);
    g.fillStyle = SEL;
    for (const [x, y] of this.draft) {
      g.beginPath();
      g.arc(ox + x * s, oy + y * s, 4, 0, Math.PI * 2);
      g.fill();
    }
  }

  private drawTip(text: string): void {
    const g = this.g;
    g.font = '13px system-ui, sans-serif';
    const w = Math.min(g.measureText(text).width + 20, this.canvas.clientWidth - RULER - 20);
    const x = RULER + 10;
    const y = this.canvas.clientHeight - 40;
    g.fillStyle = 'rgba(124,58,237,.92)';
    g.fillRect(x, y, w, 28);
    g.fillStyle = '#fff';
    g.fillText(text, x + 10, y + 18, w - 20);
  }

  private liveJobBox(): Box | null {
    if (!this.live) return this.jobBox;
    const boxes = this.parts.map((p) => this.liveBox(p)).filter((b): b is Box => !!b);
    if (!boxes.length) return null;
    return [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
  }

  private liveBox(p: PartView): Box | null {
    if (!p.box) return null;
    const lv = this.live;
    if (!lv || !lv.ids.includes(p.id)) return p.box;
    const [a, b] = [lv.from, lv.to];
    const kx = (b[2] - b[0]) / Math.max(a[2] - a[0], 1e-6);
    const ky = (b[3] - b[1]) / Math.max(a[3] - a[1], 1e-6);
    const [x0, y0, x1, y1] = p.box;
    return [b[0] + (x0 - a[0]) * kx, b[1] + (y0 - a[1]) * ky, b[0] + (x1 - a[0]) * kx, b[1] + (y1 - a[1]) * ky];
  }

  private drawPart(p: PartView): void {
    if (!p.box) return;
    const g = this.g;
    const { s, ox, oy } = this.view;
    const lv = this.live?.ids.includes(p.id) ? this.live : null;
    // bed mm → screen, including a live move/resize (the from box mapped onto the to box)
    const [a, b] = lv ? [lv.from, lv.to] : [p.box, p.box];
    const kx = (b[2] - b[0]) / Math.max(a[2] - a[0], 1e-6);
    const ky = (b[3] - b[1]) / Math.max(a[3] - a[1], 1e-6);
    const X = (x: number) => ox + (b[0] + (x - a[0]) * kx) * s;
    const Y = (y: number) => oy + (b[1] + (y - a[1]) * ky) * s;

    for (const layer of p.layers) {
      g.beginPath();
      for (const path of layer.paths) path.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
      if (layer.kind === 'engrave') {
        g.fillStyle = 'rgba(37,99,235,0.5)';
        g.fill('evenodd');
        g.strokeStyle = OP_COLORS.engrave;
        g.lineWidth = 0.75;
        g.stroke();
      } else {
        g.strokeStyle = OP_COLORS[layer.kind];
        g.lineWidth = 1.5;
        g.stroke();
      }
    }
    if (p.sketch) this.drawSketch(p.sketch, this.liveBox(p)!);

  }

  private drawSelection(): void {
    this.dims = [];
    const hp = this.handlePoints();
    if (!hp) return;
    const g = this.g;
    const { nw, se } = hp.pts;
    g.setLineDash([4, 3]);
    g.strokeStyle = SEL;
    g.lineWidth = 1;
    g.strokeRect(nw[0], nw[1], se[0] - nw[0], se[1] - nw[1]);
    if (hp.group) {
      // each selected part gets its own thin outline inside the group box
      const { s, ox, oy } = this.view;
      for (const p of this.parts) {
        const b = this.group.includes(p.id) ? this.liveBox(p) : null;
        if (b) g.strokeRect(ox + b[0] * s - 2, oy + b[1] * s - 2, (b[2] - b[0]) * s + 4, (b[3] - b[1]) * s + 4);
      }
    }
    g.setLineDash([]);
    for (const h of HANDLES) {
      if (hp.small && h.length === 1) continue;
      const [x, y] = hp.pts[h];
      g.fillStyle = '#ffffff';
      g.strokeStyle = SEL;
      g.lineWidth = 2;
      g.fillRect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE);
      g.strokeRect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE);
    }
    // move grip: a round "drag here" spot under the selection, with four arrows
    const [gx, gy] = hp.grip;
    g.beginPath();
    g.moveTo(gx, hp.pts.s[1] + HANDLE / 2);
    g.lineTo(gx, gy - GRIP);
    g.strokeStyle = SEL;
    g.lineWidth = 1.5;
    g.stroke();
    g.beginPath();
    g.arc(gx, gy, GRIP, 0, Math.PI * 2);
    g.fillStyle = SEL;
    g.fill();
    g.strokeStyle = '#ffffff';
    g.lineWidth = 1.6;
    const r = GRIP - 4;
    g.beginPath();
    g.moveTo(gx - r, gy);
    g.lineTo(gx + r, gy);
    g.moveTo(gx, gy - r);
    g.lineTo(gx, gy + r);
    for (const [ax, ay, dx, dy] of [[gx - r, gy, 1, 0], [gx + r, gy, -1, 0], [gx, gy - r, 0, 1], [gx, gy + r, 0, -1]]) {
      g.moveTo(ax + dx * 3 + dy * 3, ay + dy * 3 + dx * 3);
      g.lineTo(ax, ay);
      g.lineTo(ax + dx * 3 - dy * 3, ay + dy * 3 - dx * 3);
    }
    g.stroke();
    this.drawDims(hp);
  }

  /** Clickable size labels: width above the selection, height to its left. A circle shows its
   *  diameter, a line its length. They follow a drag live. */
  private drawDims(hp: NonNullable<ReturnType<Workspace['handlePoints']>>): void {
    const b = hp.group ? this.groupBox(true) : (() => { const p = this.parts.find((x) => x.id === this.selected); return p ? this.liveBox(p) : null; })();
    if (!b || this.tool !== 'select') return;
    const w = b[2] - b[0];
    const h = b[3] - b[1];
    const mode = hp.group ? 'box' : this.dimMode;
    const { nw, se, n, w: west } = hp.pts;
    const top = Math.max(nw[1] - 22, RULER + 12);
    if (mode === 'line') {
      this.dimLabel('len', this.fmt(Math.hypot(w, h)), Math.hypot(w, h), (nw[0] + se[0]) / 2, Math.max((nw[1] + se[1]) / 2 - 18, RULER + 12));
    } else if (mode === 'circle' && Math.abs(w - h) < 0.05) {
      this.dimLabel('d', `⌀ ${this.fmt(w)}`, w, n[0], top);
    } else {
      this.dimLabel('w', `↔ ${this.fmt(w)}`, w, n[0], top);
      this.dimLabel('h', `↕ ${this.fmt(h)}`, h, west[0] - 14, west[1], 'right');
    }
  }

  /** One size label: a white pill with purple ink, centred on (x, y) or right-aligned to x. */
  private dimLabel(which: Dim, text: string, mm: number, x: number, y: number, align: 'center' | 'right' = 'center'): void {
    const g = this.g;
    g.font = '600 12px system-ui, sans-serif';
    const w = g.measureText(text).width + 14;
    const h = 20;
    const x0 = Math.max(align === 'right' ? x - w : x - w / 2, RULER + 2);
    const y0 = y - h / 2;
    g.beginPath();
    g.roundRect(x0, y0, w, h, 6);
    g.fillStyle = '#ffffff';
    g.fill();
    g.strokeStyle = SEL;
    g.lineWidth = 1.5;
    g.stroke();
    g.fillStyle = '#5b21b6';
    g.textBaseline = 'middle';
    g.fillText(text, x0 + 7, y0 + h / 2 + 0.5);
    g.textBaseline = 'alphabetic';
    this.dims.push({ which, x: x0, y: y0, w, h, mm });
  }

  private drawSketch(sk: Sketch, b: Box): void {
    const g = this.g;
    const { s, ox, oy } = this.view;
    const turned = sk.rot === 90 || sk.rot === 270;
    const bw = (b[2] - b[0]) * s;
    const bh = (b[3] - b[1]) * s;
    const [w, h] = turned ? [bh, bw] : [bw, bh]; // size before rotation
    g.save();
    g.translate(ox + ((b[0] + b[2]) / 2) * s, oy + ((b[1] + b[3]) / 2) * s);
    g.rotate((sk.rot * Math.PI) / 180);
    if (sk.kind === 'path') {
      // map the path's own bounds onto the box; stroke width stays constant on screen
      const m = new DOMMatrix().translate(-w / 2, -h / 2).scale(sk.vb.w > 1e-6 ? w / sk.vb.w : 1, sk.vb.h > 1e-6 ? h / sk.vb.h : 1).translate(-sk.vb.x, -sk.vb.y);
      const path = new Path2D();
      path.addPath(new Path2D(sk.d), m);
      if (sk.fill) {
        g.fillStyle = 'rgba(37,99,235,0.5)';
        g.fill(path, 'evenodd');
      }
      g.strokeStyle = sk.color;
      g.lineWidth = 1.5;
      g.stroke(path);
    } else if (sk.kind === 'image') {
      g.globalAlpha = 0.85;
      g.drawImage(sk.img, -w / 2, -h / 2, w, h);
    } else if (sk.kind === 'text') {
      g.font = sk.font;
      const m = g.measureText(sk.value);
      const tw = m.width || 1;
      const th = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent || 1;
      g.scale(w / tw, h / th);
      g.textBaseline = 'alphabetic';
      const x = -tw / 2;
      const y = -th / 2 + m.actualBoundingBoxAscent;
      if (sk.fill) {
        g.fillStyle = 'rgba(37,99,235,0.5)';
        g.fillText(sk.value, x, y);
      }
      g.strokeStyle = sk.color;
      g.lineWidth = 1.5 * (tw / w);
      g.strokeText(sk.value, x, y);
    } else {
      g.setLineDash([6, 4]);
      g.strokeStyle = '#6b7280';
      g.lineWidth = 1;
      g.strokeRect(-w / 2, -h / 2, w, h);
      g.setLineDash([]);
      g.fillStyle = '#374151';
      g.font = '12px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(sk.text, 0, 4, w - 8);
    }
    g.restore();
  }

  /** Bed mm from the left/top for a distance `d` from the zero corner. */
  private gridX(d: number): number {
    return this.zero.right ? this.bed.w - d : d;
  }

  private gridY(d: number): number {
    return this.zero.bottom ? this.bed.h - d : d;
  }

  private drawRulers(cw: number, ch: number, grid: Grid, th: (typeof THEMES)['light']): void {
    const g = this.g;
    const { s, ox, oy } = this.view;
    g.fillStyle = th.ruler;
    g.fillRect(0, 0, cw, RULER);
    g.fillRect(0, 0, RULER, ch);
    g.fillStyle = th.rulerInk;
    g.strokeStyle = th.rulerInk;
    g.font = '10px system-ui, sans-serif';
    g.lineWidth = 1;
    // a number every `every` grid steps, at least ~40 px apart
    const every = [1, 2, 4, 5, 8, 10, 20, 40, 50, 100].find((k) => k * grid.step * s >= 40) ?? 200;
    const text = (i: number) => String(Number((i * grid.units).toFixed(3)));
    for (let i = 0; i * grid.step <= this.bed.w + 1e-6; i++) {
      const x = Math.round(ox + this.gridX(i * grid.step) * s) + 0.5;
      if (x < RULER || x > cw) continue;
      const major = i % every === 0;
      line(g, x, RULER, x, RULER - (major ? 10 : 5), th.rulerInk);
      // numbers sit on the bed side of their tick
      if (major) g.fillText(text(i), this.zero.right ? x - 2 - g.measureText(text(i)).width : x + 2, 10);
    }
    for (let i = 0; i * grid.step <= this.bed.h + 1e-6; i++) {
      const y = Math.round(oy + this.gridY(i * grid.step) * s) + 0.5;
      if (y < RULER || y > ch) continue;
      const major = i % every === 0;
      line(g, RULER, y, RULER - (major ? 10 : 5), y, th.rulerInk);
      if (major) {
        g.save();
        g.translate(10, y + 2);
        g.rotate(-Math.PI / 2);
        g.fillText(text(i), -g.measureText(text(i)).width, 0);
        g.restore();
      }
    }
    g.fillStyle = th.corner;
    g.fillRect(0, 0, RULER, RULER);
    g.fillStyle = th.rulerInk;
    g.fillText(this.unit.label, 3, 14);
  }
}

/** The box after dragging handle `h` to (mx, my): the opposite side stays put. A side handle stretches
 *  only its own axis; a corner keeps the shape when `uniform` (the lock). */
function resized(b: Box, h: Handle, mx: number, my: number, uniform: boolean): Box {
  const [x0, y0, x1, y1] = b;
  const w = Math.max(x1 - x0, 0.01);
  const ht = Math.max(y1 - y0, 0.01);
  let fx = h.includes('w') ? (x1 - mx) / w : h.includes('e') ? (mx - x0) / w : 1;
  let fy = h.includes('n') ? (y1 - my) / ht : h.includes('s') ? (my - y0) / ht : 1;
  fx = Math.max(fx, 0.02);
  fy = Math.max(fy, 0.02);
  // Side squares always stretch one axis. Corners keep the shape when locked.
  if (uniform && h.length === 2) fx = fy = Math.max(fx, fy);
  const W = w * fx;
  const H = ht * fy;
  const nx0 = h.includes('w') ? x1 - W : h.includes('e') ? x0 : (x0 + x1) / 2 - W / 2;
  const ny0 = h.includes('n') ? y1 - H : h.includes('s') ? y0 : (y0 + y1) / 2 - H / 2;
  return [nx0, ny0, nx0 + W, ny0 + H];
}

/** Angle from a to b in degrees, CAD style: 0 = right, 90 = up, counter-clockwise, 0..359.9. */
export function cadAngle(a: [number, number], b: [number, number]): number {
  const d = (Math.atan2(-(b[1] - a[1]), b[0] - a[0]) * 180) / Math.PI;
  return Math.round(((d % 360) + 360) % 360 * 10) / 10 % 360;
}

interface Grid { step: number; units: number; major: number } // step in mm; units = step in display units

/** Grid spacing at least 8 px apart, in round numbers of the display unit (1/8" steps for inches). */
function gridFor(s: number, mmPerUnit: number): Grid {
  const units = [0.01, 0.02, 0.05, 0.1, 0.125, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500].find((c) => c * mmPerUnit * s >= 8) ?? 1000;
  const inv = 1 / units;
  const major = units < 1 && Math.abs(inv - Math.round(inv)) < 1e-9 ? Math.round(inv) : 10; // a darker line every whole unit
  return { step: units * mmPerUnit, units, major };
}

function line(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string): void {
  g.strokeStyle = color;
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
}
