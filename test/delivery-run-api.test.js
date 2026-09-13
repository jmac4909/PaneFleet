import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

import { stopChildProcess } from './helpers/child-process.js';
import { installBlockedTool, installExecutable } from './helpers/executables.js';
import { fetchWithTimeout, responseJson, waitForHttpServer } from './helpers/http.js';
import { unusedLoopbackPort } from './helpers/unused-loopback-port.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');
const loopbackHost = '127.0.0.1';
const workerSessionCreated = 1_700_000_000;
const workerSessionCreatedAt = new Date(workerSessionCreated * 1000).toISOString();
const workerPanePid = 4100;
const workerPaneId = 'codex-fixture:0.0';
const workerTmuxPaneId = '%77';
const workerTty = '/dev/pts/77';
const workerRolloutId = '11111111-1111-4111-8111-111111111111';
const workerCommand = 'codex --sandbox workspace-write --ask-for-approval never --config sandbox_workspace_write.network_access=false';

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

function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'panefleet-delivery-run-api-'));
  const dataDir = path.join(root, 'data');
  const publicDir = path.join(root, 'public');
  const binDir = path.join(root, 'bin');
  const codexHome = path.join(root, 'codex-home');
  const projectsRoot = path.join(root, 'projects');
  const workspace = path.join(projectsRoot, 'delivery-workspace');
  const abortWorkspace = path.join(projectsRoot, 'abort-workspace');
  const toolLogPath = path.join(root, 'tools.log');
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '08', '16');
  for (const directory of [dataDir, publicDir, binDir, codexHome, projectsRoot, sessionsDir]) {
    mkdirSync(directory, { recursive: true });
  }
  chmodSync(dataDir, 0o700);
  writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>PaneFleet run API fixture</title>\n');
  writeFileSync(path.join(root, 'services.json'), '[]\n');
  writeFileSync(path.join(root, 'host-config.json'), '{}\n');
  writeFileSync(path.join(codexHome, 'models_cache.json'), '{"models":[]}\n');
  writeFileSync(path.join(root, 'AGENTS.md'), 'Host delivery rules.\n');
  writeFileSync(path.join(projectsRoot, 'AGENTS.md'), 'Project delivery rules.\n');
  initializeGitWorkspace(workspace);
  initializeGitWorkspace(abortWorkspace);

  const rolloutPath = path.join(sessionsDir, `rollout-${workerRolloutId}.jsonl`);
  const initialTimestamp = new Date().toISOString();
  writeFileSync(rolloutPath, [
    JSON.stringify({
      timestamp: initialTimestamp,
      type: 'session_meta',
      payload: { id: workerRolloutId }
    }),
    JSON.stringify({
      timestamp: initialTimestamp,
      type: 'turn_context',
      payload: {
        approval_policy: 'never',
        sandbox_policy: { type: 'workspace-write', network_access: false }
      }
    })
  ].join('\n') + '\n');
  // PaneFleet resolves a Codex rollout from an open process descriptor. Keep
  // this fixture descriptor open for the lifetime of the black-box server.
  const rolloutFd = openSync(rolloutPath, 'r');
  const workerPid = process.pid;
  const workerIdentity = {
    pid: workerPid,
    rolloutId: workerRolloutId,
    sourceId: createHash('sha256').update(rolloutPath).digest('hex').slice(0, 24),
    commandDigest: canonicalSha256([`${workerPid}:${workerCommand}`])
  };
  const workerRequestIdentity = {
    sessionCreatedAt: workerSessionCreatedAt,
    paneId: workerPaneId,
    tmuxPaneId: workerTmuxPaneId,
    panePid: workerPanePid
  };

  for (const name of ['aws', 'curl', 'journalctl', 'ss']) installBlockedTool(binDir, name);
  installExecutable(binDir, 'ps', `#!/bin/sh
case "$*" in
  *tty*)
    printf '%s\n' 'PID PPID TT STAT %CPU %MEM RSS CMD'
    printf '%s\n' '${workerPanePid} 1 pts/77 Ss+ 0.0 0.0 1000 bash'
    printf '%s\n' '${workerPid} ${workerPanePid} pts/77 S+ 0.0 0.0 1000 ${workerCommand}'
    ;;
  *)
    printf '%s\n' 'PID PPID STAT ELAPSED %CPU %MEM RSS CMD'
    printf '%s\n' '${workerPid} ${workerPanePid} S+ 00:01 0.0 0.0 1000 ${workerCommand}'
    ;;
esac
`);
  installExecutable(binDir, 'tmux', `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "$ORCH_TOOL_LOG"
case "$*" in
  *'-L pane-fleet-control'*) exit 0 ;;
  *'list-panes -a'*)
    printf '%s\n' 'codex-fixture|${workerSessionCreated}|0|0|0|1|${workerPanePid}|${workerTty}|${workerTmuxPaneId}|0||bash|${workspace}|fixture'
    ;;
  *'list-panes -t =codex-fixture'*)
    printf '%s\n' 'codex-fixture|${workerSessionCreated}|0|0|1|bash|${workspace}|${workerTmuxPaneId}|${workerPanePid}|0|'
    ;;
  *'capture-pane'*)
    printf '%s\n' '› Ready' 'gpt-5.6 • high'
    ;;
  *) exit 97 ;;
esac
`);

  return {
    root,
    dataDir,
    binDir,
    codexHome,
    projectsRoot,
    workspace,
    abortWorkspace,
    toolLogPath,
    rolloutPath,
    rolloutFd,
    workerIdentity,
    workerRequestIdentity,
    deliveryPlanPath: path.join(dataDir, 'delivery-plans.json'),
    deliveryRunPath: path.join(dataDir, 'delivery-runs.json'),
    missionQueuePath: path.join(dataDir, 'mission-queue.json')
  };
}

async function startFixture(fixture) {
  const port = await unusedLoopbackPort();
  const baseUrl = `http://${loopbackHost}:${port}`;
  let output = '';
  const child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
    cwd: fixture.root,
    env: {
      ...process.env,
      HOME: fixture.root,
      NODE_ENV: 'test',
      HOST: loopbackHost,
      PORT: String(port),
      ORCHESTRATOR_RUNTIME_ROOT: fixture.root,
      ORCHESTRATOR_HOST_CONFIG: path.join(fixture.root, 'host-config.json'),
      ORCHESTRATOR_PROJECTS_ROOT: fixture.projectsRoot,
      ORCHESTRATOR_AGENT_WORKSPACES_ROOT: path.join(fixture.projectsRoot, 'agent-workspaces'),
      ORCH_CONTROL_PLANE_MODE: 'foreground',
      ORCH_TOOL_LOG: fixture.toolLogPath,
      CODEX_HOME: fixture.codexHome,
      DELIVERY_PLAN_PATH: fixture.deliveryPlanPath,
      DELIVERY_RUN_PATH: fixture.deliveryRunPath,
      MISSION_QUEUE_PATH: fixture.missionQueuePath,
      PATH: `${fixture.binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      AWS_EC2_METADATA_DISABLED: 'true',
      SNAPSHOT_EVENT_MS: '3600000',
      PROMPT_QUEUE_MONITOR_MS: '3600000',
      SSH_RESCUE_MONITOR_MS: '3600000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await waitForHttpServer({ baseUrl, child, output: () => output, label: 'delivery run API fixture' });
  const index = await fetchWithTimeout(`${baseUrl}/`, {}, 3000);
  const cookie = String(index.headers.get('set-cookie') || '').split(';', 1)[0];
  assert.match(cookie, /^host_control_session=/);
  return { child, baseUrl, cookie, output: () => output };
}

async function api(runtime, pathname, { method = 'GET', body } = {}) {
  const headers = { cookie: runtime.cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetchWithTimeout(`${runtime.baseUrl}${pathname}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }, 8000);
  return { response, json: await responseJson(response) };
}

