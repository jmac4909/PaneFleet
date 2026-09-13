import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TAIL_BYTES = 4 * 1024 * 1024;
const DEFAULT_METADATA_BYTES = 256 * 1024;
const DELIVERY_RESULT_TAIL_BYTES = 8 * 1024 * 1024;
const LATEST_RESPONSE_TAIL_BYTES = 2 * 1024 * 1024;
const LATEST_RESPONSE_MAX_CHARACTERS = 96 * 1024;
const USAGE_STORE_VERSION = 1;
const USAGE_RETENTION_DAYS = 90;
const USAGE_STATS_DAYS = 30;
const MAX_USAGE_CURSORS = 256;
const MAX_SESSIONS_PER_DAY = 128;
const MAX_USAGE_TICKETS = 1000;
const TOKEN_FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
const LEGACY_USAGE_METHODOLOGY = Object.freeze({
  scope: 'host-local',
  measurement: 'observed-rollout-deltas',
  dayBoundary: 'UTC',
  includesCachedInput: true,
  firstSampleIsBaseline: true,
  accountUsageEquivalent: false,
  perTicket: false,
  coverage: 'partial'
});
const REPLAY_USAGE_METHODOLOGY = Object.freeze({
  scope: 'host-local',
  measurement: 'replayed-rollout-events',
  dayBoundary: 'UTC',
  includesCachedInput: true,
  firstSampleIsBaseline: false,
  accountUsageEquivalent: false,
  perTicket: true,
  coverage: 'complete'
});
const telemetryCache = new Map();

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function tokenCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function canonicalTokenUsage(value = {}) {
  const inputTokens = tokenCount(value.inputTokens);
  const cachedInputTokens = Math.min(inputTokens, tokenCount(value.cachedInputTokens));
  const outputTokens = tokenCount(value.outputTokens);
  const reasoningOutputTokens = Math.min(outputTokens, tokenCount(value.reasoningOutputTokens));
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: Math.min(Number.MAX_SAFE_INTEGER, inputTokens + outputTokens)
  };
}

function boundedText(value, maximum = 120) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maximum);
}

function normalizedTokenUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return canonicalTokenUsage({
    inputTokens: value.input_tokens,
    cachedInputTokens: value.cached_input_tokens,
    outputTokens: value.output_tokens,
    reasoningOutputTokens: value.reasoning_output_tokens
  });
}

function zeroTokenUsage() {
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
}

function safeTokenUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return zeroTokenUsage();
  return canonicalTokenUsage(value);
}

function addTokenUsage(left, right) {
  return canonicalTokenUsage(Object.fromEntries(TOKEN_FIELDS.map((field) => [
    field,
    Math.min(Number.MAX_SAFE_INTEGER, left[field] + right[field])
  ])));
}

function subtractTokenUsage(current, previous) {
  if (TOKEN_FIELDS.some((field) => current[field] < previous[field])) return zeroTokenUsage();
  return canonicalTokenUsage(Object.fromEntries(TOKEN_FIELDS.map((field) => [
    field,
    current[field] - previous[field]
  ])));
}

function usageHasTokens(value) {
  return TOKEN_FIELDS.some((field) => value[field] > 0);
}

function isoTimestamp(value) {
  if (typeof value !== 'string' || !value || Number.isNaN(Date.parse(value))) return '';
  return new Date(value).toISOString();
}

function utcDate(value) {
  const timestamp = isoTimestamp(value);
  return timestamp ? timestamp.slice(0, 10) : '';
}

function validSessionName(value) {
  return typeof value === 'string' && /^codex(?:[\w-]*)?$/.test(value) && value.length <= 128;
}

function normalizedUsageWindow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    usedPercent: Math.min(100, finiteNonNegative(value.usedPercent)),
    windowMinutes: finiteNonNegative(value.windowMinutes),
    resetsAt: isoTimestamp(value.resetsAt) || null
  };
}

function usageSnapshot(account, observedAt) {
  if (!account || typeof account !== 'object' || Array.isArray(account)) return null;
  const primary = normalizedUsageWindow(account.primary);
  const secondary = normalizedUsageWindow(account.secondary);
  if (!primary && !secondary) return null;
  return {
    observedAt,
    limitId: boundedText(account.limitId, 80),
    limitName: boundedText(account.limitName, 80),
    planType: boundedText(account.planType, 80),
    primary,
    secondary
  };
}

function normalizedRateWindow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const resetSeconds = finiteNonNegative(value.resets_at);
  const resetDate = resetSeconds ? new Date(resetSeconds * 1000) : null;
  return {
    usedPercent: Math.min(100, finiteNonNegative(value.used_percent)),
    windowMinutes: finiteNonNegative(value.window_minutes),
    resetsAt: resetDate && Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : null
  };
}

function normalizedRateLimits(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const credits = value.credits && typeof value.credits === 'object' && !Array.isArray(value.credits)
    ? {
        hasCredits: value.credits.has_credits === true,
        unlimited: value.credits.unlimited === true,
        balance: boundedText(value.credits.balance, 64)
      }
    : null;
  return {
    limitId: boundedText(value.limit_id),
    limitName: boundedText(value.limit_name),
    planType: boundedText(value.plan_type),
    primary: normalizedRateWindow(value.primary),
    secondary: normalizedRateWindow(value.secondary),
    credits,
    reachedType: boundedText(value.rate_limit_reached_type)
  };
}

