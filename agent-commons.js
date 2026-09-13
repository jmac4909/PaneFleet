import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

import {
  atomicJsonReplacementCommitted,
  ensurePrivateDirectory,
  writeJsonAtomic
} from './durable-json.js';

export const AGENT_COMMONS_VERSION = 1;
export const AGENT_COMMONS_CATEGORIES = Object.freeze([
  'update',
  'question',
  'claim',
  'decision',
  'wait',
  'work_claim',
  'help_request',
  'lesson'
]);
export const AGENT_COMMONS_ATTENTION = Object.freeze([
  'board',
  'ping',
  'checkpoint',
  'stop'
]);

const CATEGORY_SET = new Set(AGENT_COMMONS_CATEGORIES);
const ATTENTION_SET = new Set(AGENT_COMMONS_ATTENTION);
const MESSAGE_ID_PATTERN = /^commons-[a-z0-9][a-z0-9-]{11,63}$/;
const OPERATION_ID_PATTERN = /^commons-op-[A-Za-z0-9][A-Za-z0-9._:-]{7,111}$/;
const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PANE_ID_PATTERN = /^%\d+$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const MAX_MESSAGES = 1000;
const MAX_OPERATIONS = 2000;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const MAX_BODY_CHARS = 6000;
const MAX_EVIDENCE_CHARS = 3000;
const MAX_SCOPE_CHARS = 512;
const MAX_AUDIENCE = 24;
const MAX_ACKNOWLEDGEMENTS = 64;

const INITIAL_STATE = Object.freeze({
  update: 'open',
  question: 'open',
  claim: 'observation',
  decision: 'open',
  wait: 'waiting',
  work_claim: 'claimed',
  help_request: 'open',
  lesson: 'candidate'
});

const STATE_TRANSITIONS = Object.freeze({
  update: Object.freeze({
    open: Object.freeze(['resolved', 'withdrawn']),
    resolved: Object.freeze(['open']),
    withdrawn: Object.freeze([])
  }),
  question: Object.freeze({
    open: Object.freeze(['resolved', 'withdrawn']),
    resolved: Object.freeze(['open']),
    withdrawn: Object.freeze([])
  }),
  claim: Object.freeze({
    observation: Object.freeze(['verified', 'disputed', 'superseded']),
    verified: Object.freeze(['disputed', 'superseded']),
    disputed: Object.freeze(['observation', 'verified', 'superseded']),
    superseded: Object.freeze([])
  }),
  decision: Object.freeze({
    open: Object.freeze(['resolved', 'withdrawn']),
    resolved: Object.freeze(['open', 'superseded']),
    superseded: Object.freeze([]),
    withdrawn: Object.freeze([])
  }),
  wait: Object.freeze({
    waiting: Object.freeze(['accepted', 'declined', 'satisfied', 'withdrawn']),
    accepted: Object.freeze(['declined', 'satisfied', 'withdrawn']),
    declined: Object.freeze(['waiting']),
    satisfied: Object.freeze([]),
    withdrawn: Object.freeze([])
  }),
  work_claim: Object.freeze({
    claimed: Object.freeze(['completed', 'released', 'disputed']),
    disputed: Object.freeze(['claimed', 'completed', 'released']),
    completed: Object.freeze([]),
    released: Object.freeze([])
  }),
  help_request: Object.freeze({
    open: Object.freeze(['resolved', 'withdrawn']),
    resolved: Object.freeze(['open']),
    withdrawn: Object.freeze([])
  }),
  lesson: Object.freeze({
    candidate: Object.freeze(['tried', 'disputed', 'retired']),
    tried: Object.freeze(['supported', 'disputed', 'retired']),
    supported: Object.freeze(['active', 'disputed', 'retired']),
    active: Object.freeze(['disputed', 'retired']),
    disputed: Object.freeze(['tried', 'supported', 'active', 'retired']),
    retired: Object.freeze([])
  })
});

const ATTENTION_CLOSED_STATES = new Set([
  'resolved',
  'withdrawn',
  'verified',
  'superseded',
  'declined',
  'satisfied',
  'completed',
  'released',
  'supported',
  'active',
  'retired'
]);

function commonsError(code, detail = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, detail);
  return error;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys, code) {
  if (!plainObject(value)) throw commonsError(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw commonsError(code);
  }
}

