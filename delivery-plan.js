import { createHash } from 'node:crypto';
import path from 'node:path';

export const DELIVERY_PLAN_VERSION = 1;
export const DELIVERY_PLAN_ROLES = Object.freeze(['po', 'ba', 'dev', 'qa']);
export const DELIVERY_PLAN_PHASES = Object.freeze([
  'draft',
  'planning',
  'needs_decision',
  'ready_for_approval',
  'approved',
  'executing',
  'verifying',
  'ready_to_release',
  'blocked',
  'done',
  'canceled'
]);

const PHASE_SET = new Set(DELIVERY_PLAN_PHASES);
const INTENT_SET = new Set(['answer', 'review', 'diagnose', 'change', 'build', 'publish', 'live_operation']);
const DEPTH_SET = new Set(['quick', 'standard', 'high_risk']);
const RISK_SET = new Set(['read_only', 'local_reversible', 'external_reversible', 'live_or_destructive']);
const APPROVAL_PHASES = new Set(['approved', 'executing', 'verifying', 'ready_to_release', 'done']);
const TERMINAL_PHASES = new Set(['done', 'canceled']);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const PLAN_ID_PATTERN = /^plan-[a-z0-9][a-z0-9-]{7,63}$/;
const REQUIREMENT_ID_PATTERN = /^REQ-[A-Z0-9][A-Z0-9_-]{0,39}$/;
const STEP_ID_PATTERN = /^STEP-[A-Z0-9][A-Z0-9_-]{0,39}$/;
const ACCEPTANCE_ID_PATTERN = /^AC-[A-Z0-9][A-Z0-9_-]{0,39}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const MAX = Object.freeze({
  title: 160,
  request: 4000,
  workspace: 4096,
  roleText: 1600,
  listItem: 800,
  blocker: 800,
  requirements: 80,
  steps: 80,
  criteria: 120,
  list: 100,
  path: 512,
  envelope: 8000
});

const LEGAL_TRANSITIONS = Object.freeze({
  draft: new Set(['planning', 'canceled']),
  planning: new Set(['needs_decision', 'ready_for_approval', 'blocked', 'canceled']),
  needs_decision: new Set(['planning', 'ready_for_approval', 'canceled']),
  ready_for_approval: new Set(['planning', 'approved', 'canceled']),
  approved: new Set(['planning', 'executing', 'canceled']),
  executing: new Set(['planning', 'verifying', 'blocked', 'canceled']),
  verifying: new Set(['planning', 'executing', 'ready_to_release', 'blocked', 'canceled']),
  ready_to_release: new Set(['planning', 'done', 'canceled']),
  blocked: new Set(['planning', 'canceled']),
  done: new Set(),
  canceled: new Set()
});

function planError(code) {
  return new Error(code);
}

function objectInput(value, field) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw planError(`delivery_plan_${field}_invalid`);
  return value;
}

function arrayInput(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw planError(`delivery_plan_${field}_invalid`);
  return value;
}

function normalizedText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

function normalizedInline(value) {
  return normalizedText(value).replace(/\s+/g, ' ');
}

function normalizedId(value) {
  return normalizedInline(value).toUpperCase();
}

function normalizedTimestamp(value, fallback = '') {
  const text = normalizedInline(value || fallback);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text;
}

