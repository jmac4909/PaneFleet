import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  lstat,
  open,
  realpath
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

export const PLANNING_CODEX_REQUIRED_VERSION = '0.147.0';
export const PLANNING_CODEX_MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;

const execFileAsync = promisify(execFile);
const OFFICIAL_REPOSITORY = Object.freeze({
  type: 'git',
  url: 'git+https://github.com/openai/codex.git',
  directory: 'codex-cli'
});
const INSTALL_TEMPLATE_TOKENS = Object.freeze([
  '@ROOT@',
  '@NODE@',
  '@NODE_DIR@',
  '@HOME@',
  '@HOST@',
  '@PORT@',
  '@PLANNING_CODEX_MODE@',
  '@PLANNING_CODEX_EXECUTABLE@',
  '@PLANNING_CODEX_VERSION@',
  '@PLANNING_CODEX_SHA256@'
]);
const TARGETS = Object.freeze({
  'linux:x64': Object.freeze({
    packageName: '@openai/codex-linux-x64',
    packageVersion: `${PLANNING_CODEX_REQUIRED_VERSION}-linux-x64`,
    targetTriple: 'x86_64-unknown-linux-musl',
    os: 'linux',
    cpu: 'x64',
    elfMachine: 62
  }),
  'linux:arm64': Object.freeze({
    packageName: '@openai/codex-linux-arm64',
    packageVersion: `${PLANNING_CODEX_REQUIRED_VERSION}-linux-arm64`,
    targetTriple: 'aarch64-unknown-linux-musl',
    os: 'linux',
    cpu: 'arm64',
    elfMachine: 183
  })
});

function resolverError(code, cause = undefined) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function exactRepository(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.type === OFFICIAL_REPOSITORY.type
    && value.url === OFFICIAL_REPOSITORY.url
    && value.directory === OFFICIAL_REPOSITORY.directory;
}

function trustedOwner(details) {
  return typeof process.getuid !== 'function' || details.uid === process.getuid() || details.uid === 0;
}

function exactArray(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function safeAbsolutePath(value, code) {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || !path.isAbsolute(value)
    || path.normalize(value) !== value
    || /[\u0000-\u001f\u007f]/.test(value)
    || INSTALL_TEMPLATE_TOKENS.some((token) => value.includes(token))
  ) throw resolverError(code);
  return value;
}

