import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

import { deliveryPlanDiscoveryBaseline } from '../delivery-plan.js';
import { stopChildProcess, waitForChildExit } from './helpers/child-process.js';
import { installBlockedTool } from './helpers/executables.js';
import { fetchWithTimeout, responseJson, waitForHttpServer } from './helpers/http.js';
import { unusedLoopbackPort } from './helpers/unused-loopback-port.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');
const loopbackHost = '127.0.0.1';

function createFixture(prefix = 'panefleet-delivery-plan-api-') {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(root, 'data');
  const publicDir = path.join(root, 'public');
  const binDir = path.join(root, 'bin');
  const codexHome = path.join(root, 'codex-home');
  const projectsRoot = path.join(root, 'projects');
  const toolLogPath = path.join(root, 'tools.log');
  const deliveryPlanPath = path.join(dataDir, 'delivery-plans.json');
  for (const directory of [dataDir, publicDir, binDir, codexHome, projectsRoot]) {
    mkdirSync(directory, { recursive: true });
  }
  chmodSync(dataDir, 0o700);
  writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>PaneFleet API fixture</title>\n');
  writeFileSync(path.join(root, 'services.json'), '[]\n');
  writeFileSync(path.join(root, 'host-config.json'), '{}\n');
  writeFileSync(path.join(codexHome, 'models_cache.json'), '{"models":[]}\n');
  for (const name of ['aws', 'curl', 'journalctl', 'ps', 'ss', 'tmux']) {
    installBlockedTool(binDir, name);
  }
  return { root, dataDir, binDir, codexHome, projectsRoot, toolLogPath, deliveryPlanPath };
}

