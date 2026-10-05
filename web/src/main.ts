// Student app, laid out like desktop laser software: toolbar, tools on the left, the bed in the middle,
// Layers and Laser panels on the right. Every part is processed by the server; the page only
// arranges parts, previews what comes back, and streams the finished job over USB.
import '@fontsource/anton/latin-400.css';
import '@fontsource/bungee/latin-400.css';
import '@fontsource/permanent-marker/latin-400.css';
import '@fontsource/pacifico/latin-400.css';
import '@fontsource/allerta-stencil/latin-400.css';
import type {
  ColorChoice, DxfUnits, OpKind, Part, PartExtras, Placement, ProcessRequest, ProcessResponse, PublicMaterial, TextFontId, TextSpec,
} from '../../shared/contracts';
import { DXF_UNITS, MAX_PARTS, MAX_UPLOAD_BYTES, TEXT_FONTS } from '../../shared/contracts';
import { ApiError, checkPhrase, convertDwg, getMachine, getMaterials, getPhrase, processDesign, setPhrase, type PublicMachine } from './api';
import { OP_COLORS, OP_LABELS, RUN_ORDER } from './ops';
import { cleanPanelName } from './ruida/panel';
import { fromBase64 } from './ruida/swizzle';
import { LaserLink, type PortId } from './serial/laser';
import { LIBRARY, lineD, pathBBox, smoothD, type PathShape } from './library';
import { pathSvg, shapeSvg } from './shapes';
import { pieceSvg, splitPieces, type Line, type Piece } from './ungroup';
import { nearestLine, trim, type TrimHit, type TrimLine } from './trim';
import { zip } from './zip';
import { boxPanels, outsideSize } from './boxmaker';
import { adjust, runCount, toDots, toPbm } from './photo';
import { bounds, pointCount, toDxf, trace, type Pt as TracePt } from './trace';
import { binaryStringToBytes, bytesToBinaryString, dxfFlavour, dxfUnitsCode, sketchDxf, UNIT_MM as DXF_UNIT_MM } from './dxf';
import { dropLocal, localView, type DesignPart, type Source } from './sketch';
import { initThemeButton } from './theme';
import { cadAngle, Workspace, type Box, type Dim, type PartView, type Tool } from './workspace';

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
let joinLines = true; // the server chains touching lines into single paths and drops repeats
const hiddenOps = new Set<OpKind>(); // only the view: hidden colours still run on the laser
let material: { w: number; h: number } | null = null; // the student's own board, drawn on the bed
let clipboard: DesignPart[] = [];
let pasteCount = 0;
let result: ProcessResponse | null = null;
let resultIds: number[] = []; // part id for each index in `result`
let pending = false;          // a change is waiting for the server, so `result` is out of date
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
// X/Y boxes count from the machine's home corner (top-right on the class laser).
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
  onBoxSelect: (ids) => {
    const all = new Set(withGroups(ids));
    const pick = parts.map((p) => p.id).filter((x) => all.has(x));
    if (pick.length <= 1) select(pick[0] ?? null);
    else setGroup(pick);
  },
  onMenu: (at) => openMenu(at),
  trimAt: (mx, my, tol) => trimPlan(mx, my, tol)?.removed ?? null,
  onTrim: (mx, my, tol) => trimClick(mx, my, tol),
});
if (import.meta.env.DEV) Object.assign(window, { __ws: ws }); // browser tests find the bed on screen

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
  if (material) {
    $<HTMLInputElement>('myMatW').value = String(material.w);
    $<HTMLInputElement>('myMatH').value = String(material.h);
    ws.setMaterial(material);
  }
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
/** The last result sorted by part, made once per result: a 5000-piece floor plan would otherwise scan
 *  every preview layer for every part on every redraw. */
type PartLines = ProcessResponse['preview'];
interface ResultIndex { of: ProcessResponse | null; ids: number[]; preview: unknown; un: unknown; n: number; at: Map<number, number>; layers: PartLines[]; unassigned: NonNullable<ProcessResponse['unassigned']>[] }
let byPart: ResultIndex | null = null;
function resultIndex(): ResultIndex {
  const n = (result?.preview.length ?? 0) + (result?.unassigned?.length ?? 0);
  if (byPart && byPart.of === result && byPart.ids === resultIds && byPart.preview === result?.preview && byPart.un === result?.unassigned && byPart.n === n) return byPart;
  const at = new Map(resultIds.map((id, i) => [id, i]));
  const layers: PartLines[] = resultIds.map(() => []);
  const unassigned: ResultIndex['unassigned'] = resultIds.map(() => []);
  for (const l of result?.preview ?? []) layers[l.part]?.push(l);
  for (const u of result?.unassigned ?? []) unassigned[u.part]?.push(u);
  byPart = { of: result, ids: resultIds, preview: result?.preview, un: result?.unassigned, n, at, layers, unassigned };
  return byPart;
}

/** What the server drew for a part, by everything that decides it. Undo, Redo and a busy server then show
 *  the real lines at once instead of grey sketches that cannot be recoloured. */
const viewCache = new Map<string, PartView>();
/** The colours the server found in each file (by its data), kept across results for the same reason. */
const knownColors = new Map<string, { key: string; kind: OpKind | null }[]>();
const dataIds = new Map<string, number>();
const CACHE_MAX = 20000;

function sigCtx(): string {
  return JSON.stringify([materialId, colorMap, powerChoice, joinLines]);
}

function partSig(p: DesignPart, ctx: string): string {
  const { id: _id, groupId: _group, source, ...placement } = p;
  let src: unknown = source;
  if (source.kind === 'file') {
    let n = dataIds.get(source.data);
    if (n === undefined) dataIds.set(source.data, n = dataIds.size);
    src = { ...source, data: n, preview: undefined };
  }
  return `${ctx}|${JSON.stringify(placement)}|${JSON.stringify(src)}`;
}

/** Keep the parts' views and file colours from a fresh result (sigs made when the request was built). */
function remember(res: ProcessResponse, ids: number[], sigs: string[]): void {
  if (viewCache.size > CACHE_MAX || dataIds.size > CACHE_MAX) { viewCache.clear(); dataIds.clear(); }
  const ix = resultIndex();
  ids.forEach((id, i) => {
    const box = res.partBoxes[i];
    // copies of the layers: moving a part shifts the result's own lines in place
    if (box) viewCache.set(sigs[i], { id, box, layers: ix.layers[i].map((l) => ({ ...l })), unassigned: ix.unassigned[i].flatMap((u) => u.paths) });
  });
  const found = new Map<number, { key: string; kind: OpKind | null }[]>();
  for (const c of res.partColors ?? []) {
    let list = found.get(c.part);
    if (!list) found.set(c.part, list = []);
    list.push({ key: c.key, kind: c.kind });
  }
  for (const [i, list] of found) {
    const q = find(ids[i]);
    if (q?.source.kind === 'file') knownColors.set(q.source.data, list);
  }
  if (knownColors.size > CACHE_MAX) knownColors.clear();
}

function viewOf(p: DesignPart): PartView {
  const ix = resultIndex();
  const i = ix.at.get(p.id) ?? -1;
  const box = i >= 0 ? result?.partBoxes[i] : null;
  if (result && box) return { id: p.id, box, layers: ix.layers[i], unassigned: ix.unassigned[i].flatMap((u) => u.paths) };
  const seen = viewCache.get(partSig(p, sigCtx()));
  if (seen) return { ...seen, id: p.id };
  return localView(p, renderSoon);
}

let frame = 0;
/** One redraw per screen frame: a design with hundreds of pieces loads hundreds of sketches at once. */
function renderSoon(): void {
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); });
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

/** These parts plus every part grouped with any of them. */
function withGroups(ids: number[]): number[] {
  const gids = new Set(ids.map((id) => find(id)?.groupId).filter((g) => g !== undefined));
  return parts.filter((p) => ids.includes(p.id) || (p.groupId !== undefined && gids.has(p.groupId))).map((p) => p.id);
}

function toggleSelect(id: number): void {
  const now = new Set(selection());
  const members = withGroups([id]);
  if (now.has(id)) members.forEach((x) => now.delete(x));
  else members.forEach((x) => now.add(x));
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
  jobBoxNow();
  ws.clearLive();
  changed();
}

/** Each part's box is mapped from the old selection box onto the new one, so a group keeps its
 *  spacing in proportion. One Undo step for the lot. */
/** Box maker panels must keep their size, or the fingers stop fitting the material. */
function refuseBoxResize(ids: number[]): boolean {
  if (!ids.some((id) => { const s = find(id)?.source; return s?.kind === 'path' && !!s.box; })) return false;
  ws.clearLive();
  warn('Box maker panels keep their size, so the fingers fit your material. To change the box, make a new one.');
  render();
  return true;
}

function resizeParts(ids: number[], fx: number, fy: number, from: Box, to: Box): void {
  if (refuseBoxResize(ids)) return;
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
  if (refuseBoxResize(selection())) return;
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
  const i = resultIndex().at.get(id) ?? -1;
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
  if (!name.endsWith('.svg') && !name.endsWith('.dxf') && !name.endsWith('.dwg')) {
    notes = ['Pick an SVG, DXF or DWG file.'];
    render();
    return null;
  }
  if (name.endsWith('.svg')) return { kind: 'file', name: f.name, fileType: 'svg', data: await f.text() };
  let bytes: Uint8Array = new Uint8Array(await f.arrayBuffer());
  let flavour = dxfFlavour(String.fromCharCode(...bytes.subarray(0, 32)));
  let fileName = f.name;
  if (flavour === 'dwg') {
    const dxf = await dwgToDxf(bytes, used);
    if (!dxf) return null;
    bytes = dxf;
    flavour = dxfFlavour(String.fromCharCode(...bytes.subarray(0, 32)));
    fileName = f.name.replace(/\.(dwg|dxf)$/i, '') + '.dxf';
  }
  // A binary DXF is kept one char per byte and sent as the same bytes (see buildRequest).
  const data = flavour === 'binary' ? bytesToBinaryString(bytes) : new TextDecoder().decode(bytes);
  const units = await askUnits(fileName, flavour === 'ascii' ? data : null);
  if (units === null) return null; // cancelled
  if (fileName !== f.name) warn('Converted from DWG (beta). Check every line before you cut. If something is missing, use Save As DXF in AutoCAD.');
  return { kind: 'file', name: fileName, fileType: 'dxf', data, units };
}

/** DWG -> DXF on the processor (beta, LibreDWG). Null after telling the student why it did not work. */
async function dwgToDxf(dwg: Uint8Array, used: number): Promise<Uint8Array | null> {
  const say = (t: string) => { warn(t); render(); return null; };
  if (!getPhrase()) return say('Opening a DWG needs the class phrase (top right). Or, in AutoCAD, use Save As and pick "AutoCAD 2013 DXF".');
  $('busy').hidden = false;
  $('busy').lastChild!.textContent = 'Converting the DWG (beta)…';
  try {
    const dxf = await convertDwg(dwg);
    if (dxf.length + used > MAX_UPLOAD_BYTES) return say('That DWG is too big once converted (10 MB max for the whole design). Save As DXF in AutoCAD and simplify it.');
    return dxf;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setPhrase('');
    return say((e as Error).message);
  } finally {
    $('busy').lastChild!.textContent = 'Updating the laser lines…';
    $('busy').hidden = !pending;
  }
}

