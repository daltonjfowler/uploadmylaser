// Shapes library, plus the Line and Curve tools' path helpers. Every one becomes a small SVG in the
// browser (see pathSvg in shapes.ts), so the server treats them like any uploaded file.

/** `detail` is inside lines (seams, panels), added as a second part in Mark so cutting the outline
 *  never cuts along them. */
export interface PathShape { id: string; label: string; d: string; closed: boolean; detail?: string; group?: string }

type Pt = [number, number];

const f = (v: number) => Math.round(v * 100) / 100;
const poly = (pts: Pt[]) => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L')} Z`;
const ngon = (n: number, rot = -Math.PI / 2) => poly(Array.from({ length: n }, (_, i) => {
  const a = rot + (i / n) * Math.PI * 2;
  return [50 + 50 * Math.cos(a), 50 + 50 * Math.sin(a)] as Pt;
}));
const star = (n: number, inner: number) => poly(Array.from({ length: n * 2 }, (_, i) => {
  const a = -Math.PI / 2 + (i / (n * 2)) * Math.PI * 2;
  const r = i % 2 ? inner : 50;
  return [50 + r * Math.cos(a), 50 + r * Math.sin(a)] as Pt;
}));
const hole = (cx: number, cy: number, r: number) => `M${f(cx - r)} ${cy} A${r} ${r} 0 1 0 ${f(cx + r)} ${cy} A${r} ${r} 0 1 0 ${f(cx - r)} ${cy} Z`;
const gear = (teeth: number) => {
  const pts: Pt[] = [];
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    const step = (Math.PI * 2) / teeth;
    for (const [da, r] of [[0, 38], [0.18, 50], [0.5, 50], [0.68, 38]] as const) {
      pts.push([50 + r * Math.cos(a + da * step), 50 + r * Math.sin(a + da * step)]);
    }
  }
  return `${poly(pts)} ${hole(50, 50, 12)}`;
};

