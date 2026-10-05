import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export async function acquireInstance(directory) {
  const identity = path.resolve(directory);
  const hash = createHash('sha256').update(process.platform === 'win32' ? identity.toLowerCase() : identity).digest('hex').slice(0, 24);
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\local-os-agent-${hash}` : path.join(os.tmpdir(), `local-os-agent-${hash}.sock`);
  const mutex = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    mutex.once('error', error => reject(new Error(`Another server or recovery process owns this data directory (${error.code}). Stop it before continuing.`)));
    mutex.listen(address, resolve);
  });
  return () => new Promise((resolve, reject) => mutex.close(error => error ? reject(error) : resolve()));
}
