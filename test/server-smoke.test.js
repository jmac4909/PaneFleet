import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { stopChildProcess } from './helpers/child-process.js';
import { installBlockedTool } from './helpers/executables.js';
import { fetchWithTimeout, responseJson as jsonResponse, waitForHttpServer } from './helpers/http.js';
import { waitForCondition } from './helpers/timing.js';
import { unusedLoopbackPort } from './helpers/unused-loopback-port.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');
const loopbackHost = [127, 0, 0, 1].join('.');
const unspecifiedIpv4 = [0, 0, 0, 0].join('.');
const documentationIpv4 = [203, 0, 113, 10].join('.');
const publicIpv4 = [8, 8, 8, 8].join('.');
let fixtureDir;
let planningRuntimeRoot;
let codexHome;
let additionalWorkspaceRoot;
let configuredWorkspaceEntry;
let toolLogPath;
let child;
let childOutput = '';
let baseUrl;
let controlCookie;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const dynamicModelCache = {
  models: [
    {
      slug: 'gpt-test-alpha',
      display_name: 'GPT Test Alpha',
      description: 'Synthetic visible model',
      visibility: 'list',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'medium' },
        { effort: 'high' },
        { effort: 'xhigh' },
        { effort: 'max' },
        { effort: 'ultra' }
      ]
    },
    {
      slug: 'gpt-test-beta',
      display_name: 'GPT Test Beta',
      description: 'Second synthetic visible model',
      visibility: 'list',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'medium' },
        { effort: 'high' },
        { effort: 'xhigh' },
        { effort: 'max' }
      ]
    },
    {
      slug: 'codex-auto-review',
      display_name: 'Codex Auto Review',
      description: 'Hidden test-only model',
      visibility: 'hide',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'medium' },
        { effort: 'high' },
        { effort: 'xhigh' }
      ]
    }
  ]
};

function installDynamicModelFixture() {
  writeFileSync(path.join(codexHome, 'models_cache.json'), `${JSON.stringify(dynamicModelCache)}\n`);
  writeFileSync(
    path.join(codexHome, 'config.toml'),
    'model = "gpt-test-alpha"\nmodel_reasoning_effort = "ultra"\n'
  );
}

function resetDynamicModelFixture() {
  writeFileSync(path.join(codexHome, 'models_cache.json'), '{"models":[]}\n');
  rmSync(path.join(codexHome, 'config.toml'), { force: true });
}

async function request(pathname, options = {}) {
  return fetchWithTimeout(`${baseUrl}${pathname}`, options, 3000);
}

function toolLog() {
  return existsSync(toolLogPath) ? readFileSync(toolLogPath, 'utf8') : '';
}

function toolInvocationCount(name) {
  return toolLog().split('\n').filter((line) => line === name).length;
}

