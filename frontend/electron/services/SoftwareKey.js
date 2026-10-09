import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Windows DPAPI protects the durable software-plan MAC/encryption key. No plaintext fallback. */
export function protectedSoftwareKey(directory, storage) {
  if (!storage?.isEncryptionAvailable?.()) return null;
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, 'protected-key.bin');
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
      throw new Error('Protected software key is invalid.');
    const decoded = Buffer.from(storage.decryptString(fs.readFileSync(target)), 'base64');
    if (decoded.length !== 32) throw new Error('Protected software key is invalid.');
    return decoded;
  }
  const key = randomBytes(32);
  fs.writeFileSync(target, storage.encryptString(key.toString('base64')), {
    flag: 'wx',
    mode: 0o600,
  });
  return key;
}
