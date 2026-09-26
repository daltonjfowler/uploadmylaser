// LaserLink.sendToPanel against a fake USB port that answers the way MeerK40t's Ruida emulator does.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

// web/src imports without extensions (Vite style). Let Node find the .ts files.
register('data:text/javascript,' + encodeURIComponent(
  'export async function resolve(s, c, next) { try { return await next(s, c) } catch (e) {' +
  ' if (s.startsWith(".") && !s.endsWith(".ts")) return next(s + ".ts", c); throw e } }'));
const { LaserLink } = await import('../src/serial/laser.ts');
const { swizzle, unswizzle } = await import('../src/ruida/swizzle.ts');
const { parseReplies } = await import('../src/ruida/panel.ts');

const M = 0x88;
const hex = (u8) => Buffer.from(u8).toString('hex');

/** A fake controller. `files` is its list; `silent` never answers. Records every command written. */
function fakeLaser({ files = [], silent = false } = {}) {
  const writes = [];
  let push;
  const readable = new ReadableStream({ start(c) { push = (b) => c.enqueue(swizzle(b, M)); } });
  const writable = new WritableStream({
    write(chunk) {
      const plain = unswizzle(chunk, M);
      writes.push(hex(plain));
      if (silent) return;
      if (hex(plain) === 'da000405') push(Uint8Array.of(0xda, 0x01, 0x04, 0x05, 0, 0, 0, 0, files.length));
      else if (plain[0] === 0xe8 && plain[1] === 0x01) {
        const n = (plain[2] << 7) | plain[3];
        push(Uint8Array.from([...plain.subarray(0, 4), ...Buffer.from(files[n - 1] ?? ''), 0]));
      }
    },
  });
  const port = { readable, writable, open: async () => {}, close: async () => {}, getInfo: () => ({ usbVendorId: 0x0403 }) };
  const serial = { getPorts: async () => [port], addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis, 'navigator', { value: { serial }, configurable: true });
  return writes;
}

async function link() {
  const l = new LaserLink({ baud: 115200, magic: M });
  await l.connect();
  return l;
}

const JOB = swizzle(Uint8Array.of(0xd8, 0x12, 0xd7), M);

test('new name: reads the list, never deletes, sends name then job', async () => {
  const writes = fakeLaser({ files: ['STUDENTN'] });
  const l = await link();
  assert.equal(await l.sendToPanel(JOB, 'TEST1'), false);
  assert.deepEqual(writes, ['da000405', 'e8010001', 'e802e701544553543100d812d7']);
  await l.disconnect();
});

test('same name: deletes exactly that one slot', async () => {
  const writes = fakeLaser({ files: ['AB C-1', 'TEST1'] });
  const l = await link();
  assert.equal(await l.sendToPanel(JOB, 'TEST1'), true);
  assert.deepEqual(writes, ['da000405', 'e8010001', 'e8010002', 'e8010002', 'e80000020002', 'e802e701544553543100d812d7']);
  await l.disconnect();
});

test('no answer: gives up without deleting or sending the job', async () => {
  const writes = fakeLaser({ silent: true });
  const l = await link();
  await assert.rejects(l.sendToPanel(JOB, 'TEST1'), /did not answer/);
  assert.deepEqual(writes, ['da000405']);
  assert.equal(l.sending, false);
  await l.disconnect();
});

test('a bad name is refused before anything is written', async () => {
  const writes = fakeLaser({ files: ['TEST1'] });
  const l = await link();
  await assert.rejects(l.sendToPanel(JOB, 'test1'));
  assert.deepEqual(writes, []);
  await l.disconnect();
});

test('the fake controller replies parse (sanity check for this file)', () => {
  assert.equal(parseReplies(Uint8Array.of(0xda, 0x01, 0x04, 0x05, 0, 0, 0, 0, 2)).replies[0].value, 2);
});
