# Features

Host Control is organized around one primary workflow: keep live terminals easy to reach, then put queue and host operations nearby without letting them obscure the terminal.

## Terminal workspace

- Discovers tmux panes and distinguishes Codex workers from registered services.
- Sorts workers by recent dashboard interaction and supports browser-local pinning.
- Opens several live terminal previews without attaching or switching tmux clients.
- Supports free drag/resize windows plus one-, two-, and four-pane layouts on desktop.
- Shows exactly one fullscreen terminal at a time on narrow phone layouts.
- Preserves unsent drafts and recent sent-input history in the browser.
- Previews large or multiline pastes before inserting them into the terminal composer.
- Provides explicit Model, Status, Usage, Fast, picker-navigation, interrupt, and stop controls.

Closing or minimizing a browser terminal window does not stop its tmux session. Interrupt and stop remain visibly separate recovery actions.

## Project Desk

When a live terminal is focused, Project Desk resolves its canonical workspace and presents bounded project context:

- Git branch, commit, and changed-file summary;
- recognized check scripts from the nearest package metadata;
- capped excerpts from local project instruction files;
- links registered for services in the same workspace;
- generated PDFs discovered only under standard output folders;
- browser-local project notes; and
- a browser-local prompt scratchpad with reusable snippets.

Project Desk does not execute discovered check scripts. File downloads use opaque identifiers and exact live-pane identity rather than accepting a filesystem path from the browser.

The scratchpad separates drafting from sending. Review shows the literal text and exact terminal identity, and only the final confirmation sends text plus Enter.

## Mission Queue

Missions capture an outcome, workspace, priority, instructions, and verification criteria. The primary lanes are:

- **Needs You** — operator decisions, uncertain dispatch, waiting workers, or failures;
- **Running** — work owned by a live exact worker identity;
- **Up Next** — ready or held work that has not been dispatched; and
- **Done Today** — recently verified outcomes.

Creating, editing, or reordering a mission never starts it. **Run Now** targets one explicitly selected, existing idle Codex session in the matching workspace. **Adopt Existing Work** links work already in progress without typing or submitting a prompt.

The queue enforces one active mission per worker and workspace plus a configurable global concurrency cap. Revisions reject stale browser actions instead of overwriting newer mission state.

## Supervisor and attention

The Mission Supervisor samples the exact assigned pane over time. Stable, recognizable status reports can move apparently completed work to **Verifying**. Waiting, stopped, missing, or failed workers move to **Needs You**.

The supervisor cannot:

- mark a mission Done;
- resend a prompt or press Enter;
- interrupt or stop a session; or
- run a service action.

The attention feed combines operator decisions, agent exceptions, unhealthy services, and security warnings. The red Queue badge counts decisions only. Browser notifications are deduplicated and can open or snooze the corresponding item.

## Services and host tools

- Displays registered and auto-discovered tmux services.
- Shows TCP listeners, top host processes, selected logs, and recent audit events.
- Opens links for registered service ports and discovered HTTP listeners.
- Starts, stops, or restarts only services with an explicit registry entry.
- Runs only registry actions that pass startup validation.
- Keeps read-only discovery separate from mutation rights.

The local registry may describe host-specific workflows, but those commands are not accepted from arbitrary browser input.

## Operator access

- Loopback use opens normally and receives a same-page control cookie.
- Every operational API requires that cookie, including read-only snapshots and audit data.
- A non-loopback listener first requires the fixed HTTP Basic username `host-control` and a long operator token.
- The non-loopback credential is one shared operator credential, not a multi-user account system.
- The health endpoint remains a minimal unauthenticated readiness check.

HTTP Basic credentials are safe only inside HTTPS or a private/tunneled transport. Network restriction remains part of the deployment boundary.

## Optional EC2 access controls

On a suitably configured EC2 host, Host Control can inspect sanitized inbound rules, authorize one globally routable IPv4 `/32`, and preview cleanup of stale rules created by the dashboard.

Authorization and cleanup are separate operations. Cleanup preserves unmanaged rules, broad rules not owned by Host Control, IPv6, source groups, prefix lists, active SSH peers, and other port ranges. This integration is optional and should remain unused outside its documented trust and IAM boundary.

## Non-goals

Host Control is not:

- a browser shell or general remote command runner;
- a multi-user identity and permissions system;
- a distributed agent scheduler;
- a replacement for tmux, SSH, host firewalls, or a secrets manager; or
- an unattended system that decides work is complete on its own.
