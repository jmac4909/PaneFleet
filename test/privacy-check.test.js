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

function runCheckerWithEnvironment(directory, environment, ...modes) {
  return spawnSync(process.execPath, [checker, ...modes], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, PANEFLEET_PUBLICATION_DENY_TERMS: '', ...environment }
  });
}

function runChecker(directory, ...modes) {
  return runCheckerWithEnvironment(directory, {}, ...modes);
}

test('privacy checker refuses force-added private host maintenance material', () => {
  const directory = repository();
  const files = [
    'docs/host-audit-cleanup-plan.md',
    'docs/host-security-sweep-2000-01-01.md',
    'docs/example-dns-rollout-plan.md',
    'deploy/aws/panefleet-resize-automation-role.json',
    'scripts/capture-panefleet-resize-preflight.mjs',
    'scripts/resize-panefleet-instance.mjs',
    'test/capture-panefleet-resize-preflight.test.js',
    'test/panefleet-resize-role-template.test.js',
    'test/resize-panefleet-instance.test.js'
  ];
  for (const file of files) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), 'synthetic local-only maintenance\n');
    git(directory, ['add', '-f', file]);
  }
  const result = runChecker(directory, '--staged');
  assert.equal(result.status, 1);
  assert.equal((result.stderr.match(/machine-local maintenance artifact/g) || []).length, files.length);
});

test('private publication markers are case-insensitive and never printed', () => {
  const directory = repository();
  const marker = ['Fictional', 'Employer', 'Sentinel'].join('');
  writeFileSync(path.join(directory, 'README.md'), marker.toUpperCase());
  const result = runCheckerWithEnvironment(directory, {
    PANEFLEET_PUBLICATION_DENY_TERMS: marker
  }, '--worktree');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private publication marker/);
  assert.equal((result.stdout + result.stderr).toLowerCase().includes(marker.toLowerCase()), false);
});

test('private publication markers inspect history after working-tree removal', () => {
  const directory = repository();
  const marker = ['Fictional', 'History', 'Sentinel'].join('');
  writeFileSync(path.join(directory, 'README.md'), marker);
  git(directory, ['add', 'README.md']);
  git(directory, ['commit', '-qm', 'synthetic private marker']);
  writeFileSync(path.join(directory, 'README.md'), '# Safe current text\n');
  git(directory, ['add', 'README.md']);
  git(directory, ['commit', '-qm', 'safe working copy']);
  const result = runCheckerWithEnvironment(directory, {
    PANEFLEET_PUBLICATION_DENY_TERMS: marker
  }, '--history');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private publication marker/);
  assert.equal((result.stdout + result.stderr).includes(marker), false);
});

test('private filenames fail publication without exposing the filename marker', () => {
  const directory = repository();
  const marker = ['Fictional', 'Path', 'Sentinel'].join('');
  const filename = `${marker.toUpperCase()}.md`;
  writeFileSync(path.join(directory, filename), '# Synthetic contents\n');
  for (const modes of [['--worktree'], ['--staged'], ['--history']]) {
    if (modes[0] === '--staged') git(directory, ['add', filename]);
    if (modes[0] === '--history') git(directory, ['commit', '-qm', 'synthetic path fixture']);
    const result = runCheckerWithEnvironment(directory, {
      PANEFLEET_PUBLICATION_DENY_TERMS: marker
    }, ...modes);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /private publication marker/);
    assert.equal((result.stdout + result.stderr).toLowerCase().includes(marker.toLowerCase()), false);
  }
});

test('publication markers reject ineffective short entries without disclosure', () => {
  const directory = repository();
  const result = runCheckerWithEnvironment(directory, {
    PANEFLEET_PUBLICATION_DENY_TERMS: 'xy'
  }, '--worktree');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /at least 3 characters/);
});

test('privacy checker rejects fine-grained GitHub tokens without disclosing them', () => {
  const directory = repository();
  const token = ['github', 'pat', 'x'.repeat(30)].join('_');
  writeFileSync(path.join(directory, 'README.md'), token);
  const result = runChecker(directory, '--worktree');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GitHub fine-grained token/);
  assert.equal((result.stdout + result.stderr).includes(token), false);
});

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

test('privacy checker accepts GitHub automation noreply commit and tag metadata', () => {
  const directory = repository();
  git(directory, ['config', 'user.email', ['noreply', 'github.com'].join('@')]);
  git(directory, ['commit', '--allow-empty', '-qm', 'automated dependency update']);
  git(directory, ['tag', '-a', 'synthetic-automation', '-m', 'automated release metadata']);
  const result = runChecker(directory, '--tracked', '--history');
  assert.equal(result.status, 0, result.stderr);
});

test('privacy checker still rejects other GitHub-domain email identities', () => {
  for (const email of [
    ['synthetic-person', 'github.com'].join('@'),
    ['noreply', 'github.com.invalid'].join('@'),
    ['noreply', 'subdomain.github.com'].join('@')
  ]) {
    const directory = repository();
    git(directory, ['config', 'user.email', email]);
    git(directory, ['commit', '--allow-empty', '-qm', 'synthetic private identity']);
    const result = runChecker(directory, '--history');
    assert.equal(result.status, 1, 'only the exact GitHub automation address is allowed');
    assert.match(result.stderr, /non-example email address/);
    assert.equal((result.stdout + result.stderr).includes(email), false);
  }
});

test('privacy checker rejects machine-local staged paths', () => {
  const directory = repository();
  writeFileSync(path.join(directory, 'services.json'), '[]\n');
  git(directory, ['add', '-f', 'services.json']);
  const result = runChecker(directory, '--staged');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /machine-local configuration/);
});

test('privacy checker rejects force-added private operator and deployment notes', () => {
  const directory = repository();
  const docsDirectory = path.join(directory, 'docs');
  mkdirSync(docsDirectory, { recursive: true });
  for (const name of [
    'personal-weekly-plan.md',
    'private-release-notes.md',
    'host-wide-https.md',
    'security-hardening.md'
  ]) {
    writeFileSync(path.join(docsDirectory, name), '# Local-only note\n');
    git(directory, ['add', '-f', path.join('docs', name)]);
  }

  const result = runChecker(directory, '--staged');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private operator note/);
  assert.match(result.stderr, /machine-local deployment note/);
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
