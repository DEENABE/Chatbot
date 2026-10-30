import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAttachment,
  MAX_ATTACHMENT_SIZE,
  MAX_IMAGE_ATTACHMENT_SIZE,
  shouldLoadChatTools,
  parseMetadata,
  toolStatus,
} from './attachments.js';
import { redactDiagnostics } from './diagnostics.js';
test('attachment validation rejects empty, oversized and unsupported formats', () => {
  assert.equal(validateAttachment({ name: 'REPORT.PDF', size: 1234 }), null);
  assert.match(validateAttachment({ name: 'empty.txt', size: 0 }), /empty/);
  assert.match(validateAttachment({ name: 'huge.docx', size: MAX_ATTACHMENT_SIZE + 1 }), /25 MB/);
  assert.equal(validateAttachment({ name: 'photo.png', size: 100 }), null);
  assert.equal(validateAttachment({ name: 'photo.JPEG', size: 100 }), null);
  assert.match(
    validateAttachment({
      name: 'photo.webp',
      size: MAX_IMAGE_ATTACHMENT_SIZE + 1,
    }),
    /10 MB/,
  );
  assert.match(validateAttachment({ name: 'animation.gif', size: 100 }), /compatible local vision/);
  assert.match(validateAttachment({ name: 'clip.mp4', size: 100 }), /Supported formats/);
  assert.match(validateAttachment({ name: 'program.exe', size: 100 }), /Supported formats/);
});
test('normal document questions avoid OS tool catalogs; explicit tasks and continuations retain tools', () => {
  const classify = (task) => /^(?:open|fix|how do)/i.test(task);
  assert.equal(
    shouldLoadChatTools('Summarize this document', [{ id: 'file' }], null, classify),
    false,
  );
  assert.equal(shouldLoadChatTools('Tell me a story', [], null, classify), false);
  assert.equal(shouldLoadChatTools('How do I fix this?', [{ id: 'file' }], null, classify), false);
  assert.equal(shouldLoadChatTools('Open the application', [{ id: 'file' }], null, classify), true);
  assert.equal(shouldLoadChatTools('Fix the network', [], null, classify), true);
  assert.equal(shouldLoadChatTools('', [], { execution: {} }, classify), true);
});
test('broken serialized history metadata remains renderable', () => {
  assert.deepEqual(parseMetadata('{invalid'), []);
  assert.deepEqual(parseMetadata('{"id":"bad"}'), []);
  assert.deepEqual(parseMetadata('[{"id":"one","name":"notes.txt"}]'), [
    { id: 'one', name: 'notes.txt' },
  ]);
});
test('tool presentation hides raw command/output and exposes approval status', () => {
  assert.equal(
    toolStatus({
      content: JSON.stringify({
        needsConfirmation: true,
        data: { command: 'sensitive command' },
      }),
    }),
    'Waiting for your approval',
  );
  const summary = toolStatus({
    tool_name: 'file_read',
    content: JSON.stringify({
      success: true,
      data: { stdout: 'private data', path: 'C:\\Private' },
    }),
  });
  assert.equal(summary, 'File action completed');
  assert(!summary.includes('private data'));
});
test('advanced diagnostics redact credentials recursively and in text', () => {
  const redacted = redactDiagnostics({
    token: 'abc',
    nested: { password: 'secret', output: 'Bearer abc.def token=abc' },
    safe: 'status',
  });
  assert.equal(redacted.token, '[redacted]');
  assert.equal(redacted.nested.password, '[redacted]');
  assert(!redacted.nested.output.includes('abc'));
  assert.equal(redacted.safe, 'status');
});
