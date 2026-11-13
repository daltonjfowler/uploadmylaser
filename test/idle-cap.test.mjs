// The container idle cap (src/idle-cap.ts). Guards the 2026-11-09 bill leak: a request the
// containers library still counted as in flight kept the laser container awake ~5 h with no users.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CONTAINER_TIMEOUT_MS, IDLE_CAP_MS, idleCapAction, idleCapReached, KILL_AFTER_MS, SLEEP_AFTER_MS } from '../src/idle-cap.ts';

const MIN = 60_000;
const LIBRARY_ALARM_MAX_MS = 3 * MIN; // @cloudflare/containers re-arms its alarm at most 3 min apart

test('the cap only fires on a running container that has had no request for the cap', () => {
  const last = 1_000_000;
  assert.equal(idleCapReached(last + IDLE_CAP_MS, last, true), true);
  assert.equal(idleCapReached(last + IDLE_CAP_MS - 1, last, true), false);
  assert.equal(idleCapReached(last + 10 * IDLE_CAP_MS, last, false), false, 'never stops a stopped container');
});

test('the cap can never cut off a real request or beat the normal sleep clock', () => {
  assert.ok(IDLE_CAP_MS > CONTAINER_TIMEOUT_MS, 'longer than any container call is allowed to take');
  assert.ok(IDLE_CAP_MS > SLEEP_AFTER_MS, 'the normal 5 minute sleep still wins when nothing is stuck');
});

test('replay of 2026-11-09: a stuck request no longer holds the container awake for hours', () => {
  // Last real request at noon. The library sees one request still in flight, so its own sleep
  // clock never fires; it just wakes every 3 minutes. Before the cap this ran until 5 pm.
  const noon = Date.UTC(2026, 10, 9, 17, 0);
  let stoppedAt = null;
  for (let t = noon; t <= noon + 5 * 60 * MIN; t += LIBRARY_ALARM_MAX_MS) {
    if (idleCapReached(t, noon, true)) { stoppedAt = t; break; }
  }
  assert.notEqual(stoppedAt, null, 'the cap stopped it');
  assert.ok(stoppedAt - noon <= IDLE_CAP_MS + LIBRARY_ALARM_MAX_MS, `stopped ${(stoppedAt - noon) / MIN} min after the last request`);
});

test('SIGTERM first, SIGKILL only if it is still up a minute later, and a new request resets both', () => {
  const last = 1_000_000;
  const capAt = last + IDLE_CAP_MS;
  assert.equal(idleCapAction(capAt - 1, last, true, null), 'none');
  assert.equal(idleCapAction(capAt, last, true, null), 'stop');
  assert.equal(idleCapAction(capAt + KILL_AFTER_MS - 1, last, true, capAt), 'none', 'SIGTERM gets its minute');
  assert.equal(idleCapAction(capAt + KILL_AFTER_MS, last, true, capAt), 'kill');
  assert.equal(idleCapAction(capAt + KILL_AFTER_MS, last, false, capAt), 'none', 'it stopped: nothing to kill');
  // a stop sent before the latest request does not count
  const later = capAt + 5 * MIN;
  assert.equal(idleCapAction(later + 1, later, true, capAt), 'none', 'fresh request: no cap yet');
  assert.equal(idleCapAction(later + IDLE_CAP_MS, later, true, capAt), 'stop', 'old stop ignored: SIGTERM again, not SIGKILL');
});

test('replay with a hung container: killed within the cap + two alarm gaps', () => {
  const noon = Date.UTC(2026, 10, 9, 17, 0);
  let stopSentAt = null, killedAt = null;
  for (let t = noon; t <= noon + 5 * 60 * MIN; t += LIBRARY_ALARM_MAX_MS) {
    const a = idleCapAction(t, noon, true, stopSentAt); // SIGTERM ignored: still running
    if (a === 'stop') stopSentAt = t;
    if (a === 'kill') { killedAt = t; break; }
  }
  assert.notEqual(killedAt, null);
  assert.ok(killedAt - noon <= IDLE_CAP_MS + 2 * LIBRARY_ALARM_MAX_MS, `killed ${(killedAt - noon) / MIN} min after the last request`);
});

test('worker.ts wires the cap into the laser container', () => {
  const src = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
  const cls = src.slice(src.indexOf('export class LaserContainer'), src.indexOf('export class Counters'));
  assert.ok(cls.length > 0, 'LaserContainer found');
  assert.match(cls, /sleepAfter = '5m'/, 'sleepAfter matches SLEEP_AFTER_MS');
  assert.equal(SLEEP_AFTER_MS, 5 * MIN);
  // \n\s* anchors: a commented-out line must not count.
  assert.match(cls, /override async fetch\(request: Request\)[^\n]*\n\s*this\.#lastRequestAt = Date\.now\(\);\n\s*this\.#stopSentAt = null;\n\s*return super\.fetch\(request\);/, 'every request resets the clock, then goes through');
  assert.match(cls, /override async alarm\([\s\S]*?\n\s*const action = idleCapAction\(now, this\.#lastRequestAt,[\s\S]*?\n\s*await this\.stop\(\);[\s\S]*?\n\s*await this\.destroy\(\);[\s\S]*?\n\s*return super\.alarm\(alarmProps\);/, 'the alarm checks the cap, stops or kills, then runs the library loop');
  assert.match(cls, /\n {2}#lastRequestAt = Date\.now\(\);\n/, 'clock starts at now, so a restart never stops a busy container');
});

test('the container exits soon after SIGTERM even with a stuck request', () => {
  const docker = readFileSync(new URL('../container/Dockerfile', import.meta.url), 'utf8');
  const cmd = docker.split('\n').find((l) => l.startsWith('CMD '));
  assert.match(cmd, /"--timeout-graceful-shutdown", "(\d+)"/);
  assert.ok(Number(cmd.match(/"--timeout-graceful-shutdown", "(\d+)"/)[1]) * 1000 < KILL_AFTER_MS);
});
