import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { deliveryPlanDigest, normalizeDeliveryPlan } from '../delivery-plan.js';
import {
  createDeliveryPlanRepository,
  deliveryPlanStoreSummary,
  emptyDeliveryPlanStore,
  validateDeliveryPlanStore
} from '../delivery-plan-store.js';
import { createJsonAtomicWriter } from '../durable-json.js';

const BASE_AT = '2026-08-16T10:00:00.000Z';

function planInput(id = 'plan-store-12345678', overrides = {}) {
  return normalizeDeliveryPlan({
    id,
    revision: 1,
    phase: 'planning',
    title: 'Review work before implementation',
    request: 'Create a durable delivery contract before any project mutation.',
    workspace: '/srv/example',
    baseline: {
      head: '960ceac898a5',
      workingTreeDigest: 'a'.repeat(64),
      instructionsDigest: 'b'.repeat(64),
      capturedAt: BASE_AT
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
        user: 'Operator',
        problem: 'Unstructured work can leave requirements implicit.',
        outcome: 'Review one complete plan before implementation.',
        value: 'Reduce scope drift and unverifiable completion.',
        nonGoals: ['Do not deploy or send terminal input.'],
        assumptions: [],
        openQuestions: []
      },
      ba: {
        requirements: [{ id: 'REQ-001', text: 'Persist the reviewed plan safely.' }],
        dependencies: [],
        edgeCases: ['The response to a successful write is lost.'],
        constraints: ['No terminal input.'],
        openQuestions: []
      },
      dev: {
        architecture: 'Use a separate owner-only atomic JSON store.',
        steps: [{
          id: 'STEP-001',
          title: 'Persist a plan',
          outcome: 'The plan survives restart.',
          requirementIds: ['REQ-001'],
          scopePaths: ['delivery-plan-store.js'],
          checks: ['node --test test/delivery-plan-store.test.js']
        }],
        risks: ['A retry could duplicate a mutation.'],
        rollback: 'Remove the isolated store before runtime activation.',
        openQuestions: []
      },
      qa: {
        acceptanceCriteria: [{
          id: 'AC-001',
          text: 'The same operation ID produces exactly one stored mutation.',
          requirementIds: ['REQ-001']
        }],
        testStrategy: 'Exercise persistence, conflicts, corruption, permissions, and restart.',
        regressionChecks: ['Existing terminal queues remain untouched.'],
        releaseRequired: false,
        releaseChecks: [],
        openQuestions: []
      }
    },
    unresolvedQuestions: [],
    authority: {
      workspaceWrite: false,
      commit: false,
      push: false,
      deploy: false,
      network: false,
      serviceControl: false,
      destructive: false,
      externalMessages: false
    },
    createdAt: BASE_AT,
    updatedAt: BASE_AT,
    ...overrides
  }, { at: BASE_AT });
}

async function temporaryRepository(t, { times, name = 'delivery-plans.json' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panefleet-delivery-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'private', name);
  let index = 0;
  const clock = times || [BASE_AT];
  const repository = createDeliveryPlanRepository({
    filePath,
    now: () => clock[Math.min(index++, clock.length - 1)],
    idFactory: () => 'plan-generated-12345678'
  });
  return { root, filePath, repository };
}

