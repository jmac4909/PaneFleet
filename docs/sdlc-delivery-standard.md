# SDLC delivery standard

PaneFleet should turn an operator request into a reviewable, testable delivery contract before it turns that request into agent work. This standard defines that contract from product intent through live verification and rollback.

The standard is deliberately generic. PaneFleet owns orchestration, evidence, safety gates, and lifecycle semantics. Each project owns its domain behavior, validation commands, deployment targets, and operating rules.

The key words **must**, **must not**, **should**, and **may** describe required, prohibited, recommended, and optional behavior.

## Goals

The workflow must:

- preserve the operator's requested outcome, constraints, and authorization boundary;
- make Product Owner, Business Analyst, QA, and Developer concerns explicit before implementation;
- distinguish facts, assumptions, decisions, and unresolved questions;
- connect every material requirement to acceptance, verification, implementation, and evidence;
- stop safely when a call fails, an outcome is uncertain, or work leaves the approved scope;
- distinguish local source, published source, a built artifact, a deployed release, and verified live behavior;
- cover security, privacy, dependencies, data changes, deployment, rollback, and operations when relevant; and
- reuse PaneFleet's exact-terminal and no-automatic-resend guarantees instead of creating a second execution mechanism.

It must not:

- treat a submitted prompt or agent report as proof that work is complete;
- infer edit, publish, deploy, restart, ingress, destructive, or external-message authority from a review request;
- retry terminal input or an external mutation whose outcome is uncertain;
- make project-specific production rules part of PaneFleet core;
- rely on a prompt prohibition when a sandbox, credential boundary, allowlist, or named operation can enforce the same restriction; or
- require four separate agents for trivial work merely to satisfy process ceremony.

## Implemented foundation and current boundary

Phase 0's manual standard, Phase 1's durable Planning Pack, and Phase 2's governed local Delivery Run are implemented. Phase 3A adds a separate resource-gated Planning Run for a narrow standard-depth path: read-only PO then BA, independent QA and DEV reports over the same common input, deterministic candidate compilation, and operator-controlled candidate apply.

Planning remains manual for quick or high-risk work and whenever the intent, risk, or authority is outside the Phase 3A eligibility boundary. An eligible `planning` Plan classified standard-depth, `change` or `build`, `local_reversible`, and workspace-write-only may use a durable Planning Run. Planning workers cannot edit or approve the Plan; a deterministic candidate can change only the four role artifacts and unresolved questions, and the operator must apply its exact digest as a new unapproved revision. PaneFleet still does not run planned checks, retain command artifacts, commit, push, release, deploy, mutate a live system, or verify a live result. High-risk overlays and external, release, and live adapters remain future work.

The implementation preserves staged authority. **Start multi-role planning** may send a compiled read-only envelope only to a fresh, server-owned planning worker. **Apply planning candidate** creates an unapproved Plan revision and sends no implementation input. **Approve exact digest** records the reviewed definition, while the later confirmed **Create local execution run** action creates a digest-bound Run and one ready Mission; neither sends terminal input. The operator selects an exact Local Delivery worker and dispatches only from Mission Queue. A structured implementation report is transport-bound evidence, not QA: the operator separately attests every criterion and required check.

Project Desk is not an execution baseline. It reports branch and abbreviated HEAD with `working_tree_status_not_collected`. The baseline-v2 path instead targets an isolated normal checkout, reads pinned Git identity/index metadata, fingerprints raw tracked and untracked bytes, and rejects repository-wide ignored paths and unsafe repository shapes without executing working-tree porcelain, diffs, object filters, or hooks.

## Systemic problems this standard addresses

These are recurring delivery failure classes rather than project-specific incidents.

### Authorization and scope drift

A diagnosis becomes a repair, a review becomes an edit, or a local change becomes a push or deployment without a clear transition. The remedy is to classify the requested action at intake, preserve the authorization source, and place separate gates before materially different mutations.

### Transport confused with completion

A prompt can be rendered, submitted, and accepted while the requested project outcome remains incomplete. Transport evidence may move work to `running`; only requirement-linked verification may move it to `passed`.

### Stale or conflated evidence

Repository state, service state, network state, credentials, and third-party permissions change. Evidence must be timestamped and scoped. A local build is not a push, a push is not a deployment, health is not domain correctness, and old observations are not current verification.

### Unsafe retry and partial success

An external workflow can partly succeed, or a terminal may contain unsubmitted or ambiguously submitted text. Each effect must have its own outcome. Unknown outcomes go to reconciliation; they are never hidden by repeating the whole workflow.

### Worker identity and concurrency loss

Named sessions, panes, branches, and workspaces can be replaced or changed. Execution must bind to intrinsic terminal identity and a captured workspace baseline. Concurrent writers to the same or overlapping workspace are prohibited.

### Weak or misleading validation

Coverage percentages, quiet output, a zero exit status, or a single health response can conceal missing behavior. Quality gates must name the behaviors they prove, preserve failures, and include negative, regression, privacy, security, and live checks as applicable.

### Late security, privacy, and operations work

Authentication, secrets, personal data, dependencies, migrations, deployment interruption, monitoring, and rollback cannot be deferred until after coding. They are conditional but mandatory planning fields.

## Lifecycle

The delivery lifecycle is:

```text
Intake
  -> read-only discovery
  -> product and requirements planning
  -> quality and engineering challenge
  -> plan synthesis and linting
  -> operator review and approval
  -> bounded execution
  -> independent verification
  -> release preparation
  -> separately authorized deployment
  -> live verification or rollback
  -> close and learn
```