function sandboxLabel(value) {
  if (typeof value === 'string') return boundedText(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return boundedText(value.type);
}

function responseMessageText(payload) {
  if (!payload || payload.type !== 'message' || !Array.isArray(payload.content)) return '';
  return payload.content
    .map((item) => typeof item?.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n');
}

function codexResultReadError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

async function readFileRange(filePath, startOffset, maximumBytes, {
  errorPrefix = 'codex_delivery_result',
  resultLabel = 'Codex rollout result',
  changingLabel = 'Codex rollout',
  rangeLabel = 'result'
} = {}) {
  const handle = await open(filePath, 'r');
  try {
    const details = await handle.stat();
    if (!details.isFile()) {
      throw codexResultReadError(
        `${errorPrefix}_not_file`,
        `The ${resultLabel} source is not a regular file.`
      );
    }
    if (startOffset > details.size) {
      throw codexResultReadError(
        `${errorPrefix}_offset_past_end`,
        'The persisted Codex rollout offset is beyond the current file size.',
        { startOffset, endOffset: details.size }
      );
    }
    const length = details.size - startOffset;
    if (length > maximumBytes) {
      throw codexResultReadError(
        `${errorPrefix}_window_exceeded`,
        `The ${resultLabel} window exceeded the configured byte limit.`,
        { startOffset, endOffset: details.size, maximumBytes }
      );
    }

    let startsAtRecordBoundary = startOffset === 0;
    if (startOffset > 0) {
      const preceding = Buffer.alloc(1);
      const precedingRead = await handle.read(preceding, 0, 1, startOffset - 1);
      if (precedingRead.bytesRead !== 1) {
        throw codexResultReadError(
          `${errorPrefix}_read_incomplete`,
          `The ${changingLabel} changed while its ${rangeLabel} boundary was being read.`,
          { startOffset, endOffset: details.size, maximumBytes }
        );
      }
      startsAtRecordBoundary = preceding[0] === 0x0a;
    }

    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const read = await handle.read(buffer, bytesRead, length - bytesRead, startOffset + bytesRead);
      if (!read.bytesRead) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead !== length) {
      throw codexResultReadError(
        `${errorPrefix}_read_incomplete`,
        `The ${changingLabel} changed while its ${rangeLabel} window was being read.`,
        { startOffset, endOffset: details.size, maximumBytes }
      );
    }

    const firstCompleteRecordOffset = startsAtRecordBoundary ? 0 : buffer.indexOf(0x0a) + 1;
    return {
      text: firstCompleteRecordOffset > 0
        ? buffer.subarray(firstCompleteRecordOffset).toString('utf8')
        : startsAtRecordBoundary
          ? buffer.toString('utf8')
          : '',
      startOffset,
      endOffset: details.size,
      skippedPartialRecord: !startsAtRecordBoundary
    };
  } finally {
    await handle.close();
  }
}

export async function readCodexFinalAnswer(filePath, {
  confirmationMarker,
  confirmationMarkerPattern,
  submittedAt,
  startOffset,
  maximumBytes = DELIVERY_RESULT_TAIL_BYTES,
  maximumWindowBytes = DELIVERY_RESULT_TAIL_BYTES,
  errorPrefix = 'codex_final_answer',
  resultLabel = 'Codex rollout final answer',
  changingLabel = 'Codex rollout',
  rangeLabel = 'final-answer',
  requireSingleFinalAnswer = false
} = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return null;
  const marker = String(confirmationMarker || '');
  const notBefore = Date.parse(String(submittedAt || ''));
  const markerPattern = confirmationMarkerPattern instanceof RegExp
    && !confirmationMarkerPattern.global
    && !confirmationMarkerPattern.sticky
    && confirmationMarkerPattern.source.startsWith('^')
    && confirmationMarkerPattern.source.endsWith('$')
    ? confirmationMarkerPattern
    : null;
  if (!markerPattern || !markerPattern.test(marker) || !Number.isFinite(notBefore)) return null;
  const normalizedErrorPrefix = /^[a-z][a-z0-9_]{0,63}$/.test(errorPrefix)
    ? errorPrefix
    : 'codex_final_answer';
  const normalizedResultLabel = boundedText(resultLabel, 80) || 'Codex rollout final answer';
  const normalizedChangingLabel = boundedText(changingLabel, 80) || 'Codex rollout';
  const normalizedRangeLabel = boundedText(rangeLabel, 80) || 'final-answer';
  const hasPersistedOffset = startOffset !== undefined && startOffset !== null;
  if (hasPersistedOffset && (!Number.isSafeInteger(startOffset) || startOffset < 0)) {
    throw codexResultReadError(
      `${normalizedErrorPrefix}_offset_invalid`,
      'The persisted Codex rollout offset must be a non-negative safe integer.'
    );
  }
  const maximumWindow = Math.max(1, Math.min(
    DELIVERY_RESULT_TAIL_BYTES,
    Math.floor(Number(maximumWindowBytes) || DELIVERY_RESULT_TAIL_BYTES)
  ));
  const boundedMaximum = Math.max(1, Math.min(
    maximumWindow,
    Math.floor(Number(maximumBytes) || maximumWindow)
  ));
  // A legacy caller without an offset may only scan a bounded whole file. It
  // must never fall back to a tail because that could omit the marker-bearing
  // user turn while still accepting a later assistant result.
  const range = await readFileRange(filePath, hasPersistedOffset ? startOffset : 0, boundedMaximum, {
    errorPrefix: normalizedErrorPrefix,
    resultLabel: normalizedResultLabel,
    changingLabel: normalizedChangingLabel,
    rangeLabel: normalizedRangeLabel
  });
  let matchedPrompt = false;
  let superseded = false;
  let latestContext = null;
  let final = null;
  let finalAnswerCount = 0;
  let promptAt = '';
  for (const line of range.text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const eventAt = Date.parse(String(event?.timestamp || ''));
    if (!Number.isFinite(eventAt) || eventAt < notBefore) continue;
    if (event?.type === 'turn_context' && event.payload && typeof event.payload === 'object') {
      if (matchedPrompt && !superseded) latestContext = { payload: event.payload, at: new Date(eventAt).toISOString() };
      continue;
    }
    if (event?.type !== 'response_item') continue;
    const payload = event.payload;
    const message = responseMessageText(payload);
    if (!message) continue;
    if (payload.role === 'user') {
      if (!matchedPrompt && message.includes(marker)) {
        matchedPrompt = true;
        superseded = false;
        promptAt = new Date(eventAt).toISOString();
        latestContext = null;
        final = null;
      } else if (matchedPrompt) {
        superseded = true;
        final = null;
      }
      continue;
    }
    if (
      matchedPrompt
      && !superseded
      && payload.role === 'assistant'
      && payload.phase === 'final_answer'
    ) {
      finalAnswerCount += 1;
      const authority = latestContext?.payload || {};
      const sandboxPolicy = authority.sandbox_policy;
      const sandbox = sandboxLabel(sandboxPolicy);
      const approvalPolicy = boundedText(authority.approval_policy);
      const networkAccessObserved = typeof sandboxPolicy?.network_access === 'boolean';
      final = {
        text: message,
        at: new Date(eventAt).toISOString(),
        sandbox,
        approvalPolicy,
        networkAccess: networkAccessObserved ? sandboxPolicy.network_access : null,
        networkAccessObserved,
        authority: {
          promptAt,
          contextAt: latestContext?.at || null,
          sandboxObserved: Boolean(sandbox),
          approvalPolicyObserved: Boolean(approvalPolicy),
          networkAccessObserved,
          startOffset: range.startOffset,
          endOffset: range.endOffset,
          skippedPartialRecord: range.skippedPartialRecord
        }
      };
    }
  }
  if (requireSingleFinalAnswer && finalAnswerCount !== 1) return null;
  return matchedPrompt && !superseded ? final : null;
}

export async function readCodexDeliveryResult(filePath, options = {}) {
  return readCodexFinalAnswer(filePath, {
    ...options,
    confirmationMarkerPattern: /^\[PaneFleet Dispatch attempt-[a-z0-9-]{8,64}\]$/,
    maximumWindowBytes: DELIVERY_RESULT_TAIL_BYTES,
    errorPrefix: 'codex_delivery_result',
    resultLabel: 'Codex rollout result',
    changingLabel: 'Codex rollout',
    rangeLabel: 'result',
    requireSingleFinalAnswer: false
  });
}

export async function readCodexLatestFinalResponse(filePath, {
  maximumBytes = LATEST_RESPONSE_TAIL_BYTES,
  maximumCharacters = LATEST_RESPONSE_MAX_CHARACTERS
} = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return null;
  const boundedMaximumBytes = Math.max(1024, Math.min(
    LATEST_RESPONSE_TAIL_BYTES,
    Math.floor(Number(maximumBytes) || LATEST_RESPONSE_TAIL_BYTES)
  ));
  const boundedMaximumCharacters = Math.max(1024, Math.min(
    LATEST_RESPONSE_MAX_CHARACTERS,
    Math.floor(Number(maximumCharacters) || LATEST_RESPONSE_MAX_CHARACTERS)
  ));
  const details = await stat(filePath);
  if (!details.isFile()) return null;
  const startOffset = Math.max(0, details.size - boundedMaximumBytes);
  const range = await readFileRange(filePath, startOffset, boundedMaximumBytes, {
    errorPrefix: 'codex_latest_response',
    resultLabel: 'latest Codex response',
    changingLabel: 'Codex rollout',
    rangeLabel: 'latest-response'
  });
  let latest = null;
  for (const line of range.text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (
      event?.type !== 'response_item'
      || event.payload?.role !== 'assistant'
      || event.payload?.phase !== 'final_answer'
    ) continue;
    const text = responseMessageText(event.payload)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    const at = isoTimestamp(event.timestamp);
    if (!text || !at) continue;
    const truncated = text.length > boundedMaximumCharacters;
    latest = {
      text: truncated
        ? `${text.slice(0, boundedMaximumCharacters)}\n\n[Response truncated by PaneFleet]`
        : text,
      at,
      truncated
    };
  }
  return latest;
}

export function parseCodexTelemetryText(text) {
  let sessionMeta = null;
  let turnContext = null;
  let tokenEvent = null;
  let turnState = 'unknown';
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'session_meta' && event.payload && typeof event.payload === 'object') {
        sessionMeta = event;
      }
      if (event?.type === 'turn_context' && event.payload && typeof event.payload === 'object') {
        turnContext = event;
      }
      if (event?.type === 'event_msg' && event.payload?.type === 'token_count') {
        tokenEvent = event;
      }
      if (event?.type === 'event_msg' && event.payload?.type === 'task_started') {
        turnState = 'active';
      }
      if (event?.type === 'event_msg' && event.payload?.type === 'task_complete') {
        turnState = 'idle';
      }
    } catch {
      // A tail read can begin midway through a JSONL record. Complete later
      // records remain usable, so malformed fragments are deliberately skipped.
    }
  }
  if (!sessionMeta && !turnContext && !tokenEvent) return null;

  const total = normalizedTokenUsage(tokenEvent?.payload?.info?.total_token_usage);
  const last = normalizedTokenUsage(tokenEvent?.payload?.info?.last_token_usage);
  const contextWindow = finiteNonNegative(tokenEvent?.payload?.info?.model_context_window);
  const contextUsed = last?.totalTokens || 0;
  const contextUsedPercent = contextWindow
    ? Math.min(100, Math.round((contextUsed / contextWindow) * 1000) / 10)
    : 0;
  const context = contextWindow
    ? {
        scope: 'session',
        usedTokens: contextUsed,
        windowTokens: contextWindow,
        remainingTokens: Math.max(0, contextWindow - contextUsed),
        usedPercent: contextUsedPercent,
        remainingPercent: Math.max(0, Math.round((100 - contextUsedPercent) * 10) / 10)
      }
    : null;
  const turn = turnContext?.payload || {};
  const sandboxPolicy = turn.sandbox_policy && typeof turn.sandbox_policy === 'object' && !Array.isArray(turn.sandbox_policy)
    ? turn.sandbox_policy
    : null;
  const observedAt = tokenEvent?.timestamp || turnContext?.timestamp || sessionMeta?.timestamp || null;
  return {
    source: 'codex-session-log',
    observedAt: Number.isFinite(Date.parse(observedAt || '')) ? new Date(observedAt).toISOString() : null,
    model: boundedText(turn.model),
    effort: boundedText(turn.effort || turn.collaboration_mode?.settings?.reasoning_effort),
    approvalPolicy: boundedText(turn.approval_policy),
    sandbox: sandboxLabel(turn.sandbox_policy),
    networkAccess: typeof sandboxPolicy?.network_access === 'boolean' ? sandboxPolicy.network_access : null,
    networkAccessObserved: typeof sandboxPolicy?.network_access === 'boolean',
    rolloutId: boundedText(sessionMeta?.payload?.id, 80),
    turnState,
    context,
    sessionTokens: total,
    lastTurnTokens: last,
    account: normalizedRateLimits(tokenEvent?.payload?.rate_limits)
  };
}

