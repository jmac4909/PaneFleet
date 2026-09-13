# Configuration

PaneFleet separates reusable source from machine-local authority. Two ignored files provide host-specific configuration:

- `services.json` grants visibility and allowlisted service actions; and
- `host-config.json` adds workspace roots, workspace entries, display groups, display aliases, and PDF artifact folders.

The files behave differently: `services.json` must exist and may contain an empty array, while a missing `host-config.json` is treated as an empty object. Never place credentials in either file.

## Host configuration

Start from the sanitized schema example when the default `~/projects` root is not enough:

```bash
cp host-config.example.json host-config.json
```

The entire file is ignored by Git. Unknown top-level keys and malformed values fail startup instead of being silently ignored.

Example shape:

```json
{
  "additionalWorkspaceRoots": [
    {
      "path": "/srv/shared-workspaces",
      "label": "Shared workspaces",
      "group": "Additional roots"
    }
  ],
  "workspaceEntries": [
    {
      "path": "/srv/shared-workspaces/example-tooling",
      "label": "Example tooling",
      "group": "Project tools"
    }
  ],
  "directoryGroups": {
    "docs": "Supporting folders"
  },
  "areaAliases": [
    {
      "path": "/srv/shared-workspaces/example-tooling",
      "label": "Example Tooling"
    }
  ],
  "artifactDirectories": ["releases"]
}
```

| Key | Shape | Purpose |
| --- | --- | --- |
| `additionalWorkspaceRoots` | descriptor array | Adds canonical roots that Project Desk and workspace selection may read |
| `workspaceEntries` | descriptor array | Adds specific selectable workspaces inside an allowed root |
| `directoryGroups` | object | Maps immediate directory names under the primary project root to UI group labels |
| `areaAliases` | descriptor array | Assigns display names to a path and its descendants; the longest matching path wins |
| `artifactDirectories` | name array | Adds allowed output-folder names to the built-in set |

A workspace descriptor may be an absolute path string or an object with:

- `path`: required absolute path;
- `label`: optional display label; and
- `group`: optional workspace-picker group.

`workspaceEntries` and `areaAliases` must be inside the primary root or one of `additionalWorkspaceRoots`. They do not expand filesystem authority. Labels and groups are display metadata only.

`directoryGroups` keys and `artifactDirectories` values are single directory names, not paths. PDF and HTML discovery recognizes top-level `artifacts`, `deliverables`, `exports`, `output`, and `public` folders plus names explicitly listed here. Project Desk also discovers root-level PDF, Markdown, and HTML files created or modified during the focused exact tmux session, while excluding instruction and repository-metadata names. Both paths remain bounded, symlink-aware, download-only, and tied to the focused exact pane. HTML previews are limited to reviewed output folders; root session HTML remains downloadable but is not executable in the preview sandbox.

## Service registry

Create a local registry:

```bash
cp services.example.json services.json
```

Each top-level entry describes one known service or workflow.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Unique stable identifier using letters, numbers, `.`, `_`, `:`, or `-` |
| `label` | no | Human-readable name; defaults to `id` |
| `cwd` | yes | Absolute service workspace path |
| `session` | with `command` | Exact tmux session managed by Start/Stop/Restart |
| `command` | with `session` | Fixed command used to create the managed session |
| `sessionPrefixes` | no | Tmux session prefixes associated with the service for visibility |
| `ports` | no | Expected TCP listener ports |
| `links` | no | Browser links derived from a registered port, protocol, and path |
| `logFiles` | no | Bounded relative log paths inside `cwd` |
| `actions` | no | Additional fixed allowlisted workflows |
| `external` | no | Marks a visible service whose lifecycle is managed elsewhere |

`session` and `command` must appear together. Omitting both creates a visibility/action entry without generic lifecycle controls.

### Links

A link contains:

- `label`;
- `port` from 1 to 65535;
- optional `protocol`: `http`, `https`, or `exp`; and
- optional `path` beginning with `/`.