function clone(value) {
  return structuredClone(value);
}

function validTimestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return typeof value === 'string'
    && value.length > 0
    && Number.isFinite(parsed)
    && value === new Date(parsed).toISOString();
}

function timestamp(value) {
  const candidate = value instanceof Date ? value.toISOString() : String(value ?? '');
  if (!validTimestamp(candidate)) throw commonsError('agent_commons_now_invalid');
  return candidate;
}

function normalizedText(value, { field, maximum, required = false, inline = false } = {}) {
  let result = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (inline) result = result.replace(/\s+/g, ' ');
  if ((required && !result) || result.length > maximum || CONTROL_CHARACTER_PATTERN.test(result)) {
    throw commonsError(`agent_commons_${field}_invalid`);
  }
  return result;
}

function normalizedSession(value, field = 'session') {
  const result = normalizedText(value, { field, maximum: 128, required: true, inline: true });
  if (!SESSION_PATTERN.test(result)) throw commonsError(`agent_commons_${field}_invalid`);
  return result;
}

function normalizedMessageId(value, field = 'message_id', { optional = false } = {}) {
  const result = String(value ?? '').trim().toLowerCase();
  if (optional && !result) return '';
  if (!MESSAGE_ID_PATTERN.test(result)) throw commonsError(`agent_commons_${field}_invalid`);
  return result;
}

function normalizedOperationId(value) {
  const result = String(value ?? '').trim();
  if (!OPERATION_ID_PATTERN.test(result)) throw commonsError('agent_commons_operation_id_invalid');
  return result;
}

function normalizedActor(value) {
  if (!plainObject(value)) throw commonsError('agent_commons_actor_invalid');
  const kind = String(value.kind || '').trim().toLowerCase();
  if (kind === 'operator') {
    return { kind, session: '', sessionCreatedAt: '', paneId: '', panePid: 0, label: 'Operator' };
  }
  if (kind !== 'agent') throw commonsError('agent_commons_actor_invalid');
  const session = normalizedSession(value.session, 'actor_session');
  const paneId = normalizedText(value.paneId, {
    field: 'actor_pane_id', maximum: 32, required: true, inline: true
  });
  if (!PANE_ID_PATTERN.test(paneId)) throw commonsError('agent_commons_actor_pane_id_invalid');
  const sessionCreatedAt = normalizedText(value.sessionCreatedAt, {
    field: 'actor_session_created_at', maximum: 40, required: true, inline: true
  });
  if (!validTimestamp(sessionCreatedAt)) throw commonsError('agent_commons_actor_session_created_at_invalid');
  const panePid = Number(value.panePid);
  if (!Number.isSafeInteger(panePid) || panePid < 1) throw commonsError('agent_commons_actor_pane_pid_invalid');
  const label = normalizedText(value.label || session.replace(/^codex-/, '').replaceAll('-', ' '), {
    field: 'actor_label', maximum: 80, required: true, inline: true
  });
  return { kind, session, sessionCreatedAt, paneId, panePid, label };
}

function normalizedAudience(value) {
  if (value === undefined || value === null || value === 'all') {
    return { kind: 'all', sessions: [] };
  }
  if (plainObject(value) && value.kind === 'all' && Array.isArray(value.sessions) && value.sessions.length === 0) {
    return { kind: 'all', sessions: [] };
  }
  const candidates = Array.isArray(value)
    ? value
    : plainObject(value)
      ? value.sessions
      : [value];
  if (!Array.isArray(candidates)) throw commonsError('agent_commons_audience_invalid');
  const sessions = [...new Set(candidates.map((session) => normalizedSession(session, 'audience_session')))];
  if (!sessions.length || sessions.length > MAX_AUDIENCE) {
    throw commonsError('agent_commons_audience_invalid');
  }
  return { kind: 'sessions', sessions };
}

function normalizedCategory(value) {
  const category = String(value || 'update').trim().toLowerCase();
  if (!CATEGORY_SET.has(category)) throw commonsError('agent_commons_category_invalid');
  return category;
}

function normalizedAttention(value) {
  const attention = String(value || 'board').trim().toLowerCase();
  if (!ATTENTION_SET.has(attention)) throw commonsError('agent_commons_attention_invalid');
  return attention;
}

