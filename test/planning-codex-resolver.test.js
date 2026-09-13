import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PLANNING_CODEX_MAX_EXECUTABLE_BYTES,
  PLANNING_CODEX_REQUIRED_VERSION,
  defaultPlanningCodexWrapperPackagePaths,
  resolvePlanningCodex
} from '../planning-codex-resolver.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');
const resolverPath = path.join(projectDir, 'planning-codex-resolver.js');
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(label = 'planning-codex-resolver-') {
  const directory = mkdtempSync(path.join(os.tmpdir(), label));
  temporaryDirectories.push(directory);
  return directory;
}

function compileCodex({
  version = PLANNING_CODEX_REQUIRED_VERSION,
  extraLine = false,
  stderrLine = false,
  name = 'codex'
} = {}) {
  const directory = temporaryDirectory();
  const source = path.join(directory, 'codex.c');
  const executable = path.join(directory, name);
  writeFileSync(source, [
    '#include <stdio.h>',
    '#include <string.h>',
    'int main(int argc, char **argv) {',
    '  if (argc == 2 && strcmp(argv[1], "--version") == 0) {',
    `    fputs("codex-cli ${version}\\n${extraLine ? 'unexpected\\n' : ''}", stdout);`,
    `    ${stderrLine ? 'fputs("unexpected\\n", stderr);' : ''}`,
    '    return 0;',
    '  }',
    '  return 97;',
    '}',
    ''
  ].join('\n'));
  const compiled = spawnSync('/usr/bin/cc', ['-O2', '-s', '-o', executable, source], {
    encoding: 'utf8'
  });
  assert.equal(compiled.status, 0, compiled.stderr);
  chmodSync(executable, 0o700);
  return { directory, executable };
}

function officialPackageFixture(executable, overrides = {}) {
  const directory = temporaryDirectory('planning-codex-package-');
  const wrapperRoot = path.join(directory, 'node_modules', '@openai', 'codex');
  const platformRoot = path.join(wrapperRoot, 'node_modules', '@openai', 'codex-linux-x64');
  const binary = path.join(platformRoot, 'vendor', 'x86_64-unknown-linux-musl', 'bin', 'codex');
  mkdirSync(path.dirname(binary), { recursive: true });
  copyFileSync(executable, binary);
  chmodSync(binary, 0o700);
  const repository = {
    type: 'git',
    url: 'git+https://github.com/openai/codex.git',
    directory: 'codex-cli'
  };
  const wrapperPackage = path.join(wrapperRoot, 'package.json');
  writeFileSync(wrapperPackage, JSON.stringify({
    name: '@openai/codex',
    version: PLANNING_CODEX_REQUIRED_VERSION,
    repository,
    optionalDependencies: {
      '@openai/codex-linux-x64': 'npm:@openai/codex@0.147.0-linux-x64'
    },
    ...overrides.wrapper
  }), { mode: 0o600 });
  writeFileSync(path.join(platformRoot, 'package.json'), JSON.stringify({
    name: '@openai/codex',
    version: '0.147.0-linux-x64',
    os: ['linux'],
    cpu: ['x64'],
    repository,
    ...overrides.platform
  }), { mode: 0o600 });
  return { wrapperPackage, binary };
}

test('override resolves one canonical native 0.147.0 binary and pins its SHA-256', async () => {
  const fixture = compileCodex({ name: 'native codex' });
  const resolved = await resolvePlanningCodex({ executableOverride: fixture.executable });
  assert.deepEqual(resolved, {
    path: fixture.executable,
    version: PLANNING_CODEX_REQUIRED_VERSION,
    sha256: createHash('sha256').update(readFileSync(fixture.executable)).digest('hex'),
    source: 'override'
  });
  assert.deepEqual(
    defaultPlanningCodexWrapperPackagePaths('/opt/node/bin/node').at(-1),
    '/opt/node/lib/node_modules/@openai/codex/package.json'
  );
});

test('official wrapper resolves only its exact declared platform package and native binary', async () => {
  const native = compileCodex();
  const fixture = officialPackageFixture(native.executable);
  const resolved = await resolvePlanningCodex({
    executableOverride: '',
    wrapperPackagePaths: [fixture.wrapperPackage]
  });
  assert.equal(resolved.path, fixture.binary);
  assert.equal(resolved.version, PLANNING_CODEX_REQUIRED_VERSION);
  assert.equal(resolved.source, 'official-package');
  assert.match(resolved.sha256, /^[a-f0-9]{64}$/);
});

test('CLI emits one bounded tab-separated pin for the installer', () => {
  const fixture = compileCodex();
  const result = spawnSync(process.execPath, [resolverPath], {
    cwd: projectDir,
    encoding: 'utf8',
    env: { ...process.env, ORCH_PLANNING_CODEX_EXECUTABLE: fixture.executable }
  });
  assert.equal(result.status, 0, result.stderr);
  const fields = result.stdout.trim().split('\t');
  assert.deepEqual(fields.slice(0, 2), [fixture.executable, PLANNING_CODEX_REQUIRED_VERSION]);
  assert.match(fields[2], /^[a-f0-9]{64}$/);
  assert.equal(fields.length, 3);
});

