// Shapes library, plus the Line and Curve tools' path helpers. Every one becomes a small SVG in the
// browser (see pathSvg in shapes.ts), so the server treats them like any uploaded file.

/** `detail` is inside lines (seams, panels), added as a second part in Mark so cutting the outline
 *  never cuts along them. `engrave`: filled areas, added as an Engrave part; a shape with one always
 *  cuts its outline (the logos). */
export interface PathShape { id: string; label: string; d: string; closed: boolean; detail?: string; engrave?: string; group?: string }

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
  // One outline: pot and sprout share the stem's base, so cutting two loops split them into two pieces.
  { id: 'plant', label: 'teachChat.app', d: 'M18 55 H47 V34 C38 36 12 30 8 8 C30 6 44 16 47 28 V24 C50 10 66 0 92 2 C90 22 70 32 53 30 V55 H82 V66 H76 L70 100 H30 L24 66 H18 Z', closed: true },

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

  // the uploadmy logos, ready to burn: tile = Cut, solid parts = Engrave, lines = Mark (Dalton 2026-10-30)
  ...logos(),
];

/** Rounded rectangle. */
function rr(x: number, y: number, w: number, h: number, r: number): string {
  return `M${f(x + r)} ${f(y)} H${f(x + w - r)} A${r} ${r} 0 0 1 ${f(x + w)} ${f(y + r)} V${f(y + h - r)} A${r} ${r} 0 0 1 ${f(x + w - r)} ${f(y + h)}`
    + ` H${f(x + r)} A${r} ${r} 0 0 1 ${f(x)} ${f(y + h - r)} V${f(y + r)} A${r} ${r} 0 0 1 ${f(x + r)} ${f(y)} Z`;
}

/**
 * The four site icons (scripts/make-icons.mjs on each site) redrawn for the laser on the same 64 Ã— 64 grid.
 * Engraved shapes never overlap: engraving fills even-odd, so an overlap would come out as a hole.
 */
function logos(): PathShape[] {
  const tile = rr(0, 0, 64, 64, 14);
  const hat = 'M32 5 L41 15 H35 V20 H29 V15 H23 Z'; // the upload arrow on the robot's head
  const eyes = (y: number, r: number) => `${hole(25, y, r)} ${hole(39, y, r)}`;
  const spark = (cx: number, cy: number) => poly([[0, -3.5], [1.2, -1.2], [4, 0], [1.2, 1.2], [0, 3.5], [-1.2, 1.2], [-4, 0], [-1.2, -1.2]].map(([x, y]) => [cx + x, cy + y] as Pt));
  const saw = (cx: number, cy: number) => `${poly(Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2;
    const r = i % 2 ? 7.2 : 9.6;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt;
  }))} ${hole(cx, cy, 2)}`;
  const logo = (id: string, label: string, engrave: string, detail: string): PathShape =>
    ({ id, label, group: 'uploadmy logos', d: tile, closed: true, engrave, detail });
  return [
    logo('logo-laser', 'uploadmylaser',
      `${hat} ${eyes(30, 3.6)} ${spark(17, 53.5)} ${spark(47, 53)}`,
      `${rr(14, 20, 36, 25, 7)} M27 38 Q32 42.5 37 38 M25 30 Q20 42 17 50 M39 30 Q44 42 47 49.5`
      + ' M7 52.2 L57 50.6 L57.2 58.6 L7.2 60 Z M23 56.5 Q30 56.3 37 56.4'),
    logo('logo-model', 'uploadmymodel',
      `M29 25 L34 25.4 L34 15.5 L40.5 15.8 L31.8 5.5 L23.2 15.2 L29 15.4 Z ${hole(21.5, 37.5, 2.4)} ${hole(31.5, 38.5, 2.4)}`,
      // cube: front face, side face, top edges (broken where the arrow's stem stands in front)
      'M12.5 27 L39 29.5 L39 56 L12.5 53.5 Z M39 29.5 L51 23.8 L51 50 L39 56 M12.5 27 L24.5 21.5 L29 21.89 M34 22.32 L51 23.8'
      + ' M40 34 Q45 31.6 50.2 29 M40 38.6 Q45 36.2 50.2 33.6 M40 43.2 Q45 40.8 50.2 38.2 M40 47.8 Q45 45.4 50.2 42.8'
      + ' M20.5 45 Q26.5 50 32.5 46.5'),
    logo('logo-code', 'uploadmycode',
      `${hat} ${eyes(33, 3.2)} ${[27, 34, 41].map((y) => `${rr(8, y, 6, 3, 1.2)} ${rr(50, y, 6, 3, 1.2)}`).join(' ')}`,
      `${rr(14, 20, 36, 31, 6.5)} M24 41 Q32 48 40 41`),
    logo('logo-cut', 'uploadmycut',
      // drill: body, handle, battery, chuck, bit (touching, never overlapping); buzz saw with its arbor hole
      `${hat} ${eyes(30, 3.6)} ${rr(7, 45.5, 13, 7, 2.5)} M11 52.5 H16.5 L15.5 58.5 H10.5 Z ${rr(8.5, 58.5, 9.5, 3, 1)}`
      + ` ${rr(3.4, 46.6, 3.6, 4.8, 1)} ${rr(1.6, 48.2, 1.8, 1.6, 0.5)} ${saw(49, 53)}`,
      `${rr(14, 20, 36, 25, 7)} M27 38 Q32 42.5 37 38 M16 43 Q10.5 45 13.6 52 M48 43 Q53 43 52.5 45.5`),
  ];
}

/** A straight line between two points (mm). */
export function lineD(a: Pt, b: Pt): string {
  return `M${f(a[0])} ${f(a[1])} L${f(b[0])} ${f(b[1])}`;
}

/** A smooth curve through the points (Catmull-Rom as cubic BÃ©ziers). */
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
