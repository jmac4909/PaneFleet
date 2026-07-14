# Contributing to PaneFleet

Thank you for helping improve PaneFleet. This project sits on a sensitive boundary between a browser and live host processes, so small, reviewable changes with explicit safety evidence are preferred.

## Development setup

PaneFleet currently has zero runtime npm dependencies. Use Linux, Node.js 20 or newer, and the host tools listed in the [quick start](README.md#quick-start).

```bash
npm ci
cp services.example.json services.json
npm run verify:public
HOST=127.0.0.1 PORT=8787 npm start
```

Keep the development server on loopback. Use synthetic tmux sessions and test fixtures rather than real work or private terminal content when developing features for publication.

Enable the repository privacy guard:

```bash
npm run hooks:install
```

## Before changing a safety boundary

Read the [Safety model](docs/safety-model.md). Changes must preserve these invariants unless the proposal explicitly replaces them with a stronger, tested design:

- There is no arbitrary shell-command endpoint.
- Every operational API route requires the current same-page control cookie; non-loopback listeners require the operator's Basic credential by default, with trusted-network mode allowed only behind independently verified exact-source ingress.
- Normal agent input is literal text plus one Enter; interrupt, stop, and forced recovery remain distinct actions.
- Sensitive terminal actions revalidate the exact tmux session and pane identity immediately before input.
- Uncertain input is not retried or resubmitted automatically.
- Mission creation does not dispatch, and completion requires separate human verification.
- Service controls are allowlisted in the local registry; unsafe actions require visible confirmation.
- The dashboard lifecycle cannot destroy the workload tmux server.
- Filesystem access stays within canonical allowlisted roots and remains bounded and redacted.
- Tests never invoke real tmux, AWS, metadata, network-rule, or host-process mutations.

## Code and tests

- Keep the server on Node built-ins and the browser client dependency-free unless a dependency has a clear operational benefit and a documented maintenance cost.
- Use ES modules and follow the existing plain JavaScript and CSS conventions.
- Prefer focused modules and pure helpers when extracting behavior from the larger server or UI files.
- Add tests for the expected behavior and the relevant failure paths. Boundary changes should have a fail-closed regression test.
- Keep `package-lock.json` synchronized with `package.json`, even though the current application has zero runtime dependencies.
- Run the source/test check while iterating, then the complete public verification before submitting:

```bash
npm run check
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

The pre-commit hook checks staged content. `npm run privacy:check` also scans tracked files and repository history, but neither can prove that a change is safe to publish.

## Pull requests

A useful pull request includes:

- the operator problem being solved;
- the intended behavior and non-goals;
- the safety boundaries touched;
- focused test evidence and the result of `npm run verify:public`;
- manual desktop or phone checks for interaction changes; and
- sanitized visuals when the change is primarily visual.

Keep unrelated refactors separate. Do not bundle deployment, ingress, credential, or live service changes into a source pull request.

## Security reports

Do not use a public issue or pull request for a vulnerability. Follow [SECURITY.md](SECURITY.md).

## Conduct

Be respectful, specific, and evidence-driven. Critique the implementation and its tradeoffs, not the person proposing it.
