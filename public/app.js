import { agentCreateOutcome, agentDraftSignature, attentionForSession, nextDrawer, terminalFullHeightBounds, terminalLayoutSlots } from './ui-state.js';

const state = {
  snapshot: null,
  terminalWindows: new Map(),
  nextTerminalId: 1,
  topTerminalZ: 30,
  eventSource: null,
  eventRetryTimer: null,
  pollTimer: null,
  snapshotVersion: 0,
  snapshotRequestsInFlight: 0,
  initialViewSelected: false,
  openMissionDetails: new Set(),
  missionHistoryOpen: false,
  missionHistoryLimit: 24,
  activeTerminalId: null,
  selectedSession: null,
  openDrawer: null,
  drawerReturnFocus: null,
  activeToolView: 'overview',
  terminalLayout: 'free',
  terminalFullHeight: false,
  agentFilter: '',
  pinnedSessions: new Set(),
  recentAgentSession: null,
  agentInteractions: new Map(),
  agentTouchSentAt: new Map(),
  resumePreferences: new Map(),
  projectDesk: {
    target: null,
    targetKey: '',
    context: null,
    contextCache: new Map(),
    contextLoading: false,
    contextError: '',
    contextRequestToken: 0,
    customSnippets: null,
    snippetSignature: '',
    review: null,
    notesScope: '',
    notesDirty: false,
    sending: false
  },
  options: { workspaces: [], promptPresets: [], models: [], configuredDefault: {}, reasoningEfforts: [], suggestedName: '' },
  agentDraft: {
    open: false,
    name: '',
    directoryName: '',
    workspace: '__new__',
    preset: '',
    model: '',
    reasoning: '',
    prompt: ''
  },
  missionDraft: {
    open: false,
    title: '',
    workspace: '',
    priority: 'normal',
    goal: '',
    verificationCriteria: 'Review the result and record the evidence that proves the requested outcome.'
  }
};

const DETAIL_REFRESH_MS = 2500;
const SEND_TEXT_MAX = 4000;
const PROJECT_NOTES_MAX = 8000;
const SCRATCHPAD_SNIPPETS_KEY = 'host-control:prompt-snippets:v1';
const SCRATCHPAD_SNIPPET_LIMIT = 50;
const TERMINAL_SEND_HINT = 'Enter sends. Use ↵ or Tab while composing on mobile.';
const TERMINAL_DESKTOP_QUERY = '(min-width: 760px)';
const TERMINAL_PICKER_KEY_MAP = new Map([
  ['ArrowUp', 'up'],
  ['ArrowDown', 'down'],
  ['ArrowLeft', 'left'],
  ['ArrowRight', 'right'],
  ['Enter', 'select'],
  ['Escape', 'cancel']
]);
const NON_SERVICE_TMUX_SESSIONS = new Set(['agent-orchestrator-watchdog']);
const IDLE_SHELL_COMMANDS = new Set(['bash', 'sh', 'zsh']);
let controlSessionRefreshPromise = null;

const els = {
  subtitle: document.querySelector('#host-subtitle'),
  refresh: document.querySelector('#refresh-button'),
  notice: document.querySelector('#notice'),
  snapshotError: document.querySelector('#snapshot-error'),
  agentCount: document.querySelector('#agent-count'),
  serviceCount: document.querySelector('#service-count'),
  portCount: document.querySelector('#port-count'),
  liveState: document.querySelector('#live-state'),
  queueBadge: document.querySelector('#queue-badge'),
  queue: document.querySelector('#queue-view'),
  agents: document.querySelector('#agents-view'),
  services: document.querySelector('#services-view'),
  review: document.querySelector('#review-view'),
  ports: document.querySelector('#ports-view'),
  processes: document.querySelector('#processes-view'),
  audit: document.querySelector('#audit-view'),
  tabs: [...document.querySelectorAll('.tab')],
  views: [...document.querySelectorAll('.view')],
  sessionCount: document.querySelector('#session-count'),
  sessionSearch: document.querySelector('#session-search'),
  sessionList: document.querySelector('#session-list'),
  newAgentContainer: document.querySelector('#new-agent-container'),
  openTerminalCount: document.querySelector('#open-terminal-count'),
  terminalWorkspace: document.querySelector('.terminal-workspace'),
  terminalTabs: document.querySelector('#terminal-tabs'),
  terminalStage: document.querySelector('#terminal-stage'),
  terminalEmpty: document.querySelector('#terminal-empty'),
  projectDesk: document.querySelector('#project-desk'),
  projectDeskTitle: document.querySelector('#project-desk-title'),
  projectDeskSubtitle: document.querySelector('#project-desk-subtitle'),
  projectDeskRefresh: document.querySelector('#project-desk-refresh'),
  projectContextState: document.querySelector('#project-context-state'),
  projectWorkspace: document.querySelector('#project-workspace'),
  projectBranch: document.querySelector('#project-branch'),
  projectChangeSummary: document.querySelector('#project-change-summary'),
  projectCheckSummary: document.querySelector('#project-check-summary'),
  projectChanges: document.querySelector('#project-changes'),
  projectChecks: document.querySelector('#project-checks'),
  projectMissionCard: document.querySelector('#project-mission-card'),
  projectMissionStatus: document.querySelector('#project-mission-status'),
  projectMissionDetail: document.querySelector('#project-mission-detail'),
  projectInstructionCount: document.querySelector('#project-instruction-count'),
  projectInstructions: document.querySelector('#project-instructions'),
  projectLinkCount: document.querySelector('#project-link-count'),
  projectLinks: document.querySelector('#project-links'),
  projectArtifactCount: document.querySelector('#project-artifact-count'),
  projectArtifacts: document.querySelector('#project-artifacts'),
  projectNotes: document.querySelector('#project-notes'),
  projectNotesState: document.querySelector('#project-notes-state'),
  scratchpadTarget: document.querySelector('#scratchpad-target'),
  scratchpadCounter: document.querySelector('#scratchpad-counter'),
  scratchpadSnippetSelect: document.querySelector('#scratchpad-snippet-select'),
  scratchpadSnippetName: document.querySelector('#scratchpad-snippet-name'),
  scratchpadSnippetDelete: document.querySelector('#scratchpad-snippet-delete'),
  scratchpadText: document.querySelector('#scratchpad-text'),
  scratchpadSafety: document.querySelector('#scratchpad-safety'),
  scratchpadReview: document.querySelector('#scratchpad-review'),
  scratchpadReviewPanel: document.querySelector('#scratchpad-review-panel'),
  scratchpadReviewTarget: document.querySelector('#scratchpad-review-target'),
  scratchpadReviewText: document.querySelector('#scratchpad-review-text'),
  scratchpadSendConfirm: document.querySelector('#scratchpad-send-confirm'),
  terminalInspector: document.querySelector('#terminal-inspector'),
  terminalLayer: document.querySelector('#terminal-layer'),
  terminalDock: document.querySelector('#terminal-dock'),
  drawerBackdrop: document.querySelector('#drawer-backdrop'),
  queueDrawer: document.querySelector('#queue-drawer'),
  toolsDrawer: document.querySelector('#tools-drawer'),
  toolsOverview: document.querySelector('#tools-overview'),
  security: document.querySelector('#security-view'),
  toolViews: [...document.querySelectorAll('.tool-view')],
  toolTabs: [...document.querySelectorAll('.tool-tab')]
};

