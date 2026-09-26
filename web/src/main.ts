// Student app, laid out a bit like LightBurn: toolbar, tools on the left, the bed in the middle,
// Layers and Laser panels on the right. Every part is processed by the server; the page only
// arranges parts, previews what comes back, and streams the finished job over USB.
import '@fontsource/anton/latin-400.css';
import '@fontsource/bungee/latin-400.css';
import '@fontsource/permanent-marker/latin-400.css';
import '@fontsource/pacifico/latin-400.css';
import '@fontsource/allerta-stencil/latin-400.css';
import type {
  ColorChoice, OpKind, Part, Placement, ProcessRequest, ProcessResponse, PublicMaterial, TextFontId, TextSpec,
} from '../../shared/contracts';
import { MAX_PARTS, MAX_UPLOAD_BYTES, TEXT_FONTS } from '../../shared/contracts';
import { ApiError, checkPhrase, getMachine, getMaterials, getPhrase, processDesign, setPhrase, type PublicMachine } from './api';
import { OP_COLORS, OP_LABELS, RUN_ORDER } from './ops';
import { cleanPanelName } from './ruida/panel';
import { fromBase64 } from './ruida/swizzle';
import { LaserLink } from './serial/laser';
import { LIBRARY, lineD, pathBBox, smoothD, type PathShape } from './library';
import { pathSvg, shapeSvg } from './shapes';
import { dropLocal, localView, type DesignPart, type Source } from './sketch';
import { initThemeButton } from './theme';
import { cadAngle, Workspace, type Box, type Dim, type PartView } from './workspace';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;


const STORE = 'uml.design';

let machine: PublicMachine = { bedWidthMm: 914, bedHeightMm: 609, swizzleMagic: 0x88, baud: 115200, maxJobMinutes: 20 };
let materials: PublicMaterial[] = [];
let materialId = '';
let parts: DesignPart[] = [];
let nextId = 1;
let selected: number | null = null;
let group: number[] = [];      // several parts selected (Ctrl+A, Shift+click); `selected` is then null
let color: OpKind = 'cut';
let colorMap: Record<string, ColorChoice> = {};
let powerChoice: Partial<Record<OpKind, number>> = {};
let result: ProcessResponse | null = null;
let resultIds: number[] = []; // part id for each index in `result`
let pending = false;          // a change is waiting for the server, so `result` is out of date
let framedRd: string | null = null;
let notes: string[] = [];     // "Frame sent." and friends
let link: LaserLink | null = null;
let locked = true;            // resize keeps the shape (the lock button in the size bar)
type Unit = 'mm' | 'cm' | 'in';
let unit: Unit = 'mm';
const UNIT_MM: Record<Unit, number> = { mm: 1, cm: 10, in: 25.4 };
const UNIT_DIGITS: Record<Unit, number> = { mm: 1, cm: 2, in: 3 };
/** mm → the chosen display unit, rounded for the size boxes. */
const toU = (mm: number) => round(mm / UNIT_MM[unit], UNIT_DIGITS[unit]);
/** a typed value in the display unit → mm */
const fromU = (v: number) => v * UNIT_MM[unit];

const relative = () => (machine.jobOriginMode ?? 'relative') === 'relative';
// X/Y boxes count from the machine's home corner (top-right on the class laser), like LightBurn.
// Both flips are their own inverse, so they convert bed mm to typed values and back.
const zeroRight = () => (machine.origin ?? 'top-right').endsWith('right');
const zeroBottom = () => (machine.origin ?? 'top-right').startsWith('bottom');
const flipX = (mm: number) => (zeroRight() ? machine.bedWidthMm - mm : mm);
const flipY = (mm: number) => (zeroBottom() ? machine.bedHeightMm - mm : mm);

const ws = new Workspace($<HTMLCanvasElement>('ws'), {
  onSelect: (id) => select(id),
  onToggle: (id) => toggleSelect(id),
  onMove: (ids, dx, dy) => moveParts(ids, dx, dy),
  onResize: (ids, fx, fy, from, to) => resizeParts(ids, fx, fy, from, to),
  isLocked: () => locked,
  onDimClick: (which, at, mm) => openDimEdit(which, at, mm),
  onDrawn: (tool, pts, closed) => {
    const d = tool === 'line' ? lineD(pts[0], pts[1]) : smoothD(pts, closed);
    const vb = pathBBox(d);
    // An open line can't be filled, so a line drawn in Engrave marks instead.
    const op: OpKind = color === 'engrave' && !closed ? 'score' : color;
    if (op !== color) warn('Open lines can’t be engraved (filled), so this one is Mark (red). Close a curve by clicking its first point.');
    addPart({ kind: 'path', name: tool === 'line' ? 'Line' : closed ? 'Closed curve' : 'Curve', d, vb, closed, wMm: vb.w, hMm: vb.h, op },
      { xMm: round(vb.x + vb.w), yMm: round(vb.y) });
    setTool('select');
  },
});

// ---------- startup ----------

async function init(): Promise<void> {
  try {
    [machine, materials] = await Promise.all([getMachine(), getMaterials()]);
  } catch {
    notes = ["Can't reach the server. Check the Wi-Fi."];
  }
  ws.setBed(machine.bedWidthMm, machine.bedHeightMm);
  ws.setHeadDot(relative());
  ws.setZeroCorner(zeroRight(), zeroBottom());
  restore();
  lastSnap = snap();
  renderHistoryButtons();
  if (!materials.some((m) => m.id === materialId)) materialId = materials.length === 1 ? materials[0].id : '';
  applyUnits();
  renderPalette();
  if (!LaserLink.supported()) $('status').textContent = 'Use Chrome to connect the laser';
  render();
  if (parts.length) schedule(0);
}

$<HTMLFormElement>('gateForm').onsubmit = async (ev) => {
  ev.preventDefault();
  const p = $<HTMLInputElement>('phrase').value;
  try {
    await checkPhrase(p);
    setPhrase(p);
    $('gate').hidden = true;
    $('gateErr').textContent = '';
    schedule(0);
  } catch (e) {
    $('gateErr').textContent = (e as Error).message;
  }
};

// ---------- parts ----------

function find(id: number | null): DesignPart | undefined {
  return parts.find((p) => p.id === id);
}

/** The server's geometry for a part if it has it, otherwise the browser's own sketch. */
function viewOf(p: DesignPart): PartView {
  const i = resultIds.indexOf(p.id);
  const box = i >= 0 ? result?.partBoxes[i] : null;
  if (result && box) return { id: p.id, box, layers: result.preview.filter((l) => l.part === i) };
  return localView(p, render);
}

function boxOf(id: number): Box | null {
  const p = find(id);
  return p ? viewOf(p).box : null;
}

function unionBox(boxes: (Box | null)[]): Box | null {
  const bs = boxes.filter((b): b is Box => !!b);
  if (!bs.length) return null;
  return [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))];
}

/** New parts go just left of the design (Import), or near the bed's top-right corner if it's empty. */
function newSpot(): { xMm: number; yMm: number } {
  const boxes = parts.map((p) => boxOf(p.id)).filter((b): b is Box => !!b);
  if (!boxes.length) return { xMm: machine.bedWidthMm - 10, yMm: 10 };
  const last = boxes[boxes.length - 1];
  // Left of the newest part; when that would run off the bed (allowing ~50 mm for the new part),
  // start a new row under everything, back at the right-hand side.
  if (last[0] - 10 - 50 >= 0) return { xMm: round(last[0] - 10), yMm: round(last[1]) };
  return { xMm: machine.bedWidthMm - 10, yMm: round(Math.max(...boxes.map((b) => b[3])) + 10) };
}