before(async () => {
  fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'agent-orchestrator-test-'));
  planningRuntimeRoot = mkdtempSync(path.join('/dev/shm', 'panefleet-planning-smoke-'));
  mkdirSync(path.join(fixtureDir, 'data'));
  chmodSync(path.join(fixtureDir, 'data'), 0o755);
  codexHome = path.join(fixtureDir, 'codex-home');
  const binDir = path.join(fixtureDir, 'blocked-bin');
  const projectsRoot = path.join(fixtureDir, 'projects');
  additionalWorkspaceRoot = path.join(fixtureDir, 'shared-workspaces');
  configuredWorkspaceEntry = path.join(additionalWorkspaceRoot, 'example-tooling');
  toolLogPath = path.join(fixtureDir, 'external-tools.log');
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(projectsRoot, { recursive: true });
  mkdirSync(path.join(projectsRoot, 'reference'), { recursive: true });
  mkdirSync(configuredWorkspaceEntry, { recursive: true });

  copyFileSync(path.join(projectDir, 'test', 'services.fixture.json'), path.join(fixtureDir, 'services.json'));
  cpSync(path.join(projectDir, 'public'), path.join(fixtureDir, 'public'), { recursive: true });
  writeFileSync(path.join(fixtureDir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(path.join(fixtureDir, 'host-config.json'), JSON.stringify({
    additionalWorkspaceRoots: [{ path: additionalWorkspaceRoot, label: 'Shared workspaces', group: 'Additional roots' }],
    workspaceEntries: [{ path: configuredWorkspaceEntry, label: 'Example tooling', group: 'Project tools' }],
    directoryGroups: { reference: 'Supporting folders' },
    areaAliases: [{ path: configuredWorkspaceEntry, label: 'Example Tooling' }],
    artifactDirectories: ['releases']
  }));
  writeFileSync(path.join(codexHome, 'models_cache.json'), '{"models":[]}\n');

  // Any accidental command execution is contained and recorded. These tests must
  // never inspect tmux, contact instance metadata/AWS, or query host processes.
  for (const name of ['aws', 'curl', 'journalctl', 'ps', 'ss', 'tmux']) installBlockedTool(binDir, name);

  const port = await unusedLoopbackPort();
  baseUrl = `http://${loopbackHost}:${port}`;
  child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
    cwd: fixtureDir,
    env: {
      HOME: fixtureDir,
      NODE_ENV: 'test',
      HOST: loopbackHost,
      PORT: String(port),
      ORCHESTRATOR_RUNTIME_ROOT: fixtureDir,
      ORCHESTRATOR_PLANNING_RUNTIME_ROOT: planningRuntimeRoot,
      CODEX_HOME: codexHome,
      PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      ORCH_TOOL_LOG: toolLogPath,
      ORCH_CONTROL_PLANE_MODE: 'foreground',
      ORCHESTRATOR_PROJECTS_ROOT: projectsRoot,
      ORCHESTRATOR_AGENT_WORKSPACES_ROOT: path.join(projectsRoot, 'agent-workspaces'),
      ORCHESTRATOR_HOST_CONFIG: path.join(fixtureDir, 'host-config.json'),
      ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
      AWS_EC2_METADATA_DISABLED: 'true',
      SNAPSHOT_EVENT_MS: '60000',
      SSH_RESCUE_MONITOR_MS: '50',
      NETWORK_MONITOR_TEST: '1',
      NETWORK_MONITOR_MS: '5000',
      CODEX_USAGE_MONITOR_TEST: '1',
      CODEX_USAGE_MONITOR_MS: '5000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });
  await waitForHttpServer({ baseUrl, child, output: () => childOutput });

  const index = await request('/');
  const setCookie = index.headers.get('set-cookie') || '';
  controlCookie = setCookie.split(';', 1)[0];
});

after(async () => {
  await stopChildProcess(child);
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  if (planningRuntimeRoot) rmSync(planningRuntimeRoot, { recursive: true, force: true });
});

test('startup narrows an existing private state directory to owner-only', () => {
  assert.equal(statSync(path.join(fixtureDir, 'data')).mode & 0o777, 0o700);
});

test('health and index responses carry defensive headers and a control cookie', async () => {
  const health = await request('/healthz');
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok\n');
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('x-frame-options'), 'DENY');
  assert.equal(health.headers.get('referrer-policy'), 'no-referrer');

  const index = await request('/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type') || '', /^text\/html\b/);
  assert.equal(index.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(index.headers.get('permissions-policy') || '', /camera=\(\)/);
  assert.match(index.headers.get('content-security-policy') || '', /default-src 'self'/);

  const setCookie = index.headers.get('set-cookie') || '';
  assert.match(setCookie, /^host_control_session=[^;]+;/);
  assert.match(setCookie, /\bHttpOnly\b/i);
  assert.match(setCookie, /\bSameSite=Strict\b/i);
  controlCookie = setCookie.split(';', 1)[0];
});

test('static files cannot escape the public root through a symlink', async () => {
  const outsideFile = path.join(fixtureDir, 'outside-static.txt');
  const symlink = path.join(fixtureDir, 'public', 'outside-static.txt');
  writeFileSync(outsideFile, 'must not be served\n');
  symlinkSync(outsideFile, symlink);
  try {
    const response = await request('/outside-static.txt');
    assert.equal(response.status, 404);
    assert.equal((await response.text()).includes('must not be served'), false);
  } finally {
    rmSync(symlink, { force: true });
    rmSync(outsideFile, { force: true });
  }
});

