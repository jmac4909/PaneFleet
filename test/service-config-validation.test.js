import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');

async function rejectedRegistry(registry, { raw = false } = {}) {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'panefleet-service-config-'));
  mkdirSync(path.join(fixtureDir, 'data'), { recursive: true });
  const contents = raw ? String(registry) : `${JSON.stringify(registry, null, 2)}\n`;
  writeFileSync(path.join(fixtureDir, 'services.json'), contents);
  let output = '';
  const child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '0',
      ORCHESTRATOR_RUNTIME_ROOT: fixtureDir,
      ORCH_CONTROL_PLANE_MODE: 'foreground'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  let timeout;
  try {
    const [code] = await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('invalid configuration did not exit')), 3000);
      })
    ]);
    return { code, output };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

function rejectedConfiguration(service) {
  return rejectedRegistry([service]);
}

function minimalService(overrides = {}) {
  return {
    id: 'sample',
    cwd: path.join(os.tmpdir(), 'panefleet-config-workspace'),
    ...overrides
  };
}

function validAction(overrides = {}) {
  return {
    id: 'inspect',
    command: 'printf safe-fixture-output',
    runMode: 'exec',
    safe: true,
    ...overrides
  };
}

async function assertRejectedRegistry(resultPromise, expectedError, privateMarker = '') {
  const result = await resultPromise;
  assert.notEqual(result.code, 0);
  assert.match(result.output, expectedError);
  assert.doesNotMatch(result.output, /PaneFleet listening/);
  if (privateMarker) assert.equal(result.output.includes(privateMarker), false);
}

test('invalid service log and action definitions fail closed before the server listens', async (t) => {
  const workspace = path.join(os.tmpdir(), 'panefleet-config-workspace');
  const cases = [
    {
      name: 'log path traversal',
      service: { id: 'sample', cwd: workspace, logFiles: [{ path: '../private.log' }] },
      error: /logFiles\[0\]\.path: must be a relative path inside the service workspace/
    },
    {
      name: 'log line bound',
      service: { id: 'sample', cwd: workspace, logFiles: [{ path: 'service.log', lines: 5 }] },
      error: /logFiles\[0\]\.lines: must be an integer from 20 to 300/
    },
    {
      name: 'unsafe action',
      service: { id: 'sample', cwd: workspace, actions: [{ id: 'unsafe', command: 'true', runMode: 'exec' }] },
      error: /actions\[0\]: actions must be explicitly safe or require confirmation/
    },
    {
      name: 'unconfirmed tmux action',
      service: { id: 'sample', cwd: workspace, actions: [{ id: 'tmux-action', command: 'true', runMode: 'tmux', safe: true }] },
      error: /actions\[0\]: tmux actions require confirmation/
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const result = await rejectedConfiguration(testCase.service);
      assert.notEqual(result.code, 0);
      assert.match(result.output, testCase.error);
      assert.doesNotMatch(result.output, /PaneFleet listening/);
    });
  }
});

test('service registry shape and exact tmux targets fail closed before the server listens', async (t) => {
  const privateMarker = 'synthetic-private-service-command';
  const cases = [
    {
      name: 'malformed JSON is reported without echoing nearby content',
      run: () => rejectedRegistry(`[{"command":"${privateMarker}"}`, { raw: true }),
      error: /services\.json invalid JSON/
    },
    { name: 'registry must be an array', run: () => rejectedRegistry({}), error: /services\.json must contain an array/ },
    { name: 'service must be an object', run: () => rejectedConfiguration(null), error: /\[0\]: service must be an object/ },
    { name: 'service id is required', run: () => rejectedConfiguration(minimalService({ id: '' })), error: /\[0\]\.id: invalid service id/ },
    {
      name: 'service ids are unique',
      run: () => rejectedRegistry([minimalService(), minimalService()]),
      error: /\[1\]\.id: duplicate service id sample/
    },
    { name: 'workspace must be absolute', run: () => rejectedConfiguration(minimalService({ cwd: 'relative' })), error: /\[0\]\.cwd: absolute path required/ },
    { name: 'tmux session name is validated', run: () => rejectedConfiguration(minimalService({ session: 'bad session', command: privateMarker })), error: /\[0\]\.session: invalid tmux session name/ },
    { name: 'session requires command', run: () => rejectedConfiguration(minimalService({ session: 'sample-session' })), error: /session and command must be configured together/ },
    { name: 'command requires session', run: () => rejectedConfiguration(minimalService({ command: privateMarker })), error: /session and command must be configured together/ },
    { name: 'session prefixes must be an array', run: () => rejectedConfiguration(minimalService({ sessionPrefixes: 'sample' })), error: /sessionPrefixes: must be an array/ },
    { name: 'session prefixes are validated', run: () => rejectedConfiguration(minimalService({ sessionPrefixes: ['bad prefix'] })), error: /sessionPrefixes\[0\]: invalid or empty prefix/ },
    { name: 'session prefixes are unique', run: () => rejectedConfiguration(minimalService({ sessionPrefixes: ['sample', 'sample'] })), error: /sessionPrefixes: duplicate prefixes are not allowed/ },
    { name: 'ports must be an array', run: () => rejectedConfiguration(minimalService({ ports: 8080 })), error: /ports: must be an array/ },
    { name: 'ports are bounded', run: () => rejectedConfiguration(minimalService({ ports: [65536] })), error: /ports\[0\]: invalid TCP port/ },
    { name: 'ports are unique', run: () => rejectedConfiguration(minimalService({ ports: [8080, 8080] })), error: /ports: duplicate ports are not allowed/ },
    { name: 'links must be an array', run: () => rejectedConfiguration(minimalService({ links: {} })), error: /links: must be an array/ },
    { name: 'log files must be an array', run: () => rejectedConfiguration(minimalService({ logFiles: {} })), error: /logFiles: must be an array/ },
    { name: 'actions must be an array', run: () => rejectedConfiguration(minimalService({ actions: {} })), error: /actions: must be an array/ },
    {
      name: 'action ids are unique',
      run: () => rejectedConfiguration(minimalService({ actions: [validAction(), validAction()] })),
      error: /actions: duplicate action ids are not allowed/
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await assertRejectedRegistry(testCase.run(), testCase.error, privateMarker);
    });
  }
});