async function trustedJson(filePath, code) {
  const candidate = safeAbsolutePath(filePath, code);
  let lexical;
  let canonical;
  try {
    [lexical, canonical] = await Promise.all([lstat(candidate), realpath(candidate)]);
  } catch (cause) {
    throw resolverError(code, cause);
  }
  if (
    canonical !== candidate
    || !lexical.isFile()
    || lexical.isSymbolicLink()
    || lexical.nlink !== 1
    || !trustedOwner(lexical)
    || (lexical.mode & 0o022) !== 0
    || lexical.size < 2
    || lexical.size > 64 * 1024
  ) throw resolverError(code);
  let contents;
  let handle;
  try {
    handle = await open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (cause) {
    throw resolverError(code, cause);
  }
  try {
    const before = await handle.stat();
    if (!sameFile(lexical, before)) throw resolverError(code);
    contents = await handle.readFile('utf8');
    const after = await handle.stat();
    const [pathAfter, canonicalAfter] = await Promise.all([lstat(candidate), realpath(candidate)]);
    if (
      !sameFile(before, after)
      || !sameFile(after, pathAfter)
      || canonicalAfter !== candidate
    ) throw resolverError(code);
  } catch (cause) {
    if (cause?.code === code) throw cause;
    throw resolverError(code, cause);
  } finally {
    await handle.close();
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (cause) {
    throw resolverError(code, cause);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw resolverError(code);
  return parsed;
}

function targetFor(platform, architecture) {
  const target = TARGETS[`${platform}:${architecture}`];
  if (!target) throw resolverError('planning_codex_platform_unsupported');
  return target;
}

function sameFile(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mode === after.mode
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

async function hashHandle(handle, size) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (bytesRead < 1) throw resolverError('planning_codex_executable_changed');
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest('hex');
}

function assertNativeHeader(header, target) {
  if (
    header.length < 64
    || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    || header[4] !== 2
    || header[5] !== 1
    || ![2, 3].includes(header.readUInt16LE(16))
  ) throw resolverError('planning_codex_executable_not_native');
  if (header.readUInt16LE(18) !== target.elfMachine) {
    throw resolverError('planning_codex_executable_arch_mismatch');
  }
}

async function exactCodexVersion(candidate) {
  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(candidate, ['--version'], {
      encoding: 'utf8',
      env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
      maxBuffer: 4096,
      timeout: 5000,
      windowsHide: true
    }));
  } catch (cause) {
    throw resolverError('planning_codex_executable_version_unavailable', cause);
  }
  if (stdout !== `codex-cli ${PLANNING_CODEX_REQUIRED_VERSION}\n` || stderr !== '') {
    throw resolverError('planning_codex_executable_version_mismatch');
  }
  return PLANNING_CODEX_REQUIRED_VERSION;
}

async function validateNativeCodex(candidateValue, target) {
  const candidate = safeAbsolutePath(candidateValue, 'planning_codex_executable_invalid');
  let lexical;
  let canonical;
  try {
    [lexical, canonical] = await Promise.all([lstat(candidate), realpath(candidate)]);
  } catch (cause) {
    throw resolverError('planning_codex_executable_unavailable', cause);
  }
  if (
    canonical !== candidate
    || !lexical.isFile()
    || lexical.isSymbolicLink()
    || lexical.nlink !== 1
    || !trustedOwner(lexical)
    || lexical.size < 1
    || lexical.size > PLANNING_CODEX_MAX_EXECUTABLE_BYTES
    || (lexical.mode & 0o022) !== 0
    || (lexical.mode & 0o111) === 0
  ) throw resolverError('planning_codex_executable_untrusted');

  let handle;
  try {
    handle = await open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (cause) {
    throw resolverError('planning_codex_executable_untrusted', cause);
  }
  try {
    const before = await handle.stat();
    if (!sameFile(lexical, before)) throw resolverError('planning_codex_executable_changed');
    const header = Buffer.alloc(64);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    assertNativeHeader(header.subarray(0, bytesRead), target);
    const sha256 = await hashHandle(handle, before.size);
    const version = await exactCodexVersion(candidate);
    const after = await handle.stat();
    const [pathAfter, canonicalAfter] = await Promise.all([lstat(candidate), realpath(candidate)]);
    if (
      !sameFile(before, after)
      || !sameFile(after, pathAfter)
      || canonicalAfter !== candidate
    ) throw resolverError('planning_codex_executable_changed');
    return Object.freeze({ path: canonical, version, sha256 });
  } finally {
    await handle.close();
  }
}

export function defaultPlanningCodexWrapperPackagePaths(nodeExecutable = process.execPath) {
  const candidates = [];
  try {
    candidates.push(createRequire(import.meta.url).resolve('@openai/codex/package.json'));
  } catch {
    // A project-local Codex package is optional; the Node installation may own it globally.
  }
  const nodePath = safeAbsolutePath(nodeExecutable, 'planning_codex_node_executable_invalid');
  candidates.push(path.resolve(path.dirname(nodePath), '..', 'lib', 'node_modules', '@openai', 'codex', 'package.json'));
  return [...new Set(candidates)];
}

async function officialPlatformExecutable(wrapperPackagePath, target) {
  const wrapper = await trustedJson(wrapperPackagePath, 'planning_codex_wrapper_untrusted');
  const expectedDependency = `npm:@openai/codex@${target.packageVersion}`;
  if (
    wrapper.name !== '@openai/codex'
    || wrapper.version !== PLANNING_CODEX_REQUIRED_VERSION
    || !exactRepository(wrapper.repository)
    || wrapper.optionalDependencies?.[target.packageName] !== expectedDependency
  ) throw resolverError('planning_codex_wrapper_mismatch');

  const wrapperRoot = path.dirname(wrapperPackagePath);
  const requireFromWrapper = createRequire(wrapperPackagePath);
  const platformCandidates = [];
  try {
    platformCandidates.push(requireFromWrapper.resolve(`${target.packageName}/package.json`));
  } catch {
    // Exact lexical fallbacks cover npm's nested and sibling optional dependency layouts.
  }
  platformCandidates.push(
    path.join(wrapperRoot, 'node_modules', ...target.packageName.split('/'), 'package.json'),
    path.join(path.dirname(wrapperRoot), path.basename(target.packageName), 'package.json')
  );

  let firstError = null;
  for (const packagePath of new Set(platformCandidates)) {
    try {
      const platformPackage = await trustedJson(packagePath, 'planning_codex_platform_package_untrusted');
      if (
        platformPackage.name !== '@openai/codex'
        || platformPackage.version !== target.packageVersion
        || !exactArray(platformPackage.os, [target.os])
        || !exactArray(platformPackage.cpu, [target.cpu])
        || !exactRepository(platformPackage.repository)
      ) throw resolverError('planning_codex_platform_package_mismatch');
      const platformRoot = await realpath(path.dirname(packagePath));
      return path.join(platformRoot, 'vendor', target.targetTriple, 'bin', 'codex');
    } catch (error) {
      firstError ||= error;
    }
  }
  throw firstError || resolverError('planning_codex_platform_package_unavailable');
}

export async function resolvePlanningCodex({
  executableOverride = process.env.ORCH_PLANNING_CODEX_EXECUTABLE || '',
  wrapperPackagePaths = defaultPlanningCodexWrapperPackagePaths(),
  platform = process.platform,
  architecture = process.arch
} = {}) {
  const target = targetFor(platform, architecture);
  if (executableOverride) {
    return Object.freeze({
      ...await validateNativeCodex(executableOverride, target),
      source: 'override'
    });
  }
  if (!Array.isArray(wrapperPackagePaths) || !wrapperPackagePaths.length) {
    throw resolverError('planning_codex_wrapper_unavailable');
  }
  let firstError = null;
  for (const wrapperPackagePath of wrapperPackagePaths) {
    try {
      const candidate = await officialPlatformExecutable(
        safeAbsolutePath(wrapperPackagePath, 'planning_codex_wrapper_untrusted'),
        target
      );
      return Object.freeze({
        ...await validateNativeCodex(candidate, target),
        source: 'official-package'
      });
    } catch (error) {
      firstError ||= error;
    }
  }
  throw firstError || resolverError('planning_codex_wrapper_unavailable');
}

async function main() {
  const resolved = await resolvePlanningCodex();
  process.stdout.write(`${resolved.path}\t${resolved.version}\t${resolved.sha256}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error?.code || 'planning_codex_resolution_failed'}\n`);
    process.exitCode = 1;
  });
}
