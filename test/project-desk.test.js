import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
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
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

let fixtureDir;
let projectsRoot;
let workspace;
let workspaceSubdir;
let deliverablesDir;
let sessionMarkdownPath;
let sessionHtmlPath;
let outsideDir;
let toolLogPath;
let gitModePath;
let child;
let childOutput = '';
let baseUrl;
let controlCookie;

async function unusedLoopbackPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function writeExecutable(file, source) {
  writeFileSync(file, source, { mode: 0o755 });
  chmodSync(file, 0o755);
}

function toolLog() {
  return existsSync(toolLogPath) ? readFileSync(toolLogPath, 'utf8') : '';
}

async function request(pathname, { method = 'GET', body, cookie = true } = {}) {
  const headers = {};
  if (cookie && controlCookie) headers.cookie = controlCookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    return await fetch(`${baseUrl}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function responseJson(response) {
  return JSON.parse(await response.text());
}

function deskPath(session = 'codex-alpha', overrides = {}) {
  const values = {
    sessionCreatedAt: '2023-11-14T22:13:20.000Z',
    paneId: `${session}:0.0`,
    tmuxPaneId: session === 'codex-outside' ? '%8' : '%7',
    panePid: session === 'codex-outside' ? '5252' : '4242',
    ...overrides
  };
  return `/api/project-desk/${encodeURIComponent(session)}?${new URLSearchParams(values)}`;
}

function artifactPath(id, session = 'codex-alpha', overrides = {}) {
  const query = deskPath(session, overrides).split('?', 2)[1];
  return `/api/project-desk/${encodeURIComponent(session)}/artifacts/${encodeURIComponent(id)}?${query}`;
}

before(async () => {
  fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'agent-orchestrator-project-desk-'));
  projectsRoot = path.join(fixtureDir, 'projects');
  workspace = path.join(projectsRoot, 'alpha');
  workspaceSubdir = path.join(workspace, 'src');
  deliverablesDir = path.join(workspace, 'deliverables');
  outsideDir = path.join(fixtureDir, 'outside');
  const codexHome = path.join(fixtureDir, 'codex-home');
  const extraWorkspaceRoot = path.join(fixtureDir, 'extra-workspace');
  const binDir = path.join(fixtureDir, 'bin');
  const publicDir = path.join(fixtureDir, 'public');
  toolLogPath = path.join(fixtureDir, 'tools.log');
  gitModePath = path.join(fixtureDir, 'git-mode');
  for (const directory of [projectsRoot, workspaceSubdir, deliverablesDir, outsideDir, codexHome, extraWorkspaceRoot, binDir, publicDir]) {
    mkdirSync(directory, { recursive: true });
  }

  writeFileSync(path.join(fixtureDir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>Project Desk Test</title>\n');
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
  writeFileSync(path.join(deliverablesDir, 'private-notes.md'), '# not downloadable\n');
  const rootDocument = path.join(workspace, 'root-document.pdf');
  writeFileSync(rootDocument, '%PDF-1.4\nnot in an output folder\n%%EOF\n');
  const beforeSession = new Date('2023-11-14T22:13:19.000Z');
  utimesSync(rootDocument, beforeSession, beforeSession);
  sessionMarkdownPath = path.join(workspace, 'session-call-sheet.md');
  sessionHtmlPath = path.join(workspace, 'session-call-sheet.html');
  writeFileSync(sessionMarkdownPath, '# Session call sheet\n\nCreated by the current exact agent session.\n');
  writeFileSync(sessionHtmlPath, '<!doctype html>\n<html><body>Current session output</body></html>\n');
  writeFileSync(path.join(workspace, 'README.md'), '# Project metadata, not a downloadable session output\n');
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
if [ "$mode" = 'outside-root' ] && printf '%s ' "$@" | grep -q 'rev-parse --show-toplevel'; then
  printf '%s\n' "$PROJECT_DESK_OUTSIDE"
  exit 0
fi
if [ "$mode" = 'detached' ] && printf '%s ' "$@" | grep -q 'symbolic-ref --quiet --short HEAD'; then exit 1; fi
if [ "$mode" = 'status-fail' ] && printf '%s ' "$@" | grep -q 'status --porcelain=v1'; then exit 3; fi
case " $* " in
  *' rev-parse --show-toplevel '*) printf '%s\n' "$PROJECT_DESK_REPO" ;;
  *' symbolic-ref --quiet --short HEAD '*) printf '%s\n' 'feature/project-desk' ;;
  *' rev-parse --short=12 HEAD '*) printf '%s\n' 'abc123def456' ;;
  *' status --porcelain=v1 -z '*)
    index=1
    while [ "$index" -le 105 ]; do
      printf ' M file-%03d.js\\0' "$index"
      index=$((index + 1))
    done
    ;;
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
      PROJECT_DESK_OUTSIDE: outsideDir,
      PROJECT_DESK_GIT_MODE: gitModePath,
      SNAPSHOT_EVENT_MS: '3600000',
      SSH_RESCUE_MONITOR_MS: '3600000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated server exited early (${child.exitCode})\n${childOutput}`);
    try {
      const health = await fetch(`${baseUrl}/healthz`);
      if (health.status === 200) break;
    } catch {
      // Server is still binding.
    }
    await delay(50);
  }
  const index = await fetch(`${baseUrl}/`);
  controlCookie = String(index.headers.get('set-cookie') || '').split(';', 1)[0];
  assert.match(controlCookie, /^host_control_session=/);
  rmSync(toolLogPath, { force: true });
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), delay(2000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
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
  assert.equal(desk.git.changedCount, 105);
  assert.equal(desk.git.changes.length, 100);
  assert.equal(desk.git.truncated, true);
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
      name: 'release-notes.pdf',
      path: 'deliverables/release-notes.pdf',
      type: 'pdf'
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
    }
  ]);
  const releaseArtifact = desk.artifacts.find((artifact) => artifact.name === 'release-notes.pdf');
  assert.match(releaseArtifact.id, /^[a-f0-9]{32}$/);
  assert.equal(releaseArtifact.size, readFileSync(path.join(deliverablesDir, 'release-notes.pdf')).length);
  assert.doesNotMatch(JSON.stringify(desk.artifacts), /outside-link|private-notes|root-document|in-project-private|README|\/home\//);
  assert.doesNotMatch(JSON.stringify(desk), /Never Return|9999/);
  assert.doesNotMatch(toolLog(), /FORBIDDEN/);
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
      expected: { available: true, reason: '', detached: true, changedCount: 105 }
    },
    {
      mode: 'status-fail',
      expected: { available: true, reason: 'status_unavailable', detached: false, changedCount: null }
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
      if (testCase.mode === 'status-fail') assert.deepEqual(desk.git.changes, []);
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

test('Project Desk downloads Markdown and HTML created during the exact agent session', async () => {
  const desk = await responseJson(await request(deskPath()));
  const cases = [
    {
      name: path.basename(sessionMarkdownPath),
      file: sessionMarkdownPath,
      contentType: 'text/markdown; charset=utf-8'
    },
    {
      name: path.basename(sessionHtmlPath),
      file: sessionHtmlPath,
      contentType: 'text/html; charset=utf-8'
    }
  ];
  for (const testCase of cases) {
    const artifact = desk.artifacts.find((item) => item.name === testCase.name);
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
  const start = source.indexOf('async function serveProjectDeskArtifact');
  const end = source.indexOf('\nasync function ', start + 1);
  const downloadSource = source.slice(start, end < 0 ? undefined : end);
  assert.ok(start >= 0);
  assert.match(downloadSource, /openedPath !== result\.file\.path/);
  assert.match(downloadSource, /!isSameOrChild\(openedPath, result\.file\.outputRoot\)/);
  assert.match(downloadSource, /details\.dev !== result\.file\.device/);
  assert.match(downloadSource, /details\.ino !== result\.file\.inode/);
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
