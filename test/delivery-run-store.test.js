import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalSha256 } from '../delivery-plan.js';
import {
  createDeliveryRunRepository,
  deliveryRunStoreSummary,
  emptyDeliveryRunStore,
  validateDeliveryRunStore
} from '../delivery-run-store.js';
import { createJsonAtomicWriter } from '../durable-json.js';

const AT = '2026-08-16T10:00:00.000Z';

function baselineInput(at = AT, marker = 'b') {
  const entries = [{
    status: ' M',
    path: 'panefleet-run-store/src/example.js',
    originalPath: '',
    type: 'file',
    size: 12,
    sha256: marker.repeat(64)
  }];
  const instructions = [{ path: 'AGENTS.md', size: 20, sha256: 'c'.repeat(64) }];
  const baseline = {
    version: 2,
    workspace: '/srv/panefleet-run-store',
    repoRoot: '/srv',
    workspacePrefix: 'panefleet-run-store',
    head: 'a'.repeat(40),
    branch: 'main',
    detached: false,
    statusDigest: canonicalSha256(entries.map((entry) => ({
      status: entry.status,
      path: entry.path,
      originalPath: entry.originalPath
    }))),
    indexDigest: '9'.repeat(64),
    indexFlagsDigest: '8'.repeat(64),
    gitMetadata: {
      repoRoot: '/srv',
      gitDir: '/srv/.git',
      commonDir: '/srv/.git',
      objectFormat: 'sha1',
      headRef: 'refs/heads/main',
      sparseCheckout: false,
      sparseIndex: false
    },
    approvedScopes: ['src/step-1.js'],
    entries,
    instructions,
    capturedAt: at
  };
  baseline.gitMetadataDigest = canonicalSha256(baseline.gitMetadata);
  baseline.workingTreeDigest = canonicalSha256({
    statusDigest: baseline.statusDigest,
    indexDigest: baseline.indexDigest,
    indexFlagsDigest: baseline.indexFlagsDigest,
    gitMetadataDigest: baseline.gitMetadataDigest,
    entries
  });
  baseline.ignoredScopeDigest = canonicalSha256({
    approvedScopes: baseline.approvedScopes,
    outputDigest: createHash('sha256').update('', 'utf8').digest('hex')
  });
  baseline.instructionsDigest = canonicalSha256(instructions);
  baseline.manifestDigest = canonicalSha256({
    version: baseline.version,
    workspace: baseline.workspace,
    repoRoot: baseline.repoRoot,
    workspacePrefix: baseline.workspacePrefix,
    head: baseline.head,
    branch: baseline.branch,
    detached: baseline.detached,
    statusDigest: baseline.statusDigest,
    indexDigest: baseline.indexDigest,
    indexFlagsDigest: baseline.indexFlagsDigest,
    gitMetadata: baseline.gitMetadata,
    gitMetadataDigest: baseline.gitMetadataDigest,
    approvedScopes: baseline.approvedScopes,
    ignoredScopeDigest: baseline.ignoredScopeDigest,
    entries,
    instructions
  });
  return baseline;
}

function taskInput(index = 1) {
  return {
    stepId: `STEP-00${index}`,
    stepDigest: String(index).repeat(64),
    acceptanceIds: [`AC-00${index}`],
    allowedPaths: [`src/step-${index}.js`],
    missionDefinitionDigest: (index + 2).toString().repeat(64)
  };
}

function runInput(overrides = {}) {
  return {
    id: '',
    planId: 'plan-store-run-12345678',
    planRevision: 7,
    planDigest: 'd'.repeat(64),
    workspace: '/srv/panefleet-run-store',
    startBaseline: baselineInput(),
    tasks: [taskInput(1)],
    ...overrides
  };
}

function evidence(id, at, overrides = {}) {
  return {
    id,
    type: 'diff',
    producer: 'PaneFleet scope guard',
    outcome: 'applied',
    summary: 'A bounded local-source fingerprint was recorded.',
    contentRef: '',
    contentSha256: '',
    createdAt: at,
    ...overrides
  };
}

function abortEvidence(id, at = AT, overrides = {}) {
  return evidence(id, at, {
    type: 'review',
    producer: 'PaneFleet operator',
    outcome: 'applied',
    summary: 'The operator explicitly confirmed permanent Run termination.',
    ...overrides
  });
}

