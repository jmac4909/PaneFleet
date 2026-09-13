# Operations

This guide covers foreground evaluation, a persistent user-systemd installation, lifecycle checks, and the optional EC2 integration.

## Choose the network boundary first

The recommended topology is:

```text
browser -> SSH tunnel or private overlay -> 127.0.0.1:8787 on the host
```

Loopback access is intentionally frictionless: the page issues a control cookie, and every operational API requires it. By default, a non-loopback bind adds a browser HTTP Basic challenge with username `host-control` and a long operator token before the page can issue that cookie.

HTTP Basic does not encrypt credentials. Use a non-loopback listener only behind HTTPS or a private/tunneled transport, and continue restricting host and cloud firewalls to exact trusted sources. PaneFleet has one shared operator credential, not accounts or roles.

## Foreground evaluation

```bash
npm ci
cp services.example.json services.json
HOST=127.0.0.1 PORT=8787 npm start
```

Verify health from the host:

```bash
curl -fsS http://127.0.0.1:8787/healthz
```

Use an SSH tunnel from a remote workstation:

```bash
ssh -N -L 8787:127.0.0.1:8787 user@your-host
```

Foreground mode is suitable for evaluation. Closing its shell stops only PaneFleet, not the workload tmux server.

## Recurring prompt operations

Use the Queue composer rather than editing `data/prompt-queue.json` or installing a host `crontab` entry. Select the exact terminal, enter the prompt, and optionally enter a five-field UTC schedule. Common examples:

| UTC cron | Meaning |
| --- | --- |
| `*/15 * * * *` | every 15 minutes |
| `0 * * * *` | at the start of every hour |
| `0 */4 * * *` | every four hours |
| `0 9 * * *` | daily at 09:00 UTC |
| `0 9 * * 1-5` | weekdays at 09:00 UTC |

The Recurring prompts section shows the next run and last scheduling outcome. **Queue now** adds one ordinary FIFO occurrence without changing the cron or paused state; if that schedule already has open work, the request coalesces instead of creating a duplicate. Pause prevents future automatic intake; resume calculates a fresh next run. Delete removes only the schedule, not an item it already added to the queue. An unavailable exact pane is intentionally skipped. If a live same-session replacement exists, **Retarget current session** updates only the schedule's exact identity while preserving its paused state and counters; otherwise create a new schedule deliberately.

When a delivered queue item reports **Terminal replaced**, inspect the current same-session terminal first. If the work is still unresolved, **Requeue once** archives the old delivery without claiming it completed and creates one fresh queued copy on that exact replacement. This confirmed action sends no terminal input and cannot be repeated on the archived item. Do not use it when the old turn may already have completed unless the duplicate-work risk is acceptable.

## Authenticated non-loopback access

Set `HOST` to a non-loopback address only after an encrypted transport and narrow ingress are ready. On first startup, PaneFleet creates a random token at `data/access-token` unless `ORCHESTRATOR_ACCESS_TOKEN` supplies a value of at least 24 characters.

Reveal the generated token from a local shell:

```bash
bash scripts/show-access-token.sh
```

The helper requires the token file to be owned by the current user with mode `0600`. In the browser's Basic prompt use:

- username: `host-control`
- password: the generated or configured token

The Basic credential gates the page and static assets. The page then issues the separate control cookie required by every `/api` route. `/healthz` remains a minimal unauthenticated readiness endpoint.

### Remembered-device HTTPS login

For the checked-in Caddy design—public HTTPS terminating onto loopback-only PaneFleet—`device-session` replaces the browser-native Basic dialog with a normal password-manager-compatible form. A successful sign-in issues a device-specific Secure, HttpOnly, SameSite=Lax cookie for 30 days when **Remember this device** is checked. `Lax` is deliberate: it sends the remembered-device cookie on a safe top-level GET when PaneFleet is opened from another mobile app or bookmark, but not on a cross-site POST. The separate control cookie remains SameSite=Strict, and all mutation checks remain active.

The login origin guard compares normalized public origins, including the trusted proxy scheme and default-port normalization, rather than comparing a browser origin to the raw `Host` header. Some mobile or embedded browser flows serialize an otherwise same-origin form submission as the opaque origin `null`; only the password-gated login accepts that form, and only when browser fetch metadata says `same-origin`. This compatibility path does not apply to `/api` mutations. Cross-site metadata, a valid but mismatched origin, and opaque mutation origins still fail closed.