test('read-only operator APIs expose bounded state and retired paths stay closed', async () => {
  const headers = { cookie: controlCookie };

  const snapshotResponse = await request('/api/snapshot', { headers });
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await jsonResponse(snapshotResponse);
  assert.equal(snapshot.host.totalMem > 0, true);
  assert.equal(snapshot.host.availableMem > 0, true);
  assert.equal(snapshot.host.availableMem <= snapshot.host.totalMem, true);
  assert.equal(snapshot.host.swapTotal >= snapshot.host.swapFree, true);
  assert.equal(snapshot.host.rootFs.totalBytes > 0, true);
  assert.equal(snapshot.host.rootFs.availableBytes >= 0, true);
  assert.equal(snapshot.host.rootFs.usedPercent >= 0 && snapshot.host.rootFs.usedPercent <= 100, true);
  assert.equal(snapshot.codexStats.retentionDays, 90);
  assert.deepEqual(snapshot.codexStats.methodology, {
    scope: 'host-local',
    measurement: 'replayed-rollout-events',
    dayBoundary: 'UTC',
    includesCachedInput: true,
    firstSampleIsBaseline: false,
    accountUsageEquivalent: false,
    perTicket: true,
    coverage: 'complete'
  });
  assert.deepEqual(snapshot.codexStats.tickets, []);
  assert.deepEqual(snapshot.codexStats.today.agents, []);
  assert.equal(snapshot.review.session, 'codex-orchestrator-review');
  assert.equal(snapshot.review.running, false);
  assert.deepEqual(Object.keys(snapshot.review).sort(), [
    'agentStatus',
    'generatedAt',
    'running',
    'session',
    'sourceCounts'
  ]);
  assert.equal(snapshot.review.agentStatus, null);
  assert.deepEqual(snapshot.promptQueue.items, []);
  assert.deepEqual(snapshot.promptQueue.schedules, []);
  assert.equal(snapshot.promptQueue.counts.pending, 0);
  assert.equal(snapshot.capabilities.agentCommons, true);
  assert.equal(snapshot.capabilities.agentCommonsHelpRequests, true);
  assert.deepEqual(snapshot.agentCommons.messages, []);
  assert.deepEqual(snapshot.agentCommons.counts, {
    threads: 0,
    replies: 0,
    attention: 0,
    stop: 0,
    coordination: 0,
    helpRequests: 0,
    lessons: 0
  });
  assert.deepEqual(snapshot.agentCommons.help, {
    requests: [],
    policy: {
      existingAgentFirst: true,
      operatorApprovalRequired: true,
      maximumNewAgentsPerRequest: 1,
      recursiveSpawnAllowed: false
    }
  });
  assert.deepEqual(snapshot.agentCommons.safety, {
    dataOnly: true,
    terminalInputAuthorized: false,
    serviceControlAuthorized: false,
    externalMutationAuthorized: false
  });
  assert.equal(snapshot.security.sshRescue.active, false);
  assert.equal(Number.isInteger(snapshot.security.sshRescue.dashboardPort), true);
  assert.equal(snapshot.security.sshRescue.ports.includes(snapshot.security.sshRescue.dashboardPort), true);
  assert.equal(Array.isArray(snapshot.security.sshRescue.peerCidrs), true);

  for (const pathname of ['/api/audit', '/api/prompt-queue', '/api/missions', '/api/review/latest', '/api/security/ssh-rescue']) {
    const retiredApi = await request(pathname, { headers });
    assert.equal(retiredApi.status, 404);
    assert.deepEqual(await jsonResponse(retiredApi), { error: 'not_found' });
  }

  const missingStatic = await request('/missing-static.css');
  assert.equal(missingStatic.status, 404);
  assert.deepEqual(await jsonResponse(missingStatic), { error: 'not_found' });
});

test('inactive SSH rescue monitoring remains a local no-op', async () => {
  const before = toolLog();
  await delay(120);
  assert.equal(toolLog(), before);
});

test('periodic network and Codex monitor failures stay redacted without stopping the server', async () => {
  const servicesPath = path.join(fixtureDir, 'services.json');
  const original = readFileSync(servicesPath, 'utf8');
  const privateMarker = 'synthetic-private-monitor-config';
  const outputStart = childOutput.length;
  try {
    writeFileSync(servicesPath, `{ "${privateMarker}":`);
    const monitorOutput = await waitForCondition(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`isolated server exited before scheduled monitors ran (${child.exitCode ?? child.signalCode})`);
      }
      const observed = childOutput.slice(outputStart);
      return (
        observed.includes('PaneFleet network monitor failed') &&
        observed.includes('PaneFleet Codex usage monitor failed')
      ) ? observed : null;
    }, { intervalMs: 50, timeoutMs: 6500, label: 'scheduled monitor failures' });
    assert.match(monitorOutput, /PaneFleet network monitor failed: services\.json invalid JSON/);
    assert.match(monitorOutput, /PaneFleet Codex usage monitor failed: services\.json invalid JSON/);
    assert.doesNotMatch(monitorOutput, new RegExp(privateMarker));
    assert.equal(child.exitCode, null);
  } finally {
    writeFileSync(servicesPath, original);
  }
  const health = await request('/healthz');
  assert.equal(health.status, 200);
});

test('mutating API requests require the same-page control session', async () => {
  const response = await request('/api/agent/ui-key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'codex-smoke', key: 'up' })
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await jsonResponse(response), { error: 'control_session_required' });
});

test('mutating API requests require JSON', async () => {
  const response = await request('/api/agent/ui-key', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'text/plain' },
    body: '{}'
  });
  assert.equal(response.status, 415);
  assert.deepEqual(await jsonResponse(response), { error: 'application_json_required' });
});

