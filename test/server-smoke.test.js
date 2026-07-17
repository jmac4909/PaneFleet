import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

let fixtureDir;
let codexHome;
let additionalWorkspaceRoot;
let configuredWorkspaceEntry;
let toolLogPath;
let child;
let childOutput = '';
let baseUrl;
let controlCookie;

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

async function unusedLoopbackPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function installBlockedTool(binDir, name) {
  const executable = path.join(binDir, name);
  writeFileSync(
    executable,
    `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$ORCH_TOOL_LOG"\nexit 97\n`,
    { mode: 0o755 }
  );
  chmodSync(executable, 0o755);
}

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    return await fetch(`${baseUrl}${pathname}`, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function jsonResponse(response) {
  return JSON.parse(await response.text());
}

function toolLog() {
  return existsSync(toolLogPath) ? readFileSync(toolLogPath, 'utf8') : '';
}

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated server exited early (${child.exitCode})\n${childOutput}`);
    try {
      const response = await request('/healthz');
      if (response.status === 200) return;
    } catch {
      // The child may still be binding its loopback listener.
    }
    await delay(50);
  }
  throw new Error(`isolated server did not become ready\n${childOutput}`);
}

before(async () => {
  fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'agent-orchestrator-test-'));
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
  for (const name of ['aws', 'curl', 'ps', 'ss', 'tmux']) installBlockedTool(binDir, name);

  const port = await unusedLoopbackPort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
    cwd: fixtureDir,
    env: {
      HOME: fixtureDir,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      ORCHESTRATOR_RUNTIME_ROOT: fixtureDir,
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
      SSH_RESCUE_MONITOR_MS: '60000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });
  await waitForServer();

  const index = await request('/');
  const setCookie = index.headers.get('set-cookie') || '';
  controlCookie = setCookie.split(';', 1)[0];
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), delay(2000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
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

test('read-only operator APIs expose bounded state and unknown paths stay closed', async () => {
  const headers = { cookie: controlCookie };

  const promptQueueResponse = await request('/api/prompt-queue', { headers });
  assert.equal(promptQueueResponse.status, 200);
  const promptQueue = await jsonResponse(promptQueueResponse);
  assert.deepEqual(promptQueue.promptQueue.items, []);
  assert.deepEqual(promptQueue.promptQueue.schedules, []);
  assert.equal(promptQueue.promptQueue.counts.pending, 0);

  const reviewResponse = await request('/api/review/latest', { headers });
  assert.equal(reviewResponse.status, 200);
  const review = await jsonResponse(reviewResponse);
  assert.equal(review.session, 'codex-orchestrator-review');
  assert.equal(review.running, false);
  assert.equal(typeof review.contextPath, 'string');

  const unknownApi = await request('/api/not-allowlisted', { headers });
  assert.equal(unknownApi.status, 404);
  assert.deepEqual(await jsonResponse(unknownApi), { error: 'not_found' });

  const missingStatic = await request('/missing-static.css');
  assert.equal(missingStatic.status, 404);
  assert.deepEqual(await jsonResponse(missingStatic), { error: 'not_found' });
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

test('0.0.0.0 is rejected as a rescue address without consulting AWS', async () => {
  const response = await request('/api/security/ssh-rescue/open', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'open', ip: '0.0.0.0' })
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await jsonResponse(response), { error: 'exact_public_ipv4_required' });
  assert.equal(existsSync(toolLogPath) ? readFileSync(toolLogPath, 'utf8') : '', '');
});

test('non-routable documentation addresses are rejected before AWS', async () => {
  const response = await request('/api/security/ssh-rescue/open', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'open', ip: '203.0.113.10' })
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await jsonResponse(response), { error: 'exact_public_ipv4_required' });
  assert.equal(existsSync(toolLogPath) ? readFileSync(toolLogPath, 'utf8') : '', '');
});

test('public-IP service actions cannot fall back to a broad default', async () => {
  const response = await request('/api/service/public_ip_workflow/action/start', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'start' })
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await jsonResponse(response), { error: 'exact_public_ipv4_required' });
  assert.equal(existsSync(toolLogPath) ? readFileSync(toolLogPath, 'utf8') : '', '');
});

test('dashboard tmux sessions are protected before tmux is consulted', async () => {
  const response = await request('/api/session/agent-orchestrator/stop', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'stop' })
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await jsonResponse(response), { error: 'protected_session' });
  assert.equal(existsSync(toolLogPath) ? readFileSync(toolLogPath, 'utf8') : '', '');
});