For a new credential, run the password hasher interactively so plaintext never appears in an argument or shell history; pipe only its bcrypt result to the fail-closed bootstrap helper:

```bash
caddy hash-password --algorithm bcrypt --bcrypt-cost 14 \
  | bash scripts/bootstrap-device-auth.sh OPERATOR_USERNAME
```

An existing Caddy Basic deployment can migrate by copying its existing bcrypt hash through the same helper, preserving the current username and password without recovering or rewriting plaintext. `data/device-auth.json` must remain an owner-only regular file. The bootstrap helper refuses to replace an existing credential file.

Install the explicit service mode together with the loopback HTTPS settings:

```bash
install -m 0600 deploy/host-https/panefleet-device-auth.conf \
  "$HOME/.config/systemd/user/agent-orchestrator.service.d/access.conf"
install -m 0600 deploy/host-https/panefleet-loopback-override.conf \
  "$HOME/.config/systemd/user/agent-orchestrator.service.d/https-loopback.conf"
systemctl --user daemon-reload
bash scripts/restart-dashboard.sh
```

Confirm the loopback login page and persistent-session tests before removing `basic_auth` from Caddy. The checked-in Caddy template deliberately has no Basic challenge and strips any incoming `Authorization` header. Reload Caddy only after PaneFleet is healthy in `device-session` mode, then verify an anonymous HTTPS request redirects to `/login` without a `WWW-Authenticate` header. Keep the exact-source security-group rules unchanged throughout the cutover.

The device session store is `data/device-sessions.json`. It contains only SHA-256 token hashes and timestamps, caps retained sessions, and prunes expiration. Five failed attempts from one trusted proxy address trigger a 15-minute in-memory lockout. Revoking a session requires an explicit operator-side store operation; there is no browser endpoint that can mint, list, or broaden sessions without the current credential.

### Explicit trusted-network mode

If the host firewall or cloud security group has been independently verified to permit the dashboard port only from the operator's exact IPv4 `/32`, the Basic prompt can be disabled with:

```text
ORCHESTRATOR_ACCESS_MODE=trusted-network
```

This is an explicit deployment override, not the public default. It does not disable the same-page HttpOnly control cookie, JSON and same-origin checks, CSP, tmux identity validation, or allowlisted service controls. Do not use it with `0.0.0.0/0`, IPv6-wide, ranged, shared, source-group, prefix-list, or otherwise unverified access.

When the browser-facing URL is HTTPS, set this in the PaneFleet service environment:

```text
ORCHESTRATOR_SECURE_COOKIE=1
```

This marks the control cookie `Secure`. Do not set it for a plain loopback HTTP URL, because the browser will correctly refuse to send a Secure cookie over HTTP.

After installing the user systemd unit, add the setting through a drop-in and restart PaneFleet after the HTTPS endpoint is ready:

```bash
systemctl --user edit agent-orchestrator.service
```

```ini
[Service]
Environment=ORCHESTRATOR_SECURE_COOKIE=1
```

Apply the drop-in with the inventory-preserving restart helper:

```bash
systemctl --user daemon-reload
bash scripts/restart-dashboard.sh
```

## Fresh systemd installation

The normal persistent control plane is a user systemd unit. A fresh installation defaults to loopback, installs the unit, enables it, starts it, and waits for health without touching tmux:

```bash
npm ci
cp services.example.json services.json
bash scripts/install-control-plane.sh
bash scripts/isolate-workload-tmux.sh
```

Skip the copy when a reviewed ignored `services.json` already exists. The second command installs the dedicated workload unit, keeps both the default and managed-review tmux servers supervised, and either anchors a new server there or moves an existing server and its descendants without replacing any pane. Require its unchanged-inventory confirmation before continuing.

Choose a different bind address or port at install time only when needed:

```bash
ORCH_BIND_HOST=0.0.0.0 ORCH_PORT=8787 bash scripts/install-control-plane.sh
```

This non-loopback example activates the built-in Basic challenge and creates the owner-only token on first start. Establish HTTPS or a private/tunneled transport and narrow ingress before using it, then retrieve the token locally with `scripts/show-access-token.sh`.

The installer writes `ORCH_BIND_HOST` and `ORCH_PORT` into the unit. `ORCH_HEALTH_HOST` controls only the local readiness address and defaults to `127.0.0.1`.