async function fixture(t, { times, fileName = 'delivery-runs.json' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panefleet-delivery-run-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'private', fileName);
  const clock = times || [AT];
  let index = 0;
  const repository = createDeliveryRunRepository({
    filePath,
    now: () => clock[Math.min(index++, clock.length - 1)],
    idFactory: () => 'run-generated-12345678'
  });
  return { root, filePath, repository };
}

test('empty store is exact and exposes only bounded run summaries', () => {
  const empty = emptyDeliveryRunStore();
  assert.deepEqual(validateDeliveryRunStore(empty), empty);
  assert.deepEqual(deliveryRunStoreSummary(empty), {
    version: 1,
    revision: 0,
    counts: { total: 0, active: 0, verified: 0, aborted: 0, needsAttention: 0, operations: 0 },
    active: [],
    recent: []
  });
  assert.throws(() => validateDeliveryRunStore({ ...empty, extra: true }), /shape_invalid/);
  assert.throws(() => validateDeliveryRunStore({ ...empty, version: 2 }), /version_unsupported/);
  assert.throws(() => deliveryRunStoreSummary(empty, { activeLimit: -1 }), /active_limit_invalid/);
  assert.throws(() => deliveryRunStoreSummary(empty, { recentLimit: 65 }), /recent_limit_invalid/);
});

test('initialization creates one owner-only atomic file and generated run identity', async (t) => {
  const { filePath, repository } = await fixture(t);
  assert.equal((await repository.initialize()).counts.total, 0);
  const [directoryDetails, fileDetails] = await Promise.all([stat(path.dirname(filePath)), stat(filePath)]);
  assert.equal(directoryDetails.mode & 0o777, 0o700);
  assert.equal(fileDetails.mode & 0o777, 0o600);
  assert.equal(fileDetails.nlink, 1);
  const created = await repository.create({
    operationId: 'run-create-generated-operation',
    expectedStoreRevision: 0,
    run: runInput()
  });
  assert.equal(created.run.id, 'run-generated-12345678');
  assert.equal(created.run.revision, 1);
  assert.equal(created.storeRevision, 1);
});

test('default identifiers, clock, and bounded summary ordering work without injected callbacks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panefleet-delivery-run-defaults-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = createDeliveryRunRepository({ filePath: path.join(root, 'private', 'runs.json') });
  await repository.initialize();
  const first = await repository.create({
    operationId: 'run-create-default-first',
    expectedStoreRevision: 0,
    run: runInput()
  });
  const second = await repository.create({
    operationId: 'run-create-default-second',
    expectedStoreRevision: 1,
    run: runInput({
      planId: 'plan-default-second-12345678',
      planDigest: 'e'.repeat(64)
    })
  });
  assert.match(first.run.id, /^run-[a-f0-9]{24}$/);
  assert.match(second.run.id, /^run-[a-f0-9]{24}$/);
  assert.notEqual(first.run.id, second.run.id);
  assert.equal((await repository.list()).active.length, 2);
});

