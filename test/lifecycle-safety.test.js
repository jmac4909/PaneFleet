import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeExecutable(file, source) {
  writeFileSync(file, source, { mode: 0o755 });
  chmodSync(file, 0o755);
}

function lifecycleFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'host-control-lifecycle-'));
  temporaryDirectories.push(directory);
  const binDir = path.join(directory, 'bin');
  const runtimeDir = path.join(directory, 'run');
  const configDir = path.join(directory, 'config');
  const commandLog = path.join(directory, 'commands.log');
  const tmuxState = path.join(directory, 'tmux-sessions');
  const serviceState = path.join(directory, 'systemd-service-state');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    tmuxState,
    [
      'sentinel-workload|$1|100|0.0|%1|1001|codex',
      'agent-orchestrator|$2|200|0.0|%2|2002|npm start',
      'agent-orchestrator-watchdog|$3|300|0.0|%3|3003|bash scripts/watchdog.sh'
    ].join('\n') + '\n'
  );

  writeExecutable(path.join(binDir, 'systemctl'), `#!/bin/sh
printf 'systemctl' >> "$ORCH_TEST_COMMAND_LOG"
printf ' <%s>' "$@" >> "$ORCH_TEST_COMMAND_LOG"
printf '\\n' >> "$ORCH_TEST_COMMAND_LOG"
case " $* " in
  *' restart '*|*' start '*) printf '%s\\n' 'running' > "$ORCH_TEST_SERVICE_STATE" ;;
  *' show '*) printf '%s\\n' '4242' ;;
  *' is-active '*) printf '%s\\n' 'active' ;;
  *' is-enabled '*) printf '%s\\n' 'enabled' ;;
esac
exit 0
`);

  writeExecutable(path.join(binDir, 'curl'), `#!/bin/sh
printf 'curl' >> "$ORCH_TEST_COMMAND_LOG"
printf ' <%s>' "$@" >> "$ORCH_TEST_COMMAND_LOG"
printf '\\n' >> "$ORCH_TEST_COMMAND_LOG"
exit 0
`);

  writeExecutable(path.join(binDir, 'tmux'), `#!/bin/sh
printf 'tmux' >> "$ORCH_TEST_COMMAND_LOG"
printf ' <%s>' "$@" >> "$ORCH_TEST_COMMAND_LOG"
printf '\\n' >> "$ORCH_TEST_COMMAND_LOG"
if [ "\${ORCH_TEST_TMUX_ABSENT:-0}" = 1 ]; then
  case "$1" in
    list-sessions|list-panes|has-session) exit 1 ;;
  esac
fi
case "$1" in
  list-sessions)
    /usr/bin/cut -d '|' -f 1 "$ORCH_TEST_TMUX_STATE"
    ;;
  list-panes)
    if [ "\${2:-}" = '-a' ] && [ "\${3:-}" = '-F' ]; then
      /bin/cat "$ORCH_TEST_TMUX_STATE"
    elif [ "\${2:-}" = '-t' ]; then
      session="\${3#=}"
      line="$(/bin/grep "^\${session}|" "$ORCH_TEST_TMUX_STATE")"
      pane_id="$(printf '%s\\n' "$line" | /usr/bin/cut -d '|' -f 5)"
      command="$(printf '%s\\n' "$line" | /usr/bin/cut -d '|' -f 7-)"
      printf '%s|%s|%s\\n' "$pane_id" "$ORCH_ROOT" "$command"
    fi
    ;;
  has-session)
    session="\${3#=}"
    if /bin/grep -q "^\${session}|" "$ORCH_TEST_TMUX_STATE"; then
      exit 0
    fi
    exit 1
    ;;
  send-keys)
    pane_id="\${3:-}"
    /usr/bin/awk -F '|' -v pane_id="$pane_id" '$5 != pane_id' "$ORCH_TEST_TMUX_STATE" > "$ORCH_TEST_TMUX_STATE.next"
    /bin/mv "$ORCH_TEST_TMUX_STATE.next" "$ORCH_TEST_TMUX_STATE"
    ;;
  kill-server|kill-session)
    printf '%s\\n' 'FORBIDDEN_TMUX_KILL' >> "$ORCH_TEST_COMMAND_LOG"
    : > "$ORCH_TEST_TMUX_STATE"
    exit 97
    ;;
esac
exit 0
`);

  writeExecutable(path.join(binDir, 'ss'), `#!/bin/sh
printf 'ss' >> "$ORCH_TEST_COMMAND_LOG"
printf ' <%s>' "$@" >> "$ORCH_TEST_COMMAND_LOG"
printf '\\n' >> "$ORCH_TEST_COMMAND_LOG"
if [ -s "$ORCH_TEST_SERVICE_STATE" ]; then
  printf 'LISTEN 0 128 0.0.0.0:8787 0.0.0.0:* users:(("node",pid=%s,fd=20))\\n' "$ORCH_TEST_LISTENER_PID"
elif /bin/grep -q '^agent-orchestrator|' "$ORCH_TEST_TMUX_STATE"; then
  printf '%s\\n' 'LISTEN 0 128 0.0.0.0:8787 0.0.0.0:* users:(("node",pid=2002,fd=20))'
fi
exit 0
`);

  writeExecutable(path.join(binDir, 'sudo'), `#!/bin/sh
printf 'sudo' >> "$ORCH_TEST_COMMAND_LOG"
printf ' <%s>' "$@" >> "$ORCH_TEST_COMMAND_LOG"
printf '\\n' >> "$ORCH_TEST_COMMAND_LOG"
exit 0
`);

  writeExecutable(path.join(binDir, 'loginctl'), `#!/bin/sh
printf 'loginctl' >> "$ORCH_TEST_COMMAND_LOG"
printf ' <%s>' "$@" >> "$ORCH_TEST_COMMAND_LOG"
printf '\\n' >> "$ORCH_TEST_COMMAND_LOG"
case " $* " in
  *' show-user '*) printf '%s\\n' "$ORCH_TEST_LINGER" ;;
esac
exit 0
`);

  writeExecutable(path.join(binDir, 'systemd-analyze'), `#!/bin/sh
printf 'systemd-analyze' >> "$ORCH_TEST_COMMAND_LOG"
printf ' <%s>' "$@" >> "$ORCH_TEST_COMMAND_LOG"
printf '\\n' >> "$ORCH_TEST_COMMAND_LOG"
exit 0
`);

  return {
    directory,
    binDir,
    runtimeDir,
    configDir,
    commandLog,
    tmuxState,
    serviceState,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      HOME: directory,
      USER: 'host-control-test',
      XDG_CONFIG_HOME: configDir,
      XDG_RUNTIME_DIR: runtimeDir,
      ORCH_ROOT: projectDir,
      ORCH_NODE_BIN: process.execPath,
      ORCH_SYSTEMD_UNIT: 'agent-orchestrator-test.service',
      ORCH_HEALTH_HOST: '127.0.0.1',
      ORCH_PORT: '8787',
      ORCH_TEST_COMMAND_LOG: commandLog,
      ORCH_TEST_TMUX_STATE: tmuxState,
      ORCH_TEST_SERVICE_STATE: serviceState,
      ORCH_TEST_LISTENER_PID: '4242',
      ORCH_TEST_LINGER: 'yes'
    }
  };
}

