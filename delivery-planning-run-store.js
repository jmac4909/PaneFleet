import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, canonicalSha256 } from './delivery-plan.js';
import {
  DELIVERY_PLANNING_RUN_MAX_CLEANUP_CONTINUE_RECEIPTS,
  DELIVERY_PLANNING_RUN_MAX_PERSISTED_BYTES,
  DELIVERY_PLANNING_RUN_MAX_RESOURCE_CONTINUE_RECEIPTS,
  abandonDeliveryPlanningApply,
  authorizeDeliveryPlanningContinue,
  bindDeliveryPlanningRoleSpawnLease,
  cancelDeliveryPlanningRun,
  claimDeliveryPlanningRoleSpawnLeaseCleanup,
  claimDeliveryPlanningApply,
  claimDeliveryPlanningRoleCleanup,
  claimDeliveryPlanningRoleDispatch,
  claimDeliveryPlanningRoleSpawn,
  compileDeliveryPlanningCandidate,
  createDeliveryPlanningRun,
  markDeliveryPlanningApplied,
  markDeliveryPlanningApplyReconcileRequired,
  markDeliveryPlanningResourceWait,
  markDeliveryPlanningRoleSpawnLeaseCleanupComplete,
  markDeliveryPlanningRoleSpawnLeaseCleanupSent,
  markDeliveryPlanningRoleSpawnLeaseReconcileRequired,
  markDeliveryPlanningRoleCleanupComplete,
  markDeliveryPlanningRoleCleanupRequired,
  markDeliveryPlanningRoleCleanupSent,
  markDeliveryPlanningRoleCrash,
  markDeliveryPlanningRoleDispatched,
  markDeliveryPlanningRoleNeedsInput,
  markDeliveryPlanningRoleReconcileRequired,
  markDeliveryPlanningRunOffCourse,
  closeDeliveryPlanningRoleSpawnLeaseAbsent,
  recordDeliveryPlanningRoleReport,
  recoverDeliveryPlanningRoleCleanup,
  validateDeliveryPlanningRun
} from './delivery-planning-run.js';
import {
  atomicJsonReplacementCommitted,
  ensurePrivateDirectory,
  writeJsonAtomic
} from './durable-json.js';

export const DELIVERY_PLANNING_RUN_STORE_VERSION = 1;

export const DELIVERY_PLANNING_RUN_STORE_MAX_RUNS = 64;
export const DELIVERY_PLANNING_RUN_STORE_MAX_OPERATIONS = 1024;
export const DELIVERY_PLANNING_RUN_STORE_MAX_PERSISTED_BYTES = 32 * 1024 * 1024;
export const DELIVERY_PLANNING_RUN_STORE_MAX_ACTIVE_RUNS = 1;
// Fixed single-attempt path without resource retries: create (1) + four role
// spawn/lease-bind/dispatch/submitted/report/cleanup-claim/sent/complete paths
// (4 * 8) + compile/apply-claim/apply-reconcile/applied (4) = 37.
export const DELIVERY_PLANNING_RUN_BASE_GRAPH_MAX_OPERATIONS = 37;
// The pre-lease adversarial path used 24 bounded resource/cleanup-recovery
// operations beyond its fixed graph and Continue receipts. Four lease binds
// raise that executable path from 69 to 73; the separate margin retains four
// receipts of headroom. A provisional orphan terminates the Run after at most
// bind/reconcile/cleanup-claim/sent/complete/cancel and is strictly shorter.
export const DELIVERY_PLANNING_RUN_CLEANUP_RECOVERY_EXTRA_MAX_OPERATIONS = 24;
// Six resource retries cannot consume the six receipts reserved for cleanup.
export const DELIVERY_PLANNING_RUN_CONTINUE_RECEIPT_MAX_OPERATIONS =
  DELIVERY_PLANNING_RUN_MAX_RESOURCE_CONTINUE_RECEIPTS
  + DELIVERY_PLANNING_RUN_MAX_CLEANUP_CONTINUE_RECEIPTS;
export const DELIVERY_PLANNING_RUN_OPERATION_SAFETY_MARGIN = 4;
export const DELIVERY_PLANNING_RUN_MAX_ACTIVE_OPERATION_FOOTPRINT =
  DELIVERY_PLANNING_RUN_BASE_GRAPH_MAX_OPERATIONS
  + DELIVERY_PLANNING_RUN_CLEANUP_RECOVERY_EXTRA_MAX_OPERATIONS
  + DELIVERY_PLANNING_RUN_CONTINUE_RECEIPT_MAX_OPERATIONS
  + DELIVERY_PLANNING_RUN_OPERATION_SAFETY_MARGIN;
export const DELIVERY_PLANNING_RUN_STORE_CURRENT_RUN_SLOT_MAX_PERSISTED_BYTES = 320 * 1024;
export const DELIVERY_PLANNING_RUN_STORE_OPERATION_SLOT_MAX_PERSISTED_BYTES = 384 * 1024;