// ---------- DXF units: "I drew in ..." (Dalton: AutoCAD files often say the wrong units, or none) ----------

const UNIT_CHOICES: { key: string; code: DxfUnits; label: string }[] = [
  { key: 'mm', code: 4, label: 'Millimetres (mm)' },
  { key: 'cm', code: 5, label: 'Centimetres (cm)' },
  { key: 'm', code: 6, label: 'Metres (m)' },
  { key: 'in', code: 1, label: 'Inches (in)' },
  { key: 'arch', code: 1, label: 'Architectural: feet and inches (AutoCAD)' },
  { key: 'ft', code: 2, label: 'Feet (decimal)' },
];
const UNIT_SAID: Record<number, string> = { 0: 'no units', 1: 'inches', 2: 'feet', 4: 'millimetres', 5: 'centimetres', 6: 'metres', 10: 'yards', 14: 'decimetres' };
const UNITS_KEY = 'uml.dxfUnits';

/** Ask which units a DXF was drawn in, showing the size each choice makes. Null when cancelled. */
function askUnits(name: string, ascii: string | null): Promise<DxfUnits | null> {
  let said = 0;
  let w = 0, h = 0;
  if (ascii) {
    said = dxfUnitsCode(ascii);
    try {
      const sk = sketchDxf(ascii);
      if (sk) [w, h] = [sk.vb.w, sk.vb.h];
    } catch { /* no preview size: the server still reads it */ }
  }
  let last = '';
  try { last = localStorage.getItem(UNITS_KEY) ?? ''; } catch { /* fine */ }
  const fromFile = UNIT_CHOICES.find((c) => c.code === said);
  const start = fromFile && !(said === 1 && last === 'arch') ? fromFile.key : UNIT_CHOICES.some((c) => c.key === last) ? last : 'mm';

  $('unitsInfo').textContent = `${name} · the file says: ${UNIT_SAID[said] ?? `unit code ${said}`}.`;
  const fmt = (mm: number) => (mm >= 100 ? Math.round(mm) : Math.round(mm * 10) / 10);
  $('unitsList').replaceChildren(...UNIT_CHOICES.map((c) => {
    const label = document.createElement('label');
    const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'units', value: c.key, checked: c.key === start });
    const size = document.createElement('span');
    size.className = 'size';
    if (w && h) {
      const [mw, mh] = [w * DXF_UNIT_MM[c.code], h * DXF_UNIT_MM[c.code]];
      const fits = (mw <= machine.bedWidthMm && mh <= machine.bedHeightMm) || (mh <= machine.bedWidthMm && mw <= machine.bedHeightMm);
      size.textContent = `${fmt(mw)} × ${fmt(mh)} mm (${fmt(mw / 25.4)} × ${fmt(mh / 25.4)} in)${fits ? '' : ' · bigger than the laser bed'}`;
      if (!fits || Math.max(mw, mh) < 2) size.classList.add('big');
    }
    label.append(radio, document.createTextNode(c.label), size);
    return label;
  }));
  $('unitsDlg').hidden = false;
  ($('unitsList').querySelector('input:checked') as HTMLInputElement | null)?.focus();
  return new Promise((resolve) => {
    const done = (v: DxfUnits | null) => {
      $('unitsDlg').hidden = true;
      $<HTMLFormElement>('unitsForm').onsubmit = null;
      $('unitsCancel').onclick = null;
      resolve(v);
    };
    $<HTMLFormElement>('unitsForm').onsubmit = (e) => {
      e.preventDefault();
      const key = ($('unitsList').querySelector('input:checked') as HTMLInputElement | null)?.value ?? 'mm';
      try { localStorage.setItem(UNITS_KEY, key); } catch { /* fine */ }
      done(UNIT_CHOICES.find((c) => c.key === key)!.code);
    };
    $('unitsCancel').onclick = () => done(null);
  });
}

// ---------- design files (.uml): save the workspace, open it later or on another computer ----------

const DESIGN_EXT = '.uml';
const DESIGN_KIND = 'uploadmylaser design';

/** First typed text, else the first file's name, as a file-name-safe word. */
function designName(): string {
  const text = parts.find((p) => p.source.kind === 'text')?.source as { text: TextSpec } | undefined;
  const file = parts.find((p) => p.source.kind === 'file')?.source as { name: string } | undefined;
  const raw = text?.text.value || file?.name.replace(/\.[^.]*$/, '').replace(/ piece \d+$/, '') || 'design';
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'design';
}

/** Chrome asks where to save; other browsers download. False when the student cancelled. */
async function saveBlob(blob: Blob, name: string, what: string, ext: string): Promise<boolean> {
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<{ createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }> }).showSaveFilePicker;
  if (picker) {
    try {
      const h = await picker({ suggestedName: name, types: [{ description: what, accept: { 'application/octet-stream': [ext] } }] });
      const out = await h.createWritable();
      await out.write(blob);
      await out.close();
      return true;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false;
      // blocked (some school policies): fall back to a normal download
    }
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return true;
}

function designJson(): string {
  return JSON.stringify({ kind: DESIGN_KIND, version: 1, savedAt: new Date().toISOString(), materialId, colorMap, powerChoice, parts });
}

$('save').onclick = async () => {
  if (!parts.length) return warn('Add something to the workspace first.');
  const ok = await saveBlob(new Blob([designJson()], { type: 'application/json' }), designName() + DESIGN_EXT, 'uploadmylaser design', DESIGN_EXT);
  if (ok) warn('Saved. Open it later with Open…, on this computer or another one.', '✓');
};

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

/** One part's source has what drawing it needs. */
function okSource(s: Record<string, unknown>): boolean {
  const t = s.text as Record<string, unknown> | undefined;
  const vb = s.vb as Record<string, unknown> | undefined;
  switch (s.kind) {
    case 'file': return typeof s.name === 'string' && typeof s.data === 'string' && (s.fileType === 'svg' || s.fileType === 'dxf' || s.fileType === 'pbm')
      && (s.units === undefined || DXF_UNITS.includes(s.units as DxfUnits));
    case 'text': return !!t && typeof t.value === 'string' && typeof t.font === 'string' && num(t.heightMm) && typeof t.op === 'string';
    case 'shape': return (s.shape === 'box' || s.shape === 'circle') && num(s.wMm) && num(s.hMm) && typeof s.op === 'string';
    case 'path': return typeof s.d === 'string' && !!vb && [vb.x, vb.y, vb.w, vb.h].every(num) && num(s.wMm) && num(s.hMm) && typeof s.op === 'string';
    default: return false;
  }
}

/** A saved design, checked enough that a broken or odd file can't break the page (the server checks the rest). */
function readDesign(text: string): { parts: DesignPart[]; materialId: string; colorMap: Record<string, ColorChoice>; powerChoice: Partial<Record<OpKind, number>> } | null {
  let d: unknown;
  try { d = JSON.parse(text); } catch { return null; }
  const o = d as Record<string, unknown>;
  if (!o || o.kind !== DESIGN_KIND || !Array.isArray(o.parts)) return null;
  const okPart = (p: unknown): p is DesignPart => {
    const q = p as Record<string, unknown>;
    const s = q?.source as Record<string, unknown> | undefined;
    return !!q && typeof q.id === 'number' && [q.xMm, q.yMm, q.scale].every((v) => typeof v === 'number' && Number.isFinite(v))
      && [0, 90, 180, 270].includes(q.rotateDeg as number) && !!s && okSource(s);
  };
  const ps = o.parts.filter(okPart).slice(0, MAX_PARTS);
  if (!ps.length) return null;
  const plain = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, never> : {});
  return { parts: ps, materialId: typeof o.materialId === 'string' ? o.materialId : '', colorMap: plain(o.colorMap), powerChoice: plain(o.powerChoice) };
}

/** Put a saved design's parts on the workspace with fresh ids (so Import can add one next to another). */
function placeDesign(d: NonNullable<ReturnType<typeof readDesign>>, replace: boolean): void {
  const groups = new Map<number, number>(); // old group id -> new, so groups stay groups
  const fresh = (old: number) => { if (!groups.has(old)) groups.set(old, nextId++); return groups.get(old)!; };
  const added = d.parts.map((p) => ({ ...p, id: nextId++, ...(p.groupId !== undefined ? { groupId: fresh(p.groupId) } : {}) }));
  if ((replace ? 0 : parts.length) + added.length > MAX_PARTS) return warn(`That would be more than ${MAX_PARTS} parts.`);
  if (replace) {
    parts = [];
    result = null;
    resultIds = [];
    colorMap = { ...d.colorMap };
    powerChoice = { ...d.powerChoice };
    if (materials.some((m) => m.id === d.materialId)) materialId = d.materialId;
  } else {
    colorMap = { ...d.colorMap, ...colorMap };
  }
  parts.push(...added);
  select(null);
  changed();
  if (replace && d.materialId && !materials.some((m) => m.id === d.materialId)) warn('This design used a material this laser does not have. Pick a material.');
  else warn(replace ? 'Design opened. Carry on where you left off.' : `Added ${added.length} parts from that design.`, '✓');
}

