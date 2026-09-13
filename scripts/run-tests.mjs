import { constants } from 'node:fs';
import { access, lstat, mkdtemp, rm, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { TEST_SUITES } from './test-suites.mjs';

export const MIN_TEST_TEMP_BYTES = 256 * 1024 * 1024;
export const TEST_FILE_CONCURRENCY = 1;

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), '..');

export function selectTestTempBase(candidates, minimumAvailableBytes = MIN_TEST_TEMP_BYTES) {
  const minimum = Number(minimumAvailableBytes);
  if (!Number.isFinite(minimum) || minimum < 0) throw new TypeError('minimumAvailableBytes must be nonnegative');
  const selected = (Array.isArray(candidates) ? candidates : []).find((candidate) =>
    candidate?.writable === true
    && Number.isFinite(Number(candidate.availableBytes))
    && Number(candidate.availableBytes) >= minimum
    && path.isAbsolute(String(candidate.path || ''))
  );
  if (!selected) throw new Error(`No writable test temp directory has ${minimum} bytes available.`);
  return selected.path;
}

export async function inspectTestTempBase(candidate) {
  try {
    await access(candidate, constants.W_OK | constants.X_OK);
    const details = await stat(candidate);
    if (!details.isDirectory()) return { path: candidate, writable: false, availableBytes: 0 };
    let cursor = path.resolve(candidate);
    while (true) {
      for (const marker of ['AGENTS.md', '.git', '.codex']) {
        try {
          await lstat(path.join(cursor, marker));
          return { path: candidate, writable: false, availableBytes: 0 };
        } catch (error) {
          if (error?.code !== 'ENOENT') return { path: candidate, writable: false, availableBytes: 0 };
        }
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    const stats = await statfs(candidate);
    return {
      path: candidate,
      writable: true,
      availableBytes: Number(stats.bavail) * Number(stats.bsize)
    };
  } catch {
    return { path: candidate, writable: false, availableBytes: 0 };
  }
}

async function chooseTestTempBase() {
  const configured = String(process.env.PANEFLEET_TEST_TMP_ROOT || '').trim();
  const ordered = [
    configured ? path.resolve(configured) : '',
    os.tmpdir(),
    process.platform === 'win32' ? '' : '/var/tmp',
    root
  ].filter(Boolean);
  const candidates = [...new Set(ordered.map((candidate) => path.resolve(candidate)))];
  return selectTestTempBase(await Promise.all(candidates.map(inspectTestTempBase)));
}

export function selectTestSuites(requestedSuite) {
  const suite = String(requestedSuite || '');
  if (suite === 'all') return Object.keys(TEST_SUITES);
  if (!TEST_SUITES[suite]) throw new Error(`Unknown test suite: ${suite || '(missing)'}`);
  return [suite];
}

export function selectFocusedTests(requestedFiles) {
  if (!Array.isArray(requestedFiles) || !requestedFiles.length) {
    throw new Error('Provide at least one manifest-listed test file after --files.');
  }
  const allowed = new Set(Object.values(TEST_SUITES).flat());
  for (const file of requestedFiles) {
    if (!allowed.has(file)) throw new Error(`Unknown test file: ${file}`);
  }
  return [...new Set(requestedFiles)];
}

export async function runTestSuiteSequence(suites, executeSuite) {
  let failed = false;
  for (const suite of suites) {
    const result = await executeSuite(suite);
    if (result.signal) throw new Error(`Test suite ${suite} stopped by ${result.signal}.`);
    if (result.code !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

async function run() {
  const focusedFiles = process.argv[2] === '--files' ? selectFocusedTests(process.argv.slice(3)) : null;
  const suites = focusedFiles ? ['focused'] : selectTestSuites(process.argv[2]);
  const tempBase = await chooseTestTempBase();
  let child;
  const forwardSignal = (signal) => {
    if (child?.exitCode === null && child?.signalCode === null) child.kill(signal);
  };
  const onInterrupt = () => forwardSignal('SIGINT');
  const onTerminate = () => forwardSignal('SIGTERM');

  try {
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    process.exitCode = await runTestSuiteSequence(suites, async (suite) => {
      const tempDirectory = await mkdtemp(path.join(tempBase, `panefleet-tests-${suite}-`));
      try {
        child = spawn(process.execPath, [
          '--test',
          `--test-concurrency=${TEST_FILE_CONCURRENCY}`,
          ...(focusedFiles || TEST_SUITES[suite])
        ], {
          cwd: root,
          env: {
            ...process.env,
            TMPDIR: tempDirectory,
            TMP: tempDirectory,
            TEMP: tempDirectory,
            NODE_COMPILE_CACHE: path.join(tempDirectory, 'node-compile-cache')
          },
          stdio: 'inherit'
        });
        return await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code, signal) => resolve({ code, signal }));
        });
      } finally {
        child = null;
        await rm(tempDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    });
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  run().catch((error) => {
    console.error(error?.message || 'Test runner failed.');
    process.exitCode = 1;
  });
}
