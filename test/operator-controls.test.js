import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { stopChildProcess, waitForChildExit } from './helpers/child-process.js';
import { writeExecutable } from './helpers/executables.js';
import { fetchWithTimeout, responseJson, waitForHttpServer } from './helpers/http.js';
import { waitForCondition, withTimeout } from './helpers/timing.js';
import { unusedLoopbackPort } from './helpers/unused-loopback-port.js';
import { applySnapshotPatch } from '../public/ui-state.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');

let fixtureDir;
let agentModePath;
let captureFailurePath;
let captureFallbackPath;
let tmuxFailurePath;
let toolLogPath;
let runtimeSourcePath;
let runtimeModuleSourcePath;
let modelCachePath;
let rolloutPath;
let child;
let codexTelemetryHelper;
let childOutput = '';
let baseUrl;
let controlCookie;

async function request(pathname, options = {}) {
  return fetchWithTimeout(`${baseUrl}${pathname}`, options);
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

function toolLog() {
  return readFileSync(toolLogPath, 'utf8');
}

function setAgentMode(mode) {
  writeFileSync(agentModePath, `${mode}\n`);
}

function runtimeEntrypointSource(build) {
  return `import {\n  fixtureRuntimeModule\n} from './runtime-module.js';\nfixture backend build ${build}\n`;
}

before(async () => {
  fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'panefleet-operator-controls-'));
  const publicDir = path.join(fixtureDir, 'public');
  const binDir = path.join(fixtureDir, 'bin');
  const dataDir = path.join(fixtureDir, 'data');
  const codexHome = path.join(fixtureDir, 'codex-home');
  const codexSessionDir = path.join(codexHome, 'sessions', '2026', '07', '31');
  const workspace = path.join(fixtureDir, 'projects', 'control-workspace');
  const logDir = path.join(workspace, 'logs');
  agentModePath = path.join(fixtureDir, 'agent-mode');
  captureFailurePath = path.join(fixtureDir, 'capture-failure');
  captureFallbackPath = path.join(fixtureDir, 'capture-fallback');
  tmuxFailurePath = path.join(fixtureDir, 'tmux-failure');
  toolLogPath = path.join(fixtureDir, 'tools.log');
  runtimeSourcePath = path.join(fixtureDir, 'runtime-source.js');
  runtimeModuleSourcePath = path.join(fixtureDir, 'runtime-module.js');
  for (const directory of [publicDir, binDir, dataDir, codexSessionDir, workspace, logDir]) {
    mkdirSync(directory, { recursive: true });
  }
  setAgentMode('node');
  writeFileSync(toolLogPath, '');
  writeFileSync(runtimeSourcePath, runtimeEntrypointSource('one'));
  writeFileSync(runtimeModuleSourcePath, 'fixture runtime module one\n');
  writeFileSync(tmuxFailurePath, '');
  writeFileSync(captureFallbackPath, '');
  writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>Operator controls fixture</title>\n');
  modelCachePath = path.join(codexHome, 'models_cache.json');
  writeFileSync(modelCachePath, '{"models":[]}\n');
  const observedAt = new Date().toISOString();
  writeFileSync(path.join(dataDir, 'agent-samples.json'), JSON.stringify({
    version: 1,
    agents: {
      'codex-control': {
        sessionCreatedAt: '2023-11-14T22:13:20.000Z',
        updatedAt: observedAt,
        samples: [{
          sampledAt: observedAt,
          session: 'codex-control',
          sessionCreatedAt: '2023-11-14T22:13:20.000Z',
          path: '~/projects/control-workspace',
          state: 'idle',
          tone: 'warn',
          reason: 'low cpu',
          latestPrompt: 'Find and fix a bug in @filename',
          focus: '» Find and fix a bug in @filename',
          activity: '» Find and fix a bug in @filename',
          blockers: '',
          cpu: 0,
          mem: 0
        }]
      },
      'codex-retired': {
        sessionCreatedAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:01.000Z',
        samples: [{
          sampledAt: '2020-01-01T00:00:01.000Z',
          session: 'codex-retired',
          sessionCreatedAt: '2020-01-01T00:00:00.000Z',
          path: '~/projects/control-workspace',
          state: 'idle',
          tone: 'good',
          reason: '',
          latestPrompt: '',
          focus: '',
          activity: '',
          blockers: '',
          cpu: 0,
          mem: 0
        }]
      }
    }
  }));
  writeFileSync(path.join(dataDir, 'actions.jsonl'), `${JSON.stringify({
    time: new Date(Date.now() - 60_000).toISOString(),
    action: 'agent.send',
    target: 'codex-control',
    ok: true,
    detail: 'historical fixture interaction'
  })}\n`);
  rolloutPath = path.join(codexSessionDir, 'rollout-fixture.jsonl');
  writeFileSync(rolloutPath, `${[
    {
      timestamp: observedAt,
      type: 'session_meta',
      payload: {
        id: '11111111-2222-4333-8444-555555555555',
        source: 'cli'
      }
    },
    {
      timestamp: observedAt,
      type: 'turn_context',
      payload: {
        model: 'gpt-fixture',
        effort: 'high',
        approval_policy: 'never',
        sandbox_policy: { type: 'workspace-write' }
      }
    },
    {
      timestamp: observedAt,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 600,
            output_tokens: 80,
            reasoning_output_tokens: 30,
            total_tokens: 1080
          },
          last_token_usage: {
            input_tokens: 400,
            cached_input_tokens: 200,
            output_tokens: 40,
            reasoning_output_tokens: 10,
            total_tokens: 440
          },
          model_context_window: 1000
        },
        rate_limits: {
          limit_id: 'codex',
          limit_name: 'Codex fixture',
          plan_type: 'pro',
          primary: {
            used_percent: 12,
            window_minutes: 10080,
            resets_at: Math.floor(Date.now() / 1000) + 604800
          },
          secondary: null
        }
      }
    },
    {
      timestamp: observedAt,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{
          type: 'output_text',
          text: '# Finished\n\n**Bold result**\n\n```diff\n+added\n-removed\n```\n\nOPENAI_API_KEY=fixture-secret-value'
        }]
      }
    }
  ].map((event) => JSON.stringify(event)).join('\n')}\n`);
  codexTelemetryHelper = spawn(process.execPath, [
    '-e',
    "const fs=require('node:fs'); fs.openSync(process.argv[1], 'r'); process.stdout.write('ready\\n'); setInterval(() => {}, 60000);",
    rolloutPath
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let onExit;
  let onData;
  const telemetryReady = new Promise((resolve, reject) => {
    onExit = (code) => reject(new Error(`Codex telemetry fixture exited early (${code})`));
    onData = () => resolve();
    codexTelemetryHelper.once('exit', onExit);
    codexTelemetryHelper.stdout.once('data', onData);
  });
  try {
    await withTimeout(() => telemetryReady, {
      timeoutMs: 2000,
      label: 'Codex telemetry fixture readiness'
    });
  } finally {
    codexTelemetryHelper.off('exit', onExit);
    codexTelemetryHelper.stdout.off('data', onData);
  }
  writeFileSync(path.join(fixtureDir, 'host-config.json'), '{}\n');
  writeFileSync(path.join(logDir, 'service.log'), [
    ...Array.from({ length: 5 }, (_, index) => `old-line-${index + 1}`),
    ...Array.from({ length: 19 }, (_, index) => `recent-line-${index + 6}`),
    'OPENAI_API_KEY=fixture-secret-value'
  ].join('\n'));
  writeFileSync(path.join(fixtureDir, 'services.json'), JSON.stringify([
    {
      id: 'demo-service',
      label: 'Demo service',
      session: 'demo-service',
      cwd: workspace,
      command: 'npm run dev',
      ports: [],
      links: [],
      logFiles: [
        { label: 'Service fixture', path: 'logs/service.log', lines: 20 },
        { label: 'Missing fixture', path: 'logs/missing.log', lines: 20 },
        { label: 'Unreadable fixture', path: 'logs', lines: 20 }
      ],
      actions: [
        { id: 'inspect', command: "printf 'service-action-ok'", runMode: 'exec', safe: true },
        { id: 'fail-check', command: "printf 'synthetic action failure' >&2; exit 7", runMode: 'exec', safe: true },
        { id: 'ip-check', command: "printf '%s' \"$TEST_PUBLIC_IP\"", runMode: 'exec', confirm: true, publicIpEnv: 'TEST_PUBLIC_IP' },
        { id: 'maintenance.collect', command: "printf 'maintenance-ok'", runMode: 'tmux', confirm: true }
      ]
    },
    {
      id: 'agent-orchestrator',
      label: 'Agent Orchestrator',
      cwd: workspace,
      ports: [],
      links: [],
      external: true,
      self: true,
      actions: [
        { id: 'restart-dashboard', command: "printf 'restart-scheduled'", runMode: 'exec', confirm: true }
      ]
    }
  ]));

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
if [ "$mode" = 'suggestion' ]; then command='node'; fi
if [ "$mode" = 'wrapped' ] || [ "$mode" = 'background' ]; then command='bash'; fi
case "$1" in
  list-panes)
    if [ "$2" = '-a' ]; then
      printf 'codex-control|1700000000|0|0|0|1|4100|/dev/pts/77|%%77|%s|%s|%s|%s|Control Agent\n' "$dead" "$dead_status" "$command" "$OPERATOR_WORKSPACE"
      printf 'job-site|1700000001|0|0|0|1|5100|/dev/pts/88|%%88|0||node|%s|Job Site\n' "$OPERATOR_WORKSPACE"
      printf 'job-site|1700000001|1|0|0|0|5200|/dev/pts/89|%%89|0||bash|%s|Job Watcher\n' "$OPERATOR_WORKSPACE"
    elif [ "$2" = '-t' ] && [ "$3" = '=codex-control' ]; then
      printf 'codex-control|1700000000|0|0|1|%s|%s|%%77|4100|%s|%s\n' "$command" "$OPERATOR_WORKSPACE" "$dead" "$dead_status"
    else
      exit 1
    fi
    ;;
  capture-pane)
    if [ -s "$OPERATOR_CAPTURE_FAILURE" ]; then exit 91; fi
    if [ -s "$OPERATOR_CAPTURE_FALLBACK" ]; then
      ansi_capture='0'
      for argument in "$@"; do
        if [ "$argument" = '-e' ]; then ansi_capture='1'; fi
      done
      if [ "$ansi_capture" = '1' ]; then
        printf '\\033[38;5m%s\\n' 'plain fallback fixture output'
      else
        printf '%s\\n' 'plain fallback fixture output'
      fi
      exit 0
    fi
    if [ "$mode" = 'suggestion' ]; then
      printf '%s\n' 'OpenAI Codex' '» Find and fix a bug in @filename' 'gpt-5.6-sol xhigh · ~/projects/control-workspace'
    else
      printf '%s\n' 'OpenAI Codex' 'Working (1s)'
      printf '\\033[1;32m%s\\033[0m\n' 'safe synthetic fixture output'
    fi
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
  if [ "$mode" = 'node' ] || [ "$mode" = 'wrapped' ] || [ "$mode" = 'suggestion' ]; then printf '%s\n' '${codexTelemetryHelper.pid} 4100 pts/77 S+ 0.1 0.2 2000 node /fixture/node_modules/@openai/codex/bin/codex'; fi
  if [ "$mode" = 'background' ]; then printf '%s\n' '${codexTelemetryHelper.pid} 4100 pts/77 S 0.1 0.2 2000 node /fixture/node_modules/@openai/codex/bin/codex'; fi
  printf '%s\n' '5100 1 pts/88 Ss 0.0 0.1 1000 bash'
  printf '%s\n' '5101 5100 pts/88 S+ 0.1 0.2 2000 node vite'
  printf '%s\n' '5200 1 pts/89 Ss 0.0 0.1 1000 bash'
  printf '%s\n' '5201 5200 pts/89 S+ 0.0 0.1 1000 bash monitor.sh'
elif [ "$2" = 'pid,ppid,stat,etime,pcpu,pmem,rss,cmd' ]; then
  printf '%s\n' 'PID PPID STAT ELAPSED %CPU %MEM RSS CMD'
  if [ "$mode" = 'node' ] || [ "$mode" = 'wrapped' ] || [ "$mode" = 'suggestion' ]; then printf '%s\n' '${codexTelemetryHelper.pid} 4100 S+ 00:01 0.1 0.2 2000 node /fixture/node_modules/@openai/codex/bin/codex'; fi
  if [ "$mode" = 'background' ]; then printf '%s\n' '${codexTelemetryHelper.pid} 4100 S 00:01 0.1 0.2 2000 node /fixture/node_modules/@openai/codex/bin/codex'; fi
  printf '%s\n' '5101 5100 S+ 00:01 0.1 0.2 2000 node vite'
else
  exit 97
fi
`);
  writeExecutable(path.join(binDir, 'ss'), `#!/bin/sh
case "$1" in
  -ltnp)
    printf '%s\n' 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process'
    printf '%s\n' 'MALFORMED LISTENER FIXTURE'
    printf '%s\n' 'LISTEN 0 511 127.0.0.1:4321 0.0.0.0:* users:(("node",pid=5101,fd=20))'
    printf '%s\n' 'LISTEN 0 511 0.0.0.0:8765 0.0.0.0:* users:(("python",pid=6200,fd=7))'
    printf '%s\n' 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=7000,fd=3))'
    ;;
  -H)
    case "$2" in
      -tanp)
        printf 'ESTAB 0 0 192.0.2.10:%s 198.51.100.20:55000 users:(("node",pid=9000,fd=20))\n' "$PORT"
        printf '%s\n' 'ESTAB 0 0 192.0.2.10:45100 192.0.2.44:443 users:(("codex",pid=9001,fd=21))'
        ;;
      -ltnp)
        printf 'LISTEN 0 511 0.0.0.0:%s 0.0.0.0:* users:(("node",pid=9000,fd=18))\n' "$PORT"
        printf '%s\n' 'LISTEN 0 511 0.0.0.0:8765 0.0.0.0:* users:(("python",pid=6200,fd=7))'
        printf '%s\n' 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=7000,fd=3))'
        ;;
      *) exit 97 ;;
    esac
    ;;
  -Htn) exit 0 ;;
  *) exit 97 ;;