try {
  const storedPins = JSON.parse(window.localStorage.getItem('host-control:pinned-sessions') || '[]');
  if (Array.isArray(storedPins)) state.pinnedSessions = new Set(storedPins.map(String));
  const storedLayout = window.localStorage.getItem('host-control:terminal-layout');
  if (['free', 'focus', 'split', 'grid'].includes(storedLayout)) state.terminalLayout = storedLayout;
} catch {
  // Storage is optional; the terminal remains fully usable without it.
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function shortPath(value) {
  return String(value || '').replace(/^\/home\/[^/]+(?=\/|$)/, '~');
}

function cpuMem(process) {
  if (!process) return 'n/a';
  return `${process.cpu?.toFixed?.(1) ?? process.cpu}% / ${process.mem?.toFixed?.(1) ?? process.mem}%`;
}

function stateClassName(value) {
  const normalized = String(value || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `state-${normalized || 'unknown'}`;
}

function statusClassName(status) {
  return `${status?.tone || 'warn'} ${stateClassName(status?.state)}`;
}

function formatClock(value) {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'n/a';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function checkedLabel(value) {
  const clock = formatClock(value);
  return clock === 'n/a' ? 'checked n/a' : `checked ${clock}`;
}

function timestampMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function sessionCreatedMs(agent) {
  const seconds = Number(agent?.sessionCreated || 0);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return timestampMs(agent?.sessionCreatedAt);
}

function agentInteractionMs(agent) {
  const created = sessionCreatedMs(agent);
  const stored = timestampMs(agent?.lastInteractionAt);
  const local = timestampMs(state.agentInteractions.get(agent?.session)?.at);
  return Math.max(created, stored >= created ? stored : 0, local >= created ? local : 0);
}

function compareAgentInteraction(left, right) {
  return agentInteractionMs(right) - agentInteractionMs(left)
    || sessionCreatedMs(right) - sessionCreatedMs(left)
    || String(left.session || '').localeCompare(String(right.session || ''));
}

function markAgentInteraction(session, kind = 'interaction', at = new Date().toISOString(), { rerender = true } = {}) {
  const nextMs = timestampMs(at);
  if (!session || !nextMs) return;
  const previous = state.agentInteractions.get(session);
  if (timestampMs(previous?.at) > nextMs) return;
  state.agentInteractions.set(session, { at: new Date(nextMs).toISOString(), kind });
  if (rerender && state.snapshot) render({ preserveActiveEditor: true });
}

function lastUsedLabel(agent) {
  const usedAt = agentInteractionMs(agent);
  if (!usedAt) return 'Last used unknown';
  const elapsed = Math.max(0, Date.now() - usedAt);
  if (elapsed < 60_000) return 'Last used just now';
  if (elapsed < 60 * 60_000) return `Last used ${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 24 * 60 * 60_000) return `Last used ${Math.floor(elapsed / (60 * 60_000))}h ago`;
  return `Last used ${new Date(usedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

function shortDuration(ms) {
  const value = Number(ms || 0);
  if (!Number.isFinite(value) || value <= 0) return '';
  const seconds = Math.ceil(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)}m`;
}

function sampleMeta(brief) {
  if (!brief?.sampleCount) return '';
  const checked = formatClock(brief.lastSampledAt);
  return checked === 'n/a' ? `${brief.sampleCount} samples` : `${brief.sampleCount} samples · sampled ${checked}`;
}

function rescueRemainingLabel(rescue) {
  return shortDuration(rescue?.remainingMs) || '';
}

function sshRescueStatusLabel(rescue, exactPublicIpAccess) {
  if (!exactPublicIpAccess) return 'Restart required for exact IP access';
  if (rescue?.active) return `Legacy rescue needs locking ${rescueRemainingLabel(rescue) || 'now'}`;
  return 'Exact /32 access rules';
}

function sshRescueAction(rescue, exactPublicIpAccess) {
  if (!exactPublicIpAccess) {
    return {
      action: '',
      label: 'Restart required for exact IP access',
      tone: 'warn',
      title: 'The running dashboard backend does not yet advertise exact /32-only access controls.',
      disabled: true
    };
  }
  if (rescue?.active) {
    return {
      action: 'ssh-rescue-lock',
      label: 'Secure current IP',
      tone: 'primary',
      title: 'Replaces any legacy broad rescue rule with the detected public /32.'
    };
  }
  return {
    action: 'ssh-rescue-open',
    label: 'Allow current IP',
    tone: 'primary',
    title: 'Authorizes one exact public IPv4 /32 on the configured narrow ports.'
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function setNotice(message, kind = 'info') {
  if (!message) {
    els.notice.classList.add('hidden');
    els.notice.textContent = '';
    return;
  }
  els.notice.textContent = message;
  els.notice.classList.remove('hidden');
  els.notice.dataset.kind = kind;
}

function setSnapshotError(message) {
  if (!message) {
    els.snapshotError.classList.add('hidden');
    els.snapshotError.textContent = '';
    return;
  }
  els.snapshotError.textContent = message;
  els.snapshotError.classList.remove('hidden');
  els.snapshotError.dataset.kind = 'error';
}

function runElementTask(element, task) {
  if (!element || element.dataset.pending === 'true') return;
  element.dataset.pending = 'true';
  element.setAttribute('aria-busy', 'true');
  if ('disabled' in element) element.disabled = true;
  Promise.resolve()
    .then(task)
    .catch((error) => setNotice(`Action failed: ${error.message}`, 'error'))
    .finally(() => {
      element.dataset.pending = 'false';
      element.removeAttribute('aria-busy');
      if ('disabled' in element) element.disabled = false;
    });
}

async function refreshControlSession(signal) {
  if (!controlSessionRefreshPromise) {
    controlSessionRefreshPromise = fetch('/', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal
    }).finally(() => { controlSessionRefreshPromise = null; });
  }
  const refreshed = await controlSessionRefreshPromise;
  if (!refreshed.ok) throw new Error('Dashboard session refresh failed. Reload this page and try again.');
}

async function api(path, options = {}) {
  const { timeoutMs = options.method === 'POST' ? 30000 : 15000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(path, {
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        signal: controller.signal,
        ...fetchOptions
      });
      const raw = await response.text();
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = { detail: raw || `HTTP ${response.status}` }; }
      if (response.ok) return data;

      // A rejected control-session check occurs before any mutation, so both a
      // protected read and a POST are safe to refresh and retry once.
      if (data.error === 'control_session_required' && attempt === 0) {
        await refreshControlSession(controller.signal);
        continue;
      }

      const error = new Error(data.detail || data.output || data.error || `HTTP ${response.status}`);
      error.data = data;
      throw error;
    }
    throw new Error('Dashboard session refresh failed. Reload this page and try again.');
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Request timed out. Check dashboard health before retrying.');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function loadSnapshot(source = 'manual') {
  const version = ++state.snapshotVersion;
  state.snapshotRequestsInFlight += 1;
  els.refresh.disabled = true;
  try {
    const snapshot = await api('/api/snapshot');
    if (version !== state.snapshotVersion) return;
    state.snapshot = snapshot;
    render();
    setSnapshotError(state.snapshot.errors?.[0] || '');
  } catch (error) {
    if (version !== state.snapshotVersion) return;
    if (source !== 'manual') setLiveState('error');
    setSnapshotError(`Refresh failed: ${error.message}`);
  } finally {
    state.snapshotRequestsInFlight = Math.max(0, state.snapshotRequestsInFlight - 1);
    els.refresh.disabled = state.snapshotRequestsInFlight > 0;
  }
}

async function loadOptions() {
  try {
    state.options = await api('/api/options');
    render();
  } catch (error) {
    setNotice(`Option load failed: ${error.message}`, 'error');
  }
}

function setLiveState(value) {
  els.liveState.textContent = value;
  els.liveState.dataset.state = value;
}

function stopPolling() {
  if (!state.pollTimer) return;
  window.clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function scheduleEventReconnect() {
  if (state.eventRetryTimer || !window.EventSource) return;
  state.eventRetryTimer = window.setTimeout(() => {
    state.eventRetryTimer = null;
    connectEvents();
  }, 15000);
}

function connectEvents() {
  if (!window.EventSource) {
    startPolling();
    return;
  }
  state.eventSource?.close();
  state.eventSource = new EventSource('/api/events');
  state.eventSource.addEventListener('open', () => {
    stopPolling();
    setLiveState('live');
  });
  state.eventSource.addEventListener('snapshot', (event) => {
    try {
      state.snapshotVersion += 1;
      state.snapshot = JSON.parse(event.data);
      render({ preserveActiveEditor: true });
      setSnapshotError(state.snapshot.errors?.[0] || '');
      setLiveState('live');
    } catch (error) {
      setLiveState('error');
      setSnapshotError(`Live update failed: ${error.message}`);
    }
  });
  state.eventSource.addEventListener('error', () => {
    setLiveState('poll');
    setSnapshotError('Live updates were interrupted. Falling back to polling.');
    state.eventSource?.close();
    state.eventSource = null;
    startPolling();
    scheduleEventReconnect();
  });
}

function startPolling() {
  if (state.pollTimer) return;
  setLiveState('poll');
  loadSnapshot('poll');
  state.pollTimer = window.setInterval(() => loadSnapshot('poll'), 10000);
}

function render({ preserveActiveEditor = false } = {}) {
  const data = state.snapshot;
  if (!data) return;
  const activeElement = document.activeElement;
  const protectedTerminalEditor = preserveActiveEditor
    && activeElement?.matches?.('.terminal-window input, .terminal-window textarea, .terminal-window select')
    ? activeElement
    : null;
  const protectedViewId = protectedTerminalEditor
    ? 'agents-view'
    : preserveActiveEditor && activeElement?.matches?.('input, textarea, select')
      ? activeElement.closest('.view, #queue-view, #services-view, #security-view, #review-view, #ports-view, #processes-view, #audit-view')?.id || ''
      : '';
  const workerAgents = sortSessionAgents(data.agents.filter((agent) => !isReviewAgent(agent)));
  const visibleServices = data.services.filter(isDisplayableService);
  const runningServices = visibleServices.filter((item) => item.running).length;
  const missionCapability = data.capabilities?.missionQueue === true;
  const attention = normalizedAttention(data);
  const decisionCount = attentionDecisionCount(data, attention);
  els.subtitle.textContent = `${data.host.hostname} · up ${formatUptime(data.host.uptimeSeconds)} · ${new Date(data.host.time).toLocaleTimeString()}`;
  els.agentCount.textContent = workerAgents.length;
  els.serviceCount.textContent = `${runningServices}/${visibleServices.length}`;
  els.portCount.textContent = data.listeners.length;
  els.queueBadge.textContent = String(decisionCount);
  els.queueBadge.classList.toggle('hidden', !missionCapability || decisionCount === 0);
  els.queueBadge.setAttribute('aria-label', `${decisionCount} decision${decisionCount === 1 ? '' : 's'} needed`);
  if (!state.initialViewSelected) {
    state.initialViewSelected = true;
    switchView('agents');
  }
  if (protectedViewId !== 'queue-view') renderMissionQueue(data.missions, workerAgents, missionCapability, data);
  if (protectedViewId !== 'agents-view') {
    renderAgents(workerAgents, data.orchestration, data.security, visibleServices);
    revealRecentAgentCard();
  }
  if (protectedViewId !== 'services-view') renderServices(visibleServices);
  if (protectedViewId !== 'review-view') renderReview(data.review);
  if (protectedViewId !== 'ports-view') renderPorts(data.listeners);
  if (protectedViewId !== 'processes-view') renderProcesses(data.topProcesses);
  if (protectedViewId !== 'audit-view') renderAudit(data.audit || []);
  if (protectedViewId !== 'security-view') renderSecurityTools(data.security);
  renderToolsOverview(data, visibleServices, attention);
  scheduleHealthChecks();
  syncOpenTerminalWindows({ protectedEditor: protectedTerminalEditor });
}

function sortSessionAgents(agents) {
  return [...agents].sort((left, right) =>
    Number(state.pinnedSessions.has(right.session)) - Number(state.pinnedSessions.has(left.session))
      || compareAgentInteraction(left, right));
}

function isReviewAgent(agent) {
  return agent?.session === 'codex-orchestrator-review';
}

function isDisplayableService(service) {
  if (!service?.discovered) return true;
  if (NON_SERVICE_TMUX_SESSIONS.has(service.session)) return false;
  if ((service.portStates || []).some((port) => port.listening)) return true;
  const pane = service.pane;
  const currentCommand = String(pane?.currentCommand || '').toLowerCase();
  if (!IDLE_SHELL_COMMANDS.has(currentCommand)) return true;
  return (pane?.processes || []).some((process) => process.pid !== pane.panePid);
}

function revealRecentAgentCard() {
  const session = state.recentAgentSession;
  if (!session) return;
  window.requestAnimationFrame(() => {
    const card = [...els.sessionList.querySelectorAll('.session-item')]
      .find((item) => item.dataset.session === session);
    if (!card) return;
    state.recentAgentSession = null;
    card.classList.add('recently-started');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

function missionStatusLabel(status) {
  return ({
    backlog: 'backlog',
    ready: 'ready',
    dispatching: 'dispatching',
    running: 'running',
    needs_you: 'needs you',
    verifying: 'verifying',
    reconcile_required: 'check dispatch',
    done: 'done',
    failed: 'failed',
    canceled: 'canceled'
  })[status] || status;
}

function missionTone(status) {
  if (status === 'done') return 'good';
  if (['needs_you', 'reconcile_required', 'failed'].includes(status)) return 'bad';
  if (['dispatching', 'running', 'verifying'].includes(status)) return 'busy';
  if (status === 'canceled') return 'warn';
  return 'neutral';
}

function missionTimeLabel(value) {
  const time = timestampMs(value);
  if (!time) return 'unknown';
  const elapsed = Math.max(0, Date.now() - time);
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))}h ago`;
  return new Date(time).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function listValue(value) {
  return Array.isArray(value) ? value : [];
}

function attentionTone(value, fallback = 'warn') {
  const normalized = String(value || '').toLowerCase();
  if (['critical', 'error', 'failed', 'bad', 'danger'].includes(normalized)) return 'bad';
  if (['info', 'busy', 'working', 'verifying'].includes(normalized)) return 'busy';
  if (['good', 'healthy', 'resolved'].includes(normalized)) return 'good';
  if (['warning', 'warn', 'stale', 'waiting'].includes(normalized)) return 'warn';
  return fallback;
}

function normalizeAttentionItem(item, index = 0) {
  if (!item || typeof item !== 'object') return null;
  const target = item.target && typeof item.target === 'object' ? item.target : {};
  const kind = String(item.kind || item.category || item.type || target.type || 'attention').toLowerCase();
  const missionId = String(item.missionId || item.mission?.id || target.missionId || (kind === 'mission' ? target.id || item.entityId || '' : ''));
  const session = String(item.session || item.agent?.session || target.session || (kind === 'agent' ? target.id || item.entityId || '' : ''));
  const serviceId = String(item.serviceId || item.service?.id || target.serviceId || (kind === 'service' ? target.id || item.entityId || '' : ''));
  const id = String(item.id || item.key || item.dedupeKey || `${kind}:${missionId || session || serviceId || index}`);
  const status = String(item.status || item.state || item.transition || '');
  const decisionValue = item.requiresDecision ?? item.decision ?? item.actionRequired;
  const title = item.title || item.label || item.name
    || (missionId ? 'Mission needs review' : session ? session : serviceId ? serviceId : 'Host attention');
  const detail = item.detail || item.message || item.summary || item.nextAction || item.reason || status || 'Open for details.';
  return {
    ...item,
    id,
    kind,
    missionId,
    session,
    paneId: String(item.paneId || target.paneId || ''),
    serviceId,
    view: String(item.view || target.view || ''),
    title: String(title),
    detail: String(detail),
    status,
    tone: attentionTone(item.tone || item.severity || status),
    requiresDecision: decisionValue === true,
    updatedAt: item.updatedAt || item.createdAt || item.at || null
  };
}

function fallbackAttentionItems(snapshot) {
  const items = [];
  for (const mission of snapshot.missions?.jobs || []) {
    if (!['needs_you', 'reconcile_required', 'failed'].includes(mission.status)) continue;
    items.push(normalizeAttentionItem({
      id: `mission:${mission.id}:${mission.status}`,
      kind: 'mission',
      missionId: mission.id,
      title: mission.title,
      detail: mission.blocker || mission.resultSummary || `Mission is ${missionStatusLabel(mission.status)}.`,
      status: mission.status,
      tone: missionTone(mission.status),
      requiresDecision: true,
      updatedAt: mission.updatedAt
    }, items.length));
  }
  for (const agent of snapshot.orchestration?.agents || []) {
    const stateValue = String(agent.state || '').toLowerCase();
    const visible = agent.needsAttention || agent.tone === 'bad' || ['waiting', 'stopped', 'error', 'missing'].includes(stateValue);
    if (!visible) continue;
    items.push(normalizeAttentionItem({
      id: `agent:${agent.session}:${stateValue || agent.tone || 'attention'}`,
      kind: 'agent',
      session: agent.session,
      title: agent.displayName || agent.session,
      detail: agent.nextAction || agent.stateText || agent.reason || `Agent is ${stateValue || 'waiting'}.`,
      status: stateValue,
      tone: agent.tone,
      requiresDecision: stateValue === 'waiting',
      updatedAt: agent.checkedAt
    }, items.length));
  }
  for (const service of snapshot.services || []) {
    const missingPort = service.running && listValue(service.portStates).some((port) => port.listening === false);
    const unhealthy = service.healthy === false || service.health?.ok === false || service.status?.tone === 'bad'
      || missingPort || ((service.expectedRunning || service.required) && !service.running);
    if (!unhealthy) continue;
    items.push(normalizeAttentionItem({
      id: `service:${service.id}:unhealthy`,
      kind: 'service',
      serviceId: service.id,
      title: service.label || service.id,
      detail: service.health?.detail || (service.running ? 'A required listener or health check is failing.' : 'Expected service is stopped.'),
      status: service.running ? 'unhealthy' : 'stopped',
      tone: 'bad',
      requiresDecision: false,
      updatedAt: snapshot.host?.time
    }, items.length));
  }
  const securityWarnings = listValue(snapshot.security?.warnings);
  for (const warning of securityWarnings) {
    const value = typeof warning === 'string' ? { message: warning } : warning;
    items.push(normalizeAttentionItem({
      ...value,
      id: value.id || `security:${items.length}`,
      kind: 'security',
      title: value.title || 'Security warning',
      tone: value.tone || value.severity || 'warn'
    }, items.length));
  }
  if (snapshot.security?.sshRescue?.active) {
    items.push(normalizeAttentionItem({
      id: 'security:ssh-rescue',
      kind: 'security',
      title: 'Secure network access',
      detail: 'A legacy rescue rule needs to be replaced with the current exact /32 address.',
      tone: 'warn',
      requiresDecision: true,
      view: 'agents'
    }, items.length));
  }
  return items.filter(Boolean);
}

function normalizedAttention(snapshot) {
  const raw = snapshot.attention;
  const sectionValues = Array.isArray(raw?.sections)
    ? raw.sections
    : raw?.sections && typeof raw.sections === 'object'
      ? Object.values(raw.sections)
      : [];
  const explicitLists = [
    ...(Array.isArray(raw) ? [raw] : []),
    ...(raw && typeof raw === 'object' ? [raw.items, raw.feed, raw.needsYou] : []),
    ...sectionValues.map((section) => Array.isArray(section) ? section : section?.items)
  ].filter(Array.isArray);
  const sourceItems = explicitLists.flat();
  const explicitFeed = explicitLists.length > 0;
  const items = (explicitFeed ? sourceItems : fallbackAttentionItems(snapshot))
    .map(normalizeAttentionItem)
    .filter(Boolean);
  const unique = new Map();
  for (const item of items) {
    const key = item.dedupeKey || item.id;
    if (!unique.has(key)) unique.set(key, item);
  }
  const rank = { bad: 0, warn: 1, busy: 2, good: 3 };
  const sorted = [...unique.values()].sort((left, right) =>
    Number(right.requiresDecision) - Number(left.requiresDecision)
      || (rank[left.tone] ?? 4) - (rank[right.tone] ?? 4)
      || timestampMs(right.updatedAt) - timestampMs(left.updatedAt));
  const countValue = raw?.decisionCount ?? raw?.counts?.decisions;
  return {
    items: sorted,
    decisionCount: Number.isFinite(Number(countValue)) ? Math.max(0, Number(countValue)) : null
  };
}

function attentionDecisionCount(snapshot, attention = normalizedAttention(snapshot)) {
  if (attention.decisionCount !== null) return attention.decisionCount;
  return attention.items.filter((item) => item.requiresDecision).length;
}

function normalizedNotifications(snapshot) {
  const raw = snapshot.notifications;
  if (!raw) return [];
  const source = Array.isArray(raw) ? raw : listValue(raw.items).length ? raw.items : listValue(raw.outbox);
  const defaultSnoozeEndpoint = !Array.isArray(raw) ? raw.snoozeEndpoint || raw.links?.snooze || '' : '';
  const unique = new Map();
  source.forEach((item, index) => {
    if (!item || typeof item !== 'object' || ['snoozed', 'dismissed', 'closed'].includes(String(item.status || '').toLowerCase())) return;
    if (timestampMs(item.snoozedUntil) > Date.now()) return;
    const normalized = normalizeAttentionItem(item, index);
    if (!normalized) return;
    const id = String(item.id || item.notificationId || item.dedupeKey || normalized.id);
    unique.set(String(item.dedupeKey || id), {
      ...normalized,
      id,
      openEndpoint: String(item.openEndpoint || item.links?.open || ''),
      snoozeEndpoint: String(item.snoozeEndpoint || item.links?.snooze || defaultSnoozeEndpoint || '')
    });
  });
  return [...unique.values()].sort((left, right) => timestampMs(right.updatedAt) - timestampMs(left.updatedAt));
}

function agentMatchesMissionWorkspace(agent, mission) {
  const workerPath = String(agent?.currentPath || '').replace(/\/+$/, '');
  const missionPath = String(mission?.workspace || '').replace(/\/+$/, '');
  return Boolean(workerPath && missionPath && (workerPath === missionPath || workerPath.startsWith(`${missionPath}/`)));
}

function missionWorkspacesConflict(leftValue, rightValue) {
  const left = String(leftValue || '').replace(/\/+$/, '');
  const right = String(rightValue || '').replace(/\/+$/, '');
  return Boolean(left && right && (
    left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
  ));
}

function activeMissionJobs(excludeId = '') {
  return (state.snapshot?.missions?.jobs || []).filter((job) =>
    job.id !== excludeId && ['dispatching', 'running', 'needs_you', 'verifying', 'reconcile_required'].includes(job.status)
  );
}

function availableMissionWorkers(mission, agents) {
  const activeJobs = activeMissionJobs(mission.id);
  const maxActive = Number(state.snapshot?.missions?.maxActive || 3);
  if (activeJobs.length >= maxActive) return [];
  if (activeJobs.some((job) => missionWorkspacesConflict(job.workspace, mission.workspace))) return [];
  const lockedSessions = new Set(activeJobs
    .map((job) => job.assignedSession)
    .filter(Boolean));
  const candidates = agents.filter((agent) =>
    agent.canSend &&
    agent.agentStatus?.state === 'idle' &&
    !lockedSessions.has(agent.session) &&
    agentMatchesMissionWorkspace(agent, mission));
  return candidates.filter((candidate) => !agents.some((other) =>
    other.session !== candidate.session &&
    other.canSend &&
    missionWorkspacesConflict(other.currentPath, mission.workspace)
  ));
}

function missionDispatchBlockReason(mission, agents) {
  const activeJobs = activeMissionJobs(mission.id);
  const maxActive = Number(state.snapshot?.missions?.maxActive || 3);
  if (activeJobs.length >= maxActive) return `All ${maxActive} active slots are in use.`;
  const workspaceLock = activeJobs.find((job) => missionWorkspacesConflict(job.workspace, mission.workspace));
  if (workspaceLock) return `Workspace is locked by “${workspaceLock.title}”.`;
  const idleMatching = agents.filter((agent) =>
    agent.canSend && agent.agentStatus?.state === 'idle' && agentMatchesMissionWorkspace(agent, mission));
  if (!idleMatching.length) return 'Start or park an idle Codex agent in this project first.';
  if (!availableMissionWorkers(mission, agents).length) return 'Another promptable agent is already open in this workspace.';
  return '';
}

function missionWorkerSelect(mission, agents) {
  const workers = availableMissionWorkers(mission, agents);
  const selected = workers.some((agent) => agent.session === mission.assignedSession) ? mission.assignedSession : workers[0]?.session || '';
  const blockedReason = missionDispatchBlockReason(mission, agents);
  return `
    <label class="mission-worker-field">
      <span>Worker</span>
      <select data-mission-worker aria-label="Worker for ${escapeHtml(mission.title)}">
        <option value="">${workers.length ? 'Choose worker' : 'No idle matching agent'}</option>
        ${workers.map((agent) => `<option value="${escapeHtml(agent.session)}" ${agent.session === selected ? 'selected' : ''}>${escapeHtml(displayNameForSession(agent.session))} · ${escapeHtml(agent.session)}</option>`).join('')}
      </select>
    </label>
    ${blockedReason ? `<p class="mission-worker-hint">${escapeHtml(blockedReason)}</p>` : ''}
  `;
}

function availableMissionAdoptionWorkers(mission, agents) {
  if (!['ready', 'needs_you'].includes(mission.status)) return [];
  if (mission.status === 'needs_you' && mission.worker?.identityMatches) return [];
  const activeJobs = activeMissionJobs(mission.id);
  const maxActive = Number(state.snapshot?.missions?.maxActive || 3);
  if (mission.status === 'ready' && activeJobs.length >= maxActive) return [];
  if (activeJobs.some((job) => missionWorkspacesConflict(job.workspace, mission.workspace))) return [];
  const lockedSessions = new Set(activeJobs.map((job) => job.assignedSession).filter(Boolean));
  return agents.filter((agent) =>
    agent.canSend &&
    agent.agentStatus?.state !== 'stopped' &&
    agent.sessionCreatedAt &&
    agent.id &&
    /^%\d+$/.test(String(agent.tmuxPaneId || '')) &&
    Number.isInteger(agent.panePid) &&
    !lockedSessions.has(agent.session) &&
    agentMatchesMissionWorkspace(agent, mission)
  );
}

function missionAdoptionControl(mission, agents) {
  const workers = availableMissionAdoptionWorkers(mission, agents);
  if (!workers.length) return '';
  return `
    <div class="mission-adoption-control">
      <label class="mission-worker-field">
        <span>Existing work</span>
        <select data-mission-adopt-worker aria-label="Existing worker for ${escapeHtml(mission.title)}">
          ${workers.map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(displayNameForSession(agent.session))} · ${escapeHtml(agent.session)} · ${escapeHtml(agent.agentStatus?.state || 'live')}</option>`).join('')}
        </select>
      </label>
      <div class="mission-actions">
        <button class="action-button warn" data-action="mission-adopt" data-mission-id="${escapeHtml(mission.id)}" data-revision="${mission.revision}" type="button">Adopt Existing Work</button>
      </div>
      <p class="mission-worker-hint">Queue identity only. No prompt or terminal input will be sent.</p>
    </div>
  `;
}

function missionTransitionButton(mission, to, label, tone = '') {
  return `<button class="action-button ${escapeHtml(tone)}" data-action="mission-transition" data-mission-id="${escapeHtml(mission.id)}" data-revision="${mission.revision}" data-to="${escapeHtml(to)}" type="button">${escapeHtml(label)}</button>`;
}

function missionCardActions(mission, agents, queueIndex = -1, queueLength = 0) {
  const workerIdentitySafe = Boolean(mission.worker?.present && mission.worker?.identityMatches);
  const openWorker = mission.assignedSession
    ? workerIdentitySafe
      ? `<button class="action-button" data-action="mission-open-agent" data-session="${escapeHtml(mission.assignedSession)}" data-pane-id="${escapeHtml(mission.assignedPaneId || '')}" type="button">Open Terminal</button>`
      : `<button class="action-button" disabled type="button">${mission.worker?.identityState === 'unavailable' ? 'Worker Identity Lost' : mission.worker?.present ? 'Worker Replaced' : 'Worker Missing'}</button>`
    : '';
  if (mission.status === 'ready') {
    const workers = availableMissionWorkers(mission, agents);
    return `
      ${missionWorkerSelect(mission, agents)}
      <div class="mission-actions">
        <button class="action-button primary" data-action="mission-run" data-mission-id="${escapeHtml(mission.id)}" data-revision="${mission.revision}" ${workers.length ? '' : 'disabled'} type="button">Run Now</button>
        <button class="action-button" data-action="mission-move" data-direction="up" data-mission-id="${escapeHtml(mission.id)}" data-revision="${mission.revision}" ${queueIndex <= 0 ? 'disabled' : ''} type="button" aria-label="Move mission up">↑</button>
        <button class="action-button" data-action="mission-move" data-direction="down" data-mission-id="${escapeHtml(mission.id)}" data-revision="${mission.revision}" ${queueIndex < 0 || queueIndex >= queueLength - 1 ? 'disabled' : ''} type="button" aria-label="Move mission down">↓</button>
        ${missionTransitionButton(mission, 'backlog', 'Hold')}
      </div>
      ${missionAdoptionControl(mission, agents)}
    `;
  }
  if (mission.status === 'backlog') {
    return `<div class="mission-actions">${missionTransitionButton(mission, 'ready', 'Add to Up Next', 'primary')}</div>`;
  }
  if (mission.status === 'running') {
    return `<div class="mission-actions">${openWorker}${missionTransitionButton(mission, 'needs_you', 'Needs Me', 'warn')}${missionTransitionButton(mission, 'verifying', 'Verify', 'primary')}${missionTransitionButton(mission, 'failed', 'Mark Failed', 'danger')}</div>`;
  }
  if (mission.status === 'dispatching') {
    return `<div class="mission-actions">${openWorker}<button class="action-button" disabled type="button">Dispatching…</button>${missionTransitionButton(mission, 'reconcile_required', 'Inspect Dispatch', 'warn')}</div>`;
  }
  if (mission.status === 'verifying') {
    return `<div class="mission-actions">${openWorker}${missionTransitionButton(mission, 'done', 'Pass & Done', 'primary')}${missionTransitionButton(mission, 'running', 'Return to Work')}${missionTransitionButton(mission, 'failed', 'Mark Failed', 'danger')}</div>`;
  }
  if (mission.status === 'needs_you') {
    return `<div class="mission-actions">${openWorker}${missionTransitionButton(mission, 'running', 'Continue', 'primary')}${missionTransitionButton(mission, 'verifying', 'Verify')}${missionTransitionButton(mission, 'ready', 'Requeue')}${missionTransitionButton(mission, 'failed', 'Mark Failed', 'danger')}</div>${missionAdoptionControl(mission, agents)}`;
  }
  if (mission.status === 'reconcile_required') {
    const assumeRunning = workerIdentitySafe
      ? missionTransitionButton(mission, 'running', 'Assume Running', 'warn')
      : '<button class="action-button" disabled type="button">Cannot Assume Worker</button>';
    return `<div class="mission-actions">${openWorker}${assumeRunning}${missionTransitionButton(mission, 'ready', 'Requeue')}${missionTransitionButton(mission, 'failed', 'Mark Failed', 'danger')}</div>`;
  }
  if (mission.status === 'failed') {
    return `<div class="mission-actions"><button class="action-button" data-action="mission-result" data-mission-id="${escapeHtml(mission.id)}" type="button">View Failure</button>${missionTransitionButton(mission, 'ready', 'Requeue', 'primary')}</div>`;
  }
  if (mission.status === 'done' || mission.status === 'canceled') {
    return `<div class="mission-actions"><button class="action-button" data-action="mission-result" data-mission-id="${escapeHtml(mission.id)}" type="button">View Result</button>${missionTransitionButton(mission, 'ready', 'Requeue')}</div>`;
  }
  return '';
}

function missionCard(mission, agents, queueIndex = -1, queueLength = 0) {
  const attentionHint = mission.suggestedAttention && mission.status === 'running'
    ? '<p class="mission-alert">Agent activity suggests this may need your attention.</p>'
    : '';
  const blocker = mission.blocker ? `<p class="mission-alert">${escapeHtml(mission.blocker)}</p>` : '';
  return `
    <article class="mission-card ${escapeHtml(missionTone(mission.status))}" data-mission-id="${escapeHtml(mission.id)}">
      <div class="mission-card-head">
        <div>
          <h3>${escapeHtml(mission.title)}</h3>
          <p>${escapeHtml(mission.priority)} · ${escapeHtml(shortPath(mission.workspace))}</p>
        </div>
        <span class="status ${escapeHtml(missionTone(mission.status))}">${escapeHtml(missionStatusLabel(mission.status))}</span>
      </div>
      ${blocker || attentionHint}
      <p class="mission-goal">${escapeHtml(mission.goal)}</p>
      ${missionCardActions(mission, agents, queueIndex, queueLength)}
      <details class="mission-details" ${state.openMissionDetails.has(mission.id) ? 'open' : ''}>
        <summary>Details</summary>
        <dl>
          <div><dt>Mission</dt><dd>${escapeHtml(mission.id)}</dd></div>
          <div><dt>Verification</dt><dd>${escapeHtml(mission.verificationCriteria)}</dd></div>
          <div><dt>Worker</dt><dd>${escapeHtml(mission.assignedSession || 'unassigned')}</dd></div>
          <div><dt>Attempts</dt><dd>${Number(mission.attempts?.length || 0)}</dd></div>
          ${mission.outcomes?.length ? `<div><dt>Last result</dt><dd>${escapeHtml(mission.outcomes.at(-1)?.note || '')}</dd></div>` : ''}
          <div><dt>Updated</dt><dd>${escapeHtml(missionTimeLabel(mission.updatedAt))}</dd></div>
        </dl>
        ${!['done', 'canceled', 'dispatching'].includes(mission.status) ? `<button class="action-button danger" data-action="mission-transition" data-mission-id="${escapeHtml(mission.id)}" data-revision="${mission.revision}" data-to="canceled" type="button">Cancel Mission</button>` : ''}
      </details>
    </article>
  `;
}

function missionLane(title, detail, jobs, agents, { queue = false } = {}) {
  if (!jobs.length) return '';
  return `
    <section class="mission-lane">
      <div class="mission-lane-head"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p></div><strong>${jobs.length}</strong></div>
      <div class="mission-list">${jobs.map((job, index) => missionCard(job, agents, queue ? index : -1, queue ? jobs.length : 0)).join('')}</div>
    </section>
  `;
}

function attentionKindLabel(item) {
  if (item.missionId || item.kind.includes('mission')) return 'Mission';
  if (item.session || item.kind.includes('agent')) return 'Agent';
  if (item.serviceId || item.kind.includes('service')) return 'Service';
  if (item.kind.includes('security')) return 'Security';
  return 'Host';
}

function attentionCanOpen(item) {
  return Boolean(item.missionId || item.session || item.serviceId || item.view || item.kind.includes('security'));
}

function attentionFeedCard(item, missions, agents) {
  const mission = item.missionId ? missions.find((job) => job.id === item.missionId) : null;
  if (mission) return missionCard(mission, agents);
  return `
    <article class="today-card ${escapeHtml(item.tone)}" data-attention-id="${escapeHtml(item.id)}">
      <div class="today-card-head">
        <span class="today-kind">${escapeHtml(attentionKindLabel(item))}</span>
        ${item.requiresDecision ? '<span class="today-decision">Decision</span>' : `<span class="today-time">${escapeHtml(missionTimeLabel(item.updatedAt))}</span>`}
      </div>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.detail)}</p>
      ${attentionCanOpen(item) ? `<button class="action-button primary" data-action="attention-open" data-attention-id="${escapeHtml(item.id)}" type="button">Open</button>` : ''}
    </article>
  `;
}

function attentionLane(items, missions, agents) {
  if (!items.length) return '';
  const renderedMissionIds = new Set();
  const cards = items.filter((item) => {
    if (!item.missionId) return true;
    if (renderedMissionIds.has(item.missionId)) return false;
    renderedMissionIds.add(item.missionId);
    return true;
  });
  return `
    <section class="mission-lane today-attention-lane">
      <div class="mission-lane-head"><div><h2>Needs You</h2><p>Decisions and exceptions across this host</p></div><strong>${cards.length}</strong></div>
      <div class="mission-list">${cards.map((item) => attentionFeedCard(item, missions, agents)).join('')}</div>
    </section>
  `;
}

function notificationCard(notification) {
  return `
    <article class="notification-card ${escapeHtml(notification.tone)}" data-notification-id="${escapeHtml(notification.id)}">
      <div>
        <span class="today-kind">${escapeHtml(attentionKindLabel(notification))}</span>
        <span class="today-time">${escapeHtml(missionTimeLabel(notification.updatedAt))}</span>
      </div>
      <h3>${escapeHtml(notification.title)}</h3>
      <p>${escapeHtml(notification.detail)}</p>
      <div class="notification-actions">
        <button class="action-button primary" data-action="notification-open" data-notification-id="${escapeHtml(notification.id)}" ${notification.openEndpoint && attentionCanOpen(notification) ? '' : 'disabled'} type="button">Open</button>
        ${notification.snoozeEndpoint ? `<button class="action-button" data-action="notification-snooze" data-notification-id="${escapeHtml(notification.id)}" type="button">Snooze 15m</button>` : ''}
      </div>
    </article>
  `;
}

function notificationLane(notifications) {
  if (!notifications.length) return '';
  return `
    <section class="notification-outbox" aria-label="Notification outbox">
      <div class="mission-lane-head"><div><h2>Notifications</h2><p>New transitions, deduplicated</p></div><strong>${notifications.length}</strong></div>
      <div class="notification-list">${notifications.map(notificationCard).join('')}</div>
    </section>
  `;
}

function missionCreateForm() {
  const draft = state.missionDraft;
  return `
    <details class="mission-create-panel" ${draft.open ? 'open' : ''}>
      <summary>Create mission</summary>
      <form id="mission-create-form" class="mission-create-form">
        <label>Outcome<input name="title" maxlength="${160}" required autocomplete="off" placeholder="Fix login and prove it works" value="${escapeHtml(draft.title)}"></label>
        <label>Project<select name="workspace" required><option value="">Choose project</option>${workspaceSelectOptions(draft.workspace)}</select></label>
        <label>Priority<select name="priority"><option value="urgent" ${draft.priority === 'urgent' ? 'selected' : ''}>Urgent</option><option value="high" ${draft.priority === 'high' ? 'selected' : ''}>High</option><option value="normal" ${draft.priority === 'normal' ? 'selected' : ''}>Normal</option><option value="low" ${draft.priority === 'low' ? 'selected' : ''}>Low</option></select></label>
        <label class="mission-form-wide">Goal / instructions<textarea name="goal" rows="4" maxlength="2600" required placeholder="What should the agent accomplish?">${escapeHtml(draft.goal)}</textarea></label>
        <label class="mission-form-wide">Verification<textarea name="verificationCriteria" rows="2" maxlength="800" required>${escapeHtml(draft.verificationCriteria)}</textarea></label>
        <div class="mission-form-actions mission-form-wide"><button class="primary-button" type="submit">Add to Up Next</button><span>Saving never dispatches automatically. Do not include passwords, tokens, or secrets.</span></div>
      </form>
    </details>
  `;
}

function renderMissionQueue(missions, agents, available, snapshot = state.snapshot || {}) {
  if (!available) {
    els.queue.innerHTML = `<article class="row-card"><h2>Queue</h2><p class="muted">Restart the dashboard backend to activate the durable queue.</p></article>`;
    return;
  }
  const data = missions || { counts: {}, metrics: {}, jobs: [] };
  const jobs = data.jobs || [];
  const attention = normalizedAttention(snapshot);
  const notifications = normalizedNotifications(snapshot);
  const today = new Date().toISOString().slice(0, 10);
  const running = jobs.filter((job) =>
    ['dispatching', 'running', 'verifying'].includes(job.status)
      && !attention.items.some((item) => item.missionId === job.id)
  );
  const upNext = jobs.filter((job) => job.status === 'ready');
  const later = jobs.filter((job) => job.status === 'backlog');
  const doneToday = jobs.filter((job) => job.status === 'done' && String(job.finishedAt || '').startsWith(today));
  const visibleDoneToday = doneToday.slice(0, 12);
  const history = [
    ...doneToday.slice(12),
    ...jobs.filter((job) =>
      ['done', 'canceled'].includes(job.status) && !doneToday.some((item) => item.id === job.id)
    )
  ];
  const visibleHistory = history.slice(0, state.missionHistoryLimit);
  const counts = data.counts || {};
  const decisionCount = attentionDecisionCount(snapshot, attention);
  const activeCount = Number(counts.active || 0);
  const maxActive = Number(data.maxActive || 3);
  const visibleLanes = [
    attentionLane(attention.items, jobs, agents),
    missionLane('In Progress', 'Active work and verification', running, agents),
    missionLane('Up Next', 'Ready for manual dispatch—nothing starts by itself', upNext, agents, { queue: true }),
    missionLane('Later', 'Held work—promote it when you are ready', later, agents),
    missionLane('Done Today', `${data.metrics?.completed || 0} verified total`, visibleDoneToday, agents)
  ].filter(Boolean);
  els.queue.innerHTML = `
    <section class="mission-console">
      <section class="mission-hero">
        <div class="mission-hero-head">
          <div><span class="eyebrow">Exception-driven missions</span><h2>Work queue</h2><p>Decisions first, then active work and the next outcomes.</p></div>
          <button class="primary-button mission-add-button" data-action="mission-create-open" type="button">+ Job</button>
        </div>
        <div class="mission-metrics">
          ${digestMetric('Decisions', decisionCount, decisionCount ? 'needs you' : 'all clear', decisionCount ? 'bad' : 'good')}
          ${digestMetric('Active Slots', activeCount, `${Math.max(0, maxActive - activeCount)} of ${maxActive} free`, activeCount >= maxActive ? 'warn' : 'busy')}
          ${digestMetric('Up Next', counts.ready ?? counts.upNext ?? upNext.length, 'ready to dispatch', 'neutral')}
          ${digestMetric('Later', counts.backlog ?? later.length, 'held', 'neutral')}
          ${digestMetric('Done Today', counts.doneToday || 0, 'verified', 'good')}
        </div>
        ${missionCreateForm()}
      </section>
      <div class="mission-lanes">${visibleLanes.length ? visibleLanes.join('') : '<div class="today-clear"><strong>Nothing needs attention.</strong><span>Create a mission when you are ready for the next outcome.</span></div>'}</div>
      ${notificationLane(notifications)}
      ${history.length ? `<details class="mission-history" ${state.missionHistoryOpen ? 'open' : ''}><summary>History · ${history.length}</summary>${missionLane('Recent Results', 'Older completions and canceled missions', visibleHistory, agents)}${visibleHistory.length < history.length ? `<button class="action-button mission-history-more" data-action="mission-history-more" type="button">Load ${Math.min(24, history.length - visibleHistory.length)} more</button>` : ''}</details>` : ''}
    </section>
  `;
}

function renderAgents(agents, orchestration, security, services = []) {
  const draft = state.agentDraft;
  const workspaceMode = draft.workspace && draft.workspace !== '__new__' ? 'existing' : 'new';
  const model = draft.model || '';
  const reasoning = normalizedReasoning(model, draft.reasoning);
  const createCard = `
    <article class="row-card create-card">
      <details class="new-agent-panel" ${draft.open ? 'open' : ''}>
        <summary>
          <span>
            <strong>New Agent</strong>
            <small>${escapeHtml(draft.name || draft.directoryName || draft.preset || state.options.suggestedName || 'persistent tmux session')}</small>
          </span>
          <span class="summary-hint">Launcher</span>
        </summary>
        <form id="new-agent-form" class="create-agent-form" data-workspace-mode="${workspaceMode}">
          <label>
            Workspace
            <select name="workspace">
              <option value="__new__" ${draft.workspace === '__new__' ? 'selected' : ''}>New folder under agent-workspaces</option>
              ${workspaceSelectOptions(draft.workspace)}
            </select>
            <span class="field-preview">${escapeHtml(workspacePreviewText(draft))}</span>
          </label>
          <label class="new-workspace-field">
            New folder
            <input name="directoryName" autocomplete="off" placeholder="mobile-ui-fix" value="${escapeHtml(draft.directoryName)}">
          </label>
          <label>
            Prompt preset
            <select name="preset">
              <option value="" ${draft.preset ? '' : 'selected'}>Custom prompt</option>
              ${presetSelectOptions(draft.preset)}
            </select>
          </label>
          <div class="model-settings">
            <label>
              Model
              <select name="model" data-model-select>
                ${modelSelectOptions(model)}
              </select>
            </label>
            <label>
              Reasoning
              <select name="reasoning" data-reasoning-select>
                ${reasoningSelectOptions(model, reasoning)}
              </select>
            </label>
          </div>
          <label>
            Agent role / session
            <input name="name" autocomplete="off" placeholder="${escapeHtml(state.options.suggestedName || 'mobile-ui-fix')}" value="${escapeHtml(draft.name)}">
          </label>
          <label class="form-wide">
            Initial prompt
            <textarea name="prompt" rows="3" maxlength="8000" placeholder="Tell the new agent what to work on">${escapeHtml(draft.prompt)}</textarea>
          </label>
          <div class="launcher-actions form-wide">
            <button class="primary-button" type="submit">Start Agent</button>
            <span class="muted">Starts in tmux and stays alive after you close this page.</span>
          </div>
        </form>
      </details>
    </article>
  `;
  els.sessionCount.textContent = String(agents.length);
  els.sessionList.innerHTML = agents.length
    ? agents.map((agent) => sessionRailItem(agent, orchestration)).join('')
    : '<div class="session-empty">No Codex sessions are visible.</div>';
  els.newAgentContainer.innerHTML = createCard;
  if (els.sessionSearch.value !== state.agentFilter) els.sessionSearch.value = state.agentFilter;
  filterSessionRail(state.agentFilter);

  const activeSession = state.terminalWindows.get(state.activeTerminalId)?.session;
  if (activeSession) state.selectedSession = activeSession;
  if (state.selectedSession && !agents.some((agent) => agent.session === state.selectedSession)) state.selectedSession = null;
  renderTerminalInspector(agents, orchestration);
  renderTerminalChrome();
}

function sessionAttentionItems(session) {
  const snapshot = state.snapshot || {};
  const direct = attentionForSession(normalizedAttention(snapshot).items, session);
  const missionItems = (snapshot.missions?.jobs || [])
    .filter((mission) => mission.assignedSession === session && ['needs_you', 'reconcile_required', 'failed'].includes(mission.status))
    .map((mission) => normalizeAttentionItem({
      id: `mission:${mission.id}:${mission.status}`,
      kind: 'mission',
      missionId: mission.id,
      session,
      title: mission.title,
      detail: mission.blocker || mission.resultSummary || `Mission is ${missionStatusLabel(mission.status)}.`,
      status: mission.status,
      tone: missionTone(mission.status),
      requiresDecision: true,
      updatedAt: mission.updatedAt
    }));
  const unique = new Map();
  [...direct, ...missionItems].filter(Boolean).forEach((item) => unique.set(item.id, item));
  return [...unique.values()];
}

function sessionRailItem(agent, orchestration) {
  const brief = orchestration?.agents?.find((item) => item.session === agent.session) || {};
  const status = agent.agentStatus || { state: 'unknown', tone: 'warn' };
  const statusClass = statusClassName(status);
  const displayName = brief.displayName || agent.session;
  const attention = sessionAttentionItems(agent.session);
  const decisions = attention.filter((item) => item.requiresDecision).length;
  const isOpen = [...state.terminalWindows.values()].some((item) => item.session === agent.session && item.mode !== 'static');
  const pinned = state.pinnedSessions.has(agent.session);
  const searchValue = `${displayName} ${agent.session} ${agent.currentPath || ''} ${brief.task || ''}`.toLowerCase();
  return `
    <article class="session-item ${escapeHtml(statusClass)} ${isOpen ? 'is-open' : ''}" data-session="${escapeHtml(agent.session)}" data-session-search="${escapeHtml(searchValue)}">
      <button class="session-open" data-action="agent-detail" data-session="${escapeHtml(agent.session)}" type="button" aria-label="Open ${escapeHtml(displayName)} terminal">
        <span class="session-state-dot" aria-hidden="true"></span>
        <span class="session-copy"><strong>${escapeHtml(displayName)}</strong><small>${escapeHtml(shortPath(agent.currentPath))}</small><em>${escapeHtml(lastUsedLabel(agent))}</em></span>
        ${attention.length ? `<span class="session-attention ${decisions ? 'decision' : ''}" title="${escapeHtml(`${attention.length} item${attention.length === 1 ? '' : 's'} need attention`)}">${decisions || attention.length}</span>` : ''}
      </button>
      <button class="session-pin ${pinned ? 'active' : ''}" data-action="session-pin" data-session="${escapeHtml(agent.session)}" type="button" aria-pressed="${pinned ? 'true' : 'false'}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${escapeHtml(displayName)}">${pinned ? '●' : '○'}</button>
    </article>
  `;
}

function filterSessionRail(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  state.agentFilter = value;
  let visible = 0;
  for (const item of els.sessionList.querySelectorAll('.session-item')) {
    const matches = !normalized || item.dataset.sessionSearch.includes(normalized);
    item.hidden = !matches;
    if (matches) visible += 1;
  }
  els.sessionList.classList.toggle('has-no-results', Boolean(normalized) && visible === 0);
}

function selectedAgent(agents = state.snapshot?.agents || []) {
  const activeSession = state.terminalWindows.get(state.activeTerminalId)?.session;
  const session = activeSession || state.selectedSession;
  return agents.find((agent) => agent.session === session && !isReviewAgent(agent)) || null;
}

function renderTerminalInspector(agents, orchestration) {
  const agent = selectedAgent(agents);
  if (!agent) {
    els.terminalInspector.innerHTML = '<div class="inspector-empty"><span class="eyebrow">Inspector</span><h2>No session selected</h2><p>Open a terminal to see its task, mission, and anything that needs you.</p></div>';
    return;
  }
  const brief = orchestration?.agents?.find((item) => item.session === agent.session) || {};
  const status = agent.agentStatus || { state: 'unknown', tone: 'warn', reason: '' };
  const mission = activeMissionForAgentSession(agent.session);
  const attention = sessionAttentionItems(agent.session);
  const pinned = state.pinnedSessions.has(agent.session);
  const task = brief.task || agent.lastLine || `Working in ${shortPath(agent.currentPath)}.`;
  const activity = brief.activity || agent.lastLine || 'No recent summarized signal.';
  const next = observationNextAction(brief, status, task);
  els.terminalInspector.innerHTML = `
    <div class="inspector-head"><div><span class="eyebrow">Selected agent</span><h2>${escapeHtml(brief.displayName || agent.session)}</h2><p>tmux ${escapeHtml(agent.session)} · ${escapeHtml(shortPath(agent.currentPath))}</p></div><span class="status ${escapeHtml(statusClassName(status))}">${escapeHtml(status.state)}</span></div>
    <div class="inspector-actions"><button class="action-button primary" data-action="agent-detail" data-session="${escapeHtml(agent.session)}" type="button">Open</button><button class="action-button" data-action="session-pin" data-session="${escapeHtml(agent.session)}" type="button">${pinned ? 'Unpin' : 'Pin'}</button><button class="action-button" data-action="copy-attach" data-session="${escapeHtml(agent.session)}" type="button">Copy attach</button></div>
    ${attention.length ? `<section class="inspector-attention"><div class="inspector-section-head"><strong>Needs you</strong><span>${attention.length}</span></div>${attention.map((item) => `<button class="inspector-attention-item ${escapeHtml(item.tone)}" data-action="attention-open" data-attention-id="${escapeHtml(item.id)}" type="button"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></button>`).join('')}</section>` : ''}
    <section class="inspector-summary"><div><span>Current task</span><p>${escapeHtml(task)}</p></div><div><span>Last signal</span><p>${escapeHtml(activity)}</p></div><div><span>Next</span><p>${escapeHtml(next)}</p></div></section>
    ${mission ? `<section class="inspector-mission ${escapeHtml(missionTone(mission.status))}"><div class="inspector-section-head"><strong>Mission</strong><span>${escapeHtml(missionStatusLabel(mission.status))}</span></div><h3>${escapeHtml(mission.title)}</h3><p>${escapeHtml(mission.blocker || mission.goal)}</p><button class="action-button" data-action="mission-open-queue" data-mission-id="${escapeHtml(mission.id)}" type="button">Open in queue</button></section>` : ''}
    <details class="inspector-recovery"><summary>Recovery controls</summary><div><button class="action-button" data-action="peek" data-session="${escapeHtml(agent.session)}" type="button">Peek output</button><button class="action-button warn" data-action="interrupt-agent" data-session="${escapeHtml(agent.session)}" type="button">Send Ctrl-C</button><button class="action-button danger" data-action="session-stop" data-session="${escapeHtml(agent.session)}" type="button">Stop session</button></div></details>
  `;
}

function orchestrationBrief(orchestration, security, services = [], workerRows = '', createCard = '') {
  const tone = orchestration?.tone || 'warn';
  const listener = orchestration?.listener || {};
  const sshRescue = security?.sshRescue || {};
  const exactPublicIpAccess = state.snapshot?.capabilities?.exactPublicIpAccess === true;
  const ipRuleManagement = state.snapshot?.capabilities?.ipRuleManagement === true;
  const safeIpRuleControls = exactPublicIpAccess && ipRuleManagement;
  const accessAction = sshRescueAction(sshRescue, safeIpRuleControls);
  const ipRulesTitle = ipRuleManagement
    ? 'Show the current security-group inbound rules and cleanup scope.'
    : 'Restart the dashboard backend to enable IP rule inventory and cleanup.';
  const counts = orchestration?.counts || {};
  const summary = listener.summary || 'Listening to current agent panes. Run Review for a fresh deeper pass.';
  const agents = orchestration?.agents || [];
  const allIssueItems = agents.filter((item) => item.needsAttention);
  const allWorkingItems = agents.filter((item) => item.state === 'busy');
  const allIdleItems = agents.filter((item) => item.state === 'idle');
  const issueItems = allIssueItems.slice(0, 4);
  const busyCount = counts.busy ?? allWorkingItems.length;
  const waitingCount = counts.waiting ?? agents.filter((item) => item.state === 'waiting').length;
  const idleCount = counts.idle ?? allIdleItems.length;
  const issueCount = counts.issues ?? allIssueItems.length;
  const workerCount = counts.workers ?? agents.length;
  const nextText = issueItems[0]?.nextAction
    || (allWorkingItems.length ? 'Let active agents continue; open one if progress looks stale.' : '')
    || (allIdleItems.length ? 'Send work to an idle agent or close sessions you no longer need.' : '')
    || 'Start or resume an agent when there is work to delegate.';
  const headlineText = issueCount
    ? `${issueCount} agent${issueCount === 1 ? '' : 's'} ${issueCount === 1 ? 'needs' : 'need'} attention`
    : waitingCount
      ? `${waitingCount} agent${waitingCount === 1 ? '' : 's'} waiting for input`
      : workerCount
        ? `${busyCount} working, ${idleCount} idle, no blockers spotted`
        : 'No worker agents visible';
  const runningServices = services.filter((service) => service.running).length;
  const orderedServices = prioritizedServices(services);
  const runningServiceItems = orderedServices.filter((service) => service.running);
  const serviceRailItems = [
    ...runningServiceItems,
    ...orderedServices.filter((service) => !service.running).slice(0, Math.max(0, 10 - runningServiceItems.length))
  ];
  return `
    <section class="ops-console ${escapeHtml(tone)}">
      <section class="overview-panel">
        <div class="overview-hero">
          <div>
            <span class="eyebrow">Agent command center</span>
            <h2>Right now</h2>
            <p>${escapeHtml(headlineText)}</p>
          </div>
          <span class="status ${escapeHtml(listener.running ? tone : 'warn')}">${listener.running ? 'listening' : 'review offline'}</span>
        </div>
        <div class="overview-metrics">
          ${digestMetric('Needs you', issueCount, issueCount ? 'open these first' : 'all clear', issueCount ? 'bad' : 'good')}
          ${digestMetric('Working', busyCount, 'active now', 'busy')}
          ${digestMetric('Waiting', waitingCount, 'needs input', waitingCount ? 'bad' : 'neutral')}
          ${digestMetric('Idle', idleCount, 'ready for work', 'neutral')}
        </div>
        <div class="overview-next">
          <div>
            <strong>Best next action</strong>
            <span>${escapeHtml(nextText)}</span>
            <small>${escapeHtml(firstSummaryLine(summary))}</small>
          </div>
          <div class="overview-actions">
            <button class="action-button primary" data-action="new-agent-open" type="button">New Agent</button>
            <button class="action-button" data-action="open-active-agents" type="button">Open Active</button>
            <button class="action-button" data-action="review-start" type="button">Run Review</button>
          </div>
        </div>
      </section>

      <section class="workers-panel">
        <div class="panel-head compact">
          <div>
            <h2>Agents</h2>
            <p>${escapeHtml(`${workerCount} total · ${runningServices}/${services.length} services · ${sshRescueStatusLabel(sshRescue, safeIpRuleControls)}`)}</p>
          </div>
          <button class="action-button" data-action="dashboard-refresh" type="button">Refresh</button>
        </div>
        <div class="worker-list">${workerRows || empty('No worker Codex agent sessions found.')}</div>
      </section>

      <aside class="ops-rail">
        ${createCard}

        <section class="rail-panel attention-panel">
          <div class="panel-head compact">
            <div>
              <h2>Needs Me</h2>
              <p>${escapeHtml(issueCount ? `${issueCount} item${issueCount === 1 ? '' : 's'} to inspect` : 'No blockers spotted')}</p>
            </div>
          </div>
          ${issueItems.length ? `<div class="attention-list">${issueItems.map(attentionItem).join('')}</div>` : `<div class="rail-empty">Nothing waiting on you.</div>`}
        </section>

        <section class="rail-panel service-strip">
          <div class="panel-head compact">
            <div>
              <h2>Services</h2>
              <p>${escapeHtml(`${runningServices}/${services.length} running`)}</p>
            </div>
          </div>
          <div class="service-chip-list">${serviceRailItems.map(serviceChip).join('')}</div>
        </section>

        <section class="rail-panel command-panel">
          <div class="actions compact-actions">
            <button class="action-button ${escapeHtml(accessAction.tone)}" data-action="${escapeHtml(accessAction.action)}" title="${escapeHtml(accessAction.title)}" ${accessAction.disabled ? 'disabled' : ''} type="button">${escapeHtml(accessAction.label)}</button>
            <button class="action-button" data-action="ip-rules-view" title="${escapeHtml(ipRulesTitle)}" ${ipRuleManagement ? '' : 'disabled'} type="button">IP Rules</button>
            <button class="action-button warn" data-action="ip-rules-cleanup" title="${escapeHtml(ipRulesTitle)}" ${ipRuleManagement ? '' : 'disabled'} type="button">Clean Managed IPs</button>
            <button class="action-button" data-action="switch-review" type="button">Review Pane</button>
          </div>
        </section>

      </aside>
    </section>
  `;
}

function digestMetric(label, value, detail, tone = 'neutral') {
  return `
    <div class="digest-metric ${escapeHtml(tone)}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail)}</small>
    </div>
  `;
}

function attentionItem(agent) {
  return `
    <button class="attention-item ${escapeHtml(agent.tone || 'warn')}" data-action="agent-detail" data-session="${escapeHtml(agent.session)}" type="button">
      <strong>${escapeHtml(agent.displayName || agent.session)}</strong>
      <span>${escapeHtml(agent.nextAction || agent.stateText || 'Open details')}</span>
    </button>
  `;
}

function serviceChip(service) {
  const badPorts = service.portStates?.filter((item) => !item.listening) || [];
  const tone = service.managed && badPorts.length === 0 ? 'good' : service.running ? 'warn' : service.external ? 'warn' : 'bad';
  return `
    <button class="service-chip ${escapeHtml(tone)}" data-action="switch-services" data-service="${escapeHtml(service.id)}" type="button">
      <span>${escapeHtml(service.label || service.id)}</span>
      <em>${escapeHtml(`${service.discovered ? 'auto · ' : ''}${service.running ? 'running' : service.external ? 'external' : 'down'}`)}</em>
    </button>
  `;
}

function serviceSortScore(service) {
  const listening = (service.portStates || []).some((port) => port.listening);
  if (service.running && listening) return 0;
  if (service.running) return 1;
  if (!service.discovered) return 2;
  return 3;
}

function prioritizedServices(services = []) {
  return [...services].sort((left, right) => {
    const priority = serviceSortScore(left) - serviceSortScore(right);
    if (priority) return priority;
    return String(left.label || left.id).localeCompare(String(right.label || right.id));
  });
}

function renderToolsOverview(snapshot, services, attention) {
  const runningServices = services.filter((service) => service.running).length;
  const unhealthyServices = services.filter((service) =>
    service.healthy === false
      || service.health?.ok === false
      || (service.running && (service.portStates || []).some((port) => !port.listening)));
  const notifications = normalizedNotifications(snapshot);
  const decisions = attentionDecisionCount(snapshot, attention);
  const securityWarnings = attention.items.filter((item) => item.kind.includes('security'));
  const serviceItems = prioritizedServices(services).slice(0, 8);
  els.toolsOverview.innerHTML = `
    <section class="tools-overview-grid">
      <button class="tool-summary-card ${unhealthyServices.length ? 'bad' : 'good'}" data-action="tool-view" data-tool-view="services" type="button"><span>Services</span><strong>${runningServices}/${services.length}</strong><small>${unhealthyServices.length ? `${unhealthyServices.length} unhealthy` : 'No health failures'}</small></button>
      <button class="tool-summary-card ${securityWarnings.length ? 'warn' : 'good'}" data-action="tool-view" data-tool-view="security" type="button"><span>Security</span><strong>${securityWarnings.length}</strong><small>${securityWarnings.length ? 'warnings' : 'No warnings'}</small></button>
      <button class="tool-summary-card ${decisions ? 'bad' : 'good'}" data-action="drawer-toggle" data-drawer="queue" type="button"><span>Queue</span><strong>${decisions}</strong><small>${decisions ? 'decisions need you' : 'No decisions'}</small></button>
      <button class="tool-summary-card ${notifications.length ? 'busy' : 'neutral'}" data-action="drawer-toggle" data-drawer="queue" type="button"><span>Notifications</span><strong>${notifications.length}</strong><small>${notifications.length ? 'open or snooze' : 'Outbox clear'}</small></button>
    </section>
    <section class="tool-panel">
      <div class="panel-head compact"><div><h2>Service pulse</h2><p>Visibility first; controls stay inside Services.</p></div><button class="action-button" data-action="tool-view" data-tool-view="services" type="button">All services</button></div>
      <div class="service-chip-list">${serviceItems.length ? serviceItems.map(serviceChip).join('') : '<div class="rail-empty">No registered services.</div>'}</div>
    </section>
    ${notifications.length ? `
      <section class="tool-panel tools-notifications">
        <div class="panel-head compact"><div><h2>Notifications</h2><p>Open or snooze without leaving the terminal workspace.</p></div><strong>${notifications.length}</strong></div>
        <div class="notification-list">${notifications.slice(0, 4).map(notificationCard).join('')}</div>
        ${notifications.length > 4 ? `<button class="action-button" data-action="drawer-toggle" data-drawer="queue" type="button">Open all ${notifications.length}</button>` : ''}
      </section>
    ` : ''}
    <section class="tool-panel">
      <div class="panel-head compact"><div><h2>Host</h2><p>${escapeHtml(snapshot.host?.hostname || 'unknown host')}</p></div><span class="status ${escapeHtml(snapshot.errors?.length ? 'bad' : 'good')}">${snapshot.errors?.length ? 'check' : 'healthy'}</span></div>
      <div class="tool-host-grid">
        <div><span>Uptime</span><strong>${escapeHtml(formatUptime(snapshot.host?.uptimeSeconds || 0))}</strong></div>
        <div><span>Listeners</span><strong>${Number(snapshot.listeners?.length || 0)}</strong></div>
        <div><span>Agents</span><strong>${Number(snapshot.agents?.filter((agent) => !isReviewAgent(agent)).length || 0)}</strong></div>
        <div><span>Live updates</span><strong>${escapeHtml(els.liveState.textContent || 'init')}</strong></div>
      </div>
      <div class="actions compact-actions"><button class="action-button" data-action="dashboard-refresh" type="button">Refresh snapshot</button><button class="action-button" data-action="tool-view" data-tool-view="system" type="button">Diagnostics</button></div>
    </section>
  `;
}

function renderSecurityTools(security = {}) {
  const sshRescue = security?.sshRescue || {};
  const exactPublicIpAccess = state.snapshot?.capabilities?.exactPublicIpAccess === true;
  const ipRuleManagement = state.snapshot?.capabilities?.ipRuleManagement === true;
  const safeIpRuleControls = exactPublicIpAccess && ipRuleManagement;
  const accessAction = sshRescueAction(sshRescue, safeIpRuleControls);
  const warnings = normalizedAttention(state.snapshot || {}).items.filter((item) => item.kind.includes('security'));
  els.security.innerHTML = `
    <section class="tool-panel security-panel">
      <div class="panel-head"><div><span class="eyebrow">Inbound access</span><h2>Exact IP rules</h2><p>${escapeHtml(sshRescueStatusLabel(sshRescue, safeIpRuleControls))}</p></div><span class="status ${warnings.length ? 'warn' : 'good'}">${warnings.length ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : 'clear'}</span></div>
      <p class="security-explainer">PaneFleet only manages its allowlisted security-group rules. Current browser and active SSH addresses are protected during cleanup.</p>
      <div class="security-actions">
        <button class="action-button ${escapeHtml(accessAction.tone)}" data-action="${escapeHtml(accessAction.action)}" title="${escapeHtml(accessAction.title)}" ${accessAction.disabled ? 'disabled' : ''} type="button">${escapeHtml(accessAction.label)}</button>
        <button class="action-button" data-action="ip-rules-view" ${ipRuleManagement ? '' : 'disabled'} type="button">View inbound rules</button>
        <button class="action-button warn" data-action="ip-rules-cleanup" ${ipRuleManagement ? '' : 'disabled'} type="button">Clean managed IPs</button>
      </div>
    </section>
    ${warnings.length ? `<section class="tool-panel"><div class="panel-head compact"><div><h2>Warnings</h2><p>Open the exact source for context.</p></div></div><div class="attention-list">${warnings.map((item) => `<button class="attention-item ${escapeHtml(item.tone)}" data-action="attention-open" data-attention-id="${escapeHtml(item.id)}" type="button"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></button>`).join('')}</div></section>` : ''}
  `;
}

function workerRow(agent, orchestration) {
  const process = agent.primaryProcess;
  const status = agent.agentStatus || { state: agent.attached ? 'attached' : 'detached', tone: agent.attached ? 'good' : 'warn', reason: '' };
  const statusClass = statusClassName(status);
  const brief = orchestration?.agents?.find((item) => item.session === agent.session) || {};
  const displayName = brief.displayName || agent.session;
  const historyMeta = sampleMeta(brief);
  const canResume = agent.canResume || brief.canResume;
  const focus = brief.task || agent.lastLine || `No clear task visible; ${shortPath(agent.currentPath)} is the active workspace.`;
  const activity = brief.activity || agent.lastLine || 'No recent visible output.';
  const next = observationNextAction(brief, status, focus);
  const resumePreference = state.resumePreferences.get(agent.session) || { model: '', reasoning: '' };
  return `
    <article class="worker-row agent-card ${escapeHtml(statusClass)}" data-session="${escapeHtml(agent.session)}">
      <div class="worker-card-head">
        <div class="worker-main">
          <span class="agent-glyph" aria-hidden="true">&gt;_</span>
          <div>
            <div class="worker-title">
              <h2>${escapeHtml(displayName)}</h2>
              <span class="status ${escapeHtml(statusClass)}">${escapeHtml(status.state)}</span>
            </div>
            <p><span class="session-id">tmux ${escapeHtml(agent.session)}</span> · ${escapeHtml(shortPath(agent.currentPath))}</p>
          </div>
        </div>
        <div class="worker-actions">
          <button class="action-button primary" data-action="agent-detail" data-session="${escapeHtml(agent.session)}" type="button">Open Terminal</button>
          <button class="action-button" data-action="copy-attach" data-session="${escapeHtml(agent.session)}" type="button">Copy Attach</button>
          <details class="more-menu">
            <summary>More</summary>
            <div>
              ${canResume ? `
                <div class="resume-config model-settings" data-session="${escapeHtml(agent.session)}">
                  <strong>Resume settings</strong>
                  <label>Model<select data-model-select>${modelSelectOptions(resumePreference.model)}</select></label>
                  <label>Reasoning<select data-reasoning-select>${reasoningSelectOptions(resumePreference.model, resumePreference.reasoning)}</select></label>
                  <button class="action-button primary" data-action="agent-resume" data-session="${escapeHtml(agent.session)}" type="button">Resume Agent</button>
                </div>
              ` : ''}
              <button class="action-button" data-action="peek" data-session="${escapeHtml(agent.session)}" type="button">Peek Output</button>
              <button class="action-button warn" data-action="interrupt-agent" data-session="${escapeHtml(agent.session)}" type="button">Send Ctrl-C</button>
              <button class="action-button danger" data-action="session-stop" data-session="${escapeHtml(agent.session)}" type="button">Stop tmux Session</button>
            </div>
          </details>
        </div>
      </div>
      <div class="worker-task"><span>Current task</span><strong>${escapeHtml(focus)}</strong></div>
      <div class="worker-detail-grid">
        <div><span>Last signal</span><p>${escapeHtml(activity)}</p></div>
        <div><span>Next</span><p>${escapeHtml(next)}</p></div>
      </div>
      <div class="worker-card-meta"><span>${escapeHtml(lastUsedLabel(agent))} · ${escapeHtml(historyMeta || 'collecting history')}</span><span>CPU / Mem ${escapeHtml(cpuMem(process))}</span></div>
    </article>
  `;
}

function firstSummaryLine(value) {
  const line = String(value || '').split('\n').map((item) => item.trim()).find(Boolean);
  return line || 'Live worker scan is active.';
}

function hasUnresolvedPromptPlaceholder(value) {
  return /(^|\s)@(?:filename|file|path|todo|target)\b/i.test(String(value || ''));
}

function runtimeNextAction(status) {
  if (status?.state === 'waiting') return 'Open details and respond, or interrupt if it is stale.';
  if (status?.tone === 'bad') return 'Open details and inspect the recent output before giving it more work.';
  if (status?.state === 'busy') return 'Let it continue, but open details if the last signal does not change.';
  if (status?.state === 'idle') return 'Review output and either close it or send a new prompt.';
  return 'Keep monitoring.';
}

function observationNextAction(brief, status, focus) {
  if (hasUnresolvedPromptPlaceholder(focus)) {
    return 'Send a corrected prompt with the real file/path, or open the terminal to inspect what it did.';
  }
  const value = brief.nextAction || '';
  if (!value || /passive history/i.test(value)) return runtimeNextAction(status);
  return value;
}

function renderServices(services) {
  els.services.innerHTML = prioritizedServices(services).map((service) => {
    const badPorts = service.portStates.filter((item) => !item.listening);
    const statusClass = service.managed && badPorts.length === 0 ? 'good' : service.running ? 'warn' : service.external ? 'warn' : 'bad';
    const ports = service.portStates.length
      ? service.portStates.map((item) => `${item.port}:${item.listening ? 'open' : 'closed'}`).join(' · ')
      : 'no fixed ports';
    const builtInActions = service.command && service.session && !service.discovered
      ? builtinServiceActions(service)
      : '';
    const customActions = (service.actions || []).map((action) => `
      <button class="action-button ${action.confirm ? 'warn' : ''}" data-action="service-custom" data-service="${escapeHtml(service.id)}" data-custom-action="${escapeHtml(action.id)}" data-confirm="${action.confirm ? '1' : ''}" data-requires-public-ip="${action.requiresPublicIp ? '1' : ''}" type="button">${escapeHtml(action.label)}</button>
    `).join('');
    const genericSessionActions = service.discovered && service.session
      ? `
        <button class="action-button primary" data-action="peek" data-session="${escapeHtml(service.session)}" type="button">Peek Output</button>
        <button class="action-button" data-action="copy-attach" data-session="${escapeHtml(service.session)}" type="button">Copy Terminal Command</button>
        <details class="more-menu">
          <summary>Recovery</summary>
          <div>
            <button class="action-button warn" data-action="session-interrupt" data-session="${escapeHtml(service.session)}" type="button">Send Ctrl-C</button>
            <button class="action-button danger" data-action="session-stop" data-session="${escapeHtml(service.session)}" type="button">Stop tmux Session</button>
          </div>
        </details>
      `
      : '';
    return `
      <article class="row-card target-card" data-service-id="${escapeHtml(service.id)}" tabindex="-1">
        <div class="row-head">
          <div class="row-title">
            <h2>${escapeHtml(service.label)}</h2>
            <p>${escapeHtml(service.discovered ? 'Auto-discovered target' : shortPath(service.cwd))}</p>
          </div>
          <span class="status ${statusClass}">${escapeHtml(service.stateLabel || 'unknown')}</span>
        </div>
        <div class="meta-grid">
          ${meta('Managed terminal', service.session || service.sessionPrefixes?.join(', ') || 'none')}
          ${meta('Ports', ports)}
          ${meta('Source', service.discovered ? 'auto discovery' : service.external ? 'registry / external' : 'registry')}
          ${meta('CPU / Mem', cpuMem(service.pane?.primaryProcess))}
        </div>
        ${outputBlock('Last output', service.lastOutput || service.lastLine, service.redactedPreviewCount)}
        ${codeBlock('Command / start command', service.pane?.primaryProcess?.command || service.command || 'No command captured')}
        ${linkPanel(service)}
        <div class="actions">
          <span class="action-label">${service.discovered ? 'Discovered session controls' : 'Service controls'}</span>
          ${service.managed && service.session ? `<button class="action-button primary" data-action="peek" data-session="${escapeHtml(service.session)}" type="button">Peek Output</button>` : ''}
          ${builtInActions}
          ${customActions}
          ${genericSessionActions}
        </div>
      </article>
    `;
  }).join('');
}

function renderReview(review) {
  const sourceCounts = review?.sourceCounts || {};
  const sourceText = [
    `${sourceCounts.agents ?? 0} agents`,
    `${sourceCounts.services ?? 0} services`,
    `${sourceCounts.listeners ?? 0} ports`,
    `${sourceCounts.logs ?? 0} logs`
  ].join(' · ');
  const generated = review?.generatedAt ? new Date(review.generatedAt).toLocaleString() : 'not run yet';
  const inferred = review?.agentStatus;
  const statusClass = inferred ? statusClassName(inferred) : (review?.generatedAt ? 'warn' : 'bad');
  const statusText = inferred?.state
    ? `${inferred.state}${inferred.reason ? ` · ${inferred.reason}` : ''}`
    : review?.generatedAt ? 'context ready' : 'not started';
  els.review.innerHTML = `
    <article class="row-card target-card review-card">
      <div class="row-head">
        <div class="row-title">
          <h2>Review Pane</h2>
          <p>${escapeHtml(review?.session || 'codex-orchestrator-review')}</p>
        </div>
        <span class="status ${statusClass}">${escapeHtml(statusText)}</span>
      </div>
      <div class="meta-grid">
        ${meta('Last context', generated)}
        ${meta('Sources', sourceText)}
        ${meta('Context file', shortPath(review?.contextPath || ''), true, true)}
        ${meta('Last line', review?.lastLine || 'No reviewer output yet', false, true)}
      </div>
      ${outputBlock('Latest listener output', review?.lastOutput || '', review?.redactedPreviewCount)}
      <div class="actions">
        <span class="action-label">Review controls</span>
        <button class="action-button primary" data-action="review-start" type="button">Run Review</button>
        <button class="action-button" data-action="peek" data-session="${escapeHtml(review?.session || 'codex-orchestrator-review')}" ${review?.running ? '' : 'disabled'} type="button">Peek Review</button>
        <button class="action-button" data-action="copy-attach" data-session="${escapeHtml(review?.session || 'codex-orchestrator-review')}" type="button">Copy Terminal Command</button>
      </div>
    </article>
  `;
}

function builtinServiceActions(service) {
  if (service.self) {
    return `<button class="action-button" data-action="service-start" data-service="${escapeHtml(service.id)}" ${service.running ? 'disabled' : ''} type="button">Start</button>`;
  }
  const unmanagedDisabled = !service.managed && service.running ? 'disabled title="Port is open but no managed tmux session was found"' : '';
  return `
    <button class="action-button" data-action="service-start" data-service="${escapeHtml(service.id)}" ${service.running ? 'disabled' : ''} type="button">Start</button>
    <button class="action-button warn" data-action="service-restart" data-service="${escapeHtml(service.id)}" ${unmanagedDisabled || (!service.running ? 'disabled' : '')} type="button">Restart</button>
    <button class="action-button danger" data-action="service-stop" data-service="${escapeHtml(service.id)}" ${unmanagedDisabled || (!service.running ? 'disabled' : '')} type="button">Stop</button>
  `;
}

function renderPorts(listeners) {
  if (!listeners.length) {
    els.ports.innerHTML = empty('No TCP listeners found.');
    return;
  }
  els.ports.innerHTML = listeners.map((listener) => {
    const link = listener.port === 22 ? '' : serviceLinkButton({ label: `Open ${listener.port}`, port: listener.port, path: '/' }, `port-${listener.port}`);
    return `
      <article class="port-row">
        <div class="port-number">${escapeHtml(listener.port || '?')}</div>
        <div>
          <div class="mono wrap">${escapeHtml(listener.address || 'unknown')}</div>
          <div class="muted wrap">${escapeHtml(listener.processText || listener.raw || 'no process info')}</div>
          ${link ? `<div class="link-row">${link}</div>` : ''}
        </div>
      </article>
    `;
  }).join('');
}

function renderProcesses(processes) {
  els.processes.innerHTML = processes.map((process) => `
    <article class="process-row">
      <div>
        <div class="port-number">${escapeHtml(process.pid || '?')}</div>
        <div class="muted">${escapeHtml(process.cpu ?? '?')}%</div>
      </div>
      <div>
        <div class="mono scroll-inline">${escapeHtml(process.command || process.raw || 'unknown')}</div>
        <div class="muted">mem ${escapeHtml(process.mem ?? '?')}% · rss ${escapeHtml(process.rssKb ? formatBytes(process.rssKb * 1024) : 'n/a')} · ${escapeHtml(process.etime || '')}</div>
      </div>
    </article>
  `).join('');
}

function renderAudit(audit) {
  if (!audit.length) {
    els.audit.innerHTML = empty('No control actions have been audited yet.');
    return;
  }
  els.audit.innerHTML = audit.map((item) => `
    <article class="audit-row">
      <div>
        <strong>${escapeHtml(item.action)}</strong>
        <span class="muted">${escapeHtml(item.target || '')}</span>
      </div>
      <div class="muted">${escapeHtml(item.time ? new Date(item.time).toLocaleString() : '')} · ${escapeHtml(item.remoteAddress || '')}</div>
      <div class="mono wrap">${escapeHtml(item.detail || '')}</div>
      <span class="status ${item.ok ? 'good' : 'bad'}">${item.ok ? 'ok' : 'failed'}</span>
    </article>
  `).join('');
}

function meta(label, value, mono = false, large = false) {
  return `
    <div class="meta-item ${large ? 'meta-wide' : ''}">
      <span class="meta-label">${escapeHtml(label)}</span>
      <span class="meta-value ${mono ? 'mono' : ''}" title="${escapeHtml(value)}">${escapeHtml(value ?? 'n/a')}</span>
    </div>
  `;
}

function codeBlock(label, value) {
  return `
    <div class="code-section">
      <span class="meta-label">${escapeHtml(label)}</span>
      <pre>${escapeHtml(value || 'n/a')}</pre>
    </div>
  `;
}

function outputBlock(label, value, redactedCount = 0) {
  if (!value) return '';
  const suffix = redactedCount ? ` · redacted ${redactedCount}` : '';
  return `
    <div class="code-section output-section">
      <span class="meta-label">${escapeHtml(label)}${escapeHtml(suffix)}</span>
      <pre>${escapeHtml(value)}</pre>
    </div>
  `;
}

function workspacePreviewText(draft) {
  if (!draft.workspace || draft.workspace === '__new__') {
    return `New: ~/projects/agent-workspaces/${draft.directoryName || draft.name || state.options.suggestedName || 'agent'}`;
  }
  const match = (state.options.workspaces || []).find((item) => item.path === draft.workspace);
  return match?.label || shortPath(draft.workspace);
}

function workspaceSelectOptions(selected) {
  const groups = new Map();
  for (const item of state.options.workspaces || []) {
    const group = item.group || 'Projects';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  }
  return [...groups.entries()].map(([group, items]) => `
    <optgroup label="${escapeHtml(group)}">
      ${items.map((item) => `<option value="${escapeHtml(item.path)}" ${selected === item.path ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
    </optgroup>
  `).join('');
}

function presetSelectOptions(selected) {
  return (state.options.promptPresets || []).map((preset) => `
    <option value="${escapeHtml(preset.id)}" ${selected === preset.id ? 'selected' : ''}>${escapeHtml(preset.label)}</option>
  `).join('');
}

function modelOption(modelId) {
  return (state.options.models || []).find((model) => model.id === modelId) || null;
}

function modelSelectOptions(selected = '') {
  const configured = state.options.configuredDefault || {};
  const configuredDetail = [configured.modelLabel || configured.model, configured.reasoning]
    .filter(Boolean)
    .join(' · ');
  const defaultLabel = configuredDetail ? `Codex config — ${configuredDetail}` : 'Codex config';
  const options = [
    `<option value="" ${selected ? '' : 'selected'}>${escapeHtml(defaultLabel)}</option>`,
    ...(state.options.models || []).map((model) => `
      <option value="${escapeHtml(model.id)}" ${selected === model.id ? 'selected' : ''}>${escapeHtml(model.label)}</option>
    `)
  ];
  return options.join('');
}

function reasoningEffortsFor(modelId = '') {
  const model = modelOption(modelId);
  const efforts = model?.reasoningEfforts?.length ? model.reasoningEfforts : state.options.reasoningEfforts;
  return efforts?.length ? efforts : ['low', 'medium', 'high', 'xhigh'];
}

function normalizedReasoning(modelId, requested) {
  const efforts = reasoningEffortsFor(modelId);
  if (efforts.includes(requested)) return requested;
  const modelDefault = modelId
    ? modelOption(modelId)?.defaultReasoning
    : state.options.configuredDefault?.reasoning;
  if (modelDefault && efforts.includes(modelDefault)) return modelDefault;
  return efforts.includes('xhigh') ? 'xhigh' : efforts[0];
}

function reasoningSelectOptions(modelId = '', selected = '') {
  const normalized = normalizedReasoning(modelId, selected);
  return reasoningEffortsFor(modelId).map((effort) => `
    <option value="${escapeHtml(effort)}" ${normalized === effort ? 'selected' : ''}>${escapeHtml(effort)}</option>
  `).join('');
}

function syncModelSettings(scope) {
  const modelSelect = scope?.querySelector?.('[data-model-select]');
  const reasoningSelect = scope?.querySelector?.('[data-reasoning-select]');
  if (!modelSelect || !reasoningSelect) return;
  const current = reasoningSelect.value;
  reasoningSelect.innerHTML = reasoningSelectOptions(modelSelect.value, current);
}

function rememberResumeSettings(scope) {
  if (!scope?.classList?.contains('resume-config')) return;
  const session = scope.dataset.session;
  if (!session) return;
  state.resumePreferences.set(session, {
    model: scope.querySelector('[data-model-select]')?.value || '',
    reasoning: scope.querySelector('[data-reasoning-select]')?.value || ''
  });
}

function linkPanel(service) {
  const links = normalizedLinks(service);
  if (!links.length) return '';
  return `
    <div class="link-panel">
      <span class="action-label">Open links</span>
      <div class="link-row">
        ${links.map((link, index) => serviceLinkButton(link, `${service.id}-${index}`)).join('')}
      </div>
    </div>
  `;
}

function normalizedLinks(service) {
  const portMap = new Map((service.portStates || []).map((item) => [Number(item.port), Boolean(item.listening)]));
  const explicit = (service.links || []).map((link) => ({ ...link, listening: portMap.get(Number(link.port)) ?? false }));
  const linkedPorts = new Set(explicit.map((link) => Number(link.port)).filter(Number.isFinite));
  for (const portState of service.portStates || []) {
    if (portState.port !== 22 && !linkedPorts.has(portState.port)) {
      explicit.push({ label: `Open ${portState.port}`, port: portState.port, path: '/', listening: Boolean(portState.listening) });
    }
  }
  return explicit.filter((link) => Number.isFinite(Number(link.port)));
}

function serviceLinkButton(link, key) {
  const requestedProtocol = String(link.protocol || '').toLowerCase().replace(/:$/, '');
  const pageProtocol = window.location.protocol.replace(':', '');
  const protocol = ['http', 'https', 'exp'].includes(requestedProtocol)
    ? requestedProtocol
    : ['http', 'https'].includes(pageProtocol) ? pageProtocol : 'http';
  const host = window.location.hostname;
  const rawPath = String(link.path ?? '/');
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const url = `${protocol}://${host}:${Number(link.port)}${path}`;
  const healthKey = `${key}-${Number(link.port)}`;
  const canCheck = Boolean(link.listening) && (protocol === 'http' || protocol === 'https');
  const initialHealth = link.listening ? 'check' : 'closed';
  return `
    <a class="action-button link-button" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" data-health-key="${escapeHtml(healthKey)}" data-health-url="${canCheck ? escapeHtml(url) : ''}">
      ${escapeHtml(link.label || `Open ${link.port}`)}
      <span class="health-dot" data-health-dot="${escapeHtml(healthKey)}" data-health="${escapeHtml(initialHealth)}">${escapeHtml(initialHealth)}</span>
    </a>
  `;
}

function empty(message) {
  return `<article class="row-card"><div class="muted">${escapeHtml(message)}</div></article>`;
}

function scheduleHealthChecks() {
  window.clearTimeout(scheduleHealthChecks.timer);
  scheduleHealthChecks.timer = window.setTimeout(() => {
    for (const link of document.querySelectorAll('[data-health-url]')) {
      const url = link.dataset.healthUrl;
      const key = link.dataset.healthKey;
      if (url && key) checkBrowserReachability(key, url);
    }
  }, 100);
}

async function checkBrowserReachability(key, url) {
  setHealth(key, 'checking');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 3500);
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
    setHealth(key, 'reachable');
  } catch {
    setHealth(key, 'blocked');
  } finally {
    window.clearTimeout(timeout);
  }
}

function setHealth(key, status) {
  const escaped = window.CSS?.escape ? CSS.escape(key) : String(key).replaceAll('"', '\\"');
  for (const dot of document.querySelectorAll(`[data-health-dot="${escaped}"]`)) {
    dot.textContent = status;
    dot.dataset.health = status;
  }
}

function safeStorageGet(key, fallback = '') {
  try { return window.localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function safeStorageSet(key, value) {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Draft/history persistence is a convenience, never a send prerequisite.
  }
}

function storageScope(value) {
  return encodeURIComponent(String(value || '').trim() || 'unknown');
}

function projectNotesKey(workspace) {
  return `host-control:project-notes:${storageScope(workspace)}`;
}

function projectNotesScope(target = state.projectDesk.target, context = state.projectDesk.context) {
  return String(context?.workspace?.key ? `project:${context.workspace.key}` : target?.workspace || target?.currentPath || '');
}

function adoptProjectNotesScope(target, context) {
  const nextScope = projectNotesScope(target, context);
  if (!target || !nextScope || nextScope === state.projectDesk.notesScope) return;
  const stored = safeStorageGet(projectNotesKey(nextScope));
  if (!state.projectDesk.notesDirty && stored) {
    els.projectNotes.value = stored.slice(0, PROJECT_NOTES_MAX);
  } else if (els.projectNotes.value) {
    safeStorageSet(projectNotesKey(nextScope), els.projectNotes.value.slice(0, PROJECT_NOTES_MAX));
  }
  state.projectDesk.notesScope = nextScope;
}

function scratchpadDraftKey(target) {
  return `host-control:prompt-scratchpad:${storageScope([
    target?.session,
    target?.sessionCreatedAt,
    target?.paneId,
    target?.tmuxPaneId,
    target?.panePid
  ].join('|'))}`;
}

function loadCustomPromptSnippets() {
  if (Array.isArray(state.projectDesk.customSnippets)) return state.projectDesk.customSnippets;
  try {
    const parsed = JSON.parse(safeStorageGet(SCRATCHPAD_SNIPPETS_KEY, '[]'));
    state.projectDesk.customSnippets = Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.text === 'string')
        .map((item) => ({
          id: item.id.slice(0, 120),
          name: item.name.trim().slice(0, 80),
          text: item.text.slice(0, SEND_TEXT_MAX)
        }))
        .filter((item) => item.name && item.text.trim())
        .slice(-SCRATCHPAD_SNIPPET_LIMIT)
      : [];
  } catch {
    state.projectDesk.customSnippets = [];
  }
  return state.projectDesk.customSnippets;
}

function persistCustomPromptSnippets() {
  const snippets = loadCustomPromptSnippets().slice(-SCRATCHPAD_SNIPPET_LIMIT);
  state.projectDesk.customSnippets = snippets;
  safeStorageSet(SCRATCHPAD_SNIPPETS_KEY, JSON.stringify(snippets));
}

function promptSnippetCatalog() {
  const builtIns = (state.options.promptPresets || [])
    .filter((item) => item && typeof item.prompt === 'string' && item.prompt.trim())
    .map((item, index) => ({
      id: `preset:${String(item.id || index)}`,
      name: String(item.label || item.id || `Preset ${index + 1}`),
      text: item.prompt.slice(0, SEND_TEXT_MAX),
      builtIn: true
    }));
  const custom = loadCustomPromptSnippets().map((item) => ({ ...item, id: `custom:${item.id}`, builtIn: false }));
  return [...builtIns, ...custom];
}

function selectedPromptSnippet() {
  const selected = els.scratchpadSnippetSelect.value;
  return promptSnippetCatalog().find((item) => item.id === selected) || null;
}

function renderPromptSnippetOptions(preferred = '') {
  const catalog = promptSnippetCatalog();
  const signature = JSON.stringify(catalog.map((item) => [item.id, item.name, item.text]));
  const current = preferred || els.scratchpadSnippetSelect.value;
  if (signature !== state.projectDesk.snippetSignature) {
    const builtIns = catalog.filter((item) => item.builtIn);
    const custom = catalog.filter((item) => !item.builtIn);
    els.scratchpadSnippetSelect.innerHTML = [
      '<option value="">Choose a snippet</option>',
      builtIns.length ? `<optgroup label="Built in">${builtIns.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('')}</optgroup>` : '',
      custom.length ? `<optgroup label="Saved by you">${custom.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('')}</optgroup>` : ''
    ].join('');
    state.projectDesk.snippetSignature = signature;
  }
  if (catalog.some((item) => item.id === current)) els.scratchpadSnippetSelect.value = current;
  else els.scratchpadSnippetSelect.value = '';
}

function exactAgentForTerminal(item) {
  if (!item?.session || item.mode === 'static') return null;
  const agents = (state.snapshot?.agents || []).filter((agent) => agent.session === item.session && !isReviewAgent(agent));
  const missionPaneId = activeMissionForAgentSession(item.session)?.assignedPaneId || '';
  const expectedPaneId = item.paneId || missionPaneId;
  if (expectedPaneId) return agents.find((agent) => agent.id === expectedPaneId) || null;
  const promptable = agents.filter((agent) => agent.canSend);
  return promptable.length === 1 ? promptable[0] : agents.length === 1 ? agents[0] : null;
}

function focusedLiveTerminal() {
  const active = state.terminalWindows.get(state.activeTerminalId);
  if (active?.session && active.mode !== 'static' && !active.minimized) return active;
  const candidates = [...state.terminalWindows.values()].filter((item) =>
    item.session && item.mode !== 'static' && !item.minimized && item.session === state.selectedSession
  );
  return candidates.at(-1) || null;
}

function projectDeskTargetForTerminal(item) {
  const agent = exactAgentForTerminal(item);
  if (!item || !agent) return null;
  const mission = activeMissionForAgentSession(agent.session);
  const target = {
    terminalId: item.id,
    session: agent.session,
    sessionCreatedAt: String(agent.sessionCreatedAt || ''),
    paneId: String(agent.id || ''),
    tmuxPaneId: String(agent.tmuxPaneId || ''),
    panePid: Number(agent.panePid),
    currentPath: String(agent.currentPath || ''),
    workspace: String(mission?.workspace || agent.currentPath || ''),
    displayName: displayNameForSession(agent.session)
  };
  target.key = [target.session, target.sessionCreatedAt, target.paneId, target.tmuxPaneId, target.panePid, target.currentPath].join('|');
  target.identityComplete = Boolean(
    target.sessionCreatedAt && target.paneId && /^%\d+$/.test(target.tmuxPaneId) && Number.isInteger(target.panePid) && target.panePid > 0
  );
  return target;
}

function exactTargetIdentityPayload(target) {
  if (!target) return {};
  return {
    sessionCreatedAt: target.sessionCreatedAt,
    paneId: target.paneId,
    tmuxPaneId: target.tmuxPaneId,
    panePid: target.panePid,
    expectedSessionCreatedAt: target.sessionCreatedAt,
    expectedPaneId: target.paneId,
    expectedTmuxPaneId: target.tmuxPaneId,
    expectedPanePid: target.panePid
  };
}

function projectDeskCapabilityAvailable() {
  return state.snapshot?.capabilities?.projectDesk === true;
}

function sameExactTarget(left, right) {
  return Boolean(left && right
    && left.session === right.session
    && left.sessionCreatedAt === right.sessionCreatedAt
    && left.paneId === right.paneId
    && left.tmuxPaneId === right.tmuxPaneId
    && Number(left.panePid) === Number(right.panePid));
}

function projectContextWorkspace(context, target = state.projectDesk.target) {
  const workspace = context?.workspace;
  if (typeof workspace === 'string') return workspace;
  return String(workspace?.projectPath || workspace?.displayPath || workspace?.root || workspace?.path || context?.repoRoot || context?.root || target?.workspace || target?.currentPath || '');
}

function projectContextBranch(context) {
  const git = context?.git || {};
  const revision = git.head || git.sha || '';
  return String(git.branch || git.ref || context?.branch || (revision ? `detached ${revision}` : 'Not a Git repository'));
}

function projectContextChanges(context) {
  const git = context?.git || {};
  const raw = git.changedFiles || git.changes || context?.changedFiles || context?.changes || [];
  return (Array.isArray(raw) ? raw : []).map((item) => typeof item === 'string'
    ? { path: item, status: '' }
    : { path: String(item?.path || item?.file || item?.name || ''), status: String(item?.status || item?.code || '') })
    .filter((item) => item.path);
}

function projectContextChecks(context) {
  const raw = context?.checks ?? context?.testStatus ?? context?.tests ?? null;
  if (Array.isArray(raw)) {
    return {
      summary: raw.length ? `${raw.length} recorded check${raw.length === 1 ? '' : 's'}` : 'Not recorded',
      items: raw
    };
  }
  if (raw && typeof raw === 'object') {
    const items = Array.isArray(raw.items) ? raw.items
      : Array.isArray(raw.results) ? raw.results
        : [];
    const scripts = Array.isArray(raw.scripts) ? raw.scripts
      : raw.scripts && typeof raw.scripts === 'object' ? Object.keys(raw.scripts)
        : Array.isArray(raw.availableScripts) ? raw.availableScripts : [];
    return {
      summary: String(raw.summary || raw.label || raw.status || (scripts.length ? `${scripts.length} available · not run` : 'Not recorded')),
      items: items.length ? items : scripts.map((script) => typeof script === 'string'
        ? { name: script, status: 'available', detail: 'Available; not run by PaneFleet.' }
        : {
            name: String(script?.name || script?.label || 'check'),
            status: String(script?.status || 'available'),
            detail: String(script?.detail || script?.command || 'Available; not run by PaneFleet.')
          })
    };
  }
  return { summary: raw ? String(raw) : 'Not recorded', items: [] };
}

function projectContextInstructions(context) {
  const raw = context?.instructions || context?.instructionFiles || [];
  return (Array.isArray(raw) ? raw : []).map((item) => typeof item === 'string'
    ? { name: item, path: item, summary: '' }
    : {
        name: String(item?.name || item?.filename || item?.label || item?.path || 'Instructions'),
        path: String(item?.path || ''),
        summary: String(item?.summary || item?.preview || item?.excerpt || item?.content || ''),
        scope: String(item?.scope || '')
      });
}

function safeProjectLinkUrl(value) {
  try {
    const url = new URL(String(value || ''), window.location.origin);
    return ['http:', 'https:', 'exp:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function projectContextLinks(context, target) {
  const links = [];
  const workspace = String(context?.workspace?.path || target?.currentPath || target?.workspace || '');
  for (const service of state.snapshot?.services || []) {
    if (!service.cwd || !missionWorkspacesConflict(service.cwd, workspace)) continue;
    for (const link of normalizedLinks(service)) links.push({ ...link, serviceLabel: service.label || service.id });
  }
  for (const link of Array.isArray(context?.links) ? context.links : []) links.push({ ...link });
  const unique = new Map();
  links.forEach((link, index) => {
    const key = String(link.url || link.href || `${link.protocol || ''}:${link.port || ''}:${link.path || ''}:${link.label || index}`);
    if (!unique.has(key)) unique.set(key, link);
  });
  return [...unique.values()];
}

function projectLinkMarkup(link, index) {
  if (Number.isFinite(Number(link?.port))) return serviceLinkButton(link, `project-desk-${index}`);
  const url = safeProjectLinkUrl(link?.url || link?.href);
  if (!url) return '';
  return `<a class="action-button link-button" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(link.label || link.name || 'Open link')}</a>`;
}

function projectContextArtifacts(context) {
  return (Array.isArray(context?.artifacts) ? context.artifacts : []).filter((artifact) => (
    /^[a-f0-9]{32}$/.test(String(artifact?.id || '')) &&
    String(artifact?.name || '').toLowerCase().endsWith('.pdf')
  ));
}

function projectArtifactSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function projectArtifactTimestamp(value) {
  const timestamp = new Date(String(value || ''));
  if (Number.isNaN(timestamp.getTime())) return '';
  return timestamp.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function projectArtifactUrl(artifact, target) {
  if (!target?.identityComplete || !/^[a-f0-9]{32}$/.test(String(artifact?.id || ''))) return '';
  const params = new URLSearchParams({
    sessionCreatedAt: target.sessionCreatedAt,
    paneId: target.paneId,
    tmuxPaneId: target.tmuxPaneId,
    panePid: String(target.panePid)
  });
  return `/api/project-desk/${encodeURIComponent(target.session)}/artifacts/${encodeURIComponent(artifact.id)}?${params}`;
}

function projectArtifactMarkup(artifact, target) {
  const url = projectArtifactUrl(artifact, target);
  if (!url) return '';
  const modified = projectArtifactTimestamp(artifact.updatedAt);
  const detail = [
    String(artifact.path || ''),
    projectArtifactSize(artifact.size),
    modified ? `Modified ${modified}` : ''
  ].filter(Boolean).join(' · ');
  return `
    <button class="project-artifact-row" data-action="project-artifact-download" data-artifact-url="${escapeHtml(url)}" data-artifact-name="${escapeHtml(artifact.name)}" type="button">
      <span><strong>${escapeHtml(artifact.name)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</span>
      <span class="project-artifact-action">Download</span>
    </button>
  `;
}

function projectArtifactDownloadRequest(button) {
  const rawUrl = String(button?.dataset?.artifactUrl || '');
  const url = new URL(rawUrl, window.location.origin);
  const exactArtifactPath = /^\/api\/project-desk\/[^/]+\/artifacts\/[a-f0-9]{32}$/;
  const exactIdentityFields = ['sessionCreatedAt', 'paneId', 'tmuxPaneId', 'panePid'];
  const queryFields = [...url.searchParams.keys()];
  if (
    !rawUrl.startsWith('/') ||
    url.origin !== window.location.origin ||
    url.hash ||
    !exactArtifactPath.test(url.pathname) ||
    queryFields.length !== exactIdentityFields.length ||
    !exactIdentityFields.every((field) => url.searchParams.getAll(field).length === 1 && url.searchParams.get(field))
  ) {
    throw new Error('This file link is no longer tied to an exact terminal. Refresh Project Desk and try again.');
  }
  return url.pathname + url.search;
}

function projectArtifactDownloadName(button) {
  const name = String(button?.dataset?.artifactName || '').trim();
  if (!name || name !== name.split(/[\\/]/).pop() || !name.toLowerCase().endsWith('.pdf')) return 'project-file.pdf';
  return name;
}

async function projectArtifactDownload(button) {
  const requestUrl = projectArtifactDownloadRequest(button);
  const filename = projectArtifactDownloadName(button);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30000);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(requestUrl, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { accept: 'application/pdf' },
        signal: controller.signal
      });
      if (response.ok) {
        const contentType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
        if (contentType !== 'application/pdf') throw new Error('The server did not return a PDF. Refresh Project Desk and try again.');
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = filename;
        anchor.hidden = true;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        // Give mobile Safari enough time to hand the Blob to its viewer/share sheet.
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
        setNotice(`Downloading ${filename}.`, 'success');
        return;
      }

      const raw = await response.text();
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = { detail: raw || `HTTP ${response.status}` }; }
      if (data.error === 'control_session_required' && attempt === 0) {
        await refreshControlSession(controller.signal);
        continue;
      }
      throw new Error(data.detail || data.error || `File download failed (HTTP ${response.status}).`);
    }
    throw new Error('Dashboard session refresh failed. Reload this page and try again.');
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('File download timed out. Check dashboard health before retrying.');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function renderProjectMission(target) {
  const mission = target ? activeMissionForAgentSession(target.session) : null;
  if (!mission) {
    els.projectMissionCard.className = 'project-card project-mission-card';
    els.projectMissionStatus.textContent = 'No mission';
    els.projectMissionDetail.innerHTML = '<p>No queued mission is linked to this terminal.</p>';
    return;
  }
  els.projectMissionCard.className = `project-card project-mission-card ${escapeHtml(missionTone(mission.status))}`;
  els.projectMissionStatus.textContent = missionStatusLabel(mission.status);
  els.projectMissionDetail.innerHTML = `
    <strong>${escapeHtml(mission.title)}</strong>
    <div><span>Verification required</span><p>${escapeHtml(mission.verificationCriteria || 'No verification criteria recorded.')}</p></div>
    ${mission.resultSummary ? `<div><span>Latest result</span><p>${escapeHtml(mission.resultSummary)}</p></div>` : ''}
    ${mission.blocker ? `<div><span>Needs you</span><p>${escapeHtml(mission.blocker)}</p></div>` : ''}
    <button class="action-button" data-action="mission-open-queue" data-mission-id="${escapeHtml(mission.id)}" type="button">Open in queue</button>
  `;
}

function renderProjectContext() {
  const { target, context, contextLoading, contextError } = state.projectDesk;
  if (!target) {
    els.projectDeskTitle.textContent = 'Project Desk';
    els.projectDeskSubtitle.textContent = 'Focus a live agent terminal to load its project.';
    els.projectContextState.textContent = 'Waiting';
    els.projectWorkspace.textContent = '—';
    els.projectBranch.textContent = '—';
    els.projectChangeSummary.textContent = '—';
    els.projectCheckSummary.textContent = 'Not recorded';
    els.projectChanges.innerHTML = '';
    els.projectChecks.innerHTML = '';
    els.projectInstructionCount.textContent = '0';
    els.projectInstructions.innerHTML = '<p class="project-empty-copy">Focus a live terminal to load instructions.</p>';
    els.projectLinkCount.textContent = '0';
    els.projectLinks.innerHTML = '<p class="project-empty-copy">Focus a live terminal to load useful links.</p>';
    els.projectArtifactCount.textContent = '0';
    els.projectArtifacts.innerHTML = '<p class="project-empty-copy">Focus a live terminal to load downloadable files.</p>';
    renderProjectMission(null);
    return;
  }

  els.projectDeskTitle.textContent = target.displayName || target.session;
  els.projectDeskSubtitle.textContent = `tmux ${target.session} · ${target.paneId} · ${shortPath(target.currentPath)}`;
  const capabilityAvailable = projectDeskCapabilityAvailable();
  els.projectContextState.textContent = !capabilityAvailable ? 'Restart required' : contextLoading ? 'Loading…' : contextError ? 'Unavailable' : 'Current';
  els.projectContextState.dataset.tone = !capabilityAvailable || contextLoading ? 'warn' : contextError ? 'bad' : 'good';
  els.projectWorkspace.textContent = shortPath(projectContextWorkspace(context, target));
  els.projectBranch.textContent = !capabilityAvailable ? 'Restart dashboard to load' : contextLoading && !context ? 'Loading…' : projectContextBranch(context);

  const changes = projectContextChanges(context);
  const git = context?.git || {};
  const changedCount = Number.isFinite(Number(git.changedCount ?? context?.changedCount))
    ? Number(git.changedCount ?? context.changedCount)
    : changes.length;
  els.projectChangeSummary.textContent = !capabilityAvailable
    ? 'Restart required'
    : contextLoading && !context
    ? 'Loading…'
    : changedCount ? `${changedCount} changed file${changedCount === 1 ? '' : 's'}` : git.clean === false ? 'Changes detected' : 'Clean or not recorded';
  els.projectChanges.innerHTML = changes.length
    ? changes.slice(0, 40).map((item) => `<div class="project-detail-row"><code>${escapeHtml(item.status || '•')}</code><span>${escapeHtml(item.path)}</span></div>`).join('')
    : '';

  const checks = projectContextChecks(context);
  els.projectCheckSummary.textContent = capabilityAvailable ? checks.summary : 'Restart required';
  els.projectChecks.innerHTML = checks.items.length
    ? checks.items.slice(0, 12).map((item) => typeof item === 'string'
      ? `<div class="project-detail-row"><span>${escapeHtml(item)}</span></div>`
      : `<div class="project-detail-row"><code>${escapeHtml(item.status || '•')}</code><span><strong>${escapeHtml(item.name || item.label || 'Check')}</strong>${item.detail || item.summary ? `<small>${escapeHtml(item.detail || item.summary)}</small>` : ''}</span></div>`).join('')
    : '';

  const instructions = projectContextInstructions(context);
  els.projectInstructionCount.textContent = String(instructions.length);
  els.projectInstructions.innerHTML = instructions.length
    ? instructions.map((item) => item.summary
      ? `<details class="project-instruction"><summary>${escapeHtml(item.name)}</summary>${item.path && item.path !== item.name ? `<code>${escapeHtml(shortPath(item.path))}</code>` : ''}<p>${escapeHtml(item.summary)}</p></details>`
      : `<div class="project-detail-row"><span><strong>${escapeHtml(item.name)}</strong>${item.path && item.path !== item.name ? `<small>${escapeHtml(shortPath(item.path))}</small>` : ''}</span></div>`).join('')
    : `<p class="project-empty-copy">${!capabilityAvailable ? 'Restart the dashboard to load bounded project instructions.' : contextError ? escapeHtml(contextError) : 'No project instruction files were found.'}</p>`;

  const links = projectContextLinks(context, target);
  const linkMarkup = links.map(projectLinkMarkup).filter(Boolean);
  els.projectLinkCount.textContent = String(linkMarkup.length);
  els.projectLinks.innerHTML = linkMarkup.length ? linkMarkup.join('') : `<p class="project-empty-copy">${capabilityAvailable ? 'No allowlisted project links.' : 'Restart the dashboard to load project links.'}</p>`;
  if (linkMarkup.length) scheduleHealthChecks();
  const artifacts = projectContextArtifacts(context);
  const artifactMarkup = artifacts.map((artifact) => projectArtifactMarkup(artifact, target)).filter(Boolean);
  const artifactCapabilityAvailable = state.snapshot?.capabilities?.projectArtifacts === true;
  els.projectArtifactCount.textContent = String(artifactCapabilityAvailable ? artifactMarkup.length : 0);
  els.projectArtifacts.innerHTML = artifactCapabilityAvailable && artifactMarkup.length
    ? artifactMarkup.join('')
    : `<p class="project-empty-copy">${artifactCapabilityAvailable ? 'No downloadable PDFs found in the configured output folders.' : 'Restart the dashboard to load project files.'}</p>`;
  renderProjectMission(target);
}

function clearScratchpadReview() {
  state.projectDesk.review = null;
  els.scratchpadReviewPanel.classList.add('hidden');
  els.scratchpadReviewTarget.textContent = '';
  els.scratchpadReviewText.textContent = '';
}

function updateProjectComposerState() {
  const target = state.projectDesk.target;
  const canPrompt = target ? canPromptAgent(target.session) : { ok: false, reason: 'no focused terminal' };
  const capabilityAvailable = projectDeskCapabilityAvailable();
  const exactReady = Boolean(capabilityAvailable && target?.identityComplete && canPrompt.ok);
  const textLength = els.scratchpadText.value.length;
  const selectedSnippet = selectedPromptSnippet();
  els.scratchpadCounter.textContent = `${textLength}/${SEND_TEXT_MAX}`;
  els.scratchpadCounter.dataset.full = textLength >= SEND_TEXT_MAX ? 'true' : 'false';
  els.projectNotes.disabled = !target;
  els.scratchpadText.disabled = !target;
  els.scratchpadSnippetSelect.disabled = !target;
  els.scratchpadSnippetName.disabled = !target;
  document.querySelector('[data-action="scratchpad-snippet-insert"]').disabled = !target || !selectedSnippet;
  document.querySelector('[data-action="scratchpad-snippet-save"]').disabled = !target || !textLength || !els.scratchpadSnippetName.value.trim();
  els.scratchpadSnippetDelete.disabled = !selectedSnippet || selectedSnippet.builtIn;
  els.scratchpadReview.disabled = !exactReady || !els.scratchpadText.value.trim() || state.projectDesk.sending;
  els.projectDeskRefresh.disabled = !target || !capabilityAvailable || state.projectDesk.contextLoading;
  els.scratchpadSendConfirm.disabled = !capabilityAvailable || state.projectDesk.sending;
  els.scratchpadSendConfirm.textContent = state.projectDesk.sending ? 'Sending…' : `Send to ${target?.session || 'exact terminal'}`;
  els.scratchpadTarget.textContent = target
    ? `${target.displayName} · tmux ${target.session} · ${target.paneId}`
    : 'Focus a live terminal to choose an exact target.';
  els.scratchpadSafety.textContent = !target
    ? 'Draft only · no terminal selected'
    : !capabilityAvailable
      ? 'Draft saved · restart PaneFleet to enable exact-target Review and Send'
    : !target.identityComplete
      ? 'Send locked · durable pane identity unavailable'
      : !canPrompt.ok
        ? `Send locked · ${canPrompt.reason}`
        : 'Draft only · Review does not send · Confirm sends literal text plus Enter';
}

function loadProjectDeskContext(target, { force = false } = {}) {
  if (!target || !projectDeskCapabilityAvailable()) return;
  if (!force && state.projectDesk.contextCache.has(target.key)) {
    state.projectDesk.context = state.projectDesk.contextCache.get(target.key);
    state.projectDesk.contextError = '';
    state.projectDesk.contextLoading = false;
    renderProjectContext();
    updateProjectComposerState();
    return;
  }
  const token = ++state.projectDesk.contextRequestToken;
  state.projectDesk.contextLoading = true;
  state.projectDesk.contextError = '';
  renderProjectContext();
  updateProjectComposerState();
  const params = new URLSearchParams({
    sessionCreatedAt: target.sessionCreatedAt,
    paneId: target.paneId,
    tmuxPaneId: target.tmuxPaneId,
    panePid: String(target.panePid)
  });
  void api(`/api/project-desk/${encodeURIComponent(target.session)}?${params}`)
    .then((result) => {
      if (token !== state.projectDesk.contextRequestToken) return;
      const context = result?.project || result?.context || result;
      state.projectDesk.contextCache.set(target.key, context);
      state.projectDesk.context = context;
      state.projectDesk.contextError = '';
      adoptProjectNotesScope(target, context);
    })
    .catch((error) => {
      if (token !== state.projectDesk.contextRequestToken) return;
      state.projectDesk.context = null;
      state.projectDesk.contextError = error.message;
    })
    .finally(() => {
      if (token !== state.projectDesk.contextRequestToken) return;
      state.projectDesk.contextLoading = false;
      renderProjectContext();
      updateProjectComposerState();
    });
}

function syncProjectDesk({ refreshContext = false } = {}) {
  const visible = state.terminalWindows.size > 0;
  els.projectDesk.classList.toggle('hidden', !visible);
  if (!visible) {
    state.projectDesk.target = null;
    state.projectDesk.targetKey = '';
    clearScratchpadReview();
    return;
  }
  const nextTarget = projectDeskTargetForTerminal(focusedLiveTerminal());
  const nextKey = nextTarget?.key || '';
  const changed = nextKey !== state.projectDesk.targetKey;
  if (changed) {
    state.projectDesk.contextRequestToken += 1;
    state.projectDesk.target = nextTarget;
    state.projectDesk.targetKey = nextKey;
    state.projectDesk.context = nextTarget ? state.projectDesk.contextCache.get(nextTarget.key) || null : null;
    state.projectDesk.contextError = '';
    state.projectDesk.contextLoading = false;
    clearScratchpadReview();
    state.projectDesk.notesScope = nextTarget ? projectNotesScope(nextTarget, state.projectDesk.context) : '';
    state.projectDesk.notesDirty = false;
    els.projectNotes.value = nextTarget ? safeStorageGet(projectNotesKey(state.projectDesk.notesScope)).slice(0, PROJECT_NOTES_MAX) : '';
    els.scratchpadText.value = nextTarget ? safeStorageGet(scratchpadDraftKey(nextTarget)).slice(0, SEND_TEXT_MAX) : '';
    els.scratchpadSnippetName.value = '';
  } else {
    state.projectDesk.target = nextTarget;
  }
  renderPromptSnippetOptions();
  renderProjectContext();
  updateProjectComposerState();
  if (nextTarget && projectDeskCapabilityAvailable() && (
    refreshContext || (!state.projectDesk.context && !state.projectDesk.contextLoading && !state.projectDesk.contextError)
  )) {
    if (refreshContext) state.projectDesk.contextCache.delete(nextTarget.key);
    loadProjectDeskContext(nextTarget, { force: refreshContext });
  }
}

function insertScratchpadSnippet() {
  const target = state.projectDesk.target;
  const snippet = selectedPromptSnippet();
  if (!target || !snippet) return;
  const textarea = els.scratchpadText;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const prefix = start > 0 && !textarea.value.slice(0, start).endsWith('\n') ? '\n\n' : '';
  const available = SEND_TEXT_MAX - (textarea.value.length - (end - start));
  const inserted = `${prefix}${snippet.text}`.slice(0, Math.max(0, available));
  textarea.setRangeText(inserted, start, end, 'end');
  safeStorageSet(scratchpadDraftKey(target), textarea.value);
  clearScratchpadReview();
  updateProjectComposerState();
  textarea.focus({ preventScroll: true });
  if (inserted.length < prefix.length + snippet.text.length) setNotice(`Snippet was trimmed to the ${SEND_TEXT_MAX}-character prompt limit.`, 'error');
}

function saveScratchpadSnippet() {
  const name = els.scratchpadSnippetName.value.trim().slice(0, 80);
  const text = els.scratchpadText.value.slice(0, SEND_TEXT_MAX);
  if (!state.projectDesk.target || !name || !text.trim()) return;
  const snippets = loadCustomPromptSnippets();
  const existing = snippets.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.name = name;
    existing.text = text;
  } else {
    snippets.push({ id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name, text });
  }
  persistCustomPromptSnippets();
  state.projectDesk.snippetSignature = '';
  const stored = loadCustomPromptSnippets().find((item) => item.name.toLowerCase() === name.toLowerCase());
  renderPromptSnippetOptions(stored ? `custom:${stored.id}` : '');
  updateProjectComposerState();
  setNotice(`Saved reusable snippet “${name}” in this browser.`);
}

