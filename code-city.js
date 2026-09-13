import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

export const CODE_CITY_VERSION = 3;

const CODE_CITY_ROLES = new Set(['ui', 'backend', 'test', 'shared', 'config', 'docs', 'ops']);
const CODE_CITY_CONNECTION_KINDS = new Set(['api', 'import', 'test']);
const CODE_CITY_SEMANTIC_ROLES = new Set(['entrypoint', 'interface', 'service', 'ingestion', 'analysis', 'decision', 'data', 'verification', 'operations', 'documentation', 'configuration', 'module']);
const CODE_CITY_SOURCE_SIGNALS = new Set(['entrypoint', 'component', 'http-route', 'network', 'database', 'filesystem-read', 'filesystem-write', 'process', 'verification']);
const MAX_CONNECTIONS = 2400;
const MAX_ANALYSIS_FILE_BYTES = 1024 * 1024;
const MAX_ANALYSIS_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_DISTRICT_FILES = 140;
const MAX_DISTRICT_BLOCKS = 7;

const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 900,
  maxDirectories: 320,
  maxEntriesPerDirectory: 1200,
  maxDepth: 8,
  maxFileBytes: 16 * 1024 * 1024
});

const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.cache', '.idea', '.vscode',
  'node_modules', 'vendor', 'deps', 'dist', 'build', '_build', 'cover', 'coverage', '.next', '.expo',
  'data', 'logs', 'log', 'tmp', 'temp', 'cache',
  'audit', 'audits', 'artifacts', 'output', 'outputs', 'results', 'recordings', 'captures', 'worktrees'
]);

const SENSITIVE_NAMES = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials?|secrets?|auth(?:orization)?|id_[a-z0-9_-]+)$/i;
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.sqlite', '.sqlite3', '.db']);
const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.ex', '.exs', '.go', '.h', '.heex', '.html',
  '.java', '.js', '.jsx', '.json', '.kt', '.kts', '.less', '.lua', '.md', '.mjs',
  '.cjs', '.php', '.pl', '.py', '.rb', '.rs', '.sass', '.scss', '.sh', '.sql',
  '.svelte', '.swift', '.toml', '.ts', '.tsx', '.vue', '.xml', '.yaml', '.yml'
]);
const SOURCE_FILENAMES = new Set(['dockerfile', 'makefile', 'rakefile', 'gemfile']);

const LANGUAGE_BY_EXTENSION = Object.freeze({
  '.c': 'C', '.cc': 'C++', '.cpp': 'C++', '.cs': 'C#', '.css': 'CSS',
  '.ex': 'Elixir', '.exs': 'Elixir', '.go': 'Go', '.h': 'C/C++', '.heex': 'HEEx',
  '.html': 'HTML', '.java': 'Java', '.js': 'JavaScript', '.jsx': 'JavaScript',
  '.json': 'JSON', '.kt': 'Kotlin', '.kts': 'Kotlin', '.less': 'Less', '.lua': 'Lua',
  '.md': 'Markdown', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.php': 'PHP',
  '.pl': 'Perl', '.py': 'Python', '.rb': 'Ruby', '.rs': 'Rust', '.sass': 'Sass',
  '.scss': 'Sass', '.sh': 'Shell', '.sql': 'SQL', '.svelte': 'Svelte', '.swift': 'Swift',
  '.toml': 'TOML', '.ts': 'TypeScript', '.tsx': 'TypeScript', '.vue': 'Vue',
  '.xml': 'XML', '.yaml': 'YAML', '.yml': 'YAML'
});

