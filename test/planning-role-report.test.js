import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  PLANNING_ROLE_REPORT_MAX_PERSISTED_BYTES,
  parsePlanningRoleReport,
  planningRoleReportOutputDigest,
  readCodexPlanningRoleReport,
  validatePlanningRoleReport
} from '../planning-role-report.js';

const RUN_ID = 'planning-run-abcdefgh';
const PLAN_ID = 'plan-abcdefgh';
const ATTEMPT_ID = 'planning-attempt-abcdefgh';
const INPUT_DIGEST = 'a'.repeat(64);
const MARKER = `[PaneFleet Planning Dispatch ${ATTEMPT_ID}]`;

const ARTIFACTS = Object.freeze({
  po: Object.freeze({
    user: 'PaneFleet operator',
    problem: 'Planning is inconsistent.',
    outcome: 'A reviewable plan exists.',
    value: 'Less rework.',
    nonGoals: ['No live deployment.'],
    assumptions: ['The workspace is available.'],
    openQuestions: ['Which optional adapter is needed?']
  }),
  ba: Object.freeze({
    requirements: [{ id: 'REQ-001', text: 'Persist each planning role result.' }],
    dependencies: ['An approved workspace.'],
    edgeCases: ['A worker exits without a final answer.'],
    constraints: ['Never infer terminal output as completion.'],
    openQuestions: []
  }),
  dev: Object.freeze({
    architecture: 'Use a separate durable Planning Run.',
    steps: [{
      id: 'STEP-001',
      title: 'Add the parser',
      outcome: 'Only exact reports validate.',
      requirementIds: ['REQ-001'],
      scopePaths: ['planning-role-report.js'],
      checks: ['node --test test/planning-role-report.test.js']
    }],
    risks: ['A stale rollout could be misattributed.'],
    rollback: 'Remove the additive planning modules.',
    openQuestions: []
  }),
  qa: Object.freeze({
    acceptanceCriteria: [{
      id: 'AC-001',
      text: 'A stale result is rejected.',
      requirementIds: ['REQ-001']
    }],
    testStrategy: 'Exercise schema and rollout authority boundaries.',
    regressionChecks: ['Existing Delivery Result tests remain green.'],
    releaseRequired: false,
    releaseChecks: [],
    openQuestions: []
  })
});

function report(role = 'po', overrides = {}) {
  return {
    version: 1,
    runId: RUN_ID,
    planId: PLAN_ID,
    planRevision: 3,
    role,
    attemptId: ATTEMPT_ID,
    inputDigest: INPUT_DIGEST,
    status: 'complete',
    artifact: structuredClone(ARTIFACTS[role]),
    challenges: ['The final boundary is security-sensitive.'],
    evidence: [{ summary: 'Reviewed the supplied Plan revision and workspace context.', trusted: false }],
    ...overrides
  };
}

function block(value) {
  return `[PANEFLEET PLANNING RESULT]\n${JSON.stringify(value)}\n[/PANEFLEET PLANNING RESULT]`;
}

function response(timestamp, role, text, phase) {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      ...(phase ? { phase } : {}),
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }]
    }
  };
}

function turn(timestamp, overrides = {}) {
  return {
    timestamp,
    type: 'turn_context',
    payload: {
      approval_policy: 'never',
      sandbox_policy: { type: 'read-only', network_access: false },
      ...overrides
    }
  };
}