### Logs

A log entry contains a label, a relative path inside the service workspace, and a line count from 20 to 300. Absolute paths and parent traversal are rejected. Log output remains private operational data.

### Actions

An action contains:

| Field | Meaning |
| --- | --- |
| `id` | Unique action identifier within the service |
| `label` | Operator-facing button text |
| `command` | Fixed machine-local command from the reviewed registry |
| `runMode` | `exec` for bounded foreground execution or `tmux` for a new session |
| `safe` | Explicitly marks an unconfirmed action as non-destructive |
| `confirm` | Requires visible browser confirmation |
| `timeoutMs` | Integer from 1,000 to 300,000 milliseconds |
| `publicIpEnv` | Optional uppercase environment variable that receives a validated public IPv4 address |

Every action must either set `safe: true` or `confirm: true`. Tmux actions and actions receiving a public IP always require confirmation.

Do not place secrets in `command`. Read them from the process environment or an external credential store.

## Environment

Common settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP bind address |
| `PORT` | `8787` | HTTP and dashboard access port |
| `CODEX_COMMAND` | `codex` | Codex CLI executable or fixed launch prefix |
| `CODEX_HOME` | `~/.codex` | Model catalog and Codex configuration root |
| `ORCHESTRATOR_PROJECTS_ROOT` | `~/projects` | Primary allowlisted project root |
| `ORCHESTRATOR_AGENT_WORKSPACES_ROOT` | inside the project root | Additional managed agent-workspace root |
| `ORCHESTRATOR_HOST_CONFIG` | repository `host-config.json` | Alternate ignored host-configuration path |
| `ORCHESTRATOR_EXTRA_WORKSPACE_ROOTS` | unset | Additional roots separated by the platform path delimiter |
| `ORCHESTRATOR_ACCESS_MODE` | `authenticated` | `device-session` enables the persistent normal-form login on a secure loopback proxy; `trusted-network` delegates the first gate to verified exact-source ingress |
| `ORCHESTRATOR_ACCESS_TOKEN` | unset | Explicit authenticated-mode Basic password; must contain at least 24 characters |
| `ORCHESTRATOR_ACCESS_TOKEN_FILE` | `data/access-token` | Owner-only token generated/reused when authenticated non-loopback mode needs one |
| `ORCHESTRATOR_DEVICE_AUTH_FILE` | `data/device-auth.json` | Owner-only versioned username and bcrypt hash required by `device-session` mode |
| `ORCHESTRATOR_DEVICE_SESSION_FILE` | `data/device-sessions.json` | Owner-only atomic store of hashed, revocable 30-day device sessions |
| `ORCHESTRATOR_PLANNING_CODEX_MODE` | generated by installer | Exact `required` or `disabled` Planning capability; production has no executable fallback |
| `ORCHESTRATOR_PLANNING_CODEX_EXECUTABLE` | generated by installer | Canonical, verified native Codex path used only by Planning Runs |
| `ORCHESTRATOR_PLANNING_CODEX_VERSION` | generated by installer | Exact verified Planning Codex version, currently `0.147.0` |
| `ORCHESTRATOR_PLANNING_CODEX_SHA256` | generated by installer | Lowercase SHA-256 of the verified native Planning executable |
| `DELIVERY_PLAN_PATH` | `data/delivery-plans.json` | Alternate absolute owner-only Planning Pack store path; mainly useful for isolated tests or migrations |
| `DELIVERY_PLANNING_RUN_PATH` | `data/delivery-planning-runs.json` | Alternate absolute owner-only multi-role Planning Run store path; relocate it only as part of a coordinated state migration |
| `DELIVERY_RUN_PATH` | `data/delivery-runs.json` | Alternate absolute owner-only Delivery Run store path; mainly useful for isolated tests or coordinated migrations |
| `ORCHESTRATOR_SECURE_COOKIE` | unset | Set to `1` when the browser reaches PaneFleet over HTTPS |
| `ORCHESTRATOR_TRUST_LOOPBACK_PROXY` | unset | Set to `1` only when PaneFleet binds to loopback behind the checked-in Caddy design; one exact proxy-overwritten IPv4 forwarding value is then accepted from a loopback peer |
| `MISSION_LITERAL_CONFIRM_MS` | `15000` | Maximum wait for two stable captures of both literal-input witness markers before PaneFleet refuses to send Enter |
| `PROMPT_QUEUE_READY_MIN_MS` | `4000` | Minimum separation between the two exact-pane green observations required before queued delivery |
| `PROMPT_QUEUE_MONITOR_MS` | `5000` | Server-owned queue observation interval, including when no dashboard tab is open |
| `MISSION_SUPERVISOR_MONITOR_MS` | `5000` | Browser-independent interval for the narrow running-Mission supervisor; bounded from 250 to 60,000 milliseconds |
| `PLANNING_RUN_MONITOR_MS` | `5000` | Browser-independent interval for observing already-dispatched read-only planning workers; bounded from 250 to 60,000 milliseconds |
| `MISSION_MAX_ACTIVE` | `3` | Compatibility mission global active cap |
| `SNAPSHOT_EVENT_MS` | `5000` | Server-sent snapshot interval |
| `SNAPSHOT_EVENT_CACHE_MS` | `1000` | Maximum age for reusing one serialized SSE snapshot for a newly connected client; concurrent clients also share in-flight collection |
| `SNAPSHOT_OBSERVATION_CACHE_MS` | `15000` | Bounded TTL for non-authoritative Codex telemetry, top-process, and SSH-peer display observations; never used to authorize mutations |
| `AGENT_SAMPLE_INTERVAL_MS` | `15000` | Agent history sampling interval |
| `AGENT_SAMPLE_PERSIST_MS` | `15000` | Minimum interval between batched passive-history disk writes |
| `AGENT_SAMPLE_RETENTION_DAYS` | `14` | Retention window for inactive agent histories; active exact sessions are preserved |
| `AGENT_SAMPLE_SESSION_LIMIT` | `100` | Maximum stored session histories after inactive cleanup |
| `AUDIT_MAX_BYTES` | `2097152` | Active audit size that triggers owner-only archive rotation |
| `AUDIT_ARCHIVE_LIMIT` | `4` | Maximum retained audit archives |
| `AUDIT_RETENTION_DAYS` | `30` | Maximum audit archive age |
| `ORCHESTRATOR_SECURITY_GROUP_ID` | unset | Optional explicit EC2 security group target |

