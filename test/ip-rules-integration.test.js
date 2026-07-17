import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
const HOME_TEST_IP = '192.0.2.10';
const STALE_TEST_IP = '192.0.2.11';
const LOOKALIKE_TEST_IP = '192.0.2.12';
const REQUEST_TEST_IP = '198.51.100.13';
const FAILURE_TEST_IP = '198.51.100.14';
const INSTANCE_TEST_IP = '203.0.113.15';

let fixtureDir;
let child;
let childOutput = '';
let baseUrl;
let controlCookie;
let awsStatePath;
let awsLogPath;
let failPortPath;
let sshPeerPath;

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

function installExecutable(binDir, name, source) {
  const executable = path.join(binDir, name);
  writeFileSync(executable, source, { mode: 0o755 });
  chmodSync(executable, 0o755);
}

async function request(pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    return await fetch(`${baseUrl}${pathname}`, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function jsonResponse(response) {
  return JSON.parse(await response.text());
}

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`mock server exited early (${child.exitCode})\n${childOutput}`);
    try {
      const response = await request('/healthz');
      if (response.status === 200) return;
    } catch {
      // The child may still be binding.
    }
    await delay(50);
  }
  throw new Error(`mock server did not become ready\n${childOutput}`);
}

before(async () => {
  fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'agent-orchestrator-ip-test-'));
  const binDir = path.join(fixtureDir, 'mock-bin');
  const codexHome = path.join(fixtureDir, 'codex-home');
  awsStatePath = path.join(fixtureDir, 'aws-rules.json');
  awsLogPath = path.join(fixtureDir, 'aws-operations.log');
  failPortPath = path.join(fixtureDir, 'fail-port');
  sshPeerPath = path.join(fixtureDir, 'ssh-peer');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(path.join(fixtureDir, 'data'), { recursive: true });
  writeFileSync(sshPeerPath, '');

  copyFileSync(path.join(projectDir, 'test', 'services.fixture.json'), path.join(fixtureDir, 'services.json'));
  cpSync(path.join(projectDir, 'public'), path.join(fixtureDir, 'public'), { recursive: true });
  writeFileSync(path.join(fixtureDir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(path.join(codexHome, 'models_cache.json'), '{"models":[]}\n');
  writeFileSync(path.join(fixtureDir, 'data', 'ssh-rescue-state.json'), JSON.stringify({
    active: true,
    openedAt: '2026-07-10T00:00:00.000Z',
    expiresAt: '2099-07-10T00:00:00.000Z',
    region: 'us-east-2',
    instanceId: 'i-test',
    groupId: 'sg-test',
    groupName: 'test-security-group',
    lockedCidrs: [`${STALE_TEST_IP}/32`]
  }));
  writeFileSync(awsStatePath, JSON.stringify([
    { SecurityGroupRuleId: 'sgr-home-22', GroupId: 'sg-test', IsEgress: false, IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIpv4: `${HOME_TEST_IP}/32`, Description: 'home ssh' },
    { SecurityGroupRuleId: 'sgr-home-web', GroupId: 'sg-test', IsEgress: false, IpProtocol: 'tcp', FromPort: 8787, ToPort: 8787, CidrIpv4: `${HOME_TEST_IP}/32`, Description: 'home dashboard' },
    { SecurityGroupRuleId: 'sgr-stale-22', GroupId: 'sg-test', IsEgress: false, IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIpv4: `${STALE_TEST_IP}/32`, Description: 'agent-orchestrator-lte 22 2026-07-10T00:00:00.000Z' },
    { SecurityGroupRuleId: 'sgr-stale-web', GroupId: 'sg-test', IsEgress: false, IpProtocol: 'tcp', FromPort: 8787, ToPort: 8787, CidrIpv4: `${STALE_TEST_IP}/32`, Description: 'agent-orchestrator-lte 8787 2026-07-10T00:00:00.000Z' },
    { SecurityGroupRuleId: 'sgr-lookalike', GroupId: 'sg-test', IsEgress: false, IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIpv4: `${LOOKALIKE_TEST_IP}/32`, Description: 'backup agent-orchestrator-lte rule' },
    { SecurityGroupRuleId: 'sgr-broad', GroupId: 'sg-test', IsEgress: false, IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIpv4: '0.0.0.0/0', Description: 'agent-orchestrator-rescue legacy' },
    { SecurityGroupRuleId: 'sgr-unmanaged-broad', GroupId: 'sg-test', IsEgress: false, IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIpv4: '0.0.0.0/0', Description: 'public web' }
  ], null, 2));

  installExecutable(binDir, 'curl', `#!/usr/bin/env node
const value = process.argv.join(' ');
if (value.includes('/latest/api/token')) process.stdout.write('mock-token');
else if (value.includes('meta-data/instance-id')) process.stdout.write('i-test');
else if (value.includes('meta-data/placement/availability-zone')) process.stdout.write('us-east-2a');
else process.exit(2);
`);
  installExecutable(binDir, 'ss', `#!/bin/sh
peer="$(cat "$MOCK_SSH_PEER" 2>/dev/null)"
if [ -n "$peer" ]; then
  printf 'ESTAB 0 0 192.0.2.200:22 %s:54321\n' "$peer"
fi
exit 0
`);
  installExecutable(binDir, 'aws', `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const operation = args[1] || '';
const statePath = process.env.MOCK_AWS_STATE;
const logPath = process.env.MOCK_AWS_LOG;
const rules = JSON.parse(fs.readFileSync(statePath, 'utf8'));
fs.appendFileSync(logPath, operation + '\\n');
if (operation === 'describe-instances') {
  process.stdout.write(JSON.stringify({ Reservations: [{ Instances: [{
    InstanceId: 'i-test', PublicIpAddress: '${INSTANCE_TEST_IP}', PublicDnsName: 'example.test',
    SecurityGroups: [{ GroupId: 'sg-test', GroupName: 'test-security-group' }]
  }] }] }));
} else if (operation === 'describe-security-group-rules') {
  process.stdout.write(JSON.stringify({ SecurityGroupRules: rules }));
} else if (operation === 'authorize-security-group-ingress') {
  const permissions = JSON.parse(args[args.indexOf('--ip-permissions') + 1]);
  const permission = permissions[0];
  const port = Number(permission.FromPort);
  let failPort = '';
  try { failPort = fs.readFileSync(process.env.MOCK_FAIL_PORT, 'utf8').trim(); } catch {}
  if (String(port) === failPort) {
    process.stderr.write('mock authorize failure');
    process.exit(3);
  }
  const range = permission.IpRanges[0];
  rules.push({
    SecurityGroupRuleId: 'sgr-added-' + rules.length,
    GroupId: 'sg-test', IsEgress: false, IpProtocol: 'tcp',
    FromPort: port, ToPort: port, CidrIpv4: range.CidrIp, Description: range.Description
  });
  fs.writeFileSync(statePath, JSON.stringify(rules, null, 2));
  process.stdout.write('{}');
} else if (operation === 'revoke-security-group-ingress') {
  const firstId = args.indexOf('--security-group-rule-ids') + 1;
  const ids = new Set(args.slice(firstId));
  const retained = rules.filter((rule) => !ids.has(rule.SecurityGroupRuleId));
  fs.writeFileSync(statePath, JSON.stringify(retained, null, 2));
  process.stdout.write('{}');
} else {
  process.stderr.write('unexpected mock AWS operation: ' + operation);
  process.exit(5);
}
`);

  const port = await unusedLoopbackPort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      ORCHESTRATOR_RUNTIME_ROOT: fixtureDir,
      CODEX_HOME: codexHome,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      ORCH_CONTROL_PLANE_MODE: 'foreground',
      NODE_ENV: 'test',
      ORCHESTRATOR_ALLOW_DOCUMENTATION_IPS: '1',
      MOCK_AWS_STATE: awsStatePath,
      MOCK_AWS_LOG: awsLogPath,
      MOCK_FAIL_PORT: failPortPath,
      MOCK_SSH_PEER: sshPeerPath,
      SNAPSHOT_EVENT_MS: '60000',
      SSH_RESCUE_MONITOR_MS: '20'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });
  await waitForServer();
  const index = await request('/');
  controlCookie = (index.headers.get('set-cookie') || '').split(';', 1)[0];
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), delay(2000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

test('allowing a current IP authorizes exact rules without revoking stale managed access', async () => {
  const response = await request('/api/security/ssh-rescue/open', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'authorize', ip: REQUEST_TEST_IP })
  });
  const body = await jsonResponse(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.cidrs, [`${REQUEST_TEST_IP}/32`]);
  assert.deepEqual(body.ports, [22, 8787, Number(new URL(baseUrl).port)].sort((left, right) => left - right));
  assert.deepEqual(body.revoked, []);

  const operations = readFileSync(awsLogPath, 'utf8').trim().split('\n');
  assert.equal(operations.includes('revoke-security-group-ingress'), false);
  const rules = JSON.parse(readFileSync(awsStatePath, 'utf8'));
  assert.equal(rules.some((rule) => rule.SecurityGroupRuleId === 'sgr-stale-22'), true);
  assert.equal(rules.some((rule) => rule.CidrIpv4 === `${REQUEST_TEST_IP}/32` && rule.FromPort === 22), true);
  assert.equal(rules.some((rule) => rule.CidrIpv4 === `${REQUEST_TEST_IP}/32` && rule.FromPort === 8787), true);
  assert.equal(rules.some((rule) => rule.CidrIpv4 === `${REQUEST_TEST_IP}/32` && String(rule.Description).startsWith('host-control-ip ')), true);
});

