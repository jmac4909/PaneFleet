import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { stopChildProcess } from './helpers/child-process.js';
import { installBlockedTool, installExecutable } from './helpers/executables.js';
import { fetchWithTimeout, responseJson, waitForHttpServer } from './helpers/http.js';
import { waitForCondition } from './helpers/timing.js';
import { unusedLoopbackPort } from './helpers/unused-loopback-port.js';
import { createDeliveryPlanningRunRepository } from '../delivery-planning-run-store.js';
import { planningRoleReportOutputDigest } from '../planning-role-report.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');
const roles = ['po', 'ba', 'qa', 'dev'];
const defaultPlanId = 'plan-planning-bound-12345678';
const defaultStartOperationId = 'start-planning-bound-0001';

function discoverHostNativeCodex() {
  try {
    const wrapper = realpathSync(execFileSync('mise', ['which', 'codex'], { encoding: 'utf8' }).trim());
    const packageRoot = path.resolve(path.dirname(wrapper), '..');
    const platform = process.platform === 'linux'
      ? process.arch === 'x64'
        ? { packageName: 'codex-linux-x64', triple: 'x86_64-unknown-linux-musl' }
        : process.arch === 'arm64'
          ? { packageName: 'codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' }
          : null
      : null;
    if (!platform) return null;
    const executable = realpathSync(path.join(
      packageRoot,
      'node_modules',
      '@openai',
      platform.packageName,
      'vendor',
      platform.triple,
      'bin',
      'codex'
    ));
    const versionOutput = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
    const version = versionOutput.match(/^codex-cli (\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/)?.[1] || '';
    return version ? { executable, version } : null;
  } catch {
    return null;
  }
}

const hostNativeCodex = discoverHostNativeCodex();
function planningCodexConfig(planningRuntimeRoot) {
  const planningContextRoot = path.join(planningRuntimeRoot, 'contexts');
  return [
    'default_permissions = "planning-prompt-only"',
    'project_doc_max_bytes = 0',
    'project_doc_fallback_filenames = []',
    'developer_instructions = ""',
    'notify = []',
    'hooks = {}',
    '',
    `[projects.${JSON.stringify(planningContextRoot)}]`,
    'trust_level = "trusted"',
    '',
    '[shell_environment_policy]',
    'inherit = "none"',
    'ignore_default_excludes = false',
    'experimental_use_profile = false',
    '',
    '[permissions.planning-prompt-only.filesystem]',
    '":root" = "deny"',
    '":minimal" = "read"',
    '',
    '[permissions.planning-prompt-only.network]',
    'enabled = false',
    ''
  ].join('\n');
}

const disabledPlanningFeatures = [
  'hooks',
  'shell_snapshot',
  'shell_tool',
  'unified_exec',
  'code_mode',
  'code_mode_host',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'image_generation',
  'view_image',
  'workspace_dependencies',
  'multi_agent',
  'multi_agent_v2',
  'memories',
  'goals',
  'tool_suggest',
  'apps',
  'plugins',
  'remote_plugin',
  'plugin_sharing',
  'skill_search',
  'skill_mcp_dependency_install',
  'in_app_browser'
];

function planningWorkerCommand(fixture) {
  return [
  fixture.planningCodexExecutable,
  '--strict-config',
  '--ask-for-approval never',
  ...disabledPlanningFeatures.map((feature) => `--disable ${feature}`),
  '--config hooks={}',
  '--config shell_environment_policy.inherit="none"',
  '--config shell_environment_policy.ignore_default_excludes=false',
  '--config shell_environment_policy.experimental_use_profile=false',
  '--config tools.web_search=false',
  '--config model_provider="openai"',
  '--model gpt-test-alpha',
  '--config model_reasoning_effort=xhigh'
  ].join(' ');
}

const ARTIFACTS = Object.freeze({
  po: {
    user: 'PaneFleet operator',
    problem: 'Unstructured delivery can drift before implementation begins.',
    outcome: 'A four-role delivery plan is ready for explicit operator review.',
    value: 'Reduce avoidable failures without broadening execution authority.',
    nonGoals: ['Do not edit, approve, execute, commit, push, deploy, or use network access.'],
    assumptions: ['The operator owns the final approval decision.'],
    openQuestions: []
  },
  ba: {
    requirements: [{ id: 'REQ-001', text: 'Persist exact role bindings and accept only exact rollout-authored reports.' }],
    dependencies: ['The existing Delivery Plan repository'],
    edgeCases: ['A pane or Codex process is replaced after dispatch.'],
    constraints: ['Never retry uncertain terminal input.'],
    openQuestions: []
  },
  qa: {
    acceptanceCriteria: [{
      id: 'AC-001',
      text: 'All four exact reports are required before candidate synthesis.',
      requirementIds: ['REQ-001']
    }],
    testStrategy: 'Exercise durable dispatch, exact rollout results, cleanup, replay, and apply.',
    regressionChecks: ['No generic Prompt or Mission record is created.'],
    releaseRequired: false,
    releaseChecks: [],
    openQuestions: []
  },
  dev: {
    architecture: 'Use a strict Planning Run state machine behind a CAS repository.',
    steps: [{
      id: 'STEP-001',
      title: 'Implement the bounded planning lifecycle',
      outcome: 'Exact role reports synthesize one reviewable Plan patch.',
      requirementIds: ['REQ-001'],
      scopePaths: ['server.js', 'test/planning-bound-dispatch.test.js'],
      checks: ['node --test test/planning-bound-dispatch.test.js']
    }],
    risks: ['An uncertain terminal outcome must stop without a retry.'],
    rollback: 'Remove the isolated Planning Run integration before activation.',
    openQuestions: []
  }
});

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function canonicalSha256(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function initializeGitWorkspace(workspace) {
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, 'tracked.txt'), 'baseline\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'fixture.invalid'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'PaneFleet Fixture'], { cwd: workspace });
  execFileSync('git', ['add', 'tracked.txt'], { cwd: workspace });
  execFileSync('git', ['commit', '-q', '-m', 'fixture baseline'], { cwd: workspace });
}

function workerIndex(role) {
  return roles.indexOf(role) + 1;
}

function rolloutId(role) {
  const index = workerIndex(role);
  return `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`;
}

function installFixtureTools(fixture) {
  for (const name of ['aws', 'curl', 'journalctl', 'ss']) installBlockedTool(fixture.binDir, name);

  const planningCodexSource = path.join(fixture.root, 'codex-planning-fixture.c');
  const planningCodexBinary = path.join(fixture.binDir, 'codex-planning-fixture');
  fixture.nativeInvocationLog = path.join(fixture.root, 'native-codex-invocations.log');
  writeFileSync(planningCodexSource, [
    '#include <stdio.h>',
    '#include <string.h>',
    'int main(int argc, char **argv) {',
    `  FILE *trace = fopen(${JSON.stringify(fixture.nativeInvocationLog)}, "a");`,
    '  if (trace) { fprintf(trace, "%s\\n", argc > 1 ? argv[1] : "(none)"); fclose(trace); }',
    '  if (argc == 2 && strcmp(argv[1], "--version") == 0) {',
    '    puts("codex-cli 0.147.0");',
    '    return 0;',
    '  }',
    '  if (argc == 4 && strcmp(argv[1], "mcp") == 0 && strcmp(argv[2], "list") == 0 && strcmp(argv[3], "--json") == 0) {',
    '    puts("[]");',
    '    return 0;',
    '  }',
    '  fputs("fixture planning Codex must only execute the MCP preflight\\n", stderr);',
    '  return 97;',
    '}',
    ''
  ].join('\n'));
  execFileSync('/usr/bin/cc', ['-O2', '-s', '-o', planningCodexBinary, planningCodexSource]);
  chmodSync(planningCodexBinary, 0o700);

  installExecutable(fixture.binDir, 'systemctl', `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const eventPath = process.env.PLANNING_TMUX_EVENT_PATH;
function log(event) { fs.appendFileSync(eventPath, JSON.stringify({ ...event, at: new Date().toISOString() }) + '\\n'); }
log({ type: 'systemctl', argv: args });
if (args[0] !== '--user') process.exit(97);
if (args[1] === 'is-active') {
  if (args.at(-1) === 'panefleet-workloads.service') process.exit(0);
  if (!/^panefleet-planning-[a-f0-9]{24}\\.scope$/.test(args.at(-1))) process.exit(97);
  let state = { mode: 'absent', scopeActive: false };
  try { state = JSON.parse(fs.readFileSync(process.env.PLANNING_TMUX_STATE_PATH, 'utf8')); } catch {}
  const requested = args.at(-1);
  if (state.scopeObservationUnavailable === true && state.scopeUnit === requested) process.exit(97);
  if (
    (state.scopeUnit === requested && state.scopeActive === true)
    || (state.extraPlanningScopes || []).includes(requested)
  ) {
    process.stdout.write('active\\n');
    process.exit(0);
  }
  process.stdout.write('inactive\\n');
  process.exit(3);
}
if (args[1] === 'list-units') {
  let state = { mode: 'absent', extraPlanningScopes: [] };
  try { state = JSON.parse(fs.readFileSync(process.env.PLANNING_TMUX_STATE_PATH, 'utf8')); } catch {}
  const units = [
    ...((state.scopeUnit && state.scopeActive === true) ? [state.scopeUnit] : []),
    ...(state.extraPlanningScopes || [])
  ];
  for (const unit of [...new Set(units)]) {
    process.stdout.write(unit + ' loaded active running Fixture Planning scope\\n');
  }
  process.exit(0);
}
if (args[1] === 'stop') {
  const requested = args[2];
  if (!/^panefleet-planning-[a-f0-9]{24}\\.scope$/.test(requested)) process.exit(97);
  let state = { mode: 'absent', extraPlanningScopes: [] };
  try { state = JSON.parse(fs.readFileSync(process.env.PLANNING_TMUX_STATE_PATH, 'utf8')); } catch {}
  log({ type: 'scope-stop', scopeUnit: requested });
  if (state.scopeStopFailure === true) {
    process.stderr.write('fixture scope stop failed\\n');
    process.exit(97);
  }
  if (state.scopeUnit === requested) {
    state = { ...state, mode: 'absent', role: '', session: '', input: '', scopeActive: false };
  }
  state.extraPlanningScopes = (state.extraPlanningScopes || []).filter((unit) => unit !== requested);
  fs.writeFileSync(process.env.PLANNING_TMUX_STATE_PATH, JSON.stringify(state));
  process.exit(0);
}
if (args[1] !== 'show') process.exit(97);
const unit = args[2];
if (unit === 'panefleet-workloads.service') {
  process.stdout.write(process.env.PLANNING_WORKLOAD_CGROUP + '\\n');
  process.exit(0);
}
if (!/^panefleet-planning-[a-f0-9]{24}\\.scope$/.test(unit)) process.exit(97);
process.stdout.write([
  'ControlGroup=/user.slice/planning.slice/' + unit,
  'MemoryHigh=734003200',
  'MemoryMax=1153433600',
  'MemorySwapMax=1073741824',
  'TasksMax=256',
  'RuntimeMaxUSec=30min',
  'TimeoutStopUSec=30s',
  'KillMode=control-group',
  'KillSignal=15',
  'SendSIGHUP=no',
  'SendSIGKILL=yes',
  'FinalKillSignal=9',
  'ManagedOOMMemoryPressure=kill',
  'ManagedOOMMemoryPressureLimit=80%',
  'ManagedOOMSwap=kill'
].join('\\n') + '\\n');
`);

  installExecutable(fixture.binDir, 'ps', `#!/usr/bin/env node
const fs = require('node:fs');
let state = { mode: 'absent', role: '' };
try { state = JSON.parse(fs.readFileSync(process.env.PLANNING_TMUX_STATE_PATH, 'utf8')); } catch {}
const roles = ['po', 'ba', 'qa', 'dev'];
const index = Math.max(0, roles.indexOf(state.role));
const panePid = 4201 + index;
const tty = 'pts/' + (81 + index);
const workerPids = JSON.parse(process.env.PLANNING_WORKER_PIDS);
const scopeOnlyPid = Number(process.env.PLANNING_SCOPE_ONLY_PID || 987654321);
let codexActive = state.mode !== 'absent'
  && !['shell', 'shell_typed', 'transient_missing', 'dead'].includes(state.mode);
if (state.mode === 'attestation_failure') {
  const observations = Number(state.processObservations || 0);
  if (observations >= 1) {
    codexActive = false;
    state = { ...state, mode: 'absent', role: '', session: '', input: '', scopeActive: false };
  } else {
    state.processObservations = observations + 1;
  }
  fs.writeFileSync(process.env.PLANNING_TMUX_STATE_PATH, JSON.stringify(state));
}
const args = process.argv.slice(2).join(' ');
if (args.includes('pid,ppid,tty,stat,pcpu,pmem,rss,cmd')) {
  console.log('PID PPID TT STAT %CPU %MEM RSS CMD');
  if (state.mode === 'scope_only') {
    console.log(scopeOnlyPid + ' 1 ? S+ 0.0 0.2 2000 ' + process.env.PLANNING_WORKER_COMMAND);
  } else {
    if (state.mode !== 'absent') console.log(panePid + ' 1 ' + tty + ' Ss 0.0 0.1 1000 bash');
    if (codexActive) console.log(workerPids[state.role] + ' ' + panePid + ' ' + tty + ' S+ 0.0 0.2 2000 ' + process.env.PLANNING_WORKER_COMMAND);
  }
} else if (args.includes('pid,ppid,stat,etime,pcpu,pmem,rss,cmd')) {
  console.log('PID PPID STAT ELAPSED %CPU %MEM RSS CMD');
  if (state.mode === 'scope_only') {
    console.log(scopeOnlyPid + ' 1 S+ 00:01 0.0 0.2 2000 ' + process.env.PLANNING_WORKER_COMMAND);
  } else if (codexActive) console.log(workerPids[state.role] + ' ' + panePid + ' S+ 00:01 0.0 0.2 2000 ' + process.env.PLANNING_WORKER_COMMAND);
} else {
  process.exitCode = 97;
}
`);

  installExecutable(fixture.binDir, 'tmux', `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const statePath = process.env.PLANNING_TMUX_STATE_PATH;
const eventPath = process.env.PLANNING_TMUX_EVENT_PATH;
const promptDir = process.env.PLANNING_PROMPT_DIR;
const planningContexts = JSON.parse(process.env.PLANNING_CONTEXTS);
const roles = ['po', 'ba', 'qa', 'dev'];
function readState() { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return { mode: 'absent', role: '', session: '', input: '' }; } }
function save(state) { fs.writeFileSync(statePath, JSON.stringify(state)); }
function log(event) { fs.appendFileSync(eventPath, JSON.stringify({ ...event, at: new Date().toISOString() }) + '\\n'); }
function roleDetails(role) {
  const index = Math.max(0, roles.indexOf(role));
  return { created: 1700000101 + index, panePid: 4201 + index, tty: '/dev/pts/' + (81 + index), tmuxPane: '%' + (81 + index) };
}
let managedSocket = '';
if (args[0] === '-L') {
  managedSocket = String(args[1] || '');
  args.splice(0, 2);
  if (managedSocket !== 'host-control-managed') process.exit(97);
}
const command = args[0] || '';
let state = readState();
if (managedSocket) {
  if (command === 'display-message') {
    log({ type: 'managed-display-message', argv: args, pid: process.env.PLANNING_TMUX_SERVER_PID || '' });
    console.log(process.env.PLANNING_TMUX_SERVER_PID);
    process.exit(0);
  }
  if (command === 'has-session' || command === 'list-panes') process.exit(1);
  if (command === 'new-session') process.exit(97);
  process.exit(97);
}
if (command === 'has-session') {
  const wanted = String(args[2] || '').replace(/^=/, '');
  if (state.mode !== 'absent' && state.session === wanted) process.exit(0);
  process.stderr.write("can't find session: " + wanted + '\\n');
  process.exit(1);
}
if (command === 'display-message') {
  log({ type: 'display-message', argv: args, pid: process.env.PLANNING_TMUX_SERVER_PID || '' });
  console.log(process.env.PLANNING_TMUX_SERVER_PID);
  process.exit(0);
}
if (command === 'list-sessions') {
  const sessions = [
    ...(state.mode !== 'absent' && state.session ? [state.session] : []),
    ...(state.extraPlanningSessions || [])
  ];
  for (const session of [...new Set(sessions)]) console.log(session);
  process.exit(0);
}
if (command === 'new-session') {
  const session = args[args.indexOf('-s') + 1];
  const role = roles.find((item) => session.endsWith('-' + item)) || '';
  if (!role || state.mode !== 'absent') process.exit(97);
  const scopeUnit = String(args.find((item) => item.startsWith('--unit=')) || '').slice('--unit='.length);
  if (!/^panefleet-planning-[a-f0-9]{24}\.scope$/.test(scopeUnit)) process.exit(97);
  const workerPids = JSON.parse(process.env.PLANNING_WORKER_PIDS);
  const procDir = path.join(process.env.PLANNING_PROC_ROOT, String(workerPids[role]));
  fs.mkdirSync(procDir, { recursive: true });
  fs.writeFileSync(path.join(procDir, 'cgroup'), '0::/user.slice/planning.slice/' + scopeUnit + '\\n');
  const paneProcDir = path.join(process.env.PLANNING_PROC_ROOT, String(roleDetails(role).panePid));
  fs.mkdirSync(paneProcDir, { recursive: true });
  fs.writeFileSync(path.join(paneProcDir, 'cgroup'), '0::/user.slice/planning.slice/' + scopeUnit + '\\n');
  const cgroupDir = path.join(process.env.PLANNING_CGROUP_ROOT, 'user.slice', 'planning.slice', scopeUnit);
  fs.mkdirSync(cgroupDir, { recursive: true });
  fs.writeFileSync(
    path.join(cgroupDir, 'cgroup.procs'),
    roleDetails(role).panePid + '\\n' + workerPids[role] + '\\n'
  );
  state = {
    ...state,
    mode: process.env.PLANNING_TMUX_NEW_MODE || 'idle',
    swapProcessImageOnMarker: process.env.PLANNING_TMUX_NEW_MODE === 'process_image_swap',
    swapProcessImageAfterSetOption: process.env.PLANNING_TMUX_NEW_MODE === 'pre_literal_process_image_swap',
    failPromptEnter: process.env.PLANNING_TMUX_NEW_MODE === 'enter_failure',
    role,
    session,
    input: '',
    scopeUnit,
    scopeActive: true
  };
  save(state);
  log({ type: 'new-session', role, session, argv: args });
  process.exit(0);
}
if (command === 'list-panes') {
  if (state.listPanesUnavailable === true) process.exit(97);
  if (state.mode === 'absent') process.exit(args[1] === '-a' ? 0 : 1);
  if (args[1] === '-a' && state.hidePlanningPaneFromGlobal === true) process.exit(0);
  const baseDetails = roleDetails(state.role);
  const details = state.replacement === true
    ? {
        ...baseDetails,
        created: baseDetails.created + 500,
        panePid: baseDetails.panePid + 500,
        tty: '/dev/pts/' + (Number(baseDetails.tty.split('/').at(-1)) + 500),
        tmuxPane: '%' + (Number(baseDetails.tmuxPane.slice(1)) + 500)
      }
    : baseDetails;
  const currentCommand = 'codex-planning-fixture';
  const currentPath = planningContexts[state.role];
  const dead = state.mode === 'dead' ? 1 : 0;
  if (args[1] === '-a') {
    console.log([state.session, details.created, 0, 0, 0, 1, details.panePid, details.tty, details.tmuxPane, dead, dead ? 1 : '', currentCommand, currentPath, 'Planning Worker'].join('|'));
  } else {
    const wanted = String(args[2] || '').replace(/^=/, '');
    if (wanted !== state.session) process.exit(1);
    console.log([state.session, details.created, 0, 0, 1, currentCommand, currentPath, details.tmuxPane, details.panePid, details.tty, dead, dead ? 1 : ''].join('|'));
  }
  process.exit(0);
}
if (command === 'kill-pane') {
  const details = roleDetails(state.role);
  const wanted = args[args.indexOf('-t') + 1];
  if (state.mode !== 'dead' || wanted !== details.tmuxPane) process.exit(97);
  log({ type: 'dead-pane-reaped', role: state.role, argv: args });
  state = { ...state, mode: 'absent', role: '', session: '', input: '', scopeActive: false };
  save(state);
  process.exit(0);
}
if (command === 'set-option') {
  log({ type: 'protect', role: state.role, argv: args });
  if (state.failSetOption === true) process.exit(97);
  if (state.swapProcessImageAfterSetOption === true) {
    const workerPids = JSON.parse(process.env.PLANNING_WORKER_PIDS);
    const exePath = path.join(process.env.PLANNING_PROC_ROOT, String(workerPids[state.role]), 'exe');
    try { fs.unlinkSync(exePath); } catch {}
    fs.symlinkSync('/usr/bin/true', exePath);
    state.swapProcessImageAfterSetOption = false;
    log({ type: 'process-image-swap-before-literal', role: state.role });
  }
  if (state.replaceAfterSetOption === true) {
    state.replacement = true;
    state.replaceAfterSetOption = false;
    save(state);
  }
  process.exit(0);
}
if (command === 'capture-pane') {
  if (state.mode === 'absent') process.exit(1);
  if (state.mode === 'typed' || state.mode === 'cleanup_typed') {
    log({
      type: 'capture-typed',
      role: state.role,
      chars: state.input.length,
      hasPlanningMarker: state.input.includes('[PaneFleet Planning Dispatch planning-attempt-')
    });
    console.log('OpenAI Codex');
    console.log('› ' + (state.mode === 'cleanup_typed' ? '/exit' : state.input));
    console.log('gpt-test-alpha high · 100% left');
  } else if (state.mode === 'accepted') {
    console.log('OpenAI Codex');
    console.log('› ' + state.input);
    console.log('Working (1s)');
    console.log('esc to interrupt');
  } else {
    console.log('OpenAI Codex');
    console.log('› Ask Codex anything');
    console.log('gpt-test-alpha high · 100% left');
    if (Number.isSafeInteger(state.becomeBusyAfterIdleCaptures)) {
      state.becomeBusyAfterIdleCaptures -= 1;
      if (state.becomeBusyAfterIdleCaptures <= 0) state.mode = 'accepted';
      save(state);
    }
  }
  process.exit(0);
}
if (command === 'send-keys') {
  const literalIndex = args.indexOf('-l');
  if (literalIndex >= 0) {
    const value = args[literalIndex + 1] || '';
    if (value === '/exit' && state.failCleanupLiteral === true) {
      log({ type: 'cleanup-literal-failed', role: state.role });
      process.exit(97);
    }
    if (value === '/exit') state.mode = 'cleanup_typed';
    else if (value === 'exit' && state.mode === 'shell') state.mode = 'shell_typed';
    else {
      if (state.mode !== 'typed') state.input = '';
      state.input += value;
      state.mode = 'typed';
    }
    const swapProcessImage = state.swapProcessImageOnMarker === true
      && state.input.includes('[PaneFleet Planning Dispatch planning-attempt-');
    if (swapProcessImage) {
      const workerPids = JSON.parse(process.env.PLANNING_WORKER_PIDS);
      const exePath = path.join(process.env.PLANNING_PROC_ROOT, String(workerPids[state.role]), 'exe');
      try { fs.unlinkSync(exePath); } catch {}
      fs.symlinkSync('/usr/bin/true', exePath);
      state.swapProcessImageOnMarker = false;
      log({ type: 'process-image-swap', role: state.role });
    }
    save(state);
    log({ type: 'literal', role: state.role, chars: value.length, value: value === '/exit' || value === 'exit' ? value : '' });
    process.exit(0);
  }
  if (args.at(-1) === 'C-m') {
    if (state.failPromptEnter === true && state.mode === 'typed') {
      log({ type: 'prompt-enter-failed', role: state.role, chars: state.input.length });
      process.exit(97);
    }
    if (state.mode === 'typed') {
      fs.writeFileSync(path.join(promptDir, state.role + '.txt'), state.input);
      state.mode = 'accepted';
      log({ type: 'prompt-enter', role: state.role, chars: state.input.length });
    } else if (state.mode === 'cleanup_typed') {
      if (state.failCleanupEnter === true) {
        log({ type: 'cleanup-enter-failed', role: state.role });
        process.exit(97);
      }
      log({ type: 'codex-exit-enter', role: state.role });
      state.mode = 'absent';
      state.scopeActive = false;
    } else process.exit(97);
    save(state);
    process.exit(0);
  }
  log({ type: 'unexpected-send', argv: args });
  process.exit(97);
}
log({ type: 'unexpected', argv: args });
process.exit(97);
`);
}

function createFixture({ planningExecutablePath = '', planningVersion = '0.147.0' } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'panefleet-planning-bound-'));
  const planningRuntimeRoot = mkdtempSync(path.join(os.tmpdir(), 'panefleet-planning-neutral-'));
  const dataDir = path.join(root, 'data');
  const publicDir = path.join(root, 'public');
  const binDir = path.join(root, 'bin');
  const codexHome = path.join(root, 'codex-home');
  const planningCodexHome = path.join(planningRuntimeRoot, 'codex-home');
  const expectedPlanningCodexConfig = planningCodexConfig(planningRuntimeRoot);
  const planningHomeDir = path.join(planningRuntimeRoot, 'home');
  const sessionsDir = path.join(planningCodexHome, 'sessions', '2026', '08', '16');
  const procRoot = path.join(root, 'proc');
  const cgroupRoot = path.join(root, 'cgroup');
  const projectsRoot = path.join(root, 'projects');
  const workspace = path.join(projectsRoot, 'planning-workspace');
  const promptDir = path.join(root, 'prompts');
  for (const directory of [
    dataDir,
    publicDir,
    binDir,
    codexHome,
    planningCodexHome,
    planningHomeDir,
    sessionsDir,
    procRoot,
    cgroupRoot,
    projectsRoot,
    promptDir
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  for (const directory of [dataDir, planningRuntimeRoot, planningCodexHome, planningHomeDir]) {
    chmodSync(directory, 0o700);
  }
  writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>Planning dispatch fixture</title>\n');
  writeFileSync(path.join(root, 'services.json'), '[]\n');
  writeFileSync(path.join(root, 'host-config.json'), '{}\n');
  writeFileSync(path.join(root, 'AGENTS.md'), 'Host-local fixture rules.\n');
  writeFileSync(path.join(projectsRoot, 'AGENTS.md'), 'Project-local fixture rules.\n');
  writeFileSync(path.join(codexHome, 'models_cache.json'), `${JSON.stringify({
    models: [{
      slug: 'gpt-test-alpha',
      display_name: 'GPT Test Alpha',
      description: 'Synthetic planning model',
      visibility: 'list',
      default_reasoning_level: 'xhigh',
      supported_reasoning_levels: [{ effort: 'high' }, { effort: 'xhigh' }]
    }]
  })}\n`);
  writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-test-alpha"\nmodel_reasoning_effort = "xhigh"\n');
  writeFileSync(path.join(codexHome, 'auth.json'), '{"auth_mode":"chatgpt","fixture":"source-auth"}\n', { mode: 0o600 });
  chmodSync(path.join(codexHome, 'auth.json'), 0o600);
  writeFileSync(path.join(planningCodexHome, 'config.toml'), expectedPlanningCodexConfig, { mode: 0o600 });
  chmodSync(path.join(planningCodexHome, 'config.toml'), 0o600);
  writeFileSync(path.join(root, 'meminfo'), [
    'MemTotal:        2048000 kB',
    'MemAvailable:    1536000 kB',
    'SwapTotal:       1048576 kB',
    'SwapFree:        1048576 kB',
    ''
  ].join('\n'));
  writeFileSync(path.join(root, 'pressure'), [
    'some avg10=0.00 avg60=0.00 avg300=0.00 total=0',
    'full avg10=0.00 avg60=0.00 avg300=0.00 total=0',
    ''
  ].join('\n'));
  writeFileSync(path.join(root, 'tmux-state.json'), JSON.stringify({ mode: 'absent', role: '', session: '', input: '' }));
  initializeGitWorkspace(workspace);

  const fixture = {
    root,
    planningRuntimeRoot,
    dataDir,
    publicDir,
    binDir,
    codexHome,
    planningCodexHome,
    planningHomeDir,
    procRoot,
    cgroupRoot,
    projectsRoot,
    workspace,
    promptDir,
    toolLogPath: path.join(root, 'tools.log'),
    eventPath: path.join(root, 'tmux-events.jsonl'),
    tmuxStatePath: path.join(root, 'tmux-state.json'),
    planPath: path.join(dataDir, 'delivery-plans.json'),
    runPath: path.join(dataDir, 'delivery-runs.json'),
    planningRunPath: path.join(dataDir, 'delivery-planning-runs.json'),
    missionPath: path.join(dataDir, 'mission-queue.json'),
    promptQueuePath: path.join(dataDir, 'prompt-queue.json')
  };
  installFixtureTools(fixture);
  fixture.planningCodexExecutable = realpathSync(
    planningExecutablePath || path.join(binDir, 'codex-planning-fixture')
  );
  fixture.planningCodexVersion = planningVersion;
  const executableDetails = statSync(fixture.planningCodexExecutable);
  fixture.planningExecutableSha256 = createHash('sha256')
    .update(readFileSync(fixture.planningCodexExecutable))
    .digest('hex');
  fixture.planningExecutableDigest = canonicalSha256({
    sha256: fixture.planningExecutableSha256,
    version: fixture.planningCodexVersion,
    device: executableDetails.dev,
    inode: executableDetails.ino,
    size: executableDetails.size,
    mode: executableDetails.mode & 0o777
  });
  fixture.planningConfigDigest = createHash('sha256').update(expectedPlanningCodexConfig).digest('hex');
  fixture.planningRunId = `planning-run-${canonicalSha256({
    operationId: defaultStartOperationId,
    planId: defaultPlanId
  }).slice(0, 24)}`;
  fixture.planningContexts = Object.fromEntries(roles.map((role) => {
    const context = path.join(
      planningRuntimeRoot,
      'contexts',
      canonicalSha256({ runId: fixture.planningRunId, role }).slice(0, 32)
    );
    for (const directory of [
      context,
      path.join(context, 'tmp'),
      path.join(context, 'xdg-cache'),
      path.join(context, 'xdg-config'),
      path.join(context, 'xdg-data'),
      path.join(context, 'xdg-state')
    ]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    return [role, context];
  }));

  const workerProcesses = [];
  const workerPids = {};
  const rolloutPaths = {};
  const workloadTmuxPid = 4400;
  const scopeOnlyPid = 987654321;
  const workloadCgroup = '/user.slice/workloads.slice/panefleet-workloads.service';
  mkdirSync(path.join(procRoot, String(workloadTmuxPid)), { recursive: true });
  writeFileSync(path.join(procRoot, String(workloadTmuxPid), 'cgroup'), `0::${workloadCgroup}\n`);
  for (const role of roles) {
    const id = rolloutId(role);
    const rolloutPath = path.join(sessionsDir, `rollout-${id}.jsonl`);
    const observedAt = new Date().toISOString();
    writeFileSync(rolloutPath, [
      JSON.stringify({ timestamp: observedAt, type: 'session_meta', payload: { id } }),
      JSON.stringify({
        timestamp: observedAt,
        type: 'turn_context',
        payload: { approval_policy: 'never', sandbox_policy: { type: 'read-only' } }
      })
    ].join('\n') + '\n');
    const context = fixture.planningContexts[role];
    const child = spawn('/usr/bin/env', ['-u', 'NODE_V8_COVERAGE', process.execPath, '-e', `
      const fs = require('node:fs');
      const fd = fs.openSync(process.argv[1], 'r');
      process.on('SIGTERM', () => { fs.closeSync(fd); process.exit(0); });
      setInterval(() => {}, 1000);
    `, rolloutPath], {
      cwd: context,
      env: {
        BASH_ENV: '',
        CODEX_HOME: planningCodexHome,
        ENV: '',
        HOME: planningHomeDir,
        LANG: 'C.UTF-8',
        PANEFLEET_PLANNING_CONFIG_DIGEST: fixture.planningConfigDigest,
        PANEFLEET_PLANNING_EXECUTABLE_DIGEST: fixture.planningExecutableDigest,
        PATH: '/usr/local/bin:/usr/bin:/bin',
        TERM: 'xterm-256color',
        TMPDIR: path.join(context, 'tmp'),
        XDG_CACHE_HOME: path.join(context, 'xdg-cache'),
        XDG_CONFIG_HOME: path.join(context, 'xdg-config'),
        XDG_DATA_HOME: path.join(context, 'xdg-data'),
        XDG_STATE_HOME: path.join(context, 'xdg-state')
      },
      stdio: 'ignore'
    });
    workerProcesses.push(child);
    workerPids[role] = child.pid;
    rolloutPaths[role] = rolloutPath;
    mkdirSync(path.join(procRoot, String(child.pid)), { recursive: true });
    symlinkSync(
      fixture.planningCodexExecutable,
      path.join(procRoot, String(child.pid), 'exe')
    );
    writeFileSync(
      path.join(procRoot, String(child.pid), 'cgroup'),
      '0::/user.slice/planning.slice/unbound.scope\n'
    );
  }

  Object.assign(fixture, {
    workerProcesses,
    workerPids,
    rolloutPaths,
    workloadTmuxPid,
    scopeOnlyPid,
    workloadCgroup
  });
  return fixture;
}

async function startFixture(fixture, {
  monitor = true,
  newSessionMode = '',
  spawnBindMs = 10_000,
  planningCodexMode = 'required',
  planningCodexExecutable = fixture.planningCodexExecutable,
  planningCodexVersion = fixture.planningCodexVersion,
  planningCodexSha256 = fixture.planningExecutableSha256
} = {}) {
  const port = await unusedLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
    cwd: fixture.root,
    env: {
      ...process.env,
      HOME: fixture.root,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      ORCHESTRATOR_RUNTIME_ROOT: fixture.root,
      ORCHESTRATOR_HOST_CONFIG: path.join(fixture.root, 'host-config.json'),
      ORCHESTRATOR_PROJECTS_ROOT: fixture.projectsRoot,
      ORCHESTRATOR_AGENT_WORKSPACES_ROOT: path.join(fixture.projectsRoot, 'agent-workspaces'),
      ORCHESTRATOR_MEMINFO_PATH: path.join(fixture.root, 'meminfo'),
      ORCHESTRATOR_MEMORY_PRESSURE_PATH: path.join(fixture.root, 'pressure'),
      ORCHESTRATOR_PLANNING_RUNTIME_ROOT: fixture.planningRuntimeRoot,
      ORCHESTRATOR_PLANNING_PROC_ROOT: fixture.procRoot,
      ORCHESTRATOR_PLANNING_CGROUP_ROOT: fixture.cgroupRoot,
      ORCH_PROC_ROOT: fixture.procRoot,
      ORCHESTRATOR_PLANNING_CODEX_MODE: planningCodexMode,
      ORCHESTRATOR_PLANNING_CODEX_EXECUTABLE: planningCodexExecutable,
      ORCHESTRATOR_PLANNING_CODEX_VERSION: planningCodexVersion,
      ORCHESTRATOR_PLANNING_CODEX_SHA256: planningCodexSha256,
      ORCH_CONTROL_PLANE_MODE: 'systemd-user',
      ORCH_WORKLOAD_SYSTEMD_UNIT: 'panefleet-workloads.service',
      ORCH_TOOL_LOG: fixture.toolLogPath,
      CODEX_HOME: fixture.codexHome,
      DELIVERY_PLAN_PATH: fixture.planPath,
      DELIVERY_RUN_PATH: fixture.runPath,
      DELIVERY_PLANNING_RUN_PATH: fixture.planningRunPath,
      MISSION_QUEUE_PATH: fixture.missionPath,
      PROMPT_QUEUE_PATH: fixture.promptQueuePath,
      PLANNING_WORKER_PIDS: JSON.stringify(fixture.workerPids),
      PLANNING_SCOPE_ONLY_PID: String(fixture.scopeOnlyPid),
      PLANNING_WORKER_COMMAND: planningWorkerCommand(fixture),
      PLANNING_CONTEXTS: JSON.stringify(fixture.planningContexts),
      PLANNING_TMUX_SERVER_PID: String(fixture.workloadTmuxPid),
      PLANNING_PROC_ROOT: fixture.procRoot,
      PLANNING_CGROUP_ROOT: fixture.cgroupRoot,
      PLANNING_WORKLOAD_CGROUP: fixture.workloadCgroup,
      PLANNING_SECRET_SENTINEL: 'must-not-reach-planning-wrapper-or-worker',
      PLANNING_TMUX_STATE_PATH: fixture.tmuxStatePath,
      PLANNING_TMUX_EVENT_PATH: fixture.eventPath,
      PLANNING_PROMPT_DIR: fixture.promptDir,
      PLANNING_TMUX_NEW_MODE: newSessionMode,
      PATH: `${fixture.binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      AWS_EC2_METADATA_DISABLED: 'true',
      INITIAL_PROMPT_READY_MS: '500',
      MISSION_LITERAL_CONFIRM_MS: '3000',
      MISSION_SUBMIT_CONFIRM_MS: '3000',
      MISSION_CONFIRM_SAMPLE_MS: '20',
      CODEX_RUNTIME_SETTLE_MS: '20',
      PLANNING_RUN_MONITOR_TEST: monitor ? '1' : '0',
      PLANNING_RUN_MONITOR_MS: '250',
      PLANNING_SPAWN_BIND_MS: String(spawnBindMs),
      SNAPSHOT_EVENT_MS: '3600000',
      PROMPT_QUEUE_MONITOR_MS: '3600000',
      SSH_RESCUE_MONITOR_MS: '3600000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  mkdirSync(path.join(fixture.procRoot, String(child.pid)), { recursive: true });
  writeFileSync(
    path.join(fixture.procRoot, String(child.pid), 'cgroup'),
    '0::/user.slice/control-plane.slice/agent-orchestrator.service\n'
  );
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await waitForHttpServer({
      baseUrl,
      child,
      output: () => output,
      label: 'Planning Run bound fixture',
      timeoutMs: 30_000
    });
    const index = await fetchWithTimeout(`${baseUrl}/`, {}, 3000);
    const cookie = String(index.headers.get('set-cookie') || '').split(';', 1)[0];
    assert.match(cookie, /^host_control_session=/);
    return { child, baseUrl, cookie, output: () => output };
  } catch (error) {
    await Promise.allSettled([
      stopChildProcess(child),
      ...fixture.workerProcesses.map((worker) => stopChildProcess(worker))
    ]);
    throw error;
  }
}

async function api(runtime, pathname, { method = 'GET', body } = {}) {
  const headers = { cookie: runtime.cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetchWithTimeout(`${runtime.baseUrl}${pathname}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }, 30000);
  return { response, json: await responseJson(response) };
}

function planningPlan(workspace, baseline, id = 'plan-planning-bound-12345678') {
  return {
    version: 1,
    id,
    revision: 1,
    phase: 'planning',
    title: 'Build an exact multi-role Planning Run',
    request: `PRIVATE_PLANNING_SENTINEL ${'bounded-context '.repeat(240)}`,
    workspace,
    baseline,
    classification: {
      intent: 'build',
      depth: 'standard',
      risk: 'local_reversible',
      dataClasses: [],
      mutationSurfaces: ['workspace']
    },
    roles: {
      po: {
        user: 'PaneFleet operator',
        problem: 'The initial problem statement needs governed refinement.',
        outcome: 'A candidate is reviewable before implementation.',
        value: 'Reduce delivery drift.',
        nonGoals: ['No implementation or external side effects.'],
        assumptions: [],
        openQuestions: []
      },
      ba: {
        requirements: [{ id: 'REQ-OLD', text: 'Replace this draft requirement.' }],
        dependencies: [],
        edgeCases: [],
        constraints: [],
        openQuestions: []
      },
      dev: {
        architecture: 'Replace this draft architecture.',
        steps: [{
          id: 'STEP-OLD',
          title: 'Replace draft',
          outcome: 'A complete implementation plan exists.',
          requirementIds: ['REQ-OLD'],
          scopePaths: ['tracked.txt'],
          checks: ['git diff --check']
        }],
        risks: [],
        rollback: 'Discard the draft.',
        openQuestions: []
      },
      qa: {
        acceptanceCriteria: [{ id: 'AC-OLD', text: 'Replace this draft criterion.', requirementIds: ['REQ-OLD'] }],
        testStrategy: 'Replace this draft strategy.',
        regressionChecks: ['Existing Plan storage remains valid.'],
        releaseRequired: false,
        releaseChecks: [],
        openQuestions: []
      }
    },
    unresolvedQuestions: [],
    authority: {
      workspaceWrite: true,
      commit: false,
      push: false,
      deploy: false,
      network: false,
      serviceControl: false,
      destructive: false,
      externalMessages: false
    },
    approval: { digest: '', approvedAt: null, planRevision: null },
    gates: { implementationCaptured: false, qaPassed: false, releaseVerified: false },
    blocker: ''
  };
}

async function createAndStartPlanningRun(runtime, fixture, {
  planId = defaultPlanId,
  createOperationId = 'create-planning-helper-0001',
  startOperationId = defaultStartOperationId
} = {}) {
  const baseline = await api(runtime, '/api/delivery-plans/baseline', {
    method: 'POST', body: { workspace: fixture.workspace }
  });
  assert.equal(baseline.response.status, 200, JSON.stringify(baseline.json));
  const plan = planningPlan(fixture.workspace, baseline.json.baseline, planId);
  const created = await api(runtime, '/api/delivery-plans', {
    method: 'POST',
    body: { operationId: createOperationId, expectedStoreRevision: 0, plan }
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.json));
  const startBody = {
    operationId: startOperationId,
    expectedPlanStoreRevision: created.json.storeRevision,
    expectedPlanRevision: created.json.plan.revision,
    expectedDigest: created.json.digest,
    expectedPlanningRunStoreRevision: 0,
    confirmation: 'start-multi-role-planning'
  };
  const started = await api(runtime, `/api/delivery-plans/${plan.id}/planning-runs`, {
    method: 'POST', body: startBody
  });
  return { baseline, plan, created, startBody, started };
}

function events(fixture) {
  try {
    return readFileSync(fixture.eventPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function planningStore(fixture) {
  return JSON.parse(readFileSync(fixture.planningRunPath, 'utf8'));
}

function currentRun(fixture) {
  return planningStore(fixture).runs[0];
}

function setWorkerIdle(fixture, role) {
  const state = JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8'));
  assert.equal(state.role, role);
  state.mode = 'idle_result';
  writeFileSync(fixture.tmuxStatePath, JSON.stringify(state));
}

function replacePlanningProcessExecutable(fixture, role, target) {
  const executablePath = path.join(fixture.procRoot, String(fixture.workerPids[role]), 'exe');
  rmSync(executablePath, { force: true });
  symlinkSync(target, executablePath);
}

function planningReport(run, role, attemptId, artifact = ARTIFACTS[role]) {
  return {
    version: 1,
    runId: run.id,
    planId: run.planId,
    planRevision: run.planRevision,
    role,
    attemptId,
    inputDigest: run.roles[role].inputDigest,
    status: 'complete',
    artifact: structuredClone(artifact),
    challenges: [],
    evidence: [{ summary: `${role.toUpperCase()} inspected only the bounded planning input.`, trusted: false }]
  };
}

function appendRoleResult(fixture, run, role, artifact = ARTIFACTS[role]) {
  const attempt = run.roles[role].attempts.at(-1);
  const baseMs = Date.parse(attempt.submittedAt) + 100;
  const report = planningReport(run, role, attempt.id, artifact);
  const finalText = `[PANEFLEET PLANNING RESULT]\n${JSON.stringify(report)}\n[/PANEFLEET PLANNING RESULT]`;
  appendFileSync(fixture.rolloutPaths[role], [
    JSON.stringify({
      timestamp: new Date(baseMs).toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `Bound planning prompt\n${attempt.confirmationMarker}` }]
      }
    }),
    JSON.stringify({
      timestamp: new Date(baseMs + 1).toISOString(),
      type: 'turn_context',
      payload: { approval_policy: 'never', sandbox_policy: { type: 'read-only' } }
    }),
    JSON.stringify({
      timestamp: new Date(baseMs + 2).toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: finalText }]
      }
    })
  ].join('\n') + '\n');
}

