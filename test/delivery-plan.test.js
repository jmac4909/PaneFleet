import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalJson,
  canonicalSha256,
  compileDeliveryPlanExecutionEnvelope,
  deliveryPlanApprovalStatus,
  deliveryPlanDiscoveryBaseline,
  deliveryPlanDigest,
  deliveryPlanHasDiscoveryBaseline,
  invalidateDeliveryPlanApproval,
  lintDeliveryPlanReadiness,
  normalizeDeliveryPlan,
  transitionDeliveryPlan,
  updateDeliveryPlanDefinition,
  validateDeliveryPlan
} from '../delivery-plan.js';

const CREATED_AT = '2026-08-16T10:00:00.000Z';
const NEXT_AT = '2026-08-16T10:05:00.000Z';

function readyPlan(overrides = {}) {
  return normalizeDeliveryPlan({
    version: 1,
    id: 'plan-sdlc-12345678',
    revision: 4,
    phase: 'planning',
    title: 'Add a durable planning gate',
    request: 'Require a reviewed delivery plan before implementation begins.',
    workspace: '/srv/panefleet',
    baseline: {
      head: '960ceac898a551d63b56fa991aa8baf297f0d161',
      workingTreeDigest: 'a'.repeat(64),
      instructionsDigest: 'b'.repeat(64),
      capturedAt: CREATED_AT
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
        user: 'PaneFleet operator',
        problem: 'Rough prompts can skip requirements and verification.',
        outcome: 'Only a complete, approved plan can start implementation.',
        value: 'Fewer duplicate calls, scope changes, and unverifiable finishes.',
        nonGoals: ['Do not authorize deployment or external messages.'],
        assumptions: ['One operator owns the final product decision.'],
        openQuestions: []
      },
      ba: {
        requirements: [
          { id: 'req-001', text: 'Persist role-specific planning artifacts.' },
          { id: 'REQ-002', text: 'Trace every requirement to implementation and acceptance evidence.' }
        ],
        dependencies: ['Existing atomic queue persistence'],
        edgeCases: ['A plan changes after approval'],
        constraints: ['No arbitrary shell endpoint'],
        openQuestions: []
      },
      dev: {
        architecture: 'Use a pure domain module and atomic links to queue items.',
        steps: [
          {
            id: 'step-001',
            title: 'Implement the plan domain',
            outcome: 'The domain validates and freezes reviewed plans.',
            requirementIds: ['req-001', 'req-002'],
            scopePaths: ['delivery-plan.js', 'test/delivery-plan.test.js'],
            checks: ['node --test test/delivery-plan.test.js']
          }
        ],
        risks: ['A stale approval could otherwise survive a definition edit.'],
        rollback: 'Remove the isolated module before server integration.',
        openQuestions: []
      },
      qa: {
        acceptanceCriteria: [
          { id: 'ac-001', text: 'Incomplete traceability blocks approval.', requirementIds: ['req-001', 'req-002'] }
        ],
        testStrategy: 'Exercise normalization, validation, transitions, hashing, and envelope bounds.',
        regressionChecks: ['Existing queue behavior remains untouched.'],
        releaseRequired: true,
        releaseChecks: ['Run the complete repository gate before release.'],
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
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides
  }, { at: CREATED_AT });
}

function transition(plan, to, conditions = {}, at = NEXT_AT) {
  return transitionDeliveryPlan(plan, to, { expectedRevision: plan.revision, ...conditions }, { at });
}

test('normalization produces a bounded known schema without mutating input', () => {
  const source = {
    ...readyPlan(),
    title: '  Add a durable planning gate  ',
    roles: {
      ...readyPlan().roles,
      po: {
        ...readyPlan().roles.po,
        nonGoals: ['  Keep deploy separate.  ', 'Keep deploy separate.']
      }
    }
  };
  const snapshot = structuredClone(source);
  const plan = normalizeDeliveryPlan(source, { at: CREATED_AT });
  assert.deepEqual(source, snapshot);
  assert.equal(plan.title, 'Add a durable planning gate');
  assert.deepEqual(plan.roles.po.nonGoals, ['Keep deploy separate.']);
  assert.deepEqual(Object.keys(plan).sort(), [
    'approval', 'authority', 'baseline', 'blocker', 'classification', 'createdAt', 'gates', 'id', 'phase', 'request',
    'revision', 'roles', 'title', 'unresolvedQuestions', 'updatedAt', 'version', 'workspace'
  ]);
  assert.deepEqual(validateDeliveryPlan(plan), plan);
});

test('schema validation rejects duplicate IDs, unknown traceability, unsafe scopes, and control text', () => {
  const duplicate = readyPlan();
  duplicate.roles.ba.requirements.push({ ...duplicate.roles.ba.requirements[0] });
  assert.throws(() => validateDeliveryPlan(duplicate), /delivery_plan_requirement_id_duplicate/);

  const unknown = readyPlan();
  unknown.roles.dev.steps[0].requirementIds = ['REQ-404'];
  assert.throws(() => validateDeliveryPlan(unknown), /delivery_plan_step_requirement_unknown/);

  const traversal = readyPlan();
  traversal.roles.dev.steps[0].scopePaths = ['../outside'];
  assert.throws(() => validateDeliveryPlan(traversal), /delivery_plan_scope_path_invalid/);

  const gitInternals = readyPlan();
  gitInternals.roles.dev.steps[0].scopePaths = ['.git/config'];
  assert.throws(() => validateDeliveryPlan(gitInternals), /delivery_plan_scope_path_invalid/);

  const control = readyPlan();
  control.request = 'unsafe\u0000request';
  assert.throws(() => validateDeliveryPlan(control), /delivery_plan_control_characters_not_allowed/);
});

test('schema bounds and typed fields fail closed across the complete planning contract', () => {
  const cases = [
    [(plan) => { plan.title = 'x'.repeat(161); }, /delivery_plan_title_too_long/],
    [(plan) => { plan.revision = 0; }, /delivery_plan_revision_invalid/],
    [(plan) => { plan.workspace = 'relative/path'; }, /delivery_plan_workspace_invalid/],
    [(plan) => { plan.baseline.head = 'not-a-head'; }, /delivery_plan_baseline_head_invalid/],
    [(plan) => { plan.baseline.workingTreeDigest = 'short'; }, /delivery_plan_baseline_digest_invalid/],
    [(plan) => { plan.baseline.capturedAt = 'yesterday'; }, /delivery_plan_baseline_timestamp_invalid/],
    [(plan) => { plan.classification.intent = 'guess'; }, /delivery_plan_classification_intent_invalid/],
    [(plan) => { plan.classification.depth = 'huge'; }, /delivery_plan_classification_depth_invalid/],
    [(plan) => { plan.classification.risk = 'unknown'; }, /delivery_plan_classification_risk_invalid/],
    [(plan) => { plan.roles.ba.requirements = [null]; }, /delivery_plan_requirement_id_invalid/],
    [(plan) => { plan.roles.ba.requirements = Array.from({ length: 81 }, (_, index) => ({ id: `REQ-${index}`, text: 'Bounded' })); }, /delivery_plan_requirements_invalid/],
    [(plan) => { plan.roles.dev.steps = Array.from({ length: 81 }, (_, index) => ({ id: `STEP-${index}`, title: 'Step', outcome: 'Outcome', requirementIds: [], scopePaths: [], checks: [] })); }, /delivery_plan_steps_invalid/],
    [(plan) => { plan.roles.qa.acceptanceCriteria = Array.from({ length: 121 }, (_, index) => ({ id: `AC-${index}`, text: 'Criterion', requirementIds: [] })); }, /delivery_plan_acceptance_criteria_invalid/],
    [(plan) => { plan.roles.qa.releaseRequired = 'yes'; }, /delivery_plan_release_required_invalid/],
    [(plan) => { plan.authority.push = 'yes'; }, /delivery_plan_authority_invalid/],
    [(plan) => { plan.gates.qaPassed = 'yes'; }, /delivery_plan_gates_invalid/],
    [(plan) => { plan.approval = { digest: 'a'.repeat(64), approvedAt: null, planRevision: 1 }; }, /delivery_plan_approval_invalid/]
  ];
  for (const [mutate, expected] of cases) {
    const plan = readyPlan();
    mutate(plan);
    assert.throws(() => validateDeliveryPlan(plan), expected);
  }
});

test('canonical JSON and plan digests are deterministic and definition-only', () => {
  assert.equal(canonicalJson({ z: [3, { b: 2, a: 1 }], a: true }), '{"a":true,"z":[3,{"a":1,"b":2}]}');
  assert.equal(canonicalSha256({ b: 2, a: 1 }), canonicalSha256({ a: 1, b: 2 }));
  assert.throws(() => canonicalJson({ value: undefined }), /undefined/);
  const circular = {};
  circular.self = circular;
  assert.throws(() => canonicalJson(circular), /circular/);

  const plan = readyPlan();
  const digest = deliveryPlanDigest(plan);
  const lifecycleOnly = { ...plan, revision: 99, phase: 'blocked', blocker: 'Paused', updatedAt: NEXT_AT };
  assert.equal(deliveryPlanDigest(lifecycleOnly), digest);
  const refreshedEvidenceTime = {
    ...plan,
    baseline: { ...plan.baseline, capturedAt: NEXT_AT }
  };
  assert.equal(deliveryPlanDigest(refreshedEvidenceTime), digest);
  assert.notEqual(deliveryPlanDigest({ ...plan, request: `${plan.request} Changed.` }), digest);
});

test('Definition of Ready lint requires all four roles and end-to-end traceability', () => {
  const ready = lintDeliveryPlanReadiness(readyPlan());
  assert.equal(ready.ready, true);
  assert.equal(ready.errors.length, 0);
  assert.deepEqual(ready.traceability, [{
    requirementId: 'REQ-001',
    stepIds: ['STEP-001'],
    acceptanceIds: ['AC-001'],
    complete: true
  }, {
    requirementId: 'REQ-002',
    stepIds: ['STEP-001'],
    acceptanceIds: ['AC-001'],
    complete: true
  }]);

  const incomplete = readyPlan();
  incomplete.roles.dev.steps[0].requirementIds = ['REQ-001'];
  incomplete.roles.qa.acceptanceCriteria[0].requirementIds = ['REQ-001'];
  incomplete.roles.qa.openQuestions = ['Who performs the release smoke test?'];
  const lint = lintDeliveryPlanReadiness(incomplete);
  assert.equal(lint.ready, false);
  assert.deepEqual(new Set(lint.errors.map((finding) => finding.code)), new Set([
    'unresolved_questions',
    'requirement_missing_step',
    'requirement_missing_acceptance'
  ]));
});

test('a discovery baseline permits workshop planning but blocks approval until Git is connected', () => {
  const plan = readyPlan({
    baseline: deliveryPlanDiscoveryBaseline('/srv/panefleet', { at: CREATED_AT })
  });
  assert.equal(deliveryPlanHasDiscoveryBaseline(plan), true);
  const readiness = lintDeliveryPlanReadiness(plan);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.errors.some((finding) => finding.code === 'baseline_discovery_only'), true);
  assert.throws(() => transition(plan, 'ready_for_approval'), /delivery_plan_not_ready/);
  assert.equal(deliveryPlanHasDiscoveryBaseline(readyPlan()), false);
});