function normalizedScope(value) {
  return normalizedText(value || 'global', {
    field: 'scope', maximum: MAX_SCOPE_CHARS, required: true, inline: true
  });
}

function normalizedCreateInput(value, { replyTo = '' } = {}) {
  if (!plainObject(value)) throw commonsError('agent_commons_message_invalid');
  const parentId = normalizedMessageId(replyTo || value.parentId, 'parent_id', { optional: true });
  const category = parentId ? 'update' : normalizedCategory(value.category);
  const supersedesId = parentId
    ? ''
    : normalizedMessageId(value.supersedesId, 'supersedes_id', { optional: true });
  return {
    parentId,
    category,
    attention: normalizedAttention(value.attention),
    audience: normalizedAudience(value.audience),
    scope: normalizedScope(value.scope),
    body: normalizedText(value.body, {
      field: 'body', maximum: MAX_BODY_CHARS, required: true
    }),
    evidence: normalizedText(value.evidence, {
      field: 'evidence', maximum: MAX_EVIDENCE_CHARS
    }),
    independent: !parentId && category === 'decision' && value.independent === true,
    supersedesId
  };
}

function acknowledgementKey(actor) {
  return actor.kind === 'operator' ? 'operator' : `agent:${actor.session}`;
}

function normalizedAcknowledgement(value) {
  exactKeys(value, ['actor', 'at'], 'agent_commons_acknowledgement_invalid');
  return { actor: normalizedActor(value.actor), at: timestamp(value.at) };
}

function stateForCategory(category, value) {
  const state = String(value || '').trim().toLowerCase();
  if (!Object.hasOwn(STATE_TRANSITIONS[category] || {}, state)) {
    throw commonsError('agent_commons_state_invalid');
  }
  return state;
}

function normalizedMessage(value) {
  exactKeys(value, [
    'version', 'id', 'threadId', 'parentId', 'revision', 'author', 'audience',
    'category', 'attention', 'scope', 'body', 'evidence', 'state', 'independent',
    'supersedesId', 'acknowledgements', 'createdAt', 'updatedAt'
  ], 'agent_commons_message_shape_invalid');
  if (value.version !== AGENT_COMMONS_VERSION) throw commonsError('agent_commons_message_version_invalid');
  const id = normalizedMessageId(value.id);
  const parentId = normalizedMessageId(value.parentId, 'parent_id', { optional: true });
  const threadId = normalizedMessageId(value.threadId, 'thread_id');
  if ((parentId && threadId === id) || (!parentId && threadId !== id)) {
    throw commonsError('agent_commons_thread_invalid');
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw commonsError('agent_commons_message_revision_invalid');
  }
  const category = normalizedCategory(value.category);
  const acknowledgements = Array.isArray(value.acknowledgements)
    ? value.acknowledgements.map(normalizedAcknowledgement)
    : null;
  if (!acknowledgements || acknowledgements.length > MAX_ACKNOWLEDGEMENTS) {
    throw commonsError('agent_commons_acknowledgements_invalid');
  }
  const acknowledgementKeys = acknowledgements.map(({ actor }) => acknowledgementKey(actor));
  if (new Set(acknowledgementKeys).size !== acknowledgementKeys.length) {
    throw commonsError('agent_commons_acknowledgements_invalid');
  }
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw commonsError('agent_commons_message_chronology_invalid');
  const independent = value.independent === true;
  if (typeof value.independent !== 'boolean' || (independent && (category !== 'decision' || parentId))) {
    throw commonsError('agent_commons_independent_invalid');
  }
  const supersedesId = normalizedMessageId(value.supersedesId, 'supersedes_id', { optional: true });
  if (supersedesId && (category !== 'lesson' || parentId || supersedesId === id)) {
    throw commonsError('agent_commons_supersession_invalid');
  }
  return {
    version: AGENT_COMMONS_VERSION,
    id,
    threadId,
    parentId,
    revision: value.revision,
    author: normalizedActor(value.author),
    audience: normalizedAudience(value.audience),
    category,
    attention: normalizedAttention(value.attention),
    scope: normalizedScope(value.scope),
    body: normalizedText(value.body, {
      field: 'body', maximum: MAX_BODY_CHARS, required: true
    }),
    evidence: normalizedText(value.evidence, {
      field: 'evidence', maximum: MAX_EVIDENCE_CHARS
    }),
    state: stateForCategory(category, value.state),
    independent,
    supersedesId,
    acknowledgements,
    createdAt,
    updatedAt
  };
}

