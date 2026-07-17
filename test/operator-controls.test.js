import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
let agentModePath;
let captureFailurePath;
let tmuxFailurePath;
let toolLogPath;
let child;
let childOutput = '';
let baseUrl;
let controlCookie;

function writeExecutable(file, source) {
  writeFileSync(file, source, { mode: 0o755 });
  chmodSync(file, 0o755);
}

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

async function request(pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    return await fetch(`${baseUrl}${pathname}`, { ...options, signal: options.signal || controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function post(pathname, body) {
  return request(pathname, {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function get(pathname) {
  return request(pathname, { headers: { cookie: controlCookie } });
}

async function responseJson(response) {
  return JSON.parse(await response.text());
}

function toolLog() {
  return readFileSync(toolLogPath, 'utf8');
}

function setAgentMode(mode) {
  writeFileSync(agentModePath, `${mode}\n`);
}

before(async () => {
  fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'panefleet-operator-controls-'));
  const publicDir = path.join(fixtureDir, 'public');
  const binDir = path.join(fixtureDir, 'bin');
  const codexHome = path.join(fixtureDir, 'codex-home');
  const workspace = path.join(fixtureDir, 'projects', 'control-workspace');
  const logDir = path.join(workspace, 'logs');
  agentModePath = path.join(fixtureDir, 'agent-mode');
  captureFailurePath = path.join(fixtureDir, 'capture-failure');
  tmuxFailurePath = path.join(fixtureDir, 'tmux-failure');
  toolLogPath = path.join(fixtureDir, 'tools.log');
  for (const directory of [publicDir, binDir, codexHome, workspace, logDir]) {
    mkdirSync(directory, { recursive: true });
  }
  setAgentMode('node');
  writeFileSync(toolLogPath, '');
  writeFileSync(tmuxFailurePath, '');
  writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>Operator controls fixture</title>\n');
  writeFileSync(path.join(codexHome, 'models_cache.json'), '{"models":[]}\n');
  writeFileSync(path.join(fixtureDir, 'host-config.json'), '{}\n');
  writeFileSync(path.join(logDir, 'service.log'), [
    ...Array.from({ length: 5 }, (_, index) => `old-line-${index + 1}`),
    ...Array.from({ length: 19 }, (_, index) => `recent-line-${index + 6}`),
    'OPENAI_API_KEY=fixture-secret-value'
  ].join('\n'));
  writeFileSync(path.join(fixtureDir, 'services.json'), JSON.stringify([{
    id: 'demo-service',
    label: 'Demo service',
    session: 'demo-service',
    cwd: workspace,
    command: 'npm run dev',
    ports: [],
    links: [],
    logFiles: [{ label: 'Service fixture', path: 'logs/service.log', lines: 20 }],
    actions: [
      { id: 'inspect', command: "printf 'service-action-ok'", runMode: 'exec', safe: true },
      { id: 'fail-check', command: "printf 'synthetic action failure' >&2; exit 7", runMode: 'exec', safe: true },
      { id: 'ip-check', command: "printf '%s' \"$TEST_PUBLIC_IP\"", runMode: 'exec', confirm: true, publicIpEnv: 'TEST_PUBLIC_IP' },
      { id: 'maintenance.collect', command: "printf 'maintenance-ok'", runMode: 'tmux', confirm: true }
    ]
  }]));

  writeExecutable(path.join(binDir, 'tmux'), `#!/bin/sh
printf 'tmux' >> "$OPERATOR_TOOL_LOG"
printf ' <%s>' "$@" >> "$OPERATOR_TOOL_LOG"
printf '\n' >> "$OPERATOR_TOOL_LOG"
if [ "$1" = '-L' ]; then shift; shift; fi
failure="$(cat "$OPERATOR_TMUX_FAILURE" 2>/dev/null)"
if [ -n "$failure" ] && [ "$1" = "$failure" ]; then
  printf '%s\n' 'synthetic tmux failure' >&2
  exit 92
fi
mode="$(cat "$OPERATOR_AGENT_MODE")"
command="$mode"
dead='0'
dead_status=''
if [ "$mode" = 'dead' ]; then command='node'; dead='1'; dead_status='70'; fi
case "$1" in
  list-panes)
    if [ "$2" = '-a' ]; then
      printf 'codex-control|1700000000|0|0|0|1|4100|/dev/pts/77|%%77|%s|%s|%s|%s|Control Agent\n' "$dead" "$dead_status" "$command" "$OPERATOR_WORKSPACE"
      printf 'job-site|1700000001|0|0|0|1|5100|/dev/pts/88|%%88|0||node|%s|Job Site\n' "$OPERATOR_WORKSPACE"
    elif [ "$2" = '-t' ] && [ "$3" = '=codex-control' ]; then
      printf 'codex-control|1700000000|0|0|1|%s|%s|%%77|4100|%s|%s\n' "$command" "$OPERATOR_WORKSPACE" "$dead" "$dead_status"
    else
      exit 1
    fi
    ;;
  capture-pane)
    if [ -s "$OPERATOR_CAPTURE_FAILURE" ]; then exit 91; fi
    printf '%s\n' 'OpenAI Codex' 'Working (1s)' 'safe synthetic fixture output'
    ;;
  send-keys|new-session|kill-session|set-option)
    exit 0
    ;;
  has-session)
    exit 1
    ;;
  *)
    exit 97
    ;;
esac
`);

  writeExecutable(path.join(binDir, 'ps'), `#!/bin/sh
mode="$(cat "$OPERATOR_AGENT_MODE")"
if [ "$2" = 'pid,ppid,tty,stat,pcpu,pmem,rss,cmd' ]; then
  printf '%s\n' 'PID PPID TT STAT %CPU %MEM RSS CMD'
  printf '%s\n' '4100 1 pts/77 Ss 0.0 0.1 1000 bash'
  if [ "$mode" = 'node' ]; then printf '%s\n' '4101 4100 pts/77 S+ 0.1 0.2 2000 node codex'; fi
  printf '%s\n' '5100 1 pts/88 Ss 0.0 0.1 1000 bash'
  printf '%s\n' '5101 5100 pts/88 S+ 0.1 0.2 2000 node vite'
elif [ "$2" = 'pid,ppid,stat,etime,pcpu,pmem,rss,cmd' ]; then
  printf '%s\n' 'PID PPID STAT ELAPSED %CPU %MEM RSS CMD'
  if [ "$mode" = 'node' ]; then printf '%s\n' '4101 4100 S+ 00:01 0.1 0.2 2000 node codex'; fi
  printf '%s\n' '5101 5100 S+ 00:01 0.1 0.2 2000 node vite'
else
  exit 97
fi
`);
  writeExecutable(path.join(binDir, 'ss'), `#!/bin/sh
case "$1" in
  -ltnp)
    printf '%s\n' 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process'
    printf '%s\n' 'LISTEN 0 511 127.0.0.1:4321 0.0.0.0:* users:(("node",pid=5101,fd=20))'
    printf '%s\n' 'LISTEN 0 511 0.0.0.0:8765 0.0.0.0:* users:(("python",pid=6200,fd=7))'
    printf '%s\n' 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=7000,fd=3))'
    ;;
  -Htn) exit 0 ;;
  *) exit 97 ;;
esac
`);
  for (const name of ['aws', 'curl', 'git', 'npm']) {
    writeExecutable(path.join(binDir, name), `#!/bin/sh\nprintf '%s\n' '${name}:FORBIDDEN' >> "$OPERATOR_TOOL_LOG"\nexit 97\n`);
  }

  const port = await unusedLoopbackPort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      HOME: fixtureDir,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      PATH: `${binDir}:${process.env.PATH || ''}`,
      CODEX_HOME: codexHome,
      ORCHESTRATOR_RUNTIME_ROOT: fixtureDir,
      ORCHESTRATOR_PROJECTS_ROOT: path.join(fixtureDir, 'projects'),
      ORCHESTRATOR_AGENT_WORKSPACES_ROOT: path.join(fixtureDir, 'projects', 'agent-workspaces'),
      ORCH_CONTROL_PLANE_MODE: 'foreground',
      ORCHESTRATOR_ALLOW_DOCUMENTATION_IPS: '1',
      OPERATOR_TOOL_LOG: toolLogPath,
      OPERATOR_AGENT_MODE: agentModePath,
      OPERATOR_CAPTURE_FAILURE: captureFailurePath,
      OPERATOR_TMUX_FAILURE: tmuxFailurePath,
      OPERATOR_WORKSPACE: workspace,
      SNAPSHOT_EVENT_MS: '50',
      SSH_RESCUE_MONITOR_MS: '3600000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited early\n${childOutput}`);
    try {
      const health = await request('/healthz');
      if (health.status === 200) break;
    } catch {
      // Server is still binding.
    }
    await delay(40);
  }
  const index = await request('/');
  assert.equal(index.status, 200, childOutput);
  controlCookie = String(index.headers.get('set-cookie') || '').split(';', 1)[0];
  assert.match(controlCookie, /^host_control_session=/);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), delay(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

test('pane capture validates exact coordinates, bounds output, and reports capture failures', async () => {
  const invalid = await get('/api/pane/codex-control/capture?paneId=other%3A0.0&lines=17');
  assert.equal(invalid.status, 400);
  assert.deepEqual(await responseJson(invalid), { error: 'invalid_pane_id' });

  const captured = await get('/api/pane/codex-control/capture?paneId=codex-control%3A0.0&lines=17');
  const body = await responseJson(captured);
  assert.equal(captured.status, 200, JSON.stringify(body));
  assert.equal(body.lines, 17);
  assert.equal(body.pane.id, 'codex-control:0.0');
  assert.match(body.output, /safe synthetic fixture output/);

  const missing = await get('/api/pane/codex-missing/capture?paneId=codex-missing%3A0.0');
  assert.equal(missing.status, 404);
  assert.deepEqual(await responseJson(missing), { error: 'pane_not_found' });

  writeFileSync(captureFailurePath, 'fail\n');
  const failed = await get('/api/pane/codex-control/capture?paneId=codex-control%3A0.0');
  assert.equal(failed.status, 500);
  assert.equal((await responseJson(failed)).error, 'capture_failed');
  rmSync(captureFailurePath, { force: true });
});

test('snapshot discovers tmux-backed and standalone services without inventing controls or exposing SSH', async () => {
  setAgentMode('node');
  const response = await get('/api/snapshot');
  const body = await responseJson(response);
  assert.equal(response.status, 200, JSON.stringify(body));

  const tmuxService = body.services.find((service) => service.id === 'tmux:job-site');
  assert.ok(tmuxService);
  assert.equal(tmuxService.discovered, true);
  assert.equal(tmuxService.managed, true);
  assert.equal(tmuxService.running, true);
  assert.equal(tmuxService.stateLabel, 'discovered');
  assert.deepEqual(tmuxService.ports, [4321]);
  assert.deepEqual(tmuxService.actions, []);
  assert.equal(tmuxService.pane.session, 'job-site');
  assert.equal(tmuxService.pane.primaryProcess.pid, 5101);

  const listenerService = body.services.find((service) => service.id === 'port:8765');
  assert.ok(listenerService);
  assert.equal(listenerService.discovered, true);
  assert.equal(listenerService.managed, false);
  assert.equal(listenerService.stateLabel, 'open port');
  assert.deepEqual(listenerService.ports, [8765]);
  assert.deepEqual(listenerService.actions, []);

  assert.equal(body.services.some((service) => service.id === 'port:22'), false);
  assert.equal(body.services.some((service) => service.id === 'port:4321'), false);
  assert.equal(body.agents.some((agent) => agent.session === 'job-site'), false);
});

test('opening an agent records one durable interaction without sending terminal input', async () => {
  setAgentMode('node');
  const before = toolLog();

  const invalid = await post('/api/agent/touch', { session: 'not-an-agent' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await responseJson(invalid), { error: 'invalid_agent_session' });

  const missing = await post('/api/agent/touch', { session: 'codex-missing' });
  assert.equal(missing.status, 404);
  assert.deepEqual(await responseJson(missing), { error: 'agent_pane_not_found' });

  const openedResponse = await post('/api/agent/touch', { session: 'codex-control' });
  const opened = await responseJson(openedResponse);
  assert.equal(openedResponse.status, 200, JSON.stringify(opened));
  assert.equal(opened.ok, true);
  assert.equal(opened.session, 'codex-control');
  assert.equal(opened.lastInteractionKind, 'agent.open');
  assert.match(opened.lastInteractionAt, /^\d{4}-\d{2}-\d{2}T/);

  const persisted = JSON.parse(readFileSync(path.join(fixtureDir, 'data', 'agent-interactions.json'), 'utf8'));
  assert.deepEqual(persisted.agents['codex-control'], {
    at: opened.lastInteractionAt,
    kind: 'agent.open'
  });
  const audit = await responseJson(await get('/api/audit?limit=20'));
  assert.equal(audit.audit.some((entry) => entry.action === 'agent.open' && entry.target === 'codex-control' && entry.ok === true), true);
  assert.doesNotMatch(toolLog().slice(before.length), /tmux <send-keys>/);
});

test('queued prompt cancellation is revision-safe and never sends terminal input', async () => {
  setAgentMode('node');
  const createdResponse = await post('/api/prompt-queue', {
    session: 'codex-control',
    sessionCreatedAt: '2023-11-14T22:13:20.000Z',
    paneId: 'codex-control:0.0',
    tmuxPaneId: '%77',
    panePid: 4100,
    text: 'Synthetic cancellation fixture; this must never be sent.'
  });
  const created = await responseJson(createdResponse);
  assert.equal(createdResponse.status, 200, JSON.stringify(created));
  assert.equal(created.item.status, 'queued');
  const sendCount = (toolLog().match(/tmux <send-keys>/g) || []).length;

  const stale = await post(`/api/prompt-queue/${created.item.id}/cancel`, {
    expectedRevision: created.item.revision + 1
  });
  assert.equal(stale.status, 409);
  assert.equal((await responseJson(stale)).error, 'prompt_queue_revision_conflict');

  const canceledResponse = await post(`/api/prompt-queue/${created.item.id}/cancel`, {
    expectedRevision: created.item.revision
  });
  const canceled = await responseJson(canceledResponse);
  assert.equal(canceledResponse.status, 200, JSON.stringify(canceled));
  assert.equal(canceled.item.status, 'canceled');
  assert.equal(canceled.item.blocker, 'Canceled before dispatch.');
  assert.equal((toolLog().match(/tmux <send-keys>/g) || []).length, sendCount);

  const repeated = await post(`/api/prompt-queue/${created.item.id}/cancel`, {
    expectedRevision: canceled.item.revision
  });
  assert.equal(repeated.status, 409);
  assert.equal((await responseJson(repeated)).error, 'prompt_queue_item_not_cancelable');
});

test('interrupt remains explicit, exact-pane-bound, and blocked for exited panes', async () => {
  setAgentMode('node');
  const before = toolLog();
  const unconfirmed = await post('/api/agent/interrupt', { session: 'codex-control' });
  assert.equal(unconfirmed.status, 400);
  assert.doesNotMatch(toolLog().slice(before.length), /send-keys/);

  const interrupted = await post('/api/agent/interrupt', {
    session: 'codex-control',
    confirm: 'interrupt'
  });
  assert.equal(interrupted.status, 200);
  assert.match(toolLog(), /tmux <send-keys> <-t> <codex-control:0\.0> <C-c>/);

  writeFileSync(tmuxFailurePath, 'send-keys\n');
  const failedBefore = toolLog();
  const failed = await post('/api/agent/interrupt', {
    session: 'codex-control',
    confirm: true
  });
  assert.equal(failed.status, 500);
  assert.equal((await responseJson(failed)).error, 'send_key_failed');
  assert.equal((toolLog().slice(failedBefore.length).match(/tmux <send-keys>/g) || []).length, 1);
  writeFileSync(tmuxFailurePath, '');

  setAgentMode('dead');
  const deadBefore = toolLog();
  const dead = await post('/api/agent/interrupt', {
    session: 'codex-control',
    confirm: true
  });
  assert.equal(dead.status, 409);
  assert.deepEqual(await responseJson(dead), { error: 'pane_process_exited' });
  assert.doesNotMatch(toolLog().slice(deadBefore.length), /send-keys/);
});

test('picker input reports exact-pane send failures without retrying or changing targets', async () => {
  setAgentMode('node');
  writeFileSync(tmuxFailurePath, '');
  const sent = await post('/api/agent/ui-key', { session: 'codex-control', key: 'down' });
  assert.equal(sent.status, 200);
  assert.deepEqual(await responseJson(sent), { ok: true, session: 'codex-control', key: 'down' });

  const sendsBeforeFailure = (toolLog().match(/tmux <send-keys>/g) || []).length;
  writeFileSync(tmuxFailurePath, 'send-keys\n');
  const failed = await post('/api/agent/ui-key', { session: 'codex-control', key: 'up' });
  assert.equal(failed.status, 500);
  const body = await responseJson(failed);
  assert.equal(body.error, 'agent_ui_key_failed');
  assert.match(body.detail, /synthetic tmux failure/);
  assert.equal((toolLog().match(/tmux <send-keys>/g) || []).length, sendsBeforeFailure + 1);
  assert.match(toolLog(), /tmux <send-keys> <-t> <codex-control:0\.0> <Up>/);
  writeFileSync(tmuxFailurePath, '');
});

test('explicit stop protects the dashboard, handles missing panes, and reports one exact tmux failure', async () => {
  const killsBefore = (toolLog().match(/tmux <kill-session>/g) || []).length;
  const protectedResponse = await post('/api/session/agent-orchestrator/stop', { confirm: 'stop' });
  assert.equal(protectedResponse.status, 403);
  assert.deepEqual(await responseJson(protectedResponse), { error: 'protected_session' });
  assert.equal((toolLog().match(/tmux <kill-session>/g) || []).length, killsBefore);

  const missing = await post('/api/session/not-present/stop', { confirm: true });
  assert.equal(missing.status, 404);
  assert.deepEqual(await responseJson(missing), { error: 'session_not_found' });

  writeFileSync(tmuxFailurePath, 'kill-session\n');
  const failed = await post('/api/session/codex-control/stop', { confirm: true });
  assert.equal(failed.status, 500);
  assert.equal((await responseJson(failed)).error, 'stop_session_failed');
  assert.equal((toolLog().match(/tmux <kill-session>/g) || []).length, killsBefore + 1);
  assert.match(toolLog(), /tmux <kill-session> <-t> <=codex-control>/);
  writeFileSync(tmuxFailurePath, '');

  const stopped = await post('/api/session/codex-control/stop', { confirm: true });
  assert.equal(stopped.status, 200);
  assert.deepEqual(await responseJson(stopped), { ok: true, session: 'codex-control' });
});

test('resume accepts only a live shell and types one command plus one Enter', async () => {
  setAgentMode('node');
  const running = await post('/api/agent/resume', { session: 'codex-control' });
  assert.equal(running.status, 409);
  assert.equal((await responseJson(running)).error, 'already_running');

  setAgentMode('python');
  const unsupported = await post('/api/agent/resume', { session: 'codex-control' });
  assert.equal(unsupported.status, 409);
  assert.equal((await responseJson(unsupported)).error, 'unsupported_current_command');

  setAgentMode('dead');
  const dead = await post('/api/agent/resume', { session: 'codex-control' });
  assert.equal(dead.status, 409);
  assert.equal((await responseJson(dead)).error, 'pane_process_exited');

  setAgentMode('bash');
  writeFileSync(tmuxFailurePath, 'send-keys\n');
  const failedBefore = toolLog();
  const failed = await post('/api/agent/resume', { session: 'codex-control' });
  assert.equal(failed.status, 500);
  assert.equal((await responseJson(failed)).error, 'resume_send_failed');
  const failedOperations = toolLog().slice(failedBefore.length);
  assert.equal((failedOperations.match(/tmux <send-keys>/g) || []).length, 1);
  assert.doesNotMatch(failedOperations, /<C-m>/);
  writeFileSync(tmuxFailurePath, '');

  const before = toolLog();
  const resumed = await post('/api/agent/resume', { session: 'codex-control' });
  const body = await responseJson(resumed);
  assert.equal(resumed.status, 200, JSON.stringify(body));
  assert.equal(body.command, 'codex resume --last');
  const operations = toolLog().slice(before.length);
  assert.equal((operations.match(/tmux <send-keys>/g) || []).length, 2);
  assert.match(operations, /<-l> <codex resume --last --yolo --config model_reasoning_effort=xhigh>/);
  assert.match(operations, /<C-m>/);
});

test('allowlisted service lifecycle requires confirmation and uses only configured tmux actions', async () => {
  const missing = await post('/api/service/not-configured/start', {});
  assert.equal(missing.status, 404);
  assert.deepEqual(await responseJson(missing), { error: 'unknown_service' });

  const unconfirmed = await post('/api/service/demo-service/stop', {});
  assert.equal(unconfirmed.status, 400);
  assert.deepEqual(await responseJson(unconfirmed), { error: 'confirmation_required' });

  const started = await post('/api/service/demo-service/start', {});
  assert.equal(started.status, 200);
  const stopped = await post('/api/service/demo-service/stop', { confirm: 'stop' });
  assert.equal(stopped.status, 200);
  const restarted = await post('/api/service/demo-service/restart', { confirm: true });
  assert.equal(restarted.status, 200);

  writeFileSync(tmuxFailurePath, 'kill-session\n');
  const failedStop = await post('/api/service/demo-service/stop', { confirm: true });
  assert.equal(failedStop.status, 500);
  const failedStopBody = await responseJson(failedStop);
  assert.equal(failedStopBody.error, 'stop_failed');
  assert.equal(failedStopBody.detail.trim(), 'synthetic tmux failure');
  writeFileSync(tmuxFailurePath, 'new-session\n');
  const failedStart = await post('/api/service/demo-service/start', {});
  assert.equal(failedStart.status, 500);
  const failedStartBody = await responseJson(failedStart);
  assert.equal(failedStartBody.error, 'start_failed');
  assert.equal(failedStartBody.detail.trim(), 'synthetic tmux failure');
  writeFileSync(tmuxFailurePath, '');

  const operations = toolLog();
  assert.match(operations, /tmux <has-session> <-t> <=demo-service>/);
  assert.match(operations, /tmux <new-session> <-d> <-s> <demo-service>/);
  assert.match(operations, /tmux <kill-session> <-t> <=demo-service>/);
  assert.doesNotMatch(operations, /kill-server|switch-client|respawn-pane/);
});

test('custom service actions stay allowlisted, confirmation-gated, and isolated by generated session', async () => {
  const missing = await post('/api/service/demo-service/action/not-configured', {});
  assert.equal(missing.status, 404);
  assert.deepEqual(await responseJson(missing), { error: 'unknown_action' });

  const inspected = await post('/api/service/demo-service/action/inspect', {});
  assert.equal(inspected.status, 200);
  assert.equal((await responseJson(inspected)).output, 'service-action-ok');

  const failedAction = await post('/api/service/demo-service/action/fail-check', {});
  assert.equal(failedAction.status, 500);
  assert.deepEqual(await responseJson(failedAction), {
    error: 'action_failed',
    output: 'synthetic action failure'
  });

  const ipAction = await post('/api/service/demo-service/action/ip-check', {
    confirm: true,
    publicIp: '198.51.100.44'
  });
  assert.equal(ipAction.status, 200);
  assert.equal((await responseJson(ipAction)).output, '198.51.100.44/32');

  const unconfirmed = await post('/api/service/demo-service/action/maintenance.collect', {});
  assert.equal(unconfirmed.status, 400);
  assert.deepEqual(await responseJson(unconfirmed), { error: 'confirmation_required' });

  const started = await post('/api/service/demo-service/action/maintenance.collect', {
    confirm: 'maintenance.collect'
  });
  assert.equal(started.status, 200);
  const body = await responseJson(started);
  assert.match(body.session, /^orch_demo-service_maintenance_collect_[a-z0-9]+$/);
  assert.match(toolLog(), new RegExp(`tmux <new-session> <-d> <-s> <${body.session}>`));

  writeFileSync(tmuxFailurePath, 'new-session\n');
  const failedTmuxAction = await post('/api/service/demo-service/action/maintenance.collect', {
    confirm: true
  });
  assert.equal(failedTmuxAction.status, 500);
  assert.equal((await responseJson(failedTmuxAction)).error, 'action_start_failed');
  writeFileSync(tmuxFailurePath, '');
});

test('generated review context tails allowlisted logs and redacts their sensitive values', async () => {
  const response = await post('/api/review/start', {});
  assert.equal(response.status, 200);
  const body = await responseJson(response);
  assert.equal(body.sourceCounts.logs, 1);

  const context = readFileSync(path.join(fixtureDir, 'data', 'reviews', 'latest-context.md'), 'utf8');
  assert.match(context, /Service fixture/);
  assert.match(context, /recent-line-24/);
  assert.doesNotMatch(context, /old-line-1/);
  assert.match(context, /OPENAI_API_KEY\[REDACTED\]/);
  assert.doesNotMatch(context, /fixture-secret-value/);
  assert.match(toolLog(), /tmux <-L> <host-control-managed> <new-session>/);
});

test('review startup reports one bounded managed-tmux failure', async () => {
  writeFileSync(tmuxFailurePath, 'new-session\n');
  try {
    const response = await post('/api/review/start', {});
    assert.equal(response.status, 500);
    const body = await responseJson(response);
    assert.equal(body.error, 'review_start_failed');
    assert.equal(body.detail.trim(), 'synthetic tmux failure');
    assert.match(toolLog(), /tmux <-L> <host-control-managed> <new-session>/);
  } finally {
    writeFileSync(tmuxFailurePath, '');
  }
});

test('event stream emits recurring authenticated snapshots and closes cleanly', async () => {
  setAgentMode('node');
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/events`, {
    headers: { cookie: controlCookie },
    signal: controller.signal
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/event-stream/);
  const reader = response.body.getReader();
  let payload = '';
  const deadline = Date.now() + 2000;
  while ((payload.match(/event: snapshot/g) || []).length < 2 && Date.now() < deadline) {
    const chunk = await reader.read();
    if (chunk.done) break;
    payload += Buffer.from(chunk.value || []).toString('utf8');
  }
  assert.equal((payload.match(/event: snapshot/g) || []).length >= 2, true);
  assert.match(payload, /event: snapshot/);
  assert.match(payload, /"session":"codex-control"/);
  controller.abort();
  await reader.cancel().catch(() => {});
});
