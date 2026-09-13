import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { scanCodeCityWorkspace, validateCodeCitySnapshot } from '../code-city.js';

async function temporaryWorkspace(testContext, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  testContext.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return root;
}

test('Code City scans structural metadata without source content or absolute paths', async (testContext) => {
  const root = await temporaryWorkspace(testContext, 'panefleet-code-city-');
  await mkdir(path.join(root, 'src', 'feature'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'src', 'app.js'), "import './feature/view';\nPRIVATE_SOURCE_SENTINEL\n");
  await writeFile(path.join(root, 'src', 'feature', 'view.tsx'), "fetch('/api/weather');\nPRIVATE_COMPONENT_SENTINEL\n");
  await writeFile(path.join(root, 'server.js'), "route('/api/weather');\nPRIVATE_SERVER_SENTINEL\n");
  await writeFile(path.join(root, 'test', 'app.test.js'), "import '../src/app.js';\nPRIVATE_TEST_SENTINEL\n");
  await writeFile(path.join(root, '.env'), 'SECRET_TOKEN=private\n');
  await mkdir(path.join(root, 'node_modules', 'private-package'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', 'private-package', 'index.js'), 'PRIVATE_DEPENDENCY\n');

  const city = await scanCodeCityWorkspace(root, { rootName: 'Fixture City', at: '2026-08-19T00:00:00.000Z' });
  assert.equal(city.rootName, 'Fixture City');
  assert.deepEqual(city.files.map((file) => file.path).sort(), ['server.js', 'src/app.js', 'src/feature/view.tsx', 'test/app.test.js']);
  assert.deepEqual(Object.fromEntries(city.files.map((file) => [file.path, file.role])), {
    'server.js': 'backend',
    'src/app.js': 'shared',
    'src/feature/view.tsx': 'ui',
    'test/app.test.js': 'test'
  });
  assert.match(city.files.find((file) => file.path === 'test/app.test.js').purpose, /test/i);
  assert.equal(city.files.find((file) => file.path === 'server.js').analysis.semanticRole, 'entrypoint');
  assert.ok(city.files.find((file) => file.path === 'server.js').analysis.signals.includes('http-route'));
  assert.equal(city.files.find((file) => file.path === 'src/feature/view.tsx').analysis.semanticRole, 'interface');
  assert.equal(city.files.find((file) => file.path === 'test/app.test.js').analysis.semanticRole, 'verification');
  assert.equal(city.summary.semanticRoleCounts.entrypoint, 1);
  assert.equal(city.summary.signalCounts.verification, 1);
  assert.deepEqual(city.summary.flowCounts, { api: 1, import: 1, test: 1 });
  assert.equal(city.summary.connectionCount, 3);
  const fileById = new Map(city.files.map((file) => [file.id, file.path]));
  assert.deepEqual(city.connections.map((connection) => ({
    from: fileById.get(connection.fromId),
    to: fileById.get(connection.toId),
    kind: connection.kind
  })).sort((left, right) => left.kind.localeCompare(right.kind)), [
    { from: 'src/feature/view.tsx', to: 'server.js', kind: 'api' },
    { from: 'src/app.js', to: 'src/feature/view.tsx', kind: 'import' },
    { from: 'test/app.test.js', to: 'src/app.js', kind: 'test' }
  ]);
  assert.deepEqual(city.privacy, {
    sourceAnalyzedLocally: true,
    sourceContentIncluded: false,
    absolutePathsIncluded: false,
    externalRequestsRequired: false
  });
  const encoded = JSON.stringify(city);
  assert.doesNotMatch(encoded, /PRIVATE_|SECRET_TOKEN|\/api\/weather/);
  assert.doesNotMatch(encoded, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(validateCodeCitySnapshot(city), city);
});

test('Code City rejects sensitive files, symlinks, and bounded overflow', async (testContext) => {
  const root = await temporaryWorkspace(testContext, 'panefleet-code-city-bounds-');
  const outside = await temporaryWorkspace(testContext, 'panefleet-code-city-outside-');
  await writeFile(path.join(root, 'safe.js'), 'safe\n');
  await writeFile(path.join(root, 'private.pem'), 'private\n');
  await writeFile(path.join(root, 'database.sqlite'), 'private\n');
  await writeFile(path.join(outside, 'outside.js'), 'outside\n');
  await symlink(outside, path.join(root, 'linked'));
  await writeFile(path.join(root, 'extra.ts'), 'extra\n');

  const city = await scanCodeCityWorkspace(root, {
    at: '2026-08-19T00:00:00.000Z',
    limits: { maxFiles: 1 }
  });
  assert.equal(city.files.length, 1);
  assert.equal(city.summary.truncated, true);
  assert.doesNotMatch(JSON.stringify(city), /private\.pem|database\.sqlite|outside\.js|linked/);
});

test('Code City resolves local workspace-package imports into directional app flow', async (testContext) => {
  const root = await temporaryWorkspace(testContext, 'panefleet-code-city-package-');
  await mkdir(path.join(root, 'apps', 'web'), { recursive: true });
  await mkdir(path.join(root, 'packages', 'shared', 'src'), { recursive: true });
  await mkdir(path.join(root, 'packages', 'shared', 'src', 'tools', 'widget'), { recursive: true });
  await mkdir(path.join(root, 'packages', 'broken'), { recursive: true });
  await writeFile(path.join(root, 'apps', 'web', 'view.tsx'), [
    "import { model } from '@fixture/shared';",
    "import { widget } from '@fixture/shared/tools/widget';",
    'void model;',
    'void widget;'
  ].join('\n'));
  await writeFile(path.join(root, 'packages', 'shared', 'package.json'), JSON.stringify({ name: '@fixture/shared' }));
  await writeFile(path.join(root, 'packages', 'shared', 'src', 'index.ts'), 'export const model = true;\n');
  await writeFile(path.join(root, 'packages', 'shared', 'src', 'tools', 'widget', 'index.ts'), 'export const widget = true;\n');
  await writeFile(path.join(root, 'packages', 'broken', 'package.json'), '{ malformed fixture manifest\n');

  const city = await scanCodeCityWorkspace(root, { at: '2026-08-19T00:00:00.000Z' });
  const fileById = new Map(city.files.map((file) => [file.id, file]));
  const relationships = city.connections
    .filter((connection) => connection.kind === 'import')
    .map((connection) => [fileById.get(connection.fromId).path, fileById.get(connection.toId).path])
    .sort((left, right) => left[1].localeCompare(right[1]));
  assert.deepEqual(relationships, [
    ['apps/web/view.tsx', 'packages/shared/src/index.ts'],
    ['apps/web/view.tsx', 'packages/shared/src/tools/widget/index.ts']
  ]);
  assert.doesNotMatch(JSON.stringify(city), /@fixture\/shared/);
});

test('Code City resolves local Python imports and test relationships', async (testContext) => {
  const root = await temporaryWorkspace(testContext, 'panefleet-code-city-python-');
  await mkdir(path.join(root, 'package'));
  await writeFile(path.join(root, 'pipeline.py'), 'import helpers\nfrom package.model import load\ndef run(): return load()\n');
  await writeFile(path.join(root, 'helpers.py'), 'VALUE = 1\n');
  await writeFile(path.join(root, 'package', '__init__.py'), 'from .model import load\n');
  await writeFile(path.join(root, 'package', 'model.py'), 'def load(): return 1\n');
  await writeFile(path.join(root, 'test_pipeline.py'), 'from pipeline import run\ndef test_run(): assert run() == 1\n');
  await writeFile(path.join(root, 'market_source_fetch.py'), 'def fetch(): return []\nif __name__ == "__main__": fetch()\n');
  await writeFile(path.join(root, 'momentum_alpha.py'), 'def score(): return 1\nif __name__ == "__main__": score()\n');
  await writeFile(path.join(root, 'result_finalizer.py'), 'def finish(): return True\nif __name__ == "__main__": finish()\n');

  const city = await scanCodeCityWorkspace(root, { at: '2026-08-19T00:00:00.000Z' });
  const fileById = new Map(city.files.map((file) => [file.id, file.path]));
  const relationships = city.connections.map((connection) => ({
    from: fileById.get(connection.fromId),
    to: fileById.get(connection.toId),
    kind: connection.kind
  }));
  assert.ok(relationships.some((relationship) => relationship.from === 'pipeline.py' && relationship.to === 'helpers.py' && relationship.kind === 'import'));
  assert.ok(relationships.some((relationship) => relationship.from === 'pipeline.py' && relationship.to === 'package/model.py' && relationship.kind === 'import'));
  assert.ok(relationships.some((relationship) => relationship.from === 'test_pipeline.py' && relationship.to === 'pipeline.py' && relationship.kind === 'test'));
  const byPath = new Map(city.files.map((file) => [file.path, file]));
  assert.equal(byPath.get('market_source_fetch.py').analysis.semanticRole, 'ingestion');
  assert.equal(byPath.get('momentum_alpha.py').analysis.semanticRole, 'analysis');
  assert.equal(byPath.get('result_finalizer.py').analysis.semanticRole, 'decision');
  assert.equal(byPath.get('market_source_fetch.py').analysis.entrypoint, true);
  assert.ok(city.summary.signalCounts.entrypoint >= 3);
});

test('Code City finds late API routes and source-reading UI tests without exposing source', async (testContext) => {
  const root = await temporaryWorkspace(testContext, 'panefleet-code-city-large-flow-');
  await mkdir(path.join(root, 'public'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'public', 'app.js'), "fetch('/api/late-route');\nPRIVATE_UI_SOURCE\n");
  await writeFile(path.join(root, 'server.js'), `${'// bounded filler\n'.repeat(12_000)}route('/api/late-route');\nPRIVATE_LATE_ROUTE\n`);
  await writeFile(path.join(root, 'test', 'ui-shell.test.js'), "const source = uiSource('app.js');\nPRIVATE_STATIC_TEST\n");

  const city = await scanCodeCityWorkspace(root, { at: '2026-08-19T00:00:00.000Z' });
  const fileById = new Map(city.files.map((file) => [file.id, file.path]));
  const relationships = city.connections.map((connection) => ({
    from: fileById.get(connection.fromId),
    to: fileById.get(connection.toId),
    kind: connection.kind
  }));
  assert.ok(relationships.some((relationship) => relationship.from === 'public/app.js'
    && relationship.to === 'server.js'
    && relationship.kind === 'api'));
  assert.ok(relationships.some((relationship) => relationship.from === 'test/ui-shell.test.js'
    && relationship.to === 'public/app.js'
    && relationship.kind === 'test'));
  assert.doesNotMatch(JSON.stringify(city), /PRIVATE_|\/api\/late-route|bounded filler/);
});

test('Code City terminates district assignment for a large flat directory', async (testContext) => {
  const root = await temporaryWorkspace(testContext, 'panefleet-code-city-flat-');
  await mkdir(path.join(root, 'flat'));
  for (let index = 0; index < 141; index += 1) {
    await writeFile(path.join(root, 'flat', `module-${index}.js`), `export const value${index} = ${index};\n`);
  }

  const city = await scanCodeCityWorkspace(root, { at: '2026-08-19T00:00:00.000Z' });
  assert.equal(city.summary.fileCount, 141);
  assert.equal(city.summary.truncated, false);
  assert.deepEqual(city.districts.map((district) => [district.name, district.fileCount]), [
    ['flat · block 1 of 2', 140],
    ['flat · block 2 of 2', 1]
  ]);
  assert.ok(city.files.every((file) => /^flat · block [12] of 2$/.test(file.district)));
});

test('Code City validation fails closed on tampered privacy or path metadata', async (testContext) => {
  const root = await temporaryWorkspace(testContext, 'panefleet-code-city-tamper-');
  await writeFile(path.join(root, 'app.js'), 'safe\n');
  const city = await scanCodeCityWorkspace(root, { at: '2026-08-19T00:00:00.000Z' });
  assert.throws(() => validateCodeCitySnapshot({ ...city, privacy: { ...city.privacy, sourceContentIncluded: true } }), /code_city_snapshot_invalid/);
  assert.throws(() => validateCodeCitySnapshot({ ...city, files: [{ ...city.files[0], path: '/private/app.js' }] }), /code_city_snapshot_invalid/);
  assert.throws(() => validateCodeCitySnapshot({ ...city, files: [{ ...city.files[0], role: 'secret' }] }), /code_city_snapshot_invalid/);
  assert.throws(() => validateCodeCitySnapshot({ ...city, files: [{ ...city.files[0], analysis: { ...city.files[0].analysis, signals: ['private-source'] } }] }), /code_city_snapshot_invalid/);
  assert.throws(() => validateCodeCitySnapshot({ ...city, connections: [{ fromId: city.files[0].id, toId: city.files[0].id, kind: 'import', weight: 1 }] }), /code_city_snapshot_invalid/);
});

test('Code City bounds directories, directory entries, special files, and oversized source metadata', async (testContext) => {
  const root = await temporaryWorkspace(testContext, 'panefleet-code-city-limits-');
  await mkdir(path.join(root, 'alpha'));
  await mkdir(path.join(root, 'beta'));
  await writeFile(path.join(root, 'one.js'), '1');
  await writeFile(path.join(root, 'two.js'), '2');
  await writeFile(path.join(root, 'large.ts'), 'too large');
  execFileSync('mkfifo', [path.join(root, 'source.js')]);

  const entryBound = await scanCodeCityWorkspace(root, {
    at: '2026-08-19T00:00:00.000Z',
    limits: { maxEntriesPerDirectory: 1 }
  });
  assert.equal(entryBound.summary.truncated, true);

  const directoryBound = await scanCodeCityWorkspace(root, {
    at: '2026-08-19T00:00:00.000Z',
    limits: { maxDirectories: 1 }
  });
  assert.equal(directoryBound.summary.truncated, true);

  const fileBound = await scanCodeCityWorkspace(root, {
    at: '2026-08-19T00:00:00.000Z',
    limits: { maxFileBytes: 1 }
  });
  assert.ok(fileBound.summary.skippedEntries >= 2);
  assert.equal(fileBound.files.every((file) => file.bytes <= 1), true);
});

test('Code City rejects missing workspaces and file roots before scanning', async (testContext) => {
  const root = await temporaryWorkspace(testContext, 'panefleet-code-city-root-');
  const file = path.join(root, 'app.js');
  await writeFile(file, 'safe');
  await assert.rejects(scanCodeCityWorkspace(path.join(root, 'missing')), /code_city_workspace_invalid/);
  await assert.rejects(scanCodeCityWorkspace(file), /code_city_workspace_invalid/);
});
