import test from 'node:test';
import assert from 'node:assert/strict';
import { computerTask } from '../src/orchestrator/ComputerTaskPolicy.js';
import { planAstraTask } from '../src/orchestrator/AstraTask.js';
import { nextDesktopDecision, groundPrimitive } from '../src/orchestrator/GenericAppPlanner.js';
import { appIntentFor, parseWhen, isoLocal } from '../src/orchestrator/AppIntents.js';
import {
  validateCapability,
  verificationPredicates,
} from '../src/orchestrator/CapabilityContracts.js';
import { routeTask } from '../src/orchestrator/TaskRouter.js';

const NOW = new Date(2026, 9, 29, 19, 54); // local time

test('"open teams schedule meeting" is app + goal, not an app called "teams schedule meeting"', async () => {
  for (const message of [
    'open teams schedule meeting',
    'open teams and schedule a meeting tomorrow 3pm with ravi@x.com',
    'teams la meeting schedule pannu naalai maalai 5 mani',
  ]) {
    const admission = computerTask(message)?.astra;
    assert.ok(admission, message);
    assert.match(admission.app, /^teams$/i, message);
    assert.equal(admission.install, true, 'a missing app is installed (with approval) first');
    const plan = await planAstraTask({ task: message, admission, now: NOW });
    assert.equal(plan.steps[0].op, 'intent', message);
    assert.equal(plan.steps[0].intentId, 'teams.newMeeting', message);
  }
});

test('a meeting with no time opens the pre-filled form but never auto-sends', async () => {
  const task = 'open teams schedule meeting';
  const plan = await planAstraTask({ task, admission: computerTask(task).astra, now: NOW });
  assert.equal(plan.steps.length, 1);
  assert.match(plan.steps[0].note, /nothing was sent/);
});

test('meeting slots come from the request: time, duration, attendees, subject', () => {
  const hit = appIntentFor({
    app: 'teams',
    goal: 'schedule a meeting',
    task: 'open teams and schedule a meeting on 2nd nov 10:30 am for 1 hour with ravi@x.com and Priya about "Sprint sync"',
    now: NOW,
  });
  const start = new Date(2026, 10, 2, 10, 30);
  assert.equal(hit.intent.slots.startTime, isoLocal(start));
  assert.equal(hit.intent.slots.endTime, isoLocal(new Date(start.getTime() + 3600e3)));
  assert.deepEqual(hit.intent.slots.attendees, ['ravi@x.com']);
  assert.equal(hit.intent.slots.subject, 'Sprint sync');
  assert.deepEqual(
    hit.followUp.map((s) => s.goal),
    [
      'add Priya as required attendees',
      'send the meeting invite (press Send, or Save if there is no Send button)',
    ],
  );
  const range = parseWhen('friday 11-12pm', NOW);
  assert.equal(range.start.getHours(), 11);
  assert.equal(range.end.getHours(), 12);
});

test('openIntent is a validated capability with its own verification predicate', () => {
  assert.equal(
    validateCapability('app', 'openIntent', {
      intentId: 'teams.newMeeting',
      slots: { subject: 'x' },
    }),
    null,
  );
  assert.notEqual(
    validateCapability('app', 'openIntent', { intentId: 'cmd.run', slots: {} }),
    null,
  );
  assert.notEqual(validateCapability('app', 'openIntent', { intentId: 'teams.newMeeting' }), null);
  const p = { intentId: 'teams.newMeeting', slots: {} };
  assert.equal(
    verificationPredicates['app.openIntent'](
      {
        success: true,
        status: 'APP_INTENT_OPENED',
        intentId: 'teams.newMeeting',
        processId: 42,
        readiness: { status: 'ready' },
      },
      p,
    ),
    true,
  );
});

const snap = (elements, level = 'modify') => ({
  snapshotId: 's1',
  status: 'UI_OBSERVED',
  success: true,
  application: { name: 'Teams' },
  permission: { level },
  input: { keys: { allowed: level !== 'read' }, type: { allowed: false } },
  elements,
});
const button = (allowed = true) => ({
  elementId: 'btn',
  role: 'Button',
  label: 'New meeting',
  enabled: true,
  actions: [{ operation: 'invoke', permission: 'SAFE_WRITE', allowed }],
});
const label = {
  elementId: 'lbl',
  parentId: 'btn',
  role: 'Text',
  label: 'New meeting',
  enabled: true,
  actions: [],
};
const evidence = (s) => [{ toolName: 'desktop_open', success: true, data: s }];

test('a click on the text inside a button is grounded on the button', async () => {
  const s = snap([button(), label]);
  assert.equal(groundPrimitive(s, label, 'click').element.elementId, 'btn');
  const result = await nextDesktopDecision({
    task: 'open teams and click New meeting',
    evidence: evidence(s),
    complete: async () => ({ kind: 'click', elementId: 'e1', primitive: true }),
  });
  assert.deepEqual(result.call, {
    tool: 'desktop',
    action: 'click',
    params: { snapshotId: 's1', elementId: 'btn' },
  });
});

test('a rejected proposal is explained to the model and retried instead of ending the task', async () => {
  const s = snap([
    button(),
    { elementId: 'pane', role: 'Pane', label: 'Calendar', enabled: true, actions: [] },
  ]);
  const prompts = [];
  const answers = [
    { kind: 'click', elementId: 'e1', primitive: true }, // a pane with nothing to click
    { kind: 'click', elementId: 'e0', primitive: true },
  ];
  const result = await nextDesktopDecision({
    task: 'open teams and click New meeting',
    evidence: evidence(s),
    complete: async (request) => {
      prompts.push(JSON.parse(request.prompt));
      return answers.shift();
    },
  });
  assert.equal(result.call.params.elementId, 'btn');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].REJECTED_PROPOSALS[0].reason, /no permitted click/);
});

test('a permission-level block says which App Permissions level is needed', async () => {
  const s = snap([button(false)], 'read');
  const result = await nextDesktopDecision({
    task: 'open teams and click New meeting',
    evidence: evidence(s),
    complete: async () => ({ kind: 'click', elementId: 'e0', primitive: true }),
  });
  assert.equal(result.status, 'APP_PERMISSION_DENIED');
  assert.match(result.message, /“read” in App Permissions/);
  assert.doesNotMatch(result.message, /proposed primitive/);
});

test('app + goal requests are agentic, not plain chat', async () => {
  const route = await routeTask('open teams and create a meeting tomorrow 4pm');
  assert.equal(route.mode, 'agentic');
});

test('backend intent ids mirror the desktop app catalog', async () => {
  const { INTENT_IDS: desktop } = await import('../../frontend/tools/apps/AppIntentCatalog.js');
  const { INTENT_IDS: backend } = await import('../src/orchestrator/AppIntents.js');
  assert.deepEqual([...backend].sort(), [...desktop].sort());
});
