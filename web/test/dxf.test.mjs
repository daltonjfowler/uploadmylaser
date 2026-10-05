// The browser's quick DXF outline (web/src/dxf.ts), so a DXF part isn't blank before the server checks it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { binaryStringToBytes, bytesToBinaryString, dxfFlavour, sketchDxf } from '../src/dxf.ts';

// Saved by ezdxf as AutoCAD 2013 (AC1027), in inches: a 2 x 1 in polyline whose bottom edge is a
// half-circle bulge (dips to y = -1), a scaled and rotated block of a circle, a line on a layer that is
// turned off, some text, and a big line on the layout tab (paper space).
const R2013 = readFileSync(new URL('./fixtures/autocad-2013.dxf', import.meta.url), 'utf8');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg}: ${a} vs ${b}`);

test('an AutoCAD 2013 DXF sketches its model-space lines, in its units', () => {
  const sk = sketchDxf(R2013);
  assert.ok(sk, 'no sketch');
  assert.equal(sk.mmPerUnit, 25.4);
  // the hidden-layer line (to 50, 50) and the paper-space line (to 500, 500) are left out
  near(sk.vb.w, 2, 'width');
  near(sk.vb.h, 2, 'height (bulge dips to y = -1)');
  near(sk.vb.x, 0, 'x');
  near(sk.vb.y, -1, 'top, y down');
  assert.match(sk.d, /^M/);
});

test('CRLF line ends and a UTF-8 BOM make no difference', () => {
  const sk = sketchDxf('﻿' + R2013.replace(/\r?\n/g, '\r\n'));
  assert.ok(sk);
  near(sk.vb.w, 2, 'width');
});

test('a drawing only on the layout tab still sketches', () => {
  const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', '0', '67', '1', '10', '0', '20', '0', '11', '30', '21', '40', '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
  const sk = sketchDxf(dxf);
  assert.ok(sk);
  near(sk.vb.w, 30, 'width');
  near(sk.vb.h, 40, 'height');
  assert.equal(sk.mmPerUnit, 1);
});

test('nothing drawable gives null, so the part shows its name until the server explains', () => {
  const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'TEXT', '8', '0', '1', 'HI', '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
  assert.equal(sketchDxf(dxf), null);
  assert.equal(sketchDxf('not a dxf at all'), null);
});

test('binary DXF and DWG are told apart from ASCII', () => {
  assert.equal(dxfFlavour(R2013.slice(0, 32)), 'ascii');
  assert.equal(dxfFlavour('AutoCAD Binary DXF\r\n\x1a\0'), 'binary');
  assert.equal(dxfFlavour('AC1027\0\0\0'), 'dwg');
  assert.equal(sketchDxf('AutoCAD Binary DXF\r\n\x1a\0'), null);
});

test('a binary DXF survives being kept as a string', () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, i) => (i * 37) & 0xff);
  assert.deepEqual(binaryStringToBytes(bytesToBinaryString(bytes)), bytes);
});

// Dalton 2026-10-05: DXFs came in "boxy or with objects moved". Each fixture's sketch must sit where the
// server (ezdxf, with exact block matrices) puts it. Boxes below are the server's, in drawing units.
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const boxOf = (sk) => [sk.vb.x, -sk.vb.y - sk.vb.h, sk.vb.x + sk.vb.w, -sk.vb.y];
const sameBox = (got, want, msg) => got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 0.2, `${msg}: ${got} vs ${want}`));

test('splines follow the curve, not their control points; mirrored ellipses and splines stay put', () => {
  // the old sketch drew the control polygon (down to y = -40) and threw mirrored ones ~1000 units away
  sameBox(boxOf(sketchDxf(fixture('curves-mirrored.dxf'))), [400, 0, 600, 241.26], 'curves');
});

test('MINSERT draws every copy in its grid', () => {
  const sk = sketchDxf(fixture('minsert.dxf'));
  assert.equal(sk.d.split('M').length - 1, 12);
  sameBox(boxOf(sk), [492, 92, 558, 198], 'grid');
});

test('a block in a rotated, unevenly scaled block lands where AutoCAD draws it', () => {
  sameBox(boxOf(sketchDxf(fixture('nested-skew.dxf'))), [570.4, 281.13, 651.86, 378.45], 'skew');
});