function deleteScratchpadSnippet() {
  const selected = selectedPromptSnippet();
  if (!selected || selected.builtIn) return;
  const id = selected.id.replace(/^custom:/, '');
  state.projectDesk.customSnippets = loadCustomPromptSnippets().filter((item) => item.id !== id);
  persistCustomPromptSnippets();
  state.projectDesk.snippetSignature = '';
  renderPromptSnippetOptions();
  els.scratchpadSnippetName.value = '';
  updateProjectComposerState();
  setNotice(`Deleted reusable snippet “${selected.name}”.`);
}

function openScratchpadReview() {
  const target = state.projectDesk.target;
  const text = els.scratchpadText.value;
  if (!projectDeskCapabilityAvailable()) {
    setNotice('Exact-target Review and Send require a dashboard restart. Your draft remains saved.', 'error');
    return;
  }
  if (!target?.identityComplete || !text.trim()) return;
  const current = projectDeskTargetForTerminal(state.terminalWindows.get(target.terminalId));
  if (!sameExactTarget(target, current)) {
    setNotice('Review canceled: the focused terminal identity changed. Focus it again before sending.', 'error');
    syncProjectDesk();
    return;
  }
  const canPrompt = canPromptAgent(target.session);
  if (!canPrompt.ok) {
    setNotice(`Review unavailable: ${target.displayName} is ${canPrompt.reason}.`, 'error');
    return;
  }
  state.projectDesk.review = { ...target, text };
  els.scratchpadReviewTarget.textContent = `${target.displayName} · tmux ${target.session} · ${target.paneId} · ${shortPath(target.currentPath)}`;
  els.scratchpadReviewText.textContent = text;
  els.scratchpadReviewPanel.classList.remove('hidden');
  updateProjectComposerState();
  els.scratchpadSendConfirm.focus({ preventScroll: true });
}

