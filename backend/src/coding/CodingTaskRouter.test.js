import test from 'node:test';
import assert from 'node:assert/strict';
import { codingTask, isCodingTask } from './CodingTaskRouter.js';
import { routeTask } from '../orchestrator/TaskRouter.js';

test('explicit engineering execution routes to coding before desktop/chat overrides', async () => {
  for (const task of [
    'Create a full-stack Student Management application using React, Node.js, Express and SQLite. Create all files and run the tests.',
    'Refactor the modules in my repository.',
    'Fix the failing unit tests in this project.',
    'Create a new application project with authentication.',
    'Add this function to the selected workspace.',
    'Run the project test suite.',
  ]) {
    assert.equal(isCodingTask(task), true, task);
    const route = await routeTask(task);
    assert.equal(route.taskType, 'coding', task);
    assert.equal(route.mode, 'agentic', task);
    assert.equal(route.requiresWorkspace, true, task);
  }
});

test('answer-only and ordinary writing requests never gain coding admission', () => {
  for (const task of [
    'Write a poem about software.',
    'Create a story about a coding agent.',
    'Write an SQL query to show all students.',
    'Explain how a compiler works.',
    'Show me an example function.',
    'Write a Python code snippet.',
    'What are unit tests?',
    'Open Adobe Reader.',
    'Install a software package.',
    'Create a folder on my desktop.',
    'Fix my WiFi.',
    'Hello',
    'Do not execute or edit anything. Explain the project.',
  ])
    assert.equal(isCodingTask(task), false, task);
});

test('selected workspace adds engineering context without granting access', () => {
  assert.equal(
    codingTask('Fix this function.', { workspaceId: 'selected' }).requiresWorkspace,
    false,
  );
  assert.equal(codingTask('Fix this function.'), null);
  assert.equal(codingTask('Write a poem.', { workspaceId: 'selected', explicit: true }), null);
  assert.equal(codingTask('Add a module.', { explicit: true }).requiresWorkspace, true);
});
