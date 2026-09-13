import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  AGENT_COMMONS_ATTENTION,
  AGENT_COMMONS_CATEGORIES,
  agentCommonsHelpRecommendation,
  agentCommonsHelperIdentity,
  agentCommonsInbox,
  createAgentCommonsRepository,
  emptyAgentCommonsStore,
  readAgentCommonsSpoolEnvelope,
  validateAgentCommonsStore
} from '../agent-commons.js';
import { writeJsonAtomic } from '../durable-json.js';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commonsCli = path.join(projectRoot, 'scripts', 'agent-commons.mjs');

const operator = Object.freeze({ kind: 'operator' });
const alpha = Object.freeze({
  kind: 'agent',
  session: 'codex-alpha',
  sessionCreatedAt: '2026-08-27T07:00:00.000Z',
  paneId: '%7',
  panePid: 7007,
  label: 'Alpha'
});
const beta = Object.freeze({
  kind: 'agent',
  session: 'codex-beta',
  sessionCreatedAt: '2026-08-27T07:00:01.000Z',
  paneId: '%8',
  panePid: 8008,
  label: 'Beta'
});

function operationId(suffix) {
  return `commons-op-${suffix.padEnd(8, '0')}`;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panefleet-agent-commons-'));
  const filePath = path.join(root, 'private', 'agent-commons.json');
  const ids = Array.from({ length: 32 }, (_, index) => `commons-test-message-${String(index + 1).padStart(4, '0')}`);
  let tick = 0;
  const repository = createAgentCommonsRepository({
    filePath,
    now: () => new Date(Date.UTC(2026, 7, 27, 8, 0, tick++)),
    createId: () => ids.shift()
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, filePath, repository };
}

test('Agent Commons initializes a private durable store and rejects malformed stores', async (t) => {
  const { filePath, repository } = await fixture(t);
  assert.deepEqual(await repository.initialize(), emptyAgentCommonsStore());
  assert.equal((await stat(path.dirname(filePath))).mode & 0o777, 0o700);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.deepEqual(validateAgentCommonsStore(JSON.parse(await readFile(filePath, 'utf8'))), emptyAgentCommonsStore());

  assert.throws(() => validateAgentCommonsStore({}), /agent_commons_store_shape_invalid/);
  assert.throws(
    () => validateAgentCommonsStore({ ...emptyAgentCommonsStore(), version: 99 }),
    /agent_commons_store_version_unsupported/
  );
  assert.throws(
    () => validateAgentCommonsStore({ ...emptyAgentCommonsStore(), revision: 1 }),
    /agent_commons_store_revision_invalid/
  );
  assert.throws(() => createAgentCommonsRepository({ filePath: 'relative' }), /filePath must be absolute/);
  assert.throws(() => createAgentCommonsRepository({ filePath, now: null }), /repository hooks must be functions/);
});

test('persisted Commons records fail closed across store, message, actor, and operation corruption', async (t) => {
  const { filePath, repository } = await fixture(t);
  const root = await repository.create({
    category: 'question',
    audience: ['codex-alpha'],
    body: 'Is the persisted boundary intact?'
  }, { actor: operator, operationId: operationId('integrity-root') });
  await repository.reply(root.message.id, { body: 'Yes, before deliberate test corruption.' }, {
    actor: alpha,
    operationId: operationId('integrity-reply')
  });
  await repository.acknowledge(root.message.id, {
    actor: operator,
    operationId: operationId('integrity-ack')
  });
  const valid = JSON.parse(await readFile(filePath, 'utf8'));
  const rejectMutation = (mutate, pattern) => {
    const candidate = structuredClone(valid);
    mutate(candidate);
    assert.throws(() => validateAgentCommonsStore(candidate), pattern);
  };

  rejectMutation((store) => { store.revision = -1; }, /store_revision_invalid/);
  rejectMutation((store) => { store.messages = {}; }, /messages_invalid/);
  rejectMutation((store) => { store.messages = Array(1001); }, /messages_invalid/);
  rejectMutation((store) => { store.operations = {}; }, /operations_invalid/);
  rejectMutation((store) => { store.operations = Array(2001); }, /operations_invalid/);
  rejectMutation((store) => { store.messages[0].version = 2; }, /message_version_invalid/);
  rejectMutation((store) => { store.messages[0].threadId = 'commons-other-thread-0001'; }, /thread_invalid/);
  rejectMutation((store) => { store.messages[0].revision = 0; }, /message_revision_invalid/);
  rejectMutation((store) => { store.messages[0].acknowledgements = null; }, /acknowledgements_invalid/);
  rejectMutation((store) => {
    store.messages[0].acknowledgements.push(structuredClone(store.messages[0].acknowledgements[0]));
  }, /acknowledgements_invalid/);
  rejectMutation((store) => { store.messages[0].updatedAt = '2026-08-27T07:59:59.000Z'; }, /message_chronology_invalid/);
  rejectMutation((store) => { store.messages[0].independent = true; }, /independent_invalid/);
  rejectMutation((store) => { store.messages[0].state = 'invented'; }, /state_invalid/);
  rejectMutation((store) => { store.messages[0].audience = { kind: 'sessions', sessions: [] }; }, /audience_invalid/);
  rejectMutation((store) => {
    store.messages[0].audience = {
      kind: 'sessions',
      sessions: Array.from({ length: 25 }, (_, index) => `codex-viewer-${index}`)
    };
  }, /audience_invalid/);
  rejectMutation((store) => { store.messages.push(structuredClone(store.messages[0])); }, /message_duplicate/);
  rejectMutation((store) => { store.messages[1].parentId = 'commons-missing-parent-0001'; }, /thread_invalid/);
  rejectMutation((store) => { store.operations[0].action = 'terminal.interrupt'; }, /operation_invalid/);
  rejectMutation((store) => { store.operations[0].requestDigest = 'not-a-digest'; }, /operation_invalid/);
  rejectMutation((store) => { store.operations[1].id = store.operations[0].id; }, /operation_invalid/);
  rejectMutation((store) => { store.operations[1].messageId = 'commons-missing-message-0001'; }, /operation_invalid/);
  rejectMutation((store) => { store.operations[1].at = '2026-08-27T07:59:59.000Z'; }, /operation_chronology_invalid/);
});

test('actor and audience provenance reject malformed identities before persistence', async (t) => {
  const { repository } = await fixture(t);
  const attempt = (actor, suffix) => repository.create({ body: 'Must not persist.' }, {
    actor,
    operationId: operationId(suffix)
  });
  await assert.rejects(attempt(null, 'actor-null'), /actor_invalid/);
  await assert.rejects(attempt({ kind: 'service' }, 'actor-kind'), /actor_invalid/);
  await assert.rejects(attempt({ ...alpha, session: 'bad session' }, 'actor-session'), /actor_session_invalid/);
  await assert.rejects(attempt({ ...alpha, paneId: '7' }, 'actor-pane'), /actor_pane_id_invalid/);
  await assert.rejects(attempt({ ...alpha, sessionCreatedAt: 'yesterday' }, 'actor-created'), /actor_session_created_at_invalid/);
  await assert.rejects(attempt({ ...alpha, panePid: 0 }, 'actor-pid'), /actor_pane_pid_invalid/);
  await assert.rejects(repository.create({ body: 'No audience.', audience: { sessions: 'codex-alpha' } }, {
    actor: operator,
    operationId: operationId('audience-shape')
  }), /audience_invalid/);
  await assert.rejects(repository.create({ body: 'No audience.', audience: [] }, {
    actor: operator,
    operationId: operationId('audience-empty')
  }), /audience_invalid/);

  const normalized = await repository.create({
    body: 'The derived label and explicit all-audience shape are valid.',
    audience: { kind: 'all', sessions: [] }
  }, {
    actor: { ...alpha, label: '' },
    operationId: operationId('derived-label')
  });
  assert.equal(normalized.message.author.label, 'alpha');
  assert.deepEqual(normalized.message.audience, { kind: 'all', sessions: [] });
});

test('default repository hooks generate valid ids and recover only verified committed writes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panefleet-agent-commons-hooks-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const defaultRepository = createAgentCommonsRepository({ filePath: path.join(root, 'default.json') });
  const defaultResult = await defaultRepository.create({ body: 'Use production id and clock hooks.' }, {
    actor: operator,
    operationId: operationId('default-hooks')
  });
  assert.match(defaultResult.message.id, /^commons-[a-z0-9][a-z0-9-]{11,63}$/);

  let committedWrites = 0;
  const committedRepository = createAgentCommonsRepository({
    filePath: path.join(root, 'committed.json'),
    createId: () => 'commons-committed-write-0001',
    writeStore: async (target, value, options) => {
      await writeJsonAtomic(target, value, options);
      committedWrites += 1;
      if (committedWrites === 2) {
        const error = new Error('directory sync failed after rename');
        error.replacementCommitted = true;
        error.atomicWritePhase = 'parent_directory_sync';
        throw error;
      }
    }
  });
  const recovered = await committedRepository.create({ body: 'The receipt proves this write committed.' }, {
    actor: operator,
    operationId: operationId('committed-write')
  });
  assert.equal(recovered.message.id, 'commons-committed-write-0001');

  let missingReceiptWrites = 0;
  const missingReceiptRepository = createAgentCommonsRepository({
    filePath: path.join(root, 'missing-receipt.json'),
    createId: () => 'commons-missing-receipt-0001',
    writeStore: async (target, value, options) => {
      missingReceiptWrites += 1;
      if (missingReceiptWrites === 1) return writeJsonAtomic(target, value, options);
      const error = new Error('claimed commit without replacement');
      error.replacementCommitted = true;
      error.atomicWritePhase = 'parent_directory_sync';
      throw error;
    }
  });
  await assert.rejects(missingReceiptRepository.create({ body: 'No durable receipt exists.' }, {
    actor: operator,
    operationId: operationId('missing-receipt')
  }), /claimed commit without replacement/);

  let failedWrites = 0;
  const failedRepository = createAgentCommonsRepository({
    filePath: path.join(root, 'failed.json'),
    createId: () => 'commons-failed-write-0001',
    writeStore: async (target, value, options) => {
      failedWrites += 1;
      if (failedWrites === 1) return writeJsonAtomic(target, value, options);
      throw new Error('pre-commit write failed');
    }
  });
  await assert.rejects(failedRepository.create({ body: 'The mutation must fail.' }, {
    actor: operator,
    operationId: operationId('failed-write')
  }), /pre-commit write failed/);
});