Planning must remain read-only. Execution may begin only from an approved, current plan revision.

The current Plan runtime uses `draft`, `planning`, `needs_decision`, `ready_for_approval`, `approved`, `executing`, `verifying`, `ready_to_release`, `blocked`, `done`, and `canceled`. The separate Run uses `preparing`, `active`, `awaiting_verification`, `blocked`, `off_course`, `reconcile_required`, `aborted`, and `verified`. Its ordered task states are `pending`, `mission_linked`, `implementation_captured`, `verified`, `failed`, `off_course`, `reconcile_required`, and `aborted`. An operator-confirmed safe abort terminalizes the Run and returns the Plan to `planning`; `verified` Runs cannot be aborted. These are the implemented Phase 2 names; the simpler model below remains the normative cross-system vocabulary.

The durable model should keep phase and condition separate:

```text
phase:
  intake | discovery | planning | review | approved | execution |
  verification | release_ready | release | closed

condition:
  active | needs_input | blocked | off_course |
  reconcile_required | failed | canceled | aborted
```

Only `active` work may advance normally. A non-active condition records where the work paused and the explicit transition required to continue.

Task execution uses:

```text
pending -> claimed -> running -> awaiting_verification -> passed
                         |              |
                         |              +-> failed
                         +-> needs_input
                         +-> reconcile_required
                         +-> off_course
                         +-> failed
                         +-> canceled
```

An implementation agent may move a task to `awaiting_verification`; it must not mark its own task `passed`.

## Planning depth

All work must consider the same product, analysis, quality, and engineering concerns. The amount of ceremony depends on risk.

| Depth | Appropriate work | Planning method | Approval |
| --- | --- | --- | --- |
| Quick | Read-only answers, bounded reviews, typo-level or one-file reversible changes | One compact planning pass covers all four lenses | Existing exact authorization may be sufficient for a tightly matching local action |
| Standard | Multi-file feature, nontrivial bug, workflow, data-contract, or integration change | PO then BA; QA and DEV independently challenge the result | Approve the integrated plan revision before execution |
| High-risk | Authentication, authorization, sensitive data, payments, migrations, ingress, service control, destructive actions, release, or live operations | Full role reports plus security or operations review | Plan approval plus exact just-in-time mutation or release approval |

The risk classifier must choose the higher depth when uncertain. The operator may lower or raise depth explicitly, but lowering must not remove a safety boundary required by the action itself.

## Pre-execution role contract

The roles are review perspectives. They need not be different people, and they do not vote on facts. Current repository and runtime evidence takes precedence over an agent assertion. A material product decision belongs to the operator.

### Product Owner

The PO owns:

- the problem and intended user outcome;
- value, priority, and success measures;
- in-scope and out-of-scope behavior;
- non-goals and explicit exclusions; and
- unresolved product decisions.

The PO exits with an `OutcomeBrief`. It blocks when the requested outcome or a material tradeoff cannot be inferred safely.

### Business Analyst

The BA owns:

- current-state and proposed-state flows;
- actors, permissions, inputs, outputs, and interfaces;
- functional, nonfunctional, compatibility, and data requirements;
- assumptions and dependencies;
- exceptional and alternate flows; and
- testable acceptance criteria.

The BA exits with a `BehaviorSpec`. It blocks when requirements conflict or cannot be made sufficiently testable.

### Quality Assurance

QA owns:

- risk-based test strategy;
- unit, integration, system, security, privacy, regression, and live checks;
- negative cases, boundaries, concurrency, restart, and recovery cases;
- test data, environment, devices, and manual gates;
- observability and evidence requirements; and
- the independent post-implementation decision.

QA exits with a `QualityContract`. It blocks when a critical behavior has neither executable verification nor an explicitly accepted manual gate.

### Developer

DEV owns:

- feasibility and technical constraints;
- architecture and module boundaries;
- affected files and interfaces;
- dependency, migration, and compatibility impact;
- implementation ordering and workspace concurrency;
- validation commands; and
- technical rollback or safe forward-recovery strategy.

DEV exits with an `EngineeringPlan`. It blocks when the requested outcome is infeasible, unsafe, or materially larger than the product and analysis scope.

### Role ordering and disagreement

For standard and high-risk work, the end-state role workflow is:

1. PO receives the operator request and discovery evidence.
2. BA receives the request, evidence, and PO brief.
3. QA and DEV review the same PO and BA artifacts independently.
4. Synthesis records agreements, contradictions, and decisions without discarding dissent.
5. A deterministic linter evaluates readiness.

QA and DEV do not receive each other's first report in Phase 3A. Disagreement is not resolved by majority: the candidate preserves bounded findings and unresolved decisions for operator review; evidence resolves factual conflict, project policy resolves established rules, and the operator resolves product or risk acceptance. Applying the candidate is not approval. The operator may still author and reconcile all four lenses manually, and must do so outside the narrow automatic eligibility boundary.

## Planning Pack schema

Approved plan content is immutable. Mutable run status and evidence live in a separate execution record so that approval always refers to a stable object.

