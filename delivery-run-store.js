import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, canonicalSha256 } from './delivery-plan.js';
import {
  abortDeliveryRun,
  captureDeliveryRunImplementation,
  createDeliveryRun,
  linkDeliveryRunMission,
  markDeliveryRunMissionReconcileRequired,
  markDeliveryRunOffCourse,
  recordDeliveryRunVerification,
  validateDeliveryRun
} from './delivery-run.js';
import {
  atomicJsonReplacementCommitted,
  ensurePrivateDirectory,
  writeJsonAtomic
} from './durable-json.js';

export const DELIVERY_RUN_STORE_VERSION = 1;

const MAX_RUNS = 64;
const MAX_OPERATIONS = 512;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const MAX_RUN_BYTES = 512 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_SUMMARY_ITEMS = 64;
const DEFAULT_ACTIVE_LIMIT = 40;
const DEFAULT_RECENT_LIMIT = 20;
const RUN_ID_PATTERN = /^run-[a-z0-9][a-z0-9-]{7,63}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TERMINAL_CONDITIONS = new Set(['aborted', 'verified']);
const ACTIONS = new Set([
  'run.create',
  'run.mission_link',
  'run.mission_reconcile',
  'run.implementation_capture',
  'run.verification_record',
  'run.off_course',
  'run.abort'
]);

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
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw storeError(code);
}

function clone(value) {
  return structuredClone(value);
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function validTimestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return typeof value === 'string' && value.length > 0 && Number.isFinite(parsed) && value === new Date(parsed).toISOString();
}

function timestamp(value) {
  const result = value instanceof Date ? value.toISOString() : String(value ?? '');
  if (!validTimestamp(result)) throw storeError('delivery_run_store_now_invalid');
  return result;
}

function strictRun(value, code = 'delivery_run_store_run_invalid') {
  let validated;
  try {
    validated = validateDeliveryRun(value);
    if (canonicalJson(validated) !== canonicalJson(value)) throw storeError(code);
  } catch (cause) {
    if (cause?.code === code) throw cause;
    throw storeError(code, { cause });
  }
  if (byteLength(validated) > MAX_RUN_BYTES) throw storeError('delivery_run_store_run_too_large');
  return validated;
}

function operationId(value) {
  const result = String(value ?? '').trim();
  if (!OPERATION_ID_PATTERN.test(result)) throw storeError('delivery_run_store_operation_id_invalid');
  return result;
}

function runId(value) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!RUN_ID_PATTERN.test(result)) throw storeError('delivery_run_store_run_id_invalid');
  return result;
}

function requestedRevision(value, field, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) throw storeError(`delivery_run_store_${field}_invalid`);
  return value;
}

function requestSnapshot(value) {
  let serialized;
  try {
    serialized = canonicalJson(value);
  } catch (cause) {
    throw storeError('delivery_run_store_request_invalid', { cause });
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) throw storeError('delivery_run_store_request_too_large');
  return { value: JSON.parse(serialized), digest: canonicalSha256(value) };
}

function runSummary(run) {
  return {
    id: run.id,
    revision: run.revision,
    planId: run.planId,
    planDigest: run.planDigest,
    condition: run.condition,
    deliveryLevel: run.delivery.level,
    taskCount: run.tasks.length,
    completedTaskCount: run.tasks.filter((task) => task.state === 'verified').length,
    updatedAt: run.updatedAt
  };
}

function normalizedLimit(value, fallback, field) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_SUMMARY_ITEMS) {
    throw storeError(`delivery_run_store_${field}_invalid`);
  }
  return result;
}

function assertStoreRevision(store, expected) {
  if (store.revision !== expected) {
    throw storeError('delivery_run_store_revision_conflict', {
      currentStoreRevision: store.revision,
      expectedStoreRevision: expected
    });
  }
}

function assertRunRevision(run, expected) {
  if (run.revision !== expected) {
    throw storeError('delivery_run_store_run_revision_conflict', {
      runId: run.id,
      currentRunRevision: run.revision,
      expectedRunRevision: expected
    });
  }
}

function assertCapacity(store, { createsRun = false } = {}) {
  if (store.operations.length >= MAX_OPERATIONS) throw storeError('delivery_run_store_operation_limit_reached');
  if (createsRun && store.runs.length >= MAX_RUNS) throw storeError('delivery_run_store_run_limit_reached');
}

function assertChronology(store, at) {
  const latest = store.operations.at(-1)?.at;
  if (latest && Date.parse(at) < Date.parse(latest)) throw storeError('delivery_run_store_clock_regressed');
}

