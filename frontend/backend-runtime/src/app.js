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

export const app = express();
app.disable('x-powered-by');

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allowed =
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
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
app.use('/api/chat', chatRouter);
app.use('/api/models', modelsRouter);
app.use('/api/history', historyRouter);
app.use('/api/transcribe', transcribeRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/memory', memoryRouter);
app.use('/api/stats', statsRouter);
app.use('/api/agent', agentRouter);
app.use('/api/repair', repairRouter);

app.use('/ocr', express.static(config.ocrDir));
app.use(express.static(config.frontendDist));

// Handle SPAs by routing matches to index.html
app.get('/{*path}', (request, response, next) => {
  if (request.path.startsWith('/api/')) return next();
  response.sendFile(path.join(config.frontendDist, 'index.html'), (error) => error && next());
});

// Error handling middleware
app.use((error, _request, response, _next) => {
  console.error(error);
  const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
  response.status(status).json({ error: error.message || 'Unexpected local server error.' });
});