The schema below is the normative end-state contract. The implemented Plan version 1 persists classification, workspace and compact baseline digests, explicit authority flags, the four role artifacts, `REQ -> STEP -> AC` traceability, readiness findings, revision approval, and idempotent operation receipts. A separate Planning Run store persists the exact source Plan binding, role sequence and input digests, exact worker attempts, bounded schema-validated role reports, deterministic candidate, cleanup/reconciliation state, and apply receipts; reports are not copied into the Plan unless the operator applies that exact candidate. The separate Delivery Run version 1 embeds workspace baseline version 2, persists the approved Plan binding, captured start and step baselines, sequential task state, `mission.ensure` outbox state, Mission bindings, bounded implementation and operator-attestation evidence summaries, verification records, abort state, and local delivery level. The implementation does not yet provide first-class `Risk` or `TestCase` records, full dependency-DAG execution, or retained command artifacts; role prose and operator attestations are not substitutes for those future evidence types.

```js
PlanRecord = {
  schemaVersion: 1,
  id: "plan-...",
  currentRevision: 1,
  revisions: [PlanRevision],
  createdAt: "ISO-8601",
  updatedAt: "ISO-8601"
}

PlanRevision = {
  revision: 1,
  digest: "sha256:...",
  source: {
    requestId: "...",
    requestDigest: "sha256:...",
    requestedActions: [],
    authorizationBasis: [],
    constraints: [],
    requestedOutputs: []
  },
  baseline: {
    workspace: "/absolute/allowed/path",
    capturedAt: "ISO-8601",
    branch: "",
    head: "",
    dirtyFingerprint: "sha256:...",
    changedPaths: [],
    instructionFiles: [{ path: "AGENTS.md", sha256: "..." }],
    projectPolicyDigest: "sha256:...",
    runtimeEvidenceRef: null
  },
  classification: {
    intent: "answer|review|diagnose|change|build|publish|live_operation",
    depth: "quick|standard|high_risk",
    risk: "read_only|local_reversible|external_reversible|live_or_destructive",
    dataClasses: [],
    mutationSurfaces: []
  },
  product: OutcomeBrief,
  analysis: BehaviorSpec,
  requirements: [Requirement],
  acceptanceCriteria: [AcceptanceCriterion],
  risks: [Risk],
  quality: QualityContract,
  engineering: EngineeringPlan,
  operations: OperationsPlan,
  tasks: [ExecutionTask],
  decisions: [Decision],
  roleReports: [RoleReport],
  traceability: TraceabilitySummary
}
```

Canonical JSON serialization and SHA-256 should produce `digest`. Timestamps, runtime status, and approvals must not be included in the approved-content digest.

### Requirement and acceptance schema

```js
Requirement = {
  id: "REQ-001",
  kind: "functional|nonfunctional|constraint",
  priority: "must|should|could",
  statement: "One atomic, testable requirement.",
  rationale: "Why it is needed.",
  sourceRefs: [],
  acceptanceIds: []
}

AcceptanceCriterion = {
  id: "AC-001",
  requirementIds: [],
  given: "Starting conditions",
  when: "One action or event",
  then: "Observable result",
  verification: "automated|manual|inspection|live",
  evidenceTypes: []
}
```

### Risk and test schema

```js
Risk = {
  id: "RISK-001",
  category: "product|security|privacy|data|operational|delivery",
  likelihood: "low|medium|high",
  impact: "low|medium|high|critical",
  scenario: "What can go wrong.",
  mitigation: "How likelihood or impact is reduced.",
  testIds: [],
  approvalGate: null
}

TestCase = {
  id: "TEST-001",
  requirementIds: [],
  acceptanceIds: [],
  level: "unit|integration|system|security|privacy|manual|live",
  setup: "",
  action: "",
  expected: "",
  command: null,
  environment: "",
  evidenceTypes: []
}
```

### Execution task schema

```js
ExecutionTask = {
  id: "TASK-001",
  title: "",
  objective: "",
  workspace: "/absolute/allowed/path",
  dependsOn: [],
  requirementIds: [],
  acceptanceIds: [],
  testIds: [],
  mode: "read_only|workspace_write|external|live",
  allowedPaths: [],
  allowedMutations: [],
  forbiddenActions: [],
  preconditions: [],
  implementationSteps: [],
  validationCommands: [],
  evidenceRequired: [],
  stopConditions: [],
  rollback: null
}
```

An allowlist describes authorization for the task, not a general shell-command endpoint. PaneFleet must continue to expose only named server operations. Workspace-writing agents should also receive the narrowest practical sandbox and credentials.

### Role report schema

```js
RoleReport = {
  role: "po|ba|qa|dev|security|operations",
  status: "complete|needs_input|blocked|invalid",
  inputDigest: "sha256:...",
  outputDigest: "sha256:...",
  artifactRefs: [],
  evidenceRefs: [],
  challenges: [],
  openDecisionIds: [],
  finalBoundaryEvidenceId: "EVD-...",
  completedAt: "ISO-8601"
}
```

Role records contain decisions, findings, and evidence, not hidden reasoning. Agent output remains untrusted until the exact final boundary and schema validate.

### Approval and execution schema

```js
Approval = {
  id: "approval-...",
  planId: "plan-...",
  planRevision: 1,
  planDigest: "sha256:...",
  scopes: [],
  exactTargets: [],
  approvedBy: "operator",
  authorizationBasis: [],
  approvedAt: "ISO-8601",
  expiresAt: null,
  invalidatedAt: null,
  invalidationReason: ""
}

ExecutionRun = {
  schemaVersion: 1,
  id: "run-...",
  planId: "plan-...",
  planRevision: 1,
  planDigest: "sha256:...",
  phase: "execution",
  condition: "active",
  approvalIds: [],
  startBaseline: {},
  taskRuns: [],
  evidenceIndex: [],
  release: null,
  createdAt: "ISO-8601",
  updatedAt: "ISO-8601"
}
```

