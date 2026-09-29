import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import { test } from 'node:test';

// timingSafeEqual on crypto.subtle is a Cloudflare Workers extension; Node has the same thing elsewhere.
if (!crypto.subtle.timingSafeEqual) {
  crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}
const { anyKeyEquals } = await import('../src/constant-time.ts');

test('a teacher key matches either of the two keys, and nothing else', async () => {
  assert.equal(await anyKeyEquals('first-key', ['first-key', 'second-key']), true);
  assert.equal(await anyKeyEquals('second-key', ['first-key', 'second-key']), true);
  assert.equal(await anyKeyEquals('second-ke', ['first-key', 'second-key']), false);
  assert.equal(await anyKeyEquals('', ['first-key']), false);
  assert.equal(await anyKeyEquals('anything', []), false);
});
