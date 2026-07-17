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

function writeExecutable(file, source) {
  writeFileSync(file, source, { mode: 0o755 });
  chmodSync(file, 0o755);
}

function installFakeTmux(fixture) {
  writeExecutable(path.join(fixture.binDir, 'tmux'), `#!/bin/sh
log() { printf '%s\\n' "$1" >> "$AGENT_CREATE_TOOL_LOG"; }
state() {
  if [ -f "$AGENT_CREATE_STATE_PATH" ]; then cat "$AGENT_CREATE_STATE_PATH"; else printf '%s' 'missing'; fi
}

if [ "$1" = "-L" ]; then
  log "managed:$*"
  exit 1
fi

case "$1" in
  has-session)
    log "has-session:$3"
    exit 1
    ;;
  new-session)
    previous=''
    session=''
    last=''
    for argument in "$@"; do
      if [ "$previous" = "-s" ]; then session="$argument"; fi
      previous="$argument"
      last="$argument"
    done
    if [ -z "$session" ]; then log 'new-session:missing-session'; exit 97; fi
    printf '%s' "$session" > "$AGENT_CREATE_SESSION_PATH"
    printf '%s\\n' 'starting' > "$AGENT_CREATE_STATE_PATH"
    : > "$AGENT_CREATE_INPUT_PATH"
    : > "$AGENT_CREATE_READY_COUNT_PATH"
    : > "$AGENT_CREATE_RENDER_COUNT_PATH"
    log "new-session:$session"
    log "new-session-command:$last"
    ;;
  set-option)
    if [ "$2" != '-p' ] || [ "$3" != '-t' ] || [ "$4" != '%41' ] || [ "$5" != 'remain-on-exit' ] || [ "$6" != 'on' ]; then
      log "protect:unexpected:$*"
      exit 97
    fi
    log 'protect:%41:remain-on-exit:on'
    if [ "$AGENT_CREATE_BEHAVIOR" = 'lifecycle-guard-failure' ]; then exit 96; fi
    ;;
  list-panes)
    if [ "$2" = "-a" ]; then
      log 'list-panes:all'
      exit 0
    fi
    if [ "$2" != "-t" ]; then log "list-panes:unexpected:$*"; exit 97; fi
    session="\${3#=}"
    pane_id='%41'
    pane_pid='7041'
    current_state="$(state)"
    ready_count=0
    render_count=0
    if [ -s "$AGENT_CREATE_READY_COUNT_PATH" ]; then ready_count="$(cat "$AGENT_CREATE_READY_COUNT_PATH")"; fi
    if [ -s "$AGENT_CREATE_RENDER_COUNT_PATH" ]; then render_count="$(cat "$AGENT_CREATE_RENDER_COUNT_PATH")"; fi
    if { [ "$AGENT_CREATE_BEHAVIOR" = 'replacement' ] || [ "$AGENT_CREATE_BEHAVIOR" = 'replacement-between-chunks' ]; } && [ "$current_state" = 'typed' ]; then
      pane_id='%99'
      pane_pid='7099'
    elif [ "$AGENT_CREATE_BEHAVIOR" = 'replacement-before-type' ] && [ "$ready_count" -ge 3 ]; then
      pane_id='%99'
      pane_pid='7099'
    elif [ "$AGENT_CREATE_BEHAVIOR" = 'replacement-before-enter' ] && [ "$render_count" -ge 2 ]; then
      pane_id='%99'
      pane_pid='7099'
    fi
    printf '%s|1700000000|0|0|1|node|%s|%s|%s\\n' "$session" "$AGENT_CREATE_WORKSPACE" "$pane_id" "$pane_pid"
    log "list-panes:exact:$session:$pane_id:$pane_pid:$current_state"
    ;;
  capture-pane)
    current_state="$(state)"
    case "$current_state" in
      starting)
        ready_count=0
        if [ -s "$AGENT_CREATE_READY_COUNT_PATH" ]; then ready_count="$(cat "$AGENT_CREATE_READY_COUNT_PATH")"; fi
        ready_count=$((ready_count + 1))
        printf '%s\\n' "$ready_count" > "$AGENT_CREATE_READY_COUNT_PATH"
        if [ "$ready_count" -le "\${AGENT_CREATE_READY_AFTER:-1}" ]; then
          printf '%s\\n' 'OpenAI Codex' 'Starting interactive session...'
          log "capture:not-ready:$ready_count"
        else
          printf '%s\\n' 'OpenAI Codex' '› Ask Codex anything' 'gpt-test-alpha ultra · 100% left'
          log "capture:ready:$ready_count"
        fi
        ;;
      typed)
        render_count=0
        if [ -s "$AGENT_CREATE_RENDER_COUNT_PATH" ]; then render_count="$(cat "$AGENT_CREATE_RENDER_COUNT_PATH")"; fi
        render_count=$((render_count + 1))
        printf '%s\\n' "$render_count" > "$AGENT_CREATE_RENDER_COUNT_PATH"
        if [ "$AGENT_CREATE_BEHAVIOR" = 'render-timeout' ]; then
          printf '%s\\n' 'OpenAI Codex' '› input still rendering' 'gpt-test-alpha ultra · 100% left'
          log 'capture:typed:hidden'
        elif [ "$AGENT_CREATE_BEHAVIOR" = 'tail-only' ]; then
          printf '%s\\n' 'OpenAI Codex'
          printf '%s' '› '
          tail -n 1 "$AGENT_CREATE_INPUT_PATH"
          printf '\\n%s\\n' 'gpt-test-alpha ultra · 100% left'
          log 'capture:typed:tail-only'
        elif [ "$AGENT_CREATE_BEHAVIOR" = 'many-lines' ]; then
          capture_lines=300
          for argument in "$@"; do
            case "$argument" in -[0-9]*) capture_lines="\${argument#-}" ;; esac
          done
          {
            printf '%s\\n' 'OpenAI Codex'
            printf '%s' '› '
            cat "$AGENT_CREATE_INPUT_PATH"
            printf '\\n%s\\n' 'gpt-test-alpha ultra · 100% left'
          } | tail -n "$capture_lines"
          log "capture:typed:many-lines:$capture_lines"
        else
          printf '%s\\n' 'OpenAI Codex'
          printf '%s' '› '
          cat "$AGENT_CREATE_INPUT_PATH"
          printf '\\n%s\\n' 'gpt-test-alpha ultra · 100% left'
          log 'capture:typed:visible'
        fi
        ;;
      accepted)
        printf '%s\\n' 'OpenAI Codex'
        printf '%s' '› '
        cat "$AGENT_CREATE_INPUT_PATH"
        printf '\\n%s\\n' 'Working (1s)' 'esc to interrupt'
        log 'capture:accepted'
        ;;
      idle-placeholder)
        printf '%s\\n' 'OpenAI Codex'
        printf '%s' '› '
        cat "$AGENT_CREATE_INPUT_PATH"
        printf '\\n%s\\n' '› Implement {feature}' 'gpt-test-alpha ultra · 100% left'
        log 'capture:idle-placeholder'
        ;;
      *)
        printf '%s\\n' 'OpenAI Codex' 'Starting interactive session...'
        log "capture:unexpected:$current_state"
        ;;
    esac
    ;;
  send-keys)
    target="$3"
    if [ "$2" != '-t' ]; then log "send:unexpected:$*"; exit 97; fi
    if [ "$4" = '-l' ] && [ "$#" -eq 5 ]; then
      ready_count=0
      if [ -s "$AGENT_CREATE_READY_COUNT_PATH" ]; then ready_count="$(cat "$AGENT_CREATE_READY_COUNT_PATH")"; fi
      if [ "$ready_count" -le "\${AGENT_CREATE_READY_AFTER:-1}" ]; then log "literal-before-ready:$target"; fi
      if [ "$AGENT_CREATE_BEHAVIOR" = 'literal-failure' ]; then
        printf 'literal failed for %s\\n' "$5" >&2
        exit 91
      fi
      printf '%s' "$5" >> "$AGENT_CREATE_INPUT_PATH"
      printf '%s\\n' 'typed' > "$AGENT_CREATE_STATE_PATH"
      log "literal:$target:\${#5}"
    elif [ "$4" = 'C-m' ] && [ "$#" -eq 4 ]; then
      log "enter:$target:C-m"
      if [ "$AGENT_CREATE_BEHAVIOR" = 'idle-placeholder' ]; then
        printf '%s\\n' 'idle-placeholder' > "$AGENT_CREATE_STATE_PATH"
      elif [ "$AGENT_CREATE_BEHAVIOR" != 'ignored' ]; then
        printf '%s\\n' 'accepted' > "$AGENT_CREATE_STATE_PATH"
      fi
    else
      log "send:unexpected:$*"
      exit 97
    fi
    ;;
  *)
    log "unexpected:$*"
    exit 97
    ;;
esac
`);
}

