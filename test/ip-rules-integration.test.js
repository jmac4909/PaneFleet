import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { stopChildProcess } from './helpers/child-process.js';
import { installExecutable } from './helpers/executables.js';
import { fetchWithTimeout, responseJson as jsonResponse, waitForHttpServer } from './helpers/http.js';
import { waitForCondition } from './helpers/timing.js';
import { unusedLoopbackPort } from './helpers/unused-loopback-port.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');
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
let failRevokePath;
let sshPeerPath;

async function request(pathname, options = {}) {
  return fetchWithTimeout(`${baseUrl}${pathname}`, options);
}

async function startFixture({
  monitorMs = 60000,
  expiresAt = '2099-07-10T00:00:00.000Z',
  revokeFails = false,
  trustLoopbackProxy = false
} = {}) {
  child = null;
  childOutput = '';
  controlCookie = '';
  fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'agent-orchestrator-ip-test-'));
  const binDir = path.join(fixtureDir, 'mock-bin');
  const codexHome = path.join(fixtureDir, 'codex-home');
  awsStatePath = path.join(fixtureDir, 'aws-rules.json');
  awsLogPath = path.join(fixtureDir, 'aws-operations.log');
  failPortPath = path.join(fixtureDir, 'fail-port');
  failRevokePath = path.join(fixtureDir, 'fail-revoke');
  sshPeerPath = path.join(fixtureDir, 'ssh-peer');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(path.join(fixtureDir, 'data'), { recursive: true });
  writeFileSync(awsLogPath, '');
  writeFileSync(sshPeerPath, '');
  if (revokeFails) writeFileSync(failRevokePath, 'fail\n');

  copyFileSync(path.join(projectDir, 'test', 'services.fixture.json'), path.join(fixtureDir, 'services.json'));
  cpSync(path.join(projectDir, 'public'), path.join(fixtureDir, 'public'), { recursive: true });
  writeFileSync(path.join(fixtureDir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(path.join(codexHome, 'models_cache.json'), '{"models":[]}\n');
  writeFileSync(path.join(fixtureDir, 'data', 'ssh-rescue-state.json'), JSON.stringify({
    active: true,
    openedAt: '2026-07-10T00:00:00.000Z',
    expiresAt,
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
  if (fs.existsSync(process.env.MOCK_FAIL_REVOKE)) {
    process.stderr.write('mock revoke failure');
    process.exit(4);
  }
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
      ORCHESTRATOR_TRUST_LOOPBACK_PROXY: trustLoopbackProxy ? '1' : '0',
      MOCK_AWS_STATE: awsStatePath,
      MOCK_AWS_LOG: awsLogPath,
      MOCK_FAIL_PORT: failPortPath,
      MOCK_FAIL_REVOKE: failRevokePath,
      MOCK_SSH_PEER: sshPeerPath,
      SNAPSHOT_EVENT_MS: '60000',
      SSH_RESCUE_MONITOR_MS: String(monitorMs)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });
  await waitForHttpServer({ baseUrl, child, output: () => childOutput, label: 'mock server' });
  const index = await request('/');
  controlCookie = (index.headers.get('set-cookie') || '').split(';', 1)[0];
}

async function stopFixture() {
  await stopChildProcess(child);
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  child = null;
  fixtureDir = '';
}

function fixtureTest(name, callback, options = {}) {
  test(name, async () => {
    try {
      await startFixture(options);
      await callback();
    } finally {
      await stopFixture();
    }
  });
}

fixtureTest('allowing a current IP authorizes exact rules without revoking stale managed access', async () => {
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

fixtureTest('exact-IP dry run returns the bounded rule plan without authorizing ingress', async () => {
  const operationsBefore = readFileSync(awsLogPath, 'utf8');
  const response = await request('/api/security/ssh-rescue/open', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      confirm: 'authorize',
      ip: REQUEST_TEST_IP,
      dryRun: true
    })
  });
  const body = await jsonResponse(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.dryRun, true);
  assert.equal(body.cidr, `${REQUEST_TEST_IP}/32`);
  assert.deepEqual(body.ports, [22, 8787, Number(new URL(baseUrl).port)].sort((left, right) => left - right));
  const newOperations = readFileSync(awsLogPath, 'utf8').slice(operationsBefore.length);
  assert.doesNotMatch(newOperations, /authorize-security-group-ingress|revoke-security-group-ingress/);
});

fixtureTest('a partial add failure never invokes rule revocation', async () => {
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
});

fixtureTest('rule inventory cleans dashboard-owned broad access but preserves unmanaged broad/static rules', async () => {
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

fixtureTest('exact loopback proxy forwarding identifies the requester without trusting a list', async () => {
  const exact = await request('/api/security/ssh-rescue/plan', {
    headers: { cookie: controlCookie, 'x-forwarded-for': REQUEST_TEST_IP }
  });
  assert.equal(exact.status, 200);
  assert.equal((await jsonResponse(exact)).plan.requesterCidr, `${REQUEST_TEST_IP}/32`);

  const ambiguous = await request('/api/security/ssh-rescue/plan', {
    headers: { cookie: controlCookie, 'x-forwarded-for': `${REQUEST_TEST_IP}, 127.0.0.1` }
  });
  assert.equal(ambiguous.status, 200);
  assert.equal((await jsonResponse(ambiguous)).plan.requesterCidr, '');
}, { trustLoopbackProxy: true });

fixtureTest('rescue lock refuses confirmation-free and private-only targets without consulting AWS', async () => {
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

fixtureTest('rescue lock verifies every exact rule before revoking broad or stale access', async () => {
  writeFileSync(sshPeerPath, '198.51.100.45\n');
  writeFileSync(failPortPath, '8787\n');

  const response = await request('/api/security/ssh-rescue/lock', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'lock' })
  });
  const body = await jsonResponse(response);
  assert.equal(response.status, 500, JSON.stringify(body));
  assert.equal(body.error, 'lock_authorize_failed');
  assert.deepEqual(body.cidrs, ['198.51.100.45/32']);
  assert.equal(body.noRulesRevoked, true);
  assert.deepEqual(body.missingCoverage, [{ cidr: '198.51.100.45/32', port: 8787 }]);

  const operations = readFileSync(awsLogPath, 'utf8').trim().split('\n');
  assert.equal(operations.includes('revoke-security-group-ingress'), false);
  const rules = JSON.parse(readFileSync(awsStatePath, 'utf8'));
  assert.equal(rules.some((rule) => rule.SecurityGroupRuleId === 'sgr-broad'), true);
  assert.equal(rules.some((rule) => rule.SecurityGroupRuleId === 'sgr-stale-22'), true);
  const state = JSON.parse(readFileSync(path.join(fixtureDir, 'data', 'ssh-rescue-state.json'), 'utf8'));
  assert.equal(state.active, true);
  assert.deepEqual(state.pendingLockedCidrs, ['198.51.100.45/32']);
});

fixtureTest('rescue lock remains active when managed-rule revocation fails', async () => {
  writeFileSync(sshPeerPath, '198.51.100.45\n');
  writeFileSync(failRevokePath, 'fail\n');

  const response = await request('/api/security/ssh-rescue/lock', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'lock' })
  });
  const body = await jsonResponse(response);
  assert.equal(response.status, 500, JSON.stringify(body));
  assert.equal(body.error, 'lock_failed');
  assert.equal(body.revoke.ok, false);
  assert.deepEqual(body.revoke.revoked, []);

  const rules = JSON.parse(readFileSync(awsStatePath, 'utf8'));
  assert.equal(rules.some((rule) => rule.SecurityGroupRuleId === 'sgr-broad'), true);
  assert.equal(rules.some((rule) => rule.SecurityGroupRuleId === 'sgr-stale-22'), true);
  assert.equal(rules.some((rule) => rule.CidrIpv4 === '198.51.100.45/32' && rule.FromPort === 22), true);
  const state = JSON.parse(readFileSync(path.join(fixtureDir, 'data', 'ssh-rescue-state.json'), 'utf8'));
  assert.equal(state.active, true);
  assert.deepEqual(state.pendingLockedCidrs, ['198.51.100.45/32']);
  assert.deepEqual(state.revokedRuleIds, []);
});