test('Definition of Ready reports every missing PO, BA, DEV, QA, baseline, and release obligation', () => {
  const incomplete = readyPlan();
  incomplete.workspace = '';
  incomplete.baseline = { head: '', workingTreeDigest: '', instructionsDigest: '', capturedAt: '' };
  incomplete.classification = { intent: '', depth: '', risk: '', dataClasses: [], mutationSurfaces: [] };
  incomplete.roles.po = {
    ...incomplete.roles.po,
    user: '', problem: '', outcome: '', value: '', nonGoals: []
  };
  incomplete.roles.ba.requirements = [];
  incomplete.roles.dev = {
    ...incomplete.roles.dev,
    architecture: '', steps: [], rollback: ''
  };
  incomplete.roles.qa = {
    ...incomplete.roles.qa,
    acceptanceCriteria: [], testStrategy: '', regressionChecks: [], releaseRequired: true, releaseChecks: []
  };
  const lint = lintDeliveryPlanReadiness(incomplete);
  assert.equal(lint.ready, false);
  const codes = new Set(lint.errors.map((finding) => finding.code));
  for (const code of [
    'po_user_missing', 'po_problem_missing', 'po_outcome_missing', 'po_value_missing',
    'po_non_goals_missing', 'workspace_missing', 'baseline_head_missing',
    'baseline_worktree_missing', 'baseline_instructions_missing', 'baseline_timestamp_missing',
    'classification_intent_missing', 'classification_depth_missing', 'classification_risk_missing',
    'ba_requirements_missing', 'dev_architecture_missing', 'dev_steps_missing',
    'dev_rollback_missing', 'qa_acceptance_missing', 'qa_test_strategy_missing',
    'qa_regression_missing', 'qa_release_checks_missing'
  ]) assert.equal(codes.has(code), true, code);
});

