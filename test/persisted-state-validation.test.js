import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');

function emptyMissionQueue() {
  return { version: 1, revision: 0, jobs: [], events: [] };
}

function emptyPromptQueue() {
  return { version: 1, revision: 0, items: [], schedules: [] };
}

function validPromptItem(overrides = {}) {
  const timestamp = '2026-07-16T00:00:00.000Z';
  return {
    id: 'prompt-position-one',
    revision: 1,
    status: 'queued',
    position: 1,
    session: 'codex-worker',
    sessionCreatedAt: timestamp,
    paneId: 'codex-worker:0.0',
    tmuxPaneId: '%77',
    panePid: 4100,
    text: 'Synthetic durable prompt.',
    blocker: '',
    deliveryStage: 'queued',
    createdAt: timestamp,
    updatedAt: timestamp,
    claimedAt: null,
    sentAt: null,
    completionSummary: '',
    completionSnapshot: '',
    summaryState: 'pending',
    completedAt: null,
    ...overrides
  };
}

function validSentPromptItem(overrides = {}) {
  const timestamp = '2026-07-16T00:00:00.000Z';
  return validPromptItem({
    status: 'sent',
    attemptId: 'queue-attempt-lifecycle-12345678',
    deliveryStage: 'accepted',
    claimedAt: timestamp,
    sentAt: timestamp,
    ...overrides
  });
}

function validPromptSchedule(overrides = {}) {
  const timestamp = '2026-07-16T00:00:00.000Z';
  return {
    id: 'schedule-integrity-12345678',
    revision: 1,
    enabled: true,
    session: 'codex-worker',
    sessionCreatedAt: timestamp,
    paneId: 'codex-worker:0.0',
    tmuxPaneId: '%77',
    panePid: 4100,
    text: 'Synthetic recurring prompt.',
    cron: '*/5 * * * *',
    nextRunAt: '2026-07-16T00:05:00.000Z',
    lastRunAt: timestamp,
    lastScheduledFor: timestamp,
    lastOutcome: 'queued',
    runCount: 1,
    occurrenceCount: 1,
    coalescedCount: 0,
    skippedCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function validMissionJob(workspace, overrides = {}) {
  const timestamp = '2026-07-16T00:00:00.000Z';
  return {
    id: 'mission-integrity-12345678',
    revision: 1,
    title: 'Synthetic durable mission',
    goal: 'Prove durable mission state remains internally consistent.',
    verificationCriteria: 'Focused isolated validation passes.',
    priority: 'normal',
    status: 'ready',
    position: 0,
    workspace,
    assignedSession: '',
    assignedSessionCreatedAt: null,
    assignedPaneId: '',
    assignedTmuxPaneId: null,
    assignedPanePid: null,
    activeAttempt: null,
    attempts: [],
    outcomes: [],
    blocker: '',
    resultSummary: '',
    verification: { status: 'pending', note: '', at: null },
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    needsYouAt: null,
    verifyingAt: null,
    finishedAt: null,
    ...overrides
  };
}

function validMissionAttempt(overrides = {}) {
  const timestamp = '2026-07-16T00:00:00.000Z';
  const id = 'attempt-integrity-12345678';
  return {
    id,
    kind: 'dispatch',
    status: 'running',
    session: 'codex-worker',
    sessionCreatedAt: timestamp,
    paneId: 'codex-worker:0.0',
    tmuxPaneId: '%77',
    panePid: 4100,
    confirmationMarker: `[PaneFleet Dispatch ${id}]`,
    promptChars: 120,
    claimedAt: timestamp,
    submittedAt: timestamp,
    finishedAt: null,
    ...overrides
  };
}

function runningMissionJob(workspace, overrides = {}) {
  const timestamp = '2026-07-16T00:00:00.000Z';
  const attempt = validMissionAttempt();
  return validMissionJob(workspace, {
    status: 'running',
    assignedSession: 'codex-worker',
    assignedSessionCreatedAt: timestamp,
    assignedPaneId: 'codex-worker:0.0',
    assignedTmuxPaneId: '%77',
    assignedPanePid: 4100,
    activeAttempt: { ...attempt },
    attempts: [{ ...attempt }],
    startedAt: timestamp,
    ...overrides
  });
}

function validMissionEvent(missionId = 'mission-integrity-12345678', overrides = {}) {
  return {
    id: 'event-integrity-12345678',
    missionId,
    kind: 'mission.created',
    from: null,
    to: 'ready',
    at: '2026-07-16T00:00:00.000Z',
    detail: 'Synthetic durable event.',
    ...overrides
  };
}

async function rejectedPersistedState(files) {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'panefleet-persisted-state-'));
  const dataDir = path.join(fixtureDir, 'data');
  const binDir = path.join(fixtureDir, 'bin');
  const projectsRoot = path.join(fixtureDir, 'projects');
  const codexHome = path.join(fixtureDir, 'codex-home');
  const toolLogPath = path.join(fixtureDir, 'tools.log');
  for (const directory of [dataDir, binDir, projectsRoot, codexHome]) mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(fixtureDir, 'services.json'), '[]\n');
  writeFileSync(path.join(codexHome, 'models_cache.json'), '{"models":[]}\n');
  const resolvedFiles = typeof files === 'function'
    ? files({ fixtureDir, dataDir, projectsRoot })
    : files;
  for (const [filename, contents] of Object.entries(resolvedFiles)) {
    writeFileSync(path.join(dataDir, filename), contents, { mode: 0o600 });
  }
  for (const name of ['aws', 'curl', 'ps', 'ss', 'tmux']) {
    const executable = path.join(binDir, name);
    writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$ORCH_TOOL_LOG"\nexit 97\n`, { mode: 0o755 });
    chmodSync(executable, 0o755);
  }

  let output = '';
  const child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      HOME: fixtureDir,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '0',
      ORCHESTRATOR_RUNTIME_ROOT: fixtureDir,
      ORCHESTRATOR_PROJECTS_ROOT: projectsRoot,
      ORCHESTRATOR_AGENT_WORKSPACES_ROOT: path.join(projectsRoot, 'agent-workspaces'),
      CODEX_HOME: codexHome,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      ORCH_CONTROL_PLANE_MODE: 'foreground',
      ORCH_TOOL_LOG: toolLogPath,
      SNAPSHOT_EVENT_MS: '3600000',
      SSH_RESCUE_MONITOR_MS: '3600000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  let timeout;
  try {
    const [code, signal] = await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('invalid persisted state did not stop startup')), 5000);
      })
    ]);
    return {
      code,
      signal,
      output,
      toolLog: readFileSync(toolLogPath, { encoding: 'utf8', flag: 'a+' }),
      persisted: Object.fromEntries(Object.keys(resolvedFiles).map((filename) => [
        filename,
        readFileSync(path.join(dataDir, filename), 'utf8')
      ]))
    };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