test('empty store is strict and summary contains only bounded review metadata', () => {
  const empty = emptyDeliveryPlanStore();
  assert.deepEqual(validateDeliveryPlanStore(empty), empty);
  assert.deepEqual(deliveryPlanStoreSummary(empty), {
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
  assert.throws(() => validateDeliveryPlanStore({ ...empty, extra: true }), /delivery_plan_store_shape_invalid/);
  assert.throws(() => validateDeliveryPlanStore({ ...empty, version: 2 }), /delivery_plan_store_version_unsupported/);
  assert.throws(() => deliveryPlanStoreSummary(empty, { activeLimit: -1 }), /active_limit_invalid/);
  assert.throws(() => deliveryPlanStoreSummary(empty, { recentLimit: 129 }), /recent_limit_invalid/);
});

test('initialization creates a private atomic store and generated plan ID', async (t) => {
  const { filePath, repository } = await temporaryRepository(t);
  assert.deepEqual((await repository.initialize()).counts.total, 0);
  const [directoryDetails, fileDetails] = await Promise.all([
    stat(path.dirname(filePath)),
    stat(filePath)
  ]);
  assert.equal(directoryDetails.mode & 0o777, 0o700);
  assert.equal(fileDetails.mode & 0o777, 0o600);
  assert.equal(fileDetails.isFile(), true);
  assert.equal(fileDetails.nlink, 1);

  const input = planInput('', { id: '' });
  const created = await repository.create({
    operationId: 'operation-create-generated',
    expectedStoreRevision: 0,
    plan: input
  });
  assert.equal(created.plan.id, 'plan-generated-12345678');
  assert.equal(created.plan.revision, 1);
  assert.equal(created.storeRevision, 1);
  assert.equal(created.replayed, false);
});

test('create, update, transitions, history, replay, and restart remain exact', async (t) => {
  const times = [
    BASE_AT,
    '2026-08-16T10:01:00.000Z',
    '2026-08-16T10:02:00.000Z',
    '2026-08-16T10:03:00.000Z'
  ];
  const { filePath, repository } = await temporaryRepository(t, { times });
  await repository.initialize();
  const createRequest = {
    operationId: 'operation-create-exact',
    expectedStoreRevision: 0,
    plan: planInput()
  };
  const created = await repository.create(createRequest);
  assert.equal(created.storeRevision, 1);
  assert.equal((await repository.get(created.plan.id)).title, created.plan.title);

  const replay = await repository.create(createRequest);
  assert.equal(replay.replayed, true);
  assert.equal(replay.storeRevision, 1);
  assert.deepEqual(replay.plan, created.plan);
  await assert.rejects(
    repository.create({ ...createRequest, plan: { ...createRequest.plan, title: 'Changed request' } }),
    /delivery_plan_store_operation_conflict/
  );

  const updated = await repository.update(created.plan.id, {
    operationId: 'operation-update-exact',
    expectedStoreRevision: 1,
    expectedPlanRevision: 1,
    patch: { title: 'Review every nontrivial change before implementation' }
  });
  assert.equal(updated.storeRevision, 2);
  assert.equal(updated.plan.revision, 2);
  assert.equal(updated.plan.title, 'Review every nontrivial change before implementation');
  const ready = await repository.transition(created.plan.id, {
    operationId: 'operation-ready-exact',
    expectedStoreRevision: 2,
    expectedPlanRevision: 2,
    to: 'ready_for_approval',
    conditions: {}
  });
  assert.equal(ready.plan.phase, 'ready_for_approval');
  const approved = await repository.transition(created.plan.id, {
    operationId: 'operation-approve-exact',
    expectedStoreRevision: 3,
    expectedPlanRevision: 3,
    to: 'approved',
    conditions: { confirmation: 'approve-plan' }
  });
  assert.equal(approved.plan.phase, 'approved');
  assert.equal(approved.plan.approval.digest.length, 64);

  const detail = await repository.get(created.plan.id, { includeHistory: true });
  assert.equal(detail.plan.revision, 4);
  assert.deepEqual(detail.history.map((entry) => entry.plan.revision), [1, 2, 3, 4]);
  assert.equal((await repository.list()).active[0].digest, approved.plan.approval.digest);
  assert.equal('workspace' in (await repository.list()).active[0], false);

  const restarted = createDeliveryPlanRepository({ filePath, now: () => times.at(-1) });
  const restartSummary = await restarted.initialize();
  assert.equal(restartSummary.revision, 4);
  assert.equal((await restarted.get(created.plan.id)).phase, 'approved');
  const stored = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(stored.operations.length, 4);
  assert.deepEqual(stored.operations.map((operation) => operation.result.plan.revision), [1, 2, 3, 4]);
});

test('optimistic conflicts, invalid requests, create lifecycle bypass, and clock regression fail closed', async (t) => {
  const { repository } = await temporaryRepository(t, {
    times: [BASE_AT, BASE_AT, '2026-08-16T09:59:00.000Z']
  });
  await repository.initialize();
  const plan = planInput();
  await assert.rejects(repository.create({ operationId: 'short', expectedStoreRevision: 0, plan }), /operation_id_invalid/);
  await assert.rejects(repository.create({ operationId: 'operation-no-revision', plan }), /expected_store_revision_invalid/);
  await assert.rejects(repository.create({
    operationId: 'operation-phase-bypass',
    expectedStoreRevision: 0,
    plan: { ...plan, phase: 'ready_for_approval' }
  }), /create_phase_invalid|phase_not_ready/);
  const created = await repository.create({
    operationId: 'operation-create-conflicts',
    expectedStoreRevision: 0,
    plan
  });
  await assert.rejects(repository.update(created.plan.id, {
    operationId: 'operation-stale-store',
    expectedStoreRevision: 0,
    expectedPlanRevision: 1,
    patch: { title: 'Stale' }
  }), /revision_conflict/);
  await assert.rejects(repository.update(created.plan.id, {
    operationId: 'operation-stale-plan',
    expectedStoreRevision: 1,
    expectedPlanRevision: 2,
    patch: { title: 'Stale' }
  }), /plan_revision_conflict/);
  await assert.rejects(repository.update('plan-missing-12345678', {
    operationId: 'operation-plan-missing',
    expectedStoreRevision: 1,
    expectedPlanRevision: 1,
    patch: { title: 'Missing' }
  }), /plan_not_found/);
  await assert.rejects(repository.update(created.plan.id, {
    operationId: 'operation-clock-regress',
    expectedStoreRevision: 1,
    expectedPlanRevision: 1,
    patch: { title: 'Clock moved backward' }
  }), /clock_regressed|timestamp_invalid/);
  assert.throws(() => repository.get('unsafe'), /plan_id_invalid/);
  await assert.rejects(repository.get(created.plan.id, { includeHistory: 'yes' }), /history_option_invalid/);
});

test('post-rename sync failure reloads the committed plan before any later mutation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panefleet-plan-post-rename-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'private', 'delivery-plans.json');
  let syncCount = 0;
  const writeAtomic = createJsonAtomicWriter({
    syncDirectory: async () => {
      syncCount += 1;
      if (syncCount === 2) {
        throw Object.assign(new Error('synthetic directory sync failure'), { code: 'EIO' });
      }
    }
  });
  const repository = createDeliveryPlanRepository({ filePath, now: () => BASE_AT, writeAtomic });
  await repository.initialize();
  const request = {
    operationId: 'operation-post-rename-create',
    expectedStoreRevision: 0,
    plan: planInput('plan-post-rename-12345678')
  };

  await assert.rejects(
    repository.create(request),
    (error) => error.code === 'durable_json_post_rename_sync_failed' && error.replacementCommitted === true
  );
  assert.equal((await repository.list()).revision, 1);
  assert.equal((await repository.create(request)).replayed, true);
  await assert.rejects(repository.create({
    operationId: 'operation-post-rename-stale',
    expectedStoreRevision: 0,
    plan: planInput('plan-post-rename-stale-12345678')
  }), /revision_conflict/);
  const continued = await repository.update('plan-post-rename-12345678', {
    operationId: 'operation-post-rename-continue',
    expectedStoreRevision: 1,
    expectedPlanRevision: 1,
    patch: { title: 'Continue only from the reloaded committed revision' }
  });
  assert.equal(continued.storeRevision, 2);
  assert.equal((await createDeliveryPlanRepository({ filePath }).initialize()).revision, 2);
});

test('post-rename mismatch poisons the plan repository instead of overwriting disk', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panefleet-plan-post-rename-mismatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'private', 'delivery-plans.json');
  let syncCount = 0;
  const writeAtomic = createJsonAtomicWriter({
    syncDirectory: async (target) => {
      syncCount += 1;
      if (syncCount === 2) {
        await writeFile(target, `${JSON.stringify(emptyDeliveryPlanStore())}\n`, { mode: 0o600 });
        throw Object.assign(new Error('synthetic competing replacement'), { code: 'EIO' });
      }
    }
  });
  const repository = createDeliveryPlanRepository({ filePath, now: () => BASE_AT, writeAtomic });
  await repository.initialize();
  const request = {
    operationId: 'operation-post-rename-poison',
    expectedStoreRevision: 0,
    plan: planInput('plan-post-rename-poison-12345678')
  };
  await assert.rejects(repository.create(request), /delivery_plan_store_persistence_uncertain/);
  await assert.rejects(repository.list(), /delivery_plan_store_persistence_uncertain/);
  await assert.rejects(repository.create(request), /delivery_plan_store_persistence_uncertain/);
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), emptyDeliveryPlanStore());
});