export function parseCodexRolloutLineageText(text) {
  for (const line of String(text || '').split('\n')) {
    if (!line.includes('"session_meta"')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'session_meta' || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
      continue;
    }
    const payload = event.payload;
    const source = payload.source;
    const subagentSource = Boolean(
      source && typeof source === 'object' && !Array.isArray(source) && Object.hasOwn(source, 'subagent')
    ) || (typeof source === 'string' && /sub[-_ ]?agent/i.test(source));
    const parented = [
      payload.parent_thread_id,
      payload.parentThreadId,
      payload.forked_from_id,
      payload.forkedFromId
    ].some((value) => typeof value === 'string' && value.length > 0);
    return {
      rootInteractive: !subagentSource && !parented,
      subagent: subagentSource,
      parented
    };
  }
  return null;
}

function isInsideRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function codexRolloutCandidatesForPid(pid, { sessionsRoot, procRoot = '/proc' } = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid < 1 || !sessionsRoot) return [];
  let canonicalRoot;
  let descriptors;
  try {
    canonicalRoot = await realpath(sessionsRoot);
    descriptors = await readdir(path.join(procRoot, String(numericPid), 'fd'));
  } catch {
    return [];
  }
  const candidates = new Map();
  for (const descriptor of descriptors) {
    try {
      const descriptorPath = path.join(procRoot, String(numericPid), 'fd', descriptor);
      const target = await readlink(descriptorPath);
      const candidate = await realpath(path.isAbsolute(target) ? target : path.resolve(path.dirname(descriptorPath), target));
      if (!candidate.endsWith('.jsonl') || !isInsideRoot(candidate, canonicalRoot)) continue;
      const details = await stat(candidate);
      if (!details.isFile()) continue;
      const previous = candidates.get(candidate);
      if (!previous || details.mtimeMs > previous.modifiedAtMs) {
        candidates.set(candidate, {
          path: candidate,
          modifiedAtMs: details.mtimeMs,
          descriptor: Number.isInteger(Number(descriptor)) ? Number(descriptor) : -1
        });
      }
    } catch {
      // Process descriptors can disappear while they are being inspected.
    }
  }
  return [...candidates.values()].sort((left, right) => (
    right.modifiedAtMs - left.modifiedAtMs
    || right.descriptor - left.descriptor
    || left.path.localeCompare(right.path)
  ));
}