function createFixture(behavior) {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'agent-create-prompt-'));
  const projectsRoot = path.join(fixtureDir, 'projects');
  const workspace = path.join(projectsRoot, 'sample-project');
  const agentWorkspacesRoot = path.join(projectsRoot, 'agent-workspaces');
  const codexHome = path.join(fixtureDir, 'codex-home');
  const extraWorkspaceRoot = path.join(fixtureDir, 'extra-workspace');
  const publicDir = path.join(fixtureDir, 'public');
  const binDir = path.join(fixtureDir, 'bin');
  for (const directory of [projectsRoot, workspace, agentWorkspacesRoot, codexHome, extraWorkspaceRoot, publicDir, binDir]) {
    mkdirSync(directory, { recursive: true });
  }

  writeFileSync(path.join(fixtureDir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(path.join(fixtureDir, 'services.json'), '[]\n');
  writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>Agent Create Prompt Test</title>\n');
  writeFileSync(path.join(codexHome, 'models_cache.json'), '{"models":[]}\n');

  const fixture = {
    fixtureDir,
    projectsRoot,
    workspace,
    agentWorkspacesRoot,
    codexHome,
    extraWorkspaceRoot,
    publicDir,
    binDir,
    behavior,
    toolLogPath: path.join(fixtureDir, 'tools.log'),
    statePath: path.join(fixtureDir, 'tmux-state'),
    inputPath: path.join(fixtureDir, 'tmux-input'),
    sessionPath: path.join(fixtureDir, 'tmux-session'),
    readyCountPath: path.join(fixtureDir, 'tmux-ready-count'),
    renderCountPath: path.join(fixtureDir, 'tmux-render-count')
  };
  installFakeTmux(fixture);
  for (const name of ['aws', 'curl', 'ps', 'ss']) {
    writeExecutable(path.join(binDir, name), `#!/bin/sh\nprintf '%s\\n' '${name}:forbidden' >> "$AGENT_CREATE_TOOL_LOG"\nexit 97\n`);
  }
  return fixture;
}

async function startServer(fixture) {
  const port = await unusedLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
    cwd: fixture.fixtureDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      ORCHESTRATOR_RUNTIME_ROOT: fixture.fixtureDir,
      PATH: `${fixture.binDir}:${process.env.PATH || ''}`,
      CODEX_HOME: fixture.codexHome,
      ORCHESTRATOR_PROJECTS_ROOT: fixture.projectsRoot,
      ORCHESTRATOR_AGENT_WORKSPACES_ROOT: fixture.agentWorkspacesRoot,
      ORCHESTRATOR_EXTRA_WORKSPACE_ROOTS: fixture.extraWorkspaceRoot,
      ORCH_CONTROL_PLANE_MODE: 'foreground',
      AGENT_CREATE_BEHAVIOR: fixture.behavior,
      AGENT_CREATE_TOOL_LOG: fixture.toolLogPath,
      AGENT_CREATE_STATE_PATH: fixture.statePath,
      AGENT_CREATE_INPUT_PATH: fixture.inputPath,
      AGENT_CREATE_SESSION_PATH: fixture.sessionPath,
      AGENT_CREATE_READY_COUNT_PATH: fixture.readyCountPath,
      AGENT_CREATE_RENDER_COUNT_PATH: fixture.renderCountPath,
      AGENT_CREATE_WORKSPACE: fixture.workspace,
      AGENT_CREATE_READY_AFTER: '1',
      INITIAL_PROMPT_READY_MS: '3000',
      MISSION_LITERAL_CONFIRM_MS: '1200',
      MISSION_SUBMIT_CONFIRM_MS: '1400',
      MISSION_CONFIRM_SAMPLE_MS: '30',
      SNAPSHOT_EVENT_MS: '3600000',
      SSH_RESCUE_MONITOR_MS: '3600000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const deadline = Date.now() + 10000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`isolated server exited early (${child.exitCode ?? child.signalCode})\n${output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.status === 200) {
        ready = true;
        break;
      }
    } catch {
      // The isolated server is still binding.
    }
    await delay(30);
  }
  if (!ready) throw new Error(`isolated server did not become ready\n${output}`);

  const index = await fetch(`${baseUrl}/`);
  const cookie = String(index.headers.get('set-cookie') || '').split(';', 1)[0];
  assert.match(cookie, /^host_control_session=/);

  return {
    child,
    output: () => output,
    async create(body) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`${baseUrl}/api/agent/create`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        return { response, body: JSON.parse(await response.text()) };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null || server.child.signalCode !== null) return;
  const exited = once(server.child, 'exit');
  server.child.kill('SIGTERM');
  await Promise.race([exited, delay(2000)]);
  if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGKILL');
}

