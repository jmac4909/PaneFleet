const DRAWER_NAMES = new Set(['tools']);
const TERMINAL_LAYOUTS = new Set(['free', 'focus', 'split', 'grid']);
const SESSION_FILTERS = new Set(['all', 'needs', 'active', 'idle']);
const PROMPT_HISTORY_ORIGINS = new Set(['all', 'mine', 'automated']);
const PROMPT_QUEUE_SECTIONS = new Set(['compose', 'active', 'schedules', 'history']);

export function nextDrawer(current, requested) {
  if (!DRAWER_NAMES.has(requested)) return null;
  return current === requested ? null : requested;
}

export function agentCreateOutcome(result, hadPrompt) {
  const session = String(result?.session || 'agent session');
  const model = String(result?.model || 'Codex config');
  const reasoning = String(result?.reasoning || 'default');
  if (!hadPrompt || result?.promptSent === true || result?.promptState === 'accepted') {
    return {
      accepted: true,
      preserveDraft: false,
      notice: `Started ${session} with ${model} · ${reasoning} reasoning.`,
      tone: 'info'
    };
  }

  const promptState = String(result?.promptState || 'outcome_unknown');
  if (promptState === 'typed_not_submitted') {
    return {
      accepted: false,
      preserveDraft: true,
      notice: `${session} started, but its prompt was typed and not submitted. Open the terminal and review it; PaneFleet will not press Enter again.`,
      tone: 'warning'
    };
  }
  if (promptState === 'not_typed') {
    return {
      accepted: false,
      preserveDraft: true,
      notice: `${session} started, but its prompt was not typed because the terminal was not ready. Open the terminal to review it; your launcher draft was kept.`,
      tone: 'warning'
    };
  }
  return {
    accepted: false,
    preserveDraft: true,
    notice: `${session} started, but PaneFleet could not confirm that Codex accepted the prompt. Open the terminal and review it; no input was resent.`,
    tone: 'warning'
  };
}

export function agentDraftSignature(draft) {
  const source = draft || {};
  return JSON.stringify([
    source.name,
    source.directoryName,
    source.workspace,
    source.preset,
    source.model,
    source.reasoning,
    source.prompt
  ].map((value) => String(value ?? '')));
}

export function attentionForSession(items, session) {
  if (!session) return [];
  return (Array.isArray(items) ? items : []).filter((item) => String(item?.session || '') === String(session));
}

export function projectContextCacheFresh(entry, nowMs, maxAgeMs) {
  const fetchedAt = Number(entry?.fetchedAt);
  const currentTime = Number(nowMs);
  const maxAge = Number(maxAgeMs);
  return Boolean(
    entry?.context &&
    Number.isFinite(fetchedAt) &&
    Number.isFinite(currentTime) &&
    Number.isFinite(maxAge) &&
    maxAge > 0 &&
    fetchedAt <= currentTime &&
    currentTime - fetchedAt < maxAge
  );
}

export function dashboardShortcut(event, editable = false) {
  if (editable || event.isComposing) return null;
  const key = String(event.key || '').toLowerCase();
  const primaryModifier = Boolean(event.ctrlKey || event.metaKey);
  if (primaryModifier && !event.altKey && key === 'k') return 'search';
  if (event.altKey && !primaryModifier) {
    if (key === '1') return 'agents';
    if (key === '2') return 'queue';
    if (key === '3') return 'tools';
    if (key === 'n') return 'new-agent';
    if (key === '0') return 'workspace-focus';
    if (key === '[') return 'terminal-previous';
    if (key === ']') return 'terminal-next';
  }
  if (!primaryModifier && !event.altKey && event.key === '?') return 'shortcuts';
  if (!primaryModifier && !event.altKey && key === '/') return 'search';
  return null;
}

export function workspaceFocusPresentation(focused) {
  return focused
    ? {
        label: 'Show panels',
        shortLabel: 'Panels',
        description: 'Restore navigation, sessions, and the selected-agent inspector'
      }
    : {
        label: 'Focus canvas',
        shortLabel: 'Canvas',
        description: 'Hide side panels and expand the terminal canvas'
      };
}