async function openAny(f: File, replace: boolean): Promise<void> {
  if (/^image\/(png|jpe?g|webp|gif|bmp)$/.test(f.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name)) {
    const src = await photoDialog(f);
    if (!src) return;
    if (replace) { parts = []; colorMap = {}; result = null; resultIds = []; }
    addPart(src);
    return;
  }
  if (f.name.toLowerCase().endsWith(DESIGN_EXT)) {
    if (f.size > MAX_UPLOAD_BYTES * 2) return warn('That design file is too big.');
    const d = readDesign(await f.text());
    if (!d) return warn('That is not an uploadmylaser design file, or it is damaged.');
    placeDesign(d, replace);
    return;
  }
  const src = await readFile(f);
  if (!src) return;
  if (replace) {
    parts = [];
    colorMap = {};
    result = null;
    resultIds = [];
  }
  addPart(src);
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
  await openAny(f, true);
};
$<HTMLInputElement>('importFile').onchange = async (ev) => {
  const input = ev.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  await openAny(f, false);
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
$('toolTrim').onclick = () => setTool('trim');

function setTool(t: Tool): void {
  ws.setTool(t);
  for (const [id, name] of [['toolSelect', 'select'], ['toolLine', 'line'], ['toolCurve', 'curve'], ['toolTrim', 'trim']] as const) $(id).classList.toggle('on', name === t);
  if (t === 'trim') hint.textContent = 'Trim: click a line to cut away the bit between the lines that cross it. A line nothing crosses goes completely. Esc stops.';
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
$('ungroup').onclick = ungroup;
$('group').onclick = groupSelected;

/** Replace the selected file with one file per piece, in the same place, from the server's last answer. */
function ungroup(): void {
  const grouped = selection().map(find).filter((q): q is DesignPart => q?.groupId !== undefined);
  if (grouped.length) {
    grouped.forEach((q) => delete q.groupId);
    select(null);
    changed();
    warn(`Ungrouped ${grouped.length} parts. Click a part to move it on its own.`, '✓');
    return;
  }
  const p = find(selected);
  if (!p || p.source.kind !== 'file') return;
  const i = resultIds.indexOf(p.id);
  // a pop-up, not a note: under a red bed error the note was easy to miss and Ungroup looked broken
  const say = (t: string) => { warn(t); render(); };
  if (pending || !result || i < 0) return say('Wait a moment for the file to be checked, then press Ungroup again.');
  if (result.unassigned?.some((u) => u.part === i)) return say('Choose what each colour does first (under Layers), then press Ungroup.');
  const lines: Line[] = result.preview.filter((l) => l.part === i).flatMap((l) => l.paths.map((pts) => ({ kind: l.kind, pts })));
  if (!lines.length) return say('Nothing in this file to ungroup.');
  const pieces = splitPieces(lines);
  if (pieces.length < 2) return say('This file is already one piece.');
  if (parts.length - 1 + pieces.length > MAX_PARTS) return say(`Cannot ungroup: this file splits into ${pieces.length} pieces, and one design can hold ${MAX_PARTS} parts. Delete other parts first, or split it in AutoCAD or LightBurn.`);
  const name = p.source.name.replace(/\.(dxf|svg)$/i, '');
  const made: DesignPart[] = pieces.map((pc, k) => ({
    id: nextId++,
    source: { kind: 'file', name: `${name} piece ${k + 1}`, fileType: 'svg', data: pieceSvg(pc) },
    xMm: round(pc.box[2]), yMm: round(pc.box[1]), scale: 1, rotateDeg: 0, // top-right corner, like every part
  }));
  parts.splice(parts.indexOf(p), 1, ...made);
  showPiecesNow(result, made, pieces);
  // nothing selected afterwards: with every piece selected they move as one and look still grouped
  select(null);
  changed();
  warn(`Split into ${made.length} pieces. Click a piece to move or delete it on its own.`, '✓');
}
/** Until the server answers, draw the pieces from their own lines (the result they came from, renumbered).
 *  Otherwise every piece loads a sketch image, and a floorplan's thousands of them keep the page too busy. */
function showPiecesNow(old: ProcessResponse, made: DesignPart[], pieces: Piece[]): void {
  const at = new Map(made.map((q, k) => [q.id, k]));
  const ids: number[] = [];
  const next: ProcessResponse = { ...old, preview: [], unassigned: [], partBoxes: [], partColors: [], rd: null, frameRd: null, warnings: [], errors: [] };
  for (const q of parts) {
    const k = at.get(q.id);
    const n = ids.length;
    if (k !== undefined) {
      const pc = pieces[k];
      for (const kind of RUN_ORDER) {
        const paths = pc.lines.filter((l) => l.kind === kind).map((l) => l.pts);
        if (paths.length) {
          next.preview.push({ kind, part: n, paths });
          next.partColors!.push({ part: n, key: kind === 'engrave' ? 'fill:#0000ff' : `stroke:${kind === 'cut' ? '#000000' : '#ff0000'}`, kind });
        }
      }
      next.partBoxes.push(pc.box);
    } else {
      const i = resultIds.indexOf(q.id);
      if (i < 0) continue;
      for (const l of old.preview) if (l.part === i) next.preview.push({ ...l, part: n });
      for (const u of old.unassigned ?? []) if (u.part === i) next.unassigned.push({ ...u, part: n });
      for (const c of old.partColors ?? []) if (c.part === i) next.partColors!.push({ ...c, part: n });
      next.partBoxes.push(old.partBoxes[i]);
    }
    ids.push(q.id);
  }
  result = next;
  resultIds = ids;
}

// ---------- trim ----------

interface TrimPlan { p: DesignPart; keep: TrimLine[]; removed: [number, number][][] }

/** What a Trim click at (mx, my) would do: the nearest line of any part, cut back to the nearest lines
 *  crossing it (from every part). Works on the lines on screen, so the part needs its laser lines. */
function trimPlan(mx: number, my: number, tol: number): TrimPlan | null {
  const views = parts.map(viewOf);
  const linesOf = (v: PartView) => v.layers.filter((l) => !hiddenOps.has(l.kind)).flatMap((l) => l.paths.map((pts) => ({ kind: l.kind, pts })));
  let best: { k: number; lines: TrimLine[]; hit: TrimHit } | null = null;
  views.forEach((v, k) => {
    const b = v.box;
    if (!b || mx < b[0] - tol || mx > b[2] + tol || my < b[1] - tol || my > b[3] + tol) return;
    const lines = linesOf(v);
    const hit = nearestLine(lines, [mx, my], tol);
    if (hit && (!best || hit.d <= best.hit.d)) best = { k, lines, hit };
  });
  if (!best) return null;
  const { k, lines, hit } = best as { k: number; lines: TrimLine[]; hit: TrimHit };
  const pts = lines[hit.line].pts;
  const [x0, y0, x1, y1] = boundsOf([pts]);
  const cutters = views.filter((v) => v.box && v.box[0] <= x1 && v.box[2] >= x0 && v.box[1] <= y1 && v.box[3] >= y0)
    .flatMap((v) => [...v.layers.flatMap((l) => l.paths), ...(v.unassigned ?? [])]);
  return { p: parts[k], ...trim(lines, hit, cutters) };
}

/** A loop, not Math.min(...): spreading a big file's points overflows the stack. */
function boundsOf(paths: [number, number][][]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const path of paths) for (const [x, y] of path) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}

function trimClick(mx: number, my: number, tol: number): void {
  const plan = trimPlan(mx, my, tol);
  if (!plan) {
    if (!getPhrase()) warn('Trim works on the laser lines. Enter the class phrase first.');
    return;
  }
  const { p, keep } = plan;
  const i = resultIds.indexOf(p.id);
  if (i >= 0 && result?.unassigned?.some((u) => u.part === i)) return warn('Choose what each colour does first (under Layers), then trim.');
  if (!keep.length) { // the last line went: so does the part
    parts = parts.filter((q) => q !== p);
    dropLocal(p.id);
    if (selection().includes(p.id)) select(null);
    changed();
    return;
  }
  const box = boundsOf(keep.map((l) => l.pts));
  const s = p.source;
  const was = s.kind === 'text' ? s.text.value.split('\n')[0] : s.kind === 'shape' ? (s.shape === 'box' ? 'Box' : 'Circle') : s.name;
  const name = /\(trimmed\)$/.test(was) ? was : `${was.replace(/\.(dxf|svg)$/i, '')} (trimmed)`;
  const data = pieceSvg({ lines: keep, box });
  // the part keeps its id (so its selection and group stay) but becomes a plain drawing of what is left;
  // weld and outline are already in these lines
  p.source = { kind: 'file', name, fileType: 'svg', data };
  Object.assign(p, { xMm: round(box[2]), yMm: round(box[1]), scale: 1, rotateDeg: 0 });
  for (const f of ['scaleY', 'flipX', 'flipY', 'weld', 'outline'] as const) delete p[f];
  dropLocal(p.id);
  const kinds = RUN_ORDER.filter((kind) => keep.some((l) => l.kind === kind));
  knownColors.set(data, kinds.map((kind) => ({ key: kind === 'engrave' ? 'fill:#0000ff' : `stroke:${kind === 'cut' ? '#000000' : '#ff0000'}`, kind })));
  const layers = kinds.map((kind) => ({ kind, paths: keep.filter((l) => l.kind === kind).map((l) => l.pts) }));
  if (result && i >= 0) { // show it at once; the server's answer replaces it
    result.preview = [...result.preview.filter((l) => l.part !== i), ...layers.map((l) => ({ ...l, part: i }))];
    result.partBoxes[i] = box;
  }
  changed();
  viewCache.set(partSig(p, sigCtx()), { id: p.id, box, layers });
}

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
  const members = id === null ? [] : withGroups([id]);
  if (members.length > 1) return setGroup(members); // a grouped part brings its whole group
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
  renderColors(); // with many files it shows the selected one's colours
  renderSelectButtons();
}

function canUngroup(): boolean {
  const ids = selection();
  const one = ids.length === 1 ? find(ids[0])?.source : undefined;
  return ids.some((id) => find(id)?.groupId !== undefined) || (one?.kind === 'file' && one.fileType !== 'pbm');
}

function renderSelectButtons(): void {
  const n = selection().length;
  $('group').toggleAttribute('disabled', n < 2);
  $('align').toggleAttribute('disabled', n < 2);
  $('mirror').toggleAttribute('disabled', !n);
  renderPartPanel();
  $('ungroup').toggleAttribute('disabled', !canUngroup());
}