function operationReplay(store, id, action, digest) {
  const operation = store.operations.find((candidate) => candidate.id === id);
  if (!operation) return null;
  if (operation.action !== action || operation.requestDigest !== digest) {
    throw storeError('delivery_run_store_operation_conflict', { operationId: id, originalAction: operation.action });
  }
  return { replayed: true, ...clone(operation.result) };
}

function nextStore(store, { id, action, requestDigest, at, run }) {
  const revision = store.revision + 1;
  const result = { storeRevision: revision, run: clone(run) };
  const next = {
    version: DELIVERY_RUN_STORE_VERSION,
    revision,
    runs: store.runs.some((candidate) => candidate.id === run.id)
      ? store.runs.map((candidate) => candidate.id === run.id ? clone(run) : candidate)
      : [...store.runs, clone(run)],
    operations: [...store.operations, { id, action, requestDigest, at, result }]
  };
  return { store: validateDeliveryRunStore(next), result };
}

function validateOperation(operation, index, previousByRun, runIds) {
  exactKeys(operation, ['id', 'action', 'requestDigest', 'at', 'result'], 'delivery_run_store_operation_invalid');
  if (
    !OPERATION_ID_PATTERN.test(operation.id) ||
    !ACTIONS.has(operation.action) ||
    !SHA256_PATTERN.test(operation.requestDigest) ||
    !validTimestamp(operation.at)
  ) throw storeError('delivery_run_store_operation_invalid');
  exactKeys(operation.result, ['storeRevision', 'run'], 'delivery_run_store_operation_result_invalid');
  if (operation.result.storeRevision !== index + 1) throw storeError('delivery_run_store_operation_revision_invalid');
  const snapshot = strictRun(operation.result.run, 'delivery_run_store_operation_run_invalid');
  if (!runIds.has(snapshot.id)) throw storeError('delivery_run_store_operation_run_unknown');
  const previous = previousByRun.get(snapshot.id);
  if (operation.action === 'run.create') {
    if (
      previous ||
      snapshot.revision !== 1 ||
      snapshot.condition !== 'preparing' ||
      snapshot.abort !== null
    ) throw storeError('delivery_run_store_operation_lifecycle_invalid');
  } else {
    if (!previous || snapshot.revision !== previous.revision + 1 || snapshot.createdAt !== previous.createdAt) {
      throw storeError('delivery_run_store_operation_lifecycle_invalid');
    }
    if (
      snapshot.planId !== previous.planId ||
      snapshot.planRevision !== previous.planRevision ||
      snapshot.planDigest !== previous.planDigest ||
      snapshot.workspace !== previous.workspace ||
      canonicalJson(snapshot.startBaseline) !== canonicalJson(previous.startBaseline) ||
      snapshot.tasks.length !== previous.tasks.length ||
      snapshot.tasks.some((task, taskIndex) => (
        task.stepId !== previous.tasks[taskIndex].stepId ||
        task.stepDigest !== previous.tasks[taskIndex].stepDigest ||
        task.missionBindingKey !== previous.tasks[taskIndex].missionBindingKey ||
        task.missionDefinitionDigest !== previous.tasks[taskIndex].missionDefinitionDigest ||
        canonicalJson(task.acceptanceIds) !== canonicalJson(previous.tasks[taskIndex].acceptanceIds) ||
        canonicalJson(task.allowedPaths) !== canonicalJson(previous.tasks[taskIndex].allowedPaths)
      ))
    ) throw storeError('delivery_run_store_plan_binding_changed');
    if (operation.action === 'run.abort') {
      if (
        snapshot.condition !== 'aborted' ||
        snapshot.abort?.fromCondition !== previous.condition ||
        snapshot.abort?.abortedAt !== operation.at ||
        previous.condition === 'aborted'
      ) throw storeError('delivery_run_store_operation_lifecycle_invalid');
    } else if (snapshot.condition === 'aborted' || previous.condition === 'aborted') {
      throw storeError('delivery_run_store_operation_lifecycle_invalid');
    }
  }
  previousByRun.set(snapshot.id, snapshot);
  return { ...operation, result: { storeRevision: operation.result.storeRevision, run: snapshot } };
}

export function emptyDeliveryRunStore() {
  return { version: DELIVERY_RUN_STORE_VERSION, revision: 0, runs: [], operations: [] };
}

