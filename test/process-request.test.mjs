// Strict validation + rebuild of the student's /api/process request (safety invariant 1).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_PARTS } from '../shared/contracts.ts';
import { HttpError } from '../src/http.ts';
import { MAX_REQUEST_JSON_BYTES, parseProcessRequest, validateProcessRequest } from '../src/process-request.ts';

const FILES = new Set([0, 1]);
const place = { xMm: 10, yMm: 20, scale: 1, rotateDeg: 0 };
const filePart = () => ({ kind: 'file', fileIndex: 0, fileType: 'svg', ...place });
const textPart = () => ({ kind: 'text', text: { value: 'Ava', font: 'stencil', heightMm: 25, op: 'cut' }, ...place, rotateDeg: 90 });
const good = () => ({
  materialId: 'masonite-luan',
  parts: [filePart(), textPart(), { kind: 'file', fileIndex: 1, fileType: 'dxf', xMm: -5, yMm: 4999, scale: 20, rotateDeg: 270 }],
  colorMap: { '#ff0000': 'score', 'layer CUT': 'cut', '#00ff00': 'ignore' },
  powerChoice: { engrave: 25 },
});

function rejects(body, re, files = FILES) {
  assert.throws(() => validateProcessRequest(body, files), (e) => {
    assert.ok(e instanceof HttpError, 'HttpError');
    assert.equal(e.status, 400);
    if (re) assert.match(e.message, re);
    return true;
  });
}

test('a valid request passes and comes back equal', () => {
  assert.deepEqual(validateProcessRequest(good(), FILES), good());
});

test('colorMap and powerChoice are optional', () => {
  const b = good();
  delete b.colorMap;
  delete b.powerChoice;
  const out = validateProcessRequest(b, FILES);
  assert.equal('colorMap' in out, false);
  assert.equal('powerChoice' in out, false);
});

test('power/speed smuggled anywhere are dropped, not forwarded', () => {
  const b = good();
  Object.assign(b, { powerMaxPct: 100, speedMmS: 1, material: { ops: {} }, machine: { absoluteMaxPowerPct: 100 } });
  Object.assign(b.parts[0], { powerMaxPct: 100, speedMmS: 1, passes: 50, extra: 'x' });
  Object.assign(b.parts[1].text, { powerMaxPct: 100, speedMmS: 1 });
  b.powerChoice.speedMmS = 1;
  b.powerChoice.bogus = 3;
  const out = validateProcessRequest(b, FILES);
  assert.deepEqual(out, good());
  const s = JSON.stringify(out);
  assert.doesNotMatch(s, /powerMaxPct|speedMmS|passes|extra|machine|bogus/);
});

test('materialId must be a short string', () => {
  for (const id of [undefined, '', 7, 'x'.repeat(65), ['a']]) rejects({ ...good(), materialId: id }, /material/);
});

test('parts: 1..MAX_PARTS of objects', () => {
  rejects({ ...good(), parts: [] });
  rejects({ ...good(), parts: 'nope' });
  rejects({ ...good(), parts: undefined });
  rejects({ ...good(), parts: Array.from({ length: MAX_PARTS + 1 }, textPart) }, /too many/);
  assert.equal(validateProcessRequest({ ...good(), parts: Array.from({ length: MAX_PARTS }, textPart) }, FILES).parts.length, MAX_PARTS);
  rejects({ ...good(), parts: [null] });
  rejects({ ...good(), parts: [{ ...filePart(), kind: 'image' }] });
});

test('file parts need an integer fileIndex with a matching file field, and svg/dxf', () => {
  for (const fileIndex of [2, -1, 0.5, '0', null, MAX_PARTS]) rejects({ ...good(), parts: [{ ...filePart(), fileIndex }] }, /missing/);
  rejects({ ...good(), parts: [filePart()] }, /missing/, new Set());
  for (const fileType of ['png', 'text', undefined, 'SVG']) rejects({ ...good(), parts: [{ ...filePart(), fileType }] }, /SVG or DXF/);
});

