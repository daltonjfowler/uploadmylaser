// The optional school-network lock: `ALLOWED_CIDRS` is a comma-separated list of IPv4/IPv6
// ranges, empty (off) by default. Port of uploadmycode's cidr.ts. Pure: test/cidr.test.mjs.

export interface Cidr {
  readonly bytes: Uint8Array; // 4 bytes for IPv4, 16 for IPv6
  readonly prefix: number;
  readonly family: 4 | 6;
}

const BITS = { 4: 32, 6: 128 } as const;

// Rejects "01" and "+1", so no two spellings of one range exist.
function parseOctet(part: string): number | null {
  if (!/^\d{1,3}$/.test(part)) return null;
  const v = Number(part);
  if (v > 255 || String(v) !== part) return null;
  return v;
}

function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const o = parseOctet(parts[i]!);
    if (o === null) return null;
    bytes[i] = o;
  }
  return bytes;
}

function parseGroup(part: string): number | null {
  if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
  return Number.parseInt(part, 16);
}

function parseIpv6(text: string): Uint8Array | null {
  // A trailing dotted quad ("::ffff:10.0.0.1") becomes two hex groups.
  if (text.includes('.')) {
    const cut = text.lastIndexOf(':');
    if (cut < 0) return null;
    const q = parseIpv4(text.slice(cut + 1));
    if (q === null) return null;
    const groups = ((q[0]! << 8) | q[1]!).toString(16) + ':' + ((q[2]! << 8) | q[3]!).toString(16);
    return parseIpv6(text.slice(0, cut + 1) + groups);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0]!.split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1]!.split(':') : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < head.length; i++) {
    const g = parseGroup(head[i]!);
    if (g === null) return null;
    bytes[i * 2] = g >> 8;
    bytes[i * 2 + 1] = g & 0xff;
  }
  const tailStart = 16 - tail.length * 2;
  for (let i = 0; i < tail.length; i++) {
    const g = parseGroup(tail[i]!);
    if (g === null) return null;
    bytes[tailStart + i * 2] = g >> 8;
    bytes[tailStart + i * 2 + 1] = g & 0xff;
  }
  return bytes;
}

function isIpv4Mapped(b: Uint8Array): boolean {
  if (b.length !== 16) return false;
  for (let i = 0; i < 10; i++) if (b[i] !== 0) return false;
  return b[10] === 0xff && b[11] === 0xff;
}

// A bare address or "address/prefix". IPv4-mapped IPv6 folds down to IPv4 so `::ffff:10.1.2.3`
// matches `10.1.0.0/16`. Anything not fully understood is null: a typo must never match everything.
export function parseCidr(text: string): Cidr | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const slash = trimmed.indexOf('/');
  const address = slash < 0 ? trimmed : trimmed.slice(0, slash);
  const suffix = slash < 0 ? null : trimmed.slice(slash + 1);

  const family: 4 | 6 = address.includes(':') ? 6 : 4;
  const bytes = family === 6 ? parseIpv6(address) : parseIpv4(address);
  if (bytes === null) return null;

  let prefix: number = BITS[family];
  if (suffix !== null) {
    if (!/^\d{1,3}$/.test(suffix)) return null;
    prefix = Number(suffix);
    if (prefix > BITS[family]) return null;
  }
  if (family === 6 && isIpv4Mapped(bytes) && prefix >= 96) {
    return { bytes: bytes.slice(12), prefix: prefix - 96, family: 4 };
  }
  return { bytes, prefix, family };
}

// Bad entries are reported, not thrown, so one typo cannot take the site down mid-class.
export function parseCidrList(raw: string): { cidrs: Cidr[]; invalid: string[] } {
  const cidrs: Cidr[] = [];
  const invalid: string[] = [];
  for (const entry of raw.split(',')) {
    const t = entry.trim();
    if (t === '') continue;
    const c = parseCidr(t);
    if (c === null) invalid.push(t);
    else cidrs.push(c);
  }
  return { cidrs, invalid };
}

function inRange(a: Cidr, range: Cidr): boolean {
  if (a.family !== range.family) return false;
  const whole = range.prefix >> 3;
  for (let i = 0; i < whole; i++) if (a.bytes[i] !== range.bytes[i]) return false;
  const leftover = range.prefix & 7;
  if (leftover === 0) return true;
  const mask = (0xff << (8 - leftover)) & 0xff;
  return (a.bytes[whole]! & mask) === (range.bytes[whole]! & mask);
}

// Callers skip this entirely when the list is empty (empty = lock off, not "nobody allowed").
export function ipAllowed(ip: string, cidrs: readonly Cidr[]): boolean {
  if (cidrs.length === 0) return false;
  const a = parseCidr(ip);
  if (a === null) return false;
  if (a.prefix !== BITS[a.family]) return false; // a range is not a client
  return cidrs.some((r) => inRange(a, r));
}