/** Tie the selected parts together: clicking any of them selects them all. Nothing is merged. */
function groupSelected(): void {
  const ids = selection();
  if (ids.length < 2) return;
  const gid = nextId++;
  for (const id of ids) { const q = find(id); if (q) q.groupId = gid; }
  changed();
  setGroup(ids);
  warn(`Grouped ${ids.length} parts. Click any of them to move them together.`, '✓');
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
    $<HTMLTextAreaElement>('textValue').rows = Math.min(4, t.value.split('\n').length);
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
  if (p?.source.kind === 'text') {
    p.source.text.value = $<HTMLTextAreaElement>('textValue').value.split('\n').slice(0, 4).join('\n').slice(0, 120);
    changed({ merge: `text${p.id}` });
  }
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
    b.dataset.hint = `${OP_LABELS[op]}: new text and shapes use this. Click it with a text, shape or file selected to change it.`;
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
    else if (q?.source.kind === 'file') {
      // the whole file becomes this colour (each colour can be changed again in the colour list)
      const keys = fileColors(q).map((c) => c.key);
      if (keys.length) {
        q.source.colors = { ...q.source.colors, ...Object.fromEntries(keys.map((k) => [k, op])) };
        recolourNow([q.id], 'all', op);
        recoloured = took = true;
      } else notes = ['Wait a moment for the file to be checked, then pick the colour again.'];
    }
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
  const inDesign = new Set<OpKind>(); // from what is on screen, so Undo doesn't say "not in design"
  for (const q of parts) for (const l of viewOf(q).layers) inDesign.add(l.kind);
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
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'eye small' + (hiddenOps.has(op) ? ' off' : '');
    eye.textContent = '👁';
    eye.setAttribute('aria-label', `${hiddenOps.has(op) ? 'Show' : 'Hide'} ${OP_LABELS[op]}`);
    eye.setAttribute('aria-pressed', String(hiddenOps.has(op)));
    eye.dataset.hint = `${hiddenOps.has(op) ? 'Show' : 'Hide'} the ${OP_LABELS[op]} lines on the screen. Hidden lines still run on the laser.`;
    eye.onclick = () => toggleHidden(op);
    const top = document.createElement('div');
    top.className = 'layertop';
    top.append(pick, eye);
    li.append(top);
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

/** Recolour lines already on screen, before the server answers: `from` null means the grey unchosen lines. */
function recolourNow(ids: number[], from: OpKind | null | 'all', to: ColorChoice): void {
  if (!result) return;
  const ix = resultIndex();
  const moved = new Map<number, [number, number][][]>(); // part index -> its lines that change colour
  for (const id of ids) { const i = ix.at.get(id); if (i !== undefined) moved.set(i, []); }
  if (!moved.size) return;
  result.preview = result.preview.filter((l) => {
    const m = moved.get(l.part);
    if (!m || (from !== 'all' && l.kind !== from)) return true;
    m.push(...l.paths);
    return false;
  });
  if (from === null || from === 'all') {
    result.unassigned = (result.unassigned ?? []).filter((u) => {
      const m = moved.get(u.part);
      if (!m) return true;
      m.push(...u.paths);
      return false;
    });
  }
  if (to !== 'ignore') for (const [i, paths] of moved) if (paths.length) result.preview.push({ kind: to, part: i, paths });
}

function toggleHidden(op: OpKind): void {
  if (hiddenOps.has(op)) hiddenOps.delete(op);
  else hiddenOps.add(op);
  ws.setHidden(hiddenOps);
  renderLayers();
}

// ---------- right-click menu ----------

function openMenu(at: { x: number; y: number }): void {
  const ids = selection();
  const items: MenuItem[] = [];
  if (ids.length) {
    const mat = materials.find((m) => m.id === materialId);
    for (const op of [...RUN_ORDER].reverse()) {
      if (!mat || mat.ops.includes(op)) items.push([OP_LABELS[op], () => applyColor(op)]);
    }
    items.push(null);
    if (ids.length > 1) items.push(['Group', groupSelected]);
    if (canUngroup()) items.push(['Ungroup', ungroup]);
    if (selected !== null) items.push(['Rotate', () => $('rotate').click()]);
    items.push(['Mirror left-right', () => mirrorSelected('x')], ['Mirror up-down', () => mirrorSelected('y')]);
    if (ids.length > 1) items.push(['Line up…', () => openAlignMenu(at)]);
    items.push(null, ['Copy (Ctrl+C)', copySelected], ['Duplicate (Ctrl+D)', duplicateSelected]);
  }
  if (clipboard.length) items.push(['Paste (Ctrl+V)', paste]);
  if (ids.length) items.push(['Delete', deleteSelected]);
  items.push(null);
  if (parts.length) items.push(['Select all', selectAll]);
  for (const op of RUN_ORDER) items.push([`${hiddenOps.has(op) ? 'Show' : 'Hide'} ${OP_LABELS[op]}`, () => toggleHidden(op)]);
  showMenu(at, items);
}

/** A menu line: label, what it does, greyed out?, shortcut shown on the right. null = a divider. */
type MenuItem = [string, () => void, boolean?, string?] | null;

function showMenu(at: { x: number; y: number }, items: MenuItem[]): void {
  const menu = $('ctxmenu');
  while (items[0] === null) items.shift();
  while (items.at(-1) === null) items.pop();
  menu.replaceChildren(...items.map((it) => {
    if (!it) return Object.assign(document.createElement('hr'), {});
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.disabled = !!it[2];
    b.append(Object.assign(document.createElement('span'), { textContent: it[0] }));
    if (it[3]) b.append(Object.assign(document.createElement('kbd'), { textContent: it[3] }));
    b.onclick = () => { closeMenu(); it[1](); };
    return b;
  }));
  menu.hidden = false;
  // keep it on screen
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(at.x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(at.y, innerHeight - r.height - 8)}px`;
  (menu.querySelector('button') as HTMLButtonElement | null)?.focus();
}

function closeMenu(): void {
  $('ctxmenu').hidden = true;
  openMenuName = '';
  for (const b of document.querySelectorAll('.menubtn')) b.classList.remove('on');
}

// ---------- the menu bar ----------

let openMenuName = '';
let pictureStyle: 'trace' | 'dither' | null = null; // the Picture window opens on this style

/** Press one of the hidden action buttons, and say whether it is greyed out. */
const act = (label: string, id: string, key?: string): MenuItem => [label, () => $(id).click(), $<HTMLButtonElement>(id).disabled, key];

function pickPicture(style: 'trace' | 'dither'): void {
  pictureStyle = style;
  $<HTMLInputElement>('pictureFile').click();
}

function menuItems(name: string): MenuItem[] {
  const n = selection().length;
  const hasJob = !!result?.rd && !pending && !result.errors.length;
  switch (name) {
    case 'file': return [
      act('Open… (start over)', 'open'), act('Import… (add to the bed)', 'import'),
      ['Trace an image… (logo or drawing)', () => pickPicture('trace')], ['Engrave a photo…', () => pickPicture('dither')], null,
      act('Save design (.uml)', 'save'), null,
      ['Export for teacher', () => $('exportTeacher').click(), !parts.length], ['Download laser file (.rd)', () => $('downloadRd').click(), !hasJob],
    ];
    case 'edit': return [
      act('Undo', 'undo', 'Ctrl+Z'), act('Redo', 'redo', 'Ctrl+Y'), null,
      ['Copy', copySelected, !n, 'Ctrl+C'], ['Paste', paste, !clipboard.length, 'Ctrl+V'], ['Duplicate', duplicateSelected, !n, 'Ctrl+D'], null,
      act('Select all', 'selectAll', 'Ctrl+A'), act('Delete', 'delete', 'Del'),
    ];
    case 'arrange': return [
      act('Rotate a quarter turn', 'rotate'), ['Mirror left-right', () => mirrorSelected('x'), !n], ['Mirror up-down', () => mirrorSelected('y'), !n], null,
      ...(Object.keys(ALIGN_LABELS) as AlignHow[]).map((how): MenuItem => [ALIGN_LABELS[how], () => alignSelected(how), n < 2]), null,
      act('Group', 'group'), act('Ungroup', 'ungroup'),
    ];
    case 'make': return [
      ['Text', () => $('toolText').click()], ['Box', () => $('toolBox').click()], ['Circle', () => $('toolCircle').click()],
      ['Line', () => $('toolLine').click()], ['Curve', () => $('toolCurve').click()], ['Shapes…', () => $('toolShapes').click()], null,
      ['Box maker…', () => $('toolBoxMaker').click()], ['Trace an image…', () => pickPicture('trace')], ['Engrave a photo…', () => pickPicture('dither')], null,
      ['Pattern (copies in rows)…', () => $('toolPattern').click(), selected === null],
    ];
    case 'view': return [
      act('Zoom in', 'zoomIn'), act('Zoom out', 'zoomOut'), act('Whole bed', 'zoomBed'), act('My design', 'zoomDesign'), null,
      ...RUN_ORDER.map((op): MenuItem => [`${hiddenOps.has(op) ? 'Show' : 'Hide'} ${OP_LABELS[op]}`, () => toggleHidden(op)]),
    ];
    default: return [];
  }
}

function openBarMenu(btn: HTMLElement): void {
  const name = btn.dataset.menu ?? '';
  if (openMenuName === name) return closeMenu(); // a second click closes it
  closeMenu();
  const r = btn.getBoundingClientRect();
  showMenu({ x: r.left, y: r.bottom + 2 }, menuItems(name));
  openMenuName = name;
  btn.classList.add('on');
}
for (const btn of document.querySelectorAll<HTMLElement>('.menubtn')) {
  btn.addEventListener('pointerdown', (e) => e.stopPropagation()); // not "a click outside the menu"
  btn.addEventListener('click', () => openBarMenu(btn));
  // with one menu open, pointing at the next one opens it, like a desktop menu bar
  btn.addEventListener('pointerenter', () => { if (openMenuName && openMenuName !== btn.dataset.menu) { closeMenu(); openBarMenu(btn); } });
}
// Our menu opens on right mouse DOWN; Windows Chrome fires its own menu on mouse UP, by which
// time the pointer is over #ctxmenu, so block the browser menu there too.
$('ctxmenu').addEventListener('contextmenu', (e) => e.preventDefault());
$('ctxmenu').addEventListener('keydown', (e) => {
  const items = [...$('ctxmenu').querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  }
});
$('toolPicture').onclick = () => pickPicture('trace');
$('quickPicture').onclick = () => pickPicture('trace');
$<HTMLInputElement>('pictureFile').onchange = async (ev) => {
  const input = ev.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (f) await openAny(f, false);
};
document.addEventListener('pointerdown', (e) => {
  const t = e.target as HTMLElement;
  if (e.button === 2 && t.id === 'ws') return; // the right click that just opened it
  if (!t.closest('#ctxmenu')) closeMenu();
});
window.addEventListener('blur', closeMenu);

/** The colours the server found in a file, with what the file makes each one (kept across results). */
function fileColors(p: DesignPart | undefined): { key: string; kind: OpKind | null }[] {
  return p?.source.kind === 'file' ? knownColors.get(p.source.data) ?? [] : [];
}

/** What a colour in a file does now: the student's choice, else the old design-wide one, else the file's own. */
function colorNow(s: Source & { kind: 'file' }, key: string, kind: OpKind | null): ColorChoice | null {
  return s.colors?.[key] ?? colorMap[key] ?? kind;
}

/** Colour keys are `stroke:#hex`, `fill:#hex`, `dxf:LAYER|#hex` or `photo:dots`. Rows go by the colour alone,
 *  so black lines in 90 pieces (or on 12 CAD layers) are one row. */
function colourGroup(key: string): string {
  const m = /#[0-9a-f]{6}$/i.exec(key);
  return m ? m[0].toLowerCase() : key;
}

const NAMED: [string, number, number, number][] = [
  ['Black', 0, 0, 0], ['Red', 220, 30, 30], ['Blue', 30, 60, 230], ['Green', 30, 160, 60], ['Yellow', 250, 220, 0],
  ['Orange', 250, 140, 0], ['Purple', 130, 40, 170], ['Pink', 250, 120, 180], ['Light blue', 60, 200, 230],
  ['Magenta', 240, 0, 240], ['Grey', 128, 128, 128], ['White', 255, 255, 255], ['Brown', 140, 80, 30],
];
function colourName(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  let best = NAMED[0], bestD = Infinity;
  for (const n of NAMED) {
    const d = (n[1] - r) ** 2 + (n[2] - g) ** 2 + (n[3] - b) ** 2;
    if (d < bestD) { best = n; bestD = d; }
  }
  return best[0];
}

/** Every colour in the design in one short list: black, red and blue already know their jobs; anything else
 *  (green, a CAD layer colour) asks what it should be. A choice changes that colour in every file. */
function renderColors(): void {
  const ops = materials.find((m) => m.id === materialId)?.ops ?? RUN_ORDER;
  type FilePart = DesignPart & { source: Source & { kind: 'file' } };
  interface Group { kinds: Set<OpKind | null>; keys: Set<string>; now: Set<ColorChoice | null> }
  const files = parts.filter((p): p is FilePart => p.source.kind === 'file');
  const groups = new Map<string, Group>();
  for (const p of files) {
    for (const c of fileColors(p)) {
      const id = colourGroup(c.key);
      let g = groups.get(id);
      if (!g) groups.set(id, g = { kinds: new Set(), keys: new Set(), now: new Set() });
      g.kinds.add(c.kind);
      g.keys.add(c.key);
      g.now.add(colorNow(p.source, c.key, c.kind));
    }
  }
  const unsure = (g: Group) => g.now.has(null);
  // an older server only lists the unknown ones
  const oldUnknown = result && !result.partColors ? result.unknownColors : [];
  const anyUnsure = [...groups.values()].some(unsure) || oldUnknown.length > 0;
  $('colors').hidden = !groups.size && !oldUnknown.length;
  $('colorsTitle').textContent = anyUnsure ? 'What should these colours do?' : 'Colours in your design';

  const row = (label: string, swatch: string | null, now: ColorChoice | null, ask: boolean, photo: boolean, pick: (c: ColorChoice) => void) => {
    const div = document.createElement('div');
    div.className = 'colorrow' + (ask ? ' ask' : '');
    const sw = document.createElement('span');
    sw.className = 'swatch';
    if (swatch) sw.style.background = swatch;
    else if (now && now !== 'ignore') sw.style.background = OP_COLORS[now];
    const name = document.createElement('span');
    name.textContent = label;
    div.append(sw, name);
    if (ask) div.append(Object.assign(document.createElement('span'), { className: 'small muted askline', textContent: 'The laser only knows black, red and blue. What should this colour do?' }));
    for (const choice of [...ops.filter((o) => !photo || o !== 'cut'), 'ignore'] as ColorChoice[]) {
      const btn = document.createElement('button');
      btn.className = 'small' + (choice === now ? ' on' : '');
      btn.setAttribute('aria-pressed', String(choice === now));
      btn.textContent = choice === 'ignore' ? 'Skip' : OP_LABELS[choice];
      btn.onclick = () => pick(choice);
      div.append(btn);
    }
    return div;
  };

  /** Every colour key in `keys`, in every file, now does `choice`. */
  const pick = (keys: Set<string>, choice: ColorChoice) => {
    const byWas = new Map<OpKind | null, number[]>(); // instant recolour, one pass per old colour
    for (const p of files) {
      const all = fileColors(p);
      const mine = all.filter((c) => keys.has(c.key));
      if (!mine.length) continue;
      const was = new Set(mine.map((c) => colorNow(p.source, c.key, c.kind)));
      const others = all.filter((c) => !keys.has(c.key)).map((c) => colorNow(p.source, c.key, c.kind));
      p.source.colors = { ...p.source.colors, ...Object.fromEntries(mine.map((c) => [c.key, choice])) };
      const w = [...was][0];
      if (was.size === 1 && w !== 'ignore' && !others.includes(w)) {
        let ids = byWas.get(w);
        if (!ids) byWas.set(w, ids = []);
        ids.push(p.id);
      }
    }
    for (const [w, ids] of byWas) recolourNow(ids, w, choice);
    changed();
  };

  const order = (g: Group) => (unsure(g) ? -1 : RUN_ORDER.indexOf([...g.kinds][0] as OpKind));
  const out: HTMLElement[] = [];
  // Many odd colours (a CAD file with a colour per layer): one row merges them all into one of the three.
  const odd = [...groups].filter(([id, g]) => id !== 'photo:dots' && g.kinds.has(null));
  if (odd.length >= 2) {
    const keys = new Set(odd.flatMap(([, g]) => [...g.keys]));
    const nows = new Set(odd.flatMap(([, g]) => [...g.now]));
    const merge = row(`All ${odd.length} other colours`, null, nows.size === 1 ? [...nows][0] : null, false, false, (choice) => pick(keys, choice));
    merge.classList.add('merge');
    merge.dataset.hint = 'Black, red and blue already know their jobs. This sets every other colour at once; you can still change one below.';
    out.push(merge);
  }
  for (const [id, g] of [...groups].sort((a, b) => order(a[1]) - order(b[1]))) {
    const photo = id === 'photo:dots';
    const hex = id.startsWith('#') ? id : null;
    const label = photo ? 'Photo' : hex ? (g.kinds.has(null) ? `${colourName(hex)} ${hex}` : colourName(hex)) : id;
    const now = g.now.size === 1 ? [...g.now][0] : null; // mixed choices: none lit until one is picked
    out.push(row(label, hex, now, unsure(g), photo, (choice) => pick(g.keys, choice)));
  }
  for (const key of oldUnknown) out.push(row(key, null, colorMap[key] ?? null, true, false, (choice) => { colorMap[key] = choice; changed(); }));
  $('colorList').replaceChildren(...out);
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

// ---------- copy, paste, duplicate ----------

/** Copies of `ps` with new ids, moved by (dx, dy); groups among them stay groups (with new group ids). */
function copiesOf(ps: DesignPart[], dx: number, dy: number): DesignPart[] {
  const groups = new Map<number, number>();
  return cloneParts(ps).map((q) => ({
    ...q,
    id: nextId++,
    xMm: round(q.xMm + dx),
    yMm: round(q.yMm + dy),
    ...(q.groupId !== undefined ? { groupId: groups.get(q.groupId) ?? (groups.set(q.groupId, nextId++), groups.get(q.groupId)!) } : {}),
  }));
}

function putCopies(made: DesignPart[]): void {
  if (!made.length) return;
  if (parts.length + made.length > MAX_PARTS) return warn(`That would be more than ${MAX_PARTS} parts.`);
  parts.push(...made);
  changed();
  if (made.length === 1) select(made[0].id);
  else setGroup(made.map((q) => q.id));
}

function copySelected(): void {
  const ids = selection();
  if (!ids.length) return;
  clipboard = cloneParts(parts.filter((p) => ids.includes(p.id)));
  pasteCount = 0;
  warn(`Copied ${ids.length} ${ids.length === 1 ? 'part' : 'parts'}. Ctrl+V pastes.`, '✓');
}

function paste(): void {
  if (!clipboard.length) return warn('Nothing copied yet. Select a part and press Ctrl+C.');
  pasteCount++;
  putCopies(copiesOf(clipboard, -10 * pasteCount, 10 * pasteCount));
}

function duplicateSelected(): void {
  const ids = selection();
  if (!ids.length) return;
  putCopies(copiesOf(parts.filter((p) => ids.includes(p.id)), -10, 10));
}

// ---------- mirror ----------

/** Mirror the selection left-right (x) or up-down (y). Several parts also swap places across the middle. */
function mirrorSelected(axis: 'x' | 'y'): void {
  const ids = selection();
  const boxes = ids.map((id) => [id, boxOf(id)] as const).filter((e): e is readonly [number, Box] => !!e[1]);
  if (!boxes.length) return;
  const all = unionBox(boxes.map((e) => e[1]))!;
  for (const [id, b] of boxes) {
    const p = find(id)!;
    // the flip is in the part's own frame; a quarter turn swaps which way that is on the bed
    const own = p.rotateDeg === 90 || p.rotateDeg === 270 ? (axis === 'x' ? 'y' : 'x') : axis;
    if (own === 'x') p.flipX = !p.flipX || undefined;
    else p.flipY = !p.flipY || undefined;
    if (!p.flipX) delete p.flipX;
    if (!p.flipY) delete p.flipY;
    const dx = axis === 'x' ? all[0] + all[2] - b[2] - b[0] : 0;
    const dy = axis === 'y' ? all[1] + all[3] - b[3] - b[1] : 0;
    p.xMm = round(p.xMm + dx);
    p.yMm = round(p.yMm + dy);
    flipResult(id, axis, dx, dy);
  }
  changed();
}

/** Mirror what is already on screen too, so the flip shows before the server answers. */
function flipResult(id: number, axis: 'x' | 'y', dx: number, dy: number): void {
  const ix = resultIndex();
  const i = ix.at.get(id) ?? -1;
  const b = result?.partBoxes[i];
  if (!result || i < 0 || !b) return;
  const f = ([x, y]: [number, number]): [number, number] => axis === 'x' ? [b[0] + b[2] - x + dx, y + dy] : [x + dx, b[1] + b[3] - y + dy];
  for (const l of [...ix.layers[i], ...ix.unassigned[i]]) l.paths = l.paths.map((path) => path.map(f));
  result.partBoxes[i] = [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
}

// ---------- align and space evenly ----------

type AlignHow = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom' | 'across' | 'down';
const ALIGN_LABELS: Record<AlignHow, string> = {
  left: 'Align left', centre: 'Align centres (across)', right: 'Align right', top: 'Align top', middle: 'Align middles (down)',
  bottom: 'Align bottom', across: 'Space evenly across', down: 'Space evenly down',
};

function alignSelected(how: AlignHow): void {
  const ids = selection();
  const boxes = ids.map((id) => [id, boxOf(id)] as const).filter((e): e is readonly [number, Box] => !!e[1]);
  if (boxes.length < 2) return warn('Select two or more parts to line them up (drag a box around them).');
  const [X0, Y0, X1, Y1] = unionBox(boxes.map((e) => e[1]))!;
  const moves = new Map<number, [number, number]>();
  if (how === 'across' || how === 'down') {
    const k = how === 'across' ? 0 : 1;
    const sorted = [...boxes].sort((a, b) => a[1][k] + a[1][k + 2] - b[1][k] - b[1][k + 2]);
    const total = sorted.reduce((n, [, b]) => n + b[k + 2] - b[k], 0);
    const gap = ((k ? Y1 - Y0 : X1 - X0) - total) / (sorted.length - 1);
    let at = k ? Y0 : X0;
    for (const [id, b] of sorted) {
      const d = at - b[k];
      moves.set(id, k ? [0, d] : [d, 0]);
      at += b[k + 2] - b[k] + gap;
    }
  } else {
    for (const [id, b] of boxes) {
      const d = {
        left: [X0 - b[0], 0], right: [X1 - b[2], 0], centre: [(X0 + X1 - b[0] - b[2]) / 2, 0],
        top: [0, Y0 - b[1]], bottom: [0, Y1 - b[3]], middle: [0, (Y0 + Y1 - b[1] - b[3]) / 2],
      }[how] as [number, number];
      moves.set(id, d);
    }
  }
  for (const [id, [dx, dy]] of moves) {
    const p = find(id)!;
    p.xMm = round(p.xMm + dx);
    p.yMm = round(p.yMm + dy);
    shiftResult(id, dx, dy);
  }
  jobBoxNow();
  changed();
}

function openAlignMenu(at: { x: number; y: number }): void {
  showMenu(at, (Object.keys(ALIGN_LABELS) as AlignHow[]).map((how) => [ALIGN_LABELS[how], () => alignSelected(how)]));
}
$('align').onclick = () => { const r = $('align').getBoundingClientRect(); openAlignMenu({ x: r.left, y: r.bottom + 4 }); };
$('mirror').onclick = () => mirrorSelected('x');

// ---------- the selected part: weld and outline ----------

function renderPartPanel(): void {
  const p = find(selected);
  const box = $('partPanel');
  box.hidden = !p;
  if (!p) return;
  const set = (id: string, v: boolean) => { $<HTMLInputElement>(id).checked = v; };
  const dxf = p.source.kind === 'file' && p.source.fileType === 'dxf' ? p.source : null;
  $('pUnitsRow').hidden = !dxf;
  if (dxf) {
    const said = dxf.units ?? (dxfFlavour(dxf.data.slice(0, 32)) === 'ascii' ? dxfUnitsCode(dxf.data) : 0);
    $<HTMLSelectElement>('pUnits').value = String(DXF_UNITS.includes(said as DxfUnits) ? said : 4);
  }
  set('pWeld', !!p.weld);
  set('pOutline', !!p.outline);
  set('pHole', !!p.outline?.holeMm);
  const idle = (id: string, v: number) => { const el = $<HTMLInputElement>(id); if (document.activeElement !== el) el.value = String(v); };
  idle('pDist', p.outline?.distMm ?? 3);
  idle('pHoleMm', p.outline?.holeMm ?? 5);
  $<HTMLInputElement>('pDist').disabled = !p.outline;
  $<HTMLInputElement>('pHole').disabled = !p.outline;
  $<HTMLInputElement>('pHoleMm').disabled = !p.outline?.holeMm;
}

function readPartPanel(): void {
  const p = find(selected);
  if (!p) return;
  const num = (id: string, lo: number, hi: number, dflt: number) => clamp(Number($<HTMLInputElement>(id).value) || dflt, lo, hi);
  if ($<HTMLInputElement>('pWeld').checked) p.weld = true;
  else delete p.weld;
  if ($<HTMLInputElement>('pOutline').checked) {
    const hole = $<HTMLInputElement>('pHole').checked ? num('pHoleMm', 2, 12, 5) : 0;
    p.outline = { distMm: num('pDist', 0.5, 20, 3), ...(hole ? { holeMm: hole } : {}) };
  } else delete p.outline;
  changed();
}
for (const id of ['pWeld', 'pOutline', 'pHole', 'pDist', 'pHoleMm']) $(id).addEventListener('change', readPartPanel);
$('pUnits').addEventListener('change', () => {
  const p = find(selected);
  if (p?.source.kind !== 'file' || p.source.fileType !== 'dxf') return;
  const code = Number($<HTMLSelectElement>('pUnits').value) as DxfUnits;
  if (!DXF_UNITS.includes(code)) return;
  p.source = { ...p.source, units: code }; // a new source: Undo snapshots share the old one
  changed();
});

// ---------- my material ----------

function readMaterial(): void {
  const w = Number($<HTMLInputElement>('myMatW').value);
  const h = Number($<HTMLInputElement>('myMatH').value);
  material = w > 0 && h > 0 ? { w: clamp(w, 10, machine.bedWidthMm), h: clamp(h, 10, machine.bedHeightMm) } : null;
  ws.setMaterial(material);
  save();
  render();
}
for (const id of ['myMatW', 'myMatH']) $(id).addEventListener('change', readMaterial);
$('myMatClear').onclick = () => { $<HTMLInputElement>('myMatW').value = ''; $<HTMLInputElement>('myMatH').value = ''; readMaterial(); };

// ---------- photo (beta) ----------

const MAX_PHOTO_LINES = 60_000; // the server's point budget, with room to spare

/** Show the Photo window for an image; resolves to the photo part, or null if cancelled. */
function photoDialog(f: File): Promise<Source | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(f);
    img.onerror = () => { URL.revokeObjectURL(url); warn('That picture could not be opened. Try a PNG or JPG.'); resolve(null); };
    img.onload = () => {
      let made: PhotoDots | null = null;
      let traced: TracePt[][] | null = null;
      const greys = new Map<string, Float32Array>(); // the picture decoded once per size, not on every slider move
      const tracing = () => $<HTMLSelectElement>('phMode').value === 'trace';
      const redraw = () => {
        for (const el of document.querySelectorAll<HTMLElement>('.ph-trace')) el.hidden = !tracing();
        for (const el of document.querySelectorAll<HTMLElement>('.ph-dots')) el.hidden = tracing();
        $('phAdd').textContent = tracing() ? 'Add outlines' : 'Add photo';
        if (tracing()) { traced = drawTrace(img, greys); made = null; } else { made = drawPhoto(img, greys); traced = null; }
      };
      // A slider fires many times a frame; work once per frame with its latest value.
      let raf = 0;
      const redrawSoon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; redraw(); }); };
      const baseName = f.name.replace(/\.[^.]*$/, '');
      const tracedSvg = () => {
        const op = $<HTMLSelectElement>('phOp').value as OpKind;
        return pieceSvg({ lines: traced!.map((l) => ({ kind: op, pts: [...l, l[0]] })), box: bounds(traced!) });
      };
      $('phSvg').onclick = () => { if (traced?.length) void saveBlob(new Blob([tracedSvg()], { type: 'image/svg+xml' }), `${baseName}-trace.svg`, 'SVG drawing', '.svg'); };
      $('phDxf').onclick = () => { if (traced?.length) void saveBlob(new Blob([toDxf(traced)], { type: 'application/dxf' }), `${baseName}-trace.dxf`, 'DXF drawing', '.dxf'); };
      const form = $<HTMLFormElement>('photoForm');
      const done = (src: Source | null) => {
        $('photoDlg').hidden = true;
        cancelAnimationFrame(raf);
        raf = 0;
        form.oninput = null;
        form.onsubmit = null;
        $('phCancel').onclick = null;
        URL.revokeObjectURL(url);
        resolve(src);
      };
      form.oninput = (ev) => { if ((ev.target as HTMLElement).id !== 'phOp') redrawSoon(); }; // Use as only picks the colour
      form.onsubmit = (ev) => {
        ev.preventDefault();
        if (raf) { cancelAnimationFrame(raf); raf = 0; redraw(); } // Add right after a slider move gets that move
        if (tracing()) {
          if (!traced?.length) return;
          done({ kind: 'file', name: `${baseName} (trace).svg`, fileType: 'svg', data: tracedSvg() });
          return;
        }
        if (!made) return;
        if (made.lines > MAX_PHOTO_LINES) return;
        done({ kind: 'file', name: baseName + ' (photo)', fileType: 'pbm', data: made.data, preview: made.preview() });
      };
      $('phCancel').onclick = () => done(null);
      $<HTMLSelectElement>('phOp').value = color;
      if (pictureStyle) $<HTMLSelectElement>('phMode').value = pictureStyle;
      pictureStyle = null;
      $('photoDlg').hidden = false;
      redraw();
    };
    img.src = url;
  });
}

