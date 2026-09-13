import path from 'node:path';

import { readCodexFinalAnswer } from './codex-telemetry.js';
import { canonicalSha256 } from './delivery-plan.js';

export const PLANNING_ROLE_REPORT_VERSION = 1;
export const PLANNING_ROLE_REPORT_ROLES = Object.freeze(['po', 'ba', 'dev', 'qa']);
export const PLANNING_ROLE_REPORT_STATUSES = Object.freeze(['complete', 'needs_input', 'blocked', 'failed']);
export const PLANNING_ROLE_REPORT_MAX_PERSISTED_BYTES = 16 * 1024;

const ROLE_SET = new Set(PLANNING_ROLE_REPORT_ROLES);
const STATUS_SET = new Set(PLANNING_ROLE_REPORT_STATUSES);
const REPORT_KEYS = Object.freeze([
  'version',
  'runId',
  'planId',
  'planRevision',
  'role',
  'attemptId',
  'inputDigest',
  'status',
  'artifact',
  'challenges',
  'evidence'
]);
const EXPECTED_KEYS = new Set(['runId', 'planId', 'planRevision', 'role', 'attemptId', 'inputDigest']);
const EXPECTED_ERROR_FIELDS = Object.freeze({
  runId: 'run_id',
  planId: 'plan_id',
  planRevision: 'plan_revision',
  role: 'role',
  attemptId: 'attempt_id',
  inputDigest: 'input_digest'
});
const RUN_ID_PATTERN = /^planning-run-[a-z0-9][a-z0-9-]{7,63}$/;
const PLAN_ID_PATTERN = /^plan-[a-z0-9][a-z0-9-]{7,63}$/;
const ATTEMPT_ID_PATTERN = /^planning-attempt-[a-z0-9][a-z0-9-]{7,63}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const REQUIREMENT_ID_PATTERN = /^REQ-[A-Z0-9][A-Z0-9_-]{0,39}$/;
const STEP_ID_PATTERN = /^STEP-[A-Z0-9][A-Z0-9_-]{0,39}$/;
const ACCEPTANCE_ID_PATTERN = /^AC-[A-Z0-9][A-Z0-9_-]{0,39}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const PRIVATE_PLANNING_TEXT_PATTERNS = Object.freeze([
  /planning-attempt-[a-z0-9][a-z0-9-]{7,63}/i,
  /\[panefleet planning dispatch\b[^\]\r\n]{0,128}\]/i,
  /codex-planning-[a-f0-9]{24}-(?:po|ba|qa|dev)/i,
  /planning-spawn-lease-[a-f0-9]{24}-(?:po|ba|qa|dev)/i,
  /panefleet-planning-[a-f0-9]{24}\.scope/i,
  /(?:^|[\\/])rollout-[^\\/\s]{1,200}\.jsonl(?:$|[\s"'`),.;:])/i,
  /(?:^|[\\/])(?:\.codex|codex)[\\/]sessions[\\/]/i,
  /(?:^|[\\/])panefleet-planning[\\/]/i
]);
const OPEN_MARKER = '[PANEFLEET PLANNING RESULT]';
const CLOSE_MARKER = '[/PANEFLEET PLANNING RESULT]';
const MAX_FINAL_ANSWER_BYTES = 256 * 1024;
const MAX_ROLLOUT_WINDOW_BYTES = 2 * 1024 * 1024;
const MAX_JSON_DEPTH = 16;

const MAX = Object.freeze({
  roleText: 1600,
  listItem: 800,
  title: 160,
  path: 512,
  challenges: 40,
  evidence: 40,
  requirements: 80,
  steps: 80,
  criteria: 120,
  list: 100
});

const ROLE_ARTIFACT_KEYS = Object.freeze({
  po: Object.freeze(['user', 'problem', 'outcome', 'value', 'nonGoals', 'assumptions', 'openQuestions']),
  ba: Object.freeze(['requirements', 'dependencies', 'edgeCases', 'constraints', 'openQuestions']),
  dev: Object.freeze(['architecture', 'steps', 'risks', 'rollback', 'openQuestions']),
  qa: Object.freeze(['acceptanceCriteria', 'testStrategy', 'regressionChecks', 'releaseRequired', 'releaseChecks', 'openQuestions'])
});

function reportError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, code) {
  if (!plainObject(value)) throw reportError(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw reportError(code);
  }
}

