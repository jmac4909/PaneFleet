# Contributing to PaneFleet

Thank you for helping improve PaneFleet. This project sits on a sensitive boundary between a browser and live host processes, so small, reviewable changes with explicit safety evidence are preferred.

## Development setup

Use Linux, the Node.js 22 version pinned in `.node-version` (supported range: `>=22.23.0 <23`), and the host tools listed in the [quick start](README.md#quick-start). The only runtime npm dependency is `bcryptjs`, used for device sign-in password verification.

```bash
npm ci
cp services.example.json services.json
npm run verify:public
HOST=127.0.0.1 PORT=8787 npm start
```

These setup commands are for a fresh checkout, not a live installation: do not overwrite its service registry or compete for its listener. Keep the development server on loopback. Use synthetic tmux sessions and test fixtures rather than real work or private terminal content when developing features for publication. The test launcher below runs against isolated fixtures and does not require a live dashboard restart.

Enable the repository privacy guard:

```bash
npm run hooks:install
```

## Before changing a safety boundary

Read the [Safety model](docs/safety-model.md) and [SDLC delivery standard](docs/sdlc-delivery-standard.md). For nontrivial work, define the outcome, requirements, acceptance evidence, implementation scope, authority, and rollback before writing. Changes must preserve these invariants unless the proposal explicitly replaces them with a stronger, tested design:

- There is no arbitrary shell-command endpoint.
- Every operational API route requires the current same-page control cookie; non-loopback listeners require the operator's Basic credential by default, with trusted-network mode allowed only behind independently verified exact-source ingress.
- Normal agent input is literal text plus one Enter; interrupt, stop, and forced recovery remain distinct actions.
- Sensitive terminal actions revalidate the exact tmux session and pane identity immediately before input.
- Uncertain input is not retried or resubmitted automatically.
- Planning automation is bound to one current Plan revision and uses fresh prompt-only workers from PaneFleet's private minimal Codex runtime, not the selected project or the user's Codex configuration. PO precedes BA; QA and DEV receive the same PO-plus-BA input independently; their reports cannot approve or execute a Plan.
- A Planning Run candidate may change only role artifacts and unresolved questions. Applying its exact digest creates an unapproved revision; approval and execution remain later explicit gates.
- PaneFleet-owned planning sessions are not generic terminal targets. Exact process, rollout, prompt offset, authority, cleanup, and restart reconciliation must remain fail closed.
- Queued prompts dispatch only after two stable exact-pane green observations; any uncertain attempt pauses for review and is never retried automatically.
- Service controls are allowlisted in the local registry; unsafe actions require visible confirmation.
- The dashboard lifecycle cannot destroy the workload tmux server.
- Filesystem access stays within canonical allowlisted roots and remains bounded and redacted.
- Tests never invoke real tmux, AWS, metadata, network-rule, or host-process mutations.

## Code and tests

- Keep the server on Node built-ins and the browser client dependency-free unless a dependency has a clear operational benefit and a documented maintenance cost.
- Use ES modules and follow the existing plain JavaScript and CSS conventions.
- Prefer focused modules and pure helpers when extracting behavior from the larger server or UI files.
- Add tests for the expected behavior and the relevant failure paths. Boundary changes should have a fail-closed regression test.
- Treat modal isolation as a runtime safety boundary. An element may become `inert` only after proving it is neither the active surface nor an ancestor of that surface; preserve that fail-closed guard and its structural regression test when markup moves.
- For phone interaction changes involving `inert`, overflow, touch handling, fixed positioning, or stacking, manually verify portrait and short-landscape terminal scrolling, close-view behavior, background isolation, and live-refresh stability. Record the browser/device used; static source and CSS checks do not count as interaction evidence.
- Prefer behavior-level tests against the real `server.js` entrypoint. Use the test-only temporary runtime root and fake executables; do not copy the server into a fixture or invoke live host tools.
- Keep runtime and safety regressions in the core suite; put secondary UI, configuration, documentation, and Project Desk coverage in the feature suite. `npm test` runs core before features, still runs features after a core failure, and returns a failing status if either group fails.
- Keep the coverage floor from regressing. Improve assertions and missing boundary behavior instead of excluding production files.
- Keep `package-lock.json` synchronized with install-relevant metadata in `package.json`.
- Run behavior regressions while iterating. A test should detect an incorrect outcome, not merely lock in a function name or command spelling. For a performance fix, reproduce the problem with synthetic data and assert a stable resource/work budget; shared-host wall-clock timings are supporting evidence, not a pass/fail threshold.

Use the fast loop first:

```bash
npm run check:syntax
npm run test:focused -- test/codex-telemetry.test.js test/test-runner.test.js
npm run bench:telemetry
```

Replace the example test paths with the affected manifest-listed files. Focused runs preserve the full runner's sequential execution, isolated temporary directory, signal forwarding, and cleanup. They reject unknown paths and do not replace the complete gate. The launcher avoids temp filesystems with less than 256 MiB available. The telemetry benchmark uses only synthetic image and usage records, reports elapsed time and bytes copied, and never reads live conversations.

Before submitting, run the complete public verification once (it already includes core and features; there is no need to run both again first):

```bash
npm run verify:public
```

## Privacy

Do not include real pane output, prompts, mission text, credentials, private paths, hostnames, IP addresses, service names, or generated personal documents in code, tests, screenshots, issues, or pull requests.

Use sanitized fixtures. Review both the file list and the content before committing:

```bash
git status --short
git diff --cached --stat
git diff --cached
```

The pre-commit hook checks staged content. `npm run privacy:check` also scans modified tracked files, untracked non-ignored files, and repository history, but neither can prove that a change is safe to publish.

Keep one-installation cloud maintenance, host inventories and operational handoffs outside the public product. The publication guard rejects the known private maintenance paths even when force-added. Their operational originals and tests belong in the operator's private maintenance workspace, not the public CI suite.

For an additional local check, supply private names, employer identifiers or host markers through the transient `PANEFLEET_PUBLICATION_DENY_TERMS` environment variable as a `|`-separated list. Use private environment injection; never put the values in a shell command, CI configuration, fixture or committed file. Each marker must contain at least three characters. The check covers content, filenames and stored commit metadata. Findings never echo the marker; a filename containing one is withheld too.

## Pull requests

A useful pull request includes:

- the operator problem being solved;
- the intended behavior and non-goals;
- requirement-to-acceptance-to-test traceability for substantive behavior;
- the safety boundaries touched;
- focused test evidence and the result of `npm run verify:public`;
- manual desktop or phone checks for interaction changes; and
- sanitized visuals when the change is primarily visual.

Keep unrelated refactors separate. Do not bundle deployment, ingress, credential, or live service changes into a source pull request.

## Security reports

Do not use a public issue or pull request for a vulnerability. Follow [SECURITY.md](SECURITY.md).

## Conduct

Be respectful, specific, and evidence-driven. Critique the implementation and its tradeoffs, not the person proposing it.
