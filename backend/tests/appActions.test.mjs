import test from 'node:test';
import assert from 'node:assert/strict';
import { computerTask } from '../src/orchestrator/ComputerTaskPolicy.js';
import { nextDesktopDecision } from '../src/orchestrator/GenericAppPlanner.js';
import { shouldLoadChatTools } from '../../frontend/src/utils/attachments.js';

test('calculator commands route directly to real UI tools without model tool selection', () => {
  for (const [message, expression] of [
    ['run calculator add 2 3', '2+3'],
    ['open calcualtor add 2+5', '2+5'],
    ['open calculator and add two and three', '2+3'],
    ['calculator 2.5 × 4', '2.5*4'],
    ['divide 9 by 3 in calculator', '9/3'],
    ['multiply 3 by 4', '3*4'],
    ['add 2 and 3', '2+3'],
  ]) {
    const action = computerTask(message);
    assert.deepEqual(
      action.call,
      {
        tool: 'uiAutomation',
        action: 'calculate',
        params: { expression, ...(!/calc/i.test(message) ? { requireActive: true } : {}) },
      },
      message,
    );
    assert.equal(shouldLoadChatTools(message, [], null, computerTask), true, message);
  }
});

test('complex calculator requests are observed instead of truncated or evaluated', () => {
  for (const message of [
    'run calculator add 2 3 and 4',
    'calculator 2+3*4',
    'calculator (2+3)*4',
  ]) {
    const action = computerTask(message);
    assert.equal(action.call, undefined, message);
    assert.equal(action.genericDesktop.query, 'Calculator', message);
  }
  for (const message of ['what is 2+3 in calculator?', 'explain how calculator works'])
    assert.equal(computerTask(message), null, message);
});

test('app names and action suffixes stay separate and enter the grounded desktop loop', async () => {
  for (const [message, app] of [
    ['run Future Reader search invoice', 'Future Reader'],
    ['open Notepad type hello', 'Notepad'],
    ['launch VLC play the movie', 'VLC'],
  ]) {
    // App + goal requests run as Astra tasks (open, installing when missing, then the grounded goal loop).
    const action = computerTask(message);
    assert.equal(action.astra.app, app, message);
    assert.equal(action.astra.steps[0].op, 'goal', message);
    const intent = { query: app, goal: action.astra.steps[0].goal, task: message };
    const decision = await nextDesktopDecision({ task: message, intent });
    assert.deepEqual(decision.call, { tool: 'desktop', action: 'open', params: { query: app } });
  }
});