`ORCHESTRATOR_RUNTIME_ROOT` is a test-harness setting only. The server honors it only when `NODE_ENV=test`; production always resolves its public assets, service registry, and data paths from the installed PaneFleet root. The Mission and Planning Run monitor timers are disabled in test mode unless the harness sets `MISSION_SUPERVISOR_MONITOR_TEST=1` or `PLANNING_RUN_MONITOR_TEST=1`, respectively; these opt-ins are not production controls.

Timing variables used by prompt rendering, acceptance confirmation, and green-light stability exist primarily for deterministic tests and unusual terminals. Integer timing and count settings are floored and bounded; empty or non-finite values use the documented default. Keep production defaults unless a measured compatibility problem justifies a change.

`MISSION_SUPERVISOR_MONITOR_MS` is separate from dashboard snapshot collection. Its single-flight loop continues with no SSE or browser client, reads the durable queue first, and returns without listing processes when no Mission is running. When at least one Mission is running, one monitor pass lists tmux panes and processes once, narrows those observations to the assigned exact panes, and supervises only those running Missions. It does not request or build a full dashboard snapshot; an overlapping timer tick is skipped rather than run concurrently.

`PLANNING_RUN_MONITOR_MS` is also independent of dashboard snapshot collection. It observes only Planning Runs that already own an active exact worker attempt. Startup and monitoring may reconcile persisted identity, completion, and cleanup state, but they do not create a new planning session or type a new role envelope; an explicit start or safe continue action owns that boundary. Slow monitor passes do not overlap.

