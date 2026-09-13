import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

import bcrypt from 'bcryptjs';

import { writeJsonAtomic } from './durable-json.js';

export const DEVICE_AUTH_ACCESS_MODE = 'device-session';
export const DEVICE_SESSION_COOKIE = '__Host-panefleet_device';
export const DEVICE_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const DEVICE_AUTH_MAX_ATTEMPTS = 5;
export const DEVICE_AUTH_RETRY_SECONDS = 15 * 60;

const DEVICE_AUTH_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const DEVICE_AUTH_MAX_SESSIONS = 24;
const DEVICE_AUTH_CONFIG_MAX_BYTES = 4 * 1024;
const DEVICE_AUTH_STORE_MAX_BYTES = 64 * 1024;
const DEVICE_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_SESSION_HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEVICE_AUTH_USERNAME_PATTERN = /^[A-Za-z0-9_.@-]{1,128}$/;
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/;

function authError(code) {
  return new Error(code);
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function tokenHash(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

function safeTextEqual(candidate, expected) {
  const left = Buffer.from(String(candidate || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readPrivateFile(filePath, { maximumBytes, permissionError }) {
  if (!path.isAbsolute(String(filePath || ''))) throw new TypeError('private file path must be absolute');
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    );
  } catch (error) {
    if (['EACCES', 'ELOOP', 'EPERM'].includes(error?.code)) throw authError(permissionError);
    throw error;
  }
  try {
    const details = await handle.stat();
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : details.uid;
    const mode = details.mode & 0o777;
    if (
      !details.isFile()
      || details.uid !== currentUid
      || (mode !== 0o400 && mode !== 0o600)
      || details.size > maximumBytes
    ) throw authError(permissionError);
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}

export function validateOperatorDeviceAuthConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
    throw authError('orchestrator_device_auth_file_invalid');
  }
  const username = String(value.username || '');
  const passwordHash = String(value.passwordHash || '');
  const hashMatch = passwordHash.match(BCRYPT_HASH_PATTERN);
  const cost = Number(hashMatch?.[1]);
  if (
    !DEVICE_AUTH_USERNAME_PATTERN.test(username)
    || !hashMatch
    || !Number.isInteger(cost)
    || cost < 10
    || cost > 16
  ) throw authError('orchestrator_device_auth_file_invalid');
  return Object.freeze({ version: 1, username, passwordHash });
}

export async function loadOperatorDeviceAuthConfig(authConfigPath) {
  let raw;
  try {
    raw = await readPrivateFile(authConfigPath, {
      maximumBytes: DEVICE_AUTH_CONFIG_MAX_BYTES,
      permissionError: 'orchestrator_device_auth_file_permissions_invalid'
    });
  } catch (error) {
    if (error?.code === 'ENOENT') throw authError('orchestrator_device_auth_file_missing');
    throw error;
  }
  try {
    return validateOperatorDeviceAuthConfig(JSON.parse(raw));
  } catch (error) {
    if (error?.message === 'orchestrator_device_auth_file_invalid') throw error;
    throw authError('orchestrator_device_auth_file_invalid');
  }
}

function validateSessionRecord(value, nowMs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const tokenDigest = String(value.tokenHash || '');
  const createdAtMs = timestampMs(value.createdAt);
  const expiresAtMs = timestampMs(value.expiresAt);
  if (
    !DEVICE_SESSION_HASH_PATTERN.test(tokenDigest)
    || !Number.isFinite(createdAtMs)
    || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= createdAtMs
    || expiresAtMs - createdAtMs > DEVICE_SESSION_TTL_SECONDS * 1000
    || createdAtMs > nowMs + 60_000
  ) return null;
  return {
    tokenHash: tokenDigest,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString()
  };
}

function validateSessionStore(value, nowMs) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.version !== 1
    || !Array.isArray(value.sessions)
    || value.sessions.length > DEVICE_AUTH_MAX_SESSIONS
  ) throw authError('orchestrator_device_session_file_invalid');
  const sessions = value.sessions.map((record) => validateSessionRecord(record, nowMs));
  if (sessions.some((record) => !record)) throw authError('orchestrator_device_session_file_invalid');
  if (new Set(sessions.map((record) => record.tokenHash)).size !== sessions.length) {
    throw authError('orchestrator_device_session_file_invalid');
  }
  return { version: 1, sessions };
}