test('mutating API requests reject a mismatched browser origin', async () => {
  const response = await request('/api/agent/ui-key', {
    method: 'POST',
    headers: {
      cookie: controlCookie,
      'content-type': 'application/json',
      origin: 'https://untrusted.example'
    },
    body: '{}'
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await jsonResponse(response), { error: 'origin_mismatch' });
});

test('Agent Commons API persists threads and lifecycle changes without terminal input', async () => {
  const before = toolLog();
  const create = await request('/api/commons/messages', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: 'commons-op-smoke-create-0001',
      category: 'wait',
      attention: 'checkpoint',
      audience: ['codex-alpha'],
      scope: '/workspace/alpha',
      body: 'Wait for the focused verifier before changing the shared contract.',
      evidence: ''
    })
  });
  assert.equal(create.status, 201);
  const created = await jsonResponse(create);
  assert.equal(created.message.category, 'wait');
  assert.equal(created.message.state, 'waiting');
  assert.equal(created.message.attention, 'checkpoint');

  const replay = await request('/api/commons/messages', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: 'commons-op-smoke-create-0001',
      category: 'wait',
      attention: 'checkpoint',
      audience: ['codex-alpha'],
      scope: '/workspace/alpha',
      body: 'Wait for the focused verifier before changing the shared contract.',
      evidence: ''
    })
  });
  assert.equal(replay.status, 200);
  assert.equal((await jsonResponse(replay)).message.id, created.message.id);

  const changedReplay = await request('/api/commons/messages', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: 'commons-op-smoke-create-0001',
      category: 'wait',
      body: 'Changed content must not inherit the earlier receipt.'
    })
  });
  assert.equal(changedReplay.status, 409);
  assert.deepEqual(await jsonResponse(changedReplay), { error: 'agent_commons_operation_conflict' });

  const reply = await request(`/api/commons/messages/${created.message.id}/reply`, {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: 'commons-op-smoke-reply-0001',
      attention: 'board',
      body: 'The verifier is running now.',
      evidence: ''
    })
  });
  assert.equal(reply.status, 201);
  const replied = await jsonResponse(reply);
  assert.equal(replied.message.threadId, created.message.id);

  const acknowledge = await request(`/api/commons/messages/${created.message.id}/acknowledge`, {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: 'commons-op-smoke-ack-0001' })
  });
  assert.equal(acknowledge.status, 200);
  assert.equal((await jsonResponse(acknowledge)).message.acknowledgements[0].actor.kind, 'operator');

  const transition = await request(`/api/commons/messages/${created.message.id}/transition`, {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: 'commons-op-smoke-transition-0001', state: 'accepted' })
  });
  assert.equal(transition.status, 200);
  assert.equal((await jsonResponse(transition)).message.state, 'accepted');

  const missingId = 'commons-missing-message-0001';
  const missingReply = await request(`/api/commons/messages/${missingId}/reply`, {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: 'commons-op-smoke-missing-reply-0001', body: 'Missing parent.' })
  });
  assert.equal(missingReply.status, 404);
  assert.deepEqual(await jsonResponse(missingReply), { error: 'agent_commons_parent_not_found' });

  const missingAcknowledgement = await request(`/api/commons/messages/${missingId}/acknowledge`, {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: 'commons-op-smoke-missing-ack-0001' })
  });
  assert.equal(missingAcknowledgement.status, 404);
  assert.deepEqual(await jsonResponse(missingAcknowledgement), { error: 'agent_commons_message_not_found' });

  const missingTransition = await request(`/api/commons/messages/${missingId}/transition`, {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: 'commons-op-smoke-missing-transition-0001', state: 'resolved' })
  });
  assert.equal(missingTransition.status, 404);
  assert.deepEqual(await jsonResponse(missingTransition), { error: 'agent_commons_message_not_found' });

  const invalidTransition = await request(`/api/commons/messages/${created.message.id}/transition`, {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: 'commons-op-smoke-invalid-transition-0001', state: 'invented' })
  });
  assert.equal(invalidTransition.status, 409);
  assert.deepEqual(await jsonResponse(invalidTransition), { error: 'agent_commons_transition_invalid' });

  const invalidCategory = await request('/api/commons/messages', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: 'commons-op-smoke-invalid-category-0001', category: 'command', body: 'No command channel.' })
  });
  assert.equal(invalidCategory.status, 400);
  assert.deepEqual(await jsonResponse(invalidCategory), { error: 'agent_commons_category_invalid' });
  assert.equal(toolLog(), before);

  const snapshotResponse = await request('/api/snapshot', { headers: { cookie: controlCookie } });
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await jsonResponse(snapshotResponse);
  assert.equal(snapshot.agentCommons.counts.threads, 1);
  assert.equal(snapshot.agentCommons.counts.replies, 1);
  assert.equal(snapshot.agentCommons.counts.attention, 1);
  assert.equal(snapshot.agentCommons.messages.some((message) => message.body.includes('verifier')), true);
});