function persistedJsonBytes(value) {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function assertText(value, code, { required = false, max = MAX.roleText } = {}) {
  if (typeof value !== 'string' || (required && !value) || value.length > max) throw reportError(code);
  if (CONTROL_CHARACTER_PATTERN.test(value)) throw reportError('planning_role_report_control_characters_not_allowed');
}

function assertUniqueTextList(value, code, { maxItems = MAX.list, maxChars = MAX.listItem } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) throw reportError(code);
  const unique = new Set();
  for (const item of value) {
    assertText(item, code, { required: true, max: maxChars });
    if (unique.has(item)) throw reportError(`${code}_duplicate`);
    unique.add(item);
  }
}

function assertIdList(value, code, pattern, maximum = MAX.requirements) {
  assertUniqueTextList(value, code, { maxItems: maximum, maxChars: 44 });
  if (value.some((id) => !pattern.test(id))) throw reportError(code);
}

function assertUniqueObjectsById(value, code, pattern, maximum) {
  if (!Array.isArray(value) || value.length > maximum) throw reportError(code);
  const ids = new Set();
  for (const item of value) {
    if (!plainObject(item) || typeof item.id !== 'string' || !pattern.test(item.id)) throw reportError(code);
    if (ids.has(item.id)) throw reportError(`${code}_duplicate`);
    ids.add(item.id);
  }
}

function assertScopePath(value) {
  assertText(value, 'planning_role_report_scope_path_invalid', { required: true, max: MAX.path });
  const normalized = path.posix.normalize(value);
  const segments = normalized.split('/');
  if (
    value.includes('\\')
    || normalized === '.'
    || normalized !== value
    || path.posix.isAbsolute(normalized)
    || segments.includes('..')
    || segments.includes('.git')
  ) throw reportError('planning_role_report_scope_path_invalid');
}

function validatePoArtifact(artifact) {
  exactKeys(artifact, ROLE_ARTIFACT_KEYS.po, 'planning_role_report_po_artifact_invalid');
  for (const field of ['user', 'problem', 'outcome', 'value']) {
    assertText(artifact[field], `planning_role_report_po_${field}_invalid`);
  }
  for (const field of ['nonGoals', 'assumptions', 'openQuestions']) {
    assertUniqueTextList(artifact[field], `planning_role_report_po_${field}_invalid`);
  }
}

function validateBaArtifact(artifact) {
  exactKeys(artifact, ROLE_ARTIFACT_KEYS.ba, 'planning_role_report_ba_artifact_invalid');
  assertUniqueObjectsById(
    artifact.requirements,
    'planning_role_report_ba_requirements_invalid',
    REQUIREMENT_ID_PATTERN,
    MAX.requirements
  );
  for (const requirement of artifact.requirements) {
    exactKeys(requirement, ['id', 'text'], 'planning_role_report_ba_requirement_invalid');
    assertText(requirement.text, 'planning_role_report_ba_requirement_text_invalid', { required: true, max: MAX.listItem });
  }
  for (const field of ['dependencies', 'edgeCases', 'constraints', 'openQuestions']) {
    assertUniqueTextList(artifact[field], `planning_role_report_ba_${field}_invalid`);
  }
}

function validateDevArtifact(artifact) {
  exactKeys(artifact, ROLE_ARTIFACT_KEYS.dev, 'planning_role_report_dev_artifact_invalid');
  assertText(artifact.architecture, 'planning_role_report_dev_architecture_invalid');
  assertUniqueObjectsById(
    artifact.steps,
    'planning_role_report_dev_steps_invalid',
    STEP_ID_PATTERN,
    MAX.steps
  );
  for (const step of artifact.steps) {
    exactKeys(
      step,
      ['id', 'title', 'outcome', 'requirementIds', 'scopePaths', 'checks'],
      'planning_role_report_dev_step_invalid'
    );
    assertText(step.title, 'planning_role_report_dev_step_title_invalid', { required: true, max: MAX.title });
    assertText(step.outcome, 'planning_role_report_dev_step_outcome_invalid', { required: true, max: MAX.listItem });
    assertIdList(step.requirementIds, 'planning_role_report_dev_requirement_ids_invalid', REQUIREMENT_ID_PATTERN);
    assertUniqueTextList(step.scopePaths, 'planning_role_report_dev_scope_paths_invalid', {
      maxItems: MAX.list,
      maxChars: MAX.path
    });
    step.scopePaths.forEach(assertScopePath);
    assertUniqueTextList(step.checks, 'planning_role_report_dev_checks_invalid');
  }
  assertUniqueTextList(artifact.risks, 'planning_role_report_dev_risks_invalid');
  assertText(artifact.rollback, 'planning_role_report_dev_rollback_invalid');
  assertUniqueTextList(artifact.openQuestions, 'planning_role_report_dev_openQuestions_invalid');
}