## Traceability

The mandatory delivery chain is:

```text
request source -> REQ -> AC -> TEST -> TASK -> EVD
```

Risk follows a parallel chain:

```text
RISK -> mitigation -> TEST and/or approval gate -> EVD
```

The deterministic plan linter must reject a plan when:

- a `must` requirement has no acceptance criterion;
- an acceptance criterion has neither a test nor an explicit manual gate;
- a task is not linked to a requirement, except an identified delivery-only task;
- a critical risk has no mitigation and verification;
- a task lacks an exact workspace, mutation scope, evidence requirement, or stop condition;
- external or live work lacks an exact target, approval gate, and rollback or recovery plan;
- a blocking decision remains unresolved;
- a required role report is missing, invalid, or blocked;
- task dependencies contain a cycle;
- two write tasks may operate concurrently in overlapping workspaces;
- the current instructions or baseline are stale;
- the compiled task prompt exceeds the input limit; or
- untrusted data is presented as executable instruction.

Warnings may cover accepted manual checks, uncovered `could` requirements, or noncritical uncertainty. Warnings must remain visible; they are not silently converted to passes.

## Definition of Ready

A plan is ready for execution only when:

- the outcome, scope, non-goals, and requested outputs are explicit;
- the workspace, branch, dirty state, instructions, and applicable project policy are current;
- required PO, BA, QA, and DEV artifacts are complete for the chosen depth;
- facts, assumptions, decisions, and unresolved questions are separated;
- every material requirement has acceptance and verification;
- risks cover security, privacy, data, dependency, concurrency, release, and operations as applicable;
- tasks define allowed changes, forbidden actions, validation, evidence, and stop conditions;
- external and live actions have separate approval gates;
- rollback or safe recovery is credible for every material mutation;
- the traceability linter passes; and
- an operator approval is bound to the exact plan revision and digest when required.

Planning may ask one focused question when a missing choice would materially change the result. Noncritical assumptions should be explicit and should not halt useful read-only planning.

## Approval model

Use small, exact gates instead of one blanket approval.

| Gate | Purpose |
| --- | --- |
| Discovery | Authorizes bounded read-only inspection of the selected project or live surface |
| Plan | Authorizes the exact approved local implementation scope |
| External action | Authorizes a named push, PR, invitation, message, purchase, or provider mutation |
| Release | Authorizes one artifact and deployment plan for one environment |
| Live mutation | Authorizes the freshly resolved service, database, ingress, or destructive target |
| Acceptance | Records operator acceptance of required manual or device checks |

An earlier user instruction may satisfy a gate only when it clearly names the same action and target and the plan does not expand it. High-risk actions require fresh target evidence even when the general intent is already approved.

A material change to goal, scope, requirement, acceptance, allowed mutation, dependency, environment, migration, rollback, or test obligation creates a new plan revision and invalidates the earlier approval. Editorial corrections may preserve approval only when canonical approved content does not change.

For ordinary local work, use two visible gates: **Approve exact digest**, then **Create local execution run**. The first records the reviewed definition; the second rechecks the Plan, baseline, readiness, local-only risk and authority, then creates the Run and one ready Mission without dispatch. Push, deployment, destructive action, ingress, credential, and external communication remain outside the current Run and require separately visible authority.

The current baseline-v2 execution gate supports an isolated conventional checkout whose canonical `.git` directory is inside the repository, owned by the current user, and not group/world-writable, and whose repository has no ignored paths. It rejects sparse checkout/index, linked or outside/untrusted Git directories, gitlinks/submodules, unmerged entries, hidden `assume-unchanged` or `skip-worktree` flags, hardlinks, special files, and unsafe symlink parents or escapes. It fingerprints every index-tracked and untracked file directly from raw bytes. It does not run `git status`, `git diff`, `git hash-object`, repository hooks, or content filters. Modified and untracked files are not categorically rejected, but the supported operational starting point is an isolated execution checkout so later ownership and scope comparison remain unambiguous.

## Execution contract

The complete Planning Pack may be larger than a safe terminal prompt. Compile one bounded execution envelope per task:

```text
[PaneFleet Delivery Plan plan-id]
Approved definition: sha256:<digest>
Plan revision: <revision>
Workspace: <exact path>
Expected baseline: sha256:<digest>
Expected HEAD: <commit>
Expected working tree: sha256:<digest>
Expected instructions: sha256:<digest>
Outcome: <bounded outcome>
Current step: STEP-ID - <title>
Step outcome: <bounded outcome>
Requirements:
- REQ-ID: <requirement>
Acceptance criteria:
- AC-ID: <criterion>
Bounded scope:
- <allowed path>
Required checks:
- <planned check>
Approved authority: workspaceWrite
Forbidden without a separate explicit approval: <authority list>
Rollback or safe abort: <plan text>
<fixed stop instruction>
[PANEFLEET DELIVERY RESULT]
PLAN: plan-id
DIGEST: <digest>
STEP: STEP-ID
STATUS: complete | blocked | failed | needs_approval
RESULT: <concise outcome>
FILES: <changed paths or none>
CHECKS: <commands and outcomes or not_run with reason>
EVIDENCE: <concise observable evidence>
RISKS: <residual risks or none>
NEXT ACTION: <operator acceptance, decision, or safe next step>
[/PANEFLEET DELIVERY RESULT]
```

