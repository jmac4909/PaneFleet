import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentRecoveryCandidates,
  agentRecoveryResourceGate,
  agentRecoverySessionEligible,
  agentRecoveryTurnStateError,
  createAgentRecoveryStore,
  markAgentRecoveryAttempt,
  markAgentRecoveryResult,
  registerAgentRecoverySlot,
  rolloutIdFromPath,
  setAgentRecoveryEnabled,
  validateAgentRecoveryStore
} from '../agent-recovery.js';

const AT = '2026-08-14T15:00:00.000Z';
const NEXT = '2026-08-14T15:01:01.000Z';
const ROLLOUT = '019f7b51-990a-7330-a5fc-85d0a2985c20';

function registeredStore() {
  return registerAgentRecoverySlot(createAgentRecoveryStore(AT), {
    session: 'codex-ag',
    workspace: '/srv/panefleet/agent-orchestrator',
    rolloutId: ROLLOUT,
    model: 'gpt-5.6-sol',
    reasoning: 'xhigh',
    rootInteractive: true,
    turnState: 'idle',
    autoRecover: true
  }, AT);
}

test('agent recovery registry preserves exact resumable identity without prompt text', () => {
  const store = registeredStore();
  assert.equal(store.revision, 1);
  assert.deepEqual(store.slots['codex-ag'], {
    session: 'codex-ag',
    workspace: '/srv/panefleet/agent-orchestrator',
    rolloutId: ROLLOUT,
    model: 'gpt-5.6-sol',
    reasoning: 'xhigh',
    rootInteractive: true,
    turnState: 'idle',
    autoRecover: true,
    registeredAt: AT,
    lastObservedAt: AT,
    lastAttemptAt: null,
    lastRecoveredAt: null,
    attemptCount: 0,
    lastError: ''
  });
  assert.doesNotMatch(JSON.stringify(store), /prompt|terminal capture/i);
  assert.equal(validateAgentRecoveryStore(store), store);
});

test('interrupted and legacy-unverified turns fail closed without losing exact identity', () => {
  const idle = registeredStore().slots['codex-ag'];
  assert.equal(agentRecoveryTurnStateError(idle), '');
  assert.equal(agentRecoveryTurnStateError({ ...idle, turnState: 'active' }), 'agent_recovery_interrupted_turn');

  const legacy = registeredStore();
  delete legacy.slots['codex-ag'].turnState;
  assert.equal(validateAgentRecoveryStore(legacy), legacy);
  assert.equal(agentRecoveryTurnStateError(legacy.slots['codex-ag']), 'agent_recovery_turn_state_unverified');

  const observed = registerAgentRecoverySlot(legacy, {
    session: 'codex-ag',
    workspace: idle.workspace,
    rolloutId: idle.rolloutId,
    rootInteractive: true,
    turnState: 'active'
  }, NEXT);
  assert.equal(observed.slots['codex-ag'].turnState, 'active');
  assert.equal(observed.slots['codex-ag'].rolloutId, ROLLOUT);
});

test('recovery candidates are exact, missing, enabled, cooldown-gated, and newest first', () => {
  let store = registeredStore();
  store = registerAgentRecoverySlot(store, {
    session: 'codex-job-search',
    workspace: '/srv/panefleet/job-search',
    rolloutId: '019f7035-e9d0-7271-9391-9ea3fc73c8be',
    rootInteractive: true
  }, '2026-08-14T15:00:30.000Z');
  store = registerAgentRecoverySlot(store, {
    session: 'codex-pending',
    workspace: '/srv/panefleet/pending',
    rolloutId: ''
  }, '2026-08-14T15:00:40.000Z');
  assert.deepEqual(
    agentRecoveryCandidates(store, new Set(), { at: NEXT }).map((slot) => slot.session),
    ['codex-job-search', 'codex-ag']
  );
  assert.deepEqual(
    agentRecoveryCandidates(store, new Set(['codex-job-search']), { at: NEXT }).map((slot) => slot.session),
    ['codex-ag']
  );
  store = markAgentRecoveryAttempt(store, 'codex-ag', 'agent_recovery_spawn_failed', NEXT);
  assert.deepEqual(
    agentRecoveryCandidates(store, new Set(), { at: NEXT }).map((slot) => slot.session),
    ['codex-job-search']
  );
  assert.deepEqual(
    agentRecoveryCandidates(store, new Set(), { at: '2026-08-14T15:02:02.000Z' }).map((slot) => slot.session),
    ['codex-job-search', 'codex-ag']
  );
});

test('planning workers are never registered or selected by generic recovery', () => {
  assert.equal(agentRecoverySessionEligible('codex-ag'), true);
  assert.equal(agentRecoverySessionEligible('codex-planning-deadbeef'), false);
  assert.throws(() => registerAgentRecoverySlot(createAgentRecoveryStore(AT), {
    session: 'codex-planning-deadbeef',
    workspace: '/srv/panefleet/agent-orchestrator',
    rolloutId: ROLLOUT
  }, AT), /agent_recovery_state_invalid/);

  const seeded = registeredStore();
  seeded.slots['codex-planning-deadbeef'] = {
    ...seeded.slots['codex-ag'],
    session: 'codex-planning-deadbeef'
  };
  delete seeded.slots['codex-ag'];
  assert.equal(validateAgentRecoveryStore(seeded), seeded);
  assert.deepEqual(agentRecoveryCandidates(seeded, new Set(), { at: NEXT }), []);
});