function validateQaArtifact(artifact) {
  exactKeys(artifact, ROLE_ARTIFACT_KEYS.qa, 'planning_role_report_qa_artifact_invalid');
  assertUniqueObjectsById(
    artifact.acceptanceCriteria,
    'planning_role_report_qa_acceptance_criteria_invalid',
    ACCEPTANCE_ID_PATTERN,
    MAX.criteria
  );
  for (const criterion of artifact.acceptanceCriteria) {
    exactKeys(criterion, ['id', 'text', 'requirementIds'], 'planning_role_report_qa_acceptance_criterion_invalid');
    assertText(criterion.text, 'planning_role_report_qa_acceptance_text_invalid', { required: true, max: MAX.listItem });
    assertIdList(criterion.requirementIds, 'planning_role_report_qa_requirement_ids_invalid', REQUIREMENT_ID_PATTERN);
  }
  assertText(artifact.testStrategy, 'planning_role_report_qa_test_strategy_invalid');
  assertUniqueTextList(artifact.regressionChecks, 'planning_role_report_qa_regression_checks_invalid');
  if (typeof artifact.releaseRequired !== 'boolean') throw reportError('planning_role_report_qa_release_required_invalid');
  assertUniqueTextList(artifact.releaseChecks, 'planning_role_report_qa_release_checks_invalid');
  assertUniqueTextList(artifact.openQuestions, 'planning_role_report_qa_openQuestions_invalid');
}

function validateArtifact(role, artifact) {
  if (role === 'po') return validatePoArtifact(artifact);
  if (role === 'ba') return validateBaArtifact(artifact);
  if (role === 'dev') return validateDevArtifact(artifact);
  if (role === 'qa') return validateQaArtifact(artifact);
  throw reportError('planning_role_report_role_invalid');
}

function validateEvidence(value) {
  if (!Array.isArray(value) || value.length > MAX.evidence) {
    throw reportError('planning_role_report_evidence_invalid');
  }
  const summaries = new Set();
  for (const evidence of value) {
    exactKeys(evidence, ['summary', 'trusted'], 'planning_role_report_evidence_item_invalid');
    assertText(evidence.summary, 'planning_role_report_evidence_summary_invalid', {
      required: true,
      max: MAX.listItem
    });
    if (evidence.trusted !== false) throw reportError('planning_role_report_evidence_trust_invalid');
    if (summaries.has(evidence.summary)) throw reportError('planning_role_report_evidence_duplicate');
    summaries.add(evidence.summary);
  }
}

function assertNoPrivatePlanningText(value) {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (PRIVATE_PLANNING_TEXT_PATTERNS.some((pattern) => pattern.test(current))) {
        throw reportError('planning_role_report_private_identity_not_allowed');
      }
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (plainObject(current)) pending.push(...Object.values(current));
  }
}

function validateExpected(report, expected) {
  if (expected === undefined || expected === null) return;
  if (!plainObject(expected) || Object.keys(expected).some((key) => !EXPECTED_KEYS.has(key))) {
    throw reportError('planning_role_report_expected_invalid');
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (report[field] !== expectedValue) {
      throw reportError(`planning_role_report_${EXPECTED_ERROR_FIELDS[field]}_mismatch`);
    }
  }
}