function normalizedStringList(value, field) {
  const result = [];
  for (const item of arrayInput(value, field)) {
    const text = normalizedText(item);
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

function normalizedIdList(value, field) {
  const result = [];
  for (const item of arrayInput(value, field)) {
    const id = normalizedId(item);
    if (id && !result.includes(id)) result.push(id);
  }
  return result;
}

function normalizedBaseline(value) {
  const source = objectInput(value, 'baseline');
  return {
    head: normalizedInline(source.head).toLowerCase(),
    workingTreeDigest: normalizedInline(source.workingTreeDigest).toLowerCase(),
    instructionsDigest: normalizedInline(source.instructionsDigest).toLowerCase(),
    capturedAt: normalizedTimestamp(source.capturedAt)
  };
}

function normalizedAuthority(value) {
  const source = objectInput(value, 'authority');
  return {
    workspaceWrite: source.workspaceWrite === undefined ? false : source.workspaceWrite,
    commit: source.commit === undefined ? false : source.commit,
    push: source.push === undefined ? false : source.push,
    deploy: source.deploy === undefined ? false : source.deploy,
    network: source.network === undefined ? false : source.network,
    serviceControl: source.serviceControl === undefined ? false : source.serviceControl,
    destructive: source.destructive === undefined ? false : source.destructive,
    externalMessages: source.externalMessages === undefined ? false : source.externalMessages
  };
}

function normalizedClassification(value) {
  const source = objectInput(value, 'classification');
  return {
    intent: normalizedInline(source.intent).toLowerCase(),
    depth: normalizedInline(source.depth).toLowerCase(),
    risk: normalizedInline(source.risk).toLowerCase(),
    dataClasses: normalizedStringList(source.dataClasses, 'classification_data_classes'),
    mutationSurfaces: normalizedStringList(source.mutationSurfaces, 'classification_mutation_surfaces')
  };
}

function normalizedRoles(value) {
  const roles = objectInput(value, 'roles');
  const po = objectInput(roles.po, 'role_po');
  const ba = objectInput(roles.ba, 'role_ba');
  const dev = objectInput(roles.dev, 'role_dev');
  const qa = objectInput(roles.qa, 'role_qa');
  return {
    po: {
      user: normalizedText(po.user),
      problem: normalizedText(po.problem),
      outcome: normalizedText(po.outcome),
      value: normalizedText(po.value),
      nonGoals: normalizedStringList(po.nonGoals, 'po_non_goals'),
      assumptions: normalizedStringList(po.assumptions, 'po_assumptions'),
      openQuestions: normalizedStringList(po.openQuestions, 'po_open_questions')
    },
    ba: {
      requirements: arrayInput(ba.requirements, 'ba_requirements').map((requirement) => {
        const source = objectInput(requirement, 'requirement');
        return { id: normalizedId(source.id), text: normalizedText(source.text) };
      }),
      dependencies: normalizedStringList(ba.dependencies, 'ba_dependencies'),
      edgeCases: normalizedStringList(ba.edgeCases, 'ba_edge_cases'),
      constraints: normalizedStringList(ba.constraints, 'ba_constraints'),
      openQuestions: normalizedStringList(ba.openQuestions, 'ba_open_questions')
    },
    dev: {
      architecture: normalizedText(dev.architecture),
      steps: arrayInput(dev.steps, 'dev_steps').map((step) => {
        const source = objectInput(step, 'step');
        return {
          id: normalizedId(source.id),
          title: normalizedInline(source.title),
          outcome: normalizedText(source.outcome),
          requirementIds: normalizedIdList(source.requirementIds, 'step_requirement_ids'),
          scopePaths: normalizedStringList(source.scopePaths, 'step_scope_paths'),
          checks: normalizedStringList(source.checks, 'step_checks')
        };
      }),
      risks: normalizedStringList(dev.risks, 'dev_risks'),
      rollback: normalizedText(dev.rollback),
      openQuestions: normalizedStringList(dev.openQuestions, 'dev_open_questions')
    },
    qa: {
      acceptanceCriteria: arrayInput(qa.acceptanceCriteria, 'qa_acceptance_criteria').map((criterion) => {
        const source = objectInput(criterion, 'acceptance_criterion');
        return {
          id: normalizedId(source.id),
          text: normalizedText(source.text),
          requirementIds: normalizedIdList(source.requirementIds, 'acceptance_requirement_ids')
        };
      }),
      testStrategy: normalizedText(qa.testStrategy),
      regressionChecks: normalizedStringList(qa.regressionChecks, 'qa_regression_checks'),
      releaseRequired: qa.releaseRequired === undefined ? false : qa.releaseRequired,
      releaseChecks: normalizedStringList(qa.releaseChecks, 'qa_release_checks'),
      openQuestions: normalizedStringList(qa.openQuestions, 'qa_open_questions')
    }
  };
}

function normalizedApproval(value) {
  const source = objectInput(value, 'approval');
  return {
    digest: normalizedInline(source.digest).toLowerCase(),
    approvedAt: source.approvedAt == null ? null : normalizedTimestamp(source.approvedAt),
    planRevision: source.planRevision == null ? null : Number(source.planRevision)
  };
}

function normalizedGates(value) {
  const source = objectInput(value, 'gates');
  return {
    implementationCaptured: source.implementationCaptured === undefined ? false : source.implementationCaptured,
    qaPassed: source.qaPassed === undefined ? false : source.qaPassed,
    releaseVerified: source.releaseVerified === undefined ? false : source.releaseVerified
  };
}

export function normalizeDeliveryPlan(value, { at = new Date().toISOString() } = {}) {
  const source = objectInput(value, 'root');
  const createdAt = normalizedTimestamp(source.createdAt, at);
  return {
    version: source.version === undefined ? DELIVERY_PLAN_VERSION : Number(source.version),
    id: normalizedInline(source.id).toLowerCase(),
    revision: source.revision === undefined ? 1 : Number(source.revision),
    phase: normalizedInline(source.phase || 'draft').toLowerCase(),
    title: normalizedInline(source.title),
    request: normalizedText(source.request),
    workspace: normalizedInline(source.workspace),
    baseline: normalizedBaseline(source.baseline),
    classification: normalizedClassification(source.classification),
    roles: normalizedRoles(source.roles),
    unresolvedQuestions: normalizedStringList(source.unresolvedQuestions, 'unresolved_questions'),
    authority: normalizedAuthority(source.authority),
    approval: normalizedApproval(source.approval),
    gates: normalizedGates(source.gates),
    blocker: normalizedText(source.blocker),
    createdAt,
    updatedAt: normalizedTimestamp(source.updatedAt, createdAt)
  };
}

function assertText(value, field, { required = false, max = MAX.roleText } = {}) {
  if (typeof value !== 'string' || (required && !value)) throw planError(`delivery_plan_${field}_invalid`);
  if (value.length > max) throw planError(`delivery_plan_${field}_too_long`);
  if (CONTROL_CHARACTER_PATTERN.test(value)) throw planError('delivery_plan_control_characters_not_allowed');
}

function assertStringList(value, field, { maxItems = MAX.list, maxChars = MAX.listItem } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) throw planError(`delivery_plan_${field}_invalid`);
  for (const item of value) assertText(item, field, { required: true, max: maxChars });
}

function assertUniqueIds(items, field, pattern) {
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !pattern.test(item.id)) {
      throw planError(`delivery_plan_${field}_invalid`);
    }
    if (ids.has(item.id)) throw planError(`delivery_plan_${field}_duplicate`);
    ids.add(item.id);
  }
  return ids;
}

function validTimestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return typeof value === 'string'
    && value.length > 0
    && Number.isFinite(parsed)
    && value === new Date(parsed).toISOString();
}

function assertScopePath(value) {
  assertText(value, 'scope_path', { required: true, max: MAX.path });
  const normalized = path.posix.normalize(value);
  const segments = normalized.split('/');
  if (
    value.includes('\\')
    || normalized === '.'
    || normalized !== value
    || path.posix.isAbsolute(normalized)
    || segments.includes('..')
    || segments.includes('.git')
  ) {
    throw planError('delivery_plan_scope_path_invalid');
  }
}

function validateShape(plan, { enforcePhase = true } = {}) {
  if (plan.version !== DELIVERY_PLAN_VERSION) throw planError('delivery_plan_version_unsupported');
  if (!PLAN_ID_PATTERN.test(plan.id)) throw planError('delivery_plan_id_invalid');
  if (!Number.isSafeInteger(plan.revision) || plan.revision < 1) throw planError('delivery_plan_revision_invalid');
  if (!PHASE_SET.has(plan.phase)) throw planError('delivery_plan_phase_invalid');
  assertText(plan.title, 'title', { required: true, max: MAX.title });
  assertText(plan.request, 'request', { required: true, max: MAX.request });
  assertText(plan.workspace, 'workspace', { max: MAX.workspace });
  if (plan.workspace && (
    !path.isAbsolute(plan.workspace)
    || path.normalize(plan.workspace) !== plan.workspace
    || (plan.workspace !== path.parse(plan.workspace).root && plan.workspace.endsWith(path.sep))
  )) throw planError('delivery_plan_workspace_invalid');
  assertText(plan.blocker, 'blocker', { max: MAX.blocker });
  if (!validTimestamp(plan.createdAt) || !validTimestamp(plan.updatedAt) || Date.parse(plan.updatedAt) < Date.parse(plan.createdAt)) {
    throw planError('delivery_plan_timestamp_invalid');
  }

  const baseline = plan.baseline;
  assertText(baseline.head, 'baseline_head', { max: 80 });
  if (baseline.head && baseline.head !== 'unborn' && !/^[a-f0-9]{7,64}$/.test(baseline.head)) {
    throw planError('delivery_plan_baseline_head_invalid');
  }
  for (const field of ['workingTreeDigest', 'instructionsDigest']) {
    assertText(baseline[field], `baseline_${field}`, { max: 64 });
    if (baseline[field] && !DIGEST_PATTERN.test(baseline[field])) throw planError('delivery_plan_baseline_digest_invalid');
  }
  if (baseline.capturedAt && !validTimestamp(baseline.capturedAt)) throw planError('delivery_plan_baseline_timestamp_invalid');

  const classification = plan.classification;
  if (classification.intent && !INTENT_SET.has(classification.intent)) throw planError('delivery_plan_classification_intent_invalid');
  if (classification.depth && !DEPTH_SET.has(classification.depth)) throw planError('delivery_plan_classification_depth_invalid');
  if (classification.risk && !RISK_SET.has(classification.risk)) throw planError('delivery_plan_classification_risk_invalid');
  assertStringList(classification.dataClasses, 'classification_data_classes');
  assertStringList(classification.mutationSurfaces, 'classification_mutation_surfaces');

  const { po, ba, dev, qa } = plan.roles;
  for (const [field, value] of Object.entries({
    po_user: po.user,
    po_problem: po.problem,
    po_outcome: po.outcome,
    po_value: po.value,
    dev_architecture: dev.architecture,
    dev_rollback: dev.rollback,
    qa_test_strategy: qa.testStrategy
  })) assertText(value, field);
  for (const [field, value] of Object.entries({
    po_non_goals: po.nonGoals,
    po_assumptions: po.assumptions,
    po_open_questions: po.openQuestions,
    ba_dependencies: ba.dependencies,
    ba_edge_cases: ba.edgeCases,
    ba_constraints: ba.constraints,
    ba_open_questions: ba.openQuestions,
    dev_risks: dev.risks,
    dev_open_questions: dev.openQuestions,
    qa_regression_checks: qa.regressionChecks,
    qa_release_checks: qa.releaseChecks,
    qa_open_questions: qa.openQuestions,
    unresolved_questions: plan.unresolvedQuestions
  })) assertStringList(value, field);
  if (typeof qa.releaseRequired !== 'boolean') throw planError('delivery_plan_release_required_invalid');

  if (!Array.isArray(ba.requirements) || ba.requirements.length > MAX.requirements) throw planError('delivery_plan_requirements_invalid');
  const requirementIds = assertUniqueIds(ba.requirements, 'requirement_id', REQUIREMENT_ID_PATTERN);
  for (const requirement of ba.requirements) assertText(requirement.text, 'requirement_text', { required: true, max: MAX.listItem });

  if (!Array.isArray(dev.steps) || dev.steps.length > MAX.steps) throw planError('delivery_plan_steps_invalid');
  assertUniqueIds(dev.steps, 'step_id', STEP_ID_PATTERN);
  for (const step of dev.steps) {
    assertText(step.title, 'step_title', { required: true, max: MAX.title });
    assertText(step.outcome, 'step_outcome', { required: true, max: MAX.listItem });
    assertStringList(step.requirementIds, 'step_requirement_ids', { maxItems: MAX.requirements, maxChars: 44 });
    if (step.requirementIds.some((id) => !requirementIds.has(id))) throw planError('delivery_plan_step_requirement_unknown');
    assertStringList(step.scopePaths, 'step_scope_paths', { maxItems: MAX.list, maxChars: MAX.path });
    step.scopePaths.forEach(assertScopePath);
    assertStringList(step.checks, 'step_checks');
  }

  if (!Array.isArray(qa.acceptanceCriteria) || qa.acceptanceCriteria.length > MAX.criteria) {
    throw planError('delivery_plan_acceptance_criteria_invalid');
  }
  assertUniqueIds(qa.acceptanceCriteria, 'acceptance_id', ACCEPTANCE_ID_PATTERN);
  for (const criterion of qa.acceptanceCriteria) {
    assertText(criterion.text, 'acceptance_text', { required: true, max: MAX.listItem });
    assertStringList(criterion.requirementIds, 'acceptance_requirement_ids', { maxItems: MAX.requirements, maxChars: 44 });
    if (criterion.requirementIds.some((id) => !requirementIds.has(id))) throw planError('delivery_plan_acceptance_requirement_unknown');
  }

  for (const value of Object.values(plan.authority)) {
    if (typeof value !== 'boolean') throw planError('delivery_plan_authority_invalid');
  }
  const approvalPresent = Boolean(plan.approval.digest || plan.approval.approvedAt || plan.approval.planRevision != null);
  if (approvalPresent && (
    !DIGEST_PATTERN.test(plan.approval.digest) ||
    !validTimestamp(plan.approval.approvedAt) ||
    !Number.isSafeInteger(plan.approval.planRevision) ||
    plan.approval.planRevision < 1
  )) throw planError('delivery_plan_approval_invalid');
  for (const value of Object.values(plan.gates)) {
    if (typeof value !== 'boolean') throw planError('delivery_plan_gates_invalid');
  }

  if (enforcePhase) {
    const readiness = lintNormalizedReadiness(plan);
    if (['ready_for_approval', ...APPROVAL_PHASES].includes(plan.phase) && !readiness.ready) {
      throw planError('delivery_plan_phase_not_ready');
    }
    if (APPROVAL_PHASES.has(plan.phase) && deliveryPlanApprovalStatusUnchecked(plan) !== 'current') {
      throw planError('delivery_plan_approval_not_current');
    }
    if (['verifying', 'ready_to_release', 'done'].includes(plan.phase) && !plan.gates.implementationCaptured) {
      throw planError('delivery_plan_implementation_evidence_required');
    }
    if (['ready_to_release', 'done'].includes(plan.phase) && !plan.gates.qaPassed) {
      throw planError('delivery_plan_qa_pass_required');
    }
    if (plan.phase === 'done' && plan.roles.qa.releaseRequired && !plan.gates.releaseVerified) {
      throw planError('delivery_plan_release_verification_required');
    }
  }
  return plan;
}