test('legal transitions enforce approval, exact execution gates, QA, and release evidence', () => {
  const readyForApproval = transition(readyPlan(), 'ready_for_approval');
  assert.equal(readyForApproval.phase, 'ready_for_approval');
  assert.throws(
    () => transition(readyForApproval, 'approved'),
    /delivery_plan_approval_confirmation_required/
  );
  const approved = transition(readyForApproval, 'approved', { confirmation: 'approve-plan' }, '2026-08-16T10:10:00.000Z');
  assert.equal(approved.phase, 'approved');
  assert.equal(deliveryPlanApprovalStatus(approved), 'current');
  assert.equal(approved.approval.planRevision, approved.revision);

  assert.throws(
    () => transition(approved, 'executing', {
      confirmation: 'start-execution', baselineCurrent: false, workspaceAvailable: true, taskGraphReady: true
    }),
    /delivery_plan_baseline_changed/
  );
  assert.throws(
    () => transition(approved, 'executing', {
      confirmation: 'start-execution', baselineCurrent: true, workspaceAvailable: true, taskGraphReady: false
    }),
    /delivery_plan_task_graph_required/
  );
  const executing = transition(approved, 'executing', {
    confirmation: 'start-execution', baselineCurrent: true, workspaceAvailable: true, taskGraphReady: true
  }, '2026-08-16T10:15:00.000Z');
  assert.throws(() => transition(executing, 'verifying'), /delivery_plan_implementation_evidence_required/);
  const verifying = transition(executing, 'verifying', { implementationResultCaptured: true }, '2026-08-16T10:20:00.000Z');
  assert.throws(() => transition(verifying, 'ready_to_release'), /delivery_plan_qa_pass_required/);
  const releaseReady = transition(verifying, 'ready_to_release', { qaPassed: true }, '2026-08-16T10:25:00.000Z');
  assert.throws(
    () => transition(releaseReady, 'done', { confirmation: 'complete-plan' }),
    /delivery_plan_release_verification_required/
  );
  const done = transition(releaseReady, 'done', {
    confirmation: 'complete-plan', releaseVerified: true
  }, '2026-08-16T10:30:00.000Z');
  assert.equal(done.phase, 'done');
  assert.equal(done.gates.releaseVerified, true);
  assert.throws(() => transition(done, 'planning'), /delivery_plan_transition_invalid/);
});