function runScript(script, args, fixture) {
  return spawnSync('/bin/bash', [path.join(projectDir, script), ...args], {
    cwd: projectDir,
    env: fixture.env,
    encoding: 'utf8',
    timeout: 5000
  });
}

function readCommandLog(fixture) {
  return existsSync(fixture.commandLog) ? readFileSync(fixture.commandLog, 'utf8') : '';
}

function readTmuxState(fixture) {
  return readFileSync(fixture.tmuxState, 'utf8').trim().split('\n').filter(Boolean);
}

test('dashboard lifecycle sources contain no tmux server or session kill command', () => {
  const files = [
    'scripts/restart-dashboard.sh',
    'scripts/install-control-plane.sh',
    'scripts/watchdog.sh',
    'ops/agent-orchestrator.service.in'
  ];

  for (const relativeFile of files) {
    const source = readFileSync(path.join(projectDir, relativeFile), 'utf8');
    assert.doesNotMatch(source, /\bkill-server\b/, `${relativeFile} must not kill a tmux server`);
    assert.doesNotMatch(source, /\bkill-session\b/, `${relativeFile} must not kill a tmux session`);
  }

  const unit = readFileSync(path.join(projectDir, 'ops/agent-orchestrator.service.in'), 'utf8');
  assert.match(unit, /^ExecStart=@NODE@ @ROOT@\/server\.js$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^KillMode=control-group$/m);
  assert.doesNotMatch(unit, /\btmux\b/);
});

