# Architecture

PaneFleet is a single Node.js process with a dependency-free browser client. It observes a host through bounded command adapters, owns local coordination state, and sends mutations only through named allowlisted operations.

## Components

| Component | Responsibility |
| --- | --- |
| `public/index.html` | Static terminal-first shell and accessible control surfaces |
| `public/app.js` | Browser rendering, interaction state, HTTP/SSE client, terminal windows, queue, Project Desk, and tools |
| `public/ui-state.js` | Small pure helpers for layouts, drawer state, attention filtering, and launcher outcomes |
| `server.js` | HTTP authentication, static/API/SSE routing, host snapshots, exact-pane input, missions, notifications, Project Desk, services, and optional EC2 access |
| `process-runner.js` | Central `execFile` adapter, timeouts, output bounds, and permanently forbidden tmux server destruction |
| `services.json` | Ignored machine-local authority for known services, links, logs, lifecycle commands, and workflow actions |
| `host-config.json` | Ignored machine-local workspace roots, entries, groups, aliases, and artifact-folder names |
| `data/` | Private owner-only mission, notification, interaction, sampling, review, audit, network-rule, and optional access-token state |
| user systemd | Supervises PaneFleet outside the workload tmux failure domain |
| workload tmux server | Source of truth for live sessions, panes, processes, and terminal output |
| named review tmux socket | Isolated lifecycle for the optional ephemeral read-only review agent |

The application deliberately has zero runtime npm dependencies. Node built-ins serve HTTP, persist files, hash identities, and invoke fixed executables; the browser uses native DOM, fetch, EventSource, and storage APIs.

## Access and request flow

```mermaid
sequenceDiagram
    participant O as Operator browser
    participant H as HTTP boundary
    participant A as API handler
    participant D as Domain operation
    participant T as tmux or host adapter

    alt loopback listener
        O->>H: GET /
    else non-loopback listener
        O->>H: GET / with Basic host-control token
    end
    H-->>O: app plus HttpOnly SameSite control cookie
    O->>A: /api request plus current cookie
    A->>A: validate cookie; JSON and origin for POST
    A->>D: named read or mutation
    D->>T: bounded fixed command or exact-pane keys
    T-->>D: capped result
    D-->>O: redacted JSON or SSE update
```

The minimal `/healthz` route is available without Basic or the control cookie for local supervision. Every operational `/api` route requires the same-page cookie. By default, a non-loopback listener applies the Basic challenge before serving static content or allowing the page to obtain that cookie. An explicit `trusted-network` deployment may delegate that first gate to independently verified exact-source ingress; the API cookie boundary remains unchanged.

## Observation data flow

Snapshot collection reads several sources concurrently:

1. tmux supplies pane identity, current command, working directory, and bounded recent output;
2. `ps` supplies process relationships and resource summaries;
3. `ss` supplies listening sockets and established SSH peer context;
4. `services.json` supplies reviewed labels, links, log paths, and allowed actions;
5. Git supplies bounded branch and working-tree state only for a focused allowed workspace; and
6. local mission, interaction, notification, review, and access-rule stores supply durable coordination state.

The server normalizes and redacts that data, derives agent/service/attention summaries, then returns a snapshot or emits it through server-sent events. Terminal output and project text are treated as untrusted data, never as authority to run an action.

## State ownership

| State | Owner | Persistence |
| --- | --- | --- |
| Live panes, commands, and terminal output | workload tmux server | tmux/process lifetime |
| Service and workflow authority | operator-reviewed `services.json` | ignored local file |
| Workspace read authority and display metadata | `host-config.json` plus environment roots | ignored local file and process environment |
| Missions and transition history | server mission domain | atomic owner-only JSON |
| Notifications and snooze state | server notification domain | atomic owner-only JSON |
| Agent interactions and samples | server collectors | private JSON |
| Audit events | server | private append-only JSONL with rotation |
| Non-loopback Basic token | operator environment or server token file | process environment or owner-only `data/access-token` |
| Control-session token | server process | memory; rotated on restart |
| Per-pane input serialization and supervisor samples | server process | memory |
| Window placement, pins, drafts, notes, snippets, and send history | browser | browser-local storage |

The browser is not authoritative for pane identity, mission revision, locks, filesystem roots, or allowed commands. It submits expected values that the server compares with current host state.

## Exact-pane mission dispatch

Mission dispatch crosses the most sensitive boundary in the system. Its sequence is intentionally conservative:

```mermaid
sequenceDiagram
    participant B as Browser
    participant M as Mission domain
    participant X as Exact-pane input queue
    participant T as Workload tmux

    B->>M: Run Now with mission revision and selected worker
    M->>T: read current session and pane identity
    M->>M: validate revision, workspace, Codex state, locks, and concurrency
    M->>M: persist dispatch claim and exact identity
    M->>X: enqueue literal marked prompt
    loop bounded chunks
        X->>T: revalidate intrinsic pane ID and PID
        X->>T: send literal text only
    end
    X->>T: sample complete paired markers
    X->>T: revalidate exact identity
    X->>T: send one Enter
    X->>T: sample stable post-marker acceptance
    alt accepted
        X-->>M: Running
    else uncertain, replaced, or failed
        X-->>M: reconciliation or Needs You; never resend
    end
```

The exact identity includes session name and creation time, window/pane coordinate, intrinsic tmux pane ID, and pane PID. Pane input is serialized so concurrent browser windows cannot merge keystrokes. An uncertain Enter is never retried automatically.

Initial launcher prompts use the same paired-render and one-Enter philosophy. Direct reviewed terminal prompts also revalidate their exact target and remain separate from interrupt, stop, and forced-recovery controls.

## Persistence and restart behavior

Mission and notification changes are serialized in process and written through atomic replacement. Mission revisions reject stale browser decisions. Audit history is append-only and rotated when bounded size is exceeded.

The control-session cookie rotates whenever PaneFleet restarts. The persistent non-loopback Basic token does not rotate on a normal restart when it comes from the configured environment or existing owner-only token file.

The user systemd unit is not a workload tmux target. The restart helper snapshots the complete workload pane inventory, restarts only the unit, verifies stable local health and listener ownership, then compares the inventory. A mismatch is an operational failure rather than an accepted side effect.

## Current code shape

The current implementation concentrates much of the control plane in `server.js` and much of the browser behavior in `public/app.js`. That made cross-cutting safety invariants visible while the product was evolving, but both files are now modularization candidates.

A future refactor should preserve behavior while extracting clear seams:

- server adapters for tmux, processes, Git, files, EC2, and persistence;
- domain modules for exact-pane input, missions, supervision, notifications, services, and access;
- small HTTP route modules that depend on those domains; and
- browser modules for terminals, Project Desk, queue, tools, access, and shared request/state utilities.

Modularization should proceed behind the existing integration tests. File size alone is not a reason to weaken the exact-identity checks, operation queues, persistence ordering, or fail-closed outcomes.
