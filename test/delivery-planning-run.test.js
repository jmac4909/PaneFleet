import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalSha256,
  deliveryPlanDiscoveryBaseline,
  lintDeliveryPlanReadiness,
  normalizeDeliveryPlan
} from '../delivery-plan.js';
import {
  PLANNING_ROLE_REPORT_MAX_PERSISTED_BYTES,
  planningRoleReportOutputDigest
} from '../planning-role-report.js';
import {
  DELIVERY_PLANNING_RUN_CONDITIONS,
  DELIVERY_PLANNING_RUN_MAX_CLEANUP_CONTINUE_RECEIPTS,
  DELIVERY_PLANNING_RUN_MAX_RESOURCE_CONTINUE_RECEIPTS,
  DELIVERY_PLANNING_RUN_PHASES,
  DELIVERY_PLANNING_ROLE_ENVELOPE_MAX_CHARS,
  DELIVERY_PLANNING_SPAWN_LEASE_MAX_BIND_MS,
  DELIVERY_PLANNING_RUN_ROLES,
  DELIVERY_PLANNING_RUN_ROLE_STATES,
  DELIVERY_PLANNING_SOURCE_PLAN_MAX_PERSISTED_BYTES,
  abandonDeliveryPlanningApply,
  authorizeDeliveryPlanningContinue,
  bindDeliveryPlanningRoleSpawnLease,
  cancelDeliveryPlanningRun,
  claimDeliveryPlanningApply,
  claimDeliveryPlanningRoleCleanup,
  claimDeliveryPlanningRoleDispatch,
  claimDeliveryPlanningRoleSpawn as claimDeliveryPlanningRoleSpawnDomain,
  claimDeliveryPlanningRoleSpawnLeaseCleanup,
  compileDeliveryPlanningCandidate,
  compileDeliveryPlanningRoleEnvelope,
  createDeliveryPlanningRun,
  deliveryPlanningRoleEligibility,
  deliveryPlanningRoleInputDigest,
  deliveryPlanningRoleSpawnLeaseBinding,
  deliveryPlanningResourceRetryEligibility,
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
} from '../delivery-planning-run.js';

const START = Date.parse('2026-08-16T20:00:00.000Z');
const RUN_ID = 'planning-run-domain-12345678';

function at(index) {
  return new Date(START + (index * 1000)).toISOString();
}

function sourcePlan(overrides = {}) {
  return normalizeDeliveryPlan({
    version: 1,
    id: 'plan-planning-12345678',
    revision: 7,
    phase: 'planning',
    title: 'Add multi-role planning',
    request: 'Have PO, BA, QA, and DEV establish an exact delivery plan before implementation.',
    workspace: '/srv/panefleet',
    baseline: {
      head: '960ceac898a551d63b56fa991aa8baf297f0d161',
      workingTreeDigest: 'a'.repeat(64),
      instructionsDigest: 'b'.repeat(64),
      capturedAt: at(0)
    },
    classification: {
      intent: 'build',
      depth: 'standard',
      risk: 'local_reversible',
      dataClasses: [],
      mutationSurfaces: ['workspace']
    },
    roles: {
      po: {
        user: 'PaneFleet operator',
        problem: 'Planning is incomplete.',
        outcome: 'A reviewed plan exists.',
        value: 'Fewer failures.',
        nonGoals: ['No deployment.'], assumptions: [], openQuestions: []
      },
      ba: {
        requirements: [{ id: 'REQ-OLD', text: 'Old draft requirement.' }],
        dependencies: [], edgeCases: [], constraints: [], openQuestions: []
      },
      dev: {
        architecture: 'Old draft.',
        steps: [{
          id: 'STEP-OLD', title: 'Old step', outcome: 'Old outcome',
          requirementIds: ['REQ-OLD'], scopePaths: ['old.js'], checks: ['old check']
        }],
        risks: [], rollback: 'Revert old draft.', openQuestions: []
      },
      qa: {
        acceptanceCriteria: [{ id: 'AC-OLD', text: 'Old criterion.', requirementIds: ['REQ-OLD'] }],
        testStrategy: 'Old tests.', regressionChecks: ['Old regression.'],
        releaseRequired: false, releaseChecks: [], openQuestions: []
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
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides
  }, { at: at(0) });
}

function spawnLeaseBinding(run, role, attemptId, claimedAt = at(1), overrides = {}) {
  return deliveryPlanningRoleSpawnLeaseBinding(run, {
    role,
    attemptId,
    contextDigest: canonicalSha256({ runId: run.id, role, attemptId, purpose: 'context' }),
    launchDigest: canonicalSha256({ runId: run.id, role, attemptId, purpose: 'launch' }),
    bindDeadlineAt: new Date(Date.parse(claimedAt) + 60_000).toISOString(),
    ...overrides
  });
}

function claimDeliveryPlanningRoleSpawn(run, input, options = {}) {
  const claimedAt = options.at ?? new Date().toISOString();
  return claimDeliveryPlanningRoleSpawnDomain(run, {
    ...input,
    spawnLease: input.spawnLease ?? spawnLeaseBinding(run, input.role, input.attemptId, claimedAt)
  }, options);
}

const ARTIFACTS = Object.freeze({
  po: {
    user: 'PaneFleet operator',
    problem: 'Unstructured delivery skips shared requirements.',
    outcome: 'A four-role plan is ready for review before implementation.',
    value: 'Reduce drift and uncertain completion.',
    nonGoals: ['Do not approve, execute, commit, push, or deploy.'],
    assumptions: ['The operator owns approval.'],
    openQuestions: []
  },
  ba: {
    requirements: [{ id: 'REQ-001', text: 'Persist exact role reports and their bindings.' }],
    dependencies: ['Existing Delivery Plan store'],
    edgeCases: ['A worker identity changes after dispatch.'],
    constraints: ['No automatic retry of uncertain input.'],
    openQuestions: []
  },
  qa: {
    acceptanceCriteria: [{
      id: 'AC-001',
      text: 'An exact bound result is required before candidate synthesis.',
      requirementIds: ['REQ-001']
    }],
    testStrategy: 'Exercise each durable transition and fail-closed branch.',
    regressionChecks: ['Existing Delivery Plan behavior stays intact.'],
    releaseRequired: false,
    releaseChecks: [],
    openQuestions: []
  },
  dev: {
    architecture: 'Use a strict pure state machine behind a CAS repository.',
    steps: [{
      id: 'STEP-001',
      title: 'Implement planning lifecycle',
      outcome: 'Role results synthesize one reviewable candidate.',
      requirementIds: ['REQ-001'],
      scopePaths: ['delivery-planning-run.js', 'test/delivery-planning-run.test.js'],
      checks: ['node --test test/delivery-planning-run.test.js']
    }],
    risks: ['A stale report could otherwise be accepted.'],
    rollback: 'Remove the isolated planning module before activation.',
    openQuestions: []
  }
});

function worker(index = 1, lease = null) {
  const session = lease?.session || `codex-planning-${String(index).padStart(24, '0')}-po`;
  return {
    session,
    sessionCreatedAt: at(index),
    paneId: `${session}:0.0`,
    tmuxPaneId: `%${100 + index}`,
    panePid: 1000 + index,
    paneTty: `/dev/pts/${index}`,
    codexPid: 2000 + index,
    rolloutId: `12345678-1234-1234-1234-${String(index).padStart(12, '0')}`,
    sourceId: String(index % 10).repeat(24),
    commandDigest: lease?.launchDigest || String((index % 9) + 1).repeat(64),
    scopeUnit: lease?.scopeUnit || `panefleet-planning-${String(index).padStart(24, '0')}.scope`,
    scopeDigest: lease?.scopeDigest || String((index % 8) + 1).repeat(64)
  };
}

function bindSpawnLease(run, role, attemptId, index) {
  const lease = run.roles[role].attempts.at(-1).spawnLease;
  const binding = worker(index, lease);
  return bindDeliveryPlanningRoleSpawnLease(run, {
    role,
    attemptId,
    leaseId: lease.leaseId,
    scopeUnit: lease.scopeUnit,
    scopeDigest: lease.scopeDigest,
    observed: {
      sessionCreatedAt: binding.sessionCreatedAt,
      paneId: binding.paneId,
      tmuxPaneId: binding.tmuxPaneId,
      panePid: binding.panePid,
      paneTty: binding.paneTty
    }
  }, { at: at(index) });
}

function report(run, role, attemptId, status = 'complete', overrides = {}) {
  return {
    version: 1,
    runId: run.id,
    planId: run.planId,
    planRevision: run.planRevision,
    role,
    attemptId,
    inputDigest: run.roles[role].inputDigest,
    status,
    artifact: structuredClone(ARTIFACTS[role]),
    challenges: status === 'complete' ? [] : [`${role} needs operator review.`],
    evidence: [{ summary: `${role} inspected the bounded planning input.`, trusted: false }],
    ...overrides
  };
}

function dispatchRole(run, role, index) {
  const attemptId = `planning-attempt-${role}-${String(index).padStart(8, '0')}`;
  let next = claimDeliveryPlanningRoleSpawn(run, { role, attemptId }, { at: at(index) });
  next = bindSpawnLease(next, role, attemptId, index);
  const lease = next.roles[role].attempts.at(-1).spawnLease;
  const envelope = compileDeliveryPlanningRoleEnvelope(run, { role });
  const confirmationMarker = `[PaneFleet Planning Dispatch ${attemptId}]`;
  next = claimDeliveryPlanningRoleDispatch(next, {
    role,
    attemptId,
    leaseId: lease.leaseId,
    worker: worker(index, lease),
    rolloutPath: `/srv/codex/rollout-${index}.jsonl`,
    rolloutStartOffset: index * 100,
    confirmationMarker,
    promptDigest: canonicalSha256(`${envelope.text}\n${confirmationMarker}`)
  }, { at: at(index + 1) });
  next = markDeliveryPlanningRoleDispatched(next, { role, attemptId }, { at: at(index + 2) });
  return { run: next, attemptId };
}

function finishRole(run, role, index, status = 'complete') {
  const dispatched = dispatchRole(run, role, index);
  const roleReport = report(dispatched.run, role, dispatched.attemptId, status);
  let next = recordDeliveryPlanningRoleReport(dispatched.run, {
    role,
    attemptId: dispatched.attemptId,
    report: roleReport,
    outputDigest: planningRoleReportOutputDigest(roleReport)
  }, { at: at(index + 3) });
  if (next.roles[role].attempts.at(-1).cleanup) {
    next = claimDeliveryPlanningRoleCleanup(next, {
      role, attemptId: dispatched.attemptId, claimId: `cleanup:${role}:${index}`
    }, { at: at(index + 4) });
    next = markDeliveryPlanningRoleCleanupSent(next, {
      role, attemptId: dispatched.attemptId
    }, { at: at(index + 5) });
    next = markDeliveryPlanningRoleCleanupComplete(next, {
      role, attemptId: dispatched.attemptId
    }, { at: at(index + 6) });
  }
  return next;
}

function throughBa(plan = sourcePlan()) {
  let run = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: plan }, { at: at(0) });
  run = finishRole(run, 'po', 10);
  run = finishRole(run, 'ba', 20);
  return run;
}

function synthesizedRun(plan = sourcePlan()) {
  let run = throughBa(plan);
  run = finishRole(run, 'qa', 30);
  run = finishRole(run, 'dev', 40);
  return compileDeliveryPlanningCandidate(run, {}, { at: at(50) });
}

function assertTamper(run, mutate, expected) {
  const copy = structuredClone(run);
  mutate(copy);
  assert.throws(() => validateDeliveryPlanningRun(copy), expected);
}

test('creation freezes the exact planning Plan, baseline, authority, and initial role graph', () => {
  const plan = sourcePlan();
  const snapshot = structuredClone(plan);
  const run = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: plan }, { at: at(1) });
  assert.deepEqual(plan, snapshot);
  assert.equal(run.phase, 'po');
  assert.equal(run.condition, 'active');
  assert.equal(run.planId, plan.id);
  assert.equal(run.planRevision, plan.revision);
  assert.deepEqual(run.baseline, plan.baseline);
  assert.deepEqual(Object.keys(run.roles), ['po', 'ba', 'qa', 'dev']);
  assert.deepEqual(DELIVERY_PLANNING_RUN_ROLES, ['po', 'ba', 'qa', 'dev']);
  assert.equal(DELIVERY_PLANNING_RUN_PHASES.includes('review'), true);
  assert.equal(DELIVERY_PLANNING_RUN_CONDITIONS.includes('reconcile_required'), true);
  assert.equal(DELIVERY_PLANNING_RUN_ROLE_STATES.includes('dispatch_claimed'), true);
  assert.deepEqual(validateDeliveryPlanningRun(run), run);
  assert.throws(
    () => validateDeliveryPlanningRun({ ...run, planDigest: '0'.repeat(64) }),
    /delivery_planning_run_plan_binding_mismatch/
  );
  assert.throws(
    () => validateDeliveryPlanningRun({ ...run, baseline: { ...run.baseline, head: 'c'.repeat(40) } }),
    /delivery_planning_run_baseline_binding_mismatch/
  );
});