const MAX_RUNS = DELIVERY_PLANNING_RUN_STORE_MAX_RUNS;
const MAX_OPERATIONS = DELIVERY_PLANNING_RUN_STORE_MAX_OPERATIONS;
const MAX_STORE_BYTES = DELIVERY_PLANNING_RUN_STORE_MAX_PERSISTED_BYTES;
const MAX_RUN_BYTES = DELIVERY_PLANNING_RUN_MAX_PERSISTED_BYTES;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_SUMMARY_ITEMS = 128;
const DEFAULT_ACTIVE_LIMIT = 40;
const DEFAULT_RECENT_LIMIT = 20;
const RUN_ID_PATTERN = /^planning-run-[a-z0-9][a-z0-9-]{7,63}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const TERMINAL_CONDITIONS = new Set(['canceled']);
const TERMINAL_PHASES = new Set(['applied', 'closed']);
const ACTIONS = new Set([
  'planning_run.create',
  'planning_run.role_spawn_claim',
  'planning_run.role_spawn_lease_bind',
  'planning_run.role_spawn_lease_reconcile',
  'planning_run.role_spawn_lease_close_absent',
  'planning_run.role_spawn_lease_cleanup_claim',
  'planning_run.role_spawn_lease_cleanup_sent',
  'planning_run.role_spawn_lease_cleanup_complete',
  'planning_run.role_dispatch_claim',
  'planning_run.role_dispatched',
  'planning_run.role_report',
  'planning_run.resource_wait',
  'planning_run.role_needs_input',
  'planning_run.role_crash',
  'planning_run.role_reconcile',
  'planning_run.cleanup_claim',
  'planning_run.cleanup_sent',
  'planning_run.cleanup_complete',
  'planning_run.cleanup_required',
  'planning_run.cleanup_recover',
  'planning_run.continue_authorize',
  'planning_run.candidate_compile',
  'planning_run.apply_claim',
  'planning_run.applied',
  'planning_run.apply_reconcile',
  'planning_run.apply_abandon',
  'planning_run.off_course',
  'planning_run.cancel'
]);

function storeError(code, detail = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, detail);
  return error;
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, code) {
  if (!plainObject(value)) throw storeError(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw storeError(code);
  }
}

function clone(value) {
  return structuredClone(value);
}

function persistedJsonBytes(value) {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function validTimestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return typeof value === 'string'
    && value.length > 0
    && Number.isFinite(parsed)
    && value === new Date(parsed).toISOString();
}

function timestamp(value) {
  const result = value instanceof Date ? value.toISOString() : String(value ?? '');
  if (!validTimestamp(result)) throw storeError('delivery_planning_run_store_now_invalid');
  return result;
}

function strictRun(value, code = 'delivery_planning_run_store_run_invalid') {
  let validated;
  try {
    validated = validateDeliveryPlanningRun(value);
    if (canonicalJson(validated) !== canonicalJson(value)) throw storeError(code);
  } catch (cause) {
    if (cause?.code === code) throw cause;
    throw storeError(code, { cause });
  }
  if (persistedJsonBytes(validated) > MAX_RUN_BYTES) {
    throw storeError('delivery_planning_run_store_run_too_large');
  }
  return validated;
}

function operationId(value) {
  const result = String(value ?? '').trim();
  if (!OPERATION_ID_PATTERN.test(result)) {
    throw storeError('delivery_planning_run_store_operation_id_invalid');
  }
  return result;
}

function runId(value) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!RUN_ID_PATTERN.test(result)) throw storeError('delivery_planning_run_store_run_id_invalid');
  return result;
}

function requestedRevision(value, field, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw storeError(`delivery_planning_run_store_${field}_invalid`);
  }
  return value;
}

function requestSnapshot(value) {
  let serialized;
  try {
    serialized = canonicalJson(value);
  } catch (cause) {
    throw storeError('delivery_planning_run_store_request_invalid', { cause });
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) {
    throw storeError('delivery_planning_run_store_request_too_large');
  }
  return { value: JSON.parse(serialized), digest: canonicalSha256(value) };
}

function normalizedLimit(value, fallback, field) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_SUMMARY_ITEMS) {
    throw storeError(`delivery_planning_run_store_${field}_invalid`);
  }
  return result;
}

function runIsTerminal(run) {
  return TERMINAL_CONDITIONS.has(run.condition) || TERMINAL_PHASES.has(run.phase);
}

function operationsForRun(store, runIdValue) {
  return store.operations.reduce((count, operation) => (
    count + (operation.result.run.id === runIdValue ? 1 : 0)
  ), 0);
}

