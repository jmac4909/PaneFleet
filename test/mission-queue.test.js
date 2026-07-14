import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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

function installFakeTool(binDir, name, source) {
  const executable = path.join(binDir, name);
  writeFileSync(executable, source, { mode: 0o755 });
  chmodSync(executable, 0o755);
}

function installDispatchTools(fixture) {
  installFakeTool(fixture.binDir, 'tmux', `#!/bin/sh
if [ "$1" = "-L" ] && [ "$2" = "host-control-managed" ]; then
  printf 'tmux:managed:%s\n' "$3" >> "$ORCH_TOOL_LOG"
  exit 1
fi
case "$1" in
  list-panes)
    if [ "$2" = "-a" ]; then
      state="idle"
      if [ -f "$MISSION_TMUX_STATE_PATH" ]; then state="$(cat "$MISSION_TMUX_STATE_PATH")"; fi
      pane_command="\${MISSION_PANE_COMMAND:-node}"
      global_tmux_pane_id='%77'
      global_pane_pid='4100'
      if [ "$MISSION_SUBMIT_BEHAVIOR" = "replacement" ] && [ "$state" = "accepted" ]; then
        global_tmux_pane_id='%88'
        global_pane_pid='4300'
      fi
      printf '%s|%s|0|0|0|1|%s|/dev/pts/77|%s|%s|%s|Codex Worker\\n' \
        'codex-worker' "\${MISSION_SESSION_CREATED:-1700000000}" "$global_pane_pid" "$global_tmux_pane_id" "$pane_command" "$MISSION_FAKE_WORKSPACE"
      if [ -n "$MISSION_EXTRA_WORKSPACE" ]; then
        printf '%s|%s|0|0|0|1|4200|/dev/pts/78|%%78|node|%s|Other Codex Worker\\n' \
          'codex-other' '1700000000' "$MISSION_EXTRA_WORKSPACE"
      fi
      printf '%s\\n' 'tmux:list-all' >> "$ORCH_TOOL_LOG"
    elif [ "$2" = "-t" ] && [ "$3" = "=codex-worker" ]; then
      state="idle"
      if [ -f "$MISSION_TMUX_STATE_PATH" ]; then state="$(cat "$MISSION_TMUX_STATE_PATH")"; fi
      pane_command="\${MISSION_PANE_COMMAND:-node}"
      tmux_pane_id='%77'
      pane_pid='4100'
      if [ "$MISSION_SUBMIT_BEHAVIOR" = "replacement" ] && [ "$state" = "accepted" ]; then
        tmux_pane_id='%88'
        pane_pid='4300'
      fi
      printf '%s|%s|0|0|1|%s|%s|%s|%s\\n' \
        'codex-worker' "\${MISSION_SESSION_CREATED:-1700000000}" "$pane_command" "$MISSION_FAKE_WORKSPACE" "$tmux_pane_id" "$pane_pid"
      printf '%s\\n' 'tmux:list-exact' >> "$ORCH_TOOL_LOG"
    else
      printf '%s\\n' 'tmux:unexpected-list' >> "$ORCH_TOOL_LOG"
      exit 97
    fi
    ;;
  capture-pane)
    if [ -n "$MISSION_CAPTURE_DELAY" ]; then sleep "$MISSION_CAPTURE_DELAY"; fi
    state="idle"
    if [ -f "$MISSION_TMUX_STATE_PATH" ]; then state="$(cat "$MISSION_TMUX_STATE_PATH")"; fi
    if [ "$MISSION_SUBMIT_BEHAVIOR" = "capture-failure" ] && [ "$state" = "accepted" ]; then
      printf '%s\\n' 'tmux:capture-failed' >> "$ORCH_TOOL_LOG"
      exit 96
    fi
    if [ -n "$MISSION_CAPTURE_OUTPUT" ]; then
      printf '%s\\n' "$MISSION_CAPTURE_OUTPUT"
    else
      case "$state" in
        typed)
          render_count=0
          if [ -f "$MISSION_TMUX_RENDER_COUNT_PATH" ]; then render_count="$(cat "$MISSION_TMUX_RENDER_COUNT_PATH")"; fi
          render_count=$((render_count + 1))
          printf '%s\\n' "$render_count" > "$MISSION_TMUX_RENDER_COUNT_PATH"
          printf '%s\\n' 'OpenAI Codex'
          if [ -n "$MISSION_STALE_WORKING" ]; then printf '%s\\n' 'Working (old output)'; fi
          if [ "$render_count" -ge "\${MISSION_LITERAL_VISIBLE_AFTER:-1}" ]; then
            printf '› %s\\n' "$(cat "$MISSION_TMUX_INPUT_PATH")"
          else
            printf '%s\\n' '› input still rendering'
          fi
          printf '%s\\n' 'gpt-test-alpha ultra · 100% left'
          ;;
        accepted)
          printf '%s\\n' 'OpenAI Codex'
          printf '› %s\\n' "$(cat "$MISSION_TMUX_INPUT_PATH")"
          printf '%s\\n' 'Working (1s)'
          printf '%s\\n' 'esc to interrupt'
          ;;
        transient)
          confirm_count=0
          if [ -f "$MISSION_TMUX_CONFIRM_COUNT_PATH" ]; then confirm_count="$(cat "$MISSION_TMUX_CONFIRM_COUNT_PATH")"; fi
          confirm_count=$((confirm_count + 1))
          printf '%s\\n' "$confirm_count" > "$MISSION_TMUX_CONFIRM_COUNT_PATH"
          printf '%s\\n' 'OpenAI Codex'
          printf '› %s\\n' "$(cat "$MISSION_TMUX_INPUT_PATH")"
          if [ "$confirm_count" -eq 1 ]; then printf '%s\\n' 'Working (1s)'; fi
          printf '%s\\n' 'gpt-test-alpha ultra · 100% left'
          ;;
        complete)
          printf '%s\\n' 'OpenAI Codex'
          printf '› %s\\n' "$(cat "$MISSION_TMUX_INPUT_PATH")"
          printf '%s\\n' 'STATUS: complete'
          printf '%s\\n' 'RESULT: focused work completed'
          printf '%s\\n' 'EVIDENCE: focused tests passed'
          printf '%s\\n' 'NEXT ACTION: verify independently'
          printf '%s\\n' '› '
          printf '%s\\n' 'gpt-test-alpha ultra · 95% left'
          ;;
        idle-placeholder)
          printf '%s\\n' 'OpenAI Codex'
          printf '› %s\\n' "$(cat "$MISSION_TMUX_INPUT_PATH")"
          printf '%s\\n' '› Implement {feature}'
          printf '%s\\n' 'gpt-test-alpha ultra · 100% left'
          ;;
        *)
          printf '%s\\n' 'OpenAI Codex'
          printf '%s\\n' '› Ask Codex anything'
          printf '%s\\n' 'gpt-test-alpha ultra · 100% left'
          ;;
      esac
    fi
    printf '%s\\n' 'tmux:capture' >> "$ORCH_TOOL_LOG"
    ;;
  send-keys)
    printf 'tmux:send-target:%s:%s\\n' "$3" "$4" >> "$ORCH_TOOL_LOG"
    if [ "$2" != "-t" ] || { [ "$3" != "codex-worker:0.0" ] && [ "$3" != "%77" ]; }; then
      printf '%s\\n' 'tmux:unexpected-target' >> "$ORCH_TOOL_LOG"
      exit 97
    fi
    if [ "$4" = "-l" ] && [ "$#" -eq 5 ]; then
      case "$5" in
        '[Host Control Mission '* )
          if ! grep -q '"status": "dispatching"' "$MISSION_QUEUE_PATH" || \
             ! grep -q '"assignedPaneId": "codex-worker:0.0"' "$MISSION_QUEUE_PATH" || \
             ! grep -q '"activeAttempt": {' "$MISSION_QUEUE_PATH"; then
            printf '%s\\n' 'tmux:unexpected-undurable-claim' >> "$ORCH_TOOL_LOG"
            exit 97
          fi
          : > "$MISSION_TMUX_INPUT_PATH"
          ;;
      esac
      case "$5" in
        *'
'*) printf '%s\\n' 'tmux:unexpected-multiline-prompt' >> "$ORCH_TOOL_LOG"; exit 97 ;;
      esac
      if [ -n "$MISSION_MAX_LITERAL_CHUNK" ] && [ "\${#5}" -gt "$MISSION_MAX_LITERAL_CHUNK" ]; then
        printf 'tmux:oversized-literal:%s\\n' "\${#5}" >> "$ORCH_TOOL_LOG"
        exit 97
      fi
      printf 'tmux:send-literal:%s\\n' "\${#5}" >> "$ORCH_TOOL_LOG"
      printf '%s' "$5" >> "$MISSION_TMUX_INPUT_PATH"
      printf '%s\\n' 'typed' > "$MISSION_TMUX_STATE_PATH"
      if [ "$MISSION_TMUX_FAILURE" = "literal" ]; then exit 96; fi
    elif [ "$4" = "C-m" ] && [ "$#" -eq 4 ]; then
      printf '%s\\n' 'tmux:send-enter:C-m' >> "$ORCH_TOOL_LOG"
      if [ "$MISSION_TMUX_FAILURE" = "enter" ]; then exit 96; fi
      case "$MISSION_SUBMIT_BEHAVIOR" in
        ignored) ;;
        transient) printf '%s\\n' 'transient' > "$MISSION_TMUX_STATE_PATH" ;;
        complete) printf '%s\\n' 'complete' > "$MISSION_TMUX_STATE_PATH" ;;
        idle-placeholder) printf '%s\\n' 'idle-placeholder' > "$MISSION_TMUX_STATE_PATH" ;;
        *) printf '%s\\n' 'accepted' > "$MISSION_TMUX_STATE_PATH" ;;
      esac
    else
      printf '%s\\n' 'tmux:unexpected-send' >> "$ORCH_TOOL_LOG"
      exit 97
    fi
    ;;
  *)
    printf 'tmux:unexpected:%s\\n' "$1" >> "$ORCH_TOOL_LOG"
    exit 97
    ;;
esac
`);

  installFakeTool(fixture.binDir, 'ps', `#!/bin/sh
if [ "$2" = "pid,ppid,tty,stat,pcpu,pmem,rss,cmd" ]; then
  printf '%s\\n' 'PID PPID TT STAT %CPU %MEM RSS CMD'
  printf '%s\\n' '4100 1 pts/77 Ss 0.0 0.1 1000 bash'
  if [ "$MISSION_NO_CODEX_PROCESS" != "1" ]; then
    printf '%s\\n' '4101 4100 pts/77 S+ 0.0 0.2 2000 node codex'
    printf '%s\\n' '4201 4200 pts/78 S+ 0.0 0.2 2000 node codex'
  fi
  printf '%s\\n' 'ps:tty' >> "$ORCH_TOOL_LOG"
elif [ "$2" = "pid,ppid,stat,etime,pcpu,pmem,rss,cmd" ]; then
  printf '%s\\n' 'PID PPID STAT ELAPSED %CPU %MEM RSS CMD'
  printf '%s\\n' '4101 4100 S+ 00:01 0.0 0.2 2000 node codex'
  printf '%s\\n' '4201 4200 S+ 00:01 0.0 0.2 2000 node codex'
  printf '%s\\n' 'ps:top' >> "$ORCH_TOOL_LOG"
else
  printf '%s\\n' 'ps:unexpected' >> "$ORCH_TOOL_LOG"
  exit 97
fi
`);

  installFakeTool(fixture.binDir, 'ss', `#!/bin/sh
if [ "$1" = "-ltnp" ]; then
  printf '%s\\n' 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process'
  printf '%s\\n' 'ss:listeners' >> "$ORCH_TOOL_LOG"
elif [ "$1" = "-Htn" ]; then
  printf '%s\\n' 'ss:ssh-peers' >> "$ORCH_TOOL_LOG"
else
  printf '%s\\n' 'ss:unexpected' >> "$ORCH_TOOL_LOG"
  exit 97
fi
`);
}

