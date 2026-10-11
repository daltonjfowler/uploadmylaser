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

/** A fake controller. `files` is its list; `silent` never answers. Records every command written.
 *  `onWrite(hex, writes)` runs before it answers (to press STOP at an exact moment). */
function fakeLaser({ files = [], silent = false, onWrite } = {}) {
  const writes = [];
  let push;
  const readable = new ReadableStream({ start(c) { push = (b) => c.enqueue(swizzle(b, M)); } });
  const writable = new WritableStream({
    write(chunk) {
      const plain = unswizzle(chunk, M);
      writes.push(hex(plain));
      onWrite?.(hex(plain), writes);
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

test('same name, Replace pressed: deletes exactly that one slot', async () => {
  const writes = fakeLaser({ files: ['AB C-1', 'TEST1'] });
  const l = await link();
  assert.equal(await l.sendToPanel(JOB, 'TEST1', { replace: true }), true);
  assert.deepEqual(writes, ['da000405', 'e8010001', 'e8010002', 'e8010002', 'e80000020002', 'e802e701544553543100d812d7']);
  await l.disconnect();
});

test('same name without Replace (another student\'s job): nothing is deleted or sent', async () => {
  const writes = fakeLaser({ files: ['AB C-1', 'TEST1'] });
  const l = await link();
  await assert.rejects(l.sendToPanel(JOB, 'TEST1'), /already on the laser/);
  assert.deepEqual(writes, ['da000405', 'e8010001', 'e8010002']);
  assert.ok(!writes.some((w) => w.startsWith('e800')), 'no delete');
  assert.equal(l.sending, false);
  await l.disconnect();
});

test('listNames only reads the list', async () => {
  const writes = fakeLaser({ files: ['AB C-1', 'TEST1'] });
  const l = await link();
  assert.deepEqual(await l.listNames(), ['AB C-1', 'TEST1']);
  assert.deepEqual(writes, ['da000405', 'e8010001', 'e8010002']);
  await l.disconnect();
});

test('STOP while the slot is read again: the old file is never deleted', async () => {
  let l;
  const writes = fakeLaser({
    files: ['AB C-1', 'TEST1'],
    // the re-read of slot 2 (its second read): press STOP before the laser answers
    onWrite: (h, all) => { if (h === 'e8010002' && all.filter((w) => w === h).length === 2) void l.stop(); },
  });
  l = await link();
  await assert.rejects(l.sendToPanel(JOB, 'TEST1', { replace: true }), /Stopped/);
  assert.ok(!writes.some((w) => w.startsWith('e800')), `no delete in ${writes}`);
  assert.ok(!writes.some((w) => w.startsWith('e802')), 'no job');
  assert.ok(writes.includes('d801'), 'STOP went out');
  await l.disconnect();
});

test('STOP while the list is read: nothing is deleted or sent', async () => {
  let l;
  const writes = fakeLaser({
    files: ['TEST1', 'B', 'C'],
    onWrite: (h) => { if (h === 'e8010001') void l.stop(); },
  });
  l = await link();
  await assert.rejects(l.sendToPanel(JOB, 'TEST1', { replace: true }), /Stopped/);
  assert.ok(!writes.some((w) => w.startsWith('e800') || w.startsWith('e802')), `${writes}`);
  await l.disconnect();
});

test('STOP stuck behind a write the port is holding says so within its time limit', async () => {
  const port = {
    readable: new ReadableStream({ start() {} }),
    writable: new WritableStream({ write: () => new Promise(() => {}) }), // hardware flow control never lets go
    open: async () => {},
    close: async () => {},
    getInfo: () => ({ usbVendorId: 0x0403 }),
  };
  Object.defineProperty(globalThis, 'navigator', { value: { serial: { getPorts: async () => [port], addEventListener() {}, removeEventListener() {} } }, configurable: true });
  const l = new LaserLink({ baud: 115200, magic: M });
  await l.connect();
  void l.send(new Uint8Array(4096)).catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  const t = Date.now();
  assert.equal(await l.stop(100), false, 'not sent: press the E-stop');
  assert.ok(Date.now() - t < 2000);
  await l.hardClose();
});

test('STOP on a healthy port reports it was sent', async () => {
  const writes = fakeLaser();
  const l = await link();
  assert.equal(await l.stop(), true);
  assert.deepEqual(writes, ['d801']);
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

// Dalton 2026-10-05: the USB picker "never showed again". Any remembered port used to be reused, so a
// wrong one picked once stuck. choosePort only reuses the port that worked, or the one FTDI port.
const { choosePort } = await import('../src/serial/laser.ts');
const p = (vid, pid) => ({ vid, pid, getInfo: () => ({ usbVendorId: vid, usbProductId: pid }) });

test('the port that worked last time is reused', () => {
  const laser = p(0x1a86, 0x7523);
  assert.equal(choosePort([p(0x0403, 0x6001), laser], { vid: 0x1a86, pid: 0x7523 }), laser);
});

test('with nothing remembered, only a single FTDI port is reused', () => {
  const ftdi = p(0x0403, 0x6001);
  assert.equal(choosePort([p(0x2341, 0x0043), ftdi], null), ftdi);
  assert.equal(choosePort([p(0x0403, 0x6001), p(0x0403, 0x6015)], null), null); // two: ask
});

test('some other remembered port is never picked on its own: the picker shows instead', () => {
  assert.equal(choosePort([p(0x2341, 0x0043)], null), null);
  assert.equal(choosePort([p(0x2341, 0x0043)], { vid: 0x1a86, pid: 0x7523 }), null);
  assert.equal(choosePort([], null), null);
});

test('Reset USB never hangs on a stuck write, and says when the port did not close', async () => {
  const port = {
    readable: new ReadableStream({ start() {} }),
    writable: new WritableStream({ write: () => new Promise(() => {}) }), // the USB driver never finishes
    open: async () => {},
    close: () => new Promise(() => {}), // like Chrome waiting on a driver that never empties
    getInfo: () => ({ usbVendorId: 0x0403 }),
  };
  Object.defineProperty(globalThis, 'navigator', { value: { serial: { getPorts: async () => [port], addEventListener() {}, removeEventListener() {} } }, configurable: true });
  const l = new LaserLink({ baud: 115200, magic: M });
  await l.connect();
  void l.send(new Uint8Array(4096)).catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  const t = Date.now();
  assert.equal(await l.hardClose(), false, 'reports the port as stuck');
  assert.ok(Date.now() - t < 5000, 'gives up in time');
  assert.equal(l.connected, false);
});

test('Reset USB closes a healthy port', async () => {
  let closed = false;
  const port = {
    readable: new ReadableStream({ start() {} }),
    writable: new WritableStream({ write() {} }),
    open: async () => {},
    close: async () => { closed = true; },
    getInfo: () => ({ usbVendorId: 0x0403 }),
  };
  Object.defineProperty(globalThis, 'navigator', { value: { serial: { getPorts: async () => [port], addEventListener() {}, removeEventListener() {} } }, configurable: true });
  const l = new LaserLink({ baud: 115200, magic: M });
  await l.connect();
  assert.equal(await l.hardClose(), true);
  assert.equal(closed, true);
});
