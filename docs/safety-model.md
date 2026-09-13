# Safety model

PaneFleet is privileged operator software. Its design assumes that observation is common, mutation is narrow, and ambiguous terminal state must fail toward human review.

## Assets to protect

- terminal input and exact worker ownership;
- live tmux sessions and workload processes;
- queued prompts, planning-role reports, delivery state, and audit history;
- workspace files and generated artifacts;
- service commands and credentials available to the host user;
- network access rules; and
- the availability of the control plane itself.

## Trust assumptions

PaneFleet assumes:

- one trusted operator controls the browser, host account, and workload tmux server;
- every other process running under PaneFleet's Unix UID is trusted, including with respect to Planning executable and runtime-directory races;
- the dashboard is reached through loopback, HTTPS, or a private/tunneled transport with tightly restricted ingress;
- the host operating system and explicitly configured command-line tools are trusted;
- `services.json` and `host-config.json` are reviewed machine-local configuration; and
- terminal output, project instructions, logs, filenames, and agent-authored status reports are untrusted data.

PaneFleet authenticates one shared operator on non-loopback listeners by default. A secure loopback-proxy deployment may instead use a persistent device session after a normal form login. An explicit trusted-network deployment may delegate that first boundary to independently verified exact-source ingress. PaneFleet does not identify several people or assign roles.

Owner-only Planning stores and private runtime directories restrict other Unix users, not hostile same-UID code. The installer pin, server-side file SHA-256, and pre-input `/proc/<pid>/exe` image attestation detect drift and accidental binary upgrades, but cannot defend against a malicious same-UID process racing or replacing paths. Runtime deliberately invokes neither `--version` nor `mcp list`; the installer verifies version and SHA, while the server hashes the configured file and attests the running image. A root-owned immutable executable or launch from a held verified file descriptor would be a stronger future boundary.

## Authentication layers

PaneFleet applies separate transport, listener, and request controls:

1. **Transport and network** — loopback, an SSH/private tunnel, or HTTPS plus restricted ingress limits who can reach the service.
2. **Operator authentication** — by default, any non-loopback bind requires HTTP Basic username `host-control` and an operator token of at least 24 characters. A secure loopback proxy may use `device-session`, where a normal form verifies an owner-only bcrypt hash and issues a Secure, HttpOnly, SameSite=Lax 30-day device cookie. Lax permits only safe top-level cross-site entry; it does not send this cookie on a cross-site POST. A deliberate `trusted-network` override may delegate this layer to externally enforced exact-source ingress. Loopback remains frictionless unless `device-session` is explicitly selected.
3. **Same-page control session** — loading the authenticated app issues a separate HttpOnly, SameSite=Strict cookie. Every operational `/api` route requires that current cookie. `/healthz` is the only intentionally minimal public endpoint.
4. **Mutation checks** — POST requests additionally require JSON and same-origin request checks.

When the authenticated non-loopback mode needs a Basic credential and no token is injected through `ORCHESTRATOR_ACCESS_TOKEN`, PaneFleet creates and reuses a random owner-only `data/access-token`. The server reads that credential through one nonblocking, no-follow file descriptor and requires a regular file owned by the current user with mode `0400` or `0600` and valid contents before listening. Trusted-network mode does not create or use a Basic token. The local `scripts/show-access-token.sh` helper opens the file once, verifies that its descriptor still matches the inspected path, and validates and reads that descriptor before revealing the token.

HTTP Basic provides no transport encryption. It must be used only through HTTPS or a private/tunneled transport. HTTPS deployments should set `ORCHESTRATOR_SECURE_COOKIE=1` so the control-session cookie is marked `Secure`.

Device-session mode is intentionally limited to the secure loopback-proxy shape in production. Its credential file must be an owner-only regular file with bcrypt cost 10 through 16. Its durable session store contains token hashes and timestamps, never raw bearer tokens, passwords, IP addresses, or user agents. Five failed attempts from one trusted proxy address produce a 15-minute in-memory lockout. Deleting or editing these private stores is an operator recovery action, not a browser capability.