function installReviewTools(fixture) {
  installDispatchTools(fixture);
  installFakeTool(fixture.binDir, 'tmux', `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "$ORCH_TOOL_LOG"
if [ "$1" = "list-panes" ]; then
  exit 0
fi
if [ "$1" != "-L" ] || [ "$2" != "host-control-managed" ]; then
  exit 97
fi
case "$3" in
  list-panes) exit 1 ;;
  has-session|kill-session|new-session|set-option) exit 0 ;;
  *) exit 97 ;;
esac
`);
}

function createFixture() {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'agent-orchestrator-missions-'));
  const codexHome = path.join(fixtureDir, 'codex-home');
  const projectsRoot = path.join(fixtureDir, 'projects');
  const alphaWorkspace = path.join(projectsRoot, 'alpha');
  const betaWorkspace = path.join(projectsRoot, 'beta');
  const agentWorkspacesRoot = path.join(projectsRoot, 'agent-workspaces');
  const extraWorkspaceRoot = path.join(fixtureDir, 'extra-workspace');
  const publicDir = path.join(fixtureDir, 'public');
  const binDir = path.join(fixtureDir, 'blocked-bin');
  const toolLogPath = path.join(fixtureDir, 'external-tools.log');

  for (const directory of [
    codexHome,
    alphaWorkspace,
    betaWorkspace,
    agentWorkspacesRoot,
    extraWorkspaceRoot,
    publicDir,
    binDir
  ]) mkdirSync(directory, { recursive: true });

  copyFileSync(path.join(projectDir, 'server.js'), path.join(fixtureDir, 'server.js'));
  copyFileSync(path.join(projectDir, 'process-runner.js'), path.join(fixtureDir, 'process-runner.js'));
  copyFileSync(path.join(projectDir, 'test', 'services.fixture.json'), path.join(fixtureDir, 'services.json'));
  writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>Mission Queue Test</title>\n');
  writeFileSync(path.join(fixtureDir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(path.join(codexHome, 'models_cache.json'), '{"models":[]}\n');

  // Queue CRUD must remain pure filesystem work. Any accidental host inspection
  // is contained, logged, and fails the test.
  for (const name of ['aws', 'curl', 'ps', 'ss', 'tmux']) installBlockedTool(binDir, name);

  return {
    fixtureDir,
    codexHome,
    projectsRoot,
    alphaWorkspace,
    betaWorkspace,
    agentWorkspacesRoot,
    extraWorkspaceRoot,
    binDir,
    toolLogPath,
    queuePath: path.join(fixtureDir, 'data', 'mission-queue.json'),
    tmuxInputPath: path.join(fixtureDir, 'tmux-input')
  };
}

async function startServer(fixture, envOverrides = {}) {
  const port = await unusedLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: fixture.fixtureDir,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      CODEX_HOME: fixture.codexHome,
      PATH: `${fixture.binDir}:${process.env.PATH || ''}`,
      ORCH_TOOL_LOG: fixture.toolLogPath,
      ORCHESTRATOR_PROJECTS_ROOT: fixture.projectsRoot,
      ORCHESTRATOR_AGENT_WORKSPACES_ROOT: fixture.agentWorkspacesRoot,
      ORCHESTRATOR_EXTRA_WORKSPACE_ROOTS: fixture.extraWorkspaceRoot,
      MISSION_FAKE_WORKSPACE: fixture.alphaWorkspace,
      MISSION_QUEUE_PATH: fixture.queuePath,
      MISSION_TMUX_STATE_PATH: path.join(fixture.fixtureDir, 'tmux-state'),
      MISSION_TMUX_INPUT_PATH: path.join(fixture.fixtureDir, 'tmux-input'),
      MISSION_TMUX_RENDER_COUNT_PATH: path.join(fixture.fixtureDir, 'tmux-render-count'),
      MISSION_TMUX_CONFIRM_COUNT_PATH: path.join(fixture.fixtureDir, 'tmux-confirm-count'),
      MISSION_LITERAL_CONFIRM_MS: '400',
      MISSION_SUBMIT_CONFIRM_MS: '500',
      MISSION_CONFIRM_SAMPLE_MS: '20',
      ORCH_CONTROL_PLANE_MODE: 'foreground',
      SNAPSHOT_EVENT_MS: '3600000',
      SSH_RESCUE_MONITOR_MS: '3600000',
      ...envOverrides
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const rawRequest = async (pathname, options = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      return await fetch(`${baseUrl}${pathname}`, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const deadline = Date.now() + 10000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`isolated server exited early (${child.exitCode ?? child.signalCode})\n${output}`);
    }
    try {
      const response = await rawRequest('/healthz');
      if (response.status === 200) {
        ready = true;
        break;
      }
    } catch {
      // The child may still be binding its loopback listener.
    }
    await delay(50);
  }
  if (!ready) {
    throw new Error(`isolated server did not become ready\n${output}`);
  }

  const index = await rawRequest('/');
  const cookie = (index.headers.get('set-cookie') || '').split(';', 1)[0];
  assert.match(cookie, /^host_control_session=/);

  const request = (pathname, body) => rawRequest(pathname, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  return {
    child,
    request,
    cookie,
    postWithCookie(pathname, body, cookieOverride = '') {
      return rawRequest(pathname, {
        method: 'POST',
        headers: { cookie: cookieOverride, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
    },
    get(pathname, { authenticated = true, cookieOverride = null } = {}) {
      const requestCookie = cookieOverride === null ? (authenticated ? cookie : '') : cookieOverride;
      return rawRequest(pathname, { headers: requestCookie ? { cookie: requestCookie } : {} });
    },
    output: () => output,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await Promise.race([exited, delay(2000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([exited, delay(2000)]);
      }
      assert.equal(
        child.exitCode !== null || child.signalCode !== null,
        true,
        `isolated server did not stop\n${output}`
      );
    }
  };
}

function readQueue(fixture) {
  return JSON.parse(readFileSync(fixture.queuePath, 'utf8'));
}

function toolLog(fixture) {
  return existsSync(fixture.toolLogPath) ? readFileSync(fixture.toolLogPath, 'utf8') : '';
}

async function responseJson(response) {
  return JSON.parse(await response.text());
}

function missionBody(workspace, overrides = {}) {
  return {
    title: 'Ship a durable queue slice',
    goal: 'Implement the requested queue behavior and leave focused validation evidence.',
    verificationCriteria: 'Focused tests pass and the durable record contains the expected state.',
    priority: 'normal',
    workspace,
    ...overrides
  };
}

function adoptionBody(expectedRevision, overrides = {}) {
  return {
    expectedRevision,
    confirm: 'adopt-existing',
    session: 'codex-worker',
    sessionCreatedAt: '2023-11-14T22:13:20.000Z',
    paneId: 'codex-worker:0.0',
    tmuxPaneId: '%77',
    panePid: 4100,
    ...overrides
  };
}

test('a ready mission persists across restart without automatic dispatch', async () => {
  const fixture = createFixture();
  let server;
  try {
    server = await startServer(fixture);
    const createdResponse = await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace));
    assert.equal(createdResponse.status, 200);
    const created = await responseJson(createdResponse);
    assert.equal(created.ok, true);
    assert.equal(created.job.status, 'ready');
    assert.equal(created.job.revision, 1);
    assert.equal(created.job.assignedSession, '');
    assert.equal(created.job.activeAttempt, null);

    await delay(200);
    const beforeRestart = readQueue(fixture);
    assert.equal(beforeRestart.version, 1);
    assert.equal(beforeRestart.revision, 1);
    assert.equal(beforeRestart.jobs.length, 1);
    assert.equal(beforeRestart.jobs[0].id, created.job.id);
    assert.equal(beforeRestart.jobs[0].status, 'ready');
    assert.equal(beforeRestart.events.at(-1)?.kind, 'mission.created');
    assert.equal(statSync(fixture.queuePath).mode & 0o777, 0o600);
    assert.equal(existsSync(`${fixture.queuePath}.tmp`), false);
    assert.equal(toolLog(fixture), '');

    await server.stop();
    server = await startServer(fixture);
    const transitionedResponse = await server.request(
      `/api/missions/${created.job.id}/transition`,
      { expectedRevision: 1, to: 'backlog' }
    );
    assert.equal(transitionedResponse.status, 200);
    const transitioned = await responseJson(transitionedResponse);
    assert.equal(transitioned.job.status, 'backlog');
    assert.equal(transitioned.job.revision, 2);

    const afterRestart = readQueue(fixture);
    assert.equal(afterRestart.jobs.length, 1);
    assert.equal(afterRestart.jobs[0].status, 'backlog');
    assert.deepEqual(afterRestart.events.map((event) => event.kind), [
      'mission.created',
      'mission.backlog'
    ]);
    assert.equal(toolLog(fixture), '');
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('moving queued missions is durable and rejects stale revisions without mutation', async () => {
  const fixture = createFixture();
  let server;
  try {
    server = await startServer(fixture);
    const firstResponse = await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
      title: 'First mission'
    }));
    const secondResponse = await server.request('/api/missions/create', missionBody(fixture.betaWorkspace, {
      title: 'Second mission'
    }));
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    const first = (await responseJson(firstResponse)).job;
    const second = (await responseJson(secondResponse)).job;

    let queue = readQueue(fixture);
    assert.deepEqual(queue.jobs.map((job) => [job.title, job.position, job.revision]), [
      ['First mission', 1, 1],
      ['Second mission', 2, 1]
    ]);

    const movedResponse = await server.request(`/api/missions/${second.id}/move`, {
      expectedRevision: second.revision,
      direction: 'up'
    });
    assert.equal(movedResponse.status, 200);
    const moved = await responseJson(movedResponse);
    assert.equal(moved.job.id, second.id);
    assert.equal(moved.job.position, 1);
    assert.equal(moved.job.revision, 2);

    queue = readQueue(fixture);
    const ordered = [...queue.jobs].sort((left, right) => left.position - right.position);
    assert.deepEqual(ordered.map((job) => [job.title, job.position, job.revision]), [
      ['Second mission', 1, 2],
      ['First mission', 2, 2]
    ]);
    assert.equal(queue.revision, 3);
    const durableBeforeConflict = readFileSync(fixture.queuePath, 'utf8');

    const staleResponse = await server.request(`/api/missions/${second.id}/move`, {
      expectedRevision: second.revision,
      direction: 'down'
    });
    assert.equal(staleResponse.status, 409);
    const stale = await responseJson(staleResponse);
    assert.equal(stale.error, 'mission_revision_conflict');
    assert.equal(stale.job.id, second.id);
    assert.equal(stale.job.revision, 2);
    assert.equal(readFileSync(fixture.queuePath, 'utf8'), durableBeforeConflict);
    assert.equal(toolLog(fixture), '');
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('Today separates dispatchable Ready work from held Backlog work', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const firstReady = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
      title: 'Ready first'
    })))).job;
    const later = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.betaWorkspace, {
      title: 'Held for later',
      status: 'backlog'
    })))).job;
    const secondReady = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.betaWorkspace, {
      title: 'Ready second'
    })))).job;

    const snapshot = await responseJson(await server.get('/api/snapshot'));
    assert.equal(snapshot.missions.counts.upNext, 2);
    assert.equal(snapshot.missions.counts.ready, 2);
    assert.equal(snapshot.missions.counts.backlog, 1);
    assert.equal(snapshot.missions.counts.queued, 3);
    assert.deepEqual(
      snapshot.missions.jobs.filter((job) => job.status === 'ready').map((job) => job.id),
      [firstReady.id, secondReady.id]
    );
    assert.deepEqual(
      snapshot.missions.jobs.filter((job) => job.status === 'backlog').map((job) => job.id),
      [later.id]
    );

    const movedResponse = await server.request(`/api/missions/${firstReady.id}/move`, {
      expectedRevision: firstReady.revision,
      direction: 'down'
    });
    assert.equal(movedResponse.status, 200);
    const queue = readQueue(fixture);
    assert.deepEqual(
      queue.jobs.filter((job) => job.status === 'ready').sort((left, right) => left.position - right.position).map((job) => job.id),
      [secondReady.id, firstReady.id]
    );
    assert.equal(queue.jobs.find((job) => job.id === later.id).position, 2);

    const appSource = readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
    assert.match(appSource, /const upNext = jobs\.filter\(\(job\) => job\.status === 'ready'\)/);
    assert.match(appSource, /const later = jobs\.filter\(\(job\) => job\.status === 'backlog'\)/);
    assert.match(appSource, /missionLane\('Up Next',[\s\S]*missionLane\('Later'/);
    assert.equal(toolLog(fixture).split('\n').some((line) => line.startsWith('tmux:send-')), false);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('mission creation validates workspace and sensitive text before persistence', async () => {
  const fixture = createFixture();
  let server;
  try {
    server = await startServer(fixture);
    const outsideResponse = await server.request('/api/missions/create', missionBody(os.tmpdir()));
    assert.equal(outsideResponse.status, 400);
    assert.deepEqual(await responseJson(outsideResponse), { error: 'invalid_workspace' });

    const sensitiveName = ['OPENAI', 'API', 'KEY'].join('_');
    const sensitiveValue = ['definitely', 'not', 'a', 'real', 'value'].join('-');
    const sensitiveResponse = await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
      goal: `Use ${sensitiveName}=${sensitiveValue} to finish the task.`
    }));
    assert.equal(sensitiveResponse.status, 400);
    assert.deepEqual(await responseJson(sensitiveResponse), { error: 'mission_sensitive_content_not_allowed' });

    const queue = readQueue(fixture);
    assert.equal(queue.revision, 0);
    assert.deepEqual(queue.jobs, []);
    assert.deepEqual(queue.events, []);
    assert.equal(toolLog(fixture), '');
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('dispatch claims durably, then sends literal text and Enter to one idle existing worker', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const createdResponse = await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
      title: 'Dispatch through the safe terminal path'
    }));
    assert.equal(createdResponse.status, 200);
    const created = (await responseJson(createdResponse)).job;

    const dispatchResponse = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    const dispatched = await responseJson(dispatchResponse);
    assert.equal(dispatchResponse.status, 200, JSON.stringify(dispatched));
    assert.equal(dispatched.ok, true);
    assert.equal(dispatched.session, 'codex-worker');
    assert.equal(dispatched.job.status, 'running');
    assert.equal(dispatched.job.revision, 3);
    assert.equal(dispatched.job.assignedSession, 'codex-worker');
    assert.equal(dispatched.job.assignedSessionCreatedAt, '2023-11-14T22:13:20.000Z');
    assert.equal(dispatched.job.assignedPaneId, 'codex-worker:0.0');
    assert.equal(dispatched.job.assignedTmuxPaneId, '%77');
    assert.equal(dispatched.job.assignedPanePid, 4100);

    const queue = readQueue(fixture);
    const job = queue.jobs.find((item) => item.id === created.id);
    assert.equal(job.status, 'running');
    assert.equal(job.activeAttempt.status, 'running');
    assert.equal(job.activeAttempt.session, 'codex-worker');
    assert.equal(job.activeAttempt.tmuxPaneId, '%77');
    assert.equal(job.activeAttempt.panePid, 4100);
    assert.equal(job.activeAttempt.confirmationMarker, `[Host Control Dispatch ${job.activeAttempt.id}]`);
    assert.match(job.activeAttempt.submittedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(queue.events.map((event) => event.kind), [
      'mission.created',
      'mission.dispatching',
      'mission.running'
    ]);

    const operations = toolLog(fixture).trim().split('\n');
    assert.equal(operations.some((operation) => operation.includes('unexpected')), false);
    assert.equal(operations.includes('aws'), false);
    assert.equal(operations.includes('curl'), false);
    const literalOperations = operations.filter((operation) => operation.startsWith('tmux:send-literal:'));
    const enterOperations = operations.filter((operation) => operation === 'tmux:send-enter:C-m');
    assert.equal(literalOperations.length, 1);
    assert.equal(enterOperations.length, 1);
    assert.equal(operations.includes('tmux:send-target:%77:-l'), true);
    assert.equal(operations.includes('tmux:send-target:%77:C-m'), true);
    assert.ok(operations.indexOf(literalOperations[0]) < operations.indexOf('tmux:send-enter:C-m'));
    assert.ok(operations.filter((operation) => operation === 'tmux:capture').length >= 5);
    const literalOperation = operations.find((operation) => operation.startsWith('tmux:send-literal:'));
    assert.ok(Number(literalOperation?.split(':').at(-1)) > 0);

    const beforeUnlinkedInput = toolLog(fixture);
    const unlinkedInput = await server.request('/api/agent/send', {
      session: 'codex-worker',
      text: 'Continue with an unrelated task.'
    });
    assert.equal(unlinkedInput.status, 409);
    assert.equal((await responseJson(unlinkedInput)).error, 'mission_context_required');
    assert.equal(toolLog(fixture), beforeUnlinkedInput);

    const linkedInput = await server.request('/api/agent/send', {
      session: 'codex-worker',
      text: 'Continue this mission with the requested validation.',
      missionId: created.id
    });
    assert.equal(linkedInput.status, 200);
    assert.equal((await responseJson(linkedInput)).missionId, created.id);

    const unconfirmedRelease = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: dispatched.job.revision,
      to: 'canceled',
      note: 'Canceled by operator.'
    });
    assert.equal(unconfirmedRelease.status, 400);
    assert.equal((await responseJson(unconfirmedRelease)).error, 'mission_lock_release_confirmation_required');

    const confirmedRelease = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: dispatched.job.revision,
      to: 'canceled',
      note: 'Canceled by operator.',
      confirm: 'inspected-release'
    });
    assert.equal(confirmedRelease.status, 200);
    const canceled = (await responseJson(confirmedRelease)).job;
    assert.equal(canceled.status, 'canceled');

    const requeuedResponse = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: canceled.revision,
      to: 'ready'
    });
    assert.equal(requeuedResponse.status, 200);
    const requeued = (await responseJson(requeuedResponse)).job;
    assert.equal(requeued.status, 'ready');
    assert.equal(requeued.activeAttempt, null);
    assert.equal(requeued.attempts.length, 1);
    assert.equal(requeued.attempts[0].status, 'canceled');
    assert.match(requeued.attempts[0].finishedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(requeued.outcomes.map((outcome) => outcome.status), ['canceled']);
    assert.equal(requeued.outcomes[0].note, 'Canceled by operator.');
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('long mission prompts are typed in bounded literal chunks before one Enter', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { MISSION_MAX_LITERAL_CHUNK: '384' });
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
      title: 'Dispatch a long mission without dropping terminal input',
      goal: `Implement and verify the bounded terminal delivery path. ${'evidence '.repeat(190)}`
    })))).job;

    const response = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    const result = await responseJson(response);
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.job.status, 'running');

    const operations = toolLog(fixture).trim().split('\n');
    const literalOperations = operations.filter((operation) => operation.startsWith('tmux:send-literal:'));
    assert.ok(literalOperations.length > 1);
    assert.equal(literalOperations.every((operation) => Number(operation.split(':').at(-1)) <= 384), true);
    assert.equal(operations.some((operation) => operation.startsWith('tmux:oversized-literal:')), false);
    assert.equal(operations.filter((operation) => operation === 'tmux:send-enter:C-m').length, 1);
    assert.ok(operations.indexOf('tmux:send-enter:C-m') > operations.lastIndexOf(literalOperations.at(-1)));

    const renderedInput = readFileSync(fixture.tmuxInputPath, 'utf8');
    assert.match(renderedInput, new RegExp(`^\\[Host Control Mission ${created.id}\\]`));
    assert.match(renderedInput, /Dispatch a long mission without dropping terminal input/);
    assert.match(renderedInput, new RegExp(`\\[Host Control Dispatch ${readQueue(fixture).jobs[0].activeAttempt.id}\\]$`));
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('Ready work can adopt an exact live Codex pane without terminal input', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
      title: 'Adopt work already underway'
    })))).job;
    const sendsBefore = toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-')).length;

    const response = await server.request(`/api/missions/${created.id}/adopt`, adoptionBody(created.revision));
    const result = await responseJson(response);
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.job.status, 'running');
    assert.equal(result.job.worker.identityMatches, true);
    assert.equal(result.job.assignedSession, 'codex-worker');
    assert.equal(result.job.assignedSessionCreatedAt, '2023-11-14T22:13:20.000Z');
    assert.equal(result.job.assignedPaneId, 'codex-worker:0.0');
    assert.equal(result.job.assignedTmuxPaneId, '%77');
    assert.equal(result.job.assignedPanePid, 4100);

    const queue = readQueue(fixture);
    const job = queue.jobs[0];
    assert.equal(job.attempts.length, 1);
    assert.equal(job.activeAttempt.kind, 'adoption');
    assert.equal(job.activeAttempt.status, 'running_adopted');
    assert.equal(job.activeAttempt.promptChars, 0);
    assert.equal(job.activeAttempt.submittedAt, null);
    assert.equal('confirmationMarker' in job.activeAttempt, false);
    assert.deepEqual(queue.events.map((event) => event.kind), ['mission.created', 'mission.adopted']);
    assert.match(queue.events.at(-1).detail, /no_prompt=true; no_resend=true/);
    assert.equal(
      toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-')).length,
      sendsBefore
    );
    const audit = readFileSync(path.join(fixture.fixtureDir, 'data', 'actions.jsonl'), 'utf8');
    assert.match(audit, /"action":"mission\.adopt"/);
    assert.match(audit, /no_input=true; no_prompt=true; no_resend=true/);

    const appSource = readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
    assert.match(appSource, /data-action="mission-adopt"/);
    assert.match(appSource, /confirm: 'adopt-existing'/);
    assert.match(appSource, /It will not send a prompt, Enter, or any terminal input/);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('Needs You adoption preserves the lost attempt and replaces it with a no-resend attempt', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
    await server.stop();
    server = null;
    const queueBeforeAdoption = readQueue(fixture);
    const lostJob = queueBeforeAdoption.jobs[0];
    const originalAttemptId = 'attempt-lostworker-12345678';
    const lostAttempt = {
      id: originalAttemptId,
      status: 'needs_you',
      session: 'codex-lost',
      sessionCreatedAt: '2023-11-14T22:13:19.000Z',
      paneId: 'codex-lost:0.0',
      tmuxPaneId: '%70',
      panePid: 4000,
      confirmationMarker: `[Host Control Dispatch ${originalAttemptId}]`,
      promptChars: 400,
      claimedAt: '2026-07-13T12:00:00.000Z',
      submittedAt: '2026-07-13T12:00:01.000Z',
      finishedAt: null
    };
    lostJob.status = 'needs_you';
    lostJob.revision += 1;
    lostJob.updatedAt = '2026-07-13T12:05:00.000Z';
    lostJob.startedAt = '2026-07-13T12:00:01.000Z';
    lostJob.needsYouAt = '2026-07-13T12:05:00.000Z';
    lostJob.assignedSession = lostAttempt.session;
    lostJob.assignedSessionCreatedAt = lostAttempt.sessionCreatedAt;
    lostJob.assignedPaneId = lostAttempt.paneId;
    lostJob.assignedTmuxPaneId = lostAttempt.tmuxPaneId;
    lostJob.assignedPanePid = lostAttempt.panePid;
    lostJob.activeAttempt = { ...lostAttempt };
    lostJob.attempts = [{ ...lostAttempt }];
    lostJob.blocker = 'The original worker identity was lost.';
    queueBeforeAdoption.revision += 1;
    writeFileSync(fixture.queuePath, `${JSON.stringify(queueBeforeAdoption, null, 2)}\n`, { mode: 0o600 });

    server = await startServer(fixture);
    const sendsBefore = toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-')).length;
    const response = await server.request(`/api/missions/${created.id}/adopt`, adoptionBody(lostJob.revision));
    const result = await responseJson(response);
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.job.status, 'running');

    const job = readQueue(fixture).jobs[0];
    assert.equal(job.attempts.length, 2);
    assert.equal(job.attempts[0].id, originalAttemptId);
    assert.equal(job.attempts[0].status, 'superseded_by_adoption');
    assert.match(job.attempts[0].finishedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.notEqual(job.activeAttempt.id, originalAttemptId);
    assert.equal(job.activeAttempt.kind, 'adoption');
    assert.equal(job.activeAttempt.promptChars, 0);
    assert.equal(
      toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-')).length,
      sendsBefore
    );
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('adoption fails closed for missing confirmation, stale identity, stopped workers, workspace mismatch, and worker locks', async (t) => {
  await t.test('confirmation, revision, and state are explicit', async () => {
    const fixture = createFixture();
    installDispatchTools(fixture);
    let server;
    try {
      server = await startServer(fixture);
      const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
      const before = readFileSync(fixture.queuePath, 'utf8');
      const unconfirmed = await server.request(`/api/missions/${created.id}/adopt`, adoptionBody(created.revision, { confirm: '' }));
      assert.equal(unconfirmed.status, 400);
      assert.equal((await responseJson(unconfirmed)).error, 'mission_adoption_confirmation_required');
      const stale = await server.request(`/api/missions/${created.id}/adopt`, adoptionBody(0));
      assert.equal(stale.status, 409);
      assert.equal((await responseJson(stale)).error, 'mission_revision_conflict');
      assert.equal(readFileSync(fixture.queuePath, 'utf8'), before);

      const backlog = (await responseJson(await server.request(`/api/missions/${created.id}/transition`, {
        expectedRevision: created.revision,
        to: 'backlog'
      }))).job;
      const wrongState = await server.request(`/api/missions/${created.id}/adopt`, adoptionBody(backlog.revision));
      assert.equal(wrongState.status, 409);
      assert.equal((await responseJson(wrongState)).error, 'mission_not_adoptable');
      assert.equal(toolLog(fixture).split('\n').some((line) => line.startsWith('tmux:send-')), false);
    } finally {
      if (server) await server.stop();
      rmSync(fixture.fixtureDir, { recursive: true, force: true });
    }
  });

  for (const testCase of [
    {
      name: 'missing pane',
      env: {},
      body: { session: 'codex-missing', paneId: 'codex-missing:0.0' },
      error: 'mission_worker_missing_or_replaced'
    },
    {
      name: 'replacement identity',
      env: { MISSION_SESSION_CREATED: '1700000001' },
      body: {},
      error: 'mission_worker_missing_or_replaced'
    },
    {
      name: 'stopped Codex process',
      env: { MISSION_NO_CODEX_PROCESS: '1' },
      body: {},
      error: 'mission_worker_stopped'
    },
    {
      name: 'workspace mismatch',
      env: {},
      body: {},
      error: 'mission_worker_workspace_mismatch',
      workerWorkspace: 'beta'
    }
  ]) {
    await t.test(testCase.name, async () => {
      const fixture = createFixture();
      installDispatchTools(fixture);
      let server;
      try {
        const env = { ...testCase.env };
        if (testCase.workerWorkspace) env.MISSION_FAKE_WORKSPACE = fixture.betaWorkspace;
        server = await startServer(fixture, env);
        const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
        const before = readFileSync(fixture.queuePath, 'utf8');
        const response = await server.request(`/api/missions/${created.id}/adopt`, adoptionBody(created.revision, testCase.body));
        assert.equal(response.status, 409);
        assert.equal((await responseJson(response)).error, testCase.error);
        assert.equal(readFileSync(fixture.queuePath, 'utf8'), before);
        assert.equal(toolLog(fixture).split('\n').some((line) => line.startsWith('tmux:send-')), false);
      } finally {
        if (server) await server.stop();
        rmSync(fixture.fixtureDir, { recursive: true, force: true });
      }
    });
  }

  await t.test('worker already locked by another mission', async () => {
    const fixture = createFixture();
    installDispatchTools(fixture);
    let server;
    try {
      server = await startServer(fixture);
      const owner = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
        title: 'Current worker owner'
      })))).job;
      const adoptedOwner = await server.request(`/api/missions/${owner.id}/adopt`, adoptionBody(owner.revision));
      assert.equal(adoptedOwner.status, 200);
      const contender = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.betaWorkspace, {
        title: 'Conflicting worker claim'
      })))).job;
      const response = await server.request(`/api/missions/${contender.id}/adopt`, adoptionBody(contender.revision));
      assert.equal(response.status, 409);
      assert.equal((await responseJson(response)).error, 'mission_worker_locked');
      assert.equal(toolLog(fixture).split('\n').some((line) => line.startsWith('tmux:send-')), false);
    } finally {
      if (server) await server.stop();
      rmSync(fixture.fixtureDir, { recursive: true, force: true });
    }
  });
});

