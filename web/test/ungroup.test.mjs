import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pieceSvg, splitPieces } from '../src/ungroup.ts';

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];

test('two separate outlines are two pieces; a hole stays with its outline', () => {
  const pieces = splitPieces([
    { kind: 'cut', pts: rect(0, 0, 50, 50) },
    { kind: 'cut', pts: rect(10, 10, 10, 10) }, // hole
    { kind: 'engrave', pts: rect(30, 30, 5, 5) }, // engraving inside
    { kind: 'cut', pts: rect(100, 0, 20, 20) },
  ]);
  assert.equal(pieces.length, 2);
  assert.deepEqual(pieces.map((p) => p.lines.length), [3, 1]);
  assert.deepEqual(pieces[0].box, [0, 0, 50, 50]);
});

test('a box drawn as four loose lines is one piece and keeps its hole', () => {
  const pieces = splitPieces([
    { kind: 'cut', pts: [[0, 0], [40, 0]] },
    { kind: 'cut', pts: [[40, 40], [40, 0]] }, // drawn backwards
    { kind: 'cut', pts: [[40, 40], [0, 40]] },
    { kind: 'cut', pts: [[0, 40], [0, 0]] },
    { kind: 'cut', pts: rect(10, 10, 5, 5) },
    { kind: 'score', pts: [[60, 0], [80, 0]] }, // a loose mark on its own
  ]);
  assert.deepEqual(pieces.map((p) => p.lines.length), [5, 1]);
});

test('a piece outside a concave outline but inside its box is its own piece', () => {
  const L = [[0, 0], [50, 0], [50, 10], [10, 10], [10, 50], [0, 50], [0, 0]];
  const pieces = splitPieces([{ kind: 'cut', pts: L }, { kind: 'cut', pts: rect(30, 30, 10, 10) }]);
  assert.equal(pieces.length, 2);
});

test('the SVG is in mm from the piece corner, one path per colour', () => {
  const [p] = splitPieces([{ kind: 'cut', pts: rect(100, 20, 30, 10) }, { kind: 'engrave', pts: rect(105, 22, 5, 5) }]);
  const svg = pieceSvg(p);
  assert.match(svg, /width="30mm" height="10mm" viewBox="0 0 30 10"/);
  assert.match(svg, /<path d="M5 2L10 2 10 7 5 7 5 2Z" fill="#0000ff"/);
  assert.match(svg, /<path d="M0 0L30 0 30 10 0 10 0 0Z" fill="none" stroke="#000000"/);
});
