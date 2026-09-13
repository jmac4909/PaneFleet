import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  captureWorkspaceBaseline,
  compareWorkspaceBaselines,
  parseWorkspaceGitIndex,
  parseWorkspaceGitIndexFlags,
  parseWorkspaceGitUntracked,
  parseWorkspaceIgnoredPaths,
  validateWorkspaceBaseline,
  validateWorkspaceGitMetadata,
  validateWorkspaceGitMetadataTrust,
  workspaceBaselineMatches,
  workspaceScopeViolations
} from '../workspace-baseline.js';

const AT = '2026-08-16T21:00:00.000Z';
const HEAD = '9'.repeat(40);
const TRACKED = 'tracked change\n';

function blobOid(content, algorithm = 'sha1') {
  const bytes = Buffer.from(content);
  return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function indexRecord(filePath, oid, mode = '100644', stage = 0) {
  return `${mode} ${oid} ${stage}\t${filePath}\0`;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panefleet-workspace-baseline-'));
  const workspace = path.join(root, 'repo');
  await mkdir(path.join(workspace, '.git'), { recursive: true });
  await writeFile(path.join(workspace, 'tracked.txt'), TRACKED);
  await writeFile(path.join(workspace, 'untracked.txt'), 'untracked\n');
  await writeFile(path.join(root, 'AGENTS.md'), 'safe instructions\n');
  return { root, workspace };
}

function gitMetadata(state, overrides = {}) {
  return {
    repoRoot: state.workspace,
    gitDir: path.join(state.workspace, '.git'),
    commonDir: path.join(state.workspace, '.git'),
    objectFormat: 'sha1',
    headRef: 'refs/heads/main',
    sparseCheckout: false,
    sparseIndex: false,
    ...overrides
  };
}

async function capture(state, overrides = {}) {
  return captureWorkspaceBaseline({
    workspace: state.workspace,
    repoRoot: state.workspace,
    head: HEAD,
    gitMetadata: gitMetadata(state),
    indexOutput: [
      indexRecord('deleted.txt', 'a'.repeat(40)),
      indexRecord('tracked.txt', blobOid(TRACKED))
    ].join(''),
    indexFlagsOutput: 'H deleted.txt\0H tracked.txt\0',
    untrackedOutput: 'untracked.txt\0',
    approvedScopes: [],
    ignoredScopeOutput: '',
    instructionFiles: [{ path: path.join(state.root, 'AGENTS.md'), label: '../AGENTS.md' }],
    at: AT,
    ...overrides
  });
}

test('raw Git metadata parsers are strict and deterministic', () => {
  assert.deepEqual(parseWorkspaceGitIndex(indexRecord('tracked.txt', 'a'.repeat(40))), [{
    mode: '100644',
    oid: 'a'.repeat(40),
    stage: 0,
    path: 'tracked.txt',
    gitlink: false,
    sparseDirectory: false
  }]);
  assert.deepEqual(parseWorkspaceGitIndexFlags('h assumed.txt\0S skipped.txt\0'), [
    { tag: 'h', path: 'assumed.txt', assumeUnchanged: true, skipWorktree: false },
    { tag: 'S', path: 'skipped.txt', assumeUnchanged: false, skipWorktree: true }
  ]);
  assert.deepEqual(parseWorkspaceGitUntracked('z.txt\0a.txt\0'), ['a.txt', 'z.txt']);
  assert.deepEqual(parseWorkspaceIgnoredPaths('cache/\0secret.env\0'), [
    { path: 'cache', directory: true },
    { path: 'secret.env', directory: false }
  ]);
  assert.throws(() => parseWorkspaceGitIndex('100644 bad 0\ttracked.txt\0'), /git_index_invalid/);
  assert.throws(() => parseWorkspaceGitIndex(indexRecord('tracked.txt', 'a'.repeat(40)), { objectFormat: 'md5' }), /object_format_invalid/);
  assert.throws(() => parseWorkspaceGitIndex(`${indexRecord('tracked.txt', 'a'.repeat(40))}${indexRecord('tracked.txt', 'b'.repeat(40))}`), /git_index_duplicate/);
  assert.throws(() => parseWorkspaceGitIndex(indexRecord('tracked.txt', 'a'.repeat(40)), { maxEntries: 0 }), /git_index_limit/);
  assert.throws(() => parseWorkspaceGitIndexFlags('H tracked.txt'), /index_flags_invalid/);
  assert.throws(() => parseWorkspaceGitIndexFlags('X tracked.txt\0'), /index_flags_invalid/);
  assert.throws(() => parseWorkspaceGitIndexFlags('H tracked.txt\0H tracked.txt\0'), /index_flags_duplicate/);
  assert.throws(() => parseWorkspaceGitIndexFlags('H tracked.txt\0', { maxEntries: 0 }), /index_flags_limit/);
  assert.throws(() => parseWorkspaceGitUntracked('..\/outside\0'), /path_invalid/);
  assert.throws(() => parseWorkspaceGitUntracked('.git/config\0'), /path_invalid/);
  assert.throws(() => parseWorkspaceGitUntracked('same.txt\0same.txt\0'), /untracked_duplicate/);
  assert.throws(() => parseWorkspaceGitUntracked('one.txt\0', { maxEntries: 0 }), /untracked_limit/);
  assert.throws(() => parseWorkspaceIgnoredPaths('cache/\0cache/\0'), /ignored_scope_duplicate/);
  assert.throws(() => parseWorkspaceIgnoredPaths('cache/\0', { maxEntries: 0 }), /ignored_scope_limit/);
});

test('capture hashes every tracked and untracked file plus hidden Git identity without storing contents', async () => {
  const state = await fixture();
  try {
    const baseline = await capture(state);
    assert.equal(baseline.version, 2);
    assert.equal(baseline.head, HEAD);
    assert.equal(baseline.branch, 'main');
    assert.equal(baseline.detached, false);
    assert.equal(baseline.entries.length, 3);
    assert.deepEqual(baseline.entries.map((entry) => [entry.status, entry.path, entry.type]), [
      [' D', 'deleted.txt', 'missing'],
      ['  ', 'tracked.txt', 'file'],
      ['??', 'untracked.txt', 'file']
    ]);
    assert.equal(baseline.instructions[0].path, '../AGENTS.md');
    assert.match(baseline.gitMetadataDigest, /^[a-f0-9]{64}$/);
    assert.match(baseline.indexFlagsDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(baseline.approvedScopes, []);
    assert.doesNotMatch(JSON.stringify(baseline), /safe instructions|tracked change|untracked\\n/);
    assert.deepEqual(validateWorkspaceBaseline(baseline), baseline);
    assert.equal(workspaceBaselineMatches({
      head: baseline.head,
      workingTreeDigest: baseline.workingTreeDigest,
      instructionsDigest: baseline.instructionsDigest
    }, baseline), true);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('metadata validation binds repository identity, branch state, object format, and canonical scopes', async () => {
  const state = await fixture();
  try {
    assert.deepEqual(validateWorkspaceGitMetadata(gitMetadata(state), {
      repoRoot: state.workspace,
      head: HEAD,
      branch: 'main',
      detached: false
    }), gitMetadata(state));
    assert.throws(() => validateWorkspaceGitMetadata(gitMetadata(state, { headRef: 'refs/tags/not-a-branch' })), /head_ref_invalid/);
    assert.throws(() => validateWorkspaceGitMetadata({ ...gitMetadata(state), extra: true }), /git_metadata_invalid/);
    assert.throws(() => validateWorkspaceGitMetadata(gitMetadata(state, { objectFormat: 'md5' })), /object_format_invalid/);
    assert.throws(() => validateWorkspaceGitMetadata(gitMetadata(state, { sparseIndex: 'false' })), /sparse_state_invalid/);
    assert.throws(() => validateWorkspaceGitMetadata(gitMetadata(state), { repoRoot: state.root }), /identity_mismatch/);
    assert.throws(() => validateWorkspaceGitMetadata(gitMetadata(state, { gitDir: path.join(state.root, '.git') })), /directory_outside_repository/);
    assert.throws(() => validateWorkspaceGitMetadata(gitMetadata(state), { branch: 'other' }), /branch_mismatch/);
    assert.throws(() => validateWorkspaceGitMetadata(gitMetadata(state), { detached: true }), /detached_mismatch/);
    assert.throws(() => validateWorkspaceGitMetadata(gitMetadata(state, { headRef: '' }), { head: 'unborn' }), /head_state_invalid/);
    assert.throws(() => validateWorkspaceGitMetadata(gitMetadata(state), { head: 'a'.repeat(64) }), /head_state_invalid/);
    const commonDir = path.join(state.workspace, '.git', 'common');
    await mkdir(commonDir);
    await validateWorkspaceGitMetadataTrust(gitMetadata(state, { commonDir }));
    await assert.rejects(
      validateWorkspaceGitMetadataTrust(gitMetadata(state, { commonDir: path.join(state.workspace, '.git', 'missing') })),
      /common_directory_untrusted/
    );
    await assert.rejects(capture(state, { approvedScopes: ['tracked.txt', 'deleted.txt'] }), /approved_scopes_not_sorted/);
    await assert.rejects(capture(state, { approvedScopes: ['./tracked.txt'] }), /approved_scope_not_canonical/);
    await assert.rejects(capture(state, { approvedScopes: ['tracked.txt', 'tracked.txt'] }), /approved_scope_duplicate/);
    await assert.rejects(capture(state, { approvedScopes: null }), /approved_scopes_invalid/);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('capture fingerprints internal symlinks and detached SHA-256 repositories without following links', async () => {
  const state = await fixture();
  try {
    await writeFile(path.join(state.workspace, 'internal-target.txt'), 'target\n');
    await symlink('internal-target.txt', path.join(state.workspace, 'internal-link'));
    const linkBaseline = await capture(state, {
      indexOutput: indexRecord('internal-link', blobOid('internal-target.txt'), '120000'),
      indexFlagsOutput: 'H internal-link\0',
      untrackedOutput: 'internal-target.txt\0'
    });
    assert.deepEqual(linkBaseline.entries.map((entry) => [entry.status, entry.path, entry.type]), [
      ['  ', 'internal-link', 'symlink'],
      ['??', 'internal-target.txt', 'file']
    ]);

    const sha256Baseline = await capture(state, {
      head: '8'.repeat(64),
      gitMetadata: gitMetadata(state, { objectFormat: 'sha256', headRef: '' }),
      indexOutput: indexRecord('tracked.txt', blobOid(TRACKED, 'sha256')),
      indexFlagsOutput: 'H tracked.txt\0',
      untrackedOutput: ''
    });
    assert.equal(sha256Baseline.detached, true);
    assert.equal(sha256Baseline.branch, '');
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('baseline comparison detects raw same-size edits, index flags, branch, and outside-workspace changes', async () => {
  const state = await fixture();
  try {
    const nested = path.join(state.workspace, 'app');
    await mkdir(nested);
    await writeFile(path.join(nested, 'server.js'), 'before\n');
    const beforeOid = blobOid('before\n');
    const afterOid = blobOid('after!\n');
    const before = await capture(state, {
      workspace: nested,
      indexOutput: indexRecord('app/server.js', beforeOid),
      indexFlagsOutput: 'H app/server.js\0',
      untrackedOutput: '',
      approvedScopes: ['server.js']
    });
    await writeFile(path.join(nested, 'server.js'), 'after!\n');
    await writeFile(path.join(state.workspace, 'outside.txt'), 'outside\n');
    const after = await capture(state, {
      workspace: nested,
      indexOutput: indexRecord('app/server.js', afterOid),
      indexFlagsOutput: 'H app/server.js\0',
      untrackedOutput: 'outside.txt\0',
      approvedScopes: ['server.js']
    });
    const diff = compareWorkspaceBaselines(before, after);
    assert.deepEqual(diff.changedPaths, ['../outside.txt', 'server.js']);
    assert.equal(diff.headChanged, false);
    assert.equal(diff.indexChanged, true);
    assert.equal(diff.branchChanged, false);
    assert.deepEqual(workspaceScopeViolations(diff.changedPaths, ['server.js']), ['../outside.txt']);
    assert.deepEqual(workspaceScopeViolations(['public/app.js', 'public/styles.css'], ['public']), []);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('capture rejects sparse state, index concealment flags, gitlinks, unmerged entries, and repository-wide ignored paths', async () => {
  const state = await fixture();
  try {
    await assert.rejects(capture(state, {
      gitMetadata: gitMetadata(state, { sparseCheckout: true })
    }), /sparse_state_rejected/);
    await assert.rejects(capture(state, {
      indexFlagsOutput: 'H deleted.txt\0h tracked.txt\0'
    }), /assume_unchanged_rejected/);
    await assert.rejects(capture(state, {
      indexFlagsOutput: 'H deleted.txt\0S tracked.txt\0'
    }), /skip_worktree_rejected/);
    await assert.rejects(capture(state, {
      indexOutput: indexRecord('vendor/module', 'b'.repeat(40), '160000'),
      indexFlagsOutput: 'H vendor/module\0',
      untrackedOutput: ''
    }), /submodule_rejected/);
    await assert.rejects(capture(state, {
      indexOutput: indexRecord('tracked.txt', blobOid(TRACKED), '100644', 2),
      indexFlagsOutput: 'H tracked.txt\0',
      untrackedOutput: ''
    }), /unmerged_index_rejected/);
    await assert.rejects(capture(state, {
      approvedScopes: ['tracked.txt'],
      ignoredScopeOutput: 'node_modules/\0'
    }), /ignored_paths_present/);
    await assert.rejects(capture(state, {
      indexFlagsOutput: 'H tracked.txt\0'
    }), /index_flags_mismatch/);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('capture rejects final and intermediate symlink escapes before external bytes are hashed', async () => {
  const state = await fixture();
  try {
    await symlink('/etc/passwd', path.join(state.workspace, 'escape'));
    await assert.rejects(capture(state, { untrackedOutput: 'escape\0' }), /symlink_escape/);
    await unlink(path.join(state.workspace, 'escape'));

    const outside = path.join(state.root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'external private bytes must not be read\n');
    await symlink(outside, path.join(state.workspace, 'ignored-parent'));
    await assert.rejects(capture(state, {
      indexOutput: indexRecord('ignored-parent/secret.txt', 'c'.repeat(40)),
      indexFlagsOutput: 'H ignored-parent/secret.txt\0',
      untrackedOutput: '',
      limits: { maxFileBytes: 1 }
    }), /parent_symlink_rejected/);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('capture rejects hard links and special files without blocking or reading their bytes', { timeout: 2000 }, async () => {
  const state = await fixture();
  try {
    const outside = path.join(state.root, 'outside-secret.txt');
    await writeFile(outside, 'shared private inode\n');
    await link(outside, path.join(state.workspace, 'hardlink.txt'));
    await assert.rejects(capture(state, { untrackedOutput: 'hardlink.txt\0' }), /hardlink_rejected/);

    const fifo = path.join(state.workspace, 'blocking-fifo');
    execFileSync('mkfifo', [fifo]);
    await assert.rejects(capture(state, { untrackedOutput: 'blocking-fifo\0' }), /file_type_invalid/);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('capture fails closed on excessive bytes, malformed paths, unstable shapes, and instruction symlinks', async () => {
  const state = await fixture();
  try {
    await assert.rejects(capture(state, { limits: { maxFileBytes: 2 } }), /file_too_large/);
    await assert.rejects(capture(state, { limits: { maxTotalBytes: 2 } }), /total_bytes_exceeded/);
    await assert.rejects(capture(state, { limits: null }), /limits_invalid/);
    await assert.rejects(capture(state, { limits: { maxEntries: 1 } }), /entry_limit_exceeded/);
    await assert.rejects(capture(state, { limits: { maxGitMetadataBytes: 1 } }), /metadata_bytes_exceeded/);
    await assert.rejects(capture(state, { at: 'not-a-timestamp' }), /timestamp_invalid/);
    await assert.rejects(capture(state, { head: 'bad' }), /head_invalid/);
    await assert.rejects(capture(state, { untrackedOutput: 'tracked.txt\0' }), /untracked_index_overlap/);
    await assert.rejects(capture(state, { instructionFiles: null }), /instruction_limit_exceeded/);
    await assert.rejects(capture(state, { instructionFiles: [null] }), /instruction_invalid/);
    await assert.rejects(capture(state, {
      instructionFiles: [{ path: path.join(state.root, 'missing.md'), label: 'missing.md' }]
    }), /instruction_unavailable/);
    await symlink(path.join(state.root, 'AGENTS.md'), path.join(state.root, 'INSTRUCTIONS.md'));
    await assert.rejects(capture(state, {
      instructionFiles: [{ path: path.join(state.root, 'INSTRUCTIONS.md'), label: 'INSTRUCTIONS.md' }]
    }), /instruction_symlink_rejected/);
    await assert.rejects(captureWorkspaceBaseline({ workspace: 'relative', repoRoot: state.workspace, head: HEAD }), /workspace_invalid/);
    await assert.rejects(capture(state, { workspace: path.join(state.root, 'missing-workspace') }), /workspace_unavailable/);
    await assert.rejects(capture(state, { workspace: state.root }), /workspace_outside_repository/);
    assert.throws(() => workspaceScopeViolations([], []), /scope_invalid/);
    assert.throws(() => workspaceScopeViolations(['server.js'], ['.git']), /scope_invalid/);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('stored baseline validation rejects structural and digest tampering', async () => {
  const state = await fixture();
  const other = await fixture();
  try {
    const baseline = await capture(state);
    const otherBaseline = await capture(other);
    assert.equal(workspaceBaselineMatches(null, baseline), false);
    assert.equal(workspaceBaselineMatches({}, baseline), false);
    assert.throws(() => validateWorkspaceBaseline({ ...baseline, extra: true }), /workspace_baseline_invalid/);
    assert.throws(() => validateWorkspaceBaseline({ ...baseline, version: 1 }), /version_unsupported/);
    assert.throws(() => validateWorkspaceBaseline({ ...baseline, capturedAt: 'bad' }), /timestamp_invalid/);
    assert.throws(() => validateWorkspaceBaseline({ ...baseline, indexDigest: 'bad' }), /digest_invalid/);
    assert.throws(() => validateWorkspaceBaseline({ ...baseline, workspacePrefix: 'wrong' }), /workspace_invalid/);
    assert.throws(() => validateWorkspaceBaseline({
      ...baseline,
      entries: [...baseline.entries].reverse()
    }), /entries_not_sorted/);
    assert.throws(() => validateWorkspaceBaseline({
      ...baseline,
      entries: [baseline.entries[0], baseline.entries[0]]
    }), /entry_duplicate/);
    assert.throws(() => validateWorkspaceBaseline({
      ...baseline,
      entries: [{ ...baseline.entries[0], type: 'device' }, ...baseline.entries.slice(1)]
    }), /entry_invalid/);
    assert.throws(() => validateWorkspaceBaseline({
      ...baseline,
      instructions: [baseline.instructions[0], baseline.instructions[0]]
    }), /instruction_duplicate/);
    assert.throws(() => validateWorkspaceBaseline({ ...baseline, manifestDigest: '0'.repeat(64) }), /digest_mismatch/);
    assert.throws(() => compareWorkspaceBaselines(baseline, otherBaseline), /identity_changed/);
  } finally {
    await rm(state.root, { recursive: true, force: true });
    await rm(other.root, { recursive: true, force: true });
  }
});