async function assertPromptQueueRejected(store, expectedError, privateMarker = '') {
  const promptQueue = JSON.stringify(store, null, 2);
  const result = await rejectedPersistedState({
    'mission-queue.json': JSON.stringify(emptyMissionQueue()),
    'prompt-queue.json': promptQueue
  });
  assert.notEqual(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.output, expectedError);
  if (privateMarker) assert.equal(result.output.includes(privateMarker), false);
  assert.equal(result.toolLog, '');
  assert.equal(result.persisted['prompt-queue.json'], promptQueue);
}

async function assertMissionQueueRejected(storeFactory, expectedError, privateMarker = '') {
  let missionQueue = '';
  const result = await rejectedPersistedState(({ projectsRoot }) => {
    const store = typeof storeFactory === 'function' ? storeFactory(projectsRoot) : storeFactory;
    missionQueue = JSON.stringify(store, null, 2);
    return { 'mission-queue.json': missionQueue };
  });
  assert.notEqual(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.output, expectedError);
  if (privateMarker) assert.equal(result.output.includes(privateMarker), false);
  assert.equal(result.toolLog, '');
  assert.equal(result.persisted['mission-queue.json'], missionQueue);
}

async function assertNotificationStateRejected(store, expectedError) {
  const notificationState = JSON.stringify(store, null, 2);
  const result = await rejectedPersistedState({
    'mission-queue.json': JSON.stringify(emptyMissionQueue()),
    'prompt-queue.json': JSON.stringify(emptyPromptQueue()),
    'notification-state.json': notificationState
  });
  assert.notEqual(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.output, expectedError);
  assert.equal(result.toolLog, '');
  assert.equal(result.persisted['notification-state.json'], notificationState);
}

test('malformed durable stores stop startup with stable errors and never echo persisted content', async (t) => {
  const privateMarker = 'synthetic-private-persisted-content';
  const malformed = `{"saved":"${privateMarker}"`;
  const cases = [
    {
      name: 'mission queue',
      files: { 'mission-queue.json': malformed },
      error: 'mission_queue_json_invalid'
    },
    {
      name: 'prompt queue',
      files: {
        'mission-queue.json': JSON.stringify(emptyMissionQueue()),
        'prompt-queue.json': malformed
      },
      error: 'prompt_queue_json_invalid'
    },
    {
      name: 'notification state',
      files: {
        'mission-queue.json': JSON.stringify(emptyMissionQueue()),
        'prompt-queue.json': JSON.stringify(emptyPromptQueue()),
        'notification-state.json': malformed
      },
      error: 'notification_state_json_invalid'
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const result = await rejectedPersistedState(testCase.files);
      assert.notEqual(result.code, 0);
      assert.equal(result.signal, null);
      assert.match(result.output, new RegExp(testCase.error));
      assert.equal(result.output.includes(privateMarker), false);
      assert.equal(result.toolLog, '');
      for (const [filename, contents] of Object.entries(testCase.files)) {
        assert.equal(result.persisted[filename], contents);
      }
    });
  }
});