test('legacy and parented rollout slots can never become recovery candidates', () => {
  const legacy = registeredStore();
  delete legacy.slots['codex-ag'].rootInteractive;
  assert.equal(validateAgentRecoveryStore(legacy), legacy);
  assert.deepEqual(agentRecoveryCandidates(legacy, new Set(), { at: NEXT }), []);

  const parented = registerAgentRecoverySlot(createAgentRecoveryStore(AT), {
    session: 'codex-child',
    workspace: '/srv/panefleet/child',
    rolloutId: ROLLOUT,
    rootInteractive: false,
    autoRecover: true
  }, AT);
  assert.deepEqual(agentRecoveryCandidates(parented, new Set(), { at: NEXT }), []);
});

test('successful recovery clears attempts while an explicit stop disarms the slot', () => {
  let store = markAgentRecoveryAttempt(registeredStore(), 'codex-ag', '', NEXT);
  store = markAgentRecoveryResult(store, 'codex-ag', { ok: true }, '2026-08-14T15:01:05.000Z');
  assert.equal(store.slots['codex-ag'].attemptCount, 0);
  assert.equal(store.slots['codex-ag'].lastRecoveredAt, '2026-08-14T15:01:05.000Z');
  store = setAgentRecoveryEnabled(store, 'codex-ag', false, '2026-08-14T15:01:06.000Z');
  assert.equal(store.slots['codex-ag'].autoRecover, false);
  assert.deepEqual(agentRecoveryCandidates(store, new Set(), { at: '2026-08-14T16:00:00.000Z' }), []);
});

test('rollout id extraction accepts only exact Codex rollout filenames', () => {
  assert.equal(rolloutIdFromPath(`/tmp/rollout-2026-08-14T00-00-00-${ROLLOUT}.jsonl`), ROLLOUT);
  assert.equal(rolloutIdFromPath(`/tmp/${ROLLOUT}.jsonl`), ROLLOUT);
  assert.equal(rolloutIdFromPath(`/tmp/${ROLLOUT}.json`), '');
  assert.equal(rolloutIdFromPath('/tmp/../../not-a-rollout.jsonl'), '');
});

test('recovery resource gate fails closed across memory, swap, and PSI pressure', () => {
  const memoryInfo = [
    'MemTotal:        2000000 kB',
    'MemAvailable:    1000000 kB',
    'SwapTotal:       4000000 kB',
    'SwapFree:        3000000 kB'
  ].join('\n');
  assert.deepEqual(agentRecoveryResourceGate({
    memoryInfo,
    memoryPressure: 'some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.20 avg60=0.10 avg300=0.05 total=1'
  }), { ok: true, availablePercent: 50, swapUsedPercent: 25, fullPressureAvg10: 0.2 });
  assert.equal(agentRecoveryResourceGate({
    memoryInfo: memoryInfo.replace('1000000', '200000'),
    memoryPressure: 'full avg10=0.00 avg60=0.00 avg300=0.00 total=1'
  }).error, 'agent_recovery_memory_gate');
  assert.equal(agentRecoveryResourceGate({
    memoryInfo: memoryInfo.replace('3000000', '500000'),
    memoryPressure: 'full avg10=0.00 avg60=0.00 avg300=0.00 total=1'
  }).error, 'agent_recovery_swap_gate');
  assert.equal(agentRecoveryResourceGate({
    memoryInfo,
    memoryPressure: 'full avg10=12.50 avg60=4.00 avg300=1.00 total=1'
  }).error, 'agent_recovery_pressure_gate');
  assert.equal(agentRecoveryResourceGate({ memoryInfo: '', memoryPressure: '' }).error, 'agent_recovery_metrics_unavailable');
});

test('invalid recovery state is rejected rather than normalized', () => {
  assert.throws(() => createAgentRecoveryStore('not-a-time'), /agent_recovery_state_invalid/);
  assert.throws(() => validateAgentRecoveryStore(null), /agent_recovery_state_invalid/);
  assert.throws(() => registerAgentRecoverySlot(createAgentRecoveryStore(AT), {
    session: '../codex',
    workspace: '/tmp',
    rolloutId: ROLLOUT
  }, AT), /agent_recovery_state_invalid/);
  const invalid = registeredStore();
  invalid.slots['codex-ag'].workspace = 'relative/path';
  assert.throws(() => validateAgentRecoveryStore(invalid), /agent_recovery_state_invalid/);

  const store = registeredStore();
  assert.throws(
    () => markAgentRecoveryResult(store, 'codex-ag', { ok: true, error: 'agent_recovery_spawn_failed' }, NEXT),
    /agent_recovery_state_invalid/
  );
  assert.throws(
    () => agentRecoveryCandidates(store, new Set(), { at: 'not-a-time' }),
    /agent_recovery_state_invalid/
  );
});
