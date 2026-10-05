import express from 'express';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configuration, root } from './config.mjs';
import { Journal } from './journal.mjs';
import { acquireInstance } from './instance.mjs';
import { Executor } from './executor.mjs';
import { runAgent } from './agent.mjs';
import { catalog } from './catalog.mjs';

export function createApp(config, { executor, chat, journal = new Journal(config.dataDir || path.join(root, 'var')) } = {}) {
  executor ||= new Executor(config, { journal });
  const app = express();
  app.disable('x-powered-by');
  const sessions = new Map(), requests = new Map();
  const controllers = new Set();
  app.locals.shutdown = async () => {
    for (const controller of controllers) controller.abort();
    await executor.tail;
  };
  let active = 0, rateStart = Date.now(), rateCount = 0;
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'X-Frame-Options': 'DENY' });
    // No browser origins, cookies or CORS. A trusted desktop client carries the bearer token.
    if (req.headers.origin !== undefined || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return res.status(403).json({ error: 'LOCAL_CLIENT_REQUIRED' });
    const host = req.headers.host;
    if (![ `127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}` ].includes(host)) return res.status(403).json({ error: 'INVALID_HOST' });
    const presented = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${config.token}`);
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return res.status(401).json({ error: 'UNAUTHORIZED' });
    if (Date.now() - rateStart > 60000) { rateStart = Date.now(); rateCount = 0; }
    if (++rateCount > 120) return res.status(429).json({ error: 'RATE_LIMIT' });
    next();
  });
  app.use(express.json({ limit: '32kb', strict: true }));
  const route = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
  const allowedKeys = (body, keys) => body && !Array.isArray(body) && Object.keys(body).every(k => keys.includes(k));
  app.get('/health', route(async (_, res) => res.json({ ok: true, model: config.model, platform: process.platform, uiaEnabled: config.uia, writesBlocked: executor.writeBlocked, uncertainExecutions: executor.writeBlocked ? [...journal.uncertain.keys()] : [] })));
  app.get('/requests/:id', (req, res) => {
    const record = journal.requests.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
    res.json(record);
  });
  app.get('/capabilities', (_, res) => res.json(Object.values(catalog)));
  app.post('/sessions', (_, res) => {
    for (const [id, session] of sessions) if (!session.busy && Date.now() - session.usedAt > 3600000) sessions.delete(id);
    if (sessions.size >= 100) return res.status(429).json({ error: 'SESSION_LIMIT' });
    const id = randomUUID();
    sessions.set(id, { id, messages: [], busy: false, usedAt: Date.now() });
    res.status(201).json({ sessionId: id });
  });
  app.post('/chat', route(async (req, res) => {
    const b = req.body;
    if (!allowedKeys(b, ['sessionId', 'requestId', 'message', 'allowChanges']) || !uuid(b.sessionId) || !uuid(b.requestId) || typeof b.message !== 'string' || !b.message.trim() || b.message.length > 8000 || (b.allowChanges !== undefined && typeof b.allowChanges !== 'boolean')) return res.status(400).json({ error: 'INVALID_REQUEST' });
    const key = `${b.sessionId}:${b.requestId}`;
    if (journal.requests.has(b.requestId)) return res.status(409).json({ error: 'DUPLICATE_REQUEST', result: requests.get(key) || journal.requests.get(b.requestId) });
    const session = sessions.get(b.sessionId);
    if (!session) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if (session.busy || active >= 4) return res.status(409).json({ error: 'BUSY' });
    if (requests.size >= 10000) return res.status(429).json({ error: 'REQUEST_LEDGER_FULL', message: 'Restart the service after reviewing completed requests.' });
    journal.claimRequest(b.requestId, createHash('sha256').update(JSON.stringify(b)).digest('hex'));
    requests.set(key, { status: 'running' });
    session.busy = true; session.usedAt = Date.now(); active++;
    const controller = new AbortController();
    controllers.add(controller);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const deadline = setTimeout(() => controller.abort(), 600000);
    try {
      const result = await runAgent({ session, message: b.message, allowChanges: b.allowChanges === true, signal: controller.signal, executor, config, chat });
      requests.set(key, { status: 'completed', ...result });
      journal.append({ event: 'request_finished', requestId: b.requestId, status: 'completed' });
      res.json(result);
    } catch (err) {
      requests.set(key, { status: 'failed', error: err.message });
      journal.append({ event: 'request_finished', requestId: b.requestId, status: 'failed' });
      res.status(502).json({ error: 'AGENT_FAILED', message: err.message, requestId: b.requestId });
    } finally { clearTimeout(deadline); controllers.delete(controller); session.busy = false; active--; }
  }));
  app.get('/plans/:id', (req, res) => {
    const plan = executor.plans.get(req.params.id);
    if (!plan) return res.status(404).json({ error: 'PLAN_NOT_FOUND' });
    res.json(executor.publicPlan(plan));
  });
  app.post('/plans/:id/approve', route(async (req, res) => {
    if (!allowedKeys(req.body, ['sessionId', 'approve']) || !uuid(req.body.sessionId) || req.body.approve !== true) return res.status(400).json({ error: 'EXPLICIT_APPROVAL_REQUIRED' });
    const session = sessions.get(req.body.sessionId);
    if (!session) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if (session.busy || active >= 4) return res.status(409).json({ error: 'BUSY' });
    session.busy = true; active++;
    const controller = new AbortController();
    controllers.add(controller);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const result = await executor.approve(req.params.id, session.id, controller.signal);
      session.messages.push({ role: 'user', content: 'The trusted client approved the pending settings plan.' }, { role: 'assistant', content: JSON.stringify(result).slice(0, 12000) });
      res.json(result);
    } finally { controllers.delete(controller); session.busy = false; active--; }
  }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.type === 'entity.too.large' ? 413 : err instanceof SyntaxError ? 400 : 500;
    res.status(status).json({ error: status === 500 ? 'INTERNAL_ERROR' : 'INVALID_JSON', message: status === 500 ? 'Request failed; inspect the local audit log.' : 'Invalid or oversized JSON body' });
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configuration();
  const release = await acquireInstance(config.dataDir || path.join(root, 'var'));
  let app, server;
  try {
    app = createApp(config);
    server = await new Promise((resolve, reject) => {
      const listener = app.listen(config.port, '127.0.0.1', () => resolve(listener));
      listener.once('error', reject);
    });
  } catch (error) { await release(); throw error; }
  console.log(`Windows OS agent listening at http://127.0.0.1:${config.port}`);
  server.requestTimeout = 650000;
  server.headersTimeout = 10000;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    const deadline = setTimeout(() => process.exit(1), 10000);
    await app.locals.shutdown();
    server.closeAllConnections();
    await release();
    clearTimeout(deadline);
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