test('durable mission stores reject corrupt shape and job records before any host inspection', async (t) => {
  const privateMarker = 'synthetic-private-mission-field';
  const job = (root, overrides = {}) => validMissionJob(root, { goal: privateMarker, ...overrides });
  const store = (root, jobs = [job(root)], events = [], overrides = {}) => ({
    version: 1,
    revision: 1,
    jobs,
    events,
    ...overrides
  });
  const cases = [
    { name: 'non-object mission store', build: () => [], error: /mission_queue_invalid/ },
    { name: 'unsupported mission version', build: (root) => store(root, [], [], { version: 2 }), error: /mission_queue_version_unsupported/ },
    { name: 'invalid mission revision', build: (root) => store(root, [], [], { revision: -1 }), error: /mission_queue_revision_invalid/ },
    { name: 'invalid mission jobs collection', build: (root) => store(root, [], [], { jobs: {} }), error: /mission_queue_shape_invalid/ },
    { name: 'invalid mission events collection', build: (root) => store(root, [], [], { events: {} }), error: /mission_queue_shape_invalid/ },
    { name: 'mission job limit', build: (root) => store(root, Array.from({ length: 501 }, (_, index) => ({ id: index }))), error: /mission_queue_limits_invalid/ },
    { name: 'mission event limit', build: (root) => store(root, [], Array.from({ length: 2001 }, (_, index) => ({ id: index }))), error: /mission_queue_limits_invalid/ },
    { name: 'invalid mission job', build: (root) => store(root, [null]), error: /mission_queue_job_invalid/ },
    { name: 'duplicate mission job', build: (root) => store(root, [job(root), job(root)]), error: /mission_queue_duplicate_job/ },
    { name: 'invalid job revision', build: (root) => store(root, [job(root, { revision: 0 })]), error: /mission_queue_job_revision_invalid/ },
    { name: 'invalid job status', build: (root) => store(root, [job(root, { status: 'retrying' })]), error: /mission_queue_job_status_invalid/ },
    { name: 'invalid job priority', build: (root) => store(root, [job(root, { priority: 'critical' })]), error: /mission_queue_job_priority_invalid/ },
    { name: 'relative workspace', build: (root) => store(root, [job(root, { workspace: 'relative' })]), error: /mission_queue_job_workspace_invalid/ },
    { name: 'workspace outside root', build: (root) => store(root, [job(root, { workspace: '/tmp/panefleet-outside-workspace' })]), error: /mission_queue_job_workspace_outside_root/ },
    { name: 'blank mission title', build: (root) => store(root, [job(root, { title: '' })]), error: /mission_queue_job_title_invalid/ },
    { name: 'oversized mission title', build: (root) => store(root, [job(root, { title: 'x'.repeat(161) })]), error: /mission_queue_job_title_invalid/ },
    { name: 'blank mission goal', build: (root) => store(root, [job(root, { goal: '' })]), error: /mission_queue_job_goal_invalid/ },
    { name: 'oversized mission goal', build: (root) => store(root, [job(root, { goal: 'x'.repeat(2601) })]), error: /mission_queue_job_goal_invalid/ },
    { name: 'blank verification criteria', build: (root) => store(root, [job(root, { verificationCriteria: '' })]), error: /mission_queue_job_verification_invalid/ },
    { name: 'oversized verification criteria', build: (root) => store(root, [job(root, { verificationCriteria: 'x'.repeat(801) })]), error: /mission_queue_job_verification_invalid/ },
    { name: 'non-string blocker', build: (root) => store(root, [job(root, { blocker: 7 })]), error: /mission_queue_job_result_invalid/ },
    { name: 'oversized result summary', build: (root) => store(root, [job(root, { resultSummary: 'x'.repeat(801) })]), error: /mission_queue_job_result_invalid/ },
    { name: 'invalid queue position', build: (root) => store(root, [job(root, { position: -1 })]), error: /mission_queue_job_position_invalid/ },
    { name: 'invalid assigned worker', build: (root) => store(root, [job(root, { assignedSession: 'service-worker' })]), error: /mission_queue_job_worker_invalid/ },
    { name: 'cross-wired assigned pane', build: (root) => store(root, [job(root, { assignedSession: 'codex-worker', assignedPaneId: 'codex-other:0.0' })]), error: /mission_queue_job_pane_invalid/ },
    { name: 'invalid assigned tmux pane', build: (root) => store(root, [job(root, { assignedTmuxPaneId: '77' })]), error: /mission_queue_job_pane_invalid/ },
    { name: 'invalid assigned pane pid', build: (root) => store(root, [job(root, { assignedPanePid: 0 })]), error: /mission_queue_job_pane_invalid/ },
    { name: 'locked mission lacks worker', build: (root) => store(root, [job(root, { status: 'running' })]), error: /mission_queue_job_lock_without_worker/ },
    { name: 'invalid required mission timestamp', build: (root) => store(root, [job(root, { updatedAt: 'not-a-time' })]), error: /mission_queue_job_timestamp_invalid/ },
    { name: 'invalid optional mission timestamp', build: (root) => store(root, [job(root, { finishedAt: 'not-a-time' })]), error: /mission_queue_job_timestamp_invalid/ },
    { name: 'missing verification state', build: (root) => store(root, [job(root, { verification: null })]), error: /mission_queue_job_verification_state_invalid/ },
    { name: 'invalid verification status', build: (root) => store(root, [job(root, { verification: { status: 'failed', note: '', at: null } })]), error: /mission_queue_job_verification_state_invalid/ },
    { name: 'invalid verification note', build: (root) => store(root, [job(root, { verification: { status: 'pending', note: 7, at: null } })]), error: /mission_queue_job_verification_state_invalid/ },
    { name: 'invalid verification timestamp', build: (root) => store(root, [job(root, { verification: { status: 'passed', note: '', at: 'not-a-time' } })]), error: /mission_queue_job_verification_state_invalid/ },
    { name: 'attempts must be an array', build: (root) => store(root, [job(root, { attempts: {} })]), error: /mission_queue_job_attempts_invalid/ },
    { name: 'attempt history is bounded', build: (root) => store(root, [job(root, { attempts: Array.from({ length: 51 }, () => ({})) })]), error: /mission_queue_job_attempts_invalid/ }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await assertMissionQueueRejected(testCase.build, testCase.error, privateMarker);
    });
  }
});

