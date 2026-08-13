import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  isJsonl,
  canonicalize,
  getEntryKey,
  readEntries,
  checkDuplicates,
  dedupeFile,
  addEntries
} from './dataset-manager.mjs';

test('isJsonl detection', () => {
  assert.equal(isJsonl('file.jsonl'), true);
  assert.equal(isJsonl('file.json'), false);
  assert.equal(isJsonl('file.txt', '{"a":1}\n{"a":2}'), true);
  assert.equal(isJsonl('file.txt', '[{"a":1}]'), false);
});

test('canonicalize objects regardless of key order', () => {
  const obj1 = { b: 2, a: 1 };
  const obj2 = { a: 1, b: 2 };
  assert.equal(canonicalize(obj1), canonicalize(obj2));
});

test('getEntryKey with key field, dot-notation, and ignoreCase', () => {
  const entry = { user: { id: 'U123', name: 'Alice' }, status: 'ACTIVE' };
  assert.equal(getEntryKey(entry, 'user.id'), 'U123');
  assert.equal(getEntryKey(entry, 'status', { ignoreCase: true }), 'active');
  assert.equal(getEntryKey(entry, 'missingKey'), canonicalize(entry));
});

test('JSON and JSONL check, dedupe, and add operations', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-test-'));

  await t.test('JSON file operations', () => {
    const jsonFile = path.join(tmpDir, 'data.json');
    const initialData = [
      { id: '1', title: 'First' },
      { id: '2', title: 'Second' },
      { id: '1', title: 'First Duplicate' }
    ];
    fs.writeFileSync(jsonFile, JSON.stringify(initialData, null, 2), 'utf8');

    // Check duplicates
    const check1 = checkDuplicates(jsonFile);
    assert.equal(check1.totalEntries, 3);
    assert.equal(check1.duplicateCount, 0); // Full object content differs

    const checkByKey = checkDuplicates(jsonFile, 'id');
    assert.equal(checkByKey.duplicateCount, 1);
    assert.equal(checkByKey.duplicates[0].firstSeenIndex, 1);

    // Dedupe by key
    const dedupeRes = dedupeFile(jsonFile, { key: 'id' });
    assert.equal(dedupeRes.cleanCount, 2);
    assert.equal(dedupeRes.removedCount, 1);

    // Read back clean
    const { entries: cleanEntries } = readEntries(jsonFile);
    assert.equal(cleanEntries.length, 2);

    // Add entry with duplicate check
    const addRes = addEntries(jsonFile, [
      { id: '2', title: 'Second Dup' },
      { id: '3', title: 'Third' }
    ], { key: 'id' });

    assert.equal(addRes.addedCount, 1);
    assert.equal(addRes.skippedCount, 1);
    assert.equal(addRes.totalNow, 3);
  });

  await t.test('JSONL file operations', () => {
    const jsonlFile = path.join(tmpDir, 'data.jsonl');
    const initialLines = [
      JSON.stringify({ user: 'alice', msg: 'hello' }),
      JSON.stringify({ user: 'bob', msg: 'hi' }),
      JSON.stringify({ user: 'alice', msg: 'hello' })
    ];
    fs.writeFileSync(jsonlFile, initialLines.join('\n') + '\n', 'utf8');

    // Check duplicates
    const checkRes = checkDuplicates(jsonlFile);
    assert.equal(checkRes.totalEntries, 3);
    assert.equal(checkRes.duplicateCount, 1);

    // Dedupe
    const dedupeRes = dedupeFile(jsonlFile);
    assert.equal(dedupeRes.cleanCount, 2);
    assert.equal(dedupeRes.removedCount, 1);

    // Add entries with duplicates check
    const addRes = addEntries(jsonlFile, [
      { user: 'bob', msg: 'hi' }, // duplicate
      { user: 'charlie', msg: 'hey' } // new
    ]);

    assert.equal(addRes.addedCount, 1);
    assert.equal(addRes.skippedCount, 1);
    assert.equal(addRes.totalNow, 3);
  });

  // Cleanup tmp dir
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
