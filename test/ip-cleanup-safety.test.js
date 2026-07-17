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
const HOME_IP = '192.0.2.20';
const REQUESTER_IP = '198.51.100.20';
const STALE_IP = '198.51.100.21';
const ACTIVE_SSH_IP = '198.51.100.22';
const STATIC_IP = '198.51.100.23';
const INSTANCE_IP = '203.0.113.20';

let fixtureDir;
let child;
let childOutput = '';
let baseUrl;
let controlCookie;
let dashboardPort;
let rulesPath;
let operationsPath;
let failAuthorizePortPath;
let failRevokePath;
let retainRevokedPath;
let mutateOnAuthorizePath;

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

function postCleanup(body) {
  return request('/api/security/ssh-rescue/cleanup', {
    method: 'POST',
    headers: { cookie: controlCookie, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function operationCount(name) {
  return readFileSync(operationsPath, 'utf8').split('\n').filter((operation) => operation === name).length;
}

async function withFlag(flagPath, value, callback) {
  writeFileSync(flagPath, value);
  try {
    return await callback();
  } finally {
    rmSync(flagPath, { force: true });
  }
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
  fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'panefleet-ip-cleanup-test-'));
  const binDir = path.join(fixtureDir, 'mock-bin');
  const codexHome = path.join(fixtureDir, 'codex-home');
  rulesPath = path.join(fixtureDir, 'aws-rules.json');
  operationsPath = path.join(fixtureDir, 'aws-operations.log');
  failAuthorizePortPath = path.join(fixtureDir, 'fail-authorize-port');
  failRevokePath = path.join(fixtureDir, 'fail-revoke');
  retainRevokedPath = path.join(fixtureDir, 'retain-revoked');
  mutateOnAuthorizePath = path.join(fixtureDir, 'mutate-on-authorize');
  dashboardPort = await unusedLoopbackPort();
  baseUrl = `http://127.0.0.1:${dashboardPort}`;

  mkdirSync(binDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(path.join(fixtureDir, 'data'), { recursive: true });
  copyFileSync(path.join(projectDir, 'test', 'services.fixture.json'), path.join(fixtureDir, 'services.json'));
  cpSync(path.join(projectDir, 'public'), path.join(fixtureDir, 'public'), { recursive: true });
  writeFileSync(path.join(fixtureDir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(path.join(codexHome, 'models_cache.json'), '{"models":[]}\n');
  writeFileSync(operationsPath, '');
  writeFileSync(path.join(fixtureDir, 'data', 'ssh-rescue-state.json'), JSON.stringify({
    active: true,
    openedAt: '2026-07-16T00:00:00.000Z',
    expiresAt: '2099-07-16T00:00:00.000Z',
    region: 'us-east-2',
    instanceId: 'i-cleanup-test',
    publicIp: INSTANCE_IP,
    groupId: 'sg-cleanup-test',
    groupName: 'cleanup-test-group',
    baselinePeerCidrs: [`${ACTIVE_SSH_IP}/32`],
    lockedCidrs: [`${STALE_IP}/32`]
  }, null, 2));

  const managedDescription = (port, timestamp = '2026-07-15T00:00:00.000Z') =>
    `host-control-ip ${port} ${timestamp}`;
  writeFileSync(rulesPath, JSON.stringify([
    { SecurityGroupRuleId: 'sgr-home-ssh', GroupId: 'sg-cleanup-test', IsEgress: false, IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIpv4: `${HOME_IP}/32`, Description: 'home ssh' },
    { SecurityGroupRuleId: 'sgr-home-dashboard', GroupId: 'sg-cleanup-test', IsEgress: false, IpProtocol: 'tcp', FromPort: dashboardPort, ToPort: dashboardPort, CidrIpv4: `${HOME_IP}/32`, Description: 'home dashboard' },
    { SecurityGroupRuleId: 'sgr-home-extra', GroupId: 'sg-cleanup-test', IsEgress: false, IpProtocol: 'tcp', FromPort: 9443, ToPort: 9443, CidrIpv4: `${HOME_IP}/32`, Description: 'home extra service' },
    { SecurityGroupRuleId: 'sgr-current-extra', GroupId: 'sg-cleanup-test', IsEgress: false, IpProtocol: 'tcp', FromPort: 9443, ToPort: 9443, CidrIpv4: `${REQUESTER_IP}/32`, Description: managedDescription(9443) },
    { SecurityGroupRuleId: 'sgr-stale-ssh', GroupId: 'sg-cleanup-test', IsEgress: false, IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIpv4: `${STALE_IP}/32`, Description: managedDescription(22) },
    { SecurityGroupRuleId: 'sgr-stale-dashboard', GroupId: 'sg-cleanup-test', IsEgress: false, IpProtocol: 'tcp', FromPort: dashboardPort, ToPort: dashboardPort, CidrIpv4: `${STALE_IP}/32`, Description: managedDescription(dashboardPort) },
    { SecurityGroupRuleId: 'sgr-active-ssh', GroupId: 'sg-cleanup-test', IsEgress: false, IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIpv4: `${ACTIVE_SSH_IP}/32`, Description: managedDescription(22) },
    { SecurityGroupRuleId: 'sgr-lookalike', GroupId: 'sg-cleanup-test', IsEgress: false, IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIpv4: `${STATIC_IP}/32`, Description: 'backup host-control-ip 22 2026-07-15T00:00:00.000Z' },
    { SecurityGroupRuleId: 'sgr-rescue-ssh', GroupId: 'sg-cleanup-test', IsEgress: false, IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIpv4: '0.0.0.0/0', Description: 'agent-orchestrator-rescue temporary' },
    { SecurityGroupRuleId: 'sgr-rescue-dashboard', GroupId: 'sg-cleanup-test', IsEgress: false, IpProtocol: 'tcp', FromPort: dashboardPort, ToPort: dashboardPort, CidrIpv4: '0.0.0.0/0', Description: 'agent-orchestrator-rescue temporary' },
    { SecurityGroupRuleId: 'sgr-public-web', GroupId: 'sg-cleanup-test', IsEgress: false, IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIpv4: '0.0.0.0/0', Description: 'public web' },
    { SecurityGroupRuleId: 'sgr-ipv6', GroupId: 'sg-cleanup-test', IsEgress: false, IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIpv6: '::/0', Description: 'ipv6 ssh' },
    { SecurityGroupRuleId: 'sgr-prefix', GroupId: 'sg-cleanup-test', IsEgress: false, IpProtocol: 'tcp', FromPort: 9000, ToPort: 9500, PrefixListId: 'pl-test', Description: 'managed prefix' },
    { SecurityGroupRuleId: 'sgr-reference', GroupId: 'sg-cleanup-test', IsEgress: false, IpProtocol: '-1', ReferencedGroupInfo: { GroupId: 'sg-peer' }, Description: 'peer group' },
    { SecurityGroupRuleId: 'sgr-unknown', GroupId: 'sg-cleanup-test', IsEgress: false, IpProtocol: 'tcp', FromPort: 'invalid', ToPort: 22, Description: 'unknown source' },
    { SecurityGroupRuleId: 'sgr-udp', GroupId: 'sg-cleanup-test', IsEgress: false, IpProtocol: 'udp', FromPort: 22, ToPort: 22, CidrIpv4: `${STATIC_IP}/32`, Description: 'udp static' },
    { SecurityGroupRuleId: 'sgr-egress', GroupId: 'sg-cleanup-test', IsEgress: true, IpProtocol: '-1', CidrIpv4: '0.0.0.0/0', Description: 'egress' }
  ], null, 2));

  installExecutable(binDir, 'curl', `#!/usr/bin/env node
const value = process.argv.join(' ');
if (value.includes('/latest/api/token')) process.stdout.write('mock-token');
else if (value.includes('meta-data/instance-id')) process.stdout.write('i-cleanup-test');
else if (value.includes('meta-data/placement/availability-zone')) process.stdout.write('us-east-2a');
else process.exit(2);
`);
  installExecutable(binDir, 'ss', `#!/bin/sh
printf 'ESTAB 0 0 192.0.2.200:22 ${ACTIVE_SSH_IP}:54321\n'
`);
  installExecutable(binDir, 'aws', `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const operation = args[1] || '';
const statePath = process.env.MOCK_AWS_STATE;
const rules = JSON.parse(fs.readFileSync(statePath, 'utf8'));
fs.appendFileSync(process.env.MOCK_AWS_LOG, operation + '\\n');
const exists = (name) => fs.existsSync(process.env[name]);
if (operation === 'describe-instances') {
  process.stdout.write(JSON.stringify({ Reservations: [{ Instances: [{
    InstanceId: 'i-cleanup-test', PublicIpAddress: '${INSTANCE_IP}', PublicDnsName: 'cleanup.example.test',
    SecurityGroups: [{ GroupId: 'sg-cleanup-test', GroupName: 'cleanup-test-group' }]
  }] }] }));
} else if (operation === 'describe-security-group-rules') {
  process.stdout.write(JSON.stringify({ SecurityGroupRules: rules }));
} else if (operation === 'authorize-security-group-ingress') {
  const permission = JSON.parse(args[args.indexOf('--ip-permissions') + 1])[0];
  const port = Number(permission.FromPort);
  let failPort = '';
  try { failPort = fs.readFileSync(process.env.MOCK_FAIL_AUTHORIZE_PORT, 'utf8').trim(); } catch {}
  if (String(port) === failPort) {
    process.stderr.write('mock authorize failure');
    process.exit(3);
  }
  const range = permission.IpRanges[0];
  if (rules.some((rule) => !rule.IsEgress && rule.IpProtocol === 'tcp' && Number(rule.FromPort) === port && Number(rule.ToPort) === port && rule.CidrIpv4 === range.CidrIp)) {
    process.stderr.write('InvalidPermission.Duplicate');
    process.exit(4);
  }
  rules.push({
    SecurityGroupRuleId: 'sgr-added-' + port,
    GroupId: 'sg-cleanup-test', IsEgress: false, IpProtocol: 'tcp',
    FromPort: port, ToPort: port, CidrIpv4: range.CidrIp, Description: range.Description
  });
  if (exists('MOCK_MUTATE_ON_AUTHORIZE')) {
    for (const rule of rules) {
      if (String(rule.SecurityGroupRuleId).startsWith('sgr-stale-')) {
        rule.Description = 'host-control-ip ' + rule.FromPort + ' 2026-07-16T00:00:00.000Z';
      }
    }
  }
  fs.writeFileSync(statePath, JSON.stringify(rules, null, 2));
  process.stdout.write('{}');
} else if (operation === 'revoke-security-group-ingress') {
  if (exists('MOCK_FAIL_REVOKE')) {
    process.stderr.write('mock revoke failure');
    process.exit(5);
  }
  const firstId = args.indexOf('--security-group-rule-ids') + 1;
  const ids = new Set(args.slice(firstId));
  if (!exists('MOCK_RETAIN_REVOKED')) {
    fs.writeFileSync(statePath, JSON.stringify(rules.filter((rule) => !ids.has(rule.SecurityGroupRuleId)), null, 2));
  }
  process.stdout.write('{}');
} else {
  process.stderr.write('unexpected mock AWS operation: ' + operation);
  process.exit(6);
}
`);

  child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(dashboardPort),
      ORCHESTRATOR_RUNTIME_ROOT: fixtureDir,
      CODEX_HOME: codexHome,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      ORCH_CONTROL_PLANE_MODE: 'foreground',
      NODE_ENV: 'test',
      ORCHESTRATOR_ALLOW_DOCUMENTATION_IPS: '1',
      ORCHESTRATOR_TEST_REMOTE_ADDRESS: REQUESTER_IP,
      MOCK_AWS_STATE: rulesPath,
      MOCK_AWS_LOG: operationsPath,
      MOCK_FAIL_AUTHORIZE_PORT: failAuthorizePortPath,
      MOCK_FAIL_REVOKE: failRevokePath,
      MOCK_RETAIN_REVOKED: retainRevokedPath,
      MOCK_MUTATE_ON_AUTHORIZE: mutateOnAuthorizePath,
      SNAPSHOT_EVENT_MS: '60000',
      SSH_RESCUE_MONITOR_MS: '60000'
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

test('cleanup inventory classifies real AWS rule shapes and preserves non-owned access', async () => {
  const response = await request('/api/security/ssh-rescue/plan', { headers: { cookie: controlCookie } });
  const body = await jsonResponse(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.plan.requesterCidr, `${REQUESTER_IP}/32`);
  assert.equal(body.plan.cleanup.enabled, true);
  assert.deepEqual(body.plan.homeCidrs, [`${HOME_IP}/32`]);
  assert.deepEqual(body.plan.lteMirrorPorts, [22, dashboardPort, 9443].sort((left, right) => left - right));

  const byId = new Map(body.plan.inboundRules.map((rule) => [rule.id, rule]));
  assert.equal(byId.get('sgr-current-extra').classification, 'current');
  assert.equal(byId.get('sgr-current-extra').cleanupEligible, false);
  assert.equal(byId.get('sgr-active-ssh').classification, 'active-ssh');
  assert.equal(byId.get('sgr-active-ssh').cleanupEligible, false);
  assert.equal(byId.get('sgr-stale-ssh').classification, 'dashboard-stale');
  assert.equal(byId.get('sgr-lookalike').classification, 'static-unmanaged');
  assert.equal(byId.get('sgr-ipv6').source, '::/0');
  assert.equal(byId.get('sgr-ipv6').broad, true);
  assert.equal(byId.get('sgr-ipv6').relevant, true);
  assert.equal(byId.get('sgr-prefix').source, 'pl-test');
  assert.equal(byId.get('sgr-prefix').relevant, true);
  assert.equal(byId.get('sgr-reference').source, 'sg-peer');
  assert.equal(byId.get('sgr-reference').relevant, true);
  assert.equal(byId.get('sgr-unknown').source, 'unknown');
  assert.equal(byId.get('sgr-unknown').relevant, false);
  assert.equal(byId.get('sgr-udp').relevant, false);
  assert.equal(byId.has('sgr-egress'), false);
  assert.deepEqual(new Set(body.plan.cleanup.candidates.map((rule) => rule.id)), new Set([
    'sgr-rescue-ssh',
    'sgr-rescue-dashboard',
    'sgr-stale-ssh',
    'sgr-stale-dashboard'
  ]));
  assert.equal(body.plan.cleanup.broadRuleCount, 4);
});

test('cleanup is preview-bound, fail-closed, and revokes only the reviewed rule IDs', async (t) => {
  const noCurrentOnly = await postCleanup({ dryRun: true });
  assert.equal(noCurrentOnly.status, 400);
  assert.deepEqual(await jsonResponse(noCurrentOnly), { error: 'current_only_required' });

  const previewResponse = await postCleanup({ dryRun: true, currentOnly: true });
  const preview = await jsonResponse(previewResponse);
  assert.equal(previewResponse.status, 200, JSON.stringify(preview));
  assert.equal(preview.requesterCidr, `${REQUESTER_IP}/32`);
  assert.equal(preview.dashboardBroadRulesToReplace, 2);
  assert.equal(preview.unmanagedBroadRulesPreserved, 2);
  assert.equal(typeof preview.planToken, 'string');
  assert.equal(preview.planToken.length > 20, true);

  await t.test('requires confirmation and the exact preview token before mutation', async () => {
    const rulesBefore = readFileSync(rulesPath, 'utf8');
    const unconfirmed = await postCleanup({ currentOnly: true, planToken: preview.planToken });
    assert.equal(unconfirmed.status, 400);
    assert.deepEqual(await jsonResponse(unconfirmed), { error: 'confirmation_required' });

    const changed = await postCleanup({ confirm: 'cleanup', currentOnly: true, planToken: 'wrong-token' });
    assert.equal(changed.status, 409);
    assert.equal((await jsonResponse(changed)).error, 'cleanup_plan_changed');
    assert.equal(readFileSync(operationsPath, 'utf8').includes('authorize-security-group-ingress'), false);
    assert.equal(readFileSync(operationsPath, 'utf8').includes('revoke-security-group-ingress'), false);
    assert.equal(readFileSync(rulesPath, 'utf8'), rulesBefore);
  });

  await t.test('never revokes when exact current-IP coverage cannot be verified', async () => {
    await withFlag(failAuthorizePortPath, `${dashboardPort}\n`, async () => {
      const revokesBefore = operationCount('revoke-security-group-ingress');
      const response = await postCleanup({ confirm: 'cleanup', currentOnly: true, planToken: preview.planToken });
      const body = await jsonResponse(response);
      assert.equal(response.status, 500, JSON.stringify(body));
      assert.equal(body.error, 'current_ip_coverage_failed');
      assert.equal(body.noRulesRevoked, true);
      assert.deepEqual(body.missingPorts, [dashboardPort]);
      assert.equal(operationCount('revoke-security-group-ingress'), revokesBefore);
    });
  });

  await t.test('aborts when candidate rules change during coverage authorization', async () => {
    await withFlag(mutateOnAuthorizePath, '1\n', async () => {
      const revokesBefore = operationCount('revoke-security-group-ingress');
      const response = await postCleanup({ confirm: 'cleanup', currentOnly: true, planToken: preview.planToken });
      const body = await jsonResponse(response);
      assert.equal(response.status, 409, JSON.stringify(body));
      assert.equal(body.error, 'cleanup_plan_changed');
      assert.equal(operationCount('revoke-security-group-ingress'), revokesBefore);
    });
  });

  const refreshedResponse = await postCleanup({ dryRun: true, currentOnly: true });
  const refreshed = await jsonResponse(refreshedResponse);
  assert.equal(refreshedResponse.status, 200, JSON.stringify(refreshed));
  assert.notEqual(refreshed.planToken, preview.planToken);

  await t.test('surfaces AWS revoke failure without claiming removal', async () => {
    await withFlag(failRevokePath, '1\n', async () => {
      const response = await postCleanup({ confirm: 'cleanup', currentOnly: true, planToken: refreshed.planToken });
      const body = await jsonResponse(response);
      assert.equal(response.status, 500, JSON.stringify(body));
      assert.equal(body.error, 'cleanup_failed');
      assert.deepEqual(body.keepCidrs, [`${REQUESTER_IP}/32`, `${ACTIVE_SSH_IP}/32`].sort());
    });
  });

  await t.test('verifies that every reviewed rule actually disappeared', async () => {
    await withFlag(retainRevokedPath, '1\n', async () => {
      const response = await postCleanup({ confirm: 'cleanup', currentOnly: true, planToken: refreshed.planToken });
      const body = await jsonResponse(response);
      assert.equal(response.status, 500, JSON.stringify(body));
      assert.equal(body.error, 'cleanup_verification_failed');
      assert.deepEqual(new Set(body.remainingRuleIds), new Set(refreshed.candidates.map((rule) => rule.id)));
    });
  });

  await t.test('successful commit removes owned candidates and preserves current, active, and unmanaged rules', async () => {
    const response = await postCleanup({ confirm: 'cleanup', currentOnly: true, planToken: refreshed.planToken });
    const body = await jsonResponse(response);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(new Set(body.revoked), new Set(refreshed.candidates.map((rule) => rule.id)));
    assert.equal(body.rescue.active, false);
    assert.equal(body.rescue.status, 'locked');

    const remaining = JSON.parse(readFileSync(rulesPath, 'utf8'));
    const remainingIds = new Set(remaining.map((rule) => rule.SecurityGroupRuleId));
    for (const candidate of refreshed.candidates) assert.equal(remainingIds.has(candidate.id), false);
    for (const preserved of ['sgr-home-ssh', 'sgr-current-extra', 'sgr-active-ssh', 'sgr-lookalike', 'sgr-public-web', 'sgr-ipv6']) {
      assert.equal(remainingIds.has(preserved), true, preserved);
    }
    assert.equal(remaining.some((rule) => rule.CidrIpv4 === `${REQUESTER_IP}/32` && rule.FromPort === 22), true);
    assert.equal(remaining.some((rule) => rule.CidrIpv4 === `${REQUESTER_IP}/32` && rule.FromPort === dashboardPort), true);

    const durableState = JSON.parse(readFileSync(path.join(fixtureDir, 'data', 'ssh-rescue-state.json'), 'utf8'));
    assert.equal(durableState.active, false);
    assert.equal(durableState.closeReason, 'managed_cleanup');
    assert.deepEqual(new Set(durableState.revokedRuleIds), new Set(body.revoked));
  });
});
