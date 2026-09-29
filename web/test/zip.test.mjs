import assert from 'node:assert/strict';
import { test } from 'node:test';

import { crc32, zip } from '../src/zip.ts';

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip lists every file, stored as-is', () => {
  const a = new TextEncoder().encode('hello');
  const b = Uint8Array.from([0, 1, 2, 255]);
  const z = zip([{ name: 'a.txt', data: a }, { name: 'READ ME.txt', data: b }]);
  const v = new DataView(z.buffer);
  assert.equal(v.getUint32(0, true), 0x04034b50);
  const end = z.length - 22;
  assert.equal(v.getUint32(end, true), 0x06054b50);
  assert.equal(v.getUint16(end + 10, true), 2);
  // the file bytes sit right after the first local header and name
  assert.deepEqual([...z.subarray(30 + 5, 30 + 5 + 5)], [...a]);
});
