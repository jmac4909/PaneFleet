import assert from 'node:assert/strict';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalSha256, lintDeliveryPlanReadiness, normalizeDeliveryPlan } from '../delivery-plan.js';
import {
  DELIVERY_PLANNING_RUN_MAX_PERSISTED_BYTES,
  createDeliveryPlanningRun,
  deliveryPlanningRoleSpawnLeaseBinding
} from '../delivery-planning-run.js';
import {
  PLANNING_ROLE_REPORT_MAX_PERSISTED_BYTES,
  planningRoleReportOutputDigest
} from '../planning-role-report.js';
import {
  DELIVERY_PLANNING_RUN_BASE_GRAPH_MAX_OPERATIONS,
  DELIVERY_PLANNING_RUN_CLEANUP_RECOVERY_EXTRA_MAX_OPERATIONS,
  DELIVERY_PLANNING_RUN_CONTINUE_RECEIPT_MAX_OPERATIONS,
  DELIVERY_PLANNING_RUN_MAX_ACTIVE_OPERATION_FOOTPRINT,
  DELIVERY_PLANNING_RUN_OPERATION_SAFETY_MARGIN,
  DELIVERY_PLANNING_RUN_STORE_CURRENT_RUN_SLOT_MAX_PERSISTED_BYTES,
  DELIVERY_PLANNING_RUN_STORE_MAX_OPERATIONS,
  DELIVERY_PLANNING_RUN_STORE_MAX_PERSISTED_BYTES,
  DELIVERY_PLANNING_RUN_STORE_OPERATION_SLOT_MAX_PERSISTED_BYTES,
  createDeliveryPlanningRunRepository,
  deliveryPlanningRunStoreCapacity,
  deliveryPlanningRunStoreSummary,
  emptyDeliveryPlanningRunStore,
  validateDeliveryPlanningRunStore
} from '../delivery-planning-run-store.js';
import { createJsonAtomicWriter } from '../durable-json.js';

const AT = '2026-08-16T12:00:00.000Z';

function after(seconds) {
  return new Date(Date.parse(AT) + (seconds * 1000)).toISOString();
}

function sourcePlan(id = 'plan-planning-store-12345678', overrides = {}) {
  return normalizeDeliveryPlan({
    id,
    revision: 1,
    phase: 'planning',
    title: 'Build a reviewed Planning Pack',
    request: 'Have PO, BA, QA, and DEV prepare one candidate before implementation.',
    workspace: '/srv/panefleet-planning-store',
    baseline: {
      head: '960ceac898a5',
      workingTreeDigest: 'a'.repeat(64),
      instructionsDigest: 'b'.repeat(64),
      capturedAt: AT
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
        user: '',
        problem: '',
        outcome: '',
        value: '',
        nonGoals: [],
        assumptions: [],
        openQuestions: []
      },
      ba: {
        requirements: [],
        dependencies: [],
        edgeCases: [],
        constraints: [],
        openQuestions: []
      },
      dev: {
        architecture: '',
        steps: [],
        risks: [],
        rollback: '',
        openQuestions: []
      },
      qa: {
        acceptanceCriteria: [],
        testStrategy: '',
        regressionChecks: [],
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
    blocker: '',
    createdAt: AT,
    updatedAt: AT,
    ...overrides
  }, { at: AT });
}

function spawnLeaseBinding(run, role, attemptId, claimedAt = AT, overrides = {}) {
  return deliveryPlanningRoleSpawnLeaseBinding(run, {
    role,
    attemptId,
    contextDigest: canonicalSha256({ runId: run.id, role, attemptId, purpose: 'context' }),
    launchDigest: canonicalSha256({ runId: run.id, role, attemptId, purpose: 'launch' }),
    bindDeadlineAt: new Date(Date.parse(claimedAt) + 60_000).toISOString(),
    ...overrides
  });
}

function worker(role, lease) {
  const roleNumber = { po: 1, ba: 2, qa: 3, dev: 4 }[role];
  return {
    session: lease.session,
    sessionCreatedAt: AT,
    paneId: `${lease.session}:0.0`,
    tmuxPaneId: `%${roleNumber}`,
    panePid: 1000 + roleNumber,
    paneTty: `/dev/pts/${roleNumber}`,
    codexPid: 2000 + roleNumber,
    rolloutId: `019c000${roleNumber}-0000-7000-8000-00000000000${roleNumber}`,
    sourceId: String(roleNumber).repeat(24),
    commandDigest: lease.launchDigest,
    scopeUnit: lease.scopeUnit,
    scopeDigest: lease.scopeDigest
  };
}

function observedPane(role, lease) {
  const binding = worker(role, lease);
  return {
    sessionCreatedAt: binding.sessionCreatedAt,
    paneId: binding.paneId,
    tmuxPaneId: binding.tmuxPaneId,
    panePid: binding.panePid,
    paneTty: binding.paneTty
  };
}

function artifact(role, overrides = {}) {
  if (role === 'po') return {
    user: 'PaneFleet operator',
    problem: 'Delivery work can begin before its requirements are complete.',
    outcome: 'One reviewable Planning Pack is prepared before implementation.',
    value: 'Reduce scope drift and unverifiable completion.',
    nonGoals: ['Do not implement, deploy, or send external messages.'],
    assumptions: ['The source Plan and baseline remain current.'],
    openQuestions: [],
    ...overrides
  };
  if (role === 'ba') return {
    requirements: [{ id: 'REQ-001', text: 'Persist and review a deterministic Planning Pack.' }],
    dependencies: ['The source Plan remains at its bound revision.'],
    edgeCases: ['A durable response is lost after persistence.'],
    constraints: ['Planning workers remain read-only.'],
    openQuestions: [],
    ...overrides
  };
  if (role === 'qa') return {
    acceptanceCriteria: [{
      id: 'AC-001',
      text: 'A restart preserves the exact reviewed Planning Pack.',
      requirementIds: ['REQ-001']
    }],
    testStrategy: 'Exercise ordering, exact bindings, replay, restart, and tamper rejection.',
    regressionChecks: ['Existing Delivery Plan and Delivery Run records remain unchanged.'],
    releaseRequired: false,
    releaseChecks: [],
    openQuestions: [],
    ...overrides
  };
  return {
    architecture: 'Use a separate owner-only atomic JSON store with CAS receipts.',
    steps: [{
      id: 'STEP-001',
      title: 'Persist a Planning Run',
      outcome: 'The exact reviewed run survives restart.',
      requirementIds: ['REQ-001'],
      scopePaths: ['delivery-planning-run-store.js'],
      checks: ['node --test test/delivery-planning-run-store.test.js']
    }],
    risks: ['A retry could duplicate a transition without operation receipts.'],
    rollback: 'Remove only the isolated, not-yet-activated Planning Run integration.',
    openQuestions: [],
    ...overrides
  };
}

function roleReport(run, role, attemptId, { challenges = [], artifactOverrides = {} } = {}) {
  const report = {
    version: 1,
    runId: run.id,
    planId: run.planId,
    planRevision: run.planRevision,
    role,
    attemptId,
    inputDigest: run.roles[role].inputDigest,
    status: 'complete',
    artifact: artifact(role, artifactOverrides),
    challenges,
    evidence: [{ summary: `${role.toUpperCase()} produced a schema-bound planning artifact.`, trusted: false }]
  };
  return { report, outputDigest: planningRoleReportOutputDigest(report) };
}

async function fixture(t, { times, name = 'delivery-planning-runs.json', writeAtomic } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panefleet-planning-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'private', name);
  const clock = times || [AT];
  let index = 0;
  const repository = createDeliveryPlanningRunRepository({
    filePath,
    now: () => clock[Math.min(index++, clock.length - 1)],
    idFactory: () => 'planning-run-generated-12345678',
    ...(writeAtomic ? { writeAtomic } : {})
  });
  return { root, filePath, repository };
}