Execution must retain the existing PaneFleet properties:

- exact session and pane identity;
- one serialized input path per pane;
- a durable claim before terminal input;
- workspace conflict locks;
- no automatic retry of uncertain input;
- startup reconciliation rather than resend; and
- a separate verification gate after the worker reports completion.

The implemented Run store links each current task to an existing Mission Queue item instead of duplicating terminal-delivery state. The Mission Queue owns worker selection, exact-pane dispatch, transport evidence, workspace locks, and uncertain-delivery recovery. The SDLC layer owns why the task exists, its approved path and baseline boundary, bounded implementation summaries, and operator acceptance.

A bound Mission accepts only a server-attested `local_delivery` worker: exact workspace, Codex `workspace-write`, approval policy `never`, outbound sandbox network disabled, and none of `--yolo`, sandbox bypass, search, or danger-full-access. The tmux identity is session name/creation time, pane coordinate, intrinsic tmux pane ID, and pane PID. The additional Codex identity is PID, rollout ID, rollout-source ID, and foreground-command digest. Dispatch persists the rollout file's byte size as `rolloutStartOffset`; supervision accepts only a complete structured final answer after that offset and exact dispatch marker in the same rollout with matching sandbox/approval authority and no observed network contradiction. If the rollout omits network authority, the pinned launch argument remains the proof. Replacement, ambiguous ownership, or contradictory authority stops the Mission for review.

Phase 2 does not claim independent QA. For every linked criterion the operator supplies Passed, Failed, or Not run, manual or command method, and a required observation; every required check on that DEV step separately receives Passed, Failed, or Not run and a required observation. PaneFleet creates bounded operator evidence summaries and the verifier record is explicitly `{ kind: "operator" }`. It neither executes the check nor retains its raw output. QA `releaseChecks` remain planning data for a later separately authorized release workflow; they are not executed by the local Run.

## Failure and retry policy

Every call must have a normalized outcome:

```text
not_started | proven_not_applied | applied | outcome_unknown | failed
```

Do not reduce all failures to a boolean or infer success from reassuring text.

| Operation | Automatic behavior |
| --- | --- |
| Read-only idempotent query | At most two bounded retries with jitter; honor provider backoff |
| Planning output with invalid schema | One repair request only after confirmed completion and unchanged identity |
| Deterministic build, lint, or test failure | No blind retry; preserve and diagnose the first failure |
| Suspected flaky check | One reasoned rerun; keep the original failure in evidence |
| Terminal text, Enter, or acceptance with uncertain outcome | Never retry; require reconciliation |
| External mutation with an idempotency key | Read back authoritative state; retry only when proven unapplied |
| External mutation without idempotency | Never retry automatically; require reconciliation |
| Authentication or authorization failure | Stop and record the missing capability |
| Persistence failure after a proven external effect | Retry persistence only; never repeat the effect |
| Agent crash | Resume only the exact registered rollout, sequentially and behind resource gates; never replay the prompt |
| Rate limit or provider outage | Honor `Retry-After`, cap attempts, and open a circuit breaker |
| Operator-confirmed local Run abort | Refuse an active or uncertain worker; when safe, terminalize the Run and reconcile Mission cancellation plus Plan-to-`planning` without input or signals |

A partial workflow must report each irreversible outcome separately. For example, a successful push followed by a failed PR call is `push=applied, pr=failed`; it is not an all-or-nothing failure and must not trigger another push.

The end state should retain test output in an owner-only evidence artifact before producing a bounded UI summary. A truncated summary must not hide the failed test name or convert a failed suite into an apparent coverage result. Phase 2 does not yet provide that artifact store: the operator must inspect the actual check output elsewhere and describe the review in the acceptance note.

## Off-course handling

Work is off course when:

- the approved plan revision or digest no longer matches;
- relevant instructions, project policy, branch, or initial baseline changed unexpectedly;
- another writer changes the same or an overlapping workspace;
- new changes appear outside the task's allowed paths;
- a task discovers a new dependency, secret, migration, external integration, or live operation;
- an agent attempts an explicitly forbidden action;
- implementation requires a material product or architecture change;
- exact terminal or runtime identity changes; or
- the operator replaces or materially amends the request.

PaneFleet must then:

1. stop dispatching later tasks;
2. avoid interrupting the current terminal merely to enforce workflow state;
3. avoid automatic cleanup, reset, revert, or deletion;
4. capture a bounded diff and evidence references;
5. mark the run `off_course` or `reconcile_required`;
6. explain the deviation and propose a plan amendment; and
7. require approval of the new digest before continuing.

Phase 2 enforces part of this policy by rejecting stale Plan/baseline bindings, changed repository identity, HEAD/branch, index or hidden index flags, ignored-scope or approved-scope coverage, changed instructions, empty implementations, and out-of-scope paths with typed errors before capture or verification. Although the Run domain defines an `off_course` condition, those route-level drift rejections do not yet persist a new `off_course` record automatically. The operator must preserve the workspace and re-plan or reconcile deliberately; complete durable deviation capture is still future work.

Do not clean, reset, or delete another user's files to make a workspace eligible. Use an isolated normal execution checkout with no ignored paths. If ordinary modified or untracked files are present, baseline v2 fingerprints their raw bytes individually and later treats them as changed only when their fingerprints differ; the capture path does not categorically reject them or run Git working-tree porcelain.