test('durable mission attempts preserve exact-pane identity and safe dispatch history', async (t) => {
  const privateMarker = 'synthetic-private-mission-attempt';
  const store = (root, mission) => ({ version: 1, revision: 1, jobs: [mission], events: [] });
  const jobWithAttempts = (root, attempts) => validMissionJob(root, { goal: privateMarker, attempts });
  const running = (root, overrides = {}) => runningMissionJob(root, { goal: privateMarker, ...overrides });
  const cases = [
    { name: 'invalid attempt record', build: (root) => store(root, jobWithAttempts(root, [null])), error: /mission_queue_job_attempt_invalid/ },
    { name: 'invalid attempt id', build: (root) => store(root, jobWithAttempts(root, [validMissionAttempt({ id: 'attempt-short' })])), error: /mission_queue_job_attempt_invalid/ },
    { name: 'invalid attempt session', build: (root) => store(root, jobWithAttempts(root, [validMissionAttempt({ session: 'service-worker', paneId: 'service-worker:0.0' })])), error: /mission_queue_job_attempt_invalid/ },
    { name: 'invalid attempt status', build: (root) => store(root, jobWithAttempts(root, [validMissionAttempt({ status: 'x'.repeat(41) })])), error: /mission_queue_job_attempt_invalid/ },
    { name: 'invalid attempt kind', build: (root) => store(root, jobWithAttempts(root, [validMissionAttempt({ kind: 'retry' })])), error: /mission_queue_job_attempt_invalid/ },
    { name: 'dispatch prompt count cannot be zero', build: (root) => store(root, jobWithAttempts(root, [validMissionAttempt({ promptChars: 0 })])), error: /mission_queue_job_attempt_invalid/ },
    { name: 'adoption prompt count must be zero', build: (root) => store(root, jobWithAttempts(root, [validMissionAttempt({ kind: 'adoption', promptChars: 1, confirmationMarker: undefined })])), error: /mission_queue_job_attempt_invalid/ },
    { name: 'invalid attempt tmux pane', build: (root) => store(root, jobWithAttempts(root, [validMissionAttempt({ tmuxPaneId: '77' })])), error: /mission_queue_job_attempt_invalid/ },
    { name: 'invalid attempt pane pid', build: (root) => store(root, jobWithAttempts(root, [validMissionAttempt({ panePid: 0 })])), error: /mission_queue_job_attempt_invalid/ },
    { name: 'invalid attempt creation identity', build: (root) => store(root, jobWithAttempts(root, [validMissionAttempt({ sessionCreatedAt: 'not-a-time' })])), error: /mission_queue_job_attempt_invalid/ },
    { name: 'cross-wired attempt pane', build: (root) => store(root, jobWithAttempts(root, [validMissionAttempt({ paneId: 'codex-other:0.0' })])), error: /mission_queue_job_attempt_invalid/ },
    { name: 'adoption cannot retain confirmation marker', build: (root) => store(root, jobWithAttempts(root, [validMissionAttempt({ kind: 'adoption', promptChars: 0 })])), error: /mission_queue_job_attempt_invalid/ },
    { name: 'dispatch marker is exact', build: (root) => store(root, jobWithAttempts(root, [validMissionAttempt({ confirmationMarker: '[PaneFleet Dispatch attempt-other-12345678]' })])), error: /mission_queue_job_attempt_invalid/ },
    { name: 'invalid attempt timestamp', build: (root) => store(root, jobWithAttempts(root, [validMissionAttempt({ claimedAt: 'not-a-time' })])), error: /mission_queue_job_attempt_invalid/ },
    { name: 'active attempt worker matches assignment', build: (root) => store(root, running(root, { activeAttempt: { ...validMissionAttempt(), session: 'codex-other' } })), error: /mission_queue_job_attempt_invalid/ },
    { name: 'active attempt session creation matches assignment', build: (root) => store(root, running(root, { activeAttempt: { ...validMissionAttempt(), sessionCreatedAt: '2026-07-16T00:01:00.000Z' } })), error: /mission_queue_job_attempt_invalid/ },
    { name: 'active attempt coordinate matches assignment', build: (root) => store(root, running(root, { activeAttempt: { ...validMissionAttempt(), paneId: 'codex-worker:0.1' } })), error: /mission_queue_job_attempt_invalid/ },
    { name: 'active attempt tmux pane matches assignment', build: (root) => store(root, running(root, { activeAttempt: { ...validMissionAttempt(), tmuxPaneId: '%78' } })), error: /mission_queue_job_attempt_invalid/ },
    { name: 'active attempt pid matches assignment', build: (root) => store(root, running(root, { activeAttempt: { ...validMissionAttempt(), panePid: 4101 } })), error: /mission_queue_job_attempt_invalid/ },
    { name: 'active attempt exists in history', build: (root) => store(root, running(root, { attempts: [] })), error: /mission_queue_job_attempt_invalid/ }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await assertMissionQueueRejected(testCase.build, testCase.error, privateMarker);
    });
  }
});

test('durable mission outcomes and events remain attributable and bounded', async (t) => {
  const privateMarker = 'synthetic-private-mission-evidence';
  const job = (root, overrides = {}) => validMissionJob(root, { goal: privateMarker, ...overrides });
  const store = (root, mission, events = []) => ({ version: 1, revision: 1, jobs: [mission], events });
  const cases = [
    { name: 'outcomes must be an array', build: (root) => store(root, job(root, { outcomes: {} })), error: /mission_queue_job_outcomes_invalid/ },
    { name: 'outcome history is bounded', build: (root) => store(root, job(root, { outcomes: Array.from({ length: 51 }, () => ({})) })), error: /mission_queue_job_outcomes_invalid/ },
    { name: 'invalid outcome status', build: (root) => store(root, job(root, { outcomes: [{ status: 'retry', note: '', at: '2026-07-16T00:00:00.000Z' }] })), error: /mission_queue_job_outcome_invalid/ },
    { name: 'invalid outcome note', build: (root) => store(root, job(root, { outcomes: [{ status: 'done', note: 7, at: '2026-07-16T00:00:00.000Z' }] })), error: /mission_queue_job_outcome_invalid/ },
    { name: 'invalid outcome timestamp', build: (root) => store(root, job(root, { outcomes: [{ status: 'done', note: '', at: 'not-a-time' }] })), error: /mission_queue_job_outcome_invalid/ },
    { name: 'invalid outcome duration', build: (root) => store(root, job(root, { outcomes: [{ status: 'done', note: '', at: '2026-07-16T00:00:00.000Z', durationMinutes: -1 }] })), error: /mission_queue_job_outcome_invalid/ },
    { name: 'invalid event record', build: (root) => store(root, job(root), [null]), error: /mission_queue_event_invalid/ },
    { name: 'event references known mission', build: (root) => store(root, job(root), [validMissionEvent('mission-other-12345678')]), error: /mission_queue_event_invalid/ },
    { name: 'event kind is bounded', build: (root) => store(root, job(root), [validMissionEvent(undefined, { kind: 'x'.repeat(81) })]), error: /mission_queue_event_invalid/ },
    { name: 'event timestamp is valid', build: (root) => store(root, job(root), [validMissionEvent(undefined, { at: 'not-a-time' })]), error: /mission_queue_event_invalid/ },
    { name: 'event detail is bounded', build: (root) => store(root, job(root), [validMissionEvent(undefined, { detail: 'x'.repeat(501) })]), error: /mission_queue_event_invalid/ }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await assertMissionQueueRejected(testCase.build, testCase.error, privateMarker);
    });
  }
});

