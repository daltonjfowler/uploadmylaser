// Two processors: who gets which job. The clock is passed in, so no real waiting.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { LINE_STALE_MS, MAX_IN_FLIGHT, PROCESSOR_NAMES, ProcessorLine } from '../src/processor-line.ts';

const T0 = 1_000_000;

test('one job at a time always goes to the first container (the second stays asleep)', () => {
  const line = new ProcessorLine();
  for (let i = 0; i < 20; i++) {
    const t = line.join(`a${i}`, T0 + i * 1000);
    assert.equal(t.container, 0);
    line.leave(t.token);
  }
});

test('overlapping jobs spread over both, least busy first', () => {
  const line = new ProcessorLine();
  assert.equal(line.join('a', T0).container, 0);
  assert.equal(line.join('b', T0).container, 1);
  assert.equal(line.join('c', T0).container, 0);
  assert.deepEqual(line.busy(T0), [2, 1]);
  line.leave('a');
  line.leave('c');
  assert.equal(line.join('d', T0).container, 0); // 0 and 1 both have one now: tie to the first
});

test('a job that never says it finished stops counting after LINE_STALE_MS', () => {
  const line = new ProcessorLine();
  line.join('lost', T0);
  assert.equal(line.join('next', T0 + 1).container, 1);
  line.leave('next');
  assert.equal(line.join('later', T0 + LINE_STALE_MS).container, 0); // "lost" expired
  assert.deepEqual(line.busy(T0 + LINE_STALE_MS), [1, 0]);
});

test('leaving twice, or with an unknown token, is harmless', () => {
  const line = new ProcessorLine();
  const t = line.join('x', T0);
  line.leave(t.token);
  line.leave(t.token);
  line.leave('never-joined');
  assert.deepEqual(line.busy(T0), [0, 0]);
});

test('a flood cannot grow the line without bound', () => {
  const line = new ProcessorLine();
  for (let i = 0; i < MAX_IN_FLIGHT + 50; i++) line.join(`f${i}`, T0);
  assert.equal(line.busy(T0).reduce((a, b) => a + b, 0), MAX_IN_FLIGHT);
});

test('there are as many container names as wrangler.jsonc allows instances, and the first is the old one', () => {
  const cfg = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const block = cfg.slice(cfg.indexOf('"class_name": "LaserContainer"'));
  const max = Number(/"max_instances":\s*(\d+)/.exec(block)[1]);
  assert.equal(PROCESSOR_NAMES.length, max);
  assert.equal(PROCESSOR_NAMES[0], 'cf-singleton-container');
});
