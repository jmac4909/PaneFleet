import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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

async function request(baseUrl, pathname, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    return await fetch(`${baseUrl}${pathname}`, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`isolated server exited early (${child.exitCode ?? child.signalCode})\n${output()}`);
    }
    try {
      const response = await request(baseUrl, '/healthz');
      if (response.status === 200) return;
    } catch {
      // The isolated child may still be binding its listener.
    }
    await delay(50);
  }
  throw new Error(`isolated server did not become ready\n${output()}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), delay(2000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function installCommandTrap(binDir, toolLogPath, name) {
  writeFileSync(
    path.join(binDir, name),
    `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${toolLogPath}'\nexit 97\n`,
    { mode: 0o755 }
  );
}

test('non-loopback access defaults to operator auth and trusted-network mode remains cookie-gated', async (t) => {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'host-control-network-auth-'));
  const homeDir = path.join(fixtureDir, 'home');
  const projectsRoot = path.join(homeDir, 'projects');
  const agentWorkspacesRoot = path.join(projectsRoot, 'agent-workspaces');
  const codexHome = path.join(homeDir, '.codex');
  const binDir = path.join(fixtureDir, 'isolated-bin');
  const publicDir = path.join(fixtureDir, 'public');
  const tmpDir = path.join(fixtureDir, 'tmp');
  const toolLogPath = path.join(fixtureDir, 'host-command-attempts.log');
  let child;
  let childOutput = '';

  try {
    for (const directory of [homeDir, projectsRoot, agentWorkspacesRoot, codexHome, binDir, publicDir, tmpDir]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(path.join(fixtureDir, 'package.json'), '{"type":"module"}\n');
    writeFileSync(path.join(fixtureDir, 'services.json'), '[]\n');
    writeFileSync(path.join(fixtureDir, 'host-config.json'), '{}\n');
    writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>Network Auth Test</title>\n');
    writeFileSync(path.join(codexHome, 'models_cache.json'), '{"models":[]}\n');

    // PATH contains only failing fixtures. A regression cannot fall through to
    // tmux, AWS, metadata, Git, or host process tools installed on the machine.
    for (const name of ['aws', 'bash', 'curl', 'git', 'ps', 'ss', 'tmux']) {
      installCommandTrap(binDir, toolLogPath, name);
    }

    const port = await unusedLoopbackPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const baseEnvironment = {
      HOME: homeDir,
      HOST: '0.0.0.0',
      PATH: binDir,
      TMPDIR: tmpDir,
      NODE_ENV: 'test',
      CODEX_HOME: codexHome,
      ORCHESTRATOR_RUNTIME_ROOT: fixtureDir,
      ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
      ORCH_CONTROL_PLANE_MODE: 'foreground',
      ORCH_TOOL_LOG: toolLogPath,
      ORCHESTRATOR_SECURE_COOKIE: '1',
      ORCHESTRATOR_HOST_CONFIG: path.join(fixtureDir, 'host-config.json'),
      ORCHESTRATOR_PROJECTS_ROOT: projectsRoot,
      ORCHESTRATOR_AGENT_WORKSPACES_ROOT: agentWorkspacesRoot,
      AWS_EC2_METADATA_DISABLED: 'true',
      SNAPSHOT_EVENT_MS: '3600000',
      SSH_RESCUE_MONITOR_MS: '3600000'
    };
    child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
      cwd: fixtureDir,
      env: {
        ...baseEnvironment,
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk) => { childOutput += chunk; });
    child.stderr.on('data', (chunk) => { childOutput += chunk; });
    await waitForServer(baseUrl, child, () => childOutput);

    const accessTokenPath = path.join(fixtureDir, 'data', 'access-token');
    const operatorToken = readFileSync(accessTokenPath, 'utf8').trim();
    const operatorAuthorization = `Basic ${Buffer.from(`host-control:${operatorToken}`).toString('base64')}`;
    assert.match(operatorToken, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(statSync(accessTokenPath).mode & 0o777, 0o600);

    await t.test('anonymous static and API requests receive a Basic challenge', async () => {
      for (const pathname of ['/', '/api/audit']) {
        const response = await request(baseUrl, pathname);
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('www-authenticate'), 'Basic realm="PaneFleet", charset="UTF-8"');
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(await response.text(), 'Operator authentication required.\n');
      }
    });

    await t.test('malformed and same-length incorrect Basic credentials never issue a control cookie', async () => {
      const replacement = operatorToken.endsWith('A') ? 'B' : 'A';
      const wrongToken = operatorToken.slice(0, -1) + replacement;
      const authorizations = [
        'Basic ' + Buffer.from('host-control-without-password').toString('base64'),
        'Basic ' + Buffer.from('host-control:' + wrongToken).toString('base64')
      ];
      for (const authorization of authorizations) {
        const response = await request(baseUrl, '/', { headers: { authorization } });
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(response.headers.get('www-authenticate'), 'Basic realm="PaneFleet", charset="UTF-8"');
      }
    });

    await t.test('health remains minimal and public', async () => {
      const response = await request(baseUrl, '/healthz');
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /^text\/plain\b/);
      assert.equal(response.headers.get('www-authenticate'), null);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(await response.text(), 'ok\n');
    });

    let controlCookie = '';
    await t.test('the generated operator credential allows the index to issue a secure control cookie', async () => {
      const response = await request(baseUrl, '/', {
        headers: { authorization: operatorAuthorization }
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /^text\/html\b/);
      assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
      const setCookie = response.headers.get('set-cookie') || '';
      assert.match(setCookie, /^host_control_session=[^;]+;/);
      assert.match(setCookie, /\bHttpOnly\b/i);
      assert.match(setCookie, /\bSameSite=Strict\b/i);
      assert.match(setCookie, /\bSecure\b/i);
      controlCookie = setCookie.split(';', 1)[0];
    });

    await t.test('an authenticated operator still needs the control cookie for APIs', async () => {
      const withoutCookie = await request(baseUrl, '/api/audit', {
        headers: { authorization: operatorAuthorization }
      });
      assert.equal(withoutCookie.status, 401);
      assert.equal(withoutCookie.headers.get('www-authenticate'), null);
      assert.deepEqual(await withoutCookie.json(), { error: 'control_session_required' });

      const withCookie = await request(baseUrl, '/api/audit', {
        headers: {
          authorization: operatorAuthorization,
          cookie: controlCookie
        }
      });
      assert.equal(withCookie.status, 200);
      assert.deepEqual(await withCookie.json(), { audit: [] });
    });

    await t.test('trusted-network mode removes Basic but retains the same-page API cookie', async () => {
      await stopServer(child);
      child = null;
      rmSync(accessTokenPath, { force: true });
      childOutput = '';
      const trustedPort = await unusedLoopbackPort();
      const trustedBaseUrl = `http://127.0.0.1:${trustedPort}`;
      child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
        cwd: fixtureDir,
        env: {
          ...baseEnvironment,
          PORT: String(trustedPort),
          ORCHESTRATOR_ACCESS_MODE: 'trusted-network'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      child.stdout.on('data', (chunk) => { childOutput += chunk; });
      child.stderr.on('data', (chunk) => { childOutput += chunk; });
      await waitForServer(trustedBaseUrl, child, () => childOutput);

      const indexResponse = await request(trustedBaseUrl, '/');
      assert.equal(indexResponse.status, 200);
      assert.equal(indexResponse.headers.get('www-authenticate'), null);
      const setCookie = indexResponse.headers.get('set-cookie') || '';
      assert.match(setCookie, /^host_control_session=[^;]+;/);
      const trustedCookie = setCookie.split(';', 1)[0];
      assert.equal(existsSync(accessTokenPath), false);

      const withoutCookie = await request(trustedBaseUrl, '/api/audit');
      assert.equal(withoutCookie.status, 401);
      assert.deepEqual(await withoutCookie.json(), { error: 'control_session_required' });

      const withCookie = await request(trustedBaseUrl, '/api/audit', {
        headers: { cookie: trustedCookie }
      });
      assert.equal(withCookie.status, 200);
      assert.deepEqual(await withCookie.json(), { audit: [] });
    });

    assert.equal(existsSync(toolLogPath) ? readFileSync(toolLogPath, 'utf8') : '', '');
  } finally {
    await stopServer(child);
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