async function waitForRole(fixture, role) {
  try {
    return await waitForCondition(() => {
      const run = currentRun(fixture);
      return run.roles[role].state === 'dispatched' ? run : null;
    }, { intervalMs: 50, timeoutMs: 40000, label: `${role} exact planning dispatch` });
  } catch (error) {
    const run = currentRun(fixture);
    throw new Error(`${error.message}; phase=${run.phase}; condition=${run.condition}; roles=${JSON.stringify(
      Object.fromEntries(roles.map((item) => [item, {
        state: run.roles[item].state,
        cleanup: run.roles[item].attempts.at(-1)?.cleanup?.state || ''
      }]))
    )}; events=${JSON.stringify(events(fixture).slice(-12))}`);
  }
}

async function cleanupFixture(fixture, runtime) {
  const stopped = await Promise.allSettled([
    // Coverage collection is flushed by server.js during its graceful SIGTERM
    // shutdown. The full Planning lifecycle produces a large V8 payload, so
    // allow that exact fixture server to finish before the generic helper's
    // two-second SIGKILL fallback would discard its exercised branches.
    ...(runtime ? [stopChildProcess(runtime.child, 15_000)] : []),
    ...fixture.workerProcesses.map((child) => stopChildProcess(child))
  ]);
  rmSync(fixture.root, { recursive: true, force: true });
  rmSync(fixture.planningRuntimeRoot, { recursive: true, force: true });
  const failures = stopped.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Planning fixture cleanup failed');
}

