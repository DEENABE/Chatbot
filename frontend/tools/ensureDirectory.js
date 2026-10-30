import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Makes sure `directory` exists before a file is written into it.
 *
 * A filesystem root (`E:\`, `\\server\share\`, `/`) always exists, and Windows refuses `mkdir` on a drive root with
 * EPERM even with `recursive: true`, so saving straight into `E:\` failed with "mkdir 'E:'". For a root we only check
 * that it is reachable (an unknown drive then reports ENOENT instead of a misleading permission error).
 */
export async function ensureDirectory(directory, { files = fs, flavour = path } = {}) {
  if (flavour.dirname(directory) === directory) {
    await files.stat(directory);
    return directory;
  }
  await files.mkdir(directory, { recursive: true });
  return directory;
}