export function validatePlanningRoleReport(value, expected = null) {
  exactKeys(value, REPORT_KEYS, 'planning_role_report_shape_invalid');
  if (value.version !== PLANNING_ROLE_REPORT_VERSION) throw reportError('planning_role_report_version_unsupported');
  if (typeof value.runId !== 'string' || !RUN_ID_PATTERN.test(value.runId)) throw reportError('planning_role_report_run_id_invalid');
  if (typeof value.planId !== 'string' || !PLAN_ID_PATTERN.test(value.planId)) throw reportError('planning_role_report_plan_id_invalid');
  if (!Number.isSafeInteger(value.planRevision) || value.planRevision < 1) throw reportError('planning_role_report_plan_revision_invalid');
  if (typeof value.role !== 'string' || !ROLE_SET.has(value.role)) throw reportError('planning_role_report_role_invalid');
  if (typeof value.attemptId !== 'string' || !ATTEMPT_ID_PATTERN.test(value.attemptId)) {
    throw reportError('planning_role_report_attempt_id_invalid');
  }
  if (typeof value.inputDigest !== 'string' || !DIGEST_PATTERN.test(value.inputDigest)) {
    throw reportError('planning_role_report_input_digest_invalid');
  }
  if (typeof value.status !== 'string' || !STATUS_SET.has(value.status)) throw reportError('planning_role_report_status_invalid');
  validateArtifact(value.role, value.artifact);
  assertUniqueTextList(value.challenges, 'planning_role_report_challenges_invalid', {
    maxItems: MAX.challenges,
    maxChars: MAX.listItem
  });
  validateEvidence(value.evidence);
  // Binding fields identify the report itself. Worker-authored content must not
  // copy PaneFleet's private prompt, session, scope, or rollout identities into
  // a persisted artifact or candidate.
  assertNoPrivatePlanningText(value.artifact);
  assertNoPrivatePlanningText(value.challenges);
  assertNoPrivatePlanningText(value.evidence);
  validateExpected(value, expected);
  if (persistedJsonBytes(value) > PLANNING_ROLE_REPORT_MAX_PERSISTED_BYTES) {
    throw reportError('planning_role_report_persisted_size_exceeded');
  }
  return structuredClone(value);
}

function strictJsonParse(text) {
  let offset = 0;

  function invalid(code = 'planning_role_report_json_invalid') {
    throw reportError(code, { offset });
  }

  function whitespace() {
    while (offset < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[offset])) offset += 1;
  }

  function string() {
    if (text[offset] !== '"') invalid();
    const start = offset;
    offset += 1;
    let escaped = false;
    while (offset < text.length) {
      const character = text[offset];
      if (!escaped && character === '"') {
        offset += 1;
        try {
          return JSON.parse(text.slice(start, offset));
        } catch {
          invalid();
        }
      }
      if (!escaped && character.charCodeAt(0) < 0x20) invalid();
      if (!escaped && character === '\\') escaped = true;
      else escaped = false;
      offset += 1;
    }
    invalid();
  }

  function number() {
    const match = text.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) invalid();
    offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) invalid();
    return value;
  }

  function value(depth) {
    if (depth > MAX_JSON_DEPTH) invalid('planning_role_report_json_depth_exceeded');
    whitespace();
    const character = text[offset];
    if (character === '"') return string();
    if (character === '{') return object(depth + 1);
    if (character === '[') return array(depth + 1);
    for (const [keyword, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(keyword, offset)) {
        offset += keyword.length;
        return parsed;
      }
    }
    return number();
  }

  function object(depth) {
    const result = Object.create(null);
    const keys = new Set();
    offset += 1;
    whitespace();
    if (text[offset] === '}') {
      offset += 1;
      return result;
    }
    while (offset < text.length) {
      whitespace();
      const key = string();
      if (keys.has(key)) invalid('planning_role_report_json_duplicate_key');
      keys.add(key);
      whitespace();
      if (text[offset] !== ':') invalid();
      offset += 1;
      result[key] = value(depth);
      whitespace();
      if (text[offset] === '}') {
        offset += 1;
        return result;
      }
      if (text[offset] !== ',') invalid();
      offset += 1;
    }
    invalid();
  }

  function array(depth) {
    const result = [];
    offset += 1;
    whitespace();
    if (text[offset] === ']') {
      offset += 1;
      return result;
    }
    while (offset < text.length) {
      result.push(value(depth));
      whitespace();
      if (text[offset] === ']') {
        offset += 1;
        return result;
      }
      if (text[offset] !== ',') invalid();
      offset += 1;
    }
    invalid();
  }

  const result = value(0);
  whitespace();
  if (offset !== text.length) invalid();
  return result;
}

