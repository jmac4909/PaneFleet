import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { canonicalSha256 } from '../delivery-plan.js';
import { validateWorkspaceBaseline as validateCapturedWorkspaceBaseline } from '../workspace-baseline.js';
import {
  abortDeliveryRun,
  captureDeliveryRunImplementation,
  createDeliveryRun,
  createWorkspaceBaseline,
  deliveryRunMissionBindingKey,
  linkDeliveryRunMission,
  markDeliveryRunMissionReconcileRequired,
  markDeliveryRunOffCourse,
  recordDeliveryRunVerification,
  validateDeliveryRun,
  validateWorkspaceBaseline,
  workspaceBaselineDigest
} from '../delivery-run.js';

const AT = '2026-08-16T10:00:00.000Z';
const AT_1 = '2026-08-16T10:01:00.000Z';
const AT_2 = '2026-08-16T10:02:00.000Z';
const AT_3 = '2026-08-16T10:03:00.000Z';
const AT_4 = '2026-08-16T10:04:00.000Z';

function refreshBaselineDigests(baseline) {
  baseline.gitMetadataDigest = canonicalSha256(baseline.gitMetadata);
  baseline.statusDigest = canonicalSha256(baseline.entries.map((entry) => ({
    status: entry.status,
    path: entry.path,
    originalPath: entry.originalPath
  })));
  baseline.workingTreeDigest = canonicalSha256({
    statusDigest: baseline.statusDigest,
    indexDigest: baseline.indexDigest,
    indexFlagsDigest: baseline.indexFlagsDigest,
    gitMetadataDigest: baseline.gitMetadataDigest,
    entries: baseline.entries
  });
  baseline.ignoredScopeDigest = canonicalSha256({
    approvedScopes: baseline.approvedScopes,
    outputDigest: createHash('sha256').update('', 'utf8').digest('hex')
  });
  baseline.instructionsDigest = canonicalSha256(baseline.instructions);
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
    entries: baseline.entries,
    instructions: baseline.instructions
  });
  return baseline;
}

function baselineInput(at = AT, marker = 'b') {
  const entries = [{
    status: ' M',
    path: 'panefleet-run-test/src/example.js',
    originalPath: '',
    type: 'file',
    size: 12,
    sha256: marker.repeat(64)
  }];
  const instructions = [{ path: 'AGENTS.md', size: 20, sha256: 'c'.repeat(64) }];
  const baseline = {
    version: 2,
    workspace: '/srv/panefleet-run-test',
    repoRoot: '/srv',
    workspacePrefix: 'panefleet-run-test',
    head: 'a'.repeat(40),
    branch: 'main',
    detached: false,
    statusDigest: marker.repeat(64),
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
    approvedScopes: ['delivery-run.js', 'test/delivery-run.test.js'],
    entries,
    instructions,
    capturedAt: at
  };
  return refreshBaselineDigests(baseline);
}

function taskInput(index = 1) {
  return {
    stepId: `STEP-00${index}`,
    stepDigest: String(index).repeat(64),
    acceptanceIds: [`AC-00${index}`],
    allowedPaths: index === 1 ? ['delivery-run.js'] : ['test/delivery-run.test.js'],
    missionDefinitionDigest: (index + 2).toString().repeat(64)
  };
}

function runInput(overrides = {}) {
  return {
    id: 'run-domain-12345678',
    planId: 'plan-domain-12345678',
    planRevision: 4,
    planDigest: 'd'.repeat(64),
    workspace: '/srv/panefleet-run-test',
    startBaseline: baselineInput(),
    tasks: [taskInput(1), taskInput(2)],
    ...overrides
  };
}

function evidence(id, at, overrides = {}) {
  return {
    id,
    type: 'diff',
    producer: 'PaneFleet scope guard',
    outcome: 'applied',
    summary: 'A bounded source diff was captured without storing private content.',
    contentRef: '',
    contentSha256: '',
    createdAt: at,
    ...overrides
  };
}

function abortEvidence(id, at, overrides = {}) {
  return evidence(id, at, {
    type: 'review',
    producer: 'PaneFleet operator',
    outcome: 'applied',
    summary: 'The operator confirmed that this Delivery Run must stop permanently.',
    ...overrides
  });
}

function linkCurrent(run, missionId, at = AT_1) {
  const task = run.tasks.find((candidate) => candidate.state === 'pending');
  return linkDeliveryRunMission(run, {
    stepId: task.stepId,
    bindingKey: task.missionBindingKey,
    missionId
  }, { at });
}

function captureCurrent(run, baseline, evidenceId, at) {
  const task = run.tasks.find((candidate) => candidate.state === 'mission_linked');
  return captureDeliveryRunImplementation(run, {
    stepId: task.stepId,
    missionId: task.missionId,
    baseline,
    evidence: [evidence(evidenceId, at)]
  }, { at });
}

function verifyCurrent(run, verificationId, outcome, evidenceId, baseline, at) {
  const task = run.tasks.find((candidate) => candidate.state === 'implementation_captured');
  return recordDeliveryRunVerification(run, {
    id: verificationId,
    stepId: task.stepId,
    missionId: task.missionId,
    baseline,
    criteria: task.acceptanceIds.map((acceptanceId) => ({
      acceptanceId,
      outcome,
      evidenceIds: [evidenceId]
    })),
    evidence: [evidence(`EVD-REVIEW-${task.sequence + 1}`, at, {
      type: 'review',
      outcome: outcome === 'passed' ? 'passed' : 'failed',
      summary: `Independent operator verification ${outcome}.`
    })],
    evidenceIds: [evidenceId],
    note: outcome === 'passed' ? 'All linked acceptance criteria passed.' : 'One linked criterion failed.'
  }, { at });
}