const MAX_TRACE_POINTS = 40_000;

function traceSize(loops: TracePt[][]): string {
  const [x0, y0, x1, y1] = bounds(loops);
  return `${round(x1 - x0, 1)} × ${round(y1 - y0, 1)} mm`;
}

/** Width and height in mm, both inside `maxMm`, keeping the picture's shape (a tall picture gets narrower). */
function pictureMm(img: HTMLImageElement, maxMm: number): [number, number] {
  const aspect = img.naturalHeight / Math.max(img.naturalWidth, 1);
  const wMm = Math.min(clamp(Number($<HTMLInputElement>('phW').value) || 60, 10, maxMm), maxMm / Math.max(aspect, 1e-6));
  return [wMm, wMm * aspect];
}

/** The picture drawn at w x h on white (see-through parts of a PNG are paper, not black), as grey 0..255. */
function pictureGrey(img: HTMLImageElement, w: number, h: number, cache: Map<string, Float32Array>): Float32Array {
  const key = `${w}x${h}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.drawImage(img, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const grey = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) grey[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  cache.clear(); // one size at a time is plenty
  cache.set(key, grey);
  return grey;
}

/** Image Trace: the picture in black and white, traced into outlines (mm). Draws them in the preview. */
function drawTrace(img: HTMLImageElement, greys: Map<string, Float32Array>): TracePt[][] {
  const [wMm, hMm] = pictureMm(img, 400);
  const w = Math.min(900, Math.max(40, Math.round(Math.max(img.naturalWidth, 40)))); // trace detail, not print size
  const h = Math.max(1, Math.round((w * hMm) / wMm));
  const grey = pictureGrey(img, w, h, greys);
  const look = { brightness: Number($<HTMLInputElement>('phB').value), contrast: Number($<HTMLInputElement>('phC').value), invert: $<HTMLInputElement>('phInv').checked, mode: 'threshold' as const };
  const cut = Number($<HTMLInputElement>('phT').value);
  const g2 = adjust(grey, look);
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) ink[i] = g2[i] < cut ? 1 : 0;
  const mmPerPx = wMm / w;
  const slider = (id: string) => { const v = Number($<HTMLInputElement>(id).value); $(`${id}v`).textContent = String(v); return v; };
  slider('phT');
  // Detail 0..100: how closely the outline follows the pixels (3 px off at 0, 0.3 px at 100)
  const tolerancePx = 3 - (slider('phDetail') / 100) * 2.7;
  // Clean up 0..100: drop specks up to about 25 mm² (0 keeps everything), growing gently
  const minAreaMm = (slider('phClean') / 100) ** 2 * 25;
  const loops = trace(ink, w, h, mmPerPx, { minAreaPx: Math.max(2, minAreaMm / (mmPerPx * mmPerPx)), tolerancePx, smooth: slider('phSmooth') });
  // preview: the outlines filled, on the page's wood colour
  const prev = $<HTMLCanvasElement>('photoPrev');
  const k = Math.min(1, 700 / w);
  prev.width = Math.round(w * k);
  prev.height = Math.round(h * k);
  const pg = prev.getContext('2d')!;
  pg.fillStyle = '#fdf8ee';
  pg.fillRect(0, 0, prev.width, prev.height);
  pg.beginPath();
  const s = k / mmPerPx;
  for (const l of loops) l.forEach(([x, y], i) => (i ? pg.lineTo(x * s, y * s) : pg.moveTo(x * s, y * s)));
  pg.closePath();
  pg.fillStyle = 'rgba(37,99,235,0.35)';
  pg.fill('evenodd');
  pg.strokeStyle = '#111827';
  pg.lineWidth = 1;
  pg.stroke();
  const n = pointCount(loops);
  const tooMany = n > MAX_TRACE_POINTS;
  $('phInfo').textContent = !loops.length
    ? 'Nothing to trace. Move Threshold or Brightness until the dark parts show.'
    : tooMany ? `Too detailed (${n.toLocaleString()} points). Pick more Clean up or Smooth, or a simpler picture.`
      : `${loops.length} shapes, ${n.toLocaleString()} points, ${traceSize(loops)} (the picture is ${Math.round(wMm)} mm wide; blank edges are left off).`;
  $<HTMLButtonElement>('phAdd').disabled = !loops.length || tooMany;
  $<HTMLButtonElement>('phSvg').disabled = !loops.length;
  $<HTMLButtonElement>('phDxf').disabled = !loops.length;
  return loops;
}

/** preview: a picture of the dots, made only when the photo is added (a PNG of a big photo is slow to make). */
interface PhotoDots { data: string; preview: () => string; lines: number }

/** The picture at the chosen size and detail, as dots: draws the preview and returns the PBM. */
function drawPhoto(img: HTMLImageElement, greys: Map<string, Float32Array>): PhotoDots {
  const mm = Number($<HTMLSelectElement>('phRes').value) || 0.2;
  const [wMm, hMm] = pictureMm(img, 200);
  const w = Math.max(1, Math.round(wMm / mm));
  const h = Math.max(1, Math.round(hMm / mm));
  const grey = pictureGrey(img, w, h, greys);
  const dots = toDots(grey, w, h, {
    brightness: Number($<HTMLInputElement>('phB').value), contrast: Number($<HTMLInputElement>('phC').value),
    invert: $<HTMLInputElement>('phInv').checked, mode: $<HTMLSelectElement>('phMode').value === 'threshold' ? 'threshold' : 'dither',
  });
  const prev = $<HTMLCanvasElement>('photoPrev');
  prev.width = w;
  prev.height = h;
  const pg = prev.getContext('2d')!;
  const out = pg.createImageData(w, h);
  const o = out.data;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) { // dark dots on light wood
    if (dots[i]) { o[j] = o[j + 1] = o[j + 2] = 30; } else { o[j] = o[j + 1] = 255; o[j + 2] = 237; }
    o[j + 3] = 255;
  }
  pg.putImageData(out, 0, 0);
  const lines = runCount(dots, w, h);
  $('phInfo').textContent = lines > MAX_PHOTO_LINES
    ? `Too detailed (${lines.toLocaleString()} lines). Make it smaller, pick Fast, or use Black and white.`
    : `${Math.round(wMm)} × ${Math.round(hMm)} mm, ${lines.toLocaleString()} engrave lines. Engraves with your material's Engrave setting.`;
  $<HTMLButtonElement>('phAdd').disabled = lines > MAX_PHOTO_LINES;
  return { data: toPbm(dots, w, h, mm), preview: () => prev.toDataURL('image/png'), lines };
}

