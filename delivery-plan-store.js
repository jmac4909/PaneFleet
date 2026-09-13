import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

import {
  canonicalJson,
  canonicalSha256,
  deliveryPlanDigest,
  lintDeliveryPlanReadiness,
  transitionDeliveryPlan,
  updateDeliveryPlanDefinition,
  validateDeliveryPlan
} from './delivery-plan.js';
import {
  atomicJsonReplacementCommitted,
  ensurePrivateDirectory,
  writeJsonAtomic
} from './durable-json.js';

export const DELIVERY_PLAN_STORE_VERSION = 1;

const MAX_PLANS = 128;
const MAX_OPERATIONS = 1024;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const MAX_PLAN_BYTES = 512 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_SUMMARY_ITEMS = 128;
const DEFAULT_ACTIVE_LIMIT = 50;
const DEFAULT_RECENT_LIMIT = 20;
const TERMINAL_PHASES = new Set(['done', 'canceled']);
const ACTIONS = new Set(['plan.create', 'plan.update', 'plan.transition']);
const PLAN_ID_PATTERN = /^plan-[a-z0-9][a-z0-9-]{7,63}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function storeError(code, detail = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, detail);
  return error;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, code) {
  if (!plainObject(value)) throw storeError(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw storeError(code);
  }
}

function validTimestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return typeof value === 'string'
    && value.length > 0
    && Number.isFinite(parsed)
    && value === new Date(parsed).toISOString();
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function clone(value) {
  return structuredClone(value);
}

function strictPlan(value, code = 'delivery_plan_store_plan_invalid') {
  let validated;
  try {
    validated = validateDeliveryPlan(value);
  } catch (cause) {
    throw storeError(code, { cause });
  }
  try {
    if (canonicalJson(value) !== canonicalJson(validated)) throw storeError(code);
  } catch (cause) {
    if (cause?.code === code) throw cause;
    throw storeError(code, { cause });
  }
  if (byteLength(validated) > MAX_PLAN_BYTES) throw storeError('delivery_plan_store_plan_too_large');
  return validated;
}

function planSummary(plan) {
  const readiness = lintDeliveryPlanReadiness(plan);
  return {
    id: plan.id,
    revision: plan.revision,
    phase: plan.phase,
    title: plan.title,
    digest: deliveryPlanDigest(plan),
    ready: readiness.ready,
    errorCount: readiness.errors.length,
    warningCount: readiness.warnings.length,
    updatedAt: plan.updatedAt,
  };
}

function normalizedLimit(value, fallback, field) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_SUMMARY_ITEMS) {
    throw storeError(`delivery_plan_store_${field}_invalid`);
  }
  return result;
}

function timestamp(value) {
  const candidate = value instanceof Date ? value.toISOString() : String(value ?? '');
  if (!validTimestamp(candidate)) throw storeError('delivery_plan_store_now_invalid');
  return candidate;
}

function requestedRevision(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw storeError(`delivery_plan_store_${field}_invalid`);
  }
  return value;
}

function requestedPlanRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw storeError('delivery_plan_store_expected_plan_revision_invalid');
  }
  return value;
}

function operationId(value) {
  const result = String(value ?? '').trim();
  if (!OPERATION_ID_PATTERN.test(result)) throw storeError('delivery_plan_store_operation_id_invalid');
  return result;
}

function planId(value) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!PLAN_ID_PATTERN.test(result)) throw storeError('delivery_plan_store_plan_id_invalid');
  return result;
}

function requestSnapshot(value) {
  let serialized;
  try {
    serialized = canonicalJson(value);
  } catch (cause) {
    throw storeError('delivery_plan_store_request_invalid', { cause });
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) {
    throw storeError('delivery_plan_store_request_too_large');
  }
  return {
    value: JSON.parse(serialized),
    digest: canonicalSha256(value)
  };
}

function replayResult(operation) {
  return { replayed: true, ...clone(operation.result) };
}

function newResult(storeRevision, plan) {
  return { storeRevision, plan: clone(plan) };
}

function assertCreateLifecycle(plan) {
  if (!['draft', 'planning'].includes(plan.phase)) {
    throw storeError('delivery_plan_store_create_phase_invalid');
  }
  if (plan.revision !== 1) throw storeError('delivery_plan_store_create_revision_invalid');
  if (plan.approval.digest || plan.approval.approvedAt !== null || plan.approval.planRevision !== null) {
    throw storeError('delivery_plan_store_create_approval_invalid');
  }
  if (Object.values(plan.gates).some(Boolean)) throw storeError('delivery_plan_store_create_gates_invalid');
  if (plan.blocker) throw storeError('delivery_plan_store_create_blocker_invalid');
}