async function startFixture(fixture) {
  const port = await unusedLoopbackPort();
  const baseUrl = `http://${loopbackHost}:${port}`;
  let output = '';
  const child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
    cwd: fixture.root,
    env: {
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
      TMPDIR: os.tmpdir(),
      TMP: os.tmpdir(),
      TEMP: os.tmpdir(),
      DELIVERY_PLAN_PATH: fixture.deliveryPlanPath,
      PATH: `${fixture.binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      AWS_EC2_METADATA_DISABLED: 'true',
      SNAPSHOT_EVENT_MS: '60000',
      PROMPT_QUEUE_MONITOR_MS: '60000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await waitForHttpServer({ baseUrl, child, output: () => output, label: 'delivery plan API fixture' });
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
  }, 5000);
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

function readyPlan(workspace) {
  return {
    version: 1,
    id: 'plan-api-12345678',
    revision: 1,
    phase: 'planning',
    title: 'Review a delivery plan',
    request: 'Persist this lazy-detail-only-request-marker outside recurring snapshots.',
    workspace,
    baseline: {
      head: '960ceac898a551d63b56fa991aa8baf297f0d161',
      workingTreeDigest: 'a'.repeat(64),
      instructionsDigest: 'b'.repeat(64),
      capturedAt: '2026-08-16T10:00:00.000Z'
    },
    classification: {
      intent: 'change',
      depth: 'standard',
      risk: 'local_reversible',
      dataClasses: [],
      mutationSurfaces: ['workspace']
    },
    roles: {
      po: {
        user: 'PaneFleet operator',
        problem: 'Implementation can start without a reviewed definition.',
        outcome: 'A reviewed plan is required before work starts.',
        value: 'Keep work bounded and verifiable.',
        nonGoals: ['Do not execute work or type into terminals.'],
        assumptions: [],
        openQuestions: []
      },
      ba: {
        requirements: [{ id: 'REQ-001', text: 'Persist and review the plan.' }],
        dependencies: [],
        edgeCases: ['A stale browser submits an old revision.'],
        constraints: ['No terminal or workspace behavior.'],
        openQuestions: []
      },
      dev: {
        architecture: 'Use an isolated atomic repository and lazy detail endpoint.',
        steps: [{
          id: 'STEP-001',
          title: 'Persist the reviewed plan',
          outcome: 'The exact reviewed definition remains durable.',
          requirementIds: ['REQ-001'],
          scopePaths: ['server.js'],
          checks: ['node --test test/delivery-plan-api.test.js']
        }],
        risks: ['A stale digest could approve the wrong definition.'],
        rollback: 'Remove the isolated API and state file before activation.',
        openQuestions: []
      },
      qa: {
        acceptanceCriteria: [{
          id: 'AC-001',
          text: 'Stale revisions and digests fail closed.',
          requirementIds: ['REQ-001']
        }],
        testStrategy: 'Exercise API persistence, concurrency, replay, and isolation.',
        regressionChecks: ['No terminal input is produced.'],
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

test('delivery-plan API is durable, lazy, idempotent, optimistic, and execution-free', async () => {
  const fixture = createFixture();
  let runtime;
  try {
    runtime = await startFixture(fixture);

    const baselineWorkspace = path.join(fixture.projectsRoot, 'baseline-project');
    mkdirSync(baselineWorkspace, { recursive: true });
    writeFileSync(path.join(fixture.root, 'AGENTS.md'), 'Host delivery rules.\n');
    writeFileSync(path.join(fixture.projectsRoot, 'AGENTS.md'), 'Project delivery rules.\n');
    writeFileSync(path.join(baselineWorkspace, 'tracked.txt'), 'baseline\n');
    writeFileSync(path.join(baselineWorkspace, '.gitattributes'), '*.txt filter=panefleet-evil\n');
    writeFileSync(path.join(baselineWorkspace, '.gitignore'), 'node_modules/\ncoverage/\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: baselineWorkspace });
    execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: baselineWorkspace });
    execFileSync('git', ['config', 'user.name', 'PaneFleet Fixture'], { cwd: baselineWorkspace });
    execFileSync('git', ['add', '.gitattributes', '.gitignore', 'tracked.txt'], { cwd: baselineWorkspace });
    execFileSync('git', ['commit', '-q', '-m', 'fixture baseline'], { cwd: baselineWorkspace });
    const filterMarker = path.join(fixture.root, 'MALICIOUS_FILTER_RAN');
    const filterScript = path.join(fixture.root, 'malicious-filter.sh');
    writeFileSync(filterScript, `#!/bin/sh\ntouch "${filterMarker}"\ncat\n`);
    chmodSync(filterScript, 0o700);
    execFileSync('git', ['config', 'filter.panefleet-evil.clean', filterScript], { cwd: baselineWorkspace });
    execFileSync('git', ['config', 'filter.panefleet-evil.required', 'true'], { cwd: baselineWorkspace });

    const conversationWorkspace = path.join(fixture.projectsRoot, 'existing-project-without-git');
    mkdirSync(conversationWorkspace, { recursive: true });
    writeFileSync(path.join(conversationWorkspace, 'idea.txt'), 'Existing project context.\n');
    const conversationBaseline = await api(runtime, '/api/delivery-plans/baseline', {
      method: 'POST',
      body: { workspace: conversationWorkspace, mode: 'conversation' }
    });
    assert.equal(conversationBaseline.response.status, 200);
    assert.equal(conversationBaseline.json.workspace, conversationWorkspace);
    assert.deepEqual(
      conversationBaseline.json.baseline,
      deliveryPlanDiscoveryBaseline(conversationWorkspace, { at: conversationBaseline.json.baseline.capturedAt })
    );
    assert.deepEqual(conversationBaseline.json.evidence, {
      eligible: true,
      discoveryOnly: true,
      gitRequiredBeforeApproval: true,
      changedPaths: [],
      instructionFiles: []
    });
    const implicitConversationBaseline = await api(runtime, '/api/delivery-plans/baseline', {
      method: 'POST',
      body: { mode: 'conversation' }
    });
    assert.equal(implicitConversationBaseline.response.status, 200);
    assert.equal(implicitConversationBaseline.json.workspace, fixture.projectsRoot);
    assert.deepEqual(
      implicitConversationBaseline.json.baseline,
      deliveryPlanDiscoveryBaseline(fixture.projectsRoot, { at: implicitConversationBaseline.json.baseline.capturedAt })
    );
    assert.equal(toolLog(fixture), '', 'conversation setup must not invoke Git, tmux, or another host tool');

    const capturedBaseline = await api(runtime, '/api/delivery-plans/baseline', {
      method: 'POST',
      body: { workspace: baselineWorkspace }
    });
    assert.equal(capturedBaseline.response.status, 200);
    assert.match(capturedBaseline.json.baseline.head, /^[a-f0-9]{40}$/);
    assert.match(capturedBaseline.json.baseline.workingTreeDigest, /^[a-f0-9]{64}$/);
    assert.match(capturedBaseline.json.baseline.instructionsDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(capturedBaseline.json.evidence.changedPaths, []);
    assert.deepEqual(capturedBaseline.json.evidence.instructionFiles, ['AGENTS.md', 'projects/AGENTS.md']);
    const baselineToolLog = toolLog(fixture);
    assert.doesNotMatch(baselineToolLog, /tmux|send-keys/);
    assert.equal(existsSync(filterMarker), false, 'baseline capture must never execute repository clean/process filters');

    writeFileSync(path.join(baselineWorkspace, 'tracked.txt'), 'changed!\n');
    const changedBaseline = await api(runtime, '/api/delivery-plans/baseline', {
      method: 'POST',
      body: { workspace: baselineWorkspace }
    });
    assert.equal(changedBaseline.response.status, 200);
    assert.deepEqual(changedBaseline.json.evidence.changedPaths, ['tracked.txt']);
    assert.notEqual(changedBaseline.json.baseline.workingTreeDigest, capturedBaseline.json.baseline.workingTreeDigest);
    assert.equal(existsSync(filterMarker), false, 'same-size working-tree inspection must remain raw and filter-free');

    mkdirSync(path.join(baselineWorkspace, 'node_modules'));
    writeFileSync(path.join(baselineWorkspace, 'node_modules', 'ignored.js'), 'ignored dependency bytes\n');
    const ignoredBaseline = await api(runtime, '/api/delivery-plans/baseline', {
      method: 'POST',
      body: { workspace: baselineWorkspace }
    });
    assert.equal(ignoredBaseline.response.status, 409);
    assert.deepEqual(ignoredBaseline.json, { error: 'delivery_plan_workspace_baseline_ignored_paths_present' });
    rmSync(path.join(baselineWorkspace, 'node_modules'), { recursive: true, force: true });

    execFileSync('git', ['update-index', '--assume-unchanged', 'tracked.txt'], { cwd: baselineWorkspace });
    rmSync(filterMarker, { force: true });
    const concealedBaseline = await api(runtime, '/api/delivery-plans/baseline', {
      method: 'POST',
      body: { workspace: baselineWorkspace }
    });
    assert.equal(concealedBaseline.response.status, 409);
    assert.deepEqual(concealedBaseline.json, { error: 'delivery_plan_workspace_baseline_git_assume_unchanged_rejected' });
    assert.equal(existsSync(filterMarker), false);
    execFileSync('git', ['update-index', '--no-assume-unchanged', 'tracked.txt'], { cwd: baselineWorkspace });

    const trackedPath = path.join(baselineWorkspace, 'tracked.txt');
    const gitWrapperPath = path.join(fixture.binDir, 'git');
    const gitWrapperCountPath = path.join(fixture.root, 'git-wrapper-count');
    writeFileSync(gitWrapperPath, `#!/bin/sh
count=0
if [ -r "${gitWrapperCountPath}" ]; then
  IFS= read -r count < "${gitWrapperCountPath}"
fi
count=$((count + 1))
printf '%s\\n' "$count" > "${gitWrapperCountPath}"
if [ "$count" -eq 13 ]; then
  printf 'mutated!\\n' > "${trackedPath}"
fi
exec /usr/bin/git "$@"
`);
    chmodSync(gitWrapperPath, 0o700);
    const unstableBaseline = await api(runtime, '/api/delivery-plans/baseline', {
      method: 'POST',
      body: { workspace: baselineWorkspace }
    });
    assert.equal(unstableBaseline.response.status, 409);
    assert.deepEqual(unstableBaseline.json, { error: 'delivery_plan_baseline_unstable' });
    assert.equal(readFileSync(trackedPath, 'utf8'), 'mutated!\n');
    assert.equal(existsSync(filterMarker), false);
    rmSync(gitWrapperPath, { force: true });
    rmSync(gitWrapperCountPath, { force: true });

    writeFileSync(gitWrapperPath, `#!/bin/sh
case "$*" in
  *'config --type=bool --get core.sparseCheckout'*) exit 2 ;;
esac
exec /usr/bin/git "$@"
`);
    chmodSync(gitWrapperPath, 0o700);
    const unavailableGitConfig = await api(runtime, '/api/delivery-plans/baseline', {
      method: 'POST',
      body: { workspace: baselineWorkspace }
    });
    assert.equal(unavailableGitConfig.response.status, 409);
    assert.deepEqual(unavailableGitConfig.json, { error: 'delivery_plan_baseline_git_config_unavailable' });

    writeFileSync(gitWrapperPath, `#!/bin/sh
case "$*" in
  *'config --type=bool --get core.sparseCheckout'*) printf 'maybe\\n'; exit 0 ;;
esac
exec /usr/bin/git "$@"
`);
    chmodSync(gitWrapperPath, 0o700);
    const invalidGitConfig = await api(runtime, '/api/delivery-plans/baseline', {
      method: 'POST',
      body: { workspace: baselineWorkspace }
    });
    assert.equal(invalidGitConfig.response.status, 400);
    assert.deepEqual(invalidGitConfig.json, { error: 'delivery_plan_baseline_git_config_invalid' });
    rmSync(gitWrapperPath, { force: true });

    const initial = await api(runtime, '/api/snapshot');
    assert.equal(initial.response.status, 200);
    assert.equal(initial.json.capabilities.deliveryPlans, true);
    assert.deepEqual(initial.json.deliveryPlans, {
      version: 1,
      revision: 0,
      counts: {
        total: 0,
        active: 0,
        terminal: 0,
        done: 0,
        canceled: 0,
        draft: 0,
        needsDecision: 0,
        awaitingApproval: 0,
        approved: 0,
        closed: 0,
        operations: 0
      },
      active: [],
      recent: []
    });

    for (const [pathname, method] of [
      ['/api/delivery-plans', 'POST'],
      ['/api/delivery-plans/plan-api-12345678', 'PATCH'],
      ['/api/delivery-plans/plan-api-12345678/transition', 'POST']
    ]) {
      const invalidBody = await api(runtime, pathname, { method, body: null });
      assert.equal(invalidBody.response.status, 400);
      assert.match(invalidBody.json.error, /^delivery_plan_/);
      assert.notEqual(invalidBody.json.error, 'internal_error');
    }

    const beforeMutations = toolLog(fixture);
    const createBody = {
      operationId: 'api-create-0001',
      expectedStoreRevision: 0,
      plan: readyPlan(baselineWorkspace)
    };
    const created = await api(runtime, '/api/delivery-plans', { method: 'POST', body: createBody });
    assert.equal(created.response.status, 200);
    assert.equal(created.json.replayed, false);
    assert.equal(created.json.storeRevision, 1);
    assert.equal(created.json.plan.revision, 1);
    assert.deepEqual(created.json.executionPreview, {
      dispatchEnabled: false,
      runCreationEnabled: false,
      steps: []
    });

    const replayedCreate = await api(runtime, '/api/delivery-plans', { method: 'POST', body: createBody });
    assert.equal(replayedCreate.response.status, 200);
    assert.equal(replayedCreate.json.replayed, true);
    assert.equal(replayedCreate.json.storeRevision, 1);

    const conflictingOperation = await api(runtime, '/api/delivery-plans', {
      method: 'POST',
      body: { ...createBody, plan: { ...createBody.plan, title: 'Conflicting replay' } }
    });
    assert.equal(conflictingOperation.response.status, 409);
    assert.deepEqual(conflictingOperation.json, { error: 'delivery_plan_store_operation_conflict' });

    const noncanonicalWorkspace = await api(runtime, `/api/delivery-plans/${created.json.plan.id}`, {
      method: 'PATCH',
      body: {
        operationId: 'api-update-noncanonical-workspace',
        expectedStoreRevision: 1,
        expectedPlanRevision: 1,
        patch: { workspace: `${baselineWorkspace}/` }
      }
    });
    assert.equal(noncanonicalWorkspace.response.status, 400);
    assert.deepEqual(noncanonicalWorkspace.json, { error: 'delivery_plan_workspace_not_canonical' });

    const staleStore = await api(runtime, `/api/delivery-plans/${created.json.plan.id}`, {
      method: 'PATCH',
      body: {
        operationId: 'api-update-stale-store',
        expectedStoreRevision: 0,
        expectedPlanRevision: 1,
        patch: { title: 'Stale update' }
      }
    });
    assert.equal(staleStore.response.status, 409);
    assert.deepEqual(staleStore.json, { error: 'delivery_plan_store_revision_conflict' });

    const stalePlan = await api(runtime, `/api/delivery-plans/${created.json.plan.id}`, {
      method: 'PATCH',
      body: {
        operationId: 'api-update-stale-plan',
        expectedStoreRevision: 1,
        expectedPlanRevision: 2,
        patch: { title: 'Stale plan update' }
      }
    });
    assert.equal(stalePlan.response.status, 409);
    assert.deepEqual(stalePlan.json, { error: 'delivery_plan_store_plan_revision_conflict' });

    const updated = await api(runtime, `/api/delivery-plans/${created.json.plan.id}`, {
      method: 'PATCH',
      body: {
        operationId: 'api-update-0001',
        expectedStoreRevision: 1,
        expectedPlanRevision: 1,
        patch: { title: 'Reviewed delivery plan' }
      }
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.json.storeRevision, 2);
    assert.equal(updated.json.plan.revision, 2);
    assert.equal(updated.json.plan.title, 'Reviewed delivery plan');

    const ready = await api(runtime, `/api/delivery-plans/${created.json.plan.id}/transition`, {
      method: 'POST',
      body: {
        operationId: 'api-ready-0001',
        expectedStoreRevision: 2,
        expectedPlanRevision: 2,
        expectedDigest: updated.json.digest,
        to: 'ready_for_approval',
        conditions: {}
      }
    });
    assert.equal(ready.response.status, 200);
    assert.equal(ready.json.plan.phase, 'ready_for_approval');
    assert.equal(ready.json.storeRevision, 3);

    const disguisedApproval = await api(runtime, `/api/delivery-plans/${created.json.plan.id}/transition`, {
      method: 'POST',
      body: {
        operationId: 'api-approve-disguised',
        expectedStoreRevision: 3,
        expectedPlanRevision: 3,
        to: ' APPROVED ',
        conditions: { confirmation: 'approve-plan' }
      }
    });
    assert.equal(disguisedApproval.response.status, 400);
    assert.deepEqual(disguisedApproval.json, { error: 'delivery_plan_expected_digest_required' });

    const nonStringApproval = await api(runtime, `/api/delivery-plans/${created.json.plan.id}/transition`, {
      method: 'POST',
      body: {
        operationId: 'api-approve-array',
        expectedStoreRevision: 3,
        expectedPlanRevision: 3,
        expectedDigest: ready.json.digest,
        to: ['approved'],
        conditions: { confirmation: 'approve-plan' }
      }
    });
    assert.equal(nonStringApproval.response.status, 400);
    assert.deepEqual(nonStringApproval.json, { error: 'delivery_plan_transition_invalid' });

    const staleDigest = await api(runtime, `/api/delivery-plans/${created.json.plan.id}/transition`, {
      method: 'POST',
      body: {
        operationId: 'api-approve-stale-digest',
        expectedStoreRevision: 3,
        expectedPlanRevision: 3,
        expectedDigest: '0'.repeat(64),
        to: 'approved',
        conditions: { confirmation: 'approve-plan' }
      }
    });
    assert.equal(staleDigest.response.status, 409);
    assert.deepEqual(staleDigest.json, { error: 'delivery_plan_digest_conflict' });

    const executionAttempt = await api(runtime, `/api/delivery-plans/${created.json.plan.id}/transition`, {
      method: 'POST',
      body: {
        operationId: 'api-execute-disabled',
        expectedStoreRevision: 3,
        expectedPlanRevision: 3,
        expectedDigest: ready.json.digest,
        to: 'executing',
        conditions: {}
      }
    });
    assert.equal(executionAttempt.response.status, 409);
    assert.deepEqual(executionAttempt.json, { error: 'delivery_plan_execution_not_enabled' });

    const disguisedExecution = await api(runtime, `/api/delivery-plans/${created.json.plan.id}/transition`, {
      method: 'POST',
      body: {
        operationId: 'api-execute-disguised',
        expectedStoreRevision: 3,
        expectedPlanRevision: 3,
        expectedDigest: ready.json.digest,
        to: 'EXECUTING',
        conditions: {}
      }
    });
    assert.equal(disguisedExecution.response.status, 409);
    assert.deepEqual(disguisedExecution.json, { error: 'delivery_plan_execution_not_enabled' });

    const approvalBody = {
      operationId: 'api-approve-0001',
      expectedStoreRevision: 3,
      expectedPlanRevision: 3,
      expectedDigest: ready.json.digest,
      to: 'approved',
      conditions: { confirmation: 'approve-plan' }
    };
    const approved = await api(runtime, `/api/delivery-plans/${created.json.plan.id}/transition`, {
      method: 'POST', body: approvalBody
    });
    assert.equal(approved.response.status, 200);
    assert.equal(approved.json.plan.phase, 'approved');
    assert.equal(approved.json.storeRevision, 4);
    assert.equal(approved.json.plan.approval.digest, approved.json.digest);
    assert.equal(approved.json.executionPreview.dispatchEnabled, false);
    assert.equal(approved.json.executionPreview.steps.length, 1);
    assert.deepEqual({
      stepId: approved.json.executionPreview.steps[0].stepId,
      ready: approved.json.executionPreview.steps[0].ready,
      error: approved.json.executionPreview.steps[0].error
    }, { stepId: 'STEP-001', ready: true, error: '' });
    assert.ok(approved.json.executionPreview.steps[0].chars > 0);

    const replayedApproval = await api(runtime, `/api/delivery-plans/${created.json.plan.id}/transition`, {
      method: 'POST', body: approvalBody
    });
    assert.equal(replayedApproval.response.status, 200);
    assert.equal(replayedApproval.json.replayed, true);
    assert.equal(replayedApproval.json.storeRevision, 4);
    assert.equal(toolLog(fixture), beforeMutations, 'planning mutations must not invoke terminal or host tools');

    const snapshot = await api(runtime, '/api/snapshot');
    assert.equal(snapshot.response.status, 200);
    assert.equal(snapshot.json.deliveryPlans.revision, 4);
    assert.equal(snapshot.json.deliveryPlans.counts.approved, 1);
    assert.equal(snapshot.json.deliveryPlans.active[0].id, created.json.plan.id);
    assert.deepEqual(Object.keys(snapshot.json.deliveryPlans.active[0]).sort(), [
      'digest', 'errorCount', 'id', 'phase', 'ready', 'revision', 'title', 'updatedAt', 'warningCount'
    ]);
    assert.equal(JSON.stringify(snapshot.json.deliveryPlans).includes('lazy-detail-only-request-marker'), false);

    const detail = await api(runtime, `/api/delivery-plans/${created.json.plan.id}`);
    assert.equal(detail.response.status, 200);
    assert.equal(detail.json.plan.request.includes('lazy-detail-only-request-marker'), true);
    assert.equal(detail.json.plan.title, 'Reviewed delivery plan');
    assert.equal(detail.json.digest, approved.json.digest);
    assert.equal(detail.json.readiness.ready, true);

    const oversizedPlan = readyPlan(baselineWorkspace);
    oversizedPlan.id = 'plan-long-12345678';
    oversizedPlan.title = 'Plan whose execution envelope exceeds the worker limit';
    oversizedPlan.roles.po.nonGoals = Array.from(
      { length: 6 },
      (_, index) => `Non-goal ${index + 1}: ${'x'.repeat(780)}`
    );
    const oversizedCreated = await api(runtime, '/api/delivery-plans', {
      method: 'POST',
      body: {
        operationId: 'api-create-oversized-preview',
        expectedStoreRevision: 4,
        plan: oversizedPlan
      }
    });
    assert.equal(oversizedCreated.response.status, 200);
    const oversizedReady = await api(runtime, `/api/delivery-plans/${oversizedPlan.id}/transition`, {
      method: 'POST',
      body: {
        operationId: 'api-ready-oversized-preview',
        expectedStoreRevision: 5,
        expectedPlanRevision: 1,
        expectedDigest: oversizedCreated.json.digest,
        to: 'ready_for_approval',
        conditions: {}
      }
    });
    assert.equal(oversizedReady.response.status, 200);
    const oversizedApproved = await api(runtime, `/api/delivery-plans/${oversizedPlan.id}/transition`, {
      method: 'POST',
      body: {
        operationId: 'api-approve-oversized-preview',
        expectedStoreRevision: 6,
        expectedPlanRevision: 2,
        expectedDigest: oversizedReady.json.digest,
        to: 'approved',
        conditions: { confirmation: 'approve-plan' }
      }
    });
    assert.equal(oversizedApproved.response.status, 200);
    assert.deepEqual(oversizedApproved.json.executionPreview.steps, [{
      stepId: 'STEP-001',
      ready: false,
      chars: 0,
      error: 'delivery_plan_execution_envelope_too_long'
    }]);

    await stopChildProcess(runtime.child);
    runtime = await startFixture(fixture);
    const restored = await api(runtime, `/api/delivery-plans/${created.json.plan.id}`);
    assert.equal(restored.response.status, 200);
    assert.equal(restored.json.plan.phase, 'approved');
    assert.equal(restored.json.plan.revision, 4);
    assert.equal(restored.json.plan.title, 'Reviewed delivery plan');
    assert.equal(restored.json.digest, approved.json.digest);
  } finally {
    await stopChildProcess(runtime?.child);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('malformed delivery-plan state fails startup before listening', async () => {
  const fixture = createFixture('panefleet-delivery-plan-malformed-');
  let child;
  try {
    writeFileSync(fixture.deliveryPlanPath, '{"version":1', { mode: 0o600 });
    chmodSync(fixture.deliveryPlanPath, 0o600);
    const port = await unusedLoopbackPort();
    let output = '';
    child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
      cwd: fixture.root,
      env: {
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
        TMPDIR: os.tmpdir(),
        TMP: os.tmpdir(),
        TEMP: os.tmpdir(),
        DELIVERY_PLAN_PATH: fixture.deliveryPlanPath,
        PATH: `${fixture.binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        AWS_EC2_METADATA_DISABLED: 'true'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const [exitCode] = await waitForChildExit(child, { timeoutMs: 5000, label: 'malformed delivery plan fixture' });
    assert.notEqual(exitCode, 0);
    assert.match(output, /delivery_plan_store_json_invalid/);
    assert.doesNotMatch(output, /PaneFleet listening/);
  } finally {
    await stopChildProcess(child);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