test('decision, cancellation, replan, revision, and remediation transitions require exact evidence', () => {
  const plan = readyPlan();
  assert.throws(
    () => transitionDeliveryPlan(plan, 'ready_for_approval', { expectedRevision: 99 }, { at: NEXT_AT }),
    /delivery_plan_revision_conflict/
  );
  assert.throws(() => transition(plan, 'needs_decision'), /delivery_plan_blocker_required/);
  const needsDecision = transition(plan, 'needs_decision', { reason: 'Operator must choose the release target.' });
  assert.equal(needsDecision.blocker, 'Operator must choose the release target.');
  assert.throws(() => transition(needsDecision, 'canceled'), /delivery_plan_cancellation_confirmation_required/);
  const canceled = transition(needsDecision, 'canceled', { confirmation: 'cancel-plan' });
  assert.equal(canceled.phase, 'canceled');
  assert.throws(() => invalidateDeliveryPlanApproval(canceled), /delivery_plan_terminal/);
  assert.throws(() => updateDeliveryPlanDefinition(canceled, { title: 'No edit' }), /delivery_plan_terminal/);

  const readyForApproval = transition(readyPlan(), 'ready_for_approval');
  const approved = transition(readyForApproval, 'approved', { confirmation: 'approve-plan' });
  assert.throws(() => transition(approved, 'planning'), /delivery_plan_replan_confirmation_required/);
  const replanning = transition(approved, 'planning', { confirmation: 'replan' });
  assert.equal(replanning.phase, 'planning');
  assert.equal(replanning.approval.digest, '');

  const executing = transition(approved, 'executing', {
    confirmation: 'start-execution', baselineCurrent: true, workspaceAvailable: true, taskGraphReady: true
  });
  assert.throws(
    () => transition(executing, 'planning', { confirmation: 'replan' }),
    /delivery_plan_execution_locked/
  );
  assert.throws(
    () => transition(executing, 'planning', { confirmation: 'replan', deliveryRunAborted: false }),
    /delivery_plan_execution_locked/
  );
  const abortedReplan = transition(executing, 'planning', {
    confirmation: 'replan', deliveryRunAborted: true
  });
  assert.equal(abortedReplan.phase, 'planning');
  assert.deepEqual(abortedReplan.approval, { digest: '', approvedAt: null, planRevision: null });
  assert.deepEqual(abortedReplan.gates, {
    implementationCaptured: false,
    qaPassed: false,
    releaseVerified: false
  });
  const verifying = transition(executing, 'verifying', { implementationResultCaptured: true });
  const resumeConditions = {
    confirmation: 'resume-execution', remediationApproved: true,
    baselineCurrent: true, workspaceAvailable: true, taskGraphReady: true
  };
  assert.throws(
    () => transition(verifying, 'executing', { ...resumeConditions, confirmation: '' }),
    /delivery_plan_remediation_confirmation_required/
  );
  assert.throws(
    () => transition(verifying, 'executing', { ...resumeConditions, remediationApproved: false }),
    /delivery_plan_remediation_approval_required/
  );
  const remediating = transition(verifying, 'executing', resumeConditions);
  assert.equal(remediating.gates.implementationCaptured, false);
  assert.equal(remediating.gates.qaPassed, false);
});

