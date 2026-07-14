import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedCaptures = [
  ['panefleet-desktop.png', 1440, 900],
  ['panefleet-mobile.png', 390, 844]
];

test('README screenshots are bounded PNGs generated from the synthetic PaneFleet fixture', async () => {
  const [readme, demo] = await Promise.all([
    readFile(path.join(root, 'README.md'), 'utf8'),
    readFile(path.join(root, 'docs', 'readme-demo.html'), 'utf8')
  ]);

  assert.match(demo, /Synthetic demo data/i);
  assert.match(demo, /demo-host/);
  assert.doesNotMatch(demo, /\/home\/|\/Users\//);

  for (const [name, width, height] of expectedCaptures) {
    assert.match(readme, new RegExp(`docs/assets/${name.replace('.', '\\.')}\\b`));
    const capture = await readFile(path.join(root, 'docs', 'assets', name));
    assert.equal(capture.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(capture.readUInt32BE(16), width);
    assert.equal(capture.readUInt32BE(20), height);
    assert.ok(capture.length <= 512 * 1024, `${name} must stay at or below 512 KiB`);
  }
});
