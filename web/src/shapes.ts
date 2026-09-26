// Box and Circle tools: the browser draws them as tiny SVG files, so the container needs no new code.
import type { OpKind } from '../../shared/contracts';

export type ShapeKind = 'box' | 'circle';

const STROKE: Record<OpKind, string> = { cut: '#000000', score: '#ff0000', engrave: '#0000ff' };

export function shapeSvg(shape: ShapeKind, wMm: number, hMm: number, op: OpKind): string {
  const w = round(wMm);
  const h = round(hMm);
  // Engrave fills the shape; cut and mark follow its outline.
  const paint = op === 'engrave' ? `fill="${STROKE[op]}" stroke="none"` : `fill="none" stroke="${STROKE[op]}" stroke-width="0.1"`;
  const el = shape === 'box'
    ? `<rect x="0" y="0" width="${w}" height="${h}" ${paint}/>`
    : `<ellipse cx="${round(w / 2)}" cy="${round(h / 2)}" rx="${round(w / 2)}" ry="${round(h / 2)}" ${paint}/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">${el}</svg>`;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

export interface ViewBox { x: number; y: number; w: number; h: number }

/** A library shape, line or curve as an SVG file, stretched from its own bounds `vb` to w x h mm. */
export function pathSvg(d: string, vb: ViewBox, wMm: number, hMm: number, op: OpKind, closed: boolean): string {
  const w = Math.max(round(wMm), 0.01);
  const h = Math.max(round(hMm), 0.01);
  const sx = vb.w > 1e-6 ? w / vb.w : 1;
  const sy = vb.h > 1e-6 ? h / vb.h : 1;
  const paint = op === 'engrave' && closed
    ? `fill="${STROKE[op]}" fill-rule="evenodd" stroke="none"`
    : `fill="none" stroke="${STROKE[op]}" stroke-width="0.1"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">`
    + `<path d="${d}" transform="scale(${round(sx * 1e4) / 1e4} ${round(sy * 1e4) / 1e4}) translate(${-vb.x} ${-vb.y})" ${paint}/></svg>`;
}
