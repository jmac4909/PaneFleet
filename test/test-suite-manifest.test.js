import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TEST_SUITES } from '../scripts/test-suites.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const productionModules = [
  'server.js',
  'agent-commons.js',
  'agent-recovery.js',
  'workload-isolation.js',
  'code-city.js',
  'codex-telemetry.js',
  'delivery-plan.js',
  'delivery-plan-store.js',
  'delivery-run.js',
  'delivery-run-store.js',
  'delivery-planning-run.js',
  'delivery-planning-run-store.js',
  'planning-role-report.js',
  'planning-codex-resolver.js',
  'workspace-baseline.js',
  'dashboard-presenters.js',
  'durable-json.js',
  'host-metrics.js',
  'observation-cache.js',
  'trusted-proxy.js',
  'snapshot-events.js',
  'network-monitor.js',
  'runtime-config.js',
  'site-onboarding.js',
  'operator-access-token.js',
  'operator-device-auth.js',
  'runtime-retention.js',
  'prompt-schedule.js',
  'process-runner.js',
  'sensitive-text.js',
  'terminal-ansi.js',
  'public/app.js',
  'public/theme-bootstrap.js',
  'public/terminal-presentation.js',
  'public/ui-state.js',
  'scripts/capture-readme-screenshots.mjs',
  'scripts/agent-commons.mjs',
  'scripts/benchmark-telemetry.mjs',
  'scripts/plan-private-site.mjs',
  'scripts/privacy-check.mjs',
  'scripts/run-tests.mjs',
  'scripts/test-suites.mjs'
];
const coverageExclusions = new Map([
  ['public/app.js', 'browser entrypoint exercised by UI behavior and static integration tests'],
  ['public/theme-bootstrap.js', 'synchronous pre-CSS browser bootstrap exercised in an isolated DOM context'],
  ['public/terminal-presentation.js', 'browser presentation model is exercised through focused safety and rendering contract tests'],
  ['scripts/capture-readme-screenshots.mjs', 'optional browser capture tool exercised through its fixture contract'],
  ['scripts/agent-commons.mjs', 'live-pane collaboration CLI exercised through a fake tmux boundary and subprocess integration test'],
  ['scripts/benchmark-telemetry.mjs', 'optional synthetic benchmark with event and cursor assertions; copying budget is enforced by the telemetry regression suite'],
  ['scripts/plan-private-site.mjs', 'review-only CLI exercised through focused subprocess behavior tests'],
  ['scripts/privacy-check.mjs', 'subprocess tool exercised by privacy-check integration tests'],
  ['scripts/run-tests.mjs', 'test-process orchestrator exercised through subprocess and focused unit tests'],
  ['scripts/test-suites.mjs', 'declarative test manifest with no executable branches']
]);
const coverageModules = productionModules.filter((file) => !coverageExclusions.has(file));
const sourceInventoryIgnoredDirectories = new Set([
  '.git',
  '.github',
  'coverage',
  'data',
  'docs',
  'node_modules',
  'test'
]);

async function sourceFiles(relativeDirectory = '') {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (sourceInventoryIgnoredDirectories.has(entry.name)) continue;
      files.push(...await sourceFiles(relativePath));
    } else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) {
      files.push(relativePath);
    }
  }
  return files;
}

function wordOccurrences(source, name) {
  return (String(source).match(new RegExp(`\\b${name}\\b`, 'g')) || []).length;
}

function importedBindings(source) {
  const bindings = [];
  for (const match of String(source).matchAll(/^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];$/gm)) {
    const specifier = match[1].trim();
    const named = specifier.match(/\{([\s\S]*?)\}/);
    if (named) {
      for (const part of named[1].split(',')) {
        const value = part.trim();
        if (!value) continue;
        const [imported, local = imported] = value.split(/\s+as\s+/).map((item) => item.trim());
        bindings.push({ imported, local, source: match[2] });
      }
    }
    const remaining = specifier.replace(/\{[\s\S]*?\}/, '').replace(/^\s*,|,\s*$/g, '').trim();
    for (const part of remaining.split(',').map((item) => item.trim()).filter(Boolean)) {
      const namespace = part.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (namespace) bindings.push({ imported: '*', local: namespace[1], source: match[2] });
      else if (/^[A-Za-z_$][\w$]*$/.test(part)) {
        bindings.push({ imported: 'default', local: part, source: match[2] });
      }
    }
  }
  return bindings;
}