The device login validates the normalized trusted external origin rather than the raw proxy `Host` text, so equivalent default-port authorities remain equivalent. A browser-standard opaque `Origin: null` is tolerated only on the password-gated login and only with `Sec-Fetch-Site: same-origin`. Cross-site login metadata and all opaque or mismatched operational API mutations remain rejected; do not broaden this compatibility exception to `validateMutationRequest`.

## Read and mutation boundary

Read-only discovery can report tmux sessions, panes, listeners, processes, bounded Git identity, and registered services. Project Desk reports branch and abbreviated HEAD but deliberately does not collect working-tree status. The stricter raw-byte Git workspace baseline is a separate, explicit Planning Pack and Delivery Run operation. Mutation is limited to named API operations with server-side validation.

There is no endpoint that accepts an arbitrary shell command or filesystem path. Service actions are loaded from `services.json` at startup. The registry rejects malformed actions, requires every action to be explicitly safe or confirmed, and requires confirmation for tmux-backed and public-IP actions.

All operational API reads and writes require the current control cookie. Mutating requests also require JSON and origin checks when the browser supplies an Origin header. Response headers apply a self-only content security policy and deny framing, cross-origin resource use, referrers, and unnecessary browser permissions.

## Exact terminal identity

A visible pane coordinate alone is not durable because a tmux window or pane can be replaced. Sensitive actions therefore bind to:

1. tmux session name and creation time;
2. window and pane coordinate;
3. intrinsic tmux pane ID; and
4. pane PID.

PaneFleet re-queries tmux and compares that identity immediately before sensitive input. A mismatch fails closed. Input is serialized per pane so simultaneous browser windows cannot merge prompts or keys.

## Agent Commons boundary

- Commons messages are untrusted collaboration data. A post, reply, acknowledgement, wait, work claim, help request, lesson, Ping, Nudge, or Stop request grants no terminal, service, network, deployment, filesystem, external-message, or other mutation authority.
- The Commons browser API uses the ordinary operator control cookie, JSON requirement, and same-origin mutation check. Body, evidence, and the complete serialized request are rejected when they contain hidden control characters or secret-like values. Audit entries record identifiers and classifications, never message text.
- Agent writes use an owner-only immutable spool envelope. The server accepts one only while its claimed session creation time, intrinsic pane ID, and pane PID match a currently live Codex pane, and each operation receipt is bound to the normalized action, actor, and request digest. Changed receipt reuse conflicts; a crash after durable commit can replay the same receipt without duplicating the message.
- Same-UID code can inspect or imitate other same-UID processes, so the pane match provides live-pane-bound provenance rather than cryptographic authorship. Independent-first reply withholding is likewise a normal-inbox behavior, not an isolation claim. This limitation is acceptable only because Commons content never authorizes execution.
- **Board** and **Ping** are passive. **Nudge** asks for the next safe checkpoint. **Stop request** means urgent operator review and may justify a separate manual interrupt when continued work risks harm, cost, data loss, or the wrong target. No attention mode sends `Esc`, `Ctrl-C`, Enter, a signal, or an automatic retry. **Review terminal** only navigates to the exact terminal.
- A Help request first offers an idle compatible existing agent; reviewing that suggestion sends no terminal input. Creating a helper requires a separate same-origin operator click in the New Agent launcher. Agents do not receive that browser credential.
- Each request maps to one deterministic helper identity. The create path revalidates the open request revision, exact allowed workspace, helper name, systemd-user isolation, root disk below 90%, recovery memory/swap/PSI gates, and workload tmux isolation. It ignores browser-supplied helper prompt text, disables auto-recovery, and never retries uncertain input. A live deterministic session blocks another launch.
- A helper is instructed not to spawn or delegate, and a Help request authored by a `codex-commons-helper-*` session cannot qualify a new helper. Accepted initial input proves transport only: the request remains open until its reported outcome is reviewed and explicitly resolved or withdrawn.
- Lessons remain scoped and reversible. An agent may report that its own lesson was tried, disputed, or retired, but only the operator may promote it to supported or active. Replacing a lesson retires its predecessor without deleting history.

## Normal prompt delivery

Normal agent input behaves like terminal typing:

1. revalidate the target and Codex process;
2. arm per-pane exit preservation and revalidate the same intrinsic pane identity;
3. type literal text in bounded chunks;
4. revalidate between chunks and before submission;
5. confirm stable rendering with paired markers when the workflow requires it;
6. send one Enter; and
7. observe stable evidence that Codex accepted the submission.

PaneFleet does not use normal dispatch to send `Ctrl-C`, respawn a pane, kill a session, signal a process, or switch a tmux client. Those recovery actions remain separate and visibly confirmed.

If text rendering or acceptance cannot be proven, PaneFleet records an uncertain state and does not retry Enter. This can leave text visible but unsubmitted; the operator must inspect the exact terminal.

## Planning Pack, Planning Run, and local Delivery Run invariants

- A Planning Pack is planning data, not terminal or live authority.
- The server validates a bounded known schema and computes the canonical definition digest; it never accepts a client-supplied digest as proof.
- Product outcome, requirements, implementation scope, acceptance criteria, authority, baseline identity, and unresolved questions are explicit and traceable before approval.
- Approval binds to the current definition digest and optimistic revisions. A material definition edit invalidates it.
- Repeating the same durable operation ID with the same request returns the original result. Reusing that ID for different content fails closed.
- Only capped Plan, Planning Run, and Delivery Run summaries enter recurring snapshots. Full role artifacts, role reports, candidate changes, worker identities, task state, evidence summaries, and verification records require a separate authenticated detail read. Raw planning prompts and terminal transcripts are not exposed by this surface.
- Creating, editing, reviewing, applying a planning candidate, and approving a Plan never creates a Delivery Run or Mission, writes the selected project workspace, or performs an external or live operation. Candidate apply creates an unapproved Plan revision.
- Automatic Planning Runs accept only a current `planning` Plan classified standard-depth, `change` or `build`, `local_reversible`, with `workspaceWrite` as its sole authority. Other depths, risks, intents, and authority shapes remain manual.
- A Planning Run is bound to the exact source Plan revision, digest, workspace, and baseline. PO completes before BA; QA and DEV receive the same PO-plus-BA input independently and cannot see each other's first report.
- Each role attempt uses the installer-pinned canonical native Codex 0.147.0 executable, exact version, and SHA-256. Scripts, symlinks, insecure or unexpected files, architecture/version mismatch, and runtime content drift fail closed with no `PATH` or New Agent launcher fallback.
- Before tmux creation, each attempt durably binds a deterministic provisional spawn lease to the Run, role, attempt, internal session, context and launch digests, exact transient scope, scope-policy digest, and deadline. Only an on-time exact-pane observation can adopt that lease into a normal worker. A late, replaced, ambiguous, or unattestable observation cannot authorize prompt input.
- Each adopted role attempt uses a fresh, hidden PaneFleet session and the exact compiled envelope. The server revalidates intrinsic pane identity, foreground Codex executable/PID/arguments, sanitized environment, dedicated-home configuration digest, neutral context, concrete model, minimal permission profile, approval policy `never`, rollout identity/root and byte offset before every literal chunk and Enter. The profile denies the filesystem root, grants no selected-project root, disables command network, and removes callable shell, code, app, plugin, MCP, memory, browser, image, and subagent surfaces. User/project Codex configuration and instructions are absent; contradictory authority or a nonempty MCP inventory fails closed.
- Planning reports are accepted only from the exact rollout's later final answer and must match the Run, Plan, revision, role, attempt, and input digest. Project files, terminal text, and report content remain untrusted data; reports grant no mutation authority.
- The deterministic planning compiler may propose only the four role artifacts and unresolved questions. Applying the exact candidate digest is an explicit optimistic operation; it is not approval and cannot start execution.
- Resource pressure, a missing or replaced worker, invalid or ambiguous output, uncertain input, or cleanup failure pauses durably. No uncertain terminal input is retried. `resource_retry` and `cleanup_only` continuation authority is persisted with the exact Run revision and intent before a spawn or cleanup input; an identical operation replays its receipt, while a changed request conflicts. Startup may reconcile existing records and workers but must not create a new planning session or type; explicit continuation is required before new input.
- An unresolved provisional lease blocks role advancement, candidate apply, and cancel. When exact absence is proven, PaneFleet can close it without external action. When only the durably bound exact transient Planning scope is proven active and process/rollout identity was never established, the browser may expose a separate **Terminate stuck planning worker** action only from exact server capability `canTerminateExactScope === true`. Its confirmed operation claims one `stop_exact_scope`, issues at most one `systemctl stop`, never reuses Continue, never automatically replays after an uncertain response, and exposes no lease/session/scope identifiers. Unknown, ambiguous, or replaced inventory remains fail-closed.
- Planning scopes enforce the immutable resource profile plus `RuntimeMaxSec=30min`, `TimeoutStopSec=30s`, `KillMode=control-group`, SIGTERM followed by systemd's configured final SIGKILL. Cleanup is complete only after the exact scope and pane are absent; a claimed or sent stop remains unresolved.
- At most one Planning Run is nonterminal. Before creation, its owner-only store reserves the worst-case bounded operation and exact pretty-serialized byte headroom for role completion, cleanup recovery, Continue receipts, apply reconciliation, cancel, and replay. Source Plans and role reports are each capped at 16 KiB and the current Run at 256 KiB; exhaustion therefore rejects before a worker is created rather than stranding cleanup.
- Approval and Run creation are separate confirmed operations. A local Run requires a current approved digest, a matching captured baseline, ready traceability, `change` or `build` intent, `local_reversible` risk, and `workspaceWrite` as the only enabled authority.
- The supported baseline-v2 target is an isolated, normal Git checkout with a canonical, current-user-owned, non-group/world-writable in-repository `.git` directory and no repository-wide ignored paths. Sparse checkout/index, linked or outside/untrusted Git metadata, gitlinks/submodules, unmerged entries, `assume-unchanged`, `skip-worktree`, hardlinks, special files, and unsafe symlink parents or escapes fail closed.
- Baseline v2 fingerprints raw bytes for every index-tracked and untracked file. It does not invoke `git status`, `git diff`, `git hash-object`, repository hooks, or content filters. Modified and untracked files are fingerprinted and later scope-compared rather than categorically rejected; operators should still begin from an isolated execution checkout.
- Run creation binds the approved Plan digest and task definitions in a separate owner-only store. It ensures at most one ready Mission for the next step and performs no terminal input.
- Mission Queue remains the sole execution surface. The operator selects an exact worker and dispatches there; the SDLC panel cannot select, start, dispatch, interrupt, or retry a worker.
- A digest-bound Mission requires PaneFleet's Local Delivery worker profile: Codex `workspace-write`, approval policy `never`, outbound sandbox network disabled, no `--yolo`, no sandbox bypass, no search, no danger-full-access, no contradictory authority telemetry, and the exact Run workspace. A standard worker is ineligible. This profile does not prove host credential isolation or provide an OS-enforced per-approved-path write sandbox.
- Bound dispatch pins both identities: the exact tmux session/pane tuple and the Codex PID, rollout ID, rollout-source ID, and foreground-command digest. It records the rollout file's pre-dispatch byte size and accepts a Delivery Result only from a complete later record in that same rollout, after the exact marker, with matching sandbox/approval authority and no observed network contradiction. If network authority is absent from the rollout schema, the exact launch argument is the proof; an observed non-disabled value fails closed. Replacement, ambiguous rollout ownership, offset failure, or authority drift also fails closed.
- Every task is bound to an expected baseline, allowed paths, linked acceptance IDs, and one Mission binding. A later task remains held until the prior task passes operator acceptance.
- Implementation capture requires a linked Mission in verification, a nonempty workspace change, unchanged repository/HEAD/branch/index/index-flags/ignored-scope/instruction guards, and no changes outside the task's approved paths. It records bounded summaries, not a full diff or terminal transcript.
- Verification requires an operator-authored outcome and observation for every linked criterion and every required DEV-step check, plus an overall note. For each criterion the operator also supplies manual or command method and may cite task-local evidence; PaneFleet encodes the method and observation in a bounded operator evidence summary. It does not execute the checks or retain their command output, so `verified_locally` means operator-attested local acceptance, not independent command evidence.
- `ready_to_release` is a lifecycle-only Plan state. It does not create an artifact or grant commit, push, deployment, service, network, external-message, destructive, or live authority.
- A pending or uncertain cross-store Mission link becomes `reconcile_required`. Explicit and startup reconciliation may inspect or repair only that idempotent link; it never dispatches, resends, or retries terminal input.
- **Abort local delivery run** requires explicit operator confirmation and a reason. It refuses dispatching, running, input-waiting, or uncertain linked workers; when safe, it records operator evidence, terminalizes the Run, cancels only ready or verifying Missions, and moves the Plan back to `planning`. It sends no terminal input or process signal, and startup reconciliation may finish only the durable cancellation/Plan transition.
- Phase 3A Planning Runs automate only this narrow pre-approval path. High-risk overlays, first-class Risk/TestCase records, retained command artifacts, and release/live adapters are not implemented.

