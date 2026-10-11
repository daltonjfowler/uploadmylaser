// Send to panel. Expected bytes follow the Ruida file commands in MeerK40t's emulator (MIT).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanPanelName, deleteOneFile, namePacket, parseReplies, readFileName, readMemory } from '../src/ruida/panel.ts';

const hex = (u8) => Buffer.from(u8).toString('hex');

test('name packet: E8 02 file transfer, then E7 01 <name> 00', () => {
  assert.equal(hex(namePacket('TEST1')), 'e802e701544553543100');
  assert.equal(hex(namePacket('AB C-1')), 'e802e70141422043 2d3100'.replace(/ /g, ''));
});

test('names are cleaned to capitals, 8 characters at most', () => {
  assert.equal(cleanPanelName('ab c-1'), 'AB C-1');
  assert.equal(cleanPanelName('STUDENTNAME12'), 'STUDENTN');
  assert.equal(cleanPanelName('  Zoë_s  tag!! '), 'ZOS TAG');
  assert.equal(cleanPanelName('***'), '');
  assert.throws(() => namePacket('lower'));
  assert.throws(() => namePacket(''));
});

test('delete one file is E8 00 <slot> <slot>, and delete-all can never be built', () => {
  assert.equal(hex(deleteOneFile(1)), 'e800000100 01'.replace(/ /g, ''));
  assert.equal(hex(deleteOneFile(130)), 'e800010201 02'.replace(/ /g, '')); // 7-bit bytes
  for (const bad of [0, -1, 1.5, NaN, 201, Infinity]) assert.throws(() => deleteOneFile(bad), String(bad));
});

test('read commands: DA 00 memory, E8 01 file name', () => {
  assert.equal(hex(readMemory(0x0205)), 'da000405');
  assert.equal(hex(readFileName(3)), 'e8010003');
});

test('replies are parsed, even when split across reads', () => {
  const count = Uint8Array.from(Buffer.from('da0104050000000003', 'hex'));
  const name = Uint8Array.from(Buffer.from('e80100025354554445 4e544e00'.replace(/ /g, ''), 'hex'));
  const ack = Uint8Array.of(0xcc);
  const all = Uint8Array.from([...ack, ...count, ...name]);
  assert.deepEqual(parseReplies(all).replies, [
    { kind: 'mem', addr: 0x0205, value: 3 },
    { kind: 'name', slot: 2, name: 'STUDENTN' },
  ]);
  // Split in the middle of the name: nothing lost, the rest completes it.
  const first = parseReplies(all.subarray(0, 14));
  assert.equal(first.replies.length, 1);
  const rest = Uint8Array.from([...all.subarray(first.used, 14), ...all.subarray(14)]);
  assert.deepEqual(parseReplies(rest).replies, [{ kind: 'name', slot: 2, name: 'STUDENTN' }]);
  // A lone first byte waits for more.
  assert.equal(parseReplies(Uint8Array.of(0xda)).used, 0);
});

// "Keep both": a free name next to a taken one, within the controller's 8 characters.
const { freePanelName } = await import('../src/ruida/panel.ts');

test('Keep both picks a free name: a number on the end, still 8 characters at most', () => {
  assert.equal(freePanelName('DESIGN', ['DESIGN']), 'DESIGN2');
  assert.equal(freePanelName('DESIGN', ['DESIGN', 'DESIGN2', 'DESIGN3']), 'DESIGN4');
  assert.equal(freePanelName('JOB2', ['JOB2']), 'JOB3'); // counts on, not JOB22
  assert.equal(freePanelName('ABCDEFGH', ['ABCDEFGH']), 'ABCDEFG2');
  const many = ['ABCDEFGH', ...Array.from({ length: 8 }, (_, i) => `ABCDEFG${i + 2}`)];
  assert.equal(freePanelName('ABCDEFGH', many), 'ABCDEF10');
  assert.equal(freePanelName('AB CDEFG', ['AB CDEFG']), 'AB CDEF2');
  assert.equal(freePanelName('ABCDEF G', ['ABCDEF G']), 'ABCDEF2'); // no space before the number
  for (const n of ['DESIGN2', 'ABCDEF10', 'ABCDEF2']) assert.equal(namePacket(n).length > 0, true);
});

test('Keep both never returns the taken name, and gives up rather than guess', () => {
  const taken = ['X', ...Array.from({ length: 998 }, (_, i) => `X${i + 2}`)];
  assert.equal(freePanelName('X', taken), null);
  assert.equal(freePanelName('X', []), 'X2');
});