async function withServer(behavior, operation) {
  const fixture = createFixture(behavior);
  let server;
  try {
    server = await startServer(fixture);
    return await operation({ fixture, server });
  } finally {
    await stopServer(server);
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
}

function toolLog(fixture) {
  return existsSync(fixture.toolLogPath) ? readFileSync(fixture.toolLogPath, 'utf8') : '';
}

function deliveredInput(fixture) {
  return existsSync(fixture.inputPath) ? readFileSync(fixture.inputPath, 'utf8') : '';
}

function markersAroundPrompt(delivered, prompt) {
  const firstBreak = delivered.indexOf('\n\n');
  const lastBreak = delivered.lastIndexOf('\n\n');
  assert.ok(firstBreak > 0 && lastBreak > firstBreak, 'paired PaneFleet markers must surround the prompt');
  const startMarker = delivered.slice(0, firstBreak);
  const deliveredPrompt = delivered.slice(firstBreak + 2, lastBreak);
  const endMarker = delivered.slice(lastBreak + 2);
  const startMatch = startMarker.match(/^\[PaneFleet Initial Prompt ([a-f0-9]+) Start\]$/);
  const endMatch = endMarker.match(/^\[PaneFleet Initial Prompt ([a-f0-9]+) End\]$/);
  assert.ok(startMatch && endMatch, 'bounded start and end confirmation markers are required');
  assert.equal(startMatch[1], endMatch[1], 'start and end markers must share one unique token');
  assert.equal(deliveredPrompt, prompt, 'the complete requested prompt must remain between the markers');
  return { startMarker, endMarker };
}

function occurrences(textValue, needle) {
  return String(textValue).split(needle).length - 1;
}

test('New Agent waits for a stable composer, types in chunks, and confirms acceptance once', async () => {
  await withServer('success', async ({ fixture, server }) => {
    const prompt = `Work only on the sample-project workspace.\n${'Review the evidence carefully. '.repeat(70)}`;
    const first = await server.create({
      name: 'prompt-success',
      workspaceMode: 'existing',
      workspace: fixture.workspace,
      prompt
    });
    assert.equal(first.response.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.promptSent, true);
    assert.equal(first.body.promptState, 'accepted');

    const firstDelivered = deliveredInput(fixture);
    const firstMarker = markersAroundPrompt(firstDelivered, prompt);
    const firstLog = toolLog(fixture);
    assert.match(firstLog, /new-session-command:.*exec bash -l/);
    assert.match(firstLog, /protect:%41:remain-on-exit:on/);
    const firstLiteralIndex = firstLog.indexOf('literal:%41:');
    assert.ok(firstLiteralIndex > -1);
    assert.ok(firstLog.indexOf('protect:%41:remain-on-exit:on') < firstLiteralIndex);
    assert.equal(firstLog.includes('literal-before-ready:'), false);
    assert.ok((firstLog.slice(0, firstLiteralIndex).match(/capture:ready:/g) || []).length >= 2);
    const firstChunkLengths = [...firstLog.matchAll(/literal:%41:(\d+)/g)].map((match) => Number(match[1]));
    assert.ok(firstChunkLengths.length > 1, 'the long prompt must use bounded literal chunks');
    assert.ok(firstChunkLengths.every((length) => length > 0 && length <= 384));
    assert.equal(occurrences(firstLog, 'enter:%41:C-m'), 1);

    const secondPrompt = 'Check marker uniqueness without touching another session.';
    const second = await server.create({
      name: 'prompt-success-two',
      workspaceMode: 'existing',
      workspace: fixture.workspace,
      prompt: secondPrompt
    });
    assert.equal(second.response.status, 200);
    assert.equal(second.body.promptSent, true);
    assert.equal(second.body.promptState, 'accepted');
    const secondMarker = markersAroundPrompt(deliveredInput(fixture), secondPrompt);
    assert.notEqual(secondMarker.endMarker, firstMarker.endMarker, 'each create handshake needs a unique confirmation marker');
    assert.equal(occurrences(toolLog(fixture), 'enter:%41:C-m'), 2);
  });
});

test('New Agent sends no prompt when exact-pane exit preservation cannot be armed', async () => {
  await withServer('lifecycle-guard-failure', async ({ fixture, server }) => {
    const result = await server.create({
      name: 'prompt-lifecycle-guard',
      workspaceMode: 'existing',
      workspace: fixture.workspace,
      prompt: 'Do not type this unless the exact pane is protected first.'
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.promptSent, false);
    assert.equal(result.body.promptState, 'not_typed');
    assert.equal(result.body.promptError, 'agent_lifecycle_guard_failed');
    assert.match(toolLog(fixture), /protect:%41:remain-on-exit:on/);
    assert.doesNotMatch(toolLog(fixture), /(^|\n)literal:/);
    assert.doesNotMatch(toolLog(fixture), /(^|\n)enter:/);
  });
});

test('an ignored Enter reports outcome_unknown and never resends', async () => {
  await withServer('ignored', async ({ fixture, server }) => {
    const prompt = 'Start the focused sample-project task and report evidence.';
    const result = await server.create({
      name: 'prompt-ignored',
      workspaceMode: 'existing',
      workspace: fixture.workspace,
      prompt
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.promptSent, false);
    assert.equal(result.body.promptState, 'outcome_unknown');
    assert.equal(occurrences(toolLog(fixture), 'enter:%41:C-m'), 1);
    assert.equal(occurrences(deliveredInput(fixture), prompt), 1);
  });
});

test('an unconfirmed render remains typed_not_submitted with zero Enter keys', async () => {
  await withServer('render-timeout', async ({ fixture, server }) => {
    const prompt = 'Do not submit this until every literal character is visible.';
    const result = await server.create({
      name: 'prompt-render-timeout',
      workspaceMode: 'existing',
      workspace: fixture.workspace,
      prompt
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.promptSent, false);
    assert.equal(result.body.promptState, 'typed_not_submitted');
    assert.doesNotMatch(toolLog(fixture), /(^|\n)enter:/);
    markersAroundPrompt(deliveredInput(fixture), prompt);
  });
});

test('tail-only rendering never permits Enter without the leading witness marker', async () => {
  await withServer('tail-only', async ({ fixture, server }) => {
    const prompt = 'Require both render witnesses before submitting this prompt.';
    const result = await server.create({
      name: 'prompt-tail-only',
      workspaceMode: 'existing',
      workspace: fixture.workspace,
      prompt
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.promptSent, false);
    assert.equal(result.body.promptState, 'typed_not_submitted');
    assert.doesNotMatch(toolLog(fixture), /(^|\n)enter:/);
    markersAroundPrompt(deliveredInput(fixture), prompt);
  });
});

test('newline-dense prompts expand the render capture enough to keep both witnesses', async () => {
  await withServer('many-lines', async ({ fixture, server }) => {
    const prompt = Array.from({ length: 340 }, (_, index) => 'line-' + index).join('\n');
    const result = await server.create({
      name: 'prompt-many-lines',
      workspaceMode: 'existing',
      workspace: fixture.workspace,
      prompt
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.promptSent, true);
    assert.equal(result.body.promptState, 'accepted');
    const captureDepths = [...toolLog(fixture).matchAll(/capture:typed:many-lines:(\d+)/g)].map((match) => Number(match[1]));
    assert.ok(captureDepths.length >= 2);
    assert.ok(captureDepths.every((depth) => depth >= 420));
    assert.equal(occurrences(toolLog(fixture), 'enter:%41:C-m'), 1);
    markersAroundPrompt(deliveredInput(fixture), prompt);
  });
});

test('an idle composer after Enter is outcome_unknown, not accepted', async () => {
  await withServer('idle-placeholder', async ({ fixture, server }) => {
    const result = await server.create({
      name: 'prompt-idle-placeholder',
      workspaceMode: 'existing',
      workspace: fixture.workspace,
      prompt: 'Start only when Codex visibly acknowledges this prompt.'
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.promptSent, false);
    assert.equal(result.body.promptState, 'outcome_unknown');
    assert.equal(occurrences(toolLog(fixture), 'enter:%41:C-m'), 1);
  });
});

test('literal command failures never echo private prompt text into the API or audit', async () => {
  await withServer('literal-failure', async ({ fixture, server }) => {
    const sentinel = 'private-candidate-note-sentinel-7429';
    const result = await server.create({
      name: 'prompt-literal-failure',
      workspaceMode: 'existing',
      workspace: fixture.workspace,
      prompt: 'Review ' + sentinel + ' without exposing it.'
    });
    const audit = readFileSync(path.join(fixture.fixtureDir, 'data', 'actions.jsonl'), 'utf8');
    assert.equal(result.response.status, 200);
    assert.equal(result.body.promptSent, false);
    assert.equal(result.body.promptError, 'terminal_literal_input_failed');
    assert.equal(JSON.stringify(result.body).includes(sentinel), false);
    assert.equal(audit.includes(sentinel), false);
    assert.doesNotMatch(toolLog(fixture), /(^|\n)enter:/);
  });
});

test('pane identity replacement after typing fails closed before Enter', async () => {
  await withServer('replacement', async ({ fixture, server }) => {
    const prompt = 'Keep this bound to the exact pane that was initially discovered.';
    const result = await server.create({
      name: 'prompt-replacement',
      workspaceMode: 'existing',
      workspace: fixture.workspace,
      prompt
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.promptSent, false);
    assert.equal(result.body.promptState, 'typed_not_submitted');
    assert.doesNotMatch(toolLog(fixture), /(^|\n)enter:/);
    assert.match(toolLog(fixture), /list-panes:exact:codex-prompt-replacement:%99:7099:typed/);
  });
});

test('pane replacement before typing sends no literal input', async () => {
  await withServer('replacement-before-type', async ({ fixture, server }) => {
    const result = await server.create({
      name: 'prompt-replaced-before-type',
      workspaceMode: 'existing',
      workspace: fixture.workspace,
      prompt: 'This must remain bound to the pane that became ready.'
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.promptSent, false);
    assert.equal(result.body.promptState, 'not_typed');
    assert.equal(toolLog(fixture).includes('literal:'), false);
    assert.doesNotMatch(toolLog(fixture), /(^|\n)enter:/);
  });
});

test('pane replacement between chunks stops the remaining prompt and sends no Enter', async () => {
  await withServer('replacement-between-chunks', async ({ fixture, server }) => {
    const result = await server.create({
      name: 'prompt-replaced-between-chunks',
      workspaceMode: 'existing',
      workspace: fixture.workspace,
      prompt: 'Long exact-pane prompt. '.repeat(80)
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.promptSent, false);
    assert.equal(result.body.promptState, 'typed_not_submitted');
    assert.equal((toolLog(fixture).match(/literal:%41:/g) || []).length, 1);
    assert.doesNotMatch(toolLog(fixture), /(^|\n)enter:/);
  });
});

test('pane replacement after render confirmation is rechecked before Enter', async () => {
  await withServer('replacement-before-enter', async ({ fixture, server }) => {
    const result = await server.create({
      name: 'prompt-replaced-before-enter',
      workspaceMode: 'existing',
      workspace: fixture.workspace,
      prompt: 'Revalidate the exact pane after rendering and before Enter.'
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.promptSent, false);
    assert.equal(result.body.promptState, 'typed_not_submitted');
    assert.equal((toolLog(fixture).match(/capture:typed:visible/g) || []).length, 2);
    assert.doesNotMatch(toolLog(fixture), /(^|\n)enter:/);
  });
});