test('notification disposition state rejects malformed and unbounded records', async (t) => {
  const validNotice = (overrides = {}) => ({ openedAt: null, snoozedUntil: null, ...overrides });
  const cases = [
    { name: 'notification store must be an object', store: [], error: /notification_state_invalid/ },
    { name: 'notification version is fixed', store: { version: 2, revision: 0, items: {} }, error: /notification_state_invalid/ },
    { name: 'notification revision is nonnegative', store: { version: 1, revision: -1, items: {} }, error: /notification_state_invalid/ },
    { name: 'notification items are an object', store: { version: 1, revision: 0, items: [] }, error: /notification_state_invalid/ },
    {
      name: 'notification store is bounded',
      store: {
        version: 1,
        revision: 0,
        items: Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`notice-event-limit-${String(index).padStart(8, '0')}`, validNotice()]))
      },
      error: /notification_state_limit_invalid/
    },
    { name: 'notification id is validated', store: { version: 1, revision: 0, items: { short: validNotice() } }, error: /notification_state_item_invalid/ },
    { name: 'notification item is an object', store: { version: 1, revision: 0, items: { 'notice-event-valid-12345678': null } }, error: /notification_state_item_invalid/ },
    { name: 'notification open time is valid', store: { version: 1, revision: 0, items: { 'notice-event-valid-12345678': validNotice({ openedAt: 'not-a-time' }) } }, error: /notification_state_item_invalid/ },
    { name: 'notification snooze time is valid', store: { version: 1, revision: 0, items: { 'notice-event-valid-12345678': validNotice({ snoozedUntil: 'not-a-time' }) } }, error: /notification_state_item_invalid/ }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await assertNotificationStateRejected(testCase.store, testCase.error);
    });
  }
});

test('a persisted prompt cannot cross-wire its session and pane identity', async () => {
  const timestamp = '2026-07-16T00:00:00.000Z';
  const privateMarker = 'synthetic-private-cross-wired-prompt';
  const promptQueue = JSON.stringify({
    version: 1,
    revision: 1,
    items: [{
      id: 'prompt-invalid-target',
      revision: 1,
      status: 'queued',
      position: 1,
      session: 'codex-worker',
      sessionCreatedAt: timestamp,
      paneId: 'codex-other:0.0',
      tmuxPaneId: '%77',
      panePid: 4100,
      text: privateMarker,
      blocker: '',
      deliveryStage: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
      claimedAt: null,
      sentAt: null
    }],
    schedules: []
  }, null, 2);
  const files = {
    'mission-queue.json': JSON.stringify(emptyMissionQueue()),
    'prompt-queue.json': promptQueue
  };
  const result = await rejectedPersistedState(files);
  assert.notEqual(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.output, /prompt_queue_item_target_invalid/);
  assert.equal(result.output.includes(privateMarker), false);
  assert.equal(result.toolLog, '');
  assert.equal(result.persisted['prompt-queue.json'], promptQueue);
});

test('durable prompt stores reject corrupt shape and item fields before any host inspection', async (t) => {
  const privateMarker = 'synthetic-private-prompt-field';
  const validStore = (items = [validPromptItem({ text: privateMarker })], overrides = {}) => ({
    version: 1,
    revision: 1,
    items,
    schedules: [],
    ...overrides
  });
  const cases = [
    { name: 'non-object store', store: [], error: /prompt_queue_invalid/ },
    { name: 'unsupported version', store: validStore([], { version: 2 }), error: /prompt_queue_version_unsupported/ },
    { name: 'invalid revision', store: validStore([], { revision: -1 }), error: /prompt_queue_shape_invalid/ },
    { name: 'invalid item collection', store: validStore([], { items: {} }), error: /prompt_queue_shape_invalid/ },
    { name: 'invalid schedule collection', store: validStore([], { schedules: {} }), error: /prompt_schedule_shape_invalid/ },
    { name: 'queue item limit', store: validStore(Array.from({ length: 501 }, (_, index) => ({ id: index }))), error: /prompt_queue_limit_exceeded/ },
    { name: 'invalid item record', store: validStore([null]), error: /prompt_queue_item_invalid/ },
    {
      name: 'duplicate item id',
      store: validStore([validPromptItem({ text: privateMarker }), validPromptItem({ position: 2, text: privateMarker })]),
      error: /prompt_queue_duplicate_item/
    },
    { name: 'invalid item revision', store: validStore([validPromptItem({ revision: 0, text: privateMarker })]), error: /prompt_queue_item_invalid/ },
    { name: 'invalid item status', store: validStore([validPromptItem({ status: 'retryable', text: privateMarker })]), error: /prompt_queue_item_invalid/ },
    { name: 'invalid target session', store: validStore([validPromptItem({ session: 'service-worker', paneId: 'service-worker:0.0', text: privateMarker })]), error: /prompt_queue_item_target_invalid/ },
    { name: 'invalid target creation time', store: validStore([validPromptItem({ sessionCreatedAt: 'not-a-time', text: privateMarker })]), error: /prompt_queue_item_target_invalid/ },
    { name: 'invalid pane coordinate', store: validStore([validPromptItem({ paneId: 'codex-worker:zero', text: privateMarker })]), error: /prompt_queue_item_target_invalid/ },
    { name: 'invalid intrinsic pane id', store: validStore([validPromptItem({ tmuxPaneId: '77', text: privateMarker })]), error: /prompt_queue_item_target_invalid/ },
    { name: 'invalid pane pid', store: validStore([validPromptItem({ panePid: 0, text: privateMarker })]), error: /prompt_queue_item_target_invalid/ },
    { name: 'blank prompt', store: validStore([validPromptItem({ text: '   ' })]), error: /prompt_queue_item_text_invalid/ },
    { name: 'oversized prompt', store: validStore([validPromptItem({ text: 'x'.repeat(4001) })]), error: /prompt_queue_item_text_invalid/ },
    { name: 'invalid blocker', store: validStore([validPromptItem({ blocker: 7, text: privateMarker })]), error: /prompt_queue_item_invalid/ },
    { name: 'invalid delivery stage', store: validStore([validPromptItem({ deliveryStage: 'x'.repeat(81), text: privateMarker })]), error: /prompt_queue_item_invalid/ },
    { name: 'invalid completion state', store: validStore([validPromptItem({ summaryState: 'guessed', text: privateMarker })]), error: /prompt_queue_item_completion_invalid/ },
    { name: 'oversized completion summary', store: validStore([validPromptItem({ completionSummary: 'x'.repeat(1201), text: privateMarker })]), error: /prompt_queue_item_completion_invalid/ },
    { name: 'oversized completion snapshot', store: validStore([validPromptItem({ completionSnapshot: 'x'.repeat(4001), text: privateMarker })]), error: /prompt_queue_item_completion_invalid/ },
    { name: 'invalid attempt id', store: validStore([validPromptItem({ attemptId: 'attempt-wrong-prefix', text: privateMarker })]), error: /prompt_queue_item_invalid/ },
    { name: 'invalid schedule id', store: validStore([validPromptItem({ scheduleId: 'schedule-short', text: privateMarker })]), error: /prompt_queue_item_schedule_invalid/ },
    { name: 'invalid created timestamp', store: validStore([validPromptItem({ createdAt: 'not-a-time', text: privateMarker })]), error: /prompt_queue_item_timestamp_invalid/ },
    { name: 'invalid optional send timestamp', store: validStore([validPromptItem({ sentAt: 'not-a-time', text: privateMarker })]), error: /prompt_queue_item_timestamp_invalid/ },
    { name: 'invalid optional completion timestamp', store: validStore([validPromptItem({ completedAt: 'not-a-time', text: privateMarker })]), error: /prompt_queue_item_timestamp_invalid/ },
    { name: 'invalid scheduled occurrence timestamp', store: validStore([validPromptItem({ scheduledFor: 'not-a-time', text: privateMarker })]), error: /prompt_queue_item_timestamp_invalid/ }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await assertPromptQueueRejected(testCase.store, testCase.error, privateMarker);
    });
  }
});