export async function codexRolloutForPid(pid, options = {}) {
  const candidates = await codexRolloutCandidatesForPid(pid, options);
  if (!candidates.length) return null;
  const inspected = await Promise.all(candidates.map(async (candidate) => {
    try {
      return { candidate, lineage: await readCodexRolloutLineage(candidate.path, options) };
    } catch {
      return { candidate, lineage: null };
    }
  }));
  return (inspected.find(({ lineage }) => lineage?.rootInteractive === true) || inspected[0])?.candidate.path || null;
}

export async function readCodexTelemetryFile(filePath, { maximumBytes = DEFAULT_TAIL_BYTES } = {}) {
  const details = await stat(filePath);
  const boundedMaximum = Math.max(1024, Math.floor(finiteNonNegative(maximumBytes) || DEFAULT_TAIL_BYTES));
  const cacheKey = `${details.size}:${details.mtimeMs}:${boundedMaximum}`;
  const cached = telemetryCache.get(filePath);
  if (cached?.key === cacheKey) return cached.value;

  const start = Math.max(0, details.size - boundedMaximum);
  const length = details.size - start;
  const buffer = Buffer.alloc(length);
  const handle = await open(filePath, 'r');
  try {
    await handle.read(buffer, 0, length, start);
  } finally {
    await handle.close();
  }
  let text = buffer.toString('utf8');
  if (start > 0) {
    const firstNewline = text.indexOf('\n');
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
  }
  const value = parseCodexTelemetryText(text);
  telemetryCache.set(filePath, { key: cacheKey, value });
  if (telemetryCache.size > 64) telemetryCache.delete(telemetryCache.keys().next().value);
  return value;
}

export async function readCodexRolloutLineage(filePath, { maximumBytes = DEFAULT_METADATA_BYTES } = {}) {
  const details = await stat(filePath);
  const boundedMaximum = Math.max(1024, Math.min(DEFAULT_METADATA_BYTES, Math.floor(finiteNonNegative(maximumBytes) || DEFAULT_METADATA_BYTES)));
  const length = Math.min(details.size, boundedMaximum);
  const buffer = Buffer.alloc(length);
  const handle = await open(filePath, 'r');
  try {
    await handle.read(buffer, 0, length, 0);
  } finally {
    await handle.close();
  }
  return parseCodexRolloutLineageText(buffer.toString('utf8'));
}

export async function readCodexTelemetryForPids(pids, options = {}) {
  const uniquePids = [...new Set((Array.isArray(pids) ? pids : []).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
  const candidates = new Map();
  for (const pid of uniquePids) {
    for (const candidate of await codexRolloutCandidatesForPid(pid, options)) {
      const existing = candidates.get(candidate.path) || { sourcePids: [], modifiedAtMs: 0 };
      existing.sourcePids.push(pid);
      existing.modifiedAtMs = Math.max(existing.modifiedAtMs, candidate.modifiedAtMs);
      candidates.set(candidate.path, existing);
    }
  }
  const results = await Promise.all([...candidates.entries()].map(async ([candidate, observation]) => {
    try {
      const [telemetry, lineage] = await Promise.all([
        readCodexTelemetryFile(candidate, options),
        readCodexRolloutLineage(candidate, options)
      ]);
      return telemetry
        ? {
            modifiedAtMs: observation.modifiedAtMs,
            telemetry: {
              ...telemetry,
              rootInteractive: lineage?.rootInteractive === true,
              rolloutId: telemetry.rolloutId || path.basename(candidate).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i)?.[1] || '',
              sourceId: codexUsageSourceId(candidate),
              rolloutPath: candidate,
              sourcePids: [...new Set(observation.sourcePids)].sort((left, right) => left - right),
              candidateCount: candidates.size
            }
          }
        : null;
    } catch {
      return null;
    }
  }));
  const readable = results.filter(Boolean);
  const preferred = readable.some((result) => result.telemetry.rootInteractive === true)
    ? readable.filter((result) => result.telemetry.rootInteractive === true)
    : readable;
  return preferred
    .sort((left, right) => (
      right.modifiedAtMs - left.modifiedAtMs
      || Date.parse(right.telemetry.observedAt || '') - Date.parse(left.telemetry.observedAt || '')
    ))[0]?.telemetry || null;
}

export function codexUsageSourceId(filePath) {
  return createHash('sha256').update(String(filePath || '')).digest('hex').slice(0, 24);
}

async function findCodexRollouts(directory, canonicalRoot, wanted, found) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!wanted.size) return;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await findCodexRollouts(candidate, canonicalRoot, wanted, found);
      continue;
    }
    if (!entry.isFile() || !candidate.endsWith('.jsonl')) continue;
    let canonical;
    try {
      canonical = await realpath(candidate);
    } catch {
      continue;
    }
    if (!isInsideRoot(canonical, canonicalRoot)) continue;
    const sourceId = codexUsageSourceId(canonical);
    if (!wanted.has(sourceId)) continue;
    found[sourceId] = canonical;
    wanted.delete(sourceId);
  }
}