test('dispatch failure stages never auto-retry uncertain terminal input', async () => {
  for (const failure of ['literal', 'enter']) {
    const fixture = createFixture();
    installDispatchTools(fixture);
    let server;
    try {
      server = await startServer(fixture, { MISSION_TMUX_FAILURE: failure });
      const createdResponse = await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
        title: `Exercise ${failure} dispatch failure`
      }));
      assert.equal(createdResponse.status, 200);
      const created = (await responseJson(createdResponse)).job;

      const dispatchResponse = await server.request(`/api/missions/${created.id}/dispatch`, {
        expectedRevision: created.revision,
        session: 'codex-worker'
      });
      const result = await responseJson(dispatchResponse);
      const operations = toolLog(fixture).trim().split('\n');
      const literalSends = operations.filter((operation) => operation.startsWith('tmux:send-literal:')).length;
      const enterSends = operations.filter((operation) => operation === 'tmux:send-enter:C-m').length;
      assert.equal(literalSends, 1);

      if (failure === 'literal') {
        assert.equal(dispatchResponse.status, 409);
        assert.equal(result.stage, 'literal_unknown');
        assert.equal(result.job.status, 'reconcile_required');
        assert.equal(enterSends, 0);
        assert.equal(readQueue(fixture).jobs[0].activeAttempt.status, 'outcome_unknown');
      } else {
        assert.equal(dispatchResponse.status, 409);
        assert.equal(result.stage, 'submit');
        assert.equal(result.job.status, 'reconcile_required');
        assert.equal(enterSends, 1);
        assert.equal(readQueue(fixture).jobs[0].activeAttempt.status, 'outcome_unknown');

        const logBeforeRestart = toolLog(fixture);
        await server.stop();
        server = await startServer(fixture);
        assert.equal(readQueue(fixture).jobs[0].status, 'reconcile_required');
        assert.equal(toolLog(fixture), logBeforeRestart);
        const reconcileRevision = readQueue(fixture).jobs[0].revision;

        const unconfirmedReady = await server.request(`/api/missions/${created.id}/transition`, {
          expectedRevision: reconcileRevision,
          to: 'ready'
        });
        assert.equal(unconfirmedReady.status, 400);
        assert.equal((await responseJson(unconfirmedReady)).error, 'mission_lock_release_confirmation_required');

        const unconfirmedRunning = await server.request(`/api/missions/${created.id}/transition`, {
          expectedRevision: reconcileRevision,
          to: 'running'
        });
        assert.equal(unconfirmedRunning.status, 400);
        assert.equal((await responseJson(unconfirmedRunning)).error, 'reconcile_confirmation_required');

        const confirmedReady = await server.request(`/api/missions/${created.id}/transition`, {
          expectedRevision: reconcileRevision,
          to: 'ready',
          confirm: 'inspected-release'
        });
        assert.equal(confirmedReady.status, 200);
        assert.equal((await responseJson(confirmedReady)).job.status, 'ready');
        assert.equal(toolLog(fixture), logBeforeRestart);
      }
    } finally {
      if (server) await server.stop();
      rmSync(fixture.fixtureDir, { recursive: true, force: true });
    }
  }
});