export const LIBRARY: PathShape[] = [
  { id: 'triangle', label: 'Triangle', d: 'M50 0 L100 90 L0 90 Z', closed: true },
  { id: 'diamond', label: 'Diamond', d: 'M50 0 L100 50 L50 100 L0 50 Z', closed: true },
  { id: 'pentagon', label: 'Pentagon', d: ngon(5), closed: true },
  { id: 'hexagon', label: 'Hexagon', d: ngon(6, 0), closed: true },
  { id: 'octagon', label: 'Octagon', d: ngon(8, Math.PI / 8), closed: true },
  { id: 'star', label: 'Star', d: star(5, 20), closed: true },
  { id: 'heart', label: 'Heart', d: 'M50 95 C20 75 0 55 0 32 C0 13 14 0 29 0 C39 0 46 6 50 15 C54 6 61 0 71 0 C86 0 100 13 100 32 C100 55 80 75 50 95 Z', closed: true },
  { id: 'arrow', label: 'Arrow', d: 'M0 35 H60 V10 L100 50 L60 90 V65 H0 Z', closed: true },
  { id: 'rounded', label: 'Rounded box', d: 'M12 0 H88 A12 12 0 0 1 100 12 V48 A12 12 0 0 1 88 60 H12 A12 12 0 0 1 0 48 V12 A12 12 0 0 1 12 0 Z', closed: true },
  { id: 'tag', label: 'Keychain tag', d: `M20 0 H90 A10 10 0 0 1 100 10 V40 A10 10 0 0 1 90 50 H20 L0 25 Z ${hole(18, 25, 5)}`, closed: true },
  { id: 'plus', label: 'Plus', d: 'M35 0 H65 V35 H100 V65 H65 V100 H35 V65 H0 V35 H35 Z', closed: true },
  { id: 'bolt', label: 'Lightning', d: 'M62 0 L12 58 H46 L34 100 L88 38 H54 Z', closed: true },
  { id: 'moon', label: 'Moon', d: 'M62 0 A50 50 0 1 0 100 72 A40 40 0 1 1 62 0 Z', closed: true },
  { id: 'bubble', label: 'Speech bubble', d: 'M10 0 H90 A10 10 0 0 1 100 10 V55 A10 10 0 0 1 90 65 H40 L22 85 V65 H10 A10 10 0 0 1 0 55 V10 A10 10 0 0 1 10 0 Z', closed: true },
  { id: 'gear', label: 'Gear', d: gear(12), closed: true },
  { id: 'burst', label: 'Starburst', d: star(12, 40), closed: true },
  { id: 'cloud', label: 'Cloud', d: 'M22 30 A16 16 0 0 1 50 16 A20 20 0 0 1 86 30 A15 15 0 0 1 88 60 H14 A15 15 0 0 1 22 30 Z', closed: true },
  { id: 'plant', label: 'teachChat.app', d: 'M18 55 H82 V66 H76 L70 100 H30 L24 66 H18 Z M47 55 V34 C38 36 12 30 8 8 C30 6 44 16 47 28 V24 C50 10 66 0 92 2 C90 22 70 32 53 30 V55 Z', closed: true },

  // sports
  { id: 'basketball', label: 'Basketball', group: 'Sports', d: hole(50, 50, 50), closed: true,
    detail: 'M50 0 V100 M0 50 H100 M16 14 C34 32 34 68 16 86 M84 14 C66 32 66 68 84 86' },
  { id: 'soccer', label: 'Soccer ball', group: 'Sports', d: hole(50, 50, 50), closed: true,
    detail: `${poly(Array.from({ length: 5 }, (_, i) => { const a = -Math.PI / 2 + (i / 5) * Math.PI * 2; return [50 + 18 * Math.cos(a), 50 + 18 * Math.sin(a)] as Pt; }))} `
      + Array.from({ length: 5 }, (_, i) => { const a = -Math.PI / 2 + (i / 5) * Math.PI * 2; return `M${f(50 + 18 * Math.cos(a))} ${f(50 + 18 * Math.sin(a))} L${f(50 + 50 * Math.cos(a))} ${f(50 + 50 * Math.sin(a))}`; }).join(' ') },
  { id: 'football', label: 'Football', group: 'Sports', d: 'M0 50 C18 18 82 18 100 50 C82 82 18 82 0 50 Z', closed: true,
    detail: 'M32 50 H68 M38 44 V56 M46 44 V56 M54 44 V56 M62 44 V56' },
  { id: 'baseball', label: 'Baseball', group: 'Sports', d: hole(50, 50, 50), closed: true,
    detail: 'M18 12 C36 30 36 70 18 88 M82 12 C64 30 64 70 82 88' },
  { id: 'tennis', label: 'Tennis ball', group: 'Sports', d: hole(50, 50, 50), closed: true,
    detail: 'M8 26 C30 34 30 66 8 74 M92 26 C70 34 70 66 92 74' },
  { id: 'trophy', label: 'Trophy', group: 'Sports', d: 'M25 0 H75 V8 H94 V14 C94 30 84 40 70 42 C66 50 60 55 55 57 V72 H68 V82 H78 V100 H22 V82 H32 V72 H45 V57 C40 55 34 50 30 42 C16 40 6 30 6 14 V8 H25 Z', closed: true },
  { id: 'medal', label: 'Medal', group: 'Sports', d: `M32 0 H68 L58 36 H42 Z ${hole(50, 68, 32)}`, closed: true, detail: hole(50, 68, 22) },

  // callouts
  { id: 'bubble2', label: 'Thought bubble', group: 'Callouts', d: 'M25 20 A18 18 0 0 1 55 12 A18 18 0 0 1 85 25 A15 15 0 0 1 88 55 A18 18 0 0 1 60 68 A18 18 0 0 1 28 65 A15 15 0 0 1 12 40 A15 15 0 0 1 25 20 Z ' + hole(22, 82, 6) + ' ' + hole(10, 95, 4), closed: true },
  { id: 'callout', label: 'Callout box', group: 'Callouts', d: 'M0 0 H100 V60 H38 L16 82 L22 60 H0 Z', closed: true },
  { id: 'banner', label: 'Ribbon banner', group: 'Callouts', d: 'M0 10 H100 L90 30 L100 50 H0 L10 30 Z', closed: true },
];

/** A straight line between two points (mm). */
export function lineD(a: Pt, b: Pt): string {
  return `M${f(a[0])} ${f(a[1])} L${f(b[0])} ${f(b[1])}`;
}

/** A smooth curve through the points (Catmull-Rom as cubic Béziers). */
export function smoothD(pts: Pt[], closed: boolean): string {
  if (pts.length < 2) return '';
  if (pts.length === 2) return lineD(pts[0], pts[1]);
  const n = pts.length;
  const at = (i: number): Pt => (closed ? pts[(i + n) % n] : pts[Math.min(Math.max(i, 0), n - 1)]);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return closed ? `${d} Z` : d;
}

let probe: SVGPathElement | null = null;

/** The true drawn bounds of a path (curves included), measured by the browser. */
export function pathBBox(d: string): { x: number; y: number; w: number; h: number } {
  if (!probe) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.style.visibility = 'hidden';
    probe = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.append(probe);
    document.body.append(svg);
  }
  probe.setAttribute('d', d);
  const b = probe.getBBox();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}