test('resolver rejects scripts, symlinks, hardlinks, insecure modes, oversized files, and relative paths', async () => {
  const native = compileCodex();
  const script = path.join(native.directory, 'codex-script');
  writeFileSync(script, '#!/bin/sh\nprintf "codex-cli 0.147.0\\n"\n', { mode: 0o700 });
  await assert.rejects(resolvePlanningCodex({ executableOverride: script }), { code: 'planning_codex_executable_not_native' });

  const symlink = path.join(native.directory, 'codex-link');
  symlinkSync(native.executable, symlink);
  await assert.rejects(resolvePlanningCodex({ executableOverride: symlink }), { code: 'planning_codex_executable_untrusted' });

  const hardlink = path.join(native.directory, 'codex-hardlink');
  linkSync(native.executable, hardlink);
  await assert.rejects(resolvePlanningCodex({ executableOverride: native.executable }), { code: 'planning_codex_executable_untrusted' });
  rmSync(hardlink);

  chmodSync(native.executable, 0o722);
  await assert.rejects(resolvePlanningCodex({ executableOverride: native.executable }), { code: 'planning_codex_executable_untrusted' });
  chmodSync(native.executable, 0o700);

  const oversized = path.join(native.directory, 'codex-oversized');
  copyFileSync(native.executable, oversized);
  truncateSync(oversized, PLANNING_CODEX_MAX_EXECUTABLE_BYTES + 1);
  chmodSync(oversized, 0o700);
  await assert.rejects(resolvePlanningCodex({ executableOverride: oversized }), { code: 'planning_codex_executable_untrusted' });

  await assert.rejects(resolvePlanningCodex({ executableOverride: 'relative/codex' }), { code: 'planning_codex_executable_invalid' });
  await assert.rejects(resolvePlanningCodex({ executableOverride: `${native.executable}\n` }), { code: 'planning_codex_executable_invalid' });
  await assert.rejects(resolvePlanningCodex({
    executableOverride: path.join(native.directory, '@PLANNING_CODEX_VERSION@')
  }), { code: 'planning_codex_executable_invalid' });
});

test('resolver rejects incorrect version output, extra output, and the wrong native architecture', async () => {
  const old = compileCodex({ version: '0.146.1' });
  await assert.rejects(resolvePlanningCodex({ executableOverride: old.executable }), { code: 'planning_codex_executable_version_mismatch' });
  const verbose = compileCodex({ extraLine: true });
  await assert.rejects(resolvePlanningCodex({ executableOverride: verbose.executable }), { code: 'planning_codex_executable_version_mismatch' });
  const noisy = compileCodex({ stderrLine: true });
  await assert.rejects(resolvePlanningCodex({ executableOverride: noisy.executable }), { code: 'planning_codex_executable_version_mismatch' });

  const wrongArchitecture = compileCodex();
  const bytes = readFileSync(wrongArchitecture.executable);
  bytes.writeUInt16LE(183, 18);
  writeFileSync(wrongArchitecture.executable, bytes, { mode: 0o700 });
  await assert.rejects(resolvePlanningCodex({ executableOverride: wrongArchitecture.executable }), { code: 'planning_codex_executable_arch_mismatch' });
  await assert.rejects(resolvePlanningCodex({ executableOverride: old.executable, platform: 'darwin' }), { code: 'planning_codex_platform_unsupported' });
});

test('official discovery rejects incorrect wrapper and platform provenance instead of falling back', async () => {
  const native = compileCodex();
  const wrongWrapper = officialPackageFixture(native.executable, {
    wrapper: { version: '0.146.1' }
  });
  await assert.rejects(resolvePlanningCodex({
    wrapperPackagePaths: [wrongWrapper.wrapperPackage]
  }), { code: 'planning_codex_wrapper_mismatch' });

  const wrongPlatform = officialPackageFixture(native.executable, {
    platform: { cpu: ['arm64'] }
  });
  await assert.rejects(resolvePlanningCodex({
    wrapperPackagePaths: [wrongPlatform.wrapperPackage]
  }), { code: 'planning_codex_platform_package_mismatch' });

  await assert.rejects(resolvePlanningCodex({ wrapperPackagePaths: [] }), { code: 'planning_codex_wrapper_unavailable' });
  await assert.rejects(resolvePlanningCodex({ wrapperPackagePaths: 'not-an-array' }), { code: 'planning_codex_wrapper_unavailable' });
});

test('CLI fails closed without printing a partial pin', () => {
  const result = spawnSync(process.execPath, [resolverPath], {
    cwd: projectDir,
    encoding: 'utf8',
    env: { ...process.env, ORCH_PLANNING_CODEX_EXECUTABLE: 'relative/codex' }
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^planning_codex_executable_invalid\n$/);
});