fixtureTest('expired rescue access reports revoke failure and preserves active state', async () => {
  const statePath = path.join(fixtureDir, 'data', 'ssh-rescue-state.json');
  const state = await waitForCondition(() => {
    const current = JSON.parse(readFileSync(statePath, 'utf8'));
    return current.closeFailedAt ? current : null;
  }, { intervalMs: 25, timeoutMs: 5000, label: 'failed rescue expiry' });

  const rules = JSON.parse(readFileSync(awsStatePath, 'utf8'));
  assert.equal(rules.some((rule) => rule.SecurityGroupRuleId === 'sgr-broad'), true);
  assert.equal(state.active, true);
  assert.equal(state.closeReason, 'expired');
  assert.deepEqual(state.revokedRuleIds, []);
}, { monitorMs: 20, expiresAt: '2000-01-01T00:00:00.000Z', revokeFails: true });

fixtureTest('expired rescue access revokes only the dashboard-owned broad rule and verifies durable state', async () => {
  const statePath = path.join(fixtureDir, 'data', 'ssh-rescue-state.json');
  const state = await waitForCondition(() => {
    const current = JSON.parse(readFileSync(statePath, 'utf8'));
    return current.active === false ? current : null;
  }, { intervalMs: 25, timeoutMs: 5000, label: 'successful rescue expiry' });

  const rules = JSON.parse(readFileSync(awsStatePath, 'utf8'));
  assert.equal(rules.some((rule) => rule.SecurityGroupRuleId === 'sgr-broad'), false);
  assert.equal(rules.some((rule) => rule.SecurityGroupRuleId === 'sgr-unmanaged-broad'), true);
  assert.equal(rules.some((rule) => rule.SecurityGroupRuleId === 'sgr-stale-22'), true);

  assert.equal(state.active, false);
  assert.equal(state.closeReason, 'expired');
  assert.deepEqual(state.revokedRuleIds, ['sgr-broad']);
  assert.equal(readFileSync(awsLogPath, 'utf8').includes('revoke-security-group-ingress'), true);
}, { monitorMs: 20, expiresAt: '2000-01-01T00:00:00.000Z' });

