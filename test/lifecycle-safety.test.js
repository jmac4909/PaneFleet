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
  symlinkSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { writeExecutable } from './helpers/executables.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');
const LIFECYCLE_SCRIPT_TIMEOUT_MS = 15_000;
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function lifecycleFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'host-control-lifecycle-'));
  temporaryDirectories.push(directory);
  const binDir = path.join(directory, 'bin');
  const runtimeDir = path.join(directory, 'run');
  const configDir = path.join(directory, 'config');
  const commandLog = path.join(directory, 'commands.log');
  const tmuxState = path.join(directory, 'tmux-sessions');
  const serviceState = path.join(directory, 'systemd-service-state');
  const restartHelperState = path.join(directory, 'restart-helper-state');
  const procRoot = path.join(directory, 'proc');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(path.join(procRoot, '4242'), { recursive: true });
  mkdirSync(path.join(procRoot, '5151'), { recursive: true });
  writeFileSync(path.join(procRoot, '4242', 'cgroup'), '0::/dashboard\n');
  writeFileSync(path.join(procRoot, '5151', 'cgroup'), '0::/workloads\n');
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
  *' show panefleet-workloads.service -p ControlGroup --value '*) printf '%s\n' '/workloads' ;;
  *' panefleet-dashboard-restart.timer '*|*' panefleet-dashboard-restart.service '*)
    if [ -s "$ORCH_TEST_RESTART_HELPER_STATE" ]; then printf '%s\\n' 'active'; exit 0; fi
    exit 3
    ;;
  *' restart '*|*' start '*) printf '%s\\n' 'running' > "$ORCH_TEST_SERVICE_STATE" ;;
  *' show '*) printf '%s\\n' '4242' ;;
  *' is-active '*) printf '%s\\n' 'active' ;;
  *' is-enabled '*) printf '%s\\n' 'enabled' ;;
esac
exit 0
`);

  writeExecutable(path.join(binDir, 'systemd-run'), `#!/bin/sh
printf 'systemd-run' >> "$ORCH_TEST_COMMAND_LOG"
printf ' <%s>' "$@" >> "$ORCH_TEST_COMMAND_LOG"
printf '\\n' >> "$ORCH_TEST_COMMAND_LOG"
if [ "$ORCH_TEST_SYSTEMD_RUN_COLLISION" = 1 ]; then
  printf '%s\\n' 'active' > "$ORCH_TEST_RESTART_HELPER_STATE"
  printf '%s\\n' 'Unit panefleet-dashboard-restart.timer was already loaded' >&2
  exit 1
fi
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
if [ "\${1:-}" = '-L' ]; then shift 2; fi
if [ "\${ORCH_TEST_TMUX_ABSENT:-0}" = 1 ]; then
  case "$1" in
    display-message|list-sessions|list-panes|has-session) exit 1 ;;
  esac
fi
case "$1" in
  display-message)
    printf '%s\n' '5151'
    ;;
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

  writeExecutable(path.join(binDir, 'id'), `#!/bin/sh
case "\${1:-}" in
  -u) /usr/bin/id -u ;;
  -un) printf '%s\\n' 'host-control-test' ;;
  *) /usr/bin/id "$@" ;;
esac
`);

  return {
    directory,
    binDir,
    runtimeDir,
    configDir,
    commandLog,
    tmuxState,
    serviceState,
    restartHelperState,
    procRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      HOME: directory,
      USER: 'host-control-test',
      XDG_CONFIG_HOME: configDir,
      XDG_RUNTIME_DIR: runtimeDir,
      ORCH_ROOT: projectDir,
      ORCH_NODE_BIN: process.execPath,
      ORCH_PLANNING_CODEX_MODE: 'disabled',
      ORCH_SYSTEMD_UNIT: 'agent-orchestrator-test.service',
      ORCH_HEALTH_HOST: '127.0.0.1',
      ORCH_PORT: '8787',
      ORCH_TEST_COMMAND_LOG: commandLog,
      ORCH_TEST_TMUX_STATE: tmuxState,
      ORCH_TEST_SERVICE_STATE: serviceState,
      ORCH_TEST_RESTART_HELPER_STATE: restartHelperState,
      ORCH_TEST_SYSTEMD_RUN_COLLISION: '0',
      ORCH_TEST_LISTENER_PID: '4242',
      ORCH_TEST_LINGER: 'yes',
      ORCH_TEST_MODE: '1',
      ORCH_PROC_ROOT: procRoot
    }
  };
}