export function validateDeliveryRunStore(value) {
  exactKeys(value, ['version', 'revision', 'runs', 'operations'], 'delivery_run_store_shape_invalid');
  if (value.version !== DELIVERY_RUN_STORE_VERSION) throw storeError('delivery_run_store_version_unsupported');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw storeError('delivery_run_store_revision_invalid');
  if (!Array.isArray(value.runs) || value.runs.length > MAX_RUNS) throw storeError('delivery_run_store_runs_invalid');
  if (!Array.isArray(value.operations) || value.operations.length > MAX_OPERATIONS) {
    throw storeError('delivery_run_store_operations_invalid');
  }
  if (value.revision !== value.operations.length) throw storeError('delivery_run_store_revision_invalid');
  const runIds = new Set();
  const runs = value.runs.map((candidate) => {
    const run = strictRun(candidate);
    if (runIds.has(run.id)) throw storeError('delivery_run_store_run_duplicate');
    runIds.add(run.id);
    return run;
  });
  const operationIds = new Set();
  const previousByRun = new Map();
  let previousAt = null;
  const operations = value.operations.map((candidate, index) => {
    if (plainObject(candidate) && operationIds.has(candidate.id)) throw storeError('delivery_run_store_operation_duplicate');
    const operation = validateOperation(candidate, index, previousByRun, runIds);
    if (previousAt && Date.parse(operation.at) < Date.parse(previousAt)) {
      throw storeError('delivery_run_store_operation_chronology_invalid');
    }
    previousAt = operation.at;
    operationIds.add(operation.id);
    return operation;
  });
  if (previousByRun.size !== runs.length) throw storeError('delivery_run_store_history_incomplete');
  for (const run of runs) {
    if (canonicalJson(previousByRun.get(run.id)) !== canonicalJson(run)) {
      throw storeError('delivery_run_store_current_run_mismatch');
    }
  }
  const store = { version: value.version, revision: value.revision, runs, operations };
  if (byteLength(store) > MAX_STORE_BYTES) throw storeError('delivery_run_store_too_large');
  return store;
}

function summaryFromValidatedStore(store, { activeLimit = DEFAULT_ACTIVE_LIMIT, recentLimit = DEFAULT_RECENT_LIMIT } = {}) {
  const activeMax = normalizedLimit(activeLimit, DEFAULT_ACTIVE_LIMIT, 'active_limit');
  const recentMax = normalizedLimit(recentLimit, DEFAULT_RECENT_LIMIT, 'recent_limit');
  const newestFirst = (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id);
  const active = store.runs.filter((run) => !TERMINAL_CONDITIONS.has(run.condition)).sort(newestFirst);
  const recent = store.runs.filter((run) => TERMINAL_CONDITIONS.has(run.condition)).sort(newestFirst);
  return {
    version: store.version,
    revision: store.revision,
    counts: {
      total: store.runs.length,
      active: active.length,
      verified: recent.filter((run) => run.condition === 'verified').length,
      aborted: recent.filter((run) => run.condition === 'aborted').length,
      needsAttention: active.filter((run) => ['blocked', 'off_course', 'reconcile_required'].includes(run.condition)).length,
      operations: store.operations.length
    },
    active: active.slice(0, activeMax).map(runSummary),
    recent: recent.slice(0, recentMax).map(runSummary)
  };
}

export function deliveryRunStoreSummary(value, options = {}) {
  return summaryFromValidatedStore(validateDeliveryRunStore(value), options);
}

async function readStoreFile(filePath) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ELOOP') throw storeError('delivery_run_store_symlink_rejected', { cause: error });
    throw error;
  }
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.nlink !== 1) throw storeError('delivery_run_store_file_invalid');
    if (typeof process.getuid === 'function' && details.uid !== process.getuid()) throw storeError('delivery_run_store_owner_invalid');
    if ((details.mode & 0o077) !== 0) throw storeError('delivery_run_store_permissions_insecure');
    if ((details.mode & 0o777) !== 0o600) await handle.chmod(0o600);
    if (details.size > MAX_STORE_BYTES) throw storeError('delivery_run_store_too_large');
    let parsed;
    try {
      parsed = JSON.parse(await handle.readFile('utf8'));
    } catch (cause) {
      throw storeError('delivery_run_store_json_invalid', { cause });
    }
    return validateDeliveryRunStore(parsed);
  } finally {
    await handle.close();
  }
}