test('malformed, unsupported, insecure, and symlink stores are never overwritten', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panefleet-delivery-corrupt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'private');
  await mkdir(directory, { recursive: true, mode: 0o700 });

  for (const [name, contents, expected] of [
    ['malformed.json', '{not json\n', /delivery_plan_store_json_invalid/],
    ['unsupported.json', JSON.stringify({ version: 2, revision: 0, plans: [], operations: [] }), /version_unsupported/]
  ]) {
    const filePath = path.join(directory, name);
    await writeFile(filePath, contents, { mode: 0o600 });
    const before = await readFile(filePath, 'utf8');
    const repository = createDeliveryPlanRepository({ filePath });
    await assert.rejects(repository.initialize(), expected);
    assert.equal(await readFile(filePath, 'utf8'), before);
  }

  const insecurePath = path.join(directory, 'insecure.json');
  const emptyText = `${JSON.stringify(emptyDeliveryPlanStore())}\n`;
  await writeFile(insecurePath, emptyText, { mode: 0o600 });
  await chmod(insecurePath, 0o644);
  await assert.rejects(
    createDeliveryPlanRepository({ filePath: insecurePath }).initialize(),
    /permissions_insecure/
  );
  assert.equal(await readFile(insecurePath, 'utf8'), emptyText);

  const target = path.join(directory, 'target.json');
  const linked = path.join(directory, 'linked.json');
  await writeFile(target, emptyText, { mode: 0o600 });
  await symlink(target, linked);
  await assert.rejects(
    createDeliveryPlanRepository({ filePath: linked }).initialize(),
    /symlink_rejected/
  );
  assert.equal((await lstat(linked)).isSymbolicLink(), true);
  assert.equal(await readFile(target, 'utf8'), emptyText);
});