test('eligibility and envelopes enforce PO then BA and identical independent QA plus DEV context', () => {
  const initial = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: sourcePlan() }, { at: at(0) });
  assert.equal(deliveryPlanningRoleEligibility(initial).role, 'po');
  assert.equal(deliveryPlanningRoleEligibility(initial, 'ba').eligible, false);
  assert.equal(deliveryPlanningRoleInputDigest(initial, 'po'), deliveryPlanningRoleEligibility(initial, 'po').inputDigest);
  const poEnvelope = compileDeliveryPlanningRoleEnvelope(initial, { role: 'po' });
  assert.equal(poEnvelope.inputDigest, deliveryPlanningRoleInputDigest(initial, 'po'));
  assert.match(poEnvelope.text, /Act only as Product Owner/);
  assert.match(poEnvelope.text, /writeAllowed/);
  assert.doesNotMatch(poEnvelope.text, /PANEFLEET PLANNING RESULT\]\n/);

  const challenged = throughBa();
  assert.equal(challenged.phase, 'challenge');
  const qa = compileDeliveryPlanningRoleEnvelope(challenged, { role: 'qa' });
  const dev = compileDeliveryPlanningRoleEnvelope(challenged, { role: 'dev' });
  assert.equal(qa.commonInputDigest, dev.commonInputDigest);
  assert.notEqual(qa.inputDigest, dev.inputDigest);
  assert.match(qa.text, /Do not assume or consume DEV output/);
  assert.match(dev.text, /Do not assume or consume QA output/);
  assert.throws(
    () => compileDeliveryPlanningRoleEnvelope(initial, { role: 'ba' }),
    /delivery_planning_run_role_phase_ineligible/
  );
  assert.throws(
    () => compileDeliveryPlanningRoleEnvelope(initial, { role: 'po', maxChars: 999 }),
    /delivery_planning_run_role_envelope_limit_invalid/
  );
});

test('the exact spawn, identity, dispatch, result, and cleanup chain advances roles only after cleanup', () => {
  let run = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: sourcePlan() }, { at: at(0) });
  const attemptId = 'planning-attempt-po-00000001';
  run = claimDeliveryPlanningRoleSpawn(run, { role: 'po', attemptId }, { at: at(1) });
  assert.equal(run.roles.po.state, 'spawn_claimed');
  assert.equal(run.roles.po.attempts[0].inputDigest, run.roles.po.inputDigest);
  run = bindSpawnLease(run, 'po', attemptId, 1);
  const lease = run.roles.po.attempts[0].spawnLease;
  const envelope = compileDeliveryPlanningRoleEnvelope(
    createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: sourcePlan() }, { at: at(0) }),
    { role: 'po' }
  );
  run = claimDeliveryPlanningRoleDispatch(run, {
    role: 'po', attemptId, leaseId: lease.leaseId, worker: worker(1, lease),
    rolloutPath: '/srv/codex/po.jsonl', rolloutStartOffset: 99,
    confirmationMarker: `[PaneFleet Planning Dispatch ${attemptId}]`, promptDigest: canonicalSha256(envelope.text)
  }, { at: at(2) });
  assert.equal(run.roles.po.state, 'dispatch_claimed');
  assert.equal(run.roles.po.attempts[0].tmuxPaneId, '%101');
  run = markDeliveryPlanningRoleDispatched(run, { role: 'po', attemptId }, { at: at(3) });
  const poReport = report(run, 'po', attemptId);
  run = recordDeliveryPlanningRoleReport(run, {
    role: 'po', attemptId, report: poReport, outputDigest: planningRoleReportOutputDigest(poReport)
  }, { at: at(4) });
  assert.equal(run.roles.po.state, 'completed');
  assert.equal(run.phase, 'po');
  assert.equal(run.roles.po.attempts[0].cleanup.state, 'pending');
  run = claimDeliveryPlanningRoleCleanup(run, { role: 'po', attemptId, claimId: 'cleanup:po:00000001' }, { at: at(5) });
  run = markDeliveryPlanningRoleCleanupSent(run, { role: 'po', attemptId }, { at: at(6) });
  run = markDeliveryPlanningRoleCleanupComplete(run, { role: 'po', attemptId }, { at: at(7) });
  assert.equal(run.phase, 'ba');
  assert.equal(deliveryPlanningRoleEligibility(run).role, 'ba');
});

test('provisional spawn leases are Run-bound, deadline-bound, and close only after exact absence', () => {
  const fresh = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: sourcePlan() }, { at: at(0) });
  const attemptId = 'planning-attempt-po-provisional1';
  const spawnLease = spawnLeaseBinding(fresh, 'po', attemptId, at(1), {
    bindDeadlineAt: at(3)
  });
  assert.deepEqual(
    spawnLease,
    deliveryPlanningRoleSpawnLeaseBinding(fresh, {
      role: 'po',
      attemptId,
      contextDigest: spawnLease.contextDigest,
      launchDigest: spawnLease.launchDigest,
      bindDeadlineAt: at(3)
    })
  );
  assert.match(spawnLease.leaseId, /^planning-spawn-lease-[a-f0-9]{24}-po$/);
  assert.match(spawnLease.session, /^codex-planning-[a-f0-9]{24}-po$/);
  assert.match(spawnLease.scopeUnit, /^panefleet-planning-[a-f0-9]{24}\.scope$/);
  assert.throws(() => deliveryPlanningRoleSpawnLeaseBinding(fresh, {
    role: 'po', attemptId, contextDigest: spawnLease.contextDigest,
    launchDigest: spawnLease.launchDigest, bindDeadlineAt: 'not-a-time'
  }), /spawn_lease_deadline_invalid/);

  const other = createDeliveryPlanningRun({
    id: 'planning-run-domain-other-12345678',
    sourcePlan: sourcePlan({ id: 'plan-planning-other-12345678' })
  }, { at: at(0) });
  assert.throws(() => claimDeliveryPlanningRoleSpawnDomain(other, {
    role: 'po', attemptId, spawnLease
  }, { at: at(1) }), /spawn_lease_binding_mismatch/);

  let claimed = claimDeliveryPlanningRoleSpawnDomain(fresh, {
    role: 'po', attemptId, spawnLease
  }, { at: at(1) });
  assert.equal(claimed.roles.po.attempts[0].spawnLease.state, 'claimed');
  const bindInput = {
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    scopeUnit: spawnLease.scopeUnit, scopeDigest: spawnLease.scopeDigest,
    observed: {
      sessionCreatedAt: at(2), paneId: `${spawnLease.session}:0.0`, tmuxPaneId: '%901',
      panePid: 9001, paneTty: '/dev/pts/91'
    }
  };
  assert.throws(() => bindDeliveryPlanningRoleSpawnLease(claimed, {
    ...bindInput, observed: { ...bindInput.observed, sessionCreatedAt: 'not-a-time' }
  }, { at: at(2) }), /session_timestamp_invalid/);
  assert.throws(() => bindDeliveryPlanningRoleSpawnLease(claimed, {
    ...bindInput, observed: { ...bindInput.observed, tmuxPaneId: 'pane-901' }
  }, { at: at(2) }), /tmux_pane_id_invalid/);
  assert.throws(() => bindDeliveryPlanningRoleSpawnLease(claimed, {
    ...bindInput, observed: { ...bindInput.observed, panePid: 0 }
  }, { at: at(2) }), /pane_pid_invalid/);
  assert.throws(() => cancelDeliveryPlanningRun(claimed, {
    operatorConfirmed: true, reason: 'A provisional scope may still exist.'
  }, { at: at(2) }), /cleanup_required/);
  assert.throws(() => bindDeliveryPlanningRoleSpawnLease(claimed, {
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    scopeUnit: spawnLease.scopeUnit, scopeDigest: spawnLease.scopeDigest,
    observed: {
      sessionCreatedAt: at(2), paneId: `${spawnLease.session}:0.0`, tmuxPaneId: '%901',
      panePid: 9001, paneTty: '/dev/pts/91'
    }
  }, { at: at(4) }), /bind_deadline_expired/);

  claimed = closeDeliveryPlanningRoleSpawnLeaseAbsent(claimed, {
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    scopeUnit: spawnLease.scopeUnit, scopeDigest: spawnLease.scopeDigest,
    observation: 'scope_and_pane_absent',
    reason: 'The deterministic scope and tmux pane are both absent.'
  }, { at: at(4) });
  assert.equal(claimed.roles.po.attempts[0].spawnLease.state, 'closed');
  assert.equal(claimed.roles.po.attempts[0].state, 'crashed');
  assert.equal(claimed.roles.po.state, 'failed');
  claimed = cancelDeliveryPlanningRun(claimed, {
    operatorConfirmed: true, reason: 'The provisional lease is authoritatively closed.'
  }, { at: at(5) });
  assert.equal(claimed.condition, 'canceled');
});

test('expired present spawn leases require one explicit exact-scope stop claim and preserve off-course', () => {
  const fresh = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: sourcePlan() }, { at: at(0) });
  const attemptId = 'planning-attempt-po-stop-scope1';
  const spawnLease = spawnLeaseBinding(fresh, 'po', attemptId, at(1), {
    bindDeadlineAt: at(3)
  });
  let run = claimDeliveryPlanningRoleSpawnDomain(fresh, {
    role: 'po', attemptId, spawnLease
  }, { at: at(1) });
  assert.throws(() => markDeliveryPlanningRoleSpawnLeaseReconcileRequired(run, {
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    scopeUnit: spawnLease.scopeUnit, scopeDigest: spawnLease.scopeDigest,
    observation: 'present_unattestable', reason: 'The provisional process is not yet attestable.'
  }, { at: at(2) }), /deadline_not_reached/);
  assert.throws(() => markDeliveryPlanningRoleSpawnLeaseReconcileRequired(run, {
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    scopeUnit: spawnLease.scopeUnit, scopeDigest: spawnLease.scopeDigest,
    observation: 'scope_and_pane_absent', reason: 'Wrong transition observation.'
  }, { at: at(3) }), /observation_invalid/);
  assert.throws(() => closeDeliveryPlanningRoleSpawnLeaseAbsent(run, {
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    scopeUnit: spawnLease.scopeUnit, scopeDigest: spawnLease.scopeDigest,
    observation: 'present_unattestable', reason: 'Wrong transition observation.'
  }, { at: at(3) }), /observation_invalid/);
  run = markDeliveryPlanningRunOffCourse(run, {
    reason: 'The source baseline changed while provisional startup was pending.'
  }, { at: at(2) });
  const offCourseBlocker = run.blocker;
  run = markDeliveryPlanningRoleSpawnLeaseReconcileRequired(run, {
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    scopeUnit: spawnLease.scopeUnit, scopeDigest: spawnLease.scopeDigest,
    observation: 'present_unattestable', reason: 'The exact provisional scope remains present after deadline.'
  }, { at: at(3) });
  assert.equal(run.condition, 'off_course');
  assert.equal(run.blocker, offCourseBlocker);
  assert.equal(run.roles.po.attempts[0].spawnLease.state, 'reconcile_required');
  assert.throws(() => claimDeliveryPlanningRoleSpawnLeaseCleanup(run, {
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    claimId: 'planning:spawn:stop:0001', action: 'stop_exact_scope', operatorConfirmed: false
  }, { at: at(4) }), /confirmation_required/);
  assert.throws(() => claimDeliveryPlanningRoleSpawnLeaseCleanup(run, {
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    claimId: 'planning:spawn:stop:wrong1', action: 'terminate_exact_scope', operatorConfirmed: true
  }, { at: at(4) }), /cleanup_action_invalid/);
  run = claimDeliveryPlanningRoleSpawnLeaseCleanup(run, {
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    claimId: 'planning:spawn:stop:0001', action: 'stop_exact_scope', operatorConfirmed: true
  }, { at: at(4) });
  assert.equal(run.roles.po.attempts[0].spawnLease.cleanup.state, 'claimed');
  assert.throws(() => cancelDeliveryPlanningRun(run, {
    operatorConfirmed: true, reason: 'Stop is only claimed, not observed complete.'
  }, { at: at(5) }), /cleanup_required/);
  run = markDeliveryPlanningRoleSpawnLeaseCleanupSent(run, {
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    claimId: 'planning:spawn:stop:0001'
  }, { at: at(5) });
  assert.throws(() => markDeliveryPlanningRoleSpawnLeaseCleanupSent(run, {
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    claimId: 'planning:spawn:stop:0001'
  }, { at: at(5) }), /cleanup_state_conflict/);
  assert.throws(() => markDeliveryPlanningRoleSpawnLeaseCleanupComplete(run, {
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    claimId: 'planning:spawn:stop:0001',
    scopeUnit: spawnLease.scopeUnit, scopeDigest: spawnLease.scopeDigest,
    observation: 'present_unattestable', reason: 'Wrong completion observation.'
  }, { at: at(6) }), /observation_invalid/);
  run = markDeliveryPlanningRoleSpawnLeaseCleanupComplete(run, {
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    claimId: 'planning:spawn:stop:0001',
    scopeUnit: spawnLease.scopeUnit, scopeDigest: spawnLease.scopeDigest,
    observation: 'scope_and_pane_absent',
    reason: 'The exact scope and pane are absent after the one claimed stop.'
  }, { at: at(6) });
  assert.equal(run.condition, 'off_course');
  assert.equal(run.blocker, offCourseBlocker);
  assert.equal(run.roles.po.attempts[0].spawnLease.state, 'closed');
  assert.equal(run.roles.po.attempts[0].spawnLease.cleanup.state, 'complete');
  run = cancelDeliveryPlanningRun(run, {
    operatorConfirmed: true, reason: 'The exact provisional scope is absent.'
  }, { at: at(7) });
  assert.equal(run.condition, 'canceled');
});

