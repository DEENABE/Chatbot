/**
 * Deterministic React + Vite starter.
 *
 * A small local model cannot be trusted to lay down a working Vite project file by
 * file: it runs `npm install react vite` in an empty folder (npm then writes a
 * package.json with NO scripts), writes JSON into vite.config.js, imports createRoot
 * from 'react-dom', and finally loops on "package.json already exists". The app owns
 * this skeleton instead: it only fills in what is missing or clearly broken, never
 * touches a project that already has its own scripts, and leaves the model to
 * customise App.jsx / App.css for the actual request.
 */

const OTHER_STACK =
  /\b(?:three(?:\.?js)?|webgl|vue|svelte|angular|next\.?js|nuxt|remix|astro|solid(?:js)?|preact)\b/i;

/** The request (or one it continues) asks for a React / Vite web project. */
export function wantsReactVite(text) {
  const goal = String(text || '');
  if (!/\breact\b|\bvite\b/i.test(goal) || OTHER_STACK.test(goal)) return false;
  return /\b(?:create|make|build|new|scaffold|set\s*up|setup|generate|start|website|web\s*site|web\s*app|app|application|project|site|page|landing|portfolio|dashboard)\b/i.test(
    goal,
  );
}

const npmName = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 60) || 'react-vite-app';

const titleFrom = (value) => {
  const words = String(value || '')
    .replace(/[-_.]+/g, ' ')
    .trim();
  return words ? words.replace(/\b\w/g, (c) => c.toUpperCase()) : 'React + Vite';
};

export const SCAFFOLD_SCRIPTS = Object.freeze({
  dev: 'vite',
  build: 'vite build',
  preview: 'vite preview',
});

export function reactViteFiles({ name, tailwind = false } = {}) {
  const pkg = npmName(name);
  const title = titleFrom(name);
  return {
    'package.json': `${JSON.stringify(
      {
        name: pkg,
        private: true,
        version: '0.1.0',
        type: 'module',
        scripts: { ...SCAFFOLD_SCRIPTS },
        dependencies: { react: 'latest', 'react-dom': 'latest' },
        devDependencies: {
          '@vitejs/plugin-react': 'latest',
          vite: 'latest',
          ...(tailwind ? { tailwindcss: 'latest', '@tailwindcss/vite': 'latest' } : {}),
        },
      },
      null,
      2,
    )}\n`,
    'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
    'vite.config.js': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
${tailwind ? "import tailwindcss from '@tailwindcss/vite';\n" : ''}
export default defineConfig({
  plugins: [react()${tailwind ? ', tailwindcss()' : ''}],
});
`,
    'src/main.jsx': `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
    'src/App.jsx': `import { useState } from 'react';
import './App.css';

const features = [
  { title: 'Fast', text: 'Vite serves this page instantly and rebuilds on every save.' },
  { title: 'React', text: 'Components, hooks and state, ready to grow into a full app.' },
  { title: 'Yours', text: 'Edit src/App.jsx and src/App.css to make it your own.' },
];

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="page">
      <header className="nav">
        <span className="brand">${title}</span>
        <nav>
          <a href="#features">Features</a>
          <a href="#start">Get started</a>
        </nav>
      </header>

      <main>
        <section className="hero">
          <h1>${title}</h1>
          <p>A React + Vite website, ready to run.</p>
          <button type="button" onClick={() => setCount((value) => value + 1)}>
            Clicked {count} {count === 1 ? 'time' : 'times'}
          </button>
        </section>

        <section id="features" className="features">
          {features.map((feature) => (
            <article key={feature.title} className="card">
              <h2>{feature.title}</h2>
              <p>{feature.text}</p>
            </article>
          ))}
        </section>

        <section id="start" className="start">
          <h2>Get started</h2>
          <p>
            Run <code>npm run dev</code> and open the address it prints.
          </p>
        </section>
      </main>

      <footer className="footer">Built with React + Vite</footer>
    </div>
  );
}
`,
    'src/App.css': `.page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem clamp(1rem, 5vw, 4rem);
  border-bottom: 1px solid var(--line);
}

.brand {
  font-weight: 700;
}

.nav nav {
  display: flex;
  gap: 1.25rem;
}

.nav a {
  color: var(--muted);
  text-decoration: none;
}

.nav a:hover {
  color: var(--accent);
}

main {
  flex: 1;
  width: min(1100px, 100%);
  margin: 0 auto;
  padding: 0 clamp(1rem, 5vw, 2rem);
}

.hero {
  padding: clamp(3rem, 10vw, 7rem) 0 3rem;
  text-align: center;
}

.hero h1 {
  font-size: clamp(2.2rem, 6vw, 4rem);
  margin: 0 0 0.75rem;
}

.hero p {
  color: var(--muted);
  font-size: 1.15rem;
  margin: 0 0 2rem;
}

button {
  font: inherit;
  padding: 0.7rem 1.4rem;
  border: 0;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}

button:hover {
  filter: brightness(1.1);
}

.features {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1rem;
  padding: 1rem 0 3rem;
}

.card {
  padding: 1.5rem;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface);
}

.card h2 {
  margin: 0 0 0.5rem;
  font-size: 1.2rem;
}

.card p {
  margin: 0;
  color: var(--muted);
}

.start {
  text-align: center;
  padding-bottom: 4rem;
}

code {
  padding: 0.15rem 0.4rem;
  border-radius: 6px;
  background: var(--surface);
}

.footer {
  padding: 1.5rem;
  text-align: center;
  color: var(--muted);
  border-top: 1px solid var(--line);
}
`,
    'src/index.css': `${tailwind ? '@import "tailwindcss";\n\n' : ''}:root {
  --bg: #ffffff;
  --text: #1c1d22;
  --muted: #5d606b;
  --line: #e5e6ea;
  --surface: #f6f7f9;
  --accent: #5b5bd6;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  line-height: 1.5;
  color: var(--text);
  background: var(--bg);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15161a;
    --text: #ececf1;
    --muted: #a0a3ad;
    --line: #2a2c33;
    --surface: #1d1f25;
    --accent: #7c7cf0;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
}
`,
  };
}