// ---------- box maker ----------

function boxSpecFromForm() {
  const n = (id: string) => Number($<HTMLInputElement>(id).value);
  const t = clamp(n('boxT') || 3, 1, 12);
  const lid = $<HTMLInputElement>('boxLid').checked;
  const inside = ($('boxForm').querySelector('input[name=boxSize]:checked') as HTMLInputElement | null)?.value === 'inside';
  const size = outsideSize(clamp(n('boxW') || 100, 20, 600), clamp(n('boxD') || 80, 20, 600), clamp(n('boxH') || 60, 15, 600), t, inside, lid);
  const finger = clamp(n('boxF') || Math.max(3 * t, 8), 3, 50);
  return { ...size, t, lid, kerf: Number($<HTMLSelectElement>('boxFit').value) || 0, finger };
}

/** Panels laid out in rows from `start` (top-right corner), leftwards, wrapping onto the bed. */
function boxLayout(panels: { w: number; h: number }[], start: { xMm: number; yMm: number }): { xMm: number; yMm: number }[] {
  const gap = 4;
  let x = start.xMm;
  let y = start.yMm;
  let rowH = 0;
  return panels.map((p) => {
    if (x - p.w < 0 && rowH > 0) { x = machine.bedWidthMm - 10; y += rowH + gap; rowH = 0; }
    const at = { xMm: round(x), yMm: round(y) };
    x -= p.w + gap;
    rowH = Math.max(rowH, p.h);
    return at;
  });
}