test('strict provisional spawn lease schema rejects malformed observations, cleanup, and chronology', () => {
  const fresh = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: sourcePlan() }, { at: at(0) });
  const attemptId = 'planning-attempt-po-lease-schema1';
  const spawnLease = spawnLeaseBinding(fresh, 'po', attemptId, at(1), {
    bindDeadlineAt: at(3)
  });
  const claimed = claimDeliveryPlanningRoleSpawnDomain(fresh, {
    role: 'po', attemptId, spawnLease
  }, { at: at(1) });
  const leaseOf = (run) => run.roles.po.attempts[0].spawnLease;

  assertTamper(claimed, (run) => { leaseOf(run).scopeUnit = 'not-a-planning-scope.service'; }, /scope_unit_invalid/);
  assertTamper(claimed, (run) => { leaseOf(run).contextDigest = 'bad'; }, /context_digest_invalid/);
  assertTamper(claimed, (run) => { leaseOf(run).scopeDigest = 'bad'; }, /scope_digest_invalid/);
  assertTamper(claimed, (run) => { leaseOf(run).launchDigest = 'bad'; }, /launch_digest_invalid/);
  assertTamper(claimed, (run) => { leaseOf(run).bindDeadlineAt = 'not-a-time'; }, /timestamp_invalid/);
  assertTamper(claimed, (run) => { leaseOf(run).bindDeadlineAt = at(1); }, /deadline_invalid/);
  assertTamper(claimed, (run) => {
    leaseOf(run).bindDeadlineAt = new Date(Date.parse(at(1)) + DELIVERY_PLANNING_SPAWN_LEASE_MAX_BIND_MS + 1).toISOString();
  }, /deadline_invalid/);
  assertTamper(claimed, (run) => { leaseOf(run).state = 'unknown'; }, /spawn_lease_state_invalid/);
  assertTamper(claimed, (run) => { leaseOf(run).observed.status = 'unknown'; }, /observation_invalid/);
  assertTamper(claimed, (run) => { leaseOf(run).observed.tmuxPaneId = 'pane-1'; }, /tmux_pane_id_invalid/);
  assertTamper(claimed, (run) => { leaseOf(run).observed.panePid = 0; }, /pane_pid_invalid/);
  assertTamper(claimed, (run) => { leaseOf(run).observed.paneId = 'partial-pane'; }, /pane_binding_incomplete/);
  assertTamper(claimed, (run) => { leaseOf(run).observed.observedAt = at(2); }, /observation_lifecycle_invalid/);
  assertTamper(claimed, (run) => { leaseOf(run).observed.status = 'exact_pane'; }, /observation_lifecycle_invalid/);
  assertTamper(claimed, (run) => { leaseOf(run).observed.status = 'present_unattestable'; }, /observation_lifecycle_invalid/);
  assertTamper(claimed, (run) => {
    leaseOf(run).observed.status = 'present_unattestable';
    leaseOf(run).observed.observedAt = at(0);
  }, /spawn_lease_chronology_invalid/);
  assertTamper(claimed, (run) => { leaseOf(run).error = 'Unexpected claimed-state error.'; }, /spawn_lease_lifecycle_invalid/);

  const bound = bindSpawnLease(claimed, 'po', attemptId, 2);
  assertTamper(bound, (run) => { leaseOf(run).observed.paneTty = ''; }, /pane_binding_incomplete/);
  assertTamper(bound, (run) => { leaseOf(run).observed.status = 'none'; }, /observation_lifecycle_invalid/);
  assertTamper(bound, (run) => { leaseOf(run).observed.observedAt = null; }, /observation_lifecycle_invalid/);
  assertTamper(bound, (run) => {
    leaseOf(run).observed.boundAt = at(0);
  }, /spawn_lease_chronology_invalid/);
  assertTamper(bound, (run) => {
    leaseOf(run).observed.boundAt = at(4);
    leaseOf(run).observed.observedAt = at(4);
  }, /bound_after_deadline/);

  const reconciled = markDeliveryPlanningRoleSpawnLeaseReconcileRequired(claimed, {
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    scopeUnit: spawnLease.scopeUnit, scopeDigest: spawnLease.scopeDigest,
    observation: 'present_unattestable', reason: 'The exact provisional scope remains present.'
  }, { at: at(3) });
  assertTamper(reconciled, (run) => { leaseOf(run).observed.observedAt = null; }, /observation_lifecycle_invalid/);

  const cleanupClaimed = claimDeliveryPlanningRoleSpawnLeaseCleanup(reconciled, {
    role: 'po', attemptId, leaseId: spawnLease.leaseId,
    claimId: 'planning:spawn:schema:0001', action: 'stop_exact_scope', operatorConfirmed: true
  }, { at: at(4) });
  assertTamper(cleanupClaimed, (run) => { leaseOf(run).cleanup.action = 'terminate'; }, /cleanup_action_invalid/);
  assertTamper(cleanupClaimed, (run) => { leaseOf(run).cleanup.state = 'unknown'; }, /cleanup_state_invalid/);
  assertTamper(cleanupClaimed, (run) => { leaseOf(run).cleanup.operatorConfirmed = false; }, /cleanup_confirmation_invalid/);
  assertTamper(cleanupClaimed, (run) => { leaseOf(run).cleanup.claimedAt = null; }, /cleanup_claimed_at_invalid/);
  assertTamper(cleanupClaimed, (run) => { leaseOf(run).cleanup.observation = 'present'; }, /cleanup_observation_invalid/);
  assertTamper(cleanupClaimed, (run) => { leaseOf(run).cleanup.sentAt = at(5); }, /cleanup_lifecycle_invalid/);
  assertTamper(cleanupClaimed, (run) => { leaseOf(run).cleanup.state = 'sent'; }, /cleanup_lifecycle_invalid/);
  assertTamper(cleanupClaimed, (run) => {
    leaseOf(run).cleanup.state = 'sent';
    leaseOf(run).cleanup.sentAt = at(2);
  }, /cleanup_chronology_invalid/);
  assertTamper(cleanupClaimed, (run) => { leaseOf(run).cleanup.claimedAt = at(0); }, /cleanup_chronology_invalid/);

  const cleanupSent = markDeliveryPlanningRoleSpawnLeaseCleanupSent(cleanupClaimed, {
    role: 'po', attemptId, leaseId: spawnLease.leaseId, claimId: 'planning:spawn:schema:0001'
  }, { at: at(5) });
  assertTamper(cleanupSent, (run) => {
    leaseOf(run).cleanup.state = 'complete';
    leaseOf(run).cleanup.completedAt = at(4);
    leaseOf(run).cleanup.observation = 'scope_and_pane_absent';
  }, /cleanup_chronology_invalid/);
  assertTamper(cleanupSent, (run) => {
    leaseOf(run).cleanup.state = 'complete';
    leaseOf(run).cleanup.observation = 'scope_and_pane_absent';
  }, /cleanup_lifecycle_invalid/);
});

test('QA and DEV remain independent, synthesize an exact patch, and apply only by exact outbox binding', () => {
  let run = throughBa();
  const devBeforeQa = compileDeliveryPlanningRoleEnvelope(run, { role: 'dev' });
  run = finishRole(run, 'qa', 30);
  const devAfterQa = compileDeliveryPlanningRoleEnvelope(run, { role: 'dev' });
  assert.equal(devBeforeQa.commonInputDigest, devAfterQa.commonInputDigest);
  assert.equal(devBeforeQa.inputDigest, devAfterQa.inputDigest);
  assert.doesNotMatch(devAfterQa.text, /Exercise each durable transition/);
  run = finishRole(run, 'dev', 40);
  assert.equal(run.phase, 'synthesis');
  run = compileDeliveryPlanningCandidate(run, {}, { at: at(50) });
  assert.equal(run.phase, 'review');
  assert.equal(run.candidate.readiness.ready, true);
  assert.deepEqual(Object.keys(run.candidate.definitionPatch).sort(), ['roles', 'unresolvedQuestions']);
  assert.deepEqual(run.candidate.definitionPatch.roles.qa, ARTIFACTS.qa);
  assert.deepEqual(run.candidate.definitionPatch.roles.dev, ARTIFACTS.dev);
  assert.throws(
    () => claimDeliveryPlanningApply(run, {
      claimId: 'apply:claim:00000001', candidateDigest: '0'.repeat(64)
    }, { at: at(51) }),
    /delivery_planning_run_candidate_not_applyable/
  );
  run = claimDeliveryPlanningApply(run, {
    claimId: 'apply:claim:00000001', candidateDigest: run.candidate.digest
  }, { at: at(51) });
  run = markDeliveryPlanningApplied(run, {
    claimId: 'apply:claim:00000001',
    candidateDigest: run.candidate.digest,
    appliedPlanRevision: run.planRevision + 1,
    appliedPlanDigest: run.candidate.previewPlanDigest
  }, { at: at(52) });
  assert.equal(run.phase, 'applied');
  assert.equal(run.applyOutbox.state, 'applied');
  assert.equal(run.condition, 'active');
});

test('a discovery-only project can complete and apply its role workshop before Git approval setup', () => {
  const plan = sourcePlan({
    baseline: deliveryPlanDiscoveryBaseline('/srv/panefleet', { at: at(0) })
  });
  assert.equal(lintDeliveryPlanReadiness(plan).ready, false);
  let run = synthesizedRun(plan);
  assert.equal(run.candidate.readiness.ready, true);
  assert.equal(run.candidate.readiness.errors.length, 0);
  assert.equal(run.candidate.readiness.warnings.some((finding) => finding.code === 'baseline_discovery_only'), true);
  run = claimDeliveryPlanningApply(run, {
    claimId: 'apply:discovery:00001', candidateDigest: run.candidate.digest
  }, { at: at(51) });
  assert.equal(run.applyOutbox.state, 'claimed');
});

