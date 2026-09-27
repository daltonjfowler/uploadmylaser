// The Phase 0 serial test page streams any .rd file straight to the laser, past every server
// clamp and the Frame step. It must never be a production build input (dev server only).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('serial-test.html is not built for the live site', () => {
  const cfg = readFileSync(new URL('../web/vite.config.ts', import.meta.url), 'utf8');
  const inputs = cfg.slice(cfg.indexOf('input:'), cfg.indexOf('},', cfg.indexOf('input:')));
  assert.doesNotMatch(inputs, /serial-test/);
});