test('workspace baselines are canonical, versioned, strict, and tamper evident', () => {
  const input = baselineInput();
  const baseline = createWorkspaceBaseline(input);
  assert.equal(baseline.version, 2);
  assert.equal(baseline.digest, workspaceBaselineDigest(baseline));
  assert.deepEqual(validateWorkspaceBaseline(baseline), baseline);
  assert.deepEqual(createWorkspaceBaseline({ ...input }), baseline);
  assert.throws(
    () => validateWorkspaceBaseline({ ...baseline, digest: '0'.repeat(64) }),
    /delivery_run_baseline_digest_mismatch/
  );
  assert.throws(() => createWorkspaceBaseline({ ...input, extra: true }), /baseline_input_invalid/);
  assert.throws(() => createWorkspaceBaseline({ ...input, version: 1 }), /baseline_version_unsupported/);
  assert.throws(() => createWorkspaceBaseline({ ...input, head: 'abc1234' }), /baseline_head_invalid/);
  assert.throws(() => createWorkspaceBaseline({ ...input, capturedAt: 'not-a-time' }), /timestamp_invalid/);
});

test('full workspace fingerprints reject malformed, reordered, duplicate, and recomputed-looking data', () => {
  const input = baselineInput();
  const twoEntries = refreshBaselineDigests({
    ...baselineInput(),
    entries: [
      input.entries[0],
      { ...input.entries[0], path: 'panefleet-run-test/src/second.js', sha256: 'e'.repeat(64) }
    ]
  });
  const twoInstructions = refreshBaselineDigests({
    ...baselineInput(),
    instructions: [
      input.instructions[0],
      { path: 'panefleet-run-test/AGENTS.md', size: 21, sha256: 'e'.repeat(64) }
    ]
  });
  const stored = createWorkspaceBaseline(input);
  const storedEntries = createWorkspaceBaseline(twoEntries);
  const storedInstructions = createWorkspaceBaseline(twoInstructions);

  const createCases = [
    [{ ...input, entries: null }, /baseline_entries_invalid/],
    [{ ...input, instructions: null }, /baseline_instructions_invalid/],
    [{ ...input, entries: [input.entries[0], input.entries[0]] }, /baseline_entry_duplicate/],
    [{ ...input, instructions: [input.instructions[0], input.instructions[0]] }, /baseline_instruction_duplicate/],
    [{ ...input, instructions: [{ ...input.instructions[0], size: -1 }] }, /baseline_instruction_invalid/],
    [{ ...input, workspace: '/outside/workspace' }, /baseline_workspace_invalid/],
    [{ ...input, workspacePrefix: 'wrong-prefix' }, /baseline_workspace_prefix_invalid/],
    [{ ...input, digest: '0'.repeat(64) }, /baseline_digest_mismatch/]
  ];
  for (const [candidate, pattern] of createCases) {
    assert.throws(() => createWorkspaceBaseline(candidate), pattern);
  }

  const validationCases = [
    [{ ...stored, instructionsDigest: '0'.repeat(64) }, /baseline_instructions_mismatch/],
    [{ ...stored, workingTreeDigest: '0'.repeat(64) }, /baseline_worktree_mismatch/],
    [{ ...stored, manifestDigest: '0'.repeat(64) }, /baseline_manifest_mismatch/],
    [{ ...stored, entries: null }, /baseline_entries_invalid/],
    [{ ...stored, instructions: null }, /baseline_instructions_invalid/],
    [{ ...storedEntries, entries: [...storedEntries.entries].reverse() }, /baseline_entries_unsorted/],
    [{ ...storedInstructions, instructions: [...storedInstructions.instructions].reverse() }, /baseline_instructions_unsorted/],
    [{ ...stored, entries: [stored.entries[0], stored.entries[0]] }, /baseline_entry_duplicate/],
    [{ ...stored, instructions: [stored.instructions[0], stored.instructions[0]] }, /baseline_instruction_duplicate/],
    [{ ...stored, detached: 'false' }, /baseline_detached_invalid/],
    [{ ...stored, capturedAt: 'invalid' }, /baseline_timestamp_invalid/]
  ];
  for (const [candidate, pattern] of validationCases) {
    assert.throws(() => validateWorkspaceBaseline(candidate), pattern);
  }
});

test('run baselines require and preserve the complete workspace baseline v2 contract', () => {
  const input = baselineInput();
  const baseline = createWorkspaceBaseline(input);
  assert.equal(baseline.version, 2);
  assert.equal(baseline.indexFlagsDigest, input.indexFlagsDigest);
  assert.deepEqual(baseline.gitMetadata, input.gitMetadata);
  assert.equal(baseline.gitMetadataDigest, canonicalSha256(input.gitMetadata));
  assert.deepEqual(baseline.approvedScopes, input.approvedScopes);
  assert.equal(baseline.ignoredScopeDigest, input.ignoredScopeDigest);
  const { digest, ...capturedBaseline } = baseline;
  assert.equal(digest, workspaceBaselineDigest(baseline));
  assert.deepEqual(validateCapturedWorkspaceBaseline(capturedBaseline), capturedBaseline);

  const parentInstruction = refreshBaselineDigests({
    ...baselineInput(),
    instructions: [{ path: '../AGENTS.md', size: 20, sha256: 'c'.repeat(64) }]
  });
  assert.equal(createWorkspaceBaseline(parentInstruction).instructions[0].path, '../AGENTS.md');

  for (const field of [
    'indexFlagsDigest',
    'gitMetadata',
    'gitMetadataDigest',
    'approvedScopes',
    'ignoredScopeDigest'
  ]) {
    const incomplete = structuredClone(input);
    delete incomplete[field];
    assert.throws(() => createWorkspaceBaseline(incomplete), /baseline_input_invalid/);
  }

  assert.throws(() => validateWorkspaceBaseline({
    ...baseline,
    indexFlagsDigest: '0'.repeat(64)
  }), /baseline_worktree_mismatch/);
  assert.throws(() => validateWorkspaceBaseline({
    ...baseline,
    gitMetadataDigest: '0'.repeat(64)
  }), /baseline_git_metadata_mismatch/);
  assert.throws(() => validateWorkspaceBaseline({
    ...baseline,
    approvedScopes: [...baseline.approvedScopes].reverse()
  }), /approved_scopes_not_sorted/);
  assert.throws(() => validateWorkspaceBaseline({
    ...baseline,
    ignoredScopeDigest: '0'.repeat(64)
  }), /baseline_ignored_scope_mismatch/);
  assert.throws(() => validateWorkspaceBaseline({
    ...baseline,
    gitMetadata: { ...baseline.gitMetadata, sparseCheckout: true }
  }), /git_sparse_state_rejected/);
});