test('persisted verification, QA, and release phases require their own evidence gates', () => {
  const readyForApproval = transition(readyPlan(), 'ready_for_approval');
  const approved = transition(readyForApproval, 'approved', { confirmation: 'approve-plan' });
  const executing = transition(approved, 'executing', {
    confirmation: 'start-execution', baselineCurrent: true, workspaceAvailable: true, taskGraphReady: true
  });
  const verifying = transition(executing, 'verifying', { implementationResultCaptured: true });
  assert.throws(
    () => validateDeliveryPlan({ ...verifying, gates: { ...verifying.gates, implementationCaptured: false } }),
    /delivery_plan_implementation_evidence_required/
  );
  const releaseReady = transition(verifying, 'ready_to_release', { qaPassed: true });
  assert.throws(
    () => validateDeliveryPlan({ ...releaseReady, gates: { ...releaseReady.gates, qaPassed: false } }),
    /delivery_plan_qa_pass_required/
  );
  const done = transition(releaseReady, 'done', { confirmation: 'complete-plan', releaseVerified: true });
  assert.throws(
    () => validateDeliveryPlan({ ...done, gates: { ...done.gates, releaseVerified: false } }),
    /delivery_plan_release_verification_required/
  );
});

test('definition edits and explicit invalidation remove stale approval and execution evidence', () => {
  const readyForApproval = transition(readyPlan(), 'ready_for_approval');
  const approved = transition(readyForApproval, 'approved', { confirmation: 'approve-plan' });
  const unchanged = updateDeliveryPlanDefinition(approved, { title: approved.title }, { at: NEXT_AT });
  assert.deepEqual(unchanged, approved);

  const updated = updateDeliveryPlanDefinition(approved, {
    roles: { po: { value: 'Prevent ambiguous execution and make delivery evidence reviewable.' } }
  }, { at: '2026-08-16T10:15:00.000Z' });
  assert.equal(updated.revision, approved.revision + 1);
  assert.equal(updated.phase, 'ready_for_approval');
  assert.equal(updated.approval.digest, '');
  assert.equal(deliveryPlanApprovalStatus(updated), 'missing');
  assert.notEqual(deliveryPlanDigest(updated), approved.approval.digest);

  const invalidated = invalidateDeliveryPlanApproval(approved, { at: '2026-08-16T10:20:00.000Z' });
  assert.equal(invalidated.phase, 'ready_for_approval');
  assert.deepEqual(invalidated.approval, { digest: '', approvedAt: null, planRevision: null });
  assert.deepEqual(invalidated.gates, {
    implementationCaptured: false,
    qaPassed: false,
    releaseVerified: false
  });
});