An operator may instead choose **Abort local delivery run** for any nonterminal, unverified Run after every linked Mission is safely ready, verifying, or terminal. Dispatching, running, input-waiting, or uncertain Missions block abort until separately recovered. A successful abort records a required reason and operator review evidence, preserves already verified tasks, marks remaining tasks and pending outbox work aborted/canceled, cancels safe ready or verifying Missions, terminalizes the Run as `aborted`, and returns the Plan to `planning`. It sends no terminal input or process signal. Cross-store failure is exposed as reconciliation; startup may finish only the durable Mission/Plan transition.

## Definition of Done

Implementation is done only when:

- every required task is independently verified;
- all `must` requirements and acceptance criteria have passing evidence;
- required negative, regression, security, privacy, restart, and recovery checks pass;
- the final diff stays within the approved scope and preserves pre-existing work;
- dependencies, generated artifacts, documentation, and compatibility obligations are accounted for;
- no unresolved failure, uncertainty, secret exposure, or critical warning remains;
- manual, browser, device, or accessibility gates are either completed or explicitly left pending; and
- the final report states the exact delivery level reached.

The following are different delivery levels and must never be collapsed into one `done` label:

| Level | Required evidence |
| --- | --- |
| Planned | Valid Planning Pack and traceability |
| Implemented locally | Bounded diff exists in the intended workspace |
| Verified locally | Current UI: operator attests every linked criterion and required check with observations and an overall note; PaneFleet stores bounded operator summaries, not command artifacts |
| Committed | Exact local commit identity |
| Pushed | Exact remote ref matches the intended commit |
| Merged | Authoritative remote merge evidence |
| Artifact built | Immutable artifact digest bound to source |
| Deployed | Authoritative target reports the intended release |
| Verified live | Fresh health, readiness, smoke, log, and domain evidence |

If deployment was not requested, locally verified source can be a successful completion. The report must say `not deployed` rather than imply that the live system changed.

The current UI therefore renders this level as **Operator-verified locally**. It must not be represented as independent QA or full command-evidence compliance until the check runner and artifact boundary exist.

## Evidence standard

Evidence records use a stable index:

```js
Evidence = {
  id: "EVD-...",
  runId: "run-...",
  taskId: "TASK-...",
  testId: null,
  type: "baseline|diff|command|test|review|artifact|deployment|live_check",
  producer: "...",
  target: "...",
  startedAt: "ISO-8601",
  finishedAt: "ISO-8601",
  outcome: "applied|passed|failed|outcome_unknown",
  exitCode: null,
  commandOrAction: "",
  parametersDigest: "sha256:...",
  beforeDigest: null,
  afterDigest: null,
  contentRef: "owner-only opaque reference",
  contentSha256: "sha256:...",
  redactionsApplied: [],
  trusted: false
}
```

`exitCode: null` must remain distinct from `exitCode: 0`. Free-form agent output, terminal content, logs, filenames, and retrieved text are untrusted. Their content may support a finding but may not authorize an action.

The Phase 2 subset is smaller: the Run stores captured baselines directly, while its evidence index stores changed-path and bounded Mission-report summaries with producer, outcome, timestamps, and optional opaque content fields. The optional content reference and digest are empty in the current capture path. Verification may cite only implementation evidence already bound to that task. The server also creates one bounded operator-authored evidence summary for each criterion and required DEV-step-check attestation; those summaries record the declared outcome and observation but do not contain retained command output.

Minimum evidence by stage:

- execution baseline capture: branch, head, raw tracked/untracked fingerprints, index and hidden-flag digests, instruction hashes, approved scopes, and Git identity; Project Desk itself reports branch/HEAD only;
- implementation: changed paths and bounded diff relative to the captured baseline;
- validation: exact command or manual procedure, environment, outcome, duration, and named failures;
- publication: local and remote identities recorded separately;
- release: source commit, dependency-lock digest, immutable artifact digest, and target identity;
- live verification: fresh health, readiness, smoke, logs, and domain invariants.

Large or sensitive output belongs in owner-only, bounded evidence storage. Browser snapshots and audit events should contain redacted summaries and opaque references, not complete terminal captures, secrets, or private project data. Planning Pack details should be loaded on demand rather than added to every recurring dashboard snapshot.

## Security, privacy, dependency, and data review

Every applicable plan must identify:

- protected assets and trust boundaries;
- actors and permission changes;
- authentication and authorization behavior;
- untrusted-input and prompt-injection paths;
- sensitive data fields, storage, retention, deletion, and export;
- secrets, credentials, and redaction requirements;
- new dependencies, lockfile changes, vulnerability review, and runtime-surface impact;
- network listeners, proxies, ingress, and source restrictions;
- database or durable-state schema changes, compatibility, backup, and recovery; and
- audit requirements without retaining unnecessary sensitive content.

Future planning workers must be read-only with approvals disabled. Phase 2 implementation Missions require the server-verified Local Delivery profile: a `workspace-write` Codex sandbox, approval policy `never`, outbound sandbox network disabled, no `--yolo`, sandbox bypass, search, or danger-full-access flag, no contradictory available telemetry, and an exact Run-workspace match. Dispatch also pins the exact tmux and Codex rollout identities plus a pre-input rollout byte offset. Plan authority still does not prove host credential isolation, provide OS-enforced per-approved-path writes, or prevent every local executable effect; external and live credentials should be unavailable to source-writing workers wherever the host setup permits that separation.

