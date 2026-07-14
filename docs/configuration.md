# Configuration

Host Control separates reusable source from machine-local authority. Two ignored files provide host-specific configuration:

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
| `artifactDirectories` | name array | Adds allowed PDF output-folder names to the built-in set |

A workspace descriptor may be an absolute path string or an object with:

- `path`: required absolute path;
- `label`: optional display label; and
- `group`: optional workspace-picker group.

`workspaceEntries` and `areaAliases` must be inside the primary root or one of `additionalWorkspaceRoots`. They do not expand filesystem authority. Labels and groups are display metadata only.

`directoryGroups` keys and `artifactDirectories` values are single directory names, not paths. Artifact discovery recognizes top-level `artifacts`, `deliverables`, `exports`, and `output` folders plus names explicitly listed here. It remains PDF-only, bounded, symlink-aware, and tied to the focused exact pane.

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
| `ORCHESTRATOR_ACCESS_TOKEN` | unset | Explicit non-loopback Basic password; must contain at least 24 characters |
| `ORCHESTRATOR_ACCESS_TOKEN_FILE` | `data/access-token` | Owner-only generated/reused non-loopback token file |
| `ORCHESTRATOR_SECURE_COOKIE` | unset | Set to `1` when the browser reaches Host Control over HTTPS |
| `MISSION_MAX_ACTIVE` | `3` | Global active mission cap |
| `SNAPSHOT_EVENT_MS` | `5000` | Server-sent snapshot interval |
| `AGENT_SAMPLE_INTERVAL_MS` | `15000` | Agent history sampling interval |
| `ORCHESTRATOR_SECURITY_GROUP_ID` | unset | Optional explicit EC2 security group target |

Timing variables used by prompt confirmation and the Mission Supervisor exist primarily for deterministic tests and unusual terminals. Keep production defaults unless a measured compatibility problem justifies a change.

Values in `ORCHESTRATOR_EXTRA_WORKSPACE_ROOTS` must be absolute paths. On Linux, separate several roots with `:`. Host configuration is usually clearer when roots also need labels, groups, or aliases.

The systemd installer has separate installation-time settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ORCH_BIND_HOST` | `127.0.0.1` | Bind address written into the installed unit |
| `ORCH_PORT` | `8787` | Port written into the installed unit |
| `ORCH_HEALTH_HOST` | `127.0.0.1` | Local address used for install/restart health checks |
| `ORCH_SYSTEMD_UNIT` | `agent-orchestrator.service` | User-unit name |
| `ORCH_NODE_BIN` | discovered `node` | Absolute Node executable written into the unit |

Any non-loopback `ORCH_BIND_HOST` activates the Basic challenge at runtime. If no explicit token is injected into the installed service, first startup creates the owner-only token file. Retrieve it locally with:

```bash
bash scripts/show-access-token.sh
```

Use username `host-control` and the printed token. Never carry that credential over plain HTTP; use HTTPS or a private/tunneled transport.

Prefer the generated owner-only token file. If a supervisor injects `ORCHESTRATOR_ACCESS_TOKEN`, use its protected secret mechanism rather than placing the token in a command line, unit file, repository file, or shell history.

## Runtime data

Host Control creates `data/` with mission, notification, interaction, review, access-rule, and audit state. A non-loopback deployment without an injected token also stores `data/access-token` with owner-only permissions. State files use atomic replacement where consistency matters.

Treat `data/`, `services.json`, and `host-config.json` as private. Back them up only to a protected destination, never commit them, and stop Host Control before attempting a manual restore.

Browser-local notes, prompt drafts, snippets, pins, and window preferences live in browser storage rather than `data/`.
