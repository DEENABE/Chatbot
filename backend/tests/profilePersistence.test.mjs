import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
await fs.mkdir(path.resolve('.astra-tmp'), { recursive: true });
const directory = await fs.mkdtemp(path.resolve('.astra-tmp/profile-test-'));
process.env.APP_DATA_PATH = directory;
const { db } = await import('../src/services/db.js');
const { updateUserProfile } = await import('../src/services/authService.js');
const userId = randomUUID();
db.prepare(
  'INSERT INTO users(id,username,displayName,email,department,role,passwordHash,salt) VALUES(?,?,?,?,?,?,?,?)',
).run(
  userId,
  'profile-fixture',
  'Before',
  'before@example.test',
  'Before',
  'User',
  'fixture-hash',
  'fixture-salt',
);
test.after(() => db.close());
test('profile update persists fields, clears optional values and preserves account privileges', async () => {
  await updateUserProfile(userId, { displayName: 'After', role: 'Admin', permissions: 'all' });
  let row = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  assert.equal(row.displayName, 'After');
  assert.equal(row.email, 'before@example.test');
  assert.equal(row.role, 'User');
  await updateUserProfile(userId, { email: '', department: '' });
  row = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  assert.equal(row.email, null);
  assert.equal(row.department, null);
  assert.equal(row.passwordHash, 'fixture-hash');
});
test('invalid profile fields are rejected without changing saved account data', async () => {
  for (const data of [{ displayName: ' ' }, { email: 'invalid' }, { department: 'x'.repeat(121) }])
    await assert.rejects(updateUserProfile(userId, data), (error) => error.status === 400);
  assert.equal(
    db.prepare('SELECT displayName FROM users WHERE id=?').get(userId).displayName,
    'After',
  );
});
