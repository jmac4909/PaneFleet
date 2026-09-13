import { createHash } from 'node:crypto';
import path from 'node:path';

import { canonicalSha256 } from './delivery-plan.js';
import {
  WORKSPACE_BASELINE_VERSION,
  validateWorkspaceGitMetadata
} from './workspace-baseline.js';

export const DELIVERY_RUN_VERSION = 1;
export const DELIVERY_RUN_BASELINE_VERSION = WORKSPACE_BASELINE_VERSION;
export const DELIVERY_RUN_CONDITIONS = Object.freeze([
  'preparing',
  'active',
  'awaiting_verification',
  'blocked',
  'off_course',
  'reconcile_required',
  'aborted',
  'verified'
]);
export const DELIVERY_RUN_DELIVERY_LEVELS = Object.freeze([
  'planned',
  'implemented_locally',
  'verified_locally'
]);

const CONDITION_SET = new Set(DELIVERY_RUN_CONDITIONS);
const ABORTABLE_CONDITION_SET = new Set(DELIVERY_RUN_CONDITIONS.filter((condition) => (
  !['aborted', 'verified'].includes(condition)
)));
const DELIVERY_LEVEL_SET = new Set(DELIVERY_RUN_DELIVERY_LEVELS);
const TASK_STATE_SET = new Set([
  'pending',
  'mission_linked',
  'implementation_captured',
  'verified',
  'failed',
  'off_course',
  'reconcile_required',
  'aborted'
]);
const OUTBOX_STATE_SET = new Set(['held', 'pending', 'applied', 'reconcile_required', 'blocked', 'canceled']);
const EVIDENCE_TYPE_SET = new Set(['baseline', 'diff', 'command', 'test', 'review']);
const EVIDENCE_OUTCOME_SET = new Set(['applied', 'passed', 'failed', 'outcome_unknown']);
const CRITERION_OUTCOME_SET = new Set(['passed', 'failed', 'not_run']);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^run-[a-z0-9][a-z0-9-]{7,63}$/;
const PLAN_ID_PATTERN = /^plan-[a-z0-9][a-z0-9-]{7,63}$/;
const STEP_ID_PATTERN = /^STEP-[A-Z0-9][A-Z0-9_-]{0,39}$/;
const ACCEPTANCE_ID_PATTERN = /^AC-[A-Z0-9][A-Z0-9_-]{0,39}$/;
const EVIDENCE_ID_PATTERN = /^EVD-[A-Z0-9][A-Z0-9_-]{2,63}$/;
const VERIFICATION_ID_PATTERN = /^verification-[a-z0-9][a-z0-9-]{7,63}$/;
const MISSION_ID_PATTERN = /^mission-[a-z0-9-]{8,64}$/;
const OUTBOX_ID_PATTERN = /^outbox-[a-f0-9]{32}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const MAX = Object.freeze({
  workspace: 4096,
  paths: 100,
  path: 512,
  tasks: 80,
  acceptanceIds: 120,
  evidence: 512,
  verifications: 120,
  criteria: 120,
  evidenceRefs: 128,
  baselineEntries: 1000,
  approvedScopes: 128,
  instructions: 32,
  producer: 160,
  summary: 800,
  contentRef: 512,
  blocker: 800,
  error: 500
});

function runError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, code) {
  if (!plainObject(value)) throw runError(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw runError(code);
  }
}

function text(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

function inline(value) {
  return text(value).replace(/\s+/g, ' ');
}

function assertText(value, code, { required = true, max = MAX.summary } = {}) {
  if (typeof value !== 'string' || (required && !value) || value.length > max) throw runError(code);
  if (CONTROL_CHARACTER_PATTERN.test(value)) throw runError('delivery_run_control_characters_not_allowed');
}

function validTimestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return typeof value === 'string'
    && value.length > 0
    && Number.isFinite(parsed)
    && value === new Date(parsed).toISOString();
}

function timestamp(value) {
  const normalized = value instanceof Date ? value.toISOString() : inline(value);
  if (!validTimestamp(normalized)) throw runError('delivery_run_timestamp_invalid');
  return normalized;
}

function assertDigest(value, code) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) throw runError(code);
}

function uniqueStrings(values, pattern, code, { maxItems = MAX.evidenceRefs } = {}) {
  if (!Array.isArray(values) || values.length > maxItems) throw runError(code);
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !pattern.test(value) || seen.has(value)) throw runError(code);
    seen.add(value);
  }
  return seen;
}