By default the installer also resolves the official native Codex 0.147.0 platform executable and writes its canonical path, exact version, and SHA-256 into the user unit. Resolution happens before filesystem or systemd mutation. An optional absolute `ORCH_PLANNING_CODEX_EXECUTABLE` may select a specific native binary, but it does not bypass the exact ownership, permissions, ELF architecture, version-output, or hash checks. Failure leaves Planning unconfigured and aborts installation; PaneFleet never substitutes the New Agent `CODEX_COMMAND`.

For a host that intentionally will not offer Planning Runs, install explicitly with:

```bash
ORCH_PLANNING_CODEX_MODE=disabled bash scripts/install-control-plane.sh
```

This produces a working dashboard whose Planning capability is false. It is also the documented lifecycle-fixture path; it is not a way to run Planning with an unverified executable.

### Upgrade the pinned Planning Codex

Do not replace the pinned file in place. First land one reviewed change that updates the required version, server compatibility checks, resolver provenance rules, and their tests. Install the matching official `@openai/codex` wrapper/platform package, then rerun `bash scripts/install-control-plane.sh` so the generated unit receives the new canonical path, exact version, and SHA-256. Review the unit diff and activate it only through the normal dashboard restart procedure. Merely updating npm or a `codex` command on `PATH` cannot silently change Planning; a path, version, or content mismatch fails closed until it is deliberately repinned.

The running server does not execute `--version` or `mcp list`. The installer owns version/SHA verification; before role input the server hashes the configured executable and attests the running `/proc/<pid>/exe` image. Treat those checks as protection from drift and accidental upgrades only. The operator and all same-UID processes remain trusted: owner-only files and private runtime directories cannot stop hostile same-UID replacement races. If that threat is in scope, disable Planning until a reviewed root-owned immutable installation or held-file-descriptor launch boundary is available.

Confirm the result:

```bash
bash scripts/control-plane-status.sh
```

To keep the user service manager running without an active login session, an administrator can enable lingering:

```bash
sudo loginctl enable-linger "$USER"
```

Review this command under the host's account policy; it changes user-service persistence.

## Migration from a legacy tmux-backed dashboard

Only installations that already run PaneFleet in legacy control sessions need migration. The same install-time bind and port variables apply:

```bash
bash scripts/install-control-plane.sh --migrate
bash scripts/isolate-workload-tmux.sh
```

Migration enables lingering and the user unit, validates the exact legacy control panes, interrupts only those control panes, waits for port ownership to clear, starts systemd, verifies stable health, and compares the complete workload tmux inventory. The isolation step then places that preserved workload server in its durable cgroup.

Do not use `--migrate` as a generic repair command. Inspect its prerequisites and current control-plane state first.

## Status and restart

```bash
bash scripts/control-plane-status.sh
bash scripts/restart-dashboard.sh
```

The restart helper:

1. takes a complete workload pane inventory;
2. restarts only `agent-orchestrator.service`;
3. waits for two healthy loopback samples;
4. confirms that the listener belongs to the systemd MainPID; and
5. fails if the workload inventory changed.

It does not destroy a tmux server or workload session.

Useful read-only diagnostics:

```bash
systemctl --user status agent-orchestrator.service
journalctl --user -u agent-orchestrator.service --since today
ss -ltnp | awk 'NR==1 || /:8787/'
curl -fsS http://127.0.0.1:8787/healthz
```

Operational API routes intentionally reject command-line requests that do not carry a same-page control cookie. Use the browser for snapshots and audit data. Do not paste operational output into public issues without sanitizing it.

## Runtime state

Durable state lives under `data/` and should remain owner-readable only. It may contain Planning Pack requests and role artifacts, Planning Run role reports and exact worker identities, Delivery Runs and bounded evidence summaries, Agent Commons messages and receipts, queued prompt text, compatibility Mission text, pane summaries, audit records, notifications, managed access-rule state, and the generated non-loopback access token.

Before a protected backup, stop only the PaneFleet user unit, copy `data/` to a private destination, and start the unit again. Back up `delivery-plans.json`, `delivery-planning-runs.json`, and `delivery-runs.json` together from that same stopped-process point; each Run is digest-bound to its Plan even though it has a separate owner-only store. Never include `data/`, logs, or terminal captures in a source archive.

## Agent Commons operations

Use the **Commons** workspace for operator posts and review. Agents may use the checked-in CLI only from their own current Codex tmux pane:

