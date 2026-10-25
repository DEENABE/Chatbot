// End-to-end check of POST /api/chat with the REAL router, real SQLite, real auth/session code and a fake local Ollama.
// It exists because a variable-shadowing bug in routes/chat.js (an imported function hidden by a request-body field)
// made every chat fail with "This response could not be completed" and no unit test touched that route.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-e2e-'));
process.env.APP_DATA_PATH = dataDir;
// Never talk to a real translator that may be running on this PC: an unreachable address makes the Ollama fallback run.
process.env.INDICTRANS_SERVICE_URL = 'http://127.0.0.1:1';
// The desktop app gives the backend a per-launch secret; computer-tool proposals are signed with it (see modelRouteAuthority).
process.env.TOOL_ENGINE_SESSION_SECRET = 'e2e-test-secret-for-signing-proposals-0123456789';

const INSTALLED = {
  'qwen3.5:9b': { caps: ['completion', 'tools', 'vision'], family: 'qwen35' },
  'qwen3.5:4b': { caps: ['completion', 'tools'], family: 'qwen35' },
  'gemma-e2b:latest': { caps: ['completion'], family: 'gemma' },
};
let installed = INSTALLED;
let chatReplies = [];
const chatBodies = [];
const ollama = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const json = (value) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.url === '/api/tags')
      return json({
        models: Object.keys(installed).map((name) => ({ name, digest: `d-${name}`, size: 3e9 })),
      });
    if (request.url === '/api/show') {
      const entry = installed[body.model];
      return entry
        ? json({
            capabilities: entry.caps,
            model_info: { 'x.context_length': 16384 },
            details: { family: entry.family, parameter_size: '4B', quantization_level: 'Q4' },
          })
        : (response.writeHead(404), response.end('{"error":"not found"}'));
    }
    if (request.url === '/api/ps') return json({ models: [] });
    if (request.url === '/api/chat') {
      chatBodies.push(body);
      const reply = chatReplies.length ? chatReplies.shift() : 'Hello from the fake model.';
      if (body.stream === false)
        return json({ message: { role: 'assistant', content: reply }, done: true });
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.write(
        `${JSON.stringify({ message: { role: 'assistant', content: reply }, done: false })}\n`,
      );
      response.end(`${JSON.stringify({ done: true, eval_count: 3 })}\n`);
      return;
    }
    if (request.url === '/api/embed' || request.url === '/api/embeddings')
      return json({ embeddings: [[0.1, 0.2, 0.3]], embedding: [0.1, 0.2, 0.3] });
    response.writeHead(404);
    response.end('{}');
  });
});
await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve));
process.env.OLLAMA_URL = `http://127.0.0.1:${ollama.address().port}`;

const { default: express } = await import('express');
const { chatRouter } = await import('../src/routes/chat.js');
const { translateRouter } = await import('../src/routes/translate.js');
const { discoverModels } = await import('../src/services/modelRouter.js');
const { db } = await import('../src/services/db.js');
const { createSession } = await import('../src/services/sessionService.js');

const userId = crypto.randomUUID();
db.prepare(
  "INSERT INTO users (id, username, displayName, passwordHash, salt) VALUES (?, 'tester', 'Tester', 'x', 'y')",
).run(userId);
const { token } = createSession(userId);

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/chat', chatRouter);
app.use('/api/translate', translateRouter);
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => {
  server.close();
  ollama.close();
  try {
    db.close(); // Windows cannot delete a SQLite file that is still open
  } catch {
    /* already closed */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* a temp folder left behind is harmless */
  }
});

async function chat(body) {
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const events = text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { status: response.status, events };
}
const of = (events, type) => events.filter((event) => event.type === type);

test('a plain question streams a route event, the reply tokens and done (no error)', async () => {
  chatReplies = ['Paris is the capital of France.'];
  const { status, events } = await chat({ message: 'What is the capital of France?', history: [] });
  assert.equal(status, 200);
  assert.deepEqual(of(events, 'error'), [], JSON.stringify(of(events, 'error')));
  const route = of(events, 'route')[0];
  assert.equal(route.route, 'general');
  assert.ok(route.model, 'a model was chosen');
  assert.equal(route.agent, 'general-chat');
  assert.equal(typeof route.agentLabel, 'string');
  assert.equal(
    of(events, 'token')
      .map((event) => event.text)
      .join(''),
    'Paris is the capital of France.',
  );
  assert.equal(of(events, 'done').length, 1);
});

test('a client-supplied agentProfile (the prompt style) does not break routing', async () => {
  chatReplies = ['ok'];
  const { events } = await chat({
    message: 'Explain recursion',
    history: [],
    agentProfile: 'coder',
  });
  assert.deepEqual(of(events, 'error'), []);
  assert.equal(of(events, 'route')[0].agent, 'general-chat');
  assert.match(chatBodies.at(-1).messages[0].content, /./, 'a system message was sent');
});

test('with no model installed the person gets the specific message, not the generic one', async () => {
  installed = {};
  await discoverModels({ refresh: true }); // the model list is cached for 30 s; make the change visible now
  try {
    const { events } = await chat({ message: 'hello', history: [] });
    const error = of(events, 'error')[0];
    assert.ok(error, 'an error event');
    assert.match(error.error, /^No installed local model/);
    assert.doesNotMatch(error.error, /could not be completed/);
  } finally {
    installed = INSTALLED;
    await discoverModels({ refresh: true });
  }
});

