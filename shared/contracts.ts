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
  /** Send stores the job on the controller under a name, like LightBurn's Send (docs/HARDWARE.md). */
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
}

export interface TextSpec { value: string; font: TextFontId; heightMm: number; op: OpKind }

/** One thing on the workspace: an uploaded file (multipart field `file<fileIndex>`) or typed text.
 *  Boxes and circles are drawn by the browser as small SVG files. */
export type Part = Placement & (
  | { kind: 'file'; fileIndex: number; fileType: 'svg' | 'dxf' }
  | { kind: 'text'; text: TextSpec }
);

/** Browser → Worker, as multipart: `request` (this, JSON) plus `file0`…`fileN`. */
export interface ProcessRequest {
  materialId: string;
  parts: Part[];
  colorMap?: Record<string, ColorChoice>;
  powerChoice?: Partial<Record<OpKind, number>>; // clamped server-side to the teacher's range
}

export interface PreviewLayer { kind: OpKind; part: number; paths: [Mm, Mm][][] }

export interface ProcessResponse {
  preview: PreviewLayer[];                  // bed mm, per part and op, for the canvas
  partBoxes: ([Mm, Mm, Mm, Mm] | null)[];   // one per request part (null: nothing in it to laser)
  bboxMm: [Mm, Mm, Mm, Mm] | null;          // the whole job
  rd: string | null;       // base64, swizzled, ready to stream
  frameRd: string | null;  // base64, laser-off trace of bbox
  estimateS: number;
  unknownColors: string[];
  warnings: string[];
  errors: string[];
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // all files in one request together
export const MAX_PARTS = 100; // room for patterns (copies of one file share its fileIndex)

/** Fonts for the Text tool. Ids must match FONTS in container/app/geometry/text_import.py.
 *  `css` is the Google Fonts family, used to preview the font in the picker. */
export const TEXT_FONTS = [
  { id: 'sans', label: 'Sans', css: 'DejaVu Sans, Verdana, sans-serif', tip: '' },
  { id: 'serif', label: 'Serif', css: 'DejaVu Serif, Georgia, serif', tip: '' },
  { id: 'block', label: 'Block', css: 'Anton', tip: 'Tall and bold. Great for names.' },
  { id: 'chunky', label: 'Chunky', css: 'Bungee', tip: 'Wide letters, easy to engrave.' },
  { id: 'marker', label: 'Marker', css: 'Permanent Marker', tip: 'Engrave it, don\'t cut it out.' },
  { id: 'script', label: 'Script', css: 'Pacifico', tip: 'Joined-up letters: engrave only.' },
  { id: 'stencil', label: 'Stencil', css: 'Allerta Stencil', tip: 'Best for Cut through: letters keep their middles.' },
] as const;
export type TextFontId = (typeof TEXT_FONTS)[number]['id'];
