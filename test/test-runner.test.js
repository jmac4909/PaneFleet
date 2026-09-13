import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  inspectTestTempBase,
  MIN_TEST_TEMP_BYTES,
  runTestSuiteSequence,
  selectFocusedTests,
  selectTestSuites,
  selectTestTempBase,
  TEST_FILE_CONCURRENCY
} from '../scripts/run-tests.mjs';

test('test files run sequentially on the memory-constrained control host', () => {
  assert.equal(TEST_FILE_CONCURRENCY, 1);
});

test('focused runs accept only explicitly selected manifest files and deduplicate them', () => {
  const first = 'test/runtime-config.test.js';
  const second = 'test/codex-telemetry.test.js';
  assert.deepEqual(selectFocusedTests([first, second, first]), [first, second]);
  assert.throws(() => selectFocusedTests([]), /at least one/);
  assert.throws(() => selectFocusedTests(), /at least one/);
  for (const file of ['--test', 'server.js', 'test/*.test.js', '../test/runtime-config.test.js']) {
    assert.throws(() => selectFocusedTests([file]), /Unknown test file/);
  }
});

test('shell syntax gate rejects errors in later scripts and the hook without executing them', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'panefleet-shell-check-'));
  const files = ['scripts/a.sh', 'scripts/z.sh', '.githooks/pre-commit'];
  try {
    mkdirSync(path.join(directory, 'scripts'));
    mkdirSync(path.join(directory, '.githooks'));
    // An executing checker would fail even on the syntactically valid fixture.
    for (const file of files) writeFileSync(path.join(directory, file), 'exit 99\n');
    const run = () => spawnSync('bash', ['-c', scripts['check:shell']], { cwd: directory, encoding: 'utf8' });
    assert.equal(run().status, 0);
    for (const file of files) {
      writeFileSync(path.join(directory, file), 'if then\n');
      const result = run();
      assert.notEqual(result.status, 0, `${file} must be syntax-checked`);
      assert.ok(result.stderr.includes(file), 'failure must identify the broken script');
      writeFileSync(path.join(directory, file), 'exit 99\n');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('test temp inspection accepts directories and rejects files or missing paths', async () => {
  const baseCandidates = process.platform === 'win32'
    ? [os.tmpdir()]
    : ['/dev/shm', '/var/tmp', os.tmpdir()];
  let neutralBase = '';
  for (const candidate of baseCandidates) {
    if ((await inspectTestTempBase(candidate)).writable) {
      neutralBase = candidate;
      break;
    }
  }
  assert.ok(neutralBase, 'a neutral temporary base is required for the test fixture');
  const fixtureDir = mkdtempSync(path.join(neutralBase, 'panefleet-test-root-'));
  const markedDir = mkdtempSync(path.join(neutralBase, 'panefleet-test-marked-'));
  const filePath = path.join(fixtureDir, 'not-a-directory');
  const missingPath = path.join(fixtureDir, 'missing');
  writeFileSync(filePath, 'fixture\n');
  mkdirSync(path.join(markedDir, '.codex'));
  try {
    const directory = await inspectTestTempBase(fixtureDir);
    assert.equal(directory.path, fixtureDir);
    assert.equal(directory.writable, true);
    assert.ok(directory.availableBytes > 0);
    assert.deepEqual(await inspectTestTempBase(filePath), {
      path: filePath,
      writable: false,
      availableBytes: 0
    });
    assert.deepEqual(await inspectTestTempBase(missingPath), {
      path: missingPath,
      writable: false,
      availableBytes: 0
    });
    assert.deepEqual(await inspectTestTempBase(markedDir), {
      path: markedDir,
      writable: false,
      availableBytes: 0
    });
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(markedDir, { recursive: true, force: true });
  }
});

test('test runner skips constrained or unwritable temp roots before starting fixtures', () => {
  const constrained = MIN_TEST_TEMP_BYTES - 1;
  const roomy = MIN_TEST_TEMP_BYTES * 2;
  assert.equal(selectTestTempBase([
    { path: '/tmp', writable: true, availableBytes: constrained },
    { path: '/var/tmp', writable: true, availableBytes: roomy }
  ]), '/var/tmp');
  assert.equal(selectTestTempBase([
    { path: '/preferred', writable: false, availableBytes: roomy },
    { path: '/fallback', writable: true, availableBytes: roomy }
  ]), '/fallback');
  assert.throws(
    () => selectTestTempBase([{ path: '/tmp', writable: true, availableBytes: constrained }]),
    /No writable test temp directory/
  );
  assert.throws(() => selectTestTempBase([], -1), /must be nonnegative/);
});

test('all-suite runs report every suite before returning a failed status', async () => {
  assert.deepEqual(selectTestSuites('all'), ['core', 'features']);
  assert.deepEqual(selectTestSuites('core'), ['core']);
  assert.throws(() => selectTestSuites('missing'), /Unknown test suite: missing/);

  const executed = [];
  const status = await runTestSuiteSequence(['core', 'features'], async (suite) => {
    executed.push(suite);
    return { code: suite === 'core' ? 1 : 0, signal: null };
  });
  assert.equal(status, 1);
  assert.deepEqual(executed, ['core', 'features']);

  await assert.rejects(
    runTestSuiteSequence(['core'], async () => ({ code: null, signal: 'SIGTERM' })),
    /Test suite core stopped by SIGTERM/
  );
});
