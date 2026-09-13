function kilobyteMetrics(value) {
  const metrics = new Map();
  for (const line of String(value || '').split('\n')) {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB\s*$/);
    if (match) metrics.set(match[1], Number(match[2]) * 1024);
  }
  return metrics;
}

export function parseLinuxMemoryMetrics(value) {
  const metrics = kilobyteMetrics(value);
  return {
    totalMem: metrics.get('MemTotal') ?? null,
    availableMem: metrics.get('MemAvailable') ?? null,
    swapTotal: metrics.get('SwapTotal') ?? null,
    swapFree: metrics.get('SwapFree') ?? null
  };
}

export function filesystemUsage(stats) {
  if (!stats) return null;
  const blockSize = Number(stats.bsize);
  const blocks = Number(stats.blocks);
  const freeBlocks = Number(stats.bfree);
  const availableBlocks = Number(stats.bavail);
  if (![blockSize, blocks, freeBlocks, availableBlocks].every(Number.isFinite)) return null;
  if (blockSize <= 0 || blocks < 0 || freeBlocks < 0 || availableBlocks < 0) return null;

  const totalBytes = blocks * blockSize;
  const availableBytes = Math.min(totalBytes, availableBlocks * blockSize);
  const usedBytes = Math.min(totalBytes, Math.max(0, (blocks - freeBlocks) * blockSize));
  const allocatableBytes = usedBytes + availableBytes;
  return {
    totalBytes,
    usedBytes,
    availableBytes,
    usedPercent: allocatableBytes ? Math.round((usedBytes / allocatableBytes) * 100) : 0
  };
}

export function hostResourceWarnings(host = {}) {
  const warnings = [];
  const totalMem = Number(host.totalMem);
  const availableMem = Number(host.availableMem);
  if (
    Number.isFinite(totalMem) &&
    totalMem > 0 &&
    Number.isFinite(availableMem) &&
    availableMem >= 0
  ) {
    const boundedAvailableMem = Math.min(totalMem, availableMem);
    const availableRatio = boundedAvailableMem / totalMem;
    if (availableRatio < 0.35) {
      const critical = availableRatio < 0.20;
      const availableMiB = boundedAvailableMem / (1024 ** 2);
      const totalMiB = totalMem / (1024 ** 2);
      warnings.push({
        id: 'attention:host:memory',
        dedupeKey: 'host:memory',
        kind: 'host',
        title: critical ? 'Host memory is critically low' : 'Host memory is low',
        detail: `${Math.floor(availableRatio * 100)}% available (${availableMiB.toFixed(0)} MiB of ${totalMiB.toFixed(0)} MiB). Defer resource-heavy tests and browser jobs until memory recovers.`,
        status: 'memory-pressure',
        tone: critical ? 'bad' : 'warn',
        requiresDecision: true
      });
    }
  }

  const diskPercent = Number(host?.rootFs?.usedPercent);
  if (Number.isFinite(diskPercent) && diskPercent >= 90) {
    const availableGiB = Number(host.rootFs.availableBytes) / (1024 ** 3);
    warnings.push({
      id: 'attention:host:root-disk',
      dedupeKey: 'host:root-disk',
      kind: 'host',
      title: diskPercent >= 95 ? 'Root disk is critically full' : 'Root disk space is low',
      detail: `${diskPercent}% used with ${availableGiB.toFixed(1)} GiB available. Review regenerable caches and retained artifacts before writes begin failing.`,
      status: 'disk-pressure',
      tone: diskPercent >= 95 ? 'bad' : 'warn',
      requiresDecision: true
    });
  }
  return warnings;
}