test('durable recurring schedules reject corrupt definitions before any host inspection', async (t) => {
  const privateMarker = 'synthetic-private-schedule-field';
  const validStore = (schedules) => ({ version: 1, revision: 1, items: [], schedules });
  const schedule = (overrides = {}) => validPromptSchedule({ text: privateMarker, ...overrides });
  const cases = [
    { name: 'schedule limit', store: validStore(Array.from({ length: 51 }, (_, index) => ({ id: index }))), error: /prompt_schedule_shape_invalid/ },
    { name: 'invalid schedule record', store: validStore([null]), error: /prompt_schedule_item_invalid/ },
    { name: 'invalid schedule array', store: validStore([[]]), error: /prompt_schedule_item_invalid/ },
    {
      name: 'invalid legacy schedule id is not migrated',
      store: validStore([{ ...schedule({ id: 'schedule-short' }), occurrenceCount: undefined }]),
      error: /prompt_schedule_item_invalid/
    },
    { name: 'duplicate schedule id', store: validStore([schedule(), schedule()]), error: /prompt_schedule_duplicate_item/ },
    { name: 'invalid schedule revision', store: validStore([schedule({ revision: 0 })]), error: /prompt_schedule_item_invalid/ },
    { name: 'invalid enabled flag', store: validStore([schedule({ enabled: 'yes' })]), error: /prompt_schedule_item_invalid/ },
    { name: 'invalid schedule session', store: validStore([schedule({ session: 'service-worker', paneId: 'service-worker:0.0' })]), error: /prompt_schedule_target_invalid/ },
    { name: 'cross-wired schedule pane', store: validStore([schedule({ paneId: 'codex-other:0.0' })]), error: /prompt_schedule_target_invalid/ },
    { name: 'invalid schedule creation identity', store: validStore([schedule({ sessionCreatedAt: 'not-a-time' })]), error: /prompt_schedule_target_invalid/ },
    { name: 'invalid schedule pane coordinate', store: validStore([schedule({ paneId: 'codex-worker:zero' })]), error: /prompt_schedule_target_invalid/ },
    { name: 'invalid schedule intrinsic pane id', store: validStore([schedule({ tmuxPaneId: '77' })]), error: /prompt_schedule_target_invalid/ },
    { name: 'invalid schedule pane pid', store: validStore([schedule({ panePid: 0 })]), error: /prompt_schedule_target_invalid/ },
    { name: 'blank recurring prompt', store: validStore([schedule({ text: '   ' })]), error: /prompt_schedule_text_invalid/ },
    { name: 'oversized recurring prompt', store: validStore([schedule({ text: 'x'.repeat(4001) })]), error: /prompt_schedule_text_invalid/ },
    { name: 'invalid cron type', store: validStore([schedule({ cron: 5 })]), error: /prompt_schedule_cron_invalid/ },
    { name: 'invalid cron range', store: validStore([schedule({ cron: '0 0 32 * *' })]), error: /prompt_schedule_cron_invalid/ },
    { name: 'invalid last outcome', store: validStore([schedule({ lastOutcome: 7 })]), error: /prompt_schedule_item_invalid/ },
    { name: 'invalid run count', store: validStore([schedule({ runCount: -1 })]), error: /prompt_schedule_item_invalid/ },
    { name: 'invalid occurrence counter', store: validStore([schedule({ occurrenceCount: -1 })]), error: /prompt_schedule_item_invalid/ },
    { name: 'invalid required schedule timestamp', store: validStore([schedule({ nextRunAt: 'not-a-time' })]), error: /prompt_schedule_timestamp_invalid/ },
    { name: 'invalid optional schedule timestamp', store: validStore([schedule({ lastRunAt: 'not-a-time' })]), error: /prompt_schedule_timestamp_invalid/ }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await assertPromptQueueRejected(testCase.store, testCase.error, privateMarker);
    });
  }
});

