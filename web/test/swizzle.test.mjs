// Run with `npm test` (Node 22.18+ strips TS types natively).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STOP_PROCESS, swizzle, swizzleByte, unswizzle } from '../src/ruida/swizzle.ts';

test('swizzle is a bijection and round-trips', () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.equal(new Set(all.map((b) => swizzleByte(b, 0x88))).size, 256);
  assert.deepEqual(unswizzle(swizzle(all, 0x88), 0x88), all);
});

test('STOP stays two bytes after swizzling', () => {
  assert.equal(swizzle(STOP_PROCESS, 0x88).length, 2);
});
