import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export async function ensurePrivateDirectory(directoryPath) {
  if (!path.isAbsolute(directoryPath)) throw new TypeError('directoryPath must be absolute');
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const handle = await open(
    directoryPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

async function syncParentDirectory(filePath) {
  const directoryHandle = await open(path.dirname(filePath), 'r');
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

function postRenameWriteError(cause) {
  const error = new Error(
    'atomic JSON replacement committed but parent-directory sync failed',
    { cause }
  );
  error.name = 'AtomicJsonPostRenameError';
  error.code = 'durable_json_post_rename_sync_failed';
  error.replacementCommitted = true;
  error.durabilityUncertain = true;
  error.atomicWritePhase = 'parent_directory_sync';
  error.originalCode = cause?.code || '';
  return error;
}

export function atomicJsonReplacementCommitted(error) {
  return Boolean(
    error
    && error.replacementCommitted === true
    && error.atomicWritePhase === 'parent_directory_sync'
  );
}

export function createJsonAtomicWriter({
  openFile = open,
  renameFile = rename,
  unlinkFile = unlink,
  syncDirectory = syncParentDirectory
} = {}) {
  for (const [name, operation] of Object.entries({ openFile, renameFile, unlinkFile, syncDirectory })) {
    if (typeof operation !== 'function') throw new TypeError(`${name} must be a function`);
  }
  return async function writeAtomic(filePath, value, { spaces = 0, trailingNewline = true } = {}) {
    if (!path.isAbsolute(filePath)) throw new TypeError('filePath must be absolute');
    if (!Number.isInteger(spaces) || spaces < 0 || spaces > 8) throw new TypeError('spaces must be an integer from 0 to 8');
    if (typeof trailingNewline !== 'boolean') throw new TypeError('trailingNewline must be boolean');
    const serialized = JSON.stringify(value, null, spaces);
    if (serialized === undefined) throw new TypeError('value must be JSON serializable');
    const contents = trailingNewline ? `${serialized}\n` : serialized;
    const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    let handle = null;
    let replacementCommitted = false;
    try {
      handle = await openFile(temporaryPath, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await renameFile(temporaryPath, filePath);
      replacementCommitted = true;
      await syncDirectory(filePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (!replacementCommitted) await unlinkFile(temporaryPath).catch(() => {});
      if (replacementCommitted) throw postRenameWriteError(error);
      throw error;
    }
  };
}

export const writeJsonAtomic = createJsonAtomicWriter();