function addPart(source: Source, at?: { xMm: number; yMm: number }): void {
  if (parts.length >= MAX_PARTS) {
    notes = [`That's the most parts one design can have (${MAX_PARTS}).`];
    render();
    return;
  }
  const p: DesignPart = { id: nextId++, source, ...(at ?? newSpot()), scale: 1, rotateDeg: 0 };
  parts.push(p);
  select(p.id);
  changed();
}

/** Every part the next action applies to: the group, or the one selected part. */
function selection(): number[] {
  return group.length ? group : selected !== null ? [selected] : [];
}

function deleteSelected(): void {
  const ids = selection();
  if (!ids.length) return;
  parts = parts.filter((p) => !ids.includes(p.id));
  ids.forEach(dropLocal);
  select(null);
  changed();
}

function selectAll(): void {
  if (parts.length === 1) return select(parts[0].id);
  if (!parts.length) return;
  setGroup(parts.map((p) => p.id));
}

function toggleSelect(id: number): void {
  const now = new Set(selection());
  if (now.has(id)) now.delete(id);
  else now.add(id);
  const ids = parts.map((p) => p.id).filter((x) => now.has(x));
  if (ids.length <= 1) select(ids[0] ?? null);
  else setGroup(ids);
}

function setGroup(ids: number[]): void {
  selected = null;
  group = ids;
  const ops = new Set(ids.map((id) => opOf(find(id))).filter((o): o is OpKind => !!o));
  if (ops.size === 1 && !ops.has(color)) {
    color = [...ops][0];
    renderPalette();
  }
  ws.setSelected(null);
  ws.setGroup(ids);
  render();
}

function moveParts(ids: number[], dx: number, dy: number): void {
  for (const id of ids) {
    const p = find(id);
    if (!p) continue;
    p.xMm = round(p.xMm + dx);
    p.yMm = round(p.yMm + dy);
    shiftResult(id, dx, dy); // exact, so the part never jumps back while the server works
  }
  ws.clearLive();
  changed();
}

/** Each part's box is mapped from the old selection box onto the new one, so a group keeps its
 *  spacing in proportion. One Undo step for the lot. */
function resizeParts(ids: number[], fx: number, fy: number, from: Box, to: Box): void {
  const kx = (to[2] - to[0]) / Math.max(from[2] - from[0], 1e-6);
  const ky = (to[3] - to[1]) / Math.max(from[3] - from[1], 1e-6);
  const moves = ids.map((id) => ({ p: find(id), b: boxOf(id), server: hasServerView(id) }));
  for (const { p, b } of moves) {
    if (!p || !b) continue;
    const nb: Box = [to[0] + (b[0] - from[0]) * kx, to[1] + (b[1] - from[1]) * ky, to[0] + (b[2] - from[0]) * kx, to[1] + (b[3] - from[1]) * ky];
    resizePart(p, fx, fy, nb, false);
  }
  changed();
  // Browser-drawn parts are already redrawn at their new size; if every part is server-drawn, the
  // live stretch stays on screen until the new geometry arrives.
  if (moves.some((m) => !m.server)) ws.clearLive();
}

/** A typed width (axis 0) or height (axis 1) in mm for the selection. The lock keeps the shape;
 *  `both` sets width and height to v (a circle's diameter). A group keeps its top-right corner. */
function typeSize(axis: 0 | 1, v: number, both = false): void {
  if (!(v > 0)) return;
  const p = find(selected);
  if (p) {
    const b = boxOf(p.id);
    if (!b) return;
    const [w, h] = [b[2] - b[0], b[3] - b[1]];
    if (both) {
      if (w > 0 && h > 0) resizePart(p, v / w, v / h);
      return;
    }
    const cur = axis === 0 ? w : h;
    if (cur <= 0) return;
    const f = v / cur;
    if (locked) resizePart(p, f, f);
    else resizePart(p, axis === 0 ? f : 1, axis === 1 ? f : 1);
    return;
  }
  const from = unionBox(group.map(boxOf));
  if (!from) return;
  const cur = axis === 0 ? from[2] - from[0] : from[3] - from[1];
  if (cur <= 0) return;
  const f = v / cur;
  const [fx, fy] = locked ? [f, f] : axis === 0 ? [f, 1] : [1, f];
  const W = (from[2] - from[0]) * fx;
  const H = (from[3] - from[1]) * fy;
  resizeParts([...group], fx, fy, from, [from[2] - W, from[1], from[2], from[1] + H]);
}

/** fx/fy are along the screen's axes. `to` (from a handle drag) is the new box, so the part's
 *  top-right anchor follows whichever side stayed put. */
function resizePart(p: DesignPart, fx: number, fy: number, to?: Box, commit = true): void {
  const turned = p.rotateDeg === 90 || p.rotateDeg === 270;
  const [px, py] = turned ? [fy, fx] : [fx, fy]; // the part's own width/height factors
  const s = p.source;
  if (s.kind === 'shape' || s.kind === 'path') {
    // a flat line stays flat (0 mm tall), it just gets longer
    s.wMm = s.wMm < 0.05 ? s.wMm : clamp(round(s.wMm * px), 0.5, 900);
    s.hMm = s.hMm < 0.05 ? s.hMm : clamp(round(s.hMm * py), 0.5, 900);
  } else {
    setScale(p, (p.scale) * px, (p.scaleY ?? p.scale) * py);
  }
  if (to) {
    p.xMm = round(to[2]);
    p.yMm = round(to[1]);
  }
  if (commit) changed();
}

/** Width and height scale for files and text; scaleY is only kept while the part is stretched. */
function setScale(p: DesignPart, sx: number, sy: number): void {
  p.scale = clamp(sx, 0.01, 20);
  const y = clamp(sy, 0.01, 20);
  if (Math.abs(y - p.scale) < 1e-6) delete p.scaleY;
  else p.scaleY = y;
}

function hasServerView(id: number): boolean {
  const i = resultIds.indexOf(id);
  return i >= 0 && !!result?.partBoxes[i];
}

async function readFile(f: File): Promise<Source | null> {
  const used = parts.reduce((n, p) => n + (p.source.kind === 'file' ? p.source.data.length : 0), 0);
  if (f.size + used > MAX_UPLOAD_BYTES) {
    notes = ['That file is too big (10 MB max for the whole design).'];
    render();
    return null;
  }
  const name = f.name.toLowerCase();
  if (!name.endsWith('.svg') && !name.endsWith('.dxf')) {
    notes = ['Pick an SVG or DXF file.'];
    render();
    return null;
  }
  return { kind: 'file', name: f.name, fileType: name.endsWith('.dxf') ? 'dxf' : 'svg', data: await f.text() };
}

$('open').onclick = () => {
  if (parts.length && !confirm('Start over with a new file? This clears everything on the workspace.')) return;
  $<HTMLInputElement>('openFile').click();
};
$('import').onclick = () => $<HTMLInputElement>('importFile').click();

$<HTMLInputElement>('openFile').onchange = async (ev) => {
  const input = ev.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  const src = await readFile(f);
  if (!src) return;
  parts = [];
  colorMap = {};
  result = null;
  resultIds = [];
  addPart(src);
};
$<HTMLInputElement>('importFile').onchange = async (ev) => {
  const input = ev.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  const src = await readFile(f);
  if (src) addPart(src);
};