test('create, mission link, implementation capture, verification, replay, history, and restart are exact', async (t) => {
  const times = [
    AT,
    '2026-08-16T10:01:00.000Z',
    '2026-08-16T10:02:00.000Z',
    '2026-08-16T10:03:00.000Z'
  ];
  const { filePath, repository } = await fixture(t, { times });
  await repository.initialize();
  const createRequest = {
    operationId: 'run-create-complete-operation',
    expectedStoreRevision: 0,
    run: runInput()
  };
  const created = await repository.create(createRequest);
  const replayedCreate = await repository.create(createRequest);
  assert.equal(replayedCreate.replayed, true);
  assert.deepEqual(replayedCreate.run, created.run);
  const task = created.run.tasks[0];
  const linkRequest = {
    operationId: 'run-link-complete-operation',
    expectedStoreRevision: 1,
    expectedRunRevision: 1,
    stepId: task.stepId,
    bindingKey: task.missionBindingKey,
    missionId: 'mission-run-store-12345678'
  };
  const linked = await repository.linkMission(created.run.id, linkRequest);
  assert.equal(linked.run.tasks[0].state, 'mission_linked');
  assert.equal((await repository.linkMission(created.run.id, linkRequest)).replayed, true);

  const after = baselineInput('2026-08-16T10:02:00.000Z', 'e');
  const captureRequest = {
    operationId: 'run-capture-complete-operation',
    expectedStoreRevision: 2,
    expectedRunRevision: 2,
    stepId: task.stepId,
    missionId: linkRequest.missionId,
    baseline: after,
    evidence: [evidence('EVD-STORE-DIFF-001', after.capturedAt)]
  };
  const captured = await repository.captureImplementation(created.run.id, captureRequest);
  assert.equal(captured.run.delivery.level, 'implemented_locally');

  const verificationRequest = {
    operationId: 'run-verify-complete-operation',
    expectedStoreRevision: 3,
    expectedRunRevision: 3,
    stepId: task.stepId,
    missionId: linkRequest.missionId,
    baseline: after,
    criteria: [{ acceptanceId: 'AC-001', outcome: 'passed', evidenceIds: ['EVD-STORE-DIFF-001'] }],
    evidence: [evidence('EVD-STORE-REVIEW-001', '2026-08-16T10:03:00.000Z', {
      type: 'review',
      outcome: 'passed'
    })],
    evidenceIds: ['EVD-STORE-DIFF-001', 'EVD-STORE-REVIEW-001'],
    note: 'The operator independently verified the linked criterion.'
  };
  const verified = await repository.recordVerification(created.run.id, verificationRequest);
  assert.equal(verified.run.condition, 'verified');
  assert.equal(verified.run.delivery.level, 'verified_locally');
  assert.match(verified.run.verificationRecords[0].id, /^verification-[a-f0-9]{32}$/);
  const replayedVerification = await repository.recordVerification(created.run.id, verificationRequest);
  assert.equal(replayedVerification.replayed, true);
  assert.equal(replayedVerification.run.verificationRecords[0].id, verified.run.verificationRecords[0].id);

  const detail = await repository.get(created.run.id, { includeHistory: true });
  assert.equal(detail.history.length, 4);
  assert.deepEqual(detail.history.map((entry) => entry.action), [
    'run.create',
    'run.mission_link',
    'run.implementation_capture',
    'run.verification_record'
  ]);
  assert.equal((await repository.list()).counts.verified, 1);

  const restored = createDeliveryRunRepository({ filePath });
  assert.equal((await restored.initialize()).counts.verified, 1);
  assert.deepEqual(await restored.get(created.run.id), verified.run);
});

test('uncertain mission intent and authoritative relink are durable named mutations', async (t) => {
  const times = [AT, '2026-08-16T10:01:00.000Z', '2026-08-16T10:02:00.000Z'];
  const { repository } = await fixture(t, { times });
  await repository.initialize();
  const created = await repository.create({
    operationId: 'run-create-reconcile-operation',
    expectedStoreRevision: 0,
    run: runInput()
  });
  const task = created.run.tasks[0];
  const uncertain = await repository.markMissionEnsureReconcileRequired(created.run.id, {
    operationId: 'run-mark-reconcile-operation',
    expectedStoreRevision: 1,
    expectedRunRevision: 1,
    stepId: task.stepId,
    bindingKey: task.missionBindingKey,
    error: 'Mission write outcome is unknown.'
  });
  assert.equal(uncertain.run.condition, 'reconcile_required');
  const linked = await repository.linkMission(created.run.id, {
    operationId: 'run-link-recovered-operation',
    expectedStoreRevision: 2,
    expectedRunRevision: 2,
    stepId: task.stepId,
    bindingKey: task.missionBindingKey,
    missionId: 'mission-authoritative-12345678'
  });
  assert.equal(linked.run.condition, 'active');
  assert.equal(linked.run.tasks[0].missionId, 'mission-authoritative-12345678');
});

test('off-course mutation preserves evidence, summary attention, and any existing mission link', async (t) => {
  const times = [AT, '2026-08-16T10:01:00.000Z', '2026-08-16T10:02:00.000Z'];
  const { repository } = await fixture(t, { times });
  await repository.initialize();
  const created = await repository.create({
    operationId: 'run-create-offcourse-operation',
    expectedStoreRevision: 0,
    run: runInput()
  });
  const task = created.run.tasks[0];
  const linked = await repository.linkMission(created.run.id, {
    operationId: 'run-link-offcourse-operation',
    expectedStoreRevision: 1,
    expectedRunRevision: 1,
    stepId: task.stepId,
    bindingKey: task.missionBindingKey,
    missionId: 'mission-offcourse-store-12345678'
  });
  const offCourse = await repository.markOffCourse(created.run.id, {
    operationId: 'run-mark-offcourse-operation',
    expectedStoreRevision: 2,
    expectedRunRevision: linked.run.revision,
    stepId: task.stepId,
    reason: 'An unapproved path changed.',
    evidence: [evidence('EVD-STORE-OFFCOURSE', '2026-08-16T10:02:00.000Z', { outcome: 'failed' })]
  });
  assert.equal(offCourse.run.condition, 'off_course');
  assert.equal(offCourse.run.tasks[0].missionId, 'mission-offcourse-store-12345678');
  const summary = await repository.list();
  assert.equal(summary.counts.needsAttention, 1);
  assert.equal(summary.active[0].deliveryLevel, 'planned');
});

