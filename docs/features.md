# Features

PaneFleet is organized around one primary workflow: keep live terminals easy to reach, then put queue and host operations nearby without letting them obscure the terminal.

## Terminal workspace

- Discovers tmux panes and distinguishes Codex workers from registered services.
- Sorts workers by recent dashboard interaction and supports browser-local pinning.
- Opens several live terminal previews without attaching or switching tmux clients.
- Jumps directly to any named open terminal from an ultrawide workspace or fullscreen phone terminal, including restoring docked views without stepping through every window.
- Restores open and docked live terminal views after browser refresh only when the saved session creation time and pane identity still match the current agent; freeform widescreen geometry and intentional capture pauses return with them.
- Supports free drag/resize windows plus one-, two-, and four-pane layouts on desktop.
- Lets desktop operators independently show or hide the Sessions and Details panels, remembers both choices locally, and still offers a persistent Focus canvas mode with `Alt+0`.
- Keeps off-screen monitoring useful with a browser title that prioritizes offline/polling state, decisions, queue depth, or active work, plus a decision-count app badge where supported.
- Keeps phone sessions in a bounded vertical list for fast scanning, then shows exactly one fullscreen terminal at a time with quick tools and the reply composer collapsed until requested.
- Scales live terminal text from 80% to 140% with one browser-local preference shared across every open terminal.
- Switches all terminal output between wrapped reading and horizontally scrollable exact-line views without changing pane capture or terminal input.
- Copies the currently captured terminal output in one tap, with a safe fallback when the modern Clipboard API is unavailable.
- Finds text inside long terminal captures in place, highlights matches, and cycles forward or backward without changing pane state.
- Pauses and resumes each browser-side live capture independently, with a persistent paused badge and no effect on the running agent.
- Separates browser-side reading controls from terminal-input commands, using a compact widescreen row and labeled mobile touch grids instead of a long horizontal tool strip.
- Opens the active terminal's in-app search with `Ctrl/Command+F`, and turns the displayed text percentage into a one-tap reset to 100%.
- Opens a complete keyboard shortcut guide from the top bar or the `?` key, with keyboard focus contained until it is dismissed.
- Preserves unsent drafts and recent sent-input history in the browser.
- Previews large or multiline pastes before inserting them into the terminal composer.
- Provides explicit Model, Status, Usage, Fast, and picker-navigation controls, plus a separately labeled Recovery group with confirmed Ctrl-C and Stop session actions in every live terminal.

Closing or minimizing a browser terminal window does not stop its tmux session. Interrupt and stop remain visibly separate, confirmed recovery actions in the terminal Tools panel and selected-agent inspector.

## Project Desk

When a live terminal is focused, Project Desk resolves its canonical workspace and presents bounded project context:

- Git branch, commit, and changed-file summary;
- recognized check scripts from the nearest package metadata;
- capped excerpts from local project instruction files;
- links registered for services in the same workspace;
- generated PDFs from standard output folders plus root-level PDF, Markdown, and HTML outputs modified during the exact tmux session;
- browser-local project notes; and
- a browser-local prompt scratchpad with reusable snippets.

Project Desk does not execute discovered check scripts. File downloads use opaque identifiers and exact live-pane identity rather than accepting a filesystem path from the browser.

The scratchpad separates drafting from sending. Review shows the literal text and exact terminal identity, and only the final confirmation sends text plus Enter.

## Green-light prompt queue

Choose one exact live terminal and add the next plain prompt without interrupting its current work. Each terminal owns an independent FIFO line:

- **Blue** — the agent is working, so every queued prompt waits;
- **Green** — the visible Codex composer is ready; and
- **Needs review** — delivery became uncertain and the line is paused.

PaneFleet's server continues observing queued lines even when no dashboard tab is open. It requires two stable green observations before it durably claims and submits the first prompt for that terminal. A visible Codex `background terminal` indicator keeps the line blue even when the composer is drawn. After acceptance, the item stays **Waiting for final response** until the same exact pane provides either a stable `Worked for` footer or a stable return boundary made from the exact dispatch marker, a non-empty response, a later composer, and the Codex status bar. The first is labeled **Verified final response**; the second is labeled **Returned to ready · no footer**. Both can release the next prompt, but the latter explicitly does not claim that the project task is Done. Stable green without either boundary becomes **Needs review**. The operator can inspect the exact terminal and choose **Release queue** or cancel; neither action resends the prompt. Pane replacement, completion timeout, incomplete rendering, an uncertain Enter, uncertain acceptance, or a dashboard restart during dispatch also pauses the line. PaneFleet never retries an uncertain attempt.