function isSameOrChild(childPath, rootPath) {
  const relative = path.relative(rootPath, childPath);
  return relative === '' || (Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeEntryName(value) {
  const name = String(value || '');
  return Boolean(
    name &&
    name.length <= 160 &&
    name !== '.' &&
    name !== '..' &&
    !/[\\/]/.test(name) &&
    !/[\u0000-\u001F\u007F]/.test(name)
  );
}

function codeCityDistrictIdentity(value) {
  const name = String(value || '');
  if (!safeEntryName(name)) return null;
  const match = /^(.*?) · block ([1-9]\d?) of ([1-9]\d?)$/.exec(name);
  if (!match) return name.includes(' · block ') ? null : { name, base: name, block: 0, blocks: 0 };
  const block = Number(match[2]);
  const blocks = Number(match[3]);
  if (!safeEntryName(match[1]) || block > blocks || blocks > MAX_DISTRICT_BLOCKS) return null;
  return { name, base: match[1], block, blocks };
}

function sourceFileDescriptor(name) {
  const normalized = String(name || '');
  const lower = normalized.toLowerCase();
  const extension = path.extname(lower);
  if (
    !safeEntryName(normalized) ||
    normalized.startsWith('.') ||
    SENSITIVE_NAMES.test(lower) ||
    SENSITIVE_EXTENSIONS.has(extension) ||
    (!SOURCE_EXTENSIONS.has(extension) && !SOURCE_FILENAMES.has(lower))
  ) return null;
  return {
    extension: extension || lower,
    language: LANGUAGE_BY_EXTENSION[extension] || (SOURCE_FILENAMES.has(lower) ? 'Build' : 'Other')
  };
}

function generatedStructuredData(relativePath, descriptor) {
  if (!['.json', '.xml', '.yaml', '.yml'].includes(descriptor.extension)) return false;
  return /(?:^|\/)(?:state|states|fixtures|snapshots|results?|captures?)(?:\/|$)/i.test(relativePath);
}

function opaqueId(prefix, relativePath) {
  return `${prefix}-${createHash('sha256').update(relativePath).digest('hex').slice(0, 16)}`;
}

function normalizedLimits(input = {}) {
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const value = Number(input[key]);
    result[key] = Number.isSafeInteger(value) && value > 0 ? Math.min(value, fallback) : fallback;
  }
  return result;
}

function snapshotDigest(snapshot) {
  return createHash('sha256').update(JSON.stringify({
    version: snapshot.version,
    rootName: snapshot.rootName,
    files: snapshot.files,
    districts: snapshot.districts,
    connections: snapshot.connections,
    summary: snapshot.summary,
    privacy: snapshot.privacy
  })).digest('hex');
}

function codeCityFileRole(relativePath, descriptor) {
  const normalized = String(relativePath || '').toLowerCase();
  const name = path.posix.basename(normalized);
  const extension = descriptor.extension;
  if (
    /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e)(?:\/|$)/.test(normalized)
    || /(?:^|[._-])(?:test|tests|spec|specs)(?:[._-]|$)/.test(name)
  ) return 'test';
  if (extension === '.md') return 'docs';
  if (
    /(?:^|\/)(?:ops|scripts|deploy|deployment|infra|infrastructure|\.github)(?:\/|$)/.test(normalized)
    || ['dockerfile', 'makefile', 'rakefile'].includes(name)
    || extension === '.sh'
  ) return 'ops';
  if (
    ['.css', '.scss', '.sass', '.less', '.html', '.heex', '.jsx', '.tsx', '.vue', '.svelte'].includes(extension)
    || /(?:^|\/)(?:public|ui|client|frontend|mobile|components|screens|pages|views|styles|assets)(?:\/|$)/.test(normalized)
  ) return 'ui';
  if (
    /(?:^|\/)(?:server|servers|api|backend|controllers|routes|workers|database|migrations)(?:\/|$)/.test(normalized)
    || /^(?:server|api|router|routes?)[._-]/.test(name)
    || ['server.js', 'server.mjs', 'server.cjs', 'server.ts'].includes(name)
    || extension === '.sql'
  ) return 'backend';
  if (
    ['.json', '.toml', '.yaml', '.yml', '.xml'].includes(extension)
    || /(?:^|\/)(?:config|configs)(?:\/|$)/.test(normalized)
    || /^(?:package|tsconfig|jsconfig|eslint|prettier|babel|vite|webpack|rollup)[._-]/.test(name)
  ) return 'config';
  return 'shared';
}

function codeCityFilePurpose(role, relativePath) {
  if (role === 'test') {
    const normalized = String(relativePath || '').toLowerCase();
    if (/(?:ui|mobile|browser|component|e2e)/.test(normalized)) return 'Automated UI or interaction test';
    if (/(?:api|server|backend|integration)/.test(normalized)) return 'Automated backend or API test';
    return 'Automated test or verification code';
  }
  return {
    ui: 'Browser or mobile interface code',
    backend: 'Server, API, worker, or data-side code',
    shared: 'Shared application or library code',
    config: 'Project configuration or structured data',
    docs: 'Project documentation',
    ops: 'Build, deployment, or operational automation'
  }[role] || 'Project source file';
}

