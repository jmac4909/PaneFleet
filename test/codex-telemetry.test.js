import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  codexUsageStats,
  codexRolloutForPid,
  createCodexUsageStore,
  latestCodexAccountTelemetry,
  parseCodexRolloutLineageText,
  parseCodexTelemetryText,
  readCodexDeliveryResult,
  readCodexLatestFinalResponse,
  readCodexRolloutLineage,
  readCodexUsageEventBatch,
  readCodexTelemetryFile,
  readCodexTelemetryForPids,
  rebuildCodexUsageStoreFromEvents,
  reconcileCodexUsageEventBatches,
  reconcileCodexUsageStore,
  resolveCodexRolloutPaths,
  validateCodexUsageStore
} from '../codex-telemetry.js';

function jsonl(events) {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

function turn(timestamp, overrides = {}) {
  return {
    timestamp,
    type: 'turn_context',
    payload: {
      model: 'gpt-test',
      effort: 'high',
      approval_policy: 'never',
      sandbox_policy: { type: 'workspace-write' },
      ...overrides
    }
  };
}

function token(timestamp, overrides = {}) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 600,
          output_tokens: 80,
          reasoning_output_tokens: 30,
          total_tokens: 1080
        },
        last_token_usage: {
          input_tokens: 400,
          cached_input_tokens: 200,
          output_tokens: 40,
          reasoning_output_tokens: 10,
          total_tokens: 440
        },
        model_context_window: 1000
      },
      rate_limits: {
        limit_id: 'codex',
        limit_name: null,
        plan_type: 'pro',
        primary: { used_percent: 12, window_minutes: 10080, resets_at: 1_800_000_000 },
        secondary: null,
        credits: { has_credits: true, unlimited: false, balance: '25' },
        rate_limit_reached_type: null
      },
      ...overrides
    }
  };
}

function task(timestamp, type) {
  return { timestamp, type: 'event_msg', payload: { type } };
}

test('rollout lineage accepts only root interactive sessions and rejects parented sub-agents', async () => {
  const rootMetadata = JSON.stringify({
    type: 'session_meta',
    payload: { id: '11111111-2222-3333-4444-555555555555', source: 'cli' }
  });
  const childMetadata = JSON.stringify({
    type: 'session_meta',
    payload: {
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      source: { subagent: { role: 'worker' } },
      parent_thread_id: '11111111-2222-3333-4444-555555555555'
    }
  });
  assert.deepEqual(parseCodexRolloutLineageText(rootMetadata), {
    rootInteractive: true,
    subagent: false,
    parented: false
  });
  assert.deepEqual(parseCodexRolloutLineageText(childMetadata), {
    rootInteractive: false,
    subagent: true,
    parented: true
  });
  assert.equal(parseCodexRolloutLineageText('{bad json'), null);

  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-rollout-lineage-'));
  const file = path.join(directory, 'rollout.jsonl');
  try {
    await writeFile(file, `${childMetadata}\n${'x'.repeat(300_000)}\n`);
    assert.deepEqual(await readCodexRolloutLineage(file), {
      rootInteractive: false,
      subagent: true,
      parented: true
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function response(timestamp, role, text, phase) {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      ...(phase ? { phase } : {}),
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }]
    }
  };
}

test('parses the latest Codex status and usage metadata without transcript content', () => {
  const result = parseCodexTelemetryText([
    '{partial-json',
    JSON.stringify(turn('2026-07-18T10:00:00.000Z', { model: 'old-model' })),
    JSON.stringify(token('2026-07-18T10:01:00.000Z')),
    JSON.stringify(turn('2026-07-18T10:02:00.000Z', {
      model: 'gpt-new\u0000',
      effort: '',
      collaboration_mode: { settings: { reasoning_effort: 'xhigh' } },
      sandbox_policy: 'danger-full-access'
    })),
    JSON.stringify(token('2026-07-18T10:03:00.000Z', {
      info: {
        total_token_usage: { input_tokens: 2000, cached_input_tokens: 1000, output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 2200 },
        last_token_usage: { input_tokens: 700, cached_input_tokens: 500, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 750 },
        model_context_window: 1000
      }
    }))
  ].join('\n'));

  assert.equal(result.source, 'codex-session-log');
  assert.equal(result.observedAt, '2026-07-18T10:03:00.000Z');
  assert.equal(result.model, 'gpt-new');
  assert.equal(result.effort, 'xhigh');
  assert.equal(result.approvalPolicy, 'never');
  assert.equal(result.sandbox, 'danger-full-access');
  assert.deepEqual(result.context, {
    scope: 'session',
    usedTokens: 750,
    windowTokens: 1000,
    remainingTokens: 250,
    usedPercent: 75,
    remainingPercent: 25
  });
  assert.equal(result.sessionTokens.totalTokens, 2200);
  assert.equal(result.lastTurnTokens.outputTokens, 50);
  assert.equal(result.account.planType, 'pro');
  assert.equal(result.account.primary.usedPercent, 12);
  assert.equal(result.account.primary.windowMinutes, 10080);
  assert.equal(result.account.primary.resetsAt, '2027-01-15T08:00:00.000Z');
  assert.deepEqual(result.account.credits, { hasCredits: true, unlimited: false, balance: '25' });
  assert.equal(result.turnState, 'unknown');
});

test('tracks only privacy-safe Codex turn boundaries for crash recovery', () => {
  const active = parseCodexTelemetryText(jsonl([
    turn('2026-07-18T10:00:00.000Z'),
    task('2026-07-18T10:00:01.000Z', 'task_started'),
    token('2026-07-18T10:00:02.000Z')
  ]));
  assert.equal(active.turnState, 'active');

  const idle = parseCodexTelemetryText(jsonl([
    turn('2026-07-18T10:00:00.000Z'),
    task('2026-07-18T10:00:01.000Z', 'task_started'),
    task('2026-07-18T10:00:02.000Z', 'task_complete')
  ]));
  assert.equal(idle.turnState, 'idle');

  const interrupted = parseCodexTelemetryText(jsonl([
    turn('2026-07-18T10:00:00.000Z'),
    task('2026-07-18T10:00:01.000Z', 'task_complete'),
    task('2026-07-18T10:00:02.000Z', 'task_started')
  ]));
  assert.equal(interrupted.turnState, 'active');
  assert.doesNotMatch(JSON.stringify(interrupted), /prompt|response|message/i);
});

test('handles missing, malformed, and bounded telemetry fields safely', () => {
  assert.equal(parseCodexTelemetryText(''), null);
  assert.equal(parseCodexTelemetryText('{bad}\n{"type":"response_item"}\n'), null);

  const result = parseCodexTelemetryText(jsonl([
    turn('invalid', { model: 'x'.repeat(200), approval_policy: null, sandbox_policy: [] }),
    token('invalid', {
      info: {
        total_token_usage: null,
        last_token_usage: { total_tokens: -4 },
        model_context_window: 0
      },
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: 140, window_minutes: -1, resets_at: 'bad' },
        secondary: { used_percent: 5, window_minutes: 300, resets_at: 0 },
        credits: [],
        rate_limit_reached_type: 'weekly'
      }
    })
  ]));

  assert.equal(result.observedAt, null);
  assert.equal(result.model.length, 120);
  assert.equal(result.sandbox, '');
  assert.equal(result.context, null);
  assert.equal(result.sessionTokens, null);
  assert.equal(result.lastTurnTokens.totalTokens, 0);
  assert.equal(result.account.primary.usedPercent, 100);
  assert.equal(result.account.primary.windowMinutes, 0);
  assert.equal(result.account.primary.resetsAt, null);
  assert.equal(result.account.secondary.resetsAt, null);
  assert.equal(result.account.credits, null);
  assert.equal(result.account.reachedType, 'weekly');
});