function activeReservation(store) {
  const active = store.runs.filter((run) => !runIsTerminal(run));
  if (active.length > DELIVERY_PLANNING_RUN_STORE_MAX_ACTIVE_RUNS) {
    throw storeError('delivery_planning_run_store_active_run_limit_reached');
  }
  let operationHeadroom = 0;
  let persistedByteHeadroom = 0;
  for (const run of active) {
    const consumed = operationsForRun(store, run.id);
    if (consumed > DELIVERY_PLANNING_RUN_MAX_ACTIVE_OPERATION_FOOTPRINT) {
      throw storeError('delivery_planning_run_store_active_operation_budget_exceeded');
    }
    const remaining = DELIVERY_PLANNING_RUN_MAX_ACTIVE_OPERATION_FOOTPRINT - consumed;
    const currentRunSlotBytes = persistedJsonBytes({ runs: [run] });
    operationHeadroom += remaining;
    persistedByteHeadroom += (
      DELIVERY_PLANNING_RUN_STORE_CURRENT_RUN_SLOT_MAX_PERSISTED_BYTES - currentRunSlotBytes
    )
      + (remaining * DELIVERY_PLANNING_RUN_STORE_OPERATION_SLOT_MAX_PERSISTED_BYTES);
  }
  return { activeCount: active.length, operationHeadroom, persistedByteHeadroom };
}

export function deliveryPlanningRunStoreCapacity(value) {
  const store = validateDeliveryPlanningRunStore(value);
  const reservation = activeReservation(store);
  const persistedBytes = persistedJsonBytes(store);
  return {
    persistedBytes,
    reservedPersistedBytes: reservation.persistedByteHeadroom,
    operationCount: store.operations.length,
    reservedOperations: reservation.operationHeadroom,
    activeRunCount: reservation.activeCount,
    maximumPersistedBytes: MAX_STORE_BYTES,
    maximumOperations: MAX_OPERATIONS
  };
}

function runSummary(run) {
  const roles = Object.values(run.roles || {});
  return {
    id: run.id,
    revision: run.revision,
    planId: run.planId,
    planRevision: run.planRevision,
    planDigest: run.planDigest,
    phase: run.phase,
    condition: run.condition,
    completedRoleCount: roles.filter((role) => role?.state === 'completed').length,
    roleCount: roles.length,
    candidateDigest: run.candidate?.digest || '',
    applyState: run.applyOutbox?.state || 'held',
    updatedAt: run.updatedAt
  };
}

function assertStoreRevision(store, expected) {
  if (store.revision !== expected) {
    throw storeError('delivery_planning_run_store_revision_conflict', {
      currentStoreRevision: store.revision,
      expectedStoreRevision: expected
    });
  }
}

function assertRunRevision(run, expected) {
  if (run.revision !== expected) {
    throw storeError('delivery_planning_run_store_run_revision_conflict', {
      runId: run.id,
      currentRunRevision: run.revision,
      expectedRunRevision: expected
    });
  }
}

function assertCapacity(store, { createsRun = false } = {}) {
  const capacity = deliveryPlanningRunStoreCapacity(store);
  if (capacity.operationCount >= MAX_OPERATIONS) {
    throw storeError('delivery_planning_run_store_operation_limit_reached');
  }
  if (createsRun && store.runs.length >= MAX_RUNS) {
    throw storeError('delivery_planning_run_store_run_limit_reached');
  }
  if (createsRun) {
    if (capacity.activeRunCount >= DELIVERY_PLANNING_RUN_STORE_MAX_ACTIVE_RUNS) {
      throw storeError('delivery_planning_run_store_active_run_limit_reached');
    }
    if (capacity.operationCount + DELIVERY_PLANNING_RUN_MAX_ACTIVE_OPERATION_FOOTPRINT > MAX_OPERATIONS) {
      throw storeError('delivery_planning_run_store_operation_reservation_unavailable');
    }
    // This is evaluated against the pre-create store. Reserve all operation
    // slots, including the create receipt that does not exist in that store yet.
    const projectedReservation = DELIVERY_PLANNING_RUN_STORE_CURRENT_RUN_SLOT_MAX_PERSISTED_BYTES
      + (DELIVERY_PLANNING_RUN_MAX_ACTIVE_OPERATION_FOOTPRINT
        * DELIVERY_PLANNING_RUN_STORE_OPERATION_SLOT_MAX_PERSISTED_BYTES);
    if (capacity.persistedBytes + projectedReservation > MAX_STORE_BYTES) {
      throw storeError('delivery_planning_run_store_byte_reservation_unavailable');
    }
  }
}

function assertChronology(store, at) {
  const latest = store.operations.at(-1)?.at;
  if (latest && Date.parse(at) < Date.parse(latest)) {
    throw storeError('delivery_planning_run_store_clock_regressed');
  }
}

function operationReplay(store, id, action, digest) {
  const operation = store.operations.find((candidate) => candidate.id === id);
  if (!operation) return null;
  if (operation.action !== action || operation.requestDigest !== digest) {
    throw storeError('delivery_planning_run_store_operation_conflict', {
      operationId: id,
      originalAction: operation.action
    });
  }
  return { replayed: true, ...clone(operation.result) };
}