function persistedBytes(value) {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function syntheticTerminalStore(operationCount, {
  id = 'planning-run-synthetic-history-12345678',
  plan = sourcePlan('plan-synthetic-history-12345678'),
  terminal = true
} = {}) {
  assert.ok(operationCount >= 2);
  let snapshot = createDeliveryPlanningRun({ id, sourcePlan: plan }, { at: AT });
  const operations = [];
  for (let index = 0; index < operationCount; index += 1) {
    if (index > 0) {
      snapshot = { ...structuredClone(snapshot), revision: snapshot.revision + 1, updatedAt: AT };
      if (terminal && index === operationCount - 1) {
        snapshot.phase = 'closed';
        snapshot.condition = 'canceled';
        snapshot.blocker = 'Synthetic terminal history used only for capacity-boundary validation.';
      }
    }
    operations.push({
      id: `synthetic-operation-${String(index).padStart(8, '0')}`,
      action: index === 0
        ? 'planning_run.create'
        : (terminal && index === operationCount - 1 ? 'planning_run.cancel' : 'planning_run.off_course'),
      requestDigest: canonicalSha256({ id, index }),
      at: AT,
      result: { storeRevision: index + 1, run: structuredClone(snapshot) }
    });
  }
  return {
    version: 1,
    revision: operationCount,
    runs: [structuredClone(snapshot)],
    operations
  };
}

test('empty Planning Run store is exact and exposes bounded summaries', () => {
  const empty = emptyDeliveryPlanningRunStore();
  assert.deepEqual(validateDeliveryPlanningRunStore(empty), empty);
  assert.deepEqual(deliveryPlanningRunStoreSummary(empty), {
    version: 1,
    revision: 0,
    counts: {
      total: 0,
      active: 0,
      applied: 0,
      canceled: 0,
      needsAttention: 0,
      operations: 0
    },
    active: [],
    recent: []
  });
  assert.throws(
    () => validateDeliveryPlanningRunStore({ ...empty, extra: true }),
    /delivery_planning_run_store_shape_invalid/
  );
  assert.throws(
    () => validateDeliveryPlanningRunStore({ ...empty, version: 2 }),
    /delivery_planning_run_store_version_unsupported/
  );
  assert.throws(
    () => deliveryPlanningRunStoreSummary(empty, { activeLimit: -1 }),
    /active_limit_invalid/
  );
  assert.throws(
    () => deliveryPlanningRunStoreSummary(empty, { recentLimit: 129 }),
    /recent_limit_invalid/
  );
});

test('initialization creates an owner-only atomic store', async (t) => {
  const { filePath, repository } = await fixture(t);
  assert.equal((await repository.initialize()).counts.total, 0);
  const [directoryDetails, fileDetails] = await Promise.all([
    stat(path.dirname(filePath)),
    stat(filePath)
  ]);
  assert.equal(directoryDetails.mode & 0o777, 0o700);
  assert.equal(fileDetails.mode & 0o777, 0o600);
  assert.equal(fileDetails.isFile(), true);
  assert.equal(fileDetails.nlink, 1);
});

test('create is idempotent, CAS-bound, restart-safe, and rejects duplicate Plan bindings', async (t) => {
  const { filePath, repository } = await fixture(t);
  await repository.initialize();
  const request = {
    operationId: 'planning-store-create-exact',
    expectedStoreRevision: 0,
    run: { sourcePlan: sourcePlan() }
  };
  const created = await repository.create(request);
  assert.equal(created.replayed, false);
  assert.equal(created.storeRevision, 1);
  assert.equal(created.run.id, 'planning-run-generated-12345678');
  assert.equal(created.run.revision, 1);
  assert.equal(created.run.planId, request.run.sourcePlan.id);
  assert.equal((await repository.create(request)).replayed, true);
  await assert.rejects(
    repository.create({
      ...request,
      run: { sourcePlan: sourcePlan('plan-conflicting-store-12345678') }
    }),
    /delivery_planning_run_store_operation_conflict/
  );
  await assert.rejects(
    repository.create({
      operationId: 'planning-store-create-stale',
      expectedStoreRevision: 0,
      run: { sourcePlan: sourcePlan('plan-stale-store-12345678') }
    }),
    /delivery_planning_run_store_revision_conflict/
  );
  const duplicateRepository = createDeliveryPlanningRunRepository({
    filePath,
    now: () => AT,
    idFactory: () => 'planning-run-duplicate-12345678'
  });
  await assert.rejects(
    duplicateRepository.create({
      operationId: 'planning-store-create-duplicate',
      expectedStoreRevision: 1,
      run: { sourcePlan: sourcePlan() }
    }),
    /delivery_planning_run_store_plan_binding_duplicate/
  );

  const restarted = createDeliveryPlanningRunRepository({ filePath });
  const restored = await restarted.get(created.run.id, { includeHistory: true });
  assert.deepEqual(restored.run, created.run);
  assert.equal(restored.history.length, 1);
  assert.equal(restored.history[0].action, 'planning_run.create');
  assert.equal((await restarted.list()).counts.total, 1);
});

test('full PO, BA, independent QA and DEV, compile, apply, history, and restart lifecycle is durable', async (t) => {
  const { filePath, repository } = await fixture(t);
  await repository.initialize();
  let current = await repository.create({
    operationId: 'planning-lifecycle-create',
    expectedStoreRevision: 0,
    run: { sourcePlan: sourcePlan('plan-lifecycle-store-12345678') }
  });
  const runId = current.run.id;

  async function mutate(method, operationId, fields = {}) {
    current = await repository[method](runId, {
      operationId,
      expectedStoreRevision: current.storeRevision,
      expectedRunRevision: current.run.revision,
      ...fields
    });
    return current;
  }

  async function startRole(role) {
    const attemptId = `planning-attempt-${role}-store-12345678`;
    const spawnLease = spawnLeaseBinding(current.run, role, attemptId);
    await mutate('claimRoleSpawn', `planning-lifecycle-${role}-spawn`, { role, attemptId, spawnLease });
    await mutate('bindRoleSpawnLease', `planning-lifecycle-${role}-lease-bind`, {
      role,
      attemptId,
      leaseId: spawnLease.leaseId,
      scopeUnit: spawnLease.scopeUnit,
      scopeDigest: spawnLease.scopeDigest,
      observed: observedPane(role, spawnLease)
    });
    await mutate('claimRoleDispatch', `planning-lifecycle-${role}-dispatch`, {
      role,
      attemptId,
      leaseId: spawnLease.leaseId,
      worker: worker(role, spawnLease),
      rolloutPath: `/srv/private/rollouts/${role}.jsonl`,
      rolloutStartOffset: 128,
      confirmationMarker: `[PaneFleet Planning Dispatch ${attemptId}]`,
      promptDigest: 'e'.repeat(64)
    });
    await mutate('markRoleDispatched', `planning-lifecycle-${role}-submitted`, { role, attemptId });
    return attemptId;
  }

  async function finishRole(role, attemptId) {
    await mutate('recordRoleReport', `planning-lifecycle-${role}-report`, {
      role,
      attemptId,
      ...roleReport(current.run, role, attemptId)
    });
    await mutate('claimRoleCleanup', `planning-lifecycle-${role}-cleanup-claim`, {
      role,
      attemptId,
      claimId: `cleanup-claim-${role}-12345678`
    });
    await mutate('markRoleCleanupSent', `planning-lifecycle-${role}-cleanup-sent`, {
      role,
      attemptId
    });
    await mutate('markRoleCleanupComplete', `planning-lifecycle-${role}-cleanup-complete`, {
      role,
      attemptId
    });
  }

  await mutate('markResourceWait', 'planning-lifecycle-resource-wait', {
    role: 'po',
    reason: 'Memory headroom is temporarily below the Planning Worker gate.'
  });
  assert.equal(current.run.condition, 'resource_wait');
  const poAttempt = await startRole('po');
  await finishRole('po', poAttempt);
  assert.equal(current.run.phase, 'ba');
  await assert.rejects(repository.claimRoleSpawn(runId, {
    operationId: 'planning-lifecycle-qa-too-early',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    role: 'qa',
    attemptId: 'planning-attempt-qa-too-early-12345678',
    spawnLease: {}
  }), /delivery_planning_run_role_phase_ineligible/);

  const baAttempt = await startRole('ba');
  await finishRole('ba', baAttempt);
  assert.equal(current.run.phase, 'challenge');

  const qaAttempt = await startRole('qa');
  const devAttempt = await startRole('dev');
  assert.match(current.run.roles.qa.inputDigest, /^[a-f0-9]{64}$/);
  assert.match(current.run.roles.dev.inputDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(current.run.roles.qa.attempts[0].id, current.run.roles.dev.attempts[0].id);

  // Finish DEV first to prove QA and DEV completion order is immaterial.
  await finishRole('dev', devAttempt);
  assert.equal(current.run.phase, 'challenge');
  await finishRole('qa', qaAttempt);
  assert.equal(current.run.phase, 'synthesis');

  await mutate('compileCandidate', 'planning-lifecycle-compile');
  assert.equal(current.run.phase, 'review');
  assert.equal(current.run.candidate.readiness.ready, true);
  assert.deepEqual(Object.keys(current.run.candidate.definitionPatch).sort(), [
    'roles',
    'unresolvedQuestions'
  ]);
  const candidateDigest = current.run.candidate.digest;
  const previewPlanDigest = current.run.candidate.previewPlanDigest;
  await mutate('claimApply', 'planning-lifecycle-apply-claim-op', {
    claimId: 'planning-lifecycle-apply-claim',
    candidateDigest
  });
  await mutate('markApplied', 'planning-lifecycle-applied-op', {
    claimId: 'planning-lifecycle-apply-claim',
    candidateDigest,
    appliedPlanRevision: current.run.planRevision + 1,
    appliedPlanDigest: previewPlanDigest
  });
  assert.equal(current.run.phase, 'applied');
  assert.equal(current.run.applyOutbox.state, 'applied');
  assert.equal((await repository.list()).counts.applied, 1);
  await assert.rejects(repository.cancel(runId, {
    operationId: 'planning-lifecycle-cancel-terminal',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    operatorConfirmed: true,
    reason: 'Terminal runs cannot be canceled.'
  }), /delivery_planning_run_terminal/);

  const rejectedTerminalMutations = [
    ['markRoleNeedsInput', 'terminal-needs-input', {
      role: 'po', attemptId: poAttempt, reason: 'No terminal mutation is allowed.'
    }],
    ['markRoleCrash', 'terminal-crash', {
      role: 'po', attemptId: poAttempt, reason: 'No terminal mutation is allowed.'
    }],
    ['markRoleReconcileRequired', 'terminal-reconcile', {
      role: 'po', attemptId: poAttempt, reason: 'No terminal mutation is allowed.'
    }],
    ['markRoleCleanupRequired', 'terminal-cleanup-required', {
      role: 'po', attemptId: poAttempt, error: 'Cleanup is already complete.'
    }],
    ['markApplyReconcileRequired', 'terminal-apply-reconcile', {
      claimId: 'planning-lifecycle-apply-claim', error: 'Apply is already complete.'
    }],
    ['markOffCourse', 'terminal-off-course', { reason: 'Applied runs are immutable.' }]
  ];
  for (const [method, suffix, fields] of rejectedTerminalMutations) {
    await assert.rejects(repository[method](runId, {
      operationId: `planning-lifecycle-${suffix}`,
      expectedStoreRevision: current.storeRevision,
      expectedRunRevision: current.run.revision,
      ...fields
    }), /delivery_planning_run_/);
  }

  const restarted = createDeliveryPlanningRunRepository({ filePath });
  const restored = await restarted.get(runId, { includeHistory: true });
  assert.deepEqual(restored.run, current.run);
  assert.equal(restored.history.length, current.storeRevision);
  assert.deepEqual(
    restored.history.map((entry) => entry.storeRevision),
    Array.from({ length: current.storeRevision }, (_, index) => index + 1)
  );
  const scopeTampered = JSON.parse(await readFile(filePath, 'utf8'));
  const dispatchedSnapshot = scopeTampered.operations.find((operation) => (
    operation.action === 'planning_run.role_dispatched'
    && operation.result.run.roles.po.attempts.length === 1
  ));
  dispatchedSnapshot.result.run.roles.po.attempts[0].paneTty = '/dev/pts/999';
  dispatchedSnapshot.result.run.roles.po.attempts[0].spawnLease.observed.paneTty = '/dev/pts/999';
  assert.throws(
    () => validateDeliveryPlanningRunStore(scopeTampered),
    /delivery_planning_run_store_spawn_lease_observation_changed/
  );
});

test('default clock and IDs produce distinct sortable summaries', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panefleet-planning-defaults-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = createDeliveryPlanningRunRepository({
    filePath: path.join(root, 'private', 'runs.json')
  });
  await repository.initialize();
  const first = await repository.create({
    operationId: 'planning-default-create-first',
    expectedStoreRevision: 0,
    run: { sourcePlan: sourcePlan('plan-default-first-12345678') }
  });
  const closedFirst = await repository.cancel(first.run.id, {
    operationId: 'planning-default-cancel-first',
    expectedStoreRevision: first.storeRevision,
    expectedRunRevision: first.run.revision,
    operatorConfirmed: true,
    reason: 'Close the first bounded default-ID run.'
  });
  const second = await repository.create({
    operationId: 'planning-default-create-second',
    expectedStoreRevision: closedFirst.storeRevision,
    run: { sourcePlan: sourcePlan('plan-default-second-12345678') }
  });
  assert.match(first.run.id, /^planning-run-[a-f0-9]{24}$/);
  assert.match(second.run.id, /^planning-run-[a-f0-9]{24}$/);
  assert.notEqual(first.run.id, second.run.id);
  const closedSecond = await repository.cancel(second.run.id, {
    operationId: 'planning-default-cancel-second',
    expectedStoreRevision: second.storeRevision,
    expectedRunRevision: second.run.revision,
    operatorConfirmed: true,
    reason: 'Close the second bounded default-ID run.'
  });
  const repeated = await repository.create({
    operationId: 'planning-default-create-repeated-binding',
    expectedStoreRevision: closedSecond.storeRevision,
    run: { sourcePlan: sourcePlan('plan-default-first-12345678') }
  });
  assert.notEqual(repeated.run.id, first.run.id);
  await repository.cancel(repeated.run.id, {
    operationId: 'planning-default-cancel-repeated-binding',
    expectedStoreRevision: repeated.storeRevision,
    expectedRunRevision: repeated.run.revision,
    operatorConfirmed: true,
    reason: 'Close the later workshop round for the same Plan binding.'
  });
  const summary = await repository.list();
  assert.equal(summary.active.length, 0);
  assert.equal(summary.recent.length, 3);
});

test('concurrent CAS claims serialize and exactly one mutation wins', async (t) => {
  const { repository } = await fixture(t);
  await repository.initialize();
  const created = await repository.create({
    operationId: 'planning-concurrent-create',
    expectedStoreRevision: 0,
    run: { sourcePlan: sourcePlan('plan-concurrent-store-12345678') }
  });
  const request = (suffix) => repository.claimRoleSpawn(created.run.id, {
    operationId: `planning-concurrent-spawn-${suffix}`,
    expectedStoreRevision: created.storeRevision,
    expectedRunRevision: created.run.revision,
    role: 'po',
    attemptId: `planning-attempt-concurrent-${suffix}-12345678`,
    spawnLease: spawnLeaseBinding(
      created.run,
      'po',
      `planning-attempt-concurrent-${suffix}-12345678`
    )
  });
  const results = await Promise.allSettled([request('first'), request('second')]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(
    results.find((result) => result.status === 'rejected').reason.message,
    /delivery_planning_run_store_revision_conflict/
  );
  assert.equal((await repository.get(created.run.id)).revision, 2);
});

test('a crash before pane bind can adopt only the exact durable provisional lease', async (t) => {
  const { filePath, repository } = await fixture(t, {
    name: 'spawn-lease-adoption.json',
    times: [AT, after(1)]
  });
  await repository.initialize();
  let current = await repository.create({
    operationId: 'planning-lease-adopt-create', expectedStoreRevision: 0,
    run: { sourcePlan: sourcePlan('plan-lease-adopt-12345678') }
  });
  const attemptId = 'planning-attempt-lease-adopt-12345678';
  const spawnLease = spawnLeaseBinding(current.run, 'po', attemptId, after(1));
  const spawnRequest = {
    operationId: 'planning-lease-adopt-claim',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    role: 'po', attemptId, spawnLease
  };
  current = await repository.claimRoleSpawn(current.run.id, spawnRequest);
  assert.equal(current.run.roles.po.attempts[0].spawnLease.state, 'claimed');

  const restarted = createDeliveryPlanningRunRepository({ filePath, now: () => after(1) });
  assert.deepEqual(await restarted.get(current.run.id), current.run);
  await assert.rejects(restarted.bindRoleSpawnLease(current.run.id, {
    operationId: 'planning-lease-adopt-wrong-scope',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    scopeUnit: spawnLease.scopeUnit, scopeDigest: '0'.repeat(64),
    observed: observedPane('po', spawnLease)
  }), /delivery_planning_run_spawn_lease_binding_mismatch/);
  current = await restarted.bindRoleSpawnLease(current.run.id, {
    operationId: 'planning-lease-adopt-bind',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    scopeUnit: spawnLease.scopeUnit, scopeDigest: spawnLease.scopeDigest,
    observed: observedPane('po', spawnLease)
  });
  current = await restarted.claimRoleDispatch(current.run.id, {
    operationId: 'planning-lease-adopt-dispatch',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    worker: worker('po', spawnLease),
    rolloutPath: '/srv/codex/planning-lease-adopt.jsonl', rolloutStartOffset: 0,
    confirmationMarker: `[PaneFleet Planning Dispatch ${attemptId}]`, promptDigest: '9'.repeat(64)
  });
  assert.equal(current.run.roles.po.attempts[0].spawnLease.state, 'adopted');
  assert.equal(current.run.roles.po.attempts[0].session, spawnLease.session);
});

test('provisional exact-scope stop authority is durable, replay-safe, and closes only on absence', async (t) => {
  const { filePath, repository } = await fixture(t, {
    name: 'spawn-lease-stop.json',
    times: [AT, after(1), after(3), after(4), after(5), after(6), after(7)]
  });
  await repository.initialize();
  let current = await repository.create({
    operationId: 'planning-lease-stop-create', expectedStoreRevision: 0,
    run: { sourcePlan: sourcePlan('plan-lease-stop-12345678') }
  });
  const runId = current.run.id;
  const attemptId = 'planning-attempt-lease-stop-12345678';
  const spawnLease = spawnLeaseBinding(current.run, 'po', attemptId, after(1), {
    bindDeadlineAt: after(2)
  });
  current = await repository.claimRoleSpawn(runId, {
    operationId: 'planning-lease-stop-spawn',
    expectedStoreRevision: current.storeRevision, expectedRunRevision: current.run.revision,
    role: 'po', attemptId, spawnLease
  });
  current = await repository.markRoleSpawnLeaseReconcileRequired(runId, {
    operationId: 'planning-lease-stop-reconcile',
    expectedStoreRevision: current.storeRevision, expectedRunRevision: current.run.revision,
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    scopeUnit: spawnLease.scopeUnit, scopeDigest: spawnLease.scopeDigest,
    observation: 'present_unattestable',
    reason: 'The deterministic scope is present but cannot be safely adopted after deadline.'
  });
  const claimRequest = {
    operationId: 'planning-lease-stop-cleanup-claim',
    expectedStoreRevision: current.storeRevision, expectedRunRevision: current.run.revision,
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    claimId: 'planning:lease:stop:claim:0001', action: 'stop_exact_scope', operatorConfirmed: true
  };
  current = await repository.claimRoleSpawnLeaseCleanup(runId, claimRequest);
  assert.equal(current.replayed, false);
  const claimReplay = await repository.claimRoleSpawnLeaseCleanup(runId, claimRequest);
  assert.equal(claimReplay.replayed, true);
  assert.deepEqual(claimReplay.run, current.run);
  await assert.rejects(repository.cancel(runId, {
    operationId: 'planning-lease-stop-cancel-early',
    expectedStoreRevision: current.storeRevision, expectedRunRevision: current.run.revision,
    operatorConfirmed: true, reason: 'A claimed stop is not proof of absence.'
  }), /delivery_planning_run_cleanup_required/);
  const sentRequest = {
    operationId: 'planning-lease-stop-cleanup-sent',
    expectedStoreRevision: current.storeRevision, expectedRunRevision: current.run.revision,
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    claimId: 'planning:lease:stop:claim:0001'
  };
  current = await repository.markRoleSpawnLeaseCleanupSent(runId, sentRequest);
  assert.equal((await repository.markRoleSpawnLeaseCleanupSent(runId, sentRequest)).replayed, true);
  const restarted = createDeliveryPlanningRunRepository({ filePath, now: () => after(6) });
  assert.equal((await restarted.get(runId)).roles.po.attempts[0].spawnLease.cleanup.state, 'sent');
  current = await restarted.markRoleSpawnLeaseCleanupComplete(runId, {
    operationId: 'planning-lease-stop-cleanup-complete',
    expectedStoreRevision: current.storeRevision, expectedRunRevision: current.run.revision,
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    claimId: 'planning:lease:stop:claim:0001',
    scopeUnit: spawnLease.scopeUnit, scopeDigest: spawnLease.scopeDigest,
    observation: 'scope_and_pane_absent',
    reason: 'The exact persisted scope and tmux pane are both absent.'
  });
  assert.equal(current.run.roles.po.attempts[0].spawnLease.state, 'closed');
  current = await restarted.cancel(runId, {
    operationId: 'planning-lease-stop-cancel',
    expectedStoreRevision: current.storeRevision, expectedRunRevision: current.run.revision,
    operatorConfirmed: true, reason: 'The provisional worker is authoritatively absent.'
  });
  assert.equal(current.run.condition, 'canceled');
  const history = await restarted.get(runId, { includeHistory: true });
  assert.equal(history.history.filter((entry) => entry.action === 'planning_run.role_spawn_lease_cleanup_claim').length, 1);
  assert.equal(history.history.filter((entry) => entry.action === 'planning_run.role_spawn_lease_cleanup_sent').length, 1);
});

test('Continue and cleanup recovery receipts replay before stale CAS without duplicate authorization', async (t) => {
  const { repository, filePath } = await fixture(t);
  await repository.initialize();
  let current = await repository.create({
    operationId: 'planning-continue-create',
    expectedStoreRevision: 0,
    run: { sourcePlan: sourcePlan('plan-continue-store-12345678') }
  });
  current = await repository.markResourceWait(current.run.id, {
    operationId: 'planning-continue-resource-wait',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    role: 'po',
    reason: 'The bounded planning worker slot is unavailable.'
  });
  const continueRequest = {
    operationId: 'planning-continue-resource-authorize',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    kind: 'resource_retry',
    role: 'po',
    attemptId: '',
    claimId: '',
    cleanupRecoveryOutcome: ''
  };
  current = await repository.authorizeContinue(current.run.id, continueRequest);
  assert.equal(current.run.continueReceipts.length, 1);
  assert.equal(current.run.continueReceipts[0].requestedStoreRevision, 2);
  assert.equal(current.run.continueReceipts[0].requestedRunRevision, 2);
  const replay = await repository.authorizeContinue(current.run.id, continueRequest);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.run, current.run);
  await assert.rejects(repository.authorizeContinue(current.run.id, {
    ...continueRequest,
    role: 'ba'
  }), /delivery_planning_run_store_operation_conflict/);

  const continueAttemptId = 'planning-attempt-continue-po-12345678';
  const continueLease = spawnLeaseBinding(current.run, 'po', continueAttemptId);
  current = await repository.claimRoleSpawn(current.run.id, {
    operationId: 'planning-continue-spawn',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    role: 'po',
    attemptId: continueAttemptId,
    spawnLease: continueLease
  });
  current = await repository.closeRoleSpawnLeaseAbsent(current.run.id, {
    operationId: 'planning-continue-lease-absent',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    role: 'po',
    attemptId: continueAttemptId,
    leaseId: continueLease.leaseId,
    scopeUnit: continueLease.scopeUnit,
    scopeDigest: continueLease.scopeDigest,
    observation: 'scope_and_pane_absent',
    reason: 'The provisional scope and pane are authoritatively absent.'
  });
  assert.equal(current.run.roles.po.state, 'failed');
  current = await repository.cancel(current.run.id, {
    operationId: 'planning-continue-cancel-first',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    operatorConfirmed: true,
    reason: 'No exact worker was bound, so the operator safely closes the Run.'
  });

  current = await repository.create({
    operationId: 'planning-cleanup-create',
    expectedStoreRevision: current.storeRevision,
    run: {
      id: 'planning-run-cleanup-recovery-12345678',
      sourcePlan: sourcePlan('plan-cleanup-recovery-store-12345678')
    }
  });
  const runId = current.run.id;
  const attemptId = 'planning-attempt-cleanup-po-12345678';
  const cleanupLease = spawnLeaseBinding(current.run, 'po', attemptId);
  current = await repository.claimRoleSpawn(runId, {
    operationId: 'planning-cleanup-spawn',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    role: 'po', attemptId, spawnLease: cleanupLease
  });
  current = await repository.bindRoleSpawnLease(runId, {
    operationId: 'planning-cleanup-lease-bind',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    role: 'po', attemptId,
    leaseId: cleanupLease.leaseId,
    scopeUnit: cleanupLease.scopeUnit,
    scopeDigest: cleanupLease.scopeDigest,
    observed: observedPane('po', cleanupLease)
  });
  current = await repository.claimRoleDispatch(runId, {
    operationId: 'planning-cleanup-dispatch-claim',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    role: 'po', attemptId, leaseId: cleanupLease.leaseId, worker: worker('po', cleanupLease),
    rolloutPath: '/srv/codex/planning-cleanup.jsonl',
    rolloutStartOffset: 100,
    confirmationMarker: `[PaneFleet Planning Dispatch ${attemptId}]`,
    promptDigest: 'c'.repeat(64)
  });
  current = await repository.markRoleDispatched(runId, {
    operationId: 'planning-cleanup-dispatched',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    role: 'po', attemptId
  });
  const result = roleReport(current.run, 'po', attemptId);
  current = await repository.recordRoleReport(runId, {
    operationId: 'planning-cleanup-report',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    role: 'po', attemptId, ...result
  });
  current = await repository.authorizeContinue(runId, {
    operationId: 'planning-cleanup-pending-authorize',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    kind: 'cleanup_only', role: 'po', attemptId,
    claimId: 'planning:cleanup:pending:claim',
    cleanupRecoveryOutcome: ''
  });
  assert.equal(current.run.roles.po.attempts[0].cleanup.state, 'claimed');
  current = await repository.markRoleCleanupRequired(runId, {
    operationId: 'planning-cleanup-reconcile-required',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    role: 'po', attemptId, error: 'The cleanup input outcome is uncertain.'
  });
  const recoveryAuthorization = {
    operationId: 'planning-cleanup-recovery-authorize',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    kind: 'cleanup_only', role: 'po', attemptId,
    claimId: 'planning:cleanup:recovered:claim',
    cleanupRecoveryOutcome: 'exact_worker'
  };
  current = await repository.authorizeContinue(runId, recoveryAuthorization);
  assert.equal(current.run.roles.po.attempts[0].cleanup.recoveryOutcome, 'exact_worker');
  assert.equal((await repository.authorizeContinue(runId, recoveryAuthorization)).replayed, true);
  await assert.rejects(repository.authorizeContinue(runId, {
    ...recoveryAuthorization,
    claimId: 'planning:cleanup:changed:claim'
  }), /delivery_planning_run_store_operation_conflict/);
  current = await repository.markRoleCleanupSent(runId, {
    operationId: 'planning-cleanup-recovered-sent',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    role: 'po', attemptId
  });
  current = await repository.markRoleCleanupRequired(runId, {
    operationId: 'planning-cleanup-second-reconcile',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    role: 'po', attemptId,
    error: 'The recovered cleanup response was lost.'
  });
  current = await repository.authorizeContinue(runId, {
    operationId: 'planning-cleanup-second-authorize',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    kind: 'cleanup_only', role: 'po', attemptId,
    claimId: 'planning:cleanup:recovered:claim2', cleanupRecoveryOutcome: 'exact_worker'
  });
  current = await repository.markRoleCleanupSent(runId, {
    operationId: 'planning-cleanup-second-sent',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    role: 'po', attemptId
  });
  current = await repository.markRoleCleanupRequired(runId, {
    operationId: 'planning-cleanup-third-reconcile',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    role: 'po', attemptId, error: 'The second recovered cleanup response was lost.'
  });
  current = await repository.recoverRoleCleanup(runId, {
    operationId: 'planning-cleanup-third-absent',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    role: 'po', attemptId, outcome: 'worker_absent', claimId: ''
  });
  assert.equal(current.run.condition, 'reconcile_required');
  assert.equal(current.run.roles.po.attempts[0].cleanup.state, 'complete');
  assert.equal(current.run.roles.po.attempts[0].cleanup.recoveryCount, 3);
  current = await repository.cancel(runId, {
    operationId: 'planning-cleanup-recovered-cancel',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    operatorConfirmed: true,
    reason: 'The exact recovered worker exited and the operator closes the Run.'
  });
  assert.equal(current.run.condition, 'canceled');
  assert.deepEqual((await createDeliveryPlanningRunRepository({ filePath }).get(runId)), current.run);
});

test('repository reserves six Continue receipts for cleanup after the resource retry cap', async (t) => {
  const { repository } = await fixture(t);
  await repository.initialize();
  let current = await repository.create({
    operationId: 'planning-receipt-partition-create',
    expectedStoreRevision: 0,
    run: { sourcePlan: sourcePlan('plan-receipt-partition-12345678') }
  });
  current = await repository.authorizeContinue(current.run.id, {
    operationId: 'planning-receipt-partition-initial-active',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    kind: 'resource_retry', role: 'po', attemptId: '', claimId: '', cleanupRecoveryOutcome: ''
  });
  for (let index = 1; index < 6; index += 1) {
    current = await repository.markResourceWait(current.run.id, {
      operationId: `planning-receipt-partition-wait-${index}`,
      expectedStoreRevision: current.storeRevision,
      expectedRunRevision: current.run.revision,
      role: 'po', reason: `Resource gate ${index + 1} remains closed.`
    });
    current = await repository.authorizeContinue(current.run.id, {
      operationId: `planning-receipt-partition-authorize-${index}`,
      expectedStoreRevision: current.storeRevision,
      expectedRunRevision: current.run.revision,
      kind: 'resource_retry', role: 'po', attemptId: '', claimId: '', cleanupRecoveryOutcome: ''
    });
  }
  current = await repository.markResourceWait(current.run.id, {
    operationId: 'planning-receipt-partition-wait-capped',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    role: 'po', reason: 'The resource retry budget is exhausted before worker creation.'
  });
  await assert.rejects(repository.authorizeContinue(current.run.id, {
    operationId: 'planning-receipt-partition-authorize-capped',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    kind: 'resource_retry', role: 'po', attemptId: '', claimId: '', cleanupRecoveryOutcome: ''
  }), /delivery_planning_run_continue_receipt_limit_reached/);
  current = await repository.cancel(current.run.id, {
    operationId: 'planning-receipt-partition-cancel',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    operatorConfirmed: true,
    reason: 'No worker exists and the operator safely closes the capped Run.'
  });
  assert.equal(current.run.condition, 'canceled');
});

test('worker-absent recovery is durable, idempotent, and clears only unresolved cleanup', async (t) => {
  const { repository } = await fixture(t);
  await repository.initialize();
  let current = await repository.create({
    operationId: 'planning-absent-create', expectedStoreRevision: 0,
    run: { sourcePlan: sourcePlan('plan-worker-absent-store-12345678') }
  });
  const runId = current.run.id;
  const attemptId = 'planning-attempt-absent-po-12345678';
  const absentLease = spawnLeaseBinding(current.run, 'po', attemptId);
  current = await repository.claimRoleSpawn(runId, {
    operationId: 'planning-absent-spawn', expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision, role: 'po', attemptId, spawnLease: absentLease
  });
  current = await repository.bindRoleSpawnLease(runId, {
    operationId: 'planning-absent-lease-bind', expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision, role: 'po', attemptId,
    leaseId: absentLease.leaseId,
    scopeUnit: absentLease.scopeUnit,
    scopeDigest: absentLease.scopeDigest,
    observed: observedPane('po', absentLease)
  });
  current = await repository.claimRoleDispatch(runId, {
    operationId: 'planning-absent-dispatch', expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision, role: 'po', attemptId,
    leaseId: absentLease.leaseId, worker: worker('po', absentLease),
    rolloutPath: '/srv/codex/planning-absent.jsonl', rolloutStartOffset: 10,
    confirmationMarker: `[PaneFleet Planning Dispatch ${attemptId}]`, promptDigest: 'd'.repeat(64)
  });
  current = await repository.markRoleDispatched(runId, {
    operationId: 'planning-absent-submitted', expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision, role: 'po', attemptId
  });
  current = await repository.markRoleReconcileRequired(runId, {
    operationId: 'planning-absent-reconcile', expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision, role: 'po', attemptId,
    reason: 'The exact worker disappeared while its completion was uncertain.'
  });
  const request = {
    operationId: 'planning-absent-recover', expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision, role: 'po', attemptId,
    outcome: 'worker_absent', claimId: ''
  };
  current = await repository.recoverRoleCleanup(runId, request);
  assert.equal(current.run.roles.po.attempts[0].cleanup.state, 'complete');
  assert.equal(current.run.roles.po.attempts[0].cleanup.recoveryOutcome, 'worker_absent');
  assert.equal((await repository.recoverRoleCleanup(runId, request)).replayed, true);
  const closed = await repository.cancel(runId, {
    operationId: 'planning-absent-cancel', expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision, operatorConfirmed: true,
    reason: 'The persisted exact worker is absent; close without retrying role work.'
  });
  assert.equal(closed.run.condition, 'canceled');
});

test('store and request caps fail closed before persistence', async (t) => {
  const { filePath, repository } = await fixture(t);
  await repository.initialize();
  await assert.rejects(repository.create({
    operationId: 'planning-store-oversize-request',
    expectedStoreRevision: 0,
    run: {
      sourcePlan: sourcePlan('plan-oversize-store-12345678'),
      padding: 'x'.repeat(2 * 1024 * 1024)
    }
  }), /delivery_planning_run_store_request_too_large/);
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), emptyDeliveryPlanningRunStore());

  const created = await repository.create({
    operationId: 'planning-store-cap-source',
    expectedStoreRevision: 0,
    run: { sourcePlan: sourcePlan('plan-cap-source-12345678') }
  });
  const empty = emptyDeliveryPlanningRunStore();
  assert.throws(() => validateDeliveryPlanningRunStore({
    ...empty,
    runs: Array.from({ length: 65 }, () => created.run)
  }), /delivery_planning_run_store_runs_invalid/);
  assert.throws(() => validateDeliveryPlanningRunStore({
    ...empty,
    revision: 1025,
    operations: Array.from({ length: 1025 }, () => ({}))
  }), /delivery_planning_run_store_operations_invalid/);
});

