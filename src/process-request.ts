// Strict validation of the student's `request` JSON for POST /api/process. The result is REBUILT
// from whitelisted fields only (never spread a student object), so anything extra, like a
// `powerMaxPct` or `speedMmS` smuggled into a part, is dropped. Safety invariant 1: students never
// send power or speed; the Worker resolves Material + MachineConfig from KV.
// Pure: test/process-request.test.mjs runs it.

import type { ColorChoice, OpKind, Part, Placement, ProcessRequest, TextFontId } from '../shared/contracts.ts';
import { MAX_PARTS, TEXT_FONTS } from '../shared/contracts.ts';
import { HttpError } from './http.ts';
import { OPS } from './presets.ts';

export const MAX_REQUEST_JSON_BYTES = 64 * 1024;
export const MAX_COORD_MM = 5000;
export const MAX_SCALE = 20;
export const MAX_TEXT_CHARS = 60;
export const MAX_TEXT_HEIGHT_MM = 200;
export const MAX_COLORS = 100;
export const MAX_COLOR_KEY_CHARS = 200;
export const MAX_MATERIAL_ID_CHARS = 64;

const COLOR_CHOICES: readonly string[] = ['cut', 'score', 'engrave', 'ignore'];
const FONT_IDS: readonly string[] = TEXT_FONTS.map((f) => f.id);
const ROTATIONS: readonly number[] = [0, 90, 180, 270];
// Control characters, except newline (in case the Text tool ever allows two lines).
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isOp = (v: unknown): v is OpKind => typeof v === 'string' && (OPS as readonly string[]).includes(v);

function bad(message: string): never {
  throw new HttpError(400, message);
}

// `raw` is the multipart `request` field; `fileFields` holds the N of every `file<N>` present.
export function parseProcessRequest(raw: unknown, fileFields: ReadonlySet<number>): ProcessRequest {
  if (typeof raw !== 'string' || raw.length === 0) bad('Your design did not arrive. Try again.');
  if (raw.length > MAX_REQUEST_JSON_BYTES) bad('Your design has too many settings. Try removing some parts.');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    bad('Your design did not arrive in one piece. Try again.');
  }
  return validateProcessRequest(body, fileFields);
}

export function validateProcessRequest(body: unknown, fileFields: ReadonlySet<number>): ProcessRequest {
  if (!isObj(body)) bad('Your design did not arrive in one piece. Try again.');

  const materialId = body.materialId;
  if (typeof materialId !== 'string' || !materialId || materialId.length > MAX_MATERIAL_ID_CHARS) bad('Pick a material first.');

  const parts = body.parts;
  if (!Array.isArray(parts) || parts.length === 0) bad('Add something to the workspace first.');
  if (parts.length > MAX_PARTS) bad(`That is too many things on the workspace. The limit is ${MAX_PARTS}.`);

  const out: ProcessRequest = { materialId, parts: parts.map((p, i) => validatePart(p, i + 1, fileFields)) };
  const colorMap = validateColorMap(body.colorMap);
  if (colorMap) out.colorMap = colorMap;
  const powerChoice = validatePowerChoice(body.powerChoice);
  if (powerChoice) out.powerChoice = powerChoice;
  return out;
}

function validatePlacement(p: Record<string, unknown>, n: number): Placement {
  const { xMm, yMm, scale, scaleY, rotateDeg } = p;
  if (!finite(xMm) || !finite(yMm) || Math.abs(xMm) > MAX_COORD_MM || Math.abs(yMm) > MAX_COORD_MM) {
    bad(`Part ${n} is too far off the workspace. Drag it back on.`);
  }
  if (!finite(scale) || scale <= 0 || scale > MAX_SCALE) bad(`Part ${n} is sized too big or too small.`);
  if (scaleY !== undefined && (!finite(scaleY) || scaleY <= 0 || scaleY > MAX_SCALE)) bad(`Part ${n} is sized too big or too small.`);
  if (typeof rotateDeg !== 'number' || !ROTATIONS.includes(rotateDeg)) bad(`Part ${n} can only turn in quarter turns.`);
  const out: Placement = { xMm, yMm, scale, rotateDeg: rotateDeg as Placement['rotateDeg'] };
  if (scaleY !== undefined) out.scaleY = scaleY as number;
  return out;
}

function validatePart(p: unknown, n: number, fileFields: ReadonlySet<number>): Part {
  if (!isObj(p)) bad(`Part ${n} is not readable. Try removing it and adding it again.`);
  const placement = validatePlacement(p, n);

  if (p.kind === 'file') {
    const { fileIndex, fileType } = p;
    if (typeof fileIndex !== 'number' || !Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= MAX_PARTS || !fileFields.has(fileIndex)) {
      bad(`The file for part ${n} is missing. Try adding it again.`);
    }
    if (fileType !== 'svg' && fileType !== 'dxf') bad(`Part ${n} must be an SVG or DXF file.`);
    return { kind: 'file', fileIndex, fileType, ...placement };
  }

  if (p.kind === 'text') {
    const t = p.text;
    if (!isObj(t)) bad(`Part ${n} is missing its text.`);
    const { value, font, heightMm, op } = t;
    if (typeof value !== 'string' || value.trim().length === 0) bad(`Part ${n} needs some text.`);
    if ([...value].length > MAX_TEXT_CHARS) bad(`Text can be at most ${MAX_TEXT_CHARS} letters.`);
    if (CONTROL.test(value)) bad('Text can only use normal letters, numbers and symbols.');
    if (typeof font !== 'string' || !FONT_IDS.includes(font)) bad(`Pick a font for part ${n}.`);
    if (!finite(heightMm) || heightMm < 1 || heightMm > MAX_TEXT_HEIGHT_MM) bad(`Text height must be between 1 and ${MAX_TEXT_HEIGHT_MM} mm.`);
    if (!isOp(op)) bad(`Pick Cut, Mark or Engrave for part ${n}.`);
    return { kind: 'text', text: { value, font: font as TextFontId, heightMm, op }, ...placement };
  }

  return bad(`Part ${n} is not a file or text.`);
}

function validateColorMap(v: unknown): Record<string, ColorChoice> | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) bad('The colour choices did not arrive in one piece. Try again.');
  const entries = Object.entries(v);
  if (entries.length > MAX_COLORS) bad('Your design has too many colours. Try using fewer.');
  for (const [k, c] of entries) {
    if (k.length === 0 || k.length > MAX_COLOR_KEY_CHARS) bad('One of the colours in your design has a strange name.');
    if (typeof c !== 'string' || !COLOR_CHOICES.includes(c)) bad('Pick Cut, Mark, Engrave or Ignore for each colour.');
  }
  // fromEntries defines own properties, so a "__proto__" key stays plain data.
  return Object.fromEntries(entries) as Record<string, ColorChoice>;
}

// Only op keys are kept; the container clamps each value to the teacher's student range.
function validatePowerChoice(v: unknown): Partial<Record<OpKind, number>> | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) bad('The power choice did not arrive in one piece. Try again.');
  const out: Partial<Record<OpKind, number>> = {};
  for (const k of OPS) {
    const x = v[k];
    if (x === undefined) continue;
    if (!finite(x) || x < 0 || x > 100) bad('Power must be a number between 0 and 100.');
    out[k] = x;
  }
  return out;
}
