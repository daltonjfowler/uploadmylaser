// Teacher presets: validating materials and machine config, and what students may see of them.
// Pure (no bindings), so test/presets.test.mjs can check the banned-material rule.

import type { MachineConfig, Material, OpKind, OpSettings, PublicMaterial } from '../shared/contracts.ts';
import { HttpError } from './http.ts';
import { BANNED_MATERIAL_WORDS, DEFAULT_MACHINE } from './seed.ts';

export const OPS: readonly OpKind[] = ['cut', 'score', 'engrave'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function num(v: unknown, lo: number, hi: number, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new HttpError(400, `${what} must be between ${lo} and ${hi}.`);
  return v;
}

// Safety invariant 4: banned materials (PVC, vinyl, ...) are refused here.
export function bannedWordIn(name: string): string | undefined {
  return BANNED_MATERIAL_WORDS.find((w) => new RegExp(`\\b${w}\\b`, 'i').test(name));
}

export function validateMaterials(body: unknown, mc: MachineConfig): Material[] {
  if (!Array.isArray(body) || body.length > 50) throw new HttpError(400, 'Expected a list of materials.');
  const ids = new Set<string>();
  return body.map((x: unknown) => {
    if (!isObj(x)) throw new HttpError(400, 'Expected a list of materials.');
    const name = String(x.name ?? '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'Every material needs a name.');
    const banned = bannedWordIn(name);
    if (banned) throw new HttpError(400, `"${name}": ${banned.toUpperCase()} is not safe to laser.`);
    const id = String(x.id ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
    if (!id || ids.has(id)) throw new HttpError(400, `"${name}" needs a unique id.`);
    ids.add(id);
    const ops: Partial<Record<OpKind, OpSettings>> = {};
    const xops = isObj(x.ops) ? x.ops : {};
    for (const k of OPS) {
      const o = xops[k];
      if (o == null) continue;
      if (!isObj(o)) throw new HttpError(400, `${name} ${k} settings are not valid.`);
      const max = num(o.powerMaxPct, 0, mc.absoluteMaxPowerPct, `${name} ${k} max power`);
      let studentMinPct: number | undefined;
      let studentMaxPct: number | undefined;
      if (o.studentMinPct != null || o.studentMaxPct != null) {
        studentMinPct = num(o.studentMinPct, 0, mc.absoluteMaxPowerPct, `${name} ${k} student min power`);
        studentMaxPct = num(o.studentMaxPct, studentMinPct, mc.absoluteMaxPowerPct, `${name} ${k} student max power`);
      }
      ops[k] = {
        studentMinPct,
        studentMaxPct,
        speedMmS: num(o.speedMmS, mc.minSpeedMmS, 1000, `${name} ${k} speed`),
        powerMinPct: num(o.powerMinPct, 0, max, `${name} ${k} min power`),
        powerMaxPct: max,
        passes: Math.round(num(o.passes ?? 1, 1, 10, `${name} ${k} passes`)),
        hatchMm: k === 'engrave' ? num(o.hatchMm ?? 0.15, 0.05, 2, `${name} line spacing`) : undefined,
        airAssist: o.airAssist !== false,
      };
    }
    if (!Object.keys(ops).length) throw new HttpError(400, `"${name}" needs at least one operation.`);
    return { id, name, thicknessMm: num(x.thicknessMm, 0, 50, `${name} thickness`), enabled: x.enabled === true, ops };
  });
}

export function validateMachine(body: unknown): MachineConfig {
  const b = isObj(body) ? body : {};
  const origins = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
  if (!origins.includes(b.origin as (typeof origins)[number])) throw new HttpError(400, 'Invalid origin.');
  return {
    bedWidthMm: num(b.bedWidthMm, 50, 2000, 'Bed width'),
    bedHeightMm: num(b.bedHeightMm, 50, 2000, 'Bed height'),
    origin: b.origin as MachineConfig['origin'],
    jobOriginMode: b.jobOriginMode === 'absolute' ? 'absolute' : 'relative',
    swizzleMagic: num(b.swizzleMagic, 0, 255, 'Swizzle magic'),
    baud: num(b.baud, 1200, 3_000_000, 'Baud'),
    maxJobMinutes: num(b.maxJobMinutes, 1, 180, 'Max job minutes'),
    absoluteMaxPowerPct: num(b.absoluteMaxPowerPct, 1, 100, 'Absolute max power'),
    minSpeedMmS: num(b.minSpeedMmS, 0.5, 100, 'Min speed'),
    travelSpeedMmS: num(b.travelSpeedMmS ?? DEFAULT_MACHINE.travelSpeedMmS, 10, 2000, 'Travel speed'),
    sendToPanel: b.sendToPanel === true,
  };
}

// No speeds, and power only where the teacher allows a student range.
export function publicMaterials(mats: Material[]): PublicMaterial[] {
  return mats.filter((x) => x.enabled).map((x) => {
    const adjustable: PublicMaterial['adjustable'] = {};
    for (const k of OPS) {
      const o = x.ops[k];
      if (o?.studentMinPct != null && o.studentMaxPct != null) {
        adjustable[k] = { minPct: o.studentMinPct, maxPct: o.studentMaxPct, defaultPct: o.powerMaxPct };
      }
    }
    return { id: x.id, name: x.name, thicknessMm: x.thicknessMm, ops: OPS.filter((k) => x.ops[k]), adjustable };
  });
}

export function publicMachine(mc: MachineConfig) {
  return {
    bedWidthMm: mc.bedWidthMm, bedHeightMm: mc.bedHeightMm, swizzleMagic: mc.swizzleMagic, baud: mc.baud,
    maxJobMinutes: mc.maxJobMinutes, origin: mc.origin, jobOriginMode: mc.jobOriginMode,
    sendToPanel: mc.sendToPanel === true,
  };
}