test('the board stores human and agent threads without granting execution authority', async (t) => {
  const { repository } = await fixture(t);
  const created = await repository.create({
    category: 'question',
    attention: 'ping',
    audience: ['codex-alpha'],
    scope: '/work/alpha',
    body: 'Can Alpha confirm the release boundary?',
    evidence: 'Linked to the focused verification result.'
  }, { actor: operator, operationId: operationId('create-question') });
  assert.equal(created.message.author.kind, 'operator');
  assert.deepEqual(created.message.audience, { kind: 'sessions', sessions: ['codex-alpha'] });
  assert.equal(created.message.state, 'open');
  assert.deepEqual(created.message.transitions, ['resolved', 'withdrawn']);

  const replied = await repository.reply(created.message.id, {
    attention: 'board',
    body: 'Confirmed from the current checkout.',
    evidence: 'Focused check passed.'
  }, { actor: alpha, operationId: operationId('reply-question') });
  assert.equal(replied.message.threadId, created.message.id);
  assert.equal(replied.message.parentId, created.message.id);
  assert.equal(replied.message.author.session, 'codex-alpha');

  await assert.rejects(
    repository.reply(created.message.id, { body: 'Not addressed to Beta.' }, {
      actor: beta,
      operationId: operationId('reply-wrong-agent')
    }),
    /agent_commons_reply_not_addressed/
  );
  await assert.rejects(
    repository.acknowledge(created.message.id, {
      actor: beta,
      operationId: operationId('ack-wrong-agent')
    }),
    /agent_commons_acknowledgement_not_addressed/
  );

  const acknowledged = await repository.acknowledge(created.message.id, {
    actor: alpha,
    operationId: operationId('ack-question')
  });
  assert.equal(acknowledged.message.acknowledgements.length, 1);
  assert.equal(acknowledged.message.acknowledgements[0].actor.session, 'codex-alpha');

  const snapshot = await repository.snapshot();
  assert.equal(snapshot.counts.threads, 1);
  assert.equal(snapshot.counts.replies, 1);
  assert.equal(snapshot.counts.attention, 1);
  assert.deepEqual(snapshot.safety, {
    dataOnly: true,
    terminalInputAuthorized: false,
    serviceControlAuthorized: false,
    externalMutationAuthorized: false
  });
});

