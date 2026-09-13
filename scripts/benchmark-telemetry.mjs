// Synthetic inputs only; never reads a live rollout or starts a service.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { readCodexUsageEventBatch } from '../codex-telemetry.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-telemetry-bench-'));
const file = path.join(directory, 'synthetic.jsonl');
const usage = JSON.stringify({
  timestamp: '2026-01-01T00:00:00Z',
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 2 } } }
});
try {
  for (const imageMiB of [1, 4, 8]) {
    const line = JSON.stringify({ type: 'response_item', payload: { image: 'x'.repeat(imageMiB * 1024 * 1024) } });
    await writeFile(file, `${line}\n${usage}\n`);
    const concat = Buffer.concat;
    let copiedBytes = 0;
    Buffer.concat = function (buffers, length) {
      copiedBytes += length ?? buffers.reduce((sum, buffer) => sum + buffer.length, 0);
      return concat(buffers, length);
    };
    const started = performance.now();
    let batch;
    try {
      batch = await readCodexUsageEventBatch(file);
    } finally {
      Buffer.concat = concat;
    }
    const elapsedMs = performance.now() - started;
    assert.equal(batch.events.length, 1);
    assert.equal(batch.events[0].sessionTokens.totalTokens, 12);
    assert.equal(batch.nextOffset, batch.fileSize);
    console.log(JSON.stringify({ imageMiB, elapsedMs: Math.round(elapsedMs), copiedMiB: +(copiedBytes / 1024 ** 2).toFixed(2) }));
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