test('persisted history tampering and duplicate identities fail validation', async (t) => {
  const { filePath, repository } = await temporaryRepository(t);
  await repository.initialize();
  const created = await repository.create({
    operationId: 'operation-create-tamper',
    expectedStoreRevision: 0,
    plan: planInput()
  });
  const stored = JSON.parse(await readFile(filePath, 'utf8'));
  assert.throws(
    () => validateDeliveryPlanStore({ ...stored, plans: [...stored.plans, stored.plans[0]] }),
    /plan_duplicate/
  );
  assert.throws(
    () => validateDeliveryPlanStore({
      ...stored,
      operations: [...stored.operations, stored.operations[0]],
      revision: 2
    }),
    /operation_duplicate|operation_revision_invalid/
  );
  const changedCurrent = structuredClone(stored);
  changedCurrent.plans[0].title = 'Tampered current plan';
  assert.throws(() => validateDeliveryPlanStore(changedCurrent), /current_plan_mismatch/);
  const changedHistory = structuredClone(stored);
  changedHistory.operations[0].result.plan.id = 'plan-unknown-12345678';
  assert.throws(() => validateDeliveryPlanStore(changedHistory), /operation_plan_unknown/);
  assert.equal(created.plan.id, stored.plans[0].id);
});

test('constructor and request shape validation reject unsafe repository use', async () => {
  assert.throws(() => createDeliveryPlanRepository(), /filePath must be absolute/);
  assert.throws(() => createDeliveryPlanRepository({ filePath: '/delivery-plans.json' }), /dedicated parent/);
  assert.throws(() => createDeliveryPlanRepository({ filePath: '/tmp/x.json', now: null }), /now must be a function/);
  assert.throws(() => createDeliveryPlanRepository({ filePath: '/tmp/x.json', idFactory: null }), /idFactory must be a function/);
  assert.throws(() => createDeliveryPlanRepository({ filePath: '/tmp/x.json', writeAtomic: null }), /writeAtomic must be a function/);
});

test('invalid plan, request, approval, gate, blocker, and duplicate creation fail closed', async (t) => {
  const { repository } = await temporaryRepository(t, {
    times: Array(10).fill(BASE_AT)
  });
  await repository.initialize();
  const base = planInput();
  await assert.rejects(repository.create(null), /create_request_invalid/);
  await assert.rejects(repository.create({
    operationId: 'operation-create-invalid-plan',
    expectedStoreRevision: 0,
    plan: { ...base, title: '' }
  }), /plan_invalid/);
  const approvedInput = {
    ...base,
    approval: { digest: deliveryPlanDigest(base), approvedAt: BASE_AT, planRevision: 1 }
  };
  await assert.rejects(repository.create({
    operationId: 'operation-create-approved',
    expectedStoreRevision: 0,
    plan: approvedInput
  }), /create_approval_invalid/);
  await assert.rejects(repository.create({
    operationId: 'operation-create-gated',
    expectedStoreRevision: 0,
    plan: { ...base, gates: { ...base.gates, implementationCaptured: true } }
  }), /create_gates_invalid/);
  await assert.rejects(repository.create({
    operationId: 'operation-create-blocked',
    expectedStoreRevision: 0,
    plan: { ...base, blocker: 'Injected blocker' }
  }), /create_blocker_invalid/);
  const created = await repository.create({
    operationId: 'operation-create-valid-one',
    expectedStoreRevision: 0,
    plan: base
  });
  await assert.rejects(repository.create({
    operationId: 'operation-create-duplicate',
    expectedStoreRevision: 1,
    plan: base
  }), /plan_duplicate/);
  assert.equal((await repository.list()).revision, created.storeRevision);
});