test('a successful tmux Enter is not Running until Codex visibly accepts it', async (t) => {
  const cases = [
    { name: 'ignored Enter', behavior: 'ignored', expectedError: 'terminal_submit_unconfirmed' },
    { name: 'one transient working sample', behavior: 'transient', expectedError: 'terminal_submit_unconfirmed' },
    { name: 'capture failure after Enter', behavior: 'capture-failure', expectedError: 'terminal_confirmation_capture_failed' },
    { name: 'pane replacement after Enter', behavior: 'replacement', expectedError: 'mission_worker_identity_changed' },
    { name: 'idle composer after Enter', behavior: 'idle-placeholder', expectedError: 'terminal_submit_unconfirmed' },
    { name: 'stale working text before the marker', behavior: 'ignored', staleWorking: '1', expectedError: 'terminal_submit_unconfirmed' }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fixture = createFixture();
      installDispatchTools(fixture);
      let server;
      try {
        server = await startServer(fixture, {
          MISSION_SUBMIT_BEHAVIOR: testCase.behavior,
          MISSION_STALE_WORKING: testCase.staleWorking || ''
        });
        const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
        const response = await server.request(`/api/missions/${created.id}/dispatch`, {
          expectedRevision: created.revision,
          session: 'codex-worker'
        });
        const result = await responseJson(response);
        assert.equal(response.status, 409);
        assert.equal(result.stage, 'confirmation');
        assert.equal(result.error, testCase.expectedError);
        assert.equal(result.job.status, 'reconcile_required');
        assert.equal(result.job.activeAttempt.status, 'outcome_unknown');
        assert.equal(result.job.activeAttempt.submittedAt, null);

        const operations = toolLog(fixture).trim().split('\n');
        assert.equal(operations.filter((operation) => operation.startsWith('tmux:send-literal:')).length, 1);
        assert.equal(operations.filter((operation) => operation === 'tmux:send-enter:C-m').length, 1);
      } finally {
        if (server) await server.stop();
        rmSync(fixture.fixtureDir, { recursive: true, force: true });
      }
    });
  }
});