test('creation binds an immutable plan, baseline, ordered tasks, and one sequential ensure outbox', () => {
  const run = createDeliveryRun(runInput(), { at: AT });
  assert.equal(run.revision, 1);
  assert.equal(run.condition, 'preparing');
  assert.equal(run.delivery.level, 'planned');
  assert.deepEqual(run.tasks.map((task) => task.sequence), [0, 1]);
  assert.deepEqual(run.outbox.map((item) => item.state), ['pending', 'held']);
  assert.equal(run.tasks[0].expectedBaselineDigest, run.startBaseline.digest);
  assert.equal(run.tasks[1].expectedBaselineDigest, '');
  assert.equal(run.tasks[0].missionBindingKey, deliveryRunMissionBindingKey({
    runId: run.id,
    planId: run.planId,
    planDigest: run.planDigest,
    stepId: run.tasks[0].stepId
  }));
  assert.equal(run.outbox[0].payloadDigest, run.tasks[0].missionDefinitionDigest);
  assert.deepEqual(validateDeliveryRun(run), run);
});

test('two tasks advance only through mission link, implementation evidence, and criterion verification', () => {
  let run = createDeliveryRun(runInput(), { at: AT });
  run = linkCurrent(run, 'mission-domain-first-12345678', AT_1);
  assert.equal(run.tasks[0].state, 'mission_linked');
  assert.equal(run.outbox[0].state, 'applied');
  assert.equal(run.condition, 'active');

  const firstAfter = baselineInput(AT_2, 'e');
  run = captureCurrent(run, firstAfter, 'EVD-DIFF-FIRST', AT_2);
  assert.equal(run.tasks[0].state, 'implementation_captured');
  assert.equal(run.delivery.level, 'implemented_locally');
  assert.equal(run.condition, 'awaiting_verification');
  run = verifyCurrent(
    run,
    'verification-domain-first-12345678',
    'passed',
    'EVD-DIFF-FIRST',
    firstAfter,
    AT_3
  );
  assert.equal(run.tasks[0].state, 'verified');
  assert.equal(run.tasks[1].expectedBaselineDigest, run.tasks[0].implementation.baseline.digest);
  assert.equal(run.outbox[1].state, 'pending');
  assert.equal(run.delivery.level, 'implemented_locally');

  run = linkCurrent(run, 'mission-domain-second-12345678', AT_4);
  const secondAfter = baselineInput('2026-08-16T10:05:00.000Z', 'f');
  run = captureCurrent(run, secondAfter, 'EVD-DIFF-SECOND', '2026-08-16T10:05:00.000Z');
  assert.throws(() => recordDeliveryRunVerification(run, {
    id: 'verification-domain-cross-task-12345678',
    stepId: 'STEP-002',
    missionId: run.tasks[1].missionId,
    baseline: secondAfter,
    criteria: [{ acceptanceId: 'AC-002', outcome: 'passed', evidenceIds: ['EVD-DIFF-FIRST'] }],
    evidence: [],
    evidenceIds: ['EVD-DIFF-FIRST'],
    note: 'Evidence from the first task cannot prove the second task.'
  }, { at: '2026-08-16T10:06:00.000Z' }), /evidence_not_for_task/);
  run = verifyCurrent(
    run,
    'verification-domain-second-12345678',
    'passed',
    'EVD-DIFF-SECOND',
    secondAfter,
    '2026-08-16T10:06:00.000Z'
  );
  assert.equal(run.condition, 'verified');
  assert.equal(run.delivery.level, 'verified_locally');
  assert.equal(run.tasks.every((task) => task.state === 'verified'), true);
  assert.equal(run.verificationRecords.length, 2);
  assert.equal(run.verificationRecords.every((record) => record.verifier.kind === 'operator'), true);
  assert.equal(run.revision, 7);
});

test('a failed or not-run criterion blocks the run and never releases the next task', () => {
  let run = createDeliveryRun(runInput(), { at: AT });
  run = linkCurrent(run, 'mission-domain-fail-12345678', AT_1);
  const after = baselineInput(AT_2, 'e');
  run = captureCurrent(run, after, 'EVD-DIFF-FAIL', AT_2);
  run = verifyCurrent(
    run,
    'verification-domain-fail-12345678',
    'not_run',
    'EVD-DIFF-FAIL',
    after,
    AT_3
  );
  assert.equal(run.condition, 'blocked');
  assert.equal(run.tasks[0].state, 'failed');
  assert.equal(run.outbox[1].state, 'held');
  assert.equal(run.delivery.level, 'implemented_locally');
  assert.match(run.blocker, /criterion failed/i);
});