function toolLog(fixture) {
  try {
    return readFileSync(fixture.toolLogPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function assertNoTerminalDelivery(fixture) {
  assert.doesNotMatch(toolLog(fixture), /tmux:.*\bsend-keys\b/);
}

function markMissionVerifying(fixture, missionId, resultSummary) {
  const store = JSON.parse(readFileSync(fixture.missionQueuePath, 'utf8'));
  const job = store.jobs.find((candidate) => candidate.id === missionId);
  assert.ok(job, `fixture Mission ${missionId} must exist`);
  assert.equal(job.status, 'ready');
  assert.ok(job.deliveryBinding);
  const claimedMs = Math.max(Date.now(), Date.parse(job.updatedAt) + 1);
  const at = new Date(claimedMs).toISOString();
  const attemptId = `attempt-fixture-${job.deliveryBinding.stepId.toLowerCase()}-12345678`;
  const confirmationMarker = `[PaneFleet Dispatch ${attemptId}]`;
  const rolloutStartOffset = statSync(fixture.rolloutPath).size;
  const result = [
    '[PANEFLEET DELIVERY RESULT]',
    `PLAN: ${job.deliveryBinding.planId}`,
    `DIGEST: ${job.deliveryBinding.planDigest}`,
    `STEP: ${job.deliveryBinding.stepId}`,
    'STATUS: complete',
    `RESULT: ${resultSummary}`,
    `FILES: ${job.deliveryBinding.stepId === 'STEP-001' ? 'tracked.txt' : 'next.txt'}`,
    'CHECKS: git diff --check passed',
    'EVIDENCE: bounded workspace change is ready for operator review',
    'RISKS: none observed',
    'NEXT ACTION: operator acceptance review',
    '[/PANEFLEET DELIVERY RESULT]'
  ].join('\n');
  appendFileSync(fixture.rolloutPath, [
    JSON.stringify({
      timestamp: new Date(claimedMs + 1).toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `Bound delivery prompt\n${confirmationMarker}` }]
      }
    }),
    JSON.stringify({
      timestamp: new Date(claimedMs + 2).toISOString(),
      type: 'turn_context',
      payload: {
        approval_policy: 'never',
        sandbox_policy: { type: 'workspace-write', network_access: false }
      }
    }),
    JSON.stringify({
      timestamp: new Date(claimedMs + 3).toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: result }]
      }
    })
  ].join('\n') + '\n');
  const attempt = {
    id: attemptId,
    kind: 'dispatch',
    status: 'verifying',
    session: 'codex-fixture',
    sessionCreatedAt: workerSessionCreatedAt,
    paneId: workerPaneId,
    tmuxPaneId: workerTmuxPaneId,
    panePid: workerPanePid,
    codexIdentity: fixture.workerIdentity,
    rolloutStartOffset,
    promptChars: 100,
    confirmationMarker,
    claimedAt: at,
    submittedAt: new Date(claimedMs + 1).toISOString(),
    finishedAt: null
  };
  Object.assign(job, {
    revision: job.revision + 1,
    status: 'verifying',
    assignedSession: attempt.session,
    assignedSessionCreatedAt: attempt.sessionCreatedAt,
    assignedPaneId: attempt.paneId,
    assignedTmuxPaneId: attempt.tmuxPaneId,
    assignedPanePid: attempt.panePid,
    activeAttempt: { ...attempt },
    attempts: [...job.attempts, attempt],
    resultSummary,
    blocker: '',
    startedAt: at,
    needsYouAt: null,
    verifyingAt: new Date(claimedMs + 4).toISOString(),
    finishedAt: null,
    verification: { status: 'pending', note: '', at: null },
    updatedAt: new Date(claimedMs + 4).toISOString()
  });
  store.revision += 1;
  writeFileSync(fixture.missionQueuePath, `${JSON.stringify(store, null, 2)}\n`);
  return { missionId, revision: job.revision, rolloutStartOffset };
}

