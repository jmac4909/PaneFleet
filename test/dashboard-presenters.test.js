import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatReviewContext, todayAttentionSnapshot } from '../dashboard-presenters.js';

const at = '2026-08-17T09:30:00.000Z';

test('Today attention combines decision sources, fallbacks, deduplication, and severity ordering', () => {
  const result = todayAttentionSnapshot({
    missions: {
      jobs: [
        { id: 'verify', title: 'Verify work', status: 'verifying', updatedAt: '2026-08-17T09:29:00.000Z' },
        { id: 'failed', title: 'Failed work', status: 'failed', blocker: '', updatedAt: '' },
        { id: 'waiting', title: 'Waiting work', status: 'needs_you', blocker: 'Choose an option.', assignedSession: 'codex-owned', updatedAt: at },
        { id: 'running', title: 'Healthy work', status: 'running', suggestedAttention: false, updatedAt: at }
      ]
    },
    agents: [
      { session: 'codex-owned', id: 'codex-owned:0.0', agentStatus: { state: 'waiting', tone: 'bad' } },
      { session: 'codex-defaults', id: 'codex-defaults:0.0', agentStatus: {} },
      { session: 'codex-stopped', id: 'codex-stopped:0.0', agentStatus: { state: 'stopped', tone: 'good', reason: 'Exited.' } },
      { session: 'codex-bad', id: 'codex-bad:0.0', agentStatus: { state: 'busy', tone: 'bad', reason: 'Fault.' } },
      { session: 'codex-healthy', id: 'codex-healthy:0.0', agentStatus: { state: 'idle', tone: 'good' } }
    ],
    orchestration: {
      agents: [
        { session: 'codex-stopped', displayName: 'Stopped worker', nextAction: 'Restart only after review.', checkedAt: '2026-08-17T09:28:00.000Z' },
        { session: 'codex-bad', displayName: '', nextAction: '', stateText: 'Inspect the failure.', checkedAt: '' }
      ]
    },
    services: [
      { id: 'missing-port', label: '', running: true, ports: [8787], portStates: [{ listening: false }] },
      { id: 'health-failed', label: 'Failed health', healthy: false, health: { detail: 'Health probe failed.' } },
      { id: 'health-object', label: 'Health object', health: { ok: false, detail: '' } },
      { id: 'healthy', label: 'Healthy service', healthy: true, ports: [] }
    ],
    security: {
      sshRescue: { active: true, openedAt: '' },
      warnings: [
        { id: 'duplicate', title: 'First warning', detail: 'First detail.' },
        { id: 'duplicate', title: 'Duplicate warning', detail: 'Must be dropped.', tone: 'mystery', updatedAt: '' },
        { id: 'explicit', title: 'Explicit warning', detail: 'Exact fields.', status: 'known', tone: 'good', requiresDecision: true, updatedAt: at }
      ]
    },
    host: {
      totalMem: 2 * (1024 ** 3),
      availableMem: 0.3 * (1024 ** 3),
      rootFs: { usedPercent: 96, availableBytes: 1024 ** 3 }
    },
    errors: ['', 'tmux observation failed', 'tmux observation failed'],
    at
  });

  assert.equal(result.items.some((item) => item.id === 'attention:mission:verify:verifying' && item.tone === 'busy'), true);
  assert.match(result.items.find((item) => item.missionId === 'failed')?.detail || '', /Inspect the failure/);
  assert.equal(result.items.some((item) => item.session === 'codex-owned'), false);
  assert.equal(result.items.some((item) => item.session === 'codex-defaults'), false);
  assert.equal(result.items.find((item) => item.session === 'codex-stopped')?.title, 'Stopped worker');
  assert.equal(result.items.find((item) => item.session === 'codex-bad')?.detail, 'Inspect the failure.');
  assert.equal(result.items.filter((item) => item.dedupeKey === 'system:duplicate').length, 1);
  assert.equal(result.items.filter((item) => item.dedupeKey === 'host-error:tmux observation failed').length, 1);
  assert.equal(result.items.some((item) => item.id === 'attention:host:memory'), true);
  assert.equal(result.items.some((item) => item.id === 'attention:host:root-disk'), true);
  assert.equal(result.items[0].tone, 'bad');
  assert.equal(result.decisionCount, result.items.filter((item) => item.requiresDecision).length);
});

test('Today attention accepts empty optional collections without inventing work', () => {
  assert.deepEqual(todayAttentionSnapshot({ host: {}, at }), { decisionCount: 0, items: [] });
});

