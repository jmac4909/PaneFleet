import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

import { canonicalSha256 } from './delivery-plan.js';

export const WORKSPACE_BASELINE_VERSION = 2;

const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 1000,
  maxIndexEntries: 100_000,
  maxIgnoredEntries: 1000,
  maxApprovedScopes: 128,
  maxGitMetadataBytes: 16 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxInstructionFiles: 32,
  maxInstructionBytes: 2 * 1024 * 1024
});
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STATUS_PATTERN = /^[ MADRCUT?!]{2}$/;
const GIT_OBJECT_FORMATS = new Set(['sha1', 'sha256']);
const GIT_INDEX_MODES = new Set(['040000', '100644', '100755', '120000', '160000']);
const GIT_INDEX_TAG_PATTERN = /^[HSMRCK?hsmrck]$/;

function baselineError(code, detail = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, detail);
  return error;
}

function validTimestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return typeof value === 'string'
    && Number.isFinite(parsed)
    && value === new Date(parsed).toISOString();
}

function normalizedRepoPath(value, field = 'path') {
  const result = String(value ?? '').replaceAll('\\', '/');
  if (
    !result
    || result.includes('\0')
    || result.includes('\uFFFD')
    || path.posix.isAbsolute(result)
    || result.split('/').some((segment) => !segment || segment === '.' || segment === '..' || segment === '.git')
  ) {
    throw baselineError(`workspace_baseline_${field}_invalid`);
  }
  return result;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, code) {
  if (!plainObject(value)) throw baselineError(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw baselineError(code);
  }
}

function normalizedAbsolutePath(value, field) {
  const candidate = String(value ?? '');
  if (
    !candidate
    || candidate.includes('\0')
    || candidate.includes('\uFFFD')
    || !path.isAbsolute(candidate)
    || path.normalize(candidate) !== candidate
  ) throw baselineError(`workspace_baseline_git_${field}_invalid`);
  return candidate;
}

function validGitHeadRef(value) {
  if (!value.startsWith('refs/heads/') || value.length > 1024) return false;
  const branch = value.slice('refs/heads/'.length);
  return Boolean(branch)
    && !branch.startsWith('.')
    && !branch.endsWith('.')
    && !branch.endsWith('/')
    && !branch.includes('..')
    && !branch.includes('@{')
    && !branch.includes('//')
    && !/[\x00-\x20\x7f~^:?*[\\]/.test(branch)
    && !branch.split('/').some((segment) => !segment || segment.endsWith('.lock'));
}

function nullDelimitedTokens(value, code) {
  if (typeof value !== 'string') throw baselineError(code);
  if (!value) return [];
  if (!value.endsWith('\0')) throw baselineError(code);
  const tokens = value.slice(0, -1).split('\0');
  if (tokens.some((token) => !token)) throw baselineError(code);
  return tokens;
}

function exactPathWithin(root, relativePath) {
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw baselineError('workspace_baseline_path_outside_repository');
  }
  return candidate;
}

function isSameOrChild(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonicalRepositoryRoot(repoRoot) {
  let resolved;
  try {
    resolved = await realpath(repoRoot);
  } catch (cause) {
    throw baselineError('workspace_baseline_repository_unavailable', { cause });
  }
  if (resolved !== repoRoot) throw baselineError('workspace_baseline_repository_symlink_rejected');
  return resolved;
}

async function assertResolvedParentWithinRepository(absolutePath, repoRoot) {
  const relativeParent = path.relative(repoRoot, path.dirname(absolutePath));
  if (relativeParent === '..' || relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) {
    throw baselineError('workspace_baseline_path_outside_repository');
  }
  let candidate = repoRoot;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    candidate = path.join(candidate, segment);
    try {
      const details = await lstat(candidate);
      if (details.isSymbolicLink()) throw baselineError('workspace_baseline_parent_symlink_rejected');
      if (!details.isDirectory()) throw baselineError('workspace_baseline_parent_type_invalid');
      const resolved = await realpath(candidate);
      if (resolved !== candidate) throw baselineError('workspace_baseline_parent_symlink_rejected');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      if (error?.code?.startsWith?.('workspace_baseline_')) throw error;
      throw baselineError('workspace_baseline_file_unavailable', { cause: error });
    }
  }
}

async function assertOpenedFileWithinRepository(handle, repoRoot, expectedPath) {
  let resolved;
  try {
    resolved = await realpath(`/proc/self/fd/${handle.fd}`);
  } catch (cause) {
    throw baselineError('workspace_baseline_file_unstable', { cause });
  }
  const openedPath = resolved.replace(/ \(deleted\)$/, '');
  if (!isSameOrChild(openedPath, repoRoot)) {
    throw baselineError('workspace_baseline_symlink_escape');
  }
  if (openedPath !== expectedPath) throw baselineError('workspace_baseline_path_alias_rejected');
}