export function createDeliveryRunRepository({
  filePath,
  now = () => new Date().toISOString(),
  idFactory = () => `run-${randomBytes(12).toString('hex')}`,
  writeAtomic = writeJsonAtomic
} = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new TypeError('filePath must be absolute');
  if (path.dirname(filePath) === path.parse(filePath).root) throw new TypeError('filePath must use a dedicated parent directory');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof idFactory !== 'function') throw new TypeError('idFactory must be a function');
  if (typeof writeAtomic !== 'function') throw new TypeError('writeAtomic must be a function');
  let store = null;
  let initialization = null;
  let mutationTail = Promise.resolve();
  let poisoned = null;

  function poisonAfterCommittedWrite(writeError, cause) {
    if (!poisoned) {
      poisoned = storeError('delivery_run_store_persistence_uncertain', { cause, writeError });
    }
    store = null;
    return poisoned;
  }

  async function recoverCommittedWrite(validated, writeError) {
    let recovered;
    try {
      recovered = await readStoreFile(filePath);
      if (canonicalJson(recovered) !== canonicalJson(validated)) {
        throw storeError('delivery_run_store_post_commit_mismatch');
      }
    } catch (cause) {
      throw poisonAfterCommittedWrite(writeError, cause);
    }
    store = recovered;
  }

  async function persist(next) {
    const validated = validateDeliveryRunStore(next);
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
      store = emptyDeliveryRunStore();
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

  async function performMutation(idValue, input, action, inputKeys, requestValue, mutator) {
    let wanted;
    let id;
    let expectedStoreRevision;
    let expectedRunRevision;
    let request;
    try {
      wanted = runId(idValue);
      if (!plainObject(input)) throw storeError('delivery_run_store_mutation_request_invalid');
      const mutationKeys = typeof inputKeys === 'function' ? inputKeys(input) : inputKeys;
      exactKeys(
        input,
        ['operationId', 'expectedStoreRevision', 'expectedRunRevision', ...mutationKeys],
        'delivery_run_store_mutation_request_invalid'
      );
      id = operationId(input.operationId);
      expectedStoreRevision = requestedRevision(input.expectedStoreRevision, 'expected_store_revision', 0);
      expectedRunRevision = requestedRevision(input.expectedRunRevision, 'expected_run_revision', 1);
      request = requestSnapshot({ runId: wanted, expectedStoreRevision, expectedRunRevision, ...requestValue(input, id) });
    } catch (error) {
      return Promise.reject(error);
    }
    return mutate(async (current) => {
      const replay = operationReplay(current, id, action, request.digest);
      if (replay) return replay;
      assertStoreRevision(current, expectedStoreRevision);
      assertCapacity(current);
      const currentRun = current.runs.find((candidate) => candidate.id === wanted);
      if (!currentRun) throw storeError('delivery_run_store_run_not_found', { runId: wanted });
      assertRunRevision(currentRun, expectedRunRevision);
      const at = timestamp(now());
      assertChronology(current, at);
      let nextRun;
      try {
        nextRun = mutator(currentRun, request.value, at);
      } catch (cause) {
        throw storeError(cause?.code || cause?.message || 'delivery_run_store_mutation_invalid', { cause });
      }
      const next = nextStore(current, { id, action, requestDigest: request.digest, at, run: nextRun });
      await persist(next.store);
      return { replayed: false, ...clone(next.result) };
    });
  }

  return Object.freeze({
    async initialize() {
      return deliveryRunStoreSummary(await ensureInitialized());
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
      if (typeof includeHistory !== 'boolean') return Promise.reject(storeError('delivery_run_store_history_option_invalid'));
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
        return Promise.reject(storeError('delivery_run_store_create_request_invalid'));
      }
      let id;
      let expectedStoreRevision;
      let request;
      try {
        exactKeys(
          input,
          ['operationId', 'expectedStoreRevision', 'run'],
          'delivery_run_store_create_request_invalid'
        );
        id = operationId(input.operationId);
        expectedStoreRevision = requestedRevision(input.expectedStoreRevision, 'expected_store_revision', 0);
        request = requestSnapshot({ expectedStoreRevision, run: input.run });
      } catch (error) {
        return Promise.reject(error);
      }
      return mutate(async (current) => {
        const replay = operationReplay(current, id, 'run.create', request.digest);
        if (replay) return replay;
        assertStoreRevision(current, expectedStoreRevision);
        assertCapacity(current, { createsRun: true });
        const at = timestamp(now());
        assertChronology(current, at);
        const candidateId = runId(request.value.run.id || idFactory('run'));
        if (current.runs.some((candidate) => candidate.id === candidateId)) {
          throw storeError('delivery_run_store_run_duplicate', { runId: candidateId });
        }
        let run;
        try {
          run = createDeliveryRun({ ...request.value.run, id: candidateId }, { at });
        } catch (cause) {
          throw storeError(cause?.code || cause?.message || 'delivery_run_store_run_invalid', { cause });
        }
        const duplicateBinding = current.runs.find((candidate) => (
          candidate.planId === run.planId && candidate.planDigest === run.planDigest
        ));
        if (duplicateBinding) {
          throw storeError('delivery_run_store_plan_binding_duplicate', { runId: duplicateBinding.id });
        }
        const next = nextStore(current, { id, action: 'run.create', requestDigest: request.digest, at, run });
        await persist(next.store);
        return { replayed: false, ...clone(next.result) };
      });
    },

    linkMission(idValue, input) {
      return performMutation(
        idValue,
        input,
        'run.mission_link',
        ['stepId', 'bindingKey', 'missionId'],
        (source) => ({ stepId: source.stepId, bindingKey: source.bindingKey, missionId: source.missionId }),
        (run, request, at) => linkDeliveryRunMission(run, {
          stepId: request.stepId,
          bindingKey: request.bindingKey,
          missionId: request.missionId
        }, { at })
      );
    },

    markMissionEnsureReconcileRequired(idValue, input) {
      return performMutation(
        idValue,
        input,
        'run.mission_reconcile',
        ['stepId', 'bindingKey', 'error'],
        (source) => ({ stepId: source.stepId, bindingKey: source.bindingKey, error: source.error }),
        (run, request, at) => markDeliveryRunMissionReconcileRequired(run, {
          stepId: request.stepId,
          bindingKey: request.bindingKey,
          error: request.error
        }, { at })
      );
    },

    captureImplementation(idValue, input) {
      return performMutation(
        idValue,
        input,
        'run.implementation_capture',
        ['stepId', 'missionId', 'baseline', 'evidence'],
        (source) => ({
          stepId: source.stepId,
          missionId: source.missionId,
          baseline: source.baseline,
          evidence: source.evidence
        }),
        (run, request, at) => captureDeliveryRunImplementation(run, {
          stepId: request.stepId,
          missionId: request.missionId,
          baseline: request.baseline,
          evidence: request.evidence
        }, { at })
      );
    },

    recordVerification(idValue, input) {
      return performMutation(
        idValue,
        input,
        'run.verification_record',
        (source) => [
          ...(Object.hasOwn(source, 'verificationId') ? ['verificationId'] : []),
          'stepId',
          'missionId',
          'baseline',
          'criteria',
          'evidence',
          'evidenceIds',
          'note'
        ],
        (source, id) => ({
          id: Object.hasOwn(source, 'verificationId')
            ? source.verificationId
            : `verification-${canonicalSha256({ operationId: id }).slice(0, 32)}`,
          stepId: source.stepId,
          missionId: source.missionId,
          baseline: source.baseline,
          criteria: source.criteria,
          evidence: source.evidence,
          evidenceIds: source.evidenceIds,
          note: source.note
        }),
        (run, request, at) => recordDeliveryRunVerification(run, {
          id: request.id,
          stepId: request.stepId,
          missionId: request.missionId,
          baseline: request.baseline,
          criteria: request.criteria,
          evidence: request.evidence,
          evidenceIds: request.evidenceIds,
          note: request.note
        }, { at })
      );
    },

    markOffCourse(idValue, input) {
      return performMutation(
        idValue,
        input,
        'run.off_course',
        ['stepId', 'reason', 'evidence'],
        (source) => ({ stepId: source.stepId, reason: source.reason, evidence: source.evidence }),
        (run, request, at) => markDeliveryRunOffCourse(run, {
          stepId: request.stepId,
          reason: request.reason,
          evidence: request.evidence
        }, { at })
      );
    },

    abort(idValue, input) {
      return performMutation(
        idValue,
        input,
        'run.abort',
        ['operatorConfirmed', 'reason', 'evidence'],
        (source) => ({
          operatorConfirmed: source.operatorConfirmed,
          reason: source.reason,
          evidence: source.evidence
        }),
        (run, request, at) => abortDeliveryRun(run, {
          operatorConfirmed: request.operatorConfirmed,
          reason: request.reason,
          evidence: Array.isArray(request.evidence)
            ? request.evidence.map((item) => ({ ...item, createdAt: at }))
            : request.evidence
        }, { at })
      );
    }
  });
}