function nextStore(store, { id, action, requestDigest, at, run }) {
  const revision = store.revision + 1;
  const result = { storeRevision: revision, run: clone(run) };
  const next = {
    version: DELIVERY_PLANNING_RUN_STORE_VERSION,
    revision,
    runs: store.runs.some((candidate) => candidate.id === run.id)
      ? store.runs.map((candidate) => candidate.id === run.id ? clone(run) : candidate)
      : [...store.runs, clone(run)],
    operations: [...store.operations, { id, action, requestDigest, at, result }]
  };
  return { store: validateDeliveryPlanningRunStore(next), result };
}

function validateOperation(operation, index, previousByRun, runIds) {
  exactKeys(
    operation,
    ['id', 'action', 'requestDigest', 'at', 'result'],
    'delivery_planning_run_store_operation_invalid'
  );
  if (
    !OPERATION_ID_PATTERN.test(operation.id)
    || !ACTIONS.has(operation.action)
    || !DIGEST_PATTERN.test(operation.requestDigest)
    || !validTimestamp(operation.at)
  ) throw storeError('delivery_planning_run_store_operation_invalid');
  exactKeys(
    operation.result,
    ['storeRevision', 'run'],
    'delivery_planning_run_store_operation_result_invalid'
  );
  if (operation.result.storeRevision !== index + 1) {
    throw storeError('delivery_planning_run_store_operation_revision_invalid');
  }
  const snapshot = strictRun(
    operation.result.run,
    'delivery_planning_run_store_operation_run_invalid'
  );
  if (persistedJsonBytes({ operations: [operation] }) > DELIVERY_PLANNING_RUN_STORE_OPERATION_SLOT_MAX_PERSISTED_BYTES) {
    throw storeError('delivery_planning_run_store_operation_too_large');
  }
  if (!runIds.has(snapshot.id)) {
    throw storeError('delivery_planning_run_store_operation_run_unknown');
  }
  const previous = previousByRun.get(snapshot.id);
  if (operation.action === 'planning_run.create') {
    if (previous || snapshot.revision !== 1) {
      throw storeError('delivery_planning_run_store_operation_lifecycle_invalid');
    }
  } else {
    if (
      !previous
      || snapshot.revision !== previous.revision + 1
      || snapshot.createdAt !== previous.createdAt
      || snapshot.planId !== previous.planId
      || snapshot.planRevision !== previous.planRevision
      || snapshot.planDigest !== previous.planDigest
      || snapshot.workspace !== previous.workspace
      || snapshot.inputDigest !== previous.inputDigest
      || canonicalJson(snapshot.baseline) !== canonicalJson(previous.baseline)
      || canonicalJson(snapshot.sourcePlan) !== canonicalJson(previous.sourcePlan)
      || runIsTerminal(previous)
    ) throw storeError('delivery_planning_run_store_operation_lifecycle_invalid');
    for (const role of ['po', 'ba', 'qa', 'dev']) {
      const priorAttempt = previous.roles[role].attempts.at(-1) || null;
      if (!priorAttempt) continue;
      const currentAttempt = snapshot.roles[role].attempts.find((attempt) => attempt.id === priorAttempt.id);
      if (!currentAttempt) throw storeError('delivery_planning_run_store_spawn_lease_binding_changed');
      const priorLease = priorAttempt.spawnLease;
      const currentLease = currentAttempt.spawnLease;
      const immutableLease = (lease) => ({
        leaseId: lease.leaseId,
        session: lease.session,
        contextDigest: lease.contextDigest,
        scopeUnit: lease.scopeUnit,
        scopeDigest: lease.scopeDigest,
        launchDigest: lease.launchDigest,
        bindDeadlineAt: lease.bindDeadlineAt,
        claimedAt: lease.claimedAt
      });
      if (canonicalJson(immutableLease(priorLease)) !== canonicalJson(immutableLease(currentLease))) {
        throw storeError('delivery_planning_run_store_spawn_lease_binding_changed');
      }
      if (priorLease.observed.boundAt && canonicalJson({
        sessionCreatedAt: priorLease.observed.sessionCreatedAt,
        paneId: priorLease.observed.paneId,
        tmuxPaneId: priorLease.observed.tmuxPaneId,
        panePid: priorLease.observed.panePid,
        paneTty: priorLease.observed.paneTty,
        boundAt: priorLease.observed.boundAt
      }) !== canonicalJson({
        sessionCreatedAt: currentLease.observed.sessionCreatedAt,
        paneId: currentLease.observed.paneId,
        tmuxPaneId: currentLease.observed.tmuxPaneId,
        panePid: currentLease.observed.panePid,
        paneTty: currentLease.observed.paneTty,
        boundAt: currentLease.observed.boundAt
      })) throw storeError('delivery_planning_run_store_spawn_lease_observation_changed');
      if (priorLease.cleanup && (
        !currentLease.cleanup
        || currentLease.cleanup.claimId !== priorLease.cleanup.claimId
        || currentLease.cleanup.action !== priorLease.cleanup.action
        || currentLease.cleanup.claimedAt !== priorLease.cleanup.claimedAt
      )) throw storeError('delivery_planning_run_store_spawn_lease_cleanup_changed');
      if (!priorAttempt.scopeUnit) continue;
      if (
        currentAttempt.scopeUnit !== priorAttempt.scopeUnit
        || currentAttempt.scopeDigest !== priorAttempt.scopeDigest
      ) throw storeError('delivery_planning_run_store_scope_binding_changed');
    }
  }
  previousByRun.set(snapshot.id, snapshot);
  return { ...operation, result: { storeRevision: operation.result.storeRevision, run: snapshot } };
}