$('toolText').onclick = () => {
  const font = ($<HTMLSelectElement>('textFont').value || 'sans') as TextFontId;
  addPart({ kind: 'text', text: { value: 'Your name', font, heightMm: 20, op: color } });
  const t = $<HTMLInputElement>('textValue');
  t.focus();
  t.select();
};
$('toolBox').onclick = () => addPart({ kind: 'shape', shape: 'box', wMm: 50, hMm: 30, op: color });
$('toolCircle').onclick = () => addPart({ kind: 'shape', shape: 'circle', wMm: 40, hMm: 40, op: color });
$('toolSelect').onclick = () => setTool('select');
$('toolLine').onclick = () => setTool('line');
$('toolCurve').onclick = () => setTool('curve');

function setTool(t: 'select' | 'line' | 'curve'): void {
  ws.setTool(t);
  for (const [id, name] of [['toolSelect', 'select'], ['toolLine', 'line'], ['toolCurve', 'curve']] as const) $(id).classList.toggle('on', name === t);
  if (t === 'line') hint.textContent = 'Line: click two points, or drag. Hold Shift for straight and 45° lines. Esc cancels.';
  if (t === 'curve') hint.textContent = 'Curve: click points along the curve. Click the first point to close it, or double-click / press Enter to finish. Esc cancels.';
}

// ---------- shapes library ----------

$('toolShapes').onclick = () => {
  renderLibrary();
  $('libraryDlg').hidden = false;
};
$('libClose').onclick = () => { $('libraryDlg').hidden = true; };

let libraryBuilt = false;
function renderLibrary(): void {
  if (libraryBuilt) return;
  libraryBuilt = true;
  const groups = new Map<string, PathShape[]>();
  for (const sh of LIBRARY) groups.set(sh.group ?? 'Shapes', [...(groups.get(sh.group ?? 'Shapes') ?? []), sh]);
  const NS = 'http://www.w3.org/2000/svg';
  $('libGrid').replaceChildren(...[...groups].flatMap(([name, list]) => {
    const h = document.createElement('h3');
    h.textContent = name;
    const grid = document.createElement('div');
    grid.className = 'libgrid';
    grid.append(...list.map((sh) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'libitem';
      const vb = pathBBox(sh.d);
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', `${vb.x - 4} ${vb.y - 4} ${vb.w + 8} ${vb.h + 8}`);
      for (const [d, cls] of [[sh.d, 'o'], [sh.detail ?? '', 'dl']] as const) {
        if (!d) continue;
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', d);
        path.setAttribute('class', cls);
        svg.append(path);
      }
      const label = document.createElement('span');
      label.textContent = sh.label;
      b.append(svg, label);
      b.onclick = () => insertLibrary(sh);
      return b;
    }));
    return [h, grid];
  }));
}

/** Add a library shape 40 mm on its long side. Inside lines come in as a Mark part, selected with it. */
function insertLibrary(sh: PathShape): void {
  $('libraryDlg').hidden = true;
  const vb = pathBBox(sh.d);
  const k = 40 / Math.max(vb.w, vb.h);
  const spot = newSpot();
  const x0 = spot.xMm - vb.w * k;
  const y0 = spot.yMm;
  const outline: Source = { kind: 'path', name: sh.label, d: sh.d, vb, closed: sh.closed, wMm: round(vb.w * k), hMm: round(vb.h * k), op: color };
  if (!sh.detail) return addPart(outline, spot);
  if (parts.length + 2 > MAX_PARTS) return addPart(outline, spot);
  const dvb = pathBBox(sh.detail);
  const a: DesignPart = { id: nextId++, source: outline, ...spot, scale: 1, rotateDeg: 0 };
  const b: DesignPart = {
    id: nextId++,
    source: { kind: 'path', name: `${sh.label} lines`, d: sh.detail, vb: dvb, closed: false, wMm: round(dvb.w * k), hMm: round(dvb.h * k), op: 'score' },
    xMm: round(x0 + (dvb.x + dvb.w - vb.x) * k), yMm: round(y0 + (dvb.y - vb.y) * k), scale: 1, rotateDeg: 0,
  };
  parts.push(a, b);
  notes = [`${sh.label}: the inside lines are a separate Mark part, so cutting the outline won’t cut along them. Both are selected, so they move together.`];
  changed();
  setGroup([a.id, b.id]);
}

// ---------- help ----------

$('help').onclick = () => { $('helpDlg').hidden = false; };
$('helpClose').onclick = () => { $('helpDlg').hidden = true; };

$('rotate').onclick = () => {
  const p = find(selected);
  if (!p) return;
  p.rotateDeg = ((p.rotateDeg + 90) % 360) as Placement['rotateDeg'];
  changed();
};
$('delete').onclick = deleteSelected;
$('selectAll').onclick = selectAll;
$('zoomIn').onclick = () => ws.zoomBy(1.3);
$('zoomOut').onclick = () => ws.zoomBy(1 / 1.3);
$('zoomBed').onclick = () => ws.fit();
$('zoomDesign').onclick = () => {
  const b = unionBox(parts.map((p) => viewOf(p).box));
  if (b) {
    const [x0, y0, x1, y1] = b;
    ws.zoomTo([x0 - 10, y0 - 10, x1 + 10, y1 + 10]);
  }
};

function select(id: number | null): void {
  selected = id;
  if (group.length) {
    group = [];
    ws.setGroup([]);
  }
  const op = opOf(find(id));
  if (op && op !== color) {
    color = op; // the palette shows the selected part's colour
    renderPalette();
  }
  ws.setSelected(id);
  renderSizebar();
}

/** The colour of a text, shape or line (files carry their own colours). */
function opOf(p: DesignPart | undefined): OpKind | null {
  const s = p?.source;
  return s?.kind === 'text' ? s.text.op : s?.kind === 'shape' || s?.kind === 'path' ? s.op : null;
}

// ---------- size bar ----------

const fontSel = $<HTMLSelectElement>('textFont');
for (const f of TEXT_FONTS) {
  const o = new Option(f.label, f.id);
  o.style.fontFamily = f.css;
  fontSel.add(o);
}