test('control-plane status reports an absent workload tmux server without silently exiting', () => {
  const fixture = lifecycleFixture();
  fixture.env.ORCH_TEST_TMUX_ABSENT = '1';
  writeFileSync(fixture.serviceState, 'running\n');
  const result = runScript('scripts/control-plane-status.sh', [], fixture);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /isolation=ok/);
  assert.match(result.stdout, /workload_tmux=absent/);
  assert.match(result.stdout, /workloads=0/);
});

test('dashboard restart uses systemd and preserves every workload tmux session', () => {
  const fixture = lifecycleFixture();
  const before = readTmuxState(fixture);
  const result = runScript('scripts/restart-dashboard.sh', [], fixture);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /workload tmux inventory unchanged/);
  assert.deepEqual(readTmuxState(fixture), before);

  const commands = readCommandLog(fixture);
  assert.match(commands, /systemctl <--user> <restart> <agent-orchestrator-test\.service>/);
  assert.match(commands, /curl .*<http:\/\/127\.0\.0\.1:8787\/healthz>/);
  assert.doesNotMatch(commands, /tmux <(?:send-keys|new-session|kill-session|kill-server)>/);
  assert.doesNotMatch(commands, /FORBIDDEN_TMUX_KILL/);
});

test('dashboard restart fails closed when the health listener is not owned by MainPID', () => {
  const fixture = lifecycleFixture();
  fixture.env.ORCH_TEST_LISTENER_PID = '9999';
  const before = readTmuxState(fixture);
  const result = runScript('scripts/restart-dashboard.sh', [], fixture);

  assert.equal(result.status, 5);
  assert.match(result.stderr, /listener is not owned by .* MainPID 4242/);
  assert.deepEqual(readTmuxState(fixture), before);

  const commands = readCommandLog(fixture);
  assert.match(commands, /systemctl <--user> <restart> <agent-orchestrator-test\.service>/);
  assert.match(commands, /ss <-H> <-ltnp> <sport = :8787>/);
  assert.doesNotMatch(commands, /tmux <(?:send-keys|new-session|kill-session|kill-server)>/);
});

test('fresh install starts a loopback systemd unit without touching tmux', () => {
  const fixture = lifecycleFixture();
  const before = readTmuxState(fixture);
  const result = runScript('scripts/install-control-plane.sh', [], fixture);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /installed and started .* on 127\.0\.0\.1:8787/);
  assert.deepEqual(readTmuxState(fixture), before);

  const commands = readCommandLog(fixture);
  assert.match(commands, /systemctl <--user> <enable> <agent-orchestrator-test\.service>/);
  assert.match(commands, /systemctl <--user> <start> <agent-orchestrator-test\.service>/);
  assert.doesNotMatch(commands, /tmux/);

  const installedUnit = path.join(fixture.configDir, 'systemd', 'user', 'agent-orchestrator-test.service');
  const unit = readFileSync(installedUnit, 'utf8');
  assert.match(unit, /^Environment=HOST=127\.0\.0\.1$/m);
  assert.match(unit, /^Environment=PORT=8787$/m);
});