function normalizedRequestDigest(value) {
  const result = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw commonsError('agent_commons_operation_invalid');
  return result;
}

function normalizedOperation(value) {
  exactKeys(value, ['id', 'action', 'messageId', 'requestDigest', 'at'], 'agent_commons_operation_invalid');
  const action = String(value.action || '');
  if (!['message.create', 'message.reply', 'message.acknowledge', 'message.transition'].includes(action)) {
    throw commonsError('agent_commons_operation_invalid');
  }
  return {
    id: normalizedOperationId(value.id),
    action,
    messageId: normalizedMessageId(value.messageId),
    requestDigest: normalizedRequestDigest(value.requestDigest),
    at: timestamp(value.at)
  };
}

function requestDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function emptyAgentCommonsStore() {
  return { version: AGENT_COMMONS_VERSION, revision: 0, messages: [], operations: [] };
}

export function validateAgentCommonsStore(value) {
  exactKeys(value, ['version', 'revision', 'messages', 'operations'], 'agent_commons_store_shape_invalid');
  if (value.version !== AGENT_COMMONS_VERSION) throw commonsError('agent_commons_store_version_unsupported');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw commonsError('agent_commons_store_revision_invalid');
  }
  if (!Array.isArray(value.messages) || value.messages.length > MAX_MESSAGES) {
    throw commonsError('agent_commons_messages_invalid');
  }
  if (!Array.isArray(value.operations) || value.operations.length > MAX_OPERATIONS) {
    throw commonsError('agent_commons_operations_invalid');
  }
  if (value.revision !== value.operations.length) throw commonsError('agent_commons_store_revision_invalid');

  const messages = value.messages.map(normalizedMessage);
  const byId = new Map();
  for (const message of messages) {
    if (byId.has(message.id)) throw commonsError('agent_commons_message_duplicate');
    byId.set(message.id, message);
  }
  for (const message of messages) {
    if (message.parentId) {
      const parent = byId.get(message.parentId);
      const root = byId.get(message.threadId);
      if (!parent || !root || root.parentId || parent.threadId !== message.threadId) {
        throw commonsError('agent_commons_thread_invalid');
      }
    }
    if (message.supersedesId) {
      const prior = byId.get(message.supersedesId);
      if (!prior || prior.category !== 'lesson' || prior.state !== 'retired') {
        throw commonsError('agent_commons_supersession_invalid');
      }
    }
  }

  const operations = value.operations.map(normalizedOperation);
  const operationIds = new Set();
  let previousAt = '';
  for (const operation of operations) {
    if (operationIds.has(operation.id) || !byId.has(operation.messageId)) {
      throw commonsError('agent_commons_operation_invalid');
    }
    if (previousAt && Date.parse(operation.at) < Date.parse(previousAt)) {
      throw commonsError('agent_commons_operation_chronology_invalid');
    }
    previousAt = operation.at;
    operationIds.add(operation.id);
  }
  const store = { version: AGENT_COMMONS_VERSION, revision: value.revision, messages, operations };
  if (Buffer.byteLength(JSON.stringify(store), 'utf8') > MAX_STORE_BYTES) {
    throw commonsError('agent_commons_store_too_large');
  }
  return store;
}

function publicMessage(message) {
  return {
    ...clone(message),
    transitions: [...(STATE_TRANSITIONS[message.category]?.[message.state] || [])]
  };
}

function publicSnapshot(store) {
  const messages = store.messages.map(publicMessage);
  const roots = messages.filter((message) => !message.parentId);
  const openAttention = messages.filter((message) => (
    ['ping', 'checkpoint', 'stop'].includes(message.attention)
    && !ATTENTION_CLOSED_STATES.has(message.state)
  ));
  return {
    version: AGENT_COMMONS_VERSION,
    revision: store.revision,
    messages,
    counts: {
      threads: roots.length,
      replies: messages.length - roots.length,
      attention: openAttention.length,
      stop: openAttention.filter((message) => message.attention === 'stop').length,
      coordination: roots.filter((message) => ['wait', 'work_claim', 'help_request'].includes(message.category)).length,
      helpRequests: roots.filter((message) => message.category === 'help_request' && message.state === 'open').length,
      lessons: roots.filter((message) => message.category === 'lesson').length
    },
    lastActivityAt: messages.reduce((latest, message) => (
      !latest || Date.parse(message.updatedAt) > Date.parse(latest) ? message.updatedAt : latest
    ), '') || null,
    safety: {
      dataOnly: true,
      terminalInputAuthorized: false,
      serviceControlAuthorized: false,
      externalMutationAuthorized: false
    }
  };
}