test('an uncertain mission ensure records reconciliation and can link only the authoritative binding', () => {
  const created = createDeliveryRun(runInput({ tasks: [taskInput(1)] }), { at: AT });
  const task = created.tasks[0];
  const uncertain = markDeliveryRunMissionReconcileRequired(created, {
    stepId: task.stepId,
    bindingKey: task.missionBindingKey,
    error: 'Mission persistence outcome is unknown; inspect durable state.'
  }, { at: AT_1 });
  assert.equal(uncertain.condition, 'reconcile_required');
  assert.equal(uncertain.tasks[0].state, 'reconcile_required');
  assert.equal(uncertain.outbox[0].state, 'reconcile_required');
  const linked = linkDeliveryRunMission(uncertain, {
    stepId: task.stepId,
    bindingKey: task.missionBindingKey,
    missionId: 'mission-recovered-12345678'
  }, { at: AT_2 });
  assert.equal(linked.condition, 'active');
  assert.equal(linked.blocker, '');
  assert.throws(() => linkDeliveryRunMission(created, {
    stepId: task.stepId,
    bindingKey: '0'.repeat(64),
    missionId: 'mission-wrong-bind-12345678'
  }), /mission_binding_conflict/);
});

test('off-course evidence blocks pending or linked work without deleting its mission link', () => {
  let pending = createDeliveryRun(runInput({ tasks: [taskInput(1)] }), { at: AT });
  pending = markDeliveryRunOffCourse(pending, {
    stepId: 'STEP-001',
    reason: 'An instruction digest changed before dispatch.',
    evidence: [evidence('EVD-OFFCOURSE-PENDING', AT_1, { type: 'baseline', outcome: 'failed' })]
  }, { at: AT_1 });
  assert.equal(pending.condition, 'off_course');
  assert.equal(pending.outbox[0].state, 'blocked');

  let linked = createDeliveryRun(runInput({
    id: 'run-domain-linked-12345678',
    planId: 'plan-domain-linked-12345678',
    tasks: [taskInput(1)]
  }), { at: AT });
  linked = linkCurrent(linked, 'mission-offcourse-12345678', AT_1);
  linked = markDeliveryRunOffCourse(linked, {
    stepId: 'STEP-001',
    reason: 'A file outside the approved paths changed.',
    evidence: [evidence('EVD-OFFCOURSE-LINKED', AT_2, { outcome: 'failed' })]
  }, { at: AT_2 });
  assert.equal(linked.outbox[0].state, 'applied');
  assert.equal(linked.tasks[0].missionId, 'mission-offcourse-12345678');
});

test('operator-confirmed abort terminalizes pending work and rejects every later work mutation', () => {
  const created = createDeliveryRun(runInput(), { at: AT });
  const reason = 'The operator withdrew this approved local Delivery Run.';
  const aborted = abortDeliveryRun(created, {
    operatorConfirmed: true,
    reason,
    evidence: [abortEvidence('EVD-ABORT-PENDING', AT_1)]
  }, { at: AT_1 });

  assert.equal(aborted.condition, 'aborted');
  assert.equal(aborted.revision, created.revision + 1);
  assert.equal(aborted.blocker, reason);
  assert.deepEqual(aborted.tasks.map((task) => task.state), ['aborted', 'aborted']);
  assert.deepEqual(aborted.outbox.map((item) => item.state), ['canceled', 'canceled']);
  assert.equal(aborted.outbox.every((item) => item.error === reason), true);
  assert.equal(aborted.delivery.level, 'planned');
  assert.deepEqual(aborted.delivery.evidenceIds, ['EVD-ABORT-PENDING']);
  assert.deepEqual(aborted.abort, {
    operatorConfirmed: true,
    fromCondition: 'preparing',
    reason,
    evidenceIds: ['EVD-ABORT-PENDING'],
    abortedAt: AT_1
  });
  assert.deepEqual(validateDeliveryRun(aborted), aborted);
  assert.deepEqual(created, createDeliveryRun(runInput(), { at: AT }));

  const first = aborted.tasks[0];
  assert.throws(() => linkDeliveryRunMission(aborted, {
    stepId: first.stepId,
    bindingKey: first.missionBindingKey,
    missionId: 'mission-after-abort-12345678'
  }, { at: AT_2 }), /mission_link_state_invalid/);
  assert.throws(() => markDeliveryRunMissionReconcileRequired(aborted, {
    stepId: first.stepId,
    bindingKey: first.missionBindingKey,
    error: 'This must not reopen terminal work.'
  }, { at: AT_2 }), /mission_reconcile_state_invalid/);
  assert.throws(() => captureDeliveryRunImplementation(aborted, {
    stepId: first.stepId,
    missionId: 'mission-after-abort-12345678',
    baseline: baselineInput(AT_2, 'e'),
    evidence: []
  }, { at: AT_2 }), /implementation_state_invalid/);
  assert.throws(() => recordDeliveryRunVerification(aborted, {
    id: 'verification-after-abort-12345678',
    stepId: first.stepId,
    missionId: 'mission-after-abort-12345678',
    baseline: baselineInput(AT_2, 'e'),
    criteria: [],
    evidence: [],
    evidenceIds: [],
    note: 'Terminal work cannot be verified later.'
  }, { at: AT_2 }), /verification_state_invalid/);
  assert.throws(() => markDeliveryRunOffCourse(aborted, {
    stepId: first.stepId,
    reason: 'Terminal work cannot change classification.',
    evidence: []
  }, { at: AT_2 }), /off_course_state_invalid/);
  assert.throws(() => abortDeliveryRun(aborted, {
    operatorConfirmed: true,
    reason,
    evidence: [abortEvidence('EVD-ABORT-AGAIN', AT_2)]
  }, { at: AT_2 }), /abort_state_invalid/);
});

