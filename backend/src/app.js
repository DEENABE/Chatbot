import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { config } from './config.js';
import { uploadRouter } from './routes/upload.js';
import { chatRouter } from './routes/chat.js';
import { modelsRouter } from './routes/models.js';
import { historyRouter } from './routes/history.js';
import { transcribeRouter } from './routes/transcribe.js';
import { documentsRouter } from './routes/documents.js';
import { authRouter } from './routes/auth.js';
import { memoryRouter } from './routes/memory.js';
import { statsRouter } from './routes/stats.js';
import { agentRouter } from './routes/agent.js';
import { repairRouter } from './routes/repair.js';
import { askLimiter } from './middleware/rateLimiter.js';

export const app = express();
app.disable('x-powered-by');

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      // A file://-loaded page (the packaged Electron renderer, always —
      // `loadFile()` is the only load path this app has) is an opaque
      // origin per RFC 6454 §6.2, and browsers serialize that as the
      // literal string "null" in the Origin header — NOT "file://...".
      // `origin.startsWith('file://')` never matches anything a real
      // browser sends; confirmed empirically (a preflight from the real
      // packaged app got no Access-Control-Allow-Origin header at all,
      // silently blocking every request before it reached the server).
      const allowed =
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
        origin === 'null' ||
        origin.startsWith('file://');
      callback(null, allowed);
    },
    credentials: true
  })
);

app.use(express.json({ limit: '10mb' })); // Increased limit to support annotated image canvas contexts

app.get('/api/health', (_request, response) =>
  response.json({ status: 'ok', localOnly: true })
);

app.use('/api/auth', authRouter);
app.use('/api/upload', uploadRouter);
// Chat/agent/repair all end up driving the same single local model (or, for
// agent/repair, unattended PowerShell) — askLimiter was defined but never
// mounted anywhere, so nothing was actually rate-limited.
app.use('/api/chat', askLimiter, chatRouter);
app.use('/api/models', modelsRouter);
app.use('/api/history', historyRouter);
app.use('/api/transcribe', transcribeRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/memory', memoryRouter);
app.use('/api/stats', statsRouter);
app.use('/api/agent', askLimiter, agentRouter);
app.use('/api/repair', askLimiter, repairRouter);

app.use('/ocr', express.static(config.ocrDir));
app.use(express.static(config.frontendDist));

// Handle SPAs by routing matches to index.html
app.get('/{*path}', (request, response, next) => {
  if (request.path.startsWith('/api/')) return next();
  response.sendFile(path.join(config.frontendDist, 'index.html'), (error) => error && next());
});

// Error handling middleware. Routes that expect a specific failure (bad
// input, wrong password) already catch it themselves and respond with 400/401
// directly — anything that reaches this generic handler is unexpected, so it
// no longer echoes error.message back to the client. That message can include
// internal file paths or library details; it still goes to the server log via
// console.error, just not into the HTTP response.
app.use((error, _request, response, _next) => {
  console.error(error);
  if (error.code === 'LIMIT_FILE_SIZE') {
    return response.status(413).json({ error: 'File is larger than the allowed upload size.' });
  }
  response.status(500).json({ error: 'Unexpected local server error.' });
});