## Prompt queue invariants

- Queue creation binds a prompt to the exact current pane identity and performs no terminal input.
- Idea creation and rejection perform no terminal input. Only explicit approval creates an implementation ticket; refinement tickets are linked, labeled planning-only, and cannot silently approve their parent idea.
- Idea generation shares only selected redacted completion summaries, labels them as untrusted data, and previews the exact prompt. Owner mode uses the ordinary FIFO; scout mode is memory/disk/concurrency gated and read-only; draft mode sends no request. Imported ideas remain `proposed`, and active or recently rejected title duplicates are suppressed.
- Agent-proposed ideas are accepted only from a trustworthy exact-pane queued response with complete structured markers. This includes the bounded no-footer return path, which proves terminal flow rather than task completion; every extracted idea still enters review and never dispatches automatically.
- Recurring schedules use parsed five-field UTC cron only; they do not invoke a shell, `crontab`, service action, or arbitrary command.
- A due schedule adds at most one ordinary queue item, coalesces while its prior item is open, and never replays a downtime backlog.
- A schedule retains the original exact pane identity. Missing or replaced panes are skipped rather than retargeted.
- Pausing, resuming, or deleting a schedule performs no terminal input; deletion leaves already queued items unchanged.
- Green requires a live Codex process plus the explicit idle, healthy, prompt-ready state; low CPU alone is not enough.
- A dead pane is retained for inspection, reported as stopped, and is never green or eligible for terminal input.
- A live shell left behind after a normal Codex exit is not treated as promptable and is not automatically restarted. **Resume saved chat** is available only for an eligible registered slot with an exact saved root-interactive rollout. The UI confirms that this continues the exact recorded conversation and cannot select a topic or create a new chat. The server rechecks rollout lineage, pane and workspace identities, workload cgroup, resource gate, and lack of an active Codex descendant before sending one exact resume command plus one Enter. Unregistered, legacy, parented, and sub-agent panes fail closed with no input.
- Every new or resumed persistent Codex process runs in its own bounded user-systemd scope while tmux and the outer shell stay in the workload service. A registered nonzero crash may resume automatically, but only by the exact stored rollout UUID, one agent at a time, behind memory/swap/PSI gates. It never replays a prompt. Any uncertain input or identity mismatch disarms the slot. Planning-owned `codex-planning-*` workers are excluded and remain governed by their Planning Run's exact attested scope and cleanup reconciliation.
- Explicit **Stop session** disables recovery before the exact session is killed and restores the previous setting if the kill fails.
- A visible nonzero `background terminal` count overrides the drawn composer and keeps queue readiness blue.
- The same exact identity must be green in at least two observations separated by the configured stability interval.
- Dispatch persists an owner-only claim before typing into the pane.
- Each terminal has one FIFO line and only its head item can dispatch.
- Active Codex runtime signals take precedence over stale ready-looking text: background work, interruptible work, and deferred-message banners keep automatic dispatch blocked.
- Accepted delivery is not task completion. The sent head blocks its line until the same exact pane shows stable readiness plus either a `Worked for` final-response boundary or a safely bounded return to a later composer. A footerless return is recorded as terminal flow, never as proof the project task is Done.
- Slash-prefixed queue items are submitted literally without PaneFleet markers. They are recorded only as command submissions, and successor prompts still require the exact terminal to pass the normal stable-ready gate.
- An operator may explicitly leave a queue line only while its item is still queued. The revision-checked action is serialized with dispatch, sends no terminal input, and fails closed once dispatch has durably claimed the item.
- **Wait again — no resend** is available only for an unsent `needs_review` item stopped at literal confirmation. It requires the current revision and original exact pane, keeps the queue line blocked, survives restart, and observes only whether that marker later has two stable acceptance samples after the operator submits manually. It never types or presses Enter. **Dismiss after review** and **Stop waiting** cancel the unsent item without input or retry; sent items, other review causes, stale identities, and replacement panes fail closed, while a linked refinement idea returns to `proposed`.
- **Requeue once** is available only for a delivered `completion_target_replaced` review and one live same-session Codex replacement. A revision check serializes the decision, the old delivery is archived without a completion claim, and exactly one new item inherits its prompt and optional Idea link. The recovery action sends no input, and repeating it against the archived item fails closed.
- A **Newer activity detected** review can be explicitly returned to monitoring. The action acknowledges only activity through that warning, sends and resends nothing, pauses again on later manual input, and rejects completion evidence containing a newer prompt before the original turn's first final footer.
- Intermediate green-looking tool output cannot create a completion snapshot or release the next prompt. A verified final snapshot searches the complete item-specific response boundary and is redacted before owner-only persistence; snapshots above 32 KiB retain a visibly marked tail.
- A restart during dispatch, identity change, incomplete rendering, uncertain Enter, or uncertain acceptance moves the prompt to human review.
- Long marked queue prompts may prove their leading and trailing witnesses in separate stable captures, but only across bounded literal chunks with exact-pane revalidation between them. Enter remains a single final action after both witnesses are proven.
- An uncertain attempt is never retried automatically and blocks later prompts for that terminal until reviewed or dismissed.
- Queue delivery cannot interrupt or stop a session, start a service, or select another terminal.