test('resource, needs-input, crash, reconciliation, cleanup uncertainty, and apply uncertainty fail closed', () => {
  const fresh = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: sourcePlan() }, { at: at(0) });
  const waiting = markDeliveryPlanningResourceWait(fresh, { role: 'po', reason: 'Available memory is below the gate.' }, { at: at(1) });
  assert.equal(waiting.condition, 'resource_wait');
  assert.equal(waiting.blocker, 'Available memory is below the gate.');
  assert.equal(deliveryPlanningRoleEligibility(waiting).eligible, true);
  const resumed = dispatchRole(waiting, 'po', 10).run;
  assert.equal(resumed.condition, 'active');
  assert.equal(resumed.blocker, '');

  const needs = markDeliveryPlanningRoleNeedsInput(resumed, {
    role: 'po', attemptId: 'planning-attempt-po-00000010', reason: 'The desired user outcome is ambiguous.'
  }, { at: at(13) });
  assert.equal(needs.condition, 'needs_input');
  assert.equal(needs.roles.po.state, 'needs_input');
  assert.equal(deliveryPlanningRoleEligibility(needs).eligible, false);

  let crashBase = dispatchRole(fresh, 'po', 20).run;
  const crashed = markDeliveryPlanningRoleCrash(crashBase, {
    role: 'po', attemptId: 'planning-attempt-po-00000020', reason: 'The exact worker exited after dispatch.'
  }, { at: at(23) });
  assert.equal(crashed.condition, 'failed');
  assert.equal(crashed.roles.po.attempts[0].state, 'crashed');

  crashBase = dispatchRole(fresh, 'po', 30).run;
  const reconciled = markDeliveryPlanningRoleReconcileRequired(crashBase, {
    role: 'po', attemptId: 'planning-attempt-po-00000030', reason: 'Pane identity changed during observation.'
  }, { at: at(33) });
  assert.equal(reconciled.condition, 'reconcile_required');
  assert.equal(reconciled.roles.po.state, 'reconcile_required');

  let cleanup = dispatchRole(fresh, 'po', 10).run;
  const cleanupReport = report(cleanup, 'po', cleanup.roles.po.attempts[0].id);
  cleanup = recordDeliveryPlanningRoleReport(cleanup, {
    role: 'po', attemptId: cleanupReport.attemptId, report: cleanupReport,
    outputDigest: planningRoleReportOutputDigest(cleanupReport)
  }, { at: at(13) });
  cleanup = markDeliveryPlanningRoleCleanupRequired(cleanup, {
    role: 'po', attemptId: cleanupReport.attemptId, error: 'Cleanup submit outcome is uncertain.'
  }, { at: at(14) });
  assert.equal(cleanup.condition, 'reconcile_required');
  assert.equal(cleanup.roles.po.attempts[0].cleanup.state, 'reconcile_required');

  let apply = synthesizedRun();
  apply = claimDeliveryPlanningApply(apply, {
    claimId: 'apply:claim:uncertain1', candidateDigest: apply.candidate.digest
  }, { at: at(51) });
  apply = markDeliveryPlanningApplyReconcileRequired(apply, {
    claimId: 'apply:claim:uncertain1', error: 'Plan-store result is unknown.'
  }, { at: at(52) });
  assert.equal(apply.condition, 'reconcile_required');
  assert.equal(apply.applyOutbox.state, 'reconcile_required');
});

test('off-course pauses in place and confirmed cancellation closes without authorizing execution', () => {
  const fresh = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: sourcePlan() }, { at: at(0) });
  const offCourse = markDeliveryPlanningRunOffCourse(fresh, {
    reason: 'The worker attempted to expand beyond the frozen planning scope.'
  }, { at: at(1) });
  assert.equal(offCourse.phase, 'po');
  assert.equal(offCourse.condition, 'off_course');
  assert.equal(deliveryPlanningRoleEligibility(offCourse).eligible, false);
  assert.throws(() => claimDeliveryPlanningRoleSpawn(offCourse, {
    role: 'po', attemptId: 'planning-attempt-po-offcourse1'
  }), /delivery_planning_run_off_course/);
  assert.throws(() => markDeliveryPlanningRunOffCourse(offCourse, { reason: 'Again.' }), /delivery_planning_run_terminal/);

  const closedOffCourse = cancelDeliveryPlanningRun(offCourse, {
    operatorConfirmed: true, reason: 'Operator reviewed the pause and closed it.'
  }, { at: at(2) });
  assert.equal(closedOffCourse.phase, 'closed');
  assert.equal(closedOffCourse.condition, 'canceled');

  assert.throws(
    () => cancelDeliveryPlanningRun(fresh, { operatorConfirmed: false, reason: 'Stop.' }),
    /delivery_planning_run_cancel_confirmation_required/
  );
  const canceled = cancelDeliveryPlanningRun(fresh, {
    operatorConfirmed: true, reason: 'The operator withdrew the request.'
  }, { at: at(1) });
  assert.equal(canceled.phase, 'closed');
  assert.equal(canceled.condition, 'canceled');
  const live = claimDeliveryPlanningRoleSpawn(fresh, {
    role: 'po', attemptId: 'planning-attempt-po-live0001'
  }, { at: at(1) });
  assert.throws(
    () => cancelDeliveryPlanningRun(live, { operatorConfirmed: true, reason: 'Stop.' }),
    /delivery_planning_run_cleanup_required/
  );
});

test('strict schema and exact report bindings reject malformed or stale persisted state', () => {
  const run = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: sourcePlan() }, { at: at(0) });
  assert.throws(() => createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: sourcePlan(), extra: true }), /create_input_invalid/);
  assert.throws(() => validateDeliveryPlanningRun({ ...run, extra: true }), /shape_invalid/);
  assert.throws(() => createDeliveryPlanningRun({
    id: RUN_ID,
    sourcePlan: sourcePlan({ classification: { ...sourcePlan().classification, depth: 'quick' } })
  }), /source_plan_depth_invalid/);
  const dispatched = dispatchRole(run, 'po', 10).run;
  const stale = report(dispatched, 'po', dispatched.roles.po.attempts[0].id, 'complete', {
    planRevision: dispatched.planRevision + 1
  });
  assert.throws(() => recordDeliveryPlanningRoleReport(dispatched, {
    role: 'po', attemptId: stale.attemptId, report: stale, outputDigest: planningRoleReportOutputDigest(stale)
  }), /plan_revision_mismatch/);
  let badMarker = claimDeliveryPlanningRoleSpawn(
    run,
    { role: 'po', attemptId: 'planning-attempt-po-badmark1' },
    { at: at(1) }
  );
  badMarker = bindSpawnLease(badMarker, 'po', 'planning-attempt-po-badmark1', 1);
  const badMarkerLease = badMarker.roles.po.attempts[0].spawnLease;
  assert.throws(() => claimDeliveryPlanningRoleDispatch(
    badMarker,
    {
      role: 'po', attemptId: 'planning-attempt-po-badmark1', leaseId: badMarkerLease.leaseId,
      worker: worker(1, badMarkerLease),
      rolloutPath: '/srv/codex/po.jsonl', rolloutStartOffset: 0,
      confirmationMarker: '[PaneFleet Planning Dispatch wrong]', promptDigest: 'a'.repeat(64)
    }
  ), /confirmation_marker_invalid/);
});

test('exact Run and worker-private values cannot persist in a report or synthesized candidate', () => {
  let run = throughBa();
  run = finishRole(run, 'qa', 30);
  const dispatched = dispatchRole(run, 'dev', 40).run;
  const attempt = dispatched.roles.dev.attempts.at(-1);

  for (const privateValue of [
    dispatched.workspace,
    attempt.rolloutId,
    attempt.sourceId,
    attempt.commandDigest,
    attempt.paneTty
  ]) {
    const privateReport = report(dispatched, 'dev', attempt.id, 'complete', {
      artifact: {
        ...ARTIFACTS.dev,
        architecture: `The implementation inspected ${privateValue} while planning.`
      }
    });
    assert.throws(() => recordDeliveryPlanningRoleReport(dispatched, {
      role: 'dev',
      attemptId: attempt.id,
      report: privateReport,
      outputDigest: planningRoleReportOutputDigest(privateReport)
    }), { code: 'delivery_planning_run_report_private_value_not_allowed' });
  }
  assert.equal(dispatched.roles.dev.report, null);
  assert.equal(dispatched.candidate, null);

  const acceptedReport = report(dispatched, 'dev', attempt.id);
  const accepted = recordDeliveryPlanningRoleReport(dispatched, {
    role: 'dev',
    attemptId: attempt.id,
    report: acceptedReport,
    outputDigest: planningRoleReportOutputDigest(acceptedReport)
  }, { at: at(43) });
  const tampered = structuredClone(accepted);
  tampered.roles.dev.report.artifact.architecture = `Leaked workspace: ${tampered.workspace}`;
  tampered.roles.dev.outputDigest = planningRoleReportOutputDigest(tampered.roles.dev.report);
  assert.throws(
    () => validateDeliveryPlanningRun(tampered),
    { code: 'delivery_planning_run_report_private_value_not_allowed' }
  );
});

test('source binding and top-level schema reject every authority, classification, and identity drift', () => {
  const invalidPlan = (plan, expected) => assert.throws(
    () => createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: plan }),
    expected
  );
  invalidPlan(null, /source_plan_invalid/);
  invalidPlan({ ...sourcePlan(), ignored: true }, /source_plan_not_canonical/);
  invalidPlan(sourcePlan({ phase: 'draft' }), /source_plan_phase_invalid/);
  invalidPlan(sourcePlan({
    classification: { ...sourcePlan().classification, intent: 'answer' }
  }), /source_plan_intent_invalid/);
  invalidPlan(sourcePlan({
    classification: { ...sourcePlan().classification, risk: 'read_only' }
  }), /source_plan_risk_invalid/);
  invalidPlan(sourcePlan({
    classification: { ...sourcePlan().classification, mutationSurfaces: [] }
  }), /source_plan_surface_invalid/);
  invalidPlan(sourcePlan({
    authority: { ...sourcePlan().authority, push: true }
  }), /source_plan_authority_invalid/);

  const fresh = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: sourcePlan() }, { at: at(0) });
  for (const [mutate, expected] of [
    [(run) => { run.version = 2; }, /version_unsupported/],
    [(run) => { run.id = 'bad'; }, /id_invalid/],
    [(run) => { run.revision = 0; }, /revision_invalid/],
    [(run) => { run.phase = 'guess'; }, /phase_invalid/],
    [(run) => { run.condition = 'guess'; }, /condition_invalid/],
    [(run) => { run.planId = 'bad'; }, /plan_id_invalid/],
    [(run) => { run.planRevision = 0; }, /plan_revision_invalid/],
    [(run) => { run.planDigest = 'short'; }, /plan_digest_invalid/],
    [(run) => { run.workspace = 'relative'; }, /workspace_invalid/],
    [(run) => { run.inputDigest = '0'.repeat(64); }, /input_digest_mismatch/],
    [(run) => { run.createdAt = 'yesterday'; }, /timestamp_invalid/],
    [(run) => { run.updatedAt = at(-1); }, /timestamp_invalid/],
    [(run) => { run.baseline.head = 'invalid'; }, /baseline_head_invalid/],
    [(run) => { run.baseline.capturedAt = 'yesterday'; }, /baseline_timestamp_invalid/]
  ]) assertTamper(fresh, mutate, expected);
  assert.throws(
    () => createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: sourcePlan() }, { at: 'not-a-time' }),
    /timestamp_invalid/
  );
  assert.throws(
    () => deliveryPlanningRoleInputDigest(fresh, 'ba'),
    /po_report_required/
  );
  const afterPo = finishRole(fresh, 'po', 10);
  assert.throws(
    () => deliveryPlanningRoleInputDigest(afterPo, 'qa'),
    /ba_report_required/
  );
});