test('a partial add failure never invokes rule revocation', async () => {
  writeFileSync(failPortPath, '8787\n');
  const response = await request('/api/security/ssh-rescue/open', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'authorize', ip: FAILURE_TEST_IP })
  });
  assert.equal(response.status, 500);
  const body = await jsonResponse(response);
  assert.equal(body.error, 'authorize_failed');
  assert.equal(body.noRulesRevoked, true);
  assert.deepEqual(body.missingPorts, [8787]);
  assert.equal(readFileSync(awsLogPath, 'utf8').includes('revoke-security-group-ingress'), false);
  rmSync(failPortPath, { force: true });
});

test('rule inventory cleans dashboard-owned broad access but preserves unmanaged broad/static rules', async () => {
  const response = await request('/api/security/ssh-rescue/plan', {
    headers: { cookie: controlCookie }
  });
  const inventoryBody = await jsonResponse(response);
  assert.equal(response.status, 200, JSON.stringify(inventoryBody));
  const { plan } = inventoryBody;
  assert.equal(plan.requesterCidr, '');
  assert.equal(plan.cleanup.enabled, false);
  const lookalike = plan.inboundRules.find((rule) => rule.id === 'sgr-lookalike');
  const broad = plan.inboundRules.find((rule) => rule.id === 'sgr-broad');
  const unmanagedBroad = plan.inboundRules.find((rule) => rule.id === 'sgr-unmanaged-broad');
  const stale = plan.inboundRules.find((rule) => rule.id === 'sgr-stale-22');
  assert.equal(lookalike.managed, false);
  assert.equal(lookalike.cleanupEligible, false);
  assert.equal(broad.broad, true);
  assert.equal(broad.cleanupEligible, true);
  assert.equal(broad.classification, 'dashboard-broad');
  assert.equal(unmanagedBroad.broad, true);
  assert.equal(unmanagedBroad.cleanupEligible, false);
  assert.equal(stale.managed, true);
  assert.equal(stale.cleanupEligible, true);
});