test('operator abort is durable, idempotent, terminal in summaries, and exact across restart', async (t) => {
  const abortedAt = '2026-08-16T10:01:00.000Z';
  const { filePath, repository } = await fixture(t, { times: [AT, abortedAt] });
  await repository.initialize();
  const created = await repository.create({
    operationId: 'run-create-abort-operation',
    expectedStoreRevision: 0,
    run: runInput({ tasks: [taskInput(1), taskInput(2)] })
  });
  const abortRequest = {
    operationId: 'run-abort-terminal-operation',
    expectedStoreRevision: 1,
    expectedRunRevision: 1,
    operatorConfirmed: true,
    reason: 'The operator intentionally ended this local Delivery Run.',
    evidence: [abortEvidence('EVD-STORE-ABORT-REVIEW', '2000-01-01T00:00:00.000Z')]
  };

  const aborted = await repository.abort(created.run.id, abortRequest);
  assert.equal(aborted.replayed, false);
  assert.equal(aborted.storeRevision, 2);
  assert.equal(aborted.run.revision, 2);
  assert.equal(aborted.run.condition, 'aborted');
  assert.deepEqual(aborted.run.tasks.map((task) => task.state), ['aborted', 'aborted']);
  assert.deepEqual(aborted.run.outbox.map((item) => item.state), ['canceled', 'canceled']);
  assert.equal(aborted.run.abort.fromCondition, 'preparing');
  assert.equal(aborted.run.abort.abortedAt, abortedAt);
  assert.deepEqual(aborted.run.abort.evidenceIds, ['EVD-STORE-ABORT-REVIEW']);
  assert.equal(aborted.run.evidenceIndex.at(-1).createdAt, abortedAt);

  const replay = await repository.abort(created.run.id, abortRequest);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.run, aborted.run);
  await assert.rejects(repository.abort(created.run.id, {
    ...abortRequest,
    reason: 'Changing the same operation identifier must conflict.'
  }), /operation_conflict/);
  await assert.rejects(repository.abort(created.run.id, {
    ...abortRequest,
    operationId: 'run-abort-stale-store-operation',
    expectedStoreRevision: 1
  }), /revision_conflict/);
  await assert.rejects(repository.abort(created.run.id, {
    ...abortRequest,
    operationId: 'run-abort-second-operation',
    expectedStoreRevision: 2,
    expectedRunRevision: 2,
    evidence: [abortEvidence('EVD-STORE-ABORT-AGAIN', abortedAt)]
  }), /abort_state_invalid/);
  await assert.rejects(repository.linkMission(created.run.id, {
    operationId: 'run-link-after-abort-operation',
    expectedStoreRevision: 2,
    expectedRunRevision: 2,
    stepId: aborted.run.tasks[0].stepId,
    bindingKey: aborted.run.tasks[0].missionBindingKey,
    missionId: 'mission-after-abort-12345678'
  }), /mission_link_state_invalid/);

  assert.deepEqual(await repository.list(), {
    version: 1,
    revision: 2,
    counts: { total: 1, active: 0, verified: 0, aborted: 1, needsAttention: 0, operations: 2 },
    active: [],
    recent: [{
      id: aborted.run.id,
      revision: 2,
      planId: aborted.run.planId,
      planDigest: aborted.run.planDigest,
      condition: 'aborted',
      deliveryLevel: 'planned',
      taskCount: 2,
      completedTaskCount: 0,
      updatedAt: abortedAt
    }]
  });
  const history = await repository.get(created.run.id, { includeHistory: true });
  assert.deepEqual(history.history.map((entry) => entry.action), ['run.create', 'run.abort']);

  const stored = JSON.parse(await readFile(filePath, 'utf8'));
  const mislabeledAbort = structuredClone(stored);
  mislabeledAbort.operations[1].action = 'run.off_course';
  assert.throws(() => validateDeliveryRunStore(mislabeledAbort), /operation_lifecycle_invalid/);
  const wrongPriorCondition = structuredClone(stored);
  wrongPriorCondition.operations[1].result.run.abort.fromCondition = 'active';
  wrongPriorCondition.runs[0].abort.fromCondition = 'active';
  assert.throws(() => validateDeliveryRunStore(wrongPriorCondition), /operation_lifecycle_invalid/);
  const wrongAbortOperationTime = structuredClone(stored);
  wrongAbortOperationTime.operations[1].at = AT;
  assert.throws(() => validateDeliveryRunStore(wrongAbortOperationTime), /operation_lifecycle_invalid/);
  const postAbortMutation = structuredClone(stored);
  const postAbortRun = structuredClone(postAbortMutation.runs[0]);
  postAbortRun.revision += 1;
  postAbortMutation.revision += 1;
  postAbortMutation.operations.push({
    id: 'run-post-abort-forged-operation',
    action: 'run.off_course',
    requestDigest: 'f'.repeat(64),
    at: abortedAt,
    result: { storeRevision: 3, run: postAbortRun }
  });
  postAbortMutation.runs[0] = postAbortRun;
  assert.throws(() => validateDeliveryRunStore(postAbortMutation), /operation_lifecycle_invalid/);

  const restored = createDeliveryRunRepository({ filePath });
  const restoredSummary = await restored.initialize();
  assert.equal(restoredSummary.counts.aborted, 1);
  assert.equal(restoredSummary.counts.active, 0);
  assert.deepEqual(await restored.get(created.run.id), aborted.run);
  const restoredReplay = await restored.abort(created.run.id, abortRequest);
  assert.equal(restoredReplay.replayed, true);
  assert.deepEqual(restoredReplay.run, aborted.run);
});