```bash
scripts/agent-commons.mjs inbox
scripts/agent-commons.mjs post --body "Waiting on the schema review." --category wait --attention ping --to codex-example --scope current
scripts/agent-commons.mjs post --body "Need an independent parser review." --category help_request --attention ping --scope current
scripts/agent-commons.mjs reply commons-example-message --body "Review complete; the focused check passed."
scripts/agent-commons.mjs ack commons-example-message
scripts/agent-commons.mjs transition commons-example-message satisfied
```

The CLI reports a receipt after placing a write in `data/agent-commons-inbox/`; acceptance is asynchronous and appears in the next successful server snapshot. A receipt proves only that the envelope was queued locally. The server may quarantine it under the private rejected directory if its claimed pane is no longer live, the shape is invalid, or sensitive content is detected. Never manually edit `agent-commons.json`, move a rejected envelope back, or interpret a Commons message as authorization.

Use **Board** for ambient context, **Ping** for awareness, **Nudge** for the next safe checkpoint, and **Stop request** only for urgent review. A Stop request does not interrupt anything. Open the exact terminal, inspect current work, and use the separate confirmed terminal interrupt only when continuing risks harm, cost, data loss, or wrong-target work. Resolve or withdraw handled attention records so the Commons badge reflects outstanding requests; history remains durable.

Use a project-scoped **Help request** when another perspective is genuinely useful. PaneFleet recommends a compatible idle existing agent first; **Review suggested agent** sends nothing, so use the normal reviewed prompt path separately if that agent should take the work. If PaneFleet instead offers **Prepare one helper**, review the locked request, workspace, deterministic session name, model, reasoning, and safety profile, then press **Approve & Start One Helper** once. The server rechecks systemd isolation, root disk, memory, swap, PSI, workload separation, and the exact open request immediately before creation. Global requests, resource-gated requests, and helper-authored recursive requests cannot create helpers.

The new helper has auto-recovery disabled and is told to reply in the request thread without delegating further. Initial prompt acceptance means only that the helper received the request; the thread stays open. Review its reply and exact terminal evidence, then resolve or withdraw the request explicitly. If initial delivery is uncertain, inspect the existing helper terminal and do not prepare or send another copy.

## Multi-role Planning Run operations

Use a Planning Run only for a current `planning` Plan classified standard-depth, `change` or `build`, `local_reversible`, with `workspaceWrite` as its sole enabled authority. Quick and high-risk work, broader authority, releases, deployments, service/network operations, destructive changes, and external communication remain operator-authored planning paths.

1. Open **SDLC → AAP Workshop**, type what is on your mind, and press **Send to workshop**. That is the only workshop action. Project context is optional; PaneFleet waits until approval or coding to require a real Git baseline. The action durably creates the unapproved AAP and starts the resource-gated PO, BA, QA, and DEV round. It never starts coding.
2. Use the shared conversation as the workshop surface. Between rounds, type an optional message and press **Send to workshop** again; a blank message runs the current AAP unchanged. While a round is active, the control reads **Workshop running**, remains disabled, and preserves the next browser-session draft without changing the frozen round.
3. PaneFleet creates a durable Planning Run and resource-gates each role attempt. PO completes first, BA receives PO, and QA and DEV then receive the same PO-plus-BA input independently. Workers use the installer-pinned native Codex, fresh hidden `codex-planning-*` sessions, a dedicated owner-only Codex home, a neutral non-project context, and the prompt-only permission profile. They are intentionally absent from the terminal rail and capture, Project Desk, queue, Mission, resume, interrupt, stop, and generic agent-control APIs. Before tmux creation, PaneFleet durably records the exact transient scope and a bounded spawn lease; only an on-time exact pane observation may establish normal process and rollout identity.
4. A resource wait is safe to continue only after reading the current host state and Planning Run. **Continue after resource check** durably authorizes one exact `resource_retry`; normal cleanup recovery similarly authorizes only one exact `cleanup_only` action. A provisional lease that is present but could not establish process and rollout identity is different: when the authoritative Run alone reports the action eligible, the UI shows the separate destructive **Terminate stuck planning worker** control. Its exact request is retained for readback after an uncertain response and is never retried automatically. After confirmation, PaneFleet issues one stop for only the durably bound exact transient Planning scope; systemd applies the fixed 30-second stop timeout. This action is never Continue, never targets a normal accepted worker, and reveals no lease, session, or scope identifier in the browser.
5. PaneFleet never retries uncertain input, and replaying a lost browser response cannot create a second worker or resend cleanup text. For a crash, replacement, invalid report, cleanup ambiguity, `needs_input`, `reconcile_required`, or `off_course`, inspect the exact Run and audit state; do not type into a reserved pane or edit the JSON store. Use **Cancel planning run** only when the server reports no unresolved worker or apply claim; cancel sends no terminal input.
6. After all four reports pass, review the role messages and complete old-versus-new candidate. The candidate may replace only the four role artifacts and unresolved questions. Choose **Use this proposed AAP** only after confirming the proposal. Apply creates a new unapproved Plan revision; it sends no implementation prompt and grants no execution authority.
7. Inspect the revised Agent Action Plan. Add your next workshop message if a decision, answer, or challenge should enter the shared context, then start another complete round against that exact revision. Each cycle gets fresh role workers and immutable inputs; it does not replay or reopen the prior Run.
8. Re-run Plan readiness, resolve unresolved questions and traceability findings, and then use the existing **Ready for approval** and **Approve exact digest** gates. A Planning Run result is evidence for review, not approval or proof of implementation.