test('persisted role, worker, attempt, cleanup, phase, and condition combinations are cross-validated', () => {
  const fresh = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: sourcePlan() }, { at: at(0) });
  const attemptId = 'planning-attempt-po-tamper001';
  assert.throws(
    () => claimDeliveryPlanningRoleSpawn(fresh, { role: 'po', attemptId: 'bad' }),
    /attempt_id_invalid/
  );
  const spawn = claimDeliveryPlanningRoleSpawn(fresh, { role: 'po', attemptId }, { at: at(1) });
  assertTamper(spawn, (run) => { run.roles.po.attempts[0].kind = 'ba'; }, /attempt_role_mismatch/);
  assertTamper(spawn, (run) => { run.roles.po.attempts[0].state = 'guess'; }, /attempt_state_invalid/);
  assertTamper(spawn, (run) => { run.roles.po.attempts[0].tmuxPaneId = 'bad'; }, /tmux_pane_id_invalid/);
  assertTamper(spawn, (run) => { run.roles.po.attempts[0].panePid = 0; }, /panePid_invalid/);
  assertTamper(spawn, (run) => { run.roles.po.attempts[0].rolloutId = 'bad'; }, /rollout_id_invalid/);
  assertTamper(spawn, (run) => { run.roles.po.attempts[0].sourceId = 'bad'; }, /source_id_invalid/);
  assertTamper(spawn, (run) => { run.roles.po.attempts[0].rolloutPath = 'relative'; }, /rollout_path_invalid/);
  assertTamper(spawn, (run) => { run.roles.po.attempts[0].rolloutStartOffset = -1; }, /rollout_offset_invalid/);
  assertTamper(spawn, (run) => { run.roles.po.attempts[0].claimedAt = 'bad'; }, /claimedAt_invalid/);
  assertTamper(spawn, (run) => { run.roles.po.attempts[0].outcome = 'unknown'; }, /outcome_invalid/);
  assertTamper(spawn, (run) => { run.roles.po.attempts[0].inputDigest = '0'.repeat(64); }, /spawn_lease_binding_mismatch/);
  assertTamper(spawn, (run) => { run.roles.po.attempts.push(structuredClone(run.roles.po.attempts[0])); }, /attempts_invalid/);
  assertTamper(spawn, (run) => { run.roles.po.state = 'pending'; }, /role_lifecycle_invalid/);
  assertTamper(spawn, (run) => { run.roles.po.state = 'dispatch_claimed'; }, /role_lifecycle_invalid/);
  assertTamper(spawn, (run) => { run.roles.po.attempts[0].session = 'partial'; }, /worker_binding_incomplete/);
  assertTamper(spawn, (run) => { run.roles.po.attempts[0].error = 'unexpected'; }, /attempt_lifecycle_invalid/);

  const boundSpawn = bindSpawnLease(spawn, 'po', attemptId, 1);
  const lease = boundSpawn.roles.po.attempts[0].spawnLease;
  const baseEnvelope = compileDeliveryPlanningRoleEnvelope(fresh, { role: 'po' });
  const marker = `[PaneFleet Planning Dispatch ${attemptId}]`;
  const dispatchInput = {
    role: 'po', attemptId, leaseId: lease.leaseId, worker: worker(1, lease),
    rolloutPath: '/srv/codex/tamper.jsonl',
    rolloutStartOffset: 0, confirmationMarker: marker, promptDigest: canonicalSha256(baseEnvelope.text)
  };
  assert.throws(() => claimDeliveryPlanningRoleDispatch(boundSpawn, {
    ...dispatchInput, worker: { ...dispatchInput.worker, panePid: 0 }
  }), /panePid_invalid/);
  assert.throws(() => claimDeliveryPlanningRoleDispatch(boundSpawn, {
    ...dispatchInput, worker: { ...dispatchInput.worker, scopeUnit: 'not-a-scope.service' }
  }), /scope_unit_invalid/);
  assert.throws(() => claimDeliveryPlanningRoleDispatch(boundSpawn, {
    ...dispatchInput, rolloutPath: 'relative.jsonl'
  }), /rollout_path_invalid/);
  assert.throws(() => claimDeliveryPlanningRoleDispatch(boundSpawn, {
    ...dispatchInput, rolloutStartOffset: -1
  }), /rollout_offset_invalid/);
  const dispatchClaimed = claimDeliveryPlanningRoleDispatch(boundSpawn, {
    ...dispatchInput
  }, { at: at(2) });
  assert.equal(dispatchClaimed.roles.po.attempts[0].scopeUnit, lease.scopeUnit);
  assert.equal(dispatchClaimed.roles.po.attempts[0].scopeDigest, lease.scopeDigest);
  assertTamper(dispatchClaimed, (run) => {
    run.roles.po.attempts[0].scopeUnit = 'not-a-scope.service';
  }, /attempt_scope_unit_invalid/);
  assertTamper(dispatchClaimed, (run) => {
    run.roles.po.attempts[0].scopeDigest = 'not-a-digest';
  }, /attempt_scope_digest_invalid/);
  assertTamper(dispatchClaimed, (run) => { run.roles.po.attempts[0].submittedAt = at(2); }, /attempt_lifecycle_invalid/);
  const dispatched = markDeliveryPlanningRoleDispatched(dispatchClaimed, { role: 'po', attemptId }, { at: at(3) });
  assertTamper(dispatched, (run) => { run.roles.po.attempts[0].finishedAt = at(3); }, /attempt_lifecycle_invalid/);
  assert.throws(() => markDeliveryPlanningRoleDispatched(dispatched, { role: 'po', attemptId }), /attempt_state_conflict/);
  assert.throws(() => recordDeliveryPlanningRoleReport(spawn, {
    role: 'po', attemptId, report: {}, outputDigest: 'a'.repeat(64)
  }), /report_not_expected/);

  const poReport = report(dispatched, 'po', attemptId);
  assert.throws(() => recordDeliveryPlanningRoleReport(dispatched, {
    role: 'po', attemptId, report: poReport, outputDigest: '0'.repeat(64)
  }), /report_output_digest_mismatch/);
  const completed = recordDeliveryPlanningRoleReport(dispatched, {
    role: 'po', attemptId, report: poReport, outputDigest: planningRoleReportOutputDigest(poReport)
  }, { at: at(4) });
  assertTamper(completed, (run) => { run.roles.po.attempts[0].summary = ''; }, /attempt_lifecycle_invalid/);
  assertTamper(completed, (run) => { run.roles.po.report = null; }, /role_output_without_report/);
  assertTamper(completed, (run) => { run.roles.po.state = 'needs_input'; }, /role_lifecycle_invalid/);
  assertTamper(completed, (run) => { run.roles.po.outputDigest = '0'.repeat(64); }, /output_digest_mismatch/);
  assertTamper(completed, (run) => {
    run.roles.po.attempts[0].cleanup.claimId = 'cleanup:tamper:0001';
  }, /cleanup_lifecycle_invalid/);
  assertTamper(completed, (run) => {
    run.roles.po.attempts[0].cleanup.recoveryCount = 1;
  }, /cleanup_recovery_history_invalid/);

  const claimed = claimDeliveryPlanningRoleCleanup(completed, {
    role: 'po', attemptId, claimId: 'cleanup:tamper:0001'
  }, { at: at(5) });
  assertTamper(claimed, (run) => { run.roles.po.attempts[0].cleanup.claimId = ''; }, /cleanup_lifecycle_invalid/);
  const sent = markDeliveryPlanningRoleCleanupSent(claimed, { role: 'po', attemptId }, { at: at(6) });
  assertTamper(sent, (run) => { run.roles.po.attempts[0].cleanup.sentAt = null; }, /cleanup_lifecycle_invalid/);
  const cleaned = markDeliveryPlanningRoleCleanupComplete(sent, { role: 'po', attemptId }, { at: at(7) });
  assertTamper(cleaned, (run) => { run.roles.po.attempts[0].cleanup.error = 'unexpected'; }, /cleanup_lifecycle_invalid/);
  assert.throws(() => claimDeliveryPlanningRoleCleanup(cleaned, {
    role: 'po', attemptId, claimId: 'cleanup:again:0001'
  }), /cleanup_state_conflict/);

  assertTamper(fresh, (run) => { run.phase = 'ba'; }, /phase_lifecycle_invalid/);
  assertTamper(fresh, (run) => { run.phase = 'challenge'; }, /phase_lifecycle_invalid/);
  assertTamper(fresh, (run) => { run.phase = 'synthesis'; }, /phase_lifecycle_invalid/);
  assertTamper(fresh, (run) => { run.blocker = 'Unexpected.'; }, /active_blocker_invalid/);
  assertTamper(fresh, (run) => { run.condition = 'resource_wait'; }, /blocker_required/);
  assertTamper(fresh, (run) => { run.condition = 'needs_input'; run.blocker = 'Missing.'; }, /needs_input_role_required/);
  assertTamper(fresh, (run) => { run.condition = 'failed'; run.blocker = 'Missing.'; }, /failed_role_required/);
  assertTamper(fresh, (run) => { run.condition = 'reconcile_required'; run.blocker = 'Missing.'; }, /reconcile_evidence_required/);
  assertTamper(fresh, (run) => { run.phase = 'closed'; }, /closed_condition_invalid/);
  assertTamper(fresh, (run) => { run.condition = 'canceled'; run.blocker = 'Canceled.'; }, /canceled_phase_invalid/);
});

test('candidate and apply metadata are bound to exact reports, questions, preview, phase, and claim', () => {
  const review = synthesizedRun();
  assertTamper(review, (run) => { run.candidate.definitionPatch.roles.po.problem = 'Tampered.'; }, /candidate_role_binding_mismatch/);
  assertTamper(review, (run) => { run.candidate.roleOutputDigests.po = '0'.repeat(64); }, /candidate_output_binding_mismatch/);
  assertTamper(review, (run) => { run.candidate.definitionPatch.unresolvedQuestions = 'bad'; }, /candidate_questions_invalid/);
  assertTamper(review, (run) => { run.candidate.definitionPatch.unresolvedQuestions = ['Injected question']; }, /questions_binding_mismatch/);
  assertTamper(review, (run) => { run.candidate.challenges = 'bad'; }, /candidate_challenges_invalid/);
  assertTamper(review, (run) => { run.candidate.challenges = ['Injected challenge']; }, /challenges_binding_mismatch/);
  assertTamper(review, (run) => { run.candidate.compiledAt = 'bad'; }, /candidate_timestamp_invalid/);
  assertTamper(review, (run) => { run.candidate.digest = '0'.repeat(64); }, /candidate_digest_mismatch/);
  assertTamper(review, (run) => {
    run.candidate.readiness.errors = [{ code: 'injected', path: 'roles.po', message: 'Injected.' }];
  }, /preview_binding_mismatch/);
  assertTamper(review, (run) => { run.candidate.readiness.traceability[0].complete = 'yes'; }, /candidate_traceability_invalid/);
  assertTamper(review, (run) => { run.phase = 'synthesis'; }, /candidate_phase_invalid/);
  assertTamper(review, (run) => { run.candidate = null; }, /review_candidate_required/);

  const claimed = claimDeliveryPlanningApply(review, {
    claimId: 'apply:tamper:00000001', candidateDigest: review.candidate.digest
  }, { at: at(51) });
  assertTamper(claimed, (run) => { run.applyOutbox.candidateDigest = '0'.repeat(64); }, /apply_candidate_binding_mismatch/);
  assertTamper(claimed, (run) => { run.applyOutbox.claimId = ''; }, /apply_lifecycle_invalid/);
  assertTamper(claimed, (run) => {
    run.phase = 'closed'; run.condition = 'off_course'; run.blocker = 'Paused.';
  }, /apply_phase_invalid/);
  assert.throws(() => markDeliveryPlanningApplied(claimed, {
    claimId: 'apply:tamper:00000001', candidateDigest: claimed.candidate.digest,
    appliedPlanRevision: 0, appliedPlanDigest: claimed.candidate.previewPlanDigest
  }), /applied_plan_revision_invalid/);
  assert.throws(() => markDeliveryPlanningApplied(claimed, {
    claimId: 'apply:wrong:00000001', candidateDigest: claimed.candidate.digest,
    appliedPlanRevision: claimed.planRevision + 1, appliedPlanDigest: claimed.candidate.previewPlanDigest
  }), /apply_binding_conflict/);
  assert.throws(() => markDeliveryPlanningApplyReconcileRequired(claimed, {
    claimId: 'apply:wrong:00000001', error: 'Unknown.'
  }), /apply_binding_conflict/);
  assert.throws(() => cancelDeliveryPlanningRun(claimed, {
    operatorConfirmed: true, reason: 'Do not abandon an uncertain apply.'
  }), /cleanup_required/);
});

test('candidate questions preserve source questions, role questions, and report challenges in stable order', () => {
  const base = sourcePlan();
  const question = 'Which operator owns the final rollout decision?';
  const plan = sourcePlan({
    unresolvedQuestions: [question],
    roles: {
      ...base.roles,
      po: { ...base.roles.po, openQuestions: [question, 'What is the first measurable outcome?'] }
    }
  });
  let run = throughBa(plan);
  run = finishRole(run, 'qa', 30);
  run = finishRole(run, 'dev', 40);
  run.roles.qa.report.challenges = ['Confirm the real-device verification owner.'];
  run.roles.qa.outputDigest = planningRoleReportOutputDigest(run.roles.qa.report);
  run = compileDeliveryPlanningCandidate(run, {}, { at: at(50) });
  assert.deepEqual(run.candidate.definitionPatch.unresolvedQuestions, [
    question,
    'What is the first measurable outcome?',
    'QA challenge: Confirm the real-device verification owner.'
  ]);
  assert.deepEqual(run.candidate.challenges, ['QA: Confirm the real-device verification owner.']);
  assert.equal(run.candidate.readiness.ready, false);
});