test('optimistic revisions, operation conflicts, immutable plan binding, and duplicate runs fail closed', async (t) => {
  const times = [AT, '2026-08-16T10:01:00.000Z'];
  const { repository } = await fixture(t, { times });
  await repository.initialize();
  const createRequest = {
    operationId: 'run-create-conflict-operation',
    expectedStoreRevision: 0,
    run: runInput()
  };
  const created = await repository.create(createRequest);
  await assert.rejects(
    repository.create({ ...createRequest, run: { ...createRequest.run, planRevision: 8 } }),
    /operation_conflict/
  );
  await assert.rejects(repository.create({
    operationId: 'run-create-stale-store-operation',
    expectedStoreRevision: 0,
    run: runInput({ id: 'run-stale-store-12345678', planId: 'plan-stale-store-12345678' })
  }), /revision_conflict/);
  await assert.rejects(repository.create({
    operationId: 'run-create-duplicate-binding',
    expectedStoreRevision: 1,
    run: runInput({ id: 'run-duplicate-bind-12345678' })
  }), /plan_binding_duplicate/);
  const task = created.run.tasks[0];
  await assert.rejects(repository.linkMission(created.run.id, {
    operationId: 'run-link-stale-run-operation',
    expectedStoreRevision: 1,
    expectedRunRevision: 2,
    stepId: task.stepId,
    bindingKey: task.missionBindingKey,
    missionId: 'mission-stale-run-12345678'
  }), /run_revision_conflict/);
  assert.equal((await repository.get(created.run.id)).revision, 1);
});

test('concurrent stale mutations serialize to one durable winner', async (t) => {
  const times = [AT, '2026-08-16T10:01:00.000Z', '2026-08-16T10:02:00.000Z'];
  const { repository } = await fixture(t, { times });
  await repository.initialize();
  const created = await repository.create({
    operationId: 'run-create-serialize-operation',
    expectedStoreRevision: 0,
    run: runInput()
  });
  const task = created.run.tasks[0];
  const request = (operationId, missionId) => repository.linkMission(created.run.id, {
    operationId,
    expectedStoreRevision: 1,
    expectedRunRevision: 1,
    stepId: task.stepId,
    bindingKey: task.missionBindingKey,
    missionId
  });
  const results = await Promise.allSettled([
    request('run-link-serialize-first', 'mission-serialize-first-12345678'),
    request('run-link-serialize-second', 'mission-serialize-second-12345678')
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /revision_conflict/);
  assert.equal((await repository.get(created.run.id)).revision, 2);
});

test('post-rename sync failure reloads the committed run before any later mutation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panefleet-run-post-rename-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'private', 'delivery-runs.json');
  let syncCount = 0;
  const writeAtomic = createJsonAtomicWriter({
    syncDirectory: async () => {
      syncCount += 1;
      if (syncCount === 2) {
        throw Object.assign(new Error('synthetic directory sync failure'), { code: 'EIO' });
      }
    }
  });
  const repository = createDeliveryRunRepository({
    filePath,
    now: () => AT,
    idFactory: () => 'run-post-rename-12345678',
    writeAtomic
  });
  await repository.initialize();
  const request = {
    operationId: 'run-post-rename-create',
    expectedStoreRevision: 0,
    run: runInput()
  };

  await assert.rejects(
    repository.create(request),
    (error) => error.code === 'durable_json_post_rename_sync_failed' && error.replacementCommitted === true
  );
  assert.equal((await repository.list()).revision, 1);
  const replay = await repository.create(request);
  assert.equal(replay.replayed, true);
  await assert.rejects(repository.create({
    operationId: 'run-post-rename-stale',
    expectedStoreRevision: 0,
    run: runInput({ planId: 'plan-post-rename-stale-12345678', planDigest: 'e'.repeat(64) })
  }), /revision_conflict/);
  const task = replay.run.tasks[0];
  const continued = await repository.linkMission(replay.run.id, {
    operationId: 'run-post-rename-continue',
    expectedStoreRevision: 1,
    expectedRunRevision: 1,
    stepId: task.stepId,
    bindingKey: task.missionBindingKey,
    missionId: 'mission-post-rename-12345678'
  });
  assert.equal(continued.storeRevision, 2);
  assert.equal((await createDeliveryRunRepository({ filePath }).initialize()).revision, 2);
});