export function validateDeliveryPlan(value) {
  return validateShape(normalizeDeliveryPlan(value));
}

function addFinding(findings, code, pathName, message) {
  findings.push({ code, path: pathName, message });
}

function lintNormalizedReadiness(plan) {
  const errors = [];
  const warnings = [];
  const { po, ba, dev, qa } = plan.roles;
  for (const [field, value, label] of [
    ['user', po.user, 'PO user'],
    ['problem', po.problem, 'PO problem'],
    ['outcome', po.outcome, 'PO outcome'],
    ['value', po.value, 'PO value']
  ]) {
    if (!value) addFinding(errors, `po_${field}_missing`, `roles.po.${field}`, `${label} is required.`);
  }
  if (!po.nonGoals.length) addFinding(errors, 'po_non_goals_missing', 'roles.po.nonGoals', 'At least one explicit non-goal is required.');
  if (!plan.workspace) addFinding(errors, 'workspace_missing', 'workspace', 'A canonical workspace is required.');
  if (!plan.baseline.head) addFinding(errors, 'baseline_head_missing', 'baseline.head', 'The Git baseline is required.');
  if (!plan.baseline.workingTreeDigest) addFinding(errors, 'baseline_worktree_missing', 'baseline.workingTreeDigest', 'The recognized working-tree baseline is required.');
  if (!plan.baseline.instructionsDigest) addFinding(errors, 'baseline_instructions_missing', 'baseline.instructionsDigest', 'The project-instruction baseline is required.');
  if (!plan.baseline.capturedAt) addFinding(errors, 'baseline_timestamp_missing', 'baseline.capturedAt', 'The baseline capture time is required.');
  if (deliveryPlanHasDiscoveryBaseline(plan)) {
    addFinding(errors, 'baseline_discovery_only', 'baseline', 'Connect a real Git workspace baseline before approval or coding. The discovery workshop may continue.');
  }
  if (!plan.classification.intent) addFinding(errors, 'classification_intent_missing', 'classification.intent', 'The requested action class is required.');
  if (!plan.classification.depth) addFinding(errors, 'classification_depth_missing', 'classification.depth', 'The planning depth is required.');
  if (!plan.classification.risk) addFinding(errors, 'classification_risk_missing', 'classification.risk', 'The mutation risk class is required.');
  if (!ba.requirements.length) addFinding(errors, 'ba_requirements_missing', 'roles.ba.requirements', 'At least one numbered requirement is required.');
  if (!dev.architecture) addFinding(errors, 'dev_architecture_missing', 'roles.dev.architecture', 'A bounded technical approach is required.');
  if (!dev.steps.length) addFinding(errors, 'dev_steps_missing', 'roles.dev.steps', 'At least one implementation step is required.');
  if (!dev.rollback) addFinding(errors, 'dev_rollback_missing', 'roles.dev.rollback', 'A rollback or safe-abort strategy is required.');
  if (!qa.acceptanceCriteria.length) addFinding(errors, 'qa_acceptance_missing', 'roles.qa.acceptanceCriteria', 'At least one acceptance criterion is required.');
  if (!qa.testStrategy) addFinding(errors, 'qa_test_strategy_missing', 'roles.qa.testStrategy', 'A test strategy is required.');
  if (!qa.regressionChecks.length) addFinding(errors, 'qa_regression_missing', 'roles.qa.regressionChecks', 'At least one regression check is required.');
  if (qa.releaseRequired && !qa.releaseChecks.length) {
    addFinding(errors, 'qa_release_checks_missing', 'roles.qa.releaseChecks', 'Release checks are required when release is in scope.');
  }

  const openQuestions = [
    ...plan.unresolvedQuestions,
    ...DELIVERY_PLAN_ROLES.flatMap((role) => plan.roles[role].openQuestions || [])
  ];
  if (openQuestions.length) {
    addFinding(errors, 'unresolved_questions', 'unresolvedQuestions', `${openQuestions.length} planning question(s) remain unresolved.`);
  }

  const traceability = ba.requirements.map((requirement) => {
    const stepIds = dev.steps.filter((step) => step.requirementIds.includes(requirement.id)).map((step) => step.id);
    const acceptanceIds = qa.acceptanceCriteria
      .filter((criterion) => criterion.requirementIds.includes(requirement.id))
      .map((criterion) => criterion.id);
    if (!stepIds.length) addFinding(errors, 'requirement_missing_step', `roles.ba.requirements.${requirement.id}`, `${requirement.id} is not covered by an implementation step.`);
    if (!acceptanceIds.length) addFinding(errors, 'requirement_missing_acceptance', `roles.ba.requirements.${requirement.id}`, `${requirement.id} is not covered by an acceptance criterion.`);
    return { requirementId: requirement.id, stepIds, acceptanceIds, complete: Boolean(stepIds.length && acceptanceIds.length) };
  });
  for (const step of dev.steps) {
    if (!step.requirementIds.length) addFinding(errors, 'step_requirements_missing', `roles.dev.steps.${step.id}`, `${step.id} must trace to a requirement.`);
    if (!step.scopePaths.length) addFinding(errors, 'step_scope_missing', `roles.dev.steps.${step.id}`, `${step.id} needs a bounded file or directory scope.`);
    if (!step.checks.length) addFinding(errors, 'step_checks_missing', `roles.dev.steps.${step.id}`, `${step.id} needs at least one verification check.`);
  }
  for (const criterion of qa.acceptanceCriteria) {
    if (!criterion.requirementIds.length) addFinding(errors, 'acceptance_requirements_missing', `roles.qa.acceptanceCriteria.${criterion.id}`, `${criterion.id} must trace to a requirement.`);
  }
  if (!dev.risks.length) addFinding(warnings, 'dev_risks_empty', 'roles.dev.risks', 'No implementation risks were recorded.');
  const elevated = Object.entries(plan.authority).filter(([name, enabled]) => name !== 'workspaceWrite' && enabled).map(([name]) => name);
  if (elevated.length) addFinding(warnings, 'elevated_authority', 'authority', `Elevated authority requested: ${elevated.join(', ')}.`);
  return { ready: errors.length === 0, errors, warnings, traceability };
}