fixtureTest('SSH peer detection locks to the remote endpoint and removes only managed stale access', async () => {
  writeFileSync(sshPeerPath, '198.51.100.45\n');
  const lock = await request('/api/security/ssh-rescue/lock', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'lock' })
  });
  const lockBody = await jsonResponse(lock);
  assert.equal(lock.status, 200, JSON.stringify(lockBody));
  assert.deepEqual(lockBody.cidrs, ['198.51.100.45/32']);
  assert.equal(lockBody.cidrs.includes('192.0.2.200/32'), false);
  assert.deepEqual(lockBody.revoked.sort(), ['sgr-broad', 'sgr-stale-22', 'sgr-stale-web']);
  assert.equal(lockBody.rescue.active, false);
  assert.equal(lockBody.rescue.status, 'locked');

  const rules = JSON.parse(readFileSync(awsStatePath, 'utf8'));
  assert.equal(rules.some((rule) => rule.SecurityGroupRuleId === 'sgr-broad'), false);
  assert.equal(rules.some((rule) => rule.SecurityGroupRuleId === 'sgr-stale-22'), false);
  assert.equal(rules.some((rule) => rule.SecurityGroupRuleId === 'sgr-home-22'), true);
  assert.equal(rules.some((rule) => rule.SecurityGroupRuleId === 'sgr-lookalike'), true);
  assert.equal(rules.some((rule) => rule.CidrIpv4 === '198.51.100.45/32' && rule.FromPort === 22), true);

  const state = JSON.parse(readFileSync(path.join(fixtureDir, 'data', 'ssh-rescue-state.json'), 'utf8'));
  assert.equal(state.active, false);
  assert.equal(state.lockReason, 'manual');
  assert.deepEqual(state.lockedCidrs, ['198.51.100.45/32']);
});

fixtureTest('rescue monitor automatically locks a newly connected exact SSH peer', async () => {
  writeFileSync(sshPeerPath, '198.51.100.46\n');
  const statePath = path.join(fixtureDir, 'data', 'ssh-rescue-state.json');
  const state = await waitForCondition(() => {
    const current = JSON.parse(readFileSync(statePath, 'utf8'));
    return current.active === false ? current : null;
  }, { intervalMs: 25, timeoutMs: 5000, label: 'automatic SSH rescue lock' });

  assert.equal(state.active, false, childOutput);
  assert.equal(state.lockReason, 'new_ssh_peer');
  assert.deepEqual(state.lockedCidrs, ['198.51.100.46/32']);
  const rules = JSON.parse(readFileSync(awsStatePath, 'utf8'));
  assert.equal(rules.some((rule) => rule.SecurityGroupRuleId === 'sgr-broad'), false);
  assert.equal(rules.some((rule) => rule.SecurityGroupRuleId === 'sgr-stale-22'), false);
  assert.equal(rules.some((rule) => rule.CidrIpv4 === '198.51.100.46/32' && rule.FromPort === 22), true);
}, { monitorMs: 20 });