const missing = (error) => ['FILE_NOT_FOUND', 'ENOENT'].includes(error?.code);

async function readOptional(files, path) {
  try {
    return await files.read({ path });
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/**
 * Works out which starter files to write. Returns null when the folder is already a
 * configured project (package.json with its own dev/build scripts) or cannot be read
 * as JSON, so an existing project is never rewritten.
 */
export async function planReactViteScaffold(files, { goal = '', name } = {}) {
  const tailwind = /\btailwind/i.test(goal);
  const template = reactViteFiles({ name, tailwind });
  const writes = [];
  const add = (path, content, current) =>
    writes.push({ path, content, expectedVersion: current ? current.version : 'new' });

  const manifestFile = await readOptional(files, 'package.json');
  if (!manifestFile) add('package.json', template['package.json'], null);
  else {
    let manifest;
    try {
      manifest = JSON.parse(manifestFile.content);
    } catch {
      return null;
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
    const scripts =
      manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
    // A project with its own scripts is the user's: never take it over. One exception:
    // npm 11 writes "type": "commonjs", which makes Vite load an ESM vite.config.js as
    // CommonJS (warning now, error once Vite's native config loader is the default).
    if (scripts.dev || scripts.build || scripts.start) {
      const usesVite = /(?:^|\s|\/)vite(?:\s|$)/.test(
        `${scripts.dev || ''} ${scripts.build || ''}`,
      );
      if (!usesVite || manifest.type === 'module') return null;
      const config = await readOptional(files, 'vite.config.js');
      if (!config || !/^\s*(?:import|export)\s/m.test(config.content)) return null;
      return {
        writes: [
          {
            path: 'package.json',
            content: `${JSON.stringify({ ...manifest, type: 'module' }, null, 2)}\n`,
            expectedVersion: manifestFile.version,
          },
        ],
        tailwind,
        repairOnly: true,
      };
    }
    const deps = { ...manifest.dependencies };
    const devDeps = { ...manifest.devDependencies };
    const has = (pkg) => Object.hasOwn(deps, pkg) || Object.hasOwn(devDeps, pkg);
    for (const pkg of ['react', 'react-dom']) if (!has(pkg)) deps[pkg] = 'latest';
    for (const pkg of [
      '@vitejs/plugin-react',
      'vite',
      ...(tailwind ? ['tailwindcss', '@tailwindcss/vite'] : []),
    ])
      if (!has(pkg)) devDeps[pkg] = 'latest';
    const repaired = {
      name: manifest.name || npmName(name),
      private: true,
      version: manifest.version || '0.1.0',
      ...manifest,
      type: 'module',
      scripts: { ...scripts, ...SCAFFOLD_SCRIPTS },
      dependencies: deps,
      devDependencies: devDeps,
    };
    add('package.json', `${JSON.stringify(repaired, null, 2)}\n`, manifestFile);
  }

  const index = await readOptional(files, 'index.html');
  if (
    !index ||
    !/src=["']\/?src\/main\.[jt]sx?["']/.test(index.content) ||
    !/id=["']root["']/.test(index.content)
  )
    add('index.html', template['index.html'], index);

  const configs = await Promise.all(
    ['vite.config.ts', 'vite.config.mjs', 'vite.config.cjs'].map((path) =>
      readOptional(files, path),
    ),
  );
  if (!configs.some(Boolean)) {
    const config = await readOptional(files, 'vite.config.js');
    if (!config || !/export\s+default|module\.exports/.test(config.content))
      add('vite.config.js', template['vite.config.js'], config);
  }

  const entries = await Promise.all(
    ['src/main.tsx', 'src/main.ts', 'src/main.js'].map((path) => readOptional(files, path)),
  );
  let freshEntry = false;
  if (!entries.some(Boolean)) {
    const main = await readOptional(files, 'src/main.jsx');
    // `import ReactDOM from 'react-dom'` + ReactDOM.createRoot crashes on React 18/19.
    if (!main || !/react-dom\/client/.test(main.content)) {
      add('src/main.jsx', template['src/main.jsx'], main);
      freshEntry = true;
    }
  }

  const app = await readOptional(files, 'src/App.jsx');
  const tsApp = await readOptional(files, 'src/App.tsx');
  if (!app && !tsApp) add('src/App.jsx', template['src/App.jsx'], null);
  const appImportsCss = !app || /['"]\.\/App\.css['"]/.test(app.content);
  if (appImportsCss && !(await readOptional(files, 'src/App.css')))
    add('src/App.css', template['src/App.css'], null);
  if (freshEntry && !(await readOptional(files, 'src/index.css')))
    add('src/index.css', template['src/index.css'], null);

  return writes.length ? { writes, tailwind } : null;
}

export const SCAFFOLD_NOTE =
  'Chanakya already created a working React + Vite project (package.json with dev/build/preview scripts, index.html, vite.config.js, src/main.jsx, src/App.jsx, src/App.css, src/index.css) and installed its packages. Do NOT recreate these files or call deps.install for them again. To fulfil the request, fs.read src/App.jsx and src/App.css, then fs.write them with expectedVersion set to the version you read (add new components under src/ with expectedVersion "new"). Run npm run build to check, then finish.';