export function emptyDeliveryPlanningRunStore() {
  return { version: DELIVERY_PLANNING_RUN_STORE_VERSION, revision: 0, runs: [], operations: [] };
}

export function validateDeliveryPlanningRunStore(value) {
  exactKeys(
    value,
    ['version', 'revision', 'runs', 'operations'],
    'delivery_planning_run_store_shape_invalid'
  );
  if (value.version !== DELIVERY_PLANNING_RUN_STORE_VERSION) {
    throw storeError('delivery_planning_run_store_version_unsupported');
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw storeError('delivery_planning_run_store_revision_invalid');
  }
  if (!Array.isArray(value.runs) || value.runs.length > MAX_RUNS) {
    throw storeError('delivery_planning_run_store_runs_invalid');
  }
  if (!Array.isArray(value.operations) || value.operations.length > MAX_OPERATIONS) {
    throw storeError('delivery_planning_run_store_operations_invalid');
  }
  if (value.revision !== value.operations.length) {
    throw storeError('delivery_planning_run_store_revision_invalid');
  }
  const runIds = new Set();
  const runs = value.runs.map((candidate) => {
    const run = strictRun(candidate);
    if (persistedJsonBytes({ runs: [run] }) > DELIVERY_PLANNING_RUN_STORE_CURRENT_RUN_SLOT_MAX_PERSISTED_BYTES) {
      throw storeError('delivery_planning_run_store_current_run_too_large');
    }
    if (runIds.has(run.id)) throw storeError('delivery_planning_run_store_run_duplicate');
    runIds.add(run.id);
    return run;
  });
  const activeBindingIds = new Set();
  for (const run of runs) {
    if (runIsTerminal(run)) continue;
    const binding = `${run.planId}:${run.planRevision}:${run.planDigest}`;
    if (activeBindingIds.has(binding)) {
      throw storeError('delivery_planning_run_store_plan_binding_duplicate');
    }
    activeBindingIds.add(binding);
  }
  const operationIds = new Set();
  const previousByRun = new Map();
  let previousAt = null;
  const operations = value.operations.map((candidate, index) => {
    if (plainObject(candidate) && operationIds.has(candidate.id)) {
      throw storeError('delivery_planning_run_store_operation_duplicate');
    }
    const operation = validateOperation(candidate, index, previousByRun, runIds);
    if (previousAt && Date.parse(operation.at) < Date.parse(previousAt)) {
      throw storeError('delivery_planning_run_store_operation_chronology_invalid');
    }
    previousAt = operation.at;
    operationIds.add(operation.id);
    return operation;
  });
  if (previousByRun.size !== runs.length) {
    throw storeError('delivery_planning_run_store_history_incomplete');
  }
  for (const run of runs) {
    if (canonicalJson(previousByRun.get(run.id)) !== canonicalJson(run)) {
      throw storeError('delivery_planning_run_store_current_run_mismatch');
    }
  }
  const store = { version: value.version, revision: value.revision, runs, operations };
  const reservation = activeReservation(store);
  if (store.operations.length + reservation.operationHeadroom > MAX_OPERATIONS) {
    throw storeError('delivery_planning_run_store_operation_reservation_unavailable');
  }
  const persistedBytes = persistedJsonBytes(store);
  if (persistedBytes > MAX_STORE_BYTES) {
    throw storeError('delivery_planning_run_store_too_large');
  }
  if (persistedBytes + reservation.persistedByteHeadroom > MAX_STORE_BYTES) {
    throw storeError('delivery_planning_run_store_byte_reservation_unavailable');
  }
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
  const active = store.runs.filter((run) => !runIsTerminal(run)).sort(newestFirst);
  const recent = store.runs.filter(runIsTerminal).sort(newestFirst);
  return {
    version: store.version,
    revision: store.revision,
    counts: {
      total: store.runs.length,
      active: active.length,
      applied: recent.filter((run) => run.phase === 'applied').length,
      canceled: recent.filter((run) => run.condition === 'canceled').length,
      needsAttention: active.filter((run) => [
        'needs_input',
        'reconcile_required',
        'off_course',
        'failed'
      ].includes(run.condition)).length,
      operations: store.operations.length
    },
    active: active.slice(0, activeMax).map(runSummary),
    recent: recent.slice(0, recentMax).map(runSummary)
  };
}