export function workspaceFocusApplies(focused, activeView) {
  return Boolean(focused) && activeView === 'agents';
}

export function isNewAgentSubmitShortcut(event) {
  if (!event || event.isComposing || event.altKey || event.shiftKey) return false;
  return event.key === 'Enter' && Boolean(event.ctrlKey || event.metaKey);
}

export function modalFocusIndex(event, currentIndex, count) {
  if (
    !event
    || event.key !== 'Tab'
    || event.isComposing
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || count < 1
  ) return -1;
  if (currentIndex < 0) return event.shiftKey ? count - 1 : 0;
  if (event.shiftKey && currentIndex === 0) return count - 1;
  if (!event.shiftKey && currentIndex === count - 1) return 0;
  return -1;
}

export function preferredDashboardView(hash, storedView) {
  const hashView = String(hash || '').replace(/^#/, '').toLowerCase();
  if (hashView === 'queue') return 'queue';
  if (hashView === 'terminals' || hashView === 'agents') return 'agents';
  return storedView === 'queue' ? 'queue' : 'agents';
}

export function dashboardDocumentTitle({
  view = 'agents',
  drawer = null,
  decisionCount = 0,
  queuedCount = 0,
  workingCount = 0,
  connection = 'live'
} = {}) {
  const section = drawer === 'tools' ? 'Tools' : view === 'queue' ? 'Queue' : 'Terminals';
  if (connection === 'error') return `Offline · ${section} — PaneFleet`;
  if (connection === 'poll') return `Polling · ${section} — PaneFleet`;
  if (Number(decisionCount) > 0) return `Needs you: ${Math.floor(Number(decisionCount))} · ${section} — PaneFleet`;
  if (view === 'queue' && Number(queuedCount) > 0) return `Queued: ${Math.floor(Number(queuedCount))} · ${section} — PaneFleet`;
  if (Number(workingCount) > 0) return `Working: ${Math.floor(Number(workingCount))} · ${section} — PaneFleet`;
  return `${section} — PaneFleet`;
}

export function normalizedTerminalRestoreState(value, limit = 8) {
  if (value?.version !== 1 || !Array.isArray(value.terminals)) return [];
  const maximum = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 8) : 8;
  const active = value.active && typeof value.active === 'object' ? value.active : {};
  const seen = new Set();
  const terminals = [];
  for (const candidate of value.terminals) {
    if (!candidate || typeof candidate !== 'object') continue;
    const session = String(candidate.session || '').trim();
    const sessionCreatedAt = String(candidate.sessionCreatedAt || '').trim();
    const paneId = String(candidate.paneId || '').trim();
    const tmuxPaneId = String(candidate.tmuxPaneId || '').trim();
    const panePid = Number(candidate.panePid);
    const rawBounds = candidate.freeBounds;
    const bounds = rawBounds && typeof rawBounds === 'object' ? {
      left: Number(rawBounds.left),
      top: Number(rawBounds.top),
      width: Number(rawBounds.width),
      height: Number(rawBounds.height)
    } : null;
    const freeBounds = bounds
      && Number.isFinite(bounds.left)
      && Number.isFinite(bounds.top)
      && Number.isFinite(bounds.width)
      && Number.isFinite(bounds.height)
      && Math.abs(bounds.left) <= 50_000
      && Math.abs(bounds.top) <= 50_000
      && bounds.width >= 320
      && bounds.width <= 10_000
      && bounds.height >= 220
      && bounds.height <= 10_000
      ? bounds
      : null;
    if (
      !session
      || session.length > 160
      || !sessionCreatedAt
      || !Number.isFinite(Date.parse(sessionCreatedAt))
      || !paneId
      || paneId.length > 240
      || !/^%\d+$/.test(tmuxPaneId)
      || !Number.isInteger(panePid)
      || panePid < 1
    ) continue;
    const identity = `${session}\u0000${sessionCreatedAt}\u0000${paneId}\u0000${tmuxPaneId}\u0000${panePid}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    terminals.push({
      session,
      sessionCreatedAt,
      paneId,
      tmuxPaneId,
      panePid,
      minimized: candidate.minimized === true,
      refreshPaused: candidate.refreshPaused === true,
      freeBounds,
      active: session === String(active.session || '')
        && sessionCreatedAt === String(active.sessionCreatedAt || '')
        && paneId === String(active.paneId || '')
        && tmuxPaneId === String(active.tmuxPaneId || '')
        && panePid === Number(active.panePid)
    });
    if (terminals.length >= maximum) break;
  }
  return terminals;
}

export function connectionStatePresentation(value) {
  const states = {
    live: { label: 'Live', tone: 'good', description: 'Live updates connected' },
    poll: { label: 'Polling', tone: 'warn', description: 'Live stream unavailable; snapshot polling is active' },
    error: { label: 'Offline', tone: 'bad', description: 'Dashboard updates are unavailable' },
    init: { label: 'Connecting', tone: 'neutral', description: 'Connecting to dashboard updates' }
  };
  return states[value] || states.init;
}

export function noticeAutoDismissMs(kind) {
  const normalized = String(kind || 'info').toLowerCase();
  if (normalized === 'error' || normalized === 'warning') return 0;
  if (normalized === 'success') return 6000;
  return 8000;
}

export function cycledItemIndex(index, count, direction) {
  if (count < 1) return -1;
  const current = index >= 0 && index < count ? index : 0;
  const step = direction < 0 ? -1 : 1;
  return (current + step + count) % count;
}

export function terminalFindOffsets(value, query, limit = 500) {
  const content = String(value || '');
  const needle = String(query || '');
  if (!content || !needle) return [];
  const maximum = Math.min(1000, Math.max(1, Math.trunc(Number(limit) || 500)));
  const haystack = content.toLowerCase();
  const normalizedNeedle = needle.toLowerCase();
  const offsets = [];
  let cursor = 0;
  while (offsets.length < maximum) {
    const offset = haystack.indexOf(normalizedNeedle, cursor);
    if (offset < 0) break;
    offsets.push(offset);
    cursor = offset + normalizedNeedle.length;
  }
  return offsets;
}

export function terminalRefreshPresentation(paused) {
  return paused
    ? {
        label: 'Resume',
        pressed: true,
        description: 'Resume live terminal capture',
        notice: 'Live capture paused. The agent keeps running.'
      }
    : {
        label: 'Pause',
        pressed: false,
        description: 'Pause live terminal capture while the agent keeps running',
        notice: 'Live capture resumed. The agent was never paused.'
      };
}

export function sessionFilterCategory(status, attentionCount = 0) {
  const state = String(status?.state || 'unknown').toLowerCase();
  const tone = String(status?.tone || 'warn').toLowerCase();
  if (Number(attentionCount) > 0 || state === 'waiting' || state === 'stopped' || tone === 'bad') return 'needs';
  if (state === 'busy') return 'active';
  if (state === 'idle') return 'idle';
  return 'other';
}

export function sessionStatusPresentation(status, attentionCount = 0) {
  const state = String(status?.state || 'unknown').trim().toLowerCase() || 'unknown';
  const tone = String(status?.tone || 'warn').trim().toLowerCase();
  const reason = String(status?.reason || '').trim();
  let presentation;

  if (Number(attentionCount) > 0 || state === 'waiting') {
    presentation = { label: 'Needs you', tone: 'needs', fallback: 'This session needs your attention.' };
  } else if (state === 'stopped') {
    presentation = { label: 'Stopped', tone: 'stopped', fallback: 'This session is no longer running.' };
  } else if (tone === 'bad') {
    presentation = { label: 'Check', tone: 'check', fallback: 'This session should be inspected.' };
  } else if (state === 'busy') {
    presentation = { label: 'Working', tone: 'working', fallback: 'This session is actively working.' };
  } else if (state === 'idle') {
    presentation = { label: 'Ready', tone: 'ready', fallback: 'This session is ready for input.' };
  } else {
    const label = state === 'unknown'
      ? 'Unknown'
      : state.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
    presentation = { label, tone: 'neutral', fallback: `Session state: ${label}.` };
  }

  return {
    label: presentation.label,
    tone: presentation.tone,
    description: reason || presentation.fallback
  };
}

export function sessionPinPresentation(pinned, displayName = 'session') {
  const name = String(displayName || 'session').trim() || 'session';
  return pinned
    ? {
        symbol: '★',
        visibleLabel: 'Pinned',
        actionLabel: `Unpin ${name}`,
        title: 'Pinned to top. Activate to return this session to recent order.'
      }
    : {
        symbol: '☆',
        visibleLabel: 'Pin',
        actionLabel: `Pin ${name} to top`,
        title: 'Pin this session to the top.'
      };
}

export function sessionFilterMatches(filter, category, searchValue = '', query = '') {
  const selected = SESSION_FILTERS.has(filter) ? filter : 'all';
  const matchesCategory = selected === 'all' || category === selected;
  const needle = String(query || '').trim().toLowerCase();
  return matchesCategory && (!needle || String(searchValue || '').toLowerCase().includes(needle));
}

export function sessionSearchKeyAction(event, resultCount, query = '') {
  if (event?.isComposing || event?.altKey || event?.ctrlKey || event?.metaKey || event?.shiftKey) return null;
  const count = Math.max(0, Number(resultCount) || 0);
  if (event?.key === 'Enter' && count) return 'open-first';
  if (event?.key === 'ArrowDown' && count) return 'focus-first';
  if (event?.key === 'ArrowUp' && count) return 'focus-last';
  if (event?.key === 'Escape' && String(query || '')) return 'clear';
  return null;
}

export function sessionResultCountPresentation(visibleCount, totalCount, constrained) {
  const total = Math.max(0, Number(totalCount) || 0);
  const visible = Math.min(total, Math.max(0, Number(visibleCount) || 0));
  if (!constrained) {
    return {
      label: String(total),
      description: `${total} session${total === 1 ? '' : 's'}`
    };
  }
  return {
    label: `${visible}/${total}`,
    description: `${visible} of ${total} sessions visible`
  };
}

export function terminalTabScrollLeft(viewportWidth, scrollLeft, itemStart, itemEnd, activeChanged) {
  const current = Math.max(0, scrollLeft);
  if (!activeChanged) return current;
  if (itemStart < current) return Math.max(0, itemStart);
  if (itemEnd > current + viewportWidth) return Math.max(0, itemEnd - viewportWidth);
  return current;
}

export function terminalTabKeyIndex(key, index, count) {
  if (count < 1) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowLeft') return cycledItemIndex(index, count, -1);
  if (key === 'ArrowRight') return cycledItemIndex(index, count, 1);
  return -1;
}

export function terminalSwitcherLabel(position, count, displayName, statusLabel = '') {
  const total = Math.max(0, Number(count) || 0);
  const current = Number(position);
  if (!Number.isInteger(current) || current < 0 || current >= total) return 'Minimized terminal';
  const name = String(displayName || '').trim() || 'Terminal';
  const status = String(statusLabel || '').trim();
  return `${current + 1} of ${total} · ${name}${status ? ` · ${status}` : ''}`;
}

export function shouldStickTerminalOutput(item, atBottom, nowMs) {
  const now = Number(nowMs);
  const forceUntil = Number(item?.forceScrollUntil || 0);
  return Boolean(item?.scrollToBottomOnNextOutput || (Number.isFinite(now) && now < forceUntil) || atBottom);
}

export function terminalLatestPresentation(atBottom, hasUnseenOutput) {
  if (atBottom) return { hidden: true, label: 'Latest ↓', description: 'Showing latest terminal output' };
  if (hasUnseenOutput) return { hidden: false, label: 'New output ↓', description: 'New terminal output available; jump to latest' };
  return { hidden: false, label: 'Latest ↓', description: 'Jump to latest terminal output' };
}

export function terminalFocusKind(desktop, editorAvailable) {
  return desktop && editorAvailable ? 'editor' : 'output';
}

export function terminalComposerPresentation(collapsed, hasDraft, draftSaved = true) {
  const draftDescription = draftSaved ? 'draft saved' : 'draft not saved';
  if (collapsed) {
    return {
      label: hasDraft ? 'Reply · draft' : 'Reply',
      description: hasDraft ? `Expand terminal reply composer; ${draftDescription}` : 'Expand terminal reply composer'
    };
  }
  return {
    label: 'Hide',
    description: hasDraft ? `Collapse terminal reply composer; ${draftDescription}` : 'Collapse terminal reply composer'
  };
}

export function terminalDraftPresentation(text, pendingPaste = false, sending = false, storageAvailable = true) {
  if (sending) return { label: 'Sending...', tone: 'busy', description: 'Terminal input is being sent.' };
  if (pendingPaste) return { label: 'Paste awaiting review', tone: 'warn', description: 'Review the pending paste before inserting it.' };
  if (String(text || '').length && !storageAvailable) {
    return { label: 'Draft not saved', tone: 'warn', description: 'Browser storage is unavailable; keep this tab open.' };
  }
  if (String(text || '').length) {
    return { label: 'Draft saved', tone: 'good', description: 'Draft saved in this browser.' };
  }
  return { label: 'No draft', tone: 'neutral', description: 'No terminal reply draft.' };
}

export function promptHistoryOrigin(item) {
  return item?.scheduleId ? 'automated' : 'mine';
}

export function promptHistorySearchValue(item) {
  return [
    item?.target?.displayName,
    item?.session,
    item?.text,
    item?.completionSnapshot,
    item?.completionSummary,
    item?.summaryState
  ].map((value) => String(value || '').trim()).filter(Boolean).join(' ').toLowerCase();
}

export function filterPromptHistory(items, filter, query = '') {
  const list = Array.isArray(items) ? items : [];
  const selected = PROMPT_HISTORY_ORIGINS.has(filter) ? filter : 'all';
  const originMatches = selected === 'all' ? list : list.filter((item) => promptHistoryOrigin(item) === selected);
  const needle = String(query || '').trim().toLowerCase();
  return needle ? originMatches.filter((item) => promptHistorySearchValue(item).includes(needle)) : originMatches;
}

export function promptQueueSectionTarget(section) {
  const name = String(section || '').toLowerCase();
  return PROMPT_QUEUE_SECTIONS.has(name) ? `#prompt-queue-${name}` : null;
}

export function promptQueueComposerPresentation(draft, targetsAvailable) {
  const source = draft || {};
  const text = String(source.text || '');
  const recurring = Boolean(String(source.cron || '').trim());
  const sessions = Array.isArray(source.sessions)
    ? source.sessions.filter(Boolean)
    : String(source.session || '') ? [String(source.session)] : [];
  const selectedCount = new Set(sessions).size;
  const hasTargets = Boolean(targetsAvailable) && selectedCount > 0;
  const hasText = Boolean(text.trim());
  return {
    label: recurring ? 'Create schedule' : selectedCount > 1 ? `Queue for ${selectedCount}` : 'Add prompt',
    sendLabel: selectedCount > 1 ? `Send now to ${selectedCount}` : 'Send now',
    disabled: !hasTargets || !hasText || (recurring && selectedCount !== 1),
    sendDisabled: !hasTargets || !hasText || recurring,
    selectedCount,
    count: `${text.length}/4000`,
    full: text.length >= 4000,
    hasDraft: Boolean(text || recurring)
  };
}

export function normalizedPromptQueueDraft(value) {
  const source = value && typeof value === 'object' ? value : {};
  const legacySession = String(source.session || '').slice(0, 128);
  const sessions = [];
  for (const value of Array.isArray(source.sessions) ? source.sessions : legacySession ? [legacySession] : []) {
    const session = String(value || '').slice(0, 128);
    if (session && !sessions.includes(session) && sessions.length < 12) sessions.push(session);
  }
  return {
    session: sessions[0] || legacySession,
    sessions,
    text: String(source.text || '').slice(0, 4000),
    cron: String(source.cron || '').trim().slice(0, 80)
  };
}

export function isPromptQueueSubmitShortcut(event) {
  return Boolean(
    String(event?.key || '').toLowerCase() === 'enter' &&
    (event?.ctrlKey || event?.metaKey) &&
    !event?.altKey &&
    !event?.shiftKey &&
    !event?.isComposing
  );
}

export function isTerminalFindShortcut(event, editable = false) {
  return Boolean(
    !editable &&
    String(event?.key || '').toLowerCase() === 'f' &&
    (event?.ctrlKey || event?.metaKey) &&
    !event?.altKey &&
    !event?.shiftKey &&
    !event?.isComposing
  );
}

export function terminalLayoutSlots(layout, count, width, height, gap = 10) {
  const mode = TERMINAL_LAYOUTS.has(layout) ? layout : 'free';
  const availableWidth = Math.max(0, Number(width) || 0);
  const availableHeight = Math.max(0, Number(height) || 0);
  const visibleCount = mode === 'focus' ? Math.min(count, 1)
    : mode === 'split' ? Math.min(count, 2)
      : mode === 'grid' ? Math.min(count, 4) : 0;
  if (!visibleCount || mode === 'free') return [];

  const columns = mode === 'grid' && visibleCount > 2 ? 2 : visibleCount;
  const rows = Math.ceil(visibleCount / columns);
  const slotWidth = Math.max(0, (availableWidth - gap * (columns - 1)) / columns);
  const slotHeight = Math.max(0, (availableHeight - gap * (rows - 1)) / rows);
  return Array.from({ length: visibleCount }, (_, index) => ({
    left: (index % columns) * (slotWidth + gap),
    top: Math.floor(index / columns) * (slotHeight + gap),
    width: slotWidth,
    height: slotHeight
  }));
}

export function terminalWorkspaceFrame(layerRect, stageRect, fallbackRect, desktop, keepWithinStage = false) {
  const width = Math.max(0, layerRect.width);
  const height = Math.max(0, layerRect.height);
  if (!desktop) return { left: 0, top: 0, width, height };

  const stageVisible = stageRect.width > 0 && stageRect.height > 0;
  const anchor = stageVisible ? stageRect : fallbackRect;
  const left = Math.min(Math.max(anchor.left - layerRect.left, 0), width);
  const top = Math.min(Math.max(anchor.top - layerRect.top, 0), height);
  const right = keepWithinStage && stageVisible
    ? Math.min(width, Math.max(left, stageRect.right - layerRect.left))
    : width;
  const bottom = keepWithinStage && stageVisible
    ? Math.min(height, Math.max(top, stageRect.bottom - layerRect.top))
    : height;
  return { left, top, width: right - left, height: bottom - top };
}

export function terminalFullHeightBounds(rect, viewportWidth, viewportHeight, inset = 8) {
  const edge = Math.max(0, Number(inset) || 0);
  const availableWidth = Math.max(0, (Number(viewportWidth) || 0) - edge * 2);
  const availableHeight = Math.max(0, (Number(viewportHeight) || 0) - edge * 2);
  const requestedWidth = Math.max(0, Number(rect?.width) || 0);
  const requestedLeft = Number(rect?.left ?? rect?.x);
  const width = Math.min(requestedWidth, availableWidth);
  const maximumLeft = Math.max(edge, availableWidth + edge - width);
  const left = Math.min(Math.max(Number.isFinite(requestedLeft) ? requestedLeft : edge, edge), maximumLeft);

  return {
    left,
    top: edge,
    width,
    height: availableHeight
  };
}