Startup and the browser-independent planning monitor only reconcile already-persisted attempts and observe already-dispatched exact workers. They do not create a new role session or type a role envelope. After restart, use the full Run detail and an explicit safe continuation rather than assuming work resumed. Raw planning prompts and terminal transcripts are intentionally absent from Plan/Run API detail; use private host inspection only when reconciliation requires it.

## Local Delivery Run operations

Use the Delivery Plans area in **SDLC** for governed local source work. Planning may be operator-authored or explicitly applied from a Planning Run; implementation remains one serialized Mission at a time:

1. Prepare a dedicated isolated normal Git checkout for execution, then create or edit the four-lens Planning Pack. Its canonical `.git` directory must be a real directory inside that repository, owned by the current user, and not group/world-writable; the repository must contain no ignored paths. Do not use a sparse or linked worktree, a repository with submodules/gitlinks or unmerged entries, or index entries hidden by `assume-unchanged` or `skip-worktree`. Ignored `node_modules/`, `coverage/`, and build output make the current baseline path ineligible. Modified and untracked files are fingerprinted when intentionally present, so do not delete another user's content merely to make the checkout appear clean. **Capture real workspace baseline** immediately before final review, then resolve every blocking readiness finding. Project Desk's branch/HEAD display is not this gate and deliberately does not collect working-tree status.
2. Move the Plan to **Ready for approval** and choose **Approve exact digest**. Read the displayed digest and authority first. Approval records only that definition; it creates no Run or Mission and sends no terminal input.
3. Choose **Create local execution run** as a separate confirmed action. It is available only to a ready `local_reversible` `change` or `build` Plan whose sole enabled authority is `workspaceWrite`. PaneFleet rechecks the approved digest and baseline, creates the separate Run, and ensures one ready Mission for the first DEV step. It still sends no terminal input.
4. Start or select a worker in the exact workspace using the New Agent launcher's **Local Delivery · workspace only, no network** profile. Open Mission Queue, inspect the ready Mission and envelope, and dispatch to that exact worker. Bound dispatch rejects standard/`--yolo`, sandbox-bypass, search, danger-full-access, contradictory sandbox/approval/network telemetry, replaced-pane or Codex-process, ambiguous-rollout, and nonexact-workspace workers. Run creation does not select or start one. The profile enforces `workspace-write`, approval policy `never`, and outbound sandbox network disabled; it does not prove host credential isolation or enforce the Plan's individual approved paths at the operating-system layer, so use the isolated workspace and review host credentials too.
5. Treat the dispatch binding as immutable. PaneFleet pins the session creation time, pane coordinate, intrinsic tmux pane ID, pane PID, Codex PID, rollout ID, rollout-source ID, and foreground-command digest. Immediately before input it records the rollout file size. It will accept a Delivery Result only from a complete final record after that byte offset and the exact dispatch marker in the same rollout. A later user turn supersedes the boundary, and more than 8 MiB of post-offset rollout data fails closed. Do not replace or resume the process behind a bound Mission and expect it to remain valid.
6. Wait for Mission Queue to show the linked Mission in verification with its bounded delivery result. Inspect the terminal and workspace. Choose **Capture local implementation** only when the reported step really stopped and its changes should be measured. PaneFleet recaptures raw tracked/untracked bytes and instruction state, rejects changed repository identity, HEAD/branch, index or index flags, ignored-scope or approved-scope coverage, an empty implementation, or paths outside the approved scope, and stores only bounded path and report summaries. It does not run `git status`, `git diff`, `git hash-object`, repository hooks, or content filters for this baseline.
7. Perform every required DEV-step check yourself or inspect evidence produced by the worker. PaneFleet does not run checks or retain command output in Phase 2. In **Operator acceptance review**, give every linked criterion a Passed, Failed, or Not run outcome, choose Manual observation or Command executed by operator, and write the observed result. Give every required DEV-step check its own Passed, Failed, or Not run outcome and observed-result note. Add only task-local supporting evidence references and finish with the required overall operator note. PaneFleet persists bounded operator-authored evidence summaries for each criterion and check; those summaries are attestations, not retained command artifacts.
8. A passing record requires every linked criterion and required check to be Passed. It completes that Mission and ensures one ready Mission for the next step; it does not dispatch the next step. Repeat from Mission Queue. When all steps pass, the Run becomes `verified_locally` and the Plan becomes `ready_to_release`.