esac
`);
  const acceptedSshAt = new Date(Date.now() - 2 * 60_000).toISOString();
  const failedSshAt = new Date(Date.now() - 60_000).toISOString();
  writeExecutable(path.join(binDir, 'journalctl'), `#!/bin/sh
printf '%s\n' '${acceptedSshAt} host sshd[1]: Accepted publickey for ec2-user from 198.51.100.20 port 55000 ssh2'
printf '%s\n' '${failedSshAt} host sshd[2]: Failed password for root from 203.0.113.55 port 55001 ssh2'
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
      ORCHESTRATOR_SERVER_SOURCE_PATH: runtimeSourcePath,
      ORCHESTRATOR_RUNTIME_VERSION_CACHE_MS: '1000',
      ORCHESTRATOR_PROJECTS_ROOT: path.join(fixtureDir, 'projects'),
      ORCHESTRATOR_AGENT_WORKSPACES_ROOT: path.join(fixtureDir, 'projects', 'agent-workspaces'),
      ORCH_CONTROL_PLANE_MODE: 'foreground',
      ORCHESTRATOR_ALLOW_DOCUMENTATION_IPS: '1',
      OPERATOR_TOOL_LOG: toolLogPath,
      OPERATOR_AGENT_MODE: agentModePath,
      OPERATOR_CAPTURE_FAILURE: captureFailurePath,
      OPERATOR_CAPTURE_FALLBACK: captureFallbackPath,
      OPERATOR_TMUX_FAILURE: tmuxFailurePath,
      OPERATOR_WORKSPACE: workspace,
      SNAPSHOT_EVENT_MS: '250',
      SNAPSHOT_EVENT_CACHE_MS: '1000',
      AGENT_SAMPLE_PERSIST_MS: '300000',
      NETWORK_MONITOR_TEST: '1',
      NETWORK_MONITOR_MS: '300000',
      CODEX_USAGE_MONITOR_TEST: '1',
      CODEX_USAGE_MONITOR_MS: '300000',
      AUDIT_MAX_BYTES: '65536',
      AUDIT_ARCHIVE_LIMIT: '2',
      AUDIT_RETENTION_DAYS: '1',
      AUDIT_MAINTENANCE_MS: '1000',
      SSH_RESCUE_MONITOR_MS: '3600000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });

  await waitForHttpServer({ baseUrl, child, output: () => childOutput, label: 'fixture server' });
  const index = await request('/');
  assert.equal(index.status, 200, childOutput);
  controlCookie = String(index.headers.get('set-cookie') || '').split(';', 1)[0];
  assert.match(controlCookie, /^host_control_session=/);
});