export function lintDeliveryPlanReadiness(value) {
  const plan = validateShape(normalizeDeliveryPlan(value), { enforcePhase: false });
  return lintNormalizedReadiness(plan);
}

function canonicalSerialize(value, stack) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON does not support non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new TypeError('canonical JSON supports JSON values only');
  if (stack.has(value)) throw new TypeError('canonical JSON does not support circular values');
  stack.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => canonicalSerialize(item, stack)).join(',')}]`;
  } else {
    const pairs = Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) throw new TypeError('canonical JSON does not support undefined');
      return `${JSON.stringify(key)}:${canonicalSerialize(value[key], stack)}`;
    });
    result = `{${pairs.join(',')}}`;
  }
  stack.delete(value);
  return result;
}

export function canonicalJson(value) {
  return canonicalSerialize(value, new Set());
}

export function canonicalSha256(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function deliveryPlanDiscoveryBaseline(workspace, { at = new Date().toISOString() } = {}) {
  const canonicalWorkspace = normalizedInline(workspace);
  if (
    !path.isAbsolute(canonicalWorkspace)
    || path.normalize(canonicalWorkspace) !== canonicalWorkspace
    || (canonicalWorkspace !== path.parse(canonicalWorkspace).root && canonicalWorkspace.endsWith(path.sep))
  ) throw planError('delivery_plan_workspace_invalid');
  return {
    head: 'unborn',
    workingTreeDigest: canonicalSha256({ version: 1, kind: 'aap_discovery', workspace: canonicalWorkspace }),
    instructionsDigest: canonicalSha256({ version: 1, kind: 'aap_discovery_instructions', workspace: canonicalWorkspace }),
    capturedAt: normalizedTimestamp(at)
  };
}

export function deliveryPlanHasDiscoveryBaseline(value) {
  if (!value?.workspace || !value?.baseline) return false;
  let expected;
  try {
    expected = deliveryPlanDiscoveryBaseline(value.workspace, { at: value.baseline.capturedAt });
  } catch {
    return false;
  }
  return value.baseline.head === expected.head
    && value.baseline.workingTreeDigest === expected.workingTreeDigest
    && value.baseline.instructionsDigest === expected.instructionsDigest;
}

export function deliveryPlanDefinition(value) {
  const plan = validateShape(normalizeDeliveryPlan(value), { enforcePhase: false });
  return {
    version: plan.version,
    id: plan.id,
    title: plan.title,
    request: plan.request,
    workspace: plan.workspace,
    baseline: {
      head: plan.baseline.head,
      workingTreeDigest: plan.baseline.workingTreeDigest,
      instructionsDigest: plan.baseline.instructionsDigest
    },
    classification: plan.classification,
    roles: plan.roles,
    unresolvedQuestions: plan.unresolvedQuestions,
    authority: plan.authority
  };
}

export function deliveryPlanDigest(value) {
  return canonicalSha256(deliveryPlanDefinition(value));
}

function deliveryPlanApprovalStatusUnchecked(plan) {
  if (!plan.approval.digest) return 'missing';
  return plan.approval.digest === deliveryPlanDigest(plan) ? 'current' : 'stale';
}

export function deliveryPlanApprovalStatus(value) {
  const plan = validateShape(normalizeDeliveryPlan(value), { enforcePhase: false });
  return deliveryPlanApprovalStatusUnchecked(plan);
}

function emptyApproval() {
  return { digest: '', approvedAt: null, planRevision: null };
}

function emptyGates() {
  return { implementationCaptured: false, qaPassed: false, releaseVerified: false };
}

function readinessPhase(plan) {
  return lintNormalizedReadiness(plan).ready ? 'ready_for_approval' : 'planning';
}

export function invalidateDeliveryPlanApproval(value, { at = new Date().toISOString() } = {}) {
  const plan = validateShape(normalizeDeliveryPlan(value), { enforcePhase: false });
  if (TERMINAL_PHASES.has(plan.phase)) throw planError('delivery_plan_terminal');
  if (!plan.approval.digest && !['ready_for_approval', ...APPROVAL_PHASES].includes(plan.phase)) return plan;
  const next = {
    ...plan,
    revision: plan.revision + 1,
    phase: readinessPhase(plan),
    approval: emptyApproval(),
    gates: emptyGates(),
    blocker: '',
    updatedAt: normalizedTimestamp(at)
  };
  return validateDeliveryPlan(next);
}

function mergedDefinition(plan, patch) {
  const source = objectInput(patch, 'definition_patch');
  const rolesPatch = objectInput(source.roles, 'roles_patch');
  const roles = { ...plan.roles };
  for (const role of DELIVERY_PLAN_ROLES) {
    if (rolesPatch[role] !== undefined) roles[role] = { ...plan.roles[role], ...objectInput(rolesPatch[role], `role_${role}_patch`) };
  }
  return {
    ...plan,
    ...(source.title === undefined ? {} : { title: source.title }),
    ...(source.request === undefined ? {} : { request: source.request }),
    ...(source.workspace === undefined ? {} : { workspace: source.workspace }),
    ...(source.unresolvedQuestions === undefined ? {} : { unresolvedQuestions: source.unresolvedQuestions }),
    baseline: source.baseline === undefined ? plan.baseline : { ...plan.baseline, ...objectInput(source.baseline, 'baseline_patch') },
    classification: source.classification === undefined
      ? plan.classification
      : { ...plan.classification, ...objectInput(source.classification, 'classification_patch') },
    authority: source.authority === undefined ? plan.authority : { ...plan.authority, ...objectInput(source.authority, 'authority_patch') },
    roles
  };
}

export function updateDeliveryPlanDefinition(value, patch, { at = new Date().toISOString() } = {}) {
  const plan = validateDeliveryPlan(value);
  if (TERMINAL_PHASES.has(plan.phase)) throw planError('delivery_plan_terminal');
  if (['executing', 'verifying', 'ready_to_release'].includes(plan.phase)) {
    throw planError('delivery_plan_execution_locked');
  }
  const candidate = normalizeDeliveryPlan(mergedDefinition(plan, patch));
  validateShape(candidate, { enforcePhase: false });
  if (deliveryPlanDigest(candidate) === deliveryPlanDigest(plan)) return plan;
  const invalidatesApproval = plan.approval.digest || ['ready_for_approval', ...APPROVAL_PHASES].includes(plan.phase);
  if (invalidatesApproval) return invalidateDeliveryPlanApproval(candidate, { at });
  const next = {
    ...candidate,
    revision: plan.revision + 1,
    phase: plan.phase,
    approval: plan.approval,
    gates: plan.gates,
    blocker: '',
    createdAt: plan.createdAt,
    updatedAt: normalizedTimestamp(at)
  };
  return validateDeliveryPlan(next);
}

function requireCondition(condition, code) {
  if (!condition) throw planError(code);
}

export function transitionDeliveryPlan(value, to, conditions = {}, { at = new Date().toISOString() } = {}) {
  const plan = validateDeliveryPlan(value);
  const target = normalizedInline(to).toLowerCase();
  if (!PHASE_SET.has(target) || !LEGAL_TRANSITIONS[plan.phase].has(target)) {
    throw planError('delivery_plan_transition_invalid');
  }
  if (
    (plan.phase === 'executing' && target !== 'verifying' && !(target === 'planning' && conditions.deliveryRunAborted === true))
    || (plan.phase === 'verifying' && !['executing', 'ready_to_release'].includes(target) && !(target === 'planning' && conditions.deliveryRunAborted === true))
    || (plan.phase === 'ready_to_release' && target !== 'done' && !(target === 'planning' && conditions.deliveryRunAborted === true))
  ) {
    throw planError('delivery_plan_execution_locked');
  }
  if (conditions.expectedRevision !== undefined && Number(conditions.expectedRevision) !== plan.revision) {
    throw planError('delivery_plan_revision_conflict');
  }
  if (target === 'canceled') requireCondition(conditions.confirmation === 'cancel-plan', 'delivery_plan_cancellation_confirmation_required');
  if (target === 'needs_decision' || target === 'blocked') {
    requireCondition(normalizedText(conditions.reason), 'delivery_plan_blocker_required');
  }
  if (target === 'ready_for_approval') requireCondition(lintNormalizedReadiness(plan).ready, 'delivery_plan_not_ready');
  if (target === 'approved') {
    requireCondition(conditions.confirmation === 'approve-plan', 'delivery_plan_approval_confirmation_required');
    requireCondition(lintNormalizedReadiness(plan).ready, 'delivery_plan_not_ready');
  }
  if (target === 'planning' && ['approved', 'executing', 'verifying', 'ready_to_release', 'blocked'].includes(plan.phase)) {
    requireCondition(conditions.confirmation === 'replan', 'delivery_plan_replan_confirmation_required');
  }
  if (target === 'executing') {
    requireCondition(deliveryPlanApprovalStatusUnchecked(plan) === 'current', 'delivery_plan_approval_not_current');
    requireCondition(plan.authority.workspaceWrite, 'delivery_plan_workspace_write_not_approved');
    requireCondition(conditions.baselineCurrent === true, 'delivery_plan_baseline_changed');
    requireCondition(conditions.workspaceAvailable === true, 'delivery_plan_workspace_locked');
    // Exact pane identity is selected and enforced by Mission Queue at the
    // durable dispatch boundary. Entering `executing` means only that the
    // digest-bound task graph and its first durable ensure intent exist.
    requireCondition(conditions.taskGraphReady === true, 'delivery_plan_task_graph_required');
    if (plan.phase === 'approved') requireCondition(conditions.confirmation === 'start-execution', 'delivery_plan_execution_confirmation_required');
    if (plan.phase === 'verifying') {
      requireCondition(conditions.confirmation === 'resume-execution', 'delivery_plan_remediation_confirmation_required');
      requireCondition(conditions.remediationApproved === true, 'delivery_plan_remediation_approval_required');
    }
  }
  if (target === 'verifying') requireCondition(conditions.implementationResultCaptured === true, 'delivery_plan_implementation_evidence_required');
  if (target === 'ready_to_release') requireCondition(conditions.qaPassed === true, 'delivery_plan_qa_pass_required');
  if (target === 'done') {
    requireCondition(conditions.confirmation === 'complete-plan', 'delivery_plan_completion_confirmation_required');
    requireCondition(plan.gates.qaPassed, 'delivery_plan_qa_pass_required');
    if (plan.roles.qa.releaseRequired) requireCondition(conditions.releaseVerified === true, 'delivery_plan_release_verification_required');
  }

  const next = {
    ...plan,
    revision: plan.revision + 1,
    phase: target,
    blocker: ['needs_decision', 'blocked'].includes(target) ? normalizedText(conditions.reason) : '',
    updatedAt: normalizedTimestamp(at)
  };
  if (target === 'approved') {
    next.approval = { digest: deliveryPlanDigest(plan), approvedAt: next.updatedAt, planRevision: next.revision };
  }
  if (target === 'planning' && plan.approval.digest) {
    next.approval = emptyApproval();
    next.gates = emptyGates();
  }
  if (target === 'executing' && plan.phase === 'verifying') {
    next.gates = { ...plan.gates, implementationCaptured: false, qaPassed: false, releaseVerified: false };
  }
  if (target === 'verifying') next.gates = { ...plan.gates, implementationCaptured: true, qaPassed: false, releaseVerified: false };
  if (target === 'ready_to_release') next.gates = { ...plan.gates, qaPassed: true, releaseVerified: false };
  if (target === 'done' && plan.roles.qa.releaseRequired) next.gates = { ...plan.gates, releaseVerified: true };
  return validateDeliveryPlan(next);
}

function bulletList(values, fallback = 'None recorded.') {
  return values.length ? values.map((value) => `- ${value}`).join('\n') : `- ${fallback}`;
}

export function compileDeliveryPlanExecutionEnvelope(value, {
  stepId,
  maxChars = 4000,
  expectedBaseline = null
} = {}) {
  const plan = validateDeliveryPlan(value);
  if (!Number.isInteger(maxChars) || maxChars < 800 || maxChars > MAX.envelope) {
    throw planError('delivery_plan_execution_envelope_limit_invalid');
  }
  if (!['approved', 'executing'].includes(plan.phase)) throw planError('delivery_plan_not_approved_for_execution');
  if (deliveryPlanApprovalStatus(plan) !== 'current') throw planError('delivery_plan_approval_not_current');
  if (!plan.authority.workspaceWrite) throw planError('delivery_plan_workspace_write_not_approved');
  const requestedStepId = normalizedId(stepId);
  const step = plan.roles.dev.steps.find((candidate) => candidate.id === requestedStepId);
  if (!step) throw planError('delivery_plan_step_not_found');
  const requirements = plan.roles.ba.requirements.filter((requirement) => step.requirementIds.includes(requirement.id));
  const criteria = plan.roles.qa.acceptanceCriteria.filter((criterion) => (
    criterion.requirementIds.some((requirementId) => step.requirementIds.includes(requirementId))
  ));
  const digest = deliveryPlanDigest(plan);
  const baseline = expectedBaseline && typeof expectedBaseline === 'object' && !Array.isArray(expectedBaseline)
    ? expectedBaseline
    : plan.baseline;
  const expectedBaselineDigest = expectedBaseline?.digest || canonicalSha256({
    head: baseline.head,
    workingTreeDigest: baseline.workingTreeDigest,
    instructionsDigest: baseline.instructionsDigest
  });
  if (
    typeof baseline.head !== 'string'
    || !baseline.head
    || typeof baseline.workingTreeDigest !== 'string'
    || !DIGEST_PATTERN.test(baseline.workingTreeDigest)
    || typeof baseline.instructionsDigest !== 'string'
    || !DIGEST_PATTERN.test(baseline.instructionsDigest)
    || !DIGEST_PATTERN.test(expectedBaselineDigest)
  ) throw planError('delivery_plan_execution_baseline_invalid');
  const allowed = Object.entries(plan.authority).filter(([, enabled]) => enabled).map(([name]) => name);
  const forbidden = Object.entries(plan.authority).filter(([, enabled]) => !enabled).map(([name]) => name);
  const text = [
    `[PaneFleet Delivery Plan ${plan.id}]`,
    `Approved definition: sha256:${digest}`,
    `Plan revision: ${plan.revision}`,
    `Workspace: ${plan.workspace}`,
    `Expected baseline: sha256:${expectedBaselineDigest}`,
    `Expected HEAD: ${baseline.head}`,
    `Expected working tree: sha256:${baseline.workingTreeDigest}`,
    `Expected instructions: sha256:${baseline.instructionsDigest}`,
    `Outcome: ${plan.roles.po.outcome}`,
    `Current step: ${step.id} — ${step.title}`,
    `Step outcome: ${step.outcome}`,
    'Requirements:',
    bulletList(requirements.map((requirement) => `${requirement.id}: ${requirement.text}`)),
    'Acceptance criteria:',
    bulletList(criteria.map((criterion) => `${criterion.id}: ${criterion.text}`)),
    'Bounded scope:',
    bulletList(step.scopePaths),
    'Required checks:',
    bulletList(step.checks),
    'Non-goals:',
    bulletList(plan.roles.po.nonGoals),
    'Known risks:',
    bulletList(plan.roles.dev.risks),
    `Approved authority: ${allowed.length ? allowed.join(', ') : 'none'}`,
    `Forbidden without a separate explicit approval: ${forbidden.length ? forbidden.join(', ') : 'none'}`,
    `Rollback or safe abort: ${plan.roles.dev.rollback}`,
    'Read the workspace instructions first. Work only on this approved step. Stop if the baseline, exact workspace, scope, or authority differs; do not silently re-plan, broaden scope, deploy, push, message externally, or retry an uncertain action.',
    'When stopping, return exactly one bounded result block:',
    '[PANEFLEET DELIVERY RESULT]',
    `PLAN: ${plan.id}`,
    `DIGEST: ${digest}`,
    `STEP: ${step.id}`,
    'STATUS: complete | blocked | failed | needs_approval',
    'RESULT: concise outcome for this step',
    'FILES: changed paths or none',
    'CHECKS: commands and outcomes or not_run with reason',
    'EVIDENCE: concise observable evidence',
    'RISKS: residual risks or none',
    'NEXT ACTION: operator acceptance, decision, or safe next step',
    '[/PANEFLEET DELIVERY RESULT]'
  ].join('\n');
  if (text.length > maxChars) throw planError('delivery_plan_execution_envelope_too_long');
  return { text, chars: text.length, digest, planId: plan.id, planRevision: plan.revision, stepId: step.id };
}