export function deliveryPlanningRunStoreSummary(value, options = {}) {
  return summaryFromValidatedStore(validateDeliveryPlanningRunStore(value), options);
}

async function readStoreFile(filePath) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw storeError('delivery_planning_run_store_symlink_rejected', { cause: error });
    }
    throw error;
  }
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.nlink !== 1) {
      throw storeError('delivery_planning_run_store_file_invalid');
    }
    if (typeof process.getuid === 'function' && details.uid !== process.getuid()) {
      throw storeError('delivery_planning_run_store_owner_invalid');
    }
    if ((details.mode & 0o077) !== 0) {
      throw storeError('delivery_planning_run_store_permissions_insecure');
    }
    if ((details.mode & 0o777) !== 0o600) await handle.chmod(0o600);
    if (details.size > MAX_STORE_BYTES) {
      throw storeError('delivery_planning_run_store_too_large');
    }
    let parsed;
    try {
      parsed = JSON.parse(await handle.readFile('utf8'));
    } catch (cause) {
      throw storeError('delivery_planning_run_store_json_invalid', { cause });
    }
    return validateDeliveryPlanningRunStore(parsed);
  } finally {
    await handle.close();
  }
}

export function createDeliveryPlanningRunRepository({
  filePath,
  now = () => new Date().toISOString(),
  idFactory = () => `planning-run-${randomBytes(12).toString('hex')}`,
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
      poisoned = storeError('delivery_planning_run_store_persistence_uncertain', {
        cause,
        writeError
      });
    }
    store = null;
    return poisoned;
  }

  async function recoverCommittedWrite(validated, writeError) {
    let recovered;
    try {
      recovered = await readStoreFile(filePath);
      if (canonicalJson(recovered) !== canonicalJson(validated)) {
        throw storeError('delivery_planning_run_store_post_commit_mismatch');
      }
    } catch (cause) {
      throw poisonAfterCommittedWrite(writeError, cause);
    }
    store = recovered;
  }

  async function persist(next) {
    const validated = validateDeliveryPlanningRunStore(next);
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
      store = emptyDeliveryPlanningRunStore();
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

  async function performMutation(idValue, input, action, fields, mutator) {
    let wanted;
    let id;
    let expectedStoreRevision;
    let expectedRunRevision;
    let request;
    try {
      wanted = runId(idValue);
      if (!plainObject(input)) {
        throw storeError('delivery_planning_run_store_mutation_request_invalid');
      }
      const mutationFields = typeof fields === 'function' ? fields(input) : fields;
      exactKeys(
        input,
        ['operationId', 'expectedStoreRevision', 'expectedRunRevision', ...mutationFields],
        'delivery_planning_run_store_mutation_request_invalid'
      );
      id = operationId(input.operationId);
      expectedStoreRevision = requestedRevision(
        input.expectedStoreRevision,
        'expected_store_revision',
        0
      );
      expectedRunRevision = requestedRevision(
        input.expectedRunRevision,
        'expected_run_revision',
        1
      );
      const domainInput = Object.fromEntries(mutationFields.map((field) => [field, input[field]]));
      request = requestSnapshot({
        runId: wanted,
        expectedStoreRevision,
        expectedRunRevision,
        ...domainInput
      });
    } catch (error) {
      return Promise.reject(error);
    }
    return mutate(async (current) => {
      const replay = operationReplay(current, id, action, request.digest);
      if (replay) return replay;
      assertStoreRevision(current, expectedStoreRevision);
      assertCapacity(current);
      const currentRun = current.runs.find((candidate) => candidate.id === wanted);
      if (!currentRun) {
        throw storeError('delivery_planning_run_store_run_not_found', { runId: wanted });
      }
      assertRunRevision(currentRun, expectedRunRevision);
      const at = timestamp(now());
      assertChronology(current, at);
      const domainInput = Object.fromEntries(
        Object.keys(request.value)
          .filter((field) => !['runId', 'expectedStoreRevision', 'expectedRunRevision'].includes(field))
          .map((field) => [field, request.value[field]])
      );
      let nextRun;
      try {
        nextRun = mutator(currentRun, domainInput, at, {
          operationId: id,
          expectedStoreRevision,
          expectedRunRevision
        });
      } catch (cause) {
        throw storeError(
          cause?.code || cause?.message || 'delivery_planning_run_store_mutation_invalid',
          { cause }
        );
      }
      const next = nextStore(current, {
        id,
        action,
        requestDigest: request.digest,
        at,
        run: nextRun
      });
      await persist(next.store);
      return { replayed: false, ...clone(next.result) };
    });
  }

  const repository = {
    async initialize() {
      return deliveryPlanningRunStoreSummary(await ensureInitialized());
    },

    list(options = {}) {
      return afterMutations((current) => summaryFromValidatedStore(current, options));
    },

    get(idValue, { includeHistory = false } = {}) {
      let wanted;
      try {
        wanted = runId(idValue);
      } catch (error) {
        return Promise.reject(error);
      }
      if (typeof includeHistory !== 'boolean') {
        return Promise.reject(storeError('delivery_planning_run_store_history_option_invalid'));
      }
      return afterMutations((current) => {
        const currentRun = current.runs.find((candidate) => candidate.id === wanted);
        if (!currentRun) return null;
        if (!includeHistory) return clone(currentRun);
        return {
          run: clone(currentRun),
          history: current.operations
            .filter((operation) => operation.result.run.id === wanted)
            .map((operation) => ({
              operationId: operation.id,
              action: operation.action,
              storeRevision: operation.result.storeRevision,
              at: operation.at,
              run: clone(operation.result.run)
            }))
        };
      });
    },

    create(input) {
      if (!plainObject(input) || !plainObject(input.run)) {
        return Promise.reject(storeError('delivery_planning_run_store_create_request_invalid'));
      }
      let id;
      let expectedStoreRevision;
      let request;
      try {
        exactKeys(
          input,
          ['operationId', 'expectedStoreRevision', 'run'],
          'delivery_planning_run_store_create_request_invalid'
        );
        id = operationId(input.operationId);
        expectedStoreRevision = requestedRevision(
          input.expectedStoreRevision,
          'expected_store_revision',
          0
        );
        request = requestSnapshot({ expectedStoreRevision, run: input.run });
      } catch (error) {
        return Promise.reject(error);
      }
      return mutate(async (current) => {
        const replay = operationReplay(current, id, 'planning_run.create', request.digest);
        if (replay) return replay;
        assertStoreRevision(current, expectedStoreRevision);
        const at = timestamp(now());
        assertChronology(current, at);
        const candidateId = runId(request.value.run.id || idFactory());
        if (current.runs.some((candidate) => candidate.id === candidateId)) {
          throw storeError('delivery_planning_run_store_run_duplicate', { runId: candidateId });
        }
        let run;
        try {
          run = createDeliveryPlanningRun({ ...request.value.run, id: candidateId }, { at });
        } catch (cause) {
          throw storeError(
            cause?.code || cause?.message || 'delivery_planning_run_store_run_invalid',
            { cause }
          );
        }
        const duplicate = current.runs.find((candidate) => (
          !runIsTerminal(candidate)
          &&
          candidate.planId === run.planId
          && candidate.planRevision === run.planRevision
          && candidate.planDigest === run.planDigest
        ));
        if (duplicate) {
          throw storeError('delivery_planning_run_store_plan_binding_duplicate', {
            runId: duplicate.id
          });
        }
        assertCapacity(current, { createsRun: true });
        const next = nextStore(current, {
          id,
          action: 'planning_run.create',
          requestDigest: request.digest,
          at,
          run
        });
        await persist(next.store);
        return { replayed: false, ...clone(next.result) };
      });
    }
  };

  Object.assign(repository, {
    claimRoleSpawn(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.role_spawn_claim',
        ['role', 'attemptId', 'spawnLease'],
        (run, domainInput, at) => claimDeliveryPlanningRoleSpawn(run, domainInput, { at })
      );
    },

    bindRoleSpawnLease(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.role_spawn_lease_bind',
        ['role', 'attemptId', 'leaseId', 'scopeUnit', 'scopeDigest', 'observed'],
        (run, domainInput, at) => bindDeliveryPlanningRoleSpawnLease(run, domainInput, { at })
      );
    },

    markRoleSpawnLeaseReconcileRequired(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.role_spawn_lease_reconcile',
        [
          'role', 'attemptId', 'leaseId', 'scopeUnit', 'scopeDigest',
          'observation', 'reason'
        ],
        (run, domainInput, at) => markDeliveryPlanningRoleSpawnLeaseReconcileRequired(
          run,
          domainInput,
          { at }
        )
      );
    },

    closeRoleSpawnLeaseAbsent(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.role_spawn_lease_close_absent',
        [
          'role', 'attemptId', 'leaseId', 'scopeUnit', 'scopeDigest',
          'observation', 'reason'
        ],
        (run, domainInput, at) => closeDeliveryPlanningRoleSpawnLeaseAbsent(run, domainInput, { at })
      );
    },

    claimRoleSpawnLeaseCleanup(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.role_spawn_lease_cleanup_claim',
        ['role', 'attemptId', 'leaseId', 'claimId', 'action', 'operatorConfirmed'],
        (run, domainInput, at) => claimDeliveryPlanningRoleSpawnLeaseCleanup(run, domainInput, { at })
      );
    },

    markRoleSpawnLeaseCleanupSent(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.role_spawn_lease_cleanup_sent',
        ['role', 'attemptId', 'leaseId', 'claimId'],
        (run, domainInput, at) => markDeliveryPlanningRoleSpawnLeaseCleanupSent(run, domainInput, { at })
      );
    },

    markRoleSpawnLeaseCleanupComplete(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.role_spawn_lease_cleanup_complete',
        [
          'role', 'attemptId', 'leaseId', 'claimId', 'scopeUnit', 'scopeDigest',
          'observation', 'reason'
        ],
        (run, domainInput, at) => markDeliveryPlanningRoleSpawnLeaseCleanupComplete(
          run,
          domainInput,
          { at }
        )
      );
    },

    claimRoleDispatch(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.role_dispatch_claim',
        [
          'role',
          'attemptId',
          'leaseId',
          'worker',
          'rolloutPath',
          'rolloutStartOffset',
          'confirmationMarker',
          'promptDigest'
        ],
        (run, domainInput, at) => claimDeliveryPlanningRoleDispatch(run, domainInput, { at })
      );
    },

    markRoleDispatched(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.role_dispatched',
        ['role', 'attemptId'],
        (run, domainInput, at) => markDeliveryPlanningRoleDispatched(run, domainInput, { at })
      );
    },

    recordRoleReport(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.role_report',
        ['role', 'attemptId', 'report', 'outputDigest'],
        (run, domainInput, at) => recordDeliveryPlanningRoleReport(run, domainInput, { at })
      );
    },

    markResourceWait(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.resource_wait',
        ['role', 'reason'],
        (run, domainInput, at) => markDeliveryPlanningResourceWait(run, domainInput, { at })
      );
    },

    markRoleNeedsInput(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.role_needs_input',
        ['role', 'attemptId', 'reason'],
        (run, domainInput, at) => markDeliveryPlanningRoleNeedsInput(run, domainInput, { at })
      );
    },

    markRoleCrash(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.role_crash',
        ['role', 'attemptId', 'reason'],
        (run, domainInput, at) => markDeliveryPlanningRoleCrash(run, domainInput, { at })
      );
    },

    markRoleReconcileRequired(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.role_reconcile',
        ['role', 'attemptId', 'reason'],
        (run, domainInput, at) => markDeliveryPlanningRoleReconcileRequired(run, domainInput, { at })
      );
    },

    claimRoleCleanup(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.cleanup_claim',
        ['role', 'attemptId', 'claimId'],
        (run, domainInput, at) => claimDeliveryPlanningRoleCleanup(run, domainInput, { at })
      );
    },

    markRoleCleanupSent(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.cleanup_sent',
        ['role', 'attemptId'],
        (run, domainInput, at) => markDeliveryPlanningRoleCleanupSent(run, domainInput, { at })
      );
    },

    markRoleCleanupComplete(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.cleanup_complete',
        ['role', 'attemptId'],
        (run, domainInput, at) => markDeliveryPlanningRoleCleanupComplete(run, domainInput, { at })
      );
    },

    markRoleCleanupRequired(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.cleanup_required',
        ['role', 'attemptId', 'error'],
        (run, domainInput, at) => markDeliveryPlanningRoleCleanupRequired(run, domainInput, { at })
      );
    },

    recoverRoleCleanup(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.cleanup_recover',
        ['role', 'attemptId', 'outcome', 'claimId'],
        (run, domainInput, at) => recoverDeliveryPlanningRoleCleanup(run, domainInput, { at })
      );
    },

    authorizeContinue(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.continue_authorize',
        ['kind', 'role', 'attemptId', 'claimId', 'cleanupRecoveryOutcome'],
        (run, domainInput, at, context) => authorizeDeliveryPlanningContinue(run, {
          ...domainInput,
          operationId: context.operationId,
          requestedStoreRevision: context.expectedStoreRevision,
          requestedRunRevision: context.expectedRunRevision
        }, { at })
      );
    },

    compileCandidate(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.candidate_compile',
        [],
        (run, domainInput, at) => compileDeliveryPlanningCandidate(run, domainInput, { at })
      );
    },

    claimApply(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.apply_claim',
        ['claimId', 'candidateDigest'],
        (run, domainInput, at) => claimDeliveryPlanningApply(run, domainInput, { at })
      );
    },

    markApplied(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.applied',
        ['claimId', 'candidateDigest', 'appliedPlanRevision', 'appliedPlanDigest'],
        (run, domainInput, at) => markDeliveryPlanningApplied(run, domainInput, { at })
      );
    },

    markApplyReconcileRequired(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.apply_reconcile',
        ['claimId', 'error'],
        (run, domainInput, at) => markDeliveryPlanningApplyReconcileRequired(run, domainInput, { at })
      );
    },

    abandonApply(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.apply_abandon',
        ['claimId', 'candidateDigest', 'observation', 'reason'],
        (run, domainInput, at) => abandonDeliveryPlanningApply(run, domainInput, { at })
      );
    },

    markOffCourse(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.off_course',
        ['reason'],
        (run, domainInput, at) => markDeliveryPlanningRunOffCourse(run, domainInput, { at })
      );
    },

    cancel(idValue, input) {
      return performMutation(
        idValue,
        input,
        'planning_run.cancel',
        ['operatorConfirmed', 'reason'],
        (run, domainInput, at) => cancelDeliveryPlanningRun(run, domainInput, { at })
      );
    }
  });

  return Object.freeze(repository);
}