function audienceIncludes(message, session) {
  return message.audience.kind === 'all' || message.audience.sessions.includes(session);
}

function scopeIncludes(message, scope) {
  return message.scope === 'global' || !scope || message.scope === scope;
}

export function agentCommonsInbox(snapshot, {
  session,
  scope = '',
  includeResolved = false,
  limit = 40
} = {}) {
  const viewer = normalizedSession(session, 'viewer_session');
  const boundedLimit = Number(limit);
  if (!Number.isSafeInteger(boundedLimit) || boundedLimit < 1 || boundedLimit > 200) {
    throw commonsError('agent_commons_inbox_limit_invalid');
  }
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages.map((candidate) => {
    const { transitions: _transitions, ...message } = candidate || {};
    return normalizedMessage(message);
  }) : [];
  const byId = new Map(messages.map((message) => [message.id, message]));
  const defaultVisibleThreads = new Set(messages
    .filter((message) => (
      !ATTENTION_CLOSED_STATES.has(message.state)
      || ['active', 'verified', 'supported'].includes(message.state)
    ))
    .map((message) => message.threadId));
  const viewerThreads = new Set(messages
    .filter((message) => message.parentId && message.author.kind === 'agent' && message.author.session === viewer)
    .map((message) => message.threadId));
  const visible = messages.filter((message) => {
    const root = byId.get(message.threadId);
    if (!root || !audienceIncludes(root, viewer) || !scopeIncludes(root, scope)) return false;
    if (!includeResolved && !defaultVisibleThreads.has(root.id)) return false;
    if (
      message.parentId
      && root.independent
      && message.author.kind === 'agent'
      && message.author.session !== viewer
      && !viewerThreads.has(root.id)
    ) return false;
    return true;
  });
  return visible
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, boundedLimit)
    .reverse()
    .map(publicMessage);
}

export function agentCommonsHelperIdentity(messageIdValue) {
  const messageId = normalizedMessageId(messageIdValue);
  const suffix = messageId.slice('commons-'.length);
  const name = `commons-helper-${suffix}`;
  return Object.freeze({ name, session: `codex-${name}` });
}

function normalizedWorkspace(value) {
  const result = String(value || '').replace(/\/+$/, '');
  return path.isAbsolute(result) ? result : '';
}

function helpCandidateSummary(agent) {
  return {
    session: String(agent.session || ''),
    displayName: normalizedText(agent.displayName || agent.session, {
      field: 'helper_display_name', maximum: 120, required: true, inline: true
    }),
    state: String(agent.agentStatus?.state || 'idle'),
    workspace: normalizedWorkspace(agent.currentPath),
    lastInteractionAt: validTimestamp(agent.lastInteractionAt) ? agent.lastInteractionAt : null
  };
}