function togglePinnedSession(session) {
  if (!session) return;
  if (state.pinnedSessions.has(session)) state.pinnedSessions.delete(session);
  else state.pinnedSessions.add(session);
  safeStorageSet('host-control:pinned-sessions', JSON.stringify([...state.pinnedSessions]));
  if (state.snapshot) render({ preserveActiveEditor: true });
}

function terminalDraftKey(session) {
  return `host-control:terminal-draft:${session || 'static'}`;
}

function terminalHistoryKey(session) {
  return `host-control:terminal-history:${session || 'static'}`;
}

function loadTerminalHistory(session) {
  try {
    const parsed = JSON.parse(safeStorageGet(terminalHistoryKey(session), '[]'));
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string').slice(-30) : [];
  } catch {
    return [];
  }
}

function persistTerminalDraft(item) {
  if (!item?.session || item.mode === 'static') return;
  safeStorageSet(terminalDraftKey(item.session), item.sendText.value);
}

function rememberTerminalHistory(item, text) {
  const value = String(text || '');
  if (!item?.session || !value.trim()) return;
  item.sendHistory = [...item.sendHistory.filter((entry) => entry !== value), value].slice(-30);
  item.sendHistoryIndex = item.sendHistory.length;
  safeStorageSet(terminalHistoryKey(item.session), JSON.stringify(item.sendHistory));
}