after(async () => {
  await stopChildProcess(child, 5000);
  await stopChildProcess(codexTelemetryHelper, 5000);
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

test('snapshot exposes drift in the backend entrypoint or an imported runtime module', async () => {
  const waitForRuntimeStatus = (status, label) => waitForCondition(async () => {
    const snapshot = await responseJson(await get('/api/snapshot'));
    return snapshot.runtimeVersion.status === status ? snapshot.runtimeVersion : null;
  }, { intervalMs: 200, timeoutMs: 3000, label });

  const current = await responseJson(await get('/api/snapshot'));
  assert.equal(current.runtimeVersion.protocolVersion, 3);
  assert.equal(current.runtimeVersion.status, 'current');
  assert.equal(current.runtimeVersion.restartRequired, false);
  assert.match(current.runtimeVersion.processBuildId, /^[a-f0-9]{16}$/);

  writeFileSync(runtimeSourcePath, runtimeEntrypointSource('two'));
  const cached = await responseJson(await get('/api/snapshot'));
  assert.deepEqual(cached.runtimeVersion, current.runtimeVersion);

  const stale = await waitForRuntimeStatus('restart_required', 'runtime source drift');
  assert.equal(stale.restartRequired, true);
  assert.equal(stale.processBuildId, current.runtimeVersion.processBuildId);

  writeFileSync(runtimeSourcePath, runtimeEntrypointSource('one'));
  const restored = await waitForRuntimeStatus('current', 'restored runtime source');
  assert.equal(restored.restartRequired, false);

  writeFileSync(runtimeModuleSourcePath, 'fixture runtime module two\n');
  const staleModule = await waitForRuntimeStatus('restart_required', 'imported runtime module drift');
  assert.equal(staleModule.restartRequired, true);
  assert.equal(staleModule.processBuildId, current.runtimeVersion.processBuildId);
  writeFileSync(runtimeModuleSourcePath, 'fixture runtime module one\n');
  const restoredModule = await waitForRuntimeStatus('current', 'restored imported runtime module');
  assert.equal(restoredModule.restartRequired, false);

  const unavailablePath = `${runtimeSourcePath}.missing`;
  renameSync(runtimeSourcePath, unavailablePath);
  try {
    const unavailable = await waitForRuntimeStatus('source_unavailable', 'unavailable runtime source');
    assert.equal(unavailable.restartRequired, true);
    assert.equal(unavailable.processBuildId, current.runtimeVersion.processBuildId);
  } finally {
    renameSync(unavailablePath, runtimeSourcePath);
  }
  const recovered = await waitForRuntimeStatus('current', 'recovered runtime source');
  assert.equal(recovered.restartRequired, false);
});

test('passive Codex usage monitoring persists one privacy-safe baseline from a live process descriptor', async () => {
  const stored = JSON.parse(readFileSync(path.join(fixtureDir, 'data', 'codex-usage-history.json'), 'utf8'));
  assert.equal(stored.version, 1);
  assert.equal(stored.revision, 1);
  const cursors = Object.values(stored.cursors);
  assert.equal(cursors.length, 1);
  assert.equal(cursors[0].session, 'codex-control');
  assert.equal(cursors[0].tokens.totalTokens, 1080);
  assert.equal(JSON.stringify(stored).includes('turn_context'), false);

  const snapshot = await responseJson(await get('/api/snapshot'));
  assert.equal(snapshot.codexUsage.sourceSession, 'codex-control');
  assert.equal(snapshot.codexUsage.account.primary.usedPercent, 12);
  assert.equal(snapshot.codexStats.agents.some((agent) => agent.session === 'codex-control'), true);
  assert.doesNotMatch(JSON.stringify(snapshot), /Bold result|fixture-secret-value/);
});

test('pane capture validates exact coordinates, bounds output, and reports capture failures', async () => {
  const malformedPath = await get('/api/pane/%E0%A4%A/capture');
  assert.equal(malformedPath.status, 400);
  assert.deepEqual(await responseJson(malformedPath), { error: 'invalid_url_encoding' });

  const invalid = await get('/api/pane/codex-control/capture?paneId=other%3A0.0&lines=17');
  assert.equal(invalid.status, 400);
  assert.deepEqual(await responseJson(invalid), { error: 'invalid_pane_id' });

  const captured = await get('/api/pane/codex-control/capture?paneId=codex-control%3A0.0&lines=17');
  const body = await responseJson(captured);
  assert.equal(captured.status, 200, JSON.stringify(body));
  assert.equal(body.lines, 17);
  assert.equal(body.pane.id, 'codex-control:0.0');
  assert.match(body.output, /safe synthetic fixture output/);
  assert.doesNotMatch(body.output, /\u001b/);
  assert.equal(body.styleStatus, 'styled');
  assert.equal(body.styleRuns.some((run) => run.bold && run.fg === '#0dbc79'), true);
  assert.equal(body.captureKind, 'live');

  const liveBound = await get('/api/pane/codex-control/capture?paneId=codex-control%3A0.0&lines=1200');
  assert.equal((await responseJson(liveBound)).lines, 300);

  const history = await get('/api/pane/codex-control/capture?paneId=codex-control%3A0.0&view=history&lines=5000');
  const historyBody = await responseJson(history);
  assert.equal(history.status, 200);
  assert.equal(historyBody.lines, 1200);
  assert.equal(historyBody.captureKind, 'history');

  writeFileSync(captureFallbackPath, 'fallback\n');
  try {
    const plainFallback = await get('/api/pane/codex-control/capture?paneId=codex-control%3A0.0');
    const plainFallbackBody = await responseJson(plainFallback);
    assert.equal(plainFallback.status, 200, JSON.stringify(plainFallbackBody));
    assert.match(plainFallbackBody.output, /plain fallback fixture output/);
    assert.deepEqual(plainFallbackBody.styleRuns, []);
    assert.equal(plainFallbackBody.styleStatus, 'plain-fallback');
  } finally {
    writeFileSync(captureFallbackPath, '');
  }

  const invalidView = await get('/api/pane/codex-control/capture?paneId=codex-control%3A0.0&view=everything');
  assert.equal(invalidView.status, 400);
  assert.deepEqual(await responseJson(invalidView), { error: 'invalid_capture_view' });

  const fallbackLines = await get('/api/pane/codex-control/capture?paneId=codex-control%3A0.0&lines=not-a-number');
  assert.equal(fallbackLines.status, 200);
  assert.equal((await responseJson(fallbackLines)).lines, 100);

  const changedCaptureIdentity = new URLSearchParams({
    sessionCreatedAt: '2023-11-14T22:13:20.000Z',
    paneId: 'codex-control:0.0',
    tmuxPaneId: '%77',
    panePid: '4101'
  }).toString();
  const changedCapture = await get(`/api/pane/codex-control/capture?${changedCaptureIdentity}`);
  assert.equal(changedCapture.status, 409);
  assert.deepEqual(await responseJson(changedCapture), { error: 'pane_identity_changed' });

  const missing = await get('/api/pane/codex-missing/capture?paneId=codex-missing%3A0.0');
  assert.equal(missing.status, 404);
  assert.deepEqual(await responseJson(missing), { error: 'pane_not_found' });

  writeFileSync(captureFailurePath, 'fail\n');
  const failed = await get('/api/pane/codex-control/capture?paneId=codex-control%3A0.0');
  assert.equal(failed.status, 500);
  assert.equal((await responseJson(failed)).error, 'capture_failed');
  rmSync(captureFailurePath, { force: true });
});

test('latest response stays bound to the exact active pane and is redacted', async () => {
  const identity = new URLSearchParams({
    sessionCreatedAt: '2023-11-14T22:13:20.000Z',
    paneId: 'codex-control:0.0',
    tmuxPaneId: '%77',
    panePid: '4100'
  }).toString();
  const result = await get(`/api/pane/codex-control/response?${identity}`);
  const body = await responseJson(result);
  assert.equal(result.status, 200, JSON.stringify(body));
  assert.match(body.response.text, /^# Finished/);
  assert.match(body.response.text, /```diff/);
  assert.doesNotMatch(body.response.text, /fixture-secret-value/);
  assert.equal(body.response.at.length > 0, true);
  assert.equal(body.response.truncated, false);
  assert.equal(body.redactedCount, 1);

  const missingIdentity = await get('/api/pane/codex-control/response?paneId=codex-control%3A0.0');
  assert.equal(missingIdentity.status, 400);
  assert.deepEqual(await responseJson(missingIdentity), { error: 'invalid_pane_identity' });

  const changedIdentity = new URLSearchParams({
    sessionCreatedAt: '2023-11-14T22:13:20.000Z',
    paneId: 'codex-control:0.0',
    tmuxPaneId: '%77',
    panePid: '4101'
  }).toString();
  const changed = await get(`/api/pane/codex-control/response?${changedIdentity}`);
  assert.equal(changed.status, 409);
  assert.deepEqual(await responseJson(changed), { error: 'pane_identity_changed' });

  const missingPaneIdentity = new URLSearchParams({
    sessionCreatedAt: '2023-11-14T22:13:22.000Z',
    paneId: 'codex-missing:0.0',
    tmuxPaneId: '%99',
    panePid: '9999'
  }).toString();
  const missingPane = await get(`/api/pane/codex-missing/response?${missingPaneIdentity}`);
  assert.equal(missingPane.status, 404);
  assert.deepEqual(await responseJson(missingPane), { error: 'pane_not_found' });

  const planningIdentity = new URLSearchParams({
    sessionCreatedAt: '2023-11-14T22:13:22.000Z',
    paneId: 'codex-planning-fixture:0.0',
    tmuxPaneId: '%98',
    panePid: '9998'
  }).toString();
  const managedPlanningPane = await get(`/api/pane/codex-planning-fixture/response?${planningIdentity}`);
  assert.equal(managedPlanningPane.status, 409);
  assert.deepEqual(await responseJson(managedPlanningPane), { error: 'planning_run_worker_control_managed' });

  const rolloutContents = readFileSync(rolloutPath, 'utf8');
  const withoutFinalResponse = rolloutContents
    .split('\n')
    .filter((line) => !line.includes('"phase":"final_answer"'))
    .join('\n');
  writeFileSync(rolloutPath, withoutFinalResponse);
  try {
    const missingResponse = await get(`/api/pane/codex-control/response?${identity}`);
    assert.equal(missingResponse.status, 404);
    assert.deepEqual(await responseJson(missingResponse), { error: 'final_response_not_found' });
  } finally {
    writeFileSync(rolloutPath, rolloutContents);
  }

  setAgentMode('background');
  try {
    const backgroundPane = await get(`/api/pane/codex-control/response?${identity}`);
    assert.equal(backgroundPane.status, 409);
    assert.deepEqual(await responseJson(backgroundPane), { error: 'codex_rollout_identity_unavailable' });
  } finally {
    setAgentMode('node');
  }
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
  assert.equal(body.services.filter((service) => service.id === 'tmux:job-site').length, 1);
  assert.deepEqual(tmuxService.panes.map((pane) => pane.id), ['job-site:0.0', 'job-site:1.0']);

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

  assert.equal(body.security.networkMonitor.status, 'monitoring');
  assert.deepEqual(body.security.networkMonitor.counts, {
    active: 2,
    inbound: 1,
    outbound: 1,
    local: 0,
    knownInboundPeers: 1,
    activeFlags: 2,
    sshFailures24h: 1,
    recentClosed: 0,
    sshEvents: 2
  });
  assert.equal(body.security.networkMonitor.activeConnections.find((connection) => connection.direction === 'inbound').destination, `PaneFleet :${new URL(baseUrl).port}`);
  assert.equal(body.security.networkMonitor.flags.some((flag) => flag.kind === 'unknown_inbound_peer'), false);
  assert.equal(body.security.networkMonitor.flags.some((flag) => flag.kind === 'unregistered_public_listener' && flag.active), true);
  assert.equal(body.security.networkMonitor.flags.some((flag) => flag.kind === 'ssh_auth_failure' && flag.active), true);
  assert.equal(body.attention.items.some((item) => item.kind === 'security' && item.status === 'ssh_auth_failure'), true);
  assert.equal(JSON.parse(readFileSync(path.join(fixtureDir, 'data', 'network-monitor.json'), 'utf8')).version, 1);
});

test('Agent Commons accepts only live-pane-bound spools and quarantines a replaced identity without terminal input', async () => {
  setAgentMode('node');
  const inbox = path.join(fixtureDir, 'data', 'agent-commons-inbox');
  const rejected = path.join(fixtureDir, 'data', 'agent-commons-rejected');
  const actor = {
    kind: 'agent',
    session: 'codex-control',
    sessionCreatedAt: '2023-11-14T22:13:20.000Z',
    paneId: '%77',
    panePid: 4100,
    label: 'Control Agent'
  };
  const queue = (suffix, action, payload, actorOverride = actor) => {
    const file = path.join(inbox, `commons-spool-${suffix}.json`);
    writeFileSync(file, `${JSON.stringify({
      version: 1,
      operationId: `commons-op-${suffix}`,
      action,
      actor: actorOverride,
      payload,
      createdAt: new Date().toISOString()
    })}\n`, { mode: 0o600 });
    return file;
  };
  const before = toolLog();

  const createFile = queue('live-create-0001', 'message.create', {
    category: 'question',
    attention: 'ping',
    audience: 'all',
    scope: 'global',
    body: 'The exact live control pane posted this bounded question.',
    evidence: ''
  });
  let snapshot = await responseJson(await get('/api/snapshot'));
  const root = snapshot.agentCommons.messages.find((message) => message.body.includes('bounded question'));
  assert.ok(root);
  assert.equal(root.author.session, 'codex-control');
  assert.equal(existsSync(createFile), false);

  queue('live-replying-0001', 'message.reply', {
    parentId: root.id,
    attention: 'board',
    body: 'The same pane added attributable context.',
    evidence: ''
  });
  snapshot = await responseJson(await get('/api/snapshot'));
  assert.equal(
    snapshot.agentCommons.messages.some((message) => message.parentId === root.id),
    true,
    JSON.stringify({ inbox: readdirSync(inbox), rejected: readdirSync(rejected) })
  );

  queue('live-acknowledge-0001', 'message.acknowledge', { messageId: root.id });
  queue('live-transition-0001', 'message.transition', { messageId: root.id, state: 'resolved' });
  snapshot = await responseJson(await get('/api/snapshot'));
  const resolved = snapshot.agentCommons.messages.find((message) => message.id === root.id);
  assert.equal(resolved.state, 'resolved');
  assert.equal(resolved.acknowledgements.some((item) => item.actor.session === 'codex-control'), true);

  const rejectedFile = queue('stale-create-0001', 'message.create', {
    body: 'A same-name replacement must not inherit this post.'
  }, { ...actor, panePid: 9999 });
  snapshot = await responseJson(await get('/api/snapshot'));
  assert.equal(snapshot.agentCommons.messages.some((message) => message.body.includes('replacement must not')), false);
  assert.equal(existsSync(rejectedFile), false);
  assert.equal(readdirSync(rejected).some((name) => name.startsWith('commons-spool-stale-create-0001.json.')), true);
  assert.doesNotMatch(toolLog().slice(before.length), /tmux <send-keys>/);
});

test('model options fail closed when the local catalog becomes unreadable and recover on refresh', async () => {
  const original = readFileSync(modelCachePath, 'utf8');
  try {
    writeFileSync(modelCachePath, '{ invalid model catalog\n');
    const unavailable = await get('/api/options');
    const unavailableBody = await responseJson(unavailable);
    assert.equal(unavailable.status, 200, JSON.stringify(unavailableBody));
    assert.deepEqual(unavailableBody.models, []);
    assert.equal(unavailableBody.configuredDefault.model, '');
    assert.equal(unavailableBody.configuredDefault.reasoning, '');
  } finally {
    writeFileSync(modelCachePath, original);
  }
  const recovered = await responseJson(await get('/api/options'));
  assert.deepEqual(recovered.models, []);
  const snapshot = await get('/api/snapshot');
  assert.equal(snapshot.status, 200, JSON.stringify(await responseJson(snapshot)));
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
    kind: 'agent.open',
    lastSupersedingAt: persisted.agents['codex-control'].lastSupersedingAt,
    lastSupersedingKind: 'agent.send'
  });
  assert.match(persisted.agents['codex-control'].lastSupersedingAt, /^\d{4}-\d{2}-\d{2}T/);
  const audit = readFileSync(path.join(fixtureDir, 'data', 'actions.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(audit.some((entry) => entry.action === 'agent.open' && entry.target === 'codex-control' && entry.ok === true), true);
  assert.doesNotMatch(toolLog().slice(before.length), /tmux <send-keys>/);
});

test('leaving a queued prompt is revision-safe and never sends terminal input', async () => {
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
    expectedRevision: created.item.revision + 1,
    confirm: 'leave-queue'
  });
  assert.equal(stale.status, 409);
  assert.equal((await responseJson(stale)).error, 'prompt_queue_revision_conflict');

  const unconfirmed = await post(`/api/prompt-queue/${created.item.id}/cancel`, {
    expectedRevision: created.item.revision,
    confirm: 'cancel'
  });
  assert.equal(unconfirmed.status, 400);
  assert.equal((await responseJson(unconfirmed)).error, 'prompt_queue_leave_confirmation_required');
  assert.equal((toolLog().match(/tmux <send-keys>/g) || []).length, sendCount);

  const canceledResponse = await post(`/api/prompt-queue/${created.item.id}/cancel`, {
    expectedRevision: created.item.revision,
    confirm: 'leave-queue'
  });
  const canceled = await responseJson(canceledResponse);
  assert.equal(canceledResponse.status, 200, JSON.stringify(canceled));
  assert.equal(canceled.item.status, 'canceled');
  assert.equal(canceled.item.blocker, 'Left the queue before dispatch.');
  assert.equal((toolLog().match(/tmux <send-keys>/g) || []).length, sendCount);

  const repeated = await post(`/api/prompt-queue/${created.item.id}/cancel`, {
    expectedRevision: canceled.item.revision,
    confirm: 'leave-queue'
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

  const legacyConfirmation = await post('/api/agent/interrupt', {
    session: 'codex-control',
    confirm: true
  });
  assert.equal(legacyConfirmation.status, 400);
  assert.deepEqual(await responseJson(legacyConfirmation), { error: 'confirmation_required' });
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
    confirm: 'interrupt'
  });
  assert.equal(failed.status, 500);
  assert.equal((await responseJson(failed)).error, 'send_key_failed');
  assert.equal((toolLog().slice(failedBefore.length).match(/tmux <send-keys>/g) || []).length, 1);
  writeFileSync(tmuxFailurePath, '');

  const protectedBefore = toolLog();
  const protectedResponse = await post('/api/agent/interrupt', {
    session: 'agent-orchestrator',
    confirm: 'interrupt'
  });
  assert.equal(protectedResponse.status, 403);
  assert.deepEqual(await responseJson(protectedResponse), { error: 'protected_session' });
  assert.doesNotMatch(toolLog().slice(protectedBefore.length), /send-keys/);

  const missingBefore = toolLog();
  const missing = await post('/api/agent/interrupt', {
    session: 'codex-not-present',
    confirm: 'interrupt'
  });
  assert.equal(missing.status, 404);
  assert.deepEqual(await responseJson(missing), { error: 'pane_not_found' });
  assert.doesNotMatch(toolLog().slice(missingBefore.length), /send-keys/);

  setAgentMode('dead');
  const deadBefore = toolLog();
  const dead = await post('/api/agent/interrupt', {
    session: 'codex-control',
    confirm: 'interrupt'
  });
  assert.equal(dead.status, 409);
  assert.deepEqual(await responseJson(dead), { error: 'pane_process_exited' });
  assert.doesNotMatch(toolLog().slice(deadBefore.length), /send-keys/);
});

test('session interrupt alias requires exact confirmation and sends one C-c', async () => {
  setAgentMode('node');
  writeFileSync(tmuxFailurePath, '');
  const before = toolLog();

  const unconfirmed = await post('/api/session/codex-control/interrupt', { confirm: true });
  assert.equal(unconfirmed.status, 400);
  assert.deepEqual(await responseJson(unconfirmed), { error: 'confirmation_required' });
  assert.doesNotMatch(toolLog().slice(before.length), /send-keys/);

  const interrupted = await post('/api/session/codex-control/interrupt', { confirm: 'interrupt' });
  assert.equal(interrupted.status, 200);
  assert.deepEqual(await responseJson(interrupted), { ok: true, session: 'codex-control' });
  const operations = toolLog().slice(before.length);
  assert.equal((operations.match(/tmux <send-keys>/g) || []).length, 1);
  assert.match(operations, /tmux <send-keys> <-t> <codex-control:0\.0> <C-c>/);
});

test('terminal Esc and Ctrl-C controls require exact pane identity and never retry replacements', async () => {
  // PaneFleet-created agents normally retain a shell as the tmux pane command
  // while Codex runs as the foreground descendant.
  setAgentMode('wrapped');
  writeFileSync(tmuxFailurePath, '');
  const identity = {
    session: 'codex-control',
    sessionCreatedAt: '2023-11-14T22:13:20.000Z',
    paneId: 'codex-control:0.0',
    tmuxPaneId: '%77',
    panePid: 4100
  };
  const before = toolLog();

  const unconfirmedEscape = await post('/api/agent/ui-key', { ...identity, key: 'escape' });
  assert.equal(unconfirmedEscape.status, 400);
  assert.deepEqual(await responseJson(unconfirmedEscape), { error: 'confirmation_required' });
  const missingIdentity = await post('/api/agent/ui-key', {
    session: identity.session,
    key: 'escape',
    confirm: 'send-escape'
  });
  assert.equal(missingIdentity.status, 400);
  assert.deepEqual(await responseJson(missingIdentity), { error: 'exact_agent_identity_required' });
  assert.doesNotMatch(toolLog().slice(before.length), /tmux <send-keys>/);

  const escaped = await post('/api/agent/ui-key', {
    ...identity,
    key: 'escape',
    confirm: 'send-escape'
  });
  assert.equal(escaped.status, 200, JSON.stringify(await responseJson(escaped)));
  const interrupted = await post('/api/agent/ui-key', {
    ...identity,
    key: 'interrupt',
    confirm: 'interrupt'
  });
  assert.equal(interrupted.status, 200, JSON.stringify(await responseJson(interrupted)));
  const operations = toolLog().slice(before.length);
  assert.equal((operations.match(/tmux <send-keys>/g) || []).length, 2);
  assert.match(operations, /tmux <send-keys> <-t> <codex-control:0\.0> <Escape>/);
  assert.match(operations, /tmux <send-keys> <-t> <codex-control:0\.0> <C-c>/);

  const sendsBeforeReplacement = (toolLog().match(/tmux <send-keys>/g) || []).length;
  const replaced = await post('/api/agent/ui-key', {
    ...identity,
    panePid: identity.panePid + 1,
    key: 'escape',
    confirm: 'send-escape'
  });
  assert.equal(replaced.status, 409);
  assert.deepEqual(await responseJson(replaced), { error: 'agent_pane_identity_changed' });
  assert.equal((toolLog().match(/tmux <send-keys>/g) || []).length, sendsBeforeReplacement);
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

test('a foreground Codex child behind a shell stays queue-eligible and accepts picker arrows and Enter', async () => {
  setAgentMode('wrapped');
  const response = await get('/api/snapshot');
  const body = await responseJson(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  const agent = body.agents.find((candidate) => candidate.session === 'codex-control');
  assert.ok(agent);
  assert.equal(agent.currentCommand, 'bash');
  assert.equal(agent.canSend, true);
  assert.equal(agent.canResume, false);
  assert.notEqual(agent.agentStatus.state, 'stopped');

  const before = toolLog();
  const arrow = await post('/api/agent/ui-key', { session: 'codex-control', key: 'down' });
  assert.equal(arrow.status, 200, JSON.stringify(await responseJson(arrow)));
  const select = await post('/api/agent/ui-key', { session: 'codex-control', key: 'select' });
  assert.equal(select.status, 200, JSON.stringify(await responseJson(select)));
  const operations = toolLog().slice(before.length);
  assert.match(operations, /tmux <send-keys> <-t> <codex-control:0\.0> <Down>/);
  assert.match(operations, /tmux <send-keys> <-t> <codex-control:0\.0> <C-m>/);
});

test('Codex starter suggestions are not reported as submitted prompts needing attention', async () => {
  setAgentMode('suggestion');
  try {
    const response = await get('/api/snapshot');
    const body = await responseJson(response);
    assert.equal(response.status, 200, JSON.stringify(body));
    const agent = body.agents.find((candidate) => candidate.session === 'codex-control');
    const brief = body.orchestration.agents.find((candidate) => candidate.session === 'codex-control');
    assert.ok(agent);
    assert.ok(brief);
    assert.equal(agent.latestPrompt, '');
    assert.equal(agent.historySummary.focus.includes('@filename'), false);
    assert.equal(agent.agentStatus.tone, 'good');
    assert.equal(brief.needsAttention, false);
    assert.equal(brief.tone, 'good');
    assert.doesNotMatch(brief.summary, /unresolved|specific file|corrected prompt/i);
  } finally {
    setAgentMode('node');
  }
});

test('a background Codex-shaped process does not make a shell pane promptable', async () => {
  setAgentMode('background');
  const response = await get('/api/snapshot');
  const body = await responseJson(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  const agent = body.agents.find((candidate) => candidate.session === 'codex-control');
  assert.ok(agent);
  assert.equal(agent.canSend, false);
  assert.equal(agent.canResume, true);
  const brief = body.orchestration.agents.find((candidate) => candidate.session === 'codex-control');
  assert.ok(brief);
  assert.equal(brief.tone, 'warn');
  assert.equal(brief.stateText, 'Codex exited, but its exact tmux pane is still running at a live shell.');
  assert.equal(brief.nextAction, 'Use Resume saved chat to continue the exact registered conversation in this terminal.');
  assert.equal(brief.needsAttention, true);

  const before = toolLog();
  const rejected = await post('/api/agent/ui-key', { session: 'codex-control', key: 'down' });
  assert.equal(rejected.status, 403);
  assert.deepEqual(await responseJson(rejected), { error: 'not_allowlisted_agent' });
  assert.doesNotMatch(toolLog().slice(before.length), /tmux <send-keys>/);
});

test('explicit stop protects the dashboard, handles missing panes, and reports one exact tmux failure', async () => {
  const killsBefore = (toolLog().match(/tmux <kill-session>/g) || []).length;
  const legacyConfirmation = await post('/api/session/codex-control/stop', { confirm: true });
  assert.equal(legacyConfirmation.status, 400);
  assert.deepEqual(await responseJson(legacyConfirmation), { error: 'confirmation_required' });
  assert.equal((toolLog().match(/tmux <kill-session>/g) || []).length, killsBefore);

  const protectedResponse = await post('/api/session/agent-orchestrator/stop', { confirm: 'stop' });
  assert.equal(protectedResponse.status, 403);
  assert.deepEqual(await responseJson(protectedResponse), { error: 'protected_session' });
  assert.equal((toolLog().match(/tmux <kill-session>/g) || []).length, killsBefore);

  const missing = await post('/api/session/not-present/stop', { confirm: 'stop' });
  assert.equal(missing.status, 404);
  assert.deepEqual(await responseJson(missing), { error: 'session_not_found' });

  writeFileSync(tmuxFailurePath, 'kill-session\n');
  const failed = await post('/api/session/codex-control/stop', { confirm: 'stop' });
  assert.equal(failed.status, 500);
  assert.equal((await responseJson(failed)).error, 'stop_session_failed');
  assert.equal((toolLog().match(/tmux <kill-session>/g) || []).length, killsBefore + 1);
  assert.match(toolLog(), /tmux <kill-session> <-t> <=codex-control>/);
  writeFileSync(tmuxFailurePath, '');

  const stopped = await post('/api/session/codex-control/stop', { confirm: 'stop' });
  assert.equal(stopped.status, 200);
  assert.deepEqual(await responseJson(stopped), { ok: true, session: 'codex-control' });
});

test('resume accepts only a live shell with an exact saved rollout and never falls back to last', async () => {
  const planningManaged = await post('/api/agent/resume', {
    session: 'codex-planning-0123456789abcdef01234567-po'
  });
  assert.equal(planningManaged.status, 409);
  assert.equal((await responseJson(planningManaged)).error, 'planning_run_worker_control_managed');

  const ineligible = await post('/api/agent/resume', { session: 'review-agent' });
  assert.equal(ineligible.status, 409);
  assert.equal((await responseJson(ineligible)).error, 'agent_recovery_profile_not_eligible');

  const missingPane = await post('/api/agent/resume', {
    session: 'codex-missing',
    sessionCreatedAt: new Date(1_700_000_000_000).toISOString(),
    paneId: 'codex-missing:0.0',
    tmuxPaneId: '%999',
    panePid: 99999
  });
  assert.equal(missingPane.status, 404);
  assert.equal((await responseJson(missingPane)).error, 'agent_pane_not_found');

  setAgentMode('node');
  const snapshotResponse = await get('/api/snapshot');
  const snapshot = await responseJson(snapshotResponse);
  const agent = snapshot.agents.find((candidate) => candidate.session === 'codex-control');
  const identity = {
    session: agent.session,
    sessionCreatedAt: agent.sessionCreatedAt,
    paneId: agent.id,
    tmuxPaneId: agent.tmuxPaneId,
    panePid: agent.panePid
  };
  const missingIdentity = await post('/api/agent/resume', { session: 'codex-control' });
  assert.equal(missingIdentity.status, 400);
  assert.equal((await responseJson(missingIdentity)).error, 'exact_agent_identity_required');

  const running = await post('/api/agent/resume', identity);
  assert.equal(running.status, 409);
  assert.equal((await responseJson(running)).error, 'already_running');

  const replaced = await post('/api/agent/resume', { ...identity, panePid: identity.panePid + 1 });
  assert.equal(replaced.status, 409);
  assert.equal((await responseJson(replaced)).error, 'agent_pane_identity_changed');

  setAgentMode('python');
  const unsupported = await post('/api/agent/resume', identity);
  assert.equal(unsupported.status, 409);
  assert.equal((await responseJson(unsupported)).error, 'unsupported_current_command');

  setAgentMode('dead');
  const dead = await post('/api/agent/resume', identity);
  assert.equal(dead.status, 409);
  assert.equal((await responseJson(dead)).error, 'pane_process_exited');

  setAgentMode('bash');
  writeFileSync(tmuxFailurePath, 'send-keys\n');
  const failedBefore = toolLog();
  const failed = await post('/api/agent/resume', identity);
  assert.equal(failed.status, 409);
  assert.equal((await responseJson(failed)).error, 'agent_recovery_exact_root_rollout_required');
  const failedOperations = toolLog().slice(failedBefore.length);
  assert.equal((failedOperations.match(/tmux <send-keys>/g) || []).length, 0);
  assert.doesNotMatch(failedOperations, /<C-m>/);
  assert.doesNotMatch(failedOperations, /resume --last/);
  writeFileSync(tmuxFailurePath, '');
});

test('allowlisted service lifecycle requires confirmation and uses only configured tmux actions', async () => {
  const missing = await post('/api/service/not-configured/start', {});
  assert.equal(missing.status, 404);
  assert.deepEqual(await responseJson(missing), { error: 'unknown_service' });

  const unconfirmed = await post('/api/service/demo-service/stop', {});
  assert.equal(unconfirmed.status, 400);
  assert.deepEqual(await responseJson(unconfirmed), { error: 'confirmation_required' });

  const beforeLegacyConfirmation = toolLog();
  const legacyConfirmation = await post('/api/service/demo-service/restart', { confirm: true });
  assert.equal(legacyConfirmation.status, 400);
  assert.deepEqual(await responseJson(legacyConfirmation), { error: 'confirmation_required' });
  assert.equal(toolLog(), beforeLegacyConfirmation);

  const started = await post('/api/service/demo-service/start', {});
  assert.equal(started.status, 200);
  const stopped = await post('/api/service/demo-service/stop', { confirm: 'stop' });
  assert.equal(stopped.status, 200);
  const restarted = await post('/api/service/demo-service/restart', { confirm: 'restart' });
  assert.equal(restarted.status, 200);

  writeFileSync(tmuxFailurePath, 'kill-session\n');
  const failedStop = await post('/api/service/demo-service/stop', { confirm: 'stop' });
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

  const beforeLegacyConfirmation = toolLog();
  const legacyConfirmation = await post('/api/service/demo-service/action/ip-check', {
    confirm: true,
    publicIp: '198.51.100.44'
  });
  assert.equal(legacyConfirmation.status, 400);
  assert.deepEqual(await responseJson(legacyConfirmation), { error: 'confirmation_required' });
  assert.equal(toolLog(), beforeLegacyConfirmation);

  const ipAction = await post('/api/service/demo-service/action/ip-check', {
    confirm: 'ip-check',
    publicIp: ' \t198.51.100.44/32\r\n'
  });
  assert.equal(ipAction.status, 200);
  assert.equal((await responseJson(ipAction)).output, '198.51.100.44/32');

  const beforeUnsafePaste = toolLog();
  const unsafePaste = await post('/api/service/demo-service/action/ip-check', {
    confirm: 'ip-check',
    publicIp: '198.51.100.44\u200b'
  });
  assert.equal(unsafePaste.status, 400);
  assert.deepEqual(await responseJson(unsafePaste), { error: 'unsafe_public_ipv4_characters' });
  assert.equal(toolLog(), beforeUnsafePaste);

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
    confirm: 'maintenance.collect'
  });
  assert.equal(failedTmuxAction.status, 500);
  assert.equal((await responseJson(failedTmuxAction)).error, 'action_start_failed');
  writeFileSync(tmuxFailurePath, '');
});

test('the self dashboard can schedule only its fixed confirmed custom restart action', async () => {
  const before = toolLog();
  const unconfirmed = await post('/api/service/agent-orchestrator/action/restart-dashboard', {});
  assert.equal(unconfirmed.status, 400);
  assert.deepEqual(await responseJson(unconfirmed), { error: 'confirmation_required' });
  assert.equal(toolLog(), before);

  const scheduled = await post('/api/service/agent-orchestrator/action/restart-dashboard', {
    confirm: 'restart-dashboard'
  });
  assert.equal(scheduled.status, 200);
  assert.deepEqual(await responseJson(scheduled), {
    ok: true,
    service: 'agent-orchestrator',
    action: 'restart-dashboard',
    output: 'restart-scheduled'
  });
  assert.equal(toolLog(), before);
});

test('generated review context tails allowlisted logs and redacts their sensitive values', async () => {
  const response = await post('/api/review/start', {});
  assert.equal(response.status, 200);
  const body = await responseJson(response);
  assert.equal(body.sourceCounts.logs, 3);

  const context = readFileSync(path.join(fixtureDir, 'data', 'reviews', 'latest-context.md'), 'utf8');
  assert.match(context, /Service fixture/);
  assert.match(context, /recent-line-24/);
  assert.doesNotMatch(context, /old-line-1/);
  assert.match(context, /OPENAI_API_KEY\[REDACTED\]/);
  assert.doesNotMatch(context, /fixture-secret-value/);
  assert.match(context, /Missing fixture/);
  assert.match(context, /Skipped: log is missing or resolves outside service cwd\./);
  assert.match(context, /Unreadable fixture/);
  assert.match(context, /EISDIR|illegal operation on a directory/i);
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

test('audit writes rotate an oversized log and remove expired archives without losing the new event', async () => {
  setAgentMode('node');
  const auditPath = path.join(fixtureDir, 'data', 'actions.jsonl');
  const nowMs = Date.now();
  const expiredPaths = [nowMs - 3 * 24 * 60 * 60 * 1000, nowMs - 2 * 24 * 60 * 60 * 1000]
    .map((timestamp) => `${auditPath}.${timestamp}`);
  for (const expiredPath of expiredPaths) {
    writeFileSync(expiredPath, 'expired fixture archive\n');
    const expiredAt = new Date(Number(expiredPath.slice(expiredPath.lastIndexOf('.') + 1)));
    utimesSync(expiredPath, expiredAt, expiredAt);
  }
  writeFileSync(auditPath, `${'x'.repeat(70 * 1024)}\n`);
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const response = await post('/api/agent/touch', { session: 'codex-control' });
  assert.equal(response.status, 200, JSON.stringify(await responseJson(response)));
  const entries = readdirSync(path.dirname(auditPath));
  const archives = entries.filter((name) => /^actions\.jsonl\.\d+$/.test(name));
  assert.equal(archives.length, 1);
  assert.equal(statSync(path.join(path.dirname(auditPath), archives[0])).size > 64 * 1024, true);
  assert.equal(expiredPaths.some((expiredPath) => entries.includes(path.basename(expiredPath))), false);
  assert.match(readFileSync(auditPath, 'utf8'), /"action":"agent\.open"/);
});

test('audit maintenance retries immediately after a transient filesystem failure', async () => {
  setAgentMode('node');
  const dataDir = path.join(fixtureDir, 'data');
  const auditPath = path.join(dataDir, 'actions.jsonl');
  const archiveNames = () => readdirSync(dataDir).filter((name) => /^actions\.jsonl\.\d+$/.test(name));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  writeFileSync(auditPath, `${'x'.repeat(70 * 1024)}\n`);
  const beforeArchives = new Set(archiveNames());

  chmodSync(dataDir, 0o500);
  try {
    const failedMaintenance = await post('/api/agent/touch', { session: 'codex-control' });
    assert.equal(failedMaintenance.status, 200, JSON.stringify(await responseJson(failedMaintenance)));
  } finally {
    chmodSync(dataDir, 0o700);
  }

  const retried = await post('/api/agent/touch', { session: 'codex-control' });
  assert.equal(retried.status, 200, JSON.stringify(await responseJson(retried)));
  assert.equal(archiveNames().some((name) => !beforeArchives.has(name)), true);
  assert.match(readFileSync(auditPath, 'utf8'), /"action":"agent\.open"/);
  assert.equal(statSync(auditPath).size < 64 * 1024, true);
});

test('event stream reports an initial snapshot failure to the connected client', async () => {
  const controller = new AbortController();
  const servicesPath = path.join(fixtureDir, 'services.json');
  const servicesSource = readFileSync(servicesPath, 'utf8');
  let reader;
  try {
    writeFileSync(servicesPath, '{ invalid fixture JSON\n');
    const response = await withTimeout(
      () => fetch(`${baseUrl}/api/events`, {
        headers: { cookie: controlCookie },
        signal: controller.signal
      }),
      { timeoutMs: 2500, label: 'initial event stream failure connection' }
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /^text\/event-stream/);
    reader = response.body.getReader();
    const payload = await withTimeout(async () => {
      let received = '';
      while (!received.includes('event: error')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('event stream closed before the initial error');
        received += Buffer.from(chunk.value || []).toString('utf8');
      }
      return received;
    }, { timeoutMs: 2500, label: 'initial event stream error' });
    assert.match(payload, /event: error/);
    assert.match(payload, /services\.json invalid JSON/);
  } finally {
    writeFileSync(servicesPath, servicesSource);
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
  }
});

test('event stream shares snapshots and shuts down cleanly with active clients', async () => {
  setAgentMode('node');
  const controllers = [new AbortController(), new AbortController()];
  const buildsBefore = (toolLog().match(/tmux <list-panes> <-a>/g) || []).length;
  const topProcessBuilds = () => (
    toolLog().match(/ps <-eo> <pid,ppid,stat,etime,pcpu,pmem,rss,cmd> <--sort=-rss>/g) || []
  ).length;
  const topBuildsBefore = topProcessBuilds();
  const dataDir = path.join(fixtureDir, 'data');
  const agentSamplesPath = path.join(dataDir, 'agent-samples.json');
  let dataDirRestricted = false;
  let readers = [];
  try {
    const responses = await withTimeout(
      () => Promise.all(controllers.map((controller) => fetch(`${baseUrl}/api/events`, {
        headers: { cookie: controlCookie },
        signal: controller.signal
      }))),
      { timeoutMs: 2500, label: 'event stream connections' }
    );
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /^text\/event-stream/);
    }
    readers = responses.map((response) => response.body.getReader());
    const pendingEvents = new Map();
    const readEvent = (reader, expectedEvent) => withTimeout(async () => {
      const pending = pendingEvents.get(reader) || { text: '', decoder: new TextDecoder() };
      pendingEvents.set(reader, pending);
      while (!pending.text.includes('\n\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`event stream closed before ${expectedEvent}`);
        pending.text += pending.decoder.decode(chunk.value, { stream: true });
      }
      const end = pending.text.indexOf('\n\n') + 2;
      const payload = pending.text.slice(0, end);
      pending.text = pending.text.slice(end);
      assert.ok(payload.split('\n').includes(`event: ${expectedEvent}`), `expected ${expectedEvent}, got ${payload.slice(0, 100)}`);
      return payload;
    }, { timeoutMs: 2500, label: `${expectedEvent} event` });

    const initialPayloads = await Promise.all(readers.map((reader) => readEvent(reader, 'snapshot')));
    assert.equal((toolLog().match(/tmux <list-panes> <-a>/g) || []).length - buildsBefore, 1);
    for (const payload of initialPayloads) {
      assert.match(payload, /id: 1/);
      assert.match(payload, /event: snapshot/);
      assert.match(payload, /"session":"codex-control"/);
    }

    const recurringPayloads = await Promise.all(readers.map((reader) => readEvent(reader, 'snapshot-patch')));
    for (const payload of recurringPayloads) {
      assert.match(payload, /id: 2/);
      assert.match(payload, /event: snapshot-patch/);
      assert.match(payload, /"baseSequence":1/);
      assert.match(payload, /"sequence":2/);
    }
    assert.equal((toolLog().match(/tmux <list-panes> <-a>/g) || []).length - buildsBefore, 2);
    assert.equal(topProcessBuilds() - topBuildsBefore <= 1, true);

    const servicesPath = path.join(fixtureDir, 'services.json');
    const servicesSource = readFileSync(servicesPath, 'utf8');
    writeFileSync(servicesPath, '{ invalid fixture JSON\n');
    try {
      const errorPayloads = await Promise.all(readers.map((reader) => readEvent(reader, 'error')));
      for (const payload of errorPayloads) {
        assert.match(payload, /event: error/);
        assert.match(payload, /services\.json invalid JSON/);
      }
    } finally {
      writeFileSync(servicesPath, servicesSource);
    }
    const recoveredPayloads = await Promise.all(readers.map((reader) => readEvent(reader, 'snapshot-patch')));
    for (const payload of recoveredPayloads) {
      assert.match(payload, /id: 3/);
      assert.match(payload, /event: snapshot-patch/);
    }

    // A browser joining an already-running stream must get a full base first,
    // then a patch the real browser reducer accepts (never a duplicate update).
    const joiningController = new AbortController();
    controllers.push(joiningController);
    const joiningResponse = await withTimeout(() => fetch(`${baseUrl}/api/events`, {
      headers: { cookie: controlCookie },
      signal: joiningController.signal
    }), { timeoutMs: 2500, label: 'joining event stream connection' });
    assert.equal(joiningResponse.status, 200);
    const joiningReader = joiningResponse.body.getReader();
    readers.push(joiningReader);
    const joinedFull = await readEvent(joiningReader, 'snapshot');
    const joinedPatch = await readEvent(joiningReader, 'snapshot-patch');
    const fullSequence = Number(joinedFull.match(/^id: (\d+)$/m)[1]);
    const fullData = JSON.parse(joinedFull.match(/^data: (.+)$/m)[1]);
    const patchData = JSON.parse(joinedPatch.match(/^data: (.+)$/m)[1]);
    assert.equal(applySnapshotPatch(fullData, fullSequence, patchData).ok, true);

    setAgentMode('background');
    const changedSnapshot = await get('/api/snapshot');
    assert.equal(changedSnapshot.status, 200);
    const durableSamples = readFileSync(agentSamplesPath, 'utf8');
    assert.doesNotThrow(() => JSON.parse(durableSamples));
    chmodSync(dataDir, 0o500);
    dataDirRestricted = true;

    const exited = waitForChildExit(child, { timeoutMs: 3000, label: 'active SSE fixture server' });
    assert.equal(child.kill('SIGTERM'), true);
    assert.equal(child.kill('SIGINT'), true);
    assert.deepEqual(await exited, [0, null]);
    assert.equal(readFileSync(agentSamplesPath, 'utf8'), durableSamples);
    assert.equal(
      readdirSync(dataDir).some((name) => /^agent-samples\.json\..+\.tmp$/.test(name)),
      false
    );
  } finally {
    if (dataDirRestricted) chmodSync(dataDir, 0o700);
    for (const controller of controllers) controller.abort();
    await Promise.all(readers.map((reader) => reader.cancel().catch(() => {})));
  }
});