test('abort preserves verified history and applied Mission identity while canceling only unfinished work', () => {
  let run = createDeliveryRun(runInput(), { at: AT });
  run = linkCurrent(run, 'mission-abort-first-12345678', AT_1);
  const firstAfter = baselineInput(AT_2, 'e');
  run = captureCurrent(run, firstAfter, 'EVD-ABORT-FIRST-DIFF', AT_2);
  run = verifyCurrent(
    run,
    'verification-abort-first-12345678',
    'passed',
    'EVD-ABORT-FIRST-DIFF',
    firstAfter,
    AT_3
  );
  run = linkCurrent(run, 'mission-abort-second-12345678', AT_4);
  const beforeAbort = structuredClone(run);
  const abortedAt = '2026-08-16T10:05:00.000Z';
  const aborted = abortDeliveryRun(run, {
    operatorConfirmed: true,
    reason: 'The operator ended the Run after accepting the first task.',
    evidence: [abortEvidence('EVD-ABORT-ACTIVE', abortedAt)]
  }, { at: abortedAt });

  assert.equal(aborted.abort.fromCondition, 'active');
  assert.deepEqual(aborted.tasks.map((task) => task.state), ['verified', 'aborted']);
  assert.deepEqual(aborted.outbox.map((item) => item.state), ['applied', 'applied']);
  assert.equal(aborted.tasks[1].missionId, 'mission-abort-second-12345678');
  assert.deepEqual(aborted.tasks[0], beforeAbort.tasks[0]);
  assert.deepEqual(aborted.verificationRecords, beforeAbort.verificationRecords);
  assert.equal(aborted.delivery.level, 'implemented_locally');
});

test('abort requires an exact operator confirmation, reason, and applied review evidence', () => {
  const run = createDeliveryRun(runInput({ tasks: [taskInput(1)] }), { at: AT });
  const request = {
    operatorConfirmed: true,
    reason: 'The operator intentionally stopped this Run.',
    evidence: [abortEvidence('EVD-ABORT-STRICT', AT_1)]
  };
  assert.throws(() => abortDeliveryRun(run, { ...request, extra: true }, { at: AT_1 }), /abort_input_invalid/);
  assert.throws(() => abortDeliveryRun(run, { ...request, operatorConfirmed: false }, { at: AT_1 }), /confirmation_required/);
  assert.throws(() => abortDeliveryRun(run, { ...request, reason: '   ' }, { at: AT_1 }), /abort_reason_invalid/);
  assert.throws(() => abortDeliveryRun(run, { ...request, evidence: [] }, { at: AT_1 }), /abort_evidence_required/);
  assert.throws(() => abortDeliveryRun(run, {
    ...request,
    evidence: [evidence('EVD-ABORT-NO-REVIEW', AT_1)]
  }, { at: AT_1 }), /abort_operator_evidence_required/);
  assert.throws(() => abortDeliveryRun(run, {
    ...request,
    evidence: [abortEvidence('EVD-ABORT-FAILED-REVIEW', AT_1, { outcome: 'failed' })]
  }, { at: AT_1 }), /abort_operator_evidence_required/);
  assert.throws(() => abortDeliveryRun(run, {
    ...request,
    evidence: [abortEvidence('EVD-ABORT-STALE-REVIEW', AT)]
  }, { at: AT_1 }), /abort_operator_evidence_required/);
});

test('verified runs remain immutable and persisted abort records fail closed when forged', () => {
  let verified = createDeliveryRun(runInput({ tasks: [taskInput(1)] }), { at: AT });
  verified = linkCurrent(verified, 'mission-verified-abort-12345678', AT_1);
  const after = baselineInput(AT_2, 'e');
  verified = captureCurrent(verified, after, 'EVD-VERIFIED-ABORT-DIFF', AT_2);
  verified = verifyCurrent(
    verified,
    'verification-verified-abort-12345678',
    'passed',
    'EVD-VERIFIED-ABORT-DIFF',
    after,
    AT_3
  );
  const snapshot = structuredClone(verified);
  assert.throws(() => abortDeliveryRun(verified, {
    operatorConfirmed: true,
    reason: 'A verified Run must not be rewritten as aborted.',
    evidence: [abortEvidence('EVD-ABORT-VERIFIED', AT_4)]
  }, { at: AT_4 }), /abort_state_invalid/);
  assert.deepEqual(verified, snapshot);

  const created = createDeliveryRun(runInput({
    id: 'run-forged-abort-12345678',
    planId: 'plan-forged-abort-12345678',
    tasks: [taskInput(1)]
  }), { at: AT });
  const aborted = abortDeliveryRun(created, {
    operatorConfirmed: true,
    reason: 'A valid terminal record used as the tamper-test baseline.',
    evidence: [abortEvidence('EVD-ABORT-FORGE', AT_1)]
  }, { at: AT_1 });
  assert.throws(() => validateDeliveryRun({ ...created, abort: aborted.abort }), /abort_invalid/);
  assert.throws(() => validateDeliveryRun({ ...aborted, abort: null }), /abort_invalid/);
  assert.throws(() => validateDeliveryRun({
    ...aborted,
    abort: { ...aborted.abort, operatorConfirmed: false }
  }), /abort_invalid/);
  assert.throws(() => validateDeliveryRun({
    ...aborted,
    abort: { ...aborted.abort, evidenceIds: [] }
  }), /abort_evidence_invalid/);
  assert.throws(() => validateDeliveryRun({
    ...aborted,
    abort: { ...aborted.abort, abortedAt: AT_2 }
  }), /abort_invalid/);
  assert.throws(() => validateDeliveryRun({
    ...aborted,
    tasks: aborted.tasks.map((task) => ({ ...task, state: 'pending' }))
  }), /abort_task_invalid|outbox_lifecycle_invalid/);
  assert.throws(() => validateDeliveryRun({
    ...aborted,
    outbox: aborted.outbox.map((item) => ({ ...item, error: 'A different terminal reason.' }))
  }), /abort_outbox_invalid/);
});