function updateBoxPreview(): void {
  const spec = boxSpecFromForm();
  const panels = boxPanels(spec);
  // preview only: all panels in one row
  let x = 0;
  const laid = panels.map((p) => { const at = x; x += p.w + 4; return { x: at, p }; });
  const W = x - 4;
  const H = Math.max(...panels.map((p) => p.h));
  const svg = $('boxPreview');
  svg.setAttribute('viewBox', `-2 -2 ${W + 4} ${H + 4}`);
  svg.innerHTML = laid.map(({ x: px, p }) => `<path d="${p.d}" transform="translate(${px} 0)" fill="rgba(180,120,60,.15)" stroke="currentColor" stroke-width="${Math.max(W, H) / 400}"/>`).join('');
  const thick = materials.find((mm) => mm.id === materialId)?.thicknessMm;
  $('boxInfo').textContent = `${panels.length} panels, outside ${round(spec.w, 1)} × ${round(spec.d, 1)} × ${round(spec.h, 1)} mm, ${round(spec.t, 1)} mm material`
    + (thick && Math.abs(thick - spec.t) > 0.05 ? ` (your material is ${thick} mm: measure it, boards vary)` : '')
    + '. Everything is Cut through.';
}

$('toolBoxMaker').onclick = () => {
  const thick = materials.find((mm) => mm.id === materialId)?.thicknessMm;
  if (!$<HTMLInputElement>('boxT').value) $<HTMLInputElement>('boxT').value = String(thick ?? 3);
  if (!$<HTMLInputElement>('boxF').value) $<HTMLInputElement>('boxF').value = String(round(Math.max(3 * (thick ?? 3), 8), 1));
  updateBoxPreview();
  $('boxDlg').hidden = false;
  $<HTMLInputElement>('boxW').focus();
};
$('boxCancel').onclick = () => { $('boxDlg').hidden = true; };
$('boxForm').addEventListener('input', updateBoxPreview);
$<HTMLFormElement>('boxForm').onsubmit = (ev) => {
  ev.preventDefault();
  const spec = boxSpecFromForm();
  const panels = boxPanels(spec);
  if (panels.some((p) => p.w > machine.bedWidthMm - 20 || p.h > machine.bedHeightMm - 20)) return warn('That box is too big for the laser bed. Make it smaller.');
  if (parts.length + panels.length > MAX_PARTS) return warn(`That would be more than ${MAX_PARTS} parts.`);
  const spots = boxLayout(panels, newSpot());
  const gid = nextId++;
  const made: DesignPart[] = panels.map((p, i) => ({
    id: nextId++,
    source: { kind: 'path', name: `Box ${p.name}`, d: p.d, vb: { x: 0, y: 0, w: p.w, h: p.h }, closed: true, wMm: p.w, hMm: p.h, op: 'cut', box: true },
    ...spots[i],
    scale: 1,
    rotateDeg: 0,
    groupId: gid,
  }));
  parts.push(...made);
  $('boxDlg').hidden = true;
  changed();
  setGroup(made.map((q) => q.id));
  warn(`Box made: ${made.length} panels, grouped. Ungroup to move one on its own.`, '✓');
};

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

/** The "Updating" sign over the bed: kids see their change is on its way, not ignored. */
function setBusy(on: boolean): void {
  $('busy').hidden = !on;
}

function schedule(delay = 400): void {
  pending = true;
  if (materialId && getPhrase() && parts.length) setBusy(true); // at once, not after the pause
  clearTimeout(timer);
  timer = window.setTimeout(run, delay);
}

function buildRequest(): { req: ProcessRequest; files: Blob[]; ids: number[] } {
  const files: Blob[] = [];
  const ids: number[] = [];
  const reqParts: Part[] = [];
  const fileOf = new Map<string, number>();
  for (const p of parts) {
    const pl: Placement & PartExtras = { xMm: p.xMm, yMm: p.yMm, scale: p.scale, rotateDeg: p.rotateDeg };
    if (p.scaleY !== undefined) pl.scaleY = p.scaleY;
    if (p.flipX) pl.flipX = true;
    if (p.flipY) pl.flipY = true;
    if (p.weld) pl.weld = true;
    if (p.outline) pl.outline = { ...p.outline };
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
        const dxf = s.kind === 'file' && s.fileType === 'dxf';
        const pbm = s.kind === 'file' && s.fileType === 'pbm';
        const body = pbm || (dxf && dxfFlavour(data.slice(0, 32)) === 'binary') ? binaryStringToBytes(data) : data;
        fileIndex = files.push(new Blob([body as BlobPart], { type: pbm ? 'image/x-portable-bitmap' : dxf ? 'application/dxf' : 'image/svg+xml' })) - 1;
        fileOf.set(data, fileIndex);
      }
      if (s.kind === 'shape' || s.kind === 'path') { pl.scale = 1; delete pl.scaleY; }
      const own = s.kind === 'file' && s.colors && Object.keys(s.colors).length ? { colorMap: s.colors } : {};
      const units = s.kind === 'file' && s.fileType === 'dxf' && s.units ? { dxfUnits: s.units } : {};
      reqParts.push({ ...pl, kind: 'file', fileIndex, fileType: s.kind === 'file' ? s.fileType : 'svg', ...own, ...units });
    }
    ids.push(p.id);
  }
  return { req: { materialId, parts: reqParts, colorMap, powerChoice, ...(joinLines ? {} : { joinLines: false }) }, files, ids };
}

async function run(): Promise<void> {
  const { req, files, ids } = buildRequest();
  if (!materialId || !req.parts.length) {
    result = null;
    resultIds = [];
    pending = false;
    setBusy(false);
    render();
    return;
  }
  // The site works without the phrase. Only processing (the server's container) needs it.
  if (!getPhrase()) {
    pending = false;
    setBusy(false);
    ws.clearLive();
    render();
    return;
  }
  const mine = ++seq;
  setBusy(true);
  const ctx = sigCtx();
  const sigs = ids.map((id) => partSig(find(id)!, ctx));
  try {
    const res = await processDesign(req, files);
    if (mine !== seq) return; // a newer request superseded this one
    result = res;
    resultIds = ids;
    notes = [];
    remember(res, ids, sigs);
  } catch (e) {
    if (mine !== seq) return;
    result = null;
    resultIds = [];
    notes = [(e as Error).message];
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      setPhrase(''); // wrong or expired: the phrase card at the top of the side panel asks again
    }
  }
  pending = false;
  setBusy(false);
  ws.clearLive();
  render();
}

function askPhrase(): void {
  $('gateErr').textContent = '';
  $('gate').hidden = false;
  $<HTMLInputElement>('phrase').focus();
}
$('phraseBtn').onclick = askPhrase;
$('phraseChange').onclick = askPhrase;

const joinBox = $<HTMLInputElement>('joinLines');
joinBox.onchange = () => { joinLines = joinBox.checked; save(); schedule(); render(); };

// ---------- side panel: drag its edge to resize, fold any box away ----------

const PANELS_W = 'uml.panelsW';
const PANELS_SHUT = 'uml.panelsShut';
const workarea = document.querySelector<HTMLElement>('.workarea')!;
function setPanelsW(w: number): number {
  w = clamp(Math.round(w), 240, Math.max(240, Math.min(720, window.innerWidth - 420)));
  workarea.style.setProperty('--panels-w', `${w}px`);
  return w;
}
try {
  const w = Number(localStorage.getItem(PANELS_W));
  if (w) setPanelsW(w);
} catch { /* storage blocked: default width */ }
const grip = $('panelGrip');
grip.onpointerdown = (e) => {
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  grip.classList.add('on');
  let w = 0;
  grip.onpointermove = (ev) => { w = setPanelsW(workarea.getBoundingClientRect().right - ev.clientX); };
  grip.onpointerup = grip.onpointercancel = () => {
    grip.onpointermove = grip.onpointerup = grip.onpointercancel = null;
    grip.classList.remove('on');
    try { if (w) localStorage.setItem(PANELS_W, String(w)); } catch { /* fine */ }
  };
};
grip.ondblclick = () => {
  workarea.style.removeProperty('--panels-w');
  try { localStorage.removeItem(PANELS_W); } catch { /* fine */ }
};
{
  let shut: string[] = [];
  try { shut = JSON.parse(localStorage.getItem(PANELS_SHUT) ?? '[]'); } catch { /* fine */ }
  for (const d of document.querySelectorAll<HTMLDetailsElement>('.panels details.panel')) {
    if (shut.includes(d.id)) d.open = false;
    d.addEventListener('toggle', () => {
      const now = [...document.querySelectorAll<HTMLDetailsElement>('.panels details.panel')].filter((x) => !x.open).map((x) => x.id);
      try { localStorage.setItem(PANELS_SHUT, JSON.stringify(now)); } catch { /* fine */ }
    });
  }
}

$('gateLater').onclick = () => { $('gate').hidden = true; };

/** Move one part's lines already on screen. Call jobBoxNow() after moving a batch. */
function shiftResult(id: number, dx: number, dy: number): void {
  const ix = resultIndex();
  const i = ix.at.get(id) ?? -1;
  if (!result || i < 0) return;
  const b = result.partBoxes[i];
  if (b) result.partBoxes[i] = [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
  for (const l of [...ix.layers[i], ...ix.unassigned[i]]) l.paths = l.paths.map((path) => path.map(([x, y]) => [x + dx, y + dy] as [number, number]));
}

/** The whole job's box from the parts' boxes (once per batch: moving 5000 pieces one by one was slow). */
function jobBoxNow(): void {
  if (!result) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of result.partBoxes) {
    if (!b) continue;
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
  }
  result.bboxMm = x0 <= x1 ? [x0, y0, x1, y1] : null;
}