test('all collaboration categories, attention modes, scopes, and audience forms normalize strictly', async (t) => {
  const { repository } = await fixture(t);
  for (let index = 0; index < AGENT_COMMONS_CATEGORIES.length; index += 1) {
    const category = AGENT_COMMONS_CATEGORIES[index];
    const attention = AGENT_COMMONS_ATTENTION[index % AGENT_COMMONS_ATTENTION.length];
    const result = await repository.create({
      category,
      attention,
      audience: index % 2 ? 'codex-alpha' : 'all',
      scope: index % 2 ? '/work/alpha' : 'global',
      body: `${category} body`,
      evidence: category === 'claim' || category === 'lesson' ? 'bounded evidence' : '',
      independent: category === 'decision'
    }, { actor: index % 2 ? alpha : operator, operationId: operationId(`category-${index}`) });
    assert.equal(result.message.category, category);
    assert.equal(result.message.attention, attention);
    assert.equal(result.message.independent, category === 'decision');
  }

  await assert.rejects(
    repository.create({ category: 'command', body: 'no' }, { actor: operator, operationId: operationId('bad-category') }),
    /agent_commons_category_invalid/
  );
  await assert.rejects(
    repository.create({ attention: 'interrupt', body: 'no' }, { actor: operator, operationId: operationId('bad-attention') }),
    /agent_commons_attention_invalid/
  );
  await assert.rejects(
    repository.create({ body: `hidden\u0000text` }, { actor: operator, operationId: operationId('hidden-text') }),
    /agent_commons_body_invalid/
  );
  await assert.rejects(
    repository.create({ body: 'x'.repeat(6001) }, { actor: operator, operationId: operationId('long-body') }),
    /agent_commons_body_invalid/
  );
});