test('review context formats full and missing observations without exposing reviewer panes', () => {
  const mebibyte = 1024 ** 2;
  const current = {
    host: {
      hostname: 'fixture-host',
      uptimeSeconds: 42,
      loadavg: [0, 1.25, 2.5],
      totalMem: 2048 * mebibyte,
      freeMem: 512 * mebibyte
    },
    agents: [
      { session: 'codex-review', currentPath: '/private/review' },
      { session: 'codex-empty', currentPath: '/srv/fixture', agentStatus: {} },
      {
        session: 'codex-full',
        currentPath: '/srv/fixture/projects/full',
        agentStatus: { state: 'busy', reason: 'Working.' },
        primaryProcess: { cpu: 1.5, mem: 2.5 },
        lastLine: 'Still working.'
      }
    ],
    orchestration: {
      agents: [{
        session: 'codex-full',
        sampleCount: 3,
        lastSampledAt: at,
        task: 'Build the fixture.',
        stateText: 'Actively working.',
        nextAction: 'Wait.'
      }]
    },
    services: [
      { id: 'empty', label: 'Empty', cwd: '', running: false, managed: false },
      {
        id: 'full', label: 'Full', stateLabel: 'running', cwd: '/srv/fixture/projects/full',
        running: true, managed: true, discovered: true,
        portStates: [{ port: 8787, listening: true }, { port: 9000, listening: false }],
        lastLine: 'healthy'
      }
    ],
    listeners: [
      {},
      { address: '127.0.0.1', port: 8787, processText: 'node' },
      { address: '::1', port: 9000, raw: 'raw listener' }
    ],
    topProcesses: [
      {},
      { pid: 7, cpu: 1.2, mem: 2.3, rssKb: 4096, command: 'node server.js' },
      { pid: 8, raw: 'raw process' }
    ],
    audit: [
      {},
      { time: at, ok: true, action: 'fixture.ok', target: 'one', detail: 'Complete.' },
      { time: at, ok: false, action: 'fixture.failed', target: 'two', detail: 'Failed.' }
    ]
  };
  const panePreviews = [
    { pane: { session: 'one', currentPath: '/srv/fixture', type: 'agent', primaryProcess: { command: 'node codex' } }, preview: { redactedCount: 1, output: 'Output.' } },
    { pane: { session: 'two', currentPath: '/outside', type: 'service', currentCommand: 'node' }, preview: { redactedCount: 0, error: 'Capture failed.' } },
    { pane: { session: 'three', currentPath: '', type: 'service', currentCommand: '' }, preview: { redactedCount: 0 } }
  ];
  const logTails = [
    { service: 'full', label: 'Output', path: '~/log', ok: true, redactedCount: 2, output: 'Log output.' },
    { service: 'empty', label: 'Missing', path: '~/missing', ok: false }
  ];
  const result = formatReviewContext({
    current,
    panePreviews,
    logTails,
    homeDir: '/srv/fixture',
    reviewSession: 'codex-review',
    generatedAt: at,
    maxChars: 100_000
  });

  assert.deepEqual(result.sourceCounts, { panes: 3, agents: 2, services: 2, listeners: 3, logs: 2 });
  assert.match(result.context, /Memory available: 512 MB/);
  assert.match(result.context, /Root disk available: 0 MB \/ 0 MB/);
  assert.match(result.context, /cwd: ~\/projects\/full/);
  assert.match(result.context, /state: unknown \(no reason\)/);
  assert.match(result.context, /source=auto-discovered/);
  assert.match(result.context, /8787:open, 9000:closed/);
  assert.match(result.context, /Capture failed\./);
  assert.match(result.context, /\(no output\)/);
  assert.match(result.context, /fixture\.failed/);
  assert.doesNotMatch(result.context, /codex-review/);
});

test('review context emits explicit empty sections and bounded truncation', () => {
  const result = formatReviewContext({
    current: {
      host: {
        hostname: 'empty-host', uptimeSeconds: 0, loadavg: [],
        totalMem: 1, availableMem: 1,
        rootFs: { availableBytes: 1, totalBytes: 1 }
      },
      agents: [], orchestration: {}, services: [], listeners: [], topProcesses: []
    },
    panePreviews: [],
    logTails: [],
    homeDir: '/srv/fixture',
    reviewSession: 'codex-review',
    generatedAt: at,
    maxChars: 180
  });
  assert.deepEqual(result.sourceCounts, { panes: 0, agents: 0, services: 0, listeners: 0, logs: 0 });
  assert.match(result.context, /\[truncated \d+ chars\]$/);
});