test('durable FIFO positions must remain unique and safely orderable', async (t) => {
  const privateMarker = 'synthetic-private-position-prompt';
  const cases = [
    {
      name: 'duplicate position',
      items: [
        validPromptItem({ text: privateMarker }),
        validPromptItem({ id: 'prompt-position-two', position: 1, text: privateMarker })
      ]
    },
    {
      name: 'unsafe terminal position',
      items: [validPromptItem({ position: Number.MAX_SAFE_INTEGER, text: privateMarker })]
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const promptQueue = JSON.stringify({
        version: 1,
        revision: 1,
        items: testCase.items,
        schedules: []
      }, null, 2);
      const result = await rejectedPersistedState({
        'mission-queue.json': JSON.stringify(emptyMissionQueue()),
        'prompt-queue.json': promptQueue
      });
      assert.notEqual(result.code, 0);
      assert.equal(result.signal, null);
      assert.match(result.output, /prompt_queue_item_position_invalid/);
      assert.equal(result.output.includes(privateMarker), false);
      assert.equal(result.toolLog, '');
      assert.equal(result.persisted['prompt-queue.json'], promptQueue);
    });
  }
});

test('finalized prompt records require internally consistent bounded completion evidence', async (t) => {
  const timestamp = '2026-07-16T00:00:00.000Z';
  const privateMarker = 'synthetic-private-completion-evidence';
  const cases = [
    {
      name: 'missing completion summary',
      item: validSentPromptItem({
        summaryState: 'captured',
        completionSummary: '',
        completionSnapshot: privateMarker,
        completedAt: timestamp
      })
    },
    {
      name: 'missing terminal snapshot',
      item: validSentPromptItem({
        summaryState: 'returned',
        completionSummary: privateMarker,
        completionSnapshot: '',
        completedAt: timestamp
      })
    },
    {
      name: 'missing completion timestamp',
      item: validSentPromptItem({
        summaryState: 'captured',
        completionSummary: privateMarker,
        completionSnapshot: privateMarker,
        completedAt: null
      })
    },
    {
      name: 'final evidence on an unsent ticket',
      item: validPromptItem({
        status: 'queued',
        summaryState: 'operator_released',
        completionSummary: privateMarker,
        completionSnapshot: '',
        completedAt: timestamp
      })
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const promptQueue = JSON.stringify({
        version: 1,
        revision: 1,
        items: [testCase.item],
        schedules: []
      }, null, 2);
      const result = await rejectedPersistedState({
        'mission-queue.json': JSON.stringify(emptyMissionQueue()),
        'prompt-queue.json': promptQueue
      });
      assert.notEqual(result.code, 0);
      assert.equal(result.signal, null);
      assert.match(result.output, /prompt_queue_item_completion_invalid/);
      assert.equal(result.output.includes(privateMarker), false);
      assert.equal(result.toolLog, '');
      assert.equal(result.persisted['prompt-queue.json'], promptQueue);
    });
  }
});

test('persisted prompt lifecycle evidence cannot regress into a resendable state', async (t) => {
  const timestamp = '2026-07-16T00:00:00.000Z';
  const privateMarker = 'synthetic-private-lifecycle-evidence';
  const claim = {
    attemptId: 'queue-attempt-lifecycle-12345678',
    claimedAt: timestamp
  };
  const cases = [
    {
      name: 'ticket retains an attempt without its durable claim time',
      item: validPromptItem({
        status: 'canceled',
        attemptId: claim.attemptId,
        summaryState: 'unavailable',
        blocker: 'Synthetic canceled ticket.',
        text: privateMarker
      })
    },
    {
      name: 'ticket records Enter without its originating claim',
      item: validPromptItem({
        status: 'canceled',
        sentAt: timestamp,
        summaryState: 'unavailable',
        blocker: 'Synthetic canceled ticket.',
        text: privateMarker
      })
    },
    {
      name: 'ticket records completion without ever being sent',
      item: validPromptItem({
        status: 'canceled',
        completedAt: timestamp,
        summaryState: 'unavailable',
        blocker: 'Synthetic canceled ticket.',
        text: privateMarker
      })
    },
    {
      name: 'queued ticket retains a dispatch claim',
      item: validPromptItem({ ...claim, deliveryStage: 'dispatching', text: privateMarker })
    },
    {
      name: 'queued ticket retains proof that Enter was sent',
      item: validPromptItem({ ...claim, sentAt: timestamp, deliveryStage: 'accepted', text: privateMarker })
    },
    {
      name: 'dispatching ticket has no durable claim',
      item: validPromptItem({ status: 'dispatching', deliveryStage: 'dispatching', text: privateMarker })
    },
    {
      name: 'dispatching ticket already records Enter',
      item: validPromptItem({
        status: 'dispatching',
        ...claim,
        sentAt: timestamp,
        deliveryStage: 'dispatching',
        text: privateMarker
      })
    },
    {
      name: 'sent ticket has no durable dispatch evidence',
      item: validPromptItem({ status: 'sent', deliveryStage: 'accepted', text: privateMarker })
    },
    {
      name: 'review ticket has no originating attempt',
      item: validPromptItem({
        status: 'needs_review',
        summaryState: 'unavailable',
        deliveryStage: 'confirmation',
        blocker: 'Synthetic review blocker.',
        text: privateMarker
      })
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const promptQueue = JSON.stringify({
        version: 1,
        revision: 1,
        items: [testCase.item],
        schedules: []
      }, null, 2);
      const result = await rejectedPersistedState({
        'mission-queue.json': JSON.stringify(emptyMissionQueue()),
        'prompt-queue.json': promptQueue
      });
      assert.notEqual(result.code, 0);
      assert.equal(result.signal, null);
      assert.match(result.output, /prompt_queue_item_lifecycle_invalid/);
      assert.equal(result.output.includes(privateMarker), false);
      assert.equal(result.toolLog, '');
      assert.equal(result.persisted['prompt-queue.json'], promptQueue);
    });
  }
});

