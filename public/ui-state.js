const DRAWER_NAMES = new Set(['queue', 'tools']);
const TERMINAL_LAYOUTS = new Set(['free', 'focus', 'split', 'grid']);

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
      notice: `${session} started, but its prompt was typed and not submitted. Open the terminal and review it; Host Control will not press Enter again.`,
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
    notice: `${session} started, but Host Control could not confirm that Codex accepted the prompt. Open the terminal and review it; no input was resent.`,
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
