// The site logos in the Shapes library: each one is a Cut tile, an Engrave layer and a Mark layer,
// and every engraved shape is closed (an open one cannot be filled).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIBRARY } from '../src/library.ts';

const logos = LIBRARY.filter((s) => s.group === 'Logos');

test('the four uploadmy logos and teachChat, each with Cut, Engrave and Mark layers', () => {
  assert.deepEqual(logos.map((s) => s.label), ['uploadmylaser', 'uploadmymodel', 'uploadmycode', 'uploadmycut', 'teachChat']);
  for (const s of logos) {
    assert.ok(s.closed && s.d.trim().endsWith('Z'), `${s.label}: the tile is one closed outline`);
    assert.ok(s.engrave, `${s.label}: engrave layer`);
    assert.ok(s.detail, `${s.label}: mark layer`);
  }
  assert.equal(new Set(LIBRARY.map((s) => s.id)).size, LIBRARY.length, 'library ids are unique');
});

test('every engraved shape is closed', () => {
  for (const s of logos) {
    const subpaths = s.engrave.split(/(?=M)/).map((p) => p.trim()).filter(Boolean);
    assert.ok(subpaths.length >= 3, `${s.label}: three solid shapes at least`);
    for (const p of subpaths) assert.ok(p.endsWith('Z'), `${s.label}: "${p.slice(0, 30)}…" is not closed`);
  }
});
