import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filesystemUsage, hostResourceWarnings, parseLinuxMemoryMetrics } from '../host-metrics.js';

test('Linux memory metrics use available memory and retain swap capacity', () => {
  assert.deepEqual(parseLinuxMemoryMetrics([
    'MemTotal:        2000000 kB',
    'MemFree:          400000 kB',
    'MemAvailable:    1000000 kB',
    'SwapTotal:       4194300 kB',
    'SwapFree:        3000000 kB'
  ].join('\n')), {
    totalMem: 2048000000,
    availableMem: 1024000000,
    swapTotal: 4294963200,
    swapFree: 3072000000
  });
  assert.deepEqual(parseLinuxMemoryMetrics('MemFree: 12 kB\nmalformed'), {
    totalMem: null,
    availableMem: null,
    swapTotal: null,
    swapFree: null
  });
});

test('filesystem metrics follow allocatable disk usage and reject malformed stats', () => {
  assert.deepEqual(filesystemUsage({ bsize: 1024, blocks: 100, bfree: 25, bavail: 20 }), {
    totalBytes: 102400,
    usedBytes: 76800,
    availableBytes: 20480,
    usedPercent: 79
  });
  assert.deepEqual(filesystemUsage({ bsize: 1024, blocks: 0, bfree: 0, bavail: 0 }), {
    totalBytes: 0,
    usedBytes: 0,
    availableBytes: 0,
    usedPercent: 0
  });
  assert.equal(filesystemUsage(null), null);
  assert.equal(filesystemUsage({ bsize: 0, blocks: 1, bfree: 0, bavail: 0 }), null);
  assert.equal(filesystemUsage({ bsize: 1, blocks: 'invalid', bfree: 0, bavail: 0 }), null);
});

test('host resource warnings distinguish low and critical root-disk pressure', () => {
  assert.deepEqual(hostResourceWarnings({ rootFs: { usedPercent: 89, availableBytes: 12 } }), []);
  assert.deepEqual(hostResourceWarnings({}), []);
  const low = hostResourceWarnings({ rootFs: { usedPercent: 90, availableBytes: 2 * (1024 ** 3) } });
  assert.equal(low[0].title, 'Root disk space is low');
  assert.equal(low[0].tone, 'warn');
  assert.match(low[0].detail, /2\.0 GiB available/);
  const critical = hostResourceWarnings({ rootFs: { usedPercent: 98, availableBytes: 1.5 * (1024 ** 3) } });
  assert.equal(critical[0].title, 'Root disk is critically full');
  assert.equal(critical[0].tone, 'bad');
  assert.equal(critical[0].requiresDecision, true);
});

test('host resource warnings enforce the scheduled-cycle available-memory boundary', () => {
  const gibibyte = 1024 ** 3;
  assert.deepEqual(hostResourceWarnings({ totalMem: 2 * gibibyte, availableMem: 0.7 * gibibyte }), []);
  assert.deepEqual(hostResourceWarnings({ totalMem: 0, availableMem: 0 }), []);
  assert.deepEqual(hostResourceWarnings({ totalMem: 2 * gibibyte, availableMem: -1 }), []);

  const low = hostResourceWarnings({ totalMem: 2 * gibibyte, availableMem: 0.69 * gibibyte });
  assert.equal(low.length, 1);
  assert.equal(low[0].id, 'attention:host:memory');
  assert.equal(low[0].title, 'Host memory is low');
  assert.equal(low[0].status, 'memory-pressure');
  assert.equal(low[0].tone, 'warn');
  assert.equal(low[0].requiresDecision, true);
  assert.match(low[0].detail, /^34% available \(707 MiB of 2048 MiB\)\./);

  const critical = hostResourceWarnings({ totalMem: 2 * gibibyte, availableMem: 0.39 * gibibyte });
  assert.equal(critical.length, 1);
  assert.equal(critical[0].title, 'Host memory is critically low');
  assert.equal(critical[0].tone, 'bad');
  assert.match(critical[0].detail, /^19% available/);
});
