const FORBIDDEN_SNAPSHOT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const sentSnapshotSequences = new WeakMap();

function snapshotFields(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('snapshot_event_value_invalid');
  }
  const fields = new Map();
  for (const [key, value] of Object.entries(snapshot)) {
    if (FORBIDDEN_SNAPSHOT_KEYS.has(key)) throw new TypeError('snapshot_event_key_invalid');
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) fields.set(key, serialized);
  }
  return fields;
}

function nextSequence(previous) {
  const current = Number(previous?.sequence);
  if (!Number.isSafeInteger(current) || current < 1) return 1;
  return current === Number.MAX_SAFE_INTEGER ? 1 : current + 1;
}

export function buildSnapshotEventUpdate(snapshot, previous = null) {
  const fields = snapshotFields(snapshot);
  const sequence = nextSequence(previous);
  const fullPayload = `{${[...fields]
    .map(([key, serialized]) => `${JSON.stringify(key)}:${serialized}`)
    .join(',')}}`;
  let broadcastEvent = 'snapshot';
  let broadcastPayload = fullPayload;

  if (previous?.fields instanceof Map && Number.isSafeInteger(previous.sequence) && previous.sequence > 0) {
    const changes = [];
    const removed = [];
    for (const [key, serialized] of fields) {
      if (previous.fields.get(key) !== serialized) changes.push(`${JSON.stringify(key)}:${serialized}`);
    }
    for (const key of previous.fields.keys()) {
      if (!fields.has(key)) removed.push(key);
    }
    // Reuse the domain JSON already used for diffing and the full snapshot.
    const patchPayload = `{"baseSequence":${previous.sequence},"sequence":${sequence},"changes":{${changes.join(',')}},"removed":${JSON.stringify(removed)}}`;
    if (Buffer.byteLength(patchPayload) < Buffer.byteLength(fullPayload)) {
      broadcastEvent = 'snapshot-patch';
      broadcastPayload = patchPayload;
    }
  }

  return {
    state: { sequence, fields },
    fullPayload,
    broadcastEvent,
    broadcastPayload
  };
}

export function writeSnapshotEvent(res, event, payload, sequence = null) {
  if (res.destroyed || res.writableEnded) return false;
  const sequenced = Number.isSafeInteger(sequence) && sequence > 0;
  // An initial snapshot and an in-flight broadcast can share the same update.
  if (sequenced && sentSnapshotSequences.get(res) === sequence) return true;
  // Allow a large frame to drain, but never queue another update behind it.
  // A stalled browser reconnects for a full snapshot; no terminal input occurs.
  if (res.writableNeedDrain) {
    res.destroy();
    return false;
  }
  try {
    const id = sequenced ? `id: ${sequence}\n` : '';
    res.write(`${id}event: ${event}\ndata: ${payload}\n\n`);
    if (sequenced) sentSnapshotSequences.set(res, sequence);
    return true;
  } catch {
    res.destroy();
    return false;
  }
}
