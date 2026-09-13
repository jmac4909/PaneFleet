import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Writable } from 'node:stream';

import { buildSnapshotEventUpdate, writeSnapshotEvent } from '../snapshot-events.js';

test('the first live snapshot is complete and sequenced', () => {
  const snapshot = { host: { time: 'first' }, promptQueue: { items: [{ id: 'one' }] } };
  const update = buildSnapshotEventUpdate(snapshot);

  assert.equal(update.state.sequence, 1);
  assert.equal(update.broadcastEvent, 'snapshot');
  assert.deepEqual(JSON.parse(update.fullPayload), snapshot);
  assert.equal(update.broadcastPayload, update.fullPayload);
});

test('recurring updates carry only changed and removed top-level domains', () => {
  const first = buildSnapshotEventUpdate({
    host: { time: 'first' },
    promptQueue: { items: Array.from({ length: 20 }, (_, index) => ({ id: `item-${index}`, status: 'sent' })) },
    security: { recent: ['stable'] }
  });
  const secondSnapshot = {
    host: { time: 'second' },
    promptQueue: JSON.parse(first.fullPayload).promptQueue,
    agents: [{ session: 'codex' }]
  };
  const second = buildSnapshotEventUpdate(secondSnapshot, first.state);
  const patch = JSON.parse(second.broadcastPayload);

  assert.equal(second.state.sequence, 2);
  assert.equal(second.broadcastEvent, 'snapshot-patch');
  assert.deepEqual(patch, {
    baseSequence: 1,
    sequence: 2,
    changes: {
      host: { time: 'second' },
      agents: [{ session: 'codex' }]
    },
    removed: ['security']
  });
  assert.deepEqual(JSON.parse(second.fullPayload), secondSnapshot);
});

test('a patch never replaces a smaller complete snapshot', () => {
  const first = buildSnapshotEventUpdate({ value: 1 });
  const second = buildSnapshotEventUpdate({ value: 2 }, first.state);

  assert.equal(second.broadcastEvent, 'snapshot');
  assert.equal(second.broadcastPayload, second.fullPayload);
});

test('full and patch payloads share one serialization of each changed domain', () => {
  const stable = 'x'.repeat(4096);
  const domain = 'quoted"\n界';
  const first = buildSnapshotEventUpdate({ stable, [domain]: { tick: 0 } });
  let serializations = 0;
  const host = { toJSON() { return { tick: ++serializations, label: 'quote: " and newline: \n' }; } };
  const next = buildSnapshotEventUpdate({ stable, [domain]: host }, first.state);
  assert.equal(next.broadcastEvent, 'snapshot-patch');
  assert.equal(serializations, 1, 'changed domains must not be serialized again for the patch');
  assert.deepEqual(JSON.parse(next.broadcastPayload).changes[domain], JSON.parse(next.fullPayload)[domain]);
  assert.equal(next.state.fields.get(domain), JSON.stringify(JSON.parse(next.fullPayload)[domain]));
});

test('snapshot event state rejects invalid values and unsafe keys', () => {
  assert.throws(() => buildSnapshotEventUpdate(null), /snapshot_event_value_invalid/);
  assert.throws(() => buildSnapshotEventUpdate([]), /snapshot_event_value_invalid/);
  const unsafe = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => buildSnapshotEventUpdate(unsafe), /snapshot_event_key_invalid/);
});

test('undefined fields are omitted and the sequence rolls over safely', () => {
  const first = buildSnapshotEventUpdate({ stable: 'x'.repeat(200), omitted: undefined, tick: 1 });
  first.state.sequence = Number.MAX_SAFE_INTEGER;
  const second = buildSnapshotEventUpdate({ stable: 'x'.repeat(200), tick: 2 }, first.state);
  const patch = JSON.parse(second.broadcastPayload);

  assert.equal(first.state.fields.has('omitted'), false);
  assert.equal(second.broadcastEvent, 'snapshot-patch');
  assert.equal(second.state.sequence, 1);
  assert.equal(patch.baseSequence, Number.MAX_SAFE_INTEGER);
  assert.equal(patch.sequence, 1);
});

