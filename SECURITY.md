# Security policy

PaneFleet can inspect terminals and host state, send input to selected tmux panes, run locally allowlisted service actions, and optionally update narrowly scoped network rules. Treat it as privileged operator software.

## Supported versions

Security fixes are applied to the current `main` branch and the most recent tagged release, when releases exist. Older commits and private forks are not maintained automatically.

## Report a vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub private vulnerability reporting for this repository when it is available. Otherwise contact the maintainer privately through the contact method on the repository owner profile. Include:

- the affected commit or version;
- the preconditions and deployment topology;
- a minimal reproduction that does not include real terminal output, credentials, IP addresses, or private paths;
- the expected impact; and
- any suggested mitigation.

The maintainer will acknowledge the report as soon as practical, investigate it privately, and coordinate disclosure after a fix or documented mitigation is available. This project does not currently operate a bug-bounty program.

## Deployment and authentication boundary

PaneFleet is a single-operator application. It does not provide separate accounts, roles, or multi-user audit identities. It uses two access modes:

- A loopback listener (`127.0.0.1`, `::1`, or `localhost`) does not prompt for HTTP Basic credentials.
- A non-loopback listener requires HTTP Basic authentication before serving the application or issuing a control cookie by default. The username is always `host-control`; the password is an operator token of at least 24 characters.
- An explicit `ORCHESTRATOR_ACCESS_MODE=trusted-network` deployment may suppress that prompt only after an external firewall or cloud security group has been independently verified to allow the dashboard port solely from the operator's exact IPv4 `/32`.

Every operational `/api` route, read or write, also requires the same-page `host_control_session` cookie. The minimal `/healthz` endpoint is the intentional exception. POST requests additionally require JSON and same-origin request checks.

If `ORCHESTRATOR_ACCESS_TOKEN` is not supplied for an authenticated non-loopback listener, PaneFleet creates a random owner-only token at `data/access-token`. Reveal it locally with `bash scripts/show-access-token.sh`. Never paste the token into chat, logs, issues, or shell history.

HTTP Basic only encodes credentials; it does not encrypt them. Carry Basic credentials only through HTTPS or a private/tunneled transport. When the browser reaches PaneFleet over HTTPS, set `ORCHESTRATOR_SECURE_COOKIE=1` so the control cookie receives the `Secure` attribute.

Recommended deployment:

- bind to `127.0.0.1`;
- connect through an SSH tunnel or a private overlay network;
- if a non-loopback bind is unavoidable, use HTTPS or a private encrypted transport in addition to the built-in Basic challenge, and restrict ingress to exact trusted sources;
- use trusted-network mode only when independently verified external ingress is restricted to the operator's exact IPv4 `/32`;
- never expose the dashboard to the open internet; and
- keep the host account, tmux server, Codex configuration, and service registry under one trusted operator.

See the [Safety model](docs/safety-model.md) for assets, trust assumptions, and failure behavior.

## Secrets and private data

Never commit or publish:

- `services.json`, `host-config.json`, `AGENTS.md`, `.env*`, access tokens, credentials, or key material;
- runtime `data/`, audit logs, terminal captures, or process output;
- private documents, generated artifacts, databases, hostnames, IP addresses, or user-specific paths.

Machine-local configuration should read secrets from the process environment or an external credential store. Do not embed secrets in service commands.

The repository includes a pre-commit privacy guard. Enable it with:

```bash
npm run hooks:install
```

The hook runs the staged privacy check. Before publishing, also review the staged diff and scan the publishable working tree plus Git history:

```bash
npm run verify:public
```

These checks are defense in depth, not proof that a repository or deployment is safe.