function renderSizebar(): void {
  const p = find(selected);
  const gb = !p && group.length ? unionBox(group.map(boxOf)) : null;
  $('selControls').hidden = !p && !gb;
  $('selName').textContent = p ? partName(p)
    : group.length ? `${group.length} parts selected:`
      : parts.length ? 'Nothing selected. Click a part to select it. Ctrl+A selects everything.' : '';
  $('xyBox').dataset.hint = relative()
    ? "Where the middle of the part sits. 0, 0 is the bed's top-right corner. Your job starts at the laser head, so this only spaces parts apart."
    : "Where the middle of the part sits. 0, 0 is the bed's top-right corner.";
  const t = p?.source.kind === 'text' ? p.source.text : null;
  $('textControls').hidden = !t;
  $('fontTip').textContent = t ? TEXT_FONTS.find((f) => f.id === t.font)?.tip ?? '' : '';
  const isLine = p?.source.kind === 'path' && p.source.name === 'Line';
  ws.setDimMode(isLine ? 'line' : p?.source.kind === 'shape' && p.source.shape === 'circle' ? 'circle' : 'box');
  $('lenField').hidden = !isLine;
  $('angField').hidden = !isLine;
  renderLock();
  if (gb) {
    // a group: the box around all of it. Typing a size scales the lot; X/Y moves it.
    setIfIdle('selX', toU(flipX((gb[0] + gb[2]) / 2)));
    setIfIdle('selY', toU(flipY((gb[1] + gb[3]) / 2)));
    setIfIdle('selW', toU(gb[2] - gb[0]));
    setIfIdle('selH', toU(gb[3] - gb[1]));
    $('pctBox').hidden = true;
    return;
  }
  if (!p) return;
  const b = boxOf(p.id);
  setIfIdle('selX', toU(flipX(b ? (b[0] + b[2]) / 2 : p.xMm)));
  setIfIdle('selY', toU(flipY(b ? (b[1] + b[3]) / 2 : p.yMm)));
  setIfIdle('selW', b ? toU(b[2] - b[0]) : '');
  setIfIdle('selH', b ? toU(b[3] - b[1]) : '');
  if (isLine) {
    const [a, b2] = lineEnds(p);
    setIfIdle('selLen', toU(Math.hypot(b2[0] - a[0], b2[1] - a[1])));
    setIfIdle('selAng', cadAngle(a, b2));
  }
  // Percent sizing is for files and text; boxes and circles are sized in mm.
  $('pctBox').hidden = p.source.kind === 'shape' || p.source.kind === 'path';
  const stretched = p.scaleY !== undefined;
  $('pctY').hidden = !stretched && locked;
  setIfIdle('selPct', round(p.scale * 100, 1));
  setIfIdle('selPctY', round((p.scaleY ?? p.scale) * 100, 1));
  if (t) {
    setIfIdle('textValue', t.value);
    setIfIdle('textH', toU(t.heightMm * (p.scaleY ?? p.scale)));
    fontSel.value = t.font;
    fontSel.style.fontFamily = TEXT_FONTS.find((f) => f.id === t.font)?.css ?? '';
  }
}

function renderLock(): void {
  const lockBtn = $('lock');
  lockBtn.textContent = locked ? '🔒' : '🔓';
  lockBtn.setAttribute('aria-pressed', String(locked));
  lockBtn.title = locked ? 'Size is locked: corners and typed sizes keep the shape.' : 'Size is unlocked: corners and typed sizes stretch.';
}

function partName(p: DesignPart): string {
  const s = p.source;
  if (s.kind === 'file') return s.name;
  if (s.kind === 'text') return `Text (${OP_LABELS[s.text.op]})`;
  if (s.kind === 'path') return `${s.name} (${OP_LABELS[s.op]})`;
  return `${s.shape === 'box' ? 'Box' : 'Circle'} (${OP_LABELS[s.op]})`;
}

function setIfIdle(id: string, v: string | number): void {
  const el = $<HTMLInputElement>(id);
  if (document.activeElement !== el) el.value = String(v);
}

function numIn(id: string): number | null {
  const v = Number($<HTMLInputElement>(id).value);
  return Number.isFinite(v) && $<HTMLInputElement>(id).value !== '' ? v : null;
}

// X/Y is the centre of one part, or of the box around a group, measured from the home corner.
for (const [id, axis] of [['selX', 0], ['selY', 1]] as const) {
  $(id).addEventListener('change', () => {
    const typed = numIn(id);
    if (typed === null) return;
    const v = round(axis === 0 ? flipX(fromU(typed)) : flipY(fromU(typed)));
    const p = find(selected);
    const ids = p ? [p.id] : [...group];
    const b = p ? boxOf(p.id) : unionBox(group.map(boxOf));
    if (!b) {
      if (!p) return;
      if (axis === 0) p.xMm = v; // nothing drawn yet: fall back to the placement corner
      else p.yMm = v;
      changed();
      return;
    }
    const c = axis === 0 ? (b[0] + b[2]) / 2 : (b[1] + b[3]) / 2;
    moveParts(ids, axis === 0 ? v - c : 0, axis === 1 ? v - c : 0);
  });
}
// A selected Line: typing a Length or an Angle keeps its first point where it is.
$('selLen').addEventListener('change', () => {
  const v = numIn('selLen');
  if (v !== null) setLineLength(fromU(v));
});

function setLineLength(mm: number): void {
  const p = find(selected);
  if (!p || p.source.kind !== 'path' || !(mm > 0)) return;
  const [a, b] = lineEnds(p);
  const ang = (cadAngle(a, b) * Math.PI) / 180;
  setLineEnds(p, a, [a[0] + mm * Math.cos(ang), a[1] - mm * Math.sin(ang)]);
}
$('selAng').addEventListener('change', () => {
  const p = find(selected);
  const v = numIn('selAng');
  if (!p || p.source.kind !== 'path' || v === null) return;
  const [a, b] = lineEnds(p);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ang = (v * Math.PI) / 180;
  setLineEnds(p, a, [a[0] + len * Math.cos(ang), a[1] - len * Math.sin(ang)]);
});

