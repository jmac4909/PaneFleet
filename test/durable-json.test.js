import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  atomicJsonReplacementCommitted,
  createJsonAtomicWriter,
  ensurePrivateDirectory,
  writeJsonAtomic
} from '../durable-json.js';

test('private directories are owner-only and reject symlink substitution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panefleet-private-directory-'));
  const existing = path.join(root, 'existing');
  const created = path.join(root, 'created');
  const decoy = path.join(root, 'decoy');
  const substituted = path.join(root, 'substituted');
  try {
    await mkdir(existing, { mode: 0o755 });
    await mkdir(decoy, { mode: 0o755 });
    await chmod(existing, 0o755);
    await chmod(decoy, 0o755);
    await symlink(decoy, substituted);

    await ensurePrivateDirectory(existing);
    await ensurePrivateDirectory(created);

    assert.equal((await lstat(existing)).mode & 0o777, 0o700);
    assert.equal((await lstat(created)).mode & 0o777, 0o700);
    await assert.rejects(
      ensurePrivateDirectory(substituted),
      (error) => ['ELOOP', 'ENOTDIR'].includes(error?.code)
    );
    assert.equal((await lstat(decoy)).mode & 0o777, 0o755);
    await assert.rejects(ensurePrivateDirectory('relative'), /directoryPath must be absolute/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('atomic JSON writes replace broad targets with owner-only files and ignore predictable symlinks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-durable-json-'));
  const target = path.join(directory, 'state.json');
  const decoy = path.join(directory, 'decoy.txt');
  const predictableTemporary = `${target}.tmp`;
  try {
    await writeFile(target, 'old\n');
    await chmod(target, 0o644);
    await writeFile(decoy, 'unchanged\n');
    await symlink(decoy, predictableTemporary);

    await writeJsonAtomic(target, { revision: 2, ready: true }, { spaces: 2 });

    assert.equal(await readFile(target, 'utf8'), '{\n  "revision": 2,\n  "ready": true\n}\n');
    assert.equal((await lstat(target)).mode & 0o777, 0o600);
    assert.equal(await readFile(decoy, 'utf8'), 'unchanged\n');
    assert.equal((await lstat(predictableTemporary)).isSymbolicLink(), true);
    assert.deepEqual(
      (await readdir(directory)).sort(),
      ['decoy.txt', 'state.json', 'state.json.tmp']
    );

    await writeJsonAtomic(target, { revision: 3 }, { trailingNewline: false });
    assert.equal(await readFile(target, 'utf8'), '{"revision":3}');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('atomic JSON writes validate inputs and clean random temporary files after replacement failure', async () => {
  await assert.rejects(writeJsonAtomic('relative.json', {}), /filePath must be absolute/);
  await assert.rejects(writeJsonAtomic('/unused/state.json', {}, { spaces: 9 }), /spaces must be an integer/);
  await assert.rejects(writeJsonAtomic('/unused/state.json', {}, { trailingNewline: 'yes' }), /trailingNewline must be boolean/);
  await assert.rejects(writeJsonAtomic('/unused/state.json', undefined), /value must be JSON serializable/);

  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-durable-json-failure-'));
  const target = path.join(directory, 'state.json');
  try {
    await mkdir(target);
    await assert.rejects(writeJsonAtomic(target, { revision: 1 }), (error) => ['EISDIR', 'ENOTEMPTY'].includes(error?.code));
    assert.deepEqual(await readdir(directory), ['state.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('post-rename sync failures expose a committed replacement while pre-rename failures do not', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panefleet-durable-json-phases-'));
  const target = path.join(directory, 'state.json');
  try {
    await writeFile(target, '{"revision":0}\n', { mode: 0o600 });
    const syncFailure = Object.assign(new Error('synthetic directory sync failure'), { code: 'EIO' });
    let postRenameUnlinks = 0;
    const postRenameWriter = createJsonAtomicWriter({
      unlinkFile: async (...args) => {
        postRenameUnlinks += 1;
        return unlink(...args);
      },
      syncDirectory: async () => { throw syncFailure; }
    });
    await assert.rejects(
      postRenameWriter(target, { revision: 1 }),
      (error) => {
        assert.equal(error.code, 'durable_json_post_rename_sync_failed');
        assert.equal(error.originalCode, 'EIO');
        assert.equal(error.replacementCommitted, true);
        assert.equal(error.durabilityUncertain, true);
        assert.equal(atomicJsonReplacementCommitted(error), true);
        return true;
      }
    );
    assert.equal(postRenameUnlinks, 0);
    assert.equal(await readFile(target, 'utf8'), '{"revision":1}\n');
    assert.deepEqual(await readdir(directory), ['state.json']);

    const renameFailure = Object.assign(new Error('synthetic rename failure'), { code: 'EACCES' });
    const preRenameWriter = createJsonAtomicWriter({
      renameFile: async () => { throw renameFailure; }
    });
    await assert.rejects(
      preRenameWriter(target, { revision: 2 }),
      (error) => error === renameFailure && atomicJsonReplacementCommitted(error) === false
    );
    assert.equal(await readFile(target, 'utf8'), '{"revision":1}\n');
    assert.deepEqual(await readdir(directory), ['state.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('atomic writer dependency hooks must be callable', () => {
  assert.throws(() => createJsonAtomicWriter({ syncDirectory: null }), /syncDirectory must be a function/);
  assert.throws(() => createJsonAtomicWriter({ renameFile: false }), /renameFile must be a function/);
});