test('strict validation rejects unknown fields, unsafe scope, duplicate identity, and forged lifecycle state', () => {
  const run = createDeliveryRun(runInput(), { at: AT });
  assert.throws(() => validateDeliveryRun({ ...run, unknown: true }), /shape_invalid/);
  assert.throws(() => createDeliveryRun(runInput({ workspace: 'relative/path' })), /workspace_invalid/);
  assert.throws(() => createDeliveryRun(runInput({ tasks: [{ ...taskInput(1), allowedPaths: ['../escape'] }] })), /allowed_path_invalid/);
  assert.throws(() => createDeliveryRun(runInput({ tasks: [{ ...taskInput(1), allowedPaths: ['.git/config'] }] })), /allowed_path_invalid/);
  assert.throws(() => createDeliveryRun(runInput({ tasks: [taskInput(1), taskInput(1)] })), /step_id_duplicate/);
  assert.throws(() => createDeliveryRun(runInput({ tasks: [{ ...taskInput(1), acceptanceIds: [] }] })), /acceptance_ids_invalid/);
  assert.throws(() => validateDeliveryRun({
    ...run,
    tasks: run.tasks.map((task, index) => index ? task : { ...task, state: 'mission_linked' })
  }), /task_lifecycle_invalid/);
  assert.throws(() => validateDeliveryRun({
    ...run,
    delivery: { ...run.delivery, level: 'verified_locally' }
  }), /delivery_invalid/);
});

test('mutation state, baseline, evidence, and complete-criteria guards fail closed', () => {
  let run = createDeliveryRun(runInput({ tasks: [taskInput(1)] }), { at: AT });
  const task = run.tasks[0];
  assert.throws(() => captureDeliveryRunImplementation(run, {
    stepId: task.stepId,
    missionId: 'mission-too-early-12345678',
    baseline: baselineInput(AT_1, 'e'),
    evidence: []
  }), /implementation_state_invalid/);
  run = linkCurrent(run, 'mission-guarded-12345678', AT_1);
  assert.throws(() => captureDeliveryRunImplementation(run, {
    stepId: task.stepId,
    missionId: run.tasks[0].missionId,
    baseline: run.startBaseline,
    evidence: [evidence('EVD-DIFF-UNCHANGED', AT_2)]
  }, { at: AT_2 }), /implementation_unchanged/);
  const after = baselineInput(AT_2, 'e');
  run = captureCurrent(run, after, 'EVD-DIFF-GUARDED', AT_2);
  assert.throws(() => recordDeliveryRunVerification(run, {
    id: 'verification-guarded-12345678',
    stepId: task.stepId,
    missionId: run.tasks[0].missionId,
    baseline: baselineInput(AT_3, 'f'),
    criteria: [{ acceptanceId: 'AC-001', outcome: 'passed', evidenceIds: ['EVD-DIFF-GUARDED'] }],
    evidence: [],
    evidenceIds: ['EVD-DIFF-GUARDED'],
    note: ''
  }), /verification_baseline_changed/);
  assert.throws(() => recordDeliveryRunVerification(run, {
    id: 'verification-guarded-12345678',
    stepId: task.stepId,
    missionId: run.tasks[0].missionId,
    baseline: after,
    criteria: [],
    evidence: [],
    evidenceIds: [],
    note: ''
  }), /verification_criteria_invalid/);
  assert.throws(() => recordDeliveryRunVerification(run, {
    id: 'verification-guarded-12345678',
    stepId: task.stepId,
    missionId: run.tasks[0].missionId,
    baseline: after,
    criteria: [{ acceptanceId: 'AC-001', outcome: 'passed', evidenceIds: ['EVD-UNKNOWN-001'] }],
    evidence: [],
    evidenceIds: [],
    note: ''
  }), /evidence_reference_unknown/);
  assert.throws(() => recordDeliveryRunVerification(run, {
    id: 'verification-note-required-12345678',
    stepId: task.stepId,
    missionId: run.tasks[0].missionId,
    baseline: after,
    criteria: [{ acceptanceId: 'AC-001', outcome: 'passed', evidenceIds: ['EVD-DIFF-GUARDED'] }],
    evidence: [],
    evidenceIds: ['EVD-DIFF-GUARDED'],
    note: ''
  }), /verification_note_required/);
});

test('schema caps reject oversized task and evidence collections', () => {
  const tasks = Array.from({ length: 81 }, (_, index) => ({
    stepId: `STEP-${String(index + 1).padStart(3, '0')}`,
    stepDigest: (index % 10).toString().repeat(64),
    acceptanceIds: [`AC-${String(index + 1).padStart(3, '0')}`],
    allowedPaths: [`src/${index}.js`],
    missionDefinitionDigest: ((index + 1) % 10).toString().repeat(64)
  }));
  assert.throws(() => createDeliveryRun(runInput({ tasks })), /tasks_invalid/);
  const run = createDeliveryRun(runInput({ tasks: [taskInput(1)] }), { at: AT });
  assert.throws(() => validateDeliveryRun({
    ...run,
    evidenceIndex: Array.from({ length: 513 }, () => ({}))
  }), /evidence_index_invalid/);
});