test('dispatch waits for complete literal rendering and never sends Enter when rendering is uncertain', async () => {
  for (const visibleAfter of ['3', '99']) {
    const fixture = createFixture();
    installDispatchTools(fixture);
    let server;
    try {
      server = await startServer(fixture, {
        MISSION_LITERAL_VISIBLE_AFTER: visibleAfter,
        ...(visibleAfter === '3' ? {
          MISSION_LITERAL_CONFIRM_MS: '2000',
          MISSION_SUBMIT_CONFIRM_MS: '2000'
        } : {})
      });
      const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
      const response = await server.request(`/api/missions/${created.id}/dispatch`, {
        expectedRevision: created.revision,
        session: 'codex-worker'
      });
      const result = await responseJson(response);
      const operations = toolLog(fixture).trim().split('\n');
      const literalIndex = operations.findIndex((operation) => operation.startsWith('tmux:send-literal:'));
      const enterIndex = operations.indexOf('tmux:send-enter:C-m');
      assert.ok(literalIndex >= 0);
      if (visibleAfter === '3') {
        assert.equal(response.status, 200, JSON.stringify(result));
        assert.equal(result.job.status, 'running');
        assert.ok(enterIndex > literalIndex);
        assert.ok(operations.slice(literalIndex, enterIndex).filter((operation) => operation === 'tmux:capture').length >= 4);
      } else {
        assert.equal(response.status, 409);
        assert.equal(result.stage, 'literal_confirmation');
        assert.equal(result.job.status, 'reconcile_required');
        assert.equal(enterIndex, -1);
      }
      assert.equal(operations.filter((operation) => operation.startsWith('tmux:send-literal:')).length, 1);
      assert.ok(operations.filter((operation) => operation === 'tmux:send-enter:C-m').length <= 1);
    } finally {
      if (server) await server.stop();
      rmSync(fixture.fixtureDir, { recursive: true, force: true });
    }
  }
});