function navigateTerminalHistory(item, direction) {
  if (!item?.sendHistory?.length || item.sendInFlight || item.pickerActive) return;
  const next = clamp(item.sendHistoryIndex + direction, 0, item.sendHistory.length);
  item.sendHistoryIndex = next;
  item.sendText.value = next === item.sendHistory.length ? '' : item.sendHistory[next];
  item.sendUndoText = '';
  persistTerminalDraft(item);
  updateSendInputState(item);
  focusSendText(item);
}

function previewTerminalPaste(item, value) {
  const text = String(value || '');
  if (!item || !text) return;
  item.pendingPaste = text;
  const lineCount = text.split(/\r?\n/).length;
  item.pastePreviewMeta.textContent = `${text.length} characters · ${lineCount} line${lineCount === 1 ? '' : 's'}`;
  item.pastePreviewText.textContent = text.length > 500 ? `${text.slice(0, 500)}…` : text;
  item.pastePreview.classList.remove('hidden');
}

function clearPendingPaste(item) {
  if (!item) return;
  item.pendingPaste = '';
  item.pastePreview.classList.add('hidden');
  item.pastePreviewMeta.textContent = '';
  item.pastePreviewText.textContent = '';
  focusSendText(item);
}

function insertPendingPaste(item) {
  const value = item?.pendingPaste || '';
  if (!value) return;
  const selectedLength = Math.max(0, (item.sendText.selectionEnd || 0) - (item.sendText.selectionStart || 0));
  const capacity = Math.max(0, SEND_TEXT_MAX - (item.sendText.value.length - selectedLength));
  const inserted = value.slice(0, capacity);
  clearPendingPaste(item);
  insertSendText(item, inserted);
  if (inserted.length < value.length) setNotice(`Paste was trimmed to the ${SEND_TEXT_MAX}-character terminal input limit.`, 'error');
}

function terminalWorkspaceBounds() {
  const width = Math.max(0, els.terminalLayer.clientWidth || els.terminalStage.clientWidth || window.innerWidth);
  const height = Math.max(0, els.terminalLayer.clientHeight || els.terminalStage.clientHeight || window.innerHeight);
  return { width, height };
}

function captureTerminalFreeBounds(item) {
  if (!item || item.minimized || item.maximized || !isDesktopTerminalMode()) return;
  const layerRect = els.terminalLayer.getBoundingClientRect();
  const rect = item.element.getBoundingClientRect();
  item.freeBounds = {
    left: rect.left - layerRect.left,
    top: rect.top - layerRect.top,
    width: rect.width,
    height: rect.height
  };
}

function terminalLayoutItems() {
  const items = [...state.terminalWindows.values()].filter((item) => !item.minimized);
  const active = state.terminalWindows.get(state.activeTerminalId);
  return active && items.includes(active) ? [active, ...items.filter((item) => item !== active)] : items;
}

function applyTerminalLayout() {
  const items = terminalLayoutItems();
  if (!isDesktopTerminalMode()) {
    const active = state.terminalWindows.get(state.activeTerminalId) || items[0];
    items.forEach((item) => item.element.classList.toggle('is-layout-hidden', item !== active));
    return;
  }

  const mode = state.terminalLayout;
  if (mode === 'free') {
    for (const item of items) {
      item.element.classList.remove('is-layout-hidden', 'is-tiled');
      if (item.maximized) {
        const bounds = terminalWorkspaceBounds();
        item.element.style.left = '8px';
        item.element.style.top = '8px';
        item.element.style.width = `${bounds.width - 16}px`;
        item.element.style.height = `${bounds.height - 16}px`;
        continue;
      }
      if (item.freeBounds) {
        item.element.style.left = `${item.freeBounds.left}px`;
        item.element.style.top = `${item.freeBounds.top}px`;
        item.element.style.width = `${item.freeBounds.width}px`;
        item.element.style.height = `${item.freeBounds.height}px`;
      }
      if (state.terminalFullHeight) applyTerminalFullHeightToItem(item);
      else constrainTerminalWindow(item);
    }
    return;
  }

  const visibleLimit = mode === 'focus' ? 1 : mode === 'split' ? 2 : 4;
  const visible = items.slice(0, visibleLimit);
  const { width, height } = terminalWorkspaceBounds();
  const inset = 8;
  const slots = terminalLayoutSlots(mode, visible.length, width - inset * 2, height - inset * 2, 8);
  items.forEach((item) => item.element.classList.toggle('is-layout-hidden', !visible.includes(item)));
  visible.forEach((item, index) => {
    const slot = slots[index];
    item.element.classList.add('is-tiled');
    item.element.style.left = `${slot.left + inset}px`;
    item.element.style.top = `${slot.top + inset}px`;
    item.element.style.width = `${slot.width}px`;
    item.element.style.height = `${slot.height}px`;
  });
}

function setTerminalLayout(layout) {
  if (!['free', 'focus', 'split', 'grid'].includes(layout) || layout === state.terminalLayout) return;
  if (layout !== 'free' && state.terminalFullHeight) setTerminalFullHeight(false, { render: false });
  if (state.terminalLayout === 'free') terminalLayoutItems().forEach(captureTerminalFreeBounds);
  state.terminalLayout = layout;
  safeStorageSet('host-control:terminal-layout', layout);
  applyTerminalLayout();
  renderTerminalChrome();
}

function renderTerminalTabs() {
  const windows = [...state.terminalWindows.values()];
  els.terminalTabs.classList.toggle('hidden', windows.length === 0);
  els.terminalTabs.innerHTML = windows.map((item) => {
    const agent = currentAgent(item.session);
    const brief = currentBrief(item.session);
    const status = agent?.agentStatus || { state: item.mode === 'static' ? 'result' : 'unknown', tone: item.mode === 'static' ? 'neutral' : 'warn' };
    const attention = sessionAttentionItems(item.session);
    const active = item.id === state.activeTerminalId;
    return `
      <div class="terminal-tab ${active ? 'active' : ''} ${item.minimized ? 'minimized' : ''} ${escapeHtml(statusClassName(status))}">
        <button data-action="terminal-tab" data-terminal-id="${escapeHtml(item.id)}" type="button" aria-pressed="${active ? 'true' : 'false'}"><span class="terminal-tab-dot" aria-hidden="true"></span><strong>${escapeHtml(brief?.displayName || item.title.textContent || item.session || 'Result')}</strong>${attention.length ? `<em>${attention.length}</em>` : ''}</button>
        <button class="terminal-tab-close" data-action="terminal-close" data-terminal-id="${escapeHtml(item.id)}" type="button" aria-label="Close ${escapeHtml(item.title.textContent || 'terminal')}">×</button>
      </div>
    `;
  }).join('');
}