test('help requests reuse one compatible idle agent before offering one bounded helper', async (t) => {
  const { repository } = await fixture(t);
  const created = await repository.create({
    category: 'help_request',
    attention: 'ping',
    scope: '/work/alpha',
    body: 'A second agent should independently inspect the parser boundary.'
  }, { actor: alpha, operationId: operationId('help-request') });
  assert.equal(created.message.state, 'open');
  assert.deepEqual(created.message.transitions, ['resolved', 'withdrawn']);
  assert.deepEqual(agentCommonsHelperIdentity(created.message.id), {
    name: `commons-helper-${created.message.id.slice('commons-'.length)}`,
    session: `codex-commons-helper-${created.message.id.slice('commons-'.length)}`
  });

  const readyAgent = {
    session: 'codex-beta',
    displayName: 'Beta',
    currentPath: '/work/alpha',
    canSend: true,
    queueReady: true,
    agentStatus: { state: 'idle', tone: 'good' },
    lastInteractionAt: '2026-08-27T07:30:00.000Z'
  };
  const existing = agentCommonsHelpRecommendation(created.message, {
    agents: [
      { ...readyAgent, session: 'codex-alpha', displayName: 'Requester' },
      {
        ...readyAgent,
        session: 'codex-commons-helper-other-request',
        displayName: 'Already-bound helper',
        lastInteractionAt: '2026-08-27T07:00:00.000Z'
      },
      readyAgent
    ],
    workspace: '/work/alpha',
    resourceGate: { ok: true, availablePercent: 70, swapUsedPercent: 1, fullPressureAvg10: 0 },
    diskUsedPercent: 89,
    controlPlaneReady: true
  });
  assert.equal(existing.kind, 'existing');
  assert.equal(existing.candidate.session, 'codex-beta');
  assert.equal(existing.spawnAllowed, false);

  const spawn = agentCommonsHelpRecommendation(created.message, {
    agents: [readyAgent],
    busySessions: ['codex-beta'],
    workspace: '/work/alpha',
    resourceGate: { ok: true, availablePercent: 70, swapUsedPercent: 1, fullPressureAvg10: 0 },
    diskUsedPercent: 89,
    controlPlaneReady: true
  });
  assert.equal(spawn.kind, 'spawn');
  assert.equal(spawn.spawnAllowed, true);
  assert.equal(spawn.helper.workspace, '/work/alpha');
  assert.equal(agentCommonsHelpRecommendation(created.message, {
    agents: [readyAgent],
    resourceGate: { ok: true },
    diskUsedPercent: 89,
    controlPlaneReady: true
  }).kind, 'existing');
  assert.equal(agentCommonsHelpRecommendation(created.message, {
    agents: [],
    resourceGate: { ok: true },
    diskUsedPercent: 89,
    controlPlaneReady: true
  }).reason, 'workspace_required');

  const helperExists = agentCommonsHelpRecommendation(created.message, {
    agents: [{ ...readyAgent, session: spawn.helper.session, displayName: 'Bound helper', queueReady: false }],
    workspace: '/work/alpha',
    resourceGate: { ok: true },
    diskUsedPercent: 89,
    controlPlaneReady: true
  });
  assert.equal(helperExists.kind, 'helper_exists');
  assert.equal(helperExists.candidate.session, spawn.helper.session);
  assert.equal(agentCommonsHelpRecommendation(created.message, {
    workspace: '/work/alpha',
    resourceGate: { ok: true },
    diskUsedPercent: 90,
    controlPlaneReady: true
  }).reason, 'disk_gate');

  await repository.transition(created.message.id, 'resolved', {
    actor: operator,
    operationId: operationId('help-resolve')
  });
  const closed = (await repository.snapshot()).messages.find((message) => message.id === created.message.id);
  assert.equal(agentCommonsHelpRecommendation(closed, {
    workspace: '/work/alpha',
    resourceGate: { ok: true },
    controlPlaneReady: true
  }).kind, 'closed');
  assert.equal((await repository.snapshot()).counts.helpRequests, 0);
});