test('core and feature scripts include every test file exactly once', async () => {
  const [packageText, directoryEntries] = await Promise.all([
    readFile(path.join(root, 'package.json'), 'utf8'),
    readdir(path.join(root, 'test'), { withFileTypes: true })
  ]);
  const scripts = JSON.parse(packageText).scripts || {};
  assert.equal(scripts.test, 'node scripts/run-tests.mjs all');
  assert.equal(scripts['test:core'], 'node scripts/run-tests.mjs core');
  assert.equal(scripts['test:features'], 'node scripts/run-tests.mjs features');
  assert.equal(scripts['test:focused'], 'node scripts/run-tests.mjs --files');
  const core = TEST_SUITES.core.map((file) => path.basename(file));
  const features = TEST_SUITES.features.map((file) => path.basename(file));
  const listed = [...core, ...features];
  const actual = directoryEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => entry.name)
    .sort();

  assert.equal(new Set(listed).size, listed.length, 'a test file is listed more than once');
  assert.deepEqual(listed.sort(), actual);
});

test('package lock and pinned Node version match install-relevant package metadata', async () => {
  const [packageText, lockText, nodeVersionText] = await Promise.all([
    readFile(path.join(root, 'package.json'), 'utf8'),
    readFile(path.join(root, 'package-lock.json'), 'utf8'),
    readFile(path.join(root, '.node-version'), 'utf8')
  ]);
  const packageJson = JSON.parse(packageText);
  const packageLock = JSON.parse(lockText);
  const lockRoot = packageLock.packages?.[''];
  assert.equal(packageLock.lockfileVersion, 3);
  assert.ok(lockRoot && typeof lockRoot === 'object', 'package lock is missing its root package');
  for (const field of ['name', 'version', 'license', 'engines', 'dependencies', 'devDependencies']) {
    assert.deepEqual(lockRoot[field], packageJson[field], `package-lock root ${field} is stale`);
  }
  assert.equal(nodeVersionText.trim(), '22.23.1');
  assert.equal(packageJson.engines?.node, '>=22.23.0 <23');
});

test('every production source module is syntax-checked and coverage-classified', async () => {
  const [actual, packageText] = await Promise.all([
    sourceFiles(),
    readFile(path.join(root, 'package.json'), 'utf8')
  ]);
  actual.sort();
  assert.deepEqual([...productionModules].sort(), actual, 'production source inventory is incomplete');

  const scripts = JSON.parse(packageText).scripts || {};
  const syntaxCheck = String(scripts['check:syntax'] || '');
  assert.match(syntaxCheck, /^npm run check:shell && /);
  assert.equal(scripts.check, 'npm run check:syntax && npm run test:coverage && npm run privacy:check');
  assert.equal(scripts['verify:public'], 'npm run check');
  for (const file of productionModules) {
    assert.match(syntaxCheck, new RegExp(`(?:^|&&\\s*)node --check ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s*&&|$)`));
  }

  const coverageCommand = String(scripts['test:coverage'] || '');
  assert.match(coverageCommand, /(?:^|\s)--merge-async(?:\s|$)/, 'coverage merge must stay bounded on the control-plane host');
  assert.match(coverageCommand, /(?:^|\s)--check-coverage(?:\s|$)/);
  assert.match(coverageCommand, /(?:^|\s)--per-file(?:\s|$)/);
  for (const [metric, minimum] of Object.entries({ statements: 96, branches: 81, functions: 100, lines: 96 })) {
    const match = coverageCommand.match(new RegExp(`(?:^|\\s)--${metric}=(\\d+(?:\\.\\d+)?)(?:\\s|$)`));
    assert.ok(match, `test:coverage is missing its ${metric} floor`);
    assert.ok(Number(match[1]) >= minimum, `test:coverage ${metric} floor regressed below ${minimum}`);
  }
  const includes = [...coverageCommand.matchAll(/--include=([^\s]+)/g)].map((match) => match[1]).sort();
  assert.deepEqual(includes, [...coverageModules].sort());
  assert.deepEqual(
    [...coverageModules, ...coverageExclusions.keys()].sort(),
    [...productionModules].sort(),
    'every source module must be covered or have an explicit test-strategy exclusion'
  );
  for (const [file, reason] of coverageExclusions) {
    assert.ok(reason.length >= 20, `${file} needs a meaningful coverage exclusion reason`);
  }
});