/** A Line part's two ends in bed mm (after its size and any quarter turn). */
function lineEnds(p: DesignPart): [[number, number], [number, number]] {
  const s = p.source;
  if (s.kind !== 'path') return [[0, 0], [0, 0]];
  const n = (s.d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  const kx = s.vb.w > 1e-6 ? s.wMm / s.vb.w : 1;
  const ky = s.vb.h > 1e-6 ? s.hMm / s.vb.h : 1;
  const W = s.wMm;
  const H = s.hMm;
  const turned = p.rotateDeg === 90 || p.rotateDeg === 270;
  const left = p.xMm - (turned ? H : W);
  const map = (x: number, y: number): [number, number] => {
    let lx = (x - s.vb.x) * kx;
    let ly = (y - s.vb.y) * ky;
    if (p.rotateDeg === 90) [lx, ly] = [H - ly, lx]; // same turns as the server's transform.place
    else if (p.rotateDeg === 180) [lx, ly] = [W - lx, H - ly];
    else if (p.rotateDeg === 270) [lx, ly] = [ly, W - lx];
    return [left + lx, p.yMm + ly];
  };
  return [map(n[0] ?? 0, n[1] ?? 0), map(n[2] ?? 0, n[3] ?? 0)];
}

/** Rebuild a Line from two bed points. */
function setLineEnds(p: DesignPart, a: [number, number], b: [number, number]): void {
  if (p.source.kind !== 'path') return;
  const d = lineD(a, b);
  const vb = { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
  Object.assign(p.source, { d, vb, wMm: vb.w, hMm: vb.h });
  p.xMm = round(vb.x + vb.w);
  p.yMm = round(vb.y);
  p.rotateDeg = 0;
  p.scale = 1;
  delete p.scaleY;
  changed();
}
for (const [id, axis] of [['selW', 0], ['selH', 1]] as const) {
  $(id).addEventListener('change', () => {
    const typed = numIn(id);
    if (typed !== null) typeSize(axis, fromU(typed));
  });
}

// ---------- size labels on the bed (click one, type a new size) ----------

const dimEdit = $<HTMLInputElement>('dimEdit');
let dimWhich: Dim | null = null;

function openDimEdit(which: Dim, at: { x: number; y: number }, mm: number): void {
  dimWhich = which;
  const c = $('ws');
  const box = $('dimBox');
  // centred on the label, but kept inside the bed area so it never hangs off a small screen
  box.style.left = `${c.offsetLeft + clamp(at.x, 100, Math.max(c.clientWidth - 100, 100))}px`;
  box.style.top = `${c.offsetTop + clamp(at.y, 40, Math.max(c.clientHeight - 40, 40))}px`;
  $('dimLabel').textContent = which === 'd' ? 'Diameter' : which === 'len' ? 'Length' : which === 'w' ? 'Width' : 'Height';
  box.hidden = false;
  dimEdit.value = String(toU(mm));
  dimEdit.focus();
  dimEdit.select();
}

function closeDimEdit(apply: boolean): void {
  const which = dimWhich;
  dimWhich = null;
  $('dimBox').hidden = true;
  const v = Number(dimEdit.value);
  if (!apply || !which || dimEdit.value.trim() === '' || !Number.isFinite(v) || v <= 0) return;
  const mm = fromU(v);
  if (which === 'len') setLineLength(mm);
  else typeSize(which === 'h' ? 1 : 0, mm, which === 'd');
}

dimEdit.addEventListener('keydown', (e) => {
  e.stopPropagation(); // Esc here cancels the edit; it must not unselect
  if (e.key === 'Enter') { e.preventDefault(); closeDimEdit(true); }
  if (e.key === 'Escape') { e.preventDefault(); closeDimEdit(false); }
});
dimEdit.addEventListener('blur', () => { if (dimWhich) closeDimEdit(true); });
$('lock').onclick = () => {
  locked = !locked;
  save();
  renderSizebar();
};
$('selPct').addEventListener('change', () => {
  const p = find(selected);
  const v = numIn('selPct');
  if (!p || p.source.kind === 'shape' || p.source.kind === 'path' || v === null || v <= 0) return;
  const k = v / 100;
  if (locked || p.scaleY === undefined) setScale(p, k, locked ? k : (p.scaleY ?? p.scale));
  else setScale(p, k, p.scaleY);
  changed();
});
$('selPctY').addEventListener('change', () => {
  const p = find(selected);
  const v = numIn('selPctY');
  if (!p || p.source.kind === 'shape' || p.source.kind === 'path' || v === null || v <= 0) return;
  setScale(p, locked ? v / 100 : p.scale, v / 100);
  changed();
});
$('textValue').addEventListener('input', () => {
  const p = find(selected);
  if (p?.source.kind === 'text') { p.source.text.value = $<HTMLInputElement>('textValue').value.slice(0, 60); changed({ merge: `text${p.id}` }); }
});
$('textH').addEventListener('change', () => {
  const p = find(selected);
  const typed = numIn('textH');
  const v = typed === null ? null : fromU(typed);
  if (p?.source.kind === 'text' && v !== null) {
    // Letters is the height you see. Typing it sets the base size and keeps any stretch.
    const ratio = p.scale / (p.scaleY ?? p.scale);
    p.source.text.heightMm = clamp(v, 3, 150);
    setScale(p, ratio, 1);
    changed();
  }
});
fontSel.addEventListener('change', () => {
  const p = find(selected);
  if (p?.source.kind === 'text') { p.source.text.font = fontSel.value as TextFontId; changed(); }
});

// ---------- units ----------

$<HTMLSelectElement>('units').onchange = (ev) => {
  const next = (ev.target as HTMLSelectElement).value as Unit;
  // keep the pattern spacing the same distance
  for (const id of ['patGapX', 'patGapY']) {
    const v = numIn(id);
    if (v !== null) $<HTMLInputElement>(id).value = String(round((v * UNIT_MM[unit]) / UNIT_MM[next], UNIT_DIGITS[next]));
  }
  unit = next;
  applyUnits();
  save();
  render();
};

function applyUnits(): void {
  $<HTMLSelectElement>('units').value = unit;
  document.querySelectorAll('.u').forEach((el) => { el.textContent = unit; });
  $('lenUnit').textContent = unit;
  ws.setUnits(UNIT_MM[unit], unit);
  renderMaterials();
}

// ---------- typed lengths while drawing ----------

const lenInput = $<HTMLInputElement>('lenInput');
const angInput = $<HTMLInputElement>('angInput');

/** Open the Length / Angle box: a digit starts the length, Tab starts at the angle. */
function openLength(first: string, field: 'len' | 'ang' = 'len'): void {
  $('lenBox').hidden = false;
  lenInput.value = field === 'len' ? first : '';
  angInput.value = field === 'ang' ? first : '';
  (field === 'len' ? lenInput : angInput).focus();
}
function closeLength(): void {
  $('lenBox').hidden = true;
  lenInput.blur();
  angInput.blur();
}
for (const input of [lenInput, angInput]) {
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') return closeLength();
    if (e.key === 'Tab') { // Tab flips between Length and Angle, like AutoCAD's dynamic input
      e.preventDefault();
      const other = input === lenInput ? angInput : lenInput;
      other.focus();
      other.select();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // Length: "50", or the short form "50<45". Angle: 0 = right, 90 = up. Blank length = to the pointer.
    const m = /^\s*(\d*\.?\d+)?\s*(?:<\s*(-?\d*\.?\d+))?\s*$/.exec(lenInput.value);
    const angText = angInput.value.trim();
    const angle = angText !== '' ? Number(angText) : m?.[2] !== undefined ? Number(m[2]) : null;
    const len = m?.[1] !== undefined ? fromU(Number(m[1])) : angle !== null ? ws.pointerLength() : 0;
    if (!m || !(len > 0) || (angle !== null && !Number.isFinite(angle))) {
      (m && angle !== null && !Number.isFinite(angle) ? angInput : lenInput).select();
      return;
    }
    closeLength();
    ws.typedPoint(len, angle);
  });
}

// ---------- palette ----------

function renderPalette(): void {
  renderLayers();
  $('palette').replaceChildren(...RUN_ORDER.slice().reverse().map((op) => {
    const b = document.createElement('button');
    b.className = 'swatchbtn' + (op === color ? ' on' : '');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(op === color));
    b.dataset.hint = `${OP_LABELS[op]}: new text and shapes use this. Click it with a text or shape selected to change it.`;
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = OP_COLORS[op];
    b.append(sw, OP_LABELS[op]);
    b.onclick = () => applyColor(op);
    return b;
  }));
}

/** Pick a colour: new parts use it, and the selected text, shapes and lines change to it. */
function applyColor(op: OpKind): void {
  color = op;
  let recoloured = false;
  let took = false; // at least one part really is `op` now
  let fellBack = false; // an open line that can't be engraved went to Mark instead
  for (const id of selection()) {
    const q = find(id);
    if (q?.source.kind === 'text') { q.source.text.op = op; recoloured = took = true; }
    else if (q?.source.kind === 'shape') { q.source.op = op; recoloured = took = true; }
    else if (q?.source.kind === 'path') {
      q.source.op = op === 'engrave' && !q.source.closed ? 'score' : op;
      if (q.source.op !== op) fellBack = true;
      else took = true;
      recoloured = true;
    }
    else if (q?.source.kind === 'file') notes = ['Colours in a file come from the file itself: black cuts, red marks, blue engraves.'];
  }
  if (fellBack) {
    if (!took) color = 'score'; // nothing could take Engrave, so the palette shows what it really is
    warn(took
      ? 'Some of these are open lines. Open lines can’t be engraved (filled), so they stay Mark (red).'
      : 'Open lines can’t be engraved (filled), so this stays Mark (red). Close a curve by clicking its first point.');
  }
  renderPalette();
  if (recoloured) changed();
  else render();
}

// ---------- materials and layers ----------