test('a Commons helper may report a need but can never qualify a recursive helper spawn', async (t) => {
  const { repository } = await fixture(t);
  const helperActor = {
    ...alpha,
    session: 'codex-commons-helper-recursive-0001',
    label: 'Bound helper'
  };
  const request = await repository.create({
    category: 'help_request',
    scope: '/work/alpha',
    body: 'The helper believes more review may be useful.'
  }, { actor: helperActor, operationId: operationId('recursive-help') });
  const recommendation = agentCommonsHelpRecommendation(request.message, {
    workspace: '/work/alpha',
    resourceGate: { ok: true, availablePercent: 70, swapUsedPercent: 0, fullPressureAvg10: 0 },
    diskUsedPercent: 20,
    controlPlaneReady: true
  });
  assert.equal(recommendation.kind, 'blocked');
  assert.equal(recommendation.reason, 'recursive_helper_spawn_forbidden');
  assert.equal(recommendation.spawnAllowed, false);
});

test('coordination and learning transitions remain reversible only where explicitly modeled', async (t) => {
  const { repository } = await fixture(t);
  const wait = await repository.create({
    category: 'wait',
    audience: ['codex-beta'],
    body: 'Waiting for Beta to finish the schema review.'
  }, { actor: alpha, operationId: operationId('create-wait') });
  const accepted = await repository.transition(wait.message.id, 'accepted', {
    actor: beta,
    operationId: operationId('accept-wait')
  });
  assert.equal(accepted.message.state, 'accepted');
  const satisfied = await repository.transition(wait.message.id, 'satisfied', {
    actor: beta,
    operationId: operationId('satisfy-wait')
  });
  assert.equal(satisfied.message.state, 'satisfied');
  await assert.rejects(
    repository.transition(wait.message.id, 'waiting', { actor: operator, operationId: operationId('reopen-wait') }),
    /agent_commons_transition_invalid/
  );

  const claim = await repository.create({
    category: 'work_claim',
    audience: 'all',
    body: 'Alpha is taking the CSS pass.'
  }, { actor: alpha, operationId: operationId('create-claim') });
  await assert.rejects(
    repository.transition(claim.message.id, 'completed', { actor: beta, operationId: operationId('steal-claim') }),
    /agent_commons_transition_forbidden/
  );
  assert.equal((await repository.transition(claim.message.id, 'released', {
    actor: alpha,
    operationId: operationId('release-claim')
  })).message.state, 'released');

  const lesson = await repository.create({
    category: 'lesson',
    body: 'Run the focused contract test before broad UI checks.',
    evidence: 'One successful Alpha outcome.',
    scope: '/work/alpha'
  }, { actor: alpha, operationId: operationId('create-lesson') });
  assert.equal((await repository.transition(lesson.message.id, 'tried', {
    actor: alpha,
    operationId: operationId('try-lesson')
  })).message.state, 'tried');
  await assert.rejects(
    repository.transition(lesson.message.id, 'supported', { actor: alpha, operationId: operationId('self-promote') }),
    /agent_commons_transition_forbidden/
  );
  assert.equal((await repository.transition(lesson.message.id, 'supported', {
    actor: operator,
    operationId: operationId('support-lesson')
  })).message.state, 'supported');
  assert.equal((await repository.transition(lesson.message.id, 'active', {
    actor: operator,
    operationId: operationId('activate-lesson')
  })).message.state, 'active');
});

