# Safety model

PaneFleet is privileged operator software. Its design assumes that observation is common, mutation is narrow, and ambiguous terminal state must fail toward human review.

## Assets to protect

- terminal input and exact worker ownership;
- live tmux sessions and workload processes;
- mission goals, results, and audit history;
- workspace files and generated artifacts;
- service commands and credentials available to the host user;
- network access rules; and
- the availability of the control plane itself.

## Trust assumptions

PaneFleet assumes:

- one trusted operator controls the browser, host account, and workload tmux server;
- the dashboard is reached through loopback, HTTPS, or a private/tunneled transport with tightly restricted ingress;
- the host operating system and explicitly configured command-line tools are trusted;
- `services.json` and `host-config.json` are reviewed machine-local configuration; and
- terminal output, project instructions, logs, filenames, and agent-authored status reports are untrusted data.

PaneFleet authenticates one shared operator on non-loopback listeners by default. An explicit trusted-network deployment may delegate that first boundary to independently verified exact-source ingress. PaneFleet does not identify several people or assign roles.

## Authentication layers

PaneFleet applies separate transport, listener, and request controls:

1. **Transport and network** — loopback, an SSH/private tunnel, or HTTPS plus restricted ingress limits who can reach the service.
2. **Non-loopback operator challenge** — by default, any non-loopback bind requires HTTP Basic username `host-control` and an operator token of at least 24 characters before serving the app. A deliberate `trusted-network` override may delegate this layer to externally enforced exact-source ingress. Loopback remains frictionless.
3. **Same-page control session** — loading the app issues an HttpOnly, SameSite=Strict cookie. Every operational `/api` route requires that current cookie. `/healthz` is the only intentionally minimal public endpoint.
4. **Mutation checks** — POST requests additionally require JSON and same-origin request checks.

When the authenticated non-loopback mode needs a Basic credential and no token is injected through `ORCHESTRATOR_ACCESS_TOKEN`, PaneFleet creates and reuses a random owner-only `data/access-token`. Trusted-network mode does not create or use a Basic token. The local `scripts/show-access-token.sh` helper refuses unsafe file ownership or permissions before revealing an existing token.

HTTP Basic provides no transport encryption. It must be used only through HTTPS or a private/tunneled transport. HTTPS deployments should set `ORCHESTRATOR_SECURE_COOKIE=1` so the control-session cookie is marked `Secure`.

## Read and mutation boundary

Read-only discovery can report tmux sessions, panes, listeners, processes, Git state, and registered services. Mutation is limited to named API operations with server-side validation.

There is no endpoint that accepts an arbitrary shell command or filesystem path. Service actions are loaded from `services.json` at startup. The registry rejects malformed actions, requires every action to be explicitly safe or confirmed, and requires confirmation for tmux-backed and public-IP actions.

All operational API reads and writes require the current control cookie. Mutating requests also require JSON and origin checks when the browser supplies an Origin header. Response headers apply a self-only content security policy and deny framing, cross-origin resource use, referrers, and unnecessary browser permissions.

## Exact terminal identity

A visible pane coordinate alone is not durable because a tmux window or pane can be replaced. Sensitive actions therefore bind to:

1. tmux session name and creation time;
2. window and pane coordinate;
3. intrinsic tmux pane ID; and
4. pane PID.

PaneFleet re-queries tmux and compares that identity immediately before sensitive input. A mismatch fails closed. Input is serialized per pane so simultaneous browser windows cannot merge prompts or keys.

## Normal prompt delivery

Normal agent input behaves like terminal typing:

1. revalidate the target and Codex process;
2. type literal text in bounded chunks;
3. revalidate between chunks and before submission;
4. confirm stable rendering with paired markers when the workflow requires it;
5. send one Enter; and
6. observe stable evidence that Codex accepted the submission.

PaneFleet does not use normal dispatch to send `Ctrl-C`, respawn a pane, kill a session, signal a process, or switch a tmux client. Those recovery actions remain separate and visibly confirmed.

If text rendering or acceptance cannot be proven, PaneFleet records an uncertain state and does not retry Enter. This can leave text visible but unsubmitted; the operator must inspect the exact terminal.

## Mission invariants

- Creating, prioritizing, or moving a mission never dispatches it.
- Dispatch reserves worker and workspace ownership before terminal input.
- One worker and one workspace cannot own competing active missions.
- Stale mission revisions are rejected.
- A restart during uncertain dispatch produces a reconciliation decision, never an automatic resend.
- Requeue releases queue ownership but does not interrupt the worker.
- Supervisor observations require multiple stable samples.
- The supervisor may move completed-looking work only to Verifying.
- Only a human can mark Done, and verification evidence is required.

Mission and notification state is written atomically with owner-only permissions. Operational state remains local and must not be committed.

## Filesystem boundary

Workspaces originate from the primary project root, reviewed additional roots in ignored host configuration, and live pane context. Explicit workspace entries and display aliases must stay inside an allowed root. Before reading, PaneFleet resolves real paths and verifies containment, including symlinks. Reads are capped and sensitive-looking values are redacted.

Project Desk:

- reports bounded Git and instruction data;
- never runs a discovered package script;
- discovers downloadable PDFs only in built-in or explicitly configured output-directory names;
- represents files with opaque identifiers rather than browser-supplied paths; and
- revalidates the exact pane, canonical root, selected file, size, and PDF type at download time.

## Lifecycle isolation

The normal control plane is supervised by a user systemd unit, outside the default workload tmux server. Restarting the dashboard therefore does not require a tmux server or workload session operation.

The restart helper:

- records the complete workload pane inventory;
- restarts only the user systemd unit;
- waits for stable local health;
- verifies that the listening process is the systemd MainPID; and
- fails if the workload inventory changed.

The optional ephemeral review agent uses a separate named tmux socket and a read-only sandbox. Its lifecycle cannot target the default workload tmux server.

## Optional network-rule boundary

The EC2 integration accepts only an explicit globally routable IPv4 address and authorizes its exact `/32`. It never authorizes `0.0.0.0/0` as a normal action.

Cleanup requires a fresh preview and token. It can remove only rules with the exact PaneFleet ownership format and preserves active SSH sources plus unmanaged, IPv6, source-group, prefix-list, broad, and unrelated port rules.

This integration depends on EC2 metadata, AWS CLI credentials, least-privilege IAM, and a network topology that matches its assumptions. Do not enable it merely because the UI exposes the option.

## Failure philosophy

PaneFleet prefers a visible unresolved state to a guessed action:

- no automatic prompt resend;
- no automatic Done;
- no automatic session stop;
- no service action inferred from terminal text;
- no cleanup without preview and confirmation; and
- no lifecycle recovery that destroys the workload tmux server.

These controls reduce risk; they do not make open-internet deployment safe. Follow [SECURITY.md](../SECURITY.md) and [Operations](operations.md).
