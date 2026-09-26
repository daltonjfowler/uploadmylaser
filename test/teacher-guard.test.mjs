// The failure-path-only guard on wrong teacher keys.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GLOBAL_TEACHER_LOCK_MS, GLOBAL_TEACHER_MAX_FAILURES, GLOBAL_TEACHER_WINDOW_MS, minutesPhrase, TeacherKeyGuard,
} from '../src/teacher-guard.ts';

const T0 = 5_000_000;

test('100 wrong keys do not arm it; the 101st does', () => {
  const g = new TeacherKeyGuard();
  for (let i = 0; i < GLOBAL_TEACHER_MAX_FAILURES; i++) assert.equal(g.recordFailure(T0 + i).locked, false, `failure ${i + 1}`);
  const v = g.recordFailure(T0 + 100);
  assert.equal(v.locked, true);
  assert.equal(v.retryAfterSeconds, GLOBAL_TEACHER_LOCK_MS / 1000);
  assert.equal(v.retryAfterMinutes, 15);
});

test('while armed, more failures neither count nor extend the lock', () => {
  const g = new TeacherKeyGuard();
  for (let i = 0; i <= GLOBAL_TEACHER_MAX_FAILURES; i++) g.recordFailure(T0);
  const before = g.failures;
  const v = g.recordFailure(T0 + 60_000);
  assert.equal(g.failures, before);
  assert.equal(v.retryAfterSeconds, (GLOBAL_TEACHER_LOCK_MS - 60_000) / 1000);
});

test('the lock lifts after 15 minutes and the count starts over', () => {
  const g = new TeacherKeyGuard();
  for (let i = 0; i <= GLOBAL_TEACHER_MAX_FAILURES; i++) g.recordFailure(T0);
  const v = g.recordFailure(T0 + GLOBAL_TEACHER_LOCK_MS);
  assert.equal(v.locked, false);
  assert.equal(g.failures, 1);
});

test('failures older than the window age out', () => {
  const g = new TeacherKeyGuard();
  for (let i = 0; i < GLOBAL_TEACHER_MAX_FAILURES; i++) g.recordFailure(T0);
  assert.equal(g.recordFailure(T0 + GLOBAL_TEACHER_WINDOW_MS + 1).locked, false);
  assert.equal(g.failures, 1);
});

test('minutesPhrase', () => {
  assert.equal(minutesPhrase({ retryAfterMinutes: 1 }), '1 minute');
  assert.equal(minutesPhrase({ retryAfterMinutes: 14 }), '14 minutes');
});

test('the last second still reads as 1 minute, never 0', () => {
  const g = new TeacherKeyGuard();
  for (let i = 0; i <= GLOBAL_TEACHER_MAX_FAILURES; i++) g.recordFailure(T0);
  const v = g.recordFailure(T0 + GLOBAL_TEACHER_LOCK_MS - 500);
  assert.equal(v.locked, true);
  assert.equal(v.retryAfterSeconds, 1);
  assert.equal(v.retryAfterMinutes, 1);
});