test('Commons help requests bind one deterministic helper and fail closed outside isolated control-plane mode', async () => {
  const create = await request('/api/commons/messages', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: 'commons-op-smoke-help-create-0001',
      category: 'help_request',
      attention: 'ping',
      audience: 'all',
      scope: configuredWorkspaceEntry,
      body: 'Independently inspect the parser boundary and report evidence.'
    })
  });
  assert.equal(create.status, 201);
  const created = await jsonResponse(create);
  assert.equal(created.message.state, 'open');
  const helperName = `commons-helper-${created.message.id.slice('commons-'.length)}`;

  const snapshotResponse = await request('/api/snapshot', { headers: { cookie: controlCookie } });
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await jsonResponse(snapshotResponse);
  const routing = snapshot.agentCommons.help.requests.find((item) => item.messageId === created.message.id);
  assert.equal(routing.kind, 'blocked');
  assert.equal(routing.reason, 'control_plane_isolation_required');
  assert.equal(routing.helper.name, helperName);
  assert.equal(routing.helper.workspace, configuredWorkspaceEntry);
  assert.deepEqual(snapshot.agentCommons.help.policy, {
    existingAgentFirst: true,
    operatorApprovalRequired: true,
    maximumNewAgentsPerRequest: 1,
    recursiveSpawnAllowed: false
  });

  const invalidBinding = await request('/api/agent/create', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ commonsRequestId: 'invalid', name: 'ignored' })
  });
  assert.equal(invalidBinding.status, 400);
  assert.deepEqual(await jsonResponse(invalidBinding), { error: 'agent_commons_message_id_invalid' });

  const missingBinding = await request('/api/agent/create', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ commonsRequestId: 'commons-missing-help-0001', name: 'ignored' })
  });
  assert.equal(missingBinding.status, 404);
  assert.deepEqual(await jsonResponse(missingBinding), { error: 'agent_commons_help_request_not_found' });

  const nonHelpCreate = await request('/api/commons/messages', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: 'commons-op-smoke-non-help-create-0001',
      category: 'update',
      scope: configuredWorkspaceEntry,
      body: 'This update is not authority to start a helper.'
    })
  });
  assert.equal(nonHelpCreate.status, 201);
  const nonHelp = await jsonResponse(nonHelpCreate);
  const nonHelpBinding = await request('/api/agent/create', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ commonsRequestId: nonHelp.message.id, name: 'ignored' })
  });
  assert.equal(nonHelpBinding.status, 404);
  assert.deepEqual(await jsonResponse(nonHelpBinding), { error: 'agent_commons_help_request_not_found' });

  const globalCreate = await request('/api/commons/messages', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: 'commons-op-smoke-global-help-create-0001',
      category: 'help_request',
      scope: 'global',
      body: 'Find an existing idle agent, but do not create an unscoped helper.'
    })
  });
  assert.equal(globalCreate.status, 201);
  const globalHelp = await jsonResponse(globalCreate);
  const globalBinding = await request('/api/agent/create', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ commonsRequestId: globalHelp.message.id, name: 'ignored' })
  });
  assert.equal(globalBinding.status, 409);
  assert.deepEqual(await jsonResponse(globalBinding), { error: 'agent_commons_helper_workspace_required' });

  const unavailableCreate = await request('/api/commons/messages', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: 'commons-op-smoke-unavailable-help-create-0001',
      category: 'help_request',
      scope: path.join(fixtureDir, 'not-an-allowed-workspace'),
      body: 'Do not create a helper outside the allowlisted workspace roots.'
    })
  });
  assert.equal(unavailableCreate.status, 201);
  const unavailableHelp = await jsonResponse(unavailableCreate);
  const unavailableBinding = await request('/api/agent/create', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ commonsRequestId: unavailableHelp.message.id, name: 'ignored' })
  });
  assert.equal(unavailableBinding.status, 409);
  assert.deepEqual(await jsonResponse(unavailableBinding), { error: 'agent_commons_helper_workspace_unavailable' });

  const closedCreate = await request('/api/commons/messages', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: 'commons-op-smoke-closed-help-create-0001',
      category: 'help_request',
      scope: configuredWorkspaceEntry,
      body: 'This request will be closed before any helper is approved.'
    })
  });
  assert.equal(closedCreate.status, 201);
  const closedHelp = await jsonResponse(closedCreate);
  const closeRequest = await request(`/api/commons/messages/${closedHelp.message.id}/transition`, {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: 'commons-op-smoke-closed-help-resolve-0001', state: 'resolved' })
  });
  assert.equal(closeRequest.status, 200);
  const closedBinding = await request('/api/agent/create', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ commonsRequestId: closedHelp.message.id, name: 'ignored' })
  });
  assert.equal(closedBinding.status, 409);
  assert.deepEqual(await jsonResponse(closedBinding), { error: 'agent_commons_help_request_closed' });

  const launchBefore = toolLog();

  const baseLaunch = {
    commonsRequestId: created.message.id,
    name: helperName,
    workspaceMode: 'existing',
    workspace: configuredWorkspaceEntry,
    prompt: 'Browser text must never replace the server-bound request.'
  };
  const wrongName = await request('/api/agent/create', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ ...baseLaunch, name: 'different-helper' })
  });
  assert.equal(wrongName.status, 409);
  assert.deepEqual(await jsonResponse(wrongName), { error: 'agent_commons_helper_name_mismatch' });

  const wrongWorkspace = await request('/api/agent/create', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ ...baseLaunch, workspace: additionalWorkspaceRoot })
  });
  assert.equal(wrongWorkspace.status, 409);
  assert.deepEqual(await jsonResponse(wrongWorkspace), { error: 'agent_commons_helper_workspace_mismatch' });

  const missingWorkspace = await request('/api/agent/create', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ ...baseLaunch, workspace: '' })
  });
  assert.equal(missingWorkspace.status, 409);
  assert.deepEqual(await jsonResponse(missingWorkspace), { error: 'agent_commons_helper_workspace_mismatch' });

  const wrongWorkspaceMode = await request('/api/agent/create', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ ...baseLaunch, workspaceMode: 'new' })
  });
  assert.equal(wrongWorkspaceMode.status, 409);
  assert.deepEqual(await jsonResponse(wrongWorkspaceMode), { error: 'agent_commons_helper_workspace_mismatch' });

  const missingName = await request('/api/agent/create', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ ...baseLaunch, name: '' })
  });
  assert.equal(missingName.status, 409);
  assert.deepEqual(await jsonResponse(missingName), { error: 'agent_commons_helper_name_mismatch' });

  const blockedLaunch = await request('/api/agent/create', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify(baseLaunch)
  });
  assert.equal(blockedLaunch.status, 503);
  assert.deepEqual(await jsonResponse(blockedLaunch), {
    error: 'agent_commons_helper_control_plane_isolation_required'
  });
  assert.equal(toolLog(), launchBefore, 'a rejected helper approval must not consult tmux or other host tools');

  const after = await jsonResponse(await request('/api/snapshot', { headers: { cookie: controlCookie } }));
  assert.equal(after.agentCommons.messages.find((message) => message.id === created.message.id).state, 'open');
  assert.equal(after.agentCommons.counts.helpRequests, 3);
});