function normalizedUniqueIds(values, pattern, code, { maxItems = MAX.evidenceRefs } = {}) {
  if (!Array.isArray(values) || values.length > maxItems) throw runError(code);
  const result = [];
  for (const value of values) {
    const normalized = inline(value).toUpperCase();
    if (!pattern.test(normalized)) throw runError(code);
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function normalizedScopePath(value) {
  const candidate = inline(value).replaceAll('\\', '/');
  assertText(candidate, 'delivery_run_allowed_path_invalid', { max: MAX.path });
  const normalized = path.posix.normalize(candidate);
  const segments = normalized.split('/');
  if (
    !candidate ||
    normalized === '.' ||
    normalized !== candidate ||
    path.posix.isAbsolute(normalized) ||
    segments.includes('..') ||
    segments.includes('.git')
  ) throw runError('delivery_run_allowed_path_invalid');
  return normalized;
}

function normalizedScopePaths(values) {
  if (!Array.isArray(values) || !values.length || values.length > MAX.paths) {
    throw runError('delivery_run_allowed_paths_invalid');
  }
  const result = [];
  for (const value of values) {
    const normalized = normalizedScopePath(value);
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function sha256Text(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizedApprovedScope(value) {
  const candidate = String(value ?? '');
  const normalized = candidate.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized.split('/').some((part) => part === '..' || part === '.git')
  ) throw runError('delivery_run_baseline_scope_invalid');
  if (candidate !== normalized) throw runError('delivery_run_baseline_approved_scope_not_canonical');
  return normalized;
}

function normalizedApprovedScopes(values) {
  if (!Array.isArray(values) || values.length > MAX.approvedScopes) {
    throw runError('delivery_run_baseline_approved_scopes_invalid');
  }
  const scopes = values.map(normalizedApprovedScope);
  if (new Set(scopes).size !== scopes.length) {
    throw runError('delivery_run_baseline_approved_scope_duplicate');
  }
  const sorted = [...scopes].sort();
  if (sorted.some((scope, index) => scope !== scopes[index])) {
    throw runError('delivery_run_baseline_approved_scopes_not_sorted');
  }
  return scopes;
}

function normalizedGitMetadata(value, expected) {
  let metadata;
  try {
    metadata = validateWorkspaceGitMetadata(value, expected);
  } catch (cause) {
    const sourceCode = String(cause?.code || '');
    const suffix = sourceCode.startsWith('workspace_baseline_')
      ? sourceCode.slice('workspace_baseline_'.length)
      : 'git_metadata_invalid';
    throw runError(`delivery_run_baseline_${suffix}`);
  }
  if (metadata.sparseCheckout || metadata.sparseIndex) {
    throw runError('delivery_run_baseline_git_sparse_state_rejected');
  }
  return metadata;
}

function baselineDefinition(value) {
  return {
    version: value.version,
    workspace: value.workspace,
    repoRoot: value.repoRoot,
    workspacePrefix: value.workspacePrefix,
    head: value.head,
    branch: value.branch,
    detached: value.detached,
    workingTreeDigest: value.workingTreeDigest,
    instructionsDigest: value.instructionsDigest,
    manifestDigest: value.manifestDigest,
    statusDigest: value.statusDigest,
    indexDigest: value.indexDigest,
    indexFlagsDigest: value.indexFlagsDigest,
    gitMetadata: value.gitMetadata,
    gitMetadataDigest: value.gitMetadataDigest,
    approvedScopes: value.approvedScopes,
    ignoredScopeDigest: value.ignoredScopeDigest,
    entries: value.entries,
    instructions: value.instructions
  };
}

function normalizedRepoPath(value, code, { allowEmpty = false } = {}) {
  const candidate = String(value ?? '').replaceAll('\\', '/');
  if (allowEmpty && !candidate) return '';
  if (
    !candidate ||
    candidate.includes('\0') ||
    candidate.includes('\uFFFD') ||
    path.posix.isAbsolute(candidate) ||
    candidate.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) throw runError(code);
  return candidate;
}

function normalizedBaselineEntry(value) {
  exactKeys(value, ['status', 'path', 'originalPath', 'type', 'size', 'sha256'], 'delivery_run_baseline_entry_invalid');
  const entry = {
    status: String(value.status ?? ''),
    path: normalizedRepoPath(value.path, 'delivery_run_baseline_entry_invalid'),
    originalPath: normalizedRepoPath(value.originalPath, 'delivery_run_baseline_entry_invalid', { allowEmpty: true }),
    type: inline(value.type).toLowerCase(),
    size: Number(value.size),
    sha256: inline(value.sha256).toLowerCase()
  };
  if (
    !/^[ MADRCUT?!]{2}$/.test(entry.status) ||
    !['file', 'missing', 'symlink'].includes(entry.type) ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    !DIGEST_PATTERN.test(entry.sha256)
  ) throw runError('delivery_run_baseline_entry_invalid');
  return entry;
}

function normalizedInstruction(value) {
  exactKeys(value, ['path', 'size', 'sha256'], 'delivery_run_baseline_instruction_invalid');
  const instruction = {
    path: String(value.path ?? '').replaceAll('\\', '/'),
    size: Number(value.size),
    sha256: String(value.sha256 ?? '')
  };
  if (
    !instruction.path ||
    instruction.path.includes('\0') ||
    instruction.path.includes('\uFFFD') ||
    !Number.isSafeInteger(instruction.size) ||
    instruction.size < 0 ||
    !DIGEST_PATTERN.test(instruction.sha256)
  ) {
    throw runError('delivery_run_baseline_instruction_invalid');
  }
  return instruction;
}

function expectedWorkspacePrefix(repoRoot, workspace) {
  const relative = path.relative(repoRoot, workspace);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw runError('delivery_run_baseline_workspace_invalid');
  }
  return relative.split(path.sep).filter(Boolean).join('/');
}

function validateBaselineDigests(baseline) {
  const gitMetadataDigest = canonicalSha256(baseline.gitMetadata);
  const instructionsDigest = canonicalSha256(baseline.instructions);
  const statusDigest = canonicalSha256(baseline.entries.map((entry) => ({
    status: entry.status,
    path: entry.path,
    originalPath: entry.originalPath
  })));
  const ignoredScopeDigest = canonicalSha256({
    approvedScopes: baseline.approvedScopes,
    outputDigest: sha256Text('')
  });
  const workingTreeDigest = canonicalSha256({
    statusDigest: baseline.statusDigest,
    indexDigest: baseline.indexDigest,
    indexFlagsDigest: baseline.indexFlagsDigest,
    gitMetadataDigest: baseline.gitMetadataDigest,
    entries: baseline.entries
  });
  const manifestDigest = canonicalSha256({
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
  if (baseline.gitMetadataDigest !== gitMetadataDigest) throw runError('delivery_run_baseline_git_metadata_mismatch');
  if (baseline.instructionsDigest !== instructionsDigest) throw runError('delivery_run_baseline_instructions_mismatch');
  if (baseline.statusDigest !== statusDigest) throw runError('delivery_run_baseline_status_mismatch');
  if (baseline.ignoredScopeDigest !== ignoredScopeDigest) throw runError('delivery_run_baseline_ignored_scope_mismatch');
  if (baseline.workingTreeDigest !== workingTreeDigest) throw runError('delivery_run_baseline_worktree_mismatch');
  if (baseline.manifestDigest !== manifestDigest) throw runError('delivery_run_baseline_manifest_mismatch');
}

export function workspaceBaselineDigest(value) {
  const source = plainObject(value) ? value : {};
  return canonicalSha256(baselineDefinition(source));
}

export function createWorkspaceBaseline(value) {
  const inputKeys = [
    'version',
    'workspace',
    'repoRoot',
    'workspacePrefix',
    'head',
    'branch',
    'detached',
    'workingTreeDigest',
    'instructionsDigest',
    'manifestDigest',
    'statusDigest',
    'indexDigest',
    'indexFlagsDigest',
    'gitMetadata',
    'gitMetadataDigest',
    'approvedScopes',
    'ignoredScopeDigest',
    'entries',
    'instructions',
    'capturedAt'
  ];
  const hasDigest = plainObject(value) && Object.hasOwn(value, 'digest');
  exactKeys(value, hasDigest ? [...inputKeys, 'digest'] : inputKeys, 'delivery_run_baseline_input_invalid');
  const workspace = path.normalize(String(value.workspace ?? ''));
  const repoRoot = path.normalize(String(value.repoRoot ?? ''));
  if (
    !path.isAbsolute(workspace) ||
    !path.isAbsolute(repoRoot) ||
    workspace !== value.workspace ||
    repoRoot !== value.repoRoot ||
    workspace.length > MAX.workspace ||
    repoRoot.length > MAX.workspace
  ) throw runError('delivery_run_baseline_workspace_invalid');
  if (!Array.isArray(value.entries) || value.entries.length > MAX.baselineEntries) {
    throw runError('delivery_run_baseline_entries_invalid');
  }
  if (!Array.isArray(value.instructions) || value.instructions.length > MAX.instructions) {
    throw runError('delivery_run_baseline_instructions_invalid');
  }
  const entries = value.entries.map(normalizedBaselineEntry)
    .sort((left, right) => left.path.localeCompare(right.path) || left.originalPath.localeCompare(right.originalPath));
  const instructions = value.instructions.map(normalizedInstruction)
    .sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) throw runError('delivery_run_baseline_entry_duplicate');
  if (new Set(instructions.map((instruction) => instruction.path)).size !== instructions.length) {
    throw runError('delivery_run_baseline_instruction_duplicate');
  }
  const head = inline(value.head).toLowerCase();
  const branch = inline(value.branch);
  const detached = value.detached;
  if (head !== 'unborn' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) {
    throw runError('delivery_run_baseline_head_invalid');
  }
  assertText(branch, 'delivery_run_baseline_branch_invalid', { required: false, max: 256 });
  if (typeof detached !== 'boolean') throw runError('delivery_run_baseline_detached_invalid');
  const gitMetadata = normalizedGitMetadata(value.gitMetadata, { repoRoot, head, branch, detached });
  const approvedScopes = normalizedApprovedScopes(value.approvedScopes);
  const baseline = {
    version: Number(value.version),
    workspace,
    repoRoot,
    workspacePrefix: normalizedRepoPath(
      value.workspacePrefix,
      'delivery_run_baseline_workspace_prefix_invalid',
      { allowEmpty: true }
    ),
    digest: '',
    head,
    branch,
    detached,
    workingTreeDigest: inline(value.workingTreeDigest).toLowerCase(),
    instructionsDigest: inline(value.instructionsDigest).toLowerCase(),
    manifestDigest: inline(value.manifestDigest).toLowerCase(),
    statusDigest: inline(value.statusDigest).toLowerCase(),
    indexDigest: inline(value.indexDigest).toLowerCase(),
    indexFlagsDigest: inline(value.indexFlagsDigest).toLowerCase(),
    gitMetadata,
    gitMetadataDigest: inline(value.gitMetadataDigest).toLowerCase(),
    approvedScopes,
    ignoredScopeDigest: inline(value.ignoredScopeDigest).toLowerCase(),
    entries,
    instructions,
    capturedAt: timestamp(value.capturedAt)
  };
  if (baseline.workspacePrefix !== expectedWorkspacePrefix(repoRoot, workspace)) {
    throw runError('delivery_run_baseline_workspace_prefix_invalid');
  }
  baseline.digest = workspaceBaselineDigest(baseline);
  if (hasDigest && inline(value.digest).toLowerCase() !== baseline.digest) {
    throw runError('delivery_run_baseline_digest_mismatch');
  }
  return validateWorkspaceBaseline(baseline);
}

export function validateWorkspaceBaseline(value) {
  exactKeys(
    value,
    [
      'version',
      'workspace',
      'repoRoot',
      'workspacePrefix',
      'digest',
      'head',
      'branch',
      'detached',
      'workingTreeDigest',
      'instructionsDigest',
      'manifestDigest',
      'statusDigest',
      'indexDigest',
      'indexFlagsDigest',
      'gitMetadata',
      'gitMetadataDigest',
      'approvedScopes',
      'ignoredScopeDigest',
      'entries',
      'instructions',
      'capturedAt'
    ],
    'delivery_run_baseline_invalid'
  );
  if (value.version !== DELIVERY_RUN_BASELINE_VERSION) throw runError('delivery_run_baseline_version_unsupported');
  if (
    !path.isAbsolute(value.workspace) ||
    !path.isAbsolute(value.repoRoot) ||
    path.normalize(value.workspace) !== value.workspace ||
    path.normalize(value.repoRoot) !== value.repoRoot ||
    expectedWorkspacePrefix(value.repoRoot, value.workspace) !== value.workspacePrefix
  ) throw runError('delivery_run_baseline_workspace_invalid');
  if (value.head !== 'unborn' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.head)) {
    throw runError('delivery_run_baseline_head_invalid');
  }
  assertText(value.branch, 'delivery_run_baseline_branch_invalid', { required: false, max: 256 });
  if (typeof value.detached !== 'boolean') throw runError('delivery_run_baseline_detached_invalid');
  const gitMetadata = normalizedGitMetadata(value.gitMetadata, {
    repoRoot: value.repoRoot,
    head: value.head,
    branch: value.branch,
    detached: value.detached
  });
  if (canonicalSha256(gitMetadata) !== canonicalSha256(value.gitMetadata)) {
    throw runError('delivery_run_baseline_git_metadata_invalid');
  }
  normalizedApprovedScopes(value.approvedScopes);
  for (const field of [
    'workingTreeDigest',
    'instructionsDigest',
    'manifestDigest',
    'statusDigest',
    'indexDigest',
    'indexFlagsDigest',
    'gitMetadataDigest',
    'ignoredScopeDigest'
  ]) {
    assertDigest(value[field], 'delivery_run_baseline_digest_invalid');
  }
  if (!Array.isArray(value.entries) || value.entries.length > MAX.baselineEntries) {
    throw runError('delivery_run_baseline_entries_invalid');
  }
  if (!Array.isArray(value.instructions) || value.instructions.length > MAX.instructions) {
    throw runError('delivery_run_baseline_instructions_invalid');
  }
  const normalizedEntries = value.entries.map(normalizedBaselineEntry)
    .sort((left, right) => left.path.localeCompare(right.path) || left.originalPath.localeCompare(right.originalPath));
  const normalizedInstructions = value.instructions.map(normalizedInstruction)
    .sort((left, right) => left.path.localeCompare(right.path));
  if (canonicalSha256(normalizedEntries) !== canonicalSha256(value.entries)) throw runError('delivery_run_baseline_entries_unsorted');
  if (canonicalSha256(normalizedInstructions) !== canonicalSha256(value.instructions)) {
    throw runError('delivery_run_baseline_instructions_unsorted');
  }
  if (new Set(value.entries.map((entry) => entry.path)).size !== value.entries.length) {
    throw runError('delivery_run_baseline_entry_duplicate');
  }
  if (new Set(value.instructions.map((instruction) => instruction.path)).size !== value.instructions.length) {
    throw runError('delivery_run_baseline_instruction_duplicate');
  }
  validateBaselineDigests(value);
  if (!validTimestamp(value.capturedAt)) throw runError('delivery_run_baseline_timestamp_invalid');
  assertDigest(value.digest, 'delivery_run_baseline_digest_invalid');
  if (workspaceBaselineDigest(value) !== value.digest) throw runError('delivery_run_baseline_digest_mismatch');
  return structuredClone(value);
}

export function deliveryRunMissionBindingKey({ runId, planId, planDigest, stepId }) {
  return canonicalSha256({
    version: DELIVERY_RUN_VERSION,
    role: 'implementation',
    runId,
    planId,
    planDigest,
    stepId
  });
}

function createEvidence(value) {
  exactKeys(
    value,
    ['id', 'type', 'producer', 'outcome', 'summary', 'contentRef', 'contentSha256', 'createdAt'],
    'delivery_run_evidence_input_invalid'
  );
  return validateEvidence({
    id: inline(value.id).toUpperCase(),
    type: inline(value.type).toLowerCase(),
    producer: inline(value.producer),
    outcome: inline(value.outcome).toLowerCase(),
    summary: text(value.summary),
    contentRef: inline(value.contentRef),
    contentSha256: inline(value.contentSha256).toLowerCase(),
    createdAt: timestamp(value.createdAt)
  });
}

function validateEvidence(value) {
  exactKeys(
    value,
    ['id', 'type', 'producer', 'outcome', 'summary', 'contentRef', 'contentSha256', 'createdAt'],
    'delivery_run_evidence_invalid'
  );
  if (!EVIDENCE_ID_PATTERN.test(value.id) || !EVIDENCE_TYPE_SET.has(value.type) || !EVIDENCE_OUTCOME_SET.has(value.outcome)) {
    throw runError('delivery_run_evidence_invalid');
  }
  assertText(value.producer, 'delivery_run_evidence_invalid', { max: MAX.producer });
  assertText(value.summary, 'delivery_run_evidence_invalid', { max: MAX.summary });
  assertText(value.contentRef, 'delivery_run_evidence_invalid', { required: false, max: MAX.contentRef });
  if (Boolean(value.contentRef) !== Boolean(value.contentSha256)) throw runError('delivery_run_evidence_content_invalid');
  if (value.contentSha256) assertDigest(value.contentSha256, 'delivery_run_evidence_content_invalid');
  if (!validTimestamp(value.createdAt)) throw runError('delivery_run_evidence_invalid');
  return structuredClone(value);
}

function createTask(value, context, sequence) {
  exactKeys(
    value,
    ['stepId', 'stepDigest', 'acceptanceIds', 'allowedPaths', 'missionDefinitionDigest'],
    'delivery_run_task_input_invalid'
  );
  const stepId = inline(value.stepId).toUpperCase();
  if (!STEP_ID_PATTERN.test(stepId)) throw runError('delivery_run_step_id_invalid');
  const stepDigest = inline(value.stepDigest).toLowerCase();
  const missionDefinitionDigest = inline(value.missionDefinitionDigest).toLowerCase();
  assertDigest(stepDigest, 'delivery_run_step_digest_invalid');
  assertDigest(missionDefinitionDigest, 'delivery_run_mission_definition_digest_invalid');
  const acceptanceIds = normalizedUniqueIds(
    value.acceptanceIds,
    ACCEPTANCE_ID_PATTERN,
    'delivery_run_task_acceptance_ids_invalid',
    { maxItems: MAX.acceptanceIds }
  );
  if (!acceptanceIds.length) throw runError('delivery_run_task_acceptance_ids_invalid');
  const bindingKey = deliveryRunMissionBindingKey({ ...context, stepId });
  return {
    stepId,
    sequence,
    stepDigest,
    acceptanceIds,
    allowedPaths: normalizedScopePaths(value.allowedPaths),
    expectedBaselineDigest: sequence === 0 ? context.startBaselineDigest : '',
    state: 'pending',
    missionBindingKey: bindingKey,
    missionDefinitionDigest,
    missionId: null,
    implementation: { baseline: null, evidenceIds: [], capturedAt: null },
    verificationId: null
  };
}

function createOutbox(task, at) {
  return {
    id: `outbox-${task.missionBindingKey.slice(0, 32)}`,
    kind: 'mission.ensure',
    stepId: task.stepId,
    bindingKey: task.missionBindingKey,
    payloadDigest: task.missionDefinitionDigest,
    state: task.sequence === 0 ? 'pending' : 'held',
    missionId: null,
    error: '',
    updatedAt: at
  };
}

function expectedDeliveryLevel(run) {
  if (run.tasks.every((task) => task.state === 'verified')) return 'verified_locally';
  if (run.tasks.some((task) => task.implementation.baseline !== null)) return 'implemented_locally';
  return 'planned';
}

function validateTask(task, run, evidenceIds, verificationIds) {
  exactKeys(task, [
    'stepId',
    'sequence',
    'stepDigest',
    'acceptanceIds',
    'allowedPaths',
    'expectedBaselineDigest',
    'state',
    'missionBindingKey',
    'missionDefinitionDigest',
    'missionId',
    'implementation',
    'verificationId'
  ], 'delivery_run_task_invalid');
  if (!STEP_ID_PATTERN.test(task.stepId) || !Number.isSafeInteger(task.sequence) || task.sequence < 0) {
    throw runError('delivery_run_task_invalid');
  }
  assertDigest(task.stepDigest, 'delivery_run_task_invalid');
  const acceptanceIds = uniqueStrings(
    task.acceptanceIds,
    ACCEPTANCE_ID_PATTERN,
    'delivery_run_task_invalid',
    { maxItems: MAX.acceptanceIds }
  );
  if (!acceptanceIds.size) throw runError('delivery_run_task_invalid');
  if (!Array.isArray(task.allowedPaths) || !task.allowedPaths.length || task.allowedPaths.length > MAX.paths) {
    throw runError('delivery_run_task_invalid');
  }
  const paths = new Set();
  for (const scopePath of task.allowedPaths) {
    if (normalizedScopePath(scopePath) !== scopePath || paths.has(scopePath)) throw runError('delivery_run_task_invalid');
    paths.add(scopePath);
  }
  if (task.expectedBaselineDigest) assertDigest(task.expectedBaselineDigest, 'delivery_run_task_invalid');
  if (!TASK_STATE_SET.has(task.state)) throw runError('delivery_run_task_invalid');
  const expectedBinding = deliveryRunMissionBindingKey({
    runId: run.id,
    planId: run.planId,
    planDigest: run.planDigest,
    stepId: task.stepId
  });
  if (task.missionBindingKey !== expectedBinding) throw runError('delivery_run_task_binding_invalid');
  assertDigest(task.missionDefinitionDigest, 'delivery_run_task_invalid');
  if (task.missionId !== null && !MISSION_ID_PATTERN.test(task.missionId)) throw runError('delivery_run_task_mission_invalid');
  exactKeys(task.implementation, ['baseline', 'evidenceIds', 'capturedAt'], 'delivery_run_implementation_invalid');
  uniqueStrings(task.implementation.evidenceIds, EVIDENCE_ID_PATTERN, 'delivery_run_implementation_invalid');
  for (const id of task.implementation.evidenceIds) {
    if (!evidenceIds.has(id)) throw runError('delivery_run_evidence_reference_unknown');
  }
  if (task.implementation.baseline === null) {
    if (task.implementation.evidenceIds.length || task.implementation.capturedAt !== null) {
      throw runError('delivery_run_implementation_invalid');
    }
  } else {
    validateWorkspaceBaseline(task.implementation.baseline);
    if (
      task.implementation.baseline.workspace !== run.startBaseline.workspace ||
      task.implementation.baseline.repoRoot !== run.startBaseline.repoRoot ||
      task.implementation.baseline.workspacePrefix !== run.startBaseline.workspacePrefix
    ) throw runError('delivery_run_implementation_baseline_identity_changed');
    if (!validTimestamp(task.implementation.capturedAt)) throw runError('delivery_run_implementation_invalid');
    if (task.implementation.capturedAt !== task.implementation.baseline.capturedAt) {
      throw runError('delivery_run_implementation_invalid');
    }
  }
  if (task.verificationId !== null && !VERIFICATION_ID_PATTERN.test(task.verificationId)) {
    throw runError('delivery_run_task_verification_invalid');
  }
  if (task.verificationId !== null && !verificationIds.has(task.verificationId)) {
    throw runError('delivery_run_task_verification_invalid');
  }
  if (['mission_linked', 'implementation_captured', 'verified', 'failed'].includes(task.state) && !task.missionId) {
    throw runError('delivery_run_task_lifecycle_invalid');
  }
  if (['implementation_captured', 'verified', 'failed'].includes(task.state) && !task.implementation.baseline) {
    throw runError('delivery_run_task_lifecycle_invalid');
  }
  if (['verified', 'failed'].includes(task.state) && !task.verificationId) {
    throw runError('delivery_run_task_lifecycle_invalid');
  }
}

function validateOutbox(item, task) {
  exactKeys(item, [
    'id', 'kind', 'stepId', 'bindingKey', 'payloadDigest', 'state', 'missionId', 'error', 'updatedAt'
  ], 'delivery_run_outbox_invalid');
  if (
    !OUTBOX_ID_PATTERN.test(item.id) ||
    item.id !== `outbox-${task.missionBindingKey.slice(0, 32)}` ||
    item.kind !== 'mission.ensure' ||
    item.stepId !== task.stepId ||
    item.bindingKey !== task.missionBindingKey ||
    item.payloadDigest !== task.missionDefinitionDigest ||
    !OUTBOX_STATE_SET.has(item.state) ||
    !validTimestamp(item.updatedAt)
  ) throw runError('delivery_run_outbox_invalid');
  if (item.missionId !== null && !MISSION_ID_PATTERN.test(item.missionId)) throw runError('delivery_run_outbox_invalid');
  assertText(item.error, 'delivery_run_outbox_invalid', { required: false, max: MAX.error });
  if (item.state === 'applied') {
    if (!item.missionId || item.missionId !== task.missionId || task.state === 'pending') {
      throw runError('delivery_run_outbox_lifecycle_invalid');
    }
  } else if (item.missionId !== null) {
    throw runError('delivery_run_outbox_lifecycle_invalid');
  }
  if (item.state === 'reconcile_required' && task.state !== 'reconcile_required') {
    throw runError('delivery_run_outbox_lifecycle_invalid');
  }
  if (item.state === 'blocked' && task.state !== 'off_course') throw runError('delivery_run_outbox_lifecycle_invalid');
  if (item.state === 'canceled' && (task.state !== 'aborted' || !item.error)) {
    throw runError('delivery_run_outbox_lifecycle_invalid');
  }
  if (item.error && !['reconcile_required', 'blocked', 'canceled'].includes(item.state)) {
    throw runError('delivery_run_outbox_lifecycle_invalid');
  }
}

function validateVerification(record, run, task, evidenceIds) {
  exactKeys(record, [
    'id',
    'stepId',
    'planDigest',
    'implementationMissionId',
    'verifier',
    'criteria',
    'outcome',
    'beforeBaselineDigest',
    'afterBaselineDigest',
    'evidenceIds',
    'note',
    'verifiedAt'
  ], 'delivery_run_verification_invalid');
  if (
    !VERIFICATION_ID_PATTERN.test(record.id) ||
    record.stepId !== task.stepId ||
    record.planDigest !== run.planDigest ||
    record.implementationMissionId !== task.missionId ||
    !MISSION_ID_PATTERN.test(record.implementationMissionId) ||
    !['passed', 'failed'].includes(record.outcome)
  ) throw runError('delivery_run_verification_invalid');
  exactKeys(record.verifier, ['kind'], 'delivery_run_verifier_invalid');
  if (record.verifier.kind !== 'operator') throw runError('delivery_run_verifier_invalid');
  if (!Array.isArray(record.criteria) || record.criteria.length !== task.acceptanceIds.length || record.criteria.length > MAX.criteria) {
    throw runError('delivery_run_verification_criteria_invalid');
  }
  const criteriaIds = new Set();
  for (const criterion of record.criteria) {
    exactKeys(criterion, ['acceptanceId', 'outcome', 'evidenceIds'], 'delivery_run_verification_criterion_invalid');
    if (
      !task.acceptanceIds.includes(criterion.acceptanceId) ||
      criteriaIds.has(criterion.acceptanceId) ||
      !CRITERION_OUTCOME_SET.has(criterion.outcome)
    ) throw runError('delivery_run_verification_criterion_invalid');
    criteriaIds.add(criterion.acceptanceId);
    uniqueStrings(criterion.evidenceIds, EVIDENCE_ID_PATTERN, 'delivery_run_verification_criterion_invalid');
    for (const id of criterion.evidenceIds) {
      if (!evidenceIds.has(id)) throw runError('delivery_run_evidence_reference_unknown');
    }
  }
  assertDigest(record.beforeBaselineDigest, 'delivery_run_verification_baseline_invalid');
  assertDigest(record.afterBaselineDigest, 'delivery_run_verification_baseline_invalid');
  if (
    record.beforeBaselineDigest !== task.implementation.baseline?.digest ||
    record.afterBaselineDigest !== task.implementation.baseline?.digest
  ) throw runError('delivery_run_verification_baseline_changed');
  uniqueStrings(record.evidenceIds, EVIDENCE_ID_PATTERN, 'delivery_run_verification_invalid');
  for (const id of record.evidenceIds) {
    if (!evidenceIds.has(id)) throw runError('delivery_run_evidence_reference_unknown');
  }
  assertText(record.note, 'delivery_run_verification_invalid', { required: false, max: MAX.summary });
  if (record.outcome === 'passed' && record.criteria.some((criterion) => criterion.outcome !== 'passed')) {
    throw runError('delivery_run_verification_outcome_invalid');
  }
  if (record.outcome === 'failed' && record.criteria.every((criterion) => criterion.outcome === 'passed')) {
    throw runError('delivery_run_verification_outcome_invalid');
  }
  if (!validTimestamp(record.verifiedAt)) throw runError('delivery_run_verification_invalid');
}

function validateAbort(abort, run, evidenceById) {
  exactKeys(
    abort,
    ['operatorConfirmed', 'fromCondition', 'reason', 'evidenceIds', 'abortedAt'],
    'delivery_run_abort_invalid'
  );
  if (abort.operatorConfirmed !== true || !ABORTABLE_CONDITION_SET.has(abort.fromCondition)) {
    throw runError('delivery_run_abort_invalid');
  }
  assertText(abort.reason, 'delivery_run_abort_reason_invalid', { max: MAX.blocker });
  const evidenceIds = uniqueStrings(
    abort.evidenceIds,
    EVIDENCE_ID_PATTERN,
    'delivery_run_abort_evidence_invalid'
  );
  if (!evidenceIds.size) throw runError('delivery_run_abort_evidence_invalid');
  for (const id of evidenceIds) {
    if (!evidenceById.has(id)) throw runError('delivery_run_evidence_reference_unknown');
  }
  if (!validTimestamp(abort.abortedAt) || abort.abortedAt !== run.updatedAt) {
    throw runError('delivery_run_abort_invalid');
  }
  if (![...evidenceIds].some((id) => {
    const evidence = evidenceById.get(id);
    return evidence.type === 'review'
      && evidence.outcome === 'applied'
      && evidence.createdAt === abort.abortedAt;
  })) throw runError('delivery_run_abort_operator_evidence_required');
}

export function validateDeliveryRun(value) {
  exactKeys(value, [
    'version',
    'id',
    'revision',
    'planId',
    'planRevision',
    'planDigest',
    'workspace',
    'startBaseline',
    'condition',
    'tasks',
    'outbox',
    'evidenceIndex',
    'verificationRecords',
    'delivery',
    'abort',
    'blocker',
    'createdAt',
    'updatedAt'
  ], 'delivery_run_shape_invalid');
  if (value.version !== DELIVERY_RUN_VERSION) throw runError('delivery_run_version_unsupported');
  if (!RUN_ID_PATTERN.test(value.id)) throw runError('delivery_run_id_invalid');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw runError('delivery_run_revision_invalid');
  if (!PLAN_ID_PATTERN.test(value.planId)) throw runError('delivery_run_plan_id_invalid');
  if (!Number.isSafeInteger(value.planRevision) || value.planRevision < 1) throw runError('delivery_run_plan_revision_invalid');
  assertDigest(value.planDigest, 'delivery_run_plan_digest_invalid');
  assertText(value.workspace, 'delivery_run_workspace_invalid', { max: MAX.workspace });
  if (!path.isAbsolute(value.workspace) || path.normalize(value.workspace) !== value.workspace) {
    throw runError('delivery_run_workspace_invalid');
  }
  validateWorkspaceBaseline(value.startBaseline);
  if (value.startBaseline.workspace !== value.workspace) throw runError('delivery_run_baseline_workspace_mismatch');
  if (!CONDITION_SET.has(value.condition)) throw runError('delivery_run_condition_invalid');
  assertText(value.blocker, 'delivery_run_blocker_invalid', { required: false, max: MAX.blocker });
  if (!validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt) || Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    throw runError('delivery_run_timestamp_invalid');
  }
  if (!Array.isArray(value.evidenceIndex) || value.evidenceIndex.length > MAX.evidence) {
    throw runError('delivery_run_evidence_index_invalid');
  }
  const evidenceIds = new Set();
  const evidenceById = new Map();
  for (const evidence of value.evidenceIndex) {
    validateEvidence(evidence);
    if (evidenceIds.has(evidence.id)) throw runError('delivery_run_evidence_duplicate');
    evidenceIds.add(evidence.id);
    evidenceById.set(evidence.id, evidence);
  }
  if (!Array.isArray(value.verificationRecords) || value.verificationRecords.length > MAX.verifications) {
    throw runError('delivery_run_verifications_invalid');
  }
  const verificationIds = new Set();
  for (const record of value.verificationRecords) {
    if (!plainObject(record) || !VERIFICATION_ID_PATTERN.test(String(record.id || '')) || verificationIds.has(record.id)) {
      throw runError('delivery_run_verification_duplicate');
    }
    verificationIds.add(record.id);
  }
  if (!Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > MAX.tasks) {
    throw runError('delivery_run_tasks_invalid');
  }
  if (!Array.isArray(value.outbox) || value.outbox.length !== value.tasks.length) {
    throw runError('delivery_run_outbox_invalid');
  }
  const stepIds = new Set();
  for (const [index, task] of value.tasks.entries()) {
    validateTask(task, value, evidenceIds, verificationIds);
    if (task.sequence !== index || stepIds.has(task.stepId)) throw runError('delivery_run_task_order_invalid');
    stepIds.add(task.stepId);
    validateOutbox(value.outbox[index], task);
    if (index === 0 && task.expectedBaselineDigest !== value.startBaseline.digest) {
      throw runError('delivery_run_task_baseline_invalid');
    }
    if (value.condition === 'aborted') {
      if (task.state === 'verified') {
        if (value.outbox[index].state !== 'applied') throw runError('delivery_run_abort_task_invalid');
      } else if (task.state !== 'aborted' || !['applied', 'canceled'].includes(value.outbox[index].state)) {
        throw runError('delivery_run_abort_task_invalid');
      }
    } else if (task.state === 'aborted' || value.outbox[index].state === 'canceled') {
      throw runError('delivery_run_abort_task_invalid');
    }
    if (index > 0) {
      const previous = value.tasks[index - 1];
      const expected = previous.state === 'verified' ? previous.implementation.baseline.digest : '';
      if (task.expectedBaselineDigest !== expected) throw runError('delivery_run_task_baseline_invalid');
      if (value.condition !== 'aborted') {
        const shouldRelease = previous.state === 'verified' && task.state === 'pending';
        if (shouldRelease && !['pending', 'reconcile_required', 'applied', 'blocked'].includes(value.outbox[index].state)) {
          throw runError('delivery_run_outbox_sequence_invalid');
        }
        if (previous.state !== 'verified' && value.outbox[index].state !== 'held') {
          throw runError('delivery_run_outbox_sequence_invalid');
        }
      }
    }
  }
  for (const record of value.verificationRecords) {
    const task = value.tasks.find((candidate) => candidate.stepId === record.stepId);
    if (!task) throw runError('delivery_run_verification_step_unknown');
    validateVerification(record, value, task, evidenceIds);
    if (task.verificationId !== record.id) throw runError('delivery_run_verification_task_mismatch');
  }
  const pendingActions = value.outbox.filter((item) => ['pending', 'reconcile_required'].includes(item.state));
  if (pendingActions.length > 1) throw runError('delivery_run_outbox_sequence_invalid');
  exactKeys(value.delivery, ['level', 'evidenceIds', 'updatedAt'], 'delivery_run_delivery_invalid');
  if (!DELIVERY_LEVEL_SET.has(value.delivery.level) || value.delivery.level !== expectedDeliveryLevel(value)) {
    throw runError('delivery_run_delivery_invalid');
  }
  uniqueStrings(value.delivery.evidenceIds, EVIDENCE_ID_PATTERN, 'delivery_run_delivery_invalid');
  for (const id of value.delivery.evidenceIds) {
    if (!evidenceIds.has(id)) throw runError('delivery_run_evidence_reference_unknown');
  }
  if (!validTimestamp(value.delivery.updatedAt) || Date.parse(value.delivery.updatedAt) > Date.parse(value.updatedAt)) {
    throw runError('delivery_run_delivery_invalid');
  }
  if (value.condition === 'aborted') {
    if (!value.abort || !value.tasks.some((task) => task.state === 'aborted')) {
      throw runError('delivery_run_abort_invalid');
    }
    validateAbort(value.abort, value, evidenceById);
    if (value.blocker !== value.abort.reason) throw runError('delivery_run_abort_reason_invalid');
    for (const item of value.outbox.filter((candidate) => candidate.state === 'canceled')) {
      if (
        item.error !== value.abort.reason.slice(0, MAX.error) ||
        item.updatedAt !== value.abort.abortedAt
      ) throw runError('delivery_run_abort_outbox_invalid');
    }
  } else if (value.abort !== null) {
    throw runError('delivery_run_abort_invalid');
  }
  if (value.condition === 'verified' && !value.tasks.every((task) => task.state === 'verified')) {
    throw runError('delivery_run_condition_invalid');
  }
  if (value.condition === 'awaiting_verification' && !value.tasks.some((task) => task.state === 'implementation_captured')) {
    throw runError('delivery_run_condition_invalid');
  }
  if (value.condition === 'reconcile_required' && !value.tasks.some((task) => task.state === 'reconcile_required')) {
    throw runError('delivery_run_condition_invalid');
  }
  if (value.condition === 'off_course' && !value.tasks.some((task) => task.state === 'off_course')) {
    throw runError('delivery_run_condition_invalid');
  }
  if (value.condition === 'blocked' && !value.tasks.some((task) => task.state === 'failed')) {
    throw runError('delivery_run_condition_invalid');
  }
  if (['blocked', 'off_course', 'reconcile_required', 'aborted'].includes(value.condition) !== Boolean(value.blocker)) {
    throw runError('delivery_run_blocker_invalid');
  }
  return structuredClone(value);
}

export function createDeliveryRun(value, { at = new Date().toISOString() } = {}) {
  exactKeys(
    value,
    ['id', 'planId', 'planRevision', 'planDigest', 'workspace', 'startBaseline', 'tasks'],
    'delivery_run_create_input_invalid'
  );
  const createdAt = timestamp(at);
  const id = inline(value.id).toLowerCase();
  const planId = inline(value.planId).toLowerCase();
  const planDigest = inline(value.planDigest).toLowerCase();
  if (!RUN_ID_PATTERN.test(id)) throw runError('delivery_run_id_invalid');
  if (!PLAN_ID_PATTERN.test(planId)) throw runError('delivery_run_plan_id_invalid');
  if (!Number.isSafeInteger(value.planRevision) || value.planRevision < 1) throw runError('delivery_run_plan_revision_invalid');
  assertDigest(planDigest, 'delivery_run_plan_digest_invalid');
  const workspace = path.normalize(inline(value.workspace));
  if (!path.isAbsolute(workspace) || workspace !== inline(value.workspace) || workspace.length > MAX.workspace) {
    throw runError('delivery_run_workspace_invalid');
  }
  const startBaseline = createWorkspaceBaseline(value.startBaseline);
  if (!Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > MAX.tasks) {
    throw runError('delivery_run_tasks_invalid');
  }
  const context = { runId: id, planId, planDigest, startBaselineDigest: startBaseline.digest };
  const tasks = value.tasks.map((task, index) => createTask(task, context, index));
  if (new Set(tasks.map((task) => task.stepId)).size !== tasks.length) throw runError('delivery_run_step_id_duplicate');
  const run = {
    version: DELIVERY_RUN_VERSION,
    id,
    revision: 1,
    planId,
    planRevision: value.planRevision,
    planDigest,
    workspace,
    startBaseline,
    condition: 'preparing',
    tasks,
    outbox: tasks.map((task) => createOutbox(task, createdAt)),
    evidenceIndex: [],
    verificationRecords: [],
    delivery: { level: 'planned', evidenceIds: [], updatedAt: createdAt },
    abort: null,
    blocker: '',
    createdAt,
    updatedAt: createdAt
  };
  return validateDeliveryRun(run);
}

function currentTask(run, stepId) {
  const task = run.tasks.find((candidate) => candidate.stepId === inline(stepId).toUpperCase());
  if (!task) throw runError('delivery_run_task_not_found');
  return task;
}

function outboxForTask(run, task) {
  const outbox = run.outbox.find((candidate) => candidate.stepId === task.stepId);
  if (!outbox) throw runError('delivery_run_outbox_invalid');
  return outbox;
}

function nextRevision(run, at) {
  run.revision += 1;
  run.updatedAt = timestamp(at);
  return run;
}

function appendEvidence(run, values) {
  if (!Array.isArray(values)) throw runError('delivery_run_evidence_input_invalid');
  if (run.evidenceIndex.length + values.length > MAX.evidence) throw runError('delivery_run_evidence_limit_reached');
  const known = new Set(run.evidenceIndex.map((item) => item.id));
  const appended = [];
  for (const value of values) {
    const evidence = createEvidence(value);
    if (known.has(evidence.id)) throw runError('delivery_run_evidence_duplicate');
    known.add(evidence.id);
    run.evidenceIndex.push(evidence);
    appended.push(evidence.id);
  }
  return appended;
}

function refreshDelivery(run, evidenceIds, at) {
  for (const id of evidenceIds) {
    if (!run.delivery.evidenceIds.includes(id)) run.delivery.evidenceIds.push(id);
  }
  run.delivery.level = expectedDeliveryLevel(run);
  run.delivery.updatedAt = timestamp(at);
}

function assertWorkMutable(run, code) {
  if (['aborted', 'verified'].includes(run.condition)) throw runError(code);
}

export function linkDeliveryRunMission(value, input, { at = new Date().toISOString() } = {}) {
  const run = validateDeliveryRun(value);
  exactKeys(input, ['stepId', 'bindingKey', 'missionId'], 'delivery_run_mission_link_input_invalid');
  assertWorkMutable(run, 'delivery_run_mission_link_state_invalid');
  const task = currentTask(run, input.stepId);
  const outbox = outboxForTask(run, task);
  if (!['pending', 'reconcile_required'].includes(outbox.state) || !['pending', 'reconcile_required'].includes(task.state)) {
    throw runError('delivery_run_mission_link_state_invalid');
  }
  if (input.bindingKey !== task.missionBindingKey) throw runError('delivery_run_mission_binding_conflict');
  const missionId = inline(input.missionId).toLowerCase();
  if (!MISSION_ID_PATTERN.test(missionId)) throw runError('delivery_run_mission_id_invalid');
  const next = structuredClone(run);
  const nextTask = currentTask(next, task.stepId);
  const nextOutbox = outboxForTask(next, nextTask);
  nextTask.state = 'mission_linked';
  nextTask.missionId = missionId;
  nextOutbox.state = 'applied';
  nextOutbox.missionId = missionId;
  nextOutbox.error = '';
  nextOutbox.updatedAt = timestamp(at);
  next.condition = 'active';
  next.blocker = '';
  return validateDeliveryRun(nextRevision(next, at));
}

export function markDeliveryRunMissionReconcileRequired(value, input, { at = new Date().toISOString() } = {}) {
  const run = validateDeliveryRun(value);
  exactKeys(input, ['stepId', 'bindingKey', 'error'], 'delivery_run_mission_reconcile_input_invalid');
  assertWorkMutable(run, 'delivery_run_mission_reconcile_state_invalid');
  const task = currentTask(run, input.stepId);
  const outbox = outboxForTask(run, task);
  if (outbox.state !== 'pending' || task.state !== 'pending') throw runError('delivery_run_mission_reconcile_state_invalid');
  if (input.bindingKey !== task.missionBindingKey) throw runError('delivery_run_mission_binding_conflict');
  const error = inline(input.error);
  assertText(error, 'delivery_run_mission_reconcile_error_invalid', { max: MAX.error });
  const next = structuredClone(run);
  const nextTask = currentTask(next, task.stepId);
  const nextOutbox = outboxForTask(next, nextTask);
  nextTask.state = 'reconcile_required';
  nextOutbox.state = 'reconcile_required';
  nextOutbox.error = error;
  nextOutbox.updatedAt = timestamp(at);
  next.condition = 'reconcile_required';
  next.blocker = error;
  return validateDeliveryRun(nextRevision(next, at));
}

export function captureDeliveryRunImplementation(value, input, { at = new Date().toISOString() } = {}) {
  const run = validateDeliveryRun(value);
  exactKeys(input, ['stepId', 'missionId', 'baseline', 'evidence'], 'delivery_run_implementation_input_invalid');
  assertWorkMutable(run, 'delivery_run_implementation_state_invalid');
  const task = currentTask(run, input.stepId);
  if (task.state !== 'mission_linked' || input.missionId !== task.missionId) {
    throw runError('delivery_run_implementation_state_invalid');
  }
  const baseline = createWorkspaceBaseline(input.baseline);
  if (
    baseline.workspace !== run.startBaseline.workspace ||
    baseline.repoRoot !== run.startBaseline.repoRoot ||
    baseline.workspacePrefix !== run.startBaseline.workspacePrefix
  ) throw runError('delivery_run_implementation_baseline_identity_changed');
  if (baseline.digest === task.expectedBaselineDigest) throw runError('delivery_run_implementation_unchanged');
  const next = structuredClone(run);
  const nextTask = currentTask(next, task.stepId);
  const evidenceIds = appendEvidence(next, input.evidence);
  nextTask.state = 'implementation_captured';
  nextTask.implementation = {
    baseline,
    evidenceIds,
    capturedAt: baseline.capturedAt
  };
  next.condition = 'awaiting_verification';
  next.blocker = '';
  refreshDelivery(next, evidenceIds, at);
  return validateDeliveryRun(nextRevision(next, at));
}

export function recordDeliveryRunVerification(value, input, { at = new Date().toISOString() } = {}) {
  const run = validateDeliveryRun(value);
  exactKeys(
    input,
    ['id', 'stepId', 'missionId', 'baseline', 'criteria', 'evidence', 'evidenceIds', 'note'],
    'delivery_run_verification_input_invalid'
  );
  assertWorkMutable(run, 'delivery_run_verification_state_invalid');
  const task = currentTask(run, input.stepId);
  if (task.state !== 'implementation_captured' || input.missionId !== task.missionId) {
    throw runError('delivery_run_verification_state_invalid');
  }
  const verificationId = inline(input.id).toLowerCase();
  if (!VERIFICATION_ID_PATTERN.test(verificationId)) throw runError('delivery_run_verification_id_invalid');
  if (run.verificationRecords.some((record) => record.id === verificationId)) {
    throw runError('delivery_run_verification_duplicate');
  }
  const baseline = createWorkspaceBaseline(input.baseline);
  if (baseline.digest !== task.implementation.baseline.digest) throw runError('delivery_run_verification_baseline_changed');
  if (!Array.isArray(input.criteria) || input.criteria.length !== task.acceptanceIds.length) {
    throw runError('delivery_run_verification_criteria_invalid');
  }
  const next = structuredClone(run);
  const nextTask = currentTask(next, task.stepId);
  const newEvidenceIds = appendEvidence(next, input.evidence);
  const referencedEvidenceIds = normalizedUniqueIds(
    input.evidenceIds,
    EVIDENCE_ID_PATTERN,
    'delivery_run_verification_evidence_invalid'
  );
  const allEvidenceIds = new Set(next.evidenceIndex.map((item) => item.id));
  const taskEvidenceIds = new Set([...task.implementation.evidenceIds, ...newEvidenceIds]);
  for (const id of referencedEvidenceIds) {
    if (!allEvidenceIds.has(id)) throw runError('delivery_run_evidence_reference_unknown');
    if (!taskEvidenceIds.has(id)) throw runError('delivery_run_evidence_not_for_task');
  }
  const criteria = input.criteria.map((criterion) => {
    exactKeys(criterion, ['acceptanceId', 'outcome', 'evidenceIds'], 'delivery_run_verification_criterion_input_invalid');
    const acceptanceId = inline(criterion.acceptanceId).toUpperCase();
    const outcome = inline(criterion.outcome).toLowerCase();
    if (!task.acceptanceIds.includes(acceptanceId) || !CRITERION_OUTCOME_SET.has(outcome)) {
      throw runError('delivery_run_verification_criterion_invalid');
    }
    const evidenceIds = normalizedUniqueIds(
      criterion.evidenceIds,
      EVIDENCE_ID_PATTERN,
      'delivery_run_verification_criterion_invalid'
    );
    for (const id of evidenceIds) {
      if (!allEvidenceIds.has(id)) throw runError('delivery_run_evidence_reference_unknown');
      if (!taskEvidenceIds.has(id)) throw runError('delivery_run_evidence_not_for_task');
    }
    return { acceptanceId, outcome, evidenceIds };
  });
  if (new Set(criteria.map((criterion) => criterion.acceptanceId)).size !== task.acceptanceIds.length) {
    throw runError('delivery_run_verification_criteria_invalid');
  }
  const outcome = criteria.every((criterion) => criterion.outcome === 'passed') ? 'passed' : 'failed';
  const verificationNote = text(input.note);
  if (!verificationNote) throw runError('delivery_run_verification_note_required');
  const verifiedAt = timestamp(at);
  const record = {
    id: verificationId,
    stepId: task.stepId,
    planDigest: run.planDigest,
    implementationMissionId: task.missionId,
    verifier: { kind: 'operator' },
    criteria,
    outcome,
    beforeBaselineDigest: task.implementation.baseline.digest,
    afterBaselineDigest: baseline.digest,
    evidenceIds: referencedEvidenceIds,
    note: verificationNote,
    verifiedAt
  };
  next.verificationRecords.push(record);
  nextTask.verificationId = verificationId;
  nextTask.state = outcome === 'passed' ? 'verified' : 'failed';
  if (outcome === 'passed') {
    const following = next.tasks[nextTask.sequence + 1] || null;
    if (following) {
      following.expectedBaselineDigest = baseline.digest;
      const followingOutbox = outboxForTask(next, following);
      followingOutbox.state = 'pending';
      followingOutbox.updatedAt = verifiedAt;
      next.condition = 'active';
      next.blocker = '';
    } else {
      next.condition = 'verified';
      next.blocker = '';
    }
  } else {
    next.condition = 'blocked';
    next.blocker = verificationNote;
  }
  refreshDelivery(next, [...newEvidenceIds, ...referencedEvidenceIds], verifiedAt);
  return validateDeliveryRun(nextRevision(next, verifiedAt));
}

export function abortDeliveryRun(value, input, { at = new Date().toISOString() } = {}) {
  const run = validateDeliveryRun(value);
  exactKeys(
    input,
    ['operatorConfirmed', 'reason', 'evidence'],
    'delivery_run_abort_input_invalid'
  );
  if (!ABORTABLE_CONDITION_SET.has(run.condition)) throw runError('delivery_run_abort_state_invalid');
  if (input.operatorConfirmed !== true) throw runError('delivery_run_abort_confirmation_required');
  const reason = text(input.reason);
  assertText(reason, 'delivery_run_abort_reason_invalid', { max: MAX.blocker });
  if (!Array.isArray(input.evidence) || !input.evidence.length) {
    throw runError('delivery_run_abort_evidence_required');
  }
  const abortedAt = timestamp(at);
  const next = structuredClone(run);
  const evidenceIds = appendEvidence(next, input.evidence);
  if (!evidenceIds.some((id) => {
    const evidence = next.evidenceIndex.find((candidate) => candidate.id === id);
    return evidence?.type === 'review'
      && evidence.outcome === 'applied'
      && evidence.createdAt === abortedAt;
  })) throw runError('delivery_run_abort_operator_evidence_required');
  for (const task of next.tasks) {
    if (task.state === 'verified') continue;
    task.state = 'aborted';
    const outbox = outboxForTask(next, task);
    if (outbox.state !== 'applied') {
      outbox.state = 'canceled';
      outbox.missionId = null;
      outbox.error = reason.slice(0, MAX.error);
      outbox.updatedAt = abortedAt;
    }
  }
  next.condition = 'aborted';
  next.abort = {
    operatorConfirmed: true,
    fromCondition: run.condition,
    reason,
    evidenceIds,
    abortedAt
  };
  next.blocker = reason;
  refreshDelivery(next, evidenceIds, abortedAt);
  return validateDeliveryRun(nextRevision(next, abortedAt));
}

export function markDeliveryRunOffCourse(value, input, { at = new Date().toISOString() } = {}) {
  const run = validateDeliveryRun(value);
  exactKeys(input, ['stepId', 'reason', 'evidence'], 'delivery_run_off_course_input_invalid');
  if (['verified', 'aborted', 'off_course', 'blocked'].includes(run.condition)) {
    throw runError('delivery_run_off_course_state_invalid');
  }
  const task = currentTask(run, input.stepId);
  if (['verified', 'failed', 'off_course'].includes(task.state)) throw runError('delivery_run_off_course_state_invalid');
  const reason = text(input.reason);
  assertText(reason, 'delivery_run_off_course_reason_invalid', { max: MAX.blocker });
  const next = structuredClone(run);
  const nextTask = currentTask(next, task.stepId);
  const evidenceIds = appendEvidence(next, input.evidence);
  nextTask.state = 'off_course';
  const outbox = outboxForTask(next, nextTask);
  if (outbox.state !== 'applied') {
    outbox.state = 'blocked';
    outbox.error = reason.slice(0, MAX.error);
    outbox.updatedAt = timestamp(at);
  }
  next.condition = 'off_course';
  next.blocker = reason;
  refreshDelivery(next, evidenceIds, at);
  return validateDeliveryRun(nextRevision(next, at));
}
