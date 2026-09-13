import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = (...parts) => path.join(root, 'deploy', 'host-https', ...parts);
const securityBundle = (...parts) => path.join(root, 'deploy', 'host-security', ...parts);

test('Caddy template terminates only approved names onto loopback backends', async () => {
  const source = await readFile(bundle('Caddyfile.template'), 'utf8');
  assert.match(source, /admin 127\.0\.0\.1:2019/);
  assert.match(source, /protocols tls1\.2 tls1\.3/);
  assert.match(source, /dns route53/);
  assert.match(source, /hosted_zone_id \{\$ROUTE53_HOSTED_ZONE_ID\}/);
  assert.match(source, /\{\$PANEFLEET_HTTPS_HOST\}[\s\S]*reverse_proxy 127\.0\.0\.1:8787/);
  assert.match(source, /\{\$PANEFLEET_HTTPS_HOST\}[\s\S]*header_up -Authorization/);
  assert.doesNotMatch(source, /\bbasic_auth\b|\bbasicauth\b/);
  assert.match(source, /\{\$COMPANION_HTTPS_HOST\}[\s\S]*reverse_proxy 127\.0\.0\.1:8104/);
  assert.doesNotMatch(source, /reverse_proxy\s+(?:0\.0\.0\.0|\[?::\]?)/);
  assert.doesNotMatch(source, /^\s*log\s*(?:\{|$)/m);
  assert.match(source, /^\s*Strict-Transport-Security "max-age=31536000"$/m);
  assert.doesNotMatch(source, /includeSubDomains|preload/);
});

test('Caddy overwrites the one trusted address and removes alternate forwarding headers', async () => {
  const source = await readFile(bundle('Caddyfile.template'), 'utf8');
  assert.match(source, /header_up X-Forwarded-For \{remote_host\}/);
  assert.match(source, /header_up X-Real-IP \{remote_host\}/);
  for (const header of [
    'Forwarded',
    'CF-Connecting-IP',
    'Fastly-Client-IP',
    'Fly-Client-IP',
    'True-Client-IP',
    'X-Azure-ClientIP',
    'X-Client-IP',
    'X-Cluster-Client-IP'
  ]) {
    assert.match(source, new RegExp(`header_up -${header.replaceAll('-', '\\-')}`));
  }
});

test('PaneFleet device-auth override selects the persistent login boundary explicitly', async () => {
  const source = await readFile(bundle('panefleet-device-auth.conf'), 'utf8');
  assert.match(source, /^\[Service\]$/m);
  assert.match(source, /^Environment=ORCHESTRATOR_ACCESS_MODE=device-session$/m);
  assert.doesNotMatch(source, /PASSWORD|TOKEN|SECRET|KEY/);
});

test('Route 53 policy grants only exact-zone ACME TXT access', async () => {
  const policy = JSON.parse(await readFile(bundle('route53-acme-policy.json.template'), 'utf8'));
  const statements = policy.Statement;
  assert.equal(statements.length, 3);
  const actions = statements.flatMap((statement) => Array.isArray(statement.Action) ? statement.Action : [statement.Action]).sort();
  assert.deepEqual(actions, [
    'route53:ChangeResourceRecordSets',
    'route53:GetChange',
    'route53:ListResourceRecordSets'
  ]);
  assert.ok(statements.every((statement) => statement.Effect === 'Allow'));
  assert.ok(statements.every((statement) => statement.Resource !== '*'));
  const change = statements.find((statement) => statement.Action === 'route53:ChangeResourceRecordSets');
  const conditions = change.Condition['ForAllValues:StringEquals'];
  assert.deepEqual(conditions['route53:ChangeResourceRecordSetsRecordTypes'], 'TXT');
  assert.deepEqual(conditions['route53:ChangeResourceRecordSetsActions'], ['UPSERT', 'DELETE']);
  assert.deepEqual(conditions['route53:ChangeResourceRecordSetsNormalizedRecordNames'], [
    '_acme-challenge.${PANEFLEET_HTTPS_HOST}',
    '_acme-challenge.${COMPANION_HTTPS_HOST}'
  ]);
});

test('instance-role deny blocks self-escalation without changing workload services', async () => {
  const policy = JSON.parse(await readFile(securityBundle('instance-role-self-escalation-deny.json'), 'utf8'));
  assert.equal(policy.Statement.length, 1);
  const [statement] = policy.Statement;
  assert.equal(statement.Sid, 'DenyInstanceRoleSelfEscalation');
  assert.equal(statement.Effect, 'Deny');
  assert.equal(statement.Resource, '*');
  assert.deepEqual([...statement.Action].sort(), [
    'iam:AddRoleToInstanceProfile',
    'iam:AttachRolePolicy',
    'iam:CreateInstanceProfile',
    'iam:CreatePolicy',
    'iam:CreatePolicyVersion',
    'iam:CreateRole',
    'iam:CreateServiceLinkedRole',
    'iam:DeleteInstanceProfile',
    'iam:DeletePolicy',
    'iam:DeletePolicyVersion',
    'iam:DeleteRole',
    'iam:DeleteRolePermissionsBoundary',
    'iam:DeleteRolePolicy',
    'iam:DeleteServiceLinkedRole',
    'iam:DetachRolePolicy',
    'iam:PassRole',
    'iam:PutRolePermissionsBoundary',
    'iam:PutRolePolicy',
    'iam:RemoveRoleFromInstanceProfile',
    'iam:SetDefaultPolicyVersion',
    'iam:TagPolicy',
    'iam:TagRole',
    'iam:UntagPolicy',
    'iam:UntagRole',
    'iam:UpdateAssumeRolePolicy',
    'iam:UpdateRole',
    'iam:UpdateRoleDescription'
  ].sort());
  assert.ok(statement.Action.every((action) => !action.includes('*')));
  assert.ok(statement.Action.every((action) => action.startsWith('iam:')));
});

test('Caddy unit is unprivileged, supervised, and writes only owner-private state', async () => {
  const unit = await readFile(bundle('caddy.service'), 'utf8');
  assert.match(unit, /^User=caddy$/m);
  assert.match(unit, /^Group=caddy$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^ProtectHome=true$/m);
  assert.match(unit, /^CapabilityBoundingSet=CAP_NET_BIND_SERVICE$/m);
  assert.match(unit, /^StateDirectoryMode=0700$/m);
  assert.match(unit, /^UMask=0077$/m);
  assert.doesNotMatch(unit, /AWS_(?:ACCESS_KEY|SECRET|SESSION_TOKEN)/);
});

test('companion application templates preserve loopback binding and worker locking', async () => {
  const [web, worker] = await Promise.all([
    readFile(bundle('companion-web.service.template'), 'utf8'),
    readFile(bundle('companion-worker.service.template'), 'utf8')
  ]);
  assert.match(web, /--hostname 127\.0\.0\.1 --port 8104/);
  assert.match(web, /^Restart=on-failure$/m);
  assert.match(web, /^Environment=COMPANION_DB_PATH=@COMPANION_ROOT@\/\.data\/app\.sqlite$/m);
  assert.match(web, /^ProtectHome=read-only$/m);
  assert.match(web, /^ReadWritePaths=@COMPANION_ROOT@\/\.data @COMPANION_ROOT@\/\.next\/cache$/m);
  assert.match(worker, /ExecStart=\/usr\/bin\/flock -n @COMPANION_ROOT@\/\.data\/worker\.lock/);
  assert.match(worker, /npm run worker/);
  assert.match(worker, /^Environment=COMPANION_DB_PATH=@COMPANION_ROOT@\/\.data\/app\.sqlite$/m);
  assert.match(worker, /^Environment=CODEX_HOME=%h\/\.codex$/m);
  assert.match(worker, /^ProtectHome=read-only$/m);
  assert.match(worker, /^ReadWritePaths=@COMPANION_ROOT@\/\.data %h\/\.codex %h\/\.cache$/m);
  for (const directive of [
    'LockPersonality=true',
    'ProtectControlGroups=true',
    'ProtectHostname=true',
    'ProtectKernelTunables=true',
    'RestrictRealtime=true',
    'SystemCallArchitectures=native'
  ]) {
    const escaped = directive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(web, new RegExp(`^${escaped}$`, 'm'));
    assert.match(worker, new RegExp(`^${escaped}$`, 'm'));
  }
  assert.doesNotMatch(`${web}\n${worker}`, /^(?:CapabilityBoundingSet|ProtectClock|ProtectKernelLogs|ProtectKernelModules)=/m);
  assert.match(web, /^PrivateDevices=true$/m);
  assert.match(web, /^RemoveIPC=true$/m);
  assert.match(web, /^RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX$/m);
  assert.match(web, /^RestrictNamespaces=true$/m);
  assert.doesNotMatch(`${web}\n${worker}`, /0\.0\.0\.0|--yolo|auto.?apply/i);
});

test('custom Caddy builder pins every source and refuses overwrite', async () => {
  const script = await readFile(path.join(root, 'scripts', 'build-pinned-caddy.sh'), 'utf8');
  for (const version of ['1.26.5', 'v2.11.4', 'v0.4.5', 'v1.6.2']) assert.match(script, new RegExp(version.replaceAll('.', '\\.')));
  assert.match(script, /sha256sum --check --strict/);
  assert.match(script, /refusing to overwrite existing output/);
  assert.match(script, /chmod -R u\+w "\$panefleet_build_root"/);
  assert.match(script, /dns\\\.providers\\\.route53/);
  assert.doesNotMatch(script, /(?:^|[\s@])latest(?:$|[\s"'])/m);
  assert.doesNotMatch(script, /sudo|npm install -g/);
});