function runScript(script, args, fixture) {
  return spawnSync('/bin/bash', [path.join(projectDir, script), ...args], {
    cwd: projectDir,
    env: fixture.env,
    encoding: 'utf8',
    timeout: LIFECYCLE_SCRIPT_TIMEOUT_MS
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
    'scripts/schedule-dashboard-restart.sh',
    'scripts/restart-dashboard.sh',
    'scripts/install-control-plane.sh',
    'scripts/isolate-workload-tmux.sh',
    'scripts/run-isolated-agent.sh',
    'scripts/workload-tmux-anchor.sh',
    'ops/agent-orchestrator.service.in',
    'ops/panefleet-workloads.service.in'
  ];

  for (const relativeFile of files) {
    const source = readFileSync(path.join(projectDir, relativeFile), 'utf8');
    assert.doesNotMatch(source, /\bkill-server\b/, `${relativeFile} must not kill a tmux server`);
    assert.doesNotMatch(source, /\bkill-session\b/, `${relativeFile} must not kill a tmux session`);
  }

  const unit = readFileSync(path.join(projectDir, 'ops/agent-orchestrator.service.in'), 'utf8');
  assert.match(unit, /^ExecStart=@NODE@ @ROOT@\/server\.js$/m);
  assert.match(unit, /^Environment="ORCHESTRATOR_PLANNING_CODEX_MODE=@PLANNING_CODEX_MODE@"$/m);
  assert.match(unit, /^Environment="ORCHESTRATOR_PLANNING_CODEX_EXECUTABLE=@PLANNING_CODEX_EXECUTABLE@"$/m);
  assert.match(unit, /^Environment="ORCHESTRATOR_PLANNING_CODEX_VERSION=@PLANNING_CODEX_VERSION@"$/m);
  assert.match(unit, /^Environment="ORCHESTRATOR_PLANNING_CODEX_SHA256=@PLANNING_CODEX_SHA256@"$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^KillMode=control-group$/m);
  for (const directive of [
    'LockPersonality=true',
    'ProtectControlGroups=true',
    'ProtectHostname=true',
    'ProtectKernelTunables=true',
    'RestrictRealtime=true',
    'SystemCallArchitectures=native'
  ]) {
    assert.match(unit, new RegExp(`^${directive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
  assert.doesNotMatch(unit, /^(?:CapabilityBoundingSet|ProtectClock|ProtectKernelLogs|ProtectKernelModules)=/m);
  assert.doesNotMatch(unit, /\btmux\b/);

  assert.match(unit, /^Wants=.*\bpanefleet-workloads\.service\b/m);
  assert.match(unit, /^After=.*\bpanefleet-workloads\.service\b/m);
  const workloadUnit = readFileSync(path.join(projectDir, 'ops/panefleet-workloads.service.in'), 'utf8');
  assert.match(workloadUnit, /^Type=simple$/m);
  assert.match(workloadUnit, /^ExitType=cgroup$/m);
  assert.match(workloadUnit, /^ExecStart=@ROOT@\/scripts\/workload-tmux-anchor\.sh$/m);
  assert.match(workloadUnit, /^KillMode=control-group$/m);
  assert.match(workloadUnit, /^OOMPolicy=continue$/m);
  assert.match(workloadUnit, /^Restart=on-failure$/m);
  assert.match(workloadUnit, /^RestartSec=2$/m);

  const anchor = readFileSync(path.join(projectDir, 'scripts/workload-tmux-anchor.sh'), 'utf8');
  assert.match(anchor, /ensure_server ''/);
  assert.match(anchor, /ensure_server "\$MANAGED_SOCKET"/);
  assert.match(anchor, /while sleep "\$SUPERVISOR_SECONDS"/);
  assert.match(anchor, /start-server \\; set-option -g exit-empty off/);
  assert.doesNotMatch(anchor, /\bnew-session\b/);

  const isolator = readFileSync(path.join(projectDir, 'scripts/isolate-workload-tmux.sh'), 'utf8');
  assert.match(isolator, /cgroup\.procs/);
  assert.match(isolator, /workload inventory changed during cgroup isolation/);
  assert.match(isolator, /dashboard cgroup changed unexpectedly/);
  assert.match(isolator, /panefleet-planning-\[a-f0-9\]\{24\}\\\.scope/);
  assert.doesNotMatch(isolator, /panefleet-planning-\[A-Za-z0-9_/);

  const agentLauncher = readFileSync(path.join(projectDir, 'scripts/run-isolated-agent.sh'), 'utf8');
  assert.match(agentLauncher, /systemd-run --user --scope --quiet --collect/);
  assert.match(agentLauncher, /--property="MemoryHigh=\$MEMORY_HIGH"/);
  assert.match(agentLauncher, /PANEFLEET_AGENT_MEMORY_HIGH/);
  assert.match(agentLauncher, /--property="MemoryMax=\$MEMORY_MAX"/);
  assert.match(agentLauncher, /--property="MemorySwapMax=\$MEMORY_SWAP_MAX"/);
  assert.match(agentLauncher, /--property=TasksMax=256/);
  assert.match(agentLauncher, /--property=ManagedOOMMemoryPressure=auto/);
  assert.match(agentLauncher, /--property=ManagedOOMSwap=auto/);
  assert.doesNotMatch(agentLauncher, /ManagedOOMMemoryPressureLimit/);
  assert.match(agentLauncher, /planning sessions require the dedicated planning launcher/);
  assert.match(agentLauncher, /write_state crashed "\$exit_code"/);
});

test('isolated agent launcher records normal and failed scope exits without interpreting the command', () => {
  const fixture = lifecycleFixture();
  const stateDir = path.join(fixture.directory, 'agent-runtime');
  const env = { ...fixture.env, PANEFLEET_AGENT_STATE_DIR: stateDir };
  const command = 'codex resume 11111111-2222-3333-4444-555555555555 --yolo';
  const planning = spawnSync('/bin/bash', [
    path.join(projectDir, 'scripts/run-isolated-agent.sh'),
    'codex-planning-deadbeef',
    command
  ], {
    cwd: projectDir,
    env,
    encoding: 'utf8',
    timeout: LIFECYCLE_SCRIPT_TIMEOUT_MS
  });
  assert.equal(planning.status, 2);
  assert.match(planning.stderr, /planning sessions require the dedicated planning launcher/);
  assert.equal(existsSync(path.join(stateDir, 'codex-planning-deadbeef.state')), false);

  const normal = spawnSync('/bin/bash', [path.join(projectDir, 'scripts/run-isolated-agent.sh'), 'codex-safe', command], {
    cwd: projectDir,
    env,
    encoding: 'utf8',
    timeout: LIFECYCLE_SCRIPT_TIMEOUT_MS
  });
  assert.equal(normal.status, 0, normal.stderr);
  assert.match(readFileSync(path.join(stateDir, 'codex-safe.state'), 'utf8'), /state=exited\nexit_code=0/);
  const normalLog = readCommandLog(fixture);
  assert.match(normalLog, /systemd-run <--user> <--scope> <--quiet> <--collect>/);
  assert.match(normalLog, /<--property=MemoryHigh=3G>/);
  assert.match(normalLog, /<--property=MemoryMax=4G>/);
  assert.match(normalLog, /<--property=MemorySwapMax=4G>/);
  assert.match(normalLog, /<--property=TasksMax=256>/);
  assert.match(normalLog, /<--property=ManagedOOMMemoryPressure=auto>/);
  assert.match(normalLog, /<--property=ManagedOOMSwap=auto>/);
  assert.match(normalLog, new RegExp(`<bash> <-lc> <${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`));

  fixture.env.ORCH_TEST_SYSTEMD_RUN_COLLISION = '1';
  const failed = spawnSync('/bin/bash', [path.join(projectDir, 'scripts/run-isolated-agent.sh'), 'codex-safe', command], {
    cwd: projectDir,
    env: { ...fixture.env, PANEFLEET_AGENT_STATE_DIR: stateDir },
    encoding: 'utf8',
    timeout: LIFECYCLE_SCRIPT_TIMEOUT_MS
  });
  assert.equal(failed.status, 1);
  assert.match(readFileSync(path.join(stateDir, 'codex-safe.state'), 'utf8'), /state=crashed\nexit_code=1/);
});

test('browser restart scheduling escapes the dashboard cgroup through one fixed user-systemd helper', () => {
  const fixture = lifecycleFixture();
  const before = readTmuxState(fixture);
  const result = runScript('scripts/schedule-dashboard-restart.sh', [], fixture);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /dashboard restart scheduled/);
  assert.deepEqual(readTmuxState(fixture), before);

  const commands = readCommandLog(fixture);
  assert.match(commands, /systemd-run <--user> <--quiet> <--collect> <--unit=panefleet-dashboard-restart> <--on-active=1s>/);
  assert.equal(commands.includes(`<${path.join(projectDir, 'scripts', 'restart-dashboard.sh')}>`), true);
  assert.match(commands, /systemctl <--user> <is-active> <--quiet> <panefleet-dashboard-restart\.timer>/);
  assert.match(commands, /systemctl <--user> <is-active> <--quiet> <panefleet-dashboard-restart\.service>/);
  assert.doesNotMatch(commands, /tmux/);
});

test('browser restart scheduling is idempotent while its fixed helper is active', () => {
  const fixture = lifecycleFixture();
  writeFileSync(fixture.restartHelperState, 'active\n');
  const before = readTmuxState(fixture);
  const result = runScript('scripts/schedule-dashboard-restart.sh', [], fixture);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /dashboard restart already scheduled/);
  assert.deepEqual(readTmuxState(fixture), before);
  const commands = readCommandLog(fixture);
  assert.match(commands, /systemctl <--user> <is-active> <--quiet> <panefleet-dashboard-restart\.timer>/);
  assert.doesNotMatch(commands, /systemd-run|tmux/);
});

test('browser restart scheduling treats a concurrent fixed-helper claim as success', () => {
  const fixture = lifecycleFixture();
  fixture.env.ORCH_TEST_SYSTEMD_RUN_COLLISION = '1';
  const before = readTmuxState(fixture);
  const result = runScript('scripts/schedule-dashboard-restart.sh', [], fixture);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /dashboard restart already scheduled/);
  assert.deepEqual(readTmuxState(fixture), before);
  const commands = readCommandLog(fixture);
  assert.equal((commands.match(/systemd-run/g) || []).length, 1);
  assert.doesNotMatch(commands, /tmux/);
});

test('control-plane status reports an absent workload tmux server without silently exiting', () => {
  const fixture = lifecycleFixture();
  fixture.env.ORCH_TEST_TMUX_ABSENT = '1';
  writeFileSync(fixture.serviceState, 'running\n');
  const result = runScript('scripts/control-plane-status.sh', [], fixture);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /isolation=attention/);
  assert.match(result.stdout, /workload_tmux=absent/);
  assert.match(result.stdout, /workload_cgroup=absent/);
  assert.match(result.stdout, /workloads=0/);
  assert.match(result.stdout, /managed_tmux=absent/);
  assert.match(result.stdout, /managed_cgroup=absent/);
});

test('control-plane status reports a separate workload cgroup', () => {
  const fixture = lifecycleFixture();
  writeFileSync(fixture.tmuxState, 'sentinel-workload|$1|100|0.0|%1|1001|codex\n');
  writeFileSync(fixture.serviceState, 'running\n');
  const result = runScript('scripts/control-plane-status.sh', [], fixture);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /isolation=ok/);
  assert.match(result.stdout, /workload_tmux=present/);
  assert.match(result.stdout, /workload_cgroup=separate/);
  assert.match(result.stdout, /managed_tmux=present/);
  assert.match(result.stdout, /managed_cgroup=separate/);
});

test('lifecycle helpers reject unsafe systemd unit names before filesystem or host mutation', () => {
  for (const script of ['scripts/install-control-plane.sh', 'scripts/restart-dashboard.sh', 'scripts/control-plane-status.sh']) {
    const fixture = lifecycleFixture();
    fixture.env.ORCH_SYSTEMD_UNIT = '../unsafe.service';
    const before = readTmuxState(fixture);
    const result = runScript(script, [], fixture);

    assert.equal(result.status, 2, `${script}: ${result.stderr || result.stdout}`);
    assert.match(result.stderr, /invalid ORCH_SYSTEMD_UNIT/);
    assert.equal(readCommandLog(fixture), '');
    assert.deepEqual(readTmuxState(fixture), before);
    assert.equal(existsSync(path.join(fixture.configDir, 'systemd', 'unsafe.service')), false);
  }
});

test('status and restart helpers reject unsafe workload systemd unit names', () => {
  for (const script of ['scripts/restart-dashboard.sh', 'scripts/control-plane-status.sh']) {
    const fixture = lifecycleFixture();
    fixture.env.ORCH_WORKLOAD_SYSTEMD_UNIT = '../unsafe.service';
    const result = runScript(script, [], fixture);

    assert.equal(result.status, 2, `${script}: ${result.stderr || result.stdout}`);
    assert.match(result.stderr, /invalid ORCH_WORKLOAD_SYSTEMD_UNIT/);
    assert.equal(readCommandLog(fixture), '');
  }
});

test('installer rejects unsafe configuration base paths before creating a user unit', () => {
  const cases = [
    { name: 'relative config home', environment: { XDG_CONFIG_HOME: 'relative-config' }, error: /invalid XDG_CONFIG_HOME/ },
    { name: 'multiline home', environment: { HOME: '/tmp/unsafe\nhome' }, error: /invalid HOME/ }
  ];
  for (const testCase of cases) {
    const fixture = lifecycleFixture();
    Object.assign(fixture.env, testCase.environment);
    const before = readTmuxState(fixture);
    const result = runScript('scripts/install-control-plane.sh', [], fixture);

    assert.equal(result.status, 2, `${testCase.name}: ${result.stderr || result.stdout}`);
    assert.match(result.stderr, testCase.error);
    assert.equal(readCommandLog(fixture), '');
    assert.deepEqual(readTmuxState(fixture), before);
  }
});

test('access-token display rejects unsafe files and server-invalid token contents', () => {
  const fixture = lifecycleFixture();
  const tokenPath = path.join(fixture.directory, 'access-token');
  fixture.env.ORCHESTRATOR_ACCESS_TOKEN_FILE = tokenPath;
  const validToken = 'a'.repeat(24);
  const scriptSource = readFileSync(path.join(projectDir, 'scripts', 'show-access-token.sh'), 'utf8');
  assert.match(scriptSource, /exec \{token_fd\}<"\$TOKEN_FILE"/);
  assert.match(scriptSource, /\/proc\/self\/fd\/\$token_fd/);
  assert.match(scriptSource, /cat <&"\$token_fd"/);
  assert.doesNotMatch(scriptSource, /token="\$\(<"\$TOKEN_FILE"\)"/);

  writeFileSync(tokenPath, `${validToken}\n`);
  for (const mode of [0o400, 0o600]) {
    chmodSync(tokenPath, mode);
    const valid = runScript('scripts/show-access-token.sh', [], fixture);
    assert.equal(valid.status, 0, `${mode.toString(8)}: ${valid.stderr}`);
    assert.equal(valid.stdout, `${validToken}\n`);
  }

  for (const mode of [0o200, 0o644, 0o700]) {
    chmodSync(tokenPath, mode);
    const invalidMode = runScript('scripts/show-access-token.sh', [], fixture);
    assert.equal(invalidMode.status, 2, mode.toString(8));
    assert.match(invalidMode.stderr, /owned by the current user with mode 400 or 600/);
  }

  rmSync(tokenPath);
  const targetPath = path.join(fixture.directory, 'token-target');
  writeFileSync(targetPath, `${validToken}\n`);
  chmodSync(targetPath, 0o600);
  symlinkSync(targetPath, tokenPath);
  const symlinked = runScript('scripts/show-access-token.sh', [], fixture);
  assert.equal(symlinked.status, 1);
  assert.match(symlinked.stderr, /missing or unsafe/);

  rmSync(tokenPath);
  writeFileSync(tokenPath, `${validToken}\n${'b'.repeat(24)}\n`);
  chmodSync(tokenPath, 0o600);
  const multiline = runScript('scripts/show-access-token.sh', [], fixture);
  assert.equal(multiline.status, 3);
  assert.match(multiline.stderr, /access token file is invalid/);

  writeFileSync(tokenPath, `${'c'.repeat(513)}\n`);
  const oversized = runScript('scripts/show-access-token.sh', [], fixture);
  assert.equal(oversized.status, 3);
  assert.match(oversized.stderr, /access token file is invalid/);
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

test('dashboard restart refuses to stop a shared workload cgroup', () => {
  const fixture = lifecycleFixture();
  writeFileSync(path.join(fixture.procRoot, '5151', 'cgroup'), '0::/dashboard\n');
  const before = readTmuxState(fixture);
  const result = runScript('scripts/restart-dashboard.sh', [], fixture);

  assert.equal(result.status, 7, result.stderr || result.stdout);
  assert.match(result.stderr, /workload tmux shares the PaneFleet cgroup/);
  assert.deepEqual(readTmuxState(fixture), before);
  const commands = readCommandLog(fixture);
  assert.doesNotMatch(commands, /systemctl <--user> <restart>/);
  assert.doesNotMatch(commands, /tmux <(?:send-keys|new-session|kill-session|kill-server)>/);
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

test('dashboard restart rejects a symlinked fallback lock directory before lifecycle mutation', () => {
  const fixture = lifecycleFixture();
  const temporaryRoot = path.join(fixture.directory, 'temporary');
  const redirectTarget = path.join(fixture.directory, 'redirect-target');
  mkdirSync(temporaryRoot);
  mkdirSync(redirectTarget);
  const lockDirectory = path.join(temporaryRoot, `panefleet-runtime-${process.getuid()}`);
  symlinkSync(redirectTarget, lockDirectory);
  delete fixture.env.XDG_RUNTIME_DIR;
  fixture.env.TMPDIR = temporaryRoot;
  const before = readTmuxState(fixture);
  const result = runScript('scripts/restart-dashboard.sh', [], fixture);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /unsafe restart lock directory/);
  assert.equal(readCommandLog(fixture), '');
  assert.deepEqual(readTmuxState(fixture), before);
  assert.equal(existsSync(path.join(redirectTarget, 'agent-orchestrator-restart.lock')), false);
});

test('dashboard restart rejects a relative temporary root before creating its fallback lock', () => {
  const fixture = lifecycleFixture();
  delete fixture.env.XDG_RUNTIME_DIR;
  fixture.env.TMPDIR = `relative-temporary-${path.basename(fixture.directory)}`;
  const unintendedPath = path.join(projectDir, fixture.env.TMPDIR);
  const before = readTmuxState(fixture);
  const result = runScript('scripts/restart-dashboard.sh', [], fixture);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /unsafe restart temporary directory/);
  assert.equal(readCommandLog(fixture), '');
  assert.deepEqual(readTmuxState(fixture), before);
  assert.equal(existsSync(unintendedPath), false);
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
  assert.match(unit, /^Environment="ORCHESTRATOR_PLANNING_CODEX_MODE=disabled"$/m);
  assert.match(unit, /^Environment="ORCHESTRATOR_PLANNING_CODEX_EXECUTABLE="$/m);
  assert.match(unit, /^Environment="ORCHESTRATOR_PLANNING_CODEX_VERSION="$/m);
  assert.match(unit, /^Environment="ORCHESTRATOR_PLANNING_CODEX_SHA256="$/m);
  assert.doesNotMatch(unit, /@[A-Z_]+@/);
});

test('installer records the canonical native Planning Codex version and SHA-256 pin', () => {
  const fixture = lifecycleFixture();
  const source = path.join(fixture.directory, 'planning-codex.c');
  const specialDirectory = path.join(fixture.directory, 'Planning % "quoted" back\\slash & pipe|');
  mkdirSync(specialDirectory);
  const executable = path.join(specialDirectory, 'planning codex');
  writeFileSync(source, [
    '#include <stdio.h>',
    '#include <string.h>',
    'int main(int argc, char **argv) {',
    '  if (argc == 2 && strcmp(argv[1], "--version") == 0) { puts("codex-cli 0.147.0"); return 0; }',
    '  return 97;',
    '}',
    ''
  ].join('\n'));
  const compiled = spawnSync('/usr/bin/cc', ['-O2', '-s', '-o', executable, source], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  chmodSync(executable, 0o700);
  fixture.env.ORCH_PLANNING_CODEX_MODE = 'required';
  fixture.env.ORCH_PLANNING_CODEX_EXECUTABLE = executable;
  const injectedMarker = path.join(fixture.directory, 'node-options-loaded');
  const injectedModule = path.join(fixture.directory, 'node-options.cjs');
  writeFileSync(injectedModule, `require('node:fs').writeFileSync(${JSON.stringify(injectedMarker)}, 'loaded');\n`);
  fixture.env.NODE_OPTIONS = `--require=${injectedModule}`;
  fixture.env.NODE_PATH = path.join(fixture.directory, 'untrusted-node-path');

  const result = runScript('scripts/install-control-plane.sh', [], fixture);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const installedUnit = path.join(fixture.configDir, 'systemd', 'user', 'agent-orchestrator-test.service');
  const unit = readFileSync(installedUnit, 'utf8');
  const digest = createHash('sha256').update(readFileSync(executable)).digest('hex');
  const escapedExecutable = executable
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%');
  assert.match(unit, /^Environment="ORCHESTRATOR_PLANNING_CODEX_MODE=required"$/m);
  assert.ok(unit.includes(`Environment="ORCHESTRATOR_PLANNING_CODEX_EXECUTABLE=${escapedExecutable}"`));
  assert.match(unit, /^Environment="ORCHESTRATOR_PLANNING_CODEX_VERSION=0\.147\.0"$/m);
  assert.ok(unit.includes(`Environment="ORCHESTRATOR_PLANNING_CODEX_SHA256=${digest}"`));
  assert.equal(existsSync(injectedMarker), false, 'installer must not pass NODE_OPTIONS to Node');
  assert.doesNotMatch(unit, /@[A-Z_]+@/);
});

test('required Planning resolution failure leaves an existing unit and workload inventory untouched', () => {
  const fixture = lifecycleFixture();
  fixture.env.ORCH_PLANNING_CODEX_MODE = 'required';
  fixture.env.ORCH_PLANNING_CODEX_EXECUTABLE = 'relative/unverified-codex';
  const unitDirectory = path.join(fixture.configDir, 'systemd', 'user');
  const unitPath = path.join(unitDirectory, 'agent-orchestrator-test.service');
  mkdirSync(unitDirectory, { recursive: true });
  writeFileSync(unitPath, 'existing-unit-must-remain\n', { mode: 0o600 });
  const before = readTmuxState(fixture);

  const result = runScript('scripts/install-control-plane.sh', [], fixture);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Planning Codex resolution failed/);
  assert.equal(readFileSync(unitPath, 'utf8'), 'existing-unit-must-remain\n');
  assert.equal(readCommandLog(fixture), '');
  assert.deepEqual(readTmuxState(fixture), before);
});

test('installer rejects an unknown Planning Codex mode before systemd or tmux mutation', () => {
  const fixture = lifecycleFixture();
  fixture.env.ORCH_PLANNING_CODEX_MODE = 'automatic';
  const before = readTmuxState(fixture);
  const result = runScript('scripts/install-control-plane.sh', [], fixture);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid ORCH_PLANNING_CODEX_MODE/);
  assert.equal(readCommandLog(fixture), '');
  assert.deepEqual(readTmuxState(fixture), before);
});

test('install refuses an unsupported Node runtime before systemd or tmux mutation', () => {
  const fixture = lifecycleFixture();
  const unsupportedNode = path.join(fixture.binDir, 'node-unsupported');
  writeExecutable(unsupportedNode, `#!/bin/sh
if [ "\${1:-}" = '-p' ]; then printf '%s\\n' '19'; exit 0; fi
exit 97
`);
  fixture.env.ORCH_NODE_BIN = unsupportedNode;
  const before = readTmuxState(fixture);
  const result = runScript('scripts/install-control-plane.sh', [], fixture);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Node\.js 20 or newer is required/);
  assert.equal(readCommandLog(fixture), '');
  assert.deepEqual(readTmuxState(fixture), before);
  assert.equal(existsSync(path.join(fixture.configDir, 'systemd', 'user', 'agent-orchestrator-test.service')), false);
});

test('one-time migration removes only legacy control sessions and preserves a sentinel workload', () => {
  const fixture = lifecycleFixture();
  fixture.env.USER = 'misleading-environment-user';
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

test('legacy watchdog entrypoint stays retired while migration still recognizes its old session', () => {
  assert.equal(existsSync(path.join(projectDir, 'scripts', 'watchdog.sh')), false);
  const installer = readFileSync(path.join(projectDir, 'scripts', 'install-control-plane.sh'), 'utf8');
  assert.match(installer, /stop_legacy_session agent-orchestrator-watchdog 'scripts\/watchdog\.sh'/);
});
