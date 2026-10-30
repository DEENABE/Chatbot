import fs from 'node:fs/promises';
import path from 'node:path';

/** Copy legacy installation data once. Never overwrite or remove either copy. */
export async function prepareRuntimeStorage(userDataPath, legacyPaths = []) {
  const dataRoot = path.join(path.resolve(userDataPath), 'backend-data');
  const storagePath = path.join(dataRoot, 'storage');
  await fs.mkdir(dataRoot, { recursive: true });
  let targetExists = true;
  const entries = await fs.readdir(storagePath).catch((error) => {
    if (error.code === 'ENOENT') {
      targetExists = false;
      return [];
    }
    throw error;
  });
  if (entries.length) return { dataRoot, migrated: false };
  for (const legacyPath of legacyPaths) {
    const source = path.resolve(legacyPath);
    if (source === storagePath) continue;
    const legacy = await fs.readdir(source).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (!legacy.length) continue;
    // Stage the entire copy before exposing it to SQLite. A failed copy leaves
    // originals intact and a retry does not open a partial database.
    const staging = path.join(dataRoot, `migration-${process.pid}-${Date.now()}`);
    await fs.cp(source, staging, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: async (entry) => !(await fs.lstat(entry)).isSymbolicLink(),
    });
    if (targetExists) await fs.rmdir(storagePath); // succeeds only while empty
    await fs.rename(staging, storagePath);
    return { dataRoot, migrated: true };
  }
  return { dataRoot, migrated: false };
}