function assertStoreRevision(store, expected) {
  if (store.revision !== expected) {
    throw storeError('delivery_plan_store_revision_conflict', {
      currentStoreRevision: store.revision,
      expectedStoreRevision: expected
    });
  }
}

function assertPlanRevision(plan, expected) {
  if (plan.revision !== expected) {
    throw storeError('delivery_plan_store_plan_revision_conflict', {
      planId: plan.id,
      currentPlanRevision: plan.revision,
      expectedPlanRevision: expected
    });
  }
}

function assertMutationCapacity(store, { createsPlan = false } = {}) {
  if (store.operations.length >= MAX_OPERATIONS) {
    throw storeError('delivery_plan_store_operation_limit_reached');
  }
  if (createsPlan && store.plans.length >= MAX_PLANS) {
    throw storeError('delivery_plan_store_plan_limit_reached');
  }
}

function assertChronology(store, at) {
  const latest = store.operations.at(-1)?.at;
  if (latest && Date.parse(at) < Date.parse(latest)) {
    throw storeError('delivery_plan_store_clock_regressed');
  }
}

function operationReplay(store, id, action, digest) {
  const existing = store.operations.find((candidate) => candidate.id === id);
  if (!existing) return null;
  if (existing.action !== action || existing.requestDigest !== digest) {
    throw storeError('delivery_plan_store_operation_conflict', {
      operationId: id,
      originalAction: existing.action
    });
  }
  return replayResult(existing);
}

function nextStore(store, { id, action, requestDigest, at, plan }) {
  const revision = store.revision + 1;
  const result = newResult(revision, plan);
  const next = {
    version: DELIVERY_PLAN_STORE_VERSION,
    revision,
    plans: store.plans.some((candidate) => candidate.id === plan.id)
      ? store.plans.map((candidate) => candidate.id === plan.id ? clone(plan) : candidate)
      : [...store.plans, clone(plan)],
    operations: [...store.operations, {
      id,
      action,
      requestDigest,
      at,
      result
    }]
  };
  return { store: validateDeliveryPlanStore(next), result };
}

function validateOperation(operation, index, previousByPlan, planIds) {
  exactKeys(operation, ['id', 'action', 'requestDigest', 'at', 'result'], 'delivery_plan_store_operation_invalid');
  if (!OPERATION_ID_PATTERN.test(operation.id) || !ACTIONS.has(operation.action)) {
    throw storeError('delivery_plan_store_operation_invalid');
  }
  if (!SHA256_PATTERN.test(operation.requestDigest) || !validTimestamp(operation.at)) {
    throw storeError('delivery_plan_store_operation_invalid');
  }
  exactKeys(operation.result, ['storeRevision', 'plan'], 'delivery_plan_store_operation_result_invalid');
  if (operation.result.storeRevision !== index + 1) {
    throw storeError('delivery_plan_store_operation_revision_invalid');
  }
  const snapshot = strictPlan(operation.result.plan, 'delivery_plan_store_operation_plan_invalid');
  if (!planIds.has(snapshot.id)) throw storeError('delivery_plan_store_operation_plan_unknown');
  const previous = previousByPlan.get(snapshot.id);
  if (operation.action === 'plan.create') {
    if (previous || snapshot.revision !== 1) throw storeError('delivery_plan_store_operation_lifecycle_invalid');
    assertCreateLifecycle(snapshot);
  } else {
    if (!previous) throw storeError('delivery_plan_store_operation_lifecycle_invalid');
    if (snapshot.createdAt !== previous.createdAt) throw storeError('delivery_plan_store_operation_lifecycle_invalid');
    const delta = snapshot.revision - previous.revision;
    if (operation.action === 'plan.transition' ? delta !== 1 : ![0, 1].includes(delta)) {
      throw storeError('delivery_plan_store_operation_lifecycle_invalid');
    }
  }
  previousByPlan.set(snapshot.id, snapshot);
  return { ...operation, result: { storeRevision: operation.result.storeRevision, plan: snapshot } };
}

export function emptyDeliveryPlanStore() {
  return { version: DELIVERY_PLAN_STORE_VERSION, revision: 0, plans: [], operations: [] };
}

