import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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

// Correlation id: generated once per request, echoed back as a response
// header, and threaded into every log line this request touches (see the
// error handler at the bottom of this file) so a report of "it broke" can be
// tied to one server-side log line without needing to log anything sensitive
// about the request itself.
app.use((request, response, next) => {
  request.id = randomUUID();
  response.setHeader('X-Request-Id', request.id);
  next();
});

// Security headers. CSP is scoped to what the actual built React bundle
// needs (verified against frontend/index.html and the Vite build — no
// inline scripts, no external CDNs) rather than helmet's stock defaults:
//   - style-src needs 'unsafe-inline' because this app sets colors via
//     inline `style` attributes computed at runtime (per-user accent
//     color) — those can't be pre-hashed, so this is a real requirement,
//     not a shortcut.
//   - img-src/media-src allow data:/blob: for pasted screenshots and the
//     screen-recorder preview, both of which are real features.
// crossOriginResourcePolicy/crossOriginOpenerPolicy are disabled: this
// server is *meant* to be fetched cross-origin (the packaged Electron
// renderer is a file:// origin, an intentionally different origin from
// this http://127.0.0.1 backend — see the CORS config below), so CORP's
// default same-origin restriction would block real, expected traffic
// (e.g. the OCR engine fetching its language file from /ocr). The actual
// cross-origin boundary is enforced by the CORS allowlist, not CORP.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null
      }
    },
    // This app is never meant to be framed by anything — CSP's
    // frame-ancestors 'none' above is the modern directive, but older
    // engines only honor X-Frame-Options, whose helmet default (SAMEORIGIN)
    // is looser than what this app actually needs.
    xFrameOptions: { action: 'deny' },
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false
  })
);

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

// Anything under /api/ that didn't match one of the routers above — an
// unknown route, or a real route hit with a method it never registered
// (e.g. DELETE on a GET-only path) — falls through to here rather than
// Express's own default 404 page, which is an unstyled, framework-branded
// HTML response that both looks broken next to the rest of this JSON API
// and unnecessarily confirms "this is Express" to anything probing it.
app.use('/api', (_request, response) => {
  response.status(404).json({ error: 'Not found.' });
});

// Error handling middleware. Routes that expect a specific failure (bad
// input, wrong password) already catch it themselves and respond with 400/401
// directly. Anything else that reaches this generic handler falls into two
// buckets:
//   - a ValidationError (lib/validate.js) or another error deliberately
//     constructed with a `.status` in the 4xx range: its message was
//     authored specifically to be safe to show a client, so it's echoed
//     back with that status.
//   - anything else (a raw DB/library exception, a bug) is genuinely
//     unexpected, so its message never reaches the response — it can
//     contain internal file paths or library details. It still goes to the
//     server log via console.error, tagged with this request's correlation
//     id so a report of "it broke" can be matched to one log line without
//     logging anything about the request itself.
app.use((error, request, response, _next) => {
  console.error(`[${request.id || '-'}]`, error);
  if (error.code === 'LIMIT_FILE_SIZE') {
    return response.status(413).json({ error: 'File is larger than the allowed upload size.' });
  }
  if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
    return response.status(error.status).json({ error: error.message });
  }
  response.status(500).json({ error: 'Unexpected local server error.' });
});