test('Agent Commons rejects hidden or sensitive collaboration text before persistence', async () => {
  const before = toolLog();
  const hidden = await request('/api/commons/messages', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: 'commons-op-smoke-hidden-0001',
      body: 'looks normal\u200bbut is not'
    })
  });
  assert.equal(hidden.status, 400);
  assert.deepEqual(await jsonResponse(hidden), { error: 'agent_commons_sensitive_content_not_allowed' });

  const secret = await request('/api/commons/messages', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: 'commons-op-smoke-secret-0001',
      body: `OPENAI_API_KEY=sk-proj-${'x'.repeat(32)}`
    })
  });
  assert.equal(secret.status, 400);
  assert.deepEqual(await jsonResponse(secret), { error: 'agent_commons_sensitive_content_not_allowed' });

  const secretScope = await request('/api/commons/messages', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: 'commons-op-smoke-secret-scope-0001',
      scope: `OPENAI_API_KEY=sk-proj-${'y'.repeat(32)}`,
      body: 'This body is otherwise safe.'
    })
  });
  assert.equal(secretScope.status, 400);
  assert.deepEqual(await jsonResponse(secretScope), { error: 'agent_commons_sensitive_content_not_allowed' });
  assert.equal(toolLog(), before);
});

test('mutating API requests reject cross-site metadata and malformed origins before routing', async () => {
  const before = existsSync(toolLogPath) ? readFileSync(toolLogPath, 'utf8') : '';
  const cases = [
    {
      headers: { 'sec-fetch-site': 'cross-site' },
      error: 'cross_site_request_rejected'
    },
    {
      headers: { origin: 'not a valid origin' },
      error: 'invalid_origin'
    },
    {
      headers: { origin: 'null', 'sec-fetch-site': 'same-origin' },
      error: 'invalid_origin'
    }
  ];
  for (const testCase of cases) {
    const response = await request('/api/agent/ui-key', {
      method: 'POST',
      headers: {
        cookie: controlCookie,
        'content-type': 'application/json',
        ...testCase.headers
      },
      body: '{}'
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await jsonResponse(response), { error: testCase.error });
  }
  assert.equal(existsSync(toolLogPath) ? readFileSync(toolLogPath, 'utf8') : '', before);
});

test('malformed JSON is a client error', async () => {
  const response = await request('/api/agent/ui-key', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: '{'
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await jsonResponse(response), { error: 'invalid_json' });
});

test('oversized JSON is rejected before parsing or host command execution', async () => {
  const before = existsSync(toolLogPath) ? readFileSync(toolLogPath, 'utf8') : '';
  const response = await request('/api/agent/ui-key', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      session: 'codex-smoke',
      key: 'up',
      padding: 'x'.repeat(1024 * 1024)
    })
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await jsonResponse(response), { error: 'request_body_too_large' });
  assert.equal(existsSync(toolLogPath) ? readFileSync(toolLogPath, 'utf8') : '', before);
});

test('picker key input is allowlisted before tmux is consulted', async () => {
  const before = toolLog();
  const response = await request('/api/agent/ui-key', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'codex-smoke', key: 'C-c' })
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await jsonResponse(response), { error: 'invalid_agent_ui_key' });
  assert.equal(toolLog(), before);
});