test('rescue lock refuses confirmation-free and private-only targets without consulting AWS', async () => {
  const operationsBefore = readFileSync(awsLogPath, 'utf8');
  const unconfirmed = await request('/api/security/ssh-rescue/lock', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(unconfirmed.status, 400);
  assert.deepEqual(await jsonResponse(unconfirmed), { error: 'confirmation_required' });

  const confirmed = await request('/api/security/ssh-rescue/lock', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'lock' })
  });
  assert.equal(confirmed.status, 409);
  assert.deepEqual(await jsonResponse(confirmed), { error: 'no_lte_target_detected' });
  assert.equal(readFileSync(awsLogPath, 'utf8'), operationsBefore);
});

test('closing rescue access revokes only the dashboard-owned broad rule and verifies durable state', async () => {
  const response = await request('/api/security/ssh-rescue/close', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'close' })
  });
  const body = await jsonResponse(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.revoked, ['sgr-broad']);

  const rules = JSON.parse(readFileSync(awsStatePath, 'utf8'));
  assert.equal(rules.some((rule) => rule.SecurityGroupRuleId === 'sgr-broad'), false);
  assert.equal(rules.some((rule) => rule.SecurityGroupRuleId === 'sgr-unmanaged-broad'), true);
  assert.equal(rules.some((rule) => rule.SecurityGroupRuleId === 'sgr-stale-22'), true);

  const state = JSON.parse(readFileSync(path.join(fixtureDir, 'data', 'ssh-rescue-state.json'), 'utf8'));
  assert.equal(state.active, false);
  assert.equal(state.closeReason, 'manual');
  assert.deepEqual(state.revokedRuleIds, ['sgr-broad']);
  assert.equal(readFileSync(awsLogPath, 'utf8').includes('revoke-security-group-ingress'), true);
});

test('SSH peer detection uses the remote ss endpoint rather than the local listener', async () => {
  writeFileSync(sshPeerPath, '198.51.100.45\n');
  try {
    const response = await request('/api/security/ssh-rescue', {
      headers: { cookie: controlCookie }
    });
    assert.equal(response.status, 200);
    const body = await jsonResponse(response);
    assert.deepEqual(body.rescue.peerCidrs, ['198.51.100.45/32']);
    assert.equal(body.rescue.peerCidrs.includes('192.0.2.200/32'), false);

    const operationsBefore = readFileSync(awsLogPath, 'utf8');
    const lock = await request('/api/security/ssh-rescue/lock', {
      method: 'POST',
      headers: { cookie: controlCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'lock' })
    });
    assert.equal(lock.status, 409);
    assert.deepEqual(await jsonResponse(lock), { error: 'rescue_not_active' });
    assert.equal(readFileSync(awsLogPath, 'utf8'), operationsBefore);
  } finally {
    writeFileSync(sshPeerPath, '');
  }
});