async function loadSessionStore(sessionStorePath, nowMs) {
  let raw;
  try {
    raw = await readPrivateFile(sessionStorePath, {
      maximumBytes: DEVICE_AUTH_STORE_MAX_BYTES,
      permissionError: 'orchestrator_device_session_file_permissions_invalid'
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, sessions: [] };
    throw error;
  }
  try {
    return validateSessionStore(JSON.parse(raw), nowMs);
  } catch (error) {
    if (error?.message === 'orchestrator_device_session_file_invalid') throw error;
    throw authError('orchestrator_device_session_file_invalid');
  }
}

function activeSessions(store, nowMs) {
  return store.sessions.filter((record) => timestampMs(record.expiresAt) > nowMs);
}

function safeClientKey(value) {
  const key = String(value || '').trim();
  return key && key.length <= 160 ? key : 'unknown';
}

export async function createOperatorDeviceAuth({
  authConfigPath,
  sessionStorePath,
  now = () => Date.now(),
  verifyPassword = (password, passwordHash) => bcrypt.compare(password, passwordHash),
  createToken = () => randomBytes(32).toString('base64url'),
  writeStore = writeJsonAtomic
} = {}) {
  if (!path.isAbsolute(String(sessionStorePath || ''))) throw new TypeError('sessionStorePath must be absolute');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof verifyPassword !== 'function') throw new TypeError('verifyPassword must be a function');
  if (typeof createToken !== 'function') throw new TypeError('createToken must be a function');
  if (typeof writeStore !== 'function') throw new TypeError('writeStore must be a function');

  const config = await loadOperatorDeviceAuthConfig(authConfigPath);
  const initialNowMs = Number(now());
  if (!Number.isFinite(initialNowMs)) throw new TypeError('now must return a finite timestamp');
  let store = await loadSessionStore(sessionStorePath, initialNowMs);
  const pruned = activeSessions(store, initialNowMs);
  if (pruned.length !== store.sessions.length) {
    const prunedStore = { version: 1, sessions: pruned };
    await writeStore(sessionStorePath, prunedStore, { spaces: 2 });
    store = prunedStore;
  }

  const loginFailures = new Map();
  let operationQueue = Promise.resolve();
  const enqueue = (operation) => {
    const pending = operationQueue.catch(() => {}).then(operation);
    operationQueue = pending;
    return pending;
  };

  function currentNowMs() {
    const value = Number(now());
    if (!Number.isFinite(value)) throw new TypeError('now must return a finite timestamp');
    return value;
  }

  function rateLimitState(clientKey, nowMs) {
    const key = safeClientKey(clientKey);
    const existing = loginFailures.get(key) || { attempts: [], blockedUntil: 0 };
    if (existing.blockedUntil > nowMs) {
      return { key, limited: true, retryAfterSeconds: Math.max(1, Math.ceil((existing.blockedUntil - nowMs) / 1000)) };
    }
    const attempts = existing.attempts.filter((at) => at > nowMs - DEVICE_AUTH_FAILURE_WINDOW_MS);
    loginFailures.set(key, { attempts, blockedUntil: 0 });
    return { key, limited: false, retryAfterSeconds: 0 };
  }

  function recordFailure(key, nowMs) {
    const existing = loginFailures.get(key) || { attempts: [], blockedUntil: 0 };
    const attempts = [...existing.attempts.filter((at) => at > nowMs - DEVICE_AUTH_FAILURE_WINDOW_MS), nowMs];
    if (attempts.length >= DEVICE_AUTH_MAX_ATTEMPTS) {
      loginFailures.set(key, { attempts: [], blockedUntil: nowMs + DEVICE_AUTH_RETRY_SECONDS * 1000 });
      return { status: 'rate_limited', retryAfterSeconds: DEVICE_AUTH_RETRY_SECONDS };
    }
    loginFailures.set(key, { attempts, blockedUntil: 0 });
    return { status: 'invalid_credentials', attemptsRemaining: DEVICE_AUTH_MAX_ATTEMPTS - attempts.length };
  }

  function hasSession(token) {
    if (!DEVICE_SESSION_TOKEN_PATTERN.test(String(token || ''))) return false;
    const nowMs = currentNowMs();
    const candidate = Buffer.from(tokenHash(token), 'hex');
    return store.sessions.some((record) => (
      timestampMs(record.expiresAt) > nowMs
      && timingSafeEqual(candidate, Buffer.from(record.tokenHash, 'hex'))
    ));
  }

  async function login({ username, password, clientKey } = {}) {
    return enqueue(async () => {
      const nowMs = currentNowMs();
      const limit = rateLimitState(clientKey, nowMs);
      if (limit.limited) return { status: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds };

      const suppliedPassword = typeof password === 'string' && password.length <= 512 ? password : '';
      const passwordMatches = await verifyPassword(suppliedPassword, config.passwordHash);
      if (!safeTextEqual(username, config.username) || !passwordMatches || !suppliedPassword) {
        return recordFailure(limit.key, nowMs);
      }

      loginFailures.delete(limit.key);
      const token = String(createToken() || '');
      if (!DEVICE_SESSION_TOKEN_PATTERN.test(token)) throw authError('orchestrator_device_session_token_invalid');
      const createdAt = new Date(nowMs).toISOString();
      const expiresAt = new Date(nowMs + DEVICE_SESSION_TTL_SECONDS * 1000).toISOString();
      const sessions = [
        ...activeSessions(store, nowMs),
        { tokenHash: tokenHash(token), createdAt, expiresAt }
      ].slice(-DEVICE_AUTH_MAX_SESSIONS);
      const nextStore = { version: 1, sessions };
      await writeStore(sessionStorePath, nextStore, { spaces: 2 });
      store = nextStore;
      return { status: 'authenticated', token, createdAt, expiresAt, maxAgeSeconds: DEVICE_SESSION_TTL_SECONDS };
    });
  }

  async function revoke(token) {
    return enqueue(async () => {
      if (!DEVICE_SESSION_TOKEN_PATTERN.test(String(token || ''))) return false;
      const digest = tokenHash(token);
      const sessions = store.sessions.filter((record) => !safeTextEqual(record.tokenHash, digest));
      if (sessions.length === store.sessions.length) return false;
      const nextStore = { version: 1, sessions };
      await writeStore(sessionStorePath, nextStore, { spaces: 2 });
      store = nextStore;
      return true;
    });
  }

  return Object.freeze({
    hasSession,
    login,
    revoke,
    sessionCount: () => store.sessions.length
  });
}
