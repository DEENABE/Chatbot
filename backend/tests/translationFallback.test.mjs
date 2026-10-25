// node --test tests/translationFallback.test.mjs   (from backend/)
// With no IndicTrans2 service on the PC (a fresh install from the .exe), the Translator page falls back to the
// local Ollama model instead of failing. When IndicTrans2 is running it is always preferred.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { config } from '../src/config.js';
import {
  translateText,
  translateWithEngine,
  TranslationError,
} from '../src/services/translationService.js';
import { discoverModels } from '../src/services/modelRouter.js';

// The fake Ollama also answers model discovery: the translator uses an INSTALLED model, never a built-in tag.
let ollama,
  bodies = [],
  mode = 'ok',
  installed = ['installed-chat:1b'];
const refreshModels = () => discoverModels({ refresh: true }).catch(() => []);
const original = {
  ollamaUrl: config.ollamaUrl,
  serviceUrl: config.translate.serviceUrl,
  timeout: config.translate.serviceTimeoutMs,
  post: config.translate.postProcessingEnabled,
};
before(async () => {
  ollama = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (mode === '500') return res.writeHead(500).end('x');
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags')
        return res.end(
          JSON.stringify({
            models: installed.map((name) => ({ name, digest: `d-${name}`, size: 1e9 })),
          }),
        );
      if (req.url === '/api/show')
        return res.end(
          JSON.stringify({
            capabilities: ['completion'],
            model_info: { 'x.context_length': 8192 },
          }),
        );
      bodies.push(JSON.parse(b));
      res.end(
        JSON.stringify({
          message: { content: mode === 'think' ? '<think>hmm</think>வணக்கம்' : 'வணக்கம்' },
        }),
      );
    });
  });
  await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
  config.ollamaUrl = `http://127.0.0.1:${ollama.address().port}`;
  config.translate.serviceUrl = 'http://127.0.0.1:1'; // nothing listens here
  config.translate.serviceTimeoutMs = 5000;
  config.translate.postProcessingEnabled = false;
});
after(() => {
  ollama.close();
  config.ollamaUrl = original.ollamaUrl;
  config.translate.serviceUrl = original.serviceUrl;
  config.translate.serviceTimeoutMs = original.timeout;
  config.translate.postProcessingEnabled = original.post;
});

test('IndicTrans2 service not running → local Ollama model translates', async () => {
  const out = await translateWithEngine({
    text: 'Hello',
    sourceLanguage: 'eng_Latn',
    targetLanguage: 'tam_Taml',
  });
  assert.deepEqual(out, { translation: 'வணக்கம்', engine: 'ollama' });
  assert.equal(bodies[0].model, 'installed-chat:1b', 'uses the model that is actually installed');
  assert.match(bodies[0].messages[0].content, /English to Tamil/);
  assert.match(bodies[0].messages[0].content, /Tamil script/);
  assert.equal(bodies[0].messages[1].content, 'Hello');
  assert.equal(
    await translateText({ text: 'Hello', sourceLanguage: 'eng_Latn', targetLanguage: 'tam_Taml' }),
    'வணக்கம்',
  );
});
test('thinking text is stripped', async () => {
  mode = 'think';
  assert.equal(
    (
      await translateWithEngine({
        text: 'Hi',
        sourceLanguage: 'eng_Latn',
        targetLanguage: 'tam_Taml',
      })
    ).translation,
    'வணக்கம்',
  );
  mode = 'ok';
});
test('glossary still applies before the fallback', async () => {
  bodies = [];
  await translateWithEngine({
    text: 'check the bearing',
    sourceLanguage: 'eng_Latn',
    targetLanguage: 'tam_Taml',
  });
  assert.match(bodies[0].messages[1].content, /தாங்கி/);
});
test('Ollama also down → clear 503 message', async () => {
  mode = '500';
  await assert.rejects(
    translateText({ text: 'Hello', sourceLanguage: 'eng_Latn', targetLanguage: 'hin_Deva' }),
    (e) => e instanceof TranslationError && e.status === 503 && /Start Ollama/.test(e.message),
  );
  mode = 'ok';
});
test('fallback can be switched off', async () => {
  process.env.TRANSLATION_OLLAMA_FALLBACK = 'false';
  await assert.rejects(
    translateText({ text: 'Hello', sourceLanguage: 'eng_Latn', targetLanguage: 'hin_Deva' }),
    (e) => e.status === 503 && /Translation service is unavailable/.test(e.message),
  );
  delete process.env.TRANSLATION_OLLAMA_FALLBACK;
});
test('a pinned model is used only when it is installed', async () => {
  process.env.TRANSLATION_FALLBACK_MODEL = 'pinned-chat:3b';
  installed = ['installed-chat:1b', 'pinned-chat:3b'];
  await refreshModels();
  bodies = [];
  await translateWithEngine({
    text: 'Hello',
    sourceLanguage: 'eng_Latn',
    targetLanguage: 'tam_Taml',
  });
  assert.equal(bodies[0].model, 'pinned-chat:3b');
  installed = ['installed-chat:1b'];
  await refreshModels();
  bodies = [];
  await translateWithEngine({
    text: 'Hello',
    sourceLanguage: 'eng_Latn',
    targetLanguage: 'tam_Taml',
  });
  assert.equal(
    bodies[0].model,
    'installed-chat:1b',
    'a pinned tag that is not installed falls back to an installed model',
  );
  delete process.env.TRANSLATION_FALLBACK_MODEL;
});
test('no chat model installed → the same clear 503, nothing is sent to a model', async () => {
  installed = [];
  await refreshModels();
  bodies = [];
  await assert.rejects(
    translateText({ text: 'Hello', sourceLanguage: 'eng_Latn', targetLanguage: 'hin_Deva' }),
    (e) =>
      e instanceof TranslationError &&
      e.status === 503 &&
      /chat model is installed/.test(e.message),
  );
  assert.equal(bodies.length, 0);
  installed = ['installed-chat:1b'];
  await refreshModels();
});
test('IndicTrans2 running → it is used, Ollama untouched', async () => {
  const svc = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ translation: 'नमस्ते' }));
  });
  await new Promise((r) => svc.listen(0, '127.0.0.1', r));
  config.translate.serviceUrl = `http://127.0.0.1:${svc.address().port}`;
  bodies = [];
  assert.deepEqual(
    await translateWithEngine({
      text: 'Hello',
      sourceLanguage: 'eng_Latn',
      targetLanguage: 'hin_Deva',
    }),
    { translation: 'नमस्ते', engine: 'indictrans2' },
  );
  assert.equal(bodies.length, 0);
  svc.close();
});