## Release and rollback standard

Release preparation requires:

```js
OperationsPlan = {
  environment: "",
  targetIdentity: "",
  sourceCommit: "",
  artifactManifest: {
    releaseId: "",
    artifactSha256: "",
    sourceSha: "",
    buildCommand: "",
    dependencyLockDigest: ""
  },
  preflightChecks: [],
  migration: {
    required: false,
    compatibility: "",
    backup: "",
    rollbackOrForwardFix: ""
  },
  deploySteps: [],
  expectedInterruption: "",
  healthChecks: [],
  readinessChecks: [],
  smokeChecks: [],
  domainChecks: [],
  observabilityChecks: [],
  rollbackTarget: "",
  rollbackSteps: [],
  rollbackTriggers: [],
  observationWindow: "",
  cleanupAfterObservation: []
}
```

The release gate must:

- freshly resolve the live target before mutation;
- bind approval to the artifact manifest and exact environment;
- prove artifact-to-source identity;
- verify data compatibility and backup semantics;
- retain rollback until the observation window passes;
- state expected interruption honestly;
- verify health, readiness, smoke, logs, and domain behavior; and
- roll back or stop for review when an explicit trigger occurs.

Rollback-safe does not mean zero-downtime. A backup is not an automatic restore. A healthy process is not proof that the intended release or domain behavior is correct.

## Project-policy isolation

PaneFleet core defines generic concepts:

- planning and execution states;
- role and artifact schemas;
- traceability and approval rules;
- retry and uncertainty behavior;
- evidence and redaction requirements;
- exact-terminal execution; and
- generic release and rollback gates.

Project-owned policy defines:

- domain invariants and terminology;
- validation, build, packaging, and release commands;
- environment names and deployment targets;
- migration and rollback procedures;
- sensitive-data classification;
- manual, browser, device, and operational checks; and
- project-specific forbidden actions.

Publicly safe, stable project policy may live in that project's repository, for example `.panefleet/sdlc.json` or its existing instruction files. Machine-local targets, credentials, private URLs, network sources, and service authority remain in ignored host configuration. PaneFleet must not acquire hard-coded production rules for any particular application.

Discovered scripts and files grant no execution authority. A project policy entry identifies an eligible named check or operation; the approved plan and current server-side allowlist still govern whether it may run.

## Persistence and implementation constraints

The implemented Phase 2 SDLC layer follows PaneFleet's existing architecture:

- Node built-ins and deterministic validators;
- canonical JSON and `node:crypto` SHA-256;
- atomic owner-only persistence;
- optimistic revision checks and serialized mutations;
- exact terminal identity and existing Mission Queue delivery;
- bounded prompts, reports, events, and evidence summaries;
- lazy detail APIs instead of larger recurring snapshots;
- named server operations instead of arbitrary shell execution; and
- startup reconciliation that repairs only durable links without replaying input.

The current domain modules are:

```text
delivery-plan.js
delivery-plan-store.js
delivery-run.js
delivery-run-store.js
workspace-baseline.js
```

`server.js` integrates those domains with the existing Mission Queue and `public/app.js` supplies the operator UI. Plan, Run, and Mission records remain in separate owner-only files; the Plan and Run stores must be backed up and restored together. A Run's durable `mission.ensure` outbox permits explicit and startup reconciliation of a missing or uncertain cross-store link without selecting a worker, dispatching, resending, or retrying terminal input. Abort reconciliation likewise finishes only safe Mission cancellation and the Plan-to-`planning` transition; it never controls the worker.

## Phased rollout

### Phase 0: standard and manual contract — complete

The standard and manual Planning Pack practice are established. This phase changed no live behavior.

This phase must not:

- migrate a durable store;
- spawn new planning agents;
- change prompt dispatch or recovery;
- restart PaneFleet;
- add automatic execution; or
- add project-specific production policy to this repository.

These prohibitions remain useful when applying the standard manually in another project or dirty shared checkout.

### Phase 1: read-only Planning Pack MVP — complete

The implemented slice includes:

- strict schema and state validators in a new module;
- canonical plan revision digests;
- owner-only atomic plan storage separate from Mission Queue state;
- operator-triggered capture of the current Git workspace and applicable instruction baseline;
- a compact four-lens form or one verified planning response;
- a deterministic traceability and Definition-of-Ready linter;
- a plan review screen with unresolved decisions and warnings; and
- lazy plan details outside the main recurring snapshot.

Plan creation, edit, review, and approval still have no automatic role spawning, Mission creation, workspace write, or live action. They establish the contract, storage, UI, revision, privacy, and restart boundary before the separate Phase 2 Run gate.

### Phase 2: governed local execution through the existing Mission Queue — complete

The current implementation provides:

- separate **Approve exact digest** and confirmed **Create local execution run** gates;
- one bounded execution envelope per task;
- a separate digest-bound Run with sequential task state and a durable `mission.ensure` outbox;
- just-in-time links from the current task to one ready existing Mission item, with no dispatch from the Run controls;
- baseline-v2 raw-byte, repository-shape, and allowed-path checks between tasks;
- bounded changed-path and worker-report summaries;
- criterion-by-criterion and required DEV-step-check operator attestations with required observations and an overall note;
- an operator-confirmed safe abort that terminalizes the Run and returns the Plan to `planning` without worker input or signals; and
- visible local-source delivery levels.