Prompt queue and notification state is written atomically with owner-only permissions. Operational state remains local and must not be committed.

All connected SSE clients share one server-owned snapshot broadcast timer. Each client starts from a complete sequenced snapshot. Later cycles fan out the same top-level patch, and the browser applies it only when its current sequence exactly matches the patch base; a gap reconnects for a new complete snapshot. The server sends a complete snapshot instead when a patch would be larger. Concurrent cache misses share one in-flight collection, an initial connection may reuse only the bounded `SNAPSHOT_EVENT_CACHE_MS` result, and the timer stops when the last client disconnects. Prompt delivery remains owned by its independent monitor rather than the browser stream. The longer `SNAPSHOT_OBSERVATION_CACHE_MS` cache contains only passive telemetry, process summaries, and SSH-peer display data; it is never consulted for queue readiness, pane identity, terminal input, service control, or network mutation. Every such action performs its own current-state validation.

Host resource reporting is read-only. Memory pressure uses Linux `MemAvailable` rather than treating reclaimable filesystem cache as unavailable, swap comes from `/proc/meminfo`, and root-disk capacity comes from `statfs`. Disk warnings never run cleanup commands or remove files.

## Filesystem boundary

Workspaces originate from the primary project root, reviewed additional roots in ignored host configuration, and live pane context. Explicit workspace entries and display aliases must stay inside an allowed root. Before reading, PaneFleet resolves real paths and verifies containment, including symlinks. Reads are capped and sensitive-looking values are redacted.