test('token telemetry canonicalizes impossible subsets and ignores inconsistent reported totals', () => {
  const result = parseCodexTelemetryText(jsonl([token('2026-07-18T10:03:00.000Z', {
    info: {
      total_token_usage: { input_tokens: 100, cached_input_tokens: 140, output_tokens: 20, reasoning_output_tokens: 30, total_tokens: 999 },
      last_token_usage: { input_tokens: 10.5, cached_input_tokens: 8, output_tokens: 5, reasoning_output_tokens: 7, total_tokens: 500 },
      model_context_window: 1000
    }
  })]));

  assert.deepEqual(result.sessionTokens, {
    inputTokens: 100,
    cachedInputTokens: 100,
    outputTokens: 20,
    reasoningOutputTokens: 20,
    totalTokens: 120
  });
  assert.deepEqual(result.lastTurnTokens, {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 5,
    reasoningOutputTokens: 5,
    totalTokens: 5
  });
  assert.equal(result.context.usedTokens, 5);
});

test('reads a marker-bound final answer forward from an exact persisted rollout offset', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-delivery-result-'));
  const file = path.join(directory, 'rollout.jsonl');
  const marker = '[PaneFleet Dispatch attempt-12345678]';
  const prefix = jsonl([
    response('2026-07-18T09:59:00.000Z', 'user', 'unrelated earlier turn'),
    response('2026-07-18T09:59:01.000Z', 'assistant', 'earlier answer', 'final_answer')
  ]);
  try {
    await writeFile(file, prefix);
    const startOffset = Buffer.byteLength(prefix);
    await appendFile(file, jsonl([
      response('2026-07-18T10:00:00.000Z', 'user', `Do the governed work\n${marker}`),
      turn('2026-07-18T10:00:01.000Z', {
        sandbox_policy: { type: 'workspace-write', network_access: false }
      }),
      response('2026-07-18T10:00:02.000Z', 'assistant', 'working', 'commentary'),
      response('2026-07-18T10:00:03.000Z', 'assistant', 'STATUS: complete', 'final_answer')
    ]));

    const details = await stat(file);
    const result = await readCodexDeliveryResult(file, {
      confirmationMarker: marker,
      submittedAt: '2026-07-18T09:59:59.000Z',
      startOffset
    });
    assert.deepEqual(result, {
      text: 'STATUS: complete',
      at: '2026-07-18T10:00:03.000Z',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      networkAccess: false,
      networkAccessObserved: true,
      authority: {
        promptAt: '2026-07-18T10:00:00.000Z',
        contextAt: '2026-07-18T10:00:01.000Z',
        sandboxObserved: true,
        approvalPolicyObserved: true,
        networkAccessObserved: true,
        startOffset,
        endOffset: details.size,
        skippedPartialRecord: false
      }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reads only the latest bounded final response from a rollout tail', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-latest-response-'));
  const file = path.join(directory, 'rollout.jsonl');
  try {
    await writeFile(file, `${'x'.repeat(1400)}\n${jsonl([
      response('2026-07-18T10:00:00.000Z', 'assistant', 'older final', 'final_answer'),
      response('2026-07-18T10:00:01.000Z', 'assistant', 'working detail', 'commentary'),
      response('invalid', 'assistant', 'invalid timestamp', 'final_answer'),
      response('2026-07-18T10:00:02.000Z', 'assistant', 'latest\u0000 final', 'final_answer')
    ])}`);

    assert.deepEqual(await readCodexLatestFinalResponse(file, { maximumBytes: 1024 }), {
      text: 'latest final',
      at: '2026-07-18T10:00:02.000Z',
      truncated: false
    });
    assert.equal(await readCodexLatestFinalResponse('relative.jsonl'), null);
    assert.equal(await readCodexLatestFinalResponse(directory), null);

    await writeFile(file, jsonl([
      response('2026-07-18T10:01:00.000Z', 'assistant', 'z'.repeat(1400), 'final_answer')
    ]));
    const truncated = await readCodexLatestFinalResponse(file, { maximumCharacters: 1024 });
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.text.startsWith('z'.repeat(1024)), true);
    assert.match(truncated.text, /\[Response truncated by PaneFleet\]$/);

    await writeFile(file, jsonl([response('2026-07-18T10:02:00.000Z', 'assistant', 'not final', 'commentary')]));
    assert.equal(await readCodexLatestFinalResponse(file), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a final answer after any superseding user turn or marker replay', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-delivery-superseded-'));
  const file = path.join(directory, 'rollout.jsonl');
  const marker = '[PaneFleet Dispatch attempt-abcdefgh]';
  try {
    await writeFile(file, jsonl([
      response('2026-07-18T10:00:00.000Z', 'user', marker),
      turn('2026-07-18T10:00:01.000Z', { sandbox_policy: { type: 'workspace-write', network_access: false } }),
      response('2026-07-18T10:00:02.000Z', 'assistant', 'first final', 'final_answer'),
      response('2026-07-18T10:00:03.000Z', 'user', 'a later instruction'),
      response('2026-07-18T10:00:04.000Z', 'assistant', 'superseded final', 'final_answer')
    ]));
    assert.equal(await readCodexDeliveryResult(file, {
      confirmationMarker: marker,
      submittedAt: '2026-07-18T09:59:59.000Z',
      startOffset: 0
    }), null);

    await writeFile(file, jsonl([
      response('2026-07-18T10:00:00.000Z', 'user', marker),
      response('2026-07-18T10:00:01.000Z', 'user', `replayed ${marker}`),
      turn('2026-07-18T10:00:02.000Z', { sandbox_policy: { type: 'workspace-write', network_access: false } }),
      response('2026-07-18T10:00:03.000Z', 'assistant', 'ambiguous final', 'final_answer')
    ]));
    assert.equal(await readCodexDeliveryResult(file, {
      confirmationMarker: marker,
      submittedAt: '2026-07-18T09:59:59.000Z',
      startOffset: 0
    }), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails closed at timestamp and byte cutoffs and reports bounded read failures explicitly', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-delivery-cutoff-'));
  const file = path.join(directory, 'rollout.jsonl');
  const marker = '[PaneFleet Dispatch attempt-cutoff88]';
  const prompt = jsonl([response('2026-07-18T10:00:00.000Z', 'user', marker)]);
  const rest = jsonl([
    turn('2026-07-18T10:00:01.000Z', { sandbox_policy: { type: 'workspace-write', network_access: false } }),
    response('2026-07-18T10:00:02.000Z', 'assistant', 'not authorized', 'final_answer')
  ]);
  try {
    await writeFile(file, `${prompt}${rest}`);
    assert.equal(await readCodexDeliveryResult(file, {
      confirmationMarker: marker,
      submittedAt: '2026-07-18T10:00:00.500Z',
      startOffset: 0
    }), null);
    assert.equal(await readCodexDeliveryResult(file, {
      confirmationMarker: marker,
      submittedAt: '2026-07-18T09:59:59.000Z',
      startOffset: Buffer.byteLength(prompt)
    }), null);

    await assert.rejects(
      readCodexDeliveryResult(file, {
        confirmationMarker: marker,
        submittedAt: '2026-07-18T09:59:59.000Z',
        startOffset: 0,
        maximumBytes: 16
      }),
      (error) => error?.code === 'codex_delivery_result_window_exceeded'
        && error.startOffset === 0
        && error.endOffset === Buffer.byteLength(`${prompt}${rest}`)
        && error.maximumBytes === 16
    );
    await assert.rejects(
      readCodexDeliveryResult(file, {
        confirmationMarker: marker,
        submittedAt: '2026-07-18T09:59:59.000Z',
        maximumBytes: 16
      }),
      { code: 'codex_delivery_result_window_exceeded' }
    );
    await assert.rejects(
      readCodexDeliveryResult(file, {
        confirmationMarker: marker,
        submittedAt: '2026-07-18T09:59:59.000Z',
        startOffset: Buffer.byteLength(`${prompt}${rest}`) + 1
      }),
      { code: 'codex_delivery_result_offset_past_end' }
    );
    await assert.rejects(
      readCodexDeliveryResult(file, {
        confirmationMarker: marker,
        submittedAt: '2026-07-18T09:59:59.000Z',
        startOffset: -1
      }),
      { code: 'codex_delivery_result_offset_invalid' }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discards a partial first JSONL record at the persisted byte boundary', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-delivery-partial-'));
  const file = path.join(directory, 'rollout.jsonl');
  const marker = '[PaneFleet Dispatch attempt-partial8]';
  const partialPrefix = '{"timestamp":"2026-07-18T09:59:00.000Z","type":"response_item","payload":';
  try {
    await writeFile(file, partialPrefix);
    const startOffset = Buffer.byteLength(partialPrefix);
    await appendFile(file, `${JSON.stringify({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `untrusted ${marker}` }]
    })}}\n${jsonl([
      response('2026-07-18T10:00:00.000Z', 'user', marker),
      turn('2026-07-18T10:00:01.000Z', { sandbox_policy: { type: 'workspace-write', network_access: false } }),
      response('2026-07-18T10:00:02.000Z', 'assistant', 'trusted final', 'final_answer')
    ])}`);

    const result = await readCodexDeliveryResult(file, {
      confirmationMarker: marker,
      submittedAt: '2026-07-18T09:59:59.000Z',
      startOffset
    });
    assert.equal(result.text, 'trusted final');
    assert.equal(result.authority.skippedPartialRecord, true);
    assert.equal(result.authority.startOffset, startOffset);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('exposes absent network authority without treating omission as network denied', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-delivery-authority-'));
  const file = path.join(directory, 'rollout.jsonl');
  const marker = '[PaneFleet Dispatch attempt-authority8]';
  try {
    await writeFile(file, jsonl([
      response('2026-07-18T10:00:00.000Z', 'user', marker),
      turn('2026-07-18T10:00:01.000Z', { sandbox_policy: { type: 'workspace-write' } }),
      response('2026-07-18T10:00:02.000Z', 'assistant', 'final without network evidence', 'final_answer')
    ]));
    const result = await readCodexDeliveryResult(file, {
      confirmationMarker: marker,
      submittedAt: '2026-07-18T09:59:59.000Z',
      startOffset: 0
    });
    assert.equal(result.networkAccess, null);
    assert.equal(result.networkAccessObserved, false);
    assert.equal(result.authority.networkAccessObserved, false);

    const absent = parseCodexTelemetryText(jsonl([turn('2026-07-18T10:00:01.000Z')]));
    const denied = parseCodexTelemetryText(jsonl([turn('2026-07-18T10:00:01.000Z', {
      sandbox_policy: { type: 'workspace-write', network_access: false }
    })]));
    assert.equal(absent.networkAccess, null);
    assert.equal(absent.networkAccessObserved, false);
    assert.equal(denied.networkAccess, false);
    assert.equal(denied.networkAccessObserved, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reads only a bounded JSONL tail and caches an unchanged file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-telemetry-tail-'));
  const file = path.join(directory, 'rollout.jsonl');
  try {
    await writeFile(file, `${'x'.repeat(5000)}\n${jsonl([turn('2026-07-18T11:00:00.000Z'), token('2026-07-18T11:01:00.000Z')])}`);
    const first = await readCodexTelemetryFile(file, { maximumBytes: 4096 });
    const second = await readCodexTelemetryFile(file, { maximumBytes: 4096 });
    assert.equal(first.model, 'gpt-test');
    assert.equal(first.context.usedPercent, 44);
    assert.strictEqual(second, first);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('maps an exact Codex pid to an open rollout under the allowed sessions root', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-telemetry-proc-'));
  const sessionsRoot = path.join(directory, 'sessions');
  const procRoot = path.join(directory, 'proc');
  const rollout = path.join(sessionsRoot, '2026', '07', '18', 'rollout.jsonl');
  const resumedRollout = path.join(sessionsRoot, '2026', '07', '19', 'resumed-rollout.jsonl');
  const childRollout = path.join(sessionsRoot, '2026', '07', '20', 'child-rollout.jsonl');
  const unreadableRollout = path.join(sessionsRoot, '2026', '07', '18', 'unreadable.jsonl');
  const outside = path.join(directory, 'outside.jsonl');
  try {
    await mkdir(path.dirname(rollout), { recursive: true });
    await mkdir(unreadableRollout);
    await mkdir(path.join(procRoot, '123', 'fd'), { recursive: true });
    await mkdir(path.join(procRoot, '456', 'fd'), { recursive: true });
    await mkdir(path.join(procRoot, '789', 'fd'), { recursive: true });
    await mkdir(path.join(procRoot, '790', 'fd'), { recursive: true });
    await writeFile(rollout, jsonl([
      {
        timestamp: '2026-07-18T11:59:59.000Z',
        type: 'session_meta',
        payload: { id: '11111111-2222-3333-4444-555555555555', source: 'cli' }
      },
      turn('2026-07-18T12:00:00.000Z'),
      token('2026-07-18T12:01:00.000Z')
    ]));
    await mkdir(path.dirname(resumedRollout), { recursive: true });
    await writeFile(resumedRollout, jsonl([
      {
        timestamp: '2026-07-19T11:59:59.000Z',
        type: 'session_meta',
        payload: { id: '66666666-7777-8888-9999-000000000000', source: 'cli' }
      },
      turn('2026-07-19T12:00:00.000Z', { model: 'gpt-resumed' }),
      token('2026-07-19T12:01:00.000Z')
    ]));
    await mkdir(path.dirname(childRollout), { recursive: true });
    await writeFile(childRollout, jsonl([
      {
        timestamp: '2026-07-20T11:59:59.000Z',
        type: 'session_meta',
        payload: {
          id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          source: { subagent: { role: 'worker' } },
          parent_thread_id: '66666666-7777-8888-9999-000000000000'
        }
      },
      turn('2026-07-20T12:00:00.000Z', { model: 'gpt-child' }),
      token('2026-07-20T12:01:00.000Z')
    ]));
    await utimes(rollout, new Date('2026-07-18T12:02:00.000Z'), new Date('2026-07-18T12:02:00.000Z'));
    await utimes(resumedRollout, new Date('2026-07-19T12:02:00.000Z'), new Date('2026-07-19T12:02:00.000Z'));
    await utimes(childRollout, new Date('2026-07-20T12:02:00.000Z'), new Date('2026-07-20T12:02:00.000Z'));
    await writeFile(outside, jsonl([turn('2026-07-18T13:00:00.000Z')]));
    await symlink(path.join(directory, 'vanished.jsonl'), path.join(procRoot, '123', 'fd', '0'));
    await symlink(outside, path.join(procRoot, '123', 'fd', '1'));
    await symlink(rollout, path.join(procRoot, '123', 'fd', '2'));
    await symlink(resumedRollout, path.join(procRoot, '123', 'fd', '3'));
    await symlink(childRollout, path.join(procRoot, '123', 'fd', '4'));
    await symlink(outside, path.join(procRoot, '456', 'fd', '1'));
    await symlink(unreadableRollout, path.join(procRoot, '789', 'fd', '1'));
    await symlink(childRollout, path.join(procRoot, '790', 'fd', '1'));

    assert.equal(await codexRolloutForPid(0, { sessionsRoot, procRoot }), null);
    assert.equal(await codexRolloutForPid(999, { sessionsRoot, procRoot }), null);
    assert.equal(await codexRolloutForPid(123, { sessionsRoot, procRoot }), resumedRollout);
    assert.equal(await codexRolloutForPid(456, { sessionsRoot, procRoot }), null);
    assert.equal(await codexRolloutForPid(790, { sessionsRoot, procRoot }), childRollout);

    const telemetry = await readCodexTelemetryForPids([123, 123, -1, 'bad'], { sessionsRoot, procRoot });
    assert.equal(telemetry.model, 'gpt-resumed');
    assert.equal(telemetry.rolloutId, '66666666-7777-8888-9999-000000000000');
    assert.equal(telemetry.candidateCount, 3);
    assert.equal(telemetry.rootInteractive, true);
    assert.equal(telemetry.account.primary.usedPercent, 12);
    assert.match(telemetry.sourceId, /^[a-f0-9]{24}$/);
    assert.equal(await readCodexTelemetryForPids([456], { sessionsRoot, procRoot }), null);
    assert.equal(await readCodexTelemetryForPids([789], { sessionsRoot, procRoot }), null);
    assert.equal((await readCodexTelemetryForPids([790], { sessionsRoot, procRoot })).rootInteractive, false);
    assert.equal((await readCodexTelemetryForPids([789, 123], { sessionsRoot, procRoot })).model, 'gpt-resumed');
    assert.equal(await readCodexTelemetryForPids(null, { sessionsRoot, procRoot }), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('selects the freshest active-session account report for dashboard-wide usage', () => {
  assert.equal(latestCodexAccountTelemetry(null), null);
  assert.equal(latestCodexAccountTelemetry([{ observedAt: 'bad', account: {} }]), null);
  const olderAccount = { limitId: 'codex', planType: 'pro', primary: { usedPercent: 20 } };
  const newerAccount = { limitId: 'codex', planType: 'pro', primary: { usedPercent: 11 } };
  const modelPool = { limitId: 'codex-special', limitName: 'Special model', planType: 'pro', primary: { usedPercent: 2 } };
  const result = latestCodexAccountTelemetry([
    { session: 'codex-old', observedAt: '2026-07-17T10:00:00.000Z', account: olderAccount },
    { session: 'codex-new\u0000', observedAt: '2026-07-18T10:00:00.000Z', account: newerAccount },
    { session: 'codex-special', observedAt: '2026-07-19T10:00:00.000Z', account: modelPool },
    { session: 'no-account', observedAt: '2026-07-19T10:00:00.000Z' }
  ]);
  assert.deepEqual(result, {
    source: 'codex-session-log',
    scope: 'account',
    sourceSession: 'codex-new',
    observedAt: '2026-07-18T10:00:00.000Z',
    account: newerAccount,
    pools: [
      { sourceSession: 'codex-special', observedAt: '2026-07-19T10:00:00.000Z', account: modelPool },
      { sourceSession: 'codex-new', observedAt: '2026-07-18T10:00:00.000Z', account: newerAccount }
    ]
  });
});

function usageSample({
  sourceId = 'a'.repeat(24),
  session = 'codex-alpha',
  observedAt = '2026-07-18T10:00:00.000Z',
  inputTokens = 1000,
  cachedInputTokens = 400,
  outputTokens = 100,
  reasoningOutputTokens = 20,
  totalTokens = 1100,
  usedPercent = 12
} = {}) {
  return {
    sourceId,
    session,
    observedAt,
    sessionTokens: { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens },
    account: {
      limitId: 'codex',
      limitName: 'Codex',
      planType: 'pro',
      primary: { usedPercent, windowMinutes: 10080, resetsAt: '2026-07-25T10:00:00.000Z' },
      secondary: null
    }
  };
}

test('daily usage tracking baselines once, deduplicates refreshes, and attributes only token deltas', () => {
  const empty = createCodexUsageStore('2026-07-18T09:00:00.000Z');
  assert.strictEqual(validateCodexUsageStore(empty), empty);

  const baseline = reconcileCodexUsageStore(empty, [usageSample()], '2026-07-18T10:00:01.000Z');
  assert.equal(baseline.revision, 1);
  assert.deepEqual(baseline.days, {});
  assert.equal(Object.hasOwn(codexUsageStats(baseline, '2026-07-18T10:01:00.000Z').agents[0], 'usage'), false);
  assert.strictEqual(reconcileCodexUsageStore(baseline, [usageSample()], '2026-07-18T10:02:00.000Z'), baseline);
  assert.strictEqual(reconcileCodexUsageStore(baseline, [{ sourceId: 'bad' }]), baseline);

  const sameDay = reconcileCodexUsageStore(baseline, [usageSample({
    observedAt: '2026-07-18T11:00:00.000Z',
    inputTokens: 1300,
    cachedInputTokens: 550,
    outputTokens: 140,
    reasoningOutputTokens: 30,
    totalTokens: 1440,
    usedPercent: 15
  })], '2026-07-18T11:00:01.000Z');
  const firstStats = codexUsageStats(sameDay, '2026-07-18T12:00:00.000Z');
  assert.equal(firstStats.today.tokens.totalTokens, 340);
  assert.equal(firstStats.today.tokens.inputTokens, 300);
  assert.equal(firstStats.today.tokens.cachedInputTokens, 150);
  assert.equal(firstStats.today.tokens.outputTokens, 40);
  assert.equal(firstStats.agents[0].todayTokens.reasoningOutputTokens, 10);
  assert.equal(Object.hasOwn(firstStats.agents[0], 'usage'), false);

  const nextDay = reconcileCodexUsageStore(sameDay, [usageSample({
    observedAt: '2026-07-19T01:00:00.000Z',
    inputTokens: 1500,
    cachedInputTokens: 650,
    outputTokens: 180,
    reasoningOutputTokens: 40,
    totalTokens: 1680,
    usedPercent: 18
  })], '2026-07-19T01:00:01.000Z');
  const stats = codexUsageStats(nextDay, '2026-07-19T02:00:00.000Z');
  assert.deepEqual(Object.keys(stats).sort(), [
    'agents',
    'days',
    'methodology',
    'periodDays',
    'retentionDays',
    'ticketTokens',
    'tickets',
    'today',
    'tokens',
    'trackingStartedAt',
    'updatedAt'
  ]);
  assert.deepEqual(stats.methodology, {
    scope: 'host-local',
    measurement: 'observed-rollout-deltas',
    dayBoundary: 'UTC',
    includesCachedInput: true,
    firstSampleIsBaseline: true,
    accountUsageEquivalent: false,
    perTicket: false,
    coverage: 'partial'
  });
  assert.equal(stats.retentionDays, 90);
  assert.equal(stats.periodDays, 2);
  assert.deepEqual(stats.days.map((day) => day.date), ['2026-07-19', '2026-07-18']);
  assert.equal(stats.today.tokens.totalTokens, 240);
  assert.equal(stats.tokens.totalTokens, 580);
  assert.equal(stats.agents[0].tokens.totalTokens, 580);

  const reset = reconcileCodexUsageStore(nextDay, [usageSample({
    observedAt: '2026-07-19T03:00:00.000Z',
    inputTokens: 10,
    cachedInputTokens: 5,
    outputTokens: 2,
    reasoningOutputTokens: 1,
    totalTokens: 12
  })], '2026-07-19T03:00:01.000Z');
  assert.equal(codexUsageStats(reset, '2026-07-19T04:00:00.000Z').tokens.totalTokens, 580);
});

test('replays complete rollout events, counts first-turn usage, and attributes exact ticket windows incrementally', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-usage-replay-'));
  const sessionsRoot = path.join(directory, 'sessions');
  const rollout = path.join(sessionsRoot, '2026', '07', '18', 'rollout.jsonl');
  const sourceId = 'd'.repeat(24);
  const totalUsage = (inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens) => ({
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    reasoning_output_tokens: reasoningOutputTokens,
    total_tokens: inputTokens + outputTokens
  });
  const tokenWithTotal = (timestamp, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens) => token(timestamp, {
    info: {
      total_token_usage: totalUsage(inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens),
      last_token_usage: totalUsage(inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens),
      model_context_window: 1000
    }
  });
  const ticketWindows = [{
    id: 'prompt-ticket-12345678',
    session: 'codex-client',
    sentAt: '2026-07-18T10:00:00.000Z',
    endedAt: '2026-07-18T12:00:00.000Z',
    state: 'complete'
  }];
  try {
    await mkdir(path.dirname(rollout), { recursive: true });
    await writeFile(rollout, jsonl([
      tokenWithTotal('2026-07-18T09:00:00.000Z', 100, 40, 10, 2),
      tokenWithTotal('2026-07-18T10:30:00.000Z', 300, 140, 30, 7),
      tokenWithTotal('2026-07-18T11:30:00.000Z', 500, 240, 50, 12)
    ]));
    const batch = await readCodexUsageEventBatch(rollout, { sourceId, session: 'codex-client' });
    assert.equal(batch.startOffset, 0);
    assert.equal(batch.nextOffset, batch.fileSize);
    assert.equal(batch.events.length, 3);

    const empty = createCodexUsageStore('2026-07-18T09:30:00.000Z');
    const rebuilt = rebuildCodexUsageStoreFromEvents(empty, [batch], ticketWindows, '2026-07-18T12:01:00.000Z');
    const rebuiltStats = codexUsageStats(rebuilt, '2026-07-18T12:01:00.000Z');
    assert.deepEqual(rebuiltStats.methodology, {
      scope: 'host-local',
      measurement: 'replayed-rollout-events',
      dayBoundary: 'UTC',
      includesCachedInput: true,
      firstSampleIsBaseline: false,
      accountUsageEquivalent: false,
      perTicket: true,
      coverage: 'complete'
    });
    assert.equal(rebuiltStats.tokens.totalTokens, 440);
    assert.equal(rebuiltStats.ticketTokens.totalTokens, 440);
    assert.equal(rebuiltStats.tickets[0].id, 'prompt-ticket-12345678');
    assert.equal(rebuiltStats.tickets[0].eventCount, 2);
    assert.equal(rebuilt.cursors[sourceId].byteOffset, batch.fileSize);

    await appendFile(rollout, jsonl([tokenWithTotal('2026-07-18T13:00:00.000Z', 600, 290, 60, 14)]));
    const incrementalBatch = await readCodexUsageEventBatch(rollout, {
      sourceId,
      session: 'codex-client',
      startOffset: rebuilt.cursors[sourceId].byteOffset
    });
    const updated = reconcileCodexUsageEventBatches(rebuilt, [incrementalBatch], ticketWindows, '2026-07-18T13:01:00.000Z');
    const updatedStats = codexUsageStats(updated, '2026-07-18T13:01:00.000Z');
    assert.equal(updatedStats.tokens.totalTokens, 550);
    assert.equal(updatedStats.ticketTokens.totalTokens, 440);
    assert.equal(updatedStats.tickets[0].eventCount, 2);
    assert.strictEqual(reconcileCodexUsageEventBatches(updated, [incrementalBatch], ticketWindows), updated);

    const resolved = await resolveCodexRolloutPaths([sourceId], { sessionsRoot });
    assert.deepEqual(resolved, {});
    const realSource = batch.sourceId === sourceId ? null : batch.sourceId;
    assert.equal(realSource, null);
    const hashedBatch = await readCodexUsageEventBatch(rollout, { session: 'codex-client' });
    const mapped = await resolveCodexRolloutPaths([hashedBatch.sourceId], { sessionsRoot });
    assert.equal(mapped[hashedBatch.sourceId], rollout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('replay resumes an incomplete JSONL record, counts a post-tracking first event, and leaves overlapping tickets unassigned', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-usage-partial-'));
  const rollout = path.join(directory, 'rollout.jsonl');
  const sourceId = 'e'.repeat(24);
  const cumulativeToken = (timestamp, inputTokens, cachedInputTokens, outputTokens) => token(timestamp, {
    info: {
      total_token_usage: {
        input_tokens: inputTokens,
        cached_input_tokens: cachedInputTokens,
        output_tokens: outputTokens,
        reasoning_output_tokens: 0,
        total_tokens: inputTokens + outputTokens
      },
      last_token_usage: {
        input_tokens: 100,
        cached_input_tokens: 40,
        output_tokens: 10,
        reasoning_output_tokens: 0,
        total_tokens: 110
      },
      model_context_window: 1000
    }
  });
  const firstLine = `${JSON.stringify(cumulativeToken('2026-07-18T10:30:00.000Z', 100, 40, 10))}\n`;
  const secondLine = JSON.stringify(cumulativeToken('2026-07-18T11:00:00.000Z', 200, 80, 20));
  const split = Math.floor(secondLine.length / 2);
  const overlappingWindows = [
    {
      id: 'prompt-overlap-a1234567',
      session: 'codex-client',
      sentAt: '2026-07-18T10:00:00.000Z',
      endedAt: '2026-07-18T12:00:00.000Z',
      state: 'complete'
    },
    {
      id: 'prompt-overlap-b1234567',
      session: 'codex-client',
      sentAt: '2026-07-18T10:15:00.000Z',
      endedAt: '2026-07-18T11:30:00.000Z',
      state: 'complete'
    }
  ];
  try {
    await writeFile(rollout, `${firstLine}${secondLine.slice(0, split)}`);
    const firstBatch = await readCodexUsageEventBatch(rollout, { sourceId, session: 'codex-client' });
    assert.equal(firstBatch.events.length, 1);
    assert.equal(firstBatch.nextOffset, Buffer.byteLength(firstLine));
    assert.equal(firstBatch.completeThrough, false);

    const empty = createCodexUsageStore('2026-07-18T10:00:00.000Z');
    const rebuilt = rebuildCodexUsageStoreFromEvents(empty, [firstBatch], overlappingWindows, '2026-07-18T10:31:00.000Z');
    assert.equal(codexUsageStats(rebuilt, '2026-07-18T10:31:00.000Z').tokens.totalTokens, 110);
    assert.equal(codexUsageStats(rebuilt, '2026-07-18T10:31:00.000Z').ticketTokens.totalTokens, 0);

    await appendFile(rollout, `${secondLine.slice(split)}\n`);
    const resumedBatch = await readCodexUsageEventBatch(rollout, {
      sourceId,
      session: 'codex-client',
      startOffset: rebuilt.cursors[sourceId].byteOffset
    });
    assert.equal(resumedBatch.events.length, 1);
    assert.equal(resumedBatch.completeThrough, true);
    const updated = reconcileCodexUsageEventBatches(rebuilt, [resumedBatch], overlappingWindows, '2026-07-18T11:01:00.000Z');
    const stats = codexUsageStats(updated, '2026-07-18T11:01:00.000Z');
    assert.equal(stats.tokens.totalTokens, 220);
    assert.equal(stats.ticketTokens.totalTokens, 0);
    assert.deepEqual(stats.tickets.map((ticket) => ticket.eventCount), [0, 0]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('usage replay handles large records with linear copying and exact byte cursors', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-usage-large-'));
  const rollout = path.join(directory, 'rollout.jsonl');
  const event = token('2026-07-18T10:30:00.000Z');
  // Large unrelated tool data, a real usage event spanning chunks, CRLF,
  // multibyte text, malformed input, and an unfinished record in one stream.
  const image = JSON.stringify({ type: 'response_item', payload: { image: 'x'.repeat(2 * 1024 * 1024) } });
  const paddedEvent = { ...event, padding: 'é'.repeat(40 * 1024) };
  const complete = `${image}\r\n${JSON.stringify(paddedEvent)}\r\n{bad json}\n\n`;
  const pending = JSON.stringify(event);
  try {
    await writeFile(rollout, complete + pending.slice(0, -1));
    const concat = Buffer.concat;
    let copiedBytes = 0;
    Buffer.concat = function (buffers, length) {
      copiedBytes += length ?? buffers.reduce((sum, buffer) => sum + buffer.length, 0);
      return concat(buffers, length);
    };
    let batch;
    try {
      batch = await readCodexUsageEventBatch(rollout);
    } finally {
      Buffer.concat = concat;
    }
    assert.equal(batch.events.length, 1);
    assert.deepEqual(batch.events[0].sessionTokens, parseCodexTelemetryText(JSON.stringify(event)).sessionTokens);
    assert.equal(batch.nextOffset, Buffer.byteLength(complete));
    assert.equal(batch.completeThrough, false);
    assert.ok(copiedBytes <= batch.fileSize * 2, 'stream must not repeatedly copy a growing image record');
    await appendFile(rollout, '}\n');
    const resumed = await readCodexUsageEventBatch(rollout, { startOffset: batch.nextOffset });
    assert.equal(resumed.events.length, 1);
    assert.equal(resumed.nextOffset, resumed.fileSize);
    assert.equal(resumed.completeThrough, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('usage replay rebaselines a cursor past a truncated rollout without rereading retained events', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-usage-truncated-'));
  const rollout = path.join(directory, 'rollout.jsonl');
  const sourceId = 'b'.repeat(24);
  const usage = (inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens) => ({
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    reasoning_output_tokens: reasoningOutputTokens,
    total_tokens: inputTokens + outputTokens
  });
  const first = token('2026-07-18T10:00:00.000Z', {
    info: {
      total_token_usage: usage(100, 40, 10, 2),
      last_token_usage: usage(100, 40, 10, 2),
      model_context_window: 1000
    }
  });
  const second = token('2026-07-18T11:00:00.000Z', {
    info: {
      total_token_usage: usage(200, 80, 20, 4),
      last_token_usage: usage(100, 40, 10, 2),
      model_context_window: 1000
    }
  });
  const retained = jsonl([first]);
  try {
    await writeFile(rollout, jsonl([first, second]));
    const initialBatch = await readCodexUsageEventBatch(rollout, { sourceId, session: 'codex-client' });
    const initial = rebuildCodexUsageStoreFromEvents(
      createCodexUsageStore('2026-07-18T09:00:00.000Z'),
      [initialBatch],
      [],
      '2026-07-18T11:01:00.000Z'
    );
    const previousOffset = initial.cursors[sourceId].byteOffset;
    const previousTokens = codexUsageStats(initial, '2026-07-18T11:01:00.000Z').tokens;

    await writeFile(rollout, retained);
    const resetBatch = await readCodexUsageEventBatch(rollout, {
      sourceId,
      session: 'codex-client',
      startOffset: previousOffset
    });
    assert.equal(resetBatch.startOffset, previousOffset);
    assert.equal(resetBatch.nextOffset, Buffer.byteLength(retained));
    assert.equal(resetBatch.events.length, 0);
    assert.equal(resetBatch.completeThrough, true);

    const reset = reconcileCodexUsageEventBatches(initial, [resetBatch], [], '2026-07-18T11:02:00.000Z');
    assert.equal(reset.cursors[sourceId].byteOffset, Buffer.byteLength(retained));
    assert.deepEqual(codexUsageStats(reset, '2026-07-18T11:02:00.000Z').tokens, previousTokens);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('usage tracking rebaselines any regressed cumulative counter without phantom deltas', () => {
  const sourceId = 'c'.repeat(24);
  const empty = createCodexUsageStore('2026-07-18T09:00:00.000Z');
  const baseline = reconcileCodexUsageStore(empty, [usageSample({ sourceId })]);
  const advanced = reconcileCodexUsageStore(baseline, [usageSample({
    sourceId,
    observedAt: '2026-07-18T11:00:00.000Z',
    inputTokens: 1100,
    cachedInputTokens: 450,
    outputTokens: 110,
    reasoningOutputTokens: 25,
    totalTokens: 1210
  })]);
  assert.equal(codexUsageStats(advanced, '2026-07-18T11:30:00.000Z').tokens.totalTokens, 110);

  const redistributed = reconcileCodexUsageStore(advanced, [usageSample({
    sourceId,
    observedAt: '2026-07-18T12:00:00.000Z',
    inputTokens: 1050,
    cachedInputTokens: 430,
    outputTokens: 170,
    reasoningOutputTokens: 30,
    totalTokens: 1220
  })]);
  assert.equal(codexUsageStats(redistributed, '2026-07-18T12:30:00.000Z').tokens.totalTokens, 110);
  assert.equal(redistributed.cursors[sourceId].tokens.inputTokens, 1050);
  assert.equal(redistributed.cursors[sourceId].tokens.outputTokens, 170);

  const recovered = reconcileCodexUsageStore(redistributed, [usageSample({
    sourceId,
    observedAt: '2026-07-18T13:00:00.000Z',
    inputTokens: 1100,
    cachedInputTokens: 450,
    outputTokens: 180,
    reasoningOutputTokens: 35,
    totalTokens: 1280
  })]);
  assert.equal(codexUsageStats(recovered, '2026-07-18T13:30:00.000Z').tokens.totalTokens, 170);
});

test('usage stats group exact rollout deltas by tmux session and report the contributing rollout count', () => {
  const sourceA = 'a'.repeat(24);
  const sourceB = 'b'.repeat(24);
  const empty = createCodexUsageStore('2026-07-18T09:00:00.000Z');
  const baseline = reconcileCodexUsageStore(empty, [
    usageSample({ sourceId: sourceA, session: 'codex-shared' }),
    usageSample({ sourceId: sourceB, session: 'codex-shared' })
  ]);
  const updated = reconcileCodexUsageStore(baseline, [
    usageSample({ sourceId: sourceA, session: 'codex-shared', observedAt: '2026-07-18T11:00:00.000Z', inputTokens: 1100, outputTokens: 110, totalTokens: 1210 }),
    usageSample({ sourceId: sourceB, session: 'codex-shared', observedAt: '2026-07-18T11:00:00.000Z', inputTokens: 1200, outputTokens: 120, totalTokens: 1320 })
  ]);

  const stats = codexUsageStats(updated, '2026-07-18T12:00:00.000Z');
  assert.equal(stats.agents.length, 1);
  assert.equal(stats.agents[0].session, 'codex-shared');
  assert.equal(stats.agents[0].rolloutCount, 2);
  assert.equal(stats.agents[0].tokens.totalTokens, 330);
});

test('usage history remains bounded and malformed persisted state fails closed', () => {
  assert.throws(() => validateCodexUsageStore(null), /codex_usage_state_invalid/);
  assert.throws(() => validateCodexUsageStore({ ...createCodexUsageStore(), revision: -1 }), /codex_usage_state_invalid/);
  assert.throws(() => validateCodexUsageStore({ ...createCodexUsageStore(), cursors: { invalid: {} } }), /codex_usage_state_invalid/);
  assert.throws(() => validateCodexUsageStore({ ...createCodexUsageStore(), days: { bad: {} } }), /codex_usage_state_invalid/);

  const canonical = reconcileCodexUsageStore(createCodexUsageStore(), [usageSample({
    cachedInputTokens: 1200,
    reasoningOutputTokens: 200,
    totalTokens: 9999
  })]);
  assert.deepEqual(canonical.cursors['a'.repeat(24)].tokens, {
    inputTokens: 1000,
    cachedInputTokens: 1000,
    outputTokens: 100,
    reasoningOutputTokens: 100,
    totalTokens: 1100
  });
  const inconsistent = structuredClone(canonical);
  inconsistent.cursors['a'.repeat(24)].tokens.totalTokens += 1;
  assert.throws(() => validateCodexUsageStore(inconsistent), /codex_usage_state_invalid/);

  const dailyBaseline = reconcileCodexUsageStore(createCodexUsageStore(), [usageSample()]);
  const daily = reconcileCodexUsageStore(dailyBaseline, [usageSample({
    observedAt: '2026-07-18T11:00:00.000Z',
    inputTokens: 1100,
    outputTokens: 110,
    totalTokens: 1210
  })]);
  const inconsistentDay = structuredClone(daily);
  inconsistentDay.days['2026-07-18'].tokens.outputTokens += 1;
  inconsistentDay.days['2026-07-18'].tokens.totalTokens += 1;
  assert.throws(() => validateCodexUsageStore(inconsistentDay), /codex_usage_state_invalid/);

  let store = createCodexUsageStore('2026-01-01T00:00:00.000Z');
  store = reconcileCodexUsageStore(store, Array.from({ length: 257 }, (_, index) => usageSample({
    sourceId: index.toString(16).padStart(24, '0'),
    session: `codex-${index}`,
    observedAt: `2026-01-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`
  })), '2026-01-01T02:00:00.000Z');
  assert.equal(Object.keys(store.cursors).length, 256);

  const sourceId = 'f'.repeat(24);
  store = reconcileCodexUsageStore(store, [usageSample({ sourceId, observedAt: '2026-01-01T03:00:00.000Z' })]);
  let totalTokens = 1100;
  for (let index = 1; index <= 92; index += 1) {
    totalTokens += 10;
    const observedAt = new Date(Date.UTC(2026, 0, 1 + index, 3)).toISOString();
    store = reconcileCodexUsageStore(store, [usageSample({
      sourceId,
      observedAt,
      inputTokens: totalTokens - 100,
      outputTokens: 100,
      totalTokens
    })], observedAt);
  }
  assert.equal(Object.keys(store.days).length, 90);
  assert.equal(codexUsageStats(store, '2026-04-03T04:00:00.000Z').days.length, 30);
});