function codeCityFileAnalysis(file, text) {
  const source = String(text || '');
  const normalized = file.path.toLowerCase();
  const name = file.name.toLowerCase();
  const explicitEntrypoint = (
    /if\s+__name__\s*==\s*["']__main__["']/.test(source)
    || /\brequire\.main\s*===\s*module\b/.test(source)
    || /\b(?:app|server)\.listen\s*\(/.test(source)
    || /^(?:main|server|cli|manage|run)\.(?:cjs|js|mjs|py|ts)$/.test(name)
  );
  const conventionalEntrypoint = /^(?:main|server|cli|manage|run)\.(?:cjs|js|mjs|py|ts)$/.test(name)
    || /\b(?:app|server)\.listen\s*\(/.test(source);
  const verificationNamed = /(?:^|[._-])(?:test|tests|spec|verify|verifier|verification|validate|validator|audit|check)(?:[._-]|$)/.test(name);
  let semanticRole = 'module';
  if (file.role === 'test' || verificationNamed) semanticRole = 'verification';
  else if (conventionalEntrypoint) semanticRole = 'entrypoint';
  else if (file.role === 'ui') semanticRole = 'interface';
  else if (file.role === 'ops') semanticRole = 'operations';
  else if (file.role === 'docs') semanticRole = 'documentation';
  else if (/(?:^|[._-])(?:source|ingest|extract|loader|fetch|download|collector|scrape|import|builder|recon)(?:[._-]|$)/.test(name)) semanticRole = 'ingestion';
  else if (/(?:^|[._-])(?:decision|recommend|report|export|result|finalizer|outcome)(?:[._-]|$)/.test(name)) semanticRole = 'decision';
  else if (/(?:^|[._-])(?:repository|store|database|migration|schema|snapshot|dataset|db)(?:[._-]|$)/.test(name)) semanticRole = 'data';
  else if (/(?:^|[._-])(?:model|engine|research|analysis|analyzer|forecast|score|rank|strategy|backtest|alpha|optimizer|return|transport|probe|falsification)(?:[._-]|$)/.test(name)) semanticRole = 'analysis';
  else if (file.role === 'backend') semanticRole = 'service';
  else if (file.role === 'config') semanticRole = 'configuration';
  else if (explicitEntrypoint) semanticRole = 'entrypoint';

  const signals = new Set();
  if (explicitEntrypoint) signals.add('entrypoint');
  if (file.role === 'ui' && /(?:\bfunction\s+[A-Z]|\bclass\s+[A-Z]|<[A-Z][A-Za-z0-9]*)/.test(source)) signals.add('component');
  if (/\b(?:app|router|server)\.(?:get|post|put|patch|delete|use)\s*\(|\burl\.pathname\s*===|\broute\s*\(/.test(source)) signals.add('http-route');
  if (/\b(?:fetch|axios|requests\.|urllib\.|http\.(?:get|request)|https\.(?:get|request)|socket\.)/.test(source)) signals.add('network');
  if (/\b(?:SELECT|INSERT|UPDATE|DELETE\s+FROM|CREATE\s+TABLE)\b|\b(?:sqlite|postgres|mysql|sequelize|knex|prisma)\b/i.test(source)) signals.add('database');
  if (/\b(?:readFile|readFileSync|createReadStream|open\s*\([^,\n]+,[^\n]*["']r|Path\([^\n]+\)\.read_)/.test(source)) signals.add('filesystem-read');
  if (/\b(?:writeFile|writeFileSync|appendFile|createWriteStream|rename|unlink|mkdir|open\s*\([^,\n]+,[^\n]*["'][wax])/.test(source)) signals.add('filesystem-write');
  if (/\b(?:execFile|execSync|spawn|subprocess\.|os\.system|systemd-run)\b/.test(source)) signals.add('process');
  if (semanticRole === 'verification') signals.add('verification');

  const symbolPattern = file.extension === '.py'
    ? /^\s*(?:async\s+)?(?:def|class)\s+[A-Za-z_]\w*/gm
    : /\b(?:function|class)\s+[A-Za-z_$][\w$]*|\b(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\(/g;
  const symbolCount = Math.min(100_000, [...source.matchAll(symbolPattern)].length);
  const branchCount = Math.min(100_000, [...source.matchAll(/\b(?:if|else\s+if|for|while|switch|case|catch|except|match)\b/g)].length);
  return {
    semanticRole,
    confidence: explicitEntrypoint || semanticRole !== 'module' ? 'high' : 'medium',
    lineCount: source ? source.split('\n').length : 0,
    symbolCount,
    branchCount,
    sourceTruncated: file.bytes > Buffer.byteLength(source),
    entrypoint: explicitEntrypoint,
    signals: [...signals].sort()
  };
}

function assignCodeCityDistricts(files) {
  const MAX_DISTRICT_DEPTH = 3;
  const districtAtDepth = (file, depth) => {
    const directories = file.path.split('/').slice(0, -1);
    const districtParts = directories.slice(0, Math.min(depth, directories.length));
    while (districtParts.length > 1 && districtParts.join(' › ').length > 160) districtParts.pop();
    return districtParts.length ? districtParts.join(' › ') : 'Root';
  };
  const assignAtDepth = (members, depth) => {
    for (const file of members) file.district = districtAtDepth(file, depth);
  };
  const assignFlatBlocks = (members, depth) => {
    const ordered = members.slice().sort((left, right) => left.path.localeCompare(right.path));
    const blockCount = Math.ceil(ordered.length / MAX_DISTRICT_FILES);
    for (let index = 0; index < ordered.length; index += 1) {
      const file = ordered[index];
      file.district = `${districtAtDepth(file, depth)} · block ${Math.floor(index / MAX_DISTRICT_FILES) + 1} of ${blockCount}`;
    }
  };
  const assign = (members, depth) => {
    if (members.length <= MAX_DISTRICT_FILES || depth >= MAX_DISTRICT_DEPTH) {
      assignAtDepth(members, depth);
      return;
    }
    const direct = [];
    const nested = new Map();
    for (const file of members) {
      const directories = file.path.split('/').slice(0, -1);
      if (directories.length <= depth) {
        direct.push(file);
        continue;
      }
      const next = directories[depth];
      if (!nested.has(next)) nested.set(next, []);
      nested.get(next).push(file);
    }
    // Direct members have no deeper path segment to split on. Partition a
    // large flat directory into deterministic visual blocks instead of
    // recursing at the same depth, which would never make progress.
    if (direct.length > MAX_DISTRICT_FILES) assignFlatBlocks(direct, depth);
    else if (direct.length) assignAtDepth(direct, depth);
    for (const group of nested.values()) assign(group, depth + 1);
  };
  const roots = new Map();
  for (const file of files) {
    const first = file.path.includes('/') ? file.path.split('/')[0] : 'Root';
    if (!roots.has(first)) roots.set(first, []);
    roots.get(first).push(file);
  }
  for (const group of roots.values()) assign(group, 1);
}

async function boundedSourceText(canonicalRoot, canonicalFile, details, remainingBytes) {
  if (!Number.isSafeInteger(remainingBytes) || remainingBytes < 1 || details.size < 1) return '';
  const maximum = Math.min(details.size, MAX_ANALYSIS_FILE_BYTES, remainingBytes);
  let handle;
  try {
    handle = await open(canonicalFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    const openedPath = await realpath(`/proc/self/fd/${handle.fd}`).catch(() => '');
    if (
      !openedPath || openedPath !== canonicalFile || !isSameOrChild(openedPath, canonicalRoot) ||
      !before.isFile() || before.dev !== details.dev || before.ino !== details.ino || before.size !== details.size
    ) return '';
    const buffer = Buffer.alloc(maximum);
    const { bytesRead } = await handle.read(buffer, 0, maximum, 0);
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return '';
    const text = buffer.subarray(0, bytesRead);
    if (text.includes(0)) return '';
    return text.toString('utf8');
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sourceSpecifiers(text) {
  const found = new Set();
  const patterns = [
    /\b(?:from\s*|require\s*\(\s*|import\s*\(\s*|import\s+)[`'"]([^`'"?#]+)[`'"]/g,
    /@import\s+(?:url\(\s*)?[`'"](\.{1,2}\/[^`'"?#]+)[`'"]/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = String(match[1] || '');
      if (value && value.length <= 160 && !/[\u0000-\u001F\u007F\\]/.test(value) && !value.startsWith('/')) found.add(value);
    }
  }
  return [...found];
}

function pythonSourceSpecifiers(text) {
  const found = new Set();
  const patterns = [
    /^\s*from\s+(\.{0,8}[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s+import\b/gm,
    /^\s*import\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/gm
  ];
  for (const pattern of patterns) {
    for (const match of String(text || '').matchAll(pattern)) {
      const value = String(match[1] || '');
      if (value && value.length <= 160) found.add(value);
    }
  }
  return [...found];
}

function apiReferences(text) {
  const found = new Set();
  for (const match of text.matchAll(/\/(?:api\/[a-z0-9_./:*-]+|socket(?:\/[a-z0-9_./:*-]+)?|graphql(?:\/[a-z0-9_./:*-]+)?)/gi)) {
    let endpoint = match[0].replace(/\/+$/, '');
    if (endpoint === '/socket' || endpoint.startsWith('/socket/')) endpoint = '/socket';
    if (endpoint === '/graphql' || endpoint.startsWith('/graphql/')) endpoint = '/graphql';
    if (endpoint.length <= 160) found.add(endpoint);
  }
  return found;
}

function resolveSourceSpecifier(fromPath, specifier, fileByPath) {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  if (!base || base === '..' || base.startsWith('../') || path.posix.isAbsolute(base)) return null;
  const candidates = [base];
  if (!path.posix.extname(base)) {
    for (const extension of SOURCE_EXTENSIONS) candidates.push(`${base}${extension}`);
    for (const extension of SOURCE_EXTENSIONS) candidates.push(path.posix.join(base, `index${extension}`));
  }
  return candidates.map((candidate) => fileByPath.get(candidate)).find(Boolean) || null;
}

function resolvePythonSpecifier(fromPath, specifier, fileByPath) {
  const leadingDots = /^\.+/.exec(specifier)?.[0].length || 0;
  const moduleName = specifier.slice(leadingDots);
  if (!moduleName) return null;
  const modulePath = moduleName.replace(/\./g, '/');
  const bases = [];
  if (leadingDots > 0) {
    let relativeRoot = path.posix.dirname(fromPath);
    for (let index = 1; index < leadingDots; index += 1) relativeRoot = path.posix.dirname(relativeRoot);
    bases.push(path.posix.join(relativeRoot, modulePath));
  } else {
    bases.push(modulePath, path.posix.join(path.posix.dirname(fromPath), modulePath));
  }
  for (const base of bases) {
    if (!base || base === '..' || base.startsWith('../') || path.posix.isAbsolute(base)) continue;
    const target = fileByPath.get(`${base}.py`) || fileByPath.get(path.posix.join(base, '__init__.py'));
    if (target) return target;
  }
  return null;
}

function workspacePackageMap(files, analysisByPath, fileByPath) {
  const result = new Map();
  for (const manifest of files.filter((file) => file.name.toLowerCase() === 'package.json')) {
    let parsed;
    try {
      parsed = JSON.parse(analysisByPath.get(manifest.path) || '');
    } catch {
      continue;
    }
    const name = String(parsed?.name || '');
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name) || name.length > 100) continue;
    const root = path.posix.dirname(manifest.path);
    const candidates = ['src/index.ts', 'src/index.tsx', 'src/index.js', 'index.ts', 'index.tsx', 'index.js']
      .map((relative) => fileByPath.get(path.posix.join(root, relative)))
      .filter(Boolean);
    const target = candidates[0] || files.find((file) => file.role !== 'test' && file.path.startsWith(`${root}/`));
    if (target) result.set(name, { root, target });
  }
  return result;
}

function resolveWorkspaceSpecifier(specifier, packages, fileByPath) {
  const match = [...packages.entries()].sort((left, right) => right[0].length - left[0].length)
    .find(([name]) => specifier === name || specifier.startsWith(`${name}/`));
  if (!match) return null;
  const [name, entry] = match;
  const subpath = specifier.slice(name.length).replace(/^\//, '');
  if (!subpath) return entry.target;
  const bases = [path.posix.join(entry.root, subpath), path.posix.join(entry.root, 'src', subpath)];
  for (const base of bases) {
    const direct = fileByPath.get(base);
    if (direct) return direct;
    if (!path.posix.extname(base)) {
      for (const extension of SOURCE_EXTENSIONS) {
        const candidate = fileByPath.get(`${base}${extension}`) || fileByPath.get(path.posix.join(base, `index${extension}`));
        if (candidate) return candidate;
      }
    }
  }
  return entry.target;
}

function sourcePathReferences(text, fromPath, files, fileByPath) {
  const found = new Set();
  const byName = new Map();
  for (const file of files) {
    if (!byName.has(file.name)) byName.set(file.name, []);
    byName.get(file.name).push(file);
  }
  for (const match of String(text || '').matchAll(/[`'"]([^`'"\n\r]{1,160}\.(?:c|cc|cpp|cs|css|ex|exs|go|h|heex|html|java|js|jsx|json|kt|kts|less|lua|md|mjs|cjs|php|pl|py|rb|rs|sass|scss|sh|sql|svelte|swift|toml|ts|tsx|vue|xml|yaml|yml))[`'"]/gi)) {
    const reference = match[1].replace(/\\/g, '/');
    if (reference.startsWith('/') || reference.includes('\u0000')) continue;
    const normalized = path.posix.normalize(reference.replace(/^\.\//, ''));
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), reference));
    const direct = fileByPath.get(normalized) || fileByPath.get(relative);
    if (direct) {
      found.add(direct);
      continue;
    }
    const named = byName.get(path.posix.basename(normalized)) || [];
    if (named.length === 1) found.add(named[0]);
  }
  return found;
}

function buildCodeCityConnections(files, analysisByPath) {
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const packages = workspacePackageMap(files, analysisByPath, fileByPath);
  const connectionByKey = new Map();
  let truncated = false;
  const add = (from, to, kind, weight = 1) => {
    if (!from || !to || from.id === to.id || !CODE_CITY_CONNECTION_KINDS.has(kind)) return;
    const key = `${from.id}:${to.id}:${kind}`;
    const existing = connectionByKey.get(key);
    if (existing) {
      existing.weight = Math.min(99, existing.weight + weight);
      return;
    }
    if (connectionByKey.size >= MAX_CONNECTIONS) {
      truncated = true;
      return;
    }
    connectionByKey.set(key, { fromId: from.id, toId: to.id, kind, weight: Math.min(99, weight) });
  };

  const apiFiles = new Map();
  for (const file of files) {
    const text = analysisByPath.get(file.path) || '';
    if (!text) continue;
    for (const specifier of sourceSpecifiers(text)) {
      const target = resolveSourceSpecifier(file.path, specifier, fileByPath) || resolveWorkspaceSpecifier(specifier, packages, fileByPath);
      add(file, target, file.role === 'test' ? 'test' : 'import');
    }
    if (file.extension === '.py') {
      for (const specifier of pythonSourceSpecifiers(text)) {
        add(file, resolvePythonSpecifier(file.path, specifier, fileByPath), file.role === 'test' ? 'test' : 'import');
      }
    }
    for (const endpoint of apiReferences(text)) {
      if (!apiFiles.has(endpoint)) apiFiles.set(endpoint, []);
      apiFiles.get(endpoint).push(file);
    }
  }

  for (const matches of apiFiles.values()) {
    const providers = matches.filter((file) => file.role === 'backend');
    const consumers = matches.filter((file) => file.role !== 'backend');
    for (const consumer of consumers) {
      for (const provider of providers.slice(0, 4)) add(consumer, provider, consumer.role === 'test' ? 'test' : 'api');
    }
  }

  for (const testFile of files.filter((file) => file.role === 'test')) {
    const text = analysisByPath.get(testFile.path) || '';
    for (const target of sourcePathReferences(text, testFile.path, files, fileByPath)) {
      if (target.role !== 'test') add(testFile, target, 'test');
    }
    const alreadyLinked = [...connectionByKey.values()].some((connection) => connection.fromId === testFile.id);
    if (alreadyLinked) continue;
    const stem = testFile.name.toLowerCase()
      .replace(/(?:[._-](?:test|tests|spec|specs))+?(?=\.[^.]+$)/g, '')
      .replace(/^(?:test|spec)[._-]/, '');
    const target = files.find((file) => file.role !== 'test' && file.name.toLowerCase() === stem);
    add(testFile, target, 'test');
  }

  const connections = [...connectionByKey.values()].sort((left, right) => (
    left.fromId.localeCompare(right.fromId) || left.toId.localeCompare(right.toId) || left.kind.localeCompare(right.kind)
  ));
  return { connections, truncated };
}

export function validateCodeCitySnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('code_city_snapshot_invalid');
  const keys = ['version', 'generatedAt', 'rootName', 'files', 'districts', 'connections', 'summary', 'privacy', 'digest'];
  if (Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw new Error('code_city_snapshot_invalid');
  if (
    value.version !== CODE_CITY_VERSION ||
    typeof value.generatedAt !== 'string' ||
    Number.isNaN(Date.parse(value.generatedAt)) ||
    new Date(value.generatedAt).toISOString() !== value.generatedAt ||
    !safeEntryName(value.rootName)
  ) throw new Error('code_city_snapshot_invalid');
  if (
    !Array.isArray(value.files) || value.files.length > DEFAULT_LIMITS.maxFiles ||
    !Array.isArray(value.districts) || value.districts.length > DEFAULT_LIMITS.maxDirectories ||
    !Array.isArray(value.connections) || value.connections.length > MAX_CONNECTIONS ||
    !value.summary || typeof value.summary !== 'object' || Array.isArray(value.summary) ||
    Object.keys(value.summary).sort().join('|') !== ['analysisTruncated', 'analyzedFileCount', 'connectionCount', 'directoriesVisited', 'districtCount', 'fileCount', 'flowCounts', 'roleCounts', 'semanticRoleCounts', 'signalCounts', 'skippedEntries', 'totalBytes', 'truncated'].sort().join('|') ||
    !value.privacy || typeof value.privacy !== 'object' || Array.isArray(value.privacy) ||
    !/^[a-f0-9]{64}$/.test(String(value.digest || ''))
  ) throw new Error('code_city_snapshot_invalid');
  const seenFileIds = new Set();
  const seenPaths = new Set();
  for (const file of value.files) {
    const segments = typeof file?.path === 'string' ? file.path.split('/') : [];
    const districtIdentity = codeCityDistrictIdentity(file?.district);
    const districtSegments = districtIdentity ? districtIdentity.base.split(' › ') : [];
    if (
      !file || Object.keys(file).sort().join('|') !== ['analysis', 'bytes', 'depth', 'district', 'extension', 'id', 'language', 'name', 'path', 'purpose', 'role'].sort().join('|') ||
      !/^building-[a-f0-9]{16}$/.test(file.id) || !safeEntryName(file.name) ||
      seenFileIds.has(file.id) || seenPaths.has(file.path) ||
      typeof file.path !== 'string' || !file.path || file.path.includes('\\') || path.posix.isAbsolute(file.path) ||
      segments.some((segment) => !safeEntryName(segment)) || segments.at(-1) !== file.name ||
      !districtIdentity || (
        districtIdentity.base === 'Root'
          ? segments.length !== 1
          : districtSegments.length < 1 || districtSegments.length > 3 || districtSegments.some((segment, index) => segment !== segments[index])
      ) ||
      typeof file.extension !== 'string' || !file.extension || file.extension.length > 20 || /[\u0000-\u001F\u007F/\\]/.test(file.extension) ||
      typeof file.language !== 'string' || !file.language || file.language.length > 40 || /[\u0000-\u001F\u007F]/.test(file.language) ||
      !CODE_CITY_ROLES.has(file.role) || typeof file.purpose !== 'string' || !file.purpose || file.purpose.length > 160 || /[\u0000-\u001F\u007F]/.test(file.purpose) ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > DEFAULT_LIMITS.maxFileBytes ||
      !Number.isSafeInteger(file.depth) || file.depth !== segments.length - 1 || file.depth > DEFAULT_LIMITS.maxDepth ||
      !file.analysis || Object.keys(file.analysis).sort().join('|') !== ['branchCount', 'confidence', 'entrypoint', 'lineCount', 'semanticRole', 'signals', 'sourceTruncated', 'symbolCount'].sort().join('|') ||
      !CODE_CITY_SEMANTIC_ROLES.has(file.analysis.semanticRole) || !['high', 'medium'].includes(file.analysis.confidence) ||
      !Number.isSafeInteger(file.analysis.lineCount) || file.analysis.lineCount < 0 || file.analysis.lineCount > 2_000_000 ||
      !Number.isSafeInteger(file.analysis.symbolCount) || file.analysis.symbolCount < 0 || file.analysis.symbolCount > 100_000 ||
      !Number.isSafeInteger(file.analysis.branchCount) || file.analysis.branchCount < 0 || file.analysis.branchCount > 100_000 ||
      typeof file.analysis.sourceTruncated !== 'boolean' || typeof file.analysis.entrypoint !== 'boolean' ||
      !Array.isArray(file.analysis.signals) || file.analysis.signals.length > CODE_CITY_SOURCE_SIGNALS.size ||
      file.analysis.signals.some((signal) => !CODE_CITY_SOURCE_SIGNALS.has(signal)) ||
      new Set(file.analysis.signals).size !== file.analysis.signals.length ||
      file.analysis.signals.slice().sort().join('|') !== file.analysis.signals.join('|') ||
      file.analysis.entrypoint !== file.analysis.signals.includes('entrypoint')
    ) throw new Error('code_city_snapshot_invalid');
    seenFileIds.add(file.id);
    seenPaths.add(file.path);
  }
  const seenDistrictIds = new Set();
  const seenDistrictNames = new Set();
  for (const district of value.districts) {
    const districtIdentity = codeCityDistrictIdentity(district?.name);
    if (
      !district || Object.keys(district).sort().join('|') !== ['fileCount', 'id', 'name', 'totalBytes'].sort().join('|') ||
      !/^district-[a-f0-9]{16}$/.test(district.id) || !districtIdentity ||
      seenDistrictIds.has(district.id) || seenDistrictNames.has(district.name) ||
      !Number.isSafeInteger(district.fileCount) || district.fileCount < 1 || (districtIdentity.block > 0 && district.fileCount > MAX_DISTRICT_FILES) ||
      !Number.isSafeInteger(district.totalBytes) || district.totalBytes < 0
    ) throw new Error('code_city_snapshot_invalid');
    const matching = value.files.filter((file) => file.district === district.name);
    if (
      matching.length !== district.fileCount ||
      matching.reduce((total, file) => total + file.bytes, 0) !== district.totalBytes
    ) throw new Error('code_city_snapshot_invalid');
    seenDistrictIds.add(district.id);
    seenDistrictNames.add(district.name);
  }
  const seenConnections = new Set();
  for (const connection of value.connections) {
    const key = `${connection?.fromId}:${connection?.toId}:${connection?.kind}`;
    if (
      !connection || Object.keys(connection).sort().join('|') !== ['fromId', 'kind', 'toId', 'weight'].sort().join('|') ||
      !seenFileIds.has(connection.fromId) || !seenFileIds.has(connection.toId) || connection.fromId === connection.toId ||
      !CODE_CITY_CONNECTION_KINDS.has(connection.kind) || !Number.isSafeInteger(connection.weight) || connection.weight < 1 || connection.weight > 99 ||
      seenConnections.has(key)
    ) throw new Error('code_city_snapshot_invalid');
    seenConnections.add(key);
  }
  const expectedPrivacy = { sourceAnalyzedLocally: true, sourceContentIncluded: false, absolutePathsIncluded: false, externalRequestsRequired: false };
  if (JSON.stringify(value.privacy) !== JSON.stringify(expectedPrivacy)) throw new Error('code_city_snapshot_invalid');
  const expectedRoleCounts = Object.fromEntries([...CODE_CITY_ROLES].map((role) => [role, value.files.filter((file) => file.role === role).length]));
  const expectedSemanticRoleCounts = Object.fromEntries([...CODE_CITY_SEMANTIC_ROLES].map((role) => [role, value.files.filter((file) => file.analysis.semanticRole === role).length]));
  const expectedSignalCounts = Object.fromEntries([...CODE_CITY_SOURCE_SIGNALS].map((signal) => [signal, value.files.filter((file) => file.analysis.signals.includes(signal)).length]));
  const expectedFlowCounts = Object.fromEntries([...CODE_CITY_CONNECTION_KINDS].map((kind) => [kind, value.connections.filter((connection) => connection.kind === kind).length]));
  if (
    !Number.isSafeInteger(value.summary.fileCount) || value.summary.fileCount !== value.files.length ||
    !Number.isSafeInteger(value.summary.districtCount) || value.summary.districtCount !== value.districts.length ||
    !Number.isSafeInteger(value.summary.totalBytes) || value.summary.totalBytes !== value.files.reduce((total, file) => total + file.bytes, 0) ||
    !Number.isSafeInteger(value.summary.directoriesVisited) || value.summary.directoriesVisited < 1 || value.summary.directoriesVisited > DEFAULT_LIMITS.maxDirectories ||
    !Number.isSafeInteger(value.summary.skippedEntries) || value.summary.skippedEntries < 0 ||
    !Number.isSafeInteger(value.summary.analyzedFileCount) || value.summary.analyzedFileCount < 0 || value.summary.analyzedFileCount > value.files.length ||
    !Number.isSafeInteger(value.summary.connectionCount) || value.summary.connectionCount !== value.connections.length ||
    JSON.stringify(value.summary.roleCounts) !== JSON.stringify(expectedRoleCounts) ||
    JSON.stringify(value.summary.semanticRoleCounts) !== JSON.stringify(expectedSemanticRoleCounts) ||
    JSON.stringify(value.summary.signalCounts) !== JSON.stringify(expectedSignalCounts) ||
    JSON.stringify(value.summary.flowCounts) !== JSON.stringify(expectedFlowCounts) ||
    typeof value.summary.truncated !== 'boolean' || typeof value.summary.analysisTruncated !== 'boolean'
  ) throw new Error('code_city_snapshot_invalid');
  if (snapshotDigest(value) !== value.digest) throw new Error('code_city_snapshot_invalid');
  return structuredClone(value);
}

export async function scanCodeCityWorkspace(workspace, { rootName = '', at = new Date().toISOString(), limits = {} } = {}) {
  const canonicalRoot = await realpath(path.resolve(String(workspace || ''))).catch(() => '');
  if (!canonicalRoot) throw new Error('code_city_workspace_invalid');
  const rootDetails = await lstat(canonicalRoot).catch(() => null);
  if (!rootDetails?.isDirectory() || rootDetails.isSymbolicLink()) throw new Error('code_city_workspace_invalid');
  const bounded = normalizedLimits(limits);
  const files = [];
  const analysisByPath = new Map();
  const districtTotals = new Map();
  const queue = [{ absolute: canonicalRoot, relative: '', depth: 0 }];
  let directoriesVisited = 0;
  let skippedEntries = 0;
  let truncated = false;
  let analyzedBytes = 0;
  let analysisTruncated = false;

  while (queue.length && files.length < bounded.maxFiles && directoriesVisited < bounded.maxDirectories) {
    const current = queue.shift();
    const currentReal = await realpath(current.absolute).catch(() => '');
    const currentDetails = currentReal ? await lstat(currentReal).catch(() => null) : null;
    if (!currentReal || !isSameOrChild(currentReal, canonicalRoot) || !currentDetails?.isDirectory() || currentDetails.isSymbolicLink()) {
      skippedEntries += 1;
      continue;
    }
    directoriesVisited += 1;
    const directory = await opendir(currentReal);
    let entriesSeen = 0;
    try {
      for await (const entry of directory) {
        entriesSeen += 1;
        if (entriesSeen > bounded.maxEntriesPerDirectory) {
          truncated = true;
          break;
        }
        if (!safeEntryName(entry.name) || entry.isSymbolicLink()) {
          skippedEntries += 1;
          continue;
        }
        const lower = entry.name.toLowerCase();
        const relative = current.relative ? path.posix.join(current.relative, entry.name) : entry.name;
        const absolute = path.join(currentReal, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || EXCLUDED_DIRECTORIES.has(lower) || current.depth >= bounded.maxDepth) {
            skippedEntries += 1;
            continue;
          }
          if (queue.length + directoriesVisited >= bounded.maxDirectories) {
            truncated = true;
            continue;
          }
          queue.push({ absolute, relative, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile()) {
          skippedEntries += 1;
          continue;
        }
        const descriptor = sourceFileDescriptor(entry.name);
        if (!descriptor || generatedStructuredData(relative, descriptor)) {
          skippedEntries += 1;
          continue;
        }
        const [canonicalFile, details] = await Promise.all([
          realpath(absolute).catch(() => ''),
          lstat(absolute).catch(() => null)
        ]);
        if (
          !canonicalFile || !isSameOrChild(canonicalFile, canonicalRoot) ||
          !details?.isFile() || details.isSymbolicLink() || details.size > bounded.maxFileBytes
        ) {
          skippedEntries += 1;
          continue;
        }
        const parts = relative.split('/');
        const district = parts.length > 1 ? parts[0] : 'Root';
        const bytes = Number(details.size);
        const role = codeCityFileRole(relative, descriptor);
        files.push({
          id: opaqueId('building', relative),
          path: relative,
          name: entry.name,
          district,
          extension: descriptor.extension,
          language: descriptor.language,
          role,
          purpose: codeCityFilePurpose(role, relative),
          bytes,
          depth: parts.length - 1
        });
        if (analyzedBytes < MAX_ANALYSIS_TOTAL_BYTES) {
          const sourceText = await boundedSourceText(canonicalRoot, canonicalFile, details, MAX_ANALYSIS_TOTAL_BYTES - analyzedBytes);
          if (sourceText) {
            analysisByPath.set(relative, sourceText);
            analyzedBytes += Buffer.byteLength(sourceText);
            if (details.size > Buffer.byteLength(sourceText)) analysisTruncated = true;
          }
        } else {
          analysisTruncated = true;
        }
        const totals = districtTotals.get(district) || { fileCount: 0, totalBytes: 0 };
        totals.fileCount += 1;
        totals.totalBytes += bytes;
        districtTotals.set(district, totals);
        if (files.length >= bounded.maxFiles) {
          truncated = true;
          break;
        }
      }
    } finally {
      await directory.close().catch(() => {});
    }
  }
  if (queue.length) truncated = true;
  for (const file of files) file.analysis = codeCityFileAnalysis(file, analysisByPath.get(file.path) || '');
  assignCodeCityDistricts(files);
  districtTotals.clear();
  for (const file of files) {
    const totals = districtTotals.get(file.district) || { fileCount: 0, totalBytes: 0 };
    totals.fileCount += 1;
    totals.totalBytes += file.bytes;
    districtTotals.set(file.district, totals);
  }
  files.sort((left, right) => left.district.localeCompare(right.district) || left.path.localeCompare(right.path));
  const relationshipResult = buildCodeCityConnections(files, analysisByPath);
  analysisTruncated ||= relationshipResult.truncated;
  const connections = relationshipResult.connections;
  const fileById = new Map(files.map((file) => [file.id, file]));
  for (const file of files.filter((candidate) => candidate.role === 'test')) {
    const targetRoles = new Set(connections
      .filter((connection) => connection.fromId === file.id && connection.kind === 'test')
      .map((connection) => fileById.get(connection.toId)?.role)
      .filter(Boolean));
    if (targetRoles.has('ui') && targetRoles.has('backend')) file.purpose = 'Automated full-stack or integration test';
    else if (targetRoles.has('ui')) file.purpose = 'Automated UI or interaction test';
    else if (targetRoles.has('backend')) file.purpose = 'Automated backend or API test';
  }
  const districts = [...districtTotals.entries()]
    .map(([name, totals]) => ({ id: opaqueId('district', name), name, ...totals }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const snapshot = {
    version: CODE_CITY_VERSION,
    generatedAt: at,
    rootName: String(rootName || path.basename(canonicalRoot)).slice(0, 160),
    files,
    districts,
    connections,
    summary: {
      fileCount: files.length,
      districtCount: districts.length,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      directoriesVisited,
      skippedEntries,
      truncated,
      analyzedFileCount: analysisByPath.size,
      connectionCount: connections.length,
      roleCounts: Object.fromEntries([...CODE_CITY_ROLES].map((role) => [role, files.filter((file) => file.role === role).length])),
      semanticRoleCounts: Object.fromEntries([...CODE_CITY_SEMANTIC_ROLES].map((role) => [role, files.filter((file) => file.analysis.semanticRole === role).length])),
      signalCounts: Object.fromEntries([...CODE_CITY_SOURCE_SIGNALS].map((signal) => [signal, files.filter((file) => file.analysis.signals.includes(signal)).length])),
      flowCounts: Object.fromEntries([...CODE_CITY_CONNECTION_KINDS].map((kind) => [kind, connections.filter((connection) => connection.kind === kind).length])),
      analysisTruncated
    },
    privacy: {
      sourceAnalyzedLocally: true,
      sourceContentIncluded: false,
      absolutePathsIncluded: false,
      externalRequestsRequired: false
    },
    digest: ''
  };
  snapshot.digest = snapshotDigest(snapshot);
  return validateCodeCitySnapshot(snapshot);
}
