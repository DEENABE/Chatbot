import test from 'node:test';
import assert from 'node:assert/strict';
import { fileVersion } from './WorkspaceFiles.js';
import { planReactViteScaffold, wantsReactVite, reactViteFiles } from './ProjectScaffold.js';

function memoryFiles(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async read({ path }) {
      if (!store.has(path))
        throw Object.assign(new Error('missing'), { code: 'FILE_NOT_FOUND', status: 404 });
      return { path, content: store.get(path), version: fileVersion(store.get(path)) };
    },
  };
}

const paths = (plan) => plan.writes.map((write) => write.path).sort();

test('React/Vite intent is recognised without catching other stacks', () => {
  assert.equal(wantsReactVite('Create a React + Vite website'), true);
  assert.equal(wantsReactVite('make a portfolio site in react'), true);
  assert.equal(wantsReactVite('create new vite project'), true);
  assert.equal(wantsReactVite('Explain this project'), false);
  assert.equal(wantsReactVite('Build a Three.js scene with Vite'), false);
  assert.equal(wantsReactVite('Create a Vue app'), false);
});

test('an empty folder gets a complete, runnable starter', async () => {
  const plan = await planReactViteScaffold(memoryFiles(), {
    goal: 'Create a React + Vite website',
    name: 'project',
  });
  assert.deepEqual(paths(plan), [
    'index.html',
    'package.json',
    'src/App.css',
    'src/App.jsx',
    'src/index.css',
    'src/main.jsx',
    'vite.config.js',
  ]);
  assert.ok(plan.writes.every((write) => write.expectedVersion === 'new'));
  const manifest = JSON.parse(plan.writes.find((w) => w.path === 'package.json').content);
  assert.deepEqual(manifest.scripts, { dev: 'vite', build: 'vite build', preview: 'vite preview' });
  assert.equal(manifest.type, 'module');
  assert.ok(manifest.devDependencies.vite && manifest.devDependencies['@vitejs/plugin-react']);
  assert.equal(manifest.devDependencies.tailwindcss, undefined);
  const main = plan.writes.find((w) => w.path === 'src/main.jsx').content;
  assert.match(main, /from 'react-dom\/client'/);
  const html = plan.writes.find((w) => w.path === 'index.html').content;
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /src="\/src\/main\.jsx"/);
});

test('repairs the scripts-less package.json npm creates and replaces broken files', async () => {
  // Exactly what the failing runs left behind.
  const files = memoryFiles({
    'package.json': JSON.stringify({
      dependencies: { react: '^19.2.0', 'react-dom': '^19.2.0', vite: '^8.3.5' },
    }),
    'vite.config.js': '{\n  "plugins": ["@vitejs/plugin-react"]\n}\n',
    'src/main.jsx':
      "import React from 'react';\nimport ReactDOM from 'react-dom';\nimport App from './App';\nReactDOM.createRoot(document.getElementById('root')).render(<App />);",
    'src/App.jsx': 'export default function App() { return <h1>Mine</h1>; }\n',
  });
  const plan = await planReactViteScaffold(files, { goal: 'Create a React + Vite website' });
  const byPath = Object.fromEntries(plan.writes.map((write) => [write.path, write]));
  const manifest = JSON.parse(byPath['package.json'].content);
  assert.equal(manifest.scripts.build, 'vite build');
  assert.equal(manifest.dependencies.react, '^19.2.0', 'existing versions are kept');
  assert.equal(manifest.dependencies.vite, '^8.3.5', 'vite is not duplicated into devDependencies');
  assert.equal(manifest.devDependencies.vite, undefined);
  assert.equal(manifest.devDependencies['@vitejs/plugin-react'], 'latest');
  assert.equal(
    byPath['package.json'].expectedVersion,
    fileVersion(files.store.get('package.json')),
  );
  assert.ok(byPath['vite.config.js'], 'JSON in vite.config.js is replaced');
  assert.ok(byPath['src/main.jsx'], 'a main.jsx without react-dom/client is replaced');
  assert.equal(byPath['src/App.jsx'], undefined, "the user's App.jsx is kept");
  assert.equal(byPath['src/App.css'], undefined, 'App.css only when App.jsx imports it');
  assert.ok(byPath['index.html']);
});

test('a configured project is never taken over', async () => {
  const files = memoryFiles({
    'package.json': JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { react: '1' } }),
  });
  assert.equal(await planReactViteScaffold(files, { goal: 'Create a React website' }), null);
  assert.equal(
    await planReactViteScaffold(memoryFiles({ 'package.json': '{ not json' }), {
      goal: 'react app',
    }),
    null,
  );
  const complete = reactViteFiles({ name: 'site' });
  assert.equal(await planReactViteScaffold(memoryFiles(complete), { goal: 'react app' }), null);
});

test('Tailwind is only added when asked for', async () => {
  const plan = await planReactViteScaffold(memoryFiles(), {
    goal: 'Create a React + Vite + Tailwind landing page',
  });
  const byPath = Object.fromEntries(plan.writes.map((write) => [write.path, write.content]));
  assert.ok(JSON.parse(byPath['package.json']).devDependencies['@tailwindcss/vite']);
  assert.match(byPath['vite.config.js'], /tailwindcss\(\)/);
  assert.match(byPath['src/index.css'], /^@import "tailwindcss";/);
});

test('a Vite project left as "type": "commonjs" by npm is switched to ESM only', async () => {
  const manifest = {
    name: 'react-vite-app',
    type: 'commonjs',
    scripts: { dev: 'vite', build: 'vite build' },
    dependencies: { react: '^19.0.0' },
  };
  const files = memoryFiles({
    'package.json': JSON.stringify(manifest),
    'vite.config.js': "import { defineConfig } from 'vite';\nexport default defineConfig({});\n",
  });
  const plan = await planReactViteScaffold(files, { goal: 'Create a React + Vite website' });
  assert.equal(plan.repairOnly, true);
  assert.equal(plan.writes.length, 1);
  const repaired = JSON.parse(plan.writes[0].content);
  assert.equal(repaired.type, 'module');
  assert.deepEqual(repaired.scripts, manifest.scripts, 'nothing else changes');
  // Already ESM, or a CommonJS config: left alone.
  files.store.set('package.json', JSON.stringify({ ...manifest, type: 'module' }));
  assert.equal(await planReactViteScaffold(files, { goal: 'react app' }), null);
  files.store.set('package.json', JSON.stringify(manifest));
  files.store.set('vite.config.js', 'module.exports = {};\n');
  assert.equal(await planReactViteScaffold(files, { goal: 'react app' }), null);
});