test('an exact authoritative Plan receipt can complete an apply marked for reconciliation', () => {
  let run = synthesizedRun();
  run = claimDeliveryPlanningApply(run, {
    claimId: 'apply:receipt:00000001', candidateDigest: run.candidate.digest
  }, { at: at(51) });
  run = markDeliveryPlanningApplyReconcileRequired(run, {
    claimId: 'apply:receipt:00000001', error: 'The initial cross-store response was lost.'
  }, { at: at(52) });
  assert.throws(() => markDeliveryPlanningApplied(run, {
    claimId: 'apply:receipt:wrong001',
    candidateDigest: run.candidate.digest,
    appliedPlanRevision: run.planRevision + 1,
    appliedPlanDigest: run.candidate.previewPlanDigest
  }, { at: at(53) }), /apply_binding_conflict/);
  assert.throws(() => markDeliveryPlanningApplied(run, {
    claimId: 'apply:receipt:00000001',
    candidateDigest: '0'.repeat(64),
    appliedPlanRevision: run.planRevision + 1,
    appliedPlanDigest: run.candidate.previewPlanDigest
  }, { at: at(53) }), /apply_binding_conflict/);
  run = markDeliveryPlanningApplied(run, {
    claimId: 'apply:receipt:00000001',
    candidateDigest: run.candidate.digest,
    appliedPlanRevision: run.planRevision + 1,
    appliedPlanDigest: run.candidate.previewPlanDigest
  }, { at: at(53) });
  assert.equal(run.phase, 'applied');
  assert.equal(run.condition, 'active');
  assert.equal(run.applyOutbox.state, 'applied');
  assert.equal(run.blocker, '');
});

test('Continue authorization is durable before resource retry or cleanup input', () => {
  const fresh = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: sourcePlan() }, { at: at(0) });
  let waiting = markDeliveryPlanningResourceWait(fresh, {
    role: 'po', reason: 'The bounded worker slot is temporarily unavailable.'
  }, { at: at(1) });
  const resourceAuthorization = {
    operationId: 'planning:continue:resource:0001',
    kind: 'resource_retry',
    role: 'po',
    attemptId: '',
    claimId: '',
    cleanupRecoveryOutcome: '',
    requestedStoreRevision: 11,
    requestedRunRevision: waiting.revision
  };
  assert.throws(() => authorizeDeliveryPlanningContinue(waiting, {
    ...resourceAuthorization, requestedStoreRevision: -1
  }, { at: at(2) }), /continue_store_revision_invalid/);
  assert.throws(() => authorizeDeliveryPlanningContinue(waiting, {
    ...resourceAuthorization, requestedRunRevision: 999
  }, { at: at(2) }), /continue_run_revision_conflict/);
  assert.throws(() => authorizeDeliveryPlanningContinue(waiting, {
    ...resourceAuthorization, attemptId: 'planning-attempt-invalid-binding'
  }, { at: at(2) }), /continue_binding_invalid/);
  waiting = authorizeDeliveryPlanningContinue(waiting, {
    ...resourceAuthorization
  }, { at: at(2) });
  assert.equal(waiting.condition, 'active');
  assert.equal(waiting.blocker, '');
  assert.deepEqual(waiting.continueReceipts[0], {
    operationId: 'planning:continue:resource:0001',
    kind: 'resource_retry',
    role: 'po',
    attemptId: '',
    claimId: '',
    cleanupRecoveryOutcome: '',
    requestedStoreRevision: 11,
    requestedRunRevision: 2,
    authorizedAt: at(2)
  });
  waiting = markDeliveryPlanningResourceWait(waiting, {
    role: 'po', reason: 'The resource gate is still below its threshold.'
  }, { at: at(3) });
  waiting = authorizeDeliveryPlanningContinue(waiting, {
    operationId: 'planning:continue:resource:0002',
    kind: 'resource_retry', role: 'po', attemptId: '', claimId: '', cleanupRecoveryOutcome: '',
    requestedStoreRevision: 12, requestedRunRevision: waiting.revision
  }, { at: at(4) });
  assert.equal(waiting.condition, 'active');
  assert.equal(waiting.continueReceipts.length, 2);

  let cleanup = dispatchRole(fresh, 'po', 10).run;
  const attemptId = cleanup.roles.po.attempts[0].id;
  const poReport = report(cleanup, 'po', attemptId);
  cleanup = recordDeliveryPlanningRoleReport(cleanup, {
    role: 'po', attemptId, report: poReport, outputDigest: planningRoleReportOutputDigest(poReport)
  }, { at: at(13) });
  assert.throws(() => authorizeDeliveryPlanningContinue(cleanup, {
    operationId: 'planning:continue:cleanup:invalid1',
    kind: 'cleanup_only', role: 'po', attemptId,
    claimId: 'cleanup:continue:invalid:0001', cleanupRecoveryOutcome: 'worker_absent',
    requestedStoreRevision: 20, requestedRunRevision: cleanup.revision
  }, { at: at(14) }), /continue_recovery_outcome_invalid/);
  cleanup = authorizeDeliveryPlanningContinue(cleanup, {
    operationId: 'planning:continue:cleanup:0001',
    kind: 'cleanup_only',
    role: 'po',
    attemptId,
    claimId: 'cleanup:continue:pending:0001',
    cleanupRecoveryOutcome: '',
    requestedStoreRevision: 20,
    requestedRunRevision: cleanup.revision
  }, { at: at(14) });
  assert.equal(cleanup.roles.po.attempts[0].cleanup.state, 'claimed');
  assert.equal(cleanup.roles.po.attempts[0].cleanup.claimId, 'cleanup:continue:pending:0001');
  cleanup = markDeliveryPlanningRoleCleanupSent(cleanup, { role: 'po', attemptId }, { at: at(15) });
  cleanup = markDeliveryPlanningRoleCleanupComplete(cleanup, { role: 'po', attemptId }, { at: at(16) });
  assert.equal(cleanup.phase, 'ba');
});

test('resource retry receipts are repeatable only to the exact durable cap', () => {
  let run = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: sourcePlan() }, { at: at(0) });
  assert.equal(deliveryPlanningResourceRetryEligibility(run).eligible, true);
  run = authorizeDeliveryPlanningContinue(run, {
    operationId: 'planning:resource:initial:0000',
    kind: 'resource_retry', role: 'po', attemptId: '', claimId: '', cleanupRecoveryOutcome: '',
    requestedStoreRevision: 0, requestedRunRevision: run.revision
  }, { at: at(1) });
  assert.equal(deliveryPlanningResourceRetryEligibility(run).eligible, false);
  for (let index = 0; index < DELIVERY_PLANNING_RUN_MAX_RESOURCE_CONTINUE_RECEIPTS; index += 1) {
    if (index === 0) continue;
    run = markDeliveryPlanningResourceWait(run, {
      role: 'po', reason: `Resource gate wait ${index + 1}.`
    }, { at: at((index * 2) + 2) });
    run = authorizeDeliveryPlanningContinue(run, {
      operationId: `planning:resource:retry:${String(index).padStart(4, '0')}`,
      kind: 'resource_retry', role: 'po', attemptId: '', claimId: '', cleanupRecoveryOutcome: '',
      requestedStoreRevision: index + 1,
      requestedRunRevision: run.revision
    }, { at: at((index * 2) + 3) });
    assert.equal(run.condition, 'active');
  }
  assert.equal(run.continueReceipts.length, DELIVERY_PLANNING_RUN_MAX_RESOURCE_CONTINUE_RECEIPTS);
  run = markDeliveryPlanningResourceWait(run, {
    role: 'po', reason: 'A seventh resource wait is observable but cannot consume cleanup reserve.'
  }, { at: at(14) });
  assert.throws(() => authorizeDeliveryPlanningContinue(run, {
    operationId: 'planning:resource:retry:0006',
    kind: 'resource_retry', role: 'po', attemptId: '', claimId: '', cleanupRecoveryOutcome: '',
    requestedStoreRevision: 13,
    requestedRunRevision: run.revision
  }, { at: at(15) }), /continue_receipt_limit_reached/);
  const canceled = cancelDeliveryPlanningRun(run, {
    operatorConfirmed: true,
    reason: 'The resource cap was reached before any worker was created.'
  }, { at: at(16) });
  assert.equal(canceled.condition, 'canceled');
});

test('a restart between roles can durably normalize to resource wait without consuming Continue authority', () => {
  let run = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: sourcePlan() }, { at: at(0) });
  run = authorizeDeliveryPlanningContinue(run, {
    operationId: 'planning:resource:startup:0001',
    kind: 'resource_retry', role: 'po', attemptId: '', claimId: '', cleanupRecoveryOutcome: '',
    requestedStoreRevision: 1, requestedRunRevision: run.revision
  }, { at: at(1) });
  run = finishRole(run, 'po', 10);
  assert.equal(run.phase, 'ba');
  assert.equal(run.condition, 'active');
  assert.equal(run.roles.ba.state, 'pending');
  assert.equal(run.roles.ba.attempts.length, 0);
  assert.equal(run.continueReceipts.length, 1);

  const revisionBeforeWait = run.revision;
  run = markDeliveryPlanningResourceWait(run, {
    role: 'ba',
    reason: 'The server restarted before acquiring authority to spawn the next role.'
  }, { at: at(17) });
  assert.equal(run.revision, revisionBeforeWait + 1);
  assert.equal(run.condition, 'resource_wait');
  assert.equal(run.continueReceipts.length, 1);
  assert.equal(deliveryPlanningResourceRetryEligibility(run, 'ba').eligible, true);

  run = authorizeDeliveryPlanningContinue(run, {
    operationId: 'planning:resource:inter-role:0002',
    kind: 'resource_retry', role: 'ba', attemptId: '', claimId: '', cleanupRecoveryOutcome: '',
    requestedStoreRevision: 9, requestedRunRevision: run.revision
  }, { at: at(18) });
  assert.equal(run.condition, 'active');
  assert.equal(run.continueReceipts.length, 2);
});

test('resource retries cannot consume the six cleanup authorizations reserved for worst-case recovery', () => {
  let run = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: sourcePlan() }, { at: at(0) });
  for (let index = 0; index < DELIVERY_PLANNING_RUN_MAX_RESOURCE_CONTINUE_RECEIPTS; index += 1) {
    run = markDeliveryPlanningResourceWait(run, {
      role: 'po', reason: `Bounded pre-spawn resource wait ${index + 1}.`
    }, { at: at((index * 2) + 1) });
    run = authorizeDeliveryPlanningContinue(run, {
      operationId: `planning:reserved:resource:${String(index).padStart(4, '0')}`,
      kind: 'resource_retry', role: 'po', attemptId: '', claimId: '', cleanupRecoveryOutcome: '',
      requestedStoreRevision: index + 1, requestedRunRevision: run.revision
    }, { at: at((index * 2) + 2) });
  }

  function finishWithReservedCleanup(current, role, index, recoverTwice = false) {
    const dispatched = dispatchRole(current, role, index);
    const roleReport = report(dispatched.run, role, dispatched.attemptId);
    let next = recordDeliveryPlanningRoleReport(dispatched.run, {
      role,
      attemptId: dispatched.attemptId,
      report: roleReport,
      outputDigest: planningRoleReportOutputDigest(roleReport)
    }, { at: at(index + 3) });
    next = authorizeDeliveryPlanningContinue(next, {
      operationId: `planning:reserved:cleanup:${role}:initial`,
      kind: 'cleanup_only', role, attemptId: dispatched.attemptId,
      claimId: `cleanup:reserved:${role}:initial`, cleanupRecoveryOutcome: '',
      requestedStoreRevision: index + 100, requestedRunRevision: next.revision
    }, { at: at(index + 4) });
    next = markDeliveryPlanningRoleCleanupSent(next, {
      role, attemptId: dispatched.attemptId
    }, { at: at(index + 5) });
    if (!recoverTwice) {
      return markDeliveryPlanningRoleCleanupComplete(next, {
        role, attemptId: dispatched.attemptId
      }, { at: at(index + 6) });
    }
    next = markDeliveryPlanningRoleCleanupRequired(next, {
      role, attemptId: dispatched.attemptId, error: 'The first cleanup response was lost.'
    }, { at: at(index + 6) });
    for (let recovery = 1; recovery <= 2; recovery += 1) {
      next = authorizeDeliveryPlanningContinue(next, {
        operationId: `planning:reserved:cleanup:${role}:recovery:${recovery}`,
        kind: 'cleanup_only', role, attemptId: dispatched.attemptId,
        claimId: `cleanup:reserved:${role}:recovery:${recovery}`,
        cleanupRecoveryOutcome: 'exact_worker',
        requestedStoreRevision: index + 100 + recovery,
        requestedRunRevision: next.revision
      }, { at: at(index + 5 + (recovery * 3)) });
      next = markDeliveryPlanningRoleCleanupSent(next, {
        role, attemptId: dispatched.attemptId
      }, { at: at(index + 6 + (recovery * 3)) });
      if (recovery < 2) {
        next = markDeliveryPlanningRoleCleanupRequired(next, {
          role, attemptId: dispatched.attemptId, error: 'The recovered cleanup response was also lost.'
        }, { at: at(index + 7 + (recovery * 3)) });
      }
    }
    return markDeliveryPlanningRoleCleanupComplete(next, {
      role, attemptId: dispatched.attemptId
    }, { at: at(index + 13) });
  }

  run = finishWithReservedCleanup(run, 'po', 20);
  run = finishWithReservedCleanup(run, 'ba', 30);
  run = finishWithReservedCleanup(run, 'qa', 40);
  run = finishWithReservedCleanup(run, 'dev', 50, true);
  assert.equal(
    run.continueReceipts.filter((receipt) => receipt.kind === 'resource_retry').length,
    DELIVERY_PLANNING_RUN_MAX_RESOURCE_CONTINUE_RECEIPTS
  );
  assert.equal(
    run.continueReceipts.filter((receipt) => receipt.kind === 'cleanup_only').length,
    DELIVERY_PLANNING_RUN_MAX_CLEANUP_CONTINUE_RECEIPTS
  );
  assert.equal(run.continueReceipts.length, 12);
  assert.equal(run.roles.dev.attempts[0].cleanup.state, 'complete');
  assert.equal(run.roles.dev.attempts[0].cleanup.recoveryCount, 2);
  run = cancelDeliveryPlanningRun(run, {
    operatorConfirmed: true,
    reason: 'All exact cleanup authorizations completed and the operator closes the Run.'
  }, { at: at(64) });
  assert.equal(run.condition, 'canceled');
});