test('Planning Run dispatches exact read-only PO, BA, QA, DEV reports, then applies only its candidate', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture);
    const baseline = await api(runtime, '/api/delivery-plans/baseline', {
      method: 'POST', body: { workspace: fixture.workspace }
    });
    assert.equal(baseline.response.status, 200, JSON.stringify(baseline.json));
    const plan = planningPlan(fixture.workspace, baseline.json.baseline);
    const created = await api(runtime, '/api/delivery-plans', {
      method: 'POST',
      body: { operationId: 'create-planning-bound-0001', expectedStoreRevision: 0, plan }
    });
    assert.equal(created.response.status, 200, JSON.stringify(created.json));
    const startBody = {
      operationId: 'start-planning-bound-0001',
      expectedPlanStoreRevision: created.json.storeRevision,
      expectedPlanRevision: created.json.plan.revision,
      expectedDigest: created.json.digest,
      expectedPlanningRunStoreRevision: 0,
      confirmation: 'start-multi-role-planning'
    };
    const started = await api(runtime, `/api/delivery-plans/${plan.id}/planning-runs`, {
      method: 'POST', body: startBody
    });
    assert.equal(
      started.response.status,
      200,
      `${JSON.stringify(started.json)}\n${runtime.output()}\n${JSON.stringify(events(fixture).slice(-16))}`
    );
    assert.equal(started.json.planningRun.roles.po.state, 'dispatched');
    const runId = started.json.planningRun.id;
    const persistedPoAttempt = currentRun(fixture).roles.po.attempts[0];
    const poSession = persistedPoAttempt.session;
    assert.equal(started.json.planningRun.roles.po.attempts[0].session, undefined);
    assert.equal(started.json.planningRun.roles.po.attempts[0].id, undefined);
    assert.match(persistedPoAttempt.scopeUnit, /^panefleet-planning-[a-f0-9]{24}\.scope$/);
    assert.match(persistedPoAttempt.scopeDigest, /^[a-f0-9]{64}$/);
    for (const forbiddenKey of [
      'rolloutPath', 'confirmationMarker', 'promptDigest', 'paneTty', 'sourceId',
      'codexPid', 'commandDigest', 'scopeUnit', 'scopeDigest'
    ]) assert.doesNotMatch(JSON.stringify(started.json), new RegExp(`"${forbiddenKey}"`));
    assert.doesNotMatch(JSON.stringify(started.json), new RegExp(fixture.planningRuntimeRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const prompt = readFileSync(path.join(fixture.promptDir, 'po.txt'), 'utf8');
    assert.ok(prompt.length > 4000, `expected a >4k internal planning prompt, got ${prompt.length}`);
    assert.match(prompt, /PaneFleet multi-role planning assignment/);
    assert.match(prompt, /\[PaneFleet Planning Dispatch planning-attempt-/);

    const blockedControls = [
      ['/api/agent/send', { session: poSession, text: 'generic input must be blocked' }],
      ['/api/prompt-queue', { session: poSession, text: 'queued input must be blocked' }],
      ['/api/agent/touch', { session: poSession }],
      ['/api/agent/ui-key', { session: poSession, key: 'down' }],
      ['/api/agent/resume', { session: poSession }],
      ['/api/agent/interrupt', { session: poSession, confirm: 'interrupt' }],
      [`/api/session/${encodeURIComponent(poSession)}/stop`, { confirm: 'stop' }]
    ];
    for (const [pathname, body] of blockedControls) {
      const blocked = await api(runtime, pathname, { method: 'POST', body });
      assert.equal(blocked.response.status, 409, `${pathname}: ${JSON.stringify(blocked.json)}`);
      assert.equal(blocked.json.error, 'planning_run_worker_control_managed');
    }
    const exactTarget = {
      session: poSession,
      sessionCreatedAt: persistedPoAttempt.sessionCreatedAt,
      paneId: persistedPoAttempt.paneId,
      tmuxPaneId: persistedPoAttempt.tmuxPaneId,
      panePid: persistedPoAttempt.panePid
    };
    const otherTarget = {
      session: 'codex-nonexistent-other',
      sessionCreatedAt: persistedPoAttempt.sessionCreatedAt,
      paneId: 'codex-nonexistent-other:0.0',
      tmuxPaneId: '%999',
      panePid: 99999
    };
    for (const [pathname, confirm] of [
      ['/api/agent/send-batch', 'send-multiple'],
      ['/api/prompt-queue/batch', 'queue-multiple']
    ]) {
      const blocked = await api(runtime, pathname, {
        method: 'POST',
        body: { confirm, targets: [exactTarget, otherTarget], text: 'generic batch input must be blocked' }
      });
      assert.equal(blocked.response.status, 409, `${pathname}: ${JSON.stringify(blocked.json)}`);
      assert.equal(blocked.json.error, 'planning_run_worker_control_managed');
    }
    const capture = await api(runtime, `/api/pane/${encodeURIComponent(poSession)}/capture`);
    assert.equal(capture.response.status, 409, JSON.stringify(capture.json));
    assert.equal(capture.json.error, 'planning_run_worker_control_managed');
    const projectDesk = await api(runtime, `/api/project-desk/${encodeURIComponent(poSession)}`);
    assert.equal(projectDesk.response.status, 409, JSON.stringify(projectDesk.json));
    assert.equal(projectDesk.json.error, 'planning_run_worker_control_managed');
    const snapshot = await api(runtime, '/api/snapshot');
    assert.equal(snapshot.response.status, 200, JSON.stringify(snapshot.json));
    assert.doesNotMatch(JSON.stringify(snapshot.json.panes), new RegExp(poSession));
    assert.doesNotMatch(JSON.stringify(snapshot.json.agents), new RegExp(poSession));
    assert.doesNotMatch(JSON.stringify(snapshot.json.topProcesses), new RegExp(poSession));
    assert.doesNotMatch(JSON.stringify(snapshot.json.topProcesses), new RegExp(persistedPoAttempt.scopeUnit));
    assert.doesNotMatch(
      JSON.stringify(snapshot.json.topProcesses),
      new RegExp(fixture.planningCodexExecutable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
    assert.ok(snapshot.json.audit.every((entry) => (
      !String(entry.action || '').startsWith('delivery_planning_run.')
    )));
    assert.doesNotMatch(JSON.stringify(snapshot.json), new RegExp(persistedPoAttempt.id));

    const reviewStart = await api(runtime, '/api/review/start', { method: 'POST', body: {} });
    assert.equal(reviewStart.response.status, 500, JSON.stringify(reviewStart.json));
    const reviewContext = readFileSync(
      path.join(fixture.dataDir, 'reviews', 'latest-context.md'),
      'utf8'
    );
    for (const privateSentinel of [
      persistedPoAttempt.id,
      poSession,
      persistedPoAttempt.scopeUnit,
      fixture.planningCodexExecutable
    ]) assert.doesNotMatch(
      reviewContext,
      new RegExp(privateSentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
    assert.doesNotMatch(reviewContext, new RegExp(`pid=${persistedPoAttempt.codexPid}\\b`));

    const unrelatedPlan = planningPlan(fixture.workspace, baseline.json.baseline, 'plan-planning-other-12345678');
    unrelatedPlan.request = 'Advance only the global Plan store for Start replay coverage.';
    const unrelated = await api(runtime, '/api/delivery-plans', {
      method: 'POST',
      body: { operationId: 'create-planning-other-0001', expectedStoreRevision: 1, plan: unrelatedPlan }
    });
    assert.equal(unrelated.response.status, 200, JSON.stringify(unrelated.json));
    const startReplay = await api(runtime, `/api/delivery-plans/${plan.id}/planning-runs`, {
      method: 'POST', body: startBody
    });
    assert.equal(startReplay.response.status, 200, JSON.stringify(startReplay.json));
    assert.equal(startReplay.json.replayed, true);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter' && event.role === 'po').length, 1);

    for (const role of roles) {
      const dispatched = role === 'po' ? currentRun(fixture) : await waitForRole(fixture, role);
      setWorkerIdle(fixture, role);
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(currentRun(fixture).roles[role].state, 'dispatched', 'pane text without rollout final must not complete');
      appendRoleResult(fixture, dispatched, role);
      if (role !== 'dev') await waitForRole(fixture, roles[roles.indexOf(role) + 1]);
    }

    const candidate = await waitForCondition(() => {
      const run = currentRun(fixture);
      return run.phase === 'review' ? run : null;
    }, { intervalMs: 50, timeoutMs: 40000, label: 'compiled Planning Run candidate' });
    assert.equal(candidate.condition, 'active');
    assert.equal(candidate.candidate.readiness.ready, true);
    assert.deepEqual(candidate.candidate.definitionPatch.roles, ARTIFACTS);
    assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 4);
    for (const role of roles) {
      assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter' && event.role === role).length, 1);
      assert.equal(events(fixture).filter((event) => event.type === 'codex-exit-enter' && event.role === role).length, 1);
      assert.ok(events(fixture).some((event) => (
        event.type === 'protect'
        && event.role === role
        && event.argv.includes('remain-on-exit')
        && event.argv.at(-1) === 'off'
      )));
    }
    const launchEvents = events(fixture).filter((event) => event.type === 'new-session');
    for (const event of launchEvents) {
      const launchStart = event.argv.indexOf('/usr/bin/env');
      const commandIndex = event.argv.indexOf('/usr/bin/systemd-run');
      assert.ok(launchStart > 0 && commandIndex > launchStart, JSON.stringify(event.argv));
      const launchArgv = event.argv.slice(launchStart);
      const commandArgv = event.argv.slice(commandIndex);
      assert.deepEqual(launchArgv.slice(0, commandIndex - launchStart), [
        '/usr/bin/env',
        '-i',
        'BASH_ENV=',
        `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${process.getuid()}/bus`,
        'ENV=',
        `HOME=${fixture.planningHomeDir}`,
        'LANG=C.UTF-8',
        'PATH=/usr/local/bin:/usr/bin:/bin',
        `XDG_RUNTIME_DIR=/run/user/${process.getuid()}`
      ]);
      assert.doesNotMatch(launchArgv.join('\n'), /PLANNING_SECRET_SENTINEL|must-not-reach-planning-wrapper-or-worker/);
      assert.ok(commandArgv.length > 30, 'Planning worker must be passed as multiple direct argv entries');
      assert.equal(commandArgv[0], '/usr/bin/systemd-run');
      assert.ok(commandArgv.includes('--scope'));
      assert.ok(commandArgv.includes('/usr/bin/env'));
      assert.ok(commandArgv.includes('-i'));
      assert.ok(commandArgv.includes(fixture.planningCodexExecutable));
      assert.ok(!commandArgv.includes('mcp'));
      assert.ok(!commandArgv.includes('--version'));
      assert.ok(commandArgv.includes('--strict-config'));
      assert.ok(commandArgv.includes('--ask-for-approval'));
      assert.ok(commandArgv.includes('never'));
      assert.ok(commandArgv.includes('tools.web_search=false'));
      assert.ok(!commandArgv.includes('tools.view_image=false'));
      assert.ok(commandArgv.includes('model_provider="openai"'));
      assert.ok(commandArgv.includes('--model'));
      assert.ok(commandArgv.includes('gpt-test-alpha'));
      for (const feature of disabledPlanningFeatures) {
        assert.ok(commandArgv.some((value, index) => value === '--disable' && commandArgv[index + 1] === feature));
      }
      assert.ok(commandArgv.includes(`CODEX_HOME=${fixture.planningCodexHome}`));
      assert.ok(commandArgv.includes(`HOME=${fixture.planningHomeDir}`));
      assert.ok(commandArgv.includes(`--unit=${candidate.roles[event.role].attempts[0].scopeUnit}`));
      for (const property of [
        'RuntimeMaxSec=30min',
        'TimeoutStopSec=30s',
        'KillMode=control-group',
        'KillSignal=SIGTERM',
        'SendSIGHUP=no',
        'SendSIGKILL=yes',
        'FinalKillSignal=SIGKILL'
      ]) assert.ok(commandArgv.includes(`--property=${property}`), property);
      assert.ok(event.argv.includes('-c'));
      assert.ok(event.argv.includes(fixture.planningContexts[event.role]));
      assert.ok(event.argv.includes('BASH_ENV='));
      assert.ok(event.argv.includes('ENV='));
      assert.doesNotMatch(commandArgv.join('\n'), /(?:^|\/)bash(?:$|\n)|run-isolated-agent|exec bash|--sandbox|--yolo|workspace-write|danger-full-access|--search/);
      assert.doesNotMatch(commandArgv.join('\n'), new RegExp(fixture.workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(commandArgv.join('\n'), new RegExp(fixture.codexHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      const launchIndex = events(fixture).indexOf(event);
      assert.ok(events(fixture).slice(0, launchIndex).some((candidate) => (
        candidate.type === 'systemctl'
        && candidate.argv.includes('panefleet-workloads.service')
      )), 'workload cgroup preflight must precede every Planning tmux launch');
    }
    assert.equal(
      (() => { try { return readFileSync(fixture.nativeInvocationLog, 'utf8'); } catch { return ''; } })(),
      '',
      'Planning launch must not execute runtime MCP or version probe subprocesses before adoption'
    );
    const qaPayload = JSON.parse(readFileSync(path.join(fixture.promptDir, 'qa.txt'), 'utf8').split('\n')[3]);
    const devPayload = JSON.parse(readFileSync(path.join(fixture.promptDir, 'dev.txt'), 'utf8').split('\n')[3]);
    assert.deepEqual(qaPayload.commonInput, devPayload.commonInput);
    assert.doesNotMatch(JSON.stringify(qaPayload.commonInput), /Use a strict Planning Run state machine/);
    assert.doesNotMatch(JSON.stringify(devPayload.commonInput), /All four exact reports are required/);

    const beforeApplyPlan = await api(runtime, `/api/delivery-plans/${plan.id}`);
    assert.equal(beforeApplyPlan.response.status, 200, JSON.stringify(beforeApplyPlan.json));
    assert.equal(beforeApplyPlan.json.plan.revision, 1);
    assert.deepEqual(beforeApplyPlan.json.plan.roles, plan.roles);
    const applyBody = {
      operationId: 'apply-planning-bound-0001',
      expectedStoreRevision: (await api(runtime, `/api/planning-runs/${runId}`)).json.planningRunStoreRevision,
      expectedRunRevision: candidate.revision,
      expectedPlanStoreRevision: beforeApplyPlan.json.planStoreRevision,
      expectedPlanRevision: beforeApplyPlan.json.plan.revision,
      expectedPlanDigest: beforeApplyPlan.json.digest,
      expectedCandidateDigest: candidate.candidate.digest,
      confirmation: 'apply-planning-candidate'
    };

    for (const [field, value, expectedError] of [
      ['expectedStoreRevision', applyBody.expectedStoreRevision + 1, 'delivery_planning_run_store_revision_conflict'],
      ['expectedRunRevision', applyBody.expectedRunRevision + 1, 'delivery_planning_run_run_revision_conflict'],
      ['expectedPlanStoreRevision', applyBody.expectedPlanStoreRevision + 1, 'delivery_planning_run_plan_store_revision_conflict'],
      ['expectedCandidateDigest', 'f'.repeat(64), 'delivery_planning_run_apply_binding_conflict']
    ]) {
      const guarded = await api(runtime, `/api/planning-runs/${runId}/apply`, {
        method: 'POST', body: { ...applyBody, [field]: value }
      });
      assert.equal(guarded.response.status, 409, JSON.stringify(guarded.json));
      assert.equal(guarded.json.error, expectedError);
    }

    // Simulate a crash after the Planning apply claim but before the Plan
    // mutation. If the workspace drifts in that window, startup must prove the
    // Plan receipt is absent, mark the Run off-course, and abandon the outbox.
    const candidateStoreSnapshot = planningStore(fixture);
    const planStoreSnapshot = readFileSync(fixture.planPath);
    rmSync(fixture.planPath, { force: true });
    mkdirSync(fixture.planPath);
    const failedPlanWrite = await api(runtime, `/api/planning-runs/${runId}/apply`, {
      method: 'POST',
      body: { ...applyBody, operationId: 'apply-planning-plan-write-failure-0001' }
    });
    assert.equal(failedPlanWrite.response.status, 500, JSON.stringify(failedPlanWrite.json));
    assert.equal(currentRun(fixture).applyOutbox.state, 'reconcile_required');
    assert.equal(currentRun(fixture).applyOutbox.claimId, 'apply-planning-plan-write-failure-0001');
    await stopChildProcess(runtime.child);
    runtime = null;
    rmSync(fixture.planPath, { recursive: true, force: true });
    writeFileSync(fixture.planPath, planStoreSnapshot, { mode: 0o600 });
    writeFileSync(fixture.planningRunPath, `${JSON.stringify(candidateStoreSnapshot, null, 2)}\n`);
    runtime = await startFixture(fixture, { monitor: false });

    writeFileSync(path.join(fixture.workspace, 'tracked.txt'), 'baseline drift before apply claim\n');
    const driftApplyBody = {
      ...applyBody,
      expectedStoreRevision: planningStore(fixture).revision,
      expectedRunRevision: currentRun(fixture).revision
    };
    const driftedApply = await api(runtime, `/api/planning-runs/${runId}/apply`, {
      method: 'POST', body: driftApplyBody
    });
    assert.equal(driftedApply.response.status, 409, JSON.stringify(driftedApply.json));
    assert.equal(driftedApply.json.error, 'delivery_planning_run_off_course');
    assert.equal(currentRun(fixture).condition, 'off_course');
    const offCourseRun = currentRun(fixture);
    const candidateNotReady = await api(runtime, `/api/planning-runs/${runId}/apply`, {
      method: 'POST',
      body: {
        ...driftApplyBody,
        operationId: 'apply-planning-off-course-0001',
        expectedStoreRevision: planningStore(fixture).revision,
        expectedRunRevision: offCourseRun.revision
      }
    });
    assert.equal(candidateNotReady.response.status, 409, JSON.stringify(candidateNotReady.json));
    assert.equal(candidateNotReady.json.error, 'delivery_planning_run_candidate_not_ready');
    await stopChildProcess(runtime.child);
    runtime = null;
    writeFileSync(fixture.planningRunPath, `${JSON.stringify(candidateStoreSnapshot, null, 2)}\n`);
    writeFileSync(path.join(fixture.workspace, 'tracked.txt'), 'baseline\n');
    const crashRepository = createDeliveryPlanningRunRepository({ filePath: fixture.planningRunPath });
    await crashRepository.initialize();
    await crashRepository.claimApply(runId, {
      operationId: 'apply-planning-drift-crash-0001',
      expectedStoreRevision: candidateStoreSnapshot.revision,
      expectedRunRevision: candidate.revision,
      claimId: 'apply-planning-drift-crash-0001',
      candidateDigest: candidate.candidate.digest
    });
    writeFileSync(path.join(fixture.workspace, 'tracked.txt'), 'baseline drift after apply claim\n');
    runtime = await startFixture(fixture);
    const abandoned = await waitForCondition(() => {
      const run = currentRun(fixture);
      return run.applyOutbox.state === 'abandoned' ? run : null;
    }, { intervalMs: 50, timeoutMs: 10000, label: 'off-course Apply abandonment' });
    assert.equal(abandoned.condition, 'off_course');
    assert.equal(abandoned.applyOutbox.observation, 'plan_receipt_absent');
    const unchangedAfterAbandon = await api(runtime, `/api/delivery-plans/${plan.id}`);
    assert.equal(unchangedAfterAbandon.json.plan.revision, 1);
    assert.deepEqual(unchangedAfterAbandon.json.plan.roles, plan.roles);

    // Restore the exact pre-claim Run snapshot to continue the independent
    // happy-path proof below; the failed branch made no Plan mutation.
    await stopChildProcess(runtime.child);
    runtime = null;
    writeFileSync(fixture.planningRunPath, `${JSON.stringify(candidateStoreSnapshot, null, 2)}\n`);
    writeFileSync(path.join(fixture.workspace, 'tracked.txt'), 'baseline\n');
    runtime = await startFixture(fixture);
    const successfulApplyBody = {
      ...applyBody,
      expectedStoreRevision: planningStore(fixture).revision,
      expectedRunRevision: currentRun(fixture).revision
    };
    const applied = await api(runtime, `/api/planning-runs/${runId}/apply`, {
      method: 'POST', body: successfulApplyBody
    });
    assert.equal(applied.response.status, 200, JSON.stringify(applied.json));
    assert.equal(applied.json.planningRun.phase, 'applied');
    assert.equal(applied.json.planningRun.applyOutbox.state, 'applied');
    assert.equal(applied.json.plan.phase, 'planning');
    assert.equal(applied.json.plan.revision, 2);
    assert.equal(applied.json.plan.approval.digest, '');
    assert.deepEqual(applied.json.plan.roles, ARTIFACTS);

    const thirdPlan = planningPlan(fixture.workspace, baseline.json.baseline, 'plan-planning-third-1234567');
    thirdPlan.request = 'Advance the Plan store after Apply for replay coverage.';
    const third = await api(runtime, '/api/delivery-plans', {
      method: 'POST',
      body: {
        operationId: 'create-planning-third-0001',
        expectedStoreRevision: applied.json.planStoreRevision,
        plan: thirdPlan
      }
    });
    assert.equal(third.response.status, 200, JSON.stringify(third.json));
    // Rewind only the Planning store to the durable Apply-claim crash point.
    // The Plan update receipt remains committed, so restart must prove that
    // exact receipt and finish the outbox without applying the patch twice.
    await stopChildProcess(runtime.child);
    runtime = null;
    const planningAfterApply = planningStore(fixture);
    const applyClaimIndex = planningAfterApply.operations.findIndex((operation) => (
      operation.action === 'planning_run.apply_claim'
      && operation.result?.run?.id === runId
    ));
    assert.ok(applyClaimIndex >= 0, JSON.stringify(planningAfterApply.operations));
    const applyClaim = planningAfterApply.operations[applyClaimIndex];
    writeFileSync(fixture.planningRunPath, `${JSON.stringify({
      ...planningAfterApply,
      revision: applyClaim.result.storeRevision,
      runs: [structuredClone(applyClaim.result.run)],
      operations: planningAfterApply.operations.slice(0, applyClaimIndex + 1)
    }, null, 2)}\n`);
    runtime = await startFixture(fixture);
    const restartApplied = await waitForCondition(() => {
      const run = currentRun(fixture);
      return run.applyOutbox.state === 'applied' ? run : null;
    }, { intervalMs: 50, timeoutMs: 10000, label: 'Apply receipt restart reconciliation' });
    assert.equal(restartApplied.phase, 'applied');
    const applyReplay = await api(runtime, `/api/planning-runs/${runId}/apply`, {
      method: 'POST', body: successfulApplyBody
    });
    assert.equal(applyReplay.response.status, 200, JSON.stringify(applyReplay.json));
    assert.equal(applyReplay.json.replayed, true);
    assert.equal(applyReplay.json.plan.revision, 2);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 4);

    const missionStore = JSON.parse(readFileSync(fixture.missionPath, 'utf8'));
    const promptStore = JSON.parse(readFileSync(fixture.promptQueuePath, 'utf8'));
    assert.equal(missionStore.jobs.length, 0);
    assert.equal(promptStore.items.length, 0);
    assert.doesNotMatch(readFileSync(path.join(fixture.dataDir, 'actions.jsonl'), 'utf8'), /PRIVATE_PLANNING_SENTINEL/);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('resource wait never auto-retries and exact durable Continue replay dispatches only once', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    writeFileSync(path.join(fixture.root, 'meminfo'), [
      'MemTotal:        2048000 kB',
      'MemAvailable:      32000 kB',
      'SwapTotal:       1048576 kB',
      'SwapFree:        1048576 kB',
      ''
    ].join('\n'));
    runtime = await startFixture(fixture);
    const baseline = await api(runtime, '/api/delivery-plans/baseline', {
      method: 'POST', body: { workspace: fixture.workspace }
    });
    assert.equal(baseline.response.status, 200, JSON.stringify(baseline.json));
    const plan = planningPlan(fixture.workspace, baseline.json.baseline);
    const created = await api(runtime, '/api/delivery-plans', {
      method: 'POST',
      body: { operationId: 'create-planning-resource-0001', expectedStoreRevision: 0, plan }
    });
    assert.equal(created.response.status, 200, JSON.stringify(created.json));
    const started = await api(runtime, `/api/delivery-plans/${plan.id}/planning-runs`, {
      method: 'POST',
      body: {
        operationId: defaultStartOperationId,
        expectedPlanStoreRevision: created.json.storeRevision,
        expectedPlanRevision: created.json.plan.revision,
        expectedDigest: created.json.digest,
        expectedPlanningRunStoreRevision: 0,
        confirmation: 'start-multi-role-planning'
      }
    });
    assert.equal(started.response.status, 202, JSON.stringify(started.json));
    assert.equal(started.json.planningRun.condition, 'resource_wait');
    assert.equal(started.json.actions.canContinue, true);
    assert.equal(started.json.actions.continueKind, 'resource_retry');
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 0);

    let store = planningStore(fixture);
    let run = currentRun(fixture);
    const lowContinue = await api(runtime, `/api/planning-runs/${run.id}/continue`, {
      method: 'POST',
      body: {
        operationId: 'continue-resource-still-low-0001',
        expectedStoreRevision: store.revision,
        expectedRunRevision: run.revision,
        confirmation: 'continue-multi-role-planning'
      }
    });
    assert.equal(lowContinue.response.status, 202, JSON.stringify(lowContinue.json));
    assert.equal(currentRun(fixture).continueReceipts.length, 0);
    assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 0);

    const resourceWaitStoreSnapshot = planningStore(fixture);
    await stopChildProcess(runtime.child);
    runtime = await startFixture(fixture, { monitor: false });

    writeFileSync(path.join(fixture.root, 'meminfo'), [
      'MemTotal:        2048000 kB',
      'MemAvailable:    1536000 kB',
      'SwapTotal:       1048576 kB',
      'SwapFree:        1048576 kB',
      ''
    ].join('\n'));
    writeFileSync(path.join(fixture.workspace, 'tracked.txt'), 'resource retry baseline drift\n');
    store = planningStore(fixture);
    run = currentRun(fixture);
    const driftedContinue = await api(runtime, `/api/planning-runs/${run.id}/continue`, {
      method: 'POST',
      body: {
        operationId: 'continue-resource-baseline-drift-0001',
        expectedStoreRevision: store.revision,
        expectedRunRevision: run.revision,
        confirmation: 'continue-multi-role-planning'
      }
    });
    assert.equal(driftedContinue.response.status, 200, JSON.stringify(driftedContinue.json));
    assert.equal(driftedContinue.json.planningRun.condition, 'off_course');
    assert.equal(driftedContinue.json.planningRun.blocker, 'delivery_planning_run_plan_or_baseline_changed');
    assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 0);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 0);

    await stopChildProcess(runtime.child);
    runtime = null;
    writeFileSync(fixture.planningRunPath, `${JSON.stringify(resourceWaitStoreSnapshot, null, 2)}\n`);
    writeFileSync(path.join(fixture.workspace, 'tracked.txt'), 'baseline\n');
    runtime = await startFixture(fixture, { monitor: false });
    store = planningStore(fixture);
    run = currentRun(fixture);
    const continueBody = {
      operationId: 'continue-resource-recovered-0001',
      expectedStoreRevision: store.revision,
      expectedRunRevision: run.revision,
      confirmation: 'continue-multi-role-planning'
    };
    const gitDirectory = path.join(fixture.workspace, '.git');
    const heldGitDirectory = path.join(fixture.workspace, '.git-held-for-continue-replay');
    renameSync(gitDirectory, heldGitDirectory);
    const interrupted = await api(runtime, `/api/planning-runs/${run.id}/continue`, {
      method: 'POST', body: continueBody
    });
    assert.equal(interrupted.response.status, 400, JSON.stringify(interrupted.json));
    assert.equal(interrupted.json.error, 'delivery_plan_baseline_not_git_repository');
    assert.equal(currentRun(fixture).condition, 'active');
    assert.equal(currentRun(fixture).continueReceipts.length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 0);
    renameSync(heldGitDirectory, gitDirectory);

    // The first request durably authorized Continue but failed before it could
    // claim or type into a worker. Its exact replay may recover that receipt
    // once; another replay remains readback-only after dispatch.
    const continued = await api(runtime, `/api/planning-runs/${run.id}/continue`, {
      method: 'POST', body: continueBody
    });
    assert.equal(continued.response.status, 200, JSON.stringify(continued.json));
    assert.equal(continued.json.replayed, true);
    assert.equal(continued.json.planningRun.roles.po.state, 'dispatched');
    assert.equal(currentRun(fixture).continueReceipts.length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 1);

    const replay = await api(runtime, `/api/planning-runs/${run.id}/continue`, {
      method: 'POST', body: continueBody
    });
    assert.equal(replay.response.status, 200, JSON.stringify(replay.json));
    assert.equal(replay.json.replayed, true);
    assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 1);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('Planning mutation guards and cancel replay fail closed without worker input', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    writeFileSync(path.join(fixture.root, 'meminfo'), [
      'MemTotal:        2048000 kB',
      'MemAvailable:      32000 kB',
      'SwapTotal:       1048576 kB',
      'SwapFree:        1048576 kB',
      ''
    ].join('\n'));
    runtime = await startFixture(fixture);
    const { created, started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-planning-cancel-guards-0001'
    });
    assert.equal(started.response.status, 202, JSON.stringify(started.json));
    const runId = started.json.planningRun.id;
    let run = currentRun(fixture);
    let store = planningStore(fixture);

    const assertPlanningError = async (suffix, body, status, error) => {
      const result = await api(runtime, `/api/planning-runs/${runId}/${suffix}`, {
        method: 'POST', body
      });
      assert.equal(result.response.status, status, JSON.stringify(result.json));
      assert.equal(result.json.error, error);
    };

    const continueBody = {
      operationId: 'continue-cancel-guards-0001',
      expectedStoreRevision: store.revision,
      expectedRunRevision: run.revision,
      confirmation: 'continue-multi-role-planning'
    };
    await assertPlanningError('continue', {
      ...continueBody, confirmation: 'wrong-confirmation'
    }, 400, 'delivery_planning_run_continue_confirmation_required');
    await assertPlanningError('continue', {
      ...continueBody, operationId: 'short'
    }, 400, 'delivery_planning_run_operation_id_invalid');
    await assertPlanningError('continue', {
      ...continueBody, expectedStoreRevision: 0.5
    }, 400, 'delivery_planning_run_expected_store_revision_invalid');
    await assertPlanningError('continue', {
      ...continueBody, expectedRunRevision: 0
    }, 400, 'delivery_planning_run_expected_run_revision_invalid');
    await assertPlanningError('continue', {
      ...continueBody, expectedStoreRevision: store.revision + 1
    }, 409, 'delivery_planning_run_store_revision_conflict');
    await assertPlanningError('continue', {
      ...continueBody, expectedRunRevision: run.revision + 1
    }, 409, 'delivery_planning_run_run_revision_conflict');

    const planDetail = await api(runtime, `/api/delivery-plans/${created.json.plan.id}`);
    assert.equal(planDetail.response.status, 200, JSON.stringify(planDetail.json));
    const applyBody = {
      operationId: 'apply-cancel-guards-0001',
      expectedStoreRevision: store.revision,
      expectedRunRevision: run.revision,
      expectedPlanStoreRevision: planDetail.json.planStoreRevision,
      expectedPlanRevision: planDetail.json.plan.revision,
      expectedPlanDigest: planDetail.json.digest,
      expectedCandidateDigest: 'a'.repeat(64),
      confirmation: 'apply-planning-candidate'
    };
    await assertPlanningError('apply', {
      ...applyBody, confirmation: 'wrong-confirmation'
    }, 400, 'delivery_planning_run_apply_confirmation_required');
    await assertPlanningError('apply', {
      ...applyBody, operationId: 'short'
    }, 400, 'delivery_planning_run_operation_id_invalid');
    await assertPlanningError('apply', {
      ...applyBody, expectedStoreRevision: -1
    }, 400, 'delivery_planning_run_expected_store_revision_invalid');
    await assertPlanningError('apply', {
      ...applyBody, expectedRunRevision: 0
    }, 400, 'delivery_planning_run_expected_run_revision_invalid');
    await assertPlanningError('apply', {
      ...applyBody, expectedPlanStoreRevision: 0.5
    }, 400, 'delivery_planning_run_expected_plan_store_revision_invalid');
    await assertPlanningError('apply', {
      ...applyBody, expectedPlanRevision: 0
    }, 400, 'delivery_planning_run_expected_plan_revision_invalid');
    await assertPlanningError('apply', {
      ...applyBody, expectedPlanDigest: 'invalid'
    }, 400, 'delivery_planning_run_expected_plan_digest_invalid');
    await assertPlanningError('apply', {
      ...applyBody, expectedCandidateDigest: 'invalid'
    }, 400, 'delivery_planning_run_expected_candidate_digest_invalid');
    await assertPlanningError(
      'apply',
      applyBody,
      409,
      'delivery_planning_run_apply_binding_conflict'
    );

    const cancelBody = {
      operationId: 'cancel-planning-guards-0001',
      expectedStoreRevision: store.revision,
      expectedRunRevision: run.revision,
      reason: 'Operator closes the resource-waiting Planning Run.',
      confirmation: 'cancel-multi-role-planning'
    };
    await assertPlanningError('cancel', {
      ...cancelBody, confirmation: 'wrong-confirmation'
    }, 400, 'delivery_planning_run_cancel_confirmation_required');
    await assertPlanningError('cancel', {
      ...cancelBody, operationId: 'short'
    }, 400, 'delivery_planning_run_operation_id_invalid');
    await assertPlanningError('cancel', {
      ...cancelBody, expectedStoreRevision: -1
    }, 400, 'delivery_planning_run_expected_store_revision_invalid');
    await assertPlanningError('cancel', {
      ...cancelBody, expectedRunRevision: 0
    }, 400, 'delivery_planning_run_expected_run_revision_invalid');
    await assertPlanningError('cancel', {
      ...cancelBody, reason: ''
    }, 400, 'delivery_planning_run_cancel_reason_invalid');
    await assertPlanningError('cancel', {
      ...cancelBody, reason: 'x'.repeat(801)
    }, 400, 'delivery_planning_run_cancel_reason_invalid');
    await assertPlanningError('cancel', {
      ...cancelBody, expectedStoreRevision: store.revision + 1
    }, 409, 'delivery_planning_run_store_revision_conflict');
    await assertPlanningError('cancel', {
      ...cancelBody, expectedRunRevision: run.revision + 1
    }, 409, 'delivery_planning_run_run_revision_conflict');

    const canceled = await api(runtime, `/api/planning-runs/${runId}/cancel`, {
      method: 'POST', body: cancelBody
    });
    assert.equal(canceled.response.status, 200, JSON.stringify(canceled.json));
    assert.equal(canceled.json.planningRun.condition, 'canceled');
    assert.equal(canceled.json.actions.canCancel, false);
    assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 0);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 0);

    const detailAfterCancel = await api(runtime, `/api/delivery-plans/${created.json.plan.id}`);
    assert.equal(detailAfterCancel.response.status, 200, JSON.stringify(detailAfterCancel.json));
    assert.equal(detailAfterCancel.json.planningRun, null);

    const replay = await api(runtime, `/api/planning-runs/${runId}/cancel`, {
      method: 'POST', body: cancelBody
    });
    assert.equal(replay.response.status, 200, JSON.stringify(replay.json));
    assert.equal(replay.json.replayed, true);
    await assertPlanningError('cancel', {
      ...cancelBody, reason: 'A different replay payload must conflict.'
    }, 409, 'delivery_planning_run_cancel_replay_conflict');

    run = currentRun(fixture);
    store = planningStore(fixture);
    assert.equal(run.condition, 'canceled');
    assert.equal(store.revision, canceled.json.planningRunStoreRevision);

    const nextRound = await api(runtime, `/api/delivery-plans/${created.json.plan.id}/planning-runs`, {
      method: 'POST',
      body: {
        operationId: 'create-planning-after-cancel-0001',
        expectedPlanStoreRevision: detailAfterCancel.json.planStoreRevision,
        expectedPlanRevision: detailAfterCancel.json.plan.revision,
        expectedDigest: detailAfterCancel.json.digest,
        expectedPlanningRunStoreRevision: detailAfterCancel.json.planningRunStoreRevision,
        confirmation: 'start-multi-role-planning'
      }
    });
    assert.equal(nextRound.response.status, 202, JSON.stringify(nextRound.json));
    assert.notEqual(nextRound.json.planningRun.id, runId);
    assert.equal(nextRound.json.planningRun.condition, 'resource_wait');
    assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 0);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 0);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('Planning supervisor rejects a report that echoes its private prompt digest and still cleans the worker', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture);
    const { started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-private-report-rejection-0001'
    });
    assert.equal(started.response.status, 200, JSON.stringify(started.json));
    let run = currentRun(fixture);
    const attempt = run.roles.po.attempts.at(-1);
    setWorkerIdle(fixture, 'po');
    appendRoleResult(fixture, run, 'po', {
      ...structuredClone(ARTIFACTS.po),
      user: attempt.promptDigest
    });
    run = await waitForCondition(() => {
      const candidate = currentRun(fixture);
      return candidate.roles.po.state === 'needs_input' ? candidate : null;
    }, { intervalMs: 50, timeoutMs: 10000, label: 'private report rejection' });
    assert.equal(run.condition, 'needs_input');
    assert.match(run.blocker, /private_value_not_allowed|role_report_rejected/);
    assert.equal(run.roles.po.report, null);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 1);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('Planning supervisor reconciles a missing authoritative rollout without retrying input', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture);
    const { started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-missing-rollout-reconcile-0001'
    });
    assert.equal(started.response.status, 200, JSON.stringify(started.json));
    const run = currentRun(fixture);
    setWorkerIdle(fixture, 'po');
    rmSync(fixture.rolloutPaths.po, { force: true });
    const reconciled = await waitForCondition(() => {
      const candidate = currentRun(fixture);
      return candidate.roles.po.state === 'reconcile_required' ? candidate : null;
    }, { intervalMs: 50, timeoutMs: 10000, label: 'missing rollout reconciliation' });
    assert.equal(reconciled.condition, 'reconcile_required');
    assert.match(reconciled.blocker, /worker_profile_unsafe|not_file|ENOENT|reconcile/);
    assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 1);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('Planning supervisor reconciles an exact absent dispatched worker without respawn', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture);
    const { started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-worker-crash-observation-0001'
    });
    assert.equal(started.response.status, 200, JSON.stringify(started.json));
    const state = JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8'));
    writeFileSync(fixture.tmuxStatePath, JSON.stringify({
      ...state,
      mode: 'absent',
      scopeActive: false
    }));
    const reconciled = await waitForCondition(() => {
      const candidate = currentRun(fixture);
      return candidate.roles.po.state === 'reconcile_required' ? candidate : null;
    }, { intervalMs: 50, timeoutMs: 10000, label: 'absent Planning worker reconciliation' });
    assert.equal(reconciled.condition, 'reconcile_required');
    assert.equal(reconciled.blocker, 'delivery_planning_run_worker_missing');
    assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 1);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('restart turns a durable dispatch claim into reconcile_required without input replay', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture, { monitor: false });
    const { started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-dispatch-claim-restart-0001'
    });
    assert.equal(started.response.status, 200, JSON.stringify(started.json));
    await stopChildProcess(runtime.child);
    runtime = null;
    const store = planningStore(fixture);
    const claimIndex = store.operations.findIndex((operation) => (
      operation.action === 'planning_run.role_dispatch_claim'
      && operation.result?.run?.roles?.po?.attempts?.at(-1)?.state === 'dispatch_claimed'
    ));
    assert.ok(claimIndex >= 0, JSON.stringify(store.operations));
    const claim = store.operations[claimIndex];
    writeFileSync(fixture.planningRunPath, `${JSON.stringify({
      ...store,
      revision: claim.result.storeRevision,
      runs: [structuredClone(claim.result.run)],
      operations: store.operations.slice(0, claimIndex + 1)
    }, null, 2)}\n`);
    const beforeEvents = events(fixture);
    runtime = await startFixture(fixture);
    const reconciled = await waitForCondition(() => {
      const run = currentRun(fixture);
      return run.roles.po.state === 'reconcile_required' ? run : null;
    }, { intervalMs: 50, timeoutMs: 10000, label: 'dispatch claim restart reconciliation' });
    assert.equal(reconciled.blocker, 'delivery_planning_run_dispatch_outcome_uncertain');
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'literal').length,
      beforeEvents.filter((event) => event.type === 'literal').length);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('Planning report offset past end reconciles the exact worker without retry', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture);
    const { started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-report-offset-past-end-0001'
    });
    assert.equal(started.response.status, 200, JSON.stringify(started.json));
    const attempt = currentRun(fixture).roles.po.attempts.at(-1);
    truncateSync(fixture.rolloutPaths.po, attempt.rolloutStartOffset - 1);
    setWorkerIdle(fixture, 'po');
    const reconciled = await waitForCondition(() => {
      const run = currentRun(fixture);
      return run.roles.po.state === 'reconcile_required' ? run : null;
    }, { intervalMs: 50, timeoutMs: 10000, label: 'Planning report offset reconciliation' });
    assert.equal(reconciled.blocker, 'codex_planning_role_report_offset_past_end');
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 1);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('Planning supervisor durably reconciles cleanup sent to a worker that remains active', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture, { monitor: false });
    const { started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-cleanup-exit-unobserved-0001'
    });
    assert.equal(started.response.status, 200, JSON.stringify(started.json));
    await stopChildProcess(runtime.child);
    runtime = null;

    const repository = createDeliveryPlanningRunRepository({ filePath: fixture.planningRunPath });
    await repository.initialize();
    let store = planningStore(fixture);
    let run = currentRun(fixture);
    const attempt = run.roles.po.attempts.at(-1);
    const report = planningReport(run, 'po', attempt.id);
    let mutation = await repository.recordRoleReport(run.id, {
      operationId: 'planning:test:cleanup-unobserved-report',
      expectedStoreRevision: store.revision,
      expectedRunRevision: run.revision,
      role: 'po',
      attemptId: attempt.id,
      report,
      outputDigest: planningRoleReportOutputDigest(report)
    });
    mutation = await repository.authorizeContinue(run.id, {
      operationId: 'planning:test:cleanup-unobserved-authorize',
      expectedStoreRevision: mutation.storeRevision,
      expectedRunRevision: mutation.run.revision,
      kind: 'cleanup_only',
      role: 'po',
      attemptId: attempt.id,
      claimId: 'planning-cleanup:exit-unobserved-0001',
      cleanupRecoveryOutcome: ''
    });
    mutation = await repository.markRoleCleanupSent(run.id, {
      operationId: 'planning:test:cleanup-unobserved-sent',
      expectedStoreRevision: mutation.storeRevision,
      expectedRunRevision: mutation.run.revision,
      role: 'po',
      attemptId: attempt.id
    });
    const state = JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8'));
    writeFileSync(fixture.tmuxStatePath, JSON.stringify({ ...state, mode: 'idle_result' }));

    runtime = await startFixture(fixture);
    run = await waitForCondition(() => {
      const candidate = currentRun(fixture);
      const cleanup = candidate.roles.po.attempts.at(-1)?.cleanup;
      return cleanup?.state === 'reconcile_required' ? candidate : null;
    }, { intervalMs: 50, timeoutMs: 10000, label: 'unobserved cleanup exit reconciliation' });
    assert.equal(run.roles.po.attempts.at(-1).cleanup.error, 'delivery_planning_run_cleanup_exit_unobserved');
    assert.equal(events(fixture).filter((event) => event.type === 'literal' && event.value === '/exit').length, 0);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('authorized cleanup fails closed when exact pane observation becomes unavailable before exit', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture, { monitor: false });
    const { started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-cleanup-observation-unavailable-0001'
    });
    assert.equal(started.response.status, 200, JSON.stringify(started.json));
    await stopChildProcess(runtime.child);
    runtime = null;

    const repository = createDeliveryPlanningRunRepository({ filePath: fixture.planningRunPath });
    await repository.initialize();
    const store = planningStore(fixture);
    const run = currentRun(fixture);
    const attempt = run.roles.po.attempts.at(-1);
    const report = planningReport(run, 'po', attempt.id);
    const reported = await repository.recordRoleReport(run.id, {
      operationId: 'planning:test:cleanup-observation-report',
      expectedStoreRevision: store.revision,
      expectedRunRevision: run.revision,
      role: 'po',
      attemptId: attempt.id,
      report,
      outputDigest: planningRoleReportOutputDigest(report)
    });
    const state = JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8'));
    writeFileSync(fixture.tmuxStatePath, JSON.stringify({ ...state, listPanesUnavailable: true }));
    runtime = await startFixture(fixture, { monitor: false });

    const continued = await api(runtime, `/api/planning-runs/${run.id}/continue`, {
      method: 'POST',
      body: {
        operationId: 'continue-cleanup-observation-unavailable-0001',
        expectedStoreRevision: reported.storeRevision,
        expectedRunRevision: reported.run.revision,
        confirmation: 'continue-multi-role-planning'
      }
    });
    assert.equal(continued.response.status, 200, JSON.stringify(continued.json));
    const reconciled = currentRun(fixture);
    assert.equal(reconciled.roles.po.attempts.at(-1).cleanup.state, 'reconcile_required');
    assert.equal(
      reconciled.roles.po.attempts.at(-1).cleanup.error,
      'delivery_planning_run_worker_pane_observation_unavailable'
    );
    assert.equal(events(fixture).filter((event) => event.type === 'literal' && event.value === '/exit').length, 0);
    assert.equal(events(fixture).filter((event) => event.type === 'codex-exit-enter').length, 0);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('Planning cleanup sent fails closed for a missing Codex process or unavailable pane observation', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture, { monitor: false });
    const { started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-cleanup-sent-fail-closed-0001'
    });
    assert.equal(started.response.status, 200, JSON.stringify(started.json));
    await stopChildProcess(runtime.child);
    runtime = null;

    const repository = createDeliveryPlanningRunRepository({ filePath: fixture.planningRunPath });
    await repository.initialize();
    let store = planningStore(fixture);
    let run = currentRun(fixture);
    const attempt = run.roles.po.attempts.at(-1);
    const report = planningReport(run, 'po', attempt.id);
    let mutation = await repository.recordRoleReport(run.id, {
      operationId: 'planning:test:cleanup-sent-fail-closed-report',
      expectedStoreRevision: store.revision,
      expectedRunRevision: run.revision,
      role: 'po',
      attemptId: attempt.id,
      report,
      outputDigest: planningRoleReportOutputDigest(report)
    });
    mutation = await repository.authorizeContinue(run.id, {
      operationId: 'planning:test:cleanup-sent-fail-closed-authorize',
      expectedStoreRevision: mutation.storeRevision,
      expectedRunRevision: mutation.run.revision,
      kind: 'cleanup_only',
      role: 'po',
      attemptId: attempt.id,
      claimId: 'planning-cleanup:sent-fail-closed-0001',
      cleanupRecoveryOutcome: ''
    });
    mutation = await repository.markRoleCleanupSent(run.id, {
      operationId: 'planning:test:cleanup-sent-fail-closed-sent',
      expectedStoreRevision: mutation.storeRevision,
      expectedRunRevision: mutation.run.revision,
      role: 'po',
      attemptId: attempt.id
    });
    const sentStore = planningStore(fixture);
    const state = JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8'));
    writeFileSync(fixture.tmuxStatePath, JSON.stringify({ ...state, mode: 'shell' }));
    runtime = await startFixture(fixture);
    run = await waitForCondition(() => {
      const candidate = currentRun(fixture);
      return candidate.roles.po.attempts.at(-1)?.cleanup?.state === 'reconcile_required'
        ? candidate
        : null;
    }, { intervalMs: 50, timeoutMs: 10000, label: 'cleanup missing Codex reconciliation' });
    assert.equal(run.roles.po.attempts.at(-1).cleanup.error, 'delivery_planning_run_cleanup_session_did_not_close');
    assert.equal(events(fixture).filter((event) => event.type === 'literal' && event.value === '/exit').length, 0);

    await stopChildProcess(runtime.child);
    runtime = null;
    writeFileSync(fixture.planningRunPath, `${JSON.stringify(sentStore, null, 2)}\n`);
    writeFileSync(fixture.tmuxStatePath, JSON.stringify({
      ...state,
      mode: 'idle_result',
      listPanesUnavailable: true
    }));
    runtime = await startFixture(fixture);
    run = await waitForCondition(() => {
      const candidate = currentRun(fixture);
      return candidate.roles.po.attempts.at(-1)?.cleanup?.state === 'reconcile_required'
        ? candidate
        : null;
    }, { intervalMs: 50, timeoutMs: 10000, label: 'cleanup pane observation reconciliation' });
    assert.match(run.roles.po.attempts.at(-1).cleanup.error, /tmux|unavailable|observation/);
    assert.equal(events(fixture).filter((event) => event.type === 'literal' && event.value === '/exit').length, 0);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('Planning cleanup persists every pre-submit failure without retrying terminal input', async () => {
  const scenarios = [
    {
      name: 'literal typing failure',
      state: { failCleanupLiteral: true },
      error: 'delivery_planning_run_cleanup_literal_failed'
    },
    {
      name: 'busy worker',
      state: { becomeBusyAfterIdleCaptures: 2 },
      error: 'delivery_planning_run_worker_not_idle'
    },
    {
      name: 'pane lifecycle option failure',
      state: { failSetOption: true },
      error: 'delivery_planning_run_cleanup_lifecycle_guard_failed'
    },
    {
      name: 'identity replacement after pane option change',
      state: { replaceAfterSetOption: true },
      error: 'delivery_planning_run_worker_identity_changed'
    },
    {
      name: 'Enter failure after exact literal typing',
      state: { failCleanupEnter: true },
      error: 'delivery_planning_run_cleanup_submit_failed'
    }
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const fixture = createFixture();
    let runtime;
    try {
      runtime = await startFixture(fixture);
      const { started } = await createAndStartPlanningRun(runtime, fixture, {
        createOperationId: `create-cleanup-failure-${index}-0001`
      });
      assert.equal(started.response.status, 200, JSON.stringify(started.json));
      const dispatched = currentRun(fixture);
      const state = JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8'));
      writeFileSync(fixture.tmuxStatePath, JSON.stringify({
        ...state,
        mode: 'idle_result',
        ...scenario.state
      }));
      appendRoleResult(fixture, dispatched, 'po');
      let reconciled;
      try {
        reconciled = await waitForCondition(() => {
          const run = currentRun(fixture);
          return run.roles.po.attempts.at(-1)?.cleanup?.state === 'reconcile_required'
            ? run
            : null;
        }, { intervalMs: 50, timeoutMs: 15000, label: `cleanup failure: ${scenario.name}` });
      } catch (error) {
        throw new Error(`${error.message}; run=${JSON.stringify(currentRun(fixture))}; events=${JSON.stringify(events(fixture).slice(-12))}; output=${runtime.output()}`);
      }
      assert.equal(
        reconciled.roles.po.attempts.at(-1).cleanup.error,
        scenario.error,
        scenario.name
      );
      const scenarioEvents = events(fixture);
      assert.equal(
        scenarioEvents.filter((event) => event.type === 'codex-exit-enter').length,
        0,
        `${scenario.name} must not confirm worker exit`
      );
      assert.equal(
        scenarioEvents.filter((event) => event.type === 'prompt-enter').length,
        1,
        `${scenario.name} must not resend the role prompt`
      );
      assert.equal(
        scenarioEvents.filter((event) => event.type === 'cleanup-literal-failed').length,
        scenario.state.failCleanupLiteral === true ? 1 : 0
      );
      assert.equal(
        scenarioEvents.filter((event) => event.type === 'cleanup-enter-failed').length,
        scenario.state.failCleanupEnter === true ? 1 : 0
      );
    } finally {
      await cleanupFixture(fixture, runtime);
    }
  }
});