Project Desk:

- reports bounded Git branch/HEAD identity and instruction data, with `working_tree_status_not_collected` rather than a changed-file claim;
- never runs a discovered package script;
- discovers PDFs and HTML pages in built-in or explicitly configured output directories, durable root-level HTML consoles, and root-level PDF or Markdown outputs modified during the focused exact tmux session;
- represents files with opaque identifiers rather than browser-supplied paths; and
- revalidates the exact pane, canonical root, selected file, size, extension, content, and any applicable session-time boundary at download time.

## Lifecycle isolation

The normal control plane is supervised by a user systemd unit, outside the default workload tmux server. Restarting the dashboard therefore does not require a tmux server or workload session operation.

The restart helper:

- records the complete workload pane inventory;
- restarts only the user systemd unit;
- waits for stable local health;
- verifies that the listening process is the systemd MainPID; and
- fails if the workload inventory changed.

When the browser detects that its static interface and the running backend are from different builds, the warning bar offers a confirmation-gated **Restart dashboard** action. The action is fixed in `services.json`; browser input cannot supply a command. It schedules the restart helper in a separate transient user-systemd unit so the helper survives the dashboard process being replaced, then the browser waits for a matching healthy runtime before reloading.

The optional ephemeral review agent uses a separate named tmux socket and a read-only sandbox. Its lifecycle cannot target the default workload tmux server.