function renderTerminalChrome() {
  const count = state.terminalWindows.size;
  els.openTerminalCount.textContent = count ? `${count} terminal${count === 1 ? '' : 's'} open` : 'No terminals open';
  els.terminalWorkspace.classList.toggle('has-open-terminals', count > 0);
  els.terminalEmpty.classList.toggle('hidden', count > 0);
  document.querySelectorAll('[data-action="terminal-layout"]').forEach((button) => {
    const active = button.dataset.layout === state.terminalLayout;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  const fullHeightButton = document.querySelector('[data-action="terminal-full-height"]');
  if (fullHeightButton) {
    fullHeightButton.classList.toggle('active', state.terminalFullHeight);
    fullHeightButton.setAttribute('aria-pressed', state.terminalFullHeight ? 'true' : 'false');
    fullHeightButton.textContent = state.terminalFullHeight ? 'Restore height' : 'Full height';
    fullHeightButton.disabled = !count || !isDesktopTerminalMode();
  }
  renderTerminalTabs();
  if (state.snapshot) {
    const agents = sortSessionAgents(state.snapshot.agents.filter((agent) => !isReviewAgent(agent)));
    renderTerminalInspector(agents, state.snapshot.orchestration);
    for (const item of els.sessionList.querySelectorAll('.session-item')) {
      const open = [...state.terminalWindows.values()].some((windowItem) => windowItem.session === item.dataset.session && windowItem.mode !== 'static');
      item.classList.toggle('is-open', open);
      item.classList.toggle('is-selected', item.dataset.session === state.selectedSession);
    }
  }
  syncProjectDesk();
}

function closeFinishedTerminals() {
  const finished = [...state.terminalWindows.values()].filter((item) => {
    const stateValue = currentAgent(item.session)?.agentStatus?.state;
    return item.mode !== 'static' && ['idle', 'stopped'].includes(stateValue);
  });
  finished.forEach(closeTerminalWindow);
  setNotice(finished.length ? `Closed ${finished.length} idle terminal window${finished.length === 1 ? '' : 's'}. The tmux sessions are still running.` : 'No idle terminal windows to close.');
}

function openDetail(session) {
  startLiveDetail(session, 'pane', 120);
}

function openAgentDetail(session, paneId = '') {
  startLiveDetail(session, 'agent', 160, paneId);
}

async function touchOpenedAgent(session, { force = false } = {}) {
  if (!session || isReviewAgent(currentAgent(session))) return;
  markAgentInteraction(session, 'agent.open');
  if (state.snapshot?.capabilities?.agentInteractionOrdering !== true) return;
  const now = Date.now();
  if (!force && now - Number(state.agentTouchSentAt.get(session) || 0) < 5000) return;
  state.agentTouchSentAt.set(session, now);
  try {
    const result = await api('/api/agent/touch', {
      method: 'POST',
      body: JSON.stringify({ session })
    });
    markAgentInteraction(session, result.lastInteractionKind || 'agent.open', result.lastInteractionAt, { rerender: false });
  } catch (error) {
    // Opening the terminal still succeeded. A later snapshot can reconcile a
    // failed best-effort persistence call without blocking the user.
    console.warn('Agent interaction timestamp was not persisted:', error.message);
  }
}

function startLiveDetail(session, mode, lines, paneId = '') {
  const existing = [...state.terminalWindows.values()].find((item) => item.session === session && item.mode !== 'static');
  if (existing) {
    existing.mode = mode;
    existing.lines = lines;
    existing.paneId = paneId;
    existing.token += 1;
    existing.pollInFlight = false;
    existing.element.dataset.live = 'true';
    existing.title.textContent = mode === 'agent' ? displayNameForSession(session) : session;
    existing.output.textContent = mode === 'agent' ? buildAgentDetailText(session) : 'Loading recent tmux pane output...';
    updateTerminalSendForm(existing);
    restoreTerminalWindow(existing);
    refreshTerminalWindow(existing);
    return existing;
  }

  return createTerminalWindow({
    session,
    mode,
    lines,
    paneId,
    title: mode === 'agent' ? displayNameForSession(session) : session,
    meta: 'starting pane capture...',
    output: mode === 'agent' ? buildAgentDetailText(session) : 'Loading recent tmux pane output...'
  });
}

function createTerminalWindow({ session = null, mode = 'static', lines = 120, paneId = '', title = 'Terminal', meta = '', output = '' }) {
  if (state.openDrawer) setOpenDrawer(null, { focus: false });
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const id = `terminal-${state.nextTerminalId++}`;
  const element = document.createElement('article');
  element.className = 'terminal-window';
  element.dataset.terminalId = id;
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-modal', isDesktopTerminalMode() ? 'false' : 'true');
  element.setAttribute('aria-labelledby', `${id}-title`);
  if (mode !== 'static') element.dataset.live = 'true';
  element.innerHTML = `
    <div class="terminal-header" data-terminal-drag>
      <div class="terminal-heading">
        <h2 id="${id}-title" class="terminal-title"></h2>
        <p class="terminal-meta"></p>
      </div>
      <div class="terminal-window-actions" aria-label="Terminal window controls">
        <button class="terminal-model-control hidden" data-action="terminal-command" data-command="/model" type="button" title="Change model and reasoning">Model</button>
        <button class="terminal-control" data-action="terminal-minimize" type="button" title="Minimize" aria-label="Minimize">−</button>
        <button class="terminal-control terminal-maximize" data-action="terminal-maximize" type="button" title="Maximize" aria-label="Maximize">□</button>
        <button class="terminal-control" data-action="terminal-close" type="button" title="Close" aria-label="Close">×</button>
      </div>
    </div>
    <div class="terminal-command-bar hidden" role="toolbar" aria-label="Codex quick commands">
      <span>Quick</span>
      <button data-action="terminal-command" data-command="/model" type="button">Model / Reasoning</button>
      <button data-action="terminal-command" data-command="/status" type="button">Status</button>
      <button data-action="terminal-command" data-command="/usage" type="button">Usage</button>
      <button data-action="terminal-command" data-command="/fast" type="button">Toggle Fast</button>
      <button class="picker-toggle" data-action="terminal-picker-toggle" type="button" aria-expanded="false" title="Show controls for an already-open model picker">Picker Controls</button>
    </div>
    <div class="terminal-picker-bar hidden" role="toolbar" aria-label="Interactive picker navigation">
      <span class="picker-status" aria-live="polite">Choose model</span>
      <button data-action="terminal-ui-key" data-key="up" type="button" title="Move up" aria-label="Move up">↑</button>
      <button data-action="terminal-ui-key" data-key="down" type="button" title="Move down" aria-label="Move down">↓</button>
      <button data-action="terminal-ui-key" data-key="left" type="button" title="Move left" aria-label="Move left">←</button>
      <button data-action="terminal-ui-key" data-key="right" type="button" title="Move right" aria-label="Move right">→</button>
      <button class="picker-select" data-action="terminal-ui-key" data-key="select" type="button">Select</button>
      <button data-action="terminal-ui-key" data-key="cancel" type="button">Cancel</button>
    </div>
    <pre class="terminal-output" tabindex="0" aria-label="Recent terminal output"></pre>
    <form class="send-form terminal-send-form hidden">
      <label for="${id}-send-text">Type into terminal</label>
      <textarea id="${id}-send-text" class="terminal-send-text" rows="3" maxlength="${SEND_TEXT_MAX}" enterkeyhint="send" inputmode="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Send text exactly like typing in this tmux pane"></textarea>
      <div class="paste-preview hidden" role="status">
        <div><strong>Review paste</strong><span class="paste-preview-meta"></span><pre class="paste-preview-text"></pre></div>
        <div><button class="tool-button tool-button-text" data-action="paste-insert" type="button">Insert</button><button class="tool-button tool-button-text" data-action="paste-cancel" type="button">Cancel</button></div>
      </div>
      <div class="send-toolbar" aria-label="Terminal input tools">
        <button class="tool-button" data-action="send-newline" type="button" title="Insert line break" aria-label="Insert line break">↵</button>
        <button class="tool-button tool-button-text" data-action="send-indent" type="button" title="Insert indentation" aria-label="Insert indentation">Tab</button>
        <button class="tool-button" data-action="send-history-prev" type="button" title="Previous sent input" aria-label="Previous sent input">↑</button>
        <button class="tool-button" data-action="send-history-next" type="button" title="Next sent input" aria-label="Next sent input">↓</button>
        <button class="tool-button" data-action="send-clear" type="button" title="Clear input" aria-label="Clear input">×</button>
        <button class="tool-button tool-button-text send-undo" data-action="send-undo" type="button" title="Restore cleared input" aria-label="Restore cleared input" disabled>Undo</button>
        <span class="send-counter">0/${SEND_TEXT_MAX}</span>
      </div>
      <div class="form-row">
        <span class="send-hint">${TERMINAL_SEND_HINT}</span>
        <button class="primary-button send-submit" type="submit">Send / Enter</button>
      </div>
    </form>
    <span class="terminal-resize-handle resize-n" data-terminal-resize="n" aria-hidden="true"></span>
    <span class="terminal-resize-handle resize-e" data-terminal-resize="e" aria-hidden="true"></span>
    <span class="terminal-resize-handle resize-s" data-terminal-resize="s" aria-hidden="true"></span>
    <span class="terminal-resize-handle resize-w" data-terminal-resize="w" aria-hidden="true"></span>
    <span class="terminal-resize-handle resize-ne" data-terminal-resize="ne" aria-hidden="true"></span>
    <span class="terminal-resize-handle resize-se" data-terminal-resize="se" aria-hidden="true"></span>
    <span class="terminal-resize-handle resize-sw" data-terminal-resize="sw" aria-hidden="true"></span>
    <span class="terminal-resize-handle resize-nw" data-terminal-resize="nw" aria-hidden="true"></span>
  `;

  const item = {
    id,
    session,
    paneId,
    mode,
    lines,
    element,
    title: element.querySelector('.terminal-title'),
    meta: element.querySelector('.terminal-meta'),
    output: element.querySelector('.terminal-output'),
    commandBar: element.querySelector('.terminal-command-bar'),
    quickCommands: [...element.querySelectorAll('[data-action="terminal-command"], .picker-toggle')],
    headerModel: element.querySelector('.terminal-model-control'),
    pickerBar: element.querySelector('.terminal-picker-bar'),
    pickerStatus: element.querySelector('.picker-status'),
    pickerToggle: element.querySelector('.picker-toggle'),
    pickerButtons: [...element.querySelectorAll('.terminal-picker-bar button')],
    sendForm: element.querySelector('.terminal-send-form'),
    sendText: element.querySelector('.terminal-send-text'),
    sendCounter: element.querySelector('.send-counter'),
    sendHint: element.querySelector('.send-hint'),
    sendSubmit: element.querySelector('.send-submit'),
    sendUndo: element.querySelector('.send-undo'),
    pastePreview: element.querySelector('.paste-preview'),
    pastePreviewMeta: element.querySelector('.paste-preview-meta'),
    pastePreviewText: element.querySelector('.paste-preview-text'),
    sendTools: [...element.querySelectorAll('.tool-button')],
    maximizeButton: element.querySelector('.terminal-maximize'),
    timer: null,
    pollInFlight: false,
    token: 1,
    minimized: false,
    maximized: false,
    restoreBounds: null,
    sendInFlight: false,
    uiKeyInFlight: false,
    uiKeyQueue: [],
    pickerActive: false,
    pickerStage: 'closed',
    forceScrollUntil: 0,
    sendUndoText: '',
    promptSubmitRequestedAt: 0,
    allowLineBreakUntil: 0,
    pendingPaste: '',
    sendHistory: loadTerminalHistory(session),
    sendHistoryIndex: 0,
    openedAt: Date.now(),
    focusedAt: Date.now(),
    freeBounds: null,
    fullHeightRestoreBounds: null,
    returnFocus
  };

  item.sendHistoryIndex = item.sendHistory.length;
  if (session && mode !== 'static') item.sendText.value = safeStorageGet(terminalDraftKey(session));

  item.title.textContent = title;
  item.meta.textContent = meta;
  item.output.textContent = output || '(no output)';
  state.terminalWindows.set(id, item);
  state.selectedSession = session || state.selectedSession;
  els.terminalLayer.append(element);
  placeTerminalWindow(item);
  focusTerminalWindow(item);

  if (mode !== 'static') {
    updateTerminalSendForm(item);
    refreshTerminalWindow(item);
  }
  renderTerminalChrome();
  window.requestAnimationFrame(() => {
    if (isDesktopTerminalMode() && state.terminalLayout === 'free' && state.terminalWindows.has(item.id)) {
      placeTerminalWindow(item);
      applyTerminalLayout();
    }
    const focusTarget = !item.sendForm.classList.contains('hidden') ? item.sendText : item.output;
    focusTarget.focus({ preventScroll: true });
  });
  return item;
}

function isDesktopTerminalMode() {
  return window.matchMedia(TERMINAL_DESKTOP_QUERY).matches;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function placeTerminalWindow(item) {
  if (!isDesktopTerminalMode()) return;
  const cascade = (state.terminalWindows.size - 1) % 8;
  const bounds = terminalWorkspaceBounds();
  const width = Math.max(420, Math.min(820, bounds.width - 24));
  const height = Math.max(280, Math.min(660, bounds.height - 24));
  item.element.style.width = `${width}px`;
  item.element.style.height = `${height}px`;
  item.element.style.left = `${12 + cascade * 24}px`;
  item.element.style.top = `${12 + cascade * 20}px`;
  constrainTerminalWindow(item);
  captureTerminalFreeBounds(item);
}

function constrainTerminalWindow(item) {
  if (!isDesktopTerminalMode() || item.minimized) return;
  const layerRect = els.terminalLayer.getBoundingClientRect();
  const rect = item.element.getBoundingClientRect();
  const bounds = terminalWorkspaceBounds();
  const width = Math.min(rect.width, bounds.width - 16);
  const height = Math.min(rect.height, bounds.height - 16);
  const localLeft = rect.left - layerRect.left;
  const localTop = rect.top - layerRect.top;
  const left = clamp(localLeft, 8, bounds.width - width - 8);
  const top = clamp(localTop, 8, bounds.height - height - 8);
  item.element.style.width = `${width}px`;
  item.element.style.height = `${height}px`;
  item.element.style.left = `${left}px`;
  item.element.style.top = `${top}px`;
}

function terminalRelativeBounds(item) {
  const layerRect = els.terminalLayer.getBoundingClientRect();
  const rect = item.element.getBoundingClientRect();
  return {
    left: rect.left - layerRect.left,
    top: rect.top - layerRect.top,
    width: rect.width,
    height: rect.height
  };
}

function applyTerminalFullHeightToItem(item) {
  if (!item || item.minimized || item.maximized || !isDesktopTerminalMode()) return;
  const current = terminalRelativeBounds(item);
  if (!item.fullHeightRestoreBounds) item.fullHeightRestoreBounds = { ...current };
  const bounds = terminalWorkspaceBounds();
  const fitted = terminalFullHeightBounds(current, bounds.width, bounds.height);
  item.element.classList.add('is-full-height');
  item.element.style.left = `${fitted.left}px`;
  item.element.style.top = `${fitted.top}px`;
  item.element.style.width = `${fitted.width}px`;
  item.element.style.height = `${fitted.height}px`;
  item.freeBounds = { ...fitted };
}

function restoreTerminalFullHeightItem(item) {
  const restore = item?.fullHeightRestoreBounds;
  if (!item || !restore) return;
  item.element.classList.remove('is-full-height');
  item.fullHeightRestoreBounds = null;
  if (item.maximized) {
    item.restoreBounds = { ...restore };
    return;
  }
  item.element.style.left = `${restore.left}px`;
  item.element.style.top = `${restore.top}px`;
  item.element.style.width = `${restore.width}px`;
  item.element.style.height = `${restore.height}px`;
  constrainTerminalWindow(item);
  captureTerminalFreeBounds(item);
}

function setTerminalFullHeight(enabled = !state.terminalFullHeight, { render = true } = {}) {
  if (!isDesktopTerminalMode() && enabled) return;
  if (enabled && !state.terminalWindows.size) {
    setNotice('Open a terminal first, then use Full height.');
    return;
  }
  if (enabled && state.terminalLayout !== 'free') {
    state.terminalLayout = 'free';
    safeStorageSet('host-control:terminal-layout', 'free');
  }
  state.terminalFullHeight = Boolean(enabled);
  if (state.terminalFullHeight) {
    applyTerminalLayout();
  } else {
    for (const item of state.terminalWindows.values()) restoreTerminalFullHeightItem(item);
    applyTerminalLayout();
  }
  if (render) renderTerminalChrome();
}

function focusTerminalWindow(item) {
  if (!item || item.minimized) return;
  const alreadyActive = state.activeTerminalId === item.id;
  state.activeTerminalId = item.id;
  state.selectedSession = item.session || state.selectedSession;
  item.focusedAt = Date.now();
  if (alreadyActive) return;
  state.topTerminalZ += 1;
  item.element.style.zIndex = String(state.topTerminalZ);
  applyTerminalLayout();
  renderTerminalChrome();
}

function terminalItemFromTarget(target) {
  const element = target?.closest?.('.terminal-window');
  if (element) return state.terminalWindows.get(element.dataset.terminalId) || null;
  const id = target?.dataset?.terminalId;
  return id ? state.terminalWindows.get(id) || null : null;
}

function closeTerminalWindow(item) {
  if (!item) return;
  if (item.timer) window.clearTimeout(item.timer);
  item.token += 1;
  state.terminalWindows.delete(item.id);
  if (!state.terminalWindows.size) state.terminalFullHeight = false;
  if (state.activeTerminalId === item.id) {
    const replacement = [...state.terminalWindows.values()].filter((candidate) => !candidate.minimized).at(-1) || null;
    state.activeTerminalId = replacement?.id || null;
    state.selectedSession = replacement?.session || null;
  }
  item.element.remove();
  renderTerminalDock();
  applyTerminalLayout();
  renderTerminalChrome();
  if (item.returnFocus?.isConnected) item.returnFocus.focus({ preventScroll: true });
}

function minimizeTerminalWindow(item) {
  if (!item || item.minimized) return;
  if (item.timer) window.clearTimeout(item.timer);
  item.timer = null;
  item.minimized = true;
  item.element.classList.add('is-minimized');
  if (state.activeTerminalId === item.id) {
    const replacement = [...state.terminalWindows.values()].find((candidate) => !candidate.minimized && candidate !== item);
    state.activeTerminalId = replacement?.id || null;
    state.selectedSession = replacement?.session || null;
  }
  renderTerminalDock();
  applyTerminalLayout();
  renderTerminalChrome();
  els.terminalTabs.querySelector(`[data-terminal-id="${item.id}"]`)?.focus({ preventScroll: true });
}

function restoreTerminalWindow(item) {
  if (!item) return;
  item.minimized = false;
  item.element.classList.remove('is-minimized');
  if (state.terminalFullHeight && !item.fullHeightRestoreBounds) applyTerminalFullHeightToItem(item);
  renderTerminalDock();
  focusTerminalWindow(item);
  const focusTarget = !item.sendForm.classList.contains('hidden') ? item.sendText : item.output;
  focusTarget.focus({ preventScroll: true });
  if (item.mode !== 'static') scheduleTerminalRefresh(item, 0);
  renderTerminalChrome();
}

function renderTerminalDock() {
  els.terminalDock.replaceChildren();
  const minimized = [...state.terminalWindows.values()].filter((item) => item.minimized);
  els.terminalDock.classList.toggle('hidden', minimized.length === 0);
  for (const item of minimized) {
    const button = document.createElement('button');
    button.className = 'terminal-dock-button';
    button.type = 'button';
    button.dataset.action = 'terminal-restore';
    button.dataset.terminalId = item.id;
    button.textContent = item.title.textContent || item.session || 'Terminal';
    button.title = `Restore ${button.textContent}`;
    els.terminalDock.append(button);
  }
}

function toggleTerminalMaximize(item) {
  if (!item || !isDesktopTerminalMode()) return;
  if (state.terminalLayout !== 'free') {
    focusTerminalWindow(item);
    if (state.terminalLayout !== 'focus') setTerminalLayout('focus');
    return;
  }
  if (item.maximized) {
    const bounds = item.restoreBounds;
    item.maximized = false;
    item.element.classList.remove('is-maximized');
    item.maximizeButton.textContent = '□';
    item.maximizeButton.title = 'Maximize';
    item.maximizeButton.setAttribute('aria-label', 'Maximize');
    if (bounds) {
      item.element.style.left = `${bounds.left}px`;
      item.element.style.top = `${bounds.top}px`;
      item.element.style.width = `${bounds.width}px`;
      item.element.style.height = `${bounds.height}px`;
    }
    constrainTerminalWindow(item);
    captureTerminalFreeBounds(item);
    if (state.terminalFullHeight) applyTerminalFullHeightToItem(item);
    return;
  }

  const rect = item.element.getBoundingClientRect();
  const layerRect = els.terminalLayer.getBoundingClientRect();
  item.restoreBounds = { left: rect.left - layerRect.left, top: rect.top - layerRect.top, width: rect.width, height: rect.height };
  item.maximized = true;
  item.element.classList.add('is-maximized');
  item.maximizeButton.textContent = '❐';
  item.maximizeButton.title = 'Restore size';
  item.maximizeButton.setAttribute('aria-label', 'Restore size');
  item.element.style.left = '8px';
  item.element.style.top = '8px';
  const bounds = terminalWorkspaceBounds();
  item.element.style.width = `${bounds.width - 16}px`;
  item.element.style.height = `${bounds.height - 16}px`;
  focusTerminalWindow(item);
}

function beginTerminalPointerInteraction(event, item, resizeDirection = '') {
  if (!item || !isDesktopTerminalMode() || state.terminalLayout !== 'free' || item.maximized || event.button !== 0) return;
  const heightLocked = Boolean(state.terminalFullHeight && item.fullHeightRestoreBounds);
  if (heightLocked && resizeDirection && !['e', 'w'].includes(resizeDirection)) return;
  event.preventDefault();
  focusTerminalWindow(item);
  const start = item.element.getBoundingClientRect();
  const layerRect = els.terminalLayer.getBoundingClientRect();
  const bounds = terminalWorkspaceBounds();
  const startLeft = start.left - layerRect.left;
  const startTop = start.top - layerRect.top;
  const startX = event.clientX;
  const startY = event.clientY;
  const minWidth = Math.min(420, bounds.width - 16);
  const minHeight = Math.min(280, bounds.height - 16);
  document.body.classList.add('terminal-moving');

  const move = (moveEvent) => {
    const dx = moveEvent.clientX - startX;
    const dy = moveEvent.clientY - startY;
    let left = startLeft;
    let top = startTop;
    let width = start.width;
    let height = start.height;

    if (!resizeDirection) {
      left = clamp(startLeft + dx, 8, bounds.width - start.width - 8);
      if (!heightLocked) top = clamp(startTop + dy, 8, bounds.height - start.height - 8);
    } else {
      const right = startLeft + start.width;
      const bottom = startTop + start.height;
      if (resizeDirection.includes('e')) width = clamp(start.width + dx, minWidth, bounds.width - startLeft - 8);
      if (resizeDirection.includes('s')) height = clamp(start.height + dy, minHeight, bounds.height - startTop - 8);
      if (resizeDirection.includes('w')) {
        left = clamp(startLeft + dx, 8, right - minWidth);
        width = right - left;
      }
      if (resizeDirection.includes('n')) {
        top = clamp(startTop + dy, 8, bottom - minHeight);
        height = bottom - top;
      }
    }

    item.element.style.left = `${left}px`;
    item.element.style.top = `${top}px`;
    item.element.style.width = `${width}px`;
    item.element.style.height = `${height}px`;
  };

  const end = () => {
    document.body.classList.remove('terminal-moving');
    captureTerminalFreeBounds(item);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

function handleTerminalViewportResize() {
  for (const item of state.terminalWindows.values()) {
    item.element.setAttribute('aria-modal', isDesktopTerminalMode() ? 'false' : 'true');
    updateSendInputState(item);
    if (!isDesktopTerminalMode()) continue;
    if (item.maximized) {
      const bounds = terminalWorkspaceBounds();
      item.element.style.left = '8px';
      item.element.style.top = '8px';
      item.element.style.width = `${bounds.width - 16}px`;
      item.element.style.height = `${bounds.height - 16}px`;
    } else if (state.terminalFullHeight) {
      applyTerminalFullHeightToItem(item);
    } else {
      constrainTerminalWindow(item);
    }
  }
  applyTerminalLayout();
  renderTerminalChrome();
}

function currentAgent(session) {
  return state.snapshot?.agents.find((item) => item.session === session);
}

function currentBrief(session) {
  return state.snapshot?.orchestration?.agents?.find((item) => item.session === session);
}

function displayNameForSession(session) {
  return currentBrief(session)?.displayName || session;
}

function syncOpenTerminalWindows({ protectedEditor = null } = {}) {
  for (const item of state.terminalWindows.values()) {
    if (item.mode === 'agent') item.title.textContent = displayNameForSession(item.session);
    if (item.mode !== 'static' && item.sendText !== protectedEditor) updateTerminalSendForm(item);
  }
  if (protectedEditor?.isConnected) return;
  renderTerminalDock();
  applyTerminalLayout();
  renderTerminalChrome();
}

function agentDetailHeaderLines(session, data = null) {
  const agent = currentAgent(session);
  const brief = currentBrief(session);
  const canPrompt = canPromptAgent(session);
  return [
    `Role: ${displayNameForSession(session)}`,
    `Session: ${session}`,
    `Orchestrator checked: ${checkedLabel(brief?.checkedAt)}`,
    `History: ${sampleMeta(brief) || 'collecting samples'}`,
    `Status: ${brief?.state || agent?.agentStatus?.state || 'unknown'} (${brief?.reason || agent?.agentStatus?.reason || 'process alive'})`,
    `Prompt input: ${canPrompt.ok ? 'available' : canPrompt.reason}`,
    `Path: ${shortPath(data?.pane?.currentPath || agent?.currentPath || '')}`,
    `CPU / Mem: ${cpuMem(agent?.primaryProcess)}`
  ];
}

function buildAgentDetailText(session, data = null) {
  const agent = currentAgent(session);
  const brief = currentBrief(session);
  const lines = [
    ...agentDetailHeaderLines(session, data),
    '',
    'Orchestrator summary:',
    brief?.summary || agent?.lastLine || 'No recent visible output.',
    '',
    'Recommended next action:',
    brief?.nextAction || 'Keep monitoring.',
    ''
  ];
  if (data) {
    lines.push(`Recent output (live, refreshes every ${(DETAIL_REFRESH_MS / 1000).toFixed(1)}s):`, data.output || '(no recent output)');
  } else {
    lines.push('Loading live recent output...');
  }
  return lines.join('\n');
}

function updateTerminalSendForm(item) {
  const canPrompt = canPromptAgent(item.session);
  item.sendForm.classList.toggle('hidden', !canPrompt.ok);
  const commandsAvailable = item.mode === 'agent' && canPrompt.ok;
  item.commandBar.classList.toggle('hidden', !commandsAvailable);
  item.headerModel.classList.toggle('hidden', !commandsAvailable);
  if (!commandsAvailable) toggleTerminalPickerControls(item, false);
  updateSendInputState(item);
}

function canPromptAgent(session) {
  const mission = activeMissionForAgentSession(session);
  const pane = state.snapshot?.panes.find((item) =>
    item.session === session && (!mission?.assignedPaneId || item.id === mission.assignedPaneId)
  );
  const agent = state.snapshot?.agents.find((item) =>
    item.session === session && (!mission?.assignedPaneId || item.id === mission.assignedPaneId)
  );
  if (!(pane && pane.canSend && agent?.canSend)) return { ok: false, reason: 'unavailable' };
  if (mission && (!mission.worker?.present || !mission.worker?.identityMatches)) {
    return { ok: false, reason: 'assigned mission worker was replaced' };
  }
  if (mission?.status === 'dispatching') return { ok: false, reason: 'dispatching a mission' };
  if (mission?.status === 'reconcile_required') return { ok: false, reason: 'waiting for dispatch reconciliation' };
  return { ok: true, reason: 'available' };
}

function focusSendText(item) {
  item.sendText.focus({ preventScroll: true });
}

function resizeSendText(item) {
  const isMobile = window.matchMedia('(max-width: 759px)').matches;
  const maxHeight = Math.max(88, Math.floor(window.innerHeight * (isMobile ? 0.28 : 0.22)));
  item.sendText.style.height = 'auto';
  const nextHeight = Math.min(maxHeight, Math.max(76, item.sendText.scrollHeight));
  item.sendText.style.height = `${nextHeight}px`;
  item.sendText.style.overflowY = item.sendText.scrollHeight > nextHeight + 1 ? 'auto' : 'hidden';
}

function updateSendInputState(item) {
  const length = item.sendText.value.length;
  const pickerUiAvailable = state.snapshot?.capabilities?.pickerUiKeys === true;
  const formUnavailable = item.sendForm.classList.contains('hidden');
  const interactionBusy = item.sendInFlight || item.uiKeyInFlight;
  const promptDisabled = interactionBusy || item.pickerActive || formUnavailable;
  item.sendCounter.textContent = `${length}/${SEND_TEXT_MAX}`;
  item.sendCounter.dataset.full = length >= SEND_TEXT_MAX ? 'true' : 'false';
  item.sendForm.setAttribute('aria-busy', interactionBusy ? 'true' : 'false');
  if (item.sendText.readOnly !== promptDisabled) item.sendText.readOnly = promptDisabled;
  item.sendText.setAttribute('aria-readonly', promptDisabled ? 'true' : 'false');
  item.sendText.classList.toggle('is-picker-locked', item.pickerActive);
  const activeMission = activeMissionForAgentSession(item.session);
  item.sendHint.textContent = item.pickerActive
    ? 'Picker is controlling terminal input. Select a choice or Cancel Picker to return to typing.'
    : activeMission
      ? `Linked to mission: ${activeMission.title}. ${TERMINAL_SEND_HINT}`
      : TERMINAL_SEND_HINT;
  item.sendSubmit.disabled = promptDisabled || !item.sendText.value.trim();
  item.sendSubmit.textContent = item.sendInFlight ? 'Sending...' : 'Send / Enter';
  item.sendTools.forEach((button) => {
    button.disabled = promptDisabled;
  });
  item.quickCommands.forEach((button) => {
    const isPickerToggle = button === item.pickerToggle;
    const needsPickerUi = isPickerToggle || button.dataset.command === '/model';
    button.disabled = (needsPickerUi && !pickerUiAvailable)
      || item.commandBar.classList.contains('hidden') || item.sendInFlight || (isPickerToggle
      ? (!item.pickerActive && item.uiKeyInFlight)
      : (item.uiKeyInFlight || item.pickerActive));
    if (needsPickerUi) {
      button.title = pickerUiAvailable
        ? (isPickerToggle ? 'Recover navigation for an already-open picker' : 'Choose model and reasoning effort')
        : 'Restart the dashboard backend to enable safe picker navigation';
    }
  });
  item.pickerButtons.forEach((button) => {
    button.disabled = !pickerUiAvailable || item.sendInFlight || item.pickerBar.classList.contains('hidden');
  });
  item.sendUndo.disabled = promptDisabled || !item.sendUndoText;
  resizeSendText(item);
}

function toggleTerminalPickerControls(item, force = !item.pickerActive, stage = force ? 'effort' : 'closed', focusControls = false) {
  if (!item) return;
  item.pickerActive = Boolean(force);
  item.pickerStage = item.pickerActive ? stage : 'closed';
  if (!item.pickerActive) item.uiKeyQueue.length = 0;
  item.pickerBar.classList.toggle('hidden', !item.pickerActive);
  item.pickerToggle.setAttribute('aria-expanded', item.pickerActive ? 'true' : 'false');
  item.pickerToggle.classList.toggle('active', item.pickerActive);
  item.pickerToggle.textContent = item.pickerActive ? 'Cancel Picker' : 'Picker Controls';
  item.pickerStatus.textContent = item.pickerStage === 'model'
    ? 'Choose model'
    : item.pickerStage === 'effort' ? 'Choose reasoning effort' : 'Picker navigation';
  updateSendInputState(item);
  if (item.pickerActive && focusControls) {
    window.requestAnimationFrame(() => {
      if (!state.terminalWindows.has(item.id) || !item.pickerActive) return;
      item.pickerBar.querySelector('[data-key="down"]')?.focus({ preventScroll: true });
    });
  }
}

function insertSendText(item, value) {
  const start = item.sendText.selectionStart ?? item.sendText.value.length;
  const end = item.sendText.selectionEnd ?? item.sendText.value.length;
  item.sendText.setRangeText(value, start, end, 'end');
  item.sendUndoText = '';
  persistTerminalDraft(item);
  updateSendInputState(item);
  focusSendText(item);
}

function clearSendText(item, { remember = true } = {}) {
  if (remember && item.sendText.value) {
    item.sendUndoText = item.sendText.value;
  } else if (!remember) {
    item.sendUndoText = '';
  }
  item.sendText.value = '';
  persistTerminalDraft(item);
  updateSendInputState(item);
  focusSendText(item);
}

function undoClearSendText(item) {
  if (!item.sendUndoText) return;
  item.sendText.value = item.sendUndoText;
  item.sendUndoText = '';
  persistTerminalDraft(item);
  updateSendInputState(item);
  focusSendText(item);
}

function isTerminalAtBottom(item) {
  return item.output.scrollHeight - item.output.scrollTop - item.output.clientHeight < 36;
}

function forceTerminalScrollBottom(item, durationMs = 1800) {
  item.forceScrollUntil = Math.max(item.forceScrollUntil, Date.now() + durationMs);
  item.output.scrollTop = item.output.scrollHeight;
}

function setTerminalOutput(item, value) {
  const shouldStickToBottom = Date.now() < item.forceScrollUntil || isTerminalAtBottom(item);
  const previousTop = item.output.scrollTop;
  item.output.textContent = value || '(no output)';
  if (shouldStickToBottom) {
    item.output.scrollTop = item.output.scrollHeight;
  } else {
    item.output.scrollTop = previousTop;
  }
}

function scheduleTerminalRefresh(item, delay = DETAIL_REFRESH_MS) {
  if (!state.terminalWindows.has(item.id) || item.mode === 'static' || item.minimized) return;
  if (item.timer) window.clearTimeout(item.timer);
  item.timer = null;
  if (document.hidden) return;
  item.timer = window.setTimeout(() => refreshTerminalWindow(item), delay);
}

async function refreshTerminalWindow(item) {
  const { session, mode, lines, paneId, token } = item;
  if (!state.terminalWindows.has(item.id) || !session || mode === 'static' || item.pollInFlight || item.minimized || document.hidden) return;
  item.pollInFlight = true;
  if (item.timer) window.clearTimeout(item.timer);
  item.timer = null;
  try {
    const paneQuery = paneId ? `&paneId=${encodeURIComponent(paneId)}` : '';
    const data = await api(`/api/pane/${encodeURIComponent(session)}/capture?lines=${lines}${paneQuery}`);
    if (!state.terminalWindows.has(item.id) || token !== item.token || item.minimized) return;
    updateTerminalSendForm(item);
    const refreshed = new Date().toLocaleTimeString();
    item.title.textContent = mode === 'agent' ? displayNameForSession(session) : session;
    item.meta.textContent = `tmux ${session} · ${shortPath(data.pane.currentPath)} · live ${refreshed} · recent ${data.lines} lines · redacted ${data.redactedCount || 0}`;
    setTerminalOutput(item, mode === 'agent' ? buildAgentDetailText(session, data) : data.output || '(no recent output)');
  } catch (error) {
    if (state.terminalWindows.has(item.id) && token === item.token) {
      item.meta.textContent = `live refresh failed · ${new Date().toLocaleTimeString()}`;
      setTerminalOutput(item, error.message);
    }
  } finally {
    if (state.terminalWindows.has(item.id) && token === item.token) {
      item.pollInFlight = false;
      scheduleTerminalRefresh(item);
    }
  }
}

function showOutput(title, meta, output) {
  return createTerminalWindow({ mode: 'static', title, meta, output: output || '(no output)' });
}

async function serviceAction(service, action) {
  const needsConfirm = ['stop', 'restart'].includes(action);
  if (needsConfirm && !window.confirm(`${action.toUpperCase()} ${service}?`)) return;
  setNotice(`${action} requested for ${service}...`);
  try {
    await api(`/api/service/${encodeURIComponent(service)}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ confirm: action })
    });
    if (action === 'start' || action === 'restart') await sleep(1800);
    setNotice(`${service} ${action} complete.`);
    await loadSnapshot('manual');
  } catch (error) {
    setNotice(`${service} ${action} failed: ${error.message}`, 'error');
  }
}

async function runReview() {
  setNotice('Starting review agent pass...');
  try {
    const result = await api('/api/review/start', { method: 'POST', body: JSON.stringify({}) });
    setNotice(`Review started in ${result.session}.`);
    await sleep(1200);
    await loadSnapshot('manual');
    switchView('review');
  } catch (error) {
    setNotice(`Review start failed: ${error.message}`, 'error');
  }
}

function isPublicIpv4Address(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  const [a, b, c] = parts.map(Number);
  return a !== 0 && a !== 10 && a !== 127 && a < 224
    && !(a === 100 && b >= 64 && b <= 127)
    && !(a === 169 && b === 254)
    && !(a === 172 && b >= 16 && b <= 31)
    && !(a === 192 && b === 168)
    && !(a === 192 && b === 0 && (c === 0 || c === 2))
    && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    && !(a === 203 && b === 0 && c === 113);
}

async function customServiceAction(service, action, needsConfirm, requiresPublicIp = false) {
  let publicIp = '';
  if (requiresPublicIp) {
    const entered = window.prompt('Enter the exact public IPv4 address to authorize (address only, without /32):');
    if (entered === null) return;
    publicIp = entered.trim();
    if (!isPublicIpv4Address(publicIp)) {
      setNotice('Action not started: enter one globally routable IPv4 address without a CIDR suffix.', 'error');
      return;
    }
  }
  const target = publicIp ? `${service} for ${publicIp}` : service;
  if (needsConfirm && !window.confirm(`Run ${action} for ${target}?`)) return;
  setNotice(`${action} requested for ${service}...`);
  try {
    const result = await api(`/api/service/${encodeURIComponent(service)}/action/${encodeURIComponent(action)}`, {
      method: 'POST',
      body: JSON.stringify({ confirm: action, ...(publicIp ? { publicIp } : {}) })
    });
    setNotice(`${service} ${action} started.`);
    showOutput(`${service}: ${action}`, result.session ? `tmux session ${result.session}` : 'command output', result.output || '');
    await loadSnapshot('manual');
  } catch (error) {
    showOutput(`${service}: ${action} failed`, 'error output', error.message);
    setNotice(`${service} ${action} failed: ${error.message}`, 'error');
  }
}

async function interruptAgent(session) {
  if (!window.confirm(`RECOVERY ONLY: send Ctrl-C to ${session}? Normal prompt sending never does this.`)) return;
  try {
    await api('/api/agent/interrupt', {
      method: 'POST',
      body: JSON.stringify({ session, confirm: 'interrupt' })
    });
    markAgentInteraction(session, 'agent.interrupt');
    setNotice(`${session} interrupted.`);
    await openDetail(session);
  } catch (error) {
    setNotice(`Interrupt failed: ${error.message}`, 'error');
  }
}

async function openSshRescue() {
  if (state.snapshot?.capabilities?.exactPublicIpAccess !== true || state.snapshot?.capabilities?.ipRuleManagement !== true) {
    setNotice('Exact IP access requires a dashboard backend restart before this control can run.', 'error');
    return;
  }
  const port = state.snapshot?.security?.sshRescue?.dashboardPort || 8787;
  const ip = window.prompt(`Enter the exact public IPv4 address to authorize for SSH 22 and dashboard ${port}. It will be added as a narrow /32 only.`)?.trim().replace(/\/32$/, '');
  if (!ip) return;
  if (!isPublicIpv4Address(ip)) {
    setNotice('Access not changed: enter one globally routable IPv4 address.', 'error');
    return;
  }
  setNotice(`Previewing ports for ${ip}/32...`);
  try {
    const preview = await api('/api/security/ssh-rescue/open', {
      method: 'POST',
      body: JSON.stringify({ dryRun: true, ip })
    });
    if (!window.confirm(`Add ${ip}/32 to ports ${preview.ports?.join(', ') || `22 and ${port}`}?\n\nThis only adds access. It does not remove or replace any existing rule.`)) {
      setNotice('IP authorization canceled.');
      return;
    }
    setNotice(`Authorizing ${ip}/32...`);
    const result = await api('/api/security/ssh-rescue/open', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'authorize', ip })
    });
    setNotice(`Authorized ${result.cidrs?.join(', ') || `${ip}/32`} on ports ${result.ports?.join(', ') || `22 and ${port}`}.`);
    await loadSnapshot('manual');
  } catch (error) {
    setNotice(`IP authorization failed: ${error.message}`, 'error');
  }
}

function ipRulePortLabel(rule) {
  if (rule.protocol === '-1') return 'all';
  if (rule.fromPort === null || rule.fromPort === undefined) return rule.protocol || 'unknown';
  return Number(rule.fromPort) === Number(rule.toPort)
    ? `${rule.protocol || 'tcp'} ${rule.fromPort}`
    : `${rule.protocol || 'tcp'} ${rule.fromPort}-${rule.toPort}`;
}

function ipRuleStatusLabel(rule) {
  if (rule.current) return rule.managed ? 'CURRENT · MANAGED · KEEP' : 'CURRENT · STATIC · PRESERVED';
  if (rule.activeSsh) return rule.managed ? 'ACTIVE SSH · MANAGED · KEEP' : 'ACTIVE SSH · STATIC · PRESERVED';
  if (rule.classification === 'dashboard-broad') return 'DASHBOARD BROAD RESCUE · REPLACE WITH CURRENT /32';
  if (rule.cleanupEligible) return 'STALE DASHBOARD IP · REMOVE';
  if (rule.broad) return 'BROAD UNMANAGED · PRESERVED';
  if (rule.managed) return 'DASHBOARD MANAGED · KEEP';
  return 'STATIC / UNMANAGED · PRESERVED';
}

function formatIpRulesPlan(plan) {
  const rows = plan.inboundRules || [];
  const relevantRows = rows.filter((rule) => rule.relevant);
  const otherRows = rows.filter((rule) => !rule.relevant);
  const formatRows = (items) => items.length
    ? items.map((rule) => [
        `[${ipRuleStatusLabel(rule)}]`,
        `${ipRulePortLabel(rule)} from ${rule.source}`,
        rule.description ? `  ${rule.description}` : ''
      ].filter(Boolean).join('\n')).join('\n\n')
    : '(none)';
  return [
    'CURRENT BROWSER CONNECTION',
    plan.requesterCidr || 'Unavailable (cleanup is disabled)',
    '',
    'HOST-CONTROL ACCESS PORTS',
    (plan.lteMirrorPorts || []).join(', ') || '(none)',
    '',
    'ACTIVE SSH CONNECTION IPS',
    (plan.currentPeerCidrs || []).join(', ') || '(none)',
    '',
    'CLEANUP SCOPE',
    `${plan.cleanup?.candidates?.length || 0} stale dashboard-managed rule(s) can be removed.`,
    'Current browser and active SSH IPs are kept. Static/manual, IPv6, source-group, range, and unmanaged broad rules are preserved.',
    'A legacy dashboard-owned broad rescue rule is removed only after current /32 coverage is verified on that port.',
    '',
    'ACCESS-PORT RULES',
    formatRows(relevantRows),
    '',
    'OTHER INBOUND RULES (VIEW ONLY)',
    formatRows(otherRows)
  ].join('\n');
}

async function viewIpRules() {
  if (state.snapshot?.capabilities?.ipRuleManagement !== true) {
    setNotice('IP rule inventory requires a dashboard backend restart.', 'error');
    return;
  }
  setNotice('Loading live inbound IP rules...');
  try {
    const { plan } = await api('/api/security/ssh-rescue/plan');
    showOutput(
      'Inbound IP Rules',
      `${plan.groupName || 'security group'} ${plan.groupId || ''} · current ${plan.requesterCidr || 'unavailable'}`.trim(),
      formatIpRulesPlan(plan)
    );
    setNotice(`Loaded ${plan.inboundRules?.length || 0} inbound rule${plan.inboundRules?.length === 1 ? '' : 's'}.`);
  } catch (error) {
    setNotice(`IP rule inventory failed: ${error.message}`, 'error');
  }
}

async function cleanupManagedIpRules() {
  if (state.snapshot?.capabilities?.ipRuleManagement !== true) {
    setNotice('Managed IP cleanup requires a dashboard backend restart.', 'error');
    return;
  }
  setNotice('Previewing managed IP cleanup...');
  try {
    const preview = await api('/api/security/ssh-rescue/cleanup', {
      method: 'POST',
      body: JSON.stringify({ dryRun: true, currentOnly: true })
    });
    const candidates = preview.candidates || [];
    if (!candidates.length) {
      setNotice(`No stale dashboard-managed IP rules found. Current ${preview.requesterCidr} is kept.`);
      await viewIpRules();
      return;
    }
    const candidateText = candidates
      .slice(0, 24)
      .map((rule) => `${rule.cidr} · port ${Number(rule.fromPort) === Number(rule.toPort) ? rule.fromPort : `${rule.fromPort}-${rule.toPort}`}`)
      .join('\n');
    const overflow = candidates.length > 24 ? `\n...and ${candidates.length - 24} more rule(s)` : '';
    const confirmed = window.confirm([
      `Remove ${candidates.length} stale dashboard-managed IP rule(s)?`,
      '',
      `KEEP current browser: ${preview.requesterCidr}`,
      `KEEP active SSH: ${(preview.keepCidrs || []).filter((cidr) => cidr !== preview.requesterCidr).join(', ') || 'none'}`,
      'KEEP every static/manual and unmanaged broad rule.',
      'REPLACE any dashboard-owned broad rescue rule only after current /32 coverage is verified.',
      '',
      candidateText + overflow
    ].join('\n'));
    if (!confirmed) {
      setNotice('Managed IP cleanup canceled.');
      return;
    }
    setNotice(`Removing ${candidates.length} stale managed rule${candidates.length === 1 ? '' : 's'}...`);
    const result = await api('/api/security/ssh-rescue/cleanup', {
      method: 'POST',
      body: JSON.stringify({
        confirm: 'cleanup',
        currentOnly: true,
        planToken: preview.planToken
      })
    });
    const removed = result.removed || [];
    showOutput(
      'Managed IP Cleanup',
      `kept current ${result.requesterCidr}`,
      removed.length
        ? `Removed ${removed.length} rule(s):\n\n${removed.map((rule) => `${rule.cidr} · port ${rule.fromPort}`).join('\n')}`
        : 'No managed rules needed removal.'
    );
    setNotice(`Removed ${removed.length} stale dashboard-managed IP rule${removed.length === 1 ? '' : 's'}.`);
    await loadSnapshot('manual');
  } catch (error) {
    const suffix = error.data?.error === 'current_public_ipv4_unavailable'
      ? ' Open the dashboard through its public address, then try again.'
      : error.data?.error === 'cleanup_plan_changed' ? ' Rules changed after preview; run cleanup again.' : '';
    setNotice(`Managed IP cleanup failed: ${error.message}.${suffix}`, 'error');
  }
}

async function lockSshRescue() {
  if (state.snapshot?.capabilities?.exactPublicIpAccess !== true || state.snapshot?.capabilities?.ipRuleManagement !== true) {
    setNotice('Exact IP access requires a dashboard backend restart before this control can run.', 'error');
    return;
  }
  setNotice('Locking access to the detected public /32...');
  try {
    const result = await api('/api/security/ssh-rescue/lock', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'lock' })
    });
    setNotice(`Access locked to ${result.cidrs?.join(', ') || 'detected IP'}.`);
    await loadSnapshot('manual');
  } catch (error) {
    setNotice(`Lock failed: ${error.message}. Connect through the target public network first, then try again.`, 'error');
  }
}

async function resumeAgent(session, model = '', reasoning = '') {
  const targetLabel = displayNameForSession(session);
  setNotice(`Resuming ${targetLabel} with ${model || 'Codex config'}...`);
  try {
    const result = await api('/api/agent/resume', {
      method: 'POST',
      body: JSON.stringify({ session, model, reasoning })
    });
    markAgentInteraction(session, 'agent.resume');
    await sleep(1800);
    setNotice(`${targetLabel} resumed with ${result.model} · ${result.reasoning} reasoning.`);
    await loadSnapshot('manual');
  } catch (error) {
    setNotice(`Resume failed: ${error.message}`, 'error');
  }
}

async function sessionAction(session, action) {
  const label = action === 'interrupt'
    ? `RECOVERY ONLY: send Ctrl-C to ${session}? Normal prompt sending never does this.`
    : `RECOVERY ONLY: stop tmux session ${session}?`;
  if (!window.confirm(label)) return;
  try {
    await api(`/api/session/${encodeURIComponent(session)}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ confirm: action })
    });
    if (action === 'interrupt' && currentAgent(session)) markAgentInteraction(session, 'session.interrupt');
    setNotice(`${session} ${action} complete.`);
    await loadSnapshot('manual');
  } catch (error) {
    setNotice(`${session} ${action} failed: ${error.message}`, 'error');
  }
}

async function copyAttach(session) {
  const quotedSession = `'${String(session || '').replaceAll("'", `'"'"'`)}'`;
  const command = `tmux attach-session -t ${quotedSession}`;
  try {
    await navigator.clipboard.writeText(command);
    setNotice(`Copied: ${command}`);
  } catch {
    setNotice(command);
  }
}

function slugifyClient(value, fallback = 'agent') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || fallback;
}

function basenameFromPath(value) {
  const parts = String(value || '').split('/').filter(Boolean);
  return parts.at(-1) || '';
}

function selectedPreset(id) {
  return (state.options.promptPresets || []).find((preset) => preset.id === id) || null;
}

function readAgentDraft(form) {
  const formData = new FormData(form);
  state.agentDraft = {
    ...state.agentDraft,
    open: form.closest('details')?.open ?? state.agentDraft.open,
    name: String(formData.get('name') || ''),
    directoryName: String(formData.get('directoryName') || ''),
    workspace: String(formData.get('workspace') || '__new__'),
    preset: String(formData.get('preset') || ''),
    model: String(formData.get('model') || ''),
    reasoning: String(formData.get('reasoning') || ''),
    prompt: String(formData.get('prompt') || '')
  };
  const preview = form.querySelector('.field-preview');
  if (preview) preview.textContent = workspacePreviewText(state.agentDraft);
}

function syncAgentLauncher(form) {
  const workspace = form.elements.workspace?.value || '__new__';
  const presetId = form.elements.preset?.value || '';
  form.dataset.workspaceMode = workspace === '__new__' ? 'new' : 'existing';

  const seed = workspace === '__new__'
    ? (presetId || form.elements.name?.value || state.options.suggestedName || 'agent')
    : basenameFromPath(workspace);
  if (!form.elements.name.value.trim()) form.elements.name.value = slugifyClient(seed);
  if (workspace === '__new__' && !form.elements.directoryName.value.trim()) {
    form.elements.directoryName.value = slugifyClient(form.elements.name.value || seed);
  }
  readAgentDraft(form);
}

function applyPresetToLauncher(form) {
  const preset = selectedPreset(form.elements.preset?.value);
  if (preset) form.elements.prompt.value = preset.prompt;
  syncAgentLauncher(form);
}

async function createAgent(form) {
  readAgentDraft(form);
  const submittedDraftSignature = agentDraftSignature(state.agentDraft);
  const formData = new FormData(form);
  const name = String(formData.get('name') || '').trim();
  const directoryName = String(formData.get('directoryName') || '').trim();
  const workspace = String(formData.get('workspace') || '__new__').trim();
  const workspaceMode = workspace === '__new__' ? 'new' : 'existing';
  const model = String(formData.get('model') || '').trim();
  const reasoning = String(formData.get('reasoning') || '').trim();
  const prompt = String(formData.get('prompt') || '');
  if (workspaceMode === 'new' && !name && !directoryName) {
    setNotice('New agent needs a name or workspace folder.', 'error');
    return;
  }
  if (workspaceMode === 'existing' && !workspace) {
    setNotice('Choose an existing workspace.', 'error');
    return;
  }
  setNotice('Starting new persistent agent session...');
  try {
    const result = await api('/api/agent/create', {
      method: 'POST',
      timeoutMs: 45000,
      body: JSON.stringify({ name, directoryName, workspace, workspaceMode, model, reasoning, prompt })
    });
    const outcome = agentCreateOutcome(result, Boolean(prompt.trim()));
    markAgentInteraction(result.session, 'agent.create', new Date().toISOString(), { rerender: false });
    state.recentAgentSession = result.session;
    const draftChangedWhileStarting = agentDraftSignature(state.agentDraft) !== submittedDraftSignature;
    const preserveDraft = outcome.preserveDraft || draftChangedWhileStarting;
    if (!preserveDraft) {
      form.reset();
      state.agentDraft = { open: false, name: '', directoryName: '', workspace: '__new__', preset: '', model: '', reasoning: '', prompt: '' };
    } else {
      state.agentDraft.open = true;
    }
    const notice = draftChangedWhileStarting && outcome.accepted
      ? `${outcome.notice} Your newer launcher edits were kept.`
      : outcome.notice;
    setNotice(notice, outcome.tone);
    await sleep(1000);
    await loadSnapshot('manual');
  } catch (error) {
    setNotice(`New agent failed: ${error.message}`, 'error');
  }
}

function currentMission(id) {
  return state.snapshot?.missions?.jobs?.find((mission) => mission.id === id) || null;
}

function currentAttentionItem(id) {
  return normalizedAttention(state.snapshot || {}).items.find((item) => item.id === id) || null;
}

function currentNotification(id) {
  return normalizedNotifications(state.snapshot || {}).find((item) => item.id === id) || null;
}

function revealMissionCard(missionId) {
  switchView('queue');
  window.requestAnimationFrame(() => {
    const card = [...els.queue.querySelectorAll('.mission-card')]
      .find((item) => item.dataset.missionId === missionId);
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card?.classList.add('attention-opened');
    window.setTimeout(() => card?.classList.remove('attention-opened'), 1800);
  });
}

function openAttentionTarget(item) {
  if (!item) return;
  if (item.missionId) {
    revealMissionCard(item.missionId);
    return;
  }
  if (item.session) {
    openAgentDetail(item.session, item.paneId || '');
    void touchOpenedAgent(item.session, { force: true });
    return;
  }
  if (item.serviceId) {
    openServiceDetail(item.serviceId);
    return;
  }
  if (item.view && ['agents', 'queue', 'services', 'security', 'review', 'ports', 'processes', 'audit', 'system'].includes(item.view)) {
    switchView(item.view);
    return;
  }
  if (item.kind.includes('security')) {
    openToolView('security');
  }
}

function notificationSnoozePath(notification) {
  const encodedId = encodeURIComponent(notification.id);
  const path = String(notification.snoozeEndpoint || '')
    .replaceAll('{id}', encodedId)
    .replaceAll(':id', encodedId);
  return path.startsWith('/api/') ? path : '';
}

function notificationOpenPath(notification) {
  const encodedId = encodeURIComponent(notification.id);
  const path = String(notification.openEndpoint || '')
    .replaceAll('{id}', encodedId)
    .replaceAll(':id', encodedId);
  return path.startsWith('/api/') ? path : '';
}

async function openNotification(button) {
  const notification = currentNotification(button.dataset.notificationId);
  if (!notification) return;
  const path = notificationOpenPath(notification);
  if (!path) {
    setNotice('This notification cannot be opened from the current dashboard version.', 'error');
    return;
  }
  await api(path, { method: 'POST', body: '{}' });
  openAttentionTarget(notification);
  await loadSnapshot('manual');
}

async function snoozeNotification(button) {
  const notification = currentNotification(button.dataset.notificationId);
  if (!notification) return;
  const path = notificationSnoozePath(notification);
  if (!path) {
    setNotice('This notification cannot be snoozed from the current dashboard version.', 'error');
    return;
  }
  await api(path, {
    method: 'POST',
    body: JSON.stringify({ minutes: 15 })
  });
  setNotice(`Snoozed “${notification.title}” for 15 minutes.`);
  await loadSnapshot('manual');
}

function activeMissionForAgentSession(session) {
  return state.snapshot?.missions?.jobs?.find((mission) =>
    mission.assignedSession === session && ['dispatching', 'running', 'needs_you', 'verifying', 'reconcile_required'].includes(mission.status)
  ) || null;
}

function readMissionDraft(form) {
  const formData = new FormData(form);
  state.missionDraft = {
    ...state.missionDraft,
    open: form.closest('details')?.open ?? state.missionDraft.open,
    title: String(formData.get('title') || ''),
    workspace: String(formData.get('workspace') || ''),
    priority: String(formData.get('priority') || 'normal'),
    goal: String(formData.get('goal') || ''),
    verificationCriteria: String(formData.get('verificationCriteria') || '')
  };
}

async function createMissionFromForm(form) {
  if (state.snapshot?.capabilities?.missionQueue !== true) {
    setNotice('Mission Queue requires a dashboard backend restart.', 'error');
    return;
  }
  readMissionDraft(form);
  const draft = state.missionDraft;
  setNotice('Adding mission to Up Next...');
  try {
    const result = await api('/api/missions/create', {
      method: 'POST',
      body: JSON.stringify({
        title: draft.title,
        workspace: draft.workspace,
        priority: draft.priority,
        goal: draft.goal,
        verificationCriteria: draft.verificationCriteria,
        status: 'ready'
      })
    });
    state.missionDraft = {
      open: false,
      title: '',
      workspace: draft.workspace,
      priority: 'normal',
      goal: '',
      verificationCriteria: 'Review the result and record the evidence that proves the requested outcome.'
    };
    form.reset();
    setNotice(`Queued: ${result.job.title}. Nothing was dispatched.`);
    await loadSnapshot('manual');
  } catch (error) {
    setNotice(`Mission create failed: ${error.message}`, 'error');
  }
}

async function dispatchMissionClient(button) {
  const mission = currentMission(button.dataset.missionId);
  if (!mission) return;
  const card = button.closest('.mission-card');
  const session = card?.querySelector('[data-mission-worker]')?.value || '';
  if (!session) {
    setNotice('Choose an idle agent already working in this project.', 'error');
    return;
  }
  if (!window.confirm(`Dispatch “${mission.title}” to ${displayNameForSession(session)}?`)) return;
  setNotice(`Dispatching ${mission.title}...`);
  try {
    const result = await api(`/api/missions/${encodeURIComponent(mission.id)}/dispatch`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: mission.revision, session })
    });
    markAgentInteraction(session, 'mission.dispatch', new Date().toISOString(), { rerender: false });
    setNotice(`Mission running in ${result.session}.`);
    await loadSnapshot('manual');
    openAgentDetail(result.session, result.job?.assignedPaneId || '');
  } catch (error) {
    const suffix = error.data?.error === 'mission_revision_conflict' ? ' Refreshing the latest mission state.' : '';
    setNotice(`Dispatch failed: ${error.message}.${suffix}`, 'error');
    await loadSnapshot('manual');
  }
}

