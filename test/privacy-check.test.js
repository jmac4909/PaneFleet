import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');
const checker = path.join(projectDir, 'scripts', 'privacy-check.mjs');
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(directory, args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function repository() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'host-control-privacy-'));
  temporaryDirectories.push(directory);
  git(directory, ['init', '-q']);
  git(directory, ['config', 'user.name', 'Privacy Test']);
  git(directory, ['config', 'user.email', 'privacy@example.com']);
  writeFileSync(path.join(directory, 'README.md'), '# Synthetic repository\n\nLoopback: 127.0.0.1\n');
  git(directory, ['add', 'README.md']);
  git(directory, ['commit', '-qm', 'safe baseline']);
  return directory;
}

function runChecker(directory, ...modes) {
  return spawnSync(process.execPath, [checker, ...modes], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 10000
  });
}

test('privacy checker accepts a sanitized tracked tree and history', () => {
  const directory = repository();
  const result = runChecker(directory, '--tracked', '--history');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /privacy check passed/);
});

test('privacy checker rejects machine-local staged paths', () => {
  const directory = repository();
  writeFileSync(path.join(directory, 'services.json'), '[]\n');
  git(directory, ['add', '-f', 'services.json']);
  const result = runChecker(directory, '--staged');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /machine-local configuration/);
});

test('privacy checker rejects credentials retained only in Git history', () => {
  const directory = repository();
  const syntheticCredential = `sk-proj-${'x'.repeat(32)}`;
  writeFileSync(path.join(directory, 'temporary.txt'), `${syntheticCredential}\n`);
  git(directory, ['add', 'temporary.txt']);
  git(directory, ['commit', '-qm', 'synthetic leak']);
  git(directory, ['rm', '-q', 'temporary.txt']);
  git(directory, ['commit', '-qm', 'remove synthetic leak']);

  const result = runChecker(directory, '--tracked', '--history');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /history:temporary\.txt: possible OpenAI-style secret/);
});
