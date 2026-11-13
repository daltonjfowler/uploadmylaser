// Shared contracts between the browser, the Worker, and (mirrored in pydantic) the container.
// container/app/models.py must stay in sync with this file.

export type Mm = number;
export type OpKind = 'cut' | 'score' | 'engrave';
export type ColorChoice = OpKind | 'ignore';

export interface OpSettings {
  speedMmS: number;
  powerMinPct: number;
  powerMaxPct: number;
  passes: number;
  hatchMm?: number;     // engrave line spacing
  airAssist?: boolean;  // default true
  // If both are set, students may pick this op's power within the range (default powerMaxPct).
  studentMinPct?: number;
  studentMaxPct?: number;
}

export interface Material {
  id: string;
  name: string;
  thicknessMm: number;
  enabled: boolean;
  ops: Partial<Record<OpKind, OpSettings>>;
}

export interface MachineConfig {
  bedWidthMm: number;
  bedHeightMm: number;
  origin: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** relative: the job's `origin` corner starts at the laser head (default). absolute: bed X/Y. */
  jobOriginMode: 'relative' | 'absolute';
  swizzleMagic: number;
  baud: number;
  maxJobMinutes: number;
  absoluteMaxPowerPct: number;
  minSpeedMmS: number;
  travelSpeedMmS: number;
  /** Send stores the job on the controller under a name, the way desktop laser software sends it (docs/HARDWARE.md). */
  sendToPanel?: boolean;
}

export interface PowerRange { minPct: number; maxPct: number; defaultPct: number }

/** What students may see about a material: no speeds, and power only where the teacher allows a range. */
export interface PublicMaterial {
  id: string;
  name: string;
  thicknessMm: number;
  ops: OpKind[];
  adjustable: Partial<Record<OpKind, PowerRange>>;
}

/** Where a part sits on the workspace (bed mm, origin top-left, y down). The part is scaled and rotated
 *  first, then its **top-right corner** goes at (xMm, yMm), the same corner the laser head starts from. */
export interface Placement {
  xMm: Mm;
  yMm: Mm;
  scale: number;
  /** Height scale when stretched (lock off). Missing = same as `scale`. Applied before rotation. */
  scaleY?: number;
  rotateDeg: 0 | 90 | 180 | 270;
  /** Mirrored left-right / up-down in the part's own frame, before rotation. */
  flipX?: boolean;
  flipY?: boolean;
}

/** Cut line `distMm` around everything in a part, optionally with a keyring hole (`holeMm` across). */
export interface OutlineSpec { distMm: number; holeMm?: number }
/** Extras any part may have: weld its overlapping shapes, and/or add an outline. */
/** closeGaps: weld open ends closed (gaps up to 1 mm), so open shapes can be engraved */
export interface PartExtras { weld?: boolean; closeGaps?: boolean; outline?: OutlineSpec }

export interface TextSpec { value: string; font: TextFontId; heightMm: number; op: OpKind }

/** One thing on the workspace: an uploaded file (multipart field `file<fileIndex>`) or typed text.
 *  Boxes and circles are drawn by the browser as small SVG files. */
/** The units a DXF was drawn in, as $INSUNITS codes: 1 inches (and AutoCAD Architectural), 2 feet, 4 mm, 5 cm, 6 m. */
export type DxfUnits = 1 | 2 | 4 | 5 | 6;
export const DXF_UNITS: readonly DxfUnits[] = [1, 2, 4, 5, 6];

export type Part = Placement & PartExtras & (
  // colorMap: this file's own colour choices, ahead of the request-wide one (so Box/Circle are never touched)
  // pbm: a photo the browser turned into black and white dots (binary PBM with a size comment)
  | { kind: 'file'; fileIndex: number; fileType: 'svg' | 'dxf' | 'pbm'; colorMap?: Record<string, ColorChoice>; dxfUnits?: DxfUnits }
  | { kind: 'text'; text: TextSpec }
);

/** Browser → Worker, as multipart: `request` (this, JSON) plus `file0`…`fileN`. */
export interface ProcessRequest {
  materialId: string;
  parts: Part[];
  colorMap?: Record<string, ColorChoice>;
  powerChoice?: Partial<Record<OpKind, number>>; // clamped server-side to the teacher's range
  joinLines?: boolean; // default true: touching lines are cut as one path, repeats dropped
}

export interface PreviewLayer { kind: OpKind; part: number; paths: [Mm, Mm][][] }
export interface PartPaths { part: number; paths: [Mm, Mm][][] }
/** A colour found in a part, and what the file itself makes it (null: the student has to choose). */
export interface PartColor { part: number; key: string; kind: OpKind | null }