test('restart normalizes lost authority before PO and BA without Start replay spawning', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture, { monitor: false });
    const baseline = await api(runtime, '/api/delivery-plans/baseline', {
      method: 'POST', body: { workspace: fixture.workspace }
    });
    assert.equal(baseline.response.status, 200, JSON.stringify(baseline.json));
    const plan = planningPlan(fixture.workspace, baseline.json.baseline);
    const created = await api(runtime, '/api/delivery-plans', {
      method: 'POST',
      body: { operationId: 'create-planning-restart-0001', expectedStoreRevision: 0, plan }
    });
    assert.equal(created.response.status, 200, JSON.stringify(created.json));
    await stopChildProcess(runtime.child);
    runtime = null;

    // Simulate a committed Start whose HTTP handler/process stopped before it
    // could establish process-local advancement authority or spawn a worker.
    const repository = createDeliveryPlanningRunRepository({ filePath: fixture.planningRunPath });
    await repository.initialize();
    await repository.create({
      operationId: defaultStartOperationId,
      expectedStoreRevision: 0,
      run: { id: fixture.planningRunId, sourcePlan: created.json.plan }
    });

    runtime = await startFixture(fixture);
    let run = await waitForCondition(() => {
      const candidate = currentRun(fixture);
      return candidate.condition === 'resource_wait' ? candidate : null;
    }, { intervalMs: 50, timeoutMs: 5000, label: 'initial restart authorization wait' });
    assert.equal(run.roles.po.state, 'pending');
    assert.equal(run.continueReceipts.length, 0);
    assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 0);
    const runResponse = await api(runtime, `/api/planning-runs/${run.id}`);
    assert.equal(runResponse.json.actions.canContinue, true);
    assert.equal(runResponse.json.actions.continueKind, 'resource_retry');

    const startBody = {
      operationId: defaultStartOperationId,
      expectedPlanStoreRevision: created.json.storeRevision,
      expectedPlanRevision: created.json.plan.revision,
      expectedDigest: created.json.digest,
      expectedPlanningRunStoreRevision: 0,
      confirmation: 'start-multi-role-planning'
    };
    const beforeReplay = planningStore(fixture);
    const startReplay = await api(runtime, `/api/delivery-plans/${plan.id}/planning-runs`, {
      method: 'POST', body: startBody
    });
    assert.equal(startReplay.response.status, 202, JSON.stringify(startReplay.json));
    assert.equal(startReplay.json.replayed, true);
    assert.equal(planningStore(fixture).revision, beforeReplay.revision);
    assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 0);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 0);

    let store = planningStore(fixture);
    const poContinue = await api(runtime, `/api/planning-runs/${run.id}/continue`, {
      method: 'POST',
      body: {
        operationId: 'continue-restart-po-0001',
        expectedStoreRevision: store.revision,
        expectedRunRevision: run.revision,
        confirmation: 'continue-multi-role-planning'
      }
    });
    assert.equal(poContinue.response.status, 200, JSON.stringify(poContinue.json));
    assert.equal(poContinue.json.planningRun.roles.po.state, 'dispatched');
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter' && event.role === 'po').length, 1);

    run = currentRun(fixture);
    setWorkerIdle(fixture, 'po');
    appendRoleResult(fixture, run, 'po');
    await stopChildProcess(runtime.child);
    runtime = await startFixture(fixture);

    // Startup may accept the exact final, but it leaves cleanup pending and
    // cannot claim or type /exit without a durable cleanup-only Continue from
    // this server lifetime.
    run = await waitForCondition(() => {
      const candidate = currentRun(fixture);
      const cleanup = candidate.roles.po.attempts.at(-1)?.cleanup;
      return cleanup?.state === 'pending' ? candidate : null;
    }, { intervalMs: 50, timeoutMs: 10000, label: 'restart PO pending cleanup' });
    assert.equal(events(fixture).filter((event) => event.type === 'codex-exit-enter').length, 0);
    const cleanupActions = await api(runtime, `/api/planning-runs/${run.id}`);
    assert.equal(cleanupActions.json.actions.canContinue, true);
    assert.equal(cleanupActions.json.actions.continueKind, 'cleanup_only');
    store = planningStore(fixture);
    const cleanupContinue = await api(runtime, `/api/planning-runs/${run.id}/continue`, {
      method: 'POST',
      body: {
        operationId: 'continue-restart-po-cleanup-0001',
        expectedStoreRevision: store.revision,
        expectedRunRevision: run.revision,
        confirmation: 'continue-multi-role-planning'
      }
    });
    assert.equal(cleanupContinue.response.status, 200, JSON.stringify(cleanupContinue.json));

    run = await waitForCondition(() => {
      const candidate = currentRun(fixture);
      return candidate.phase === 'ba' && candidate.condition === 'resource_wait' ? candidate : null;
    }, { intervalMs: 50, timeoutMs: 10000, label: 'BA restart authorization wait' });
    assert.equal(run.continueReceipts.filter((receipt) => receipt.kind === 'resource_retry').length, 1);
    assert.equal(run.roles.ba.state, 'pending');
    assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 1);

    const baActions = await api(runtime, `/api/planning-runs/${run.id}`);
    assert.equal(baActions.json.actions.canContinue, true);
    assert.equal(baActions.json.actions.continueKind, 'resource_retry');
    store = planningStore(fixture);
    const baContinue = await api(runtime, `/api/planning-runs/${run.id}/continue`, {
      method: 'POST',
      body: {
        operationId: 'continue-restart-ba-0001',
        expectedStoreRevision: store.revision,
        expectedRunRevision: run.revision,
        confirmation: 'continue-multi-role-planning'
      }
    });
    assert.equal(baContinue.response.status, 200, JSON.stringify(baContinue.json));
    assert.equal(baContinue.json.planningRun.roles.ba.state, 'dispatched');
    assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 2);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 2);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('explicit cleanup-only recovery reaps only the exact retained dead Planning pane', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture);
    const baseline = await api(runtime, '/api/delivery-plans/baseline', {
      method: 'POST', body: { workspace: fixture.workspace }
    });
    const plan = planningPlan(fixture.workspace, baseline.json.baseline);
    const created = await api(runtime, '/api/delivery-plans', {
      method: 'POST',
      body: { operationId: 'create-planning-dead-pane-0001', expectedStoreRevision: 0, plan }
    });
    const started = await api(runtime, `/api/delivery-plans/${plan.id}/planning-runs`, {
      method: 'POST',
      body: {
        operationId: defaultStartOperationId,
        expectedPlanStoreRevision: created.json.storeRevision,
        expectedPlanRevision: created.json.plan.revision,
        expectedDigest: created.json.digest,
        expectedPlanningRunStoreRevision: 0,
        confirmation: 'start-multi-role-planning'
      }
    });
    assert.equal(started.response.status, 200, JSON.stringify(started.json));
    const runId = started.json.planningRun.id;
    const dead = JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8'));
    assert.equal(dead.role, 'po');
    dead.mode = 'dead';
    writeFileSync(fixture.tmuxStatePath, JSON.stringify(dead));

    let run = await waitForCondition(() => {
      const candidate = currentRun(fixture);
      const cleanup = candidate.roles.po.attempts.at(-1)?.cleanup;
      return cleanup?.state === 'reconcile_required' ? candidate : null;
    }, { intervalMs: 50, timeoutMs: 10000, label: 'dead Planning pane cleanup reconciliation' });
    assert.equal(JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8')).mode, 'dead');
    const actions = await api(runtime, `/api/planning-runs/${runId}`);
    assert.equal(actions.json.actions.canContinue, true);
    assert.equal(actions.json.actions.continueKind, 'cleanup_only');
    assert.equal(actions.json.actions.canCancel, false);

    const store = planningStore(fixture);
    const continueBody = {
      operationId: 'continue-dead-pane-cleanup-0001',
      expectedStoreRevision: store.revision,
      expectedRunRevision: run.revision,
      confirmation: 'continue-multi-role-planning'
    };
    const recovered = await api(runtime, `/api/planning-runs/${runId}/continue`, {
      method: 'POST', body: continueBody
    });
    assert.equal(recovered.response.status, 200, JSON.stringify(recovered.json));
    run = currentRun(fixture);
    assert.equal(run.roles.po.attempts.at(-1).cleanup.state, 'complete');
    assert.equal(JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8')).mode, 'absent');
    assert.equal(events(fixture).filter((event) => event.type === 'dead-pane-reaped').length, 1);
    assert.equal(recovered.json.actions.canCancel, true);

    const replay = await api(runtime, `/api/planning-runs/${runId}/continue`, {
      method: 'POST', body: continueBody
    });
    assert.equal(replay.response.status, 200, JSON.stringify(replay.json));
    assert.equal(replay.json.replayed, true);
    assert.equal(events(fixture).filter((event) => event.type === 'dead-pane-reaped').length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 1);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('cleanup Continue replay after restart is passive and never retypes exit', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture, { monitor: false });
    const baseline = await api(runtime, '/api/delivery-plans/baseline', {
      method: 'POST', body: { workspace: fixture.workspace }
    });
    const plan = planningPlan(fixture.workspace, baseline.json.baseline);
    const created = await api(runtime, '/api/delivery-plans', {
      method: 'POST',
      body: { operationId: 'create-cleanup-replay-0001', expectedStoreRevision: 0, plan }
    });
    const started = await api(runtime, `/api/delivery-plans/${plan.id}/planning-runs`, {
      method: 'POST',
      body: {
        operationId: defaultStartOperationId,
        expectedPlanStoreRevision: created.json.storeRevision,
        expectedPlanRevision: created.json.plan.revision,
        expectedDigest: created.json.digest,
        expectedPlanningRunStoreRevision: 0,
        confirmation: 'start-multi-role-planning'
      }
    });
    assert.equal(started.response.status, 200, JSON.stringify(started.json));
    await stopChildProcess(runtime.child);
    runtime = null;

    const repository = createDeliveryPlanningRunRepository({ filePath: fixture.planningRunPath });
    await repository.initialize();
    let store = planningStore(fixture);
    let run = currentRun(fixture);
    const attempt = run.roles.po.attempts.at(-1);
    const report = planningReport(run, 'po', attempt.id);
    const recorded = await repository.recordRoleReport(run.id, {
      operationId: 'planning:test:cleanup-replay-report',
      expectedStoreRevision: store.revision,
      expectedRunRevision: run.revision,
      role: 'po',
      attemptId: attempt.id,
      report,
      outputDigest: planningRoleReportOutputDigest(report)
    });
    const originalContinue = {
      operationId: 'continue-cleanup-crash-window-0001',
      expectedStoreRevision: recorded.storeRevision,
      expectedRunRevision: recorded.run.revision,
      confirmation: 'continue-multi-role-planning'
    };
    await repository.authorizeContinue(run.id, {
      operationId: originalContinue.operationId,
      expectedStoreRevision: originalContinue.expectedStoreRevision,
      expectedRunRevision: originalContinue.expectedRunRevision,
      kind: 'cleanup_only',
      role: 'po',
      attemptId: attempt.id,
      claimId: 'planning-cleanup:crash-window-0001',
      cleanupRecoveryOutcome: ''
    });

    runtime = await startFixture(fixture);
    run = await waitForCondition(() => {
      const candidate = currentRun(fixture);
      return candidate.roles.po.attempts.at(-1)?.cleanup?.state === 'reconcile_required'
        ? candidate
        : null;
    }, { intervalMs: 50, timeoutMs: 5000, label: 'lost cleanup authority reconciliation' });
    assert.equal(events(fixture).filter((event) => event.type === 'codex-exit-enter').length, 0);
    assert.equal(events(fixture).filter((event) => event.type === 'literal' && event.value === '/exit').length, 0);

    const replay = await api(runtime, `/api/planning-runs/${run.id}/continue`, {
      method: 'POST', body: originalContinue
    });
    assert.equal(replay.response.status, 200, JSON.stringify(replay.json));
    assert.equal(replay.json.replayed, true);
    assert.equal(events(fixture).filter((event) => event.type === 'codex-exit-enter').length, 0);
    assert.equal(events(fixture).filter((event) => event.type === 'literal' && event.value === '/exit').length, 0);
    assert.equal(replay.json.actions.canContinue, true);
    assert.equal(replay.json.actions.continueKind, 'cleanup_only');

    const idle = JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8'));
    idle.mode = 'idle';
    writeFileSync(fixture.tmuxStatePath, JSON.stringify(idle));
    store = planningStore(fixture);
    run = currentRun(fixture);
    const recovered = await api(runtime, `/api/planning-runs/${run.id}/continue`, {
      method: 'POST',
      body: {
        operationId: 'continue-cleanup-recover-new-0001',
        expectedStoreRevision: store.revision,
        expectedRunRevision: run.revision,
        confirmation: 'continue-multi-role-planning'
      }
    });
    assert.equal(recovered.response.status, 200, JSON.stringify(recovered.json));
    assert.equal(events(fixture).filter((event) => event.type === 'codex-exit-enter').length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'literal' && event.value === '/exit').length, 1);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('unmanaged Planning sessions and scopes fail the resource gate closed before any durable Continue', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    writeFileSync(path.join(fixture.root, 'meminfo'), [
      'MemTotal:        2048000 kB',
      'MemAvailable:      32000 kB',
      'SwapTotal:       1048576 kB',
      'SwapFree:        1048576 kB',
      ''
    ].join('\n'));
    runtime = await startFixture(fixture);
    const { started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-planning-inventory-0001'
    });
    assert.equal(started.response.status, 202, JSON.stringify(started.json));
    const runId = started.json.planningRun.id;
    const state = JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8'));
    state.extraPlanningSessions = [`codex-planning-${'a'.repeat(24)}-qa`];
    writeFileSync(fixture.tmuxStatePath, JSON.stringify(state));

    let visible = await api(runtime, `/api/planning-runs/${runId}`);
    assert.equal(visible.response.status, 200, JSON.stringify(visible.json));
    assert.equal(visible.json.actions.canContinue, false);
    assert.equal(visible.json.actions.continueReason, 'delivery_planning_run_worker_inventory_untrusted');
    let store = planningStore(fixture);
    let run = currentRun(fixture);
    const unmanagedSession = await api(runtime, `/api/planning-runs/${runId}/continue`, {
      method: 'POST',
      body: {
        operationId: 'continue-inventory-session-0001',
        expectedStoreRevision: store.revision,
        expectedRunRevision: run.revision,
        confirmation: 'continue-multi-role-planning'
      }
    });
    assert.equal(unmanagedSession.response.status, 503, JSON.stringify(unmanagedSession.json));
    assert.equal(currentRun(fixture).continueReceipts.length, 0);

    state.extraPlanningSessions = [];
    state.extraPlanningScopes = [`panefleet-planning-${'b'.repeat(24)}.scope`];
    writeFileSync(fixture.tmuxStatePath, JSON.stringify(state));
    visible = await api(runtime, `/api/planning-runs/${runId}`);
    assert.equal(visible.json.actions.canContinue, false);
    store = planningStore(fixture);
    run = currentRun(fixture);
    const unmanagedScope = await api(runtime, `/api/planning-runs/${runId}/continue`, {
      method: 'POST',
      body: {
        operationId: 'continue-inventory-scope-0001',
        expectedStoreRevision: store.revision,
        expectedRunRevision: run.revision,
        confirmation: 'continue-multi-role-planning'
      }
    });
    assert.equal(unmanagedScope.response.status, 503, JSON.stringify(unmanagedScope.json));
    assert.equal(currentRun(fixture).continueReceipts.length, 0);
    assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 0);

    state.extraPlanningScopes = [];
    writeFileSync(fixture.tmuxStatePath, JSON.stringify(state));
    writeFileSync(path.join(fixture.root, 'meminfo'), [
      'MemTotal:        2048000 kB',
      'MemAvailable:    1536000 kB',
      'SwapTotal:       1048576 kB',
      'SwapFree:        1048576 kB',
      ''
    ].join('\n'));
    store = planningStore(fixture);
    run = currentRun(fixture);
    const recovered = await api(runtime, `/api/planning-runs/${runId}/continue`, {
      method: 'POST',
      body: {
        operationId: 'continue-inventory-recovered-0001',
        expectedStoreRevision: store.revision,
        expectedRunRevision: run.revision,
        confirmation: 'continue-multi-role-planning'
      }
    });
    assert.equal(recovered.response.status, 200, JSON.stringify(recovered.json));
    assert.equal(recovered.json.planningRun.roles.po.state, 'dispatched');
    assert.equal(currentRun(fixture).continueReceipts.length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 1);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('expired provisional lease stops its exact scope once and replay remains observation-only', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture, {
      newSessionMode: 'transient_missing',
      spawnBindMs: 2500
    });
    const { started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-provisional-stop-0001'
    });
    assert.equal(started.response.status, 400, JSON.stringify(started.json));
    let run = await waitForCondition(() => {
      const candidate = currentRun(fixture);
      return candidate.roles.po.attempts.at(-1)?.spawnLease?.state === 'reconcile_required'
        ? candidate
        : null;
    }, { intervalMs: 100, timeoutMs: 15000, label: 'provisional lease reconciliation' });
    const runId = run.id;
    const scopeOnly = JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8'));
    writeFileSync(fixture.tmuxStatePath, JSON.stringify({
      ...scopeOnly,
      mode: 'absent',
      scopeActive: true
    }));
    await new Promise((resolve) => setTimeout(resolve, 700));
    run = currentRun(fixture);
    assert.equal(run.roles.po.attempts.at(-1).spawnLease.state, 'reconcile_required');
    assert.equal(events(fixture).filter((event) => event.type === 'scope-stop').length, 0);
    const visible = await api(runtime, `/api/planning-runs/${runId}`);
    assert.equal(visible.response.status, 200, JSON.stringify(visible.json));
    assert.equal(visible.json.actions.provisionalWorkerState, 'reconcile_required');
    assert.equal(visible.json.actions.canTerminateExactScope, true);
    assert.equal(visible.json.actions.canCancel, false);
    for (const forbidden of [
      'spawnLease', 'leaseId', 'contextDigest', 'launchDigest', 'bindDeadlineAt',
      'scopeUnit', 'scopeDigest', 'claimId'
    ]) assert.doesNotMatch(JSON.stringify(visible.json), new RegExp(`"${forbidden}"`));

    const store = planningStore(fixture);
    const terminateBody = {
      operationId: 'terminate-provisional-scope-0001',
      expectedStoreRevision: store.revision,
      expectedRunRevision: run.revision,
      confirmation: 'terminate-exact-planning-scope'
    };
    const stale = await api(runtime, `/api/planning-runs/${runId}/terminate-provisional-worker`, {
      method: 'POST',
      body: {
        ...terminateBody,
        operationId: 'terminate-provisional-stale-0001',
        expectedRunRevision: run.revision - 1
      }
    });
    assert.equal(stale.response.status, 409, JSON.stringify(stale.json));
    assert.equal(events(fixture).filter((event) => event.type === 'scope-stop').length, 0);

    const terminated = await api(runtime, `/api/planning-runs/${runId}/terminate-provisional-worker`, {
      method: 'POST', body: terminateBody
    });
    assert.equal(terminated.response.status, 200, JSON.stringify(terminated.json));
    assert.equal(terminated.json.actions.provisionalWorkerState, 'none');
    assert.equal(terminated.json.actions.canTerminateExactScope, false);
    assert.equal(events(fixture).filter((event) => event.type === 'scope-stop').length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'literal').length, 0);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 0);

    const replay = await api(runtime, `/api/planning-runs/${runId}/terminate-provisional-worker`, {
      method: 'POST', body: terminateBody
    });
    assert.equal(replay.response.status, 200, JSON.stringify(replay.json));
    assert.equal(replay.json.replayed, true);
    assert.equal(events(fixture).filter((event) => event.type === 'scope-stop').length, 1);
    run = currentRun(fixture);
    const noWorker = await api(runtime, `/api/planning-runs/${runId}/terminate-provisional-worker`, {
      method: 'POST',
      body: {
        operationId: 'terminate-provisional-none-0001',
        expectedStoreRevision: planningStore(fixture).revision,
        expectedRunRevision: run.revision,
        confirmation: 'terminate-exact-planning-scope'
      }
    });
    assert.equal(noWorker.response.status, 409, JSON.stringify(noWorker.json));
    assert.equal(events(fixture).filter((event) => event.type === 'scope-stop').length, 1);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('expired provisional lease terminates one still-present exact pane and scope without terminal input', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture, {
      newSessionMode: 'transient_missing',
      spawnBindMs: 2500
    });
    const { started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-provisional-present-stop-0001'
    });
    assert.equal(started.response.status, 400, JSON.stringify(started.json));
    const run = await waitForCondition(() => {
      const candidate = currentRun(fixture);
      const lease = candidate.roles.po.attempts.at(-1)?.spawnLease;
      return lease?.state === 'reconcile_required' ? candidate : null;
    }, { intervalMs: 100, timeoutMs: 15000, label: 'present provisional lease reconciliation' });
    const state = JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8'));
    assert.equal(state.mode, 'transient_missing');
    assert.equal(state.scopeActive, true);
    assert.equal(run.roles.po.attempts.at(-1).spawnLease.observed.status, 'present_unattestable');

    const terminated = await api(runtime, `/api/planning-runs/${run.id}/terminate-provisional-worker`, {
      method: 'POST',
      body: {
        operationId: 'terminate-provisional-present-scope-0001',
        expectedStoreRevision: planningStore(fixture).revision,
        expectedRunRevision: run.revision,
        confirmation: 'terminate-exact-planning-scope'
      }
    });
    assert.equal(terminated.response.status, 200, JSON.stringify(terminated.json));
    assert.equal(terminated.json.actions.provisionalWorkerState, 'none');
    assert.equal(events(fixture).filter((event) => event.type === 'scope-stop').length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'literal').length, 0);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 0);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('uncertain provisional scope stop and exact replay remain 202 until authoritative absence', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture, {
      newSessionMode: 'transient_missing',
      spawnBindMs: 2500
    });
    const { started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-provisional-stop-uncertain-0001'
    });
    assert.equal(started.response.status, 400, JSON.stringify(started.json));
    let run = await waitForCondition(() => {
      const candidate = currentRun(fixture);
      return candidate.roles.po.attempts.at(-1)?.spawnLease?.state === 'reconcile_required'
        ? candidate
        : null;
    }, { intervalMs: 100, timeoutMs: 15000, label: 'uncertain stop provisional reconciliation' });
    const state = JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8'));
    writeFileSync(fixture.tmuxStatePath, JSON.stringify({
      ...state,
      mode: 'absent',
      scopeActive: true,
      scopeStopFailure: true
    }));
    const terminateBody = {
      operationId: 'terminate-provisional-uncertain-0001',
      expectedStoreRevision: planningStore(fixture).revision,
      expectedRunRevision: run.revision,
      confirmation: 'terminate-exact-planning-scope'
    };
    const first = await api(runtime, `/api/planning-runs/${run.id}/terminate-provisional-worker`, {
      method: 'POST', body: terminateBody
    });
    assert.equal(first.response.status, 202, JSON.stringify(first.json));
    assert.equal(first.json.actions.provisionalWorkerState, 'termination_claimed');
    assert.equal(events(fixture).filter((event) => event.type === 'scope-stop').length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'literal').length, 0);

    const replay = await api(runtime, `/api/planning-runs/${run.id}/terminate-provisional-worker`, {
      method: 'POST', body: terminateBody
    });
    assert.equal(replay.response.status, 202, JSON.stringify(replay.json));
    assert.equal(replay.json.replayed, true);
    assert.equal(replay.json.actions.provisionalWorkerState, 'termination_claimed');
    assert.equal(events(fixture).filter((event) => event.type === 'scope-stop').length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'literal').length, 0);

    const absent = JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8'));
    writeFileSync(fixture.tmuxStatePath, JSON.stringify({
      ...absent,
      mode: 'absent',
      scopeActive: false,
      scopeStopFailure: false
    }));
    const completed = await api(runtime, `/api/planning-runs/${run.id}/terminate-provisional-worker`, {
      method: 'POST', body: terminateBody
    });
    assert.equal(completed.response.status, 200, JSON.stringify(completed.json));
    assert.equal(completed.json.replayed, true);
    assert.equal(completed.json.actions.provisionalWorkerState, 'none');
    assert.equal(events(fixture).filter((event) => event.type === 'scope-stop').length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'literal').length, 0);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('inactive exact scope closes a provisional lease without touching a same-named replacement pane', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture, {
      newSessionMode: 'transient_missing',
      spawnBindMs: 10_000
    });
    const { started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-provisional-replaced-0001'
    });
    assert.equal(started.response.status, 400, JSON.stringify(started.json));
    const original = JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8'));
    assert.equal(original.role, 'po');
    writeFileSync(fixture.tmuxStatePath, JSON.stringify({
      ...original,
      mode: 'replacement',
      replacement: true,
      scopeActive: false
    }));
    const run = await waitForCondition(() => {
      const candidate = currentRun(fixture);
      return candidate.roles.po.attempts.at(-1)?.spawnLease?.state === 'closed'
        ? candidate
        : null;
    }, { intervalMs: 100, timeoutMs: 10000, label: 'replacement-safe provisional close' });
    assert.equal(run.roles.po.state, 'failed');
    const replacement = JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8'));
    assert.equal(replacement.mode, 'replacement');
    assert.equal(replacement.replacement, true);
    assert.equal(events(fixture).filter((event) => event.type === 'scope-stop').length, 0);
    assert.equal(events(fixture).filter((event) => event.type === 'dead-pane-reaped').length, 0);
    assert.equal(events(fixture).filter((event) => event.type === 'literal').length, 0);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 0);
    const visible = await api(runtime, `/api/planning-runs/${run.id}`);
    assert.equal(visible.json.actions.provisionalWorkerState, 'none');
    assert.equal(visible.json.actions.canTerminateExactScope, false);
    assert.equal(visible.json.actions.canCancel, true);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('transient Planning list-panes failure reconciles without crash, completion, or terminal retry', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture);
    const { started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-transient-pane-observation-0001'
    });
    assert.equal(started.response.status, 200, JSON.stringify(started.json));
    const runId = started.json.planningRun.id;
    const state = JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8'));
    state.listPanesUnavailable = true;
    writeFileSync(fixture.tmuxStatePath, JSON.stringify(state));
    const run = await waitForCondition(() => {
      const candidate = currentRun(fixture);
      const attempt = candidate.roles.po.attempts.at(-1);
      return candidate.roles.po.state === 'reconcile_required'
        && attempt?.cleanup?.state === 'reconcile_required'
        ? candidate
        : null;
    }, { intervalMs: 100, timeoutMs: 12000, label: 'transient pane observation reconciliation' });
    const attempt = run.roles.po.attempts.at(-1);
    assert.equal(attempt.spawnLease.state, 'adopted');
    assert.notEqual(attempt.cleanup.state, 'complete');
    assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'codex-exit-enter').length, 0);
    assert.equal(events(fixture).filter((event) => event.type === 'literal' && event.value === '/exit').length, 0);
    const visible = await api(runtime, `/api/planning-runs/${runId}`);
    assert.equal(visible.json.actions.canContinue, true);
    assert.equal(visible.json.actions.continueKind, 'cleanup_only');
    assert.equal(visible.json.actions.canCancel, false);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('Planning pane replacement distinguishes an active exact scope from unavailable scope evidence', async (t) => {
  const cases = [
    {
      name: 'active exact scope',
      state: { replacement: true, scopeActive: true },
      expectedError: 'delivery_planning_run_worker_identity_changed'
    },
    {
      name: 'unavailable exact scope observation',
      state: { replacement: true, scopeActive: true, scopeObservationUnavailable: true },
      expectedError: 'delivery_planning_run_worker_scope_observation_unavailable'
    }
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fixture = createFixture();
      let runtime;
      try {
        runtime = await startFixture(fixture);
        const { started } = await createAndStartPlanningRun(runtime, fixture, {
          createOperationId: `create-pane-replacement-${testCase.name.replaceAll(' ', '-')}`
        });
        assert.equal(started.response.status, 200, JSON.stringify(started.json));
        const original = JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8'));
        writeFileSync(fixture.tmuxStatePath, JSON.stringify({ ...original, ...testCase.state }));
        const run = await waitForCondition(() => {
          const candidate = currentRun(fixture);
          const attempt = candidate.roles.po.attempts.at(-1);
          return candidate.roles.po.state === 'reconcile_required'
            && attempt?.cleanup?.state === 'reconcile_required'
            ? candidate
            : null;
        }, { intervalMs: 100, timeoutMs: 12000, label: `${testCase.name} replacement reconciliation` });
        const attempt = run.roles.po.attempts.at(-1);
        assert.equal(attempt.error, testCase.expectedError);
        assert.equal(attempt.cleanup.state, 'reconcile_required');
        assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 1);
        assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 1);
        assert.equal(events(fixture).filter((event) => event.type === 'codex-exit-enter').length, 0);
        assert.equal(events(fixture).filter((event) => event.type === 'literal' && event.value === '/exit').length, 0);
      } finally {
        await cleanupFixture(fixture, runtime);
      }
    });
  }
});