While an accepted ticket is open, its badge reports the exact agent phase rather than a generic pending label: blue while the agent is working and green while PaneFleet verifies a returned composer. A dispatch marker that has scrolled outside the bounded capture cannot prove a finish; after the exact pane returns stably ready, PaneFleet moves that ticket to **Capture boundary expired** review instead of leaving it pending until the 24-hour timeout.

A newer manual send or interrupt on the same exact pane supersedes an older ticket that still lacks finish evidence. PaneFleet moves that ticket to **Newer activity detected** review immediately, without attributing the new turn to it or sending terminal input. If the older ticket's own stable footer is still available, that exact evidence is captured first.

The Queue tab is a full center workspace rather than a modal drawer. Its live terminal board makes readiness visible before composing: every exact pane has a selectable card with its readiness reason, active count, waiting backlog, and line head. Selected cards and the composer summary share the same exact-session draft state. Current queue lanes, verified completion statistics, completed deliveries, and older history stay visible on the same page. A revision-checked **Clear history** action removes finished captured, legacy unconfirmed, and canceled records; active work, queued prompts, and recurring schedules are preserved, and the action never touches tmux.

The live terminal board can select up to twelve exact agents for one reviewed prompt. **Queue** creates all selected FIFO items in one durable update, or creates none when any target is stale. **Send now** delivers concurrently through each pane's normal literal-text-plus-Enter path and reports success or failure per terminal. Successful immediate sends cannot be rolled back, partial delivery is never retried automatically, and recurring schedules remain deliberately single-terminal.

For newly delivered prompts, PaneFleet waits for the same durable pane identity to return stably ready with a visible `Worked for` final boundary, then stores a bounded redacted snapshot of the final response with the completed ticket. The ticket preserves useful terminal formatting, including bullets and separators. A replaced pane cannot supply that snapshot, earlier history is not guessed retroactively, and capture never sends input or changes delivery success.

The composer also accepts an optional five-field UTC cron expression. Recurrence is implemented by PaneFleet's in-process scheduler, not the host shell or `crontab`. When due, it creates one normal prompt-queue item bound to the schedule's original exact pane identity. If that schedule already has an open item, the occurrence is coalesced. A missing or replaced pane causes a skipped occurrence, and a restart advances a missed schedule once without catch-up bursts. The Queue page lists active and paused schedules with next run, run count, last outcome, and explicit pause, resume, and delete controls. Those controls never send terminal input, and deleting a schedule leaves already queued items unchanged.

The Queue badge counts pending prompts. Queueing and scheduling never interrupt a session, press keys while blue, start a new worker, or choose a terminal on the operator's behalf.

## Attention and notifications

The attention feed still combines agent exceptions, unhealthy services, security warnings, and compatibility mission decisions outside the prompt queue. Browser notifications are deduplicated and can open or snooze the corresponding item.

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
- A non-loopback listener requires the fixed HTTP Basic username `host-control` and a long operator token by default; explicit `trusted-network` deployments may delegate that first gate to verified exact-source ingress.
- The non-loopback credential is one shared operator credential, not a multi-user account system.
- The health endpoint remains a minimal unauthenticated readiness check.

HTTP Basic credentials are safe only inside HTTPS or a private/tunneled transport. Network restriction remains part of the deployment boundary.

## Optional EC2 access controls

On a suitably configured EC2 host, PaneFleet can inspect sanitized inbound rules, authorize one globally routable IPv4 `/32`, and preview cleanup of stale rules created by the dashboard.

Authorization and cleanup are separate operations. Cleanup preserves unmanaged rules, broad rules not owned by PaneFleet, IPv6, source groups, prefix lists, active SSH peers, and other port ranges. This integration is optional and should remain unused outside its documented trust and IAM boundary.

## Non-goals

PaneFleet is not:

- a browser shell or general remote command runner;
- a multi-user identity and permissions system;
- a distributed agent scheduler;
- a replacement for tmux, SSH, host firewalls, or a secrets manager; or
- an unattended system that decides work is complete on its own.