test('integer runtime settings use the shared bounded parser', async () => {
  const server = await readFile(path.join(root, 'server.js'), 'utf8');
  assert.match(
    server,
    /strictIntegerSetting\(process\.env\.PORT, \{ fallback: 8787, min: 0, max: 65535 \}, 'PORT'\)/,
    'PORT bypasses strict shared startup validation'
  );
  assert.doesNotMatch(server, /const PORT = Number\(/);
  const integerSettings = new Set(
    [...server.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)\b/g)]
      .map((match) => match[1])
      .filter((name) => /(?:_MS|_MAX|_LIMIT|_DAYS)$/.test(name))
  );
  assert.ok(integerSettings.size >= 20, 'integer setting discovery unexpectedly shrank');
  for (const name of integerSettings) {
    assert.match(
      server,
      new RegExp(`boundedIntegerSetting\\(process\\.env\\.${name}, \\{`),
      `${name} bypasses the shared integer parser`
    );
  }
  assert.doesNotMatch(server, /const configured(?:SnapshotEventCacheMs|AgentSampleRetentionDays|AuditRetentionDays)\b/);
});

test('production object literals do not immediately redeclare the same key', async () => {
  for (const file of productionModules) {
    const source = await readFile(path.join(root, file), 'utf8');
    const duplicate = source.match(/^\s*([A-Za-z_$][\w$]*)\s*:[^\n]*,\s*\n\s*\1\s*:/m);
    assert.equal(duplicate, null, `${file} immediately redeclares object key ${duplicate?.[1] || ''}`);
  }
});

test('snapshot capabilities exactly match browser-gated features', async () => {
  const [server, app] = await Promise.all([
    readFile(path.join(root, 'server.js'), 'utf8'),
    readFile(path.join(root, 'public', 'app.js'), 'utf8')
  ]);
  const capabilityBlock = server.match(/\n    capabilities: \{\n([\s\S]*?)\n    \},\n    panes,/);
  assert.ok(capabilityBlock, 'server snapshot capability block is missing');
  const advertised = [...capabilityBlock[1].matchAll(/^\s{6}([A-Za-z_$][\w$]*)\s*:/gm)]
    .map((match) => match[1])
    .sort();
  const consumed = [...new Set(
    [...app.matchAll(/\bcapabilities\?\.\s*([A-Za-z_$][\w$]*)/g)].map((match) => match[1])
  )].sort();

  assert.deepEqual(advertised, consumed);
});

test('option payload fields exactly match browser-consumed bootstrap data', async () => {
  const [server, app] = await Promise.all([
    readFile(path.join(root, 'server.js'), 'utf8'),
    readFile(path.join(root, 'public', 'app.js'), 'utf8')
  ]);
  const optionsFunction = server.match(/async function optionsSnapshot\(\) \{[\s\S]*?\n  return \{\n([\s\S]*?)\n  \};\n\}/);
  assert.ok(optionsFunction, 'server options payload is missing');
  const provided = [...optionsFunction[1].matchAll(/^\s{4}([A-Za-z_$][\w$]*)(?:\s*:|,)/gm)]
    .map((match) => match[1])
    .sort();
  const consumed = [...new Set(
    [...app.matchAll(/\bstate\.options(?:\?\.)?\.?(?:\s*)?([A-Za-z_$][\w$]*)/g)]
      .map((match) => match[1])
  )].sort();

  assert.deepEqual(provided, consumed);
});

test('snapshot host fields exactly match browser-consumed host data', async () => {
  const [server, app] = await Promise.all([
    readFile(path.join(root, 'server.js'), 'utf8'),
    readFile(path.join(root, 'public', 'app.js'), 'utf8')
  ]);
  const hostBlock = server.match(/\n  const host = \{\n([\s\S]*?)\n    \};/);
  assert.ok(hostBlock, 'server snapshot host block is missing');
  const provided = [...hostBlock[1].matchAll(/^\s{6}([A-Za-z_$][\w$]*)\s*:/gm)]
    .map((match) => match[1])
    .sort();
  const consumed = [...new Set(
    [...app.matchAll(/\bhost(?:\?\.|\.)([A-Za-z_$][\w$]*)/g)].map((match) => match[1])
  )].sort();

  assert.deepEqual(provided, consumed);
});

test('live snapshot collection observes queue state without owning prompt delivery', async () => {
  const server = await readFile(path.join(root, 'server.js'), 'utf8');
  const eventCollector = server.match(/async function sharedSnapshotEventUpdate[\s\S]*?\n}\n\nfunction stopSnapshotEventTimerIfIdle/);
  assert.ok(eventCollector, 'shared live snapshot collector is missing');
  assert.match(eventCollector[0], /snapshot\(\{ runPromptQueue: false \}\)/);
  assert.match(server, /setInterval\(\(\) => \{\s*monitorPromptQueue\(\);\s*}, PROMPT_QUEUE_MONITOR_MS\)\.unref\(\)/);
});