export interface ProcessResponse {
  preview: PreviewLayer[];                  // bed mm, per part and op, for the canvas
  unassigned: PartPaths[];                  // lines whose colour the student hasn't chosen yet (drawn grey)
  partBoxes: ([Mm, Mm, Mm, Mm] | null)[];   // one per request part (null: nothing in it to laser or to choose)
  bboxMm: [Mm, Mm, Mm, Mm] | null;          // the whole job
  rd: string | null;       // base64, swizzled, ready to stream
  frameRd: string | null;  // base64, laser-off trace of bbox
  estimateS: number;
  unknownColors: string[];
  partColors?: PartColor[];                 // every colour in every file part, for the colour list
  warnings: string[];
  errors: string[];
  openEngraveParts?: number[]; // parts with open lines that engraving skipped
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // all files in one request together
export const MAX_PARTS = 5000; // room for patterns and Ungroup (copies of one file share its fileIndex)
// Class phrases (src/phrase.ts). A teacher's own phrase can be any length (Dalton's call,
// 2026-09-28): a short one is the teacher's choice, and the per-IP limit still slows guessing.
// Generated phrases (web/src/phrase-words.ts) are long and hard to guess.
export const MIN_PHRASE_LENGTH = 1;
export const MAX_PHRASE_LENGTH = 64;

/** Fonts for the Text tool. Ids must match FONTS in container/app/geometry/text_import.py, and each
 *  file is in container/Dockerfile. `css` is the Google Fonts family, self-hosted from Fontsource in
 *  web/src/fonts.ts to preview the font in the picker. `group` is the picker's heading. */
export const TEXT_FONTS = [
  { id: 'sans', group: 'Basic', label: 'Sans', css: 'DejaVu Sans, Verdana, sans-serif', tip: '' },
  { id: 'serif', group: 'Basic', label: 'Serif', css: 'DejaVu Serif, Georgia, serif', tip: '' },
  { id: 'block', group: 'Bold', label: 'Block', css: 'Anton', tip: 'Tall and bold. Great for names.' },
  { id: 'chunky', group: 'Bold', label: 'Chunky', css: 'Bungee', tip: 'Wide letters, easy to engrave.' },
  { id: 'marker', group: 'Handwriting', label: 'Marker', css: 'Permanent Marker', tip: 'Engrave it, don\'t cut it out.' },
  { id: 'script', group: 'Handwriting', label: 'Script', css: 'Pacifico', tip: 'Joined-up letters: engrave, or tick Weld to cut them out.' },
  { id: 'stencil', group: 'Stencil', label: 'Stencil', css: 'Allerta Stencil', tip: 'Best for Cut through: letters keep their middles.' },
  { id: 'bebas', group: 'Bold', label: 'Bebas Neue', css: 'Bebas Neue', tip: 'Tall, thin capitals. Clean signs.' },
  { id: 'staatliches', group: 'Bold', label: 'Staatliches', css: 'Staatliches', tip: 'Bold capitals with a poster look.' },
  { id: 'archivo-black', group: 'Bold', label: 'Archivo Black', css: 'Archivo Black', tip: 'Very bold and easy to read.' },
  { id: 'russo', group: 'Bold', label: 'Russo One', css: 'Russo One', tip: 'Square and sporty.' },
  { id: 'passion', group: 'Bold', label: 'Passion One', css: 'Passion One', tip: 'Thick, rounded and friendly.' },
  { id: 'titan', group: 'Bold', label: 'Titan One', css: 'Titan One', tip: 'Round and chunky, great for kids\' names.' },
  { id: 'luckiest', group: 'Bold', label: 'Luckiest Guy', css: 'Luckiest Guy', tip: 'Big cartoon capitals.' },
  { id: 'bowlby', group: 'Bold', label: 'Bowlby One', css: 'Bowlby One SC', tip: 'Heavy small capitals.' },
  { id: 'ultra', group: 'Bold', label: 'Ultra', css: 'Ultra', tip: 'Heavy old-style slab letters.' },
  { id: 'alfa-slab', group: 'Bold', label: 'Alfa Slab One', css: 'Alfa Slab One', tip: 'Bold slab letters, like a wanted poster.' },
  { id: 'abril', group: 'Bold', label: 'Abril Fatface', css: 'Abril Fatface', tip: 'Fancy magazine headline letters.' },
  { id: 'shrikhand', group: 'Bold', label: 'Shrikhand', css: 'Shrikhand', tip: 'Bold, leaning and fun.' },
  { id: 'rubik-mono', group: 'Bold', label: 'Rubik Mono', css: 'Rubik Mono One', tip: 'Wide, even capitals.' },
  { id: 'bangers', group: 'Fun', label: 'Bangers', css: 'Bangers', tip: 'Comic book style.' },
  { id: 'chewy', group: 'Fun', label: 'Chewy', css: 'Chewy', tip: 'Soft and bouncy.' },
  { id: 'cherry-bomb', group: 'Fun', label: 'Cherry Bomb', css: 'Cherry Bomb One', tip: 'Round, bubbly letters.' },
  { id: 'creepster', group: 'Fun', label: 'Creepster', css: 'Creepster', tip: 'Spooky drips. Engrave it, don\'t cut it out.' },
  { id: 'monoton', group: 'Fun', label: 'Monoton', css: 'Monoton', tip: 'Neon lines. Engrave it big.' },
  { id: 'bungee-inline', group: 'Fun', label: 'Bungee Inline', css: 'Bungee Inline', tip: 'Chunky with a line inside. Engrave it.' },
  { id: 'bungee-shade', group: 'Fun', label: 'Bungee Shade', css: 'Bungee Shade', tip: '3D shadow letters. Engrave it.' },
  { id: 'righteous', group: 'Fun', label: 'Righteous', css: 'Righteous', tip: 'Retro and rounded.' },
  { id: 'audiowide', group: 'Fun', label: 'Audiowide', css: 'Audiowide', tip: 'Space-age tech letters.' },
  { id: 'pixel', group: 'Fun', label: 'Pixel (Press Start)', css: 'Press Start 2P', tip: 'Blocky video game letters.' },
  { id: 'typewriter', group: 'Fun', label: 'Typewriter', css: 'Special Elite', tip: 'Old typewriter, a bit rough. Engrave it.' },
  { id: 'pirata', group: 'Fun', label: 'Pirata One', css: 'Pirata One', tip: 'Pirate and medieval style.' },
  { id: 'fraktur', group: 'Fun', label: 'Old English', css: 'UnifrakturMaguntia', tip: 'Old English blackletter.' },
  { id: 'lobster', group: 'Handwriting', label: 'Lobster', css: 'Lobster', tip: 'Bold joined-up script. Engrave, or tick Weld to cut it out.' },
  { id: 'satisfy', group: 'Handwriting', label: 'Satisfy', css: 'Satisfy', tip: 'Smooth joined-up script. Engrave it.' },
  { id: 'great-vibes', group: 'Handwriting', label: 'Great Vibes', css: 'Great Vibes', tip: 'Fancy wedding script. Thin: engrave it big.' },
  { id: 'kaushan', group: 'Handwriting', label: 'Kaushan Script', css: 'Kaushan Script', tip: 'Brush script with energy.' },
  { id: 'yellowtail', group: 'Handwriting', label: 'Yellowtail', css: 'Yellowtail', tip: 'Retro diner script.' },
  { id: 'sacramento', group: 'Handwriting', label: 'Sacramento', css: 'Sacramento', tip: 'Thin, elegant script. Engrave it big.' },
  { id: 'rock-salt', group: 'Handwriting', label: 'Rock Salt', css: 'Rock Salt', tip: 'Scratchy marker writing.' },
  { id: 'gloria', group: 'Handwriting', label: 'Gloria', css: 'Gloria Hallelujah', tip: 'Like neat kid handwriting.' },
  { id: 'caveat-brush', group: 'Handwriting', label: 'Caveat Brush', css: 'Caveat Brush', tip: 'Quick brush pen writing.' },
  { id: 'graffiti', group: 'Handwriting', label: 'Graffiti', css: 'Sedgwick Ave Display', tip: 'Graffiti tag style.' },
  { id: 'amatic', group: 'Handwriting', label: 'Amatic', css: 'Amatic SC', tip: 'Tall, thin hand-drawn capitals. Engrave it.' },
  { id: 'black-ops', group: 'Stencil', label: 'Black Ops', css: 'Black Ops One', tip: 'Army stencil. Great for Cut through.' },
  { id: 'saira-stencil', group: 'Stencil', label: 'Saira Stencil', css: 'Saira Stencil One', tip: 'Modern stencil. Great for Cut through.' },
  { id: 'stardos', group: 'Stencil', label: 'Stardos Stencil', css: 'Stardos Stencil', tip: 'Classic crate stencil. Great for Cut through.' },
  { id: 'wallpoet', group: 'Stencil', label: 'Wallpoet', css: 'Wallpoet', tip: 'Street stencil. Great for Cut through.' },
] as const;
export type TextFontId = (typeof TEXT_FONTS)[number]['id'];