test('a fast completed response after the unique dispatch marker confirms submission', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { MISSION_SUBMIT_BEHAVIOR: 'complete' });
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
    const response = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    const result = await responseJson(response);
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.job.status, 'running');
    const operations = toolLog(fixture).trim().split('\n');
    assert.equal(operations.filter((operation) => operation.startsWith('tmux:send-literal:')).length, 1);
    assert.equal(operations.filter((operation) => operation === 'tmux:send-enter:C-m').length, 1);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('Mission Supervisor requires stable report samples and moves completion only to Verifying', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
    const dispatchResponse = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    assert.equal(dispatchResponse.status, 200);
    const running = (await responseJson(dispatchResponse)).job;
    assert.equal(running.status, 'running');
    const prompt = readFileSync(path.join(fixture.fixtureDir, 'tmux-input'), 'utf8');
    const sendCountBefore = toolLog(fixture).split('\n').filter((line) => /^tmux:send-(?:literal|enter):/.test(line)).length;

    await server.stop();
    server = await startServer(fixture, {
      MISSION_SUPERVISOR_MIN_DELAY_MS: '20',
      MISSION_CAPTURE_OUTPUT: [
        `› ${prompt}`,
        'STATUS: complete',
        'RESULT: unified attention work completed',
        'EVIDENCE: focused supervisor tests passed',
        'NEXT ACTION: verify independently',
        '› ',
        'gpt-test-alpha ultra · 95% left'
      ].join('\n')
    });

    const firstSnapshot = await responseJson(await server.get('/api/snapshot'));
    const firstSample = firstSnapshot.missions.jobs.find((job) => job.id === created.id);
    assert.equal(firstSample.status, 'running');
    assert.equal(firstSample.worker.identityMatches, true);
    await delay(30);
    const secondSnapshot = await responseJson(await server.get('/api/snapshot'));
    const verifying = secondSnapshot.missions.jobs.find((job) => job.id === created.id);
    assert.equal(verifying.status, 'verifying');
    assert.equal(verifying.status === 'done', false);
    assert.equal(verifying.finishedAt, null);
    assert.deepEqual(verifying.outcomes, []);
    assert.equal(verifying.activeAttempt.status, 'verifying');
    assert.equal(verifying.verification.status, 'pending');
    assert.equal(verifying.verification.note, 'focused supervisor tests passed');
    assert.match(verifying.resultSummary, /unified attention work completed/);
    assert.equal(
      secondSnapshot.notifications.items.find((item) => item.missionId === created.id)?.kind,
      'verification_ready'
    );

    const queue = readQueue(fixture);
    const event = queue.events.at(-1);
    assert.equal(event.kind, 'mission.verifying');
    assert.equal(event.from, 'running');
    assert.equal(event.to, 'verifying');
    assert.match(event.detail, /^source=supervisor; supervisor=verification_ready$/);
    const sendCountAfter = toolLog(fixture).split('\n').filter((line) => /^tmux:send-(?:literal|enter):/.test(line)).length;
    assert.equal(sendCountAfter, sendCountBefore);
    assert.equal(toolLog(fixture).includes('tmux:unexpected:'), false);
    assert.equal(toolLog(fixture).split('\n').some((line) => ['aws', 'curl'].includes(line)), false);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('Mission Supervisor routes stable waiting, error, stale, and identity failures to Needs You without input', async (t) => {
  const cases = [
    {
      name: 'waiting report',
      reason: 'waiting',
      output(prompt) {
        return [
          `› ${prompt}`,
          'STATUS: waiting for approval',
          'RESULT: implementation is paused',
          'EVIDENCE: the approval boundary was reached',
          'NEXT ACTION: needs input from the operator'
        ].join('\n');
      }
    },
    {
      name: 'error report',
      reason: 'error',
      output(prompt) {
        return [
          `› ${prompt}`,
          'STATUS: failed',
          'RESULT: focused validation failed',
          'EVIDENCE: the test command returned an error',
          'NEXT ACTION: inspect the failure'
        ].join('\n');
      }
    },
    {
      name: 'idle without report',
      reason: 'idle',
      idleStaleMs: '0',
      output(prompt) {
        return [`› ${prompt}`, '› Ask Codex anything', 'gpt-test-alpha ultra · 95% left'].join('\n');
      }
    },
    {
      name: 'recycled session creation',
      reason: 'replaced',
      sessionCreated: '1700000001'
    },
    {
      name: 'replaced intrinsic pane',
      reason: 'replaced',
      submitBehavior: 'replacement'
    },
    {
      name: 'missing assigned coordinate',
      reason: 'missing',
      mutateQueue(queue) {
        const job = queue.jobs[0];
        job.assignedPaneId = 'codex-worker:9.9';
        job.activeAttempt.paneId = job.assignedPaneId;
        const attempt = job.attempts.find((item) => item.id === job.activeAttempt.id);
        attempt.paneId = job.assignedPaneId;
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fixture = createFixture();
      installDispatchTools(fixture);
      let server;
      try {
        server = await startServer(fixture);
        const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
        const dispatchResponse = await server.request(`/api/missions/${created.id}/dispatch`, {
          expectedRevision: created.revision,
          session: 'codex-worker'
        });
        assert.equal(dispatchResponse.status, 200);
        const prompt = readFileSync(path.join(fixture.fixtureDir, 'tmux-input'), 'utf8');
        const sendCountBefore = toolLog(fixture).split('\n').filter((line) => /^tmux:send-(?:literal|enter):/.test(line)).length;
        await server.stop();
        server = null;

        if (testCase.mutateQueue) {
          const queue = readQueue(fixture);
          testCase.mutateQueue(queue);
          writeFileSync(fixture.queuePath, `${JSON.stringify(queue, null, 2)}\n`, { mode: 0o600 });
        }
        server = await startServer(fixture, {
          MISSION_SUPERVISOR_MIN_DELAY_MS: '20',
          MISSION_SUPERVISOR_IDLE_STALE_MS: testCase.idleStaleMs || '120000',
          MISSION_CAPTURE_OUTPUT: testCase.output ? testCase.output(prompt) : '',
          MISSION_SESSION_CREATED: testCase.sessionCreated || '1700000000',
          MISSION_SUBMIT_BEHAVIOR: testCase.submitBehavior || ''
        });

        const firstSnapshot = await responseJson(await server.get('/api/snapshot'));
        const firstSample = firstSnapshot.missions.jobs.find((job) => job.id === created.id);
        assert.equal(firstSample.status, 'running');
        assert.equal(
          firstSample.worker.identityMatches,
          !['replaced', 'missing'].includes(testCase.reason)
        );
        await delay(30);
        const secondSnapshot = await responseJson(await server.get('/api/snapshot'));
        const needsYou = secondSnapshot.missions.jobs.find((job) => job.id === created.id);
        assert.equal(needsYou.status, 'needs_you');
        assert.equal(needsYou.finishedAt, null);
        assert.deepEqual(needsYou.outcomes, []);
        assert.equal(needsYou.activeAttempt.status, 'needs_you');
        assert.ok(needsYou.blocker.startsWith('Mission Supervisor'));

        const event = readQueue(fixture).events.at(-1);
        assert.equal(event.kind, 'mission.needs_you');
        assert.equal(event.from, 'running');
        assert.equal(event.to, 'needs_you');
        assert.equal(event.detail, `source=supervisor; supervisor=${testCase.reason}`);
        const expectedNotificationKind = testCase.reason === 'error'
          ? 'failure'
          : ['idle', 'replaced', 'missing'].includes(testCase.reason) ? 'stale' : 'needs_you';
        const notification = secondSnapshot.notifications.items.find((item) => item.missionId === created.id);
        assert.equal(notification?.kind, expectedNotificationKind);
        const sendCountAfter = toolLog(fixture).split('\n').filter((line) => /^tmux:send-(?:literal|enter):/.test(line)).length;
        assert.equal(sendCountAfter, sendCountBefore);
        assert.equal(toolLog(fixture).includes('tmux:unexpected:'), false);
        assert.equal(toolLog(fixture).split('\n').some((line) => ['aws', 'curl'].includes(line)), false);
      } finally {
        if (server) await server.stop();
        rmSync(fixture.fixtureDir, { recursive: true, force: true });
      }
    });
  }
});

test('Mission Supervisor ignores a completed report that predates the active dispatch marker', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
    const dispatchResponse = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    assert.equal(dispatchResponse.status, 200);
    const prompt = readFileSync(path.join(fixture.fixtureDir, 'tmux-input'), 'utf8');
    await server.stop();
    server = await startServer(fixture, {
      MISSION_SUPERVISOR_MIN_DELAY_MS: '20',
      MISSION_CAPTURE_OUTPUT: [
        'STATUS: complete',
        'RESULT: stale earlier work',
        'EVIDENCE: stale earlier evidence',
        'NEXT ACTION: verify stale result',
        `› ${prompt}`,
        'Working (1s)',
        'esc to interrupt'
      ].join('\n')
    });

    await server.get('/api/snapshot');
    await delay(30);
    const snapshot = await responseJson(await server.get('/api/snapshot'));
    assert.equal(snapshot.missions.jobs.find((job) => job.id === created.id).status, 'running');
    assert.equal(readQueue(fixture).events.some((event) => event.kind === 'mission.verifying'), false);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('restart reconciles a durable dispatch claim without sending terminal input', async () => {
  const fixture = createFixture();
  let server;
  try {
    server = await startServer(fixture);
    const createdResponse = await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace));
    assert.equal(createdResponse.status, 200);
    const created = (await responseJson(createdResponse)).job;
    await server.stop();
    server = null;

    const queue = readQueue(fixture);
    const job = queue.jobs[0];
    const claimedAt = new Date().toISOString();
    const attempt = {
      id: 'attempt-seeded1234',
      status: 'dispatching',
      session: 'codex-worker',
      sessionCreatedAt: '2023-11-14T22:13:20.000Z',
      paneId: 'codex-worker:0.0',
      promptChars: 500,
      claimedAt,
      submittedAt: null,
      finishedAt: null
    };
    job.status = 'dispatching';
    job.revision = created.revision + 1;
    job.updatedAt = claimedAt;
    job.assignedSession = 'codex-worker';
    job.assignedSessionCreatedAt = attempt.sessionCreatedAt;
    job.assignedPaneId = attempt.paneId;
    job.activeAttempt = { ...attempt };
    job.attempts = [{ ...attempt }];
    queue.revision += 1;
    writeFileSync(fixture.queuePath, `${JSON.stringify(queue, null, 2)}\n`, { mode: 0o600 });

    installDispatchTools(fixture);
    server = await startServer(fixture);
    const reconciled = readQueue(fixture);
    assert.equal(reconciled.jobs[0].status, 'reconcile_required');
    assert.equal(reconciled.jobs[0].activeAttempt.status, 'outcome_unknown');
    assert.equal(reconciled.events.at(-1)?.kind, 'mission.reconcile_required');
    assert.equal(toolLog(fixture), '');
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('completion requires the verifying gate and durable evidence', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const createdResponse = await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace));
    const created = (await responseJson(createdResponse)).job;
    const dispatchResponse = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    assert.equal(dispatchResponse.status, 200);
    const running = (await responseJson(dispatchResponse)).job;

    const directDone = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: running.revision,
      to: 'done',
      note: 'This must not bypass verification.'
    });
    assert.equal(directDone.status, 409);
    assert.equal((await responseJson(directDone)).error, 'invalid_mission_transition');

    const verifyingResponse = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: running.revision,
      to: 'verifying'
    });
    assert.equal(verifyingResponse.status, 200);
    const verifying = (await responseJson(verifyingResponse)).job;
    assert.equal(verifying.status, 'verifying');
    const durableBeforeMissingEvidence = readFileSync(fixture.queuePath, 'utf8');

    const missingEvidence = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: verifying.revision,
      to: 'done',
      note: ''
    });
    assert.equal(missingEvidence.status, 400);
    assert.equal((await responseJson(missingEvidence)).error, 'mission_note_required');
    assert.equal(readFileSync(fixture.queuePath, 'utf8'), durableBeforeMissingEvidence);

    const evidence = 'Focused mission tests passed and the durable queue record was inspected.';
    const doneResponse = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: verifying.revision,
      to: 'done',
      note: evidence
    });
    assert.equal(doneResponse.status, 200);
    const done = (await responseJson(doneResponse)).job;
    assert.equal(done.status, 'done');
    assert.deepEqual(done.verification, { status: 'passed', note: evidence, at: done.finishedAt });
    assert.equal(done.resultSummary, evidence);
    assert.equal(done.outcomes.at(-1)?.status, 'done');
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('active missions lock both their worker and workspace before tmux input', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const first = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
      title: 'Own the alpha workspace'
    })))).job;
    const firstDispatch = await server.request(`/api/missions/${first.id}/dispatch`, {
      expectedRevision: first.revision,
      session: 'codex-worker'
    });
    assert.equal(firstDispatch.status, 200);

    const sameWorkspace = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
      title: 'Conflict with alpha workspace'
    })))).job;
    const beforeWorkspaceConflict = toolLog(fixture);
    const workspaceConflict = await server.request(`/api/missions/${sameWorkspace.id}/dispatch`, {
      expectedRevision: sameWorkspace.revision,
      session: 'codex-other'
    });
    assert.equal(workspaceConflict.status, 409);
    assert.equal((await responseJson(workspaceConflict)).error, 'mission_workspace_locked');
    assert.equal(toolLog(fixture), beforeWorkspaceConflict);

    const sameWorker = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.betaWorkspace, {
      title: 'Conflict with worker'
    })))).job;
    const beforeWorkerConflict = toolLog(fixture);
    const workerConflict = await server.request(`/api/missions/${sameWorker.id}/dispatch`, {
      expectedRevision: sameWorker.revision,
      session: 'codex-worker'
    });
    assert.equal(workerConflict.status, 409);
    assert.equal((await responseJson(workerConflict)).error, 'mission_worker_locked');
    assert.equal(toolLog(fixture), beforeWorkerConflict);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('a recycled tmux session name cannot inherit an active mission', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
    const dispatchResponse = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    assert.equal(dispatchResponse.status, 200);
    const literalCountBeforeRestart = toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-literal:')).length;

    await server.stop();
    server = await startServer(fixture, { MISSION_SESSION_CREATED: '1700000001' });
    const linkedInput = await server.request('/api/agent/send', {
      session: 'codex-worker',
      text: 'This must not reach a replacement session.',
      missionId: created.id
    });
    assert.equal(linkedInput.status, 409);
    assert.equal((await responseJson(linkedInput)).error, 'agent_session_replaced');
    const literalCountAfterRestart = toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-literal:')).length;
    assert.equal(literalCountAfterRestart, literalCountBeforeRestart);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('mission continuation refuses a replacement pane even when the session name and creation time match', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
    const dispatched = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    assert.equal(dispatched.status, 200);
    const running = (await responseJson(dispatched)).job;

    await server.stop();
    server = await startServer(fixture, { MISSION_SUBMIT_BEHAVIOR: 'replacement' });
    const needsYouResponse = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: running.revision,
      to: 'needs_you',
      note: 'Inspect the recovered worker identity.'
    });
    assert.equal(needsYouResponse.status, 200);
    const needsYou = (await responseJson(needsYouResponse)).job;
    const sendsBeforeResume = toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-')).length;

    const resumeResponse = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: needsYou.revision,
      to: 'running'
    });
    assert.equal(resumeResponse.status, 409);
    assert.equal((await responseJson(resumeResponse)).error, 'mission_worker_missing_or_replaced');
    assert.equal(readQueue(fixture).jobs[0].status, 'needs_you');
    assert.equal(readQueue(fixture).jobs[0].revision, needsYou.revision);
    assert.equal(
      toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-')).length,
      sendsBeforeResume
    );
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('legacy missions without intrinsic pane identity cannot be resumed into a same-name worker', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
    const dispatched = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    assert.equal(dispatched.status, 200);
    const running = (await responseJson(dispatched)).job;
    await server.stop();
    server = null;

    const queue = readQueue(fixture);
    queue.jobs[0].assignedTmuxPaneId = null;
    queue.jobs[0].assignedPanePid = null;
    writeFileSync(fixture.queuePath, `${JSON.stringify(queue, null, 2)}\n`, { mode: 0o600 });

    server = await startServer(fixture);
    const needsYouResponse = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: running.revision,
      to: 'needs_you',
      note: 'Recover this legacy mission safely.'
    });
    assert.equal(needsYouResponse.status, 200);
    const needsYou = (await responseJson(needsYouResponse)).job;

    const snapshot = await responseJson(await server.get('/api/snapshot'));
    const visibleMission = snapshot.missions.jobs.find((job) => job.id === created.id);
    assert.equal(visibleMission.worker.present, true);
    assert.equal(visibleMission.worker.identityMatches, false);
    assert.equal(visibleMission.worker.identityState, 'unavailable');

    const sendsBeforeResume = toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-')).length;
    const resumeResponse = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: needsYou.revision,
      to: 'running'
    });
    assert.equal(resumeResponse.status, 409);
    assert.equal((await responseJson(resumeResponse)).error, 'mission_worker_identity_unavailable');
    assert.equal(readQueue(fixture).jobs[0].status, 'needs_you');
    assert.equal(
      toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-')).length,
      sendsBeforeResume
    );
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('normal text and picker keys cannot interleave with a reserved dispatch', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { MISSION_CAPTURE_DELAY: '0.1' });
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
    const dispatchPromise = server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });

    const deadline = Date.now() + 1500;
    while (!toolLog(fixture).includes('tmux:list-exact') && Date.now() < deadline) await delay(20);
    assert.equal(toolLog(fixture).includes('tmux:list-exact'), true);

    const [textRace, keyRace] = await Promise.all([
      server.request('/api/agent/send', { session: 'codex-worker', text: 'Do not interleave this text.' }),
      server.request('/api/agent/ui-key', { session: 'codex-worker', key: 'down' })
    ]);
    assert.equal(textRace.status, 409);
    assert.equal((await responseJson(textRace)).error, 'mission_dispatch_in_progress');
    assert.equal(keyRace.status, 409);
    assert.equal((await responseJson(keyRace)).error, 'mission_dispatch_in_progress');

    const dispatchResponse = await dispatchPromise;
    assert.equal(dispatchResponse.status, 200);
    const sendOperations = toolLog(fixture).split('\n').filter((line) =>
      line.startsWith('tmux:send-literal:') || line === 'tmux:send-enter:C-m'
    );
    assert.equal(sendOperations.length, 2);
    assert.equal(sendOperations[0].startsWith('tmux:send-literal:'), true);
    assert.equal(sendOperations[1], 'tmux:send-enter:C-m');
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('an unqueued live Codex pane blocks parent-child workspace collisions', async () => {
  const fixture = createFixture();
  const nestedWorkspace = path.join(fixture.alphaWorkspace, 'nested');
  mkdirSync(nestedWorkspace, { recursive: true });
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { MISSION_EXTRA_WORKSPACE: nestedWorkspace });
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
    const dispatchResponse = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    const result = await responseJson(dispatchResponse);
    assert.equal(dispatchResponse.status, 409);
    assert.equal(result.error, 'mission_workspace_agent_conflict');
    assert.equal(result.conflictingSession, 'codex-other');
    assert.equal(readQueue(fixture).jobs[0].status, 'ready');
    assert.equal(toolLog(fixture).includes('tmux:send-literal:'), false);
    assert.equal(toolLog(fixture).includes('tmux:send-enter:C-m'), false);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('new Codex sessions get a startup grace period before they are labeled stopped', async () => {
  for (const testCase of [
    { ageSeconds: 1, expected: 'starting' },
    { ageSeconds: 30, expected: 'stopped' }
  ]) {
    const fixture = createFixture();
    installDispatchTools(fixture);
    let server;
    try {
      server = await startServer(fixture, {
        MISSION_PANE_COMMAND: 'bash',
        MISSION_NO_CODEX_PROCESS: '1',
        MISSION_SESSION_CREATED: String(Math.floor(Date.now() / 1000) - testCase.ageSeconds)
      });
      const snapshot = await responseJson(await server.get('/api/snapshot'));
      const worker = snapshot.agents.find((agent) => agent.session === 'codex-worker');
      assert.equal(worker.agentStatus.state, testCase.expected);
    } finally {
      if (server) await server.stop();
      rmSync(fixture.fixtureDir, { recursive: true, force: true });
    }
  }
});

test('Codex idle prompts ignore permission metadata without masking real input requests', async (t) => {
  const cases = [
    {
      name: 'idle startup metadata',
      expectedState: 'idle',
      expectedTone: 'good',
      expectedReason: 'prompt ready',
      output: [
        'OpenAI Codex',
        'model: gpt-test-alpha ultra',
        'directory: ~/projects/alpha',
        'permissions: full access',
        '',
        '› Ask Codex anything',
        'gpt-test-alpha ultra · 100% left'
      ].join('\n')
    },
    {
      name: 'model picker',
      expectedState: 'waiting',
      expectedTone: 'warn',
      expectedReason: 'input needed',
      output: [
        'Select a model and reasoning effort',
        '› 1. gpt-test-alpha  ultra',
        '  2. gpt-test-beta max',
        'Press enter to select'
      ].join('\n')
    },
    {
      name: 'command approval',
      expectedState: 'waiting',
      expectedTone: 'warn',
      expectedReason: 'input needed',
      output: [
        'Do you want to run this command?',
        '› 1. Yes, proceed',
        '  2. No, and tell Codex what to do differently',
        'Press enter to confirm'
      ].join('\n')
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fixture = createFixture();
      installDispatchTools(fixture);
      let server;
      try {
        server = await startServer(fixture, { MISSION_CAPTURE_OUTPUT: testCase.output });
        const snapshotResponse = await server.get('/api/snapshot');
        assert.equal(snapshotResponse.status, 200);
        const snapshot = await responseJson(snapshotResponse);
        const agent = snapshot.agents.find((item) => item.session === 'codex-worker');
        assert.ok(agent, 'expected the fake Codex worker in the snapshot');
        assert.equal(agent.agentStatus?.state, testCase.expectedState);
        assert.equal(agent.agentStatus?.tone, testCase.expectedTone);
        assert.equal(agent.agentStatus?.reason, testCase.expectedReason);
      } finally {
        if (server) await server.stop();
        rmSync(fixture.fixtureDir, { recursive: true, force: true });
      }
    });
  }
});