test('operation reservation rejects the next Run early while a boundary Run can replay and cancel', async (t) => {
  async function seededRepository(name, count) {
    const seeded = await fixture(t, { name });
    await mkdir(path.dirname(seeded.filePath), { recursive: true, mode: 0o700 });
    const store = validateDeliveryPlanningRunStore(syntheticTerminalStore(count, {
      id: `planning-run-${name.replace(/[^a-z0-9]+/g, '-')}-12345678`,
      plan: sourcePlan(`plan-${name.replace(/[^a-z0-9]+/g, '-')}-12345678`)
    }));
    await writeFile(seeded.filePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await seeded.repository.initialize();
    return seeded;
  }

  assert.equal(
    DELIVERY_PLANNING_RUN_BASE_GRAPH_MAX_OPERATIONS
      + DELIVERY_PLANNING_RUN_CLEANUP_RECOVERY_EXTRA_MAX_OPERATIONS
      + DELIVERY_PLANNING_RUN_CONTINUE_RECEIPT_MAX_OPERATIONS
      + DELIVERY_PLANNING_RUN_OPERATION_SAFETY_MARGIN,
    77
  );
  assert.equal(DELIVERY_PLANNING_RUN_BASE_GRAPH_MAX_OPERATIONS, 37);
  assert.equal(DELIVERY_PLANNING_RUN_CLEANUP_RECOVERY_EXTRA_MAX_OPERATIONS, 24);
  assert.equal(DELIVERY_PLANNING_RUN_CONTINUE_RECEIPT_MAX_OPERATIONS, 12);
  assert.equal(DELIVERY_PLANNING_RUN_OPERATION_SAFETY_MARGIN, 4);
  assert.equal(DELIVERY_PLANNING_RUN_MAX_ACTIVE_OPERATION_FOOTPRINT, 77);
  const acceptedHistoryCount = 300;
  const exact = await seededRepository('operation-exact', acceptedHistoryCount);
  const createRequest = {
    operationId: 'planning-capacity-boundary-create',
    expectedStoreRevision: acceptedHistoryCount,
    run: {
      id: 'planning-run-capacity-boundary-12345678',
      sourcePlan: sourcePlan('plan-capacity-boundary-12345678')
    }
  };
  const created = await exact.repository.create(createRequest);
  const capacity = deliveryPlanningRunStoreCapacity(JSON.parse(await readFile(exact.filePath, 'utf8')));
  assert.ok(capacity.operationCount + capacity.reservedOperations <= DELIVERY_PLANNING_RUN_STORE_MAX_OPERATIONS);
  assert.equal((await exact.repository.create(createRequest)).replayed, true);
  const canceled = await exact.repository.cancel(created.run.id, {
    operationId: 'planning-capacity-boundary-cancel',
    expectedStoreRevision: created.storeRevision,
    expectedRunRevision: created.run.revision,
    operatorConfirmed: true,
    reason: 'The accepted boundary Run retains enough reserved budget to close safely.'
  });
  assert.equal(canceled.run.condition, 'canceled');

  const rejected = await seededRepository(
    'operation-reject',
    DELIVERY_PLANNING_RUN_STORE_MAX_OPERATIONS
      - DELIVERY_PLANNING_RUN_MAX_ACTIVE_OPERATION_FOOTPRINT
      + 1
  );
  const before = await readFile(rejected.filePath, 'utf8');
  await assert.rejects(rejected.repository.create({
    operationId: 'planning-capacity-rejected-create',
    expectedStoreRevision: DELIVERY_PLANNING_RUN_STORE_MAX_OPERATIONS
      - DELIVERY_PLANNING_RUN_MAX_ACTIVE_OPERATION_FOOTPRINT
      + 1,
    run: {
      id: 'planning-run-capacity-rejected-12345678',
      sourcePlan: sourcePlan('plan-capacity-rejected-12345678')
    }
  }), /delivery_planning_run_store_operation_reservation_unavailable/);
  assert.equal(await readFile(rejected.filePath, 'utf8'), before);
});

test('a validated adversarial 73-operation active history retains the four-operation safety margin', async (t) => {
  const runId = 'planning-run-adversarial-73-12345678';
  const store = validateDeliveryPlanningRunStore(syntheticTerminalStore(73, {
    id: runId,
    plan: sourcePlan('plan-adversarial-73-12345678'),
    terminal: false
  }));
  const before = deliveryPlanningRunStoreCapacity(store);
  assert.equal(before.operationCount, 73);
  assert.equal(before.reservedOperations, 4);
  assert.equal(
    before.operationCount + before.reservedOperations,
    DELIVERY_PLANNING_RUN_MAX_ACTIVE_OPERATION_FOOTPRINT
  );

  const seeded = await fixture(t, { name: 'adversarial-73.json' });
  await mkdir(path.dirname(seeded.filePath), { recursive: true, mode: 0o700 });
  await writeFile(seeded.filePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await seeded.repository.initialize();
  const closed = await seeded.repository.cancel(runId, {
    operationId: 'planning-adversarial-73-cancel',
    expectedStoreRevision: 73,
    expectedRunRevision: 73,
    operatorConfirmed: true,
    reason: 'The adversarial active history still retains its terminal cancel receipt.'
  });
  assert.equal(closed.storeRevision, 74);
  assert.equal(closed.run.condition, 'canceled');
});

test('exact pretty-JSON history reservation rejects a new Run before persisted-byte exhaustion', async (t) => {
  const paddedPlan = sourcePlan('plan-byte-reservation-history-12345678', {
    request: 'r'.repeat(4000),
    unresolvedQuestions: Array.from({ length: 12 }, (_, index) => (
      `Q${String(index).padStart(2, '0')}:${'x'.repeat(700)}`
    ))
  });
  const projectedActiveReservation = DELIVERY_PLANNING_RUN_STORE_CURRENT_RUN_SLOT_MAX_PERSISTED_BYTES
    + (DELIVERY_PLANNING_RUN_MAX_ACTIVE_OPERATION_FOOTPRINT
      * DELIVERY_PLANNING_RUN_STORE_OPERATION_SLOT_MAX_PERSISTED_BYTES);
  let operationCount = 430;
  let store = syntheticTerminalStore(operationCount, {
    id: 'planning-run-byte-reservation-history-12345678',
    plan: paddedPlan
  });
  while (
    persistedBytes(store) + projectedActiveReservation
      <= DELIVERY_PLANNING_RUN_STORE_MAX_PERSISTED_BYTES
    && operationCount + DELIVERY_PLANNING_RUN_MAX_ACTIVE_OPERATION_FOOTPRINT
      <= DELIVERY_PLANNING_RUN_STORE_MAX_OPERATIONS
  ) {
    operationCount += 5;
    store = syntheticTerminalStore(operationCount, {
      id: 'planning-run-byte-reservation-history-12345678',
      plan: paddedPlan
    });
  }
  assert.ok(
    operationCount + DELIVERY_PLANNING_RUN_MAX_ACTIVE_OPERATION_FOOTPRINT
      <= DELIVERY_PLANNING_RUN_STORE_MAX_OPERATIONS
  );
  assert.ok(persistedBytes(store) < DELIVERY_PLANNING_RUN_STORE_MAX_PERSISTED_BYTES);
  assert.ok(
    persistedBytes(store) + projectedActiveReservation
      > DELIVERY_PLANNING_RUN_STORE_MAX_PERSISTED_BYTES
  );
  store = validateDeliveryPlanningRunStore(store);

  const seeded = await fixture(t, { name: 'byte-reservation.json' });
  await mkdir(path.dirname(seeded.filePath), { recursive: true, mode: 0o700 });
  await writeFile(seeded.filePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await seeded.repository.initialize();
  const before = await readFile(seeded.filePath, 'utf8');
  await assert.rejects(seeded.repository.create({
    operationId: 'planning-byte-reservation-create',
    expectedStoreRevision: store.revision,
    run: {
      id: 'planning-run-byte-reservation-new-12345678',
      sourcePlan: sourcePlan('plan-byte-reservation-new-12345678')
    }
  }), /delivery_planning_run_store_byte_reservation_unavailable/);
  assert.equal(await readFile(seeded.filePath, 'utf8'), before);
});

test('four near-maximum valid reports fit the reserved active Run and store history', async (t) => {
  const { repository, filePath } = await fixture(t, { name: 'maximum-reports.json' });
  await repository.initialize();
  let current = await repository.create({
    operationId: 'planning-maximum-reports-create', expectedStoreRevision: 0,
    run: {
      id: 'planning-run-maximum-reports-12345678',
      sourcePlan: sourcePlan('plan-maximum-reports-12345678')
    }
  });
  const runId = current.run.id;
  async function mutate(method, operationId, fields) {
    current = await repository[method](runId, {
      operationId,
      expectedStoreRevision: current.storeRevision,
      expectedRunRevision: current.run.revision,
      ...fields
    });
  }
  function maximumReport(role, attemptId) {
    let accepted = null;
    for (let padding = 0; padding <= 780; padding += 1) {
      const candidate = roleReport(current.run, role, attemptId).report;
      candidate.evidence = Array.from({ length: 40 }, (_, index) => ({
        summary: `E${String(index).padStart(2, '0')}:${'x'.repeat(padding)}`,
        trusted: false
      }));
      if (persistedBytes(candidate) <= PLANNING_ROLE_REPORT_MAX_PERSISTED_BYTES) accepted = candidate;
      else break;
    }
    assert.ok(persistedBytes(accepted) > PLANNING_ROLE_REPORT_MAX_PERSISTED_BYTES - 64);
    return { report: accepted, outputDigest: planningRoleReportOutputDigest(accepted) };
  }
  async function finish(role) {
    const attemptId = `planning-attempt-maximum-${role}-12345678`;
    const spawnLease = spawnLeaseBinding(current.run, role, attemptId);
    await mutate('claimRoleSpawn', `planning-maximum-${role}-spawn`, { role, attemptId, spawnLease });
    await mutate('bindRoleSpawnLease', `planning-maximum-${role}-lease-bind`, {
      role, attemptId,
      leaseId: spawnLease.leaseId,
      scopeUnit: spawnLease.scopeUnit,
      scopeDigest: spawnLease.scopeDigest,
      observed: observedPane(role, spawnLease)
    });
    await mutate('claimRoleDispatch', `planning-maximum-${role}-dispatch`, {
      role, attemptId, leaseId: spawnLease.leaseId, worker: worker(role, spawnLease),
      rolloutPath: `/srv/private/rollouts/maximum-${role}.jsonl`, rolloutStartOffset: 100,
      confirmationMarker: `[PaneFleet Planning Dispatch ${attemptId}]`, promptDigest: 'f'.repeat(64)
    });
    await mutate('markRoleDispatched', `planning-maximum-${role}-submitted`, { role, attemptId });
    await mutate('recordRoleReport', `planning-maximum-${role}-report`, {
      role, attemptId, ...maximumReport(role, attemptId)
    });
    await mutate('claimRoleCleanup', `planning-maximum-${role}-cleanup-claim`, {
      role, attemptId, claimId: `planning:maximum:${role}:cleanup`
    });
    await mutate('markRoleCleanupSent', `planning-maximum-${role}-cleanup-sent`, { role, attemptId });
    await mutate('markRoleCleanupComplete', `planning-maximum-${role}-cleanup-complete`, { role, attemptId });
  }
  await finish('po');
  await finish('ba');
  await finish('qa');
  await finish('dev');
  assert.equal(current.run.phase, 'synthesis');
  assert.ok(persistedBytes(current.run) <= DELIVERY_PLANNING_RUN_MAX_PERSISTED_BYTES);
  const durable = JSON.parse(await readFile(filePath, 'utf8'));
  const capacity = deliveryPlanningRunStoreCapacity(durable);
  assert.ok(
    capacity.persistedBytes + capacity.reservedPersistedBytes
      <= capacity.maximumPersistedBytes
  );
  assert.ok(capacity.operationCount + capacity.reservedOperations <= capacity.maximumOperations);

  await mutate('compileCandidate', 'planning-maximum-compile');
  const candidateDigest = current.run.candidate.digest;
  await mutate('claimApply', 'planning-maximum-apply-claim-op', {
    claimId: 'planning:maximum:apply:claim', candidateDigest
  });
  await mutate('markOffCourse', 'planning-maximum-apply-off-course', {
    reason: 'The exact baseline changed before a deterministic Plan receipt appeared.'
  });
  await assert.rejects(repository.cancel(runId, {
    operationId: 'planning-maximum-premature-cancel',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    operatorConfirmed: true,
    reason: 'A claimed apply cannot be canceled before exact reconciliation.'
  }), /delivery_planning_run_cleanup_required/);
  const abandonRequest = {
    operationId: 'planning-maximum-apply-abandon',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    claimId: 'planning:maximum:apply:claim',
    candidateDigest,
    observation: 'plan_receipt_absent',
    reason: 'The deterministic Plan update receipt is authoritatively absent.'
  };
  current = await repository.abandonApply(runId, abandonRequest);
  assert.equal(current.run.applyOutbox.state, 'abandoned');
  assert.equal(current.run.applyOutbox.observation, 'plan_receipt_absent');
  assert.equal((await repository.abandonApply(runId, abandonRequest)).replayed, true);
  await assert.rejects(repository.abandonApply(runId, {
    ...abandonRequest,
    reason: 'A changed replay must never reuse the durable authorization.'
  }), /delivery_planning_run_store_operation_conflict/);
  current = await repository.cancel(runId, {
    operationId: 'planning-maximum-apply-cancel',
    expectedStoreRevision: current.storeRevision,
    expectedRunRevision: current.run.revision,
    operatorConfirmed: true,
    reason: 'The operator closed the safely abandoned apply.'
  });
  assert.equal(current.run.phase, 'closed');
  assert.equal(current.run.condition, 'canceled');
});

test('an unchanged all-role result persists needs-input without an apply candidate across restart', async (t) => {
  const { repository, filePath } = await fixture(t, { name: 'unchanged-candidate.json' });
  await repository.initialize();
  let current = await repository.create({
    operationId: 'planning-unchanged-create', expectedStoreRevision: 0,
    run: {
      sourcePlan: sourcePlan('plan-unchanged-candidate-12345678', {
        roles: {
          po: artifact('po'),
          ba: artifact('ba'),
          dev: artifact('dev'),
          qa: artifact('qa')
        }
      })
    }
  });
  const runId = current.run.id;
  async function mutate(method, operationId, fields) {
    current = await repository[method](runId, {
      operationId,
      expectedStoreRevision: current.storeRevision,
      expectedRunRevision: current.run.revision,
      ...fields
    });
  }
  async function finish(role) {
    const attemptId = `planning-attempt-unchanged-${role}-12345678`;
    const spawnLease = spawnLeaseBinding(current.run, role, attemptId);
    await mutate('claimRoleSpawn', `planning-unchanged-${role}-spawn`, {
      role, attemptId, spawnLease
    });
    await mutate('bindRoleSpawnLease', `planning-unchanged-${role}-bind`, {
      role, attemptId, leaseId: spawnLease.leaseId,
      scopeUnit: spawnLease.scopeUnit, scopeDigest: spawnLease.scopeDigest,
      observed: observedPane(role, spawnLease)
    });
    await mutate('claimRoleDispatch', `planning-unchanged-${role}-dispatch`, {
      role, attemptId, leaseId: spawnLease.leaseId, worker: worker(role, spawnLease),
      rolloutPath: `/srv/private/rollouts/unchanged-${role}.jsonl`, rolloutStartOffset: 0,
      confirmationMarker: `[PaneFleet Planning Dispatch ${attemptId}]`, promptDigest: '7'.repeat(64)
    });
    await mutate('markRoleDispatched', `planning-unchanged-${role}-submitted`, { role, attemptId });
    await mutate('recordRoleReport', `planning-unchanged-${role}-report`, {
      role, attemptId, ...roleReport(current.run, role, attemptId)
    });
    await mutate('claimRoleCleanup', `planning-unchanged-${role}-cleanup-claim`, {
      role, attemptId, claimId: `planning:unchanged:${role}:cleanup`
    });
    await mutate('markRoleCleanupSent', `planning-unchanged-${role}-cleanup-sent`, { role, attemptId });
    await mutate('markRoleCleanupComplete', `planning-unchanged-${role}-cleanup-complete`, { role, attemptId });
  }
  await finish('po');
  await finish('ba');
  await finish('qa');
  await finish('dev');
  assert.equal(current.storeRevision, 33);
  assert.equal(current.run.phase, 'challenge');
  assert.equal(current.run.condition, 'needs_input');
  assert.equal(current.run.candidate, null);
  assert.equal(current.run.applyOutbox.state, 'held');
  assert.equal(current.run.synthesisBlocker.code, 'delivery_planning_run_candidate_unchanged');
  await assert.rejects(repository.claimApply(runId, {
    operationId: 'planning-unchanged-apply-forbidden',
    expectedStoreRevision: current.storeRevision, expectedRunRevision: current.run.revision,
    claimId: 'planning:unchanged:apply:0001', candidateDigest: '0'.repeat(64)
  }), /delivery_planning_run_candidate_not_applyable/);
  const restarted = createDeliveryPlanningRunRepository({ filePath });
  assert.deepEqual(await restarted.get(runId), current.run);

  const tampered = JSON.parse(await readFile(filePath, 'utf8'));
  const run = tampered.runs[0];
  const definitionPatch = {
    roles: {
      po: structuredClone(run.roles.po.report.artifact),
      ba: structuredClone(run.roles.ba.report.artifact),
      dev: structuredClone(run.roles.dev.report.artifact),
      qa: structuredClone(run.roles.qa.report.artifact)
    },
    unresolvedQuestions: []
  };
  const roleOutputDigests = Object.fromEntries(
    ['po', 'ba', 'qa', 'dev'].map((role) => [role, run.roles[role].outputDigest])
  );
  Object.assign(run, {
    phase: 'review',
    condition: 'active',
    blocker: '',
    synthesisBlocker: null,
    candidate: {
      definitionPatch,
      digest: canonicalSha256({
        version: 1,
        runId: run.id,
        planId: run.planId,
        planRevision: run.planRevision,
        planDigest: run.planDigest,
        definitionPatch,
        roleOutputDigests
      }),
      previewPlanDigest: run.planDigest,
      readiness: lintDeliveryPlanReadiness(run.sourcePlan),
      challenges: [],
      roleOutputDigests,
      compiledAt: AT
    }
  });
  tampered.operations.at(-1).result.run = structuredClone(run);
  assert.throws(
    () => validateDeliveryPlanningRunStore(tampered),
    /delivery_planning_run_store_run_invalid/
  );
});

test('tampered current state or history is rejected on restart and never rewritten', async (t) => {
  const { filePath, repository } = await fixture(t);
  await repository.initialize();
  await repository.create({
    operationId: 'planning-store-tamper-source',
    expectedStoreRevision: 0,
    run: { sourcePlan: sourcePlan('plan-tamper-source-12345678') }
  });
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  persisted.runs[0].planDigest = 'f'.repeat(64);
  await writeFile(filePath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
  const before = await readFile(filePath, 'utf8');
  await assert.rejects(
    createDeliveryPlanningRunRepository({ filePath }).initialize(),
    /delivery_planning_run_store_run_invalid/
  );
  assert.equal(await readFile(filePath, 'utf8'), before);

  const historyTampered = structuredClone(persisted);
  historyTampered.runs[0] = structuredClone(historyTampered.operations[0].result.run);
  historyTampered.operations[0].result.storeRevision = 2;
  await writeFile(filePath, `${JSON.stringify(historyTampered)}\n`, { mode: 0o600 });
  await assert.rejects(
    createDeliveryPlanningRunRepository({ filePath }).initialize(),
    /delivery_planning_run_store_operation_revision_invalid/
  );
});

test('strict validator rejects duplicate bindings and tampered operation histories', async (t) => {
  const { filePath, repository } = await fixture(t);
  await repository.initialize();
  const created = await repository.create({
    operationId: 'planning-history-create',
    expectedStoreRevision: 0,
    run: { sourcePlan: sourcePlan('plan-history-source-12345678') }
  });
  const historyAttemptId = 'planning-attempt-history-po-12345678';
  await repository.claimRoleSpawn(created.run.id, {
    operationId: 'planning-history-spawn',
    expectedStoreRevision: 1,
    expectedRunRevision: 1,
    role: 'po',
    attemptId: historyAttemptId,
    spawnLease: spawnLeaseBinding(created.run, 'po', historyAttemptId)
  });
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.throws(() => validateDeliveryPlanningRunStore({
    ...persisted,
    revision: -1
  }), /store_revision_invalid/);
  assert.throws(() => validateDeliveryPlanningRunStore({
    ...persisted,
    revision: 1
  }), /store_revision_invalid/);

  const duplicateRun = structuredClone(persisted.operations[0].result.run);
  duplicateRun.id = 'planning-run-duplicate-binding-12345678';
  duplicateRun.inputDigest = canonicalSha256({
    id: duplicateRun.id,
    planId: duplicateRun.planId,
    planRevision: duplicateRun.planRevision,
    planDigest: duplicateRun.planDigest,
    workspace: duplicateRun.workspace,
    baseline: duplicateRun.baseline,
    sourcePlan: duplicateRun.sourcePlan
  });
  assert.throws(() => validateDeliveryPlanningRunStore({
    ...persisted,
    runs: [persisted.runs[0], duplicateRun]
  }), /store_plan_binding_duplicate/);

  const duplicateOperation = structuredClone(persisted);
  duplicateOperation.revision = 3;
  duplicateOperation.operations.push(structuredClone(duplicateOperation.operations[1]));
  assert.throws(
    () => validateDeliveryPlanningRunStore(duplicateOperation),
    /store_operation_duplicate/
  );

  const unknownRun = structuredClone(persisted);
  const otherRun = createDeliveryPlanningRun({
    id: 'planning-run-history-other-12345678',
    sourcePlan: sourcePlan('plan-history-other-12345678')
  }, { at: AT });
  unknownRun.operations[0].result.run = otherRun;
  assert.throws(
    () => validateDeliveryPlanningRunStore(unknownRun),
    /store_operation_run_unknown/
  );

  const duplicateCreate = structuredClone(persisted);
  duplicateCreate.operations[1].action = 'planning_run.create';
  assert.throws(
    () => validateDeliveryPlanningRunStore(duplicateCreate),
    /store_operation_lifecycle_invalid/
  );

  const regressed = structuredClone(persisted);
  regressed.operations[0].at = '2026-08-16T13:00:00.000Z';
  assert.throws(
    () => validateDeliveryPlanningRunStore(regressed),
    /store_operation_chronology_invalid/
  );

  const incomplete = structuredClone(persisted);
  incomplete.runs.push(otherRun);
  assert.throws(
    () => validateDeliveryPlanningRunStore(incomplete),
    /store_history_incomplete/
  );

  const mismatchedCurrent = structuredClone(persisted);
  mismatchedCurrent.runs[0] = structuredClone(mismatchedCurrent.operations[0].result.run);
  assert.throws(
    () => validateDeliveryPlanningRunStore(mismatchedCurrent),
    /store_current_run_mismatch/
  );
});

test('repository rejects invalid contracts, stale run revisions, missing runs, and regressed clocks', async (t) => {
  const { filePath, repository } = await fixture(t);
  await repository.initialize();
  await assert.rejects(repository.create(null), /store_create_request_invalid/);
  await assert.rejects(repository.create({
    operationId: 'short',
    expectedStoreRevision: 0,
    run: { sourcePlan: sourcePlan('plan-invalid-op-12345678') }
  }), /store_operation_id_invalid/);
  await assert.rejects(repository.create({
    operationId: 'planning-invalid-revision',
    expectedStoreRevision: -1,
    run: { sourcePlan: sourcePlan('plan-invalid-revision-12345678') }
  }), /expected_store_revision_invalid/);
  await assert.rejects(repository.create({
    operationId: 'planning-invalid-canonical-request',
    expectedStoreRevision: 0,
    run: { sourcePlan: sourcePlan('plan-invalid-canonical-12345678'), value: 1n }
  }), /store_request_invalid/);

  const created = await repository.create({
    operationId: 'planning-contract-create',
    expectedStoreRevision: 0,
    run: { sourcePlan: sourcePlan('plan-contract-source-12345678') }
  });
  await assert.rejects(repository.create({
    operationId: 'planning-contract-duplicate-id',
    expectedStoreRevision: 1,
    run: { sourcePlan: sourcePlan('plan-contract-other-12345678') }
  }), /store_run_duplicate/);
  await assert.rejects(repository.create({
    operationId: 'planning-contract-invalid-domain',
    expectedStoreRevision: 1,
    run: {
      id: 'planning-run-invalid-domain-12345678',
      sourcePlan: sourcePlan('plan-invalid-domain-12345678', { phase: 'draft' })
    }
  }), /delivery_planning_run_source_plan_phase_invalid/);
  await assert.rejects(
    repository.claimRoleSpawn(created.run.id, null),
    /store_mutation_request_invalid/
  );
  await assert.rejects(repository.claimRoleSpawn(created.run.id, {
    operationId: 'planning-contract-malformed-mutation',
    expectedStoreRevision: 1,
    expectedRunRevision: 1,
    role: 'po'
  }), /store_mutation_request_invalid/);
  await assert.rejects(repository.claimRoleSpawn('planning-run-missing-12345678', {
    operationId: 'planning-contract-missing-run',
    expectedStoreRevision: 1,
    expectedRunRevision: 1,
    role: 'po',
    attemptId: 'planning-attempt-missing-run-12345678',
    spawnLease: {}
  }), /store_run_not_found/);
  await assert.rejects(repository.claimRoleSpawn(created.run.id, {
    operationId: 'planning-contract-stale-run',
    expectedStoreRevision: 1,
    expectedRunRevision: 99,
    role: 'po',
    attemptId: 'planning-attempt-stale-run-12345678',
    spawnLease: {}
  }), /store_run_revision_conflict/);
  await assert.rejects(repository.get('unsafe'), /store_run_id_invalid/);
  await assert.rejects(
    repository.get(created.run.id, { includeHistory: 'yes' }),
    /store_history_option_invalid/
  );
  assert.equal(await repository.get('planning-run-absent-12345678'), null);

  assert.throws(() => createDeliveryPlanningRunRepository({ filePath: 'relative.json' }), /absolute/);
  assert.throws(() => createDeliveryPlanningRunRepository({ filePath: '/' }), /dedicated parent/);
  assert.throws(() => createDeliveryPlanningRunRepository({ filePath, now: null }), /now must/);
  assert.throws(() => createDeliveryPlanningRunRepository({ filePath, idFactory: null }), /idFactory must/);
  assert.throws(() => createDeliveryPlanningRunRepository({ filePath, writeAtomic: null }), /writeAtomic must/);

  const regressed = await fixture(t, {
    name: 'regressed.json',
    times: [AT, '2026-08-16T11:59:59.000Z']
  });
  await regressed.repository.initialize();
  const regressedCreate = await regressed.repository.create({
    operationId: 'planning-regressed-create',
    expectedStoreRevision: 0,
    run: { sourcePlan: sourcePlan('plan-regressed-store-12345678') }
  });
  await assert.rejects(regressed.repository.claimRoleSpawn(regressedCreate.run.id, {
    operationId: 'planning-regressed-spawn',
    expectedStoreRevision: 1,
    expectedRunRevision: 1,
    role: 'po',
    attemptId: 'planning-attempt-regressed-12345678',
    spawnLease: {}
  }), /store_clock_regressed/);
});

test('oversize on-disk stores are rejected before reading JSON', async (t) => {
  const { filePath, repository } = await fixture(t, { name: 'oversize-file.json' });
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, '', { mode: 0o600 });
  await truncate(filePath, 32 * 1024 * 1024 + 1);
  await assert.rejects(repository.initialize(), /delivery_planning_run_store_too_large/);
});

test('startup rejects malformed JSON, symlink stores, hardlinks, and insecure modes', async (t) => {
  const malformed = await fixture(t, { name: 'malformed.json' });
  await mkdir(path.dirname(malformed.filePath), { recursive: true, mode: 0o700 });
  await writeFile(malformed.filePath, '{broken', { mode: 0o600 });
  await assert.rejects(malformed.repository.initialize(), /store_json_invalid/);

  const symlinked = await fixture(t, { name: 'symlink.json' });
  await mkdir(path.dirname(symlinked.filePath), { recursive: true, mode: 0o700 });
  const target = path.join(symlinked.root, 'target.json');
  await writeFile(target, JSON.stringify(emptyDeliveryPlanningRunStore()), { mode: 0o600 });
  await symlink(target, symlinked.filePath);
  await assert.rejects(symlinked.repository.initialize(), /store_symlink_rejected/);

  const hardlinked = await fixture(t, { name: 'hardlink.json' });
  await mkdir(path.dirname(hardlinked.filePath), { recursive: true, mode: 0o700 });
  const hardlinkTarget = path.join(hardlinked.root, 'hardlink-target.json');
  await writeFile(hardlinkTarget, JSON.stringify(emptyDeliveryPlanningRunStore()), { mode: 0o600 });
  await link(hardlinkTarget, hardlinked.filePath);
  await assert.rejects(hardlinked.repository.initialize(), /store_file_invalid/);

  const insecure = await fixture(t, { name: 'insecure.json' });
  await mkdir(path.dirname(insecure.filePath), { recursive: true, mode: 0o700 });
  await writeFile(insecure.filePath, JSON.stringify(emptyDeliveryPlanningRunStore()), { mode: 0o644 });
  await chmod(insecure.filePath, 0o644);
  await assert.rejects(insecure.repository.initialize(), /store_permissions_insecure/);
});

test('pre-rename failure leaves the last durable store readable', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panefleet-planning-store-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'private', 'runs.json');
  let writes = 0;
  const baseWriter = createJsonAtomicWriter();
  const repository = createDeliveryPlanningRunRepository({
    filePath,
    now: () => AT,
    writeAtomic: async (...args) => {
      writes += 1;
      if (writes === 2) throw new Error('simulated_pre_rename_failure');
      return baseWriter(...args);
    }
  });
  await repository.initialize();
  await assert.rejects(
    repository.create({
      operationId: 'planning-store-pre-rename-failure',
      expectedStoreRevision: 0,
      run: { sourcePlan: sourcePlan('plan-pre-rename-12345678') }
    }),
    /simulated_pre_rename_failure/
  );
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), emptyDeliveryPlanningRunStore());
  const details = await lstat(filePath);
  assert.equal(details.isSymbolicLink(), false);
  assert.equal(details.nlink, 1);
});