/** Material buttons in two places: the Layers panel and the bottom colour bar. */
function renderMaterials(): void {
  const make = (m: PublicMaterial, cls: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls + (m.id === materialId ? ' on' : '');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(m.id === materialId));
    b.dataset.hint = `Laser ${m.name}. Your teacher set up the power and speed for it.`;
    const name = document.createElement('b');
    name.textContent = m.name;
    const thick = document.createElement('span');
    thick.textContent = `${toU(m.thicknessMm)} ${unit}`;
    b.append(name, ' ', thick);
    b.onclick = () => pickMaterial(m.id);
    return b;
  };
  const list = $('materialList');
  list.replaceChildren(...materials.map((m) => make(m, 'matbtn')));
  if (!materials.length) list.textContent = 'No materials yet. Ask your teacher.';
  $('matChips').replaceChildren(...(materials.length ? [Object.assign(document.createElement('span'), { className: 'matlabel', textContent: 'Material' })] : []),
    ...materials.map((m) => make(m, 'matchip')));
}

function pickMaterial(id: string): void {
  if (id === materialId) return;
  materialId = id;
  powerChoice = {};
  renderMaterials();
  changed({ history: false });
}

function renderLayers(): void {
  const mat = materials.find((m) => m.id === materialId);
  // server layers (files), plus what the browser already knows about its own text, shapes and lines
  const inDesign = new Set<OpKind>(result?.preview.map((l) => l.kind) ?? []);
  for (const q of parts) {
    if (q.source.kind === 'text') inDesign.add(q.source.text.op);
    else if (q.source.kind === 'shape' || q.source.kind === 'path') inDesign.add(q.source.op);
  }
  $('layers').replaceChildren(...RUN_ORDER.map((op) => {
    const li = document.createElement('li');
    li.className = 'layer' + (inDesign.has(op) ? '' : ' unused');
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = OP_COLORS[op];
    const name = document.createElement('b');
    name.textContent = OP_LABELS[op];
    const state = document.createElement('span');
    state.className = 'muted small';
    state.textContent = mat && !mat.ops.includes(op) ? `not allowed on ${mat.name}` : inDesign.has(op) ? '' : 'not in design';
    // the whole row is a colour button, same as the bottom bar
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'layerpick' + (op === color ? ' on' : '');
    pick.dataset.hint = `Make the selected text, shapes and lines ${OP_LABELS[op]}. New ones will use it too.`;
    const words = document.createElement('span');
    words.className = 'words';
    words.append(name, state);
    pick.append(sw, words);
    pick.onclick = () => applyColor(op);
    li.append(pick);
    const r = mat?.adjustable[op];
    if (r && mat?.ops.includes(op)) {
      const value = powerChoice[op] ?? r.defaultPct;
      const row = document.createElement('label');
      row.className = 'power';
      row.dataset.hint = 'How deep the engraving goes (laser power). Your teacher set the range.';
      const slider = Object.assign(document.createElement('input'), {
        type: 'range', min: String(r.minPct), max: String(r.maxPct), step: '1', value: String(value),
      });
      const out = document.createElement('output');
      out.textContent = `${value}%`;
      slider.oninput = () => { out.textContent = `${slider.value}%`; };
      slider.onchange = () => { powerChoice[op] = Number(slider.value); changed({ history: false }); };
      row.append('Depth / power', slider, out);
      li.append(row);
    }
    return li;
  }));
}

function renderColors(): void {
  const keys = result?.unknownColors ?? [];
  $('colors').hidden = !keys.length;
  const ops = materials.find((m) => m.id === materialId)?.ops ?? RUN_ORDER;
  $('colorList').replaceChildren(...keys.map((key) => {
    const row = document.createElement('div');
    row.className = 'colorrow';
    const [kind, value] = key.split(/:(.*)/s);
    const sw = document.createElement('span');
    sw.className = 'swatch';
    if (value?.startsWith('#')) sw.style.background = value;
    const label = document.createElement('span');
    label.textContent = kind === 'dxf' ? `Layer "${value}"` : `${kind === 'fill' ? 'Filled' : 'Lines'} ${value}`;
    row.append(sw, label);
    for (const choice of [...ops, 'ignore'] as ColorChoice[]) {
      const btn = document.createElement('button');
      btn.className = 'small';
      btn.textContent = choice === 'ignore' ? 'Skip' : OP_LABELS[choice];
      btn.onclick = () => { colorMap[key] = choice; changed(); };
      row.append(btn);
    }
    return row;
  }));
}

// ---------- processing (debounced round-trip to the container) ----------

let timer = 0;
let seq = 0;

/** Something about the design changed: remember it for Undo, save it, redraw, and re-process soon.
 *  `merge` folds quick repeats (typing, nudging) into one Undo step. */
function changed(opts: { merge?: string; history?: boolean } = {}): void {
  if (opts.history !== false) record(opts.merge);
  save();
  schedule();
  render();
}

// ---------- undo / redo ----------

interface Snap { parts: DesignPart[]; colorMap: Record<string, ColorChoice> }
const undoStack: Snap[] = [];
let redoStack: Snap[] = [];
let lastSnap: Snap = { parts: [], colorMap: {} };
let lastMerge = '';
let lastAt = 0;

function cloneParts(ps: DesignPart[]): DesignPart[] {
  // File data strings are shared, not copied, so history stays cheap.
  return ps.map((q) => ({ ...q, source: q.source.kind === 'text' ? { ...q.source, text: { ...q.source.text } } : { ...q.source } }));
}

function snap(): Snap {
  return { parts: cloneParts(parts), colorMap: { ...colorMap } };
}

function record(merge?: string): void {
  const now = Date.now();
  if (!(merge && merge === lastMerge && now - lastAt < 1200)) {
    undoStack.push(lastSnap);
    if (undoStack.length > 100) undoStack.shift();
  }
  redoStack = [];
  lastSnap = snap();
  lastMerge = merge ?? '';
  lastAt = now;
  renderHistoryButtons();
}

function applySnap(s: Snap): void {
  parts = cloneParts(s.parts);
  colorMap = { ...s.colorMap };
  lastSnap = snap();
  lastMerge = '';
  nextId = Math.max(nextId, ...parts.map((q) => q.id + 1));
  if (!find(selected)) selected = null;
  group = group.filter((id) => find(id));
  if (group.length < 2) group = [];
  ws.setGroup(group);
  result = null; // the old preview no longer matches; the browser draws parts until the server answers
  resultIds = [];
  ws.clearLive();
  ws.setSelected(selected);
  save();
  schedule();
  render();
  renderHistoryButtons();
}

function undo(): void {
  const s = undoStack.pop();
  if (!s) return;
  redoStack.push(snap());
  applySnap(s);
}

function redo(): void {
  const s = redoStack.pop();
  if (!s) return;
  undoStack.push(snap());
  applySnap(s);
}

function renderHistoryButtons(): void {
  $<HTMLButtonElement>('undo').disabled = !undoStack.length;
  $<HTMLButtonElement>('redo').disabled = !redoStack.length;
}
$('undo').onclick = undo;
$('redo').onclick = redo;

// ---------- pattern tool ----------

$('toolPattern').onclick = () => {
  const p = find(selected);
  if (!p) {
    notes = ['Select a part first, then use Pattern to make copies of it.'];
    render();
    return;
  }
  updatePatternInfo();
  $('patternDlg').hidden = false;
  $<HTMLInputElement>('patCols').focus();
};
$('patCancel').onclick = () => { $('patternDlg').hidden = true; };
for (const id of ['patCols', 'patRows', 'patGapX', 'patGapY']) $(id).addEventListener('input', updatePatternInfo);

function patternValues(): { cols: number; rows: number; gx: number; gy: number } {
  const int = (id: string) => clamp(Math.round(numIn(id) ?? 1), 1, 20);
  return { cols: int('patCols'), rows: int('patRows'), gx: clamp(fromU(numIn('patGapX') ?? 0), -500, 500), gy: clamp(fromU(numIn('patGapY') ?? 0), -500, 500) };
}

