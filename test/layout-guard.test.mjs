import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// School Chrome extensions add their own element at the top of <body>. Unpinned, it took grid row 1:
// the top bars got a 0 px row and covered the class phrase card (student laptops, 2026-10-21).
test('the top bars, work area and footer keep their own grid rows', () => {
  const css = readFileSync(new URL('../web/src/style.css', import.meta.url), 'utf8');
  for (const [sel, row] of [['body.app > .topbars', 1], ['body.app > .workarea', 2], ['body.app > .hint', 3]]) {
    assert.ok(css.includes(`${sel} { grid-row: ${row}; }`), sel);
  }
});