test('persisted task, outbox, verification, condition, and delivery invariants fail closed', () => {
  const created = createDeliveryRun(runInput(), { at: AT });
  const oneTask = createDeliveryRun(runInput({ tasks: [taskInput(1)] }), { at: AT });
  const linked = linkCurrent(oneTask, 'mission-invariant-12345678', AT_1);
  const after = baselineInput(AT_2, 'e');
  const captured = captureCurrent(linked, after, 'EVD-INVARIANT-DIFF', AT_2);
  const verified = verifyCurrent(
    captured,
    'verification-invariant-12345678',
    'passed',
    'EVD-INVARIANT-DIFF',
    after,
    AT_3
  );

  const validateCases = [
    [{ ...created, workspace: 'relative' }, /workspace_invalid/],
    [{ ...created, updatedAt: '2026-08-16T09:59:00.000Z' }, /timestamp_invalid/],
    [{ ...created, verificationRecords: null }, /verifications_invalid/],
    [{ ...created, verificationRecords: [{ id: 'bad' }] }, /verification_duplicate/],
    [{ ...created, tasks: [] }, /tasks_invalid/],
    [{ ...created, outbox: [] }, /outbox_invalid/],
    [{
      ...created,
      tasks: created.tasks.map((task, index) => index === 0
        ? { ...task, expectedBaselineDigest: '0'.repeat(64) }
        : task)
    }, /task_baseline_invalid/],
    [{
      ...created,
      tasks: created.tasks.map((task, index) => index === 0 ? { ...task, sequence: 2 } : task)
    }, /task_order_invalid/],
    [{
      ...created,
      outbox: created.outbox.map((item, index) => index === 0 ? { ...item, state: 'applied' } : item)
    }, /outbox_lifecycle_invalid/],
    [{
      ...created,
      outbox: created.outbox.map((item, index) => index === 0
        ? { ...item, missionId: 'mission-outbox-12345678' }
        : item)
    }, /outbox_lifecycle_invalid/],
    [{
      ...created,
      outbox: created.outbox.map((item, index) => index === 0 ? { ...item, state: 'reconcile_required' } : item)
    }, /outbox_lifecycle_invalid/],
    [{
      ...created,
      outbox: created.outbox.map((item, index) => index === 0 ? { ...item, state: 'blocked' } : item)
    }, /outbox_lifecycle_invalid/],
    [{
      ...created,
      outbox: created.outbox.map((item, index) => index === 0 ? { ...item, error: 'unexpected' } : item)
    }, /outbox_lifecycle_invalid/],
    [{
      ...created,
      outbox: created.outbox.map((item, index) => index === 1 ? { ...item, state: 'pending' } : item)
    }, /outbox_sequence_invalid/],
    [{ ...created, delivery: { ...created.delivery, evidenceIds: ['EVD-UNKNOWN-DELIVERY'] } }, /evidence_reference_unknown/],
    [{ ...created, delivery: { ...created.delivery, updatedAt: AT_4 } }, /delivery_invalid/],
    [{ ...created, condition: 'verified' }, /condition_invalid/],
    [{ ...created, condition: 'awaiting_verification' }, /condition_invalid/],
    [{ ...created, condition: 'reconcile_required', blocker: 'missing reconcile task' }, /condition_invalid/],
    [{ ...created, condition: 'off_course', blocker: 'missing off-course task' }, /condition_invalid/],
    [{ ...created, condition: 'blocked', blocker: 'missing failed task' }, /condition_invalid/],
    [{ ...created, condition: 'active', blocker: 'not permitted for active work' }, /blocker_invalid/],
    [{
      ...created,
      evidenceIndex: [evidence('EVD-INVALID-TYPE', AT, { type: 'unknown' })]
    }, /evidence_invalid/]
  ];
  for (const [candidate, pattern] of validateCases) {
    assert.throws(() => validateDeliveryRun(candidate), pattern);
  }

  const knownEvidence = evidence('EVD-IMPLEMENTATION-REF', AT);
  const taskCases = [
    {
      evidenceIndex: [knownEvidence],
      mutate: (task) => ({
        ...task,
        implementation: { baseline: null, evidenceIds: [knownEvidence.id], capturedAt: null }
      }),
      pattern: /implementation_invalid/
    },
    {
      mutate: (task) => ({
        ...task,
        implementation: { baseline: createWorkspaceBaseline(after), evidenceIds: [], capturedAt: 'invalid' }
      }),
      pattern: /implementation_invalid/
    },
    {
      mutate: (task) => ({
        ...task,
        implementation: { baseline: createWorkspaceBaseline(after), evidenceIds: [], capturedAt: AT_3 }
      }),
      pattern: /implementation_invalid/
    },
    {
      mutate: (task) => ({ ...task, verificationId: 'bad' }),
      pattern: /task_verification_invalid/
    },
    {
      mutate: (task) => ({ ...task, verificationId: 'verification-unknown-12345678' }),
      pattern: /task_verification_invalid/
    },
    {
      mutate: (task) => ({ ...task, state: 'implementation_captured', missionId: 'mission-state-12345678' }),
      pattern: /task_lifecycle_invalid/
    },
    {
      mutate: (task) => ({
        ...task,
        state: 'verified',
        missionId: 'mission-state-12345678',
        implementation: { baseline: createWorkspaceBaseline(after), evidenceIds: [], capturedAt: after.capturedAt }
      }),
      pattern: /task_lifecycle_invalid/
    }
  ];
  for (const testCase of taskCases) {
    const candidate = {
      ...oneTask,
      evidenceIndex: testCase.evidenceIndex || oneTask.evidenceIndex,
      tasks: oneTask.tasks.map(testCase.mutate)
    };
    assert.throws(() => validateDeliveryRun(candidate), testCase.pattern);
  }

  const recordCases = [
    {
      mutate: (record) => ({ ...record, verifier: { kind: 'agent' } }),
      pattern: /verifier_invalid/
    },
    {
      mutate: (record) => ({ ...record, criteria: [] }),
      pattern: /verification_criteria_invalid/
    },
    {
      mutate: (record) => ({
        ...record,
        criteria: record.criteria.map((criterion) => ({ ...criterion, outcome: 'failed' }))
      }),
      pattern: /verification_outcome_invalid/
    },
    {
      mutate: (record) => ({ ...record, outcome: 'failed' }),
      pattern: /verification_outcome_invalid/
    },
    {
      mutate: (record) => ({ ...record, verifiedAt: 'invalid' }),
      pattern: /verification_invalid/
    },
    {
      mutate: (record) => ({ ...record, stepId: 'STEP-UNKNOWN' }),
      pattern: /verification_step_unknown/
    }
  ];
  for (const testCase of recordCases) {
    assert.throws(() => validateDeliveryRun({
      ...verified,
      verificationRecords: verified.verificationRecords.map(testCase.mutate)
    }), testCase.pattern);
  }
});

