import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import bcrypt from 'bcryptjs';
import { stopChildProcess, waitForChildExit } from './helpers/child-process.js';
import { installBlockedTool } from './helpers/executables.js';
import { fetchWithTimeout, waitForHttpServer } from './helpers/http.js';
import { unusedLoopbackPort } from './helpers/unused-loopback-port.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');
async function request(baseUrl, pathname, options = {}) {
  return fetchWithTimeout(`${baseUrl}${pathname}`, options, 3000);
}

function rawPost(baseUrl, pathname, { body, headers }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(pathname, baseUrl), {
      method: 'POST',
      headers: {
        ...headers,
        'content-length': Buffer.byteLength(body)
      }
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        body: responseBody
      }));
    });
    request.setTimeout(3000, () => request.destroy(new Error('raw request timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

test('non-loopback access defaults to operator auth and trusted-network mode remains cookie-gated', async (t) => {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'host-control-network-auth-'));
  const planningRuntimeRoot = path.join(
    path.dirname(fixtureDir),
    `.host-control-network-auth-planning-${path.basename(fixtureDir)}`
  );
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
    writeFileSync(path.join(publicDir, 'login.css'), 'body { background: #070b12; }\n');
    writeFileSync(path.join(codexHome, 'models_cache.json'), '{"models":[]}\n');

    // PATH contains only failing fixtures. A regression cannot fall through to
    // tmux, AWS, metadata, Git, or host process tools installed on the machine.
    for (const name of ['aws', 'bash', 'curl', 'git', 'ps', 'ss', 'tmux']) {
      installBlockedTool(binDir, name);
    }

    const baseEnvironment = {
      HOME: homeDir,
      HOST: '0.0.0.0',
      PATH: binDir,
      TMPDIR: tmpDir,
      NODE_ENV: 'test',
      CODEX_HOME: codexHome,
      ORCHESTRATOR_RUNTIME_ROOT: fixtureDir,
      ORCHESTRATOR_PLANNING_RUNTIME_ROOT: planningRuntimeRoot,
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
    const startFixtureServer = async (environment = {}) => {
      const fixturePort = await unusedLoopbackPort();
      const fixtureBaseUrl = `http://127.0.0.1:${fixturePort}`;
      childOutput = '';
      child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
        cwd: fixtureDir,
        env: { ...baseEnvironment, ...environment, PORT: String(fixturePort) },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      child.stdout.on('data', (chunk) => { childOutput += chunk; });
      child.stderr.on('data', (chunk) => { childOutput += chunk; });
      await waitForHttpServer({ baseUrl: fixtureBaseUrl, child, output: () => childOutput });
      return fixtureBaseUrl;
    };
    const baseUrl = await startFixtureServer();

    const accessTokenPath = path.join(fixtureDir, 'data', 'access-token');
    const operatorToken = readFileSync(accessTokenPath, 'utf8').trim();
    const operatorAuthorization = `Basic ${Buffer.from(`host-control:${operatorToken}`).toString('base64')}`;
    assert.match(operatorToken, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(statSync(accessTokenPath).mode & 0o777, 0o600);

    await t.test('anonymous static and API requests receive a Basic challenge', async () => {
      for (const pathname of ['/', '/api/options']) {
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
      const withoutCookie = await request(baseUrl, '/api/options', {
        headers: { authorization: operatorAuthorization }
      });
      assert.equal(withoutCookie.status, 401);
      assert.equal(withoutCookie.headers.get('www-authenticate'), null);
      assert.deepEqual(await withoutCookie.json(), { error: 'control_session_required' });

      const withCookie = await request(baseUrl, '/api/options', {
        headers: {
          authorization: operatorAuthorization,
          cookie: controlCookie
        }
      });
      assert.equal(withCookie.status, 200);
      const options = await withCookie.json();
      assert.equal(Array.isArray(options.workspaces), true);
      assert.equal(Array.isArray(options.models), true);
    });

    await t.test('a valid configured token authenticates without creating a token file', async () => {
      await stopChildProcess(child);
      child = null;
      rmSync(accessTokenPath, { force: true });
      const configuredToken = 'configured-access-token-1234';
      const configuredBaseUrl = await startFixtureServer({ ORCHESTRATOR_ACCESS_TOKEN: configuredToken });
      const configuredAuthorization = `Basic ${Buffer.from(`host-control:${configuredToken}`).toString('base64')}`;
      const response = await request(configuredBaseUrl, '/', {
        headers: { authorization: configuredAuthorization }
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('set-cookie') || '', /^host_control_session=/);
      assert.equal(existsSync(accessTokenPath), false);
    });

    await t.test('trusted-network mode removes Basic but retains the same-page API cookie', async () => {
      await stopChildProcess(child);
      child = null;
      rmSync(accessTokenPath, { force: true });
      const trustedBaseUrl = await startFixtureServer({ ORCHESTRATOR_ACCESS_MODE: 'trusted-network' });

      const indexResponse = await request(trustedBaseUrl, '/');
      assert.equal(indexResponse.status, 200);
      assert.equal(indexResponse.headers.get('www-authenticate'), null);
      const setCookie = indexResponse.headers.get('set-cookie') || '';
      assert.match(setCookie, /^host_control_session=[^;]+;/);
      const trustedCookie = setCookie.split(';', 1)[0];
      assert.equal(existsSync(accessTokenPath), false);

      const withoutCookie = await request(trustedBaseUrl, '/api/options');
      assert.equal(withoutCookie.status, 401);
      assert.deepEqual(await withoutCookie.json(), { error: 'control_session_required' });

      const withCookie = await request(trustedBaseUrl, '/api/options', {
        headers: { cookie: trustedCookie }
      });
      assert.equal(withCookie.status, 200);
      const options = await withCookie.json();
      assert.equal(Array.isArray(options.workspaces), true);
      assert.equal(Array.isArray(options.models), true);
    });

    await t.test('device-session mode uses one normal form and survives a dashboard restart without Basic challenges', async () => {
      await stopChildProcess(child);
      child = null;
      const deviceUsername = 'fixture-operator';
      const devicePassword = 'fixture-device-password';
      const deviceAuthPath = path.join(fixtureDir, 'device-auth.json');
      const deviceSessionsPath = path.join(fixtureDir, 'device-sessions.json');
      writeFileSync(deviceAuthPath, `${JSON.stringify({
        version: 1,
        username: deviceUsername,
        passwordHash: bcrypt.hashSync(devicePassword, 10)
      })}\n`, { mode: 0o600 });
      const deviceEnvironment = {
        HOST: '127.0.0.1',
        ORCHESTRATOR_ACCESS_MODE: 'device-session',
        ORCHESTRATOR_TRUST_LOOPBACK_PROXY: '1',
        ORCHESTRATOR_DEVICE_AUTH_FILE: deviceAuthPath,
        ORCHESTRATOR_DEVICE_SESSION_FILE: deviceSessionsPath
      };
      let deviceBaseUrl = await startFixtureServer(deviceEnvironment);

      const anonymousIndex = await request(deviceBaseUrl, '/', { redirect: 'manual' });
      assert.equal(anonymousIndex.status, 303);
      assert.equal(anonymousIndex.headers.get('location'), '/login?next=%2F');
      assert.equal(anonymousIndex.headers.get('www-authenticate'), null);

      const anonymousApi = await request(deviceBaseUrl, '/api/snapshot');
      assert.equal(anonymousApi.status, 401);
      assert.equal(anonymousApi.headers.get('www-authenticate'), null);
      assert.deepEqual(await anonymousApi.json(), { error: 'device_auth_required', loginUrl: '/login' });

      const loginPage = await request(deviceBaseUrl, '/login?next=%2F%23terminals');
      assert.equal(loginPage.status, 200);
      assert.equal(loginPage.headers.get('www-authenticate'), null);
      const loginHtml = await loginPage.text();
      assert.match(loginHtml, /<form action="\/auth\/login" method="post">/);
      assert.match(loginHtml, /autocomplete="username"/);
      assert.match(loginHtml, /autocomplete="current-password"/);
      assert.match(loginHtml, /Remember this device for 30 days/);
      assert.doesNotMatch(loginHtml, /fixture-device-password/);
      assert.equal((await request(deviceBaseUrl, '/login.css')).status, 200);

      const postLogin = (password, { headers = {}, ...extra } = {}) => request(deviceBaseUrl, '/auth/login', {
        method: 'POST',
        redirect: 'manual',
        body: new URLSearchParams({
          username: deviceUsername,
          password,
          next: '/#terminals',
          remember: '1'
        }).toString(),
        ...extra,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: deviceBaseUrl,
          ...headers
        }
      });

      const wrongLogin = await postLogin('wrong-password');
      assert.equal(wrongLogin.status, 401);
      assert.equal(wrongLogin.headers.get('www-authenticate'), null);
      assert.equal(wrongLogin.headers.get('set-cookie'), null);
      assert.match(await wrongLogin.text(), /username or password did not match/);

      const rawLoginBody = (password) => new URLSearchParams({
        username: deviceUsername,
        password,
        next: '/#terminals',
        remember: '1'
      }).toString();
      const rawLoginHeaders = {
        host: 'dashboard.example.com:443',
        origin: 'https://dashboard.example.com',
        'x-forwarded-for': '198.51.100.24',
        'x-forwarded-proto': 'https',
        'content-type': 'application/x-www-form-urlencoded'
      };
      const normalizedDefaultPort = await rawPost(deviceBaseUrl, '/auth/login', {
        body: rawLoginBody('wrong-password'),
        headers: {
          ...rawLoginHeaders
        }
      });
      assert.equal(normalizedDefaultPort.status, 401);
      assert.match(normalizedDefaultPort.body, /username or password did not match/);

      const wrongScheme = await rawPost(deviceBaseUrl, '/auth/login', {
        body: rawLoginBody(devicePassword),
        headers: {
          ...rawLoginHeaders,
          origin: 'http://dashboard.example.com',
        }
      });
      assert.equal(wrongScheme.status, 403);
      assert.deepEqual(JSON.parse(wrongScheme.body), { error: 'origin_mismatch' });

      const opaqueOrigin = await postLogin(devicePassword, { headers: { origin: 'null' } });
      assert.equal(opaqueOrigin.status, 403);
      assert.deepEqual(await opaqueOrigin.json(), { error: 'invalid_origin' });

      const sameOriginOpaque = await postLogin('wrong-password', {
        headers: {
          origin: 'null',
          'sec-fetch-site': 'same-origin'
        }
      });
      assert.equal(sameOriginOpaque.status, 401);
      assert.match(await sameOriginOpaque.text(), /username or password did not match/);

      const crossSite = await postLogin(devicePassword, { headers: { 'sec-fetch-site': 'cross-site' } });
      assert.equal(crossSite.status, 403);
      assert.deepEqual(await crossSite.json(), { error: 'cross_site_request_rejected' });

      const accepted = await postLogin(devicePassword);
      assert.equal(accepted.status, 303);
      assert.equal(accepted.headers.get('location'), '/#terminals');
      assert.equal(accepted.headers.get('www-authenticate'), null);
      const deviceSetCookie = accepted.headers.get('set-cookie') || '';
      assert.match(deviceSetCookie, /^__Host-panefleet_device=[A-Za-z0-9_-]{43};/);
      assert.match(deviceSetCookie, /\bHttpOnly\b/);
      assert.match(deviceSetCookie, /\bSameSite=Lax\b/);
      assert.doesNotMatch(deviceSetCookie, /\bSameSite=Strict\b/);
      assert.match(deviceSetCookie, /\bMax-Age=2592000\b/);
      assert.match(deviceSetCookie, /\bSecure\b/);
      const deviceCookie = deviceSetCookie.split(';', 1)[0];
      assert.doesNotMatch(readFileSync(deviceSessionsPath, 'utf8'), new RegExp(deviceCookie.split('=', 2)[1]));

      const authenticatedIndex = await request(deviceBaseUrl, '/', { headers: { cookie: deviceCookie } });
      assert.equal(authenticatedIndex.status, 200);
      const controlCookie = String(authenticatedIndex.headers.get('set-cookie') || '').split(';', 1)[0];
      assert.match(controlCookie, /^host_control_session=/);
      const authenticatedApi = await request(deviceBaseUrl, '/api/options', {
        headers: { cookie: `${deviceCookie}; ${controlCookie}` }
      });
      assert.equal(authenticatedApi.status, 200);

      await stopChildProcess(child);
      child = null;
      deviceBaseUrl = await startFixtureServer(deviceEnvironment);
      const afterRestart = await request(deviceBaseUrl, '/', { headers: { cookie: deviceCookie } });
      assert.equal(afterRestart.status, 200);
      assert.equal(afterRestart.headers.get('www-authenticate'), null);
      assert.match(afterRestart.headers.get('set-cookie') || '', /^host_control_session=/);
    });

    assert.equal(existsSync(toolLogPath) ? readFileSync(toolLogPath, 'utf8') : '', '');
  } finally {
    await stopChildProcess(child);
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(planningRuntimeRoot, { recursive: true, force: true });
  }
});

test('safe startup defaults stay loopback-only and invalid authority settings fail before listening', async () => {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'host-control-startup-defaults-'));
  const homeDir = path.join(fixtureDir, 'home');
  const binDir = path.join(fixtureDir, 'isolated-bin');
  const publicDir = path.join(fixtureDir, 'public');
  const tmpDir = path.join(fixtureDir, 'tmp');
  const defaultPlanningRuntimeRoot = path.join(
    os.tmpdir(),
    `panefleet-planning-test-${createHash('sha256').update(fixtureDir).digest('hex').slice(0, 16)}`
  );
  let child;
  let childOutput = '';

  try {
    for (const directory of [homeDir, binDir, publicDir, tmpDir, path.join(homeDir, '.codex')]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(path.join(fixtureDir, 'package.json'), '{"type":"module"}\n');
    writeFileSync(path.join(fixtureDir, 'services.json'), '[]\n');
    writeFileSync(path.join(fixtureDir, 'host-config.json'), '{}\n');
    writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>Startup Defaults Test</title>\n');
    writeFileSync(path.join(homeDir, '.codex', 'models_cache.json'), '{"models":[]}\n');
    for (const name of ['aws', 'bash', 'curl', 'git', 'ps', 'ss', 'systemctl', 'tmux']) {
      installBlockedTool(binDir, name);
    }

    const baseEnvironment = {
      HOME: homeDir,
      PATH: binDir,
      TMPDIR: os.tmpdir(),
      TMP: os.tmpdir(),
      TEMP: os.tmpdir(),
      NODE_ENV: 'test',
      ORCHESTRATOR_RUNTIME_ROOT: fixtureDir,
      AWS_EC2_METADATA_DISABLED: 'true',
      ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {})
    };
    const fixturePort = await unusedLoopbackPort();
    const fixtureBaseUrl = `http://127.0.0.1:${fixturePort}`;
    child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
      cwd: fixtureDir,
      env: { ...baseEnvironment, PORT: String(fixturePort) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk) => { childOutput += chunk; });
    child.stderr.on('data', (chunk) => { childOutput += chunk; });
    await waitForHttpServer({ baseUrl: fixtureBaseUrl, child, output: () => childOutput });

    const indexResponse = await request(fixtureBaseUrl, '/');
    assert.equal(indexResponse.status, 200);
    assert.equal(indexResponse.headers.get('www-authenticate'), null);
    const setCookie = indexResponse.headers.get('set-cookie') || '';
    assert.match(setCookie, /^host_control_session=[^;]+;/);
    assert.doesNotMatch(setCookie, /\bSecure\b/i);
    const controlCookie = setCookie.split(';', 1)[0];
    const optionsResponse = await request(fixtureBaseUrl, '/api/options', {
      headers: { cookie: controlCookie }
    });
    assert.equal(optionsResponse.status, 200);

    await stopChildProcess(child);
    child = null;

    const invalidSettings = [
      [{ ORCH_CONTROL_PLANE_MODE: 'container-magic' }, 'invalid_control_plane_mode'],
      [{ ORCH_WORKLOAD_SYSTEMD_UNIT: '../workloads.service' }, 'invalid_workload_systemd_unit'],
      [{ HOST: '0.0.0.0', ORCHESTRATOR_TRUST_LOOPBACK_PROXY: '1' }, 'orchestrator_trusted_proxy_requires_loopback_host'],
      [{ ORCHESTRATOR_ACCESS_MODE: 'public' }, 'orchestrator_access_mode_invalid'],
      [{ ORCHESTRATOR_ACCESS_MODE: 'device-session' }, 'orchestrator_device_auth_requires_secure_loopback_proxy'],
      [{ PORT: 'not-a-port' }, 'PORT must be an integer']
    ];
    for (const [environment, expectedError] of invalidSettings) {
      childOutput = '';
      const failingChild = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
        cwd: fixtureDir,
        env: { ...baseEnvironment, ...environment },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      failingChild.stdout.on('data', (chunk) => { childOutput += chunk; });
      failingChild.stderr.on('data', (chunk) => { childOutput += chunk; });
      const [exitCode, signal] = await waitForChildExit(failingChild, {
        timeoutMs: 5000,
        label: `invalid startup ${expectedError}`
      });
      assert.notEqual(exitCode, 0, childOutput);
      assert.equal(signal, null);
      assert.match(childOutput, new RegExp(expectedError.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  } finally {
    await stopChildProcess(child);
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(defaultPlanningRuntimeRoot, { recursive: true, force: true });
  }
});