test('a replacement lesson retires the scoped predecessor and keeps its provenance', async (t) => {
  const { repository } = await fixture(t);
  const oldLesson = await repository.create({
    category: 'lesson',
    scope: '/work/alpha',
    body: 'Always run every check first.'
  }, { actor: operator, operationId: operationId('old-lesson') });
  const replacement = await repository.create({
    category: 'lesson',
    scope: '/work/alpha',
    body: 'Run focused checks first, then the smallest complete suite.',
    evidence: 'The broad-first flow repeatedly exhausted resources.',
    supersedesId: oldLesson.message.id
  }, { actor: operator, operationId: operationId('new-lesson') });
  assert.equal(replacement.message.supersedesId, oldLesson.message.id);
  const snapshot = await repository.snapshot();
  assert.equal(snapshot.messages.find((message) => message.id === oldLesson.message.id).state, 'retired');
  assert.equal(snapshot.messages.find((message) => message.id === replacement.message.id).state, 'candidate');

  await assert.rejects(
    repository.create({
      category: 'lesson', body: 'Bad chain', supersedesId: oldLesson.message.id
    }, { actor: operator, operationId: operationId('replace-retired') }),
    /agent_commons_supersession_invalid/
  );
});

test('independent-first decisions hide peer replies until the viewing agent contributes', async (t) => {
  const { repository } = await fixture(t);
  const decision = await repository.create({
    category: 'decision',
    audience: ['codex-alpha', 'codex-beta'],
    body: 'Which storage boundary is safer?',
    independent: true
  }, { actor: operator, operationId: operationId('decision') });
  const betaReply = await repository.reply(decision.message.id, { body: 'Beta prefers an append-only spool.' }, {
    actor: beta,
    operationId: operationId('beta-first')
  });
  let snapshot = await repository.snapshot();
  assert.deepEqual(
    agentCommonsInbox(snapshot, { session: 'codex-alpha' }).map((message) => message.id),
    [decision.message.id]
  );
  assert.deepEqual(
    agentCommonsInbox(snapshot, { session: 'codex-beta' }).map((message) => message.id),
    [decision.message.id, betaReply.message.id]
  );

  const alphaReply = await repository.reply(decision.message.id, { body: 'Alpha prefers atomic central writes.' }, {
    actor: alpha,
    operationId: operationId('alpha-first')
  });
  snapshot = await repository.snapshot();
  assert.deepEqual(
    agentCommonsInbox(snapshot, { session: 'codex-alpha' }).map((message) => message.id),
    [decision.message.id, betaReply.message.id, alphaReply.message.id]
  );
  assert.equal(agentCommonsInbox(snapshot, { session: 'codex-other', scope: '/other' }).length, 0);
  assert.throws(() => agentCommonsInbox(snapshot, { session: 'bad session' }), /viewer_session_invalid/);
  assert.throws(() => agentCommonsInbox(snapshot, { session: 'codex-alpha', limit: 0 }), /inbox_limit_invalid/);
});