test('one-time migration removes only legacy control sessions and preserves a sentinel workload', () => {
  const fixture = lifecycleFixture();
  const result = runScript('scripts/install-control-plane.sh', ['--migrate'], fixture);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /workload tmux inventory unchanged/);
  assert.deepEqual(
    readTmuxState(fixture),
    ['sentinel-workload|$1|100|0.0|%1|1001|codex']
  );

  const commands = readCommandLog(fixture);
  assert.match(commands, /tmux <send-keys> <-t> <%3> <C-c>/);
  assert.match(commands, /tmux <send-keys> <-t> <%2> <C-c>/);
  assert.doesNotMatch(commands, /tmux <send-keys> <-t> <=[^>]+> <C-c>/);
  assert.match(commands, /tmux <list-panes> <-t> <=agent-orchestrator-watchdog> <-F>/);
  assert.match(commands, /tmux <list-panes> <-t> <=agent-orchestrator> <-F>/);
  assert.match(commands, /systemctl <--user> <enable> <agent-orchestrator-test\.service>/);
  assert.match(commands, /systemctl <--user> <start> <agent-orchestrator-test\.service>/);
  assert.doesNotMatch(commands, /tmux <(?:kill-session|kill-server)>/);
  assert.doesNotMatch(commands, /FORBIDDEN_TMUX_KILL/);

  const installedUnit = path.join(fixture.configDir, 'systemd', 'user', 'agent-orchestrator-test.service');
  assert.equal(statSync(installedUnit).mode & 0o777, 0o600);
  const unit = readFileSync(installedUnit, 'utf8');
  assert.match(unit, new RegExp(`^WorkingDirectory=${projectDir.replaceAll('/', '\\/')}$`, 'm'));
  assert.match(unit, new RegExp(`^ExecStart=${process.execPath.replaceAll('/', '\\/')} ${projectDir.replaceAll('/', '\\/')}\\/server\\.js$`, 'm'));
  assert.doesNotMatch(unit, /\btmux\b/);
});

test('migration fails closed before tmux input when persistent user lingering is unavailable', () => {
  const fixture = lifecycleFixture();
  fixture.env.ORCH_TEST_LINGER = 'no';
  const before = readTmuxState(fixture);
  const result = runScript('scripts/install-control-plane.sh', ['--migrate'], fixture);

  assert.equal(result.status, 3);
  assert.match(result.stderr, /user lingering was not enabled; refusing migration/);
  assert.deepEqual(readTmuxState(fixture), before);

  const commands = readCommandLog(fixture);
  assert.match(commands, /sudo <-n> <loginctl> <enable-linger> <host-control-test>/);
  assert.match(commands, /loginctl <show-user> <host-control-test> <-p> <Linger> <--value>/);
  assert.doesNotMatch(commands, /tmux <send-keys>/);
  assert.doesNotMatch(commands, /systemctl <--user> <(?:enable|start)>/);
  assert.doesNotMatch(commands, /FORBIDDEN_TMUX_KILL/);
});

test('legacy watchdog is inert unless its explicit emergency opt-in is set', () => {
  const fixture = lifecycleFixture();
  const result = runScript('scripts/watchdog.sh', [], fixture);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /legacy tmux watchdog is disabled/);
  assert.equal(readCommandLog(fixture), '');
  assert.deepEqual(
    readTmuxState(fixture),
    [
      'sentinel-workload|$1|100|0.0|%1|1001|codex',
      'agent-orchestrator|$2|200|0.0|%2|2002|npm start',
      'agent-orchestrator-watchdog|$3|300|0.0|%3|3003|bash scripts/watchdog.sh'
    ]
  );
});
