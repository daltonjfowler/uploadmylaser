// "Send to panel": store a named job in the controller's file list, so it is started from the laser's
// own touchscreen. The Ruida file commands (E7 01 file name, E8 00 delete, E8 01 file name by number,
// E8 02 file transfer, DA 00 memory read) are as documented in MeerK40t's Ruida emulator
// (meerk40t/ruida/emulator.py, MIT, see CREDITS.md). Not yet checked on the class RDC6445S.
//
// SAFETY: deleteOneFile is the ONLY place in the app that builds an E8 00 (delete) command. It deletes
// one slot, never slot 0, because E8 00 00 00 ... deletes every file on the controller. The container
// never emits E8 commands at all (container/tests/test_no_delete.py).

export const MAX_PANEL_NAME = 8; // the controller lists file names up to 8 characters, in capitals
export const MAX_FILES = 200;    // a file count above this is a bad read, not a real list

// Memory addresses (two 7-bit bytes on the wire), from MeerK40t's emulator: 0x0205 = Total Doc Number.
export const MEM_FILE_COUNT = 0x0205;

/** Upper case, only A-Z 0-9 space and hyphen (a deliberately small set), at most 8 characters. */
export function cleanPanelName(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 -]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_PANEL_NAME).trim();
}

const hi7 = (n: number) => (n >> 7) & 0x7f;
const lo7 = (n: number) => n & 0x7f;

/** E8 02 + E7 01 <name> 00. Goes right before the job, whose checksum does not include it. */
export function namePacket(name: string): Uint8Array {
  if (!name || name !== cleanPanelName(name)) throw new Error(`Bad laser file name: "${name}"`);
  return Uint8Array.of(0xe8, 0x02, 0xe7, 0x01, ...[...name].map((c) => c.charCodeAt(0)), 0x00);
}

/** E8 00 <slot> <slot>: delete one stored file. Slot 0 would delete ALL files, so it is refused. */
export function deleteOneFile(slot: number): Uint8Array {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_FILES) throw new Error(`Refusing to delete file slot ${slot}.`);
  const out = Uint8Array.of(0xe8, 0x00, hi7(slot), lo7(slot), hi7(slot), lo7(slot));
  if (out[2] === 0 && out[3] === 0) throw new Error('Refusing to delete every file.'); // belt and braces
  return out;
}

export const readMemory = (addr: number) => Uint8Array.of(0xda, 0x00, hi7(addr), lo7(addr));
export const readFileName = (slot: number) => Uint8Array.of(0xe8, 0x01, hi7(slot), lo7(slot));

export type Reply = { kind: 'mem'; addr: number; value: number } | { kind: 'name'; slot: number; name: string };

/** Find complete replies in unswizzled bytes from the controller. Returns them and how many bytes were used. */
export function parseReplies(buf: Uint8Array): { replies: Reply[]; used: number } {
  const replies: Reply[] = [];
  let i = 0;
  let used = 0;
  while (i < buf.length) {
    if (buf[i] === 0xda && buf[i + 1] === 0x01) {
      if (i + 9 > buf.length) break; // DA 01 addr(2) value(5)
      let value = 0;
      for (let k = 4; k < 9; k++) value = value * 128 + (buf[i + k] & 0x7f);
      replies.push({ kind: 'mem', addr: (buf[i + 2] << 7) | buf[i + 3], value });
      i += 9;
      used = i;
    } else if (buf[i] === 0xe8 && buf[i + 1] === 0x01) {
      const end = buf.indexOf(0x00, i + 4);
      if (i + 4 > buf.length || end < 0) break; // E8 01 slot(2) name 00
      const name = String.fromCharCode(...buf.subarray(i + 4, end));
      replies.push({ kind: 'name', slot: (buf[i + 2] << 7) | buf[i + 3], name });
      i = end + 1;
      used = i;
    } else if ((buf[i] === 0xda || buf[i] === 0xe8) && i + 1 >= buf.length) {
      break; // first byte of a reply that has not fully arrived yet
    } else {
      i++; // ACKs and anything else we do not ask about
      used = i;
    }
  }
  return { replies, used };
}
