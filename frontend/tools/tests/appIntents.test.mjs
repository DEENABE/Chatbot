import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIntentUri, INTENT_IDS } from '../apps/AppIntentCatalog.js';
import { AppService } from '../services/AppService.js';
import { createToolRegistry } from '../security/ToolRegistry.js';

const later = (h) => {
  const d = new Date(Date.now() + h * 3600e3);
  const off = -d.getTimezoneOffset(),
    p = (n) => String(Math.abs(Math.trunc(n))).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00${off >= 0 ? '+' : '-'}${p(off / 60)}:${p(off % 60)}`;
};

test('Teams meeting deep link is built from validated, encoded slots only', () => {
  const { uri } = buildIntentUri('teams.newMeeting', {
    subject: 'Sprint sync & review',
    startTime: later(24),
    endTime: later(25),
    attendees: ['ravi@x.com', 'priya@y.in'],
  });
  assert.match(uri, /^msteams:\/l\/meeting\/new\?subject=Sprint%20sync%20%26%20review&startTime=/);
  assert.match(uri, /&attendees=ravi%40x\.com,priya%40y\.in$/);
});

test('unknown intents, unknown fields and unsafe values are refused', () => {
  const refuse = (id, slots, code = 'INTENT_INVALID') =>
    assert.throws(
      () => buildIntentUri(id, slots),
      (e) => e.code === code,
    );
  refuse('shell.run', {}, 'INTENT_UNKNOWN');
  refuse('teams.newMeeting', { uri: 'file:///c:/x' });
  refuse('teams.newMeeting', { subject: 'a\r\nb' });
  refuse('teams.newMeeting', { attendees: ['not-an-email'] });
  refuse('teams.newMeeting', { startTime: 'tomorrow 3pm' });
  refuse('teams.newMeeting', { startTime: later(5), endTime: later(4) });
  refuse('teams.newChat', { message: 'hi' }); // users is required
});

test('app.openIntent has an explicit SAFE_WRITE policy (never DANGEROUS-free sending)', () => {
  const app = new AppService(
    { request: async () => true },
    { registry: { directory: null, apps: [] }, permissions: { levelFor: () => 'modify' } },
  );
  const registry = createToolRegistry([['app', app]]);
  const def = registry.get('app.openIntent');
  assert.equal(def.risk, 'SAFE_WRITE');
  assert.deepEqual(def.parameterSchema.intentId.values, [...INTENT_IDS]);
});