test('placement bounds', () => {
  for (const bad of [
    { xMm: 5001 }, { xMm: -5001 }, { yMm: 1e9 }, { xMm: NaN }, { xMm: '10' }, { yMm: undefined },
    { scale: 0 }, { scale: -1 }, { scale: 20.01 }, { scale: Infinity }, { scale: '1' },
    { scaleY: 0 }, { scaleY: 21 }, { scaleY: '2' }, { scaleY: null }, { scaleY: NaN },
    { rotateDeg: 45 }, { rotateDeg: '90' }, { rotateDeg: 360 }, { rotateDeg: undefined },
  ]) rejects({ ...good(), parts: [{ ...filePart(), ...bad }] }, undefined);
});

test('text: value 1..60 chars, known font, height 1..200, an op', () => {
  const withText = (t) => ({ ...good(), parts: [{ ...textPart(), text: { ...textPart().text, ...t } }] });
  for (const value of ['', '   ', 7, undefined, 'x'.repeat(61), 'a\u0000b', 'tab\there']) rejects(withText({ value }));
  assert.ok(validateProcessRequest(withText({ value: 'x'.repeat(60) }), FILES));
  assert.ok(validateProcessRequest(withText({ value: '😀'.repeat(60) }), FILES), '60 emoji are 60 characters');
  for (const font of ['comic', '', undefined, 'Sans']) rejects(withText({ font }), /font/);
  for (const heightMm of [0.5, 201, NaN, '25', undefined]) rejects(withText({ heightMm }), /height/);
  for (const op of ['ignore', 'burn', undefined]) rejects(withText({ op }));
  rejects({ ...good(), parts: [{ ...textPart(), text: 'Ava' }] });
});

test('colorMap: values are ColorChoice, keys <= 200 chars, <= 100 entries', () => {
  rejects({ ...good(), colorMap: { '#000': 'burn' } });
  rejects({ ...good(), colorMap: { '#000': 1 } });
  rejects({ ...good(), colorMap: { ['k'.repeat(201)]: 'cut' } });
  rejects({ ...good(), colorMap: ['cut'] });
  rejects({ ...good(), colorMap: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`#${i}`, 'cut'])) }, /colours/);
  assert.ok(validateProcessRequest({ ...good(), colorMap: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`#${i}`, 'cut'])) }, FILES));
});

test('a __proto__ colour key stays plain data', () => {
  const out = parseProcessRequest(JSON.stringify({ ...good(), colorMap: JSON.parse('{"__proto__":"cut"}') }), FILES);
  assert.equal(Object.getPrototypeOf(out.colorMap), Object.prototype);
  assert.equal(Object.hasOwn(out.colorMap, '__proto__'), true);
});

test('powerChoice: finite 0..100 for op kinds only', () => {
  for (const v of [NaN, '25', -1, 101, null]) rejects({ ...good(), powerChoice: { engrave: v } }, /Power/);
  rejects({ ...good(), powerChoice: 5 });
  assert.deepEqual(validateProcessRequest({ ...good(), powerChoice: { cut: 0, score: 100, laser: 99 } }, FILES).powerChoice, { cut: 0, score: 100 });
});

test('parseProcessRequest: needs a JSON string of sane size', () => {
  assert.deepEqual(parseProcessRequest(JSON.stringify(good()), FILES), good());
  for (const raw of [null, undefined, '', '{not json', 'x'.repeat(MAX_REQUEST_JSON_BYTES + 1)]) {
    assert.throws(() => parseProcessRequest(raw, FILES), HttpError);
  }
  assert.throws(() => parseProcessRequest('[]', FILES), HttpError);
  assert.throws(() => parseProcessRequest('null', FILES), HttpError);
});

test('scaleY: optional stretch, kept only when sent', () => {
  const stretched = validateProcessRequest({ ...good(), parts: [{ ...filePart(), scaleY: 2.5 }] }, FILES);
  assert.equal(stretched.parts[0].scaleY, 2.5);
  const plain = validateProcessRequest({ ...good(), parts: [filePart()] }, FILES);
  assert.equal('scaleY' in plain.parts[0], false);
});

test('copies may share one file', () => {
  const r = validateProcessRequest({ ...good(), parts: [filePart(), filePart(), filePart()] }, FILES);
  assert.equal(r.parts.length, 3);
});
