import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pieceSvg, splitPieces } from '../src/ungroup.ts';

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];

test('every shape is its own piece, holes too', () => {
  const pieces = splitPieces([
    { kind: 'cut', pts: rect(0, 0, 50, 50) },
    { kind: 'cut', pts: rect(10, 10, 10, 10) }, // hole
    { kind: 'engrave', pts: rect(30, 30, 5, 5) }, // engraving inside
    { kind: 'cut', pts: rect(100, 0, 20, 20) },
  ]);
  assert.equal(pieces.length, 4);
  assert.deepEqual(pieces[0].box, [0, 0, 50, 50]);
});

test('an engraved shape keeps its holes, so the middle of an O stays empty', () => {
  const pieces = splitPieces([
    { kind: 'engrave', pts: rect(0, 0, 30, 30) },
    { kind: 'engrave', pts: rect(10, 10, 10, 10) },
    { kind: 'engrave', pts: rect(50, 0, 10, 10) },
  ]);
  assert.deepEqual(pieces.map((p) => p.lines.length), [2, 1]);
});

test('a box drawn as four loose lines is one piece', () => {
  const pieces = splitPieces([
    { kind: 'cut', pts: [[0, 0], [40, 0]] },
    { kind: 'cut', pts: [[40, 40], [40, 0]] }, // drawn backwards
    { kind: 'cut', pts: [[40, 40], [0, 40]] },
    { kind: 'cut', pts: [[0, 40], [0, 0]] },
    { kind: 'cut', pts: rect(10, 10, 5, 5) },
    { kind: 'score', pts: [[60, 0], [80, 0]] }, // a loose mark on its own
  ]);
  assert.deepEqual(pieces.map((p) => p.lines.length), [4, 1, 1]);
});

test('an engraved shape outside a concave engraved outline but inside its box is its own piece', () => {
  const L = [[0, 0], [50, 0], [50, 10], [10, 10], [10, 50], [0, 50], [0, 0]];
  const pieces = splitPieces([{ kind: 'engrave', pts: L }, { kind: 'engrave', pts: rect(30, 30, 10, 10) }]);
  assert.equal(pieces.length, 2);
});

test('the SVG is in mm from the piece corner, one path per colour', () => {
  const svg = pieceSvg({ lines: [{ kind: 'cut', pts: rect(100, 20, 30, 10) }, { kind: 'engrave', pts: rect(105, 22, 5, 5) }], box: [100, 20, 130, 30] });
  assert.match(svg, /width="30mm" height="10mm" viewBox="0 0 30 10"/);
  assert.match(svg, /<path d="M5 2L10 2 10 7 5 7 5 2Z" fill="#0000ff"/);
  assert.match(svg, /<path d="M0 0L30 0 30 10 0 10 0 0Z" fill="none" stroke="#000000"/);
});

test('a floor plan of touching wall lines splits at the junctions instead of being one piece', () => {
  // two rooms side by side sharing the middle wall: 7 lines, all touching
  const L = (a, b) => ({ kind: 'cut', pts: [a, b] });
  const plan = [
    L([0, 0], [100, 0]), L([100, 0], [200, 0]), L([200, 0], [200, 80]), L([200, 80], [100, 80]),
    L([100, 80], [0, 80]), L([0, 80], [0, 0]), L([100, 0], [100, 80]),
  ];
  const pieces = splitPieces(plan);
  assert.ok(pieces.length >= 3, `only ${pieces.length} piece(s)`);
  assert.equal(pieces.reduce((n, p) => n + p.lines.length, 0), 7, 'every line kept once');
});

test('a T of three lines splits into its three arms', () => {
  const L = (a, b) => ({ kind: 'cut', pts: [a, b] });
  assert.equal(splitPieces([L([0, 0], [50, 0]), L([50, 0], [100, 0]), L([50, 0], [50, 50])]).length, 3);
});