test('an exact cleanup observation recovers only cleanup and then permits safe cancellation', () => {
  const fresh = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: sourcePlan() }, { at: at(0) });
  const makeUncertain = () => {
    let run = dispatchRole(fresh, 'po', 10).run;
    const attemptId = run.roles.po.attempts[0].id;
    const roleReport = report(run, 'po', attemptId);
    run = recordDeliveryPlanningRoleReport(run, {
      role: 'po', attemptId, report: roleReport, outputDigest: planningRoleReportOutputDigest(roleReport)
    }, { at: at(13) });
    run = markDeliveryPlanningRoleCleanupRequired(run, {
      role: 'po', attemptId, error: 'The cleanup submission outcome is unknown.'
    }, { at: at(14) });
    return { run, attemptId };
  };

  let absent = makeUncertain();
  assert.throws(() => recoverDeliveryPlanningRoleCleanup(absent.run, {
    role: 'po', attemptId: absent.attemptId, outcome: 'ambiguous', claimId: ''
  }, { at: at(15) }), /cleanup_recovery_outcome_invalid/);
  assert.throws(() => recoverDeliveryPlanningRoleCleanup(absent.run, {
    role: 'po', attemptId: absent.attemptId, outcome: 'worker_absent', claimId: 'not:empty:claim'
  }, { at: at(15) }), /cleanup_recovery_claim_invalid/);
  assert.throws(() => recoverDeliveryPlanningRoleCleanup(fresh, {
    role: 'po', attemptId: absent.attemptId, outcome: 'worker_absent', claimId: ''
  }, { at: at(15) }), /cleanup_recovery_not_expected/);
  absent.run = recoverDeliveryPlanningRoleCleanup(absent.run, {
    role: 'po', attemptId: absent.attemptId, outcome: 'worker_absent', claimId: ''
  }, { at: at(15) });
  assert.equal(absent.run.roles.po.attempts[0].cleanup.state, 'complete');
  assert.equal(absent.run.roles.po.attempts[0].cleanup.recoveryOutcome, 'worker_absent');
  assert.equal(absent.run.condition, 'reconcile_required');
  absent.run = cancelDeliveryPlanningRun(absent.run, {
    operatorConfirmed: true, reason: 'The exact worker is absent and the operator closes the run.'
  }, { at: at(16) });
  assert.equal(absent.run.condition, 'canceled');

  let exact = makeUncertain();
  exact.run = authorizeDeliveryPlanningContinue(exact.run, {
    operationId: 'planning:continue:cleanup:recover1',
    kind: 'cleanup_only',
    role: 'po',
    attemptId: exact.attemptId,
    claimId: 'cleanup:continue:recovered:1',
    cleanupRecoveryOutcome: 'exact_worker',
    requestedStoreRevision: 25,
    requestedRunRevision: exact.run.revision
  }, { at: at(15) });
  assert.equal(exact.run.roles.po.attempts[0].cleanup.state, 'claimed');
  assert.equal(exact.run.roles.po.attempts[0].cleanup.recoveryOutcome, 'exact_worker');
  exact.run = markDeliveryPlanningRoleCleanupSent(exact.run, {
    role: 'po', attemptId: exact.attemptId
  }, { at: at(16) });
  exact.run = markDeliveryPlanningRoleCleanupRequired(exact.run, {
    role: 'po', attemptId: exact.attemptId,
    error: 'The recovered exact worker cleanup outcome is still uncertain.'
  }, { at: at(17) });
  exact.run = authorizeDeliveryPlanningContinue(exact.run, {
    operationId: 'planning:continue:cleanup:recover2',
    kind: 'cleanup_only', role: 'po', attemptId: exact.attemptId,
    claimId: 'cleanup:continue:recovered:2', cleanupRecoveryOutcome: 'exact_worker',
    requestedStoreRevision: 26, requestedRunRevision: exact.run.revision
  }, { at: at(18) });
  exact.run = markDeliveryPlanningRoleCleanupSent(exact.run, {
    role: 'po', attemptId: exact.attemptId
  }, { at: at(19) });
  exact.run = markDeliveryPlanningRoleCleanupRequired(exact.run, {
    role: 'po', attemptId: exact.attemptId,
    error: 'The second exact cleanup outcome is uncertain.'
  }, { at: at(20) });
  assert.throws(() => recoverDeliveryPlanningRoleCleanup(exact.run, {
    role: 'po', attemptId: exact.attemptId, outcome: 'exact_worker',
    claimId: 'cleanup:continue:recovered:3'
  }, { at: at(21) }), /cleanup_recovery_outcome_conflict/);
  exact.run = recoverDeliveryPlanningRoleCleanup(exact.run, {
    role: 'po', attemptId: exact.attemptId, outcome: 'worker_absent', claimId: ''
  }, { at: at(21) });
  assert.equal(exact.run.condition, 'reconcile_required');
  assert.equal(exact.run.roles.po.attempts[0].cleanup.state, 'complete');
  assert.equal(exact.run.roles.po.attempts[0].cleanup.recoveryCount, 3);
  assert.deepEqual(
    exact.run.roles.po.attempts[0].cleanup.recoveryHistory.map((item) => item.outcome),
    ['exact_worker', 'exact_worker', 'worker_absent']
  );
  exact.run = cancelDeliveryPlanningRun(exact.run, {
    operatorConfirmed: true, reason: 'Recovered exact cleanup completed; close without retrying role work.'
  }, { at: at(22) });
  assert.equal(exact.run.condition, 'canceled');

  const direct = makeUncertain();
  const recovered = recoverDeliveryPlanningRoleCleanup(direct.run, {
    role: 'po', attemptId: direct.attemptId, outcome: 'exact_worker',
    claimId: 'cleanup:direct:recovered:0001'
  }, { at: at(15) });
  assert.equal(recovered.roles.po.attempts[0].cleanup.state, 'claimed');
  assert.equal(recovered.roles.po.attempts[0].cleanup.claimId, 'cleanup:direct:recovered:0001');
  assert.throws(() => recoverDeliveryPlanningRoleCleanup(recovered, {
    role: 'po', attemptId: direct.attemptId, outcome: 'exact_worker',
    claimId: 'cleanup:direct:recovered:0002'
  }, { at: at(16) }), /cleanup_recovery_not_expected/);
});

test('off-course dominates reports, failures, cleanup recovery, and claimed apply transitions', () => {
  const fresh = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: sourcePlan() }, { at: at(0) });
  let dispatched = dispatchRole(fresh, 'po', 10).run;
  const attemptId = dispatched.roles.po.attempts[0].id;
  const blocker = 'The worker expanded beyond the frozen planning scope.';
  dispatched = markDeliveryPlanningRunOffCourse(dispatched, { reason: blocker }, { at: at(13) });
  const roleReport = report(dispatched, 'po', attemptId, 'failed');
  dispatched = recordDeliveryPlanningRoleReport(dispatched, {
    role: 'po', attemptId, report: roleReport, outputDigest: planningRoleReportOutputDigest(roleReport)
  }, { at: at(14) });
  assert.equal(dispatched.condition, 'off_course');
  assert.equal(dispatched.blocker, blocker);
  assert.equal(dispatched.roles.po.attempts[0].cleanup.state, 'pending');
  dispatched = claimDeliveryPlanningRoleCleanup(dispatched, {
    role: 'po', attemptId, claimId: 'cleanup:offcourse:claim:0001'
  }, { at: at(15) });
  dispatched = markDeliveryPlanningRoleCleanupSent(dispatched, { role: 'po', attemptId }, { at: at(16) });
  dispatched = markDeliveryPlanningRoleCleanupRequired(dispatched, {
    role: 'po', attemptId, error: 'The off-course worker cleanup outcome is uncertain.'
  }, { at: at(17) });
  assert.equal(dispatched.condition, 'off_course');
  assert.equal(dispatched.blocker, blocker);
  dispatched = recoverDeliveryPlanningRoleCleanup(dispatched, {
    role: 'po', attemptId, outcome: 'worker_absent', claimId: ''
  }, { at: at(18) });
  assert.equal(dispatched.condition, 'off_course');
  assert.equal(dispatched.roles.po.attempts[0].cleanup.state, 'complete');
  assert.equal(dispatched.candidate, null);
  assert.throws(
    () => compileDeliveryPlanningCandidate(dispatched, {}, { at: at(19) }),
    /delivery_planning_run_synthesis_not_ready/
  );
  assert.throws(() => claimDeliveryPlanningApply(dispatched, {
    claimId: 'apply:offcourse:forbidden:1', candidateDigest: '0'.repeat(64)
  }, { at: at(19) }), /delivery_planning_run_candidate_not_applyable/);
  dispatched = cancelDeliveryPlanningRun(dispatched, {
    operatorConfirmed: true, reason: 'The off-course worker is absent and cleanup is complete.'
  }, { at: at(19) });
  assert.equal(dispatched.condition, 'canceled');

  let claimed = dispatchRole(fresh, 'po', 60).run;
  claimed = markDeliveryPlanningRunOffCourse(claimed, { reason: blocker }, { at: at(63) });
  claimed = markDeliveryPlanningRoleCrash(claimed, {
    role: 'po', attemptId: 'planning-attempt-po-00000060', reason: 'The worker exited.'
  }, { at: at(64) });
  assert.equal(claimed.condition, 'off_course');
  assert.equal(claimed.blocker, blocker);

  let apply = synthesizedRun();
  apply = claimDeliveryPlanningApply(apply, {
    claimId: 'apply:offcourse:claimed:1', candidateDigest: apply.candidate.digest
  }, { at: at(51) });
  apply = markDeliveryPlanningRunOffCourse(apply, {
    reason: 'Do not overwrite the apply outbox.'
  }, { at: at(52) });
  assert.equal(apply.condition, 'off_course');
  assert.equal(apply.applyOutbox.state, 'claimed');
  assert.throws(() => markDeliveryPlanningApplied(apply, {
    claimId: 'apply:offcourse:claimed:1', candidateDigest: apply.candidate.digest,
    appliedPlanRevision: apply.planRevision + 1,
    appliedPlanDigest: apply.candidate.previewPlanDigest
  }, { at: at(53) }), /delivery_planning_run_apply_binding_conflict/);
  assert.throws(() => markDeliveryPlanningApplyReconcileRequired(apply, {
    claimId: 'apply:offcourse:claimed:1', error: 'Do not overwrite off-course.'
  }, { at: at(53) }), /delivery_planning_run_apply_binding_conflict/);
  assert.throws(() => cancelDeliveryPlanningRun(apply, {
    operatorConfirmed: true, reason: 'The apply claim is not reconciled yet.'
  }, { at: at(53) }), /delivery_planning_run_cleanup_required/);
  assert.throws(() => abandonDeliveryPlanningApply(apply, {
    claimId: 'apply:offcourse:claimed:1', candidateDigest: apply.candidate.digest,
    observation: 'unknown', reason: 'No exact receipt observation was made.'
  }, { at: at(53) }), /delivery_planning_run_apply_observation_invalid/);
  apply = abandonDeliveryPlanningApply(apply, {
    claimId: 'apply:offcourse:claimed:1', candidateDigest: apply.candidate.digest,
    observation: 'plan_receipt_absent',
    reason: 'The deterministic Plan update receipt is authoritatively absent.'
  }, { at: at(53) });
  assert.equal(apply.phase, 'review');
  assert.equal(apply.condition, 'off_course');
  assert.equal(apply.applyOutbox.state, 'abandoned');
  assert.equal(apply.applyOutbox.observation, 'plan_receipt_absent');
  assertTamper(apply, (run) => { run.applyOutbox.observation = ''; }, /apply_lifecycle_invalid/);
  apply = cancelDeliveryPlanningRun(apply, {
    operatorConfirmed: true, reason: 'Operator closed the safely abandoned apply.'
  }, { at: at(54) });
  assert.equal(apply.phase, 'closed');
  assert.equal(apply.condition, 'canceled');
  assert.equal(apply.applyOutbox.state, 'abandoned');
});