export function validateDeliveryPlanStore(value) {
  exactKeys(value, ['version', 'revision', 'plans', 'operations'], 'delivery_plan_store_shape_invalid');
  if (value.version !== DELIVERY_PLAN_STORE_VERSION) throw storeError('delivery_plan_store_version_unsupported');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw storeError('delivery_plan_store_revision_invalid');
  }
  if (!Array.isArray(value.plans) || value.plans.length > MAX_PLANS) {
    throw storeError('delivery_plan_store_plans_invalid');
  }
  if (!Array.isArray(value.operations) || value.operations.length > MAX_OPERATIONS) {
    throw storeError('delivery_plan_store_operations_invalid');
  }
  if (value.revision !== value.operations.length) {
    throw storeError('delivery_plan_store_revision_invalid');
  }

  const ids = new Set();
  const plans = value.plans.map((candidate) => {
    const plan = strictPlan(candidate);
    if (ids.has(plan.id)) throw storeError('delivery_plan_store_plan_duplicate');
    ids.add(plan.id);
    return plan;
  });
  const operationIds = new Set();
  const previousByPlan = new Map();
  let previousAt = null;
  const operations = value.operations.map((candidate, index) => {
    if (plainObject(candidate) && operationIds.has(candidate.id)) {
      throw storeError('delivery_plan_store_operation_duplicate');
    }
    const operation = validateOperation(candidate, index, previousByPlan, ids);
    if (previousAt && Date.parse(operation.at) < Date.parse(previousAt)) {
      throw storeError('delivery_plan_store_operation_chronology_invalid');
    }
    previousAt = operation.at;
    operationIds.add(operation.id);
    return operation;
  });
  if (previousByPlan.size !== plans.length) throw storeError('delivery_plan_store_history_incomplete');
  for (const plan of plans) {
    const latest = previousByPlan.get(plan.id);
    if (!latest || canonicalJson(latest) !== canonicalJson(plan)) {
      throw storeError('delivery_plan_store_current_plan_mismatch');
    }
  }
  const store = { version: DELIVERY_PLAN_STORE_VERSION, revision: value.revision, plans, operations };
  if (byteLength(store) > MAX_STORE_BYTES) throw storeError('delivery_plan_store_too_large');
  return store;
}

function summaryFromValidatedStore(store, {
  activeLimit = DEFAULT_ACTIVE_LIMIT,
  recentLimit = DEFAULT_RECENT_LIMIT
} = {}) {
  const activeMax = normalizedLimit(activeLimit, DEFAULT_ACTIVE_LIMIT, 'active_limit');
  const recentMax = normalizedLimit(recentLimit, DEFAULT_RECENT_LIMIT, 'recent_limit');
  const newestFirst = (left, right) => (
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id)
  );
  const active = store.plans.filter((plan) => !TERMINAL_PHASES.has(plan.phase)).sort(newestFirst);
  const terminal = store.plans.filter((plan) => TERMINAL_PHASES.has(plan.phase)).sort(newestFirst);
  return {
    version: store.version,
    revision: store.revision,
    counts: {
      total: store.plans.length,
      active: active.length,
      terminal: terminal.length,
      done: terminal.filter((plan) => plan.phase === 'done').length,
      canceled: terminal.filter((plan) => plan.phase === 'canceled').length,
      draft: store.plans.filter((plan) => plan.phase === 'draft').length,
      needsDecision: store.plans.filter((plan) => ['needs_decision', 'blocked'].includes(plan.phase)).length,
      awaitingApproval: store.plans.filter((plan) => plan.phase === 'ready_for_approval').length,
      approved: store.plans.filter((plan) => plan.phase === 'approved').length,
      closed: terminal.length,
      operations: store.operations.length
    },
    active: active.slice(0, activeMax).map(planSummary),
    recent: terminal.slice(0, recentMax).map(planSummary)
  };
}

export function deliveryPlanStoreSummary(value, options = {}) {
  return summaryFromValidatedStore(validateDeliveryPlanStore(value), options);
}

async function readStoreFile(filePath) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ELOOP') throw storeError('delivery_plan_store_symlink_rejected', { cause: error });
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw storeError('delivery_plan_store_file_invalid');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw storeError('delivery_plan_store_owner_invalid');
    }
    if ((stat.mode & 0o077) !== 0) throw storeError('delivery_plan_store_permissions_insecure');
    if ((stat.mode & 0o777) !== 0o600) await handle.chmod(0o600);
    if (stat.size > MAX_STORE_BYTES) throw storeError('delivery_plan_store_too_large');
    const contents = await handle.readFile('utf8');
    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch (cause) {
      throw storeError('delivery_plan_store_json_invalid', { cause });
    }
    return validateDeliveryPlanStore(parsed);
  } finally {
    await handle.close();
  }
}