test('update and transition request failures are typed and do not consume a store revision', async (t) => {
  const { repository } = await temporaryRepository(t, {
    times: Array(8).fill(BASE_AT)
  });
  await repository.initialize();
  const created = await repository.create({
    operationId: 'operation-create-request-errors',
    expectedStoreRevision: 0,
    plan: planInput()
  });
  await assert.rejects(repository.update(created.plan.id, null), /update_request_invalid/);
  await assert.rejects(repository.update(created.plan.id, {
    operationId: 'operation-update-bad-revision',
    expectedStoreRevision: 1,
    expectedPlanRevision: 0,
    patch: {}
  }), /expected_plan_revision_invalid/);
  const circular = {};
  circular.self = circular;
  await assert.rejects(repository.update(created.plan.id, {
    operationId: 'operation-update-circular',
    expectedStoreRevision: 1,
    expectedPlanRevision: 1,
    patch: circular
  }), /request_invalid/);
  await assert.rejects(repository.update(created.plan.id, {
    operationId: 'operation-update-too-large',
    expectedStoreRevision: 1,
    expectedPlanRevision: 1,
    patch: { title: 'x'.repeat(1024 * 1024 + 1) }
  }), /request_too_large/);
  await assert.rejects(repository.update(created.plan.id, {
    operationId: 'operation-update-domain-error',
    expectedStoreRevision: 1,
    expectedPlanRevision: 1,
    patch: { roles: [] }
  }), /roles_patch_invalid/);
  await assert.rejects(repository.transition(created.plan.id, { conditions: [] }), /transition_request_invalid/);
  await assert.rejects(repository.transition(created.plan.id, {
    operationId: 'operation-transition-mismatch',
    expectedStoreRevision: 1,
    expectedPlanRevision: 1,
    to: 'ready_for_approval',
    conditions: { expectedRevision: 2 }
  }), /expected_plan_revision_conflict/);
  await assert.rejects(repository.transition('plan-missing-87654321', {
    operationId: 'operation-transition-missing',
    expectedStoreRevision: 1,
    expectedPlanRevision: 1,
    to: 'planning',
    conditions: {}
  }), /plan_not_found/);
  await assert.rejects(repository.transition(created.plan.id, {
    operationId: 'operation-transition-illegal',
    expectedStoreRevision: 1,
    expectedPlanRevision: 1,
    to: 'done',
    conditions: {}
  }), /transition_invalid/);
  assert.equal((await repository.list()).revision, 1);
});

test('store validator rejects malformed plans, operations, chronology, and incomplete history', () => {
  const plan = planInput();
  const requestDigest = 'c'.repeat(64);
  const operation = {
    id: 'operation-validator-one',
    action: 'plan.create',
    requestDigest,
    at: BASE_AT,
    result: { storeRevision: 1, plan }
  };
  const valid = { version: 1, revision: 1, plans: [plan], operations: [operation] };
  assert.deepEqual(validateDeliveryPlanStore(valid).plans[0], plan);
  for (const [mutate, expected] of [
    [(value) => { value.revision = -1; }, /revision_invalid/],
    [(value) => { value.plans = null; }, /plans_invalid/],
    [(value) => { value.operations = null; }, /operations_invalid/],
    [(value) => { value.revision = 2; }, /revision_invalid/],
    [(value) => { value.plans[0].extra = true; }, /plan_invalid/],
    [(value) => { value.operations[0].extra = true; }, /operation_invalid/],
    [(value) => { value.operations[0].id = 'bad'; }, /operation_invalid/],
    [(value) => { value.operations[0].action = 'plan.delete'; }, /operation_invalid/],
    [(value) => { value.operations[0].requestDigest = 'bad'; }, /operation_invalid/],
    [(value) => { value.operations[0].at = 'bad'; }, /operation_invalid/],
    [(value) => { value.operations[0].result = { plan }; }, /operation_result_invalid/],
    [(value) => { value.operations[0].result.storeRevision = 2; }, /operation_revision_invalid/],
    [(value) => { value.operations[0].result.plan = {}; }, /operation_plan_invalid/],
    [(value) => { value.operations = []; value.revision = 0; }, /history_incomplete/]
  ]) {
    const candidate = structuredClone(valid);
    mutate(candidate);
    assert.throws(() => validateDeliveryPlanStore(candidate), expected);
  }

  const second = structuredClone(operation);
  second.id = 'operation-validator-two';
  second.action = 'plan.update';
  second.at = '2026-08-16T09:59:00.000Z';
  second.result.storeRevision = 2;
  assert.throws(() => validateDeliveryPlanStore({
    version: 1,
    revision: 2,
    plans: [plan],
    operations: [operation, second]
  }), /operation_chronology_invalid/);
});