test('post-rename mismatch poisons the run repository instead of overwriting disk', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panefleet-run-post-rename-mismatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'private', 'delivery-runs.json');
  let syncCount = 0;
  const writeAtomic = createJsonAtomicWriter({
    syncDirectory: async (target) => {
      syncCount += 1;
      if (syncCount === 2) {
        await writeFile(target, `${JSON.stringify(emptyDeliveryRunStore())}\n`, { mode: 0o600 });
        throw Object.assign(new Error('synthetic competing replacement'), { code: 'EIO' });
      }
    }
  });
  const repository = createDeliveryRunRepository({
    filePath,
    now: () => AT,
    idFactory: () => 'run-post-rename-poison-12345678',
    writeAtomic
  });
  await repository.initialize();
  const request = {
    operationId: 'run-post-rename-poison',
    expectedStoreRevision: 0,
    run: runInput()
  };
  await assert.rejects(repository.create(request), /delivery_run_store_persistence_uncertain/);
  await assert.rejects(repository.list(), /delivery_run_store_persistence_uncertain/);
  await assert.rejects(repository.create(request), /delivery_run_store_persistence_uncertain/);
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), emptyDeliveryRunStore());
});

test('malformed, insecure, symlinked, and hard-linked stores are never overwritten', async (t) => {
  const cases = [
    {
      name: 'malformed',
      prepare: async (filePath) => writeFile(filePath, '{"version":1', { mode: 0o600 }),
      pattern: /json_invalid/
    },
    {
      name: 'insecure',
      prepare: async (filePath) => {
        await writeFile(filePath, '{}', { mode: 0o600 });
        await chmod(filePath, 0o644);
      },
      pattern: /permissions_insecure/
    },
    {
      name: 'symlink',
      prepare: async (filePath, root) => {
        const target = path.join(root, 'target.json');
        await writeFile(target, JSON.stringify(emptyDeliveryRunStore()), { mode: 0o600 });
        await symlink(target, filePath);
      },
      pattern: /symlink_rejected/
    },
    {
      name: 'hardlink',
      prepare: async (filePath, root) => {
        const target = path.join(root, 'target.json');
        await writeFile(target, JSON.stringify(emptyDeliveryRunStore()), { mode: 0o600 });
        await link(target, filePath);
      },
      pattern: /file_invalid/
    }
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), `panefleet-run-${testCase.name}-`));
      t.after(() => rm(root, { recursive: true, force: true }));
      const directory = path.join(root, 'private');
      const filePath = path.join(directory, 'runs.json');
      await mkdir(directory, { mode: 0o700 });
      await testCase.prepare(filePath, root);
      const before = await lstat(filePath);
      const repository = createDeliveryRunRepository({ filePath });
      await assert.rejects(repository.initialize(), testCase.pattern);
      const after = await lstat(filePath);
      assert.equal(after.ino, before.ino);
    });
  }
});

test('secure owner-only mode is normalized and strict persisted history tampering is rejected', async (t) => {
  const { filePath, repository } = await fixture(t);
  await repository.initialize();
  await chmod(filePath, 0o400);
  const restored = createDeliveryRunRepository({ filePath });
  await restored.initialize();
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);

  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  parsed.revision = 1;
  parsed.operations = [{
    id: 'forged-operation-12345678',
    action: 'run.create',
    requestDigest: '0'.repeat(64),
    at: AT,
    result: { storeRevision: 1, run: {} }
  }];
  await writeFile(filePath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  const tampered = createDeliveryRunRepository({ filePath });
  await assert.rejects(tampered.initialize(), /operation_run_invalid/);
});