async function assertOpenedInstructionExact(handle, expectedPath) {
  let resolved;
  try {
    resolved = await realpath(`/proc/self/fd/${handle.fd}`);
  } catch (cause) {
    throw baselineError('workspace_baseline_instruction_unstable', { cause });
  }
  if (resolved.replace(/ \(deleted\)$/, '') !== expectedPath) {
    throw baselineError('workspace_baseline_instruction_path_alias_rejected');
  }
}

function boundedInteger(value, fallback, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw baselineError(`workspace_baseline_${field}_invalid`);
  }
  return result;
}

function normalizedLimits(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw baselineError('workspace_baseline_limits_invalid');
  }
  return {
    maxEntries: boundedInteger(value.maxEntries, DEFAULT_LIMITS.maxEntries, 'max_entries', { max: 10_000 }),
    maxIndexEntries: boundedInteger(value.maxIndexEntries, DEFAULT_LIMITS.maxIndexEntries, 'max_index_entries', { max: 1_000_000 }),
    maxIgnoredEntries: boundedInteger(value.maxIgnoredEntries, DEFAULT_LIMITS.maxIgnoredEntries, 'max_ignored_entries', { max: 10_000 }),
    maxApprovedScopes: boundedInteger(value.maxApprovedScopes, DEFAULT_LIMITS.maxApprovedScopes, 'max_approved_scopes', { max: 1024 }),
    maxGitMetadataBytes: boundedInteger(value.maxGitMetadataBytes, DEFAULT_LIMITS.maxGitMetadataBytes, 'max_git_metadata_bytes'),
    maxFileBytes: boundedInteger(value.maxFileBytes, DEFAULT_LIMITS.maxFileBytes, 'max_file_bytes'),
    maxTotalBytes: boundedInteger(value.maxTotalBytes, DEFAULT_LIMITS.maxTotalBytes, 'max_total_bytes'),
    maxInstructionFiles: boundedInteger(value.maxInstructionFiles, DEFAULT_LIMITS.maxInstructionFiles, 'max_instruction_files', { max: 128 }),
    maxInstructionBytes: boundedInteger(value.maxInstructionBytes, DEFAULT_LIMITS.maxInstructionBytes, 'max_instruction_bytes')
  };
}