test('empty direct-input requests fail closed without inventing a worker identity', async () => {
  const before = toolLog();
  const picker = await request('/api/agent/ui-key', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(picker.status, 400);
  assert.deepEqual(await jsonResponse(picker), { error: 'invalid_agent_ui_key' });

  const text = await request('/api/agent/send', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(text.status, 400);
  assert.deepEqual(await jsonResponse(text), {
    error: 'missing_session_or_text',
    detail: 'missing_session_or_text',
    stage: 'preflight'
  });
  assert.equal(toolLog(), before);
});

test('agent interaction touch rejects invalid sessions before tmux is consulted', async () => {
  const before = toolLog();
  const response = await request('/api/agent/touch', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ session: '../not-an-agent' })
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await jsonResponse(response), { error: 'invalid_agent_session' });
  assert.equal(toolLog(), before);
});

test('IP rule inventory requires the same-page control session before AWS', async () => {
  const before = toolLog();
  const response = await request('/api/security/ssh-rescue/plan');
  assert.equal(response.status, 401);
  assert.deepEqual(await jsonResponse(response), { error: 'control_session_required' });
  assert.equal(toolLog(), before);
});

test('managed IP cleanup refuses a non-public requester before AWS', async () => {
  const before = toolLog();
  const response = await request('/api/security/ssh-rescue/cleanup', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ dryRun: true, currentOnly: true })
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await jsonResponse(response), { error: 'current_public_ipv4_unavailable' });
  assert.equal(toolLog(), before);
});

test('managed IP cleanup requires current-only semantics before AWS', async () => {
  const before = toolLog();
  const response = await request('/api/security/ssh-rescue/cleanup', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ dryRun: true })
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await jsonResponse(response), { error: 'current_only_required' });
  assert.equal(toolLog(), before);
});

test('unknown models are rejected before workspace or tmux mutation', async () => {
  const before = toolLog();
  const response = await request('/api/agent/create', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'smoke-never-created', model: 'not-in-isolated-model-cache' })
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await jsonResponse(response), { error: 'invalid_model' });
  assert.equal(toolLog(), before);
});

test('New Agent validates prompt, safety profile, and existing workspace before tmux mutation', async () => {
  const before = toolLog();
  const cases = [
    {
      body: { name: 'oversized-prompt', prompt: 'x'.repeat(8001) },
      error: 'prompt_too_long'
    },
    {
      body: { name: 'unknown-safety', safetyProfile: 'unrestricted-custom' },
      error: 'invalid_agent_safety_profile'
    },
    {
      body: { name: 'outside-workspace', workspaceMode: 'existing', workspace: fixtureDir },
      error: 'invalid_workspace'
    }
  ];
  for (const scenario of cases) {
    const response = await request('/api/agent/create', {
      method: 'POST',
      headers: { cookie: controlCookie, 'content-type': 'application/json' },
      body: JSON.stringify(scenario.body)
    });
    assert.equal(response.status, 400);
    assert.equal((await jsonResponse(response)).error, scenario.error);
  }
  assert.equal(toolLog(), before);

  const derivedName = await request('/api/agent/create', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceMode: 'existing', workspace: configuredWorkspaceEntry })
  });
  assert.equal(derivedName.status, 500);
  assert.equal((await jsonResponse(derivedName)).error, 'start_failed');
  assert.match(toolLog().slice(before.length), /tmux/);
});