test('service links and log descriptors reject unsafe or ambiguous values', async (t) => {
  const cases = [
    { name: 'link must be an object', service: minimalService({ links: [null] }), error: /links\[0\]: link must be an object/ },
    { name: 'link port is required', service: minimalService({ links: [{}] }), error: /links\[0\]\.port: must be a valid TCP port/ },
    { name: 'link protocol is allowlisted', service: minimalService({ links: [{ port: 8080, protocol: 'file' }] }), error: /links\[0\]\.protocol: must be http, https, or exp/ },
    { name: 'link path is rooted', service: minimalService({ links: [{ port: 8080, path: 'admin' }] }), error: /links\[0\]\.path: must be empty or start with/ },
    { name: 'log descriptor must be an object', service: minimalService({ logFiles: [null] }), error: /logFiles\[0\]: log file must be an object/ },
    { name: 'absolute log path is rejected', service: minimalService({ logFiles: [{ path: '/var/log/private.log' }] }), error: /logFiles\[0\]\.path: must be a relative path/ },
    { name: 'fractional log line count is rejected', service: minimalService({ logFiles: [{ path: 'service.log', lines: 20.5 }] }), error: /logFiles\[0\]\.lines: must be an integer/ },
    { name: 'oversized log tail is rejected', service: minimalService({ logFiles: [{ path: 'service.log', lines: 301 }] }), error: /logFiles\[0\]\.lines: must be an integer/ }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await assertRejectedRegistry(rejectedConfiguration(testCase.service), testCase.error);
    });
  }
});

test('service actions require explicit execution, timeout, and public-IP safety metadata', async (t) => {
  const privateMarker = 'synthetic-private-action-command';
  const actionService = (action) => minimalService({ actions: [action] });
  const cases = [
    { name: 'action must be an object', action: null, error: /actions\[0\]: action must be an object/ },
    { name: 'action id is validated', action: validAction({ id: 'bad action', command: privateMarker }), error: /actions\[0\]\.id: invalid action id/ },
    { name: 'command is required', action: validAction({ command: '   ' }), error: /actions\[0\]\.command: non-empty command required/ },
    { name: 'run mode is allowlisted', action: validAction({ runMode: 'shell', command: privateMarker }), error: /actions\[0\]\.runMode: must be exec or tmux/ },
    { name: 'safe flag is boolean', action: validAction({ safe: 'yes', command: privateMarker }), error: /actions\[0\]\.safe: must be boolean/ },
    { name: 'confirm flag is boolean', action: validAction({ confirm: 'yes', command: privateMarker }), error: /actions\[0\]\.confirm: must be boolean/ },
    { name: 'timeout has a lower bound', action: validAction({ timeoutMs: 999, command: privateMarker }), error: /actions\[0\]\.timeoutMs: must be an integer/ },
    { name: 'timeout must be integral', action: validAction({ timeoutMs: 1000.5, command: privateMarker }), error: /actions\[0\]\.timeoutMs: must be an integer/ },
    { name: 'timeout has an upper bound', action: validAction({ timeoutMs: 300001, command: privateMarker }), error: /actions\[0\]\.timeoutMs: must be an integer/ },
    { name: 'public IP variable is validated', action: validAction({ publicIpEnv: 'lowercase', confirm: true, command: privateMarker }), error: /actions\[0\]\.publicIpEnv: must be an uppercase environment variable name/ },
    { name: 'public IP action requires confirmation', action: validAction({ publicIpEnv: 'PUBLIC_IP', command: privateMarker }), error: /actions\[0\]: public IP actions require confirmation/ }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await assertRejectedRegistry(rejectedConfiguration(actionService(testCase.action)), testCase.error, privateMarker);
    });
  }
});