Running-Mission supervision does not depend on an open dashboard or SSE connection. On the `MISSION_SUPERVISOR_MONITOR_MS` interval (5 seconds by default), a single-flight server loop first checks the durable queue. If no Mission is running it does not list processes. Otherwise that pass lists tmux panes and processes once, narrows the observations to the assigned exact panes, and supervises only the running Missions; it does not collect a full dashboard snapshot. A slow pass is never overlapped by the next timer tick. In test mode this timer runs only when the harness explicitly sets `MISSION_SUPERVISOR_MONITOR_TEST=1`.

`ready_to_release` is a lifecycle marker only; the local Run has not executed QA `releaseChecks`. Stop there unless the operator separately authorizes the exact commit, push, release, deployment, service, network, destructive, external-message, or live-verification action through an appropriate project workflow.

A failed or Not run criterion fails the current task and linked Mission. A failed or Not run required check must also be reflected by at least one linked criterion that is not Passed. Phase 2 has no generic retry, remediation, or archive control. Preserve the failed Run as evidence and create a new reviewed Plan for materially changed or remedial work; do not requeue the old Mission or edit the stores to force a transition.

### Abort an unverified local Run

Use **Abort local delivery run** only to terminate the governed local lifecycle deliberately. Read the exact Run, Plan, and linked Missions, enter a specific reason, and confirm the action. PaneFleet refuses abort while any linked Mission is `dispatching`, `running`, `needs_you`, or `reconcile_required`; first inspect and recover that exact worker through the appropriate separate recovery workflow. Abort itself never types into tmux, sends an interrupt, or signals a process.

When every linked Mission is safely ready, verifying, or terminal, abort records bounded operator review evidence, sets the Run condition to `aborted`, preserves already verified tasks, marks the remaining tasks aborted, cancels ready or verifying linked Missions, and transitions the Plan to `planning`. The aborted Run remains durable and immutable for ordinary work. Edit the Plan, resolve the abort reason, capture a current eligible baseline, and pass both **Approve exact digest** and **Create local execution run** again before replacement work.

Because Run, Mission, and Plan are separate stores, abort can return `reconcileRequired` after the Run is already terminal. Do not repeat worker input or edit JSON. Re-read the authoritative state; startup reconciliation can finish only the safe Mission cancellation and Plan-to-`planning` transition with no dispatch or signal.

### Delivery Run reconciliation

A crash or uncertain cross-store write can leave a Run in `reconcile_required`. Read the Plan, Run, and linked Mission before acting. **Reconcile durable Mission link** checks the immutable binding and creates or repairs only the missing idempotent Mission link. It does not choose a worker, dispatch a Mission, type into tmux, or retry a terminal attempt. Startup performs the same no-input reconciliation for persisted Runs and completes any safe pending abort-to-planning reconciliation.

If reconciliation continues to fail, preserve all three stores and inspect current revisions, the approved Plan digest, workspace baseline, Mission binding, and audit event. Do not edit JSON files manually and do not resend a Mission to make the UI advance.

The Phase 2 Run store is intentionally bounded to 64 Runs and 512 durable operation receipts and currently has no pruning endpoint. When either limit is near, stop creating Runs, take a coordinated private backup, and use a reviewed migration or future retention tool. Never delete individual records from the live JSON file.

## Optional EC2 access integration

The access-rule tools require all of the following:

- an EC2 instance with metadata access available to the PaneFleet process;
- AWS CLI in the service PATH;
- an explicit security group or an unambiguous instance security-group context;
- least-privilege permission to describe instances and security-group rules, authorize ingress, and revoke only approved rule IDs; and
- a network design based on exact trusted IPv4 `/32` sources.

Set `ORCHESTRATOR_SECURITY_GROUP_ID` when instance metadata does not identify one unambiguous target. Keep credentials outside `services.json` and the repository.

Adding an address and cleaning old managed addresses are separate confirmed operations. Always inspect the preview. Do not use this feature for shared, IPv6-first, proxy-based, or otherwise incompatible network topologies without extending and testing the safety model.

## Troubleshooting

### Workload tmux isolation

PaneFleet and the default workload tmux server must live in different user-systemd cgroups. `panefleet-workloads.service` owns the persistent default tmux server; `agent-orchestrator.service` observes and controls it but must never own its processes. This boundary lets the dashboard restart without terminating agents.

Run `bash scripts/control-plane-status.sh` and require both `workload_cgroup=separate` and `managed_cgroup=separate`. This means the default and managed-review tmux servers belong to the dedicated workload service, not merely a different transient cgroup. If either reports `shared`, `unmanaged`, `unknown`, or `absent`, do not restart PaneFleet or create a session. Run `bash scripts/isolate-workload-tmux.sh` once, verify the full pane inventory is unchanged, and then re-run the status check. Never stop `panefleet-workloads.service` unless intentionally ending every workload session it owns.

New and resumed persistent Codex processes are launched by `scripts/run-isolated-agent.sh` in one transient user-systemd scope per agent. The tmux server and persistent pane shell remain in `panefleet-workloads.service`, while the Codex process receives the resized-host defaults `MemoryHigh=3G`, `MemoryMax=4G`, `MemorySwapMax=4G`, and `TasksMax=256`. These are per-scope ceilings, not reservations: the soft boundary starts reclaim before the hard kill point and lets cold pages spill into the host's dedicated swap, while the hard boundary leaves host headroom when two long-context agents are resident. Bounded Planning workers retain their smaller, separate limits. A source-default change affects only a later scope; after exact-unit readback and explicit authorization, an already-running scope may be raised in place with `systemctl --user set-property --runtime` and does not need a restart or prompt replay. Re-read the resulting properties, available memory, swap, PSI, and control-plane isolation after each unit. The monitored host `user.slice` can still select an agent scope during genuine host pressure. PaneFleet refuses all tmux creation when the expected workload unit, server PID, or exact cgroup boundary cannot be verified.

The owner-only `data/agent-recovery.json` registry records only tmux session name, canonical workspace, exact Codex rollout UUID, model/reasoning selection, and recovery timestamps/status. It stores no prompt, response, terminal capture, or rollout path. Passive telemetry arms a live persistent agent after proving the rollout belongs to its live process. Recovery is sequential and requires at least 35% available memory, no more than 75% swap use, and memory full-pressure `avg10` no greater than 10. It resumes the exact UUID and never uses `--last` or replays a prompt. An uncertain terminal send, replacement pane, dead pane, workspace mismatch, or unverified start disables that slot for manual review instead of retrying. `codex-planning-*` sessions are ineligible: Planning Run recovery may only reconcile its persisted exact scope and cleanup state.

### A Planning Run has unknown provisional-worker inventory

Fail closed. Do not use Continue, Cancel, Apply, generic agent recovery, tmux respawn, or a blanket `tmux kill-*`/process signal. An unavailable, ambiguous, replaced, or late pane/scope observation cannot establish a Planning worker and cannot authorize an automatic stop.

Read the authoritative Planning Run and audit record locally, then inspect only the exact persisted user-systemd scope and exact reserved tmux session with `systemctl --user status`/`systemctl --user show` and targeted `tmux has-session`/`tmux list-panes` commands. Do not copy those private identifiers into chat or browser-visible notes. Restore the inventory observation path and reread the Run. If the server proves absence, it closes the lease without a stop. If it proves the durably bound exact transient Planning scope is still active but process/rollout identity was never established, use the UI's one-shot **Terminate stuck planning worker** action once; do not invoke `systemctl stop` separately or retry after an uncertain response. The scope has a 30-minute runtime backstop and systemd owns its bounded 30-second stop sequence. Cancel becomes safe only after PaneFleet proves the exact scope and pane are absent.