The owner-only recovery registry contains session/workspace identity, exact rollout UUID, a root-interactive lineage decision, model/reasoning selection, and bounded status timestamps only. It contains no prompt, response, terminal capture, or rollout path. Browser snapshots expose only a sanitized recovery summary.

## Passive Codex usage history

PaneFleet's passive telemetry path reads only structured numeric/config fields from rollout files already proven to belong to exact live Codex processes. It never types `/status` or `/usage` to collect stats. Current context remains attributed to the exact live rollout. Usage history replays token-count events from the beginning of every mapped rollout, computes monotonic cumulative deltas, records a durable complete-line byte offset, and resumes incrementally without double-counting. The first real token event is counted; malformed, truncated, missing, regressed, or ambiguously attributed data fails closed. Events are grouped by their own UTC timestamps and tmux session name, so a session row may combine several restarted rollouts. A token delta is attached to a queued ticket only when exactly one same-session ticket owns that event timestamp; manual work and overlapping or uncertain boundaries stay out of per-ticket totals. Cached input is a subset of processed input and is not presented as unique-token or account-limit consumption. These host-local counters are not Codex `/usage` account activity and cannot include work performed outside mapped rollouts on this host. Rate-limit percentages are pool-specific shared account snapshots, not per-agent consumption. Session and account observations older than 15 minutes are labeled stale and last reported. Passive events may omit model-specific pools that Codex `/status` can show. The owner-only `data/codex-usage-history.json` ledger stores bounded, internally consistent counters, timestamps, source hashes, byte offsets, queue identifiers, tmux session names, and compact account-limit observations; it stores no prompts, responses, captured terminal text, or rollout paths. History is capped at 90 UTC days and 1,000 ticket summaries.

The separate operator-requested latest-response read is not telemetry and never enters a recurring snapshot or durable PaneFleet store. It requires the full tmux pane identity, a current single foreground Codex identity, an active rollout path re-resolved from that exact PID under the allowed sessions root, and the same rollout again after the bounded read. Only the newest assistant `final_answer` record is returned, after secret redaction, with a fixed response limit. Missing, replaced, ambiguous, oversized, or changing identity fails closed. The browser treats the response as untrusted text and constructs only an allowlisted presentation model; it never injects response HTML.

## Optional network-rule boundary

The EC2 integration accepts only an explicit globally routable IPv4 address and authorizes its exact `/32`. It never authorizes `0.0.0.0/0` as a normal action.

Cleanup requires a fresh preview and token. It can remove only rules with the exact PaneFleet ownership format and preserves active SSH sources plus unmanaged, IPv6, source-group, prefix-list, broad, and unrelated port rules.

This integration depends on EC2 metadata, AWS CLI credentials, least-privilege IAM, and a network topology that matches its assumptions. Do not enable it merely because the UI exposes the option.

## Failure philosophy

PaneFleet prefers a visible unresolved state to a guessed action:

- no automatic prompt resend;
- no automatic Done;
- no execution inferred from Planning Pack approval;
- no automatic session stop;
- no service action inferred from terminal text;
- no cleanup without preview and confirmation; and
- no lifecycle recovery that destroys the workload tmux server or retries uncertain terminal input.

These controls reduce risk; they do not make open-internet deployment safe. Follow [SECURITY.md](../SECURITY.md) and [Operations](operations.md).