export async function resolveCodexRolloutPaths(sourceIds, { sessionsRoot } = {}) {
  if (!sessionsRoot) return {};
  const wanted = new Set((Array.isArray(sourceIds) ? sourceIds : [])
    .map(String)
    .filter((sourceId) => /^[a-f0-9]{24}$/.test(sourceId)));
  if (!wanted.size) return {};
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(sessionsRoot);
  } catch {
    return {};
  }
  const found = {};
  await findCodexRollouts(canonicalRoot, canonicalRoot, wanted, found);
  return found;
}

function tokenEventFromLine(line) {
  if (!line.includes('"token_count"')) return null;
  let event;
  try {
    event = JSON.parse(line.toString('utf8'));
  } catch {
    return null;
  }
  if (event?.type !== 'event_msg' || event.payload?.type !== 'token_count') return null;
  const observedAt = isoTimestamp(event.timestamp);
  const sessionTokens = normalizedTokenUsage(event.payload?.info?.total_token_usage);
  if (!observedAt || !sessionTokens) return null;
  return {
    observedAt,
    sessionTokens,
    lastTurnTokens: normalizedTokenUsage(event.payload?.info?.last_token_usage) || zeroTokenUsage(),
    account: normalizedRateLimits(event.payload?.rate_limits)
  };
}

export async function readCodexUsageEventBatch(filePath, {
  sourceId = codexUsageSourceId(filePath),
  session = '',
  startOffset = 0
} = {}) {
  const canonical = await realpath(filePath);
  const details = await stat(canonical);
  const requestedStart = Number.isSafeInteger(startOffset) && startOffset >= 0 ? startOffset : 0;
  const cursorPastEnd = requestedStart > details.size;
  const boundedStart = cursorPastEnd ? details.size : requestedStart;
  const events = [];
  let fragments = [];
  let fragmentBytes = 0;
  let nextOffset = boundedStart;
  if (details.size > boundedStart) {
    const stream = createReadStream(canonical, { start: boundedStart, end: details.size - 1 });
    for await (const chunk of stream) {
      let lineStart = 0;
      for (let index = chunk.indexOf(0x0a, lineStart); index >= 0; index = chunk.indexOf(0x0a, lineStart)) {
        const lastFragment = chunk.subarray(lineStart, index);
        const lineBytes = fragmentBytes + lastFragment.length;
        // Image/tool records can span hundreds of chunks. Join once at the
        // newline, not once per chunk (quadratic copying of the growing line).
        const line = fragments.length
          ? Buffer.concat([...fragments, lastFragment], lineBytes)
          : lastFragment;
        const parsed = tokenEventFromLine(line);
        if (parsed) events.push(parsed);
        nextOffset += lineBytes + 1;
        fragments = [];
        fragmentBytes = 0;
        lineStart = index + 1;
      }
      if (lineStart < chunk.length) {
        const fragment = chunk.subarray(lineStart);
        fragments.push(fragment);
        fragmentBytes += fragment.length;
      }
    }
  }
  return {
    sourceId,
    session,
    // Preserve the requested cursor when the rollout shrank so reconciliation
    // can safely advance the existing cursor to the new EOF without replaying
    // the retained prefix and double-counting its usage events.
    startOffset: cursorPastEnd ? requestedStart : boundedStart,
    fileSize: details.size,
    nextOffset,
    completeThrough: details.size === nextOffset,
    events
  };
}

export function latestCodexAccountTelemetry(items) {
  const candidates = (Array.isArray(items) ? items : [])
    .filter((item) => item?.account && Number.isFinite(Date.parse(item.observedAt || '')))
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));
  const byPool = new Map();
  for (const candidate of candidates) {
    const key = candidate.account.limitId || candidate.account.limitName || 'codex';
    if (!byPool.has(key)) byPool.set(key, candidate);
  }
  const pools = [...byPool.values()].map((item) => ({
    sourceSession: boundedText(item.session, 128),
    observedAt: new Date(item.observedAt).toISOString(),
    account: item.account
  }));
  const latest = pools.find((item) => item.account.limitId === 'codex') || pools[0];
  if (!latest) return null;
  return {
    source: 'codex-session-log',
    scope: 'account',
    ...latest,
    pools
  };
}

export function createCodexUsageStore(at = new Date().toISOString()) {
  const timestamp = isoTimestamp(at) || new Date().toISOString();
  return {
    version: USAGE_STORE_VERSION,
    revision: 0,
    initializedAt: timestamp,
    updatedAt: timestamp,
    cursors: {},
    days: {},
    tickets: {},
    replay: {
      coverage: 'partial',
      sourceCount: 0,
      eventCount: 0,
      completedAt: null
    }
  };
}

function validUsageWindow(value) {
  return value === null || (
    value && typeof value === 'object' && !Array.isArray(value)
    && Number.isFinite(value.usedPercent) && value.usedPercent >= 0 && value.usedPercent <= 100
    && Number.isFinite(value.windowMinutes) && value.windowMinutes >= 0
    && (value.resetsAt === null || Boolean(isoTimestamp(value.resetsAt)))
  );
}

function validUsageSnapshot(value) {
  return value === null || (
    value && typeof value === 'object' && !Array.isArray(value)
    && Boolean(isoTimestamp(value.observedAt))
    && typeof value.limitId === 'string' && value.limitId.length <= 80
    && typeof value.limitName === 'string' && value.limitName.length <= 80
    && typeof value.planType === 'string' && value.planType.length <= 80
    && validUsageWindow(value.primary)
    && validUsageWindow(value.secondary)
  );
}