test('constructor and request shapes reject unsafe repository use without consuming revisions', async (t) => {
  assert.throws(() => createDeliveryRunRepository({ filePath: 'relative.json' }), /absolute/);
  assert.throws(() => createDeliveryRunRepository({ filePath: '/runs.json' }), /dedicated parent/);
  assert.throws(() => createDeliveryRunRepository({ filePath: '/tmp/runs.json', now: null }), /now must be a function/);
  assert.throws(() => createDeliveryRunRepository({ filePath: '/tmp/runs.json', idFactory: null }), /idFactory must be a function/);
  assert.throws(() => createDeliveryRunRepository({ filePath: '/tmp/runs.json', writeAtomic: null }), /writeAtomic must be a function/);
  const { repository } = await fixture(t);
  await repository.initialize();
  await assert.rejects(repository.create(null), /create_request_invalid/);
  await assert.rejects(repository.get('bad'), /run_id_invalid/);
  await assert.rejects(repository.get('run-valid-12345678', { includeHistory: 'yes' }), /history_option_invalid/);
  await assert.rejects(repository.linkMission('run-valid-12345678', null), /mutation_request_invalid/);
  await assert.rejects(repository.create({
    operationId: 'run-create-extra-field',
    expectedStoreRevision: 0,
    run: runInput(),
    extra: true
  }), /create_request_invalid/);
  const circularRun = runInput();
  circularRun.circular = circularRun;
  await assert.rejects(repository.create({
    operationId: 'run-create-circular-request',
    expectedStoreRevision: 0,
    run: circularRun
  }), /request_invalid/);
  await assert.rejects(repository.create({
    operationId: 'run-create-invalid-domain',
    expectedStoreRevision: 0,
    run: runInput({ workspace: 'relative' })
  }), /workspace_invalid/);
  assert.equal((await repository.list()).revision, 0);
});

test('strict mutation requests and domain failures do not consume durable revisions', async (t) => {
  const { repository } = await fixture(t);
  await repository.initialize();
  const created = await repository.create({
    operationId: 'run-create-strict-mutation',
    expectedStoreRevision: 0,
    run: runInput()
  });
  const task = created.run.tasks[0];
  const request = {
    operationId: 'run-link-strict-mutation',
    expectedStoreRevision: 1,
    expectedRunRevision: 1,
    stepId: task.stepId,
    bindingKey: task.missionBindingKey,
    missionId: 'mission-strict-mutation-12345678'
  };
  await assert.rejects(repository.linkMission(created.run.id, { ...request, extra: true }), /mutation_request_invalid/);
  await assert.rejects(repository.linkMission(created.run.id, {
    ...request,
    operationId: 'run-link-wrong-binding',
    bindingKey: '0'.repeat(64)
  }), /mission_binding_conflict/);
  await assert.rejects(repository.abort(created.run.id, {
    operationId: 'run-abort-extra-field',
    expectedStoreRevision: 1,
    expectedRunRevision: 1,
    operatorConfirmed: true,
    reason: 'This malformed request must not consume a revision.',
    evidence: [abortEvidence('EVD-STORE-ABORT-EXTRA')],
    extra: true
  }), /mutation_request_invalid/);
  await assert.rejects(repository.abort(created.run.id, {
    operationId: 'run-abort-confirmation-required',
    expectedStoreRevision: 1,
    expectedRunRevision: 1,
    operatorConfirmed: false,
    reason: 'This malformed request must not consume a revision.',
    evidence: [abortEvidence('EVD-STORE-ABORT-NOT-CONFIRMED')]
  }), /abort_confirmation_required/);
  await assert.rejects(repository.abort(created.run.id, {
    operationId: 'run-abort-evidence-required',
    expectedStoreRevision: 1,
    expectedRunRevision: 1,
    operatorConfirmed: true,
    reason: 'This malformed request must not consume a revision.',
    evidence: null
  }), /abort_evidence_required/);
  await assert.rejects(repository.create({
    operationId: 'run-create-duplicate-id',
    expectedStoreRevision: 1,
    run: runInput({
      id: created.run.id,
      planId: 'plan-duplicate-id-12345678',
      planDigest: 'e'.repeat(64)
    })
  }), /run_duplicate/);
  assert.equal((await repository.list()).revision, 1);
});