export function createDeliveryPlanRepository({
  filePath,
  now = () => new Date().toISOString(),
  idFactory = () => `plan-${randomBytes(12).toString('hex')}`,
  writeAtomic = writeJsonAtomic
} = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new TypeError('filePath must be absolute');
  }
  if (path.dirname(filePath) === path.parse(filePath).root) {
    throw new TypeError('filePath must use a dedicated parent directory');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof idFactory !== 'function') throw new TypeError('idFactory must be a function');
  if (typeof writeAtomic !== 'function') throw new TypeError('writeAtomic must be a function');

  let store = null;
  let initialization = null;
  let mutationTail = Promise.resolve();
  let poisoned = null;

  function poisonAfterCommittedWrite(writeError, cause) {
    if (!poisoned) {
      poisoned = storeError('delivery_plan_store_persistence_uncertain', { cause, writeError });
    }
    store = null;
    return poisoned;
  }

  async function recoverCommittedWrite(validated, writeError) {
    let recovered;
    try {
      recovered = await readStoreFile(filePath);
      if (canonicalJson(recovered) !== canonicalJson(validated)) {
        throw storeError('delivery_plan_store_post_commit_mismatch');
      }
    } catch (cause) {
      throw poisonAfterCommittedWrite(writeError, cause);
    }
    store = recovered;
  }

  async function persist(next) {
    const validated = validateDeliveryPlanStore(next);
    try {
      await writeAtomic(filePath, validated, { spaces: 2 });
    } catch (error) {
      if (!atomicJsonReplacementCommitted(error)) throw error;
      await recoverCommittedWrite(validated, error);
      throw error;
    }
    store = validated;
    return store;
  }

  async function load() {
    await ensurePrivateDirectory(path.dirname(filePath));
    try {
      store = await readStoreFile(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      store = emptyDeliveryPlanStore();
      await persist(store);
    }
    return store;
  }

  async function ensureInitialized() {
    if (poisoned) throw poisoned;
    if (store) return store;
    if (!initialization) {
      initialization = load().catch((error) => {
        initialization = null;
        throw error;
      });
    }
    return initialization;
  }

  function afterMutations(operation) {
    return mutationTail.catch(() => {}).then(async () => operation(await ensureInitialized()));
  }

  function mutate(operation) {
    const result = mutationTail.catch(() => {}).then(async () => operation(await ensureInitialized()));
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  return Object.freeze({
    async initialize() {
      return deliveryPlanStoreSummary(await ensureInitialized());
    },

    list(options = {}) {
      return afterMutations((current) => summaryFromValidatedStore(current, options));
    },

    get(id, { includeHistory = false } = {}) {
      const wanted = planId(id);
      if (typeof includeHistory !== 'boolean') {
        return Promise.reject(storeError('delivery_plan_store_history_option_invalid'));
      }
      return afterMutations((current) => {
        const currentPlan = current.plans.find((candidate) => candidate.id === wanted);
        if (!currentPlan) return null;
        if (!includeHistory) return clone(currentPlan);
        const history = [];
        let previous = null;
        for (const operation of current.operations) {
          if (operation.result.plan.id !== wanted) continue;
          const snapshot = operation.result.plan;
          if (previous && canonicalJson(previous) === canonicalJson(snapshot)) continue;
          history.push({
            operationId: operation.id,
            action: operation.action,
            storeRevision: operation.result.storeRevision,
            at: operation.at,
            plan: clone(snapshot)
          });
          previous = snapshot;
        }
        return { plan: clone(currentPlan), history };
      });
    },

    create(input) {
      if (!plainObject(input) || !plainObject(input.plan)) {
        return Promise.reject(storeError('delivery_plan_store_create_request_invalid'));
      }
      let id;
      let expectedStoreRevision;
      let request;
      try {
        id = operationId(input.operationId);
        expectedStoreRevision = requestedRevision(input.expectedStoreRevision, 'expected_store_revision');
        request = requestSnapshot({ expectedStoreRevision, plan: input.plan });
      } catch (error) {
        return Promise.reject(error);
      }
      return mutate(async (current) => {
        const replay = operationReplay(current, id, 'plan.create', request.digest);
        if (replay) return replay;
        assertStoreRevision(current, expectedStoreRevision);
        assertMutationCapacity(current, { createsPlan: true });
        const at = timestamp(now());
        const candidateId = planId(request.value.plan.id || idFactory());
        if (current.plans.some((candidate) => candidate.id === candidateId)) {
          throw storeError('delivery_plan_store_plan_duplicate', { planId: candidateId });
        }
        let plan;
        try {
          plan = validateDeliveryPlan({
            ...request.value.plan,
            id: candidateId,
            revision: 1,
            createdAt: at,
            updatedAt: at
          });
        } catch (cause) {
          throw storeError('delivery_plan_store_plan_invalid', { cause });
        }
        if (byteLength(plan) > MAX_PLAN_BYTES) throw storeError('delivery_plan_store_plan_too_large');
        assertCreateLifecycle(plan);
        assertChronology(current, at);
        const next = nextStore(current, {
          id,
          action: 'plan.create',
          requestDigest: request.digest,
          at,
          plan
        });
        await persist(next.store);
        return { replayed: false, ...clone(next.result) };
      });
    },

    update(idValue, input) {
      let wanted;
      let id;
      let expectedStoreRevision;
      let expectedPlanRevision;
      let request;
      try {
        wanted = planId(idValue);
        if (!plainObject(input) || !plainObject(input.patch)) {
          throw storeError('delivery_plan_store_update_request_invalid');
        }
        id = operationId(input.operationId);
        expectedStoreRevision = requestedRevision(input.expectedStoreRevision, 'expected_store_revision');
        expectedPlanRevision = requestedPlanRevision(input.expectedPlanRevision);
        request = requestSnapshot({
          planId: wanted,
          expectedStoreRevision,
          expectedPlanRevision,
          patch: input.patch
        });
      } catch (error) {
        return Promise.reject(error);
      }
      return mutate(async (current) => {
        const replay = operationReplay(current, id, 'plan.update', request.digest);
        if (replay) return replay;
        assertStoreRevision(current, expectedStoreRevision);
        assertMutationCapacity(current);
        const plan = current.plans.find((candidate) => candidate.id === wanted);
        if (!plan) throw storeError('delivery_plan_store_plan_not_found', { planId: wanted });
        assertPlanRevision(plan, expectedPlanRevision);
        const at = timestamp(now());
        let updated;
        try {
          updated = updateDeliveryPlanDefinition(plan, request.value.patch, { at });
        } catch (cause) {
          throw storeError(cause?.message || 'delivery_plan_store_update_invalid', { cause });
        }
        assertChronology(current, at);
        const next = nextStore(current, {
          id,
          action: 'plan.update',
          requestDigest: request.digest,
          at,
          plan: updated
        });
        await persist(next.store);
        return { replayed: false, ...clone(next.result) };
      });
    },

    transition(idValue, input) {
      let wanted;
      let id;
      let expectedStoreRevision;
      let expectedPlanRevision;
      let request;
      try {
        wanted = planId(idValue);
        if (!plainObject(input) || !plainObject(input.conditions ?? {})) {
          throw storeError('delivery_plan_store_transition_request_invalid');
        }
        id = operationId(input.operationId);
        expectedStoreRevision = requestedRevision(input.expectedStoreRevision, 'expected_store_revision');
        expectedPlanRevision = requestedPlanRevision(input.expectedPlanRevision);
        const conditions = input.conditions ?? {};
        if (conditions.expectedRevision !== undefined && conditions.expectedRevision !== expectedPlanRevision) {
          throw storeError('delivery_plan_store_expected_plan_revision_conflict');
        }
        request = requestSnapshot({
          planId: wanted,
          expectedStoreRevision,
          expectedPlanRevision,
          to: input.to,
          conditions
        });
      } catch (error) {
        return Promise.reject(error);
      }
      return mutate(async (current) => {
        const replay = operationReplay(current, id, 'plan.transition', request.digest);
        if (replay) return replay;
        assertStoreRevision(current, expectedStoreRevision);
        assertMutationCapacity(current);
        const plan = current.plans.find((candidate) => candidate.id === wanted);
        if (!plan) throw storeError('delivery_plan_store_plan_not_found', { planId: wanted });
        assertPlanRevision(plan, expectedPlanRevision);
        const at = timestamp(now());
        let transitioned;
        try {
          transitioned = transitionDeliveryPlan(plan, request.value.to, {
            ...request.value.conditions,
            expectedRevision: expectedPlanRevision
          }, { at });
        } catch (cause) {
          throw storeError(cause?.message || 'delivery_plan_store_transition_invalid', { cause });
        }
        assertChronology(current, at);
        const next = nextStore(current, {
          id,
          action: 'plan.transition',
          requestDigest: request.digest,
          at,
          plan: transitioned
        });
        await persist(next.store);
        return { replayed: false, ...clone(next.result) };
      });
    }
  });
}