test('source Plan eligibility uses the exact persisted-byte boundary before any role spawn', () => {
  const bytes = (value) => Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let near = null;
  let oversized = null;
  for (let padding = 0; padding <= 780; padding += 1) {
    const candidate = sourcePlan({
      unresolvedQuestions: Array.from({ length: 24 }, (_, index) => (
        `Q${String(index).padStart(2, '0')}:${'x'.repeat(padding)}`
      ))
    });
    if (bytes(candidate) <= DELIVERY_PLANNING_SOURCE_PLAN_MAX_PERSISTED_BYTES) near = candidate;
    else {
      oversized = candidate;
      break;
    }
  }
  assert.ok(near);
  assert.ok(oversized);
  assert.ok(bytes(near) > DELIVERY_PLANNING_SOURCE_PLAN_MAX_PERSISTED_BYTES - 64);
  const accepted = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: near }, { at: at(1) });
  assert.equal(accepted.roles.po.attempts.length, 0);
  assert.throws(
    () => compileDeliveryPlanningCandidate(accepted, {}, { at: at(2) }),
    /delivery_planning_run_synthesis_not_ready/
  );
  assert.throws(
    () => createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: oversized }, { at: at(1) }),
    /delivery_planning_run_source_plan_too_large/
  );
});

test('near-maximum source, PO, and BA inputs fit both independent challenge envelopes', () => {
  const bytes = (value) => Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let nearSource = null;
  for (let padding = 0; padding <= 780; padding += 1) {
    const candidate = sourcePlan({
      unresolvedQuestions: Array.from({ length: 24 }, (_, index) => (
        `Q${String(index).padStart(2, '0')}:${'x'.repeat(padding)}`
      ))
    });
    if (bytes(candidate) <= DELIVERY_PLANNING_SOURCE_PLAN_MAX_PERSISTED_BYTES) nearSource = candidate;
    else break;
  }
  assert.ok(bytes(nearSource) > DELIVERY_PLANNING_SOURCE_PLAN_MAX_PERSISTED_BYTES - 64);
  let current = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: nearSource }, { at: at(1) });

  function maximumArtifactReport(run, role, attemptId) {
    let accepted = null;
    for (let padding = 0; padding <= 780; padding += 1) {
      const candidate = report(run, role, attemptId);
      candidate.evidence = [];
      if (role === 'po') {
        candidate.artifact.nonGoals = Array.from({ length: 20 }, (_, index) => (
          `PO-${String(index).padStart(2, '0')}:${'p'.repeat(padding)}`
        ));
      } else {
        candidate.artifact.requirements = Array.from({ length: 20 }, (_, index) => ({
          id: `REQ-MAX-${String(index).padStart(2, '0')}`,
          text: `BA-${String(index).padStart(2, '0')}:${'b'.repeat(padding)}`
        }));
      }
      if (bytes(candidate) <= PLANNING_ROLE_REPORT_MAX_PERSISTED_BYTES) accepted = candidate;
      else break;
    }
    assert.ok(bytes(accepted) > PLANNING_ROLE_REPORT_MAX_PERSISTED_BYTES - 64);
    return accepted;
  }

  function finishMaximumArtifactRole(run, role, index) {
    const dispatched = dispatchRole(run, role, index);
    const roleReport = maximumArtifactReport(dispatched.run, role, dispatched.attemptId);
    let next = recordDeliveryPlanningRoleReport(dispatched.run, {
      role,
      attemptId: dispatched.attemptId,
      report: roleReport,
      outputDigest: planningRoleReportOutputDigest(roleReport)
    }, { at: at(index + 3) });
    next = claimDeliveryPlanningRoleCleanup(next, {
      role, attemptId: dispatched.attemptId, claimId: `cleanup:maximum:${role}`
    }, { at: at(index + 4) });
    next = markDeliveryPlanningRoleCleanupSent(next, {
      role, attemptId: dispatched.attemptId
    }, { at: at(index + 5) });
    return markDeliveryPlanningRoleCleanupComplete(next, {
      role, attemptId: dispatched.attemptId
    }, { at: at(index + 6) });
  }

  current = finishMaximumArtifactRole(current, 'po', 10);
  current = finishMaximumArtifactRole(current, 'ba', 20);
  const qa = compileDeliveryPlanningRoleEnvelope(current, { role: 'qa' });
  const dev = compileDeliveryPlanningRoleEnvelope(current, { role: 'dev' });
  assert.ok(qa.text.length <= DELIVERY_PLANNING_ROLE_ENVELOPE_MAX_CHARS);
  assert.ok(dev.text.length <= DELIVERY_PLANNING_ROLE_ENVELOPE_MAX_CHARS);
  assert.equal(qa.commonInputDigest, dev.commonInputDigest);
});

test('an over-complete question union accepts the final report, blocks synthesis, and still cleans up', () => {
  let current = createDeliveryPlanningRun({ id: RUN_ID, sourcePlan: sourcePlan() }, { at: at(0) });
  function finishQuestionRole(run, role, index) {
    const dispatched = dispatchRole(run, role, index);
    const roleReport = report(dispatched.run, role, dispatched.attemptId);
    roleReport.artifact.openQuestions = Array.from({ length: 30 }, (_, questionIndex) => (
      `${role.toUpperCase()} unique planning question ${String(questionIndex).padStart(2, '0')}?`
    ));
    let next = recordDeliveryPlanningRoleReport(dispatched.run, {
      role,
      attemptId: dispatched.attemptId,
      report: roleReport,
      outputDigest: planningRoleReportOutputDigest(roleReport)
    }, { at: at(index + 3) });
    const accepted = next;
    next = claimDeliveryPlanningRoleCleanup(next, {
      role, attemptId: dispatched.attemptId, claimId: `cleanup:questions:${role}`
    }, { at: at(index + 4) });
    next = markDeliveryPlanningRoleCleanupSent(next, {
      role, attemptId: dispatched.attemptId
    }, { at: at(index + 5) });
    next = markDeliveryPlanningRoleCleanupComplete(next, {
      role, attemptId: dispatched.attemptId
    }, { at: at(index + 6) });
    return { run: next, accepted };
  }

  current = finishQuestionRole(current, 'po', 10).run;
  current = finishQuestionRole(current, 'ba', 20).run;
  current = finishQuestionRole(current, 'qa', 30).run;
  const final = finishQuestionRole(current, 'dev', 40);
  assert.equal(final.accepted.roles.dev.report.artifact.openQuestions.length, 30);
  assert.equal(final.accepted.roles.dev.attempts[0].cleanup.state, 'pending');
  assert.equal(final.accepted.condition, 'needs_input');
  assert.deepEqual(final.accepted.synthesisBlocker, {
    code: 'delivery_planning_run_candidate_invalid',
    reason: 'The accepted role reports cannot form a schema-valid Delivery Plan candidate.',
    recordedAt: at(43)
  });
  assert.equal(final.run.phase, 'challenge');
  assert.equal(final.run.condition, 'needs_input');
  assert.equal(final.run.roles.dev.attempts[0].cleanup.state, 'complete');
  assert.throws(
    () => compileDeliveryPlanningCandidate(final.run, {}, { at: at(47) }),
    /delivery_planning_run_synthesis_not_ready/
  );
  assertTamper(final.run, (run) => {
    run.synthesisBlocker.code = 'unknown';
  }, /synthesis_blocker_invalid/);
  current = cancelDeliveryPlanningRun(final.run, {
    operatorConfirmed: true,
    reason: 'The operator will refine the over-complete question set in a new Plan.'
  }, { at: at(47) });
  assert.equal(current.phase, 'closed');
  assert.equal(current.condition, 'canceled');
});

test('an unchanged four-role candidate is durably blocked at report-time and explicit compile-time', () => {
  let current = createDeliveryPlanningRun({
    id: RUN_ID,
    sourcePlan: sourcePlan({ roles: structuredClone(ARTIFACTS), unresolvedQuestions: [] })
  }, { at: at(0) });
  function finishNoopRole(run, role, index) {
    const dispatched = dispatchRole(run, role, index);
    const roleReport = report(dispatched.run, role, dispatched.attemptId);
    let next = recordDeliveryPlanningRoleReport(dispatched.run, {
      role,
      attemptId: dispatched.attemptId,
      report: roleReport,
      outputDigest: planningRoleReportOutputDigest(roleReport)
    }, { at: at(index + 3) });
    const accepted = next;
    next = claimDeliveryPlanningRoleCleanup(next, {
      role, attemptId: dispatched.attemptId, claimId: `cleanup:unchanged:${role}`
    }, { at: at(index + 4) });
    next = markDeliveryPlanningRoleCleanupSent(next, {
      role, attemptId: dispatched.attemptId
    }, { at: at(index + 5) });
    next = markDeliveryPlanningRoleCleanupComplete(next, {
      role, attemptId: dispatched.attemptId
    }, { at: at(index + 6) });
    return { run: next, accepted };
  }
  current = finishNoopRole(current, 'po', 10).run;
  current = finishNoopRole(current, 'ba', 20).run;
  current = finishNoopRole(current, 'qa', 30).run;
  const final = finishNoopRole(current, 'dev', 40);
  const reason = 'The accepted role reports do not change the frozen source Delivery Plan.';
  assert.deepEqual(final.accepted.synthesisBlocker, {
    code: 'delivery_planning_run_candidate_unchanged',
    reason,
    recordedAt: at(43)
  });
  assert.equal(final.accepted.candidate, null);
  assert.equal(final.accepted.condition, 'needs_input');
  assert.equal(final.run.roles.dev.attempts[0].cleanup.state, 'complete');

  const legacySynthesis = structuredClone(final.run);
  legacySynthesis.phase = 'synthesis';
  legacySynthesis.condition = 'active';
  legacySynthesis.blocker = '';
  legacySynthesis.synthesisBlocker = null;
  validateDeliveryPlanningRun(legacySynthesis);
  const explicitlyBlocked = compileDeliveryPlanningCandidate(legacySynthesis, {}, { at: at(47) });
  assert.equal(explicitlyBlocked.phase, 'synthesis');
  assert.equal(explicitlyBlocked.condition, 'needs_input');
  assert.equal(explicitlyBlocked.candidate, null);
  assert.deepEqual(explicitlyBlocked.synthesisBlocker, {
    code: 'delivery_planning_run_candidate_unchanged', reason, recordedAt: at(47)
  });
  assert.equal(explicitlyBlocked.applyOutbox.state, 'held');
  assert.throws(() => claimDeliveryPlanningApply(explicitlyBlocked, {
    claimId: 'apply:unchanged:forbidden:1', candidateDigest: '0'.repeat(64)
  }, { at: at(48) }), /candidate_not_applyable/);

  const tamperedReview = structuredClone(legacySynthesis);
  const definitionPatch = {
    roles: {
      po: structuredClone(tamperedReview.roles.po.report.artifact),
      ba: structuredClone(tamperedReview.roles.ba.report.artifact),
      dev: structuredClone(tamperedReview.roles.dev.report.artifact),
      qa: structuredClone(tamperedReview.roles.qa.report.artifact)
    },
    unresolvedQuestions: []
  };
  const roleOutputDigests = Object.fromEntries(
    DELIVERY_PLANNING_RUN_ROLES.map((role) => [role, tamperedReview.roles[role].outputDigest])
  );
  tamperedReview.phase = 'review';
  tamperedReview.candidate = {
    definitionPatch,
    digest: canonicalSha256({
      version: 1,
      runId: tamperedReview.id,
      planId: tamperedReview.planId,
      planRevision: tamperedReview.planRevision,
      planDigest: tamperedReview.planDigest,
      definitionPatch,
      roleOutputDigests
    }),
    previewPlanDigest: tamperedReview.planDigest,
    readiness: lintDeliveryPlanReadiness(tamperedReview.sourcePlan),
    challenges: [],
    roleOutputDigests,
    compiledAt: at(47)
  };
  tamperedReview.applyOutbox = {
    ...tamperedReview.applyOutbox,
    updatedAt: at(47)
  };
  assert.throws(
    () => validateDeliveryPlanningRun(tamperedReview),
    /candidate_preview_binding_mismatch/
  );
});