Execution remains one writer per overlapping workspace. Dispatch, exact-pane identity, uncertainty, and terminal recovery stay owned by the existing Mission Queue. Run reconciliation repairs only the durable Plan/Run/Mission link and never dispatches or retries terminal input. Phase 2 records `planned`, `implemented_locally`, and operator-attested `verified_locally`; it does not run checks or retain command artifacts. `ready_to_release` is lifecycle-only. Commit, push, release, deployment, service, network, destructive, external-message, and live actions are not Phase 2 capabilities.

Phase 2 also has no generic Run retry, remediation, archive, or retention operation. Its abort is a specific terminal transition, not worker cancellation or remediation: active/uncertain Missions block it, safe bound Missions are canceled, and the Plan must be edited and re-approved before replacement work. Failed, off-course, and aborted Runs remain durable. The Run store fails closed at 64 Runs or 512 operation receipts until a reviewed migration or later retention mechanism is used.

### Phase 3A: narrow multi-role planning orchestration — current

The implemented slice provides:

- a separate durable Planning Run bound to the current Plan revision, digest, workspace, and baseline;
- eligibility limited to a planning-phase, standard-depth, local-reversible `change` or `build` with `workspaceWrite` as the sole enabled authority;
- sequential PO and BA followed by independent QA and DEV reports over the same PO-plus-BA input;
- fresh hidden Codex sessions from a dedicated owner-only home and neutral non-project context, with a minimal-read/root-deny/network-disabled permission profile, approval policy `never`, disabled callable tools and hooks, and exact pane/executable/process/environment/config/model/rollout/offset/input-digest binding;
- at most two planning workers, with stricter memory availability for the second plus disk and Linux memory-pressure gates;
- exact final-answer and schema validation with no terminal-transcript or raw-prompt API exposure;
- durable crash, resource-wait, needs-input, cleanup, off-course, and reconciliation conditions with no automatic retry of uncertain input, plus exact idempotent `resource_retry` and `cleanup_only` continuation receipts;
- a deterministic candidate limited to `roles` and `unresolvedQuestions`; and
- an explicit digest-confirmed operator Apply that creates a new unapproved Plan revision and performs no execution.

PO completes before BA. QA and DEV receive neither each other's first report nor authority to inspect or alter the selected workspace; they analyze the hash-bound Planning envelope in trusted Codex platform context with user/project configuration and callable tools removed. Server startup may inspect and reconcile persisted attempts but never creates a new role session or types a new envelope; a safe explicit continuation owns that boundary. A Planning Run cannot approve a Plan, create a Delivery Run or Mission, commit, push, deploy, or perform a live or external action.

Phase 3A deliberately omits automatic quick/high-risk planning, schema-repair turns, security and operations overlays, open-ended discussion with role workers, and automated resolution of disagreements. Those cases return to operator-authored planning or a later reviewed phase.

### Phase 4: external, release, and live adapters

Only after source execution and verification are reliable, add generic named adapters for:

- capability preflight;
- commit, push, and PR evidence;
- immutable release manifests;
- exact deployment-target resolution;
- migrations, backup, rollback, and observation windows; and
- live health, readiness, smoke, log, and domain verification.

Each adapter needs an idempotency and reconciliation contract. No adapter may introduce arbitrary command execution or application-specific production behavior into PaneFleet core.

### Phase 5: measured policy automation

Consider one-click or standing-policy automation only after evidence shows low rates of off-course work, reconciliation, rework, and escaped defects. Live, destructive, credential, ingress, financial, and external-communication actions should retain exact human gates.

## Required implementation tests

Before each phase is enabled, test the new behavior at its actual boundary:

- every legal and illegal lifecycle transition;
- canonical digest stability and approval invalidation;
- complete and orphaned traceability graphs;
- malformed, truncated, duplicated, stale, and adversarial role reports;
- planning-role read-only enforcement;
- uncertain input with zero resend;
- external partial success and authoritative reconciliation;
- baseline-v2 raw-byte capture, ignored/sparse/gitlink/hidden-index rejection, and modified or untracked files versus newly off-scope changes;
- concurrent or replacement workers;
- overlapping workspace locks;
- restart reconciliation;
- operator-confirmed abort, active-worker refusal, safe Mission cancellation, and abort-to-planning restart reconciliation;
- retained named failures despite bounded display output;
- secret and private-data redaction;
- source, artifact, target, and rollback identity mismatch;
- project-policy isolation; and
- mobile and desktop review, approval, exception, and evidence flows.

Repository-wide validation and privacy checks remain required. Static assertions alone do not replace real browser, device, service, or live-environment verification when the acceptance contract calls for those surfaces.

## Operational learning

Closing a run should produce a compact, reviewable record:

- requirements passed or waived;
- first-pass verification result;
- retries by class;
- off-course or reconciliation events;
- defects found before and after release;
- rollback or recovery use;
- manual gates left open; and
- one proposed improvement to a generic standard or the owning project's policy.

Useful trend measures include first-pass verification rate, escaped defects, unauthorized-action attempts, uncertain-call frequency, flaky-check frequency, rework loops, rollback rate, and time spent waiting on missing decisions. Metrics should improve decisions, not reward larger plans or more agent activity.

Learning does not silently rewrite this standard, project instructions, or durable memory. A proposed change receives the same review and approval discipline as other maintained behavior.
