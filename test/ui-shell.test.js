import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  attentionForSession,
  connectionStatePresentation,
  cycledItemIndex,
  dashboardDocumentTitle,
  dashboardShortcut,
  filterPromptHistory,
  isNewAgentSubmitShortcut,
  isPromptQueueSubmitShortcut,
  isTerminalFindShortcut,
  modalFocusIndex,
  nextDrawer,
  noticeAutoDismissMs,
  normalizedPromptQueueDraft,
  normalizedTerminalRestoreState,
  preferredDashboardView,
  projectContextCacheFresh,
  promptHistoryOrigin,
  promptHistorySearchValue,
  promptQueueComposerPresentation,
  promptQueueSectionTarget,
  sessionFilterCategory,
  sessionFilterMatches,
  sessionPinPresentation,
  sessionResultCountPresentation,
  sessionSearchKeyAction,
  sessionStatusPresentation,
  shouldStickTerminalOutput,
  terminalComposerPresentation,
  terminalDraftPresentation,
  terminalFindOffsets,
  terminalFocusKind,
  terminalLatestPresentation,
  terminalLayoutSlots,
  terminalRefreshPresentation,
  terminalSwitcherLabel,
  terminalTabKeyIndex,
  terminalTabScrollLeft,
  terminalWorkspaceFrame,
  workspaceFocusApplies,
  workspaceFocusPresentation
} from '../public/ui-state.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');

async function uiSource(name) {
  return readFile(path.join(publicDir, name), 'utf8');
}