export function parsePlanningRoleReport(text, expected = null) {
  if (typeof text !== 'string') throw reportError('planning_role_report_text_invalid');
  if (Buffer.byteLength(text, 'utf8') > MAX_FINAL_ANSWER_BYTES) {
    throw reportError('planning_role_report_size_exceeded');
  }
  const prefix = `${OPEN_MARKER}\n`;
  const suffix = `\n${CLOSE_MARKER}`;
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) {
    throw reportError('planning_role_report_boundary_invalid');
  }
  if (text.split(OPEN_MARKER).length !== 2 || text.split(CLOSE_MARKER).length !== 2) {
    throw reportError('planning_role_report_boundary_ambiguous');
  }
  const jsonText = text.slice(prefix.length, -suffix.length);
  if (!jsonText || jsonText[0] !== '{') throw reportError('planning_role_report_json_invalid');
  return validatePlanningRoleReport(strictJsonParse(jsonText), expected);
}

export function planningRoleReportOutputDigest(value) {
  return canonicalSha256(validatePlanningRoleReport(value));
}

function assertPlanningAuthority(final, requiredAuthority) {
  if (requiredAuthority === false) return;
  const required = requiredAuthority === undefined || requiredAuthority === null
    ? { sandbox: 'read-only', approvalPolicy: 'never', networkAccess: false, allowUnobservedNetwork: true }
    : requiredAuthority;
  const requiredKeys = Object.keys(required).sort();
  const validRequiredKeys = [
    ['approvalPolicy', 'networkAccess', 'sandbox'],
    ['allowUnobservedNetwork', 'approvalPolicy', 'networkAccess', 'sandbox']
  ].some((keys) => keys.length === requiredKeys.length && keys.every((key, index) => key === requiredKeys[index]));
  if (!validRequiredKeys) throw reportError('planning_role_report_required_authority_invalid');
  const allowUnobservedNetwork = required.allowUnobservedNetwork === true;
  if (
    typeof required.sandbox !== 'string'
    || typeof required.approvalPolicy !== 'string'
    || typeof required.networkAccess !== 'boolean'
    || (required.allowUnobservedNetwork !== undefined && typeof required.allowUnobservedNetwork !== 'boolean')
  ) throw reportError('planning_role_report_required_authority_invalid');
  if (
    !final.authority.sandboxObserved
    || !final.authority.approvalPolicyObserved
    || final.sandbox !== required.sandbox
    || final.approvalPolicy !== required.approvalPolicy
    || (final.authority.networkAccessObserved
      ? final.networkAccess !== required.networkAccess
      : !allowUnobservedNetwork)
  ) throw reportError('planning_role_report_authority_mismatch');
}

export async function readCodexPlanningRoleReport(filePath, {
  confirmationMarker,
  submittedAt,
  startOffset,
  maximumBytes = MAX_ROLLOUT_WINDOW_BYTES,
  expected = null,
  requiredAuthority
} = {}) {
  const marker = String(confirmationMarker || '');
  const markerMatch = marker.match(/^\[PaneFleet Planning Dispatch (planning-attempt-[a-z0-9][a-z0-9-]{7,63})\]$/);
  if (!markerMatch) return null;
  const effectiveExpected = expected === null || expected === undefined
    ? { attemptId: markerMatch[1] }
    : { ...expected, attemptId: expected.attemptId ?? markerMatch[1] };
  if (effectiveExpected.attemptId !== markerMatch[1]) {
    throw reportError('planning_role_report_attempt_id_mismatch');
  }
  const final = await readCodexFinalAnswer(filePath, {
    confirmationMarker: marker,
    confirmationMarkerPattern: /^\[PaneFleet Planning Dispatch planning-attempt-[a-z0-9][a-z0-9-]{7,63}\]$/,
    submittedAt,
    startOffset,
    maximumBytes,
    maximumWindowBytes: MAX_ROLLOUT_WINDOW_BYTES,
    errorPrefix: 'codex_planning_role_report',
    resultLabel: 'Codex rollout planning-role report',
    changingLabel: 'Codex rollout',
    rangeLabel: 'planning-role report',
    requireSingleFinalAnswer: true
  });
  if (!final) return null;
  assertPlanningAuthority(final, requiredAuthority);
  const report = parsePlanningRoleReport(final.text, effectiveExpected);
  return {
    report,
    outputDigest: planningRoleReportOutputDigest(report),
    completedAt: final.at,
    authority: {
      sandbox: final.sandbox,
      approvalPolicy: final.approvalPolicy,
      networkAccess: final.networkAccess,
      networkAccessObserved: final.networkAccessObserved,
      ...final.authority
    }
  };
}
