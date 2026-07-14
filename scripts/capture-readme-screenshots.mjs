#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.env.CHROME_BIN || [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].find(existsSync);

if (!chrome) {
  process.stderr.write('Set CHROME_BIN to a Chromium or Chrome executable.\n');
  process.exit(2);
}

const source = pathToFileURL(path.join(root, 'docs', 'readme-demo.html')).href;
const captures = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 }
];

for (const capture of captures) {
  const output = path.join(root, 'docs', 'assets', `panefleet-${capture.name}.png`);
  execFileSync(chrome, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-font-subpixel-positioning',
    '--hide-scrollbars',
    '--allow-file-access-from-files',
    '--force-device-scale-factor=1',
    `--window-size=${capture.width},${capture.height}`,
    `--screenshot=${output}`,
    source
  ], { stdio: 'inherit' });
}

process.stdout.write('README screenshots captured from synthetic demo data.\n');