function sha256Text(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function parseWorkspaceGitIndex(value, {
  objectFormat = 'sha1',
  maxEntries = DEFAULT_LIMITS.maxIndexEntries
} = {}) {
  if (!GIT_OBJECT_FORMATS.has(objectFormat)) throw baselineError('workspace_baseline_git_object_format_invalid');
  const digestLength = objectFormat === 'sha256' ? 64 : 40;
  const tokens = nullDelimitedTokens(value, 'workspace_baseline_git_index_invalid');
  if (tokens.length > maxEntries) throw baselineError('workspace_baseline_git_index_limit_exceeded');
  const entries = tokens.map((token) => {
    const match = /^(\d{6}) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(token);
    if (!match || !GIT_INDEX_MODES.has(match[1]) || match[2].length !== digestLength) {
      throw baselineError('workspace_baseline_git_index_invalid');
    }
    return {
      mode: match[1],
      oid: match[2],
      stage: Number(match[3]),
      path: normalizedRepoPath(match[4]),
      gitlink: match[1] === '160000',
      sparseDirectory: match[1] === '040000'
    };
  });
  const keys = entries.map((entry) => `${entry.stage}\0${entry.path}`);
  if (new Set(keys).size !== keys.length) throw baselineError('workspace_baseline_git_index_duplicate');
  return entries.sort((left, right) => left.path.localeCompare(right.path) || left.stage - right.stage);
}

export function parseWorkspaceGitIndexFlags(value, {
  maxEntries = DEFAULT_LIMITS.maxIndexEntries
} = {}) {
  const tokens = nullDelimitedTokens(value, 'workspace_baseline_git_index_flags_invalid');
  if (tokens.length > maxEntries) throw baselineError('workspace_baseline_git_index_flags_limit_exceeded');
  const entries = tokens.map((token) => {
    if (token.length < 3 || token[1] !== ' ' || !GIT_INDEX_TAG_PATTERN.test(token[0])) {
      throw baselineError('workspace_baseline_git_index_flags_invalid');
    }
    const tag = token[0];
    return {
      tag,
      path: normalizedRepoPath(token.slice(2)),
      assumeUnchanged: tag !== tag.toUpperCase(),
      skipWorktree: tag.toUpperCase() === 'S'
    };
  });
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw baselineError('workspace_baseline_git_index_flags_duplicate');
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export function parseWorkspaceIgnoredPaths(value, {
  maxEntries = DEFAULT_LIMITS.maxIgnoredEntries
} = {}) {
  const tokens = nullDelimitedTokens(value, 'workspace_baseline_git_ignored_scope_invalid');
  if (tokens.length > maxEntries) throw baselineError('workspace_baseline_git_ignored_scope_limit_exceeded');
  const entries = tokens.map((token) => {
    const directory = token.endsWith('/');
    return {
      path: normalizedRepoPath(directory ? token.slice(0, -1) : token),
      directory
    };
  });
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw baselineError('workspace_baseline_git_ignored_scope_duplicate');
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export function parseWorkspaceGitUntracked(value, {
  maxEntries = DEFAULT_LIMITS.maxEntries
} = {}) {
  const tokens = nullDelimitedTokens(value, 'workspace_baseline_git_untracked_invalid');
  if (tokens.length > maxEntries) throw baselineError('workspace_baseline_git_untracked_limit_exceeded');
  const paths = tokens.map((token) => normalizedRepoPath(token));
  if (new Set(paths).size !== paths.length) throw baselineError('workspace_baseline_git_untracked_duplicate');
  return paths.sort();
}

export function validateWorkspaceGitMetadata(value, {
  repoRoot,
  head,
  branch,
  detached
} = {}) {
  exactKeys(value, [
    'repoRoot',
    'gitDir',
    'commonDir',
    'objectFormat',
    'headRef',
    'sparseCheckout',
    'sparseIndex'
  ], 'workspace_baseline_git_metadata_invalid');
  const metadata = {
    repoRoot: normalizedAbsolutePath(value.repoRoot, 'repo_root'),
    gitDir: normalizedAbsolutePath(value.gitDir, 'dir'),
    commonDir: normalizedAbsolutePath(value.commonDir, 'common_dir'),
    objectFormat: String(value.objectFormat ?? ''),
    headRef: String(value.headRef ?? ''),
    sparseCheckout: value.sparseCheckout,
    sparseIndex: value.sparseIndex
  };
  if (!GIT_OBJECT_FORMATS.has(metadata.objectFormat)) throw baselineError('workspace_baseline_git_object_format_invalid');
  if (metadata.headRef && !validGitHeadRef(metadata.headRef)) throw baselineError('workspace_baseline_git_head_ref_invalid');
  if (typeof metadata.sparseCheckout !== 'boolean' || typeof metadata.sparseIndex !== 'boolean') {
    throw baselineError('workspace_baseline_git_sparse_state_invalid');
  }
  if (repoRoot !== undefined && metadata.repoRoot !== repoRoot) {
    throw baselineError('workspace_baseline_git_repository_identity_mismatch');
  }
  if (!isSameOrChild(metadata.gitDir, metadata.repoRoot) || !isSameOrChild(metadata.commonDir, metadata.repoRoot)) {
    throw baselineError('workspace_baseline_git_directory_outside_repository');
  }
  const expectedBranch = metadata.headRef ? metadata.headRef.slice('refs/heads/'.length) : '';
  const expectedDetached = !metadata.headRef;
  if (branch !== undefined && branch !== expectedBranch) throw baselineError('workspace_baseline_git_branch_mismatch');
  if (detached !== undefined && detached !== expectedDetached) throw baselineError('workspace_baseline_git_detached_mismatch');
  if (head !== undefined) {
    const expectedLength = metadata.objectFormat === 'sha256' ? 64 : 40;
    if (head === 'unborn') {
      if (!metadata.headRef || expectedDetached) throw baselineError('workspace_baseline_git_head_state_invalid');
    } else if (typeof head !== 'string' || head.length !== expectedLength || !/^[a-f0-9]+$/.test(head)) {
      throw baselineError('workspace_baseline_git_head_state_invalid');
    }
  }
  return metadata;
}

async function assertCanonicalOwnedGitDirectory(directory, code) {
  let details;
  let resolved;
  try {
    [details, resolved] = await Promise.all([
      lstat(directory, { bigint: true }),
      realpath(directory)
    ]);
  } catch (cause) {
    throw baselineError(code, { cause });
  }
  const currentUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : details.uid;
  if (
    !details.isDirectory()
    || resolved !== directory
    || details.uid !== currentUid
    || (details.mode & 0o022n) !== 0n
  ) throw baselineError(code);
}

export async function validateWorkspaceGitMetadataTrust(value, expected = {}) {
  const metadata = validateWorkspaceGitMetadata(value, expected);
  await canonicalRepositoryRoot(metadata.repoRoot);
  await assertCanonicalOwnedGitDirectory(metadata.gitDir, 'workspace_baseline_git_directory_untrusted');
  if (metadata.commonDir !== metadata.gitDir) {
    await assertCanonicalOwnedGitDirectory(metadata.commonDir, 'workspace_baseline_git_common_directory_untrusted');
  }
  return metadata;
}

function canonicalApprovedScopes(values, limits) {
  if (!Array.isArray(values) || values.length > limits.maxApprovedScopes) {
    throw baselineError('workspace_baseline_approved_scopes_invalid');
  }
  const scopes = values.map((value) => {
    const candidate = String(value ?? '');
    const normalized = normalizedScope(candidate);
    if (candidate !== normalized) throw baselineError('workspace_baseline_approved_scope_not_canonical');
    return normalized;
  });
  if (new Set(scopes).size !== scopes.length) throw baselineError('workspace_baseline_approved_scope_duplicate');
  const sorted = [...scopes].sort();
  if (sorted.some((scope, index) => scope !== scopes[index])) {
    throw baselineError('workspace_baseline_approved_scopes_not_sorted');
  }
  return scopes;
}

function assertIgnoredScopeResults(ignoredEntries) {
  if (ignoredEntries.length) {
    throw baselineError('workspace_baseline_ignored_paths_present', { ignoredCount: ignoredEntries.length });
  }
}

function trackedStatus(indexEntry, fingerprint) {
  if (fingerprint.type === 'missing') return ' D';
  const expectedType = indexEntry.mode === '120000' ? 'symlink' : 'file';
  if (fingerprint.type !== expectedType) return ' T';
  if (fingerprint.worktreeMode !== indexEntry.mode || fingerprint.gitOid !== indexEntry.oid) return ' M';
  return '  ';
}

function publicFingerprint(fingerprint) {
  return {
    type: fingerprint.type,
    size: fingerprint.size,
    sha256: fingerprint.sha256
  };
}

function gitBlobHash(objectFormat, size) {
  const hash = createHash(objectFormat);
  hash.update(`blob ${size}\0`, 'utf8');
  return hash;
}

async function hashOpenedFile(handle, maximumBytes, unstableCode, objectFormat = '') {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile()) throw baselineError('workspace_baseline_file_type_invalid');
  if (before.nlink !== 1n) throw baselineError('workspace_baseline_hardlink_rejected');
  if (before.size > BigInt(maximumBytes)) throw baselineError('workspace_baseline_file_too_large');
  const hash = createHash('sha256');
  const objectHash = objectFormat ? gitBlobHash(objectFormat, before.size) : null;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < Number(before.size)) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - position), position);
    if (!bytesRead) throw baselineError(unstableCode);
    hash.update(buffer.subarray(0, bytesRead));
    objectHash?.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs
    || before.nlink !== after.nlink
  ) {
    throw baselineError(unstableCode);
  }
  return {
    sha256: hash.digest('hex'),
    size: Number(before.size),
    ...(objectHash ? {
      gitOid: objectHash.digest('hex'),
      worktreeMode: before.mode & 0o111n ? '100755' : '100644'
    } : {})
  };
}

