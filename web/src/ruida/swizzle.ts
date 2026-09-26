// Browser-side Ruida helpers. Kept tiny on purpose: jobs are encoded by the container.
// STOP lives here so it works even when the server is unreachable.

export function swizzleByte(b: number, magic: number): number {
  b ^= (b >> 7) & 0xff;
  b ^= (b << 7) & 0xff;
  b ^= (b >> 7) & 0xff;
  b ^= magic;
  return (b + 1) & 0xff;
}

export function unswizzleByte(b: number, magic: number): number {
  b = (b - 1) & 0xff;
  b ^= magic;
  b ^= (b >> 7) & 0xff;
  b ^= (b << 7) & 0xff;
  b ^= (b >> 7) & 0xff;
  return b;
}

export function swizzle(data: Uint8Array, magic: number): Uint8Array {
  return data.map((b) => swizzleByte(b, magic));
}

export function unswizzle(data: Uint8Array, magic: number): Uint8Array {
  return data.map((b) => unswizzleByte(b, magic));
}

export const STOP_PROCESS = Uint8Array.of(0xd8, 0x01);
export const PAUSE_PROCESS = Uint8Array.of(0xd8, 0x02);
export const RESTORE_PROCESS = Uint8Array.of(0xd8, 0x03);

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
