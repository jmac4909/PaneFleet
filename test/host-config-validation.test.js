import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');

async function rejectedHostConfig(config, { raw = false, environment = {} } = {}) {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'panefleet-host-config-'));
  const projectsRoot = path.join(fixtureDir, 'projects');
  const hostConfigPath = path.join(fixtureDir, 'host-config.json');
  mkdirSync(projectsRoot, { recursive: true });
  writeFileSync(path.join(fixtureDir, 'services.json'), '[]\n');
  writeFileSync(hostConfigPath, raw ? String(config) : `${JSON.stringify(config, null, 2)}\n`);
  let output = '';
  const child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '0',
      ORCHESTRATOR_RUNTIME_ROOT: fixtureDir,
      ORCHESTRATOR_HOST_CONFIG: hostConfigPath,
      ORCHESTRATOR_PROJECTS_ROOT: projectsRoot,
      ORCHESTRATOR_AGENT_WORKSPACES_ROOT: path.join(projectsRoot, 'agent-workspaces'),
      ORCH_CONTROL_PLANE_MODE: 'foreground',
      ...environment
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
        timeout = setTimeout(() => reject(new Error('invalid host configuration did not exit')), 3000);
      })
    ]);
    return { code, output };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

async function assertRejected(resultPromise, expectedError, privateMarker = '') {
  const result = await resultPromise;
  assert.notEqual(result.code, 0);
  assert.match(result.output, expectedError);
  assert.doesNotMatch(result.output, /PaneFleet listening/);
  if (privateMarker) assert.equal(result.output.includes(privateMarker), false);
}

test('host configuration rejects malformed or ambiguous shapes without echoing content', async (t) => {
  const privateMarker = 'synthetic-private-host-config-value';
  const cases = [
    {
      name: 'malformed JSON is reported with a stable non-echoing error',
      run: () => rejectedHostConfig(`{"workspaceEntries":["${privateMarker}"]`, { raw: true }),
      error: /host_config_load_failed/
    },
    { name: 'root must be an object', run: () => rejectedHostConfig([]), error: /invalid_host_config_root/ },
    {
      name: 'artifact directories must be an array',
      run: () => rejectedHostConfig({ artifactDirectories: {} }),
      error: /invalid_host_config_artifactDirectories/
    },
    {
      name: 'directory groups must be an object',
      run: () => rejectedHostConfig({ directoryGroups: [] }),
      error: /invalid_host_config_directoryGroups/
    },
    {
      name: 'workspace descriptors must be objects or paths',
      run: () => rejectedHostConfig({ additionalWorkspaceRoots: [null] }),
      error: /invalid_host_config_additional_root_0/
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await assertRejected(testCase.run(), testCase.error, privateMarker);
    });
  }
});

test('host configuration keeps workspace boundaries and labels fail closed', async (t) => {
  const cases = [
    {
      name: 'workspace roots must be absolute',
      run: () => rejectedHostConfig({ additionalWorkspaceRoots: ['relative-workspace'] }),
      error: /invalid_host_config_additional_root_0_path/
    },
    {
      name: 'workspace labels cannot be blank',
      run: () => rejectedHostConfig({ additionalWorkspaceRoots: [{ path: os.tmpdir(), label: '   ' }] }),
      error: /invalid_host_config_additional_root_0_label/
    },
    {
      name: 'explicit workspace entries must stay inside an allowed root',
      run: () => rejectedHostConfig({ workspaceEntries: [path.join(os.tmpdir(), 'outside-projects-entry')] }),
      error: /host_config_workspace_entry_0_outside_root/
    },
    {
      name: 'area aliases must stay inside an allowed root',
      run: () => rejectedHostConfig({ areaAliases: [path.join(os.tmpdir(), 'outside-projects-alias')] }),
      error: /host_config_area_alias_0_outside_root/
    },
    {
      name: 'control-plane mode is allowlisted',
      run: () => rejectedHostConfig({}, { environment: { ORCH_CONTROL_PLANE_MODE: 'arbitrary-shell' } }),
      error: /invalid_control_plane_mode/
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await assertRejected(testCase.run(), testCase.error);
    });
  }
});