test('operations are serialized and replayed idempotently', async (t) => {
  const { repository } = await fixture(t);
  const request = { body: 'Only one copy should exist.' };
  const id = operationId('idempotent');
  const [first, second] = await Promise.all([
    repository.create(request, { actor: operator, operationId: id }),
    repository.create(request, { actor: operator, operationId: id })
  ]);
  assert.equal(first.message.id, second.message.id);
  assert.deepEqual(new Set([first.replayed, second.replayed]), new Set([false, true]));
  assert.equal((await repository.snapshot()).messages.length, 1);

  await assert.rejects(
    repository.acknowledge(first.message.id, { actor: operator, operationId: id }),
    /agent_commons_operation_conflict/
  );
  await assert.rejects(
    repository.create({ body: 'A changed request must not inherit the old receipt.' }, {
      actor: operator,
      operationId: id
    }),
    /agent_commons_operation_conflict/
  );
});

test('attention counts include urgent replies and close when their request is resolved', async (t) => {
  const { repository } = await fixture(t);
  const root = await repository.create({
    category: 'question',
    attention: 'checkpoint',
    body: 'Can this wait until the next safe checkpoint?'
  }, { actor: operator, operationId: operationId('attention-root') });
  const reply = await repository.reply(root.message.id, {
    attention: 'stop',
    body: 'Continuing may target the wrong environment; please review now.'
  }, { actor: alpha, operationId: operationId('attention-reply') });

  assert.deepEqual((await repository.snapshot()).counts, {
    threads: 1,
    replies: 1,
    attention: 2,
    stop: 1,
    coordination: 0,
    helpRequests: 0,
    lessons: 0
  });
  await repository.transition(root.message.id, 'resolved', {
    actor: operator,
    operationId: operationId('resolve-root')
  });
  let snapshot = await repository.snapshot();
  assert.equal(snapshot.counts.attention, 1);
  assert.deepEqual(
    agentCommonsInbox(snapshot, { session: 'codex-alpha' }).map((message) => message.id),
    [root.message.id, reply.message.id]
  );
  await repository.transition(reply.message.id, 'resolved', {
    actor: operator,
    operationId: operationId('resolve-reply')
  });
  snapshot = await repository.snapshot();
  assert.equal(snapshot.counts.attention, 0);
  assert.deepEqual(agentCommonsInbox(snapshot, { session: 'codex-alpha' }), []);
  assert.deepEqual(
    agentCommonsInbox(snapshot, { session: 'codex-alpha', includeResolved: true }).map((message) => message.id),
    [root.message.id, reply.message.id]
  );
});