function validTokenUsage(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && TOKEN_FIELDS.every((field) => Number.isSafeInteger(value[field]) && value[field] >= 0)
    && value.cachedInputTokens <= value.inputTokens
    && value.reasoningOutputTokens <= value.outputTokens
    && value.totalTokens === Math.min(Number.MAX_SAFE_INTEGER, value.inputTokens + value.outputTokens);
}

function validReplayState(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && ['partial', 'complete'].includes(value.coverage)
    && Number.isSafeInteger(value.sourceCount) && value.sourceCount >= 0 && value.sourceCount <= MAX_USAGE_CURSORS
    && Number.isSafeInteger(value.eventCount) && value.eventCount >= 0
    && (value.completedAt === null || Boolean(isoTimestamp(value.completedAt)));
}

function validTicketUsage(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && validSessionName(value.session)
    && Boolean(isoTimestamp(value.sentAt))
    && (value.endedAt === null || Boolean(isoTimestamp(value.endedAt)))
    && ['in_progress', 'complete', 'review', 'unverified'].includes(value.state)
    && validTokenUsage(value.tokens)
    && Number.isSafeInteger(value.eventCount) && value.eventCount >= 0
    && (value.firstEventAt === null || Boolean(isoTimestamp(value.firstEventAt)))
    && (value.lastEventAt === null || Boolean(isoTimestamp(value.lastEventAt)))
    && Array.isArray(value.sourceIds)
    && value.sourceIds.length <= MAX_USAGE_CURSORS
    && value.sourceIds.every((sourceId) => /^[a-f0-9]{24}$/.test(sourceId));
}

function sameTokenUsage(left, right) {
  return TOKEN_FIELDS.every((field) => left[field] === right[field]);
}

function usageMethodology(store) {
  return store?.replay?.coverage === 'complete'
    ? { ...REPLAY_USAGE_METHODOLOGY }
    : { ...LEGACY_USAGE_METHODOLOGY };
}

export function validateCodexUsageStore(store) {
  if (!store || typeof store !== 'object' || Array.isArray(store) || store.version !== USAGE_STORE_VERSION) {
    throw new Error('codex_usage_state_invalid');
  }
  if (!Number.isInteger(store.revision) || store.revision < 0 || !isoTimestamp(store.initializedAt) || !isoTimestamp(store.updatedAt)) {
    throw new Error('codex_usage_state_invalid');
  }
  if (store.tickets === undefined) store.tickets = {};
  if (store.replay === undefined) {
    store.replay = { coverage: 'partial', sourceCount: 0, eventCount: 0, completedAt: null };
  }
  const cursors = store.cursors && typeof store.cursors === 'object' && !Array.isArray(store.cursors)
    ? Object.entries(store.cursors)
    : [];
  const days = store.days && typeof store.days === 'object' && !Array.isArray(store.days)
    ? Object.entries(store.days)
    : [];
  const tickets = store.tickets && typeof store.tickets === 'object' && !Array.isArray(store.tickets)
    ? Object.entries(store.tickets)
    : [];
  if (cursors.length > MAX_USAGE_CURSORS || days.length > USAGE_RETENTION_DAYS || tickets.length > MAX_USAGE_TICKETS || !validReplayState(store.replay)) {
    throw new Error('codex_usage_state_invalid');
  }
  for (const [sourceId, cursor] of cursors) {
    if (!/^[a-f0-9]{24}$/.test(sourceId) || !cursor || typeof cursor !== 'object' || Array.isArray(cursor)
      || !validSessionName(cursor.session) || !isoTimestamp(cursor.observedAt) || !validTokenUsage(cursor.tokens)
      || !validUsageSnapshot(cursor.usage ?? null)
      || (cursor.byteOffset !== undefined && (!Number.isSafeInteger(cursor.byteOffset) || cursor.byteOffset < 0))
      || (cursor.eventCount !== undefined && (!Number.isSafeInteger(cursor.eventCount) || cursor.eventCount < 0))) {
      throw new Error('codex_usage_state_invalid');
    }
  }
  for (const [date, day] of days) {
    const sessions = day?.agents && typeof day.agents === 'object' && !Array.isArray(day.agents)
      ? Object.entries(day.agents)
      : [];
    if (utcDate(`${date}T00:00:00.000Z`) !== date || !day || typeof day !== 'object' || Array.isArray(day)
      || !validTokenUsage(day.tokens) || sessions.length > MAX_SESSIONS_PER_DAY) {
      throw new Error('codex_usage_state_invalid');
    }
    let sessionTotal = zeroTokenUsage();
    for (const [session, tokens] of sessions) {
      if (!validSessionName(session) || !validTokenUsage(tokens)) throw new Error('codex_usage_state_invalid');
      sessionTotal = addTokenUsage(sessionTotal, tokens);
    }
    if (!sameTokenUsage(day.tokens, sessionTotal)) throw new Error('codex_usage_state_invalid');
  }
  for (const [ticketId, ticket] of tickets) {
    if (!/^prompt-[a-z0-9-]{8,64}$/.test(ticketId) || !validTicketUsage(ticket)) {
      throw new Error('codex_usage_state_invalid');
    }
  }
  return store;
}

function prunedUsageStore(store) {
  const retainedDays = Object.keys(store.days).sort().slice(-USAGE_RETENTION_DAYS);
  store.days = Object.fromEntries(retainedDays.map((date) => [date, store.days[date]]));
  const retainedCursors = Object.entries(store.cursors)
    .sort((left, right) => Date.parse(right[1].observedAt) - Date.parse(left[1].observedAt))
    .slice(0, MAX_USAGE_CURSORS);
  store.cursors = Object.fromEntries(retainedCursors);
  const retainedTickets = Object.entries(store.tickets || {})
    .sort((left, right) => Date.parse(right[1].endedAt || right[1].lastEventAt || right[1].sentAt) - Date.parse(left[1].endedAt || left[1].lastEventAt || left[1].sentAt))
    .slice(0, MAX_USAGE_TICKETS);
  store.tickets = Object.fromEntries(retainedTickets);
  return store;
}