function jsonl(events) {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

function expected(role = 'po', overrides = {}) {
  return {
    runId: RUN_ID,
    planId: PLAN_ID,
    planRevision: 3,
    role,
    attemptId: ATTEMPT_ID,
    inputDigest: INPUT_DIGEST,
    ...overrides
  };
}

test('validates exact Plan v1 PO, BA, DEV, and QA artifacts and computes a stable server digest', () => {
  for (const role of ['po', 'ba', 'dev', 'qa']) {
    const source = report(role);
    assert.deepEqual(validatePlanningRoleReport(source, expected(role)), source);
    assert.match(planningRoleReportOutputDigest(source), /^[a-f0-9]{64}$/);
    assert.equal(planningRoleReportOutputDigest(source), planningRoleReportOutputDigest(structuredClone(source)));
  }

  const first = report('po');
  const changed = report('po');
  changed.artifact.value = 'A different value statement.';
  assert.notEqual(planningRoleReportOutputDigest(first), planningRoleReportOutputDigest(changed));
});

test('rejects unknown fields, invalid role artifacts, control characters, duplicate values, and trusted evidence claims', () => {
  assert.throws(
    () => validatePlanningRoleReport({ ...report(), outputDigest: 'b'.repeat(64) }),
    { code: 'planning_role_report_shape_invalid' }
  );
  assert.throws(
    () => validatePlanningRoleReport(report('po', { artifact: { ...ARTIFACTS.po, secret: 'hidden' } })),
    { code: 'planning_role_report_po_artifact_invalid' }
  );
  assert.throws(
    () => validatePlanningRoleReport(report('dev', {
      artifact: { ...ARTIFACTS.dev, steps: [{ ...ARTIFACTS.dev.steps[0], scopePaths: ['../server.js'] }] }
    })),
    { code: 'planning_role_report_scope_path_invalid' }
  );
  assert.throws(
    () => validatePlanningRoleReport(report('qa', {
      artifact: { ...ARTIFACTS.qa, testStrategy: 'unsafe\nmultiline' }
    })),
    { code: 'planning_role_report_control_characters_not_allowed' }
  );
  assert.throws(
    () => validatePlanningRoleReport(report('ba', {
      artifact: {
        ...ARTIFACTS.ba,
        requirements: [ARTIFACTS.ba.requirements[0], ARTIFACTS.ba.requirements[0]]
      }
    })),
    { code: 'planning_role_report_ba_requirements_invalid_duplicate' }
  );
  assert.throws(
    () => validatePlanningRoleReport(report('po', { challenges: ['same', 'same'] })),
    { code: 'planning_role_report_challenges_invalid_duplicate' }
  );
  assert.throws(
    () => validatePlanningRoleReport(report('po', {
      evidence: [{ summary: 'The agent says this is trustworthy.', trusted: true }]
    })),
    { code: 'planning_role_report_evidence_trust_invalid' }
  );
  assert.throws(
    () => validatePlanningRoleReport(report('po', {
      evidence: [{ summary: 'bounded', trusted: false, path: '/private/path' }]
    })),
    { code: 'planning_role_report_evidence_item_invalid' }
  );
});

test('rejects private Planning attempt, dispatch, session, scope, lease, and rollout tokens outside binding fields', () => {
  const privateCases = [
    report('po', {
      artifact: { ...ARTIFACTS.po, problem: `The prompt exposed ${ATTEMPT_ID}.` }
    }),
    report('po', { challenges: [`The worker echoed ${MARKER}.`] }),
    report('po', {
      evidence: [{
        summary: `Observed codex-planning-${'a'.repeat(24)}-po.`,
        trusted: false
      }]
    }),
    report('po', {
      artifact: {
        ...ARTIFACTS.po,
        openQuestions: [`Should panefleet-planning-${'b'.repeat(24)}.scope remain active?`]
      }
    }),
    report('ba', {
      artifact: {
        ...ARTIFACTS.ba,
        constraints: [`Do not expose planning-spawn-lease-${'c'.repeat(24)}-ba.`]
      }
    }),
    report('dev', {
      artifact: {
        ...ARTIFACTS.dev,
        architecture: 'Inspect /private/codex/sessions/2026/rollout-secret.jsonl.'
      }
    }),
    report('qa', {
      artifact: {
        ...ARTIFACTS.qa,
        testStrategy: 'Read /run/user/1000/panefleet-planning/contexts only in private runtime.'
      }
    })
  ];
  for (const privateReport of privateCases) {
    assert.throws(
      () => validatePlanningRoleReport(privateReport),
      { code: 'planning_role_report_private_identity_not_allowed' }
    );
  }

  // The exact top-level binding remains required and valid; only worker-authored
  // artifact, challenge, and evidence strings are prohibited from echoing it.
  assert.equal(validatePlanningRoleReport(report('po')).attemptId, ATTEMPT_ID);
});

test('rejects every malformed report identity and bounded collection shape', () => {
  for (const [overrides, code] of [
    [{ version: 2 }, 'planning_role_report_version_unsupported'],
    [{ runId: 'run-short' }, 'planning_role_report_run_id_invalid'],
    [{ planId: 'wrong-plan' }, 'planning_role_report_plan_id_invalid'],
    [{ planRevision: 0 }, 'planning_role_report_plan_revision_invalid'],
    [{ planRevision: 1.5 }, 'planning_role_report_plan_revision_invalid'],
    [{ role: 'operator' }, 'planning_role_report_role_invalid'],
    [{ attemptId: 'attempt-short' }, 'planning_role_report_attempt_id_invalid'],
    [{ inputDigest: 'ABC' }, 'planning_role_report_input_digest_invalid'],
    [{ evidence: 'not-an-array' }, 'planning_role_report_evidence_invalid']
  ]) {
    assert.throws(() => validatePlanningRoleReport(report('po', overrides)), { code });
  }

  assert.throws(() => validatePlanningRoleReport(null), { code: 'planning_role_report_shape_invalid' });
  assert.throws(
    () => validatePlanningRoleReport(report('po'), 'not-an-object'),
    { code: 'planning_role_report_expected_invalid' }
  );
  assert.throws(
    () => validatePlanningRoleReport(report('po'), { unknown: true }),
    { code: 'planning_role_report_expected_invalid' }
  );
  assert.throws(
    () => validatePlanningRoleReport(report('qa', {
      artifact: { ...ARTIFACTS.qa, releaseRequired: 'false' }
    })),
    { code: 'planning_role_report_qa_release_required_invalid' }
  );
  assert.throws(
    () => validatePlanningRoleReport(report('dev', {
      artifact: {
        ...ARTIFACTS.dev,
        steps: [ARTIFACTS.dev.steps[0], { ...ARTIFACTS.dev.steps[0] }]
      }
    })),
    { code: 'planning_role_report_dev_steps_invalid_duplicate' }
  );
  assert.throws(
    () => validatePlanningRoleReport(report('dev', {
      artifact: {
        ...ARTIFACTS.dev,
        steps: [{ ...ARTIFACTS.dev.steps[0], requirementIds: ['bad-id'] }]
      }
    })),
    { code: 'planning_role_report_dev_requirement_ids_invalid' }
  );
  assert.throws(
    () => validatePlanningRoleReport(report('dev', {
      artifact: {
        ...ARTIFACTS.dev,
        steps: [{ ...ARTIFACTS.dev.steps[0], scopePaths: ['same.js', 'same.js'] }]
      }
    })),
    { code: 'planning_role_report_dev_scope_paths_invalid_duplicate' }
  );
  assert.throws(
    () => validatePlanningRoleReport(report('po', {
      evidence: [
        { summary: 'Repeated evidence.', trusted: false },
        { summary: 'Repeated evidence.', trusted: false }
      ]
    })),
    { code: 'planning_role_report_evidence_duplicate' }
  );
});

test('parses only one exact planning result block with duplicate-key-safe JSON', () => {
  const source = report('ba');
  assert.deepEqual(parsePlanningRoleReport(block(source), expected('ba')), source);

  assert.throws(
    () => parsePlanningRoleReport(`commentary\n${block(source)}`),
    { code: 'planning_role_report_boundary_invalid' }
  );
  assert.throws(
    () => parsePlanningRoleReport(`${block(source)}\n`),
    { code: 'planning_role_report_boundary_invalid' }
  );
  assert.throws(
    () => parsePlanningRoleReport('[PANEFLEET PLANNING RESULT]\n{"version":1'),
    { code: 'planning_role_report_boundary_invalid' }
  );
  assert.throws(
    () => parsePlanningRoleReport(`${block(source)}\n${block(source)}`),
    { code: 'planning_role_report_boundary_ambiguous' }
  );

  const duplicateVersion = JSON.stringify(source).replace('"version":1', '"version":1,"\\u0076ersion":1');
  assert.throws(
    () => parsePlanningRoleReport(`[PANEFLEET PLANNING RESULT]\n${duplicateVersion}\n[/PANEFLEET PLANNING RESULT]`),
    { code: 'planning_role_report_json_duplicate_key' }
  );
});

test('the strict JSON reader rejects malformed separators, values, depth, and trailing data', () => {
  const wrapped = (json) => `[PANEFLEET PLANNING RESULT]\n${json}\n[/PANEFLEET PLANNING RESULT]`;
  for (const json of [
    '',
    '[]',
    '{"x" 1}',
    '{"x":1 "y":2}',
    '{"x":[1 2]}',
    '{"x":}',
    '{"x":"unterminated}',
    '{"x":"bad\nstring"}',
    '{"x":1e999}',
    '{"x":1} trailing',
    `{"x":${'['.repeat(18)}null${']'.repeat(18)}}`
  ]) {
    assert.throws(
      () => parsePlanningRoleReport(wrapped(json)),
      (error) => error?.code === 'planning_role_report_json_invalid'
        || error?.code === 'planning_role_report_json_depth_exceeded'
    );
  }
  assert.throws(() => parsePlanningRoleReport(Buffer.from('not text')), {
    code: 'planning_role_report_text_invalid'
  });
});

test('binds report identity to the expected Run, Plan revision, role, attempt, and input digest', () => {
  for (const [field, value, errorField] of [
    ['runId', 'planning-run-wrongrun', 'run_id'],
    ['planId', 'plan-wrongplan', 'plan_id'],
    ['planRevision', 4, 'plan_revision'],
    ['role', 'qa', 'role'],
    ['attemptId', 'planning-attempt-wrongone', 'attempt_id'],
    ['inputDigest', 'b'.repeat(64), 'input_digest']
  ]) {
    assert.throws(
      () => validatePlanningRoleReport(report('po'), expected('po', { [field]: value })),
      (error) => error?.code === `planning_role_report_${errorField}_mismatch`
    );
  }
  assert.throws(
    () => validatePlanningRoleReport(report('po', { status: 'invalid' })),
    { code: 'planning_role_report_status_invalid' }
  );
  for (const status of ['complete', 'needs_input', 'blocked', 'failed']) {
    assert.equal(validatePlanningRoleReport(report('po', { status })).status, status);
  }
});

test('bounds the full answer by UTF-8 bytes before parsing', () => {
  const oversized = `[PANEFLEET PLANNING RESULT]\n${'{'.repeat(256 * 1024)}\n[/PANEFLEET PLANNING RESULT]`;
  assert.throws(
    () => parsePlanningRoleReport(oversized),
    { code: 'planning_role_report_size_exceeded' }
  );
  const unicodeOversized = `[PANEFLEET PLANNING RESULT]\n${'🙂'.repeat(70 * 1024)}\n[/PANEFLEET PLANNING RESULT]`;
  assert.throws(
    () => parsePlanningRoleReport(unicodeOversized),
    { code: 'planning_role_report_size_exceeded' }
  );
});

test('reads one authoritative read-only final answer from the exact persisted rollout offset', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-planning-role-'));
  const file = path.join(directory, 'rollout.jsonl');
  const prefix = jsonl([
    response('2026-08-16T09:59:00.000Z', 'user', 'old work'),
    response('2026-08-16T09:59:01.000Z', 'assistant', block(report()), 'final_answer')
  ]);
  try {
    await writeFile(file, prefix);
    const startOffset = Buffer.byteLength(prefix);
    await appendFile(file, jsonl([
      response('2026-08-16T10:00:00.000Z', 'user', `Prepare the PO report.\n${MARKER}`),
      turn('2026-08-16T10:00:01.000Z'),
      response('2026-08-16T10:00:02.000Z', 'assistant', 'Working.', 'commentary'),
      response('2026-08-16T10:00:03.000Z', 'assistant', block(report()), 'final_answer')
    ]));
    const details = await stat(file);
    const result = await readCodexPlanningRoleReport(file, {
      confirmationMarker: MARKER,
      submittedAt: '2026-08-16T09:59:59.000Z',
      startOffset,
      expected: expected()
    });

    assert.deepEqual(result.report, report());
    assert.equal(result.outputDigest, planningRoleReportOutputDigest(report()));
    assert.equal(result.completedAt, '2026-08-16T10:00:03.000Z');
    assert.deepEqual(result.authority, {
      sandbox: 'read-only',
      approvalPolicy: 'never',
      networkAccess: false,
      networkAccessObserved: true,
      promptAt: '2026-08-16T10:00:00.000Z',
      contextAt: '2026-08-16T10:00:01.000Z',
      sandboxObserved: true,
      approvalPolicyObserved: true,
      startOffset,
      endOffset: details.size,
      skippedPartialRecord: false
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects stale, duplicated, superseded, replayed, and assistant-only marker evidence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-planning-stale-'));
  const file = path.join(directory, 'rollout.jsonl');
  const options = {
    confirmationMarker: MARKER,
    submittedAt: '2026-08-16T09:59:59.000Z',
    startOffset: 0,
    expected: expected()
  };
  try {
    await writeFile(file, jsonl([
      response('2026-08-16T09:00:00.000Z', 'user', MARKER),
      turn('2026-08-16T10:00:01.000Z'),
      response('2026-08-16T10:00:02.000Z', 'assistant', block(report()), 'final_answer')
    ]));
    assert.equal(await readCodexPlanningRoleReport(file, options), null);

    await writeFile(file, jsonl([
      response('2026-08-16T10:00:00.000Z', 'user', MARKER),
      turn('2026-08-16T10:00:01.000Z'),
      response('2026-08-16T10:00:02.000Z', 'assistant', block(report()), 'final_answer'),
      response('2026-08-16T10:00:03.000Z', 'assistant', block(report()), 'final_answer')
    ]));
    assert.equal(await readCodexPlanningRoleReport(file, options), null);

    await writeFile(file, jsonl([
      response('2026-08-16T10:00:00.000Z', 'user', MARKER),
      turn('2026-08-16T10:00:01.000Z'),
      response('2026-08-16T10:00:02.000Z', 'assistant', block(report()), 'final_answer'),
      response('2026-08-16T10:00:03.000Z', 'user', 'A later operator instruction.')
    ]));
    assert.equal(await readCodexPlanningRoleReport(file, options), null);

    await writeFile(file, jsonl([
      response('2026-08-16T10:00:00.000Z', 'user', MARKER),
      response('2026-08-16T10:00:01.000Z', 'user', `Replay ${MARKER}`),
      turn('2026-08-16T10:00:02.000Z'),
      response('2026-08-16T10:00:03.000Z', 'assistant', block(report()), 'final_answer')
    ]));
    assert.equal(await readCodexPlanningRoleReport(file, options), null);

    await writeFile(file, jsonl([
      response('2026-08-16T10:00:00.000Z', 'assistant', `Untrusted echo ${MARKER}`, 'commentary'),
      turn('2026-08-16T10:00:01.000Z'),
      response('2026-08-16T10:00:02.000Z', 'assistant', block(report()), 'final_answer')
    ]));
    assert.equal(await readCodexPlanningRoleReport(file, options), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails closed on missing or elevated authority telemetry and wrong report bindings', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-planning-authority-'));
  const file = path.join(directory, 'rollout.jsonl');
  const options = {
    confirmationMarker: MARKER,
    submittedAt: '2026-08-16T09:59:59.000Z',
    startOffset: 0,
    expected: expected()
  };
  try {
    await writeFile(file, jsonl([
      response('2026-08-16T10:00:00.000Z', 'user', MARKER),
      turn('2026-08-16T10:00:01.000Z', {
        approval_policy: 'never',
        sandbox_policy: { type: 'read-only' }
      }),
      response('2026-08-16T10:00:02.000Z', 'assistant', block(report()), 'final_answer')
    ]));
    const omission = await readCodexPlanningRoleReport(file, options);
    assert.equal(omission.authority.sandbox, 'read-only');
    assert.equal(omission.authority.approvalPolicy, 'never');
    assert.equal(omission.authority.networkAccess, null);
    assert.equal(omission.authority.networkAccessObserved, false);

    for (const authority of [
      { approval_policy: undefined, sandbox_policy: { type: 'read-only' } },
      { approval_policy: 'never', sandbox_policy: undefined },
      { approval_policy: 'on-request', sandbox_policy: { type: 'read-only', network_access: false } },
      { approval_policy: 'never', sandbox_policy: { type: 'workspace-write', network_access: false } },
      { approval_policy: 'never', sandbox_policy: { type: 'read-only', network_access: true } }
    ]) {
      await writeFile(file, jsonl([
        response('2026-08-16T10:00:00.000Z', 'user', MARKER),
        turn('2026-08-16T10:00:01.000Z', authority),
        response('2026-08-16T10:00:02.000Z', 'assistant', block(report()), 'final_answer')
      ]));
      await assert.rejects(readCodexPlanningRoleReport(file, options), {
        code: 'planning_role_report_authority_mismatch'
      });
    }

    await writeFile(file, jsonl([
      response('2026-08-16T10:00:00.000Z', 'user', MARKER),
      turn('2026-08-16T10:00:01.000Z'),
      response('2026-08-16T10:00:02.000Z', 'assistant', block(report('qa', {
        attemptId: 'planning-attempt-otherone'
      })), 'final_answer')
    ]));
    await assert.rejects(readCodexPlanningRoleReport(file, options), {
      code: 'planning_role_report_role_mismatch'
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('authority requirements are exact and may be explicitly disabled only by the caller', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-planning-authority-contract-'));
  const file = path.join(directory, 'rollout.jsonl');
  const options = {
    confirmationMarker: MARKER,
    submittedAt: '2026-08-16T09:59:59.000Z',
    startOffset: 0,
    expected: expected()
  };
  try {
    await writeFile(file, jsonl([
      response('2026-08-16T10:00:00.000Z', 'user', MARKER),
      turn('2026-08-16T10:00:01.000Z'),
      response('2026-08-16T10:00:02.000Z', 'assistant', block(report()), 'final_answer')
    ]));
    assert.ok(await readCodexPlanningRoleReport(file, { ...options, requiredAuthority: false }));
    assert.ok(await readCodexPlanningRoleReport(file, {
      ...options,
      requiredAuthority: { sandbox: 'read-only', approvalPolicy: 'never', networkAccess: false }
    }));
    for (const requiredAuthority of [
      { sandbox: 'read-only', approvalPolicy: 'never' },
      { sandbox: 'read-only', approvalPolicy: 'never', networkAccess: 'false' },
      {
        sandbox: 'read-only',
        approvalPolicy: 'never',
        networkAccess: false,
        allowUnobservedNetwork: 'yes'
      }
    ]) {
      await assert.rejects(
        readCodexPlanningRoleReport(file, { ...options, requiredAuthority }),
        { code: 'planning_role_report_required_authority_invalid' }
      );
    }

    assert.equal(await readCodexPlanningRoleReport(file, {
      ...options,
      confirmationMarker: '[PaneFleet Planning Dispatch invalid]'
    }), null);
    assert.ok(await readCodexPlanningRoleReport(file, {
      ...options,
      expected: null
    }));
    await assert.rejects(
      readCodexPlanningRoleReport(file, {
        ...options,
        expected: { ...expected(), attemptId: 'planning-attempt-otherone' }
      }),
      { code: 'planning_role_report_attempt_id_mismatch' }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reports exact byte-window and offset failures and safely skips a partial first record', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-planning-window-'));
  const file = path.join(directory, 'rollout.jsonl');
  const events = jsonl([
    response('2026-08-16T10:00:00.000Z', 'user', MARKER),
    turn('2026-08-16T10:00:01.000Z'),
    response('2026-08-16T10:00:02.000Z', 'assistant', block(report()), 'final_answer')
  ]);
  const options = {
    confirmationMarker: MARKER,
    submittedAt: '2026-08-16T09:59:59.000Z',
    startOffset: 0,
    expected: expected()
  };
  try {
    await writeFile(file, events);
    await assert.rejects(readCodexPlanningRoleReport(file, { ...options, maximumBytes: 16 }), {
      code: 'codex_planning_role_report_window_exceeded'
    });
    await assert.rejects(readCodexPlanningRoleReport(file, { ...options, startOffset: Buffer.byteLength(events) + 1 }), {
      code: 'codex_planning_role_report_offset_past_end'
    });
    await assert.rejects(readCodexPlanningRoleReport(file, { ...options, startOffset: -1 }), {
      code: 'codex_planning_role_report_offset_invalid'
    });

    const partialPrefix = '{"timestamp":"2026-08-16T09:58:00.000Z","type":"response_item","payload":';
    await writeFile(file, partialPrefix);
    const startOffset = Buffer.byteLength(partialPrefix);
    await appendFile(file, `{"malicious":"${MARKER}"}}\n${events}`);
    const recovered = await readCodexPlanningRoleReport(file, { ...options, startOffset });
    assert.equal(recovered.authority.skippedPartialRecord, true);
    assert.equal(recovered.authority.startOffset, startOffset);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('surfaces malformed and truncated final report content without accepting terminal-like text', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-planning-malformed-'));
  const file = path.join(directory, 'rollout.jsonl');
  const options = {
    confirmationMarker: MARKER,
    submittedAt: '2026-08-16T09:59:59.000Z',
    startOffset: 0,
    expected: expected()
  };
  try {
    for (const finalText of [
      'terminal says complete',
      '[PANEFLEET PLANNING RESULT]\n{"version":1',
      `${block(report())}\nterminal footer`
    ]) {
      await writeFile(file, jsonl([
        response('2026-08-16T10:00:00.000Z', 'user', MARKER),
        turn('2026-08-16T10:00:01.000Z'),
        response('2026-08-16T10:00:02.000Z', 'assistant', finalText, 'final_answer')
      ]));
      await assert.rejects(
        readCodexPlanningRoleReport(file, options),
        (error) => error?.code === 'planning_role_report_boundary_invalid'
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('persisted report byte cap accepts the exact near-boundary shape and rejects the next valid schema shape', () => {
  const bytes = (value) => Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let near = null;
  let oversized = null;
  for (let padding = 0; padding <= 780; padding += 1) {
    const candidate = report('po', {
      evidence: Array.from({ length: 40 }, (_, index) => ({
        summary: `E${String(index).padStart(2, '0')}:${'x'.repeat(padding)}`,
        trusted: false
      }))
    });
    if (bytes(candidate) <= PLANNING_ROLE_REPORT_MAX_PERSISTED_BYTES) near = candidate;
    else {
      oversized = candidate;
      break;
    }
  }
  assert.ok(near);
  assert.ok(oversized);
  assert.ok(bytes(near) > PLANNING_ROLE_REPORT_MAX_PERSISTED_BYTES - 64);
  assert.deepEqual(validatePlanningRoleReport(near), near);
  assert.throws(
    () => validatePlanningRoleReport(oversized),
    { code: 'planning_role_report_persisted_size_exceeded' }
  );
  assert.throws(
    () => parsePlanningRoleReport(block(oversized)),
    { code: 'planning_role_report_persisted_size_exceeded' }
  );
});
