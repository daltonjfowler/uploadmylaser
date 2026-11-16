import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rotateAngle } from '../src/rotate.ts';

const deg = (d) => (d * Math.PI) / 180;

test('dragging clockwise on screen is a negative (clockwise) turn, like AutoCAD', () => {
  // y points down: going from angle 0 to +30 on screen is clockwise
  assert.equal(rotateAngle(0, deg(30), false), -30);
  assert.equal(rotateAngle(0, deg(-45), false), 45);
});

test('whole degrees, quarter turns click in within 3 degrees, Shift gives 15 degree steps', () => {
  assert.equal(rotateAngle(0, deg(-12.4), false), 12);
  assert.equal(rotateAngle(0, deg(-88), false), 90);
  assert.equal(rotateAngle(0, deg(-86), false), 86);
  assert.equal(rotateAngle(0, deg(2), false), 0);
  assert.equal(rotateAngle(0, deg(-37), true), 30);
  assert.equal(rotateAngle(0, deg(-38), true), 45);
});

test('the angle wraps to -180..180 however far the pointer went round', () => {
  assert.equal(rotateAngle(deg(170), deg(-170), false), -20);
  assert.equal(rotateAngle(deg(-170), deg(170), false), 20);
  assert.equal(Math.abs(rotateAngle(0, deg(180), false)), 180);
});