test('live entrypoint loads the terminal-first shell', async () => {
  const index = await uiSource('index.html');

  assert.match(index, /<title>PaneFleet — Terminal Workspace<\/title>/);
  assert.match(index, /<span class="brand-mark" aria-hidden="true">PF<\/span>/);
  assert.match(index, /<div><h1>PaneFleet<\/h1><p>Terminal workspace<\/p><\/div>/);
  assert.match(index, /id="agents-tab" class="tab active"[^>]*><span>Terminals<\/span>/);
  assert.match(index, /href="\/styles\.css"/);
  assert.match(index, /src="\/app\.js"/);
  assert.match(index, /id="queue-tab" class="tab" data-view="queue"[^>]*aria-controls="queue-view"/);
  assert.match(index, /id="queue-view" class="view queue-workspace-view"[^>]*hidden/);
  assert.match(index, /id="notice" class="notice notice-toast hidden"[^>]*><span id="notice-message"[^>]*><\/span><button class="notice-dismiss" data-action="notice-dismiss"/);
  assert.match(index, /data-action="new-agent-open"[^>]*aria-keyshortcuts="Alt\+N"[^>]*title="Create new agent \(Alt\+N\)"/);
  assert.match(index, /id="shortcut-help-button"[^>]*data-action="shortcut-help-open"[^>]*aria-keyshortcuts="Shift\+\/"/);
  assert.match(index, /id="shortcut-help" class="shortcut-help hidden" role="dialog" aria-modal="true"/);
  assert.match(index, /id="shortcut-help-backdrop" class="shortcut-help-backdrop hidden" data-action="shortcut-help-close"/);
  assert.match(index, /id="shortcut-help-title">Keyboard shortcuts/);
  assert.match(index, /data-action="close-finished-terminals"[^>]*aria-label="Close inactive terminal views; agents keep running"/);
  assert.match(index, /class="terminal-cycle-controls"[^>]*aria-label="Switch open terminal"/);
  assert.match(index, /data-action="terminal-cycle-active" data-direction="-1"[^>]*aria-keyshortcuts="Alt\+\["/);
  assert.match(index, /data-action="terminal-cycle-active" data-direction="1"[^>]*aria-keyshortcuts="Alt\+\]"/);
  assert.match(index, /id="terminal-jump-select" aria-label="Jump to open terminal" disabled/);
  assert.match(index, /id="workspace-focus-toggle"[^>]*data-action="workspace-focus-toggle"[^>]*aria-keyshortcuts="Alt\+0"/);
  assert.match(index, /id="session-panel-toggle"[^>]*data-action="workspace-panel-toggle"[^>]*data-panel="sessions"[^>]*aria-controls="session-rail"/);
  assert.match(index, /id="inspector-panel-toggle"[^>]*data-action="workspace-panel-toggle"[^>]*data-panel="inspector"[^>]*aria-controls="terminal-inspector"/);
  assert.doesNotMatch(index, /id="queue-drawer"/);
  assert.match(index, /id="tools-drawer"[^>]*class="control-drawer tools-drawer hidden"/);
  assert.match(index, /id="terminal-stage"/);
  assert.match(index, /id="session-list"/);
  assert.match(index, /id="session-search"[^>]*aria-keyshortcuts="Control\+K Meta\+K \/"/);
  assert.match(index, /id="session-search"[^>]*enterkeyhint="go"[^>]*aria-controls="session-list"[^>]*aria-describedby="session-search-help"/);
  assert.match(index, /id="session-search-help"[^>]*>Enter opens the first matching session\./);
  assert.match(index, /class="session-search-shortcut"[^>]*>Ctrl K<\/kbd>/);
  assert.match(index, /id="session-filters"[^>]*aria-label="Filter sessions by status"/);
  assert.match(index, /id="session-count" aria-label="0 sessions" title="0 sessions">0<\/strong>/);
  assert.match(index, /data-action="session-filter" data-filter="needs"/);
  assert.match(index, /id="agents-tab"[^>]*aria-keyshortcuts="Alt\+1"/);
  assert.match(index, /id="queue-tab"[^>]*aria-keyshortcuts="Alt\+2"/);
  assert.match(index, /id="tools-tab"[^>]*aria-keyshortcuts="Alt\+3"/);
  assert.match(index, /id="workspace-eyebrow" class="eyebrow">Terminal-first control/);
  assert.match(index, /id="workspace-title">Agent workspace/);
  assert.match(index, /id="connection-pill"[^>]*data-state="init"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(index, /id="connection-label">Connecting<\/strong>/);
  assert.match(index, /id="refresh-button"[^>]*aria-busy="false"/);
  assert.match(index, /class="action-button new-agent-action"[^>]*data-action="new-agent-open"[^>]*aria-label="Create new agent"/);
  assert.match(index, /class="new-agent-label-short" aria-hidden="true">New<\/span>/);
  assert.match(index, /id="terminal-tabs" class="terminal-tabs hidden" role="tablist" aria-label="Open terminal tabs"/);
  assert.match(index, /data-layout="free"/);
  assert.match(index, /data-layout="focus"/);
  assert.match(index, /data-layout="split"/);
  assert.match(index, /data-layout="grid"/);
  assert.match(index, /data-layout="free"[^>]*aria-label="Freeform terminal windows"[\s\S]*class="layout-label-full">Freeform/);
  assert.match(index, /data-layout="focus"[^>]*aria-label="Focus one terminal"[\s\S]*class="layout-label-full">Focus/);
  assert.match(index, /data-layout="split"[^>]*aria-label="Split two terminals"[\s\S]*class="layout-label-full">Split/);
  assert.match(index, /data-layout="grid"[^>]*aria-label="Grid four terminals"[\s\S]*class="layout-label-full">Grid/);
  assert.match(index, /data-action="terminal-full-height"[^>]*aria-pressed="false"/);
  assert.match(index, /id="project-desk" class="project-desk hidden"/);
  assert.match(index, /data-action="project-new-agent"[^>]*>New Codex here<\/button>/);
  assert.match(index, /id="project-notes"/);
  assert.match(index, /id="project-artifacts"/);
  assert.match(index, /id="project-artifact-count"/);
  assert.match(index, /id="scratchpad-text"[^>]*maxlength="4000"/);
  assert.match(index, /id="scratchpad-review-panel" class="scratchpad-review-panel hidden"/);
  assert.match(index, /data-action="scratchpad-send-confirm"/);

  const workspaceIndex = index.indexOf('id="terminal-stage"');
  const mainEndIndex = index.indexOf('</main>');
  const layerIndex = index.indexOf('id="terminal-layer"');
  assert.ok(workspaceIndex < mainEndIndex && mainEndIndex < layerIndex);
});

test('drawer state is exclusive and exact-session attention never leaks across workers', () => {
  assert.equal(nextDrawer(null, 'queue'), null);
  assert.equal(nextDrawer(null, 'tools'), 'tools');
  assert.equal(nextDrawer('tools', 'tools'), null);
  assert.equal(nextDrawer('tools', 'invalid'), null);

  const items = [
    { id: 'one', session: 'codex' },
    { id: 'two', session: 'codex2' },
    { id: 'host-only' }
  ];
  assert.deepEqual(attentionForSession(items, 'codex').map((item) => item.id), ['one']);
  assert.deepEqual(attentionForSession(items, 'codex2').map((item) => item.id), ['two']);
  assert.deepEqual(attentionForSession(items, ''), []);
  assert.deepEqual(attentionForSession(null, 'codex'), []);
});

test('Project Desk cache freshness is bounded and rejects missing, expired, or future entries', () => {
  const entry = { context: { artifacts: [{ name: 'fresh.pdf' }] }, fetchedAt: 10_000 };
  assert.equal(projectContextCacheFresh(entry, 10_000, 15_000), true);
  assert.equal(projectContextCacheFresh(entry, 24_999, 15_000), true);
  assert.equal(projectContextCacheFresh(entry, 25_000, 15_000), false);
  assert.equal(projectContextCacheFresh(entry, 9_999, 15_000), false);
  assert.equal(projectContextCacheFresh({ fetchedAt: 10_000 }, 10_001, 15_000), false);
  assert.equal(projectContextCacheFresh(entry, 10_001, 0), false);
  assert.equal(projectContextCacheFresh(entry, Number.NaN, 15_000), false);
});

test('dashboard shortcuts stay out of editors and map only deliberate navigation chords', () => {
  assert.equal(dashboardShortcut({ key: 'k' }, true), null);
  assert.equal(dashboardShortcut({ key: 'k', isComposing: true }, false), null);
  assert.equal(dashboardShortcut({ key: 'k', ctrlKey: true }, false), 'search');
  assert.equal(dashboardShortcut({ key: 'K', metaKey: true }, false), 'search');
  assert.equal(dashboardShortcut({ key: 'k', ctrlKey: true, altKey: true }, false), null);
  assert.equal(dashboardShortcut({ key: 'x', ctrlKey: true }, false), null);
  assert.equal(dashboardShortcut({ key: '1', altKey: true }, false), 'agents');
  assert.equal(dashboardShortcut({ key: '2', altKey: true }, false), 'queue');
  assert.equal(dashboardShortcut({ key: '3', altKey: true }, false), 'tools');
  assert.equal(dashboardShortcut({ key: 'n', altKey: true }, false), 'new-agent');
  assert.equal(dashboardShortcut({ key: 'N', altKey: true }, false), 'new-agent');
  assert.equal(dashboardShortcut({ key: '0', altKey: true }, false), 'workspace-focus');
  assert.equal(dashboardShortcut({ key: '[', altKey: true }, false), 'terminal-previous');
  assert.equal(dashboardShortcut({ key: ']', altKey: true }, false), 'terminal-next');
  assert.equal(dashboardShortcut({ key: '[', altKey: true }, true), null);
  assert.equal(dashboardShortcut({ key: ']', altKey: true, ctrlKey: true }, false), null);
  assert.equal(dashboardShortcut({ key: '9', altKey: true }, false), null);
  assert.equal(dashboardShortcut({ key: '?' }, false), 'shortcuts');
  assert.equal(dashboardShortcut({ key: '?' }, true), null);
  assert.equal(dashboardShortcut({ key: '/', altKey: true }, false), null);
  assert.equal(dashboardShortcut({ key: '/' }, false), 'search');
  assert.equal(dashboardShortcut({ key: 'x' }, false), null);
  assert.equal(dashboardShortcut({}, false), null);
});

test('terminal workspace restore keeps only bounded exact pane identities', () => {
  const value = {
    version: 1,
    active: {
      session: 'codex-beta',
      sessionCreatedAt: '2026-07-17T12:01:00.000Z',
      paneId: 'codex-beta:0.0',
      tmuxPaneId: '%12',
      panePid: 1200
    },
    terminals: [
      null,
      { session: 'bad-date', sessionCreatedAt: 'not-a-date', paneId: 'bad-date:0.0', tmuxPaneId: '%9', panePid: 900 },
      { session: 'codex-alpha', sessionCreatedAt: '2026-07-17T12:00:00.000Z', paneId: 'codex-alpha:0.0', tmuxPaneId: '%11', panePid: 1100, freeBounds: { left: 24, top: 80, width: 720, height: 540 } },
      { session: 'codex-alpha', sessionCreatedAt: '2026-07-17T12:00:00.000Z', paneId: 'codex-alpha:0.0', tmuxPaneId: '%11', panePid: 1100, minimized: true },
      { session: 'codex-beta', sessionCreatedAt: '2026-07-17T12:01:00.000Z', paneId: 'codex-beta:0.0', tmuxPaneId: '%12', panePid: 1200, minimized: true, refreshPaused: true, freeBounds: { left: 0, top: 0, width: 12, height: 12 } },
      { session: 'codex-gamma', sessionCreatedAt: '2026-07-17T12:02:00.000Z', paneId: 'codex-gamma:0.0', tmuxPaneId: '%13', panePid: 1300 }
    ]
  };

  assert.deepEqual(normalizedTerminalRestoreState(null), []);
  assert.deepEqual(normalizedTerminalRestoreState({ version: 2, terminals: [] }), []);
  assert.deepEqual(normalizedTerminalRestoreState(value, 2), [
    {
      session: 'codex-alpha',
      sessionCreatedAt: '2026-07-17T12:00:00.000Z',
      paneId: 'codex-alpha:0.0',
      tmuxPaneId: '%11',
      panePid: 1100,
      minimized: false,
      refreshPaused: false,
      freeBounds: { left: 24, top: 80, width: 720, height: 540 },
      active: false
    },
    {
      session: 'codex-beta',
      sessionCreatedAt: '2026-07-17T12:01:00.000Z',
      paneId: 'codex-beta:0.0',
      tmuxPaneId: '%12',
      panePid: 1200,
      minimized: true,
      refreshPaused: true,
      freeBounds: null,
      active: true
    }
  ]);
});

test('workspace focus mode keeps its restore action explicit', () => {
  assert.equal(workspaceFocusApplies(true, 'agents'), true);
  assert.equal(workspaceFocusApplies(true, 'queue'), false);
  assert.equal(workspaceFocusApplies(false, 'agents'), false);
  assert.equal(workspaceFocusApplies(true, 'unknown'), false);
  assert.deepEqual(workspaceFocusPresentation(false), {
    label: 'Focus canvas',
    shortLabel: 'Canvas',
    description: 'Hide side panels and expand the terminal canvas'
  });
  assert.deepEqual(workspaceFocusPresentation(true), {
    label: 'Show panels',
    shortLabel: 'Panels',
    description: 'Restore navigation, sessions, and the selected-agent inspector'
  });
});

test('New Agent keyboard controls submit deliberately and keep focus inside the modal', () => {
  assert.equal(isNewAgentSubmitShortcut({ key: 'Enter', ctrlKey: true }), true);
  assert.equal(isNewAgentSubmitShortcut({ key: 'Enter', metaKey: true }), true);
  assert.equal(isNewAgentSubmitShortcut({ key: 'Enter' }), false);
  assert.equal(isNewAgentSubmitShortcut({ key: 'Enter', ctrlKey: true, shiftKey: true }), false);
  assert.equal(isNewAgentSubmitShortcut({ key: 'Enter', metaKey: true, altKey: true }), false);
  assert.equal(isNewAgentSubmitShortcut({ key: 'Enter', ctrlKey: true, isComposing: true }), false);
  assert.equal(isNewAgentSubmitShortcut(null), false);

  assert.equal(modalFocusIndex({ key: 'Tab' }, 2, 3), 0);
  assert.equal(modalFocusIndex({ key: 'Tab', shiftKey: true }, 0, 3), 2);
  assert.equal(modalFocusIndex({ key: 'Tab' }, 1, 3), -1);
  assert.equal(modalFocusIndex({ key: 'Tab' }, -1, 3), 0);
  assert.equal(modalFocusIndex({ key: 'Tab', shiftKey: true }, -1, 3), 2);
  assert.equal(modalFocusIndex({ key: 'Tab', ctrlKey: true }, 2, 3), -1);
  assert.equal(modalFocusIndex({ key: 'Escape' }, 2, 3), -1);
  assert.equal(modalFocusIndex({ key: 'Tab' }, 0, 0), -1);
});

test('dashboard view preference honors deep links before durable local selection', () => {
  assert.equal(preferredDashboardView('#queue', 'agents'), 'queue');
  assert.equal(preferredDashboardView('#terminals', 'queue'), 'agents');
  assert.equal(preferredDashboardView('#agents', 'queue'), 'agents');
  assert.equal(preferredDashboardView('#unknown', 'queue'), 'queue');
  assert.equal(preferredDashboardView('', 'agents'), 'agents');
  assert.equal(preferredDashboardView(null, 'invalid'), 'agents');
});

test('browser title prioritizes connection and decision status without losing section context', () => {
  assert.equal(dashboardDocumentTitle(), 'Terminals — PaneFleet');
  assert.equal(dashboardDocumentTitle({ connection: 'error', decisionCount: 3 }), 'Offline · Terminals — PaneFleet');
  assert.equal(dashboardDocumentTitle({ connection: 'poll', decisionCount: 3 }), 'Polling · Terminals — PaneFleet');
  assert.equal(dashboardDocumentTitle({ decisionCount: 2.9, workingCount: 4 }), 'Needs you: 2 · Terminals — PaneFleet');
  assert.equal(dashboardDocumentTitle({ view: 'queue', queuedCount: 5, workingCount: 4 }), 'Queued: 5 · Queue — PaneFleet');
  assert.equal(dashboardDocumentTitle({ workingCount: 3 }), 'Working: 3 · Terminals — PaneFleet');
  assert.equal(dashboardDocumentTitle({ drawer: 'tools' }), 'Tools — PaneFleet');
});

test('connection state presentation keeps compact labels tied to explicit operational meaning', () => {
  assert.deepEqual(connectionStatePresentation('live'), {
    label: 'Live', tone: 'good', description: 'Live updates connected'
  });
  assert.deepEqual(connectionStatePresentation('poll'), {
    label: 'Polling', tone: 'warn', description: 'Live stream unavailable; snapshot polling is active'
  });
  assert.deepEqual(connectionStatePresentation('error'), {
    label: 'Offline', tone: 'bad', description: 'Dashboard updates are unavailable'
  });
  assert.deepEqual(connectionStatePresentation('init'), {
    label: 'Connecting', tone: 'neutral', description: 'Connecting to dashboard updates'
  });
  assert.deepEqual(connectionStatePresentation('unknown'), connectionStatePresentation());
});

test('operational notices auto-dismiss only when they are routine', () => {
  assert.equal(noticeAutoDismissMs('info'), 8000);
  assert.equal(noticeAutoDismissMs('success'), 6000);
  assert.equal(noticeAutoDismissMs('warning'), 0);
  assert.equal(noticeAutoDismissMs('error'), 0);
  assert.equal(noticeAutoDismissMs('ERROR'), 0);
  assert.equal(noticeAutoDismissMs('unknown'), 8000);
  assert.equal(noticeAutoDismissMs(null), 8000);
});

test('mobile terminal cycling wraps predictably and rejects an empty terminal set', () => {
  assert.equal(cycledItemIndex(0, 0, 1), -1);
  assert.equal(cycledItemIndex(0, 3, 1), 1);
  assert.equal(cycledItemIndex(2, 3, 1), 0);
  assert.equal(cycledItemIndex(1, 3, -1), 0);
  assert.equal(cycledItemIndex(0, 3, -1), 2);
  assert.equal(cycledItemIndex(-1, 3, 1), 1);
  assert.equal(cycledItemIndex(4, 3, -1), 2);
});

test('terminal output find is case-insensitive, non-overlapping, and safely bounded', () => {
  assert.deepEqual(terminalFindOffsets('Alpha beta ALPHA', 'alpha'), [0, 11]);
  assert.deepEqual(terminalFindOffsets('aaaa', 'aa'), [0, 2]);
  assert.deepEqual(terminalFindOffsets('one one one', 'one', 2), [0, 4]);
  assert.deepEqual(terminalFindOffsets('text', ''), []);
  assert.deepEqual(terminalFindOffsets('', 'text'), []);
});

test('terminal find shortcut is deliberate and stays out of editors', () => {
  assert.equal(isTerminalFindShortcut({ key: 'f', ctrlKey: true }), true);
  assert.equal(isTerminalFindShortcut({ key: 'F', metaKey: true }), true);
  assert.equal(isTerminalFindShortcut({ key: 'f', ctrlKey: true }, true), false);
  assert.equal(isTerminalFindShortcut({ key: 'f', ctrlKey: true, shiftKey: true }), false);
  assert.equal(isTerminalFindShortcut({ key: 'f' }), false);
  assert.equal(isTerminalFindShortcut(null), false);
});

test('terminal capture pause messaging stays explicit that the agent keeps running', () => {
  assert.deepEqual(terminalRefreshPresentation(false), {
    label: 'Pause',
    pressed: false,
    description: 'Pause live terminal capture while the agent keeps running',
    notice: 'Live capture resumed. The agent was never paused.'
  });
  assert.deepEqual(terminalRefreshPresentation(true), {
    label: 'Resume',
    pressed: true,
    description: 'Resume live terminal capture',
    notice: 'Live capture paused. The agent keeps running.'
  });
});

test('terminal tab keys wrap predictably and mobile switcher labels include the target name', () => {
  assert.equal(terminalTabKeyIndex('ArrowRight', 2, 3), 0);
  assert.equal(terminalTabKeyIndex('ArrowLeft', 0, 3), 2);
  assert.equal(terminalTabKeyIndex('Home', 2, 3), 0);
  assert.equal(terminalTabKeyIndex('End', 0, 3), 2);
  assert.equal(terminalTabKeyIndex('Enter', 1, 3), -1);
  assert.equal(terminalTabKeyIndex('ArrowRight', 0, 0), -1);

  assert.equal(terminalSwitcherLabel(1, 4, 'Poker server'), '2 of 4 · Poker server');
  assert.equal(terminalSwitcherLabel(1, 4, 'Poker server', 'Working'), '2 of 4 · Poker server · Working');
  assert.equal(terminalSwitcherLabel(0, 1, 'Poker server', '  '), '1 of 1 · Poker server');
  assert.equal(terminalSwitcherLabel(0, 1, '  '), '1 of 1 · Terminal');
  assert.equal(terminalSwitcherLabel(0, 1, null), '1 of 1 · Terminal');
  assert.equal(terminalSwitcherLabel(-1, 3, 'Poker server'), 'Minimized terminal');
  assert.equal(terminalSwitcherLabel(4, 3, 'Poker server'), 'Minimized terminal');
  assert.equal(terminalSwitcherLabel(Number.NaN, Number.NaN, null), 'Minimized terminal');
});

test('terminal view controls clearly avoid agent lifecycle actions', async () => {
  const app = await uiSource('app.js');
  const closeStart = app.indexOf('function closeTerminalWindow(item, { announce = false } = {})');
  const closeEnd = app.indexOf('function minimizeTerminalWindow(item)', closeStart);
  const minimizeEnd = app.indexOf('function restoreTerminalWindow(item)', closeEnd);
  assert.ok(closeStart >= 0 && closeEnd > closeStart && minimizeEnd > closeEnd);

  const closeSource = app.slice(closeStart, closeEnd);
  const minimizeSource = app.slice(closeEnd, minimizeEnd);
  assert.doesNotMatch(closeSource, /api\(|sessionAction|\/stop|\/interrupt/);
  assert.doesNotMatch(minimizeSource, /api\(|sessionAction|\/stop|\/interrupt/);
  assert.match(closeSource, /The agent keeps running; reopen it from Sessions/);
  assert.match(minimizeSource, /The agent and your draft stay active/);
  assert.match(app, /terminal-control-label-mobile" aria-hidden="true">Back<\/span>/);
  assert.match(app, /terminal-control-label-desktop" aria-hidden="true">Dock<\/span>/);
  assert.match(app, /const closeViewLabel = mode === 'static' \? 'Close terminal view' : 'Close terminal view; agent keeps running'/);
  assert.match(app, /title="\$\{closeViewLabel\}" aria-label="\$\{closeViewLabel\}"/);
  assert.match(app, /case 'terminal-close':[\s\S]*closeTerminalWindow\(terminalItem, \{ announce: true \}\)/);
});

test('session status filters classify operational states and compose with text search', () => {
  assert.equal(sessionFilterCategory({ state: 'waiting', tone: 'warn' }), 'needs');
  assert.equal(sessionFilterCategory({ state: 'stopped', tone: 'bad' }), 'needs');
  assert.equal(sessionFilterCategory({ state: 'busy', tone: 'good' }, 2), 'needs');
  assert.equal(sessionFilterCategory({ state: 'busy', tone: 'good' }), 'active');
  assert.equal(sessionFilterCategory({ state: 'idle', tone: 'good' }), 'idle');
  assert.equal(sessionFilterCategory({ state: 'unknown', tone: 'warn' }), 'other');
  assert.equal(sessionFilterCategory(null), 'other');

  assert.equal(sessionFilterMatches('all', 'other', 'Codex Poker', ''), true);
  assert.equal(sessionFilterMatches('active', 'active', 'Codex Poker', ' poker '), true);
  assert.equal(sessionFilterMatches('active', 'idle', 'Codex Poker', 'poker'), false);
  assert.equal(sessionFilterMatches('needs', 'needs', 'Codex Poker', 'missing'), false);
  assert.equal(sessionFilterMatches('invalid', 'other', 'Codex Poker', 'CODEX'), true);
  assert.equal(sessionFilterMatches('idle', 'idle', null, null), true);
  assert.equal(sessionFilterMatches('idle', 'idle', null, 'missing'), false);
});

test('session cards spell out live state without relying on color', () => {
  assert.deepEqual(sessionStatusPresentation({ state: 'busy', tone: 'good' }), {
    label: 'Working',
    tone: 'working',
    description: 'This session is actively working.'
  });
  assert.deepEqual(sessionStatusPresentation({ state: 'idle', tone: 'good', reason: 'Composer is ready' }), {
    label: 'Ready',
    tone: 'ready',
    description: 'Composer is ready'
  });
  assert.equal(sessionStatusPresentation({ state: 'busy', tone: 'good' }, 1).label, 'Needs you');
  assert.equal(sessionStatusPresentation({ state: 'waiting', tone: 'warn' }).tone, 'needs');
  assert.equal(sessionStatusPresentation({ state: 'stopped', tone: 'bad' }).label, 'Stopped');
  assert.equal(sessionStatusPresentation({ state: 'idle', tone: 'bad' }).label, 'Check');
  assert.equal(sessionStatusPresentation({ state: 'goal-achieved', tone: 'good' }).label, 'Goal Achieved');
  assert.equal(sessionStatusPresentation({ state: '   ', tone: ' ' }).label, 'Unknown');
  assert.deepEqual(sessionStatusPresentation(null), {
    label: 'Unknown',
    tone: 'neutral',
    description: 'Session state: Unknown.'
  });
});

test('session pin controls explain ordering instead of relying on ambiguous dots', () => {
  assert.deepEqual(sessionPinPresentation(false, 'Poker server'), {
    symbol: '☆',
    visibleLabel: 'Pin',
    actionLabel: 'Pin Poker server to top',
    title: 'Pin this session to the top.'
  });
  assert.deepEqual(sessionPinPresentation(true, 'Poker server'), {
    symbol: '★',
    visibleLabel: 'Pinned',
    actionLabel: 'Unpin Poker server',
    title: 'Pinned to top. Activate to return this session to recent order.'
  });
  assert.equal(sessionPinPresentation(false, '  ').actionLabel, 'Pin session to top');
  assert.equal(sessionPinPresentation(true, null).actionLabel, 'Unpin session');
});

test('session search keys only target visible results and stay clear of modified input', () => {
  assert.equal(sessionSearchKeyAction({ key: 'Enter' }, 2, 'codex'), 'open-first');
  assert.equal(sessionSearchKeyAction({ key: 'ArrowDown' }, 2, 'codex'), 'focus-first');
  assert.equal(sessionSearchKeyAction({ key: 'ArrowUp' }, 2, 'codex'), 'focus-last');
  assert.equal(sessionSearchKeyAction({ key: 'Escape' }, 2, 'codex'), 'clear');
  assert.equal(sessionSearchKeyAction({ key: 'Enter' }, 0, 'codex'), null);
  assert.equal(sessionSearchKeyAction({ key: 'Escape' }, 2, ''), null);
  assert.equal(sessionSearchKeyAction({ key: 'Enter', ctrlKey: true }, 2, 'codex'), null);
  assert.equal(sessionSearchKeyAction({ key: 'ArrowDown', altKey: true }, 2, 'codex'), null);
  assert.equal(sessionSearchKeyAction({ key: 'ArrowDown', shiftKey: true }, 2, 'codex'), null);
  assert.equal(sessionSearchKeyAction({ key: 'Enter', isComposing: true }, 2, 'codex'), null);
  assert.equal(sessionSearchKeyAction(null, Number.NaN, null), null);
});

test('session result counts distinguish the full rail from a constrained result set', () => {
  assert.deepEqual(sessionResultCountPresentation(12, 12, false), {
    label: '12',
    description: '12 sessions'
  });
  assert.deepEqual(sessionResultCountPresentation(1, 1, false), {
    label: '1',
    description: '1 session'
  });
  assert.deepEqual(sessionResultCountPresentation(3, 12, true), {
    label: '3/12',
    description: '3 of 12 sessions visible'
  });
  assert.deepEqual(sessionResultCountPresentation(20, 12, true), {
    label: '12/12',
    description: '12 of 12 sessions visible'
  });
  assert.deepEqual(sessionResultCountPresentation(-2, Number.NaN, true), {
    label: '0/0',
    description: '0 of 0 sessions visible'
  });
  assert.deepEqual(sessionResultCountPresentation(Number.NaN, 5, true), {
    label: '0/5',
    description: '0 of 5 sessions visible'
  });
});

test('new terminal output starts at the newest line without overriding later manual scroll', () => {
  assert.equal(shouldStickTerminalOutput({ scrollToBottomOnNextOutput: true, forceScrollUntil: 0 }, false, 100), true);
  assert.equal(shouldStickTerminalOutput({ scrollToBottomOnNextOutput: false, forceScrollUntil: 101 }, false, 100), true);
  assert.equal(shouldStickTerminalOutput({ scrollToBottomOnNextOutput: false, forceScrollUntil: 0 }, true, 100), true);
  assert.equal(shouldStickTerminalOutput({ scrollToBottomOnNextOutput: false, forceScrollUntil: 100 }, false, 100), false);
  assert.equal(shouldStickTerminalOutput(null, false, Number.NaN), false);
});

test('terminal tabs preserve manual browsing and reveal only a newly focused tab', () => {
  assert.equal(terminalTabScrollLeft(300, 120, 30, 90, false), 120);
  assert.equal(terminalTabScrollLeft(300, 120, 30, 90, true), 30);
  assert.equal(terminalTabScrollLeft(300, 120, -6, 40, true), 0);
  assert.equal(terminalTabScrollLeft(300, 120, 240, 460, true), 160);
  assert.equal(terminalTabScrollLeft(300, 120, 180, 260, true), 120);
});

test('terminal latest control distinguishes reading history from unseen output', () => {
  assert.deepEqual(terminalLatestPresentation(true, false), {
    hidden: true,
    label: 'Latest ↓',
    description: 'Showing latest terminal output'
  });
  assert.deepEqual(terminalLatestPresentation(false, false), {
    hidden: false,
    label: 'Latest ↓',
    description: 'Jump to latest terminal output'
  });
  assert.deepEqual(terminalLatestPresentation(false, true), {
    hidden: false,
    label: 'New output ↓',
    description: 'New terminal output available; jump to latest'
  });
});

test('terminal focus is inspection-first on phones and typing-first on desktop', () => {
  assert.equal(terminalFocusKind(false, true), 'output');
  assert.equal(terminalFocusKind(false, false), 'output');
  assert.equal(terminalFocusKind(true, false), 'output');
  assert.equal(terminalFocusKind(true, true), 'editor');
});

test('terminal composer presentation keeps reading mode explicit and preserves draft visibility', () => {
  assert.deepEqual(terminalComposerPresentation(true, false), {
    label: 'Reply',
    description: 'Expand terminal reply composer'
  });
  assert.deepEqual(terminalComposerPresentation(true, true), {
    label: 'Reply · draft',
    description: 'Expand terminal reply composer; draft saved'
  });
  assert.deepEqual(terminalComposerPresentation(false, false), {
    label: 'Hide',
    description: 'Collapse terminal reply composer'
  });
  assert.deepEqual(terminalComposerPresentation(false, true), {
    label: 'Hide',
    description: 'Collapse terminal reply composer; draft saved'
  });
  assert.deepEqual(terminalComposerPresentation(true, true, false), {
    label: 'Reply · draft',
    description: 'Expand terminal reply composer; draft not saved'
  });

  assert.deepEqual(terminalDraftPresentation('', false, false, true), {
    label: 'No draft',
    tone: 'neutral',
    description: 'No terminal reply draft.'
  });
  assert.equal(terminalDraftPresentation('hello').label, 'Draft saved');
  assert.equal(terminalDraftPresentation('hello', false, false, false).label, 'Draft not saved');
  assert.equal(terminalDraftPresentation('', true).label, 'Paste awaiting review');
  assert.equal(terminalDraftPresentation('hello', true, true, false).label, 'Sending...');
});

test('finished prompt origin filters use durable schedule metadata', () => {
  const mine = { id: 'mine', session: 'codex-poker', text: 'Review mobile table', target: { displayName: 'Poker mobile' } };
  const automated = { id: 'auto', scheduleId: 'schedule-nightly-12345678', text: 'Nightly checks', completionSnapshot: 'All tests passed', summaryState: 'captured' };
  const items = [mine, automated];
  assert.equal(promptHistoryOrigin(mine), 'mine');
  assert.equal(promptHistoryOrigin(automated), 'automated');
  assert.equal(promptHistoryOrigin(null), 'mine');
  assert.match(promptHistorySearchValue(mine), /poker mobile codex-poker review mobile table/);
  assert.match(promptHistorySearchValue(automated), /nightly checks all tests passed captured/);
  assert.equal(promptHistorySearchValue(null), '');
  assert.deepEqual(filterPromptHistory(items, 'all'), items);
  assert.deepEqual(filterPromptHistory(items, 'mine'), [mine]);
  assert.deepEqual(filterPromptHistory(items, 'automated'), [automated]);
  assert.deepEqual(filterPromptHistory(items, 'all', ' POKER '), [mine]);
  assert.deepEqual(filterPromptHistory(items, 'automated', 'tests passed'), [automated]);
  assert.deepEqual(filterPromptHistory(items, 'mine', 'nightly'), []);
  assert.deepEqual(filterPromptHistory(items, 'all', '   '), items);
  assert.deepEqual(filterPromptHistory(items, 'invalid'), items);
  assert.deepEqual(filterPromptHistory(null, 'mine'), []);
});

test('Prompt Queue section navigation is allowlisted to stable in-view targets', () => {
  assert.equal(promptQueueSectionTarget('compose'), '#prompt-queue-compose');
  assert.equal(promptQueueSectionTarget('ACTIVE'), '#prompt-queue-active');
  assert.equal(promptQueueSectionTarget('schedules'), '#prompt-queue-schedules');
  assert.equal(promptQueueSectionTarget('history'), '#prompt-queue-history');
  assert.equal(promptQueueSectionTarget('tools'), null);
  assert.equal(promptQueueSectionTarget(''), null);
  assert.equal(promptQueueSectionTarget(null), null);
});

test('Prompt Queue composer exposes honest readiness and deliberate desktop submit shortcuts', () => {
  assert.deepEqual(promptQueueComposerPresentation({ session: 'codex', text: 'Next task', cron: '' }, true), {
    label: 'Add prompt', sendLabel: 'Send now', disabled: false, sendDisabled: false, selectedCount: 1, count: '9/4000', full: false, hasDraft: true
  });
  assert.deepEqual(promptQueueComposerPresentation({ session: 'codex', text: 'Next task', cron: '0 * * * *' }, true), {
    label: 'Create schedule', sendLabel: 'Send now', disabled: false, sendDisabled: true, selectedCount: 1, count: '9/4000', full: false, hasDraft: true
  });
  assert.equal(promptQueueComposerPresentation({ session: '', text: 'Next task' }, true).disabled, true);
  assert.equal(promptQueueComposerPresentation({ session: 'codex', text: '   ' }, true).disabled, true);
  assert.deepEqual(promptQueueComposerPresentation({ session: 'codex', text: '', cron: '0 * * * *' }, true), {
    label: 'Create schedule', sendLabel: 'Send now', disabled: true, sendDisabled: true, selectedCount: 1, count: '0/4000', full: false, hasDraft: true
  });
  assert.equal(promptQueueComposerPresentation({ session: 'codex', text: 'Next task' }, false).disabled, true);
  assert.deepEqual(promptQueueComposerPresentation({ session: 'codex', text: 'x'.repeat(4000) }, true), {
    label: 'Add prompt', sendLabel: 'Send now', disabled: false, sendDisabled: false, selectedCount: 1, count: '4000/4000', full: true, hasDraft: true
  });
  assert.deepEqual(promptQueueComposerPresentation(null, true), {
    label: 'Add prompt', sendLabel: 'Send now', disabled: true, sendDisabled: true, selectedCount: 0, count: '0/4000', full: false, hasDraft: false
  });
  assert.deepEqual(promptQueueComposerPresentation({ sessions: ['codex', 'codex2'], text: 'Fan out', cron: '' }, true), {
    label: 'Queue for 2', sendLabel: 'Send now to 2', disabled: false, sendDisabled: false, selectedCount: 2, count: '7/4000', full: false, hasDraft: true
  });
  assert.equal(promptQueueComposerPresentation({ sessions: ['codex', 'codex2'], text: 'Fan out', cron: '0 * * * *' }, true).disabled, true);

  assert.deepEqual(normalizedPromptQueueDraft({ session: 'codex', text: 'hello', cron: ' 0 * * * * ' }), {
    session: 'codex', sessions: ['codex'], text: 'hello', cron: '0 * * * *'
  });
  assert.deepEqual(normalizedPromptQueueDraft({ session: 's'.repeat(140), text: 'x'.repeat(4010), cron: ` ${'c'.repeat(90)} ` }), {
    session: 's'.repeat(128), sessions: ['s'.repeat(128)], text: 'x'.repeat(4000), cron: 'c'.repeat(80)
  });
  assert.deepEqual(normalizedPromptQueueDraft({ sessions: ['codex', 'codex2', 'codex'], text: 'same' }), {
    session: 'codex', sessions: ['codex', 'codex2'], text: 'same', cron: ''
  });
  assert.deepEqual(normalizedPromptQueueDraft(null), { session: '', sessions: [], text: '', cron: '' });
  assert.deepEqual(normalizedPromptQueueDraft('invalid'), { session: '', sessions: [], text: '', cron: '' });

  assert.equal(isPromptQueueSubmitShortcut({ key: 'Enter', ctrlKey: true }), true);
  assert.equal(isPromptQueueSubmitShortcut({ key: 'ENTER', metaKey: true }), true);
  assert.equal(isPromptQueueSubmitShortcut({ key: 'Enter', ctrlKey: true, isComposing: true }), false);
  assert.equal(isPromptQueueSubmitShortcut({ key: 'Enter', ctrlKey: true, shiftKey: true }), false);
  assert.equal(isPromptQueueSubmitShortcut({ key: 'Enter', metaKey: true, altKey: true }), false);
  assert.equal(isPromptQueueSubmitShortcut({ key: 'Enter' }), false);
  assert.equal(isPromptQueueSubmitShortcut({ key: 'x', ctrlKey: true }), false);
  assert.equal(isPromptQueueSubmitShortcut(null), false);
});

test('Project Desk keeps stale content visible while automatically revalidating its bounded cache', async () => {
  const app = await uiSource('app.js');
  assert.match(app, /const PROJECT_CONTEXT_CACHE_MS = 5_000/);
  assert.match(app, /projectContextCacheFresh\(cached, Date\.now\(\), PROJECT_CONTEXT_CACHE_MS\)/);
  assert.match(app, /contextCache\.set\(target\.key, \{ context, fetchedAt: Date\.now\(\) \}\)/);
  assert.match(app, /const fallbackContext = cached\?\.context \|\| null/);
  assert.match(app, /state\.projectDesk\.context = fallbackContext/);
  assert.doesNotMatch(app, /contextCache\.delete\(nextTarget\.key\)/);
});

test('terminal layouts produce bounded 1, 2, and 4 pane slots', () => {
  assert.deepEqual(terminalLayoutSlots('free', 4, 1000, 700), []);
  assert.equal(terminalLayoutSlots('focus', 4, 1000, 700).length, 1);

  const split = terminalLayoutSlots('split', 4, 1000, 700, 10);
  assert.equal(split.length, 2);
  assert.deepEqual(split[0], { left: 0, top: 0, width: 495, height: 700 });
  assert.deepEqual(split[1], { left: 505, top: 0, width: 495, height: 700 });

  const grid = terminalLayoutSlots('grid', 8, 1000, 700, 10);
  assert.equal(grid.length, 4);
  assert.deepEqual(grid[3], { left: 505, top: 355, width: 495, height: 345 });

  assert.deepEqual(terminalLayoutSlots('unknown', 4, -1, 'invalid'), []);
  assert.deepEqual(terminalLayoutSlots('grid', 0, 1000, 700), []);
  assert.deepEqual(terminalLayoutSlots('focus', 1, undefined, undefined), [{
    left: 0,
    top: 0,
    width: 0,
    height: 0
  }]);
});

test('desktop terminal frames preserve shell context while phones retain the full screen', () => {
  const layer = { left: 0, top: 0, width: 1920, height: 1080 };
  const fallback = { left: 220, top: 82 };
  const stage = { left: 500, top: 112, right: 1400, bottom: 932, width: 900, height: 820 };

  assert.deepEqual(terminalWorkspaceFrame(layer, stage, fallback, true), {
    left: 500,
    top: 112,
    width: 1420,
    height: 968
  });
  assert.deepEqual(terminalWorkspaceFrame(layer, stage, fallback, true, true), {
    left: 500,
    top: 112,
    width: 900,
    height: 820
  });
  assert.deepEqual(terminalWorkspaceFrame(layer, { left: 0, top: 0, width: 0, height: 820 }, fallback, true), {
    left: 220,
    top: 82,
    width: 1700,
    height: 998
  });
  assert.deepEqual(terminalWorkspaceFrame(layer, { left: 0, top: 0, width: 900, height: 0 }, fallback, true), {
    left: 220,
    top: 82,
    width: 1700,
    height: 998
  });
  assert.deepEqual(terminalWorkspaceFrame(layer, { left: 0, top: 0, width: 0, height: 0 }, fallback, true, true), {
    left: 220,
    top: 82,
    width: 1700,
    height: 998
  });
  assert.deepEqual(terminalWorkspaceFrame({ left: 7, top: 9, width: 390, height: 844 }, { left: 80, top: 100, width: 200, height: 600 }, fallback, false), {
    left: 0,
    top: 0,
    width: 390,
    height: 844
  });
});

test('live UI keeps terminal controls and literal-send safety paths while adding terminal workflow features', async () => {
  const [app, styles] = await Promise.all([uiSource('app.js'), uiSource('styles.css')]);

  assert.doesNotMatch(app, /if \(missionCapability\) switchView\('queue'\)/);
  assert.match(app, /switchView\('agents'\)/);
  assert.match(app, /data-action="terminal-minimize"/);
  assert.match(app, /data-action="terminal-maximize"/);
  assert.match(app, /data-action="terminal-close"/);
  assert.match(app, /data-terminal-resize="nw"/);
  assert.match(app, /class="terminal-send-text"/);
  assert.match(app, /data-command="\/model"/);
  assert.match(app, /data-action="terminal-ui-key" data-key="select"/);
  assert.match(app, /api\('\/api\/agent\/send'/);
  assert.match(app, /api\('\/api\/agent\/send-batch'/);
  assert.match(app, /api\('\/api\/agent\/ui-key'/);
  assert.match(app, /api\('\/api\/prompt-queue\/batch'/);
  assert.match(app, /confirm: 'send-multiple'/);
  assert.match(app, /confirm: 'queue-multiple'/);
  assert.match(app, /data-action="prompt-queue-cancel"/);
  assert.match(app, /data-action="prompt-schedule-toggle"/);
  assert.match(app, /data-action="prompt-schedule-delete"/);
  assert.match(app, /data-action="prompt-schedule-retarget"/);
  assert.match(app, /Retarget required/);
  assert.match(app, /Retarget this schedule before resuming it/);
  assert.match(app, /data-action="prompt-queue-retarget"/);
  assert.match(app, /confirm: 'retarget-schedule'/);
  assert.match(app, /confirm: 'retarget-queued-prompt'/);
  assert.match(app, /Nothing was sent during recovery/);
  assert.match(app, /const exactTerminalAvailable = item\.target\?\.identityMatches === true/);
  assert.match(app, /exactTerminalAvailable[\s\S]*Open exact terminal[\s\S]*retargetable[\s\S]*Open replacement[\s\S]*Exact terminal unavailable/);
  assert.doesNotMatch(app, /const openPaneId = replacement\?\.id \|\| item\.paneId/);
  assert.match(app, /name="cron"[^>]*list="prompt-cron-presets"/);
  assert.match(app, /0 9 \* \* 1-5/);
  assert.match(app, /Recurring prompts/);
  assert.match(app, /coalesces that occurrence/);
  assert.match(app, /function promptScheduleDisplayOrder\(left, right\)/);
  assert.match(app, /const enabledDelta = Number\(right\.enabled\) - Number\(left\.enabled\)/);
  assert.match(app, /const orderedSchedules = \[\.\.\.schedules\]\.sort\(promptScheduleDisplayOrder\)/);
  assert.match(app, /orderedSchedules\.map\(\(schedule\) => promptScheduleCard\(schedule, items\)\)/);
  assert.match(app, /function promptScheduleAbsoluteLabel\(value\)/);
  assert.match(app, /timeZoneName: 'short'/);
  assert.match(app, /const nextRunTitle = promptScheduleAbsoluteLabel\(schedule\.nextRunAt\)/);
  assert.match(app, /<b>Occurrences<\/b>/);
  assert.match(app, /<b>Coalesced<\/b>/);
  assert.match(app, /One occurrence is already in the queue/);
  assert.match(styles, /\.prompt-schedule-pending\s*\{/);
  assert.match(app, /class="prompt-target-board"/);
  assert.match(app, /data-action="prompt-queue-select-target"/);
  assert.match(app, /data-action="prompt-queue-select-all"/);
  assert.match(app, /Queue delivery still uses each terminal's independent readiness gate/);
  assert.match(app, /waitingQueueCount/);
  assert.match(app, /finishingCount/);
  assert.match(app, /<\/strong> waiting<\/span>/);
  assert.match(app, /<\/strong> finishing<\/span>/);
  assert.match(app, /class="prompt-queue-stats"/);
  assert.match(app, /const waitingNow = items\.filter\(\(item\) => item\.status === 'queued'\)\.length/);
  assert.match(app, /const finishingNow = items\.filter\(promptQueueAwaitingFinish\)\.length/);
  assert.match(app, /digestMetric\('Waiting now', waitingNow/);
  assert.match(app, /digestMetric\('Finishing now', finishingNow/);
  assert.doesNotMatch(app, /digestMetric\('Ready terminals'/);
  assert.match(app, /Finished queue turns/);
  assert.match(app, /never claims the underlying project task is Done/);
  assert.match(app, /const visibleFinished = finished\.slice\(0, 12\)/);
  assert.match(app, /const olderFinished = finished\.slice\(12\)/);
  assert.match(app, /class="prompt-canceled-history prompt-older-history"/);
  assert.match(app, /older finished turn/);
  assert.match(app, /Accepted turns/);
  assert.match(app, /Blue · agent working/);
  assert.match(app, /Green · verifying return/);
  assert.match(app, /promptQueueAwaitingFinish/);
  assert.match(app, /delivered without a confirmed final response/);
  assert.match(app, /item\.completionSnapshot/);
  assert.match(app, /item\.completionSummary/);
  const promptQueueRenderStart = app.indexOf('function renderPromptQueue(promptQueue, agents)');
  const promptQueueRenderEnd = app.indexOf('function renderMissionQueue', promptQueueRenderStart);
  const promptQueueRenderSource = app.slice(promptQueueRenderStart, promptQueueRenderEnd);
  assert.ok(promptQueueRenderStart >= 0 && promptQueueRenderEnd > promptQueueRenderStart);
  assert.match(promptQueueRenderSource, /const activeQueueSection =/);
  assert.match(promptQueueRenderSource, /\$\{activeLanes\.length \? activeQueueSection : ''\}[\s\S]*class="mission-hero prompt-queue-hero"/);
  assert.match(promptQueueRenderSource, /promptSchedulePanel\(schedules, items\)[\s\S]*\$\{activeLanes\.length \? '' : activeQueueSection\}/);
  assert.match(app, /if \(!\['agents', 'queue'\]\.includes\(view\)\) return/);
  assert.doesNotMatch(app, /setOpenDrawer\('queue'/);
  assert.match(app, /Queue creates one independent FIFO item per terminal/);
  assert.match(app, /agent\.queueReady === true/);
  assert.match(app, /persistTerminalDraft/);
  assert.match(app, /navigateTerminalHistory/);
  assert.match(app, /previewTerminalPaste/);
  assert.match(app, /terminalWorkspace\.classList\.toggle\('has-open-terminals', count > 0\)/);
  assert.match(app, /syncProjectDesk\(\)/);
  assert.match(app, /function launcherWorkspaceForProject\(requestedWorkspace\)/);
  assert.match(app, /function nextAgentNameForWorkspace\(workspace\)/);
  assert.match(app, /case 'project-new-agent':[\s\S]*projectContextWorkspace\(state\.projectDesk\.context, state\.projectDesk\.target\)/);
  assert.match(app, /\/api\/project-desk\/\$\{encodeURIComponent\(target\.session\)\}/);
  assert.match(app, /\/artifacts\/\$\{encodeURIComponent\(artifact\.id\)\}/);
  assert.match(app, /class="project-artifact-row"/);
  assert.match(app, /data-action="project-artifact-download"/);
  assert.match(app, /data-artifact-url="\$\{escapeHtml\(url\)\}"/);
  assert.match(app, /data-artifact-name="\$\{escapeHtml\(artifact\.name\)\}"/);
  assert.match(app, /state\.snapshot\?\.capabilities\?\.projectArtifacts === true/);
  assert.match(app, /function projectArtifactTimestamp\(value\)/);
  assert.match(app, /modified \? `Modified \$\{modified\}` : ''/);
  assert.match(app, /async function projectArtifactDownload\(button\)/);
  assert.match(app, /response\.headers\.get\('content-type'\)/);
  assert.match(app, /PROJECT_ARTIFACT_CONTENT_TYPES\.has\(contentType\)/);
  assert.match(app, /markdown: '\.md'/);
  assert.match(app, /html: '\.html'/);
  assert.match(app, /URL\.createObjectURL\(blob\)/);
  assert.match(app, /URL\.revokeObjectURL\(objectUrl\)/);
  const artifactDownloadStart = app.indexOf('async function projectArtifactDownload(button)');
  const artifactDownloadEnd = app.indexOf('function renderProjectMission', artifactDownloadStart);
  const artifactDownloadSource = app.slice(artifactDownloadStart, artifactDownloadEnd);
  assert.ok(artifactDownloadStart >= 0 && artifactDownloadEnd > artifactDownloadStart);
  assert.match(artifactDownloadSource, /data\.error === 'control_session_required' && attempt === 0/);
  assert.match(artifactDownloadSource, /await refreshControlSession\(controller\.signal\)/);
  assert.match(artifactDownloadSource, /credentials: 'same-origin'/);
  assert.match(artifactDownloadSource, /headers: \{ accept: 'application\/pdf, text\/markdown, text\/html' \}/);
  assert.doesNotMatch(app, /file:\/\//);
  assert.match(app, /scratchpadDraftKey/);
  assert.match(app, /SCRATCHPAD_SNIPPETS_KEY/);
  assert.match(app, /sameExactTarget/);
  assert.match(app, /state\.snapshot\?\.capabilities\?\.projectDesk === true/);
  assert.match(app, /restart PaneFleet to enable exact-target Review and Send/);
  assert.match(app, /sessionCreatedAt: target\.sessionCreatedAt/);
  assert.match(app, /paneId: target\.paneId/);
  assert.match(app, /tmuxPaneId: target\.tmuxPaneId/);
  assert.match(app, /panePid: target\.panePid/);
  assert.match(app, /case 'terminal-layout'/);
  assert.match(app, /case 'workspace-focus-toggle'/);
  assert.match(app, /shortcut === 'workspace-focus'/);
  assert.match(app, /classList\.toggle\('is-canvas-focused', workspaceFocusApplies\(state\.workspaceFocus, state\.activeView\)\)/);
  assert.match(app, /state\.activeView = view;\s*syncWorkspaceFocus\(\);/);
  assert.match(app, /safeStorageSet\(WORKSPACE_FOCUS_STORAGE_KEY, state\.workspaceFocus \? 'true' : 'false'\)/);
  assert.match(styles, /\.app-shell\.is-canvas-focused \.terminal-home\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /\.session-list\s*\{[\s\S]*max-height: min\(46dvh, 420px\)/);
  assert.match(app, /case 'terminal-full-height'/);
  assert.match(app, /function setTerminalFullHeight/);
  assert.match(app, /terminalFullHeightBounds/);
  assert.match(app, /terminalWorkspaceFrame/);
  assert.match(app, /window\.matchMedia\(TERMINAL_ULTRAWIDE_QUERY\)\.matches/);
  assert.match(app, /dashboardShortcut\(event, editableTarget\)/);
  assert.match(app, /case 'terminal-cycle-active':[\s\S]*cycleActiveTerminal\(Number\(target\.dataset\.direction\)\)/);
  assert.match(app, /shortcut === 'terminal-previous' \|\| shortcut === 'terminal-next'/);
  assert.match(app, /button\.disabled = switchableItems\.length < 2/);
  assert.match(app, /openToolView\(state\.activeToolView\)/);
  assert.match(app, /if \(next === 'tools'\)[\s\S]*openToolView\(state\.activeToolView\)/);
  assert.match(app, /preferredDashboardView\(window\.location\.hash, safeStorageGet\(ACTIVE_VIEW_STORAGE_KEY, 'agents'\)\)/);
  assert.match(app, /safeStorageSet\(ACTIVE_VIEW_STORAGE_KEY, view\)/);
  assert.match(app, /window\.history\.replaceState\(null, '', nextHash\)/);
  assert.match(app, /window\.addEventListener\('hashchange'/);
  assert.match(app, /els\.workspaceTitle\.textContent = queueActive \? 'Prompt Queue' : 'Agent workspace'/);
  assert.match(app, /const presentation = connectionStatePresentation\(value\)/);
  assert.match(app, /els\.connectionPill\.setAttribute\('aria-label', presentation\.description\)/);
  assert.match(app, /els\.refresh\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(app, /function dismissNotice\(\)/);
  assert.match(app, /els\.noticeMessage\.textContent = message/);
  assert.match(app, /noticeAutoDismissMs\(kind\)/);
  assert.match(app, /revision === noticeRevision/);
  assert.match(app, /case 'notice-dismiss':/);
  assert.match(app, /function openShortcutHelp\(trigger = document\.activeElement\)/);
  assert.match(app, /function closeShortcutHelp/);
  assert.match(app, /function handleShortcutHelpKeydown/);
  assert.match(app, /case 'shortcut-help-open':/);
  assert.match(app, /case 'shortcut-help-close':/);
  assert.match(app, /if \(handleShortcutHelpKeydown\(event\)\) return/);
  assert.match(app, /shortcut === 'shortcuts'/);
  assert.match(app, /function syncDecisionAppBadge\(decisionCount\)/);
  assert.match(app, /globalThis\.navigator\?\.setAppBadge\?\.\(count\)/);
  assert.match(app, /globalThis\.navigator\?\.clearAppBadge\?\.\(\)/);
  assert.match(app, /document\.title = dashboardDocumentTitle\(\{/);
  assert.match(app, /connection: els\.liveState\?\.dataset\.state \|\| 'init'/);
  assert.match(app, /const TERMINAL_RESTORE_STORAGE_KEY = 'host-control:open-terminals:v1'/);
  assert.match(app, /function persistTerminalWorkspace\(\)/);
  assert.match(app, /function restoreTerminalWorkspace\(\)/);
  assert.match(app, /candidate\.session === record\.session[\s\S]*candidate\.sessionCreatedAt[\s\S]*candidate\.id/);
  assert.match(app, /refreshPaused: record\.refreshPaused,[\s\S]*restoredFreeBounds: record\.freeBounds/);
  assert.match(app, /if \(!item\.refreshPaused\) refreshTerminalWindow\(item\)/);
  assert.match(app, /const applyRestoredFreeBounds = \(\) =>/);
  assert.match(app, /captureTerminalFreeBounds\(item\);[\s\S]*persistTerminalWorkspace\(\);/);
  assert.match(app, /restoreTerminalWorkspace\(\);[\s\S]*syncOpenTerminalWindows/);
  assert.match(app, /persistTerminalWorkspace\(\);/);
  assert.match(app, /class="terminal-mobile-switcher hidden"[^>]*aria-label="Switch open terminal"/);
  assert.match(app, /class="terminal-mobile-select" aria-label="Choose open terminal"/);
  assert.match(app, /data-action="terminal-cycle-prev"/);
  assert.match(app, /data-action="terminal-cycle-next"/);
  assert.match(app, /const nextIndex = cycledItemIndex\(items\.indexOf\(item\), items\.length, direction\)/);
  assert.match(app, /switchableItems\.length > 1 && position >= 0/);
  assert.match(app, /const switcherLabel = terminalSwitcherLabel\(position, switchableItems\.length, displayName, signal\.label\)/);
  assert.match(app, /function terminalSelectorOptions\(items\)/);
  assert.match(app, /function syncTerminalSelector\(select, items, selectedId = ''\)/);
  assert.match(app, /item\.mobileSwitcher\.setAttribute\('aria-label', `Switch open terminal\. Current: \$\{switcherLabel\}\. Choose a named terminal or use previous and next\.`\)/);
  assert.match(app, /event\.target === els\.terminalJumpSelect \|\| event\.target\?\.classList\?\.contains\('terminal-mobile-select'\)/);
  assert.match(app, /activateTerminalWindow\(state\.terminalWindows\.get\(event\.target\.value\)\)/);
  assert.match(app, /role="tab" aria-selected="\$\{active \? 'true' : 'false'\}"[^>]*aria-controls="\$\{escapeHtml\(item\.id\)\}"[^>]*aria-keyshortcuts="ArrowLeft ArrowRight Home End"/);
  assert.match(app, /class="terminal-tab-copy"><strong>\$\{escapeHtml\(displayName\)\}<\/strong><span class="terminal-tab-status \$\{escapeHtml\(signal\.tone\)\}">/);
  assert.match(app, /const focusLabel = `\$\{active \? 'Current' : 'Focus'\} \$\{displayName\} terminal\. \$\{signal\.label\}\.`/);
  assert.match(app, /function terminalSignal\(item\)/);
  assert.match(app, /function syncTerminalHeaderStatus\(item\)/);
  assert.match(app, /item\.headerStatus\.setAttribute\('aria-label', `Agent state: \$\{signal\.label\}\. \$\{signal\.description\}`\)/);
  assert.match(app, /class="terminal-heading-row"><h2 id="\$\{id\}-title" class="terminal-title"><\/h2><span class="terminal-header-status neutral"/);
  assert.match(app, /headerStatus: element\.querySelector\('\.terminal-header-status'\)/);
  assert.match(app, /item\.element\.classList\.toggle\('is-active',[\s\S]*syncTerminalHeaderStatus\(item\)/);
  assert.match(app, /function handleTerminalTabKeydown\(event\)/);
  assert.match(app, /terminalTabKeyIndex\(event\.key, currentIndex, buttons\.length\)/);
  assert.match(app, /if \(handleTerminalTabKeydown\(event\)\) return/);
  assert.match(app, /element\.id = id/);
  assert.match(app, /const previousScrollLeft = els\.terminalTabs\.scrollLeft/);
  assert.match(app, /els\.terminalTabs\.scrollLeft = previousScrollLeft;[\s\S]*if \(!activeChanged\)/);
  assert.match(app, /terminalTabScrollLeft\(stripRect\.width, currentScrollLeft, itemStart, itemEnd, true\)/);
  assert.match(app, /closeIdleButton\.disabled = !count/);
  assert.match(app, /data-session-filter="\$\{escapeHtml\(filterCategory\)\}"/);
  assert.match(app, /sessionFilterMatches\(state\.sessionFilter, item\.dataset\.sessionFilter, item\.dataset\.sessionSearch, normalized\)/);
  assert.match(app, /safeStorageSet\(SESSION_FILTER_STORAGE_KEY, next\)/);
  assert.match(app, /case 'session-filter':/);
  assert.match(app, /sessionPinPresentation\(pinned, displayName\)/);
  assert.match(app, /sessionStatusPresentation\(status, attention\.length\)/);
  assert.match(app, /class="session-signal \$\{escapeHtml\(signal\.tone\)\}"/);
  assert.match(app, /aria-label="Open \$\{escapeHtml\(displayName\)\} terminal\. \$\{escapeHtml\(signal\.label\)\}/);
  assert.match(app, /class="session-task" title="\$\{escapeHtml\(taskPreview\)\}"/);
  assert.match(app, /class="session-item[^"`]*\$\{pinned \? 'is-pinned' : ''\}/);
  assert.match(app, /class="session-pin-symbol" aria-hidden="true">\$\{pin\.symbol\}<\/span>/);
  assert.match(app, /function togglePinnedSession\(session, source = null\)/);
  assert.match(app, /nextButton\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /pinned to the top/);
  assert.match(app, /class="session-no-results" data-action="session-filters-reset"/);
  assert.match(app, /const countPresentation = sessionResultCountPresentation\(visible, items\.length, Boolean\(normalized\) \|\| filtered\)/);
  assert.match(app, /function resetSessionFilters\(\)/);
  assert.match(app, /case 'session-filters-reset':/);
  assert.match(app, /function visibleSessionItems\(\)/);
  assert.match(app, /filter\(\(item\) => !item\.hidden\)/);
  assert.match(app, /function handleSessionSearchKeydown\(event\)/);
  assert.match(app, /sessionSearchKeyAction\(event, items\.length, els\.sessionSearch\.value\)/);
  assert.match(app, /items\[0\]\?\.querySelector\('\.session-open'\)\?\.click\(\)/);
  assert.match(app, /function handleSessionResultKeydown\(event\)/);
  assert.match(app, /cycledItemIndex\(currentIndex, items\.length, event\.key === 'ArrowUp' \? -1 : 1\)/);
  assert.match(app, /scrollToBottomOnNextOutput: true/);
  assert.match(app, /existing\.scrollToBottomOnNextOutput = true/);
  assert.match(app, /shouldStickTerminalOutput\(item, isTerminalAtBottom\(item\), Date\.now\(\)\)/);
  assert.match(app, /item\.scrollToBottomOnNextOutput = false/);
  assert.match(app, /class="terminal-jump-latest hidden" data-action="terminal-jump-latest"/);
  assert.match(app, /function syncTerminalLatestControl/);
  assert.match(app, /newOutput: changed && !shouldStickToBottom/);
  assert.match(app, /case 'terminal-jump-latest':/);
  assert.match(app, /classList\.toggle\('is-active', !item\.minimized && item\.id === state\.activeTerminalId\)/);
  assert.match(app, /function terminalFocusTarget\(item\)/);
  assert.match(app, /!item\.sendForm\.classList\.contains\('hidden'\) && !item\.composerCollapsed/);
  assert.match(app, /terminalFocusKind\(isDesktopTerminalMode\(\), editorAvailable\)/);
  assert.match(app, /data-action="terminal-composer-toggle"[^>]*aria-expanded="true"[^>]*aria-controls="\$\{id\}-composer-body"/);
  assert.match(app, /composerCollapsed: !isDesktopTerminalMode\(\)/);
  assert.match(app, /function setTerminalComposerCollapsed\(item, collapsed/);
  assert.match(app, /terminalComposerPresentation\(collapsed, hasDraft, draftSaved\)/);
  assert.match(app, /terminalDraftPresentation\(item\.sendText\.value, Boolean\(item\.pendingPaste\), Boolean\(item\.sendInFlight\), item\.draftStorageAvailable !== false\)/);
  assert.match(app, /class="terminal-composer-label"><label for="\$\{id\}-send-text">Reply to terminal<\/label><span class="terminal-draft-state neutral" role="status">No draft<\/span><\/div>/);
  assert.match(app, /item\.draftStorageAvailable = safeStorageSet\(terminalDraftKey\(item\.session\), item\.sendText\.value\)/);
  assert.match(app, /draftStorageAvailable: true/);
  assert.match(app, /case 'terminal-composer-toggle':/);
  assert.match(app, /class="terminal-control terminal-tools-toggle hidden"[^>]*data-action="terminal-tools-toggle"[^>]*aria-controls="\$\{id\}-commands"/);
  assert.match(app, /toolsCollapsed: !isDesktopTerminalMode\(\)/);
  assert.match(app, /function syncTerminalTools\(item, commandsAvailable/);
  assert.match(app, /case 'terminal-tools-toggle':/);
  assert.match(app, /class="terminal-text-size-controls"[^>]*aria-label="Terminal text size"/);
  assert.match(app, /data-action="terminal-font-scale" data-delta="-\$\{TERMINAL_FONT_SCALE_STEP\}"/);
  assert.match(app, /const TERMINAL_FONT_SCALE_STORAGE_KEY = 'host-control:terminal-font-scale'/);
  assert.match(app, /function syncTerminalFontScale\(\)/);
  assert.match(app, /document\.documentElement\.style\.setProperty\('--terminal-font-size'/);
  assert.match(app, /case 'terminal-font-scale':/);
  assert.match(app, /class="terminal-wrap-control" data-action="terminal-wrap-toggle"[^>]*aria-pressed="true"/);
  assert.match(app, /const TERMINAL_WRAP_STORAGE_KEY = 'host-control:terminal-wrap'/);
  assert.match(app, /function syncTerminalWrap\(\)/);
  assert.match(app, /document\.documentElement\.classList\.toggle\('is-terminal-nowrap'/);
  assert.match(app, /case 'terminal-wrap-toggle':/);
  assert.match(app, /class="terminal-copy-output" data-action="terminal-copy-output"/);
  assert.match(app, /async function copyTextToClipboard\(value\)/);
  assert.match(app, /navigator\.clipboard\?\.writeText/);
  assert.match(app, /document\.execCommand\?\.\('copy'\)/);
  assert.match(app, /async function copyTerminalOutput\(item, button\)/);
  assert.match(app, /case 'terminal-copy-output':/);
  assert.match(app, /class="terminal-find-toggle" data-action="terminal-find-toggle"[^>]*aria-controls="\$\{id\}-find"/);
  assert.match(app, /aria-keyshortcuts="Control\+F Meta\+F" title="Find text in terminal output/);
  assert.match(app, /class="terminal-find-bar hidden" role="search"/);
  assert.match(app, /class="terminal-find-input" type="search"/);
  assert.match(app, /function renderTerminalFindHighlights\(item/);
  assert.match(app, /terminalFindOffsets\(content, query\)/);
  assert.match(app, /function setTerminalFindOpen\(item, open\)/);
  assert.match(app, /function stepTerminalFind\(item, direction\)/);
  assert.match(app, /case 'terminal-find-toggle':/);
  assert.match(app, /isTerminalFindShortcut\(event, editableTarget\)/);
  assert.match(app, /event\.target\?\.classList\?\.contains\('terminal-find-bar'\)/);
  assert.match(app, /event\.target\?\.classList\?\.contains\('terminal-find-input'\)/);
  assert.match(app, /class="terminal-refresh-toggle" data-action="terminal-refresh-toggle"[^>]*aria-pressed="false"/);
  assert.match(app, /class="terminal-tool-group terminal-reading-tools"[^>]*aria-label="Reading tools"/);
  assert.match(app, /class="terminal-tool-group terminal-agent-tools"[^>]*aria-label="Agent commands"/);
  assert.match(app, /class="terminal-tool-group terminal-recovery-tools"[^>]*aria-label="Session recovery"/);
  assert.match(app, /class="terminal-interrupt-control" data-action="session-interrupt"[^>]*>Send Ctrl-C<\/button>/);
  assert.match(app, /class="terminal-stop-control" data-action="session-stop"[^>]*>Stop session<\/button>/);
  assert.match(app, /agentTools: element\.querySelector\('\.terminal-agent-tools'\)/);
  assert.match(app, /recoveryTools: element\.querySelector\('\.terminal-recovery-tools'\)/);
  assert.match(app, /item\.agentTools\.classList\.toggle\('hidden', !commandsAvailable\)/);
  assert.match(app, /item\.recoveryTools\.classList\.toggle\('hidden', item\.mode === 'static' \|\| !item\.session\)/);
  assert.match(app, /RECOVERY ONLY: stop tmux session \$\{session\}\?\\n\\nThis ends the agent or process in that session and cannot be undone\./);
  assert.match(app, /class="terminal-capture-paused hidden" role="status">Capture paused/);
  assert.match(app, /refreshPaused: Boolean\(refreshPaused\)/);
  assert.match(app, /function syncTerminalRefreshState\(item\)/);
  assert.match(app, /function setTerminalRefreshPaused\(item, paused\)/);
  assert.match(app, /case 'terminal-refresh-toggle':/);
  assert.match(app, /class="terminal-text-size-value" data-action="terminal-font-reset"[^>]*disabled>100%/);
  assert.match(app, /function resetTerminalFontScale\(\)/);
  assert.match(app, /case 'terminal-font-reset':/);
  assert.match(app, /item\.mode === 'static' \|\| item\.minimized \|\| item\.refreshPaused/);
  assert.match(app, /item\.minimized \|\| item\.refreshPaused \|\| document\.hidden/);
  assert.match(app, /data-action="new-agent-cancel" type="button">Cancel<\/button>/);
  assert.match(app, /type="submit" aria-describedby="new-agent-launcher-safety new-agent-launcher-shortcut">Start Agent<\/button>/);
  assert.match(app, /function closeNewAgentLauncher\(launcher = document\.querySelector\('\.new-agent-panel\[open\]'\)\)/);
  assert.match(app, /function handleNewAgentLauncherKeydown\(event, launcher\)/);
  assert.match(app, /form\?\.contains\(event\.target\) && isNewAgentSubmitShortcut\(event\)/);
  assert.match(app, /form\.requestSubmit\(\)/);
  assert.match(app, /modalFocusIndex\(event, focusable\.indexOf\(document\.activeElement\), focusable\.length\)/);
  assert.match(app, /case 'new-agent-cancel':/);
  assert.match(app, /event\.target\.setAttribute\('role', 'dialog'\)/);
  assert.match(app, /const openLauncher = document\.querySelector\('\.new-agent-panel\[open\]'\)/);
  assert.match(app, /openLauncher && handleNewAgentLauncherKeydown\(event, openLauncher\)/);
  assert.match(app, /class="prompt-history-filter-bar"[^>]*aria-label="Filter finished prompts by origin"/);
  assert.match(app, /data-action="prompt-history-origin" data-origin="mine"/);
  assert.match(app, /data-action="prompt-history-origin" data-origin="automated"/);
  assert.match(app, /safeStorageSet\(PROMPT_HISTORY_ORIGIN_STORAGE_KEY, next\)/);
  assert.match(app, /case 'prompt-history-origin':/);
  assert.match(app, /id="prompt-history-search-form" class="prompt-history-search-form" role="search"/);
  assert.match(app, /id="prompt-history-search" name="query" type="search" maxlength="200"[^>]*enterkeyhint="search"/);
  assert.match(app, /data-action="prompt-history-search-clear"/);
  assert.match(app, /filterPromptHistory\(allFinished, state\.promptHistoryOriginFilter, state\.promptHistoryQuery\)/);
  assert.match(app, /function setPromptHistoryQuery\(value\)/);
  assert.match(app, /event\.target\?\.id === 'prompt-history-search-form'/);
  assert.match(app, /setPromptHistoryQuery\(new FormData\(event\.target\)\.get\('query'\)\)/);
  assert.match(app, /case 'prompt-history-search-clear':/);
  assert.match(app, /class="prompt-queue-jump-nav"[^>]*aria-label="Jump to Prompt Queue section"/);
  assert.match(app, /data-action="prompt-queue-jump" data-queue-section="compose"[^>]*aria-controls="prompt-queue-compose"/);
  assert.match(app, /data-action="prompt-queue-jump" data-queue-section="history"[^>]*aria-controls="prompt-queue-history"/);
  assert.match(app, /function jumpToPromptQueueSection\(section\)/);
  assert.match(app, /const selector = promptQueueSectionTarget\(section\)/);
  assert.match(app, /behavior: reducedMotion \? 'auto' : 'smooth'/);
  assert.match(app, /case 'prompt-queue-jump':/);
  assert.match(app, /class="prompt-queue-counter" data-full="\$\{presentation\.full\}" aria-label="\$\{state\.promptQueueDraft\.text\.length\} of 4000 characters used"/);
  assert.match(app, /aria-keyshortcuts="Control\+Enter Meta\+Enter"/);
  assert.match(app, /promptQueueComposerPresentation\(state\.promptQueueDraft, targetsAvailable\)/);
  assert.match(app, /isPromptQueueSubmitShortcut\(event\)/);
  assert.match(app, /form\.requestSubmit\(queueButton\)/);
  assert.match(app, /const PROMPT_QUEUE_DRAFT_STORAGE_KEY = 'host-control:prompt-queue-draft:v1'/);
  assert.match(app, /normalizedPromptQueueDraft\(JSON\.parse\(storedPromptQueueDraft\)\)/);
  assert.match(app, /function persistPromptQueueDraft\(\)/);
  assert.match(app, /safeStorageSet\(PROMPT_QUEUE_DRAFT_STORAGE_KEY, value\)/);
  assert.match(app, /class="prompt-queue-draft-state \$\{presentation\.hasDraft \? 'has-draft' : ''\}" role="status"/);
  assert.match(app, /state\.promptQueueDraftStorageAvailable = safeStorageSet\(PROMPT_QUEUE_DRAFT_STORAGE_KEY, ''\)/);
  assert.match(app, /class="prompt-queue-draft-row"/);
  assert.match(app, /data-action="prompt-queue-draft-clear"[^>]*>Clear draft<\/button>/);
  assert.match(app, /data-action="prompt-queue-draft-undo"[^>]*>Undo clear<\/button>/);
  assert.match(app, /function clearPromptQueueDraft\(form\)/);
  assert.match(app, /state\.promptQueueDraftUndo = normalizedPromptQueueDraft\(state\.promptQueueDraft\)/);
  assert.match(app, /function undoPromptQueueDraftClear\(form\)/);
  assert.match(app, /state\.promptQueueDraftUndo = null;[\s\S]*readPromptQueueDraft\(form\)/);
  assert.match(app, /case 'prompt-queue-draft-clear':/);
  assert.match(app, /case 'prompt-queue-draft-undo':/);
  assert.match(app, /class="prompt-history-origin \$\{escapeHtml\(origin\)\}"/);
  assert.match(app, /data-queue-detail="older"[\s\S]*state\.openPromptQueueDetails\.has\('older'\)/);
  assert.match(app, /data-queue-detail="unconfirmed"[\s\S]*state\.openPromptQueueDetails\.has\('unconfirmed'\)/);
  assert.match(app, /data-queue-detail="canceled"[\s\S]*state\.openPromptQueueDetails\.has\('canceled'\)/);
  assert.match(app, /event\.target\?\.matches\?\.\('\[data-queue-detail\]'\)/);

  const sessionRenderStart = app.indexOf('function renderAgents(agents, orchestration, security, services = [])');
  const sessionRenderEnd = app.indexOf('function sessionAttentionItems', sessionRenderStart);
  const sessionRenderSource = app.slice(sessionRenderStart, sessionRenderEnd);
  assert.ok(sessionRenderStart >= 0 && sessionRenderEnd > sessionRenderStart);
  assert.ok(sessionRenderSource.indexOf('captureScrollPositions(els.sessionList') < sessionRenderSource.indexOf('els.sessionList.innerHTML'));
  assert.ok(sessionRenderSource.indexOf('els.sessionList.innerHTML') < sessionRenderSource.indexOf('restoreScrollPositions(els.sessionList'));

  assert.ok(promptQueueRenderSource.indexOf('captureScrollPositions(els.queue') < promptQueueRenderSource.indexOf('els.queue.innerHTML'));
  assert.ok(promptQueueRenderSource.indexOf('els.queue.innerHTML') < promptQueueRenderSource.indexOf('restoreScrollPositions(els.queue'));
  assert.match(app, /bounds\.left \+ slot\.left \+ inset/);
  assert.match(app, /bounds\.top \+ slot\.top \+ inset/);
  assert.match(app, /case 'drawer-toggle'/);
  assert.match(app, /const SESSION_PANEL_STORAGE_KEY = 'host-control:session-panel-visible'/);
  assert.match(app, /const INSPECTOR_PANEL_STORAGE_KEY = 'host-control:inspector-panel-visible'/);
  assert.match(app, /function syncWorkspacePanels\(\)/);
  assert.match(app, /case 'workspace-panel-toggle':/);
  assert.match(app, /class="tool-panel tools-notifications"/);
  assert.match(app, /event\.isComposing/);
  assert.match(app, /event\.shiftKey \|\| event\.altKey \|\| event\.ctrlKey \|\| event\.metaKey/);

  const reviewStart = app.indexOf('function openScratchpadReview()');
  const reviewEnd = app.indexOf('function togglePinnedSession', reviewStart);
  const reviewSource = app.slice(reviewStart, reviewEnd);
  assert.ok(reviewStart >= 0 && reviewEnd > reviewStart);
  assert.doesNotMatch(reviewSource, /api\('/);
  assert.match(app, /async function confirmScratchpadSend\(\)[\s\S]*sendTerminalTextValue\(item, review\.text/);
  assert.match(app, /data-action="prompt-queue-clear-history"/);
  assert.match(app, /async function clearPromptQueueHistoryClient/);
  assert.match(app, /confirm: 'clear-history'/);
  assert.match(app, /Finished today/);
  assert.match(app, /Average queue wait/);
  assert.match(app, /item\.completedAt \|\| item\.sentAt/);
  assert.match(app, /active · \$\{waiting\} waiting/);
  assert.match(app, /Final response missing/);
  assert.match(app, /Capture boundary expired/);
  assert.match(app, /Newer activity detected/);
  assert.match(app, /data-action="prompt-queue-release"/);
  assert.match(app, /async function releasePromptQueueClient/);
  assert.match(app, /confirm: 'release-after-review'/);
  assert.match(app, /Returned to ready · no footer/);
  assert.match(app, /Operator released after review/);
  assert.match(app, /Operator confirmed after review/);
});

test('live responsive CSS anchors desktop windows to the workspace and shows only one phone terminal', async () => {
  const styles = await uiSource('styles.css');
  assert.match(styles, /\.terminal-home\s*\{[\s\S]*grid-template-columns: 230px minmax\(520px, 1fr\) 300px/);
  assert.match(styles, /\.terminal-layer\s*\{\s*position: fixed/);
  assert.match(styles, /\.terminal-window\s*\{\s*position: fixed/);
  assert.match(styles, /\.terminal-workspace\.has-open-terminals\s*\{[\s\S]*align-self: stretch/);
  assert.match(styles, /\.terminal-workspace\.has-open-terminals \.terminal-stage\s*\{[\s\S]*display: block/);
  assert.match(styles, /\.terminal-window\.is-full-height :is\([\s\S]*\.resize-n/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.terminal-full-height-button\s*\{\s*display: none/);
  assert.match(styles, /\.project-desk\s*\{[\s\S]*min-height: 100%/);
  assert.match(styles, /\.project-desk-actions\s*\{[\s\S]*display: flex/);
  assert.match(styles, /\.project-artifact-row\s*\{/);
  assert.match(styles, /\.project-artifact-row\s*\{[\s\S]*cursor: pointer/);
  assert.match(styles, /\.project-artifact-row\[aria-busy="true"\]/);
  assert.match(styles, /\.scratchpad-review-panel\s*\{[\s\S]*border: 2px solid/);
  assert.match(styles, /\.prompt-queue-form\s*\{/);
  assert.match(styles, /\.prompt-schedule-grid\s*\{/);
  assert.match(styles, /\.prompt-schedule-card\s*\{/);
  assert.match(styles, /\.prompt-schedule-cron\s*\{/);
  assert.match(styles, /\.prompt-history-finish\.returned/);
  assert.match(styles, /\.prompt-queue-legend \.good/);
  assert.match(styles, /\.prompt-target-grid\s*\{[\s\S]*grid-template-columns: repeat\(auto-fit, minmax\(210px, 1fr\)\)/);
  assert.match(styles, /\.prompt-target-card\.selected\s*\{/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.prompt-target-grid\s*\{[\s\S]*grid-auto-flow: column/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.prompt-target-grid\s*\{[\s\S]*grid-auto-columns: clamp\(240px, 82vw, 300px\)/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.prompt-target-grid\s*\{[\s\S]*scroll-snap-type: inline proximity/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.prompt-target-card\s*\{[\s\S]*scroll-snap-align: start/);
  assert.match(styles, /#queue-view\.active\.queue-workspace-view\s*\{[\s\S]*overflow-y: auto/);
  assert.match(styles, /\.prompt-queue-stats\s*\{[\s\S]*grid-template-columns: repeat\(6/);
  assert.match(styles, /\.prompt-history-row\s*\{/);
  assert.match(styles, /\.prompt-history-filter-bar\s*\{/);
  assert.match(styles, /\.prompt-history-origin-filter\.active\s*\{/);
  assert.match(styles, /\.prompt-history-origin\.automated\s*\{/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.prompt-history-filter-bar\s*\{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.prompt-history-finish\s*\{/);
  assert.match(styles, /\.prompt-history-finish pre\s*\{/);
  assert.match(styles, /\.terminal-stage\s*\{[\s\S]*grid-row: 3/);
  assert.match(styles, /\.terminal-window\.is-layout-hidden\s*\{\s*display: none/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.terminal-window\s*\{\s*position: fixed/);
  assert.match(styles, /\.control-drawer\s*\{[\s\S]*position: fixed/);
  assert.match(styles, /\/\* Mobile and widescreen usability refinement\. \*\//);
  assert.match(styles, /@media \(min-width: 2200px\)/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.sidebar\s*\{[\s\S]*position: fixed/);
  assert.match(styles, /\/\* High-frequency workspace modes\. \*\/[\s\S]*\.app-shell\.is-canvas-focused > \.sidebar,[\s\S]*display: none/);
  assert.match(styles, /@media \(min-width: 760px\) and \(max-width: 1100px\)[\s\S]*\.app-shell\.is-canvas-focused \.terminal-home\s*\{[\s\S]*height: calc\(100dvh - 94px\)/);
  assert.match(styles, /\/\* High-frequency workspace modes\. \*\/[\s\S]*@media \(max-width: 759px\)[\s\S]*\.session-list\s*\{[\s\S]*scroll-snap-type: y proximity/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.session-task\s*\{[\s\S]*-webkit-line-clamp: 2/);
  assert.match(styles, /\.session-filters\s*\{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.session-filter\.active\s*\{[\s\S]*background: #eaf3ff/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.session-filters\s*\{[\s\S]*overflow-x: auto/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.session-filter\s*\{[\s\S]*min-height: 44px/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.terminal-command-bar\s*\{[\s\S]*overflow-x: auto/);
  assert.match(styles, /\/\* Independent workspace panels and compact phone tools\. \*\//);
  assert.match(styles, /\.app-shell\.is-session-panel-hidden \.session-rail,[\s\S]*\.app-shell\.is-inspector-panel-hidden \.terminal-inspector\s*\{\s*display: none/);
  assert.match(styles, /@media \(min-width: 2200px\)[\s\S]*\.app-shell\.is-session-panel-hidden \.terminal-home\s*\{[\s\S]*grid-template-columns: minmax\(920px, 1fr\) 380px/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.terminal-tools-toggle:not\(\.hidden\)\s*\{[\s\S]*min-width: 56px/);
  assert.match(styles, /\.terminal-window\.is-tools-collapsed \.terminal-command-bar\s*\{\s*display: none/);
  assert.match(styles, /\/\* Persistent terminal readability controls\. \*\//);
  assert.match(styles, /\.terminal-output\s*\{\s*font-size: var\(--terminal-font-size, 12px\)/);
  assert.match(styles, /\.terminal-text-size-controls\s*\{[\s\S]*font-variant-numeric: tabular-nums/);
  assert.match(styles, /@media \(max-width: 759px\), \(pointer: coarse\)[\s\S]*\.terminal-command-bar \.terminal-text-size-controls button\s*\{[\s\S]*min-width: 44px/);
  assert.match(styles, /\/\* Operator-controlled terminal line wrapping\. \*\//);
  assert.match(styles, /html\.is-terminal-nowrap \.terminal-output\s*\{[\s\S]*white-space: pre;[\s\S]*overflow-wrap: normal/);
  assert.match(styles, /\.terminal-command-bar \.terminal-wrap-control\.active\s*\{[\s\S]*background: rgba\(37, 99, 235, 0\.24\)/);
  assert.match(styles, /\/\* Fast extraction of the currently visible terminal capture\. \*\//);
  assert.match(styles, /\.terminal-command-bar \.terminal-copy-output\.copied\s*\{[\s\S]*color: #bbf7d0/);
  assert.match(styles, /\.terminal-find-bar\s*\{[\s\S]*grid-area: find/);
  assert.match(styles, /\.terminal-find-match\.current\s*\{[\s\S]*background: #facc15/);
  assert.match(styles, /@media \(max-width: 759px\), \(pointer: coarse\)[\s\S]*\.terminal-find-input\s*\{[\s\S]*font-size: 16px/);
  assert.match(styles, /\.terminal-command-bar > span:not\(\.terminal-text-size-controls\)/);
  assert.match(styles, /\.terminal-capture-paused\s*\{[\s\S]*color: #ffd27d/);
  assert.match(styles, /\.terminal-command-bar \.terminal-refresh-toggle\.active\s*\{[\s\S]*color: #fde68a/);
  assert.match(styles, /\/\* Group high-frequency read tools separately from terminal-input commands\. \*\//);
  assert.match(styles, /\.terminal-command-bar > span\.terminal-tool-group\s*\{[\s\S]*display: flex/);
  assert.match(styles, /\.terminal-command-bar \.terminal-interrupt-control\s*\{[\s\S]*color: #fde68a/);
  assert.match(styles, /\.terminal-command-bar \.terminal-stop-control\s*\{[\s\S]*color: #fecaca/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.terminal-command-bar > span\.terminal-tool-group\s*\{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.terminal-command-bar > span\.terminal-recovery-tools\s*\{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.terminal-tool-group-label\s*\{[\s\S]*display: block/);
  assert.match(styles, /\.terminal-command-bar \.terminal-text-size-controls \.terminal-text-size-value\.can-reset\s*\{[\s\S]*cursor: pointer/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /\/\* Reading-first terminal composer\. \*\//);
  assert.match(styles, /\.terminal-composer-body\s*\{[\s\S]*display: grid/);
  assert.match(styles, /\.send-form\.is-collapsed \.terminal-composer-body\s*\{\s*display: none/);
  assert.match(styles, /@media \(max-width: 759px\), \(pointer: coarse\)[\s\S]*\.terminal-composer-toggle\s*\{[\s\S]*min-height: 44px/);
  assert.match(styles, /\/\* Honest terminal draft and send readiness\. \*\//);
  assert.match(styles, /\.terminal-draft-state\.good\s*\{[\s\S]*color: #95e9b7/);
  assert.match(styles, /\.terminal-draft-state\.warn\s*\{[\s\S]*color: #ffd27d/);
  assert.match(styles, /\/\* Prompt Queue section navigation\. \*\//);
  assert.match(styles, /\.prompt-queue-jump-nav\s*\{[\s\S]*position: sticky[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(min-width: 1800px\)[\s\S]*\.prompt-queue-jump-nav\s*\{[^}]*grid-row: 3/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.prompt-queue-jump-nav\s*\{[\s\S]*safe-area-inset-top/);
  assert.match(styles, /\/\* Prompt Queue composer feedback\. \*\//);
  assert.match(styles, /\.prompt-queue-counter\[data-full="true"\]\s*\{[\s\S]*color: var\(--bad\)/);
  assert.match(styles, /\.prompt-queue-form button\[type="submit"\]:disabled\s*\{/);
  assert.match(styles, /\.prompt-target-bulk-actions\s*\{/);
  assert.match(styles, /\.prompt-queue-selected-targets\s*\{/);
  assert.match(styles, /\.prompt-queue-submit-actions\s*\{/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.prompt-queue-input-meta kbd\s*\{\s*display: none/);
  assert.match(styles, /\.prompt-queue-draft-state\.has-draft\s*\{[\s\S]*color: var\(--good\)/);
  assert.match(styles, /\.prompt-queue-draft-state\.storage-unavailable\s*\{[\s\S]*color: var\(--warn\)/);
  assert.match(styles, /\.prompt-queue-draft-row\s*\{[\s\S]*grid-column: 1 \/ -1/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.prompt-queue-draft-actions \.action-button\s*\{[\s\S]*min-height: 44px/);
  assert.match(styles, /\/\* Second-pass workflow refinement for high-frequency use\. \*\//);
  assert.match(styles, /@media \(min-width: 1800px\)[\s\S]*\.prompt-queue-console\s*\{[\s\S]*grid-template-columns: minmax\(760px, 1\.45fr\) minmax\(500px, 0\.85fr\)/);
  assert.match(styles, /@media \(min-width: 1800px\)[\s\S]*\.control-drawer\s*\{[\s\S]*width: min\(1080px, 72vw\)/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.prompt-queue-stats\s*\{[\s\S]*scroll-snap-type: inline proximity/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.tool-tabs\s*\{[\s\S]*overflow-x: auto/);
  assert.match(styles, /\/\* Persistent operational feedback\. \*\//);
  assert.match(styles, /\.connection-pill\[data-state="live"\]/);
  assert.match(styles, /\.connection-pill\[data-state="poll"\]/);
  assert.match(styles, /\.connection-pill\[data-state="error"\]/);
  assert.match(styles, /#refresh-button\[aria-busy="true"\][\s\S]*animation: panefleet-refresh-spin/);
  assert.match(styles, /@media \(max-width: 380px\)[\s\S]*\.connection-pill strong\s*\{[\s\S]*clip: rect\(0, 0, 0, 0\)/);
  assert.match(styles, /\/\* Live refresh stability\. \*\//);
  assert.match(styles, /\.session-list,[\s\S]*\.prompt-queue-stats,[\s\S]*\.prompt-target-grid\s*\{[\s\S]*overflow-anchor: none/);
  assert.match(styles, /\/\* Direct mobile terminal switching\. \*\//);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.terminal-mobile-switcher:not\(\.hidden\)\s*\{[\s\S]*grid-template-columns: 52px minmax\(0, 1fr\) 52px/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.terminal-mobile-select\s*\{[\s\S]*text-align-last: center/);
  assert.match(styles, /@media \(min-width: 1800px\)[\s\S]*\.terminal-jump-field\s*\{[\s\S]*display: inline-flex/);
  assert.match(styles, /\.terminal-tab > button:first-child:focus-visible\s*\{[\s\S]*outline: 2px solid #93c5fd/);
  assert.match(styles, /\/\* Adaptive terminal controls\. \*\//);
  assert.match(styles, /@media \(min-width: 1200px\)[\s\S]*\.layout-label-full\s*\{[\s\S]*display: inline/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.layout-button\[data-action="terminal-layout"\],[\s\S]*\.terminal-full-height-button\s*\{[\s\S]*display: none/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.session-item\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\) 44px/);
  assert.match(styles, /@media \(min-width: 1200px\)[\s\S]*\.terminal-control-label-desktop\s*\{\s*display: inline/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.terminal-minimize\s*\{[\s\S]*min-width: 56px/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.terminal-control-label-mobile\s*\{[\s\S]*display: inline/);
  assert.match(styles, /\/\* Terminal focus clarity and live-edge navigation\. \*\//);
  assert.match(styles, /@media \(min-width: 760px\)[\s\S]*\.terminal-window\.is-active\s*\{[\s\S]*border-color: rgba\(96, 165, 250, 0\.88\)/);
  assert.match(styles, /\.terminal-window\.is-active \.terminal-header\s*\{[\s\S]*box-shadow: inset 4px 0 0 #60a5fa/);
  assert.match(styles, /\.terminal-jump-latest\s*\{[\s\S]*grid-area: output/);
  assert.match(styles, /\.terminal-jump-latest\.has-new-output\s*\{/);
  assert.match(styles, /@media \(max-width: 759px\), \(pointer: coarse\)[\s\S]*\.terminal-jump-latest\s*\{[\s\S]*min-height: 44px/);
  assert.match(styles, /\/\* Ultrawide context preservation\. \*\//);
  assert.match(styles, /@media \(min-width: 1800px\)[\s\S]*\.terminal-inspector\s*\{[\s\S]*scrollbar-gutter: stable/);
  assert.match(styles, /\/\* Stable high-frequency navigation actions\. \*\//);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.topbar-actions \.action-button\.new-agent-action\s*\{[\s\S]*display: inline-flex/);
  assert.match(styles, /@media \(max-width: 380px\)[\s\S]*\.topbar-actions \.action-button\.new-agent-action\s*\{[\s\S]*width: 44px/);
  assert.match(styles, /\/\* Session filter feedback and recovery\. \*\//);
  assert.match(styles, /\.hidden,\s*\[hidden\]\s*\{\s*display: none !important/);
  assert.match(styles, /\.session-list\.has-no-results \.session-no-results\s*\{\s*display: grid/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.session-no-results\s*\{[\s\S]*flex: 1 0 min\(82vw, 280px\)/);
  assert.match(styles, /\.session-item\.is-pinned\s*\{[\s\S]*border-color: #8eb6e5/);
  assert.match(styles, /@media \(min-width: 1800px\)[\s\S]*\.session-pin-label\s*\{\s*display: inline/);
  assert.match(styles, /\/\* Explicit session state for fast, color-independent scanning\. \*\//);
  assert.match(styles, /\.session-signal\.working\s*\{[\s\S]*color: #0b579f/);
  assert.match(styles, /\.session-signal\.ready\s*\{[\s\S]*color: #12633e/);
  assert.match(styles, /@media \(min-width: 1800px\)[\s\S]*\.session-task\s*\{\s*display: block/);
  assert.match(styles, /\/\* State-aware switching for open terminals\. \*\//);
  assert.match(styles, /\.terminal-tab-status\.working\s*\{\s*color: #8fc2ff/);
  assert.match(styles, /\.terminal-tab-status\.ready\s*\{\s*color: #77d7a6/);
  assert.match(styles, /@media \(min-width: 1800px\)[\s\S]*\.terminal-tab\s*\{[\s\S]*max-width: 260px/);
  assert.match(styles, /\/\* Persistent terminal identity and live agent state\. \*\//);
  assert.match(styles, /\.terminal-header-status\.working\s*\{[\s\S]*color: #a9d0ff/);
  assert.match(styles, /\.terminal-header-status\.ready\s*\{[\s\S]*color: #95e9b7/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.terminal-meta\s*\{[\s\S]*text-overflow: ellipsis/);
  assert.match(styles, /\/\* Finished prompt history search\. \*\//);
  assert.match(styles, /\.prompt-history-search-form\s*\{[\s\S]*grid-template-columns: minmax\(220px, 360px\) auto auto/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.prompt-history-search-form input\s*\{[\s\S]*font-size: 16px/);
  assert.match(styles, /\/\* New Agent launcher sheet controls\. \*\//);
  assert.match(styles, /body:has\(\.new-agent-panel\[open\]\)\s*\{[\s\S]*overflow: hidden/);
  assert.match(styles, /\.new-agent-panel\[open\] \+ \.new-agent-backdrop\s*\{[\s\S]*position: fixed[\s\S]*inset: 0/);
  assert.match(styles, /\.new-agent-container \.new-agent-panel\[open\] > summary\s*\{[\s\S]*position: sticky[\s\S]*top: 0/);
  assert.match(styles, /\.new-agent-container \.new-agent-panel\[open\] \.launcher-actions\s*\{[\s\S]*position: sticky[\s\S]*bottom: 0/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.new-agent-container \.new-agent-panel\[open\] \.launcher-actions\s*\{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.new-agent-container \.launcher-shortcut\s*\{\s*display: none/);
  assert.match(styles, /\/\* Non-disruptive operational feedback\. \*\//);
  assert.match(styles, /#notice\.notice-toast\s*\{[\s\S]*position: fixed[\s\S]*z-index: 22050/);
  assert.match(styles, /#notice\.notice-toast\[data-kind="success"\]/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*#notice\.notice-toast\s*\{[\s\S]*safe-area-inset-top/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.notice-dismiss\s*\{[\s\S]*width: 44px[\s\S]*height: 44px/);
  assert.match(styles, /\/\* Discoverable keyboard shortcut guide\. \*\//);
  assert.match(styles, /\.shortcut-help\s*\{[\s\S]*position: fixed/);
  assert.match(styles, /\.shortcut-help-backdrop\s*\{[\s\S]*position: fixed/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.shortcut-help\s*\{[\s\S]*bottom: max\(7px, env\(safe-area-inset-bottom\)\)/);
});

test('mobile terminal typing is protected from focus-destroying dashboard renders', async () => {
  const [app, styles] = await Promise.all([uiSource('app.js'), uiSource('styles.css')]);

  assert.match(app, /const protectedTerminalEditor = preserveActiveEditor[\s\S]*\.terminal-window textarea/);
  assert.match(app, /syncOpenTerminalWindows\(\{ protectedEditor: protectedTerminalEditor \}\)/);
  assert.match(app, /item\.sendText !== protectedEditor\) updateTerminalSendForm\(item\)/);
  assert.match(app, /if \(protectedEditor\?\.isConnected\) return/);
  assert.match(app, /const alreadyActive = state\.activeTerminalId === item\.id[\s\S]*if \(alreadyActive\) return/);
  assert.match(app, /const terminalEditor = event\.target\.closest\('\.terminal-send-form, input, textarea, select, \[contenteditable="true"\]'\)/);
  assert.match(app, /if \(item\.sendText\.readOnly !== promptDisabled\) item\.sendText\.readOnly = promptDisabled/);
  assert.match(styles, /@media \(max-width: 759px\) \{\s*\.terminal-layer \{\s*z-index: 1000/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.terminal-dock \{\s*z-index: 1001/);
});