test('spool envelopes are bounded, exact, and normalize agent provenance', async (t) => {
  const { root } = await fixture(t);
  const envelopePath = path.join(root, 'envelope.json');
  const envelope = {
    version: 1,
    operationId: operationId('spool-create'),
    action: 'message.create',
    actor: alpha,
    payload: { category: 'update', body: 'Posted from Alpha.' },
    createdAt: '2026-08-27T08:00:00.000Z'
  };
  await writeFile(envelopePath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  const result = await readAgentCommonsSpoolEnvelope(envelopePath);
  assert.equal(result.actor.session, 'codex-alpha');
  assert.equal(result.payload.body, 'Posted from Alpha.');

  await chmod(envelopePath, 0o644);
  const extra = { ...envelope, unexpected: true };
  await writeFile(envelopePath, JSON.stringify(extra));
  await assert.rejects(readAgentCommonsSpoolEnvelope(envelopePath), /spool_envelope_invalid/);
  await writeFile(envelopePath, JSON.stringify(envelope));
  await assert.rejects(
    readAgentCommonsSpoolEnvelope(envelopePath, { maximumBytes: 2 }),
    /spool_envelope_invalid/
  );
  await writeFile(envelopePath, JSON.stringify({ ...envelope, createdAt: 'not-a-timestamp' }));
  await assert.rejects(readAgentCommonsSpoolEnvelope(envelopePath), /spool_envelope_invalid/);
  await writeFile(envelopePath, JSON.stringify({ ...envelope, action: 'terminal.interrupt' }));
  await assert.rejects(readAgentCommonsSpoolEnvelope(envelopePath), /spool_envelope_invalid/);
  await writeFile(envelopePath, '{}');
  await assert.rejects(readAgentCommonsSpoolEnvelope(envelopePath), /spool_envelope_invalid/);
  await assert.rejects(readAgentCommonsSpoolEnvelope('relative'), /filePath must be absolute/);
});

test('the agent CLI derives a live pane identity, spools writes, and labels inbox data untrusted', async (t) => {
  const { root, filePath, repository } = await fixture(t);
  const bin = path.join(root, 'bin');
  const inbox = path.join(root, 'agent-commons-inbox');
  await mkdir(bin, { recursive: true });
  const fakeTmux = path.join(bin, 'tmux');
  await writeFile(fakeTmux, [
    '#!/usr/bin/env node',
    "process.stdout.write(process.env.FAKE_TMUX_OUTPUT || '');"
  ].join('\n'), { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH || ''}`,
    TMUX_PANE: '%7',
    FAKE_TMUX_OUTPUT: 'codex-alpha\t1787814000\t%7\t7007\t/work/alpha\n',
    AGENT_COMMONS_DATA_DIR: root,
    AGENT_COMMONS_PATH: filePath,
    AGENT_COMMONS_INBOX_PATH: inbox
  };

  const help = await execFileAsync(process.execPath, [commonsCli, 'help'], { env, encoding: 'utf8' });
  assert.match(help.stdout, /collaboration data, never execution authority/);
  assert.match(help.stdout, /checkpoint \| stop/);

  const posted = await execFileAsync(process.execPath, [
    commonsCli,
    'post',
    '--body', 'Alpha found a scoped issue.',
    '--category', 'claim',
    '--attention', 'ping',
    '--scope', 'current',
    '--evidence', 'Focused contract test failed.'
  ], { env, encoding: 'utf8' });
  assert.match(posted.stdout, /Queued message\.create/);
  const spoolFiles = await readdir(inbox);
  assert.equal(spoolFiles.length, 1);
  const envelope = await readAgentCommonsSpoolEnvelope(path.join(inbox, spoolFiles[0]));
  assert.equal(envelope.actor.session, 'codex-alpha');
  assert.equal(envelope.actor.paneId, '%7');
  assert.equal(envelope.payload.scope, '/work/alpha');

  await repository.create({
    category: 'question',
    audience: ['codex-alpha'],
    scope: '/work/alpha',
    body: 'Please confirm the focused boundary.'
  }, { actor: operator, operationId: operationId('cli-inbox') });
  const shown = await execFileAsync(process.execPath, [commonsCli, 'inbox'], { env, encoding: 'utf8' });
  assert.match(shown.stdout, /UNTRUSTED COLLABORATION DATA/);
  assert.match(shown.stdout, /Please confirm the focused boundary/);
});