async function fingerprintPath(repoRoot, repoPath, limits, byteCounter, objectFormat = '') {
  const absolutePath = exactPathWithin(repoRoot, repoPath);
  await assertResolvedParentWithinRepository(absolutePath, repoRoot);
  let before;
  try {
    before = await lstat(absolutePath, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { type: 'missing', size: 0, sha256: sha256Text('missing'), gitOid: '', worktreeMode: '' };
    }
    throw baselineError('workspace_baseline_file_unavailable', { cause: error });
  }
  if (before.isSymbolicLink()) {
    let target;
    let after;
    try {
      target = await readlink(absolutePath);
      after = await lstat(absolutePath, { bigint: true });
    } catch (cause) {
      throw baselineError('workspace_baseline_symlink_unstable', { cause });
    }
    if (
      !after.isSymbolicLink()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) throw baselineError('workspace_baseline_symlink_unstable');
    const resolvedTarget = path.resolve(path.dirname(absolutePath), target);
    if (!isSameOrChild(resolvedTarget, repoRoot)) throw baselineError('workspace_baseline_symlink_escape');
    const size = Buffer.byteLength(target, 'utf8');
    byteCounter.total += size;
    if (byteCounter.total > limits.maxTotalBytes) throw baselineError('workspace_baseline_total_bytes_exceeded');
    const objectHash = objectFormat ? gitBlobHash(objectFormat, size).update(target, 'utf8').digest('hex') : '';
    return { type: 'symlink', size, sha256: sha256Text(`symlink:${target}`), gitOid: objectHash, worktreeMode: '120000' };
  }
  if (!before.isFile()) throw baselineError('workspace_baseline_file_type_invalid');
  if (before.nlink !== 1n) throw baselineError('workspace_baseline_hardlink_rejected');
  let handle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw baselineError('workspace_baseline_file_unstable', { cause: error });
    }
    if (error?.code === 'ELOOP') throw baselineError('workspace_baseline_file_unstable', { cause: error });
    throw baselineError('workspace_baseline_file_unavailable', { cause: error });
  }
  try {
    await assertOpenedFileWithinRepository(handle, repoRoot, absolutePath);
    const opened = await handle.stat({ bigint: true });
    if (before.dev !== opened.dev || before.ino !== opened.ino) throw baselineError('workspace_baseline_file_unstable');
    const fingerprint = await hashOpenedFile(handle, limits.maxFileBytes, 'workspace_baseline_file_unstable', objectFormat);
    byteCounter.total += fingerprint.size;
    if (byteCounter.total > limits.maxTotalBytes) throw baselineError('workspace_baseline_total_bytes_exceeded');
    return { type: 'file', ...fingerprint };
  } finally {
    await handle.close();
  }
}