async function adoptExistingMissionClient(button) {
  const mission = currentMission(button.dataset.missionId);
  if (!mission) return;
  const card = button.closest('.mission-card');
  const paneId = card?.querySelector('[data-mission-adopt-worker]')?.value || '';
  const worker = (state.snapshot?.agents || []).find((agent) => agent.id === paneId) || null;
  if (
    !worker ||
    !worker.sessionCreatedAt ||
    !/^%\d+$/.test(String(worker.tmuxPaneId || '')) ||
    !Number.isInteger(worker.panePid)
  ) {
    setNotice('That worker identity is incomplete or stale. Refresh and choose it again.', 'error');
    return;
  }
  const confirmed = window.confirm([
    `Adopt the work already running in ${displayNameForSession(worker.session)} for “${mission.title}”?`,
    '',
    'Confirm you inspected this terminal and it is doing this mission.',
    'PaneFleet will update queue ownership only. It will not send a prompt, Enter, or any terminal input.'
  ].join('\n'));
  if (!confirmed) return;

  setNotice(`Adopting existing work from ${worker.session}...`);
  try {
    const result = await api(`/api/missions/${encodeURIComponent(mission.id)}/adopt`, {
      method: 'POST',
      body: JSON.stringify({
        expectedRevision: mission.revision,
        confirm: 'adopt-existing',
        session: worker.session,
        sessionCreatedAt: worker.sessionCreatedAt,
        paneId: worker.id,
        tmuxPaneId: worker.tmuxPaneId,
        panePid: worker.panePid
      })
    });
    setNotice(`${result.job.title} adopted in ${result.session}. No terminal input was sent.`);
    await loadSnapshot('manual');
  } catch (error) {
    const suffix = error.data?.error === 'mission_revision_conflict'
      ? ' The queue changed; refreshed the latest state.'
      : '';
    setNotice(`Adoption failed: ${error.message}.${suffix}`, 'error');
    await loadSnapshot('manual');
  }
}

async function moveMissionClient(button) {
  const mission = currentMission(button.dataset.missionId);
  if (!mission) return;
  try {
    await api(`/api/missions/${encodeURIComponent(mission.id)}/move`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: mission.revision, direction: button.dataset.direction })
    });
    setNotice(`Moved ${mission.title} ${button.dataset.direction}.`);
    await loadSnapshot('manual');
  } catch (error) {
    setNotice(`Move failed: ${error.message}`, 'error');
    await loadSnapshot('manual');
  }
}

async function transitionMissionClient(button) {
  const mission = currentMission(button.dataset.missionId);
  if (!mission) return;
  const to = button.dataset.to;
  let note = '';
  let confirm = '';
  if (to === 'done') {
    const entered = window.prompt('Verification evidence required. What proves this mission is complete?', mission.verification?.note || '');
    if (entered === null) return;
    note = entered.trim();
    if (!note) {
      setNotice('Done was not recorded: verification evidence is required.', 'error');
      return;
    }
  } else if (to === 'failed') {
    const entered = window.prompt('What failed?');
    if (entered === null) return;
    note = entered.trim();
    if (!note) return;
    if (['dispatching', 'running', 'needs_you', 'verifying', 'reconcile_required'].includes(mission.status)) {
      if (!window.confirm('Marking Failed releases the worker and workspace locks but does not stop the tmux agent. Confirm you inspected that terminal.')) return;
      confirm = 'inspected-release';
    }
  } else if (to === 'needs_you') {
    const entered = window.prompt('What decision or input is needed?', mission.blocker || 'Operator review requested.');
    if (entered === null) return;
    note = entered.trim();
  } else if (to === 'canceled') {
    const releasesLock = ['dispatching', 'running', 'needs_you', 'verifying', 'reconcile_required'].includes(mission.status);
    const warning = releasesLock
      ? `Cancel “${mission.title}”? This releases its worker and workspace locks but does not stop the tmux agent. Confirm you inspected or parked that terminal.`
      : `Cancel “${mission.title}”?`;
    if (!window.confirm(warning)) return;
    note = 'Canceled by operator.';
    if (releasesLock) confirm = 'inspected-release';
  } else if (mission.status === 'dispatching' && to === 'reconcile_required') {
    if (!window.confirm('The durable dispatch outcome is incomplete. Inspect the assigned terminal before resolving this mission.')) return;
    confirm = 'inspect-dispatch';
  } else if (mission.status === 'reconcile_required' && to === 'running') {
    if (!mission.worker?.present || !mission.worker?.identityMatches) {
      setNotice('Cannot assume running: the original tmux worker is missing or was replaced.', 'error');
      return;
    }
    if (!window.confirm('Confirm the mission prompt was submitted and the assigned agent is working on it.')) return;
    confirm = 'assume-running';
  } else if (to === 'ready' && ['running', 'needs_you', 'verifying', 'reconcile_required'].includes(mission.status)) {
    if (!window.confirm('Requeue releases the workspace lock but does not stop the assigned agent. Confirm you inspected that terminal first.')) return;
    confirm = 'inspected-release';
  }

  try {
    const result = await api(`/api/missions/${encodeURIComponent(mission.id)}/transition`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: mission.revision, to, note, confirm })
    });
    setNotice(`${mission.title}: ${missionStatusLabel(result.job.status)}.`);
    await loadSnapshot('manual');
  } catch (error) {
    setNotice(`Mission update failed: ${error.message}`, 'error');
    await loadSnapshot('manual');
  }
}

function showMissionResult(id) {
  const mission = currentMission(id);
  if (!mission) return;
  showOutput(
    mission.title,
    `${missionStatusLabel(mission.status)} · ${shortPath(mission.workspace)}`,
    [
      `Mission: ${mission.id}`,
      `Goal: ${mission.goal}`,
      `Verification required: ${mission.verificationCriteria}`,
      `Worker: ${mission.assignedSession || 'unassigned'}`,
      '',
      'Result / evidence:',
      mission.resultSummary || mission.blocker || 'No result recorded.'
    ].join('\n')
  );
}