test('released sequencing and mutation boundary guards reject stale or forged completion', () => {
  let run = createDeliveryRun(runInput(), { at: AT });
  run = linkCurrent(run, 'mission-sequence-first-12345678', AT_1);
  const firstAfter = baselineInput(AT_2, 'e');
  run = captureCurrent(run, firstAfter, 'EVD-SEQUENCE-FIRST', AT_2);
  run = verifyCurrent(
    run,
    'verification-sequence-first-12345678',
    'passed',
    'EVD-SEQUENCE-FIRST',
    firstAfter,
    AT_3
  );
  assert.throws(() => validateDeliveryRun({
    ...run,
    outbox: run.outbox.map((item, index) => index === 1 ? { ...item, state: 'held' } : item)
  }), /outbox_sequence_invalid/);
  assert.throws(() => markDeliveryRunOffCourse(run, {
    stepId: 'STEP-001',
    reason: 'A completed step cannot be reclassified.',
    evidence: []
  }, { at: AT_4 }), /off_course_state_invalid/);

  run = linkCurrent(run, 'mission-sequence-second-12345678', AT_4);
  const secondAfter = baselineInput('2026-08-16T10:05:00.000Z', 'f');
  run = captureCurrent(run, secondAfter, 'EVD-SEQUENCE-SECOND', '2026-08-16T10:05:00.000Z');
  assert.throws(() => recordDeliveryRunVerification(run, {
    id: 'verification-sequence-first-12345678',
    stepId: 'STEP-002',
    missionId: run.tasks[1].missionId,
    baseline: secondAfter,
    criteria: [{ acceptanceId: 'AC-002', outcome: 'passed', evidenceIds: ['EVD-SEQUENCE-SECOND'] }],
    evidence: [],
    evidenceIds: ['EVD-SEQUENCE-SECOND'],
    note: 'A verification identifier cannot be reused.'
  }, { at: '2026-08-16T10:06:00.000Z' }), /verification_duplicate/);

  const twoCriteriaTask = { ...taskInput(1), acceptanceIds: ['AC-001', 'AC-002'] };
  let twoCriteriaRun = createDeliveryRun(runInput({ tasks: [twoCriteriaTask] }), { at: AT });
  twoCriteriaRun = linkCurrent(twoCriteriaRun, 'mission-two-criteria-12345678', AT_1);
  twoCriteriaRun = captureCurrent(twoCriteriaRun, firstAfter, 'EVD-TWO-CRITERIA', AT_2);
  assert.throws(() => recordDeliveryRunVerification(twoCriteriaRun, {
    id: 'verification-two-criteria-12345678',
    stepId: 'STEP-001',
    missionId: twoCriteriaRun.tasks[0].missionId,
    baseline: firstAfter,
    criteria: [
      { acceptanceId: 'AC-001', outcome: 'passed', evidenceIds: ['EVD-TWO-CRITERIA'] },
      { acceptanceId: 'AC-001', outcome: 'passed', evidenceIds: ['EVD-TWO-CRITERIA'] }
    ],
    evidence: [],
    evidenceIds: ['EVD-TWO-CRITERIA'],
    note: 'Every approved criterion must appear exactly once.'
  }, { at: AT_3 }), /verification_criteria_invalid/);
  assert.throws(() => recordDeliveryRunVerification(twoCriteriaRun, {
    id: 'verification-invalid-criterion-12345678',
    stepId: 'STEP-001',
    missionId: twoCriteriaRun.tasks[0].missionId,
    baseline: firstAfter,
    criteria: [
      { acceptanceId: 'AC-001', outcome: 'passed', evidenceIds: ['EVD-TWO-CRITERIA'] },
      { acceptanceId: 'AC-UNKNOWN', outcome: 'passed', evidenceIds: ['EVD-TWO-CRITERIA'] }
    ],
    evidence: [],
    evidenceIds: ['EVD-TWO-CRITERIA'],
    note: 'Unknown criteria are not accepted.'
  }, { at: AT_3 }), /verification_criterion_invalid/);
});

test('mutation evidence and workspace identity inputs are bounded before state changes', () => {
  let run = createDeliveryRun(runInput({ tasks: [taskInput(1)] }), { at: AT });
  run = linkCurrent(run, 'mission-input-guards-12345678', AT_1);
  const after = baselineInput(AT_2, 'e');
  assert.throws(() => linkDeliveryRunMission(run, {
    stepId: 'STEP-001',
    bindingKey: run.tasks[0].missionBindingKey,
    missionId: 'mission-input-guards-12345678'
  }, { at: AT_2 }), /mission_link_state_invalid/);
  assert.throws(() => captureDeliveryRunImplementation(run, {
    stepId: 'STEP-001',
    missionId: run.tasks[0].missionId,
    baseline: after,
    evidence: null
  }, { at: AT_2 }), /evidence_input_invalid/);
  assert.throws(() => captureDeliveryRunImplementation(run, {
    stepId: 'STEP-001',
    missionId: run.tasks[0].missionId,
    baseline: after,
    evidence: [
      evidence('EVD-DUPLICATE-EVIDENCE', AT_2),
      evidence('EVD-DUPLICATE-EVIDENCE', AT_2)
    ]
  }, { at: AT_2 }), /evidence_duplicate/);
  assert.throws(() => captureDeliveryRunImplementation(run, {
    stepId: 'STEP-001',
    missionId: run.tasks[0].missionId,
    baseline: after,
    evidence: Array.from({ length: 513 }, (_, index) => evidence(`EVD-LIMIT-${String(index).padStart(3, '0')}`, AT_2))
  }, { at: AT_2 }), /evidence_limit_reached/);
  const changedIdentity = refreshBaselineDigests({
    ...after,
    workspace: '/srv/other-workspace',
    workspacePrefix: 'other-workspace'
  });
  assert.throws(() => captureDeliveryRunImplementation(run, {
    stepId: 'STEP-001',
    missionId: run.tasks[0].missionId,
    baseline: changedIdentity,
    evidence: []
  }, { at: AT_2 }), /baseline_identity_changed/);
});