async function fingerprintInstruction(candidate, limits, byteCounter) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw baselineError('workspace_baseline_instruction_invalid');
  }
  const filePath = String(candidate.path ?? '');
  const label = String(candidate.label ?? '').replaceAll('\\', '/');
  if (!path.isAbsolute(filePath) || !label || label.includes('\0') || label.includes('\uFFFD')) {
    throw baselineError('workspace_baseline_instruction_invalid');
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (cause) {
    if (cause?.code === 'ELOOP') throw baselineError('workspace_baseline_instruction_symlink_rejected', { cause });
    throw baselineError('workspace_baseline_instruction_unavailable', { cause });
  }
  try {
    await assertOpenedInstructionExact(handle, filePath);
    const fingerprint = await hashOpenedFile(handle, limits.maxInstructionBytes, 'workspace_baseline_instruction_unstable');
    byteCounter.total += fingerprint.size;
    if (byteCounter.total > limits.maxTotalBytes) throw baselineError('workspace_baseline_total_bytes_exceeded');
    return { path: label, size: fingerprint.size, sha256: fingerprint.sha256 };
  } finally {
    await handle.close();
  }
}

function normalizedWorkspacePrefix(repoRoot, workspace) {
  const relative = path.relative(repoRoot, workspace);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw baselineError('workspace_baseline_workspace_outside_repository');
  }
  return relative.split(path.sep).filter(Boolean).join('/');
}

