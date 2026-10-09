import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';

let identity;
/** Cache provenance only. Neither this hash nor a matching cache grants launch authority. */
export function appMachineIdentity() {
  identity ||= (async () => {
    let guid = '';
    if (process.platform === 'win32')
      guid = await new Promise((resolve) =>
        execFile(
          path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'),
          ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'],
          {
            windowsHide: true,
            timeout: 5000,
            maxBuffer: 8192,
            encoding: 'utf8',
          },
          (error, out) =>
            resolve(error ? '' : out.match(/MachineGuid\s+REG_SZ\s+([0-9a-f-]+)/i)?.[1] || ''),
        ),
      );
    // If Windows machine identity cannot be read, do not reuse a cache across processes.
    if (process.platform === 'win32' && !guid) guid = randomUUID();
    return createHash('sha256')
      .update(
        JSON.stringify([
          guid,
          os.hostname(),
          os.userInfo().username,
          os.homedir(),
          process.env.SystemRoot || '',
        ]),
      )
      .digest('hex');
  })();
  return identity;
}
