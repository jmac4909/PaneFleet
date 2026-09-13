import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import bcrypt from 'bcryptjs';

import {
  createOperatorDeviceAuth,
  DEVICE_AUTH_MAX_ATTEMPTS,
  DEVICE_AUTH_RETRY_SECONDS,
  DEVICE_SESSION_TTL_SECONDS,
  loadOperatorDeviceAuthConfig,
  validateOperatorDeviceAuthConfig
} from '../operator-device-auth.js';

const FIXTURE_USERNAME = 'fixture-operator';
const FIXTURE_PASSWORD = 'fixture-password-only';

function fixturePaths(prefix = 'panefleet-device-auth-') {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    directory,
    config: path.join(directory, 'device-auth.json'),
    sessions: path.join(directory, 'device-sessions.json')
  };
}

function writeConfig(filePath, overrides = {}) {
  const value = {
    version: 1,
    username: FIXTURE_USERNAME,
    passwordHash: bcrypt.hashSync(FIXTURE_PASSWORD, 10),
    ...overrides
  };
  writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(filePath, 0o600);
  return value;
}

test('device-auth config accepts only a private bounded bcrypt credential', async (t) => {
  const paths = fixturePaths();
  try {
    const expected = writeConfig(paths.config);
    assert.deepEqual(await loadOperatorDeviceAuthConfig(paths.config), expected);
    assert.equal(Object.isFrozen(await loadOperatorDeviceAuthConfig(paths.config)), true);

    for (const invalid of [
      null,
      [],
      {},
      { version: 2, username: FIXTURE_USERNAME, passwordHash: expected.passwordHash },
      { version: 1, username: 'bad username', passwordHash: expected.passwordHash },
      { version: 1, username: FIXTURE_USERNAME, passwordHash: 'not-bcrypt' },
      { version: 1, username: FIXTURE_USERNAME, passwordHash: expected.passwordHash.replace('$10$', '$09$') },
      { version: 1, username: FIXTURE_USERNAME, passwordHash: expected.passwordHash.replace('$10$', '$17$') }
    ]) assert.throws(() => validateOperatorDeviceAuthConfig(invalid), /orchestrator_device_auth_file_invalid/);

    await t.test('missing, malformed, broad, and linked config sources fail closed', async () => {
      await assert.rejects(loadOperatorDeviceAuthConfig(path.join(paths.directory, 'missing')), /orchestrator_device_auth_file_missing/);

      writeFileSync(paths.config, '{', { mode: 0o600 });
      await assert.rejects(loadOperatorDeviceAuthConfig(paths.config), /orchestrator_device_auth_file_invalid/);

      writeConfig(paths.config);
      chmodSync(paths.config, 0o644);
      await assert.rejects(loadOperatorDeviceAuthConfig(paths.config), /orchestrator_device_auth_file_permissions_invalid/);

      const target = path.join(paths.directory, 'target.json');
      writeConfig(target);
      rmSync(paths.config, { force: true });
      symlinkSync(target, paths.config);
      await assert.rejects(loadOperatorDeviceAuthConfig(paths.config), /orchestrator_device_auth_file_permissions_invalid/);
    });
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test('device sessions survive restart, contain only token hashes, expire, and revoke exactly', async () => {
  const paths = fixturePaths();
  let nowMs = Date.parse('2026-08-24T12:00:00.000Z');
  const tokens = ['a'.repeat(43), 'b'.repeat(43)];
  try {
    writeConfig(paths.config);
    let auth = await createOperatorDeviceAuth({
      authConfigPath: paths.config,
      sessionStorePath: paths.sessions,
      now: () => nowMs,
      createToken: () => tokens.shift()
    });

    assert.equal(auth.hasSession(''), false);
    assert.equal(auth.sessionCount(), 0);
    assert.equal((await auth.login({ username: FIXTURE_USERNAME, password: 'wrong', clientKey: '198.51.100.1' })).status, 'invalid_credentials');
    const login = await auth.login({ username: FIXTURE_USERNAME, password: FIXTURE_PASSWORD, clientKey: '198.51.100.1' });
    assert.equal(login.status, 'authenticated');
    assert.equal(login.token, 'a'.repeat(43));
    assert.equal(login.maxAgeSeconds, DEVICE_SESSION_TTL_SECONDS);
    assert.equal(auth.hasSession(login.token), true);
    assert.equal(auth.sessionCount(), 1);
    assert.equal(statSync(paths.sessions).mode & 0o777, 0o600);
    const persisted = readFileSync(paths.sessions, 'utf8');
    assert.doesNotMatch(persisted, new RegExp(login.token));
    assert.match(persisted, /"tokenHash": "[a-f0-9]{64}"/);

    auth = await createOperatorDeviceAuth({
      authConfigPath: paths.config,
      sessionStorePath: paths.sessions,
      now: () => nowMs,
      createToken: () => tokens.shift()
    });
    assert.equal(auth.hasSession(login.token), true);
    assert.equal(await auth.revoke('invalid'), false);
    assert.equal(await auth.revoke(login.token), true);
    assert.equal(auth.hasSession(login.token), false);
    assert.equal(await auth.revoke(login.token), false);

    const replacement = await auth.login({ username: FIXTURE_USERNAME, password: FIXTURE_PASSWORD, clientKey: '198.51.100.1' });
    assert.equal(auth.hasSession(replacement.token), true);
    nowMs += DEVICE_SESSION_TTL_SECONDS * 1000;
    assert.equal(auth.hasSession(replacement.token), false);
    auth = await createOperatorDeviceAuth({
      authConfigPath: paths.config,
      sessionStorePath: paths.sessions,
      now: () => nowMs
    });
    assert.equal(auth.sessionCount(), 0);
    assert.deepEqual(JSON.parse(readFileSync(paths.sessions, 'utf8')), { version: 1, sessions: [] });
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test('login failures are bounded per client and clear after the lockout', async () => {
  const paths = fixturePaths();
  let nowMs = Date.parse('2026-08-24T12:00:00.000Z');
  let verifyCalls = 0;
  try {
    writeConfig(paths.config);
    const auth = await createOperatorDeviceAuth({
      authConfigPath: paths.config,
      sessionStorePath: paths.sessions,
      now: () => nowMs,
      verifyPassword: async (password) => {
        verifyCalls += 1;
        return password === FIXTURE_PASSWORD;
      },
      createToken: () => 'c'.repeat(43)
    });

    for (let attempt = 1; attempt < DEVICE_AUTH_MAX_ATTEMPTS; attempt += 1) {
      const result = await auth.login({ username: FIXTURE_USERNAME, password: 'wrong', clientKey: '203.0.113.9' });
      assert.deepEqual(result, {
        status: 'invalid_credentials',
        attemptsRemaining: DEVICE_AUTH_MAX_ATTEMPTS - attempt
      });
    }
    assert.deepEqual(
      await auth.login({ username: FIXTURE_USERNAME, password: 'wrong', clientKey: '203.0.113.9' }),
      { status: 'rate_limited', retryAfterSeconds: DEVICE_AUTH_RETRY_SECONDS }
    );
    assert.deepEqual(
      await auth.login({ username: FIXTURE_USERNAME, password: FIXTURE_PASSWORD, clientKey: '203.0.113.9' }),
      { status: 'rate_limited', retryAfterSeconds: DEVICE_AUTH_RETRY_SECONDS }
    );
    assert.equal(verifyCalls, DEVICE_AUTH_MAX_ATTEMPTS);

    assert.equal((await auth.login({ username: FIXTURE_USERNAME, password: FIXTURE_PASSWORD, clientKey: '203.0.113.10' })).status, 'authenticated');
    nowMs += DEVICE_AUTH_RETRY_SECONDS * 1000 + 1;
    assert.equal((await auth.login({ username: 'wrong-user', password: FIXTURE_PASSWORD, clientKey: '203.0.113.9' })).status, 'invalid_credentials');
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test('default clock, bcrypt verifier, token generator, and durable writer form a valid session', async () => {
  const paths = fixturePaths();
  try {
    writeConfig(paths.config);
    const auth = await createOperatorDeviceAuth({
      authConfigPath: paths.config,
      sessionStorePath: paths.sessions
    });
    const login = await auth.login({
      username: FIXTURE_USERNAME,
      password: FIXTURE_PASSWORD,
      clientKey: ''
    });
    assert.equal(login.status, 'authenticated');
    assert.match(login.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(auth.hasSession(login.token), true);
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test('invalid session stores and unsafe factory dependencies fail closed', async (t) => {
  const paths = fixturePaths();
  const nowMs = Date.parse('2026-08-24T12:00:00.000Z');
  try {
    writeConfig(paths.config);
    for (const value of [
      null,
      { version: 2, sessions: [] },
      { version: 1, sessions: {} },
      { version: 1, sessions: [{ tokenHash: '0'.repeat(64), createdAt: 'bad', expiresAt: 'bad' }] },
      { version: 1, sessions: [0, 1].map(() => ({
        tokenHash: '0'.repeat(64),
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + 60_000).toISOString()
      })) },
      { version: 1, sessions: Array.from({ length: 25 }, (_, index) => ({
        tokenHash: index.toString(16).padStart(64, '0'),
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + 60_000).toISOString()
      })) }
    ]) {
      writeFileSync(paths.sessions, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      chmodSync(paths.sessions, 0o600);
      await assert.rejects(createOperatorDeviceAuth({
        authConfigPath: paths.config,
        sessionStorePath: paths.sessions,
        now: () => nowMs
      }), /orchestrator_device_session_file_invalid/);
    }

    writeFileSync(paths.sessions, '{', { mode: 0o600 });
    chmodSync(paths.sessions, 0o600);
    await assert.rejects(createOperatorDeviceAuth({
      authConfigPath: paths.config,
      sessionStorePath: paths.sessions,
      now: () => nowMs
    }), /orchestrator_device_session_file_invalid/);

    writeFileSync(paths.sessions, '{"version":1,"sessions":[]}\n', { mode: 0o644 });
    chmodSync(paths.sessions, 0o644);
    await assert.rejects(createOperatorDeviceAuth({
      authConfigPath: paths.config,
      sessionStorePath: paths.sessions,
      now: () => nowMs
    }), /orchestrator_device_session_file_permissions_invalid/);

    rmSync(paths.sessions, { force: true });
    for (const overrides of [
      { sessionStorePath: 'relative' },
      { now: null },
      { verifyPassword: null },
      { createToken: null },
      { writeStore: null }
    ]) {
      await assert.rejects(createOperatorDeviceAuth({
        authConfigPath: paths.config,
        sessionStorePath: paths.sessions,
        now: () => nowMs,
        ...overrides
      }), TypeError);
    }

    await t.test('invalid generated tokens and failed durable writes never authorize', async () => {
      const invalidTokenAuth = await createOperatorDeviceAuth({
        authConfigPath: paths.config,
        sessionStorePath: paths.sessions,
        now: () => nowMs,
        verifyPassword: async () => true,
        createToken: () => 'short'
      });
      await assert.rejects(
        invalidTokenAuth.login({ username: FIXTURE_USERNAME, password: FIXTURE_PASSWORD }),
        /orchestrator_device_session_token_invalid/
      );

      const failedWriteAuth = await createOperatorDeviceAuth({
        authConfigPath: paths.config,
        sessionStorePath: paths.sessions,
        now: () => nowMs,
        verifyPassword: async () => true,
        createToken: () => 'd'.repeat(43),
        writeStore: async () => { throw new Error('fixture_write_failed'); }
      });
      await assert.rejects(
        failedWriteAuth.login({ username: FIXTURE_USERNAME, password: FIXTURE_PASSWORD }),
        /fixture_write_failed/
      );
      assert.equal(failedWriteAuth.hasSession('d'.repeat(43)), false);
    });
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});
