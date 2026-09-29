// Photo (beta): grey pixels → black and white dots → a binary PBM the server turns into engrave lines
// (container/app/geometry/photo_import.py). No DOM, so Node tests can load it.

export interface PhotoLook {
  /** -100..100 */
  brightness: number;
  /** -100..100 */
  contrast: number;
  invert: boolean;
  mode: 'dither' | 'threshold';
}

/** Grey 0 (black) .. 255 (white) after brightness, contrast and invert. */
export function adjust(grey: Float32Array, look: PhotoLook): Float32Array {
  const c = look.contrast * 2.55;
  const f = (259 * (c + 255)) / (255 * (259 - c));
  const out = new Float32Array(grey.length);
  for (let i = 0; i < grey.length; i++) {
    let v = f * (grey[i] + look.brightness * 1.28 - 128) + 128;
    if (look.invert) v = 255 - v;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

/** 1 = burn (dark). Floyd-Steinberg dots for photos, a plain cut-off for logos. */
export function toDots(grey: Float32Array, w: number, h: number, look: PhotoLook): Uint8Array {
  const g = adjust(grey, look);
  const dots = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = g[i];
      const on = old < 128;
      dots[i] = on ? 1 : 0;
      if (look.mode !== 'dither') continue;
      const err = old - (on ? 0 : 255);
      if (x + 1 < w) g[i + 1] += (err * 7) / 16;
      if (y + 1 < h) {
        if (x > 0) g[i + w - 1] += (err * 3) / 16;
        g[i + w] += (err * 5) / 16;
        if (x + 1 < w) g[i + w + 1] += err / 16;
      }
    }
  }
  return dots;
}

/** How many engrave lines the dots make (runs of burn dots on each row): the server's work. */
export function runCount(dots: Uint8Array, w: number, h: number): number {
  let n = 0;
  for (let y = 0; y < h; y++) {
    let prev = 0;
    for (let x = 0; x < w; x++) {
      const d = dots[y * w + x];
      if (d && !prev) n++;
      prev = d;
    }
  }
  return n;
}

/** Binary PBM (P4) with its size in a comment, as one char per byte (like a binary DXF is kept). */
export function toPbm(dots: Uint8Array, w: number, h: number, mmPerPx: number): string {
  const stride = Math.ceil(w / 8);
  const bytes = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (dots[y * w + x]) bytes[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
  }
  let s = `P4\n# uml-mm-per-px ${mmPerPx}\n${w} ${h}\n`;
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

/** Width, height (mm) from a PBM made by toPbm. */
export function pbmSize(data: string): [number, number] | null {
  const m = /^P4\n# uml-mm-per-px ([0-9.]+)\n(\d+) (\d+)\n/.exec(data.slice(0, 80));
  return m ? [Number(m[2]) * Number(m[1]), Number(m[3]) * Number(m[1])] : null;
}