test('runtime-version fields exactly match browser-consumed drift data', async () => {
  const [server, uiState] = await Promise.all([
    readFile(path.join(root, 'server.js'), 'utf8'),
    readFile(path.join(root, 'public', 'ui-state.js'), 'utf8')
  ]);
  const runtimeBlock = server.match(/\n  const value = \{\n([\s\S]*?)\n  \};\n  runtimeVersionCache/);
  assert.ok(runtimeBlock, 'runtime-version payload is missing');
  const provided = [...runtimeBlock[1].matchAll(/^\s{4}([A-Za-z_$][\w$]*)(?:\s*:|,)/gm)]
    .map((match) => match[1])
    .sort();
  const consumed = [...new Set(
    [...uiState.matchAll(/\bruntimeVersion(?:\?\.|\.)([A-Za-z_$][\w$]*)/g)]
      .map((match) => match[1])
  )].sort();

  assert.deepEqual(provided, consumed);
});

test('top-level production declarations have a production consumer beyond their declaration', async () => {
  const sources = new Map(await Promise.all(productionModules.map(async (file) => [
    file,
    await readFile(path.join(root, file), 'utf8')
  ])));

  const importedExports = new Set();
  for (const [consumerFile, source] of sources) {
    for (const binding of importedBindings(source)) {
      if (!binding.source.startsWith('.')) continue;
      const target = path.normalize(path.join(path.dirname(consumerFile), binding.source));
      if (sources.has(target)) importedExports.add(`${target}\0${binding.imported}`);
    }
  }

  for (const [file, source] of sources) {
    const declarations = source.matchAll(/^(export\s+)?(?:(?:async\s+)?function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm);
    for (const declaration of declarations) {
      const exported = Boolean(declaration[1]);
      const name = declaration[2];
      const consumedLocally = wordOccurrences(source, name) > 1;
      const importedByProduction = exported && importedExports.has(`${file}\0${name}`);
      assert.ok(
        consumedLocally || importedByProduction,
        `${file} declares unused top-level ${name}`
      );
    }
  }
});

test('JavaScript imports are consumed outside their declarations', async () => {
  const [testEntries, helperEntries, scriptEntries] = await Promise.all([
    readdir(path.join(root, 'test'), { withFileTypes: true }),
    readdir(path.join(root, 'test', 'helpers'), { withFileTypes: true }),
    readdir(path.join(root, 'scripts'), { withFileTypes: true })
  ]);
  const files = [...new Set([
    ...productionModules,
    ...testEntries.filter((entry) => entry.isFile() && entry.name.endsWith('.test.js')).map((entry) => path.join('test', entry.name)),
    ...helperEntries.filter((entry) => entry.isFile() && entry.name.endsWith('.js')).map((entry) => path.join('test', 'helpers', entry.name)),
    ...scriptEntries.filter((entry) => entry.isFile() && entry.name.endsWith('.mjs')).map((entry) => path.join('scripts', entry.name))
  ])];

  for (const file of files) {
    const source = await readFile(path.join(root, file), 'utf8');
    for (const { local } of importedBindings(source)) {
      assert.ok(wordOccurrences(source, local) > 1, `${file} imports unused ${local}`);
    }
  }
});

test('static DOM ids are unique and every literal relationship resolves', async () => {
  const [html, app, styles] = await Promise.all([
    readFile(path.join(root, 'public', 'index.html'), 'utf8'),
    readFile(path.join(root, 'public', 'app.js'), 'utf8'),
    readFile(path.join(root, 'public', 'styles.css'), 'utf8')
  ]);
  const staticIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(staticIds).size, staticIds.length, 'public/index.html contains duplicate ids');
  const allIds = new Set([
    ...staticIds,
    ...[...app.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
  ]);

  const relationshipTargets = new Set();
  for (const attribute of ['aria-controls', 'aria-labelledby', 'aria-describedby', 'for']) {
    const references = html.matchAll(new RegExp(`\\b${attribute}="([^"]+)"`, 'g'));
    for (const match of references) {
      for (const id of match[1].trim().split(/\s+/)) {
        assert.ok(allIds.has(id), `${attribute} references missing id ${id}`);
        relationshipTargets.add(id);
      }
    }
  }

  for (const match of app.matchAll(/document\.querySelector\(['"]#([^'"]+)['"]\)/g)) {
    assert.ok(allIds.has(match[1]), `public/app.js queries missing id ${match[1]}`);
  }

  for (const id of staticIds) {
    const selector = `#${id}`;
    assert.ok(
      app.includes(selector) || styles.includes(selector) || relationshipTargets.has(id),
      `public/index.html defines unused id ${id}`
    );
  }
});
