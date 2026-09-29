// POST /api/teacher/testcard: a material test card (grid of squares at different power and speed).
// Teacher only (the route is behind teacherGate). Rebuilt from whitelisted fields; the container
// still clamps every square to the machine's power ceiling and minimum speed.
import type { OpKind } from '../shared/contracts.ts';
import { HttpError } from './http.ts';
import { OPS } from './presets.ts';

export interface TestCardBody { op: OpKind; powers: number[]; speeds: number[]; hatchMm?: number }

const bad = (msg: string): never => { throw new HttpError(400, msg); };
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function validateTestCard(body: unknown): TestCardBody {
  if (typeof body !== 'object' || body === null) bad('Send the test card settings.');
  const b = body as Record<string, unknown>;
  if (typeof b.op !== 'string' || !(OPS as readonly string[]).includes(b.op)) bad('Pick Engrave, Mark or Cut through.');
  const list = (v: unknown, what: string, lo: number, hi: number): number[] => {
    if (!Array.isArray(v) || v.length < 2 || v.length > 7) bad(`Use 2 to 7 ${what}.`);
    const arr = v as unknown[];
    if (!arr.every((x) => finite(x) && x >= lo && x <= hi)) bad(`Each ${what.replace(/s$/, '')} must be ${lo} to ${hi}.`);
    return arr as number[];
  };
  const out: TestCardBody = { op: b.op as OpKind, powers: list(b.powers, 'powers', 1, 100), speeds: list(b.speeds, 'speeds', 1, 1000) };
  const hatch = b.hatchMm;
  if (hatch !== undefined) {
    if (!finite(hatch) || hatch < 0.03 || hatch > 1) return bad('Line spacing must be 0.03 to 1 mm.');
    out.hatchMm = hatch;
  }
  return out;
}