function updatePatternInfo(): void {
  const { cols, rows } = patternValues();
  const copies = cols * rows - 1;
  const room = MAX_PARTS - parts.length;
  $('patInfo').textContent = copies > room
    ? `That's ${copies} copies, but there's only room for ${room} more parts (${MAX_PARTS} max).`
    : `${cols} × ${rows}: ${copies} ${copies === 1 ? 'copy' : 'copies'}, laid out to the left and down from the selected part.`;
}

$<HTMLFormElement>('patternForm').onsubmit = (ev) => {
  ev.preventDefault();
  const p = find(selected);
  const b = p && boxOf(p.id);
  if (!p || !b) return;
  const { cols, rows, gx, gy } = patternValues();
  if (cols * rows - 1 > MAX_PARTS - parts.length) return updatePatternInfo();
  const w = b[2] - b[0];
  const h = b[3] - b[1];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!r && !c) continue;
      const [copy] = cloneParts([p]);
      parts.push({ ...copy, id: nextId++, xMm: round(p.xMm - c * (w + gx)), yMm: round(p.yMm + r * (h + gy)) });
    }
  }
  $('patternDlg').hidden = true;
  changed();
};

function schedule(delay = 400): void {
  pending = true;
  clearTimeout(timer);
  timer = window.setTimeout(run, delay);
}

function buildRequest(): { req: ProcessRequest; files: Blob[]; ids: number[] } {
  const files: Blob[] = [];
  const ids: number[] = [];
  const reqParts: Part[] = [];
  const fileOf = new Map<string, number>();
  for (const p of parts) {
    const pl: Placement = { xMm: p.xMm, yMm: p.yMm, scale: p.scale, rotateDeg: p.rotateDeg };
    if (p.scaleY !== undefined) pl.scaleY = p.scaleY;
    const s = p.source;
    if (s.kind === 'text') {
      if (!s.text.value.trim()) continue;
      reqParts.push({ ...pl, kind: 'text', text: { ...s.text, value: s.text.value.trim() } });
    } else {
      const data = s.kind === 'file' ? s.data
        : s.kind === 'path' ? pathSvg(s.d, s.vb, s.wMm, s.hMm, s.op, s.closed)
          : shapeSvg(s.shape, s.wMm, s.hMm, s.op);
      let fileIndex = fileOf.get(data);
      if (fileIndex === undefined) { // pattern copies share one upload
        fileIndex = files.push(new Blob([data], { type: s.kind === 'file' && s.fileType === 'dxf' ? 'application/dxf' : 'image/svg+xml' })) - 1;
        fileOf.set(data, fileIndex);
      }
      if (s.kind === 'shape' || s.kind === 'path') { pl.scale = 1; delete pl.scaleY; }
      reqParts.push({ ...pl, kind: 'file', fileIndex, fileType: s.kind === 'file' ? s.fileType : 'svg' });
    }
    ids.push(p.id);
  }
  return { req: { materialId, parts: reqParts, colorMap, powerChoice }, files, ids };
}

async function run(): Promise<void> {
  const { req, files, ids } = buildRequest();
  if (!materialId || !req.parts.length) {
    result = null;
    resultIds = [];
    pending = false;
    ws.setBusy(false);
    render();
    return;
  }
  // The site works without the phrase. Only processing (the server's container) needs it.
  if (!getPhrase()) {
    pending = false;
    ws.setBusy(false);
    ws.clearLive();
    render();
    return;
  }
  const mine = ++seq;
  ws.setBusy(true);
  try {
    const res = await processDesign(req, files);
    if (mine !== seq) return; // a newer request superseded this one
    result = res;
    resultIds = ids;
    notes = [];
  } catch (e) {
    if (mine !== seq) return;
    result = null;
    resultIds = [];
    notes = [(e as Error).message];
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      setPhrase(''); // wrong or expired: the Laser panel shows the phrase button again
    }
  }
  pending = false;
  ws.setBusy(false);
  ws.clearLive();
  render();
}

function askPhrase(): void {
  $('gateErr').textContent = '';
  $('gate').hidden = false;
  $<HTMLInputElement>('phrase').focus();
}
$('phraseBtn').onclick = askPhrase;

$('gateLater').onclick = () => { $('gate').hidden = true; };