function deliveryPlan({ id, workspace, baseline, elevatedAuthority = false }) {
  return {
    version: 1,
    id,
    revision: 1,
    phase: 'planning',
    title: elevatedAuthority ? 'Attempt an elevated delivery' : 'Deliver two bounded source steps',
    request: 'Create a local-only, reviewable source delivery without committing, pushing, deploying, or sending messages.',
    workspace,
    baseline,
    classification: {
      intent: 'change',
      depth: 'standard',
      // Keep the risk class otherwise eligible so the rejected fixture proves
      // the non-local authority guard itself rather than an earlier risk gate.
      risk: 'local_reversible',
      dataClasses: [],
      mutationSurfaces: elevatedAuthority ? ['workspace', 'network'] : ['workspace']
    },
    roles: {
      po: {
        user: 'PaneFleet operator',
        problem: 'Source work can drift from the reviewed definition.',
        outcome: 'Each source step stays bound to the approved plan and baseline.',
        value: 'Make local implementation reviewable and recoverable.',
        nonGoals: ['Do not commit, push, deploy, control services, or send external messages.'],
        assumptions: [],
        openQuestions: []
      },
      ba: {
        requirements: [
          { id: 'REQ-001', text: 'The first source step is durable and baseline-bound.' },
          { id: 'REQ-002', text: 'The second source step is released only after verification.' }
        ],
        dependencies: [],
        edgeCases: ['A restart occurs after the Mission is linked.'],
        constraints: ['Only approved workspace paths may change.'],
        openQuestions: []
      },
      dev: {
        architecture: 'Use a durable run record and one immutable Mission binding per ordered step.',
        steps: [
          {
            id: 'STEP-001',
            title: 'Change the tracked source',
            outcome: 'The approved tracked file contains the first bounded change.',
            requirementIds: ['REQ-001'],
            scopePaths: ['tracked.txt'],
            checks: ['git diff --check']
          },
          {
            id: 'STEP-002',
            title: 'Add the follow-up source',
            outcome: 'The second approved path is changed only after the first passes.',
            requirementIds: ['REQ-002'],
            scopePaths: ['next.txt'],
            checks: ['git diff --check']
          }
        ],
        risks: ['A stale browser could submit an obsolete digest or revision.'],
        rollback: 'Discard only the approved local source paths after operator review.',
        openQuestions: []
      },
      qa: {
        acceptanceCriteria: [
          { id: 'AC-001', text: 'The first step remains within tracked.txt.', requirementIds: ['REQ-001'] },
          { id: 'AC-002', text: 'The second step is held until the first passes.', requirementIds: ['REQ-002'] }
        ],
        testStrategy: 'Check durable binding, restart recovery, local scope, and explicit verification gates.',
        regressionChecks: ['Run creation and reconciliation never type into tmux.'],
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
      network: elevatedAuthority,
      serviceControl: false,
      destructive: false,
      externalMessages: false
    },
    approval: { digest: '', approvedAt: null, planRevision: null },
    gates: { implementationCaptured: false, qaPassed: false, releaseVerified: false },
    blocker: ''
  };
}

function expectedTaskDefinition(plan, planDigest, stepId) {
  const step = plan.roles.dev.steps.find((candidate) => candidate.id === stepId);
  assert.ok(step, `fixture step ${stepId} must exist`);
  const acceptanceCriteria = plan.roles.qa.acceptanceCriteria.filter((criterion) => (
    criterion.requirementIds.some((requirementId) => step.requirementIds.includes(requirementId))
  ));
  const stepDigest = canonicalSha256(step);
  return {
    stepDigest,
    acceptanceIds: acceptanceCriteria.map((criterion) => criterion.id),
    allowedPaths: [...step.scopePaths],
    missionDefinitionDigest: canonicalSha256({
      version: 2,
      role: 'implementation',
      planId: plan.id,
      planDigest,
      stepId,
      stepDigest,
      acceptanceCriteria,
      acceptanceIds: acceptanceCriteria.map((criterion) => criterion.id),
      allowedPaths: [...step.scopePaths],
      requiredChecks: [...step.checks]
    })
  };
}

async function approvePlan(runtime, plan, expectedStoreRevision) {
  const created = await api(runtime, '/api/delivery-plans', {
    method: 'POST',
    body: {
      operationId: `create-${plan.id}`,
      expectedStoreRevision,
      plan
    }
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.json));
  const ready = await api(runtime, `/api/delivery-plans/${plan.id}/transition`, {
    method: 'POST',
    body: {
      operationId: `ready-${plan.id}`,
      expectedStoreRevision: created.json.storeRevision,
      expectedPlanRevision: created.json.plan.revision,
      expectedDigest: created.json.digest,
      to: 'ready_for_approval',
      conditions: {}
    }
  });
  assert.equal(ready.response.status, 200, JSON.stringify(ready.json));
  const approved = await api(runtime, `/api/delivery-plans/${plan.id}/transition`, {
    method: 'POST',
    body: {
      operationId: `approve-${plan.id}`,
      expectedStoreRevision: ready.json.storeRevision,
      expectedPlanRevision: ready.json.plan.revision,
      expectedDigest: ready.json.digest,
      to: 'approved',
      conditions: { confirmation: 'approve-plan' }
    }
  });
  assert.equal(approved.response.status, 200, JSON.stringify(approved.json));
  return approved.json;
}

function createRunBody(approved, expectedPlanStoreRevision, overrides = {}) {
  return {
    operationId: 'create-local-run-0001',
    expectedPlanStoreRevision,
    expectedPlanRevision: approved.plan.revision,
    expectedDigest: approved.digest,
    expectedRunStoreRevision: 0,
    confirmation: 'create-local-delivery-run',
    ...overrides
  };
}

async function assertRunError(result, status, pattern) {
  assert.equal(result.response.status, status, JSON.stringify(result.json));
  assert.match(String(result.json.error || ''), pattern);
}

test('delivery-run API binds one Mission durably, replays safely, and never dispatches during create or reconcile', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture);

    const captured = await api(runtime, '/api/delivery-plans/baseline', {
      method: 'POST',
      body: { workspace: fixture.workspace }
    });
    assert.equal(captured.response.status, 200, JSON.stringify(captured.json));
    const approved = await approvePlan(runtime, deliveryPlan({
      id: 'plan-local-run-12345678',
      workspace: fixture.workspace,
      baseline: captured.json.baseline
    }), 0);
    let planStoreRevision = approved.storeRevision;

    const createBody = createRunBody(approved, planStoreRevision);
    await assertRunError(await api(runtime, `/api/delivery-plans/${approved.plan.id}/runs`, {
      method: 'POST',
      body: { ...createBody, operationId: 'create-stale-digest-0001', expectedDigest: '0'.repeat(64) }
    }), 409, /^delivery_(?:run|plan)_.*digest.*conflict$/);
    await assertRunError(await api(runtime, `/api/delivery-plans/${approved.plan.id}/runs`, {
      method: 'POST',
      body: { ...createBody, operationId: 'create-stale-revision-0001', expectedPlanRevision: approved.plan.revision + 1 }
    }), 409, /^delivery_(?:run|plan)_.*revision.*conflict$/);

    writeFileSync(path.join(fixture.workspace, 'tracked.txt'), 'baseline changed before run\n');
    await assertRunError(await api(runtime, `/api/delivery-plans/${approved.plan.id}/runs`, {
      method: 'POST',
      body: { ...createBody, operationId: 'create-stale-baseline-0001' }
    }), 409, /^delivery_run_.*baseline.*(?:changed|conflict)$/);
    let snapshot = await api(runtime, '/api/snapshot');
    assert.equal(snapshot.response.status, 200);
    assert.equal(snapshot.json.missions.jobs.some((mission) => mission.deliveryBinding), false);
    assertNoTerminalDelivery(fixture);
    writeFileSync(path.join(fixture.workspace, 'tracked.txt'), 'baseline\n');

    const elevated = await approvePlan(runtime, deliveryPlan({
      id: 'plan-elevated-run-12345678',
      workspace: fixture.workspace,
      baseline: captured.json.baseline,
      elevatedAuthority: true
    }), planStoreRevision);
    planStoreRevision = elevated.storeRevision;
    await assertRunError(await api(runtime, `/api/delivery-plans/${elevated.plan.id}/runs`, {
      method: 'POST',
      body: {
        ...createRunBody(elevated, planStoreRevision),
        operationId: 'create-elevated-run-0001'
      }
    }), 409, /^delivery_run_local_authority_required$/);
    assertNoTerminalDelivery(fixture);

    const currentBaseline = await api(runtime, '/api/delivery-plans/baseline', {
      method: 'POST',
      body: { workspace: fixture.workspace }
    });
    assert.equal(currentBaseline.response.status, 200);
    assert.equal(currentBaseline.json.baseline.head, captured.json.baseline.head);
    assert.equal(currentBaseline.json.baseline.workingTreeDigest, captured.json.baseline.workingTreeDigest);
    assert.equal(currentBaseline.json.baseline.instructionsDigest, captured.json.baseline.instructionsDigest);

    const finalCreateBody = createRunBody(approved, planStoreRevision);
    const created = await api(runtime, `/api/delivery-plans/${approved.plan.id}/runs`, {
      method: 'POST',
      body: finalCreateBody
    });
    assert.equal(created.response.status, 200, JSON.stringify(created.json));
    assert.equal(created.json.replayed, false);
    assert.match(created.json.deliveryRun.id, /^run-[a-z0-9-]{8,64}$/);
    assert.equal(created.json.deliveryRun.planId, approved.plan.id);
    assert.equal(created.json.deliveryRun.planDigest, approved.digest);
    assert.equal(created.json.deliveryRun.tasks.length, 2);
    assert.deepEqual(created.json.deliveryRun.tasks.map((task) => task.state), ['mission_linked', 'pending']);
    assert.deepEqual(created.json.deliveryRun.outbox.map((item) => item.state), ['applied', 'held']);
    assert.equal(created.json.deliveryRun.startBaseline.version, 2);
    assert.deepEqual(created.json.deliveryRun.startBaseline.approvedScopes, ['next.txt', 'tracked.txt']);
    assert.equal(created.json.deliveryRun.startBaseline.gitMetadata.headRef, 'refs/heads/main');
    assert.equal(created.json.deliveryRun.startBaseline.gitMetadata.sparseCheckout, false);
    assert.equal(created.json.deliveryRun.startBaseline.gitMetadata.sparseIndex, false);
    const expectedTaskDefinitions = approved.plan.roles.dev.steps.map((step) => (
      expectedTaskDefinition(approved.plan, approved.digest, step.id)
    ));
    assert.deepEqual(created.json.deliveryRun.tasks.map((task) => ({
      stepDigest: task.stepDigest,
      acceptanceIds: task.acceptanceIds,
      allowedPaths: task.allowedPaths,
      missionDefinitionDigest: task.missionDefinitionDigest
    })), expectedTaskDefinitions);
    assert.notEqual(
      created.json.deliveryRun.tasks[0].missionDefinitionDigest,
      canonicalSha256({
        version: 2,
        role: 'implementation',
        planId: approved.plan.id,
        planDigest: approved.digest,
        stepId: 'STEP-001',
        stepDigest: expectedTaskDefinitions[0].stepDigest,
        acceptanceCriteria: approved.plan.roles.qa.acceptanceCriteria.slice(0, 1),
        acceptanceIds: ['AC-001'],
        allowedPaths: ['tracked.txt'],
        requiredChecks: ['npm test']
      }),
      'required checks must be part of the immutable Mission definition digest'
    );
    const runId = created.json.deliveryRun.id;
    const missionId = created.json.deliveryRun.tasks[0].missionId;
    assert.match(missionId, /^mission-[a-z0-9-]{8,64}$/);

    const replayed = await api(runtime, `/api/delivery-plans/${approved.plan.id}/runs`, {
      method: 'POST',
      body: finalCreateBody
    });
    assert.equal(replayed.response.status, 200, JSON.stringify(replayed.json));
    assert.equal(replayed.json.replayed, true);
    assert.equal(replayed.json.deliveryRun.id, runId);
    assert.equal(replayed.json.deliveryRun.tasks[0].missionId, missionId);
    const conflictingReplay = await api(runtime, `/api/delivery-plans/${approved.plan.id}/runs`, {
      method: 'POST',
      body: { ...finalCreateBody, expectedPlanRevision: finalCreateBody.expectedPlanRevision + 1 }
    });
    assert.equal(conflictingReplay.response.status, 409, JSON.stringify(conflictingReplay.json));
    assert.equal(conflictingReplay.json.error, 'delivery_run_operation_conflict');

    const detail = await api(runtime, `/api/delivery-runs/${runId}`);
    assert.equal(detail.response.status, 200, JSON.stringify(detail.json));
    assert.equal(detail.json.deliveryRun.id, runId);
    assert.equal(detail.json.deliveryRun.tasks[0].missionId, missionId);
    const planDetail = await api(runtime, `/api/delivery-plans/${approved.plan.id}`);
    assert.equal(planDetail.response.status, 200, JSON.stringify(planDetail.json));
    assert.equal(planDetail.json.deliveryRun.id, runId);
    assert.equal(planDetail.json.planStoreRevision, created.json.planStoreRevision);
    assert.equal(planDetail.json.deliveryRunStoreRevision, created.json.deliveryRunStoreRevision);
    snapshot = await api(runtime, '/api/snapshot');
    const bound = snapshot.json.missions.jobs.filter((mission) => mission.deliveryBinding?.runId === runId);
    assert.equal(bound.length, 1);
    assert.equal(bound[0].id, missionId);
    assert.equal(bound[0].status, 'ready');
    assert.deepEqual({
      ...bound[0].deliveryBinding,
      envelopeDigest: undefined
    }, {
      version: 1,
      bindingKey: created.json.deliveryRun.tasks[0].missionBindingKey,
      runId,
      planId: approved.plan.id,
      planRevision: created.json.deliveryRun.planRevision,
      planDigest: approved.digest,
      stepId: 'STEP-001',
      role: 'implementation',
      definitionDigest: created.json.deliveryRun.tasks[0].missionDefinitionDigest,
      envelopeDigest: undefined
    });
    assert.match(bound[0].deliveryBinding.envelopeDigest, /^[a-f0-9]{64}$/);

    const earlyMutationBase = {
      expectedStoreRevision: detail.json.deliveryRunStoreRevision,
      expectedRunRevision: detail.json.deliveryRun.revision,
      expectedMissionRevision: bound[0].revision
    };
    const earlyImplementation = {
      ...earlyMutationBase,
      operationId: 'capture-early-guard-0001',
      confirmation: 'capture-local-implementation'
    };
    const earlyVerification = {
      ...earlyMutationBase,
      operationId: 'verify-early-guard-0001',
      confirmation: 'verify-local-delivery-step'
    };
    for (const [action, body, status, pattern] of [
      ['implementation', [], 400, /^delivery_run_implementation_confirmation_required$/],
      ['implementation', { ...earlyImplementation, confirmation: 'wrong' }, 400, /^delivery_run_implementation_confirmation_required$/],
      ['implementation', { ...earlyImplementation, operationId: 'short' }, 400, /^delivery_run_operation_id_invalid$/],
      ['implementation', { ...earlyImplementation, operationId: 'capture-store-invalid-0001', expectedStoreRevision: -1 }, 400, /^delivery_run_expected_store_revision_invalid$/],
      ['implementation', { ...earlyImplementation, operationId: 'capture-run-invalid-0001', expectedRunRevision: 0 }, 400, /^delivery_run_expected_run_revision_invalid$/],
      ['implementation', { ...earlyImplementation, operationId: 'capture-mission-invalid-0001', expectedMissionRevision: 0 }, 400, /^delivery_run_expected_mission_revision_invalid$/],
      ['implementation', { ...earlyImplementation, operationId: 'capture-store-stale-0001', expectedStoreRevision: earlyMutationBase.expectedStoreRevision + 1 }, 409, /^delivery_run_store_revision_conflict$/],
      ['implementation', { ...earlyImplementation, operationId: 'capture-run-stale-0001', expectedRunRevision: earlyMutationBase.expectedRunRevision + 1 }, 409, /^delivery_run_run_revision_conflict$/],
      ['implementation', earlyImplementation, 409, /^delivery_run_mission_not_verifying$/],
      ['verify', [], 400, /^delivery_run_verification_confirmation_required$/],
      ['verify', { ...earlyVerification, confirmation: 'wrong' }, 400, /^delivery_run_verification_confirmation_required$/],
      ['verify', { ...earlyVerification, operationId: 'short' }, 400, /^delivery_run_operation_id_invalid$/],
      ['verify', { ...earlyVerification, operationId: 'verify-store-invalid-0001', expectedStoreRevision: -1 }, 400, /^delivery_run_expected_store_revision_invalid$/],
      ['verify', { ...earlyVerification, operationId: 'verify-run-invalid-0001', expectedRunRevision: 0 }, 400, /^delivery_run_expected_run_revision_invalid$/],
      ['verify', { ...earlyVerification, operationId: 'verify-mission-invalid-0001', expectedMissionRevision: 0 }, 400, /^delivery_run_expected_mission_revision_invalid$/],
      ['verify', { ...earlyVerification, operationId: 'verify-store-stale-0001', expectedStoreRevision: earlyMutationBase.expectedStoreRevision + 1 }, 409, /^delivery_run_store_revision_conflict$/],
      ['verify', { ...earlyVerification, operationId: 'verify-run-stale-0001', expectedRunRevision: earlyMutationBase.expectedRunRevision + 1 }, 409, /^delivery_run_run_revision_conflict$/],
      ['verify', earlyVerification, 409, /^delivery_run_mission_not_verifying$/]
    ]) {
      await assertRunError(await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-001/${action}`, {
        method: 'POST', body
      }), status, pattern);
    }
    await assertRunError(await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-999/implementation`, {
      method: 'POST',
      body: { ...earlyImplementation, operationId: 'capture-task-missing-0001' }
    }), 404, /^delivery_run_task_not_found$/);
    await assertRunError(await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-999/verify`, {
      method: 'POST',
      body: { ...earlyVerification, operationId: 'verify-task-missing-0001' }
    }), 404, /^delivery_run_task_not_found$/);
    await assertRunError(await api(runtime, '/api/delivery-runs/run-does-not-exist-12345678/tasks/STEP-001/implementation', {
      method: 'POST',
      body: { ...earlyImplementation, operationId: 'capture-run-missing-0001' }
    }), 404, /^delivery_run_not_found$/);
    await assertRunError(await api(runtime, '/api/delivery-runs/run-does-not-exist-12345678/tasks/STEP-001/verify', {
      method: 'POST',
      body: { ...earlyVerification, operationId: 'verify-run-missing-0001' }
    }), 404, /^delivery_run_not_found$/);
    assertNoTerminalDelivery(fixture);

    writeFileSync(path.join(fixture.workspace, 'tracked.txt'), 'dispatch drift before worker lookup\n');
    await assertRunError(await api(runtime, `/api/missions/${missionId}/dispatch`, {
      method: 'POST',
      body: {
        expectedRevision: bound[0].revision,
        session: 'codex-fixture',
        ...fixture.workerRequestIdentity
      }
    }), 409, /^delivery_run_baseline_changed$/);
    assertNoTerminalDelivery(fixture);
    writeFileSync(path.join(fixture.workspace, 'tracked.txt'), 'baseline\n');

    for (const to of ['done', 'failed', 'canceled']) {
      const directTerminal = await api(runtime, `/api/missions/${missionId}/transition`, {
        method: 'POST',
        body: {
          expectedRevision: bound[0].revision,
          to,
          note: 'A bound Mission may reach terminal state only through delivery-run reconciliation.'
        }
      });
      assert.equal(directTerminal.response.status, 409, JSON.stringify(directTerminal.json));
      assert.equal(directTerminal.json.error, 'delivery_run_mission_completion_managed');
      assert.equal(directTerminal.json.job.id, missionId);
    }
    const directLifecycle = await api(runtime, `/api/missions/${missionId}/transition`, {
      method: 'POST',
      body: {
        expectedRevision: bound[0].revision,
        to: 'needs_you'
      }
    });
    assert.equal(directLifecycle.response.status, 409, JSON.stringify(directLifecycle.json));
    assert.equal(directLifecycle.json.error, 'delivery_run_mission_lifecycle_managed');
    assert.equal(directLifecycle.json.job.id, missionId);
    assertNoTerminalDelivery(fixture);

    await stopChildProcess(runtime.child);
    runtime = await startFixture(fixture);
    const restored = await api(runtime, `/api/delivery-runs/${runId}`);
    assert.equal(restored.response.status, 200, JSON.stringify(restored.json));
    assert.equal(restored.json.deliveryRun.tasks[0].missionId, missionId);
    snapshot = await api(runtime, '/api/snapshot');
    assert.equal(snapshot.json.missions.jobs.filter((mission) => mission.deliveryBinding?.runId === runId).length, 1);
    assertNoTerminalDelivery(fixture);

    const reconcileBody = {
      operationId: 'reconcile-local-run-0001',
      expectedStoreRevision: restored.json.deliveryRunStoreRevision,
      expectedRunRevision: restored.json.deliveryRun.revision,
      confirmation: 'reconcile-delivery-run'
    };
    for (const [body, status, pattern] of [
      [{ ...reconcileBody, operationId: 'reconcile-confirmation-0001', confirmation: 'wrong' }, 409, /^delivery_run_reconcile_confirmation_required$/],
      [{ ...reconcileBody, operationId: 'short' }, 400, /^delivery_run_operation_id_invalid$/],
      [{ ...reconcileBody, operationId: 'reconcile-store-invalid-0001', expectedStoreRevision: -1 }, 400, /^delivery_run_expected_store_revision_invalid$/],
      [{ ...reconcileBody, operationId: 'reconcile-run-invalid-0001', expectedRunRevision: 0 }, 400, /^delivery_run_expected_run_revision_invalid$/],
      [{ ...reconcileBody, operationId: 'reconcile-store-stale-0001', expectedStoreRevision: reconcileBody.expectedStoreRevision + 1 }, 409, /^delivery_run_store_revision_conflict$/],
      [{ ...reconcileBody, operationId: 'reconcile-run-stale-0001', expectedRunRevision: reconcileBody.expectedRunRevision + 1 }, 409, /^delivery_run_run_revision_conflict$/]
    ]) {
      await assertRunError(await api(runtime, `/api/delivery-runs/${runId}/reconcile`, {
        method: 'POST', body
      }), status, pattern);
    }
    await assertRunError(await api(runtime, '/api/delivery-runs/run-does-not-exist-12345678/reconcile', {
      method: 'POST',
      body: { ...reconcileBody, operationId: 'reconcile-missing-run-0001' }
    }), 404, /^delivery_run_not_found$/);
    const reconciled = await api(runtime, `/api/delivery-runs/${runId}/reconcile`, {
      method: 'POST',
      body: reconcileBody
    });
    assert.equal(reconciled.response.status, 200, JSON.stringify(reconciled.json));
    assert.equal(reconciled.json.deliveryRun.tasks[0].missionId, missionId);
    const replayedReconcile = await api(runtime, `/api/delivery-runs/${runId}/reconcile`, {
      method: 'POST',
      body: reconcileBody
    });
    assert.equal(replayedReconcile.response.status, 200, JSON.stringify(replayedReconcile.json));
    assert.equal(replayedReconcile.json.deliveryRun.tasks[0].missionId, missionId);
    await assertRunError(await api(runtime, `/api/delivery-runs/${runId}/reconcile`, {
      method: 'POST',
      body: { ...reconcileBody, expectedRunRevision: reconcileBody.expectedRunRevision + 1 }
    }), 409, /^delivery_run_run_revision_conflict$/);
    snapshot = await api(runtime, '/api/snapshot');
    assert.equal(snapshot.json.missions.jobs.filter((mission) => mission.deliveryBinding?.runId === runId).length, 1);
    assertNoTerminalDelivery(fixture);

    // Inject the durable state a real bound worker would have produced after
    // dispatch and reporting completion. This exercises only persisted Mission
    // validation and the Run APIs; no terminal input is faked or sent.
    await stopChildProcess(runtime.child);
    const firstVerifying = markMissionVerifying(
      fixture,
      missionId,
      'The first bounded source step is implemented.'
    );
    runtime = await startFixture(fixture);

    const workerSnapshot = await api(runtime, '/api/snapshot');
    assert.equal(workerSnapshot.response.status, 200, JSON.stringify(workerSnapshot.json));
    const deliveryWorker = workerSnapshot.json.agents.find((agent) => agent.id === workerPaneId);
    assert.ok(deliveryWorker, JSON.stringify(workerSnapshot.json.agents));
    assert.equal(deliveryWorker.agentStatus?.state, 'idle', JSON.stringify(deliveryWorker));
    assert.equal(deliveryWorker.agentStatus?.tone, 'good', JSON.stringify(deliveryWorker));
    assert.equal(deliveryWorker.promptReady, true, JSON.stringify(deliveryWorker));
    assert.deepEqual(deliveryWorker.codexIdentity, fixture.workerIdentity);
    assert.equal(deliveryWorker.deliveryWorker?.eligible, true, JSON.stringify(deliveryWorker));
    const firstBoundMission = workerSnapshot.json.missions.jobs.find((mission) => mission.id === missionId);
    assert.equal(firstBoundMission?.status, 'verifying');
    assert.deepEqual(firstBoundMission?.activeAttempt?.codexIdentity, fixture.workerIdentity);
    assert.equal(firstBoundMission?.activeAttempt?.rolloutStartOffset, firstVerifying.rolloutStartOffset);

    const beforeFirstCapture = await api(runtime, `/api/delivery-runs/${runId}`);
    assert.equal(beforeFirstCapture.response.status, 200, JSON.stringify(beforeFirstCapture.json));
    const firstCaptureBody = (operationId) => ({
      operationId,
      expectedStoreRevision: beforeFirstCapture.json.deliveryRunStoreRevision,
      expectedRunRevision: beforeFirstCapture.json.deliveryRun.revision,
      expectedMissionRevision: firstVerifying.revision,
      confirmation: 'capture-local-implementation'
    });

    await assertRunError(await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-001/implementation`, {
      method: 'POST',
      body: firstCaptureBody('capture-no-change-0001')
    }), 409, /^delivery_run_no_workspace_change$/);
    writeFileSync(path.join(fixture.workspace, 'tracked.txt'), 'implemented first step\n');

    const outsidePath = path.join(fixture.workspace, 'outside.txt');
    writeFileSync(outsidePath, 'not in the approved scope\n');
    await assertRunError(await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-001/implementation`, {
      method: 'POST',
      body: firstCaptureBody('capture-outside-scope-0001')
    }), 409, /^delivery_run_scope_changed$/);
    rmSync(outsidePath);

    execFileSync('git', ['add', 'tracked.txt'], { cwd: fixture.workspace });
    await assertRunError(await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-001/implementation`, {
      method: 'POST',
      body: firstCaptureBody('capture-index-drift-0001')
    }), 409, /^delivery_run_index_changed$/);
    execFileSync('git', ['reset', '-q', 'HEAD', '--', 'tracked.txt'], { cwd: fixture.workspace });

    writeFileSync(path.join(fixture.projectsRoot, 'AGENTS.md'), 'Changed project delivery rules.\n');
    await assertRunError(await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-001/implementation`, {
      method: 'POST',
      body: firstCaptureBody('capture-instruction-drift-0001')
    }), 409, /^delivery_run_instructions_changed$/);
    writeFileSync(path.join(fixture.projectsRoot, 'AGENTS.md'), 'Project delivery rules.\n');

    const firstCaptureSuccessBody = firstCaptureBody('capture-first-success-0001');
    const firstCaptured = await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-001/implementation`, {
      method: 'POST',
      body: firstCaptureSuccessBody
    });
    assert.equal(firstCaptured.response.status, 200, JSON.stringify(firstCaptured.json));
    const firstCapturedRun = firstCaptured.json.deliveryRun;
    const firstTask = firstCapturedRun.tasks[0];
    assert.equal(firstTask.state, 'implementation_captured');
    assert.equal(firstCapturedRun.condition, 'awaiting_verification');
    assert.equal(firstCapturedRun.delivery.level, 'implemented_locally');
    assert.deepEqual(Object.keys(firstTask.implementation.baseline).sort(), [
      'approvedScopes',
      'branch',
      'capturedAt',
      'detached',
      'digest',
      'entries',
      'gitMetadata',
      'gitMetadataDigest',
      'head',
      'ignoredScopeDigest',
      'indexDigest',
      'indexFlagsDigest',
      'instructions',
      'instructionsDigest',
      'manifestDigest',
      'repoRoot',
      'statusDigest',
      'version',
      'workingTreeDigest',
      'workspace',
      'workspacePrefix'
    ]);
    assert.equal(firstTask.implementation.baseline.version, 2);
    assert.equal(firstTask.implementation.baseline.workspace, fixture.workspace);
    assert.match(firstTask.implementation.baseline.digest, /^[a-f0-9]{64}$/);
    assert.match(firstTask.implementation.baseline.manifestDigest, /^[a-f0-9]{64}$/);
    assert.equal(firstTask.implementation.baseline.head, captured.json.baseline.head);
    assert.equal(firstTask.implementation.evidenceIds.length, 2);
    assert.equal(firstCapturedRun.evidenceIndex.length, 2);
    assert.deepEqual(firstCapturedRun.evidenceIndex.map((item) => item.type).sort(), ['diff', 'review']);
    assert.equal(firstCapturedRun.evidenceIndex.every((item) => item.producer === `mission:${missionId}`), true);
    assert.match(firstCapturedRun.evidenceIndex.find((item) => item.type === 'diff')?.summary || '', /tracked\.txt/);
    const firstEvidenceId = firstTask.implementation.evidenceIds[0];
    const firstCaptureReplay = await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-001/implementation`, {
      method: 'POST',
      body: firstCaptureSuccessBody
    });
    assert.equal(firstCaptureReplay.response.status, 200, JSON.stringify(firstCaptureReplay.json));
    assert.equal(firstCaptureReplay.json.replayed, true);
    assert.equal(firstCaptureReplay.json.deliveryRun.revision, firstCapturedRun.revision);

    const firstVerifyBase = {
      expectedStoreRevision: firstCaptured.json.deliveryRunStoreRevision,
      expectedRunRevision: firstCapturedRun.revision,
      expectedMissionRevision: firstVerifying.revision,
      confirmation: 'verify-local-delivery-step',
      evidenceIds: [firstEvidenceId],
      checks: [{
        check: 'git diff --check',
        outcome: 'passed',
        note: 'The required diff check completed without errors.'
      }],
      note: 'The first bounded source step satisfies its linked criterion.'
    };
    const validFirstCriterion = {
      acceptanceId: 'AC-001',
      outcome: 'passed',
      method: 'manual',
      note: 'The changed-path evidence contains only tracked.txt.',
      evidenceIds: [firstEvidenceId]
    };
    for (const [operationId, overrides, pattern] of [
      ['verify-first-criteria-shape-0001', { criteria: [] }, /^delivery_run_verification_criteria_invalid$/],
      ['verify-first-acceptance-invalid-0001', { criteria: [{ ...validFirstCriterion, acceptanceId: 'AC-999' }] }, /^delivery_run_verification_criteria_invalid$/],
      ['verify-first-outcome-invalid-0001', { criteria: [{ ...validFirstCriterion, outcome: 'maybe' }] }, /^delivery_run_verification_criteria_invalid$/],
      ['verify-first-method-invalid-0001', { criteria: [{ ...validFirstCriterion, method: 'eyeballed' }] }, /^delivery_run_verification_criteria_invalid$/],
      ['verify-first-check-observation-0001', {
        criteria: [validFirstCriterion],
        checks: [{ check: 'git diff --check', outcome: 'passed', note: '' }]
      }, /^delivery_run_verification_check_observation_required$/],
      ['verify-first-check-command-0001', {
        criteria: [validFirstCriterion],
        checks: [{ check: 'git status', outcome: 'passed', note: 'Wrong command.' }]
      }, /^delivery_run_verification_checks_invalid$/],
      ['verify-first-check-outcome-0001', {
        criteria: [validFirstCriterion],
        checks: [{ check: 'git diff --check', outcome: 'maybe', note: 'Unknown outcome.' }]
      }, /^delivery_run_verification_checks_invalid$/],
      ['verify-first-check-failed-0001', {
        criteria: [validFirstCriterion],
        checks: [{ check: 'git diff --check', outcome: 'failed', note: 'The required check failed.' }]
      }, /^delivery_run_verification_checks_failed$/],
      ['verify-first-check-not-run-0001', {
        criteria: [validFirstCriterion],
        checks: [{ check: 'git diff --check', outcome: 'not_run', note: 'The check was not run.' }]
      }, /^delivery_run_verification_checks_failed$/],
      ['verify-first-unknown-evidence-0001', {
        evidenceIds: ['EVD-UNKNOWN'],
        criteria: [{ ...validFirstCriterion, method: 'command', evidenceIds: 'not-an-array' }]
      }, /^delivery_run_evidence_reference_unknown$/]
    ]) {
      await assertRunError(await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-001/verify`, {
        method: 'POST',
        body: { ...firstVerifyBase, operationId, ...overrides }
      }), 400, pattern);
    }
    await assertRunError(await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-001/verify`, {
      method: 'POST',
      body: {
        ...firstVerifyBase,
        operationId: 'verify-first-missing-observation-0001',
        criteria: [{
          acceptanceId: 'AC-001',
          outcome: 'passed',
          method: 'manual',
          note: '',
          evidenceIds: [firstEvidenceId]
        }]
      }
    }), 400, /^delivery_run_verification_observation_required$/);
    await assertRunError(await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-001/verify`, {
      method: 'POST',
      body: {
        ...firstVerifyBase,
        operationId: 'verify-first-missing-check-0001',
        criteria: [{
          acceptanceId: 'AC-001',
          outcome: 'passed',
          method: 'manual',
          note: 'The changed-path evidence contains only tracked.txt.',
          evidenceIds: [firstEvidenceId]
        }],
        checks: []
      }
    }), 400, /^delivery_run_verification_checks_invalid$/);
    await assertRunError(await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-001/verify`, {
      method: 'POST',
      body: {
        ...firstVerifyBase,
        operationId: 'verify-first-missing-note-0001',
        criteria: [{
          acceptanceId: 'AC-001',
          outcome: 'passed',
          method: 'manual',
          note: 'The changed-path evidence contains only tracked.txt.',
          evidenceIds: [firstEvidenceId]
        }],
        note: ''
      }
    }), 400, /^delivery_run_verification_note_required$/);

    writeFileSync(path.join(fixture.workspace, 'tracked.txt'), 'verification drift after capture\n');
    await assertRunError(await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-001/verify`, {
      method: 'POST',
      body: {
        ...firstVerifyBase,
        operationId: 'verify-first-baseline-drift-0001',
        criteria: [{
          acceptanceId: 'AC-001',
          outcome: 'passed',
          method: 'manual',
          note: 'The changed-path evidence contains only tracked.txt.',
          evidenceIds: [firstEvidenceId]
        }]
      }
    }), 409, /^delivery_run_verification_baseline_changed$/);
    writeFileSync(path.join(fixture.workspace, 'tracked.txt'), 'implemented first step\n');

    const firstVerifySuccessBody = {
      ...firstVerifyBase,
      operationId: 'verify-first-success-0001',
      criteria: [{
        acceptanceId: 'AC-001',
        outcome: 'passed',
        method: 'manual',
        note: 'The changed-path evidence contains only tracked.txt.',
        evidenceIds: [firstEvidenceId]
      }]
    };
    const missionBeforeVerification = readFileSync(fixture.missionQueuePath);
    rmSync(fixture.missionQueuePath, { force: true });
    mkdirSync(fixture.missionQueuePath);
    const interruptedFirstVerify = await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-001/verify`, {
      method: 'POST',
      body: firstVerifySuccessBody
    });
    assert.equal(interruptedFirstVerify.response.status, 500, JSON.stringify(interruptedFirstVerify.json));
    assert.equal(
      JSON.parse(readFileSync(fixture.deliveryRunPath, 'utf8')).runs[0].tasks[0].state,
      'verified'
    );
    rmSync(fixture.missionQueuePath, { recursive: true, force: true });
    writeFileSync(fixture.missionQueuePath, missionBeforeVerification, { mode: 0o600 });

    const firstVerified = await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-001/verify`, {
      method: 'POST',
      body: firstVerifySuccessBody
    });
    assert.equal(firstVerified.response.status, 200, JSON.stringify(firstVerified.json));
    assert.equal(firstVerified.json.replayed, true);
    const afterFirstRun = firstVerified.json.deliveryRun;
    assert.deepEqual(afterFirstRun.tasks.map((task) => task.state), ['verified', 'mission_linked']);
    assert.deepEqual(afterFirstRun.outbox.map((item) => item.state), ['applied', 'applied']);
    const firstOperatorEvidence = afterFirstRun.evidenceIndex.filter((item) => item.producer === 'operator');
    assert.equal(firstOperatorEvidence.length, 2);
    assert.deepEqual(firstOperatorEvidence.map((item) => item.type).sort(), ['command', 'review']);
    assert.equal(firstOperatorEvidence.every((item) => item.outcome === 'passed'), true);
    assert.match(firstOperatorEvidence.find((item) => item.type === 'review')?.summary || '', /AC-001; method=manual/);
    assert.match(firstOperatorEvidence.find((item) => item.type === 'command')?.summary || '', /git diff --check/);
    const secondMissionId = afterFirstRun.tasks[1].missionId;
    assert.match(secondMissionId, /^mission-[a-z0-9-]{8,64}$/);
    assert.notEqual(secondMissionId, missionId);
    snapshot = await api(runtime, '/api/snapshot');
    const afterFirstMissions = snapshot.json.missions.jobs.filter((mission) => mission.deliveryBinding?.runId === runId);
    assert.equal(afterFirstMissions.length, 2);
    assert.equal(afterFirstMissions.find((mission) => mission.id === missionId)?.status, 'done');
    assert.equal(afterFirstMissions.find((mission) => mission.id === secondMissionId)?.status, 'ready');
    assertNoTerminalDelivery(fixture);
    const firstVerifyReplay = await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-001/verify`, {
      method: 'POST',
      body: firstVerifySuccessBody
    });
    assert.equal(firstVerifyReplay.response.status, 200, JSON.stringify(firstVerifyReplay.json));
    assert.equal(firstVerifyReplay.json.replayed, true);
    assert.equal(firstVerifyReplay.json.deliveryRun.tasks[1].missionId, secondMissionId);

    await stopChildProcess(runtime.child);
    const secondVerifying = markMissionVerifying(
      fixture,
      secondMissionId,
      'The second bounded source step is implemented.'
    );
    writeFileSync(path.join(fixture.workspace, 'next.txt'), 'implemented second step\n');
    runtime = await startFixture(fixture);
    const beforeSecondCapture = await api(runtime, `/api/delivery-runs/${runId}`);
    assert.equal(beforeSecondCapture.response.status, 200, JSON.stringify(beforeSecondCapture.json));
    const secondCaptured = await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-002/implementation`, {
      method: 'POST',
      body: {
        operationId: 'capture-second-success-0001',
        expectedStoreRevision: beforeSecondCapture.json.deliveryRunStoreRevision,
        expectedRunRevision: beforeSecondCapture.json.deliveryRun.revision,
        expectedMissionRevision: secondVerifying.revision,
        confirmation: 'capture-local-implementation'
      }
    });
    assert.equal(secondCaptured.response.status, 200, JSON.stringify(secondCaptured.json));
    const secondTask = secondCaptured.json.deliveryRun.tasks[1];
    assert.equal(secondTask.state, 'implementation_captured');
    assert.equal(secondCaptured.json.deliveryRun.evidenceIndex.length, 6);
    assert.match(
      secondCaptured.json.deliveryRun.evidenceIndex.find((item) => secondTask.implementation.evidenceIds.includes(item.id) && item.type === 'diff')?.summary || '',
      /next\.txt/
    );
    const secondEvidenceId = secondTask.implementation.evidenceIds[0];
    await assertRunError(await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-002/verify`, {
      method: 'POST',
      body: {
        operationId: 'verify-second-cross-task-evidence-0001',
        expectedStoreRevision: secondCaptured.json.deliveryRunStoreRevision,
        expectedRunRevision: secondCaptured.json.deliveryRun.revision,
        expectedMissionRevision: secondVerifying.revision,
        confirmation: 'verify-local-delivery-step',
        criteria: [{
          acceptanceId: 'AC-002',
          outcome: 'passed',
          method: 'manual',
          note: 'The second step is linked only after the first is verified.',
          evidenceIds: [firstEvidenceId]
        }],
        checks: [{
          check: 'git diff --check',
          outcome: 'passed',
          note: 'The required diff check completed without errors.'
        }],
        evidenceIds: [firstEvidenceId],
        note: 'This must not reuse evidence from the previous task.'
      }
    }), 400, /^delivery_run_evidence_not_for_task$/);
    const finalVerifyBody = {
      operationId: 'verify-second-success-0001',
      expectedStoreRevision: secondCaptured.json.deliveryRunStoreRevision,
      expectedRunRevision: secondCaptured.json.deliveryRun.revision,
      expectedMissionRevision: secondVerifying.revision,
      confirmation: 'verify-local-delivery-step',
      criteria: [{
        acceptanceId: 'AC-002',
        outcome: 'passed',
        method: 'manual',
        note: 'The second step was released only after STEP-001 passed.',
        evidenceIds: [secondEvidenceId]
      }],
      checks: [{
        check: 'git diff --check',
        outcome: 'passed',
        note: 'The required diff check completed without errors.'
      }],
      evidenceIds: [secondEvidenceId],
      note: 'The second bounded source step satisfies its linked criterion.'
    };
    const finalVerified = await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-002/verify`, {
      method: 'POST',
      body: finalVerifyBody
    });
    assert.equal(finalVerified.response.status, 200, JSON.stringify(finalVerified.json));
    assert.equal(finalVerified.json.deliveryRun.condition, 'verified');
    assert.equal(finalVerified.json.deliveryRun.delivery.level, 'verified_locally');
    assert.equal(finalVerified.json.deliveryRun.tasks.every((task) => task.state === 'verified'), true);
    assert.equal(finalVerified.json.deliveryRun.evidenceIndex.length, 8);
    assert.equal(finalVerified.json.deliveryRun.evidenceIndex.filter((item) => item.producer === 'operator').length, 4);
    assert.equal(finalVerified.json.plan.phase, 'ready_to_release');
    assert.equal(finalVerified.json.plan.gates.implementationCaptured, true);
    assert.equal(finalVerified.json.plan.gates.qaPassed, true);
    snapshot = await api(runtime, '/api/snapshot');
    const finalMissions = snapshot.json.missions.jobs.filter((mission) => mission.deliveryBinding?.runId === runId);
    assert.equal(finalMissions.length, 2);
    assert.equal(finalMissions.every((mission) => mission.status === 'done'), true);
    assertNoTerminalDelivery(fixture);
    const finalVerifyReplay = await api(runtime, `/api/delivery-runs/${runId}/tasks/STEP-002/verify`, {
      method: 'POST',
      body: finalVerifyBody
    });
    assert.equal(finalVerifyReplay.response.status, 200, JSON.stringify(finalVerifyReplay.json));
    assert.equal(finalVerifyReplay.json.replayed, true);
    assert.equal(finalVerifyReplay.json.deliveryRun.delivery.level, 'verified_locally');

    const abortBaseline = await api(runtime, '/api/delivery-plans/baseline', {
      method: 'POST',
      body: { workspace: fixture.abortWorkspace }
    });
    assert.equal(abortBaseline.response.status, 200, JSON.stringify(abortBaseline.json));
    const abortApproved = await approvePlan(runtime, deliveryPlan({
      id: 'plan-abort-run-12345678',
      workspace: fixture.abortWorkspace,
      baseline: abortBaseline.json.baseline
    }), finalVerified.json.planStoreRevision);
    const abortCreated = await api(runtime, `/api/delivery-plans/${abortApproved.plan.id}/runs`, {
      method: 'POST',
      body: createRunBody(abortApproved, abortApproved.storeRevision, {
        operationId: 'create-abort-run-0001',
        expectedRunStoreRevision: finalVerified.json.deliveryRunStoreRevision
      })
    });
    assert.equal(abortCreated.response.status, 200, JSON.stringify(abortCreated.json));
    const abortRun = abortCreated.json.deliveryRun;
    const abortMissionId = abortRun.tasks[0].missionId;
    assert.equal(abortRun.condition, 'active');
    assert.match(abortMissionId, /^mission-[a-z0-9-]{8,64}$/);
    const abortBody = {
      operationId: 'abort-local-run-0001',
      expectedStoreRevision: abortCreated.json.deliveryRunStoreRevision,
      expectedRunRevision: abortRun.revision,
      confirmation: 'abort-local-delivery-run',
      reason: 'Operator stopped this run before dispatch so the Plan can be safely revised.'
    };
    const aborted = await api(runtime, `/api/delivery-runs/${abortRun.id}/abort`, {
      method: 'POST',
      body: abortBody
    });
    assert.equal(aborted.response.status, 200, JSON.stringify(aborted.json));
    assert.equal(aborted.json.deliveryRun.condition, 'aborted');
    assert.equal(aborted.json.deliveryRun.abort.operatorConfirmed, true);
    assert.equal(aborted.json.deliveryRun.abort.fromCondition, 'active');
    assert.equal(aborted.json.deliveryRun.abort.evidenceIds.length, 1);
    assert.equal(aborted.json.deliveryRun.tasks.every((task) => ['verified', 'aborted'].includes(task.state)), true);
    assert.equal(aborted.json.deliveryRun.outbox[1].state, 'canceled');
    assert.equal(aborted.json.plan.phase, 'planning');
    const abortEvidence = aborted.json.deliveryRun.evidenceIndex.find((item) => (
      aborted.json.deliveryRun.abort.evidenceIds.includes(item.id)
    ));
    assert.deepEqual({
      type: abortEvidence?.type,
      producer: abortEvidence?.producer,
      outcome: abortEvidence?.outcome
    }, {
      type: 'review',
      producer: 'operator',
      outcome: 'applied'
    });
    snapshot = await api(runtime, '/api/snapshot');
    const abortedMission = snapshot.json.missions.jobs.find((mission) => mission.id === abortMissionId);
    assert.equal(abortedMission?.status, 'canceled');
    assert.match(abortedMission?.blocker || '', /aborted by operator/i);
    const abortReplay = await api(runtime, `/api/delivery-runs/${abortRun.id}/abort`, {
      method: 'POST',
      body: abortBody
    });
    assert.equal(abortReplay.response.status, 200, JSON.stringify(abortReplay.json));
    assert.equal(abortReplay.json.replayed, true);
    assert.equal(abortReplay.json.deliveryRun.condition, 'aborted');

    await stopChildProcess(runtime.child);
    runtime = await startFixture(fixture);
    const verifiedAfterRestart = await api(runtime, `/api/delivery-runs/${runId}`);
    assert.equal(verifiedAfterRestart.response.status, 200, JSON.stringify(verifiedAfterRestart.json));
    assert.equal(verifiedAfterRestart.json.deliveryRun.condition, 'verified');
    assert.equal(verifiedAfterRestart.json.plan.phase, 'ready_to_release');
    const abortedAfterRestart = await api(runtime, `/api/delivery-runs/${abortRun.id}`);
    assert.equal(abortedAfterRestart.response.status, 200, JSON.stringify(abortedAfterRestart.json));
    assert.equal(abortedAfterRestart.json.deliveryRun.condition, 'aborted');
    assert.equal(abortedAfterRestart.json.plan.phase, 'planning');
    assertNoTerminalDelivery(fixture);
  } finally {
    await stopChildProcess(runtime?.child);
    try { closeSync(fixture.rolloutFd); } catch {}
    try { chmodSync(path.dirname(fixture.missionQueuePath), 0o700); } catch {}
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('delivery-run startup adopts one exact ready orphan and locks its source Plan', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture);
    const captured = await api(runtime, '/api/delivery-plans/baseline', {
      method: 'POST',
      body: { workspace: fixture.workspace }
    });
    assert.equal(captured.response.status, 200, JSON.stringify(captured.json));
    const approved = await approvePlan(runtime, deliveryPlan({
      id: 'plan-orphan-run-12345678',
      workspace: fixture.workspace,
      baseline: captured.json.baseline
    }), 0);
    const createBody = createRunBody(approved, approved.storeRevision, {
      operationId: 'create-orphan-run-0001'
    });
    const started = await api(runtime, `/api/delivery-plans/${approved.plan.id}/runs`, {
      method: 'POST',
      body: createBody
    });
    assert.equal(started.response.status, 200, JSON.stringify(started.json));
    const runId = started.json.deliveryRun.id;
    const missionId = started.json.deliveryRun.tasks[0].missionId;
    assert.match(missionId, /^mission-[a-z0-9-]{8,64}$/);
    assertNoTerminalDelivery(fixture);

    await stopChildProcess(runtime.child);
    runtime = null;

    // Recreate the durable crash point after Mission ensure but before the
    // Run stored its Mission link. The exact ready Mission remains durable.
    const runStore = JSON.parse(readFileSync(fixture.deliveryRunPath, 'utf8'));
    const createOperation = runStore.operations.find((operation) => (
      operation.action === 'run.create' && operation.result?.run?.id === runId
    ));
    assert.ok(createOperation, JSON.stringify(runStore.operations));
    runStore.revision = createOperation.result.storeRevision;
    runStore.runs = [structuredClone(createOperation.result.run)];
    runStore.operations = [structuredClone(createOperation)];
    assert.equal(runStore.runs[0].tasks[0].missionId, null);
    assert.equal(runStore.runs[0].outbox[0].state, 'pending');
    writeFileSync(fixture.deliveryRunPath, `${JSON.stringify(runStore, null, 2)}\n`);

    runtime = await startFixture(fixture);
    const recovered = await api(runtime, `/api/delivery-runs/${runId}`);
    assert.equal(recovered.response.status, 200, JSON.stringify(recovered.json));
    assert.equal(recovered.json.deliveryRun.tasks[0].missionId, missionId);
    assert.equal(recovered.json.deliveryRun.tasks[0].state, 'mission_linked');
    assert.equal(recovered.json.deliveryRun.outbox[0].state, 'applied');
    const linkedStore = JSON.parse(readFileSync(fixture.deliveryRunPath, 'utf8'));
    const linkReceipt = linkedStore.operations.find((operation) => (
      operation.action === 'run.mission_link' && operation.result?.run?.id === runId
    ));
    assert.ok(linkReceipt, JSON.stringify(linkedStore.operations));
    const replayedLink = await api(runtime, `/api/delivery-runs/${runId}/reconcile`, {
      method: 'POST',
      body: {
        operationId: linkReceipt.id,
        expectedStoreRevision: linkReceipt.result.storeRevision - 1,
        expectedRunRevision: linkReceipt.result.run.revision - 1,
        confirmation: 'reconcile-delivery-run'
      }
    });
    assert.equal(replayedLink.response.status, 200, JSON.stringify(replayedLink.json));
    assert.equal(replayedLink.json.replayed, true);
    const snapshot = await api(runtime, '/api/snapshot');
    const bound = snapshot.json.missions.jobs.filter((mission) => mission.deliveryBinding?.runId === runId);
    assert.equal(bound.length, 1);
    assert.equal(bound[0].id, missionId);
    assert.equal(bound[0].status, 'ready');
    assertNoTerminalDelivery(fixture);

    const planBefore = await api(runtime, `/api/delivery-plans/${approved.plan.id}`);
    assert.equal(planBefore.response.status, 200, JSON.stringify(planBefore.json));
    const lockedPatch = await api(runtime, `/api/delivery-plans/${approved.plan.id}`, {
      method: 'PATCH',
      body: {
        operationId: 'patch-active-plan-0001',
        expectedStoreRevision: planBefore.json.planStoreRevision,
        expectedPlanRevision: planBefore.json.plan.revision,
        patch: { title: 'This mutation must stay blocked while the Run is active.' }
      }
    });
    assert.equal(lockedPatch.response.status, 409, JSON.stringify(lockedPatch.json));
    assert.equal(lockedPatch.json.error, 'delivery_plan_active_run_locked');
    const lockedTransition = await api(runtime, `/api/delivery-plans/${approved.plan.id}/transition`, {
      method: 'POST',
      body: {
        operationId: 'transition-active-plan-0001',
        expectedStoreRevision: planBefore.json.planStoreRevision,
        expectedPlanRevision: planBefore.json.plan.revision,
        expectedDigest: planBefore.json.digest,
        to: 'planning',
        conditions: {}
      }
    });
    assert.equal(lockedTransition.response.status, 409, JSON.stringify(lockedTransition.json));
    assert.equal(lockedTransition.json.error, 'delivery_plan_active_run_locked');
    const planAfter = await api(runtime, `/api/delivery-plans/${approved.plan.id}`);
    assert.equal(planAfter.response.status, 200, JSON.stringify(planAfter.json));
    assert.deepEqual(planAfter.json.plan, planBefore.json.plan);
    assert.equal(planAfter.json.digest, planBefore.json.digest);
    assert.equal(planAfter.json.planStoreRevision, planBefore.json.planStoreRevision);

    // A later, unrelated Plan creation advances the global Plan store but must
    // not invalidate the original durable start receipt.
    const unrelated = deliveryPlan({
      id: 'plan-unrelated-12345678',
      workspace: fixture.workspace,
      baseline: captured.json.baseline
    });
    const unrelatedCreated = await api(runtime, '/api/delivery-plans', {
      method: 'POST',
      body: {
        operationId: 'create-plan-unrelated-0001',
        expectedStoreRevision: planAfter.json.planStoreRevision,
        plan: unrelated
      }
    });
    assert.equal(unrelatedCreated.response.status, 200, JSON.stringify(unrelatedCreated.json));
    const replayed = await api(runtime, `/api/delivery-plans/${approved.plan.id}/runs`, {
      method: 'POST',
      body: createBody
    });
    assert.equal(replayed.response.status, 200, JSON.stringify(replayed.json));
    assert.equal(replayed.json.replayed, true);
    assert.equal(replayed.json.deliveryRun.id, runId);
    assert.equal(replayed.json.deliveryRun.tasks[0].missionId, missionId);
    assertNoTerminalDelivery(fixture);

    // A durable Mission binding is part of the Run's authority boundary. A
    // restart must detect a syntactically valid but mismatched binding and
    // stop the Run off-course without dispatching or trying to repair it.
    await stopChildProcess(runtime.child);
    runtime = null;
    const mismatchedQueue = JSON.parse(readFileSync(fixture.missionQueuePath, 'utf8'));
    const mismatchedMission = mismatchedQueue.jobs.find((job) => job.id === missionId);
    assert.ok(mismatchedMission);
    mismatchedMission.deliveryBinding.planDigest = 'f'.repeat(64);
    writeFileSync(fixture.missionQueuePath, `${JSON.stringify(mismatchedQueue, null, 2)}\n`);
    runtime = await startFixture(fixture);
    const offCourse = await api(runtime, `/api/delivery-runs/${runId}`);
    assert.equal(offCourse.response.status, 200, JSON.stringify(offCourse.json));
    assert.equal(offCourse.json.deliveryRun.condition, 'off_course');
    assert.match(offCourse.json.deliveryRun.blocker, /delivery_run_(?:plan_binding|mission_binding)_changed/);
    assertNoTerminalDelivery(fixture);

    // Recreate the same ensure-before-link crash point with an exact orphan but
    // a changed workspace. Startup must stop on baseline drift before adopting
    // the Mission, again with no terminal delivery.
    await stopChildProcess(runtime.child);
    runtime = null;
    const exactQueue = JSON.parse(readFileSync(fixture.missionQueuePath, 'utf8'));
    exactQueue.jobs.find((job) => job.id === missionId).deliveryBinding.planDigest = approved.digest;
    writeFileSync(fixture.missionQueuePath, `${JSON.stringify(exactQueue, null, 2)}\n`);
    const driftStore = JSON.parse(readFileSync(fixture.deliveryRunPath, 'utf8'));
    const originalCreate = driftStore.operations.find((operation) => (
      operation.action === 'run.create' && operation.result?.run?.id === runId
    ));
    assert.ok(originalCreate);
    writeFileSync(fixture.deliveryRunPath, `${JSON.stringify({
      ...driftStore,
      revision: originalCreate.result.storeRevision,
      runs: [structuredClone(originalCreate.result.run)],
      operations: [structuredClone(originalCreate)]
    }, null, 2)}\n`);
    writeFileSync(path.join(fixture.workspace, 'tracked.txt'), 'drift before orphan adoption\n');
    runtime = await startFixture(fixture);
    const baselineOffCourse = await api(runtime, `/api/delivery-runs/${runId}`);
    assert.equal(baselineOffCourse.response.status, 200, JSON.stringify(baselineOffCourse.json));
    assert.equal(baselineOffCourse.json.deliveryRun.condition, 'off_course');
    assert.equal(baselineOffCourse.json.deliveryRun.blocker, 'delivery_run_baseline_changed');
    assertNoTerminalDelivery(fixture);

    // Finally prove the durable ensure failure path. The Run store is rewound
    // to its original pending outbox while a valid full Mission queue prevents
    // the ensure from being mistaken for success.
    await stopChildProcess(runtime.child);
    runtime = null;
    writeFileSync(path.join(fixture.workspace, 'tracked.txt'), 'baseline\n');
    const ensureStore = JSON.parse(readFileSync(fixture.deliveryRunPath, 'utf8'));
    const ensureCreate = ensureStore.operations.find((operation) => (
      operation.action === 'run.create' && operation.result?.run?.id === runId
    ));
    writeFileSync(fixture.deliveryRunPath, `${JSON.stringify({
      ...ensureStore,
      revision: ensureCreate.result.storeRevision,
      runs: [structuredClone(ensureCreate.result.run)],
      operations: [structuredClone(ensureCreate)]
    }, null, 2)}\n`);
    const capacityMission = structuredClone(exactQueue.jobs.find((job) => job.id === missionId));
    capacityMission.deliveryBinding = null;
    writeFileSync(fixture.missionQueuePath, `${JSON.stringify({
      ...exactQueue,
      revision: exactQueue.revision + 1,
      jobs: Array.from({ length: 500 }, (_, index) => ({
        ...structuredClone(capacityMission),
        id: `mission-capacity-${String(index).padStart(8, '0')}`,
        position: index
      })),
      events: []
    }, null, 2)}\n`, { mode: 0o600 });
    runtime = await startFixture(fixture);
    const ensureFailed = await api(runtime, `/api/delivery-runs/${runId}`);
    assert.equal(ensureFailed.response.status, 200, JSON.stringify(ensureFailed.json));
    assert.equal(ensureFailed.json.deliveryRun.outbox[0].state, 'reconcile_required');
    assert.match(ensureFailed.json.deliveryRun.blocker, /mission_queue_full/);
    assertNoTerminalDelivery(fixture);
  } finally {
    await stopChildProcess(runtime?.child);
    try { closeSync(fixture.rolloutFd); } catch {}
    try { chmodSync(path.dirname(fixture.missionQueuePath), 0o700); } catch {}
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