export function reconcileCodexUsageStore(store, samples, at = new Date().toISOString()) {
  validateCodexUsageStore(store);
  if (store.replay.coverage === 'complete') return store;
  const updatedAt = isoTimestamp(at) || new Date().toISOString();
  let next = null;
  for (const sample of Array.isArray(samples) ? samples : []) {
    const sourceId = String(sample?.sourceId || '');
    const session = String(sample?.session || '');
    const observedAt = isoTimestamp(sample?.observedAt);
    if (!/^[a-f0-9]{24}$/.test(sourceId) || !validSessionName(session) || !observedAt) continue;
    const tokens = safeTokenUsage(sample.sessionTokens);
    const previous = (next || store).cursors[sourceId];
    if (previous && Date.parse(observedAt) <= Date.parse(previous.observedAt)) continue;
    if (!next) next = structuredClone(store);
    const delta = previous?.session === session ? subtractTokenUsage(tokens, previous.tokens) : zeroTokenUsage();
    const usage = usageSnapshot(sample.account, observedAt) || previous?.usage || null;
    next.cursors[sourceId] = { session, observedAt, tokens, usage };
    const date = utcDate(observedAt);
    if (usageHasTokens(delta)) {
      const day = next.days[date] || { tokens: zeroTokenUsage(), agents: {} };
      day.tokens = addTokenUsage(day.tokens, delta);
      day.agents[session] = addTokenUsage(day.agents[session] || zeroTokenUsage(), delta);
      next.days[date] = day;
    }
  }
  if (!next) return store;
  next.revision = store.revision + 1;
  next.updatedAt = updatedAt;
  return validateCodexUsageStore(prunedUsageStore(next));
}

function normalizedTicketWindows(values) {
  const windows = [];
  for (const value of Array.isArray(values) ? values : []) {
    const id = String(value?.id || '');
    const session = String(value?.session || '');
    const sentAt = isoTimestamp(value?.sentAt);
    const endedAt = value?.endedAt == null ? null : isoTimestamp(value.endedAt);
    const state = ['in_progress', 'complete', 'review', 'unverified'].includes(value?.state)
      ? value.state
      : 'unverified';
    if (!/^prompt-[a-z0-9-]{8,64}$/.test(id) || !validSessionName(session) || !sentAt || (value?.endedAt != null && !endedAt)) continue;
    if (endedAt && Date.parse(endedAt) < Date.parse(sentAt)) continue;
    windows.push({ id, session, sentAt, endedAt, state });
  }
  return windows.sort((left, right) => Date.parse(left.sentAt) - Date.parse(right.sentAt) || left.id.localeCompare(right.id));
}

function ticketUsageRow(window, existing = null) {
  return {
    session: window.session,
    sentAt: window.sentAt,
    endedAt: window.endedAt,
    state: window.state,
    tokens: existing?.tokens ? safeTokenUsage(existing.tokens) : zeroTokenUsage(),
    eventCount: Number.isSafeInteger(existing?.eventCount) ? existing.eventCount : 0,
    firstEventAt: isoTimestamp(existing?.firstEventAt) || null,
    lastEventAt: isoTimestamp(existing?.lastEventAt) || null,
    sourceIds: [...new Set(Array.isArray(existing?.sourceIds) ? existing.sourceIds.filter((sourceId) => /^[a-f0-9]{24}$/.test(sourceId)) : [])]
  };
}

function refreshTicketUsageRows(store, windows) {
  const nextTickets = { ...(store.tickets || {}) };
  for (const window of windows) nextTickets[window.id] = ticketUsageRow(window, nextTickets[window.id]);
  store.tickets = nextTickets;
}

function matchingTicketWindow(windows, session, observedAt) {
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return null;
  const matches = windows.filter((window) => (
    window.session === session
    && observedMs >= Date.parse(window.sentAt)
    && (window.endedAt === null || observedMs <= Date.parse(window.endedAt))
  ));
  return matches.length === 1 ? matches[0] : null;
}

function addUsageEvent(store, windows, sourceId, session, event, delta) {
  if (!usageHasTokens(delta)) return;
  const date = utcDate(event.observedAt);
  if (!date) return;
  const day = store.days[date] || { tokens: zeroTokenUsage(), agents: {} };
  day.tokens = addTokenUsage(day.tokens, delta);
  day.agents[session] = addTokenUsage(day.agents[session] || zeroTokenUsage(), delta);
  store.days[date] = day;

  const window = matchingTicketWindow(windows, session, event.observedAt);
  if (!window) return;
  const ticket = store.tickets[window.id] || ticketUsageRow(window);
  ticket.tokens = addTokenUsage(ticket.tokens, delta);
  ticket.eventCount += 1;
  ticket.firstEventAt = ticket.firstEventAt || event.observedAt;
  ticket.lastEventAt = event.observedAt;
  if (!ticket.sourceIds.includes(sourceId)) ticket.sourceIds.push(sourceId);
  store.tickets[window.id] = ticket;
}

function replayBatchIntoStore(store, batch, windows, { rebuild = false } = {}) {
  const sourceId = String(batch?.sourceId || '');
  const session = String(batch?.session || '');
  if (!/^[a-f0-9]{24}$/.test(sourceId) || !validSessionName(session) || !Number.isSafeInteger(batch?.nextOffset) || batch.nextOffset < 0) {
    return { changed: false, eventCount: 0 };
  }
  const previousCursor = rebuild ? null : store.cursors[sourceId];
  if (!rebuild && previousCursor && batch.startOffset !== undefined && batch.startOffset !== previousCursor.byteOffset) {
    return { changed: false, eventCount: 0 };
  }
  let previousTokens = previousCursor?.tokens ? safeTokenUsage(previousCursor.tokens) : zeroTokenUsage();
  let observedAt = previousCursor?.observedAt || store.initializedAt;
  let usage = previousCursor?.usage || null;
  let eventCount = previousCursor?.eventCount || 0;
  let changed = !previousCursor || batch.nextOffset !== previousCursor.byteOffset;
  for (const event of Array.isArray(batch.events) ? batch.events : []) {
    if (!event?.observedAt || !validTokenUsage(event.sessionTokens)) continue;
    const delta = subtractTokenUsage(event.sessionTokens, previousTokens);
    previousTokens = event.sessionTokens;
    observedAt = event.observedAt;
    usage = usageSnapshot(event.account, event.observedAt) || usage;
    eventCount += 1;
    changed = true;
    if (Date.parse(event.observedAt) >= Date.parse(store.initializedAt)) {
      addUsageEvent(store, windows, sourceId, session, event, delta);
    }
  }
  if (!changed) return { changed: false, eventCount: 0 };
  store.cursors[sourceId] = {
    session,
    observedAt,
    tokens: previousTokens,
    usage,
    byteOffset: batch.nextOffset,
    eventCount
  };
  return { changed: true, eventCount: Math.max(0, eventCount - (previousCursor?.eventCount || 0)) };
}