test('private loader normalizes owner-only mode and rejects hard links and invalid clocks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panefleet-delivery-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'private');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(directory, 'delivery-plans.json');
  await writeFile(filePath, `${JSON.stringify(emptyDeliveryPlanStore())}\n`, { mode: 0o400 });
  await createDeliveryPlanRepository({ filePath }).initialize();
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);

  const hardLink = path.join(directory, 'delivery-plans-hardlink.json');
  await link(filePath, hardLink);
  await assert.rejects(
    createDeliveryPlanRepository({ filePath: hardLink }).initialize(),
    /file_invalid/
  );

  const invalidClockPath = path.join(root, 'clock', 'delivery-plans.json');
  const repository = createDeliveryPlanRepository({ filePath: invalidClockPath, now: () => 'not-a-time' });
  await repository.initialize();
  await assert.rejects(repository.create({
    operationId: 'operation-invalid-clock',
    expectedStoreRevision: 0,
    plan: planInput()
  }), /now_invalid/);

  const dateClockPath = path.join(root, 'date-clock', 'delivery-plans.json');
  const dateRepository = createDeliveryPlanRepository({ filePath: dateClockPath, now: () => new Date(BASE_AT) });
  await dateRepository.initialize();
  assert.equal((await dateRepository.create({
    operationId: 'operation-date-clock',
    expectedStoreRevision: 0,
    plan: planInput('plan-date-clock-12345678')
  })).plan.createdAt, BASE_AT);

  const defaultPath = path.join(root, 'defaults', 'delivery-plans.json');
  const defaultRepository = createDeliveryPlanRepository({ filePath: defaultPath });
  await defaultRepository.initialize();
  const generated = await defaultRepository.create({
    operationId: 'operation-default-factories',
    expectedStoreRevision: 0,
    plan: planInput('', { id: '' })
  });
  assert.match(generated.plan.id, /^plan-[a-f0-9]{24}$/);
  await defaultRepository.create({
    operationId: 'operation-default-sort',
    expectedStoreRevision: 1,
    plan: planInput('plan-default-sort-12345678')
  });
  assert.equal((await defaultRepository.list()).active.length, 2);
});

test('operation capacity preserves exact replay and fails closed without pruning history', async (t) => {
  const { filePath, repository } = await temporaryRepository(t);
  await repository.initialize();
  const createRequest = {
    operationId: 'operation-capacity-create',
    expectedStoreRevision: 0,
    plan: planInput('plan-capacity-12345678')
  };
  await repository.create(createRequest);
  const saturated = JSON.parse(await readFile(filePath, 'utf8'));
  const snapshot = saturated.plans[0];
  for (let index = 1; index < 1024; index += 1) {
    saturated.operations.push({
      id: `operation-capacity-${String(index).padStart(4, '0')}`,
      action: 'plan.update',
      requestDigest: index.toString(16).padStart(64, '0'),
      at: BASE_AT,
      result: { storeRevision: index + 1, plan: structuredClone(snapshot) }
    });
  }
  saturated.revision = saturated.operations.length;
  validateDeliveryPlanStore(saturated);
  await writeFile(filePath, `${JSON.stringify(saturated)}\n`, { mode: 0o600 });

  const restored = createDeliveryPlanRepository({ filePath, now: () => BASE_AT });
  assert.equal((await restored.initialize()).counts.operations, 1024);
  assert.equal((await restored.create(createRequest)).replayed, true);
  const before = await readFile(filePath, 'utf8');
  await assert.rejects(restored.update(snapshot.id, {
    operationId: 'operation-capacity-overflow',
    expectedStoreRevision: 1024,
    expectedPlanRevision: snapshot.revision,
    patch: { title: 'This mutation must not replace durable history.' }
  }), /delivery_plan_store_operation_limit_reached/);
  assert.equal(await readFile(filePath, 'utf8'), before);
});