function shiftResult(id: number, dx: number, dy: number): void {
  const i = resultIds.indexOf(id);
  if (!result || i < 0) return;
  const b = result.partBoxes[i];
  if (b) result.partBoxes[i] = [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
  for (const l of result.preview) {
    if (l.part === i) l.paths = l.paths.map((path) => path.map(([x, y]) => [x + dx, y + dy] as [number, number]));
  }
  const boxes = result.partBoxes.filter((x): x is Box => !!x);
  result.bboxMm = boxes.length
    ? [Math.min(...boxes.map((x) => x[0])), Math.min(...boxes.map((x) => x[1])), Math.max(...boxes.map((x) => x[2])), Math.max(...boxes.map((x) => x[3]))]
    : null;
}

// ---------- rendering ----------

function render(): void {
  const views = parts.map(viewOf);
  ws.setParts(views, unionBox(views.map((v) => v.box)), !pending && !!result?.errors.length);
  $('phraseBtn').hidden = !!getPhrase();
  renderSizebar();
  renderLayers();
  renderColors();
  const errors = [...(result?.errors ?? [])];
  const warnings = [...(result?.warnings ?? [])];
  const li = (t: string, cls: string) => Object.assign(document.createElement('li'), { textContent: t, className: cls });
  $('messages').replaceChildren(...errors.map((e) => li(e, 'err')), ...notes.map((n) => li(n, 'note')), ...warnings.map((w) => li(w, 'warn')));
  $('estimate').textContent = result?.rd && !pending ? `About ${fmtTime(result.estimateS)} on the laser.` : '';
  $('rotate').toggleAttribute('disabled', selected === null);
  $('delete').toggleAttribute('disabled', !selection().length);
  $('selectAll').toggleAttribute('disabled', !parts.length);
  $('zoomDesign').toggleAttribute('disabled', !parts.length);
  updateButtons();
  defaultHint();
}

function fmtTime(s: number): string {
  return s < 90 ? `${Math.round(s)} seconds` : `${Math.round(s / 60)} minutes`;
}

// ---------- laser ----------

let pickerCancelled = false;

$('connect').onclick = async () => {
  if (link?.connected) {
    await link.disconnect();
    setConnected(false);
    return;
  }
  try {
    link = new LaserLink({ baud: machine.baud, magic: machine.swizzleMagic, onDisconnect: () => setConnected(false) });
    await link.connect(pickerCancelled);
    pickerCancelled = false;
    setConnected(true);
  } catch (e) {
    if ((e as Error).name === 'NotFoundError') {
      // Picker cancelled, maybe because the laser wasn't listed. Next click shows every port.
      if (!pickerCancelled) notes = ['Laser not in the list? Press Connect laser again to see every USB port.'];
      pickerCancelled = true;
    } else notes = [(e as Error).message];
    render();
  }
};

function setConnected(on: boolean): void {
  $('status').textContent = on ? 'Laser connected' : 'Laser not connected';
  $('status').classList.toggle('ok', on);
  $('connect').textContent = on ? 'Disconnect' : 'Connect laser';
  $('stop').hidden = !on;
  $('stopTop').hidden = !on;
  if (!on) framedRd = null;
  updateButtons();
}

function updateButtons(): void {
  const hasJob = !!result?.rd && !pending && !result.errors.length;
  const connected = !!link?.connected;
  const idle = !link?.sending;
  const framed = hasJob && framedRd === result!.rd;
  const ack = $<HTMLInputElement>('ack').checked;
  $<HTMLButtonElement>('frame').disabled = !(hasJob && connected && idle);
  const toPanel = !!machine.sendToPanel;
  $('panelNameRow').hidden = !toPanel;
  const nameBox = $<HTMLInputElement>('panelName');
  if (toPanel && !panelNameTyped && document.activeElement !== nameBox) nameBox.value = suggestedPanelName();
  const named = !toPanel || !!cleanPanelName(nameBox.value);
  $<HTMLButtonElement>('send').disabled = !(hasJob && connected && idle && framed && ack && named);
  const steps: [string, boolean][] = [
    ['Pick your material', !!materialId],
    ['Enter the class phrase', !!getPhrase()],
    ['Add a design with no problems', hasJob],
    ['Connect the laser', connected],
    ['Frame it and check it fits', framed],
    ['Promise to stay with the laser', ack],
  ];
  $('steps').replaceChildren(...steps.map(([t, done]) => Object.assign(document.createElement('li'), { textContent: t, className: done ? 'done' : '' })));
}
$<HTMLInputElement>('ack').onchange = updateButtons;

// "Send to panel" (teacher setting): the job is stored on the controller under this name.
let panelNameTyped = false;
$<HTMLInputElement>('panelName').oninput = () => {
  panelNameTyped = true;
  updateButtons();
};

/** First typed text, else the first file's name, else DESIGN. */
function suggestedPanelName(): string {
  for (const p of parts) if (p.source.kind === 'text' && cleanPanelName(p.source.text.value)) return cleanPanelName(p.source.text.value);
  for (const p of parts) if (p.source.kind === 'file' && cleanPanelName(p.source.name.replace(/\.[^.]*$/, ''))) return cleanPanelName(p.source.name.replace(/\.[^.]*$/, ''));
  return 'DESIGN';
}

async function sendBytes(b64: string, what: 'Frame' | 'Job'): Promise<boolean> {
  if (!link) return false;
  const panelName = what === 'Job' && machine.sendToPanel ? cleanPanelName($<HTMLInputElement>('panelName').value) : '';
  const prog = $<HTMLProgressElement>('progress');
  prog.hidden = false;
  prog.value = 0;
  updateButtons();
  try {
    const onProgress = (s: number, t: number) => { prog.value = s / t; };
    if (panelName) {
      const replaced = await link.sendToPanel(fromBase64(b64), panelName, onProgress);
      notes = [`Saved on the laser as ${panelName}${replaced ? ', replacing the old file with that name' : ''}. Start it from the laser's screen, and watch the laser the whole time.`];
    } else {
      await link.send(fromBase64(b64), onProgress);
      notes = [what === 'Frame' ? 'Frame sent. Watch the laser trace the box. Does it fit your material?' : 'Job sent. Watch the laser the whole time.'];
    }
    return true;
  } catch (e) {
    notes = [(e as Error).message];
    return false;
  } finally {
    prog.hidden = true;
    render();
  }
}

$('frame').onclick = async () => {
  if (!result?.frameRd || !result.rd) return;
  const rd = result.rd;
  if (await sendBytes(result.frameRd, 'Frame')) framedRd = rd;
  updateButtons();
};
$('send').onclick = async () => {
  if (!result?.rd) return;
  await sendBytes(result.rd, 'Job');
  $<HTMLInputElement>('ack').checked = false; // confirm again, and frame again, before the next piece
  framedRd = null;
  updateButtons();
};

async function stop(): Promise<void> {
  try {
    await link?.stop();
    notes = ['Stop sent.'];
  } catch {
    notes = ['Could not send STOP. Press the red E-stop button on the laser!'];
  }
  render();
}
$('stop').onclick = stop;
$('stopTop').onclick = stop;

// ---------- keyboard ----------

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && link?.connected) void stop(); // STOP first, always
  const t = e.target as HTMLElement;
  if (t.closest('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
    e.preventDefault();
    if (k === 'y' || e.shiftKey) redo();
    else undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k === 'a') {
    e.preventDefault();
    selectAll();
    return;
  }
  if (ws.drawing && ws.hasDraft && /^[0-9.]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    openLength(e.key);
    return;
  }
  if (ws.drawing && ws.hasDraft && e.key === 'Tab') {
    e.preventDefault();
    openLength('', 'ang');
    return;
  }
  if (ws.drawing && e.key === 'Enter') { e.preventDefault(); ws.finishDraft(); setTool('select'); return; }
  if (e.key === 'Escape') {
    // like AutoCAD: Esc ends the drawing and keeps what was drawn
    if (ws.drawing) { ws.finishDraft(); setTool('select'); return; }
    for (const id of ['helpDlg', 'libraryDlg', 'patternDlg']) $(id).hidden = true;
    select(null);
    return;
  }
  const ids = selection();
  if (!ids.length) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
  const step = e.shiftKey ? 10 : 1;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (d) {
    e.preventDefault();
    for (const id of ids) {
      const p = find(id)!;
      p.xMm = round(p.xMm + d[0]);
      p.yMm = round(p.yMm + d[1]);
      shiftResult(id, d[0], d[1]);
    }
    changed({ merge: `nudge${ids.join(',')}` });
  }
});

// ---------- warnings on the bed ----------

let toastTimer = 0;
/** A warning the student can't miss: on the bed for a few seconds, and in the Laser panel. */
function warn(text: string): void {
  notes = [text];
  const t = $('toast');
  t.textContent = `⚠ ${text}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, 6000);
}
$('toast').onclick = () => { $('toast').hidden = true; };

// ---------- hints ----------

const hint = $('hint');
let hovering = false;
document.addEventListener('mouseover', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-hint]');
  hovering = !!el;
  if (el) hint.textContent = el.dataset.hint!;
  else defaultHint();
});

function defaultHint(): void {
  if (hovering) return;
  hint.textContent = !materialId
    ? 'Start by picking your material on the right.'
    : !parts.length
      ? 'Open an SVG or DXF file, or use Text, Box or Circle on the left.'
      : !getPhrase()
        ? 'Arrange your design. When you are ready, enter the class phrase in the Laser panel to check it.'
        : 'Drag parts or the purple grip to move them. Scroll or pinch to zoom. Then connect the laser, Frame, and Send.';
}

// ---------- saving the design on this Chromebook ----------

function save(): void {
  try {
    localStorage.setItem(STORE, JSON.stringify({ parts, colorMap, materialId, color, locked, unit }));
  } catch {
    /* too big for storage: the design still works, it just won't survive a reload */
  }
}

function restore(): void {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (!s || !Array.isArray(s.parts)) return;
    parts = s.parts;
    colorMap = s.colorMap ?? {};
    materialId = s.materialId ?? '';
    if (s.color in OP_LABELS) color = s.color;
    if (s.locked === false) locked = false;
    if (s.unit === 'cm' || s.unit === 'in') unit = s.unit;
    nextId = Math.max(0, ...parts.map((p) => p.id)) + 1;
  } catch {
    parts = [];
  }
}

// ---------- helpers ----------

function round(v: number, places = 2): number {
  const k = 10 ** places;
  return Math.round(v * k) / k;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

initThemeButton($<HTMLButtonElement>('theme'));
void init();