test('event writes preserve framing, deduplicate shared updates per client, and allow sequence rollover', () => {
  const frames = [];
  const client = new Writable({ write(chunk, encoding, callback) { frames.push(chunk.toString()); callback(); } });
  try {
    assert.equal(writeSnapshotEvent(client, 'snapshot', '{"tick":1}', Number.MAX_SAFE_INTEGER), true);
    assert.equal(writeSnapshotEvent(client, 'snapshot-patch', '{"duplicate":true}', Number.MAX_SAFE_INTEGER), true);
    assert.equal(writeSnapshotEvent(client, 'snapshot-patch', '{"tick":2}', 1), true);
    assert.equal(writeSnapshotEvent(client, 'error', '{"error":"synthetic"}'), true);
    assert.deepEqual(frames, [
      `id: ${Number.MAX_SAFE_INTEGER}\nevent: snapshot\ndata: {"tick":1}\n\n`,
      'id: 1\nevent: snapshot-patch\ndata: {"tick":2}\n\n',
      'event: error\ndata: {"error":"synthetic"}\n\n'
    ]);
    for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      writeSnapshotEvent(client, 'error', '{}', sequence);
      assert.equal(frames.at(-1), 'event: error\ndata: {}\n\n');
    }
  } finally {
    client.destroy();
  }
});

test('a stalled client cannot accumulate repeated frames or disrupt a healthy client', () => {
  const payload = JSON.stringify({ synthetic: 'x'.repeat(64 * 1024) });
  const stalled = new Writable({ highWaterMark: 1024, write() {} });
  let healthyFrames = 0;
  const healthy = new Writable({ write(chunk, encoding, callback) { healthyFrames++; callback(); } });
  try {
    assert.equal(writeSnapshotEvent(stalled, 'snapshot', payload, 1), true);
    const initialBytes = stalled.writableLength;
    assert.equal(stalled.writableNeedDrain, true);
    assert.equal(stalled.destroyed, false, 'a large initial frame gets a chance to drain');
    writeSnapshotEvent(stalled, 'snapshot-patch', '{}', 1);
    assert.equal(stalled.destroyed, false, 'a shared duplicate must not abort the initial frame');
    for (let sequence = 2; sequence <= 32; sequence++) {
      assert.equal(writeSnapshotEvent(stalled, 'snapshot', payload, sequence), false);
      assert.equal(writeSnapshotEvent(healthy, 'snapshot-patch', '{}', sequence), true);
    }
    assert.equal(stalled.destroyed, true);
    assert.ok(stalled.writableLength <= initialBytes, 'buffered output must not grow behind backpressure');
    assert.equal(healthyFrames, 31);
    assert.equal(healthy.destroyed, false);
  } finally {
    stalled.destroy();
    healthy.destroy();
  }
});

test('a client that drains a large frame continues receiving updates', async () => {
  let release;
  const client = new Writable({
    highWaterMark: 1024,
    write(chunk, encoding, callback) { release = callback; }
  });
  try {
    writeSnapshotEvent(client, 'snapshot', JSON.stringify({ synthetic: 'x'.repeat(4096) }), 1);
    assert.equal(client.writableNeedDrain, true);
    const drained = once(client, 'drain');
    release();
    await drained;
    assert.equal(writeSnapshotEvent(client, 'snapshot-patch', '{}', 2), true);
    assert.equal(client.destroyed, false);
    release();
  } finally {
    client.destroy();
  }
});

test('ended, destroyed, and failed event streams cannot retain future updates', () => {
  const ended = new Writable({ write(chunk, encoding, callback) { callback(); } });
  ended.end();
  assert.equal(writeSnapshotEvent(ended, 'snapshot', '{}', 1), false);
  const failed = new Writable({ write(chunk, encoding, callback) { callback(); } });
  failed.write = () => { throw new Error('synthetic write failure'); };
  assert.equal(writeSnapshotEvent(failed, 'snapshot', '{}', 1), false);
  assert.equal(failed.destroyed, true);
  assert.equal(writeSnapshotEvent(failed, 'snapshot', '{}', 2), false);
});