test('provisional attestation failure keeps remain-on-exit off and closes only after pane plus scope absence', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture, {
      newSessionMode: 'attestation_failure',
      spawnBindMs: 10_000
    });
    const { started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-provisional-attestation-failure-0001'
    });
    assert.equal(started.response.status, 503, JSON.stringify(started.json));
    const run = await waitForCondition(() => {
      const candidate = currentRun(fixture);
      return candidate.roles.po.attempts.at(-1)?.spawnLease?.state === 'closed'
        ? candidate
        : null;
    }, { intervalMs: 100, timeoutMs: 10000, label: 'failed provisional attestation close' });
    assert.equal(run.roles.po.state, 'failed');
    assert.equal(JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8')).mode, 'absent');
    assert.equal(events(fixture).filter((event) => event.type === 'protect').length, 0);
    assert.equal(events(fixture).filter((event) => event.type === 'literal').length, 0);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 0);
    assert.equal(events(fixture).filter((event) => event.type === 'scope-stop').length, 0);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('snapshot and review hide a scope-only provisional Planning process through exact cgroup membership', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture, {
      monitor: false,
      newSessionMode: 'transient_missing',
      spawnBindMs: 10_000
    });
    const { started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-scope-only-privacy-0001'
    });
    assert.equal(started.response.status, 400, JSON.stringify(started.json));
    const run = currentRun(fixture);
    const attempt = run.roles.po.attempts.at(-1);
    assert.equal(attempt.spawnLease.state, 'bound');
    assert.ok(!attempt.codexPid);
    const state = JSON.parse(readFileSync(fixture.tmuxStatePath, 'utf8'));
    writeFileSync(fixture.tmuxStatePath, JSON.stringify({
      ...state,
      mode: 'scope_only',
      session: attempt.spawnLease.session,
      role: 'po',
      scopeActive: true,
      hidePlanningPaneFromGlobal: true
    }));
    const scopeProcessFile = path.join(
      fixture.cgroupRoot,
      'user.slice',
      'planning.slice',
      attempt.spawnLease.scopeUnit,
      'cgroup.procs'
    );
    writeFileSync(scopeProcessFile, `${fixture.scopeOnlyPid}\n`);

    const visible = await api(runtime, `/api/planning-runs/${run.id}`);
    assert.equal(visible.response.status, 200, JSON.stringify(visible.json));
    assert.doesNotMatch(JSON.stringify(visible.json), new RegExp(attempt.id));
    const snapshot = await api(runtime, '/api/snapshot');
    assert.equal(snapshot.response.status, 200, JSON.stringify(snapshot.json));
    assert.doesNotMatch(JSON.stringify(snapshot.json.topProcesses), new RegExp(String(fixture.scopeOnlyPid)));
    assert.doesNotMatch(
      JSON.stringify(snapshot.json.topProcesses),
      new RegExp(fixture.planningCodexExecutable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
    assert.ok(snapshot.json.audit.every((entry) => (
      !String(entry.action || '').startsWith('delivery_planning_run.')
    )));

    const reviewStart = await api(runtime, '/api/review/start', { method: 'POST', body: {} });
    assert.equal(reviewStart.response.status, 500, JSON.stringify(reviewStart.json));
    const reviewContext = readFileSync(
      path.join(fixture.dataDir, 'reviews', 'latest-context.md'),
      'utf8'
    );
    assert.doesNotMatch(reviewContext, new RegExp(String(fixture.scopeOnlyPid)));
    assert.doesNotMatch(reviewContext, new RegExp(attempt.id));
    assert.doesNotMatch(reviewContext, new RegExp(attempt.spawnLease.session));
    assert.doesNotMatch(reviewContext, new RegExp(attempt.spawnLease.scopeUnit));
    assert.doesNotMatch(
      reviewContext,
      new RegExp(fixture.planningCodexExecutable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('unchanged four-role synthesis stops in needs_input and never exposes or applies a candidate', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture);
    const { plan, created, started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-unchanged-candidate-0001'
    });
    assert.equal(started.response.status, 200, JSON.stringify(started.json));
    for (const role of roles) {
      const dispatched = role === 'po' ? currentRun(fixture) : await waitForRole(fixture, role);
      setWorkerIdle(fixture, role);
      appendRoleResult(fixture, dispatched, role, plan.roles[role]);
      if (role !== 'dev') await waitForRole(fixture, roles[roles.indexOf(role) + 1]);
    }
    const blocked = await waitForCondition(() => {
      const candidate = currentRun(fixture);
      const cleanup = candidate.roles.dev.attempts.at(-1)?.cleanup;
      return candidate.condition === 'needs_input' && cleanup?.state === 'complete'
        ? candidate
        : null;
    }, { intervalMs: 100, timeoutMs: 40000, label: 'unchanged candidate synthesis blocker' });
    assert.equal(blocked.synthesisBlocker.code, 'delivery_planning_run_candidate_unchanged');
    assert.equal(blocked.candidate, null);
    assert.equal(blocked.applyOutbox.state, 'held');
    const visible = await api(runtime, `/api/planning-runs/${blocked.id}`);
    assert.equal(visible.response.status, 200, JSON.stringify(visible.json));
    assert.equal(visible.json.actions.canApply, false);
    assert.equal(visible.json.actions.canContinue, false);
    const planBefore = await api(runtime, `/api/delivery-plans/${plan.id}`);
    assert.equal(planBefore.json.plan.revision, created.json.plan.revision);
    assert.equal(planBefore.json.digest, created.json.digest);
    const apply = await api(runtime, `/api/planning-runs/${blocked.id}/apply`, {
      method: 'POST',
      body: {
        operationId: 'apply-unchanged-candidate-0001',
        expectedStoreRevision: planningStore(fixture).revision,
        expectedRunRevision: blocked.revision,
        expectedPlanStoreRevision: planBefore.json.planStoreRevision,
        expectedPlanRevision: planBefore.json.plan.revision,
        expectedPlanDigest: planBefore.json.digest,
        expectedCandidateDigest: '0'.repeat(64),
        confirmation: 'apply-planning-candidate'
      }
    });
    assert.equal(apply.response.status, 409, JSON.stringify(apply.json));
    const planAfter = await api(runtime, `/api/delivery-plans/${plan.id}`);
    assert.equal(planAfter.json.plan.revision, created.json.plan.revision);
    assert.equal(planAfter.json.digest, created.json.digest);
    assert.equal(currentRun(fixture).applyOutbox.state, 'held');
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('host native Codex pin matches exact direct argv and rollout telemetry', {
  skip: !hostNativeCodex || hostNativeCodex.version !== '0.147.0'
}, async () => {
  const fixture = createFixture({
    planningExecutablePath: hostNativeCodex.executable,
    planningVersion: hostNativeCodex.version
  });
  let runtime;
  try {
    runtime = await startFixture(fixture);
    const { started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-host-native-codex-0001'
    });
    assert.equal(started.response.status, 200, JSON.stringify(started.json));
    const attempt = currentRun(fixture).roles.po.attempts.at(-1);
    assert.equal(attempt.state, 'dispatched');
    assert.equal(attempt.codexPid, fixture.workerPids.po);
    assert.equal(attempt.rolloutId, rolloutId('po'));
    assert.match(attempt.commandDigest, /^[a-f0-9]{64}$/);
    const launched = events(fixture).find((event) => event.type === 'new-session');
    assert.ok(launched);
    assert.ok(launched.argv.includes(hostNativeCodex.executable));
    assert.ok(!launched.argv.some((item) => /codex\.js$/.test(item)));
    const nativeIndex = launched.argv.indexOf(hostNativeCodex.executable);
    assert.ok(nativeIndex > launched.argv.indexOf('/usr/bin/systemd-run'));
    assert.equal(launched.argv[nativeIndex + 1], '--strict-config');
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('Planning worker adoption rejects wrong and deleted process images with identical argv, env, and telemetry', async () => {
  for (const scenario of [
    { name: 'wrong-image', target: '/usr/bin/true', error: 'delivery_planning_run_worker_executable_mismatch' },
    {
      name: 'deleted-image',
      target: '',
      error: 'delivery_planning_run_worker_executable_deleted'
    }
  ]) {
    const fixture = createFixture();
    let runtime;
    try {
      replacePlanningProcessExecutable(
        fixture,
        'po',
        scenario.target || `${fixture.planningCodexExecutable} (deleted)`
      );
      runtime = await startFixture(fixture, { monitor: false });
      const { started } = await createAndStartPlanningRun(runtime, fixture, {
        createOperationId: `create-process-image-${scenario.name}-0001`
      });
      assert.equal(started.response.status, 400, `${scenario.name}: ${JSON.stringify(started.json)}`);
      assert.equal(started.json.error, scenario.error);
      const attempt = currentRun(fixture).roles.po.attempts.at(-1);
      assert.equal(attempt.spawnLease.state, 'bound');
      assert.equal(attempt.state, 'spawn_claimed');
      assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 1);
      assert.equal(events(fixture).filter((event) => event.type === 'protect').length, 0);
      assert.equal(events(fixture).filter((event) => event.type === 'literal').length, 0);
      assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 0);
    } finally {
      await cleanupFixture(fixture, runtime);
    }
  }
});

test('uncertain Planning prompt Enter failure is durable and never retried', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture, { newSessionMode: 'enter_failure' });
    const { started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-enter-failure-0001'
    });
    assert.equal(started.response.status, 500, JSON.stringify(started.json));
    assert.equal(started.json.detail, 'terminal_submit_failed');
    const reconciled = await waitForCondition(() => {
      const run = currentRun(fixture);
      return run.roles.po.state === 'reconcile_required' ? run : null;
    }, { intervalMs: 50, timeoutMs: 10000, label: 'uncertain prompt Enter reconciliation' });
    assert.equal(reconciled.condition, 'reconcile_required');
    assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 1);
    assert.ok(events(fixture).some((event) => event.type === 'literal' && event.chars > 0));
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter-failed').length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 0);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter-failed').length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'literal').length > 0, true);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('Planning re-attests the exact process image after pane protection and before literal input', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture, {
      monitor: false,
      newSessionMode: 'pre_literal_process_image_swap'
    });
    const { started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-pre-literal-process-image-swap-0001'
    });
    assert.equal(started.response.status, 400, JSON.stringify(started.json));
    assert.equal(started.json.error, 'delivery_planning_run_worker_executable_mismatch');
    const attempt = currentRun(fixture).roles.po.attempts.at(-1);
    assert.equal(attempt.state, 'crashed');
    assert.equal(events(fixture).filter((event) => event.type === 'protect').length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'process-image-swap-before-literal').length, 1);
    assert.equal(events(fixture).filter((event) => event.type === 'literal').length, 0);
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 0);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('Planning worker process image swap after literal typing is rejected by the final pre-Enter guard', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture, {
      monitor: false,
      newSessionMode: 'process_image_swap'
    });
    const { started } = await createAndStartPlanningRun(runtime, fixture, {
      createOperationId: 'create-process-image-pre-submit-0001'
    });
    assert.equal(started.response.status, 400, JSON.stringify(started.json));
    assert.equal(started.json.error, 'delivery_planning_run_worker_executable_mismatch');
    const attempt = currentRun(fixture).roles.po.attempts.at(-1);
    assert.equal(attempt.state, 'reconcile_required');
    assert.equal(events(fixture).filter((event) => event.type === 'process-image-swap').length, 1);
    assert.ok(events(fixture).some((event) => event.type === 'literal' && event.chars > 0));
    assert.equal(events(fixture).filter((event) => event.type === 'prompt-enter').length, 0);
  } finally {
    await cleanupFixture(fixture, runtime);
  }
});