test('execution compiler emits only an approved bounded step envelope', () => {
  const readyForApproval = transition(readyPlan(), 'ready_for_approval');
  const approved = transition(readyForApproval, 'approved', { confirmation: 'approve-plan' });
  const envelope = compileDeliveryPlanExecutionEnvelope(approved, { stepId: 'step-001' });
  assert.equal(envelope.planId, approved.id);
  assert.equal(envelope.stepId, 'STEP-001');
  assert.equal(envelope.digest, approved.approval.digest);
  assert.equal(envelope.chars, envelope.text.length);
  assert.equal(envelope.chars <= 4000, true);
  assert.match(envelope.text, /REQ-001: Persist role-specific planning artifacts/);
  assert.match(envelope.text, /AC-001: Incomplete traceability blocks approval/);
  assert.match(envelope.text, /Forbidden without a separate explicit approval: commit, push, deploy, network, serviceControl, destructive, externalMessages/);
  assert.match(envelope.text, /\[PANEFLEET DELIVERY RESULT\]/);
  assert.match(envelope.text, new RegExp(`DIGEST: ${approved.approval.digest}`));

  assert.throws(
    () => compileDeliveryPlanExecutionEnvelope(readyPlan(), { stepId: 'STEP-001' }),
    /delivery_plan_not_approved_for_execution/
  );
  assert.throws(
    () => compileDeliveryPlanExecutionEnvelope(approved, { stepId: 'STEP-404' }),
    /delivery_plan_step_not_found/
  );
  assert.throws(
    () => compileDeliveryPlanExecutionEnvelope(approved, { stepId: 'STEP-001', maxChars: 800 }),
    /delivery_plan_execution_envelope_too_long/
  );
  assert.throws(
    () => compileDeliveryPlanExecutionEnvelope(approved, { stepId: 'STEP-001', maxChars: 799 }),
    /delivery_plan_execution_envelope_limit_invalid/
  );
});

test('persisted approved phases reject stale or missing approval state', () => {
  const readyForApproval = transition(readyPlan(), 'ready_for_approval');
  const approved = transition(readyForApproval, 'approved', { confirmation: 'approve-plan' });
  assert.throws(
    () => validateDeliveryPlan({ ...approved, request: `${approved.request} silently changed` }),
    /delivery_plan_approval_not_current/
  );
  assert.throws(
    () => validateDeliveryPlan({ ...approved, approval: { digest: '', approvedAt: null, planRevision: null } }),
    /delivery_plan_approval_not_current/
  );
});