test('post-rename sync failure reloads the committed Planning Run', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panefleet-planning-post-rename-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'private', 'runs.json');
  let syncCount = 0;
  const writeAtomic = createJsonAtomicWriter({
    syncDirectory: async () => {
      syncCount += 1;
      if (syncCount === 2) {
        throw Object.assign(new Error('synthetic directory sync failure'), { code: 'EIO' });
      }
    }
  });
  const repository = createDeliveryPlanningRunRepository({
    filePath,
    now: () => AT,
    idFactory: () => 'planning-run-post-rename-12345678',
    writeAtomic
  });
  await repository.initialize();
  const request = {
    operationId: 'planning-store-post-rename-create',
    expectedStoreRevision: 0,
    run: { sourcePlan: sourcePlan('plan-post-rename-12345678') }
  };
  await assert.rejects(
    repository.create(request),
    (error) => error.code === 'durable_json_post_rename_sync_failed'
      && error.replacementCommitted === true
  );
  assert.equal((await repository.list()).revision, 1);
  assert.equal((await repository.create(request)).replayed, true);
  await assert.rejects(repository.create({
    operationId: 'planning-store-post-rename-stale',
    expectedStoreRevision: 0,
    run: { sourcePlan: sourcePlan('plan-post-rename-stale-12345678') }
  }), /revision_conflict/);
  assert.equal((await createDeliveryPlanningRunRepository({ filePath }).initialize()).revision, 1);
});

test('post-rename mismatch poisons the repository instead of overwriting disk again', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panefleet-planning-post-rename-mismatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'private', 'runs.json');
  let syncCount = 0;
  const writeAtomic = createJsonAtomicWriter({
    syncDirectory: async (target) => {
      syncCount += 1;
      if (syncCount === 2) {
        await writeFile(target, `${JSON.stringify(emptyDeliveryPlanningRunStore())}\n`, { mode: 0o600 });
        throw Object.assign(new Error('synthetic competing replacement'), { code: 'EIO' });
      }
    }
  });
  const repository = createDeliveryPlanningRunRepository({
    filePath,
    now: () => AT,
    idFactory: () => 'planning-run-post-mismatch-12345678',
    writeAtomic
  });
  await repository.initialize();
  const request = {
    operationId: 'planning-store-post-mismatch-create',
    expectedStoreRevision: 0,
    run: { sourcePlan: sourcePlan('plan-post-mismatch-12345678') }
  };
  await assert.rejects(repository.create(request), /store_persistence_uncertain/);
  await assert.rejects(repository.list(), /store_persistence_uncertain/);
  await assert.rejects(repository.create(request), /store_persistence_uncertain/);
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), emptyDeliveryPlanningRunStore());
});