test('Today attention and notification outbox stay decision-only, deduplicated, snoozable, and stale-cookie safe', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, {
      MISSION_LITERAL_CONFIRM_MS: '500',
      MISSION_SUBMIT_CONFIRM_MS: '500',
      MISSION_CONFIRM_SAMPLE_MS: '20'
    });
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
      title: 'Verify the Today feed'
    })))).job;
    const dispatchResponse = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    assert.equal(dispatchResponse.status, 200);
    const running = (await responseJson(dispatchResponse)).job;
    const verifyingResponse = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: running.revision,
      to: 'verifying'
    });
    assert.equal(verifyingResponse.status, 200);

    const firstSnapshot = await responseJson(await server.get('/api/snapshot'));
    const missionAttention = firstSnapshot.attention.items.filter((item) => item.missionId === created.id);
    assert.equal(missionAttention.length, 1);
    assert.equal(missionAttention[0].status, 'verifying');
    assert.equal(missionAttention[0].requiresDecision, true);
    assert.equal(
      firstSnapshot.attention.decisionCount,
      firstSnapshot.attention.items.filter((item) => item.requiresDecision).length
    );
    assert.equal(firstSnapshot.notifications.items.length, 1);
    const notification = firstSnapshot.notifications.items[0];
    assert.equal(notification.kind, 'verification_ready');
    assert.equal(notification.missionId, created.id);
    assert.match(notification.openEndpoint, new RegExp(`^/api/notifications/${notification.id}/open$`));
    assert.match(notification.snoozeEndpoint, new RegExp(`^/api/notifications/${notification.id}/snooze$`));

    const repeatedSnapshot = await responseJson(await server.get('/api/snapshot'));
    assert.deepEqual(repeatedSnapshot.notifications.items.map((item) => item.id), [notification.id]);

    const staleCookie = server.cookie;
    await server.stop();
    server = await startServer(fixture, {
      MISSION_LITERAL_CONFIRM_MS: '500',
      MISSION_SUBMIT_CONFIRM_MS: '500',
      MISSION_CONFIRM_SAMPLE_MS: '20'
    });
    const staleSnooze = await server.postWithCookie(notification.snoozeEndpoint, { minutes: 15 }, staleCookie);
    assert.equal(staleSnooze.status, 401);
    assert.deepEqual(await responseJson(staleSnooze), { error: 'control_session_required' });

    const snoozed = await server.request(notification.snoozeEndpoint, { minutes: 15 });
    assert.equal(snoozed.status, 200);
    assert.equal((await responseJson(snoozed)).action, 'snooze');
    const snoozedSnapshot = await responseJson(await server.get('/api/snapshot'));
    assert.deepEqual(snoozedSnapshot.notifications.items, []);

    const opened = await server.request(notification.openEndpoint, {});
    assert.equal(opened.status, 200);
    assert.equal((await responseJson(opened)).action, 'open');
    const openedSnapshot = await responseJson(await server.get('/api/snapshot'));
    assert.deepEqual(openedSnapshot.notifications.items, []);
    assert.equal(statSync(path.join(fixture.fixtureDir, 'data', 'notification-state.json')).mode & 0o777, 0o600);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('Today attention merges a waiting unassigned agent as one operator decision', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, {
      MISSION_CAPTURE_OUTPUT: [
        'Select a model and reasoning effort',
        '› 1. gpt-test-alpha ultra',
        'Press enter to select'
      ].join('\n')
    });
    const snapshot = await responseJson(await server.get('/api/snapshot'));
    const workerItems = snapshot.attention.items.filter((item) => item.session === 'codex-worker');
    assert.equal(workerItems.length, 1);
    assert.equal(workerItems[0].kind, 'agent');
    assert.equal(workerItems[0].status, 'waiting');
    assert.equal(workerItems[0].requiresDecision, true);
    assert.equal(snapshot.attention.decisionCount, 1);
    assert.deepEqual(snapshot.notifications.items, []);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('snapshot reports control-plane mode and legacy tmux adds one non-decision Today warning', async (t) => {
  for (const mode of ['systemd-user', 'foreground', 'tmux-legacy']) {
    await t.test(mode, async () => {
      const fixture = createFixture();
      installDispatchTools(fixture);
      let server;
      try {
        server = await startServer(fixture, { ORCH_CONTROL_PLANE_MODE: mode });
        const snapshot = await responseJson(await server.get('/api/snapshot'));
        assert.equal(snapshot.host.controlPlane.mode, mode);
        assert.equal(snapshot.host.app.controlPlaneMode, mode);
        assert.equal(snapshot.capabilities.controlPlaneMode, mode);
        assert.equal(snapshot.capabilities.controlPlaneIsolated, mode !== 'tmux-legacy');

        const warnings = snapshot.security.warnings.filter((item) => item.id === 'legacy-control-plane');
        const todayWarnings = snapshot.attention.items.filter((item) => item.id === 'attention:system:legacy-control-plane');
        assert.equal(warnings.length, mode === 'tmux-legacy' ? 1 : 0);
        assert.equal(todayWarnings.length, mode === 'tmux-legacy' ? 1 : 0);
        if (mode === 'tmux-legacy') {
          assert.equal(warnings[0].requiresDecision, false);
          assert.equal(todayWarnings[0].requiresDecision, false);
          assert.match(todayWarnings[0].title, /shares the workload tmux server/i);
        }
        assert.equal(
          snapshot.attention.decisionCount,
          snapshot.attention.items.filter((item) => item.requiresDecision).length
        );
      } finally {
        if (server) await server.stop();
        rmSync(fixture.fixtureDir, { recursive: true, force: true });
      }
    });
  }
});