test("a question about the person's documents goes to the Document Intelligence agent on the General route", async () => {
  chatReplies = ['It says nothing yet.'];
  const { events } = await chat({
    message: 'what does my policy document say about leave',
    history: [],
  });
  assert.deepEqual(of(events, 'error'), []);
  const route = of(events, 'route')[0];
  assert.equal(route.route, 'general');
  assert.equal(route.agent, 'document-intelligence');
  assert.equal(
    route.model,
    'gemma-e2b:latest',
    'the recommended family is used when it is installed and eligible',
  );
  assert.equal(of(events, 'done').length, 1);
});

test('translation falls back to the installed local model when the translator service is not running', async () => {
  chatReplies = ['வணக்கம்'];
  const response = await fetch(`${base}/api/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: 'hello', sourceLanguage: 'eng_Latn', targetLanguage: 'tam_Taml' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { translation: 'வணக்கம்' });
});

// Windows privacy switches. "turn off location" used to fall through to the General route (no tools), so the model
// only explained how to do it in Settings. It must now become a typed systemSettings.setConfirmed proposal.
const SETTINGS_TOOLS = [
  'systemSettings_list',
  'systemSettings_set',
  'systemSettings_setConfirmed',
].map((name) => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object' } },
}));
const toolResult = (data, extra = {}) => ({
  role: 'tool',
  tool_name: 'systemSettings_setConfirmed',
  tool_call_id: 'call-1',
  content: JSON.stringify({ success: true, data, ...extra }),
});

test('"turn off location" proposes the real settings call instead of explaining Settings > Location', async () => {
  const modelCallsBefore = chatBodies.length;
  const { status, events } = await chat({
    message: 'turn off location',
    history: [],
    tools: SETTINGS_TOOLS,
  });
  assert.equal(status, 200);
  assert.deepEqual(of(events, 'error'), []);
  assert.equal(of(events, 'route')[0].route, 'windows');
  const call = of(events, 'tool_call')[0]?.toolCall;
  assert.ok(call, 'a tool_call event');
  assert.equal(call.function.name, 'systemSettings_setConfirmed');
  assert.deepEqual(call.function.arguments, { id: 'location-access', enabled: false });
  assert.ok(call.routeGrant, 'the proposal is signed like every other computer action');
  assert.equal(of(events, 'done')[0].hasToolCall, true);
  assert.deepEqual(of(events, 'token'), [], 'no advice text is streamed');
  assert.equal(chatBodies.length, modelCallsBefore, 'the call does not depend on the model');
});

test('Tanglish and camera wording map to the right setting and direction', async () => {
  const cases = [
    ['location off pannu', { id: 'location-access', enabled: false }],
    ['gps on pannunga', { id: 'location-access', enabled: true }],
    ['disable the camera', { id: 'camera-access', enabled: false }],
    ['turn on webcam', { id: 'camera-access', enabled: true }],
  ];
  for (const [message, expected] of cases) {
    const { events } = await chat({ message, history: [], tools: SETTINGS_TOOLS });
    assert.deepEqual(of(events, 'tool_call')[0]?.toolCall.function.arguments, expected, message);
  }
});

test('the reply after the tool result reports only a verified change', async () => {
  const history = [{ role: 'user', content: 'turn off location' }];
  const applied = await chat({
    message: 'turn off location',
    history: [
      ...history,
      toolResult({
        status: 'SETTING_APPLIED',
        message: 'Location access is now off.',
        verification: { status: 'verified' },
      }),
    ],
    tools: SETTINGS_TOOLS,
  });
  assert.deepEqual(of(applied.events, 'tool_call'), []);
  assert.equal(
    of(applied.events, 'token')
      .map((event) => event.text)
      .join(''),
    'Location access is now off.',
  );
  const unverified = await chat({
    message: 'turn off location',
    history: [...history, toolResult({ status: 'SETTING_NOT_VERIFIED' })],
    tools: SETTINGS_TOOLS,
  });
  assert.equal(
    of(unverified.events, 'token')
      .map((event) => event.text)
      .join(''),
    'The Windows setting change has not been verified.',
  );
});

test('without the desktop tools the person is told nothing was changed, not given instructions', async () => {
  const { events } = await chat({ message: 'turn off location', history: [] });
  const text = of(events, 'token')
    .map((event) => event.text)
    .join('');
  assert.match(text, /^Execution blocked/);
  assert.match(text, /No computer action was performed/);
});

test('ordinary sentences that mention location or camera still go to the model', async () => {
  for (const message of ['turn off the camera in zoom', 'what is gps?']) {
    chatReplies = ['Use the meeting controls.'];
    const { events } = await chat({ message, history: [], tools: SETTINGS_TOOLS });
    assert.equal(of(events, 'route')[0].route, 'general', message);
    assert.deepEqual(of(events, 'tool_call'), [], message);
  }
});

test('the reported calculator commands issue signed native tool proposals without asking the model', async () => {
  const before = chatBodies.length;
  const tools = [
    {
      type: 'function',
      function: { name: 'uiAutomation_calculate', parameters: { type: 'object' } },
    },
  ];
  for (const [message, expression] of [
    ['run calculator add 2 3', '2+3'],
    ['open calcualtor add 2+5', '2+5'],
  ]) {
    const { events } = await chat({ message, history: [], tools });
    assert.deepEqual(of(events, 'error'), [], message);
    const call = of(events, 'tool_call')[0]?.toolCall;
    assert.equal(call?.function.name, 'uiAutomation_calculate', message);
    assert.deepEqual(call.function.arguments, { expression });
    assert.ok(call.routeGrant);
  }
  assert.equal(chatBodies.length, before, 'no inference is needed for these commands');
});