export function agentCommonsHelpRecommendation(messageValue, {
  agents = [],
  busySessions = [],
  workspace = '',
  resourceGate = { ok: false, error: 'agent_commons_helper_resource_gate_unavailable' },
  diskUsedPercent = null,
  controlPlaneReady = false
} = {}) {
  const { transitions: _transitions, ...candidateMessage } = messageValue || {};
  const message = normalizedMessage(candidateMessage);
  if (message.parentId || message.category !== 'help_request') {
    throw commonsError('agent_commons_help_request_invalid');
  }
  const helper = agentCommonsHelperIdentity(message.id);
  const resolvedWorkspace = normalizedWorkspace(workspace);
  const records = Array.isArray(agents) ? agents : [];
  const occupied = new Set(Array.isArray(busySessions) ? busySessions.map(String) : [...busySessions].map(String));
  const helperAgent = records.find((agent) => String(agent?.session || '') === helper.session);
  const base = {
    messageId: message.id,
    messageRevision: message.revision,
    helper: { ...helper, workspace: resolvedWorkspace },
    candidate: null,
    spawnAllowed: false,
    reason: ''
  };
  if (message.state !== 'open') return { ...base, kind: 'closed', reason: 'request_closed' };
  if (helperAgent) {
    return {
      ...base,
      kind: 'helper_exists',
      candidate: helpCandidateSummary(helperAgent),
      reason: 'deterministic_helper_already_exists'
    };
  }

  const requesterSession = message.author.kind === 'agent' ? message.author.session : '';
  const available = records.filter((agent) => {
    const session = String(agent?.session || '');
    const currentPath = normalizedWorkspace(agent?.currentPath);
    return /^codex(?:-|$)/.test(session)
      && session !== requesterSession
      && !session.startsWith('codex-commons-helper-')
      && agent?.canSend === true
      && agent?.queueReady === true
      && agent?.agentStatus?.state === 'idle'
      && agent?.agentStatus?.tone === 'good'
      && !occupied.has(session)
      && (!resolvedWorkspace || currentPath === resolvedWorkspace);
  }).sort((left, right) => {
    const leftAt = Date.parse(left.lastInteractionAt || '') || 0;
    const rightAt = Date.parse(right.lastInteractionAt || '') || 0;
    return leftAt - rightAt || String(left.session).localeCompare(String(right.session));
  });
  if (available.length) {
    return {
      ...base,
      kind: 'existing',
      candidate: helpCandidateSummary(available[0]),
      reason: 'compatible_idle_agent_available'
    };
  }
  if (requesterSession.startsWith('codex-commons-helper-')) {
    return { ...base, kind: 'blocked', reason: 'recursive_helper_spawn_forbidden' };
  }
  if (!resolvedWorkspace) return { ...base, kind: 'blocked', reason: 'workspace_required' };
  if (!controlPlaneReady) return { ...base, kind: 'blocked', reason: 'control_plane_isolation_required' };
  if (Number.isFinite(Number(diskUsedPercent)) && Number(diskUsedPercent) >= 90) {
    return { ...base, kind: 'blocked', reason: 'disk_gate', diskUsedPercent: Number(diskUsedPercent) };
  }
  if (resourceGate?.ok !== true) {
    return {
      ...base,
      kind: 'blocked',
      reason: String(resourceGate?.error || 'agent_commons_helper_resource_gate_unavailable')
    };
  }
  return {
    ...base,
    kind: 'spawn',
    spawnAllowed: true,
    reason: 'operator_approval_required',
    resourceGate: {
      availablePercent: Number(resourceGate.availablePercent),
      swapUsedPercent: Number(resourceGate.swapUsedPercent),
      fullPressureAvg10: Number(resourceGate.fullPressureAvg10)
    }
  };
}

function canAgentTransition(message, actor, nextState) {
  if (actor.kind !== 'agent') return true;
  const owns = message.author.kind === 'agent' && message.author.session === actor.session;
  const addressed = audienceIncludes(message, actor.session);
  if (message.category === 'lesson') return owns && ['tried', 'disputed', 'retired'].includes(nextState);
  if (message.category === 'wait') {
    if (['accepted', 'declined', 'satisfied'].includes(nextState)) return addressed;
    return owns && nextState === 'withdrawn';
  }
  if (message.category === 'work_claim') return owns;
  return owns;
}

function randomMessageId() {
  return `commons-${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`;
}

async function readStore(filePath) {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size > MAX_STORE_BYTES) throw commonsError('agent_commons_store_too_large');
    return validateAgentCommonsStore(JSON.parse(await handle.readFile('utf8')));
  } finally {
    await handle.close();
  }
}