test('model options project visible cache entries and exclude hidden models', async () => {
  installDynamicModelFixture();
  try {
    const response = await request('/api/options', { headers: { cookie: controlCookie } });
    assert.equal(response.status, 200);
    const options = await jsonResponse(response);

    assert.deepEqual(
      options.models.map(({ id, label, defaultReasoning, reasoningEfforts }) => ({
        id,
        label,
        defaultReasoning,
        reasoningEfforts
      })),
      [
        {
          id: 'gpt-test-alpha',
          label: 'GPT Test Alpha',
          defaultReasoning: 'medium',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
        },
        {
          id: 'gpt-test-beta',
          label: 'GPT Test Beta',
          defaultReasoning: 'medium',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max']
        }
      ]
    );
    assert.equal(options.models.some((model) => model.id === 'codex-auto-review'), false);
    assert.equal(options.configuredDefault.model, 'gpt-test-alpha');
    assert.equal(options.configuredDefault.modelLabel, 'GPT Test Alpha');
    assert.equal(options.configuredDefault.reasoning, 'ultra');
    assert.deepEqual(
      options.configuredDefault.reasoningEfforts,
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    );
    assert.equal(options.reasoningEfforts.includes('max'), true);
    assert.equal(options.reasoningEfforts.includes('ultra'), true);
    assert.deepEqual(
      options.workspaces
        .filter((item) => [additionalWorkspaceRoot, configuredWorkspaceEntry].includes(item.path))
        .map(({ path: workspacePath, label, group }) => ({ path: workspacePath, label, group }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      [
        { path: additionalWorkspaceRoot, label: 'Shared workspaces', group: 'Additional roots' },
        { path: configuredWorkspaceEntry, label: 'Example tooling', group: 'Project tools' }
      ].sort((left, right) => left.path.localeCompare(right.path))
    );
    assert.equal(options.workspaces.some((item) => item.path.endsWith('/reference') && item.group === 'Supporting folders'), true);
  } finally {
    resetDynamicModelFixture();
  }
});

test('the alpha fixture accepts ultra reasoning before any tmux mutation', async () => {
  installDynamicModelFixture();
  rmSync(toolLogPath, { force: true });
  try {
    const response = await request('/api/agent/create', {
      method: 'POST',
      headers: { cookie: controlCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test-alpha', reasoning: 'ultra' })
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await jsonResponse(response), { error: 'missing_name_or_directory' });
    assert.equal(existsSync(toolLogPath) ? readFileSync(toolLogPath, 'utf8') : '', '');
  } finally {
    resetDynamicModelFixture();
    rmSync(toolLogPath, { force: true });
  }
});

test('the beta fixture rejects unsupported ultra reasoning before any tmux mutation', async () => {
  installDynamicModelFixture();
  rmSync(toolLogPath, { force: true });
  try {
    const response = await request('/api/agent/create', {
      method: 'POST',
      headers: { cookie: controlCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test-beta', reasoning: 'ultra' })
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await jsonResponse(response), { error: 'invalid_reasoning_effort' });
    assert.equal(existsSync(toolLogPath) ? readFileSync(toolLogPath, 'utf8') : '', '');
  } finally {
    resetDynamicModelFixture();
    rmSync(toolLogPath, { force: true });
  }
});

test('the configured fixture default accepts ultra reasoning without a model override', async () => {
  installDynamicModelFixture();
  rmSync(toolLogPath, { force: true });
  try {
    const response = await request('/api/agent/create', {
      method: 'POST',
      headers: { cookie: controlCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ model: '', reasoning: 'ultra' })
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await jsonResponse(response), { error: 'missing_name_or_directory' });
    assert.equal(existsSync(toolLogPath) ? readFileSync(toolLogPath, 'utf8') : '', '');
  } finally {
    resetDynamicModelFixture();
    rmSync(toolLogPath, { force: true });
  }
});

test('the unspecified IPv4 address is rejected as a rescue address without consulting AWS', async () => {
  const awsBefore = toolInvocationCount('aws');
  const response = await request('/api/security/ssh-rescue/open', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'authorize', ip: unspecifiedIpv4 })
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await jsonResponse(response), { error: 'exact_public_ipv4_required' });
  assert.equal(toolInvocationCount('aws'), awsBefore);
});

test('non-routable documentation addresses are rejected before AWS', async () => {
  const awsBefore = toolInvocationCount('aws');
  const response = await request('/api/security/ssh-rescue/open', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'authorize', ip: documentationIpv4 })
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await jsonResponse(response), { error: 'exact_public_ipv4_required' });
  assert.equal(toolInvocationCount('aws'), awsBefore);
});

test('security mutations require exact action-specific confirmation before AWS', async () => {
  const awsBefore = toolInvocationCount('aws');
  const attempts = [
    ['/api/security/ssh-rescue/open', { confirm: 'open', ip: publicIpv4 }],
    ['/api/security/ssh-rescue/open', { confirm: true, ip: publicIpv4 }],
    ['/api/security/ssh-rescue/lock', { confirm: true }],
    ['/api/security/ssh-rescue/cleanup', { confirm: true, currentOnly: true, planToken: 'legacy-confirmation' }]
  ];
  for (const [pathname, body] of attempts) {
    const response = await request(pathname, {
      method: 'POST',
      headers: { cookie: controlCookie, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await jsonResponse(response), { error: 'confirmation_required' });
  }

  const retiredClose = await request('/api/security/ssh-rescue/close', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'close' })
  });
  assert.equal(retiredClose.status, 404);
  assert.deepEqual(await jsonResponse(retiredClose), { error: 'not_found' });
  assert.equal(toolInvocationCount('aws'), awsBefore);
});

test('hidden characters in a pasted rescue address are rejected before AWS', async () => {
  const awsBefore = toolInvocationCount('aws');
  const response = await request('/api/security/ssh-rescue/open', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'authorize', ip: `${publicIpv4}\u200b` })
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await jsonResponse(response), { error: 'unsafe_public_ipv4_characters' });
  assert.equal(toolInvocationCount('aws'), awsBefore);
});

test('public-IP service actions cannot fall back to a broad default', async () => {
  const before = toolLog();
  const response = await request('/api/service/public_ip_workflow/action/start', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'start' })
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await jsonResponse(response), { error: 'exact_public_ipv4_required' });
  assert.equal(toolLog(), before);
});

test('dashboard tmux sessions are protected before tmux is consulted', async () => {
  const tmuxBefore = toolInvocationCount('tmux');
  const response = await request('/api/session/agent-orchestrator/stop', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'stop' })
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await jsonResponse(response), { error: 'protected_session' });
  assert.equal(toolInvocationCount('tmux'), tmuxBefore);
});
