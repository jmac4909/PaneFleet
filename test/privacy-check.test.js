import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('privacy checker scans modified tracked content rather than only the index', () => {
  const directory = repository();
  const syntheticCredential = `sk-proj-${'w'.repeat(32)}`;
  writeFileSync(path.join(directory, 'README.md'), `${syntheticCredential}\n`);

  const indexed = runChecker(directory, '--tracked');
  assert.equal(indexed.status, 0, indexed.stderr);
  const worktree = runChecker(directory, '--worktree');
  assert.equal(worktree.status, 1);
  assert.match(worktree.stderr, /worktree:README\.md: possible OpenAI-style secret/);
});

test('privacy checker scans untracked publishable files', () => {
  const directory = repository();
  const syntheticCredential = `ghp_${'u'.repeat(32)}`;
  writeFileSync(path.join(directory, 'new-public-file.txt'), `${syntheticCredential}\n`);

  const result = runChecker(directory, '--worktree');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /worktree:new-public-file\.txt: possible GitHub token/);
});

test('privacy checker ignores files excluded from publication by gitignore', () => {
  const directory = repository();
  writeFileSync(path.join(directory, '.gitignore'), 'services.json\n');
  git(directory, ['add', '.gitignore']);
  git(directory, ['commit', '-qm', 'ignore local service registry']);
  writeFileSync(path.join(directory, 'services.json'), '[{"synthetic":"machine-local"}]\n');

  const result = runChecker(directory, '--worktree');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /privacy check passed/);
});

test('privacy checker accepts a GitHub-provided noreply commit address', () => {
  const directory = repository();
  git(directory, ['config', 'user.email', '1234567+synthetic-user@users.noreply.github.com']);
  git(directory, ['commit', '--allow-empty', '-qm', 'public forge identity']);
  const result = runChecker(directory, '--tracked', '--history');
  assert.equal(result.status, 0, result.stderr);
});

test('privacy checker rejects machine-local staged paths', () => {
  const directory = repository();
  writeFileSync(path.join(directory, 'services.json'), '[]\n');
  git(directory, ['add', '-f', 'services.json']);
  const result = runChecker(directory, '--staged');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /machine-local configuration/);
});

test('privacy checker rejects a force-added credential configuration path', () => {
  const directory = repository();
  writeFileSync(path.join(directory, '.npmrc'), 'registry=https://registry.example.com\n');
  git(directory, ['add', '-f', '.npmrc']);
  const result = runChecker(directory, '--staged');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /credential file/);
});

test('privacy checker accepts only the reviewed synthetic README capture paths', () => {
  const directory = repository();
  const assetDirectory = path.join(directory, 'docs', 'assets');
  mkdirSync(assetDirectory, { recursive: true });
  const syntheticPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  writeFileSync(path.join(assetDirectory, 'panefleet-desktop.png'), syntheticPng);
  git(directory, ['add', 'docs/assets/panefleet-desktop.png']);

  const result = runChecker(directory, '--tracked', '--history');
  assert.equal(result.status, 0, result.stderr);
});

test('privacy checker rejects unreviewed image captures', () => {
  const directory = repository();
  const assetDirectory = path.join(directory, 'docs', 'assets');
  mkdirSync(assetDirectory, { recursive: true });
  const syntheticPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  writeFileSync(path.join(assetDirectory, 'live-host.png'), syntheticPng);
  git(directory, ['add', 'docs/assets/live-host.png']);

  const result = runChecker(directory, '--staged');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /binary, document, archive, or capture/);
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

test('privacy checker rejects host identity retained only in an unreachable amended commit', () => {
  const directory = repository();
  const syntheticHostEmail = ['operator@ip-', '10-20-30-40', '.compute.internal'].join('');
  git(directory, ['config', 'user.email', syntheticHostEmail]);
  git(directory, ['commit', '--allow-empty', '-qm', 'temporary host identity']);
  const leakedCommit = git(directory, ['rev-parse', 'HEAD']).trim();
  git(directory, ['reset', '--hard', '-q', 'HEAD^']);

  const result = runChecker(directory, '--tracked', '--history');
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`objects:${leakedCommit}: possible EC2 internal hostname`));
  assert.match(result.stderr, new RegExp(`objects:${leakedCommit}: non-example email address`));
});