test('validator rejects duplicate identities, incomplete history, and changed immutable bindings', async (t) => {
  const times = [AT, '2026-08-16T10:01:00.000Z'];
  const { filePath, repository } = await fixture(t, { times });
  await repository.initialize();
  const created = await repository.create({
    operationId: 'run-create-validator-operation',
    expectedStoreRevision: 0,
    run: runInput()
  });
  const stored = JSON.parse(await readFile(filePath, 'utf8'));
  assert.throws(() => validateDeliveryRunStore({ ...stored, runs: [...stored.runs, stored.runs[0]] }), /run_duplicate/);
  assert.throws(() => validateDeliveryRunStore({ ...stored, operations: [] }), /revision_invalid/);
  const changed = structuredClone(stored);
  changed.runs[0].planDigest = 'f'.repeat(64);
  assert.throws(() => validateDeliveryRunStore(changed), /store_run_invalid/);
  assert.equal((await repository.get(created.run.id)).planDigest, 'd'.repeat(64));
});

test('validator rejects operation overflow, chronology regression, broken lifecycle, and stale current snapshots', async (t) => {
  const times = [AT, '2026-08-16T10:01:00.000Z'];
  const { filePath, repository } = await fixture(t, { times });
  await repository.initialize();
  const created = await repository.create({
    operationId: 'run-create-history-guards',
    expectedStoreRevision: 0,
    run: runInput()
  });
  const task = created.run.tasks[0];
  await repository.linkMission(created.run.id, {
    operationId: 'run-link-history-guards',
    expectedStoreRevision: 1,
    expectedRunRevision: 1,
    stepId: task.stepId,
    bindingKey: task.missionBindingKey,
    missionId: 'mission-history-guards-12345678'
  });
  const stored = JSON.parse(await readFile(filePath, 'utf8'));
  assert.throws(() => validateDeliveryRunStore({
    ...stored,
    operations: Array.from({ length: 513 }, () => stored.operations[0])
  }), /operations_invalid/);

  const regressed = structuredClone(stored);
  regressed.operations[1].at = '2026-08-16T09:59:00.000Z';
  assert.throws(() => validateDeliveryRunStore(regressed), /operation_chronology_invalid/);

  const brokenLifecycle = structuredClone(stored);
  brokenLifecycle.operations[1].result.run.revision = 1;
  assert.throws(() => validateDeliveryRunStore(brokenLifecycle), /operation_lifecycle_invalid/);

  const staleCurrent = structuredClone(stored);
  staleCurrent.runs[0].updatedAt = '2026-08-16T10:02:00.000Z';
  assert.throws(() => validateDeliveryRunStore(staleCurrent), /current_run_mismatch/);
});

test('operation capacity preserves exact replay and fails closed without pruning history', async (t) => {
  const { filePath, repository } = await fixture(t);
  await repository.initialize();
  const createRequest = {
    operationId: 'run-capacity-create',
    expectedStoreRevision: 0,
    run: runInput()
  };
  await repository.create(createRequest);
  const saturated = JSON.parse(await readFile(filePath, 'utf8'));
  const initial = saturated.runs[0];
  for (let index = 1; index < 512; index += 1) {
    const snapshot = structuredClone(initial);
    snapshot.revision = index + 1;
    saturated.operations.push({
      id: `run-capacity-${String(index).padStart(4, '0')}`,
      action: 'run.off_course',
      requestDigest: index.toString(16).padStart(64, '0'),
      at: AT,
      result: { storeRevision: index + 1, run: snapshot }
    });
    saturated.runs[0] = snapshot;
  }
  saturated.revision = saturated.operations.length;
  validateDeliveryRunStore(saturated);
  await writeFile(filePath, `${JSON.stringify(saturated)}\n`, { mode: 0o600 });

  const restored = createDeliveryRunRepository({ filePath, now: () => AT });
  assert.equal((await restored.initialize()).counts.operations, 512);
  assert.equal((await restored.create(createRequest)).replayed, true);
  const before = await readFile(filePath, 'utf8');
  const current = await restored.get(initial.id);
  await assert.rejects(restored.markOffCourse(initial.id, {
    operationId: 'run-capacity-overflow',
    expectedStoreRevision: 512,
    expectedRunRevision: current.revision,
    stepId: current.tasks[0].stepId,
    reason: 'This mutation must not replace durable history.',
    evidence: []
  }), /delivery_run_store_operation_limit_reached/);
  assert.equal(await readFile(filePath, 'utf8'), before);
});
