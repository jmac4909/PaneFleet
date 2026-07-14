import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentCreateOutcome, agentDraftSignature } from '../public/ui-state.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function result(overrides = {}) {
  return {
    ok: true,
    session: 'codex-sample-project',
    model: 'gpt-5',
    reasoning: 'high',
    promptSent: false,
    promptState: 'not_requested',
    promptError: null,
    ...overrides
  };
}

function functionSource(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] !== '}') continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated ${signature}`);
}

test('New Agent clears its draft only when no prompt was requested or prompt acceptance was confirmed', () => {
  const withoutPrompt = agentCreateOutcome(result(), false);
  assert.equal(withoutPrompt.accepted, true);
  assert.equal(withoutPrompt.preserveDraft, false);
  assert.match(withoutPrompt.notice, /started codex-sample-project/i);
  assert.match(withoutPrompt.tone, /^(info|success)$/);

  const acceptedPrompt = agentCreateOutcome(result({ promptSent: true, promptState: 'accepted' }), true);
  assert.equal(acceptedPrompt.accepted, true);
  assert.equal(acceptedPrompt.preserveDraft, false);
  assert.match(acceptedPrompt.notice, /started codex-sample-project/i);
  assert.match(acceptedPrompt.tone, /^(info|success)$/);
});

test('New Agent preserves the launcher draft and gives distinct review warnings for uncertain prompt delivery', () => {
  const typed = agentCreateOutcome(result({ promptState: 'typed_not_submitted' }), true);
  assert.equal(typed.accepted, false);
  assert.equal(typed.preserveDraft, true);
  assert.equal(typed.tone, 'warning');
  assert.match(typed.notice, /prompt/i);
  assert.match(typed.notice, /typed|not submitted/i);
  assert.match(typed.notice, /open[^.]*terminal|review/i);

  const unknown = agentCreateOutcome(result({ promptState: 'outcome_unknown' }), true);
  assert.equal(unknown.accepted, false);
  assert.equal(unknown.preserveDraft, true);
  assert.equal(unknown.tone, 'warning');
  assert.match(unknown.notice, /prompt/i);
  assert.match(unknown.notice, /confirm|unknown/i);
  assert.match(unknown.notice, /open[^.]*terminal|review/i);
  assert.notEqual(unknown.notice, typed.notice);
});

test('launcher draft signatures detect edits made while a slow agent start is pending', () => {
  const submitted = { name: 'sample-project', workspace: '/projects/sample-project', prompt: 'First prompt' };
  assert.equal(agentDraftSignature({ ...submitted }), agentDraftSignature({ ...submitted, open: true }));
  assert.notEqual(agentDraftSignature(submitted), agentDraftSignature({ ...submitted, prompt: 'Newer prompt' }));
});

test('New Agent result handling records and reloads the session but resets only outside preserve-draft outcomes', async () => {
  const source = await readFile(path.join(root, 'public', 'app.js'), 'utf8');
  const createAgent = functionSource(source, 'async function createAgent(form)');

  assert.match(source, /import\s*\{[^}]*agentCreateOutcome[^}]*\}\s*from\s*['"]\.\/ui-state\.js['"]/s);
  assert.match(createAgent, /agentCreateOutcome\(result,\s*Boolean\(prompt\.trim\(\)\)\)/);
  assert.match(createAgent, /timeoutMs:\s*45000/);
  assert.equal((createAgent.match(/api\('\/api\/agent\/create'/g) || []).length, 1);

  const interaction = createAgent.indexOf('markAgentInteraction(result.session');
  const recent = createAgent.indexOf('state.recentAgentSession = result.session');
  const submittedSignature = createAgent.indexOf('const submittedDraftSignature = agentDraftSignature(state.agentDraft)');
  const changedCheck = createAgent.indexOf('const draftChangedWhileStarting = agentDraftSignature(state.agentDraft) !== submittedDraftSignature');
  const branch = createAgent.indexOf('if (!preserveDraft) {');
  const reset = createAgent.indexOf('form.reset()', branch);
  const clearDraft = createAgent.indexOf("state.agentDraft = { open: false", reset);
  const notice = createAgent.indexOf('setNotice(notice, outcome.tone)');
  const reload = createAgent.indexOf("await loadSnapshot('manual')");

  assert.ok(interaction >= 0, 'created session interaction must still be recorded');
  assert.ok(submittedSignature >= 0 && submittedSignature < interaction, 'the submitted draft must be versioned before the request');
  assert.ok(recent > interaction, 'created session must remain the recent session');
  assert.ok(changedCheck > recent && branch > changedCheck, 'late launcher edits must be detected before reset');
  assert.ok(reset > branch, 'form reset must be guarded by the preserve-draft policy');
  assert.ok(clearDraft > reset && clearDraft < notice, 'closing the launcher draft must be guarded with the form reset');
  assert.ok(notice > clearDraft, 'the outcome-specific success or warning notice must be shown');
  assert.ok(reload > notice, 'the created session must still be loaded after either outcome');

  const preserveBranch = createAgent.slice(branch, reset);
  assert.doesNotMatch(preserveBranch, /api\(/, 'uncertain outcomes must never trigger an automatic resend');
});