function openMissionCreate() {
  state.missionDraft.open = true;
  switchView('queue');
  render();
  window.requestAnimationFrame(() => {
    const panel = document.querySelector('.mission-create-panel');
    if (!panel) return;
    panel.open = true;
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    panel.querySelector('input, select, textarea')?.focus({ preventScroll: true });
  });
}

function showMoreMissionHistory() {
  state.missionHistoryOpen = true;
  state.missionHistoryLimit += 24;
  render();
}

function setOpenDrawer(drawer, { returnFocus = null, focus = true } = {}) {
  const next = drawer === 'queue' || drawer === 'tools' ? drawer : null;
  const previous = state.openDrawer;
  if (next && !previous && returnFocus) state.drawerReturnFocus = returnFocus;
  state.openDrawer = next;
  const drawerElements = { queue: els.queueDrawer, tools: els.toolsDrawer };
  for (const [name, element] of Object.entries(drawerElements)) {
    const open = name === next;
    element.classList.toggle('hidden', !open);
    element.setAttribute('aria-hidden', open ? 'false' : 'true');
  }
  els.drawerBackdrop.classList.toggle('hidden', !next);
  els.drawerBackdrop.setAttribute('aria-hidden', next ? 'false' : 'true');
  document.body.classList.toggle('drawer-open', Boolean(next));
  for (const button of document.querySelectorAll('[data-action="drawer-toggle"][data-drawer]')) {
    const expanded = button.dataset.drawer === next;
    button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    if (button.id === 'queue-tab' || button.id === 'tools-tab') button.classList.toggle('active', expanded);
  }
  if (next && focus) {
    window.requestAnimationFrame(() => drawerElements[next]?.focus({ preventScroll: true }));
  } else if (!next && previous && focus && state.drawerReturnFocus?.isConnected) {
    state.drawerReturnFocus.focus({ preventScroll: true });
    state.drawerReturnFocus = null;
  } else if (!next && previous) {
    state.drawerReturnFocus = null;
  }
}

function toggleDrawer(name, trigger = null) {
  setOpenDrawer(nextDrawer(state.openDrawer, name), { returnFocus: trigger });
}

function openToolView(view = 'overview', { focus = true } = {}) {
  const allowed = new Set(['overview', 'services', 'security', 'system']);
  const selected = allowed.has(view) ? view : 'overview';
  state.activeToolView = selected;
  els.toolTabs.forEach((tab) => {
    const active = tab.dataset.toolView === selected;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  els.toolViews.forEach((panel) => {
    const active = panel.id === (selected === 'overview' ? 'tools-overview' : `${selected}-view`);
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
  setOpenDrawer('tools', { returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null, focus });
}

function switchView(view, { focusTab = false } = {}) {
  if (view === 'queue') {
    setOpenDrawer('queue', { returnFocus: document.querySelector('#queue-tab') });
    return;
  }
  if (view === 'services') {
    openToolView('services');
    return;
  }
  if (view === 'security') {
    openToolView('security');
    return;
  }
  if (['review', 'ports', 'processes', 'audit', 'system'].includes(view)) {
    openToolView('system');
    if (view !== 'system') window.requestAnimationFrame(() => document.querySelector(`#${view}-view`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    return;
  }
  if (view !== 'agents') return;
  setOpenDrawer(null);
  const selectedTab = document.querySelector('#agents-tab');
  selectedTab.classList.add('active');
  selectedTab.setAttribute('aria-current', 'page');
  els.agents.classList.add('active');
  els.agents.hidden = false;
  if (focusTab) selectedTab.focus({ preventScroll: true });
}

function openServiceDetail(serviceId) {
  switchView('services');
  window.requestAnimationFrame(() => {
    const card = [...els.services.querySelectorAll('[data-service-id]')]
      .find((item) => item.dataset.serviceId === serviceId);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card.focus({ preventScroll: true });
  });
}

function openNewAgentLauncher() {
  state.agentDraft.open = true;
  render();
  window.requestAnimationFrame(() => {
    const launcher = document.querySelector('.new-agent-panel');
    if (!launcher) return;
    launcher.open = true;
    launcher.scrollIntoView({ behavior: 'smooth', block: 'start' });
    launcher.querySelector('select, input, textarea')?.focus({ preventScroll: true });
  });
}

function openActiveAgentWindows() {
  const briefs = state.snapshot?.orchestration?.agents || [];
  const activeSessions = briefs
    .filter((agent) => agent.state === 'busy' || agent.state === 'waiting' || agent.needsAttention)
    .map((agent) => agent.session)
    .filter(Boolean);
  const fallback = (state.snapshot?.agents || []).map((agent) => agent.session).filter(Boolean);
  const sessions = [...new Set(activeSessions.length ? activeSessions : fallback)].slice(0, 6);
  sessions.forEach((session, index) => {
    window.setTimeout(() => openAgentDetail(session), index * 120);
  });
  setNotice(sessions.length ? `Opened ${sessions.length} active terminal${sessions.length === 1 ? '' : 's'}.` : 'No agent terminals are available.');
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) {
    const focusedTerminal = terminalItemFromTarget(event.target);
    const terminalEditor = event.target.closest('.terminal-send-form, input, textarea, select, [contenteditable="true"]');
    if (!terminalEditor && focusedTerminal && currentAgent(focusedTerminal.session) && !isReviewAgent(currentAgent(focusedTerminal.session))) {
      void touchOpenedAgent(focusedTerminal.session);
    }
    return;
  }
  const action = target.dataset.action;
  const terminalItem = terminalItemFromTarget(target);
  if (terminalItem) focusTerminalWindow(terminalItem);
  switch (action) {
    case 'drawer-toggle':
      toggleDrawer(target.dataset.drawer, target);
      break;
    case 'drawer-close':
      setOpenDrawer(null);
      break;
    case 'tool-view':
      openToolView(target.dataset.toolView || 'overview', { focus: false });
      break;
    case 'attention-open':
      openAttentionTarget(currentAttentionItem(target.dataset.attentionId));
      break;
    case 'notification-open':
      runElementTask(target, () => openNotification(target));
      break;
    case 'notification-snooze':
      runElementTask(target, () => snoozeNotification(target));
      break;
    case 'mission-create-open':
      openMissionCreate();
      break;
    case 'mission-run':
      runElementTask(target, () => dispatchMissionClient(target));
      break;
    case 'mission-adopt':
      runElementTask(target, () => adoptExistingMissionClient(target));
      break;
    case 'mission-move':
      runElementTask(target, () => moveMissionClient(target));
      break;
    case 'mission-transition':
      runElementTask(target, () => transitionMissionClient(target));
      break;
    case 'mission-open-agent':
      openAgentDetail(target.dataset.session, target.dataset.paneId || '');
      void touchOpenedAgent(target.dataset.session, { force: true });
      break;
    case 'mission-result':
      showMissionResult(target.dataset.missionId);
      break;
    case 'mission-history-more':
      showMoreMissionHistory();
      break;
    case 'mission-open-queue':
      revealMissionCard(target.dataset.missionId);
      break;
    case 'peek':
      openDetail(target.dataset.session);
      if (currentAgent(target.dataset.session) && !isReviewAgent(currentAgent(target.dataset.session))) {
        void touchOpenedAgent(target.dataset.session, { force: true });
      }
      break;
    case 'agent-detail':
      openAgentDetail(target.dataset.session);
      void touchOpenedAgent(target.dataset.session, { force: true });
      break;
    case 'copy-attach':
      copyAttach(target.dataset.session);
      break;
    case 'session-pin':
      togglePinnedSession(target.dataset.session);
      break;
    case 'send-newline':
      if (terminalItem) insertSendText(terminalItem, '\n');
      break;
    case 'send-indent':
      if (terminalItem) insertSendText(terminalItem, '  ');
      break;
    case 'send-clear':
      if (terminalItem) clearSendText(terminalItem);
      break;
    case 'send-undo':
      if (terminalItem) undoClearSendText(terminalItem);
      break;
    case 'send-history-prev':
      if (terminalItem) navigateTerminalHistory(terminalItem, -1);
      break;
    case 'send-history-next':
      if (terminalItem) navigateTerminalHistory(terminalItem, 1);
      break;
    case 'paste-insert':
      if (terminalItem) insertPendingPaste(terminalItem);
      break;
    case 'paste-cancel':
      if (terminalItem) clearPendingPaste(terminalItem);
      break;
    case 'terminal-tab':
      if (terminalItem?.minimized) restoreTerminalWindow(terminalItem);
      else if (terminalItem) {
        focusTerminalWindow(terminalItem);
        applyTerminalLayout();
        renderTerminalChrome();
      }
      break;
    case 'terminal-layout':
      setTerminalLayout(target.dataset.layout);
      break;
    case 'terminal-full-height':
      setTerminalFullHeight();
      break;
    case 'close-finished-terminals':
      closeFinishedTerminals();
      break;
    case 'project-desk-refresh':
      syncProjectDesk({ refreshContext: true });
      break;
    case 'project-artifact-download':
      runElementTask(target, () => projectArtifactDownload(target));
      break;
    case 'scratchpad-snippet-insert':
      insertScratchpadSnippet();
      break;
    case 'scratchpad-snippet-save':
      saveScratchpadSnippet();
      break;
    case 'scratchpad-snippet-delete':
      deleteScratchpadSnippet();
      break;
    case 'scratchpad-review':
      openScratchpadReview();
      break;
    case 'scratchpad-review-cancel':
      clearScratchpadReview();
      updateProjectComposerState();
      els.scratchpadText.focus({ preventScroll: true });
      break;
    case 'scratchpad-send-confirm':
      runElementTask(target, confirmScratchpadSend);
      break;
    case 'terminal-minimize':
      minimizeTerminalWindow(terminalItem);
      break;
    case 'terminal-restore':
      restoreTerminalWindow(terminalItem);
      if (terminalItem && currentAgent(terminalItem.session) && !isReviewAgent(currentAgent(terminalItem.session))) {
        void touchOpenedAgent(terminalItem.session);
      }
      break;
    case 'terminal-maximize':
      toggleTerminalMaximize(terminalItem);
      break;
    case 'terminal-close':
      closeTerminalWindow(terminalItem);
      break;
    case 'terminal-command':
      if (terminalItem) sendTerminalCommand(terminalItem, target.dataset.command);
      break;
    case 'terminal-picker-toggle':
      if (state.snapshot?.capabilities?.pickerUiKeys !== true) {
        setNotice('Picker navigation requires a dashboard backend restart.', 'error');
      } else if (terminalItem?.pickerActive) {
        sendTerminalUiKey(terminalItem, 'cancel');
      } else if (terminalItem) {
        toggleTerminalPickerControls(terminalItem, true, 'effort', true);
        forceTerminalScrollBottom(terminalItem);
      }
      break;
    case 'terminal-ui-key':
      if (terminalItem) sendTerminalUiKey(terminalItem, target.dataset.key);
      break;
    case 'new-agent-open':
      openNewAgentLauncher();
      break;
    case 'open-active-agents':
      openActiveAgentWindows();
      break;
    case 'dashboard-refresh':
      loadSnapshot('manual');
      break;
    case 'ssh-rescue-open':
      runElementTask(target, openSshRescue);
      break;
    case 'ssh-rescue-lock':
      runElementTask(target, lockSshRescue);
      break;
    case 'ip-rules-view':
      runElementTask(target, viewIpRules);
      break;
    case 'ip-rules-cleanup':
      runElementTask(target, cleanupManagedIpRules);
      break;
    case 'agent-resume':
      {
        const settings = target.closest('.model-settings');
        const model = settings?.querySelector('[data-model-select]')?.value || '';
        const reasoning = settings?.querySelector('[data-reasoning-select]')?.value || '';
        runElementTask(target, () => resumeAgent(target.dataset.session, model, reasoning));
      }
      break;
    case 'interrupt-agent':
      runElementTask(target, () => interruptAgent(target.dataset.session));
      break;
    case 'session-interrupt':
      runElementTask(target, () => sessionAction(target.dataset.session, 'interrupt'));
      break;
    case 'session-stop':
      runElementTask(target, () => sessionAction(target.dataset.session, 'stop'));
      break;
    case 'review-start':
      runElementTask(target, runReview);
      break;
    case 'switch-review':
      switchView('review');
      break;
    case 'switch-services':
      openServiceDetail(target.dataset.service);
      break;
    case 'service-start':
      runElementTask(target, () => serviceAction(target.dataset.service, 'start'));
      break;
    case 'service-stop':
      runElementTask(target, () => serviceAction(target.dataset.service, 'stop'));
      break;
    case 'service-restart':
      runElementTask(target, () => serviceAction(target.dataset.service, 'restart'));
      break;
    case 'service-custom':
      runElementTask(target, () => customServiceAction(
          target.dataset.service,
          target.dataset.customAction,
          target.dataset.confirm === '1',
          target.dataset.requiresPublicIp === '1'
        ));
      break;
  }
});

document.addEventListener('submit', (event) => {
  if (event.target?.id === 'mission-create-form') {
    event.preventDefault();
    runElementTask(event.target, () => createMissionFromForm(event.target));
    return;
  }
  if (event.target?.id === 'new-agent-form') {
    event.preventDefault();
    runElementTask(event.target, () => createAgent(event.target));
    return;
  }
  const terminalItem = terminalItemFromTarget(event.target);
  if (terminalItem && event.target.classList.contains('terminal-send-form')) {
    event.preventDefault();
    sendTerminalText(terminalItem);
  }
});

document.addEventListener('input', (event) => {
  if (event.target === els.sessionSearch) {
    filterSessionRail(event.target.value);
    return;
  }
  if (event.target === els.projectNotes) {
    const target = state.projectDesk.target;
    if (target) {
      state.projectDesk.notesDirty = true;
      safeStorageSet(projectNotesKey(state.projectDesk.notesScope || target.workspace), event.target.value.slice(0, PROJECT_NOTES_MAX));
      els.projectNotesState.textContent = 'Saved locally';
    }
    return;
  }
  if (event.target === els.scratchpadText) {
    const target = state.projectDesk.target;
    if (target) safeStorageSet(scratchpadDraftKey(target), event.target.value.slice(0, SEND_TEXT_MAX));
    clearScratchpadReview();
    updateProjectComposerState();
    return;
  }
  if (event.target === els.scratchpadSnippetName) {
    updateProjectComposerState();
    return;
  }
  const missionForm = event.target?.closest?.('#mission-create-form');
  if (missionForm) readMissionDraft(missionForm);
  const form = event.target?.closest?.('#new-agent-form');
  if (form) readAgentDraft(form);
  const terminalItem = terminalItemFromTarget(event.target);
  if (terminalItem && event.target.classList.contains('terminal-send-text')) {
    handleTerminalTextInput(event, terminalItem);
  }
});

document.addEventListener('paste', (event) => {
  if (!event.target?.classList?.contains('terminal-send-text')) return;
  const item = terminalItemFromTarget(event.target);
  const value = event.clipboardData?.getData('text/plain') || '';
  const lineCount = value.split(/\r?\n/).length;
  if (!item || !value || (value.length <= 400 && lineCount <= 3)) return;
  event.preventDefault();
  previewTerminalPaste(item, value);
});

document.addEventListener('change', (event) => {
  if (event.target === els.scratchpadSnippetSelect) {
    const snippet = selectedPromptSnippet();
    els.scratchpadSnippetName.value = snippet && !snippet.builtIn ? snippet.name : '';
    updateProjectComposerState();
    return;
  }
  const missionForm = event.target?.closest?.('#mission-create-form');
  if (missionForm) {
    readMissionDraft(missionForm);
    return;
  }
  const form = event.target?.closest?.('#new-agent-form');
  if (event.target?.matches?.('[data-model-select]')) {
    const settings = event.target.closest('.model-settings');
    syncModelSettings(settings);
    rememberResumeSettings(settings);
    if (form) readAgentDraft(form);
    return;
  }
  if (event.target?.matches?.('[data-reasoning-select]')) {
    rememberResumeSettings(event.target.closest('.model-settings'));
  }
  if (!form) return;
  if (event.target.name === 'preset') {
    applyPresetToLauncher(form);
    return;
  }
  if (event.target.name === 'workspace') {
    syncAgentLauncher(form);
    return;
  }
  readAgentDraft(form);
});

document.addEventListener('toggle', (event) => {
  if (event.target?.classList?.contains('mission-details')) {
    const missionId = event.target.closest('.mission-card')?.dataset.missionId;
    if (missionId) {
      if (event.target.open) state.openMissionDetails.add(missionId);
      else state.openMissionDetails.delete(missionId);
    }
  }
  if (event.target?.classList?.contains('mission-history')) {
    state.missionHistoryOpen = event.target.open;
  }
  if (event.target?.classList?.contains('mission-create-panel')) {
    state.missionDraft.open = event.target.open;
  }
  if (event.target?.classList?.contains('new-agent-panel')) {
    state.agentDraft.open = event.target.open;
  }
}, true);

function handleTabKeydown(event) {
  const currentIndex = els.tabs.indexOf(event.currentTarget);
  if (currentIndex < 0) return;
  let nextIndex = currentIndex;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % els.tabs.length;
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + els.tabs.length) % els.tabs.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = els.tabs.length - 1;
  else return;
  event.preventDefault();
  const next = els.tabs[nextIndex];
  next.focus({ preventScroll: true });
  if (next.dataset.view) switchView(next.dataset.view);
  else next.click();
}

els.tabs.forEach((tab) => {
  if (tab.dataset.view) tab.addEventListener('click', () => switchView(tab.dataset.view));
  tab.addEventListener('keydown', handleTabKeydown);
});
els.refresh.addEventListener('click', () => Promise.all([
  loadSnapshot('manual'),
  loadOptions()
]));
window.addEventListener('resize', handleTerminalViewportResize);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    for (const item of state.terminalWindows.values()) {
      if (item.timer) window.clearTimeout(item.timer);
      item.timer = null;
    }
    return;
  }
  for (const item of state.terminalWindows.values()) {
    if (item.mode !== 'static' && !item.minimized) scheduleTerminalRefresh(item, 0);
  }
});

async function sendTerminalCommand(item, command) {
  const labels = new Map([
    ['/model', 'Model picker'],
    ['/status', 'Status'],
    ['/usage', 'Usage'],
    ['/fast', 'Fast mode toggle']
  ]);
  if (!item || item.sendInFlight || item.uiKeyInFlight || item.pickerActive || !labels.has(command)) return;
  if (command === '/model' && state.snapshot?.capabilities?.pickerUiKeys !== true) {
    setNotice('Model picker requires a dashboard backend restart.', 'error');
    return;
  }
  const canPrompt = canPromptAgent(item.session);
  if (!canPrompt.ok) {
    setNotice(`${labels.get(command)} unavailable: ${displayNameForSession(item.session)} is not accepting input.`, 'error');
    return;
  }
  item.sendInFlight = true;
  updateSendInputState(item);
  try {
    const activeMission = activeMissionForAgentSession(item.session);
    await api('/api/agent/send', {
      method: 'POST',
      body: JSON.stringify({ session: item.session, text: command, missionId: activeMission?.id || null })
    });
    markAgentInteraction(item.session, 'agent.send');
    if (command === '/model') toggleTerminalPickerControls(item, true, 'model', true);
    forceTerminalScrollBottom(item);
    setNotice(`${labels.get(command)} sent to ${displayNameForSession(item.session)}.`);
    window.setTimeout(() => {
      if (state.terminalWindows.has(item.id)) refreshTerminalWindow(item);
    }, 600);
  } catch (error) {
    setNotice(`${labels.get(command)} failed: ${error.message}`, 'error');
  } finally {
    item.sendInFlight = false;
    updateSendInputState(item);
  }
}

// Picker keys use a separate allowlisted API; prompt input stays literal text plus Enter.
async function sendTerminalUiKey(item, key) {
  const allowedKeys = new Set(['up', 'down', 'left', 'right', 'select', 'cancel']);
  if (state.snapshot?.capabilities?.pickerUiKeys !== true || !item || !item.pickerActive || !allowedKeys.has(key)) return;
  if (key === 'cancel') {
    item.uiKeyQueue.length = 0;
    item.uiKeyQueue.push(key);
  } else {
    if (item.uiKeyQueue.length >= 24) return;
    item.uiKeyQueue.push(key);
  }
  if (item.uiKeyInFlight) return;
  item.uiKeyInFlight = true;
  updateSendInputState(item);
  let sentAny = false;

  try {
    while (item.uiKeyQueue.length && state.terminalWindows.has(item.id)) {
      const nextKey = item.uiKeyQueue.shift();
      const canPrompt = canPromptAgent(item.session);
      if (!canPrompt.ok) throw new Error(`${displayNameForSession(item.session)} is not accepting input`);
      const activeMission = activeMissionForAgentSession(item.session);
      await api('/api/agent/ui-key', {
        method: 'POST',
        body: JSON.stringify({ session: item.session, key: nextKey, missionId: activeMission?.id || null })
      });
      sentAny = true;
      markAgentInteraction(item.session, 'agent.ui_key', new Date().toISOString(), { rerender: false });
      forceTerminalScrollBottom(item);
      if (nextKey === 'cancel') {
        toggleTerminalPickerControls(item, false);
      } else if (nextKey === 'select' && item.pickerStage === 'model') {
        toggleTerminalPickerControls(item, true, 'effort');
      } else if (nextKey === 'select' && item.pickerStage === 'effort') {
        toggleTerminalPickerControls(item, false);
      }
    }
    window.setTimeout(() => {
      if (state.terminalWindows.has(item.id)) refreshTerminalWindow(item);
    }, 180);
    if (sentAny) render({ preserveActiveEditor: true });
  } catch (error) {
    item.uiKeyQueue.length = 0;
    setNotice(`Picker navigation failed: ${error.message}`, 'error');
  } finally {
    item.uiKeyInFlight = false;
    updateSendInputState(item);
  }
}

async function sendTerminalTextValue(item, text, { expectedTarget = null, clearTerminalInput = false, onSent = null } = {}) {
  if (!item || item.sendInFlight || item.uiKeyInFlight || item.pickerActive) return;
  const { session } = item;
  const value = String(text || '');
  if (!session || !value.trim()) return false;
  if (expectedTarget) {
    const currentTarget = projectDeskTargetForTerminal(item);
    if (!sameExactTarget(expectedTarget, currentTarget)) {
      setNotice('Input not sent: the reviewed tmux pane was replaced or is no longer focused.', 'error');
      return false;
    }
  }
  const canPrompt = canPromptAgent(session);
  if (!canPrompt.ok) {
    setNotice(`Input not sent: ${displayNameForSession(session)} is ${canPrompt.reason}.`, 'error');
    updateTerminalSendForm(item);
    return false;
  }
  item.sendInFlight = true;
  updateSendInputState(item);
  try {
    const activeMission = activeMissionForAgentSession(session);
    const durableTarget = expectedTarget || projectDeskTargetForTerminal(item);
    await api('/api/agent/send', {
      method: 'POST',
      body: JSON.stringify({
        session,
        text: value,
        missionId: activeMission?.id || null,
        ...(durableTarget?.identityComplete ? exactTargetIdentityPayload(durableTarget) : {})
      })
    });
    markAgentInteraction(session, 'agent.send');
    rememberTerminalHistory(item, value);
    if (clearTerminalInput && item.sendText.value === value) clearSendText(item, { remember: false });
    if (onSent) onSent();
    setNotice(`Sent terminal input to ${displayNameForSession(session)}.`);
    window.setTimeout(() => {
      if (state.terminalWindows.has(item.id) && item.mode !== 'static') refreshTerminalWindow(item);
    }, 600);
    return true;
  } catch (error) {
    setNotice(`Send failed: ${error.message}`, 'error');
    return false;
  } finally {
    item.sendInFlight = false;
    updateSendInputState(item);
    updateProjectComposerState();
  }
}

async function sendTerminalText(item) {
  if (!item) return false;
  return sendTerminalTextValue(item, item.sendText.value, { clearTerminalInput: true });
}

async function confirmScratchpadSend() {
  const review = state.projectDesk.review;
  if (!review || state.projectDesk.sending) return;
  if (!projectDeskCapabilityAvailable()) {
    setNotice('Prompt not sent: restart PaneFleet to enable durable exact-target validation.', 'error');
    clearScratchpadReview();
    updateProjectComposerState();
    return;
  }
  const item = state.terminalWindows.get(review.terminalId);
  const currentTarget = projectDeskTargetForTerminal(item);
  if (!item || !sameExactTarget(review, currentTarget)) {
    setNotice('Prompt not sent: the reviewed tmux pane identity changed. Review the target again.', 'error');
    clearScratchpadReview();
    syncProjectDesk();
    return;
  }
  state.projectDesk.sending = true;
  updateProjectComposerState();
  try {
    await sendTerminalTextValue(item, review.text, {
      expectedTarget: review,
      onSent: () => {
        if (els.scratchpadText.value === review.text) {
          els.scratchpadText.value = '';
          safeStorageSet(scratchpadDraftKey(review), '');
        }
        clearScratchpadReview();
      }
    });
  } finally {
    state.projectDesk.sending = false;
    updateProjectComposerState();
  }
}

function requestPromptSubmit(item) {
  if (!item || item.sendInFlight || item.uiKeyInFlight || item.pickerActive) return;
  const now = Date.now();
  if (now - item.promptSubmitRequestedAt < 250) return;
  item.promptSubmitRequestedAt = now;
  window.setTimeout(() => item.sendForm.requestSubmit(), 0);
}

function shouldSubmitOnLineBreak(item) {
  return Date.now() > item.allowLineBreakUntil;
}

function handleTerminalTextInput(event, item) {
  if (item.sendText.value) item.sendUndoText = '';
  persistTerminalDraft(item);
  updateSendInputState(item);
  if (event.isComposing || event.inputType !== 'insertLineBreak' || !shouldSubmitOnLineBreak(item)) return;
  const withoutTrailingBreak = item.sendText.value.replace(/[\r\n]+$/g, '');
  if (withoutTrailingBreak !== item.sendText.value) {
    item.sendText.value = withoutTrailingBreak;
    updateSendInputState(item);
  }
  requestPromptSubmit(item);
}

document.addEventListener('pointerdown', (event) => {
  const item = terminalItemFromTarget(event.target);
  if (!item) return;
  focusTerminalWindow(item);
  const resizeHandle = event.target.closest('[data-terminal-resize]');
  if (resizeHandle) {
    beginTerminalPointerInteraction(event, item, resizeHandle.dataset.terminalResize);
    return;
  }
  const dragHandle = event.target.closest('[data-terminal-drag]');
  if (dragHandle && !event.target.closest('button, input, textarea, select, a')) {
    beginTerminalPointerInteraction(event, item);
  }
});

document.addEventListener('dblclick', (event) => {
  const dragHandle = event.target.closest('[data-terminal-drag]');
  if (!dragHandle || event.target.closest('button')) return;
  toggleTerminalMaximize(terminalItemFromTarget(dragHandle));
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.openDrawer) {
    event.preventDefault();
    setOpenDrawer(null);
    return;
  }
  const activeTerminal = state.terminalWindows.get(state.activeTerminalId);
  if (
    activeTerminal?.pickerActive
    && activeTerminal.element.contains(event.target)
    && TERMINAL_PICKER_KEY_MAP.has(event.key)
    && !event.isComposing
    && event.keyCode !== 229
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey
  ) {
    event.preventDefault();
    sendTerminalUiKey(activeTerminal, TERMINAL_PICKER_KEY_MAP.get(event.key));
    return;
  }

  if (!event.target?.classList?.contains('terminal-send-text') || event.key !== 'Enter') return;
  const item = terminalItemFromTarget(event.target);
  if (!item) return;
  if (event.isComposing || event.keyCode === 229) return;
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
    item.allowLineBreakUntil = Date.now() + 500;
    return;
  }
  event.preventDefault();
  requestPromptSubmit(item);
});

document.addEventListener('beforeinput', (event) => {
  if (!event.target?.classList?.contains('terminal-send-text') || event.isComposing) return;
  const item = terminalItemFromTarget(event.target);
  if (!item || event.inputType !== 'insertLineBreak' || !shouldSubmitOnLineBreak(item)) return;
  event.preventDefault();
  requestPromptSubmit(item);
});

loadSnapshot('startup');
connectEvents();
loadOptions();