### A non-loopback browser keeps requesting credentials

- Confirm the username is exactly `host-control`.
- Run `bash scripts/show-access-token.sh` locally and compare the current token without copying it into logs or chat.
- If `ORCHESTRATOR_ACCESS_TOKEN` is injected by a supervisor, confirm it is at least 24 characters and that the running unit received it.
- Clear a cached incorrect Basic credential by closing the browser session or using a private window.
- Confirm a proxy forwards the `Authorization` header.

### The page loads but API calls return `control_session_required`

- Reload the page so it can issue the current process's control cookie.
- A dashboard restart intentionally invalidates the previous cookie.
- If `ORCHESTRATOR_SECURE_COOKIE=1`, confirm the browser-facing URL is HTTPS. Secure cookies are not sent over plain HTTP.
- Confirm a proxy preserves `Set-Cookie` and browser cookies for the PaneFleet origin.

### The dashboard says the backend must restart

This means the browser assets and running server came from different PaneFleet builds. Use the confirmation-gated **Restart dashboard** button in the warning bar. PaneFleet schedules the allowlisted restart helper outside the process being replaced, waits for a healthy matching runtime, and reloads the page. Repeated clicks while that fixed helper is already active are treated as the same scheduled restart instead of a failed action. If the button cannot schedule the action, run `bash scripts/restart-dashboard.sh` locally. Do not kill a tmux server or workload session. After restart, confirm the warning clears and `bash scripts/control-plane-status.sh` reports the workload inventory unchanged.

### The page loads but shows no agents

- Confirm the workload tmux server belongs to the same host user.
- Run `tmux list-panes -a` as that user.
- Confirm the Codex process is running in the expected pane.
- Check the dashboard journal for a redacted collector error.

### Codex updated successfully but the terminal no longer accepts prompts

Codex's built-in updater normally exits with status zero. The isolated launcher records that normal exit, and PaneFleet disarms automatic recovery for the slot. When that exact terminal has an eligible registered slot with a saved root-interactive rollout UUID, choose **Resume saved chat** there or in the selected-agent inspector. PaneFleet first confirms that this continues the entire exact registered conversation—not a selected topic or a new chat—then revalidates the rollout lineage, live shell, workspace, and cgroup boundary before typing one exact resume command plus one Enter. Older terminal scrollback may temporarily be visible while Codex redraws. An unregistered, legacy, parented, or sub-agent pane has no PaneFleet resume action and receives no input; recover it outside PaneFleet, then let passive observation register its exact root rollout. PaneFleet never guesses a most-recent rollout, destroys the tmux session, replays a prompt, or retries uncertain input.

For a nonzero scoped crash, PaneFleet may recover the stored exact root-interactive rollout automatically. If the pane shell survived, it resumes there. If the workload tmux server also disappeared, its supervised empty replacement is used to recreate one eligible session at a time. Explicit **Stop session** disarms the slot before killing the exact tmux session; a failed stop restores the prior setting. Check the Agent Recovery section in `/api/snapshot` or the dashboard data before assuming a missing agent is armed. Planning-owned workers and parented/sub-agent rollouts never use this path.

### The service is active but health fails

- Check `systemctl --user status agent-orchestrator.service`.
- Confirm port 8787 is not owned by another process.
- Verify the installed unit has the intended bind address and Node path.
- Run `bash scripts/control-plane-status.sh` before any restart.

### A prompt is visible but not submitted

PaneFleet intentionally sends no Enter when full rendering cannot be proved. Open the exact terminal and inspect the draft. Choose **Wait again — no resend** to keep the ticket and its line blocked, then press Enter manually in that exact terminal if the complete prompt is visible. PaneFleet will only observe the existing dispatch marker and resume completion monitoring after stable acceptance; it will not type or submit anything. Choose **Dismiss after review** to cancel the unsent item and unblock the line, or **Stop waiting** later. These actions require the original exact pane and send no input.

### A queued prompt needs review

The dashboard lost certainty after claiming, rendering, or submitting that exact prompt, or it restarted while delivery was in progress. Inspect the assigned pane before taking any action. Use **Wait again — no resend** or **Dismiss after review** only for the unsent literal-confirmation case described above. Use **Release queue** only for an eligible delivered item whose completion evidence you reviewed; release does not claim the task is Done. Other review causes remain paused unless their specific recovery control is present. PaneFleet never resends an uncertain item automatically.