// ---------- rendering ----------

function render(): void {
  const views = parts.map(viewOf);
  ws.setParts(views, unionBox(views.map((v) => v.box)), !pending && !!result?.errors.length);
  const hasPhrase = !!getPhrase();
  $('phraseNeed').hidden = hasPhrase;
  $('phraseOk').hidden = !hasPhrase;
  $('phraseCard').classList.toggle('ok', hasPhrase);
  joinBox.checked = joinLines;
  renderSizebar();
  renderLayers();
  renderColors();
  const errors = [...(result?.errors ?? [])];
  const warnings = [...(result?.warnings ?? [])];
  const job = unionBox(views.map((v) => v.box));
  if (material && job && (job[2] - job[0] > material.w + 0.5 || job[3] - job[1] > material.h + 0.5)) {
    warnings.push(`Your design (${round(job[2] - job[0], 0)} × ${round(job[3] - job[1], 0)} mm) is bigger than your material (${material.w} × ${material.h} mm).`);
  }
  const li = (t: string, cls: string) => Object.assign(document.createElement('li'), { textContent: t, className: cls });
  $('messages').replaceChildren(...errors.map((e) => li(e, 'err')), ...notes.map((n) => li(n, 'note')), ...warnings.map((w) => li(w, 'warn')));
  $('estimate').textContent = result?.rd && !pending ? `About ${fmtTime(result.estimateS)} on the laser.` : '';
  $('rotate').toggleAttribute('disabled', selected === null);
  renderSelectButtons();
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
const PORT_KEY = 'uml.laserPort';

function rememberedPort(): PortId | null {
  try {
    const v = JSON.parse(localStorage.getItem(PORT_KEY) ?? 'null');
    return v && typeof v.vid === 'number' ? { vid: v.vid, pid: typeof v.pid === 'number' ? v.pid : null } : null;
  } catch {
    return null;
  }
}

async function connectLaser(pick: 'auto' | 'filtered' | 'all'): Promise<void> {
  if (link?.connected) await link.disconnect();
  try {
    link = new LaserLink({ baud: machine.baud, magic: machine.swizzleMagic, onDisconnect: () => setConnected(false) });
    await link.connect(pick, rememberedPort());
    pickerCancelled = false;
    try { if (link.portId) localStorage.setItem(PORT_KEY, JSON.stringify(link.portId)); } catch { /* fine */ }
    setConnected(true);
  } catch (e) {
    setConnected(false);
    if ((e as Error).name === 'NotFoundError') {
      // Picker cancelled, maybe because the laser wasn't listed. Next click shows every port.
      if (!pickerCancelled) warn('Laser not in the list? Press Choose USB port… to see every USB port.');
      pickerCancelled = true;
    } else warn(`${(e as Error).message} Or press Choose USB port… to pick the laser again.`);
    render();
  }
}

$('connect').onclick = async () => {
  if (link?.connected) {
    await link.disconnect();
    setConnected(false);
    return;
  }
  await connectLaser(pickerCancelled ? 'all' : 'auto');
};
$('pickPort').onclick = () => void connectLaser('all');

function setConnected(on: boolean): void {
  $('status').textContent = on ? 'Laser connected' : 'Laser not connected';
  const id = on ? link?.portId : null;
  $('status').title = id ? `USB ${id.vid.toString(16).padStart(4, '0')}:${(id.pid ?? 0).toString(16).padStart(4, '0')}` : '';
  $('status').classList.toggle('ok', on);
  $('connect').textContent = on ? 'Disconnect' : 'Connect laser';
  $('stop').hidden = !on;
  $('stopTop').hidden = !on;
  updateButtons();
}

function updateButtons(): void {
  const hasJob = !!result?.rd && !pending && !result.errors.length;
  const connected = !!link?.connected;
  const idle = !link?.sending;
  const ack = $<HTMLInputElement>('ack').checked;
  const toPanel = !!machine.sendToPanel;
  $('panelNameRow').hidden = !toPanel;
  const nameBox = $<HTMLInputElement>('panelName');
  if (toPanel && !panelNameTyped && document.activeElement !== nameBox) nameBox.value = suggestedPanelName();
  const named = !toPanel || !!cleanPanelName(nameBox.value);
  $<HTMLButtonElement>('send').disabled = !(hasJob && connected && idle && ack && named);
  $<HTMLButtonElement>('downloadRd').disabled = !hasJob;
  const steps: [string, boolean][] = [
    ['Pick your material', !!materialId],
    ['Enter the class phrase', !!getPhrase()],
    ['Add a design with no problems', hasJob],
    ['Connect the laser', connected],
    ['Promise to stay with the laser', ack],
    ['Send, then Frame and Start on the laser', false],
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

async function sendBytes(b64: string): Promise<boolean> {
  if (!link) return false;
  const panelName = machine.sendToPanel ? cleanPanelName($<HTMLInputElement>('panelName').value) : '';
  const prog = $<HTMLProgressElement>('progress');
  prog.hidden = false;
  prog.value = 0;
  updateButtons();
  try {
    const onProgress = (s: number, t: number) => { prog.value = s / t; };
    if (panelName) {
      const replaced = await link.sendToPanel(fromBase64(b64), panelName, onProgress);
      notes = [`Saved on the laser as ${panelName}${replaced ? ', replacing the old file with that name' : ''}. On the laser, pick it, press Frame to check it fits, then press Start. Watch the laser the whole time.`];
    } else {
      await link.send(fromBase64(b64), onProgress);
      notes = ['Loaded on the laser. On the laser, press Frame and check it fits your material, then press Start. Watch the laser the whole time.'];
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

// The job as a Ruida .rd file, for a laser in another room (the panel's USB port, or RDWorks).
// It is the same file Send would load, with the teacher's limits already applied.
$('downloadRd').onclick = async () => {
  if (!result?.rd || pending || result.errors.length) return;
  const name = (cleanPanelName($<HTMLInputElement>('panelName').value) || suggestedPanelName() || 'DESIGN').replace(/ /g, '');
  const ok = await saveBlob(new Blob([fromBase64(result.rd) as BlobPart], { type: 'application/octet-stream' }), `${name}.rd`, 'Ruida laser file', '.rd');
  if (ok) warn('Laser file saved. Give it to your teacher: it opens on the laser from a USB stick.', '✓');
};

// Export for teacher: one zip with the design (to open, fix or send) and, when it is ready, the laser file,
// plus a note saying what state it was in. Works even when something is wrong: that's when it's needed.
$('exportTeacher').onclick = async () => {
  if (!parts.length) return warn('Add something to the workspace first.');
  const name = designName();
  const enc = new TextEncoder();
  const ready = !!result?.rd && !pending && !result.errors.length;
  const rdName = `${(cleanPanelName($<HTMLInputElement>('panelName').value) || suggestedPanelName() || 'DESIGN').replace(/ /g, '')}.rd`;
  const mat = materials.find((x) => x.id === materialId);
  const problems = [...(result?.errors ?? []), ...(result?.warnings ?? []), ...(pending ? ['It was still updating when this was saved.'] : []), ...(!ready && !getPhrase() ? ['The class phrase was not entered, so the laser file could not be made.'] : [])];
  const note = [
    'uploadmylaser: a job for your teacher',
    '',
    `Design: ${name}`,
    `Saved: ${new Date().toLocaleString()}`,
    `Material: ${mat?.name ?? 'not picked'}`,
    `Laser time: ${ready ? `about ${fmtTime(result!.estimateS)}` : 'not ready'}`,
    '',
    problems.length ? 'Problems when it was saved:' : 'No problems when it was saved.',
    ...problems.map((t) => `- ${t}`),
    '',
    'Files:',
    `- ${name}${DESIGN_EXT}: open it at uploadmylaser.com with Open... to look at it, fix it or send it.`,
    ready ? `- ${rdName}: the finished laser job, for the laser's USB port. It has the class limits in it.` : '- No laser file: open the design to fix it first.',
    '',
  ].join('\r\n');
  const files = [
    { name: `${name}${DESIGN_EXT}`, data: enc.encode(designJson()) },
    ...(ready ? [{ name: rdName, data: fromBase64(result!.rd!) }] : []),
    { name: 'READ ME.txt', data: enc.encode(note) },
  ];
  const ok = await saveBlob(new Blob([zip(files) as BlobPart], { type: 'application/zip' }), `${name}-for-teacher.zip`, 'Zip file', '.zip');
  if (ok) warn(ready ? 'Saved one file for your teacher: your design and the laser file.' : 'Saved one file for your teacher: your design and a note about what is wrong.', '✓');
};

$('send').onclick = async () => {
  if (!result?.rd) return;
  await sendBytes(result.rd);
  $<HTMLInputElement>('ack').checked = false; // confirm again before the next piece
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
  if ((e.ctrlKey || e.metaKey) && k === 'v') { e.preventDefault(); paste(); return; }
  if ((e.ctrlKey || e.metaKey) && (k === 'c' || k === 'd') && selection().length) {
    e.preventDefault();
    if (k === 'c') copySelected();
    else duplicateSelected();
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
  if (e.key === 'Escape' && !$('ctxmenu').hidden) { closeMenu(); return; }
  if (e.key === 'Escape') {
    // like AutoCAD: Esc ends the drawing and keeps what was drawn
    if (ws.drawing) { ws.finishDraft(); setTool('select'); return; }
    for (const id of ['helpDlg', 'libraryDlg', 'patternDlg', 'boxDlg']) $(id).hidden = true;
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
    jobBoxNow();
    changed({ merge: `nudge${ids.join(',')}` });
  }
});

// ---------- warnings on the bed ----------

let toastTimer = 0;
/** A warning the student can't miss: on the bed for a few seconds, and in the Laser panel. */
function warn(text: string, mark = '⚠'): void {
  notes = [text];
  const t = $('toast');
  t.textContent = `${mark} ${text}`;
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
        ? 'Arrange your design. When you are ready, enter the class phrase at the top right to check it.'
        : 'Drag parts to move them. Drag on empty bed to box-select; right-click for more. Scroll to zoom; Shift+drag or the middle button pans. Then connect the laser and Send.';
}

// ---------- saving the design on this Chromebook ----------

let saveTimer = 0;
/** Kept on this Chromebook a moment after the last change (a big design is slow to write), and at once
 *  when the tab is closed or hidden. */
function save(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, 500);
}

function saveNow(): void {
  clearTimeout(saveTimer);
  saveTimer = 0;
  try {
    localStorage.setItem(STORE, JSON.stringify({ parts, colorMap, materialId, color, locked, unit, material, joinLines }));
  } catch {
    /* too big for storage: the design still works, it just won't survive a reload */
  }
}
window.addEventListener('pagehide', () => { if (saveTimer) saveNow(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) saveNow(); });

function restore(): void {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (!s || !Array.isArray(s.parts)) return;
    parts = s.parts;
    colorMap = s.colorMap ?? {};
    materialId = s.materialId ?? '';
    const mt = s.material;
    if (mt && Number(mt.w) > 0 && Number(mt.h) > 0) material = { w: Number(mt.w), h: Number(mt.h) };
    if (s.color in OP_LABELS) color = s.color;
    if (s.locked === false) locked = false;
    if (s.joinLines === false) joinLines = false;
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