export async function captureWorkspaceBaseline({
  workspace,
  repoRoot,
  head,
  gitMetadata,
  indexOutput = '',
  indexFlagsOutput = '',
  untrackedOutput = '',
  approvedScopes = [],
  ignoredScopeOutput = '',
  instructionFiles = [],
  at = new Date().toISOString(),
  limits: limitOverrides = {}
} = {}) {
  const normalizedWorkspace = String(workspace ?? '');
  const normalizedRepoRoot = String(repoRoot ?? '');
  if (
    !path.isAbsolute(normalizedWorkspace)
    || !path.isAbsolute(normalizedRepoRoot)
    || path.normalize(normalizedWorkspace) !== normalizedWorkspace
    || path.normalize(normalizedRepoRoot) !== normalizedRepoRoot
  ) {
    throw baselineError('workspace_baseline_workspace_invalid');
  }
  if (!validTimestamp(at)) throw baselineError('workspace_baseline_timestamp_invalid');
  const normalizedHead = String(head || '').trim().toLowerCase();
  if (normalizedHead !== 'unborn' && !/^[a-f0-9]{40,64}$/.test(normalizedHead)) {
    throw baselineError('workspace_baseline_head_invalid');
  }
  const limits = normalizedLimits(limitOverrides);
  const metadataBytes = [indexOutput, indexFlagsOutput, untrackedOutput, ignoredScopeOutput]
    .reduce((total, value) => total + (typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : limits.maxGitMetadataBytes + 1), 0);
  if (metadataBytes > limits.maxGitMetadataBytes) throw baselineError('workspace_baseline_git_metadata_bytes_exceeded');
  const metadata = await validateWorkspaceGitMetadataTrust(gitMetadata, {
    repoRoot: normalizedRepoRoot,
    head: normalizedHead
  });
  if (metadata.sparseCheckout || metadata.sparseIndex) {
    throw baselineError('workspace_baseline_git_sparse_state_rejected');
  }
  let canonicalWorkspace;
  try {
    canonicalWorkspace = await realpath(normalizedWorkspace);
  } catch (cause) {
    throw baselineError('workspace_baseline_workspace_unavailable', { cause });
  }
  if (canonicalWorkspace !== normalizedWorkspace) throw baselineError('workspace_baseline_workspace_symlink_rejected');
  const workspacePrefix = normalizedWorkspacePrefix(normalizedRepoRoot, normalizedWorkspace);
  const canonicalScopes = canonicalApprovedScopes(approvedScopes, limits);
  const ignoredEntries = parseWorkspaceIgnoredPaths(ignoredScopeOutput, { maxEntries: limits.maxIgnoredEntries });
  assertIgnoredScopeResults(ignoredEntries);
  const indexEntries = parseWorkspaceGitIndex(indexOutput, {
    objectFormat: metadata.objectFormat,
    maxEntries: limits.maxIndexEntries
  });
  if (indexEntries.some((entry) => entry.gitlink)) throw baselineError('workspace_baseline_git_submodule_rejected');
  if (indexEntries.some((entry) => entry.sparseDirectory)) throw baselineError('workspace_baseline_git_sparse_index_rejected');
  if (indexEntries.some((entry) => entry.stage !== 0)) throw baselineError('workspace_baseline_git_unmerged_index_rejected');
  const flagEntries = parseWorkspaceGitIndexFlags(indexFlagsOutput, { maxEntries: limits.maxIndexEntries });
  if (flagEntries.some((entry) => entry.assumeUnchanged)) {
    throw baselineError('workspace_baseline_git_assume_unchanged_rejected');
  }
  if (flagEntries.some((entry) => entry.skipWorktree)) {
    throw baselineError('workspace_baseline_git_skip_worktree_rejected');
  }
  const indexPaths = indexEntries.map((entry) => entry.path).sort();
  const flagPaths = flagEntries.map((entry) => entry.path).sort();
  if (canonicalSha256(indexPaths) !== canonicalSha256(flagPaths)) {
    throw baselineError('workspace_baseline_git_index_flags_mismatch');
  }
  const untrackedPaths = parseWorkspaceGitUntracked(untrackedOutput, { maxEntries: limits.maxEntries });
  if (untrackedPaths.some((entryPath) => indexPaths.includes(entryPath))) {
    throw baselineError('workspace_baseline_git_untracked_index_overlap');
  }
  if (indexEntries.length + untrackedPaths.length > limits.maxEntries) {
    throw baselineError('workspace_baseline_entry_limit_exceeded');
  }
  if (!Array.isArray(instructionFiles) || instructionFiles.length > limits.maxInstructionFiles) {
    throw baselineError('workspace_baseline_instruction_limit_exceeded');
  }
  const byteCounter = { total: 0 };
  const entries = [];
  for (const indexEntry of indexEntries) {
    const fingerprint = await fingerprintPath(
      normalizedRepoRoot,
      indexEntry.path,
      limits,
      byteCounter,
      metadata.objectFormat
    );
    entries.push({
      status: trackedStatus(indexEntry, fingerprint),
      path: indexEntry.path,
      originalPath: '',
      ...publicFingerprint(fingerprint)
    });
  }
  for (const untrackedPath of untrackedPaths) {
    const fingerprint = await fingerprintPath(normalizedRepoRoot, untrackedPath, limits, byteCounter);
    if (fingerprint.type === 'missing') throw baselineError('workspace_baseline_git_untracked_unstable');
    entries.push({ status: '??', path: untrackedPath, originalPath: '', ...publicFingerprint(fingerprint) });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const instructions = [];
  for (const instruction of instructionFiles) {
    instructions.push(await fingerprintInstruction(instruction, limits, byteCounter));
  }
  instructions.sort((left, right) => left.path.localeCompare(right.path));
  const statusDigest = canonicalSha256(entries.map((entry) => ({
    status: entry.status,
    path: entry.path,
    originalPath: entry.originalPath
  })));
  const indexDigest = sha256Text(indexOutput);
  const indexFlagsDigest = sha256Text(indexFlagsOutput);
  const gitMetadataDigest = canonicalSha256(metadata);
  const ignoredScopeDigest = canonicalSha256({
    approvedScopes: canonicalScopes,
    outputDigest: sha256Text(ignoredScopeOutput)
  });
  const instructionsDigest = canonicalSha256(instructions);
  const workingTreeDigest = canonicalSha256({
    statusDigest,
    indexDigest,
    indexFlagsDigest,
    gitMetadataDigest,
    entries
  });
  const branch = metadata.headRef ? metadata.headRef.slice('refs/heads/'.length) : '';
  const detached = !metadata.headRef;
  const manifestDigest = canonicalSha256({
    version: WORKSPACE_BASELINE_VERSION,
    workspace: normalizedWorkspace,
    repoRoot: normalizedRepoRoot,
    workspacePrefix,
    head: normalizedHead,
    branch,
    detached,
    statusDigest,
    indexDigest,
    indexFlagsDigest,
    gitMetadata: metadata,
    gitMetadataDigest,
    approvedScopes: canonicalScopes,
    ignoredScopeDigest,
    entries,
    instructions
  });
  return {
    version: WORKSPACE_BASELINE_VERSION,
    workspace: normalizedWorkspace,
    repoRoot: normalizedRepoRoot,
    workspacePrefix,
    head: normalizedHead,
    branch,
    detached,
    workingTreeDigest,
    instructionsDigest,
    manifestDigest,
    statusDigest,
    indexDigest,
    indexFlagsDigest,
    gitMetadata: metadata,
    gitMetadataDigest,
    approvedScopes: canonicalScopes,
    ignoredScopeDigest,
    entries,
    instructions,
    capturedAt: at
  };
}

export function workspaceBaselineMatches(expected, current) {
  if (!expected || !current || typeof expected !== 'object' || typeof current !== 'object') return false;
  return ['head', 'workingTreeDigest', 'instructionsDigest'].every((field) => (
    typeof expected[field] === 'string'
    && expected[field].length > 0
    && expected[field] === current[field]
  ));
}

function baselineEntryKey(entry) {
  return canonicalSha256({
    status: entry.status,
    path: entry.path,
    originalPath: entry.originalPath,
    type: entry.type,
    size: entry.size,
    sha256: entry.sha256
  });
}

function toWorkspacePath(repoPath, workspacePrefix) {
  if (!workspacePrefix) return repoPath;
  if (repoPath === workspacePrefix) return '.';
  if (repoPath.startsWith(`${workspacePrefix}/`)) return repoPath.slice(workspacePrefix.length + 1);
  return `../${repoPath}`;
}

export function compareWorkspaceBaselines(before, after) {
  validateWorkspaceBaseline(before);
  validateWorkspaceBaseline(after);
  if (!before || !after || before.version !== WORKSPACE_BASELINE_VERSION || after.version !== WORKSPACE_BASELINE_VERSION) {
    throw baselineError('workspace_baseline_comparison_invalid');
  }
  if (
    before.workspace !== after.workspace
    || before.repoRoot !== after.repoRoot
    || before.workspacePrefix !== after.workspacePrefix
    || before.gitMetadata.repoRoot !== after.gitMetadata.repoRoot
    || before.gitMetadata.gitDir !== after.gitMetadata.gitDir
    || before.gitMetadata.commonDir !== after.gitMetadata.commonDir
    || before.gitMetadata.objectFormat !== after.gitMetadata.objectFormat
  ) {
    throw baselineError('workspace_baseline_identity_changed');
  }
  const beforeEntries = new Map(before.entries.map((entry) => [entry.path, baselineEntryKey(entry)]));
  const afterEntries = new Map(after.entries.map((entry) => [entry.path, baselineEntryKey(entry)]));
  const changedRepoPaths = new Set();
  for (const entry of before.entries) {
    if (afterEntries.get(entry.path) !== beforeEntries.get(entry.path)) changedRepoPaths.add(entry.path);
    if (entry.originalPath) changedRepoPaths.add(entry.originalPath);
  }
  for (const entry of after.entries) {
    if (beforeEntries.get(entry.path) !== afterEntries.get(entry.path)) changedRepoPaths.add(entry.path);
    if (entry.originalPath) changedRepoPaths.add(entry.originalPath);
  }
  const changedPaths = [...changedRepoPaths]
    .map((repoPath) => toWorkspacePath(repoPath, after.workspacePrefix))
    .sort();
  return {
    changedPaths,
    headChanged: before.head !== after.head,
    branchChanged: before.gitMetadata.headRef !== after.gitMetadata.headRef,
    indexChanged: before.indexDigest !== after.indexDigest || before.indexFlagsDigest !== after.indexFlagsDigest,
    indexFlagsChanged: before.indexFlagsDigest !== after.indexFlagsDigest,
    ignoredScopeChanged: before.ignoredScopeDigest !== after.ignoredScopeDigest,
    scopeCoverageChanged: canonicalSha256(before.approvedScopes) !== canonicalSha256(after.approvedScopes),
    instructionsChanged: before.instructionsDigest !== after.instructionsDigest,
    baselineChanged: before.manifestDigest !== after.manifestDigest
  };
}

function normalizedScope(value) {
  const scope = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!scope || path.posix.isAbsolute(scope) || scope.split('/').some((part) => part === '..' || part === '.git')) {
    throw baselineError('workspace_baseline_scope_invalid');
  }
  return scope;
}