test('ephemeral review replacement is confined to the managed tmux socket', async () => {
  const fixture = createFixture();
  installReviewTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { ORCH_CONTROL_PLANE_MODE: 'foreground' });
    const response = await server.request('/api/review/start', {});
    assert.equal(response.status, 200);
    const body = await responseJson(response);
    assert.equal(body.session, 'codex-orchestrator-review');
    assert.equal(body.tmuxSocket, 'host-control-managed');

    const operations = toolLog(fixture).trim().split('\n').filter(Boolean);
    const lifecycle = operations.filter((line) => /(?:has-session|kill-session|new-session|set-option)/.test(line));
    assert.equal(lifecycle.length, 4);
    assert.equal(lifecycle.every((line) => line.startsWith('tmux:-L host-control-managed ')), true);
    assert.equal(operations.some((line) => /^tmux:(?!-L host-control-managed ).*kill-session/.test(line)), false);
    assert.equal(operations.some((line) => line.includes('kill-server')), false);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('all operational snapshots require the same-page control session', async () => {
  const fixture = createFixture();
  let server;
  try {
    server = await startServer(fixture);
    const createdResponse = await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace));
    assert.equal(createdResponse.status, 200);
    const created = (await responseJson(createdResponse)).job;

    const publicSnapshotResponse = await server.get('/api/snapshot', { authenticated: false });
    assert.equal(publicSnapshotResponse.status, 401);
    assert.deepEqual(await responseJson(publicSnapshotResponse), { error: 'control_session_required' });

    const publicMissionsResponse = await server.get('/api/missions', { authenticated: false });
    assert.equal(publicMissionsResponse.status, 401);
    assert.deepEqual(await responseJson(publicMissionsResponse), { error: 'control_session_required' });

    const publicEventsResponse = await server.get('/api/events', { authenticated: false });
    assert.equal(publicEventsResponse.status, 401);
    assert.deepEqual(await responseJson(publicEventsResponse), { error: 'control_session_required' });

    const controlledMissionsResponse = await server.get('/api/missions');
    assert.equal(controlledMissionsResponse.status, 200);
    const controlledMissions = await responseJson(controlledMissionsResponse);
    assert.equal(controlledMissions.missions.jobs.some((job) => job.id === created.id), true);

    const staleCookie = server.cookie;
    await server.stop();
    server = await startServer(fixture);
    const staleSnapshotResponse = await server.get('/api/snapshot', { cookieOverride: staleCookie });
    assert.equal(staleSnapshotResponse.status, 401);
    assert.deepEqual(await responseJson(staleSnapshotResponse), { error: 'control_session_required' });

    const refreshedSnapshotResponse = await server.get('/api/snapshot');
    assert.equal(refreshedSnapshotResponse.status, 200);
    const refreshedSnapshot = await responseJson(refreshedSnapshotResponse);
    assert.equal(refreshedSnapshot.missions.jobs.some((job) => job.id === created.id), true);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});