test('Planning native executable pins reject disabled, script, symlink, and hash drift without retry', async () => {
  const scenarios = [
    {
      name: 'disabled',
      configure: () => ({
        planningCodexMode: 'disabled',
        planningCodexExecutable: '',
        planningCodexVersion: '',
        planningCodexSha256: ''
      }),
      reason: 'delivery_planning_run_codex_disabled'
    },
    {
      name: 'script',
      configure: (fixture) => {
        const script = path.join(fixture.binDir, 'systemctl');
        return {
          planningCodexExecutable: script,
          planningCodexSha256: createHash('sha256').update(readFileSync(script)).digest('hex')
        };
      },
      reason: 'delivery_planning_run_codex_executable_not_native'
    },
    {
      name: 'symlink',
      configure: (fixture) => {
        const linked = path.join(fixture.root, 'linked-native-codex');
        symlinkSync(fixture.planningCodexExecutable, linked);
        return { planningCodexExecutable: linked };
      },
      reason: 'delivery_planning_run_codex_executable_untrusted'
    },
    {
      name: 'sha256',
      configure: () => ({ planningCodexSha256: 'f'.repeat(64) }),
      reason: 'delivery_planning_run_codex_sha256_mismatch'
    }
  ];
  for (const scenario of scenarios) {
    const fixture = createFixture();
    let runtime;
    try {
      runtime = await startFixture(fixture, scenario.configure(fixture));
      const { started } = await createAndStartPlanningRun(runtime, fixture, {
        createOperationId: `create-native-pin-${scenario.name}-0001`
      });
      assert.equal(started.response.status, 202, `${scenario.name}: ${JSON.stringify(started.json)}`);
      assert.equal(started.json.planningRun.condition, 'resource_wait');
      assert.equal(started.json.planningRun.blocker, scenario.reason);
      assert.equal(currentRun(fixture).roles.po.attempts.length, 0);
      const revision = planningStore(fixture).revision;
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(planningStore(fixture).revision, revision, `${scenario.name} retried without Continue`);
      assert.equal(events(fixture).filter((event) => event.type === 'new-session').length, 0);
      assert.equal(events(fixture).filter((event) => event.type === 'literal').length, 0);
    } finally {
      await cleanupFixture(fixture, runtime);
    }
  }
});
