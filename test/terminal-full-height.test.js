import test from 'node:test';
import assert from 'node:assert/strict';

import { terminalFullHeightBounds } from '../public/ui-state.js';

test('terminalFullHeightBounds preserves horizontal geometry and fills viewport height', () => {
  const rect = { left: 123, top: 96, width: 456, height: 320 };

  assert.deepEqual(terminalFullHeightBounds(rect, 1200, 800), {
    left: 123,
    top: 8,
    width: 456,
    height: 784
  });
  assert.deepEqual(rect, { left: 123, top: 96, width: 456, height: 320 });
});

test('terminalFullHeightBounds clamps an off-screen horizontal position', () => {
  assert.deepEqual(
    terminalFullHeightBounds({ left: 900, width: 400 }, 1000, 700),
    { left: 592, top: 8, width: 400, height: 684 }
  );
});

test('terminalFullHeightBounds clamps width and left to the usable viewport', () => {
  assert.deepEqual(
    terminalFullHeightBounds({ left: -50, width: 1400 }, 1000, 700, 12),
    { left: 12, top: 12, width: 976, height: 676 }
  );
});

test('terminalFullHeightBounds safely normalizes missing and invalid geometry', () => {
  assert.deepEqual(terminalFullHeightBounds(null, 'invalid', -100, -4), {
    left: 0,
    top: 0,
    width: 0,
    height: 0
  });
  assert.deepEqual(terminalFullHeightBounds({ x: 30, width: 120 }, 100, 80, 10), {
    left: 10,
    top: 10,
    width: 80,
    height: 60
  });
  assert.deepEqual(terminalFullHeightBounds({ x: 30, width: 120 }, null, null, null), {
    left: 0,
    top: 0,
    width: 0,
    height: 0
  });
});
