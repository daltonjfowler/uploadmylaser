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

// ---------- one layer at a time (Dalton 2026-11-12: detailed board game files would not ungroup usefully) ----------

/** A board: a frame around a 3 x 2 grid of tiles, each tile with engraved art (an "O" with its hole, a dot). */
function board(frameKind) {
  const lines = [{ kind: frameKind, pts: rect(0, 0, 200, 140) }];
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      const x = 10 + c * 63, y = 10 + r * 63;
      lines.push({ kind: 'cut', pts: rect(x, y, 55, 55) }); // tile
      lines.push({ kind: 'engrave', pts: rect(x + 5, y + 5, 30, 30) }); // "O"
      lines.push({ kind: 'engrave', pts: rect(x + 12, y + 12, 16, 16) }); // its hole
      lines.push({ kind: 'engrave', pts: rect(x + 42, y + 42, 6, 6) }); // a dot
    }
  }
  return lines;
}

test('one layer: a frame comes off, each tile keeps its art', () => {
  const pieces = splitPieces(board('cut'), 'level');
  assert.equal(pieces.length, 7); // frame + 6 tiles
  assert.deepEqual(pieces[0].box, [0, 0, 200, 140]);
  assert.equal(pieces[0].lines.length, 1);
  assert.ok(pieces.slice(1).every((p) => p.lines.length === 4), 'tile + O + hole + dot');
});

test('one layer again on a tile: the tile, the O with its hole, the dot', () => {
  const tile = splitPieces(board('cut'), 'level')[1].lines;
  const pieces = splitPieces(tile, 'level');
  assert.deepEqual(pieces.map((p) => p.lines.length).sort(), [1, 1, 2]);
});

test('tiles side by side with no frame: each tile with its art', () => {
  const pieces = splitPieces(board('cut').slice(1), 'level');
  assert.equal(pieces.length, 6);
});

test('all the way: every shape, an engraved O keeps only its hole', () => {
  const pieces = splitPieces(board('cut'), 'all');
  assert.equal(pieces.length, 1 + 6 * 3);
});

test('an engraved board: its holes stay, but the art inside the holes comes apart', () => {
  // engraved panel with 6 holes (the tiles as holes), and engraved art filled again inside each hole
  const lines = [{ kind: 'engrave', pts: rect(0, 0, 200, 140) }];
  for (let c = 0; c < 6; c++) {
    lines.push({ kind: 'engrave', pts: rect(5 + c * 32, 20, 30, 30) }); // hole
    lines.push({ kind: 'engrave', pts: rect(10 + c * 32, 25, 20, 20) }); // island: filled again
  }
  const level = splitPieces(lines, 'level');
  assert.equal(level.length, 7); // panel with its 6 holes, then each island
  assert.equal(level[0].lines.length, 7);
  assert.equal(splitPieces(lines, 'all').length, 7);
});

test('one layer on a big floor plan of thousands of shapes is quick', () => {
  const lines = [{ kind: 'cut', pts: rect(0, 0, 1000, 1000) }];
  for (let i = 0; i < 60; i++) for (let j = 0; j < 60; j++) lines.push({ kind: 'engrave', pts: rect(5 + i * 16, 5 + j * 16, 10, 10) });
  const t = Date.now();
  const pieces = splitPieces(lines, 'level');
  assert.equal(pieces.length, 3601);
  assert.ok(Date.now() - t < 3000, `${Date.now() - t} ms`);
});