export function rebuildCodexUsageStoreFromEvents(store, batches, ticketWindows = [], at = new Date().toISOString()) {
  validateCodexUsageStore(store);
  const updatedAt = isoTimestamp(at) || new Date().toISOString();
  const windows = normalizedTicketWindows(ticketWindows);
  const next = createCodexUsageStore(store.initializedAt);
  next.revision = store.revision + 1;
  next.updatedAt = updatedAt;
  refreshTicketUsageRows(next, windows);
  let sourceCount = 0;
  let eventCount = 0;
  for (const batch of Array.isArray(batches) ? batches : []) {
    const result = replayBatchIntoStore(next, batch, windows, { rebuild: true });
    if (!result.changed) continue;
    sourceCount += 1;
    eventCount += result.eventCount;
  }
  next.replay = { coverage: 'complete', sourceCount, eventCount, completedAt: updatedAt };
  return validateCodexUsageStore(prunedUsageStore(next));
}

export function reconcileCodexUsageEventBatches(store, batches, ticketWindows = [], at = new Date().toISOString()) {
  validateCodexUsageStore(store);
  if (store.replay.coverage !== 'complete') throw new Error('codex_usage_replay_required');
  const updatedAt = isoTimestamp(at) || new Date().toISOString();
  const windows = normalizedTicketWindows(ticketWindows);
  const next = structuredClone(store);
  refreshTicketUsageRows(next, windows);
  let changed = JSON.stringify(next.tickets) !== JSON.stringify(store.tickets);
  let addedEvents = 0;
  for (const batch of Array.isArray(batches) ? batches : []) {
    const result = replayBatchIntoStore(next, batch, windows);
    changed ||= result.changed;
    addedEvents += result.eventCount;
  }
  if (!changed) return store;
  next.revision = store.revision + 1;
  next.updatedAt = updatedAt;
  next.replay.sourceCount = Object.keys(next.cursors).length;
  next.replay.eventCount += addedEvents;
  return validateCodexUsageStore(prunedUsageStore(next));
}

function recentUsageDates(initializedAt, at, maximum = USAGE_STATS_DAYS) {
  const first = Date.parse(`${utcDate(initializedAt)}T00:00:00.000Z`);
  const end = Date.parse(`${utcDate(at)}T00:00:00.000Z`);
  if (!Number.isFinite(first) || !Number.isFinite(end)) return [];
  const count = Math.min(maximum, Math.max(1, Math.floor((end - first) / 86_400_000) + 1));
  return Array.from({ length: count }, (_, index) => new Date(end - index * 86_400_000).toISOString().slice(0, 10));
}

export function codexUsageStats(store, at = new Date().toISOString()) {
  validateCodexUsageStore(store);
  const timestamp = isoTimestamp(at) || new Date().toISOString();
  const dates = recentUsageDates(store.initializedAt, timestamp);
  const sessionTotals = new Map();
  const days = dates.map((date) => {
    const stored = store.days[date] || { tokens: zeroTokenUsage(), agents: {} };
    const agents = Object.entries(stored.agents)
      .map(([session, tokens]) => ({ session, tokens }))
      .sort((left, right) => right.tokens.totalTokens - left.tokens.totalTokens || left.session.localeCompare(right.session));
    for (const agent of agents) {
      sessionTotals.set(agent.session, addTokenUsage(sessionTotals.get(agent.session) || zeroTokenUsage(), agent.tokens));
    }
    return { date, tokens: stored.tokens, agentCount: agents.length, agents };
  });
  for (const cursor of Object.values(store.cursors)) {
    if (!sessionTotals.has(cursor.session)) sessionTotals.set(cursor.session, zeroTokenUsage());
  }
  const latestCursorBySession = new Map();
  const rolloutCountBySession = new Map();
  for (const cursor of Object.values(store.cursors)) {
    rolloutCountBySession.set(cursor.session, (rolloutCountBySession.get(cursor.session) || 0) + 1);
    const previous = latestCursorBySession.get(cursor.session);
    if (!previous || Date.parse(cursor.observedAt) > Date.parse(previous.observedAt)) latestCursorBySession.set(cursor.session, cursor);
  }
  const agents = [...sessionTotals.entries()].map(([session, tokens]) => {
    const cursor = latestCursorBySession.get(session);
    return {
      session,
      tokens,
      todayTokens: days[0]?.agents.find((agent) => agent.session === session)?.tokens || zeroTokenUsage(),
      lastObservedAt: cursor?.observedAt || null,
      rolloutCount: rolloutCountBySession.get(session) || 0
    };
  }).sort((left, right) => right.tokens.totalTokens - left.tokens.totalTokens || left.session.localeCompare(right.session));
  const tickets = Object.entries(store.tickets || {})
    .map(([id, ticket]) => ({ id, ...ticket }))
    .sort((left, right) => Date.parse(right.endedAt || right.lastEventAt || right.sentAt) - Date.parse(left.endedAt || left.lastEventAt || left.sentAt));
  const ticketTokens = tickets.reduce((total, ticket) => addTokenUsage(total, ticket.tokens), zeroTokenUsage());
  const trackedTokens = days.reduce((total, day) => addTokenUsage(total, day.tokens), zeroTokenUsage());
  return {
    methodology: usageMethodology(store),
    trackingStartedAt: store.initializedAt,
    updatedAt: store.updatedAt,
    retentionDays: USAGE_RETENTION_DAYS,
    periodDays: dates.length,
    tokens: trackedTokens,
    ticketTokens,
    today: days[0] || { date: utcDate(timestamp), tokens: zeroTokenUsage(), agentCount: 0, agents: [] },
    days,
    agents,
    tickets
  };
}
