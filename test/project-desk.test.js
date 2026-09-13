import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { stopChildProcess } from './helpers/child-process.js';
import { writeExecutable } from './helpers/executables.js';
import { fetchWithTimeout, responseJson, waitForHttpServer } from './helpers/http.js';
import { unusedLoopbackPort } from './helpers/unused-loopback-port.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');

let fixtureDir;
let projectsRoot;
let workspace;
let workspaceSubdir;
let deliverablesDir;
let workspacePublicDir;
let workspaceStaticDir;
let workspaceDocsDir;
let workspaceDistDir;
let durableRootHtmlPath;
let deliverableHtmlPath;
let publicSiteHtmlPath;
let staticSiteHtmlPath;
let sessionMarkdownPath;
let sessionDocsMarkdownPath;
let sessionHtmlPath;
let distZipPath;
let parentWorkspace;
let nestedWorkspace;
let nestedPlanPath;
let secondNestedWorkspace;
let outsideDir;
let toolLogPath;
let gitModePath;
let child;
let childOutput = '';
let baseUrl;
let controlCookie;

function toolLog() {
  return existsSync(toolLogPath) ? readFileSync(toolLogPath, 'utf8') : '';
}

async function request(pathname, { method = 'GET', body, cookie = true } = {}) {
  const headers = {};
  if (cookie && controlCookie) headers.cookie = controlCookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetchWithTimeout(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function deskPath(session = 'codex-alpha', overrides = {}) {
  const parentWorkspaceSession = session === 'codex-parent';
  const values = {
    sessionCreatedAt: '2023-11-14T22:13:20.000Z',
    paneId: `${session}:0.0`,
    tmuxPaneId: session === 'codex-outside' ? '%8' : parentWorkspaceSession ? '%9' : '%7',
    panePid: session === 'codex-outside' ? '5252' : parentWorkspaceSession ? '6262' : '4242',
    ...overrides
  };
  return `/api/project-desk/${encodeURIComponent(session)}?${new URLSearchParams(values)}`;
}

function artifactPath(id, session = 'codex-alpha', overrides = {}) {
  const query = deskPath(session, overrides).split('?', 2)[1];
  return `/api/project-desk/${encodeURIComponent(session)}/artifacts/${encodeURIComponent(id)}?${query}`;
}

function artifactPreviewPath(id, session = 'codex-alpha', overrides = {}) {
  const query = deskPath(session, overrides).split('?', 2)[1];
  return `/api/project-desk/${encodeURIComponent(session)}/artifacts/${encodeURIComponent(id)}/preview?${query}`;
}

before(async () => {
  fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'agent-orchestrator-project-desk-'));
  projectsRoot = path.join(fixtureDir, 'projects');
  workspace = path.join(projectsRoot, 'alpha');
  workspaceSubdir = path.join(workspace, 'src');
  deliverablesDir = path.join(workspace, 'deliverables');
  workspacePublicDir = path.join(workspace, 'public');
  workspaceStaticDir = path.join(workspace, 'static');
  workspaceDocsDir = path.join(workspace, 'docs');
  workspaceDistDir = path.join(workspace, 'dist');
  parentWorkspace = path.join(projectsRoot, 'poker');
  nestedWorkspace = path.join(parentWorkspace, 'poker-monorepo');
  secondNestedWorkspace = path.join(parentWorkspace, 'poker-bots');
  const nestedDocsDir = path.join(nestedWorkspace, 'docs');
  outsideDir = path.join(fixtureDir, 'outside');
  const codexHome = path.join(fixtureDir, 'codex-home');
  const extraWorkspaceRoot = path.join(fixtureDir, 'extra-workspace');
  const binDir = path.join(fixtureDir, 'bin');
  const publicDir = path.join(fixtureDir, 'public');
  toolLogPath = path.join(fixtureDir, 'tools.log');
  gitModePath = path.join(fixtureDir, 'git-mode');
  for (const directory of [
    projectsRoot,
    workspaceSubdir,
    deliverablesDir,
    workspacePublicDir,
    workspaceStaticDir,
    workspaceDocsDir,
    workspaceDistDir,
    nestedDocsDir,
    secondNestedWorkspace,
    outsideDir,
    codexHome,
    extraWorkspaceRoot,
    binDir,
    publicDir
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  mkdirSync(path.join(workspace, '.git'));
  mkdirSync(path.join(nestedWorkspace, '.git'));
  mkdirSync(path.join(secondNestedWorkspace, '.git'));

  writeFileSync(path.join(fixtureDir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>Project Desk Test</title>\n');
  writeFileSync(path.join(fixtureDir, 'host-config.json'), JSON.stringify({
    artifactDirectories: ['static'],
    workspaceEntries: [
      { path: nestedWorkspace, label: 'Poker App', group: 'Known services' },
      { path: secondNestedWorkspace, label: 'Poker Bots', group: 'Project tools' }
    ]
  }));
  writeFileSync(path.join(codexHome, 'models_cache.json'), '{"models":[]}\n');
  writeFileSync(gitModePath, 'normal\n');
  const fakeTestCredential = `sk-proj-${'x'.repeat(32)}`;
  writeFileSync(path.join(projectsRoot, 'AGENTS.md'), [
    '# Workspace rules',
    `Never print this synthetic test credential: OPENAI_API_KEY=${fakeTestCredential}`
  ].join('\n'));
  writeFileSync(path.join(workspace, 'CLAUDE.md'), '# Alpha instructions\nRun focused checks before reporting.\n');
  writeFileSync(path.join(outsideDir, 'secret.md'), 'outside instruction must never be returned\n');
  symlinkSync(path.join(outsideDir, 'secret.md'), path.join(workspace, 'AGENTS.md'));
  writeFileSync(path.join(deliverablesDir, 'release-notes.pdf'), '%PDF-1.4\nproject deliverable bytes\n%%EOF\n');
  deliverableHtmlPath = path.join(deliverablesDir, 'release-console.html');
  writeFileSync(deliverableHtmlPath, '<!doctype html>\n<html><body>Durable output console</body></html>\n');
  writeFileSync(path.join(deliverablesDir, 'private-notes.md'), '# not downloadable\n');
  distZipPath = path.join(workspaceDistDir, 'release-package.zip');
  writeFileSync(distZipPath, Buffer.from('504b0506000000000000000000000000000000000000', 'hex'));
  publicSiteHtmlPath = path.join(workspacePublicDir, 'index.html');
  writeFileSync(publicSiteHtmlPath, [
    '<!doctype html>',
    '<html><head>',
    '<meta http-equiv="Content-Security-Policy" content="default-src self">',
    '<link rel="stylesheet" href="/styles.css">',
    '<script src="/app.js" defer></script>',
    '</head><body>Static project site<img src="/assets/example.png" alt="Example"></body></html>',
    ''
  ].join('\n'));
  writeFileSync(path.join(workspacePublicDir, 'styles.css'), 'body { color: rgb(1, 2, 3); }\n');
  writeFileSync(path.join(workspacePublicDir, 'app.js'), 'document.body.dataset.previewReady = "yes";\n');
  mkdirSync(path.join(workspacePublicDir, 'assets'));
  writeFileSync(
    path.join(workspacePublicDir, 'assets', 'example.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  );
  writeFileSync(path.join(workspacePublicDir, 'unreferenced.js'), 'globalThis.PRIVATE_PREVIEW_SENTINEL = true;\n');
  writeFileSync(path.join(workspacePublicDir, 'private-notes.md'), '# not downloadable\n');
  staticSiteHtmlPath = path.join(workspaceStaticDir, 'index.html');
  writeFileSync(staticSiteHtmlPath, '<!doctype html><html><body>Configured static preview<script src="/preview.js"></script></body></html>\n');
  writeFileSync(path.join(workspaceStaticDir, 'preview.js'), 'document.body.dataset.staticPreviewReady = "yes";\n');
  const rootDocument = path.join(workspace, 'root-document.pdf');
  writeFileSync(rootDocument, '%PDF-1.4\nnot in an output folder\n%%EOF\n');
  const beforeSession = new Date('2023-11-14T22:13:19.000Z');
  utimesSync(rootDocument, beforeSession, beforeSession);
  durableRootHtmlPath = path.join(workspace, 'durable-console.html');
  writeFileSync(durableRootHtmlPath, '<!doctype html>\n<html><body>Durable root console</body></html>\n');
  utimesSync(durableRootHtmlPath, beforeSession, beforeSession);
  sessionMarkdownPath = path.join(workspace, 'session-call-sheet.md');
  sessionDocsMarkdownPath = path.join(workspaceDocsDir, 'developer-plan.md');
  sessionHtmlPath = path.join(workspace, 'session-call-sheet.html');
  writeFileSync(sessionMarkdownPath, '# Session call sheet\n\nCreated by the current exact agent session.\n');
  writeFileSync(sessionDocsMarkdownPath, '# Developer plan\n\nCurrent-session plan under docs.\n');
  const staleDocsMarkdownPath = path.join(workspaceDocsDir, 'old-plan.md');
  writeFileSync(staleDocsMarkdownPath, '# Old plan\n\nNot from the current session.\n');
  utimesSync(staleDocsMarkdownPath, beforeSession, beforeSession);
  writeFileSync(path.join(workspaceDocsDir, 'README.md'), '# Canonical documentation index\n');
  writeFileSync(path.join(workspaceDocsDir, 'not-markdown.txt'), 'not an artifact\n');
  writeFileSync(sessionHtmlPath, '<!doctype html>\n<html><body>Current session output</body></html>\n');
  writeFileSync(path.join(workspace, 'README.md'), '# Project metadata, not a downloadable session output\n');
  writeFileSync(path.join(nestedWorkspace, 'AGENTS.md'), '# Nested poker instructions\nUse the monorepo checks.\n');
  writeFileSync(path.join(nestedWorkspace, 'package.json'), JSON.stringify({
    scripts: { check: 'node --check nested.js', test: 'node --test nested' }
  }));
  nestedPlanPath = path.join(nestedDocsDir, 'developer-collaboration-plan.md');
  writeFileSync(nestedPlanPath, '# Collaboration plan\n\nDiscovered from the registered nested project.\n');
  const privateProjectDir = path.join(workspace, 'private-documents');
  mkdirSync(privateProjectDir, { recursive: true });
  writeFileSync(path.join(privateProjectDir, 'in-project-private.pdf'), '%PDF-1.4\nin-project private\n%%EOF\n');
  symlinkSync(privateProjectDir, path.join(workspace, 'output'));
  writeFileSync(path.join(outsideDir, 'outside.pdf'), '%PDF-1.4\noutside secret\n%%EOF\n');
  symlinkSync(path.join(outsideDir, 'outside.pdf'), path.join(deliverablesDir, 'outside-link.pdf'));
  writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
    scripts: {
      check: 'node --check app.js',
      test: 'node --test',
      start: 'touch SHOULD_NOT_RUN'
    }
  }));
  writeFileSync(path.join(fixtureDir, 'services.json'), JSON.stringify([
    {
      id: 'alpha-site',
      label: 'Alpha Site',
      cwd: workspace,
      ports: [4567],
      links: [{ label: 'Open Alpha', port: 4567, path: '/app' }]
    },
    {
      id: 'outside-site',
      label: 'Outside Site',
      cwd: outsideDir,
      ports: [9999],
      links: [{ label: 'Never Return', port: 9999, path: '/' }]
    }
  ]));

  writeExecutable(path.join(binDir, 'tmux'), `#!/bin/sh
printf 'tmux' >> "$ORCH_TOOL_LOG"
printf ' <%s>' "$@" >> "$ORCH_TOOL_LOG"
printf '\n' >> "$ORCH_TOOL_LOG"
case "$1" in
  list-panes)
    case "$3" in
      '=codex-alpha') printf '%s\n' "codex-alpha|1700000000|0|0|1|node|$PROJECT_DESK_WORKSPACE|%7|4242" ;;
      '=codex-outside') printf '%s\n' "codex-outside|1700000000|0|0|1|node|$PROJECT_DESK_OUTSIDE|%8|5252" ;;
      '=codex-parent') printf '%s\n' "codex-parent|1700000000|0|0|1|node|$PROJECT_DESK_PARENT|%9|6262" ;;
      *) exit 1 ;;
    esac
    ;;
  set-option)
    if [ "$2" = '-p' ] && [ "$3" = '-t' ] && [ "$4" = '%7' ] && [ "$5" = 'remain-on-exit' ] && [ "$6" = 'on' ]; then exit 0; fi
    exit 1
    ;;
  send-keys) exit 0 ;;
  *) exit 1 ;;
esac
`);
  writeExecutable(path.join(binDir, 'git'), `#!/bin/sh
printf 'git' >> "$ORCH_TOOL_LOG"
printf ' <%s>' "$@" >> "$ORCH_TOOL_LOG"
printf '\n' >> "$ORCH_TOOL_LOG"
mode="$(cat "$PROJECT_DESK_GIT_MODE" 2>/dev/null)"
if [ "$mode" = 'not-git' ]; then exit 2; fi
git_workspace=''
previous=''
for argument in "$@"; do
  if [ "$previous" = '-C' ]; then git_workspace="$argument"; break; fi
  previous="$argument"
done
if [ "$git_workspace" = "$PROJECT_DESK_PARENT" ]; then exit 2; fi
if [ "$git_workspace" = "$PROJECT_DESK_NESTED_SECOND" ] && [ "$mode" != 'nested-ambiguous' ]; then exit 2; fi
repo="$PROJECT_DESK_REPO"
branch='feature/project-desk'
if [ "$git_workspace" = "$PROJECT_DESK_NESTED" ] || [ "$git_workspace" = "$PROJECT_DESK_NESTED_SECOND" ]; then
  repo="$git_workspace"
  branch='feature/nested-project'
fi
if [ "$mode" = 'outside-root' ] && printf '%s ' "$@" | grep -q -- '--show-toplevel'; then
  printf '%s\n' "$PROJECT_DESK_OUTSIDE"
  exit 0
fi
if [ "$mode" = 'detached' ] && printf '%s ' "$@" | grep -q 'symbolic-ref --quiet HEAD'; then exit 1; fi
case " $* " in
  *' --show-toplevel '*) printf '%s\n' "$repo" ;;
  *' --absolute-git-dir '*) printf '%s/.git\n' "$repo" ;;
  *' --git-common-dir '*) printf '%s/.git\n' "$repo" ;;
  *' --show-object-format '*) printf '%s\n' 'sha1' ;;
  *' symbolic-ref --quiet HEAD '*) printf 'refs/heads/%s\n' "$branch" ;;
  *' rev-parse --verify HEAD '*) printf '%s\n' 'abc123def456abc123def456abc123def456abcd' ;;
  *) exit 2 ;;
esac
`);
  for (const name of ['aws', 'curl', 'npm', 'ps', 'ss']) {
    writeExecutable(path.join(binDir, name), `#!/bin/sh\nprintf '%s\\n' '${name}:FORBIDDEN' >> "$ORCH_TOOL_LOG"\nexit 97\n`);
  }

  const port = await unusedLoopbackPort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      ORCHESTRATOR_RUNTIME_ROOT: fixtureDir,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      CODEX_HOME: codexHome,
      ORCH_TOOL_LOG: toolLogPath,
      ORCH_CONTROL_PLANE_MODE: 'foreground',
      ORCHESTRATOR_PROJECTS_ROOT: projectsRoot,
      ORCHESTRATOR_AGENT_WORKSPACES_ROOT: path.join(projectsRoot, 'agent-workspaces'),
      ORCHESTRATOR_EXTRA_WORKSPACE_ROOTS: extraWorkspaceRoot,
      PROJECT_DESK_WORKSPACE: workspaceSubdir,
      PROJECT_DESK_REPO: workspace,
      PROJECT_DESK_PARENT: parentWorkspace,
      PROJECT_DESK_NESTED: nestedWorkspace,
      PROJECT_DESK_NESTED_SECOND: secondNestedWorkspace,
      PROJECT_DESK_OUTSIDE: outsideDir,
      PROJECT_DESK_GIT_MODE: gitModePath,
      SNAPSHOT_EVENT_MS: '3600000',
      SSH_RESCUE_MONITOR_MS: '3600000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });

  await waitForHttpServer({ baseUrl, child, output: () => childOutput });
  const index = await fetchWithTimeout(`${baseUrl}/`);
  controlCookie = String(index.headers.get('set-cookie') || '').split(';', 1)[0];
  assert.match(controlCookie, /^host_control_session=/);
  rmSync(toolLogPath, { force: true });
});

after(async () => {
  await stopChildProcess(child);
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

test('Project Desk requires the control cookie before inspecting tmux or git', async () => {
  const before = toolLog();
  const response = await request(deskPath(), { cookie: false });
  assert.equal(response.status, 401);
  assert.deepEqual(await responseJson(response), { error: 'control_session_required' });
  assert.equal(toolLog(), before);
});

test('Project Desk rejects incomplete durable identity before inspecting tmux or git', async () => {
  const before = toolLog();
  const response = await request('/api/project-desk/codex-alpha?paneId=codex-alpha%3A0.0');
  assert.equal(response.status, 400);
  assert.deepEqual(await responseJson(response), { error: 'invalid_agent_identity' });
  assert.equal(toolLog(), before);
});

test('Code City returns only bounded local structural metadata for an exact selectable project', async () => {
  const unauthenticated = await request(`/api/code-city?workspace=${encodeURIComponent(workspace)}`, { cookie: false });
  assert.equal(unauthenticated.status, 401);

  const before = toolLog();
  const response = await request(`/api/code-city?workspace=${encodeURIComponent(workspace)}`);
  assert.equal(response.status, 200, childOutput);
  const payload = await responseJson(response);
  assert.equal(payload.city.rootName, 'alpha');
  assert.deepEqual(payload.city.privacy, {
    sourceAnalyzedLocally: true,
    sourceContentIncluded: false,
    absolutePathsIncluded: false,
    externalRequestsRequired: false
  });
  assert.ok(payload.city.files.some((file) => file.path === 'public/app.js'));
  assert.equal(payload.city.version, 3);
  assert.ok(payload.city.files.every((file) => ['ui', 'backend', 'test', 'shared', 'config', 'docs', 'ops'].includes(file.role)));
  assert.ok(Array.isArray(payload.city.connections));
  const encoded = JSON.stringify(payload);
  assert.doesNotMatch(encoded, /PRIVATE_PREVIEW_SENTINEL|OPENAI_API_KEY|synthetic test credential/);
  assert.doesNotMatch(encoded, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(toolLog().slice(before.length), /git|npm|node /);

  const unlistedSubdirectory = await request(`/api/code-city?workspace=${encodeURIComponent(workspaceSubdir)}`);
  assert.equal(unlistedSubdirectory.status, 400);
  assert.deepEqual(await responseJson(unlistedSubdirectory), { error: 'code_city_workspace_not_selectable' });
  const outside = await request(`/api/code-city?workspace=${encodeURIComponent(outsideDir)}`);
  assert.equal(outside.status, 400);
  assert.deepEqual(await responseJson(outside), { error: 'code_city_workspace_invalid' });
});

test('Project Desk is exact-pane-bound and returns only capped, allowlisted project context', async () => {
  const response = await request(deskPath());
  assert.equal(response.status, 200, childOutput);
  const desk = await responseJson(response);

  assert.deepEqual(desk.identity, {
    session: 'codex-alpha',
    sessionCreatedAt: '2023-11-14T22:13:20.000Z',
    id: 'codex-alpha:0.0',
    tmuxPaneId: '%7',
    panePid: 4242
  });
  assert.equal(desk.workspace.path, workspaceSubdir);
  assert.equal(desk.workspace.projectPath, workspace);
  assert.equal(desk.workspace.name, 'alpha');
  assert.match(desk.workspace.key, /^[a-f0-9]{16}$/);

  assert.equal(desk.git.available, true);
  assert.equal(desk.git.branch, 'feature/project-desk');
  assert.equal(desk.git.head, 'abc123def456');
  assert.equal(desk.git.reason, 'working_tree_status_not_collected');
  assert.equal(desk.git.changedCount, null);
  assert.deepEqual(desk.git.changes, []);
  assert.equal(desk.git.truncated, false);
  assert.equal('canonicalRepoRoot' in desk.git, false);
  assert.equal('remote' in desk.git, false);

  assert.deepEqual(desk.checks.scripts, [
    { name: 'check', command: 'node --check app.js' },
    { name: 'test', command: 'node --test' }
  ]);
  assert.equal(desk.checks.scripts.some((script) => script.name === 'start'), false);
  assert.equal(existsSync(path.join(workspace, 'SHOULD_NOT_RUN')), false);

  assert.equal(desk.instructions.length, 2);
  assert.match(desk.instructions[0].excerpt, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(desk.instructions), /outside instruction/);
  assert.match(desk.instructions[1].excerpt, /Alpha instructions/);

  assert.deepEqual(desk.links, [{
    serviceId: 'alpha-site',
    serviceLabel: 'Alpha Site',
    label: 'Open Alpha',
    port: 4567,
    protocol: '',
    path: '/app'
  }]);
  assert.deepEqual(desk.artifacts.map((artifact) => ({
    name: artifact.name,
    path: artifact.path,
    type: artifact.type
  })).sort((left, right) => left.path.localeCompare(right.path)), [
    {
      name: 'release-console.html',
      path: 'deliverables/release-console.html',
      type: 'html'
    },
    {
      name: 'release-notes.pdf',
      path: 'deliverables/release-notes.pdf',
      type: 'pdf'
    },
    {
      name: 'release-package.zip',
      path: 'dist/release-package.zip',
      type: 'zip'
    },
    {
      name: 'developer-plan.md',
      path: 'docs/developer-plan.md',
      type: 'markdown'
    },
    {
      name: 'durable-console.html',
      path: 'durable-console.html',
      type: 'html'
    },
    {
      name: 'index.html',
      path: 'public/index.html',
      type: 'html'
    },
    {
      name: 'session-call-sheet.html',
      path: 'session-call-sheet.html',
      type: 'html'
    },
    {
      name: 'session-call-sheet.md',
      path: 'session-call-sheet.md',
      type: 'markdown'
    },
    {
      name: 'index.html',
      path: 'static/index.html',
      type: 'html'
    }
  ]);
  const releaseArtifact = desk.artifacts.find((artifact) => artifact.name === 'release-notes.pdf');
  assert.match(releaseArtifact.id, /^[a-f0-9]{32}$/);
  assert.equal(releaseArtifact.size, readFileSync(path.join(deliverablesDir, 'release-notes.pdf')).length);
  assert.doesNotMatch(JSON.stringify(desk.artifacts), /outside-link|private-notes|root-document|in-project-private|old-plan|not-markdown|README|\/home\//);
  assert.doesNotMatch(JSON.stringify(desk), /Never Return|9999/);
  assert.doesNotMatch(toolLog(), /FORBIDDEN/);
  assert.doesNotMatch(toolLog(), /<status>|<diff-files>|<hash-object>/, 'Project Desk must not invoke content-converting Git commands');
});

test('Project Desk resolves one registered nested Git project without moving the exact pane', async () => {
  const response = await request(deskPath('codex-parent'));
  assert.equal(response.status, 200, childOutput);
  const desk = await responseJson(response);

  assert.equal(desk.workspace.path, parentWorkspace);
  assert.equal(desk.workspace.terminalPath, parentWorkspace);
  assert.equal(desk.workspace.projectPath, nestedWorkspace);
  assert.equal(desk.workspace.resolution, 'registered_nested');
  assert.equal(desk.workspace.label, 'Poker App');
  assert.equal(desk.git.available, true);
  assert.equal(desk.git.branch, 'feature/nested-project');
  assert.deepEqual(desk.checks.scripts, [
    { name: 'check', command: 'node --check nested.js' },
    { name: 'test', command: 'node --test nested' }
  ]);
  assert.ok(desk.instructions.some((item) => item.path.endsWith('/poker/poker-monorepo/AGENTS.md')));
  const plan = desk.artifacts.find((item) => item.path === 'docs/developer-collaboration-plan.md');
  assert.ok(plan);

  const preview = await request(artifactPreviewPath(plan.id, 'codex-parent'));
  assert.equal(preview.status, 200, childOutput);
  assert.match(await preview.text(), /Discovered from the registered nested project/);
});

test('Project Desk fails closed instead of guessing between multiple registered nested repositories', async () => {
  writeFileSync(gitModePath, 'nested-ambiguous\n');
  try {
    const response = await request(deskPath('codex-parent'));
    assert.equal(response.status, 200, childOutput);
    const desk = await responseJson(response);
    assert.equal(desk.workspace.path, parentWorkspace);
    assert.equal(desk.workspace.projectPath, parentWorkspace);
    assert.equal(desk.workspace.resolution, 'ambiguous_nested');
    assert.equal(desk.git.available, false);
    assert.equal(desk.artifacts.length, 0);
  } finally {
    writeFileSync(gitModePath, 'normal\n');
  }
});

test('Project Desk reports bounded Git degradation states without failing the workspace view', async () => {
  const cases = [
    {
      mode: 'not-git',
      expected: { available: false, reason: 'not_git_repository', detached: false, changedCount: 0 }
    },
    {
      mode: 'outside-root',
      expected: { available: false, reason: 'repository_outside_allowed_workspace', detached: false, changedCount: 0 }
    },
    {
      mode: 'detached',
      expected: { available: true, reason: 'working_tree_status_not_collected', detached: true, changedCount: null }
    }
  ];

  try {
    for (const testCase of cases) {
      writeFileSync(gitModePath, `${testCase.mode}\n`);
      const response = await request(deskPath());
      const desk = await responseJson(response);
      assert.equal(response.status, 200, `${testCase.mode}: ${JSON.stringify(desk)}`);
      assert.equal(desk.git.available, testCase.expected.available, testCase.mode);
      assert.equal(desk.git.reason, testCase.expected.reason, testCase.mode);
      assert.equal(desk.git.detached, testCase.expected.detached, testCase.mode);
      assert.equal(desk.git.changedCount, testCase.expected.changedCount, testCase.mode);
      assert.equal('canonicalRepoRoot' in desk.git, false);
      assert.equal(JSON.stringify(desk.git).includes(outsideDir), false);
      if (testCase.expected.available) assert.deepEqual(desk.git.changes, []);
      if (testCase.mode === 'detached') {
        assert.equal(desk.git.branch, '');
        assert.equal(desk.git.head, 'abc123def456');
      }
    }
  } finally {
    writeFileSync(gitModePath, 'normal\n');
  }
});

test('Project Desk artifact downloads require the control cookie before tmux or files', async () => {
  const before = toolLog();
  const response = await request(artifactPath('0'.repeat(32)), { cookie: false });
  assert.equal(response.status, 401);
  assert.deepEqual(await responseJson(response), { error: 'control_session_required' });
  assert.equal(toolLog(), before);
});

test('Project Desk HTML previews require the control cookie before tmux or files', async () => {
  const before = toolLog();
  const response = await request(artifactPreviewPath('0'.repeat(32)), { cookie: false });
  assert.equal(response.status, 401);
  assert.deepEqual(await responseJson(response), { error: 'control_session_required' });
  assert.equal(toolLog(), before);
});

test('Project Desk downloads one discovered PDF with attachment headers', async () => {
  const desk = await responseJson(await request(deskPath()));
  const artifact = desk.artifacts.find((item) => item.name === 'release-notes.pdf');
  assert.ok(artifact);
  const response = await request(artifactPath(artifact.id));
  assert.equal(response.status, 200, childOutput);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.match(response.headers.get('content-disposition') || '', /^attachment;.*release-notes\.pdf/i);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(path.join(deliverablesDir, artifact.name)));
});

test('Project Desk downloads a validated ZIP from dist with attachment headers', async () => {
  const desk = await responseJson(await request(deskPath()));
  const artifact = desk.artifacts.find((item) => item.name === path.basename(distZipPath));
  assert.ok(artifact);
  assert.equal(artifact.path, 'dist/release-package.zip');
  assert.equal(artifact.type, 'zip');
  const response = await request(artifactPath(artifact.id));
  assert.equal(response.status, 200, childOutput);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(response.headers.get('content-disposition') || '', /^attachment;.*release-package\.zip/i);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(distZipPath));
});

test('Project Desk downloads current-session Markdown plus durable HTML outputs', async () => {
  const desk = await responseJson(await request(deskPath()));
  const cases = [
    {
      name: path.basename(sessionMarkdownPath),
      file: sessionMarkdownPath,
      contentType: 'text/markdown; charset=utf-8'
    },
    {
      name: path.basename(sessionDocsMarkdownPath),
      file: sessionDocsMarkdownPath,
      contentType: 'text/markdown; charset=utf-8'
    },
    {
      name: path.basename(sessionHtmlPath),
      file: sessionHtmlPath,
      contentType: 'text/html; charset=utf-8'
    },
    {
      name: path.basename(durableRootHtmlPath),
      file: durableRootHtmlPath,
      contentType: 'text/html; charset=utf-8'
    },
    {
      name: path.basename(deliverableHtmlPath),
      file: deliverableHtmlPath,
      contentType: 'text/html; charset=utf-8'
    },
    {
      name: path.basename(publicSiteHtmlPath),
      file: publicSiteHtmlPath,
      contentType: 'text/html; charset=utf-8'
    }
  ];
  for (const testCase of cases) {
    const expectedPath = path.relative(workspace, testCase.file).split(path.sep).join('/');
    const artifact = desk.artifacts.find((item) => item.path === expectedPath);
    assert.ok(artifact, testCase.name);
    const response = await request(artifactPath(artifact.id));
    assert.equal(response.status, 200, childOutput);
    assert.equal(response.headers.get('content-type'), testCase.contentType);
    assert.match(
      response.headers.get('content-disposition') || '',
      new RegExp('^attachment;.*' + testCase.name.replace('.', '\\.'), 'i')
    );
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(testCase.file));
  }
});

test('Project Desk serves current-session Markdown as an escaped mobile-readable preview', async () => {
  const desk = await responseJson(await request(deskPath()));
  const artifact = desk.artifacts.find((item) => item.path === 'docs/developer-plan.md');
  assert.ok(artifact);
  const original = readFileSync(sessionDocsMarkdownPath, 'utf8');
  writeFileSync(sessionDocsMarkdownPath, `${original}<script>globalThis.PREVIEW_ESCAPE_FAILURE = true;</script>\n`);
  try {
    const refreshedDesk = await responseJson(await request(deskPath()));
    const refreshedArtifact = refreshedDesk.artifacts.find((item) => item.path === 'docs/developer-plan.md');
    const response = await request(artifactPreviewPath(refreshedArtifact.id));
    assert.equal(response.status, 200, childOutput);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('content-disposition'), 'inline');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match(response.headers.get('content-security-policy') || '', /^sandbox;/);
    assert.doesNotMatch(response.headers.get('content-security-policy') || '', /allow-scripts|script-src/);
    const html = await response.text();
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /white-space:pre-wrap/);
    assert.match(html, /&lt;script&gt;globalThis\.PREVIEW_ESCAPE_FAILURE = true;&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/);
  } finally {
    writeFileSync(sessionDocsMarkdownPath, original);
  }
});

test('Project Desk serves a self-contained sandboxed preview for output-folder HTML', async () => {
  const desk = await responseJson(await request(deskPath()));
  const artifact = desk.artifacts.find((item) => item.path === 'public/index.html');
  assert.ok(artifact);
  const response = await request(artifactPreviewPath(artifact.id));
  assert.equal(response.status, 200, childOutput);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('content-disposition'), 'inline');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy') || '', /sandbox allow-scripts/);
  assert.match(response.headers.get('content-security-policy') || '', /connect-src 'none'/);
  assert.match(response.headers.get('content-security-policy') || '', /form-action 'none'/);
  assert.match(response.headers.get('permissions-policy') || '', /camera=\(\)/);
  const html = await response.text();
  assert.match(html, /<style>body \{ color: rgb\(1, 2, 3\); \}/);
  assert.match(html, /<script>document\.body\.dataset\.previewReady = "yes";/);
  assert.match(html, /src="data:image\/png;base64,/);
  assert.ok(html.indexOf('<script>') > html.indexOf('Static project site'));
  assert.ok(html.indexOf('<script>') < html.indexOf('</body>'));
  assert.doesNotMatch(html, /http-equiv="Content-Security-Policy"/i);
  assert.doesNotMatch(html, /href="\/styles\.css"|src="\/(?:app\.js|assets\/example\.png)"/);
  assert.doesNotMatch(html, /PRIVATE_PREVIEW_SENTINEL/);
});

test('Project Desk validates and embeds each allowlisted image signature', async () => {
  const originalHtml = readFileSync(publicSiteHtmlPath, 'utf8');
  const assets = [
    ['fixture.jpg', Buffer.from([0xff, 0xd8, 0xff, 0x00])],
    ['fixture.gif', Buffer.from('GIF89a', 'ascii')],
    ['fixture.webp', Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii')])]
  ];
  for (const [name, payload] of assets) writeFileSync(path.join(workspacePublicDir, 'assets', name), payload);
  writeFileSync(publicSiteHtmlPath, `<!doctype html><html><body>${assets
    .map(([name]) => `<img src="/assets/${name}">`)
    .join('')}</body></html>\n`);
  try {
    const desk = await responseJson(await request(deskPath()));
    const artifact = desk.artifacts.find((item) => item.path === 'public/index.html');
    assert.ok(artifact);
    const response = await request(artifactPreviewPath(artifact.id));
    assert.equal(response.status, 200, childOutput);
    const html = await response.text();
    assert.match(html, /data:image\/jpeg;base64,/);
    assert.match(html, /data:image\/gif;base64,/);
    assert.match(html, /data:image\/webp;base64,/);
  } finally {
    writeFileSync(publicSiteHtmlPath, originalHtml);
    for (const [name] of assets) rmSync(path.join(workspacePublicDir, 'assets', name), { force: true });
  }
});

test('Project Desk previews HTML from a configured static output folder', async () => {
  const desk = await responseJson(await request(deskPath()));
  const artifact = desk.artifacts.find((item) => item.path === 'static/index.html');
  assert.ok(artifact);
  const response = await request(artifactPreviewPath(artifact.id));
  assert.equal(response.status, 200, childOutput);
  const html = await response.text();
  assert.match(html, /Configured static preview/);
  assert.match(html, /document\.body\.dataset\.staticPreviewReady = "yes"/);
});

test('Project Desk does not preview root HTML outside a reviewed output folder', async () => {
  const desk = await responseJson(await request(deskPath()));
  const artifact = desk.artifacts.find((item) => item.path === 'durable-console.html');
  assert.ok(artifact);
  const response = await request(artifactPreviewPath(artifact.id));
  assert.equal(response.status, 415);
  assert.deepEqual(await responseJson(response), { error: 'artifact_preview_not_allowed' });
});

test('Project Desk preview refuses referenced assets outside the reviewed output folder', async () => {
  const originalHtml = readFileSync(publicSiteHtmlPath, 'utf8');
  const outsideAsset = path.join(workspace, 'project-secret.js');
  writeFileSync(outsideAsset, 'globalThis.PROJECT_SECRET_SENTINEL = true;\n');
  writeFileSync(publicSiteHtmlPath, '<!doctype html><html><body><script src="../project-secret.js"></script></body></html>\n');
  try {
    const desk = await responseJson(await request(deskPath()));
    const artifact = desk.artifacts.find((item) => item.path === 'public/index.html');
    assert.ok(artifact);
    const response = await request(artifactPreviewPath(artifact.id));
    assert.equal(response.status, 409);
    assert.deepEqual(await responseJson(response), { error: 'artifact_preview_asset_unavailable' });
  } finally {
    writeFileSync(publicSiteHtmlPath, originalHtml);
    rmSync(outsideAsset, { force: true });
  }
});

test('Project Desk preview rejects an image extension carrying non-image content', async () => {
  const imagePath = path.join(workspacePublicDir, 'assets', 'example.png');
  const originalImage = readFileSync(imagePath);
  writeFileSync(imagePath, '<script>globalThis.NOT_AN_IMAGE = true;</script>\n');
  try {
    const desk = await responseJson(await request(deskPath()));
    const artifact = desk.artifacts.find((item) => item.path === 'public/index.html');
    assert.ok(artifact);
    const response = await request(artifactPreviewPath(artifact.id));
    assert.equal(response.status, 415);
    assert.deepEqual(await responseJson(response), { error: 'artifact_preview_asset_content_not_allowed' });
  } finally {
    writeFileSync(imagePath, originalImage);
  }
});

test('Project Desk rejects non-PDF content carrying a .pdf filename', async () => {
  const fakePdf = path.join(deliverablesDir, 'not-really-a-pdf.pdf');
  writeFileSync(fakePdf, 'plain text with a misleading extension\n');
  try {
    const desk = await responseJson(await request(deskPath()));
    const artifact = desk.artifacts.find((item) => item.name === path.basename(fakePdf));
    assert.ok(artifact);
    const response = await request(artifactPath(artifact.id));
    assert.equal(response.status, 415);
    assert.deepEqual(await responseJson(response), { error: 'artifact_content_not_allowed' });
  } finally {
    rmSync(fakePdf, { force: true });
  }
});

test('Project Desk rejects non-ZIP content carrying a .zip filename', async () => {
  const fakeZip = path.join(workspaceDistDir, 'not-really-a-zip.zip');
  writeFileSync(fakeZip, 'plain text with a misleading extension\n');
  try {
    const desk = await responseJson(await request(deskPath()));
    const artifact = desk.artifacts.find((item) => item.name === path.basename(fakeZip));
    assert.ok(artifact);
    const response = await request(artifactPath(artifact.id));
    assert.equal(response.status, 415);
    assert.deepEqual(await responseJson(response), { error: 'artifact_content_not_allowed' });
  } finally {
    rmSync(fakeZip, { force: true });
  }
});

test('Project Desk rejects binary Markdown and non-HTML session files', async () => {
  const invalidMarkdown = path.join(workspace, 'invalid-session-output.md');
  const invalidHtml = path.join(workspace, 'invalid-session-output.html');
  writeFileSync(invalidMarkdown, Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  writeFileSync(invalidHtml, 'plain text with a misleading HTML extension\n');
  try {
    const desk = await responseJson(await request(deskPath()));
    for (const filename of [path.basename(invalidMarkdown), path.basename(invalidHtml)]) {
      const artifact = desk.artifacts.find((item) => item.name === filename);
      assert.ok(artifact, filename);
      const response = await request(artifactPath(artifact.id));
      assert.equal(response.status, 415);
      assert.deepEqual(await responseJson(response), { error: 'artifact_content_not_allowed' });
    }
  } finally {
    rmSync(invalidMarkdown, { force: true });
    rmSync(invalidHtml, { force: true });
  }
});

test('Project Desk pins the opened descriptor to the exact discovered file', () => {
  const source = readFileSync(path.join(projectDir, 'server.js'), 'utf8');
  const start = source.indexOf('async function pinnedProjectFilePayload');
  const end = source.indexOf('\nasync function ', start + 1);
  const pinnedReadSource = source.slice(start, end < 0 ? undefined : end);
  assert.ok(start >= 0);
  assert.match(pinnedReadSource, /openedPath !== file\.path/);
  assert.match(pinnedReadSource, /!isSameOrChild\(openedPath, file\.outputRoot\)/);
  assert.match(pinnedReadSource, /details\.dev !== file\.device/);
  assert.match(pinnedReadSource, /details\.ino !== file\.inode/);
});

test('Project Desk artifact IDs cannot traverse, escape by symlink, or survive stale pane identity', async () => {
  const beforeMalformed = toolLog();
  const unknown = await request(artifactPath('../outside.pdf'));
  assert.equal(unknown.status, 404);
  assert.deepEqual(await responseJson(unknown), { error: 'artifact_not_found' });
  assert.equal(toolLog(), beforeMalformed);

  const stale = await request(artifactPath('0'.repeat(32), 'codex-alpha', {
    sessionCreatedAt: '2023-11-14T22:13:21.000Z'
  }));
  assert.equal(stale.status, 409);
  assert.deepEqual(await responseJson(stale), { error: 'agent_pane_replaced' });

  const desk = await responseJson(await request(deskPath()));
  assert.doesNotMatch(JSON.stringify(desk.artifacts), /outside-link|outside\.pdf/);
});

test('Project Desk omits oversized PDFs and rejects an artifact swapped to an outside symlink', async () => {
  const exportsDir = path.join(workspace, 'exports');
  mkdirSync(exportsDir, { recursive: true });
  const oversized = path.join(exportsDir, 'oversized.pdf');
  writeFileSync(oversized, '%PDF-1.4\n');
  truncateSync(oversized, 20 * 1024 * 1024 + 1);

  const swapPath = path.join(deliverablesDir, 'swap.pdf');
  writeFileSync(swapPath, '%PDF-1.4\nsafe before swap\n%%EOF\n');
  const desk = await responseJson(await request(deskPath()));
  assert.doesNotMatch(JSON.stringify(desk.artifacts), /oversized\.pdf/);
  const swap = desk.artifacts.find((artifact) => artifact.name === 'swap.pdf');
  assert.ok(swap);

  rmSync(swapPath);
  symlinkSync(path.join(outsideDir, 'outside.pdf'), swapPath);
  const response = await request(artifactPath(swap.id));
  assert.equal(response.status, 404);
  assert.deepEqual(await responseJson(response), { error: 'artifact_not_found' });
  rmSync(swapPath);
  rmSync(exportsDir, { recursive: true, force: true });
});

test('Project Desk rejects stale identity and workspaces outside allowed roots before git', async () => {
  const beforeStale = toolLog();
  const stale = await request(deskPath('codex-alpha', { sessionCreatedAt: '2023-11-14T22:13:21.000Z' }));
  assert.equal(stale.status, 409);
  assert.deepEqual(await responseJson(stale), { error: 'agent_pane_replaced' });
  assert.doesNotMatch(toolLog().slice(beforeStale.length), /git/);

  const beforeOutside = toolLog();
  const outside = await request(deskPath('codex-outside'));
  assert.equal(outside.status, 403);
  assert.deepEqual(await responseJson(outside), { error: 'workspace_not_allowed' });
  assert.doesNotMatch(toolLog().slice(beforeOutside.length), /git/);
});

test('normal agent send validates optional durable identity and refuses stale panes before input', async () => {
  const beforePartial = toolLog();
  const partial = await request('/api/agent/send', {
    method: 'POST',
    body: { session: 'codex-alpha', text: 'not sent', paneId: 'codex-alpha:0.0' }
  });
  assert.equal(partial.status, 400);
  assert.deepEqual(await responseJson(partial), { error: 'invalid_agent_identity' });
  assert.equal(toolLog(), beforePartial);

  const beforeStale = toolLog();
  const stale = await request('/api/agent/send', {
    method: 'POST',
    body: {
      session: 'codex-alpha',
      text: 'still not sent',
      sessionCreatedAt: '2023-11-14T22:13:21.000Z',
      paneId: 'codex-alpha:0.0',
      tmuxPaneId: '%7',
      panePid: 4242
    }
  });
  assert.equal(stale.status, 409);
  assert.equal((await responseJson(stale)).error, 'agent_session_replaced');
  const attempted = toolLog().slice(beforeStale.length);
  assert.match(attempted, /tmux <list-panes>/);
  assert.doesNotMatch(attempted, /send-keys/);

  const beforeValid = toolLog();
  const valid = await request('/api/agent/send', {
    method: 'POST',
    body: {
      session: 'codex-alpha',
      text: 'safe fixture input',
      sessionCreatedAt: '2023-11-14T22:13:20.000Z',
      paneId: 'codex-alpha:0.0',
      tmuxPaneId: '%7',
      panePid: 4242
    }
  });
  assert.equal(valid.status, 200);
  assert.equal((await responseJson(valid)).submitted, true);
  const delivered = toolLog().slice(beforeValid.length);
  assert.equal((delivered.match(/tmux <send-keys>/g) || []).length, 2);
  assert.match(delivered, /tmux <set-option> <-p> <-t> <%7> <remain-on-exit> <on>/);
  assert.ok(delivered.indexOf('tmux <set-option>') < delivered.indexOf('tmux <send-keys>'));
});