export function createAgentCommonsRepository({
  filePath,
  now = () => new Date(),
  createId = randomMessageId,
  writeStore = writeJsonAtomic
} = {}) {
  if (!path.isAbsolute(String(filePath || ''))) throw new TypeError('filePath must be absolute');
  if (typeof now !== 'function' || typeof createId !== 'function' || typeof writeStore !== 'function') {
    throw new TypeError('repository hooks must be functions');
  }
  let operationChain = Promise.resolve();

  async function initialize() {
    await ensurePrivateDirectory(path.dirname(filePath));
    try {
      return await readStore(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const empty = emptyAgentCommonsStore();
      await writeStore(filePath, empty, { spaces: 2 });
      return empty;
    }
  }

  async function mutate(operationIdValue, action, digestValue, mutation) {
    const id = normalizedOperationId(operationIdValue);
    const digest = normalizedRequestDigest(digestValue);
    const run = async () => {
      const current = await initialize();
      const replay = current.operations.find((operation) => operation.id === id);
      if (replay) {
        if (replay.action !== action || replay.requestDigest !== digest) {
          throw commonsError('agent_commons_operation_conflict');
        }
        const message = current.messages.find((candidate) => candidate.id === replay.messageId);
        if (!message) throw commonsError('agent_commons_operation_invalid');
        return { replayed: true, revision: current.revision, message: publicMessage(message) };
      }
      if (current.messages.length >= MAX_MESSAGES || current.operations.length >= MAX_OPERATIONS) {
        throw commonsError('agent_commons_capacity_reached');
      }
      const at = timestamp(now());
      const { messages, messageId } = mutation(current, at);
      const next = validateAgentCommonsStore({
        version: AGENT_COMMONS_VERSION,
        revision: current.revision + 1,
        messages,
        operations: [...current.operations, { id, action, messageId, requestDigest: digest, at }]
      });
      try {
        await writeStore(filePath, next, { spaces: 2 });
      } catch (error) {
        if (!atomicJsonReplacementCommitted(error)) throw error;
        const committed = await readStore(filePath).catch(() => null);
        if (!committed?.operations.some((operation) => operation.id === id)) throw error;
      }
      const message = next.messages.find((candidate) => candidate.id === messageId);
      return { replayed: false, revision: next.revision, message: publicMessage(message) };
    };
    const result = operationChain.then(run, run);
    operationChain = result.then(() => undefined, () => undefined);
    return result;
  }

  async function create(input, { actor, operationId } = {}) {
    const author = normalizedActor(actor);
    const normalized = normalizedCreateInput(input);
    const digest = requestDigest({ actor: author, input: normalized });
    return mutate(operationId, 'message.create', digest, (store, at) => {
      const id = normalizedMessageId(createId());
      if (store.messages.some((message) => message.id === id)) throw commonsError('agent_commons_message_duplicate');
      if (normalized.supersedesId) {
        const prior = store.messages.find((message) => message.id === normalized.supersedesId);
        if (!prior || prior.category !== 'lesson' || prior.parentId || prior.state === 'retired') {
          throw commonsError('agent_commons_supersession_invalid');
        }
      }
      let messages = store.messages;
      if (normalized.supersedesId) {
        messages = messages.map((message) => message.id === normalized.supersedesId
          ? { ...message, revision: message.revision + 1, state: 'retired', updatedAt: at }
          : message);
      }
      const message = {
        version: AGENT_COMMONS_VERSION,
        id,
        threadId: id,
        parentId: '',
        revision: 1,
        author,
        audience: normalized.audience,
        category: normalized.category,
        attention: normalized.attention,
        scope: normalized.scope,
        body: normalized.body,
        evidence: normalized.evidence,
        state: INITIAL_STATE[normalized.category],
        independent: normalized.independent,
        supersedesId: normalized.supersedesId,
        acknowledgements: [],
        createdAt: at,
        updatedAt: at
      };
      return { messages: [...messages, message], messageId: id };
    });
  }

  async function reply(parentIdValue, input, { actor, operationId } = {}) {
    const author = normalizedActor(actor);
    const parentId = normalizedMessageId(parentIdValue, 'parent_id');
    const normalized = normalizedCreateInput(input, { replyTo: parentId });
    const digest = requestDigest({ actor: author, parentId, input: normalized });
    return mutate(operationId, 'message.reply', digest, (store, at) => {
      const parent = store.messages.find((message) => message.id === parentId);
      if (!parent) throw commonsError('agent_commons_parent_not_found');
      const root = store.messages.find((message) => message.id === parent.threadId);
      if (!root) throw commonsError('agent_commons_thread_invalid');
      if (author.kind === 'agent' && !audienceIncludes(root, author.session)) {
        throw commonsError('agent_commons_reply_not_addressed');
      }
      const id = normalizedMessageId(createId());
      if (store.messages.some((message) => message.id === id)) throw commonsError('agent_commons_message_duplicate');
      const message = {
        version: AGENT_COMMONS_VERSION,
        id,
        threadId: root.id,
        parentId,
        revision: 1,
        author,
        audience: root.audience,
        category: 'update',
        attention: normalized.attention,
        scope: root.scope,
        body: normalized.body,
        evidence: normalized.evidence,
        state: 'open',
        independent: false,
        supersedesId: '',
        acknowledgements: [],
        createdAt: at,
        updatedAt: at
      };
      return { messages: [...store.messages, message], messageId: id };
    });
  }

  async function acknowledge(messageIdValue, { actor, operationId } = {}) {
    const acknowledgementActor = normalizedActor(actor);
    const messageId = normalizedMessageId(messageIdValue);
    const digest = requestDigest({ actor: acknowledgementActor, messageId });
    return mutate(operationId, 'message.acknowledge', digest, (store, at) => {
      const current = store.messages.find((message) => message.id === messageId);
      if (!current) throw commonsError('agent_commons_message_not_found');
      if (acknowledgementActor.kind === 'agent' && !audienceIncludes(current, acknowledgementActor.session)) {
        throw commonsError('agent_commons_acknowledgement_not_addressed');
      }
      const key = acknowledgementKey(acknowledgementActor);
      const acknowledgements = current.acknowledgements.some(({ actor: candidate }) => acknowledgementKey(candidate) === key)
        ? current.acknowledgements
        : [...current.acknowledgements, { actor: acknowledgementActor, at }];
      const messages = store.messages.map((message) => message.id === messageId
        ? { ...message, revision: message.revision + 1, acknowledgements, updatedAt: at }
        : message);
      return { messages, messageId };
    });
  }

  async function transition(messageIdValue, nextStateValue, { actor, operationId } = {}) {
    const transitionActor = normalizedActor(actor);
    const messageId = normalizedMessageId(messageIdValue);
    const nextState = String(nextStateValue || '').trim().toLowerCase();
    const digest = requestDigest({ actor: transitionActor, messageId, nextState });
    return mutate(operationId, 'message.transition', digest, (store, at) => {
      const current = store.messages.find((message) => message.id === messageId);
      if (!current) throw commonsError('agent_commons_message_not_found');
      if (!(STATE_TRANSITIONS[current.category]?.[current.state] || []).includes(nextState)) {
        throw commonsError('agent_commons_transition_invalid', { currentState: current.state });
      }
      if (!canAgentTransition(current, transitionActor, nextState)) {
        throw commonsError('agent_commons_transition_forbidden');
      }
      const messages = store.messages.map((message) => message.id === messageId
        ? { ...message, revision: message.revision + 1, state: nextState, updatedAt: at }
        : message);
      return { messages, messageId };
    });
  }

  return Object.freeze({
    initialize,
    async snapshot() {
      return publicSnapshot(await initialize());
    },
    create,
    reply,
    acknowledge,
    transition
  });
}

export async function readAgentCommonsSpoolEnvelope(filePath, { maximumBytes = 64 * 1024 } = {}) {
  if (!path.isAbsolute(String(filePath || ''))) throw new TypeError('filePath must be absolute');
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size < 2 || details.size > maximumBytes) {
      throw commonsError('agent_commons_spool_envelope_invalid');
    }
    const value = JSON.parse(await handle.readFile('utf8'));
    exactKeys(value, ['version', 'operationId', 'action', 'actor', 'payload', 'createdAt'], 'agent_commons_spool_envelope_invalid');
    if (value.version !== AGENT_COMMONS_VERSION || !validTimestamp(value.createdAt)) {
      throw commonsError('agent_commons_spool_envelope_invalid');
    }
    const action = String(value.action || '');
    if (!['message.create', 'message.reply', 'message.acknowledge', 'message.transition'].includes(action)) {
      throw commonsError('agent_commons_spool_envelope_invalid');
    }
    return {
      version: AGENT_COMMONS_VERSION,
      operationId: normalizedOperationId(value.operationId),
      action,
      actor: normalizedActor(value.actor),
      payload: clone(value.payload),
      createdAt: value.createdAt
    };
  } finally {
    await handle.close();
  }
}
