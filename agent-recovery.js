import path from 'node:path';

const STORE_VERSION = 1;
const MAX_RECOVERY_SLOTS = 64;
const SESSION_PATTERN = /^codex(?:[\w-]*)?$/;
const PLANNING_SESSION_PATTERN = /^codex-planning-/;
const ROLLOUT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL_PATTERN = /^(?:|[A-Za-z0-9._:-]{1,128})$/;
const REASONING_EFFORTS = new Set(['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const TURN_STATES = new Set(['active', 'idle', 'unknown']);
const RECOVERY_ERRORS = new Set([
  '',
  'agent_recovery_dead_pane',
  'agent_recovery_input_failed',
  'agent_recovery_interrupted_turn',
  'agent_recovery_isolation_unavailable',
  'agent_recovery_memory_gate',
  'agent_recovery_metrics_unavailable',
  'agent_recovery_pressure_gate',
  'agent_recovery_session_conflict',
  'agent_recovery_spawn_failed',
  'agent_recovery_swap_gate',
  'agent_recovery_turn_state_unverified',
  'agent_recovery_unsupported_pane',
  'agent_recovery_workspace_unavailable'
]);

function isoTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function recoveryStateError() {
  return new Error('agent_recovery_state_invalid');
}

function validOptionalTimestamp(value) {
  return value === null || Boolean(isoTimestamp(value));
}

function validSlot(session, slot) {
  return Boolean(
    SESSION_PATTERN.test(session) &&
    slot && typeof slot === 'object' && !Array.isArray(slot) &&
    slot.session === session &&
    typeof slot.workspace === 'string' && path.isAbsolute(slot.workspace) && slot.workspace.length <= 4096 &&
    typeof slot.rolloutId === 'string' && (slot.rolloutId === '' || ROLLOUT_ID_PATTERN.test(slot.rolloutId)) &&
    typeof slot.model === 'string' && MODEL_PATTERN.test(slot.model) &&
    typeof slot.reasoning === 'string' && REASONING_EFFORTS.has(slot.reasoning) &&
    (slot.rootInteractive === undefined || typeof slot.rootInteractive === 'boolean') &&
    (slot.turnState === undefined || TURN_STATES.has(slot.turnState)) &&
    typeof slot.autoRecover === 'boolean' &&
    Boolean(isoTimestamp(slot.registeredAt)) &&
    Boolean(isoTimestamp(slot.lastObservedAt)) &&
    validOptionalTimestamp(slot.lastAttemptAt) &&
    validOptionalTimestamp(slot.lastRecoveredAt) &&
    Number.isSafeInteger(slot.attemptCount) && slot.attemptCount >= 0 && slot.attemptCount <= 1000 &&
    typeof slot.lastError === 'string' && RECOVERY_ERRORS.has(slot.lastError)
  );
}

export function agentRecoverySessionEligible(session) {
  const value = String(session || '');
  return SESSION_PATTERN.test(value) && !PLANNING_SESSION_PATTERN.test(value);
}

export function agentRecoveryTurnStateError(slot) {
  if (slot?.turnState === 'idle') return '';
  return slot?.turnState === 'active'
    ? 'agent_recovery_interrupted_turn'
    : 'agent_recovery_turn_state_unverified';
}

function cloneStore(store) {
  return {
    ...store,
    slots: Object.fromEntries(Object.entries(store.slots).map(([session, slot]) => [session, { ...slot }]))
  };
}

function updatedStore(store, at) {
  const next = cloneStore(store);
  next.revision += 1;
  next.updatedAt = at;
  return next;
}

export function createAgentRecoveryStore(at = new Date().toISOString()) {
  const timestamp = isoTimestamp(at);
  if (!timestamp) throw recoveryStateError();
  return {
    version: STORE_VERSION,
    revision: 0,
    updatedAt: timestamp,
    slots: {}
  };
}

export function validateAgentRecoveryStore(store) {
  if (!store || typeof store !== 'object' || Array.isArray(store) || store.version !== STORE_VERSION) {
    throw recoveryStateError();
  }
  const entries = store.slots && typeof store.slots === 'object' && !Array.isArray(store.slots)
    ? Object.entries(store.slots)
    : [];
  if (
    !Number.isSafeInteger(store.revision) || store.revision < 0 ||
    !isoTimestamp(store.updatedAt) ||
    entries.length > MAX_RECOVERY_SLOTS ||
    entries.some(([session, slot]) => !validSlot(session, slot))
  ) {
    throw recoveryStateError();
  }
  return store;
}

export function rolloutIdFromPath(filePath) {
  const match = path.basename(String(filePath || '')).match(/(?:^|[-_])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
  return match?.[1] || '';
}

export function registerAgentRecoverySlot(store, input, at = new Date().toISOString()) {
  validateAgentRecoveryStore(store);
  const timestamp = isoTimestamp(at);
  const session = String(input?.session || '');
  const workspace = String(input?.workspace || '');
  const rolloutId = String(input?.rolloutId || '');
  const model = String(input?.model || '');
  const reasoning = String(input?.reasoning || '');
  const requestedTurnState = input?.turnState;
  if (
    !timestamp || !agentRecoverySessionEligible(session) || !path.isAbsolute(workspace) || workspace.length > 4096 ||
    (rolloutId && !ROLLOUT_ID_PATTERN.test(rolloutId)) || !MODEL_PATTERN.test(model) || !REASONING_EFFORTS.has(reasoning) ||
    (requestedTurnState !== undefined && !TURN_STATES.has(requestedTurnState))
  ) {
    throw recoveryStateError();
  }
  const existing = store.slots[session] || null;
  if (!existing && Object.keys(store.slots).length >= MAX_RECOVERY_SLOTS) throw recoveryStateError();
  const next = updatedStore(store, timestamp);
  next.slots[session] = {
    session,
    workspace,
    rolloutId: rolloutId || existing?.rolloutId || '',
    model: model || existing?.model || '',
    reasoning: reasoning || existing?.reasoning || '',
    rootInteractive: input?.rootInteractive === true,
    turnState: requestedTurnState ?? existing?.turnState ?? 'unknown',
    autoRecover: typeof input?.autoRecover === 'boolean' ? input.autoRecover : existing?.autoRecover ?? true,
    registeredAt: existing?.registeredAt || timestamp,
    lastObservedAt: timestamp,
    lastAttemptAt: existing?.lastAttemptAt || null,
    lastRecoveredAt: existing?.lastRecoveredAt || null,
    attemptCount: 0,
    lastError: ''
  };
  return validateAgentRecoveryStore(next);
}

export function setAgentRecoveryEnabled(store, session, enabled, at = new Date().toISOString()) {
  validateAgentRecoveryStore(store);
  const timestamp = isoTimestamp(at);
  const existing = store.slots[String(session || '')];
  if (!timestamp || !existing || typeof enabled !== 'boolean') throw recoveryStateError();
  const next = updatedStore(store, timestamp);
  next.slots[session] = {
    ...existing,
    autoRecover: enabled,
    lastError: enabled ? existing.lastError : '',
    attemptCount: enabled ? existing.attemptCount : 0
  };
  return validateAgentRecoveryStore(next);
}

export function markAgentRecoveryAttempt(store, session, error = '', at = new Date().toISOString()) {
  validateAgentRecoveryStore(store);
  const timestamp = isoTimestamp(at);
  const existing = store.slots[String(session || '')];
  if (!timestamp || !existing || !RECOVERY_ERRORS.has(error)) throw recoveryStateError();
  const next = updatedStore(store, timestamp);
  next.slots[session] = {
    ...existing,
    lastAttemptAt: timestamp,
    attemptCount: Math.min(1000, existing.attemptCount + 1),
    lastError: error
  };
  return validateAgentRecoveryStore(next);
}

export function markAgentRecoveryResult(store, session, { ok, error = '' }, at = new Date().toISOString()) {
  validateAgentRecoveryStore(store);
  const timestamp = isoTimestamp(at);
  const existing = store.slots[String(session || '')];
  if (!timestamp || !existing || typeof ok !== 'boolean' || !RECOVERY_ERRORS.has(error) || (ok && error)) {
    throw recoveryStateError();
  }
  const next = updatedStore(store, timestamp);
  next.slots[session] = {
    ...existing,
    lastRecoveredAt: ok ? timestamp : existing.lastRecoveredAt,
    attemptCount: ok ? 0 : existing.attemptCount,
    lastError: ok ? '' : error
  };
  return validateAgentRecoveryStore(next);
}

export function agentRecoveryCandidates(store, liveSessions, {
  at = new Date().toISOString(),
  retryAfterMs = 60_000
} = {}) {
  validateAgentRecoveryStore(store);
  const nowMs = Date.parse(isoTimestamp(at));
  if (!Number.isFinite(nowMs) || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) throw recoveryStateError();
  const live = liveSessions instanceof Set ? liveSessions : new Set(liveSessions || []);
  return Object.values(store.slots)
    .filter((slot) => {
      if (
        !agentRecoverySessionEligible(slot.session)
        || !slot.autoRecover
        || !slot.rolloutId
        || slot.rootInteractive !== true
        || live.has(slot.session)
      ) return false;
      const attemptedAt = slot.lastAttemptAt ? Date.parse(slot.lastAttemptAt) : 0;
      return !attemptedAt || nowMs - attemptedAt >= retryAfterMs;
    })
    .sort((left, right) => {
      const observedDifference = Date.parse(right.lastObservedAt) - Date.parse(left.lastObservedAt);
      return observedDifference || left.session.localeCompare(right.session);
    })
    .map((slot) => ({ ...slot }));
}

function kibibyteMetrics(text) {
  const metrics = new Map();
  for (const line of String(text || '').split('\n')) {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB\s*$/);
    if (match) metrics.set(match[1], Number(match[2]) * 1024);
  }
  return metrics;
}

export function agentRecoveryResourceGate({
  memoryInfo,
  memoryPressure,
  minimumAvailableRatio = 0.35,
  maximumSwapUsedRatio = 0.75,
  maximumFullPressureAvg10 = 10
} = {}) {
  const metrics = kibibyteMetrics(memoryInfo);
  const total = metrics.get('MemTotal');
  const available = metrics.get('MemAvailable');
  const swapTotal = metrics.get('SwapTotal');
  const swapFree = metrics.get('SwapFree');
  const pressureMatch = String(memoryPressure || '').match(/^full\s+[^\n]*\bavg10=([\d.]+)/m);
  const fullAvg10 = pressureMatch ? Number(pressureMatch[1]) : NaN;
  if (
    !Number.isFinite(total) || total <= 0 || !Number.isFinite(available) || available < 0 ||
    !Number.isFinite(swapTotal) || swapTotal < 0 || !Number.isFinite(swapFree) || swapFree < 0 ||
    !Number.isFinite(fullAvg10)
  ) {
    return { ok: false, error: 'agent_recovery_metrics_unavailable' };
  }
  const availableRatio = Math.min(total, available) / total;
  const swapUsedRatio = swapTotal > 0 ? Math.max(0, swapTotal - Math.min(swapTotal, swapFree)) / swapTotal : 0;
  const detail = {
    availablePercent: Math.floor(availableRatio * 100),
    swapUsedPercent: Math.floor(swapUsedRatio * 100),
    fullPressureAvg10: fullAvg10
  };
  if (availableRatio < minimumAvailableRatio) return { ok: false, error: 'agent_recovery_memory_gate', ...detail };
  if (swapUsedRatio > maximumSwapUsedRatio) return { ok: false, error: 'agent_recovery_swap_gate', ...detail };
  if (fullAvg10 > maximumFullPressureAvg10) return { ok: false, error: 'agent_recovery_pressure_gate', ...detail };
  return { ok: true, ...detail };
}