export function workspaceScopeViolations(changedPaths, allowedPaths) {
  if (!Array.isArray(changedPaths) || !Array.isArray(allowedPaths) || !allowedPaths.length) {
    throw baselineError('workspace_baseline_scope_invalid');
  }
  const scopes = allowedPaths.map(normalizedScope);
  return [...new Set(changedPaths.map((value) => String(value ?? '').replaceAll('\\', '/')))]
    .filter((changedPath) => (
      !changedPath
      || changedPath === '..'
      || changedPath.startsWith('../')
      || !scopes.some((scope) => scope === '.' || changedPath === scope || changedPath.startsWith(`${scope}/`))
    ))
    .sort();
}

export function validateWorkspaceBaseline(value) {
  exactKeys(value, [
    'version',
    'workspace',
    'repoRoot',
    'workspacePrefix',
    'head',
    'branch',
    'detached',
    'workingTreeDigest',
    'instructionsDigest',
    'manifestDigest',
    'statusDigest',
    'indexDigest',
    'indexFlagsDigest',
    'gitMetadata',
    'gitMetadataDigest',
    'approvedScopes',
    'ignoredScopeDigest',
    'entries',
    'instructions',
    'capturedAt'
  ], 'workspace_baseline_invalid');
  if (value.version !== WORKSPACE_BASELINE_VERSION) throw baselineError('workspace_baseline_version_unsupported');
  if (
    !path.isAbsolute(String(value.workspace || ''))
    || !path.isAbsolute(String(value.repoRoot || ''))
    || path.normalize(value.workspace) !== value.workspace
    || path.normalize(value.repoRoot) !== value.repoRoot
    || normalizedWorkspacePrefix(value.repoRoot, value.workspace) !== value.workspacePrefix
  ) {
    throw baselineError('workspace_baseline_workspace_invalid');
  }
  const metadata = validateWorkspaceGitMetadata(value.gitMetadata, {
    repoRoot: value.repoRoot,
    head: value.head,
    branch: value.branch,
    detached: value.detached
  });
  if (metadata.sparseCheckout || metadata.sparseIndex) throw baselineError('workspace_baseline_git_sparse_state_rejected');
  for (const field of [
    'workingTreeDigest',
    'instructionsDigest',
    'manifestDigest',
    'statusDigest',
    'indexDigest',
    'indexFlagsDigest',
    'gitMetadataDigest',
    'ignoredScopeDigest'
  ]) {
    if (!SHA256_PATTERN.test(String(value[field] || ''))) throw baselineError('workspace_baseline_digest_invalid');
  }
  if (!validTimestamp(value.capturedAt)) throw baselineError('workspace_baseline_timestamp_invalid');
  if (!Array.isArray(value.entries) || !Array.isArray(value.instructions)) throw baselineError('workspace_baseline_invalid');
  const scopes = canonicalApprovedScopes(value.approvedScopes, normalizedLimits());
  const entries = value.entries.map((entry) => {
    exactKeys(entry, ['status', 'path', 'originalPath', 'type', 'size', 'sha256'], 'workspace_baseline_entry_invalid');
    const normalized = {
      status: String(entry.status ?? ''),
      path: normalizedRepoPath(entry.path),
      originalPath: entry.originalPath ? normalizedRepoPath(entry.originalPath, 'original_path') : '',
      type: String(entry.type ?? ''),
      size: Number(entry.size),
      sha256: String(entry.sha256 ?? '')
    };
    if (
      !STATUS_PATTERN.test(normalized.status)
      || !['file', 'missing', 'symlink'].includes(normalized.type)
      || !Number.isSafeInteger(normalized.size)
      || normalized.size < 0
      || !SHA256_PATTERN.test(normalized.sha256)
    ) throw baselineError('workspace_baseline_entry_invalid');
    return normalized;
  });
  const sortedEntries = [...entries].sort((left, right) => left.path.localeCompare(right.path) || left.originalPath.localeCompare(right.originalPath));
  if (canonicalSha256(entries) !== canonicalSha256(sortedEntries)) throw baselineError('workspace_baseline_entries_not_sorted');
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) throw baselineError('workspace_baseline_entry_duplicate');
  const instructions = value.instructions.map((instruction) => {
    exactKeys(instruction, ['path', 'size', 'sha256'], 'workspace_baseline_instruction_invalid');
    const normalized = {
      path: String(instruction.path ?? '').replaceAll('\\', '/'),
      size: Number(instruction.size),
      sha256: String(instruction.sha256 ?? '')
    };
    if (
      !normalized.path
      || normalized.path.includes('\0')
      || normalized.path.includes('\uFFFD')
      || !Number.isSafeInteger(normalized.size)
      || normalized.size < 0
      || !SHA256_PATTERN.test(normalized.sha256)
    ) throw baselineError('workspace_baseline_instruction_invalid');
    return normalized;
  });
  const sortedInstructions = [...instructions].sort((left, right) => left.path.localeCompare(right.path));
  if (canonicalSha256(instructions) !== canonicalSha256(sortedInstructions)) {
    throw baselineError('workspace_baseline_instructions_not_sorted');
  }
  if (new Set(instructions.map((instruction) => instruction.path)).size !== instructions.length) {
    throw baselineError('workspace_baseline_instruction_duplicate');
  }
  const gitMetadataDigest = canonicalSha256(metadata);
  const instructionsDigest = canonicalSha256(instructions);
  const statusDigest = canonicalSha256(entries.map((entry) => ({
    status: entry.status,
    path: entry.path,
    originalPath: entry.originalPath
  })));
  const ignoredScopeDigest = canonicalSha256({ approvedScopes: scopes, outputDigest: sha256Text('') });
  const workingTreeDigest = canonicalSha256({
    statusDigest: value.statusDigest,
    indexDigest: value.indexDigest,
    indexFlagsDigest: value.indexFlagsDigest,
    gitMetadataDigest: value.gitMetadataDigest,
    entries
  });
  const manifestDigest = canonicalSha256({
    version: value.version,
    workspace: value.workspace,
    repoRoot: value.repoRoot,
    workspacePrefix: value.workspacePrefix,
    head: value.head,
    branch: value.branch,
    detached: value.detached,
    statusDigest: value.statusDigest,
    indexDigest: value.indexDigest,
    indexFlagsDigest: value.indexFlagsDigest,
    gitMetadata: metadata,
    gitMetadataDigest: value.gitMetadataDigest,
    approvedScopes: scopes,
    ignoredScopeDigest: value.ignoredScopeDigest,
    entries,
    instructions
  });
  if (
    value.gitMetadataDigest !== gitMetadataDigest
    || value.instructionsDigest !== instructionsDigest
    || value.statusDigest !== statusDigest
    || value.ignoredScopeDigest !== ignoredScopeDigest
    || value.workingTreeDigest !== workingTreeDigest
    || value.manifestDigest !== manifestDigest
  ) throw baselineError('workspace_baseline_digest_mismatch');
  return structuredClone(value);
}