test('persisted prompt timestamps preserve dispatch and completion chronology', async (t) => {
  const earlier = '2026-07-15T23:59:00.000Z';
  const timestamp = '2026-07-16T00:00:00.000Z';
  const later = '2026-07-16T00:01:00.000Z';
  const privateMarker = 'synthetic-private-prompt-chronology';
  const claim = {
    status: 'dispatching',
    attemptId: 'queue-attempt-chronology-12345678',
    deliveryStage: 'dispatching'
  };
  const finalEvidence = {
    summaryState: 'captured',
    completionSummary: privateMarker,
    completionSnapshot: privateMarker
  };
  const cases = [
    {
      name: 'updated time predates creation',
      item: validPromptItem({ updatedAt: earlier, text: privateMarker })
    },
    {
      name: 'claim predates creation',
      item: validPromptItem({ ...claim, claimedAt: earlier, text: privateMarker })
    },
    {
      name: 'updated time predates claim',
      item: validPromptItem({ ...claim, claimedAt: later, text: privateMarker })
    },
    {
      name: 'send predates claim',
      item: validSentPromptItem({ sentAt: earlier, text: privateMarker })
    },
    {
      name: 'updated time predates send',
      item: validSentPromptItem({ sentAt: later, text: privateMarker })
    },
    {
      name: 'completion predates send',
      item: validSentPromptItem({ ...finalEvidence, completedAt: earlier, text: privateMarker })
    },
    {
      name: 'updated time predates completion',
      item: validSentPromptItem({ ...finalEvidence, completedAt: later, text: privateMarker })
    },
    {
      name: 'scheduled occurrence is later than item creation',
      item: validPromptItem({
        scheduleId: 'schedule-chronology-12345678',
        scheduledFor: later,
        text: privateMarker
      })
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const promptQueue = JSON.stringify({
        version: 1,
        revision: 1,
        items: [testCase.item],
        schedules: []
      }, null, 2);
      const result = await rejectedPersistedState({
        'mission-queue.json': JSON.stringify(emptyMissionQueue()),
        'prompt-queue.json': promptQueue
      });
      assert.notEqual(result.code, 0);
      assert.equal(result.signal, null);
      assert.match(result.output, /prompt_queue_item_chronology_invalid/);
      assert.equal(result.output.includes(privateMarker), false);
      assert.equal(result.toolLog, '');
      assert.equal(result.persisted['prompt-queue.json'], promptQueue);
    });
  }
});

test('persisted schedule counters conserve every due occurrence', async (t) => {
  const privateMarker = 'synthetic-private-schedule-evidence';
  const cases = [
    {
      name: 'outcomes exceed occurrence count',
      schedule: validPromptSchedule({
        text: privateMarker,
        occurrenceCount: 2,
        runCount: 1,
        coalescedCount: 1,
        skippedCount: 1
      })
    },
    {
      name: 'occurrence count exceeds outcomes',
      schedule: validPromptSchedule({
        text: privateMarker,
        occurrenceCount: 3,
        runCount: 1,
        coalescedCount: 1,
        skippedCount: 0
      })
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const promptQueue = JSON.stringify({
        version: 1,
        revision: 1,
        items: [],
        schedules: [testCase.schedule]
      }, null, 2);
      const result = await rejectedPersistedState({
        'mission-queue.json': JSON.stringify(emptyMissionQueue()),
        'prompt-queue.json': promptQueue
      });
      assert.notEqual(result.code, 0);
      assert.equal(result.signal, null);
      assert.match(result.output, /prompt_schedule_counter_invalid/);
      assert.equal(result.output.includes(privateMarker), false);
      assert.equal(result.toolLog, '');
      assert.equal(result.persisted['prompt-queue.json'], promptQueue);
    });
  }
});

test('persisted schedule timestamps advance monotonically', async (t) => {
  const earlier = '2026-07-15T23:59:00.000Z';
  const timestamp = '2026-07-16T00:00:00.000Z';
  const later = '2026-07-16T00:01:00.000Z';
  const next = '2026-07-16T00:05:00.000Z';
  const privateMarker = 'synthetic-private-schedule-chronology';
  const cases = [
    {
      name: 'updated time predates creation',
      schedule: validPromptSchedule({ updatedAt: earlier, text: privateMarker })
    },
    {
      name: 'last run predates schedule creation',
      schedule: validPromptSchedule({ lastRunAt: earlier, text: privateMarker })
    },
    {
      name: 'updated time predates last run',
      schedule: validPromptSchedule({ lastRunAt: later, text: privateMarker })
    },
    {
      name: 'scheduled occurrence predates schedule creation',
      schedule: validPromptSchedule({ lastScheduledFor: earlier, text: privateMarker })
    },
    {
      name: 'last run predates its scheduled occurrence',
      schedule: validPromptSchedule({ lastScheduledFor: later, text: privateMarker })
    },
    {
      name: 'next run does not advance beyond the prior occurrence',
      schedule: validPromptSchedule({
        updatedAt: next,
        lastRunAt: next,
        lastScheduledFor: next,
        nextRunAt: next,
        text: privateMarker
      })
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const promptQueue = JSON.stringify({
        version: 1,
        revision: 1,
        items: [],
        schedules: [testCase.schedule]
      }, null, 2);
      const result = await rejectedPersistedState({
        'mission-queue.json': JSON.stringify(emptyMissionQueue()),
        'prompt-queue.json': promptQueue
      });
      assert.notEqual(result.code, 0);
      assert.equal(result.signal, null);
      assert.match(result.output, /prompt_schedule_chronology_invalid/);
      assert.equal(result.output.includes(privateMarker), false);
      assert.equal(result.toolLog, '');
      assert.equal(result.persisted['prompt-queue.json'], promptQueue);
    });
  }
});