Values in `ORCHESTRATOR_EXTRA_WORKSPACE_ROOTS` must be absolute paths. On Linux, separate several roots with `:`. Host configuration is usually clearer when roots also need labels, groups, or aliases.

The systemd installer has separate installation-time settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ORCH_BIND_HOST` | `127.0.0.1` | Bind address written into the installed unit |
| `ORCH_PORT` | `8787` | Port written into the installed unit |
| `ORCH_HEALTH_HOST` | `127.0.0.1` | Local address used for install/restart health checks |
| `ORCH_SYSTEMD_UNIT` | `agent-orchestrator.service` | Validated user-unit name ending in `.service`; paths and option-like names are rejected |
| `ORCH_NODE_BIN` | discovered `node` | Absolute Node executable written into the unit |
| `ORCH_PLANNING_CODEX_MODE` | `required` | Require and pin native Codex 0.147.0, or explicitly write `disabled` to install PaneFleet without Planning capability |
| `ORCH_PLANNING_CODEX_EXECUTABLE` | official package resolution | Optional absolute native executable override; it is still subject to ownership, mode, ELF architecture, exact-version, and hash validation |

Any non-loopback `ORCH_BIND_HOST` activates the Basic challenge at runtime by default. In that default authenticated mode, if no explicit token is injected into the installed service, first startup creates the owner-only token file. Retrieve it locally with:

```bash
bash scripts/show-access-token.sh
```

Use username `host-control` and the printed token. Never carry that credential over plain HTTP; use HTTPS or a private/tunneled transport.

Prefer the generated owner-only token file. If a supervisor injects `ORCHESTRATOR_ACCESS_TOKEN`, use its protected secret mechanism rather than placing the token in a command line, unit file, repository file, or shell history.

When an external firewall or cloud security group has been independently verified to allow the dashboard port only from the operator's exact IPv4 `/32`, an installation may deliberately set `ORCHESTRATOR_ACCESS_MODE=trusted-network`. This removes only the browser Basic prompt. The HttpOnly same-page control cookie, JSON requirement, origin checks, CSP, and all operation-specific validation remain active. Never use trusted-network mode with broad, ranged, shared, or unverified ingress.

For private phone and desktop access through the checked-in HTTPS loopback proxy, prefer `ORCHESTRATOR_ACCESS_MODE=device-session`. Production startup fails closed unless PaneFleet remains loopback-only with `ORCHESTRATOR_SECURE_COOKIE=1` and `ORCHESTRATOR_TRUST_LOOPBACK_PROXY=1`. Bootstrap `data/device-auth.json` from one bcrypt hash with `scripts/bootstrap-device-auth.sh USERNAME`; the script reads only the hash from stdin, refuses replacement, and writes mode `0600`. The login form never stores or logs plaintext credentials. Successful login stores only a SHA-256 hash of a random per-device token, caps retained sessions, expires them after 30 days, and rate-limits failed attempts. Caddy must proxy without `basic_auth`, because PaneFleet owns this login boundary.

## Local Delivery configuration boundary

Automatic Planning Runs use a separate internal **Planning prompt-only** profile rather than the user-selectable standard or Local Delivery profiles. PaneFleet creates an owner-only ephemeral Codex home and neutral non-project context, seeds only validated authentication material, pins a minimal configuration digest, requires an empty MCP inventory, and starts a concrete allowlisted model with `--strict-config` and `--ask-for-approval never`. Its permission profile denies the filesystem root, permits only Codex's minimal runtime reads, grants no project workspace root, and disables command network access. Hooks, shell and code execution, browser/computer/image tools, apps, plugins, memories, subagents, skill discovery/install, and other callable tool surfaces are disabled. The exact foreground executable, arguments, sanitized environment, context directory, rollout root, permission telemetry, and configuration digest must match before input or output is accepted. Reserved `codex-planning-*` sessions are omitted from the generic terminal inventory and cannot be captured, opened, sent to, queued to, used by Project Desk or Mission Queue, resumed, interrupted, stopped, or recreated through public controls.

The installer resolves only the canonical native Codex 0.147.0 ELF for the host architecture. It accepts either the explicit `ORCH_PLANNING_CODEX_EXECUTABLE` path or the exact native platform package declared by the official `@openai/codex` 0.147.0 JavaScript wrapper. Scripts, symlinks, hardlinks, group/world-writable files, untrusted ownership, wrong architecture, unexpected version output or stderr, and changed content fail closed. The generated user unit records the canonical path, exact version, and SHA-256. At runtime PaneFleet rechecks the pin and never falls back to `CODEX_COMMAND`, `PATH`, or another discovered executable.

Runtime performs no `--version` or `mcp list` subprocess probe. Version and SHA-256 are install-time facts; before role input the server hashes the configured executable and hashes/attests the running `/proc/<pid>/exe` image against that pin. This protects against drift and accidental upgrades, not a malicious same-UID process: Planning explicitly trusts the host operator and other processes under PaneFleet's UID, and owner-only state/private runtime directories do not stop same-UID races or path replacement. Root-owned immutable installation or held-file-descriptor execution is future hardening.

`ORCH_PLANNING_CODEX_MODE=disabled bash scripts/install-control-plane.sh` is the explicit non-Planning installation path. It writes empty pin fields, and the Planning capability remains false; this is not a fallback or reduced-security Planning mode. Production installation defaults to `required` and fails before changing systemd state when no valid pin can be resolved.

Treat a Planning Codex upgrade as a reviewed compatibility change. Update the checked-in required version, server-side compatibility checks, resolver provenance rules, and tests together; install the exact official wrapper/platform package; then rerun `scripts/install-control-plane.sh` to write a new canonical path/version/hash. Use the normal requested dashboard restart path after reviewing the generated unit. Updating an npm package or replacing a binary alone does not repin a running installation; the old pin will fail closed if its path or bytes change.

The Codex platform's own system context and built-in skill catalog remain trusted runtime context; PaneFleet does not claim that the envelope is the model's literal only input. The boundary is that project and user configuration, project instructions, host files, and callable tools are absent. A dedicated-home `AGENTS.md` or override file, a configured MCP server, a mismatched model/provider, an untrusted auth/config/executable file, or any contradictory authority observation fails closed.

Planning Run resource gates are fixed safety policy in this version: at most one nonterminal Planning Run and two simultaneous planning workers; at least 35% available memory for the first worker and 50% for the second; root filesystem below 90% used; and Linux memory PSI ten-second `some` below 10 and `full` below 1. Unavailable metrics fail closed. These thresholds are deliberately not environment overrides. The store caps the source Plan and each structured role report at 16 KiB, the current Run at 256 KiB, and reserves the exact pretty-serialized operation and byte headroom needed for bounded completion, cleanup recovery, Continue receipts, cancel, and replay before accepting a new Run.

Every Planning attempt also binds a deterministic user-systemd scope with `RuntimeMaxSec=30min`, `TimeoutStopSec=30s`, `KillMode=control-group`, and a bounded memory/task profile. systemd owns the stop sequence, including its final kill after the timeout; the browser cannot alter these limits. A provisional spawn lease is durable before tmux creation and must bind its exact pane before its deadline. Late or ambiguous discovery cannot authorize prompt dispatch.

`CODEX_COMMAND` is the executable or fixed prefix used by the New Agent launcher. Selecting **Local Delivery · workspace only, no network** appends the enforced Codex arguments `--sandbox workspace-write`, `--ask-for-approval never`, and `--config sandbox_workspace_write.network_access=false`. The normal standard profile is not eligible for a digest-bound Delivery Mission. There is no configuration switch that makes `--yolo`, search, sandbox bypass, danger-full-access, contradictory authority telemetry, or a nonexact workspace eligible.

Local Delivery also requires a single exact Codex rollout owned by the selected foreground process. Dispatch persists its PID, rollout ID, rollout-source ID, foreground-command digest, and the rollout file's current byte size. The result reader begins at that offset and accepts only the exact later dispatch marker and structured final answer from the same rollout; a later user turn supersedes that result boundary. The post-offset read is capped at 8 MiB and fails closed on overflow. These are runtime identity checks, not configurable aliases.

An allowed workspace root grants discovery and selection, not Delivery Run eligibility. The supported baseline-v2 workspace is an isolated normal Git checkout with a canonical `.git` directory inside the repository that is owned by the current user and not group/world-writable, plus no ignored paths. Sparse state, linked/outside/untrusted Git metadata, gitlinks, unmerged index state, hidden `assume-unchanged` or `skip-worktree` flags, and unsafe filesystem aliases fail closed. The collector fingerprints raw tracked and untracked bytes without working-tree porcelain or repository filters; modified and untracked content is allowed when it is deliberately part of the captured starting state. An otherwise ordinary checkout containing ignored `node_modules/`, `coverage/`, build output, or similar paths is intentionally ineligible; use a dedicated isolated execution checkout instead of deleting or repurposing another user's files.

The baseline capture is also intentionally bounded: at most 1,000 combined tracked and untracked entries, 16 MiB per file, 64 MiB total file/instruction bytes, 32 instruction files, 2 MiB per instruction file, and 128 approved scopes. These are current fixed implementation limits, not environment settings; an over-limit repository is ineligible until a reviewed implementation change provides a safe alternative.

Project Desk is separate from this capture path. It reports branch and abbreviated HEAD with `working_tree_status_not_collected`; it does not expose a configuration option to turn its recurring display read into a working-tree scan.

## Runtime data

PaneFleet creates `data/` with separate Planning Pack, Planning Run, and Delivery Run stores plus prompt queue, idea queue, recurring schedule state, compatibility Mission, notification, interaction, review, access-rule, and audit state. `delivery-plans.json` owns definitions, approvals, and Plan operation receipts. `delivery-planning-runs.json` owns source Plan bindings, role attempts and bounded reports, candidate state, cleanup/reconciliation state, and Planning Run operation receipts. `delivery-runs.json` owns digest-bound task state, Mission-link outbox records, bounded implementation and operator-attestation evidence summaries, abort state, and Run operation receipts. None of these files is raw terminal-delivery state; linked Mission identity and delivery history stay in the Mission store. Ideas live in the prompt queue store so legacy approval can persist the idea decision and its new work ticket together. An authenticated non-loopback deployment without an injected token also stores `data/access-token` with owner-only permissions; trusted-network mode does not. State files use atomic replacement where consistency matters. Passive agent-history updates are batched, inactive histories are age/count bounded, and audit archives are age/count bounded without removing the active audit. Recurring schedules use UTC and the same server-owned `PROMPT_QUEUE_MONITOR_MS` loop; they do not install host cron entries.

Treat the Plan, Planning Run, and Delivery Run stores as one backup unit. Stop PaneFleet, copy all three files (normally by copying the whole private `data/` directory), and restore them from the same point in time. `DELIVERY_PLAN_PATH`, `DELIVERY_PLANNING_RUN_PATH`, and `DELIVERY_RUN_PATH` relocate only their respective owner-only stores; always relocate, back up, and restore them together. Do not point any path at a public, shared, or repository-tracked location. A mismatched restore can leave planning candidates or digest-bound Runs requiring manual reconciliation with their Plans, workers, or Missions.

Treat `data/`, `services.json`, and `host-config.json` as private. Back them up only to a protected destination, never commit them, and stop PaneFleet before attempting a manual restore.

Browser-local notes, prompt drafts, snippets, pins, and window preferences live in browser storage rather than `data/`.
