// Draws the uploadmylaser icon: the family robot face and upload-arrow hat, with laser eyes burning
// a plank. The look (ink outline, hand-drawn wobble) lives in scripts/icon-kit.mjs, shared by all
// four sites. Usage: node scripts/make-icons.mjs web/public
import { circle, curve, inked, poly, rrect, tag, tile, writeIcons } from './icon-kit.mjs';

const OUT = process.argv[2] || '.';
// Family colours: grey face, deep tile of the site's colour, arrow in a brighter tint of it.
const BG = '#4C1D95', FACE = '#AEB6C0', ARROW = '#A78BFA', INK = '#1A0B3B';
const WHITE = '#FFFFFF', DARK = '#0F3D40', RED = '#FF3B3B', GLOW = '#FFB3B3', WOOD = '#E9C58F', GRAIN = '#D4A86A', SPARK = '#FFD166';
const star = (cx, cy) => poly([[cx, cy - 3.5], [cx + 1.2, cy - 1], [cx + 4, cy], [cx + 1.2, cy + 1], [cx, cy + 3.5], [cx - 1.2, cy + 1], [cx - 4, cy], [cx - 1.2, cy - 1]], SPARK);

writeIcons(OUT, [
  tile(BG),
  ...inked([poly([[32, 5], [23, 15], [41, 15]], ARROW), rrect(29, 14, 6, 7, 0, ARROW)], INK),
  // the plank being lasered, a little crooked like a real offcut
  ...inked([poly([[7, 52.2], [57, 50.6], [57.2, 58.6], [7.2, 60]], WOOD)], INK),
  curve(10, 55.6, 18, 55.2, 26, 55.4, 1, GRAIN), curve(36, 57, 44, 56.6, 53, 56.2, 1, GRAIN),
  ...inked([rrect(14, 20, 36, 25, 7, FACE)], INK),
  curve(27, 38, 32, 42.5, 37, 38, 2.6, DARK),
  // laser beams from the pupils to the plank: glow, then a hot core
  ...tag('beam', [curve(25, 30, 20, 42, 17, 53.5, 3.2, GLOW), curve(39, 30, 44, 42, 47, 53, 3.2, GLOW),
    curve(25, 30, 20, 42, 17, 53.5, 1.5, RED), curve(39, 30, 44, 42, 47, 53, 1.5, RED)]),
  circle(25, 30, 3.6, DARK), circle(39, 30, 3.6, DARK),
  ...tag('glow', [circle(25, 30, 1.7, RED), circle(39, 30, 1.7, RED)]),
  circle(26, 28.8, 0.8, WHITE), circle(40, 28.8, 0.8, WHITE),
  // sparks where the beams hit
  ...tag('spark', inked([star(17, 53.5), star(47, 53)], INK, 0.8)),
], 'uploadmylaser icon: the family robot with laser eyes burning a plank.', `
  .beam { animation: flicker 0.45s steps(3) infinite; }
  @keyframes flicker { 0%, 100% { opacity: 1; } 33% { opacity: 0.45; } 66% { opacity: 0.85; } }
  .glow { animation: glow 0.45s ease-in-out infinite; }
  @keyframes glow { 50% { transform: scale(1.35); } }
  .spark { animation: twinkle 0.6s ease-in-out infinite; }
  @keyframes twinkle { 0%, 100% { transform: scale(1) rotate(0deg); } 50% { transform: scale(1.4) rotate(25deg); } }`);
