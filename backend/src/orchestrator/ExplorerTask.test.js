import test from 'node:test';
import assert from 'node:assert/strict';
import { explorerTask, nextExplorerDecision } from './ExplorerTask.js';
import { computerTask } from './ComputerTaskPolicy.js';

test('drive and folder requests are admitted from plain and Tanglish wording', () => {
  const d = explorerTask('open D drive list out folders');
  assert.deepEqual(
    d.locations.map((l) => l.path),
    ['D:\\'],
  );
  assert.equal(d.open && d.list && !d.sizes, true);
  const sizes = explorerTask('open D: drive then list out the folders size');
  assert.equal(sizes.sizes && sizes.list && sizes.open, true);
  assert.equal(explorerTask('list drive').drives, true);
  assert.equal(explorerTask('list all drives').drives, true);
  assert.equal(explorerTask('open desktop').locations[0].location, 'desktop');
  assert.deepEqual(
    explorerTask('desktop documents this pc open').locations.map((l) => l.location),
    ['desktop', 'documents', 'thisPC'],
  );
  assert.equal(explorerTask('D drive la enna folders irukku list out').list, true);
  assert.equal(explorerTask('show the folders in my documents').locations[0].location, 'documents');
  assert.equal(
    explorerTask('list files in D:\\project\\project').locations[0].path,
    'D:\\project\\project',
  );
});

test('apps, files, saves, installs and questions are left to their own agents', () => {
  for (const text of [
    'open file explorer',
    'open vlc',
    'open D:\\notes.txt',
    'open song.mp3 in vlc',
    'open the project folder in vs code',
    'open notepad and save to D drive',
    'install winrar',
    'explain what is a drive',
    'create a React + Vite website',
    'delete the temp folder on D drive',
  ])
    assert.equal(explorerTask(text), null, text);
  assert.ok(computerTask('open D drive list out folders').explorer);
  assert.equal(computerTask('open file explorer').explorer, undefined);
});

test('listing a drive asks for read-only approval once, then lists and sizes it', () => {
  const admission = explorerTask('open D: drive then list out the folders size');
  const evidence = [];
  const next = (result) => {
    const decision = nextExplorerDecision({ admission, evidence });
    if (decision.call) evidence.push({ toolName: `explorer_${decision.call.action}`, ...result });
    return decision;
  };
  assert.deepEqual(
    next({ success: true, data: { path: 'D:\\', message: 'Opened D:\\ in File Explorer.' } }).call,
    {
      tool: 'explorer',
      action: 'openLocation',
      params: { path: 'D:\\' },
    },
  );
  assert.equal(
    next({ success: false, error: { code: 'ROOT_NOT_APPROVED', message: 'not approved' } }).call
      .action,
    'listDirectory',
  );
  assert.deepEqual(
    next({ success: false, needsConfirmation: true, confirmationMessage: 'Allow?' }).call.params,
    {
      path: 'D:\\',
      hours: 8,
    },
  );
  assert.equal(nextExplorerDecision({ admission, evidence }).waiting, true);
  evidence[evidence.length - 1] = {
    toolName: 'explorer_approveRoot',
    success: true,
    data: { approved: true, root: 'D:\\' },
  };
  next({
    success: true,
    data: {
      path: 'D:\\',
      counts: { directories: 2, files: 0 },
      entries: [
        { name: 'project', type: 'directory' },
        { name: 'Games', type: 'directory' },
      ],
    },
  });
  next({
    success: true,
    data: {
      path: 'D:\\',
      complete: true,
      total: '85 GB',
      largestChildren: [
        { name: 'Games', bytes: 9e10, size: '83.8 GB' },
        { name: 'project', bytes: 2e9, size: '1.86 GB' },
      ],
    },
  });
  const done = nextExplorerDecision({ admission, evidence });
  assert.equal(done.success, true);
  assert.match(done.message, /Games — 83\.8 GB[\s\S]*project — 1\.86 GB/);
});

test('a second refusal is reported instead of asking again', () => {
  const admission = explorerTask('list folders in D drive');
  const evidence = [
    { toolName: 'explorer_listDirectory', success: false, error: { code: 'ROOT_NOT_APPROVED' } },
    { toolName: 'explorer_approveRoot', success: true, data: { approved: true, root: 'D:\\' } },
    {
      toolName: 'explorer_listDirectory',
      success: false,
      error: { code: 'ROOT_NOT_APPROVED', message: 'still not approved' },
    },
  ];
  const decision = nextExplorerDecision({ admission, evidence });
  assert.equal(decision.call, undefined);
  assert.equal(decision.success, false);
});

test('named folders are resolved by Windows before they are listed', () => {
  const admission = explorerTask('what is in my downloads folder');
  assert.deepEqual(nextExplorerDecision({ admission, evidence: [] }).call, {
    tool: 'explorer',
    action: 'resolveLocation',
    params: { location: 'downloads' },
  });
  const decision = nextExplorerDecision({
    admission,
    evidence: [
      {
        toolName: 'explorer_resolveLocation',
        success: true,
        data: { location: 'downloads', path: 'C:\\Users\\me\\Downloads' },
      },
    ],
  });
  assert.equal(decision.call.action, 'listDirectory');
  assert.equal(decision.call.params.path, 'C:\\Users\\me\\Downloads');
});
