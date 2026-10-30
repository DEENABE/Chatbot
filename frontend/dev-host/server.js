/**
 * @module dev-host/server
 * @description Browser-facing HTTP equivalent of electron/ipc/tool.ipc.js.
 *
 * Each route mirrors one IPC channel and applies the same ledger/gate calls,
 * so approvals, permission levels, idempotency and audit behave exactly as in
 * the exe. Only the transport and the "who is the caller" proof differ:
 *   exe : ipcMain + requireTrustedSender (the single app window)
 *   dev : loopback HTTP + guard.admit (Host/Origin/header) + a session token
 *         that the backend must confirm (/auth/me), re-checked on every call.
 */
import http from 'node:http';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { executionContext } from '../tools/ExecutionContext.js';
import { verifyWindowsProposal } from '../tools/security/ModelRouteAuthority.js';
import { admit, bearerToken, DEV_HEADER, defaultAllowedOrigins } from './guard.js';

const SENDER_ID = 1; // One logical "window" per signed-in user; keeps scope stable across reloads.
const MAX_BODY = 512 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Confirms the bearer token with the backend and returns the user id. */
export function createBackendUserResolver({ apiBase, request = fetch }) {
  return async (token) => {
    let response;
    try {
      response = await request(`${apiBase}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
    } catch {
      throw new HttpError(503, 'BACKEND_UNAVAILABLE', 'The local backend is not reachable.');
    }
    if (!response.ok)
      throw new HttpError(401, 'AUTH_CONTEXT_REQUIRED', 'Authenticated tool session required.');
    const user = (await response.json().catch(() => null))?.user;
    if (!UUID.test(user?.id ?? ''))
      throw new HttpError(401, 'AUTH_CONTEXT_REQUIRED', 'Authenticated tool session required.');
    return user.id;
  };
}

/** Fans tool:progress / tool:confirmation-required out to that user's open streams. */
class EventHub {
  constructor() {
    this.streams = new Map();
  }
  subscribe(userId, write) {
    if (!this.streams.has(userId)) this.streams.set(userId, new Set());
    this.streams.get(userId).add(write);
    return () => this.streams.get(userId)?.delete(write);
  }
  publish(userId, channel, data) {
    for (const write of this.streams.get(userId) || []) write({ channel, data });
  }
  senderFor(userId) {
    return {
      id: SENDER_ID,
      isDestroyed: () => false,
      send: (channel, data) => this.publish(userId, channel, data),
    };
  }
}

export function createDevToolHost({
  ledger,
  bridgeSecret,
  resolveUserId,
  port = 3002,
  allowedOrigins = defaultAllowedOrigins(),
  pickDirectory = defaultPickDirectory,
}) {
  const hub = new EventHub();
  const scopeFor = (userId) => `renderer:${userId}-${SENDER_ID}`;
  const progressFor = (userId) => (progress) => hub.publish(userId, 'tool:progress', progress);
  const readyLedger = async () => {
    await ledger.ready;
    return ledger;
  };

  const operatorSoftware = async (ctx, action, params = {}) => {
    const current = await readyLedger();
    const id = randomUUID();
    return current.execute(
      ctx.scope,
      { tool: 'software', action, params, toolCallId: id, requestId: id, idempotencyKey: id },
      ctx.sender,
      { origin: 'operator', modelRoute: 'windows' },
    );
  };
  const software = () => ledger.router.services.get('software');
  const record = (id) => ledger.router?.gate.getRecord(id)?.metadata?.authorization;
  const object = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new HttpError(400, 'BAD_REQUEST', 'A JSON object body is required.');
    return value;
  };

  // ---- routes: one per IPC channel in tool.ipc.js -------------------------
  const routes = {
    'GET /tool/desktop-status': async () => {
      const current = await readyLedger();
      return { desktopControl: current.desktopDiagnostics().desktopControl };
    },
    'POST /tool/execute': async (ctx, body) => {
      const request = object(body);
      const current = await readyLedger();
      if (request.tool === '_system' && request.action === 'getTools')
        return executionContext.run({ origin: 'model', scope: ctx.scope }, () =>
          current.dispatch(request, ctx.sender),
        );
      const id =
        request.tool === '_system' && request.action === 'confirm'
          ? `confirm:${request.params?.confirmationId}`
          : randomUUID();
      const { routeGrant, ...typed } = request;
      const authority = verifyWindowsProposal(routeGrant, typed, ctx.scope, {
        secret: bridgeSecret,
      });
      const inventory =
        typed.tool === 'app' &&
        ['listApps', 'refreshAppRegistry'].includes(typed.action) &&
        !routeGrant;
      return current.execute(
        ctx.scope,
        {
          ...typed,
          toolCallId: request.toolCallId || id,
          requestId: request.requestId || id,
          idempotencyKey:
            request.idempotencyKey ||
            (request.action === 'confirm' ? `confirm:${request.params?.confirmationId}` : id),
        },
        ctx.sender,
        {
          modelRoute: authority?.route,
          onProgress: progressFor(ctx.userId),
          proposalId: authority?.toolCallId,
          proposalOwner: authority?.userId,
          ...(inventory ? { origin: 'operator' } : {}),
        },
      );
    },
    'POST /tool/approve': async (ctx, body) => {
      const request = object(body);
      const current = await readyLedger();
      const auth = record(request.params?.confirmationId);
      return current.execute(
        ctx.scope,
        { ...request, tool: '_system', action: 'confirm' },
        ctx.sender,
        {
          humanApproved: true,
          onProgress: progressFor(ctx.userId),
          modelRoute: auth?.modelRoute,
          taskId: auth?.taskId,
          origin: auth?.origin,
        },
      );
    },
    'POST /tool/choose-app': async (ctx, body) => {
      const current = await readyLedger();
      return current.execute(
        ctx.scope,
        { ...object(body), tool: '_system', action: 'chooseApp' },
        ctx.sender,
        { humanApproved: true, modelRoute: 'windows' },
      );
    },
    'POST /tool/renew-confirmation': async (ctx, body) => {
      const request = object(body);
      await readyLedger();
      return ledger.renewConfirmation(request.confirmationId, request.renewalId, ctx.scope);
    },
    'POST /tool/cancel-request': async (ctx, body) => {
      await readyLedger();
      return ledger.cancel(ctx.scope, object(body).requestId);
    },
    'POST /tool/app-permission': async (ctx, body) => {
      const current = await readyLedger();
      const id = randomUUID();
      return current.execute(
        ctx.scope,
        {
          tool: 'app',
          action: 'setAppPermission',
          params: object(body),
          toolCallId: id,
          requestId: id,
          idempotencyKey: id,
        },
        ctx.sender,
        { origin: 'operator', modelRoute: 'windows' },
      );
    },
    // software:* channels
    'POST /software/providers': (ctx) => operatorSoftware(ctx, 'providers'),
    'POST /software/discover': (ctx, body) => {
      const { query, online } = object(body);
      return operatorSoftware(ctx, online === true ? 'discoverOnline' : 'discover', { query });
    },
    'POST /software/resolve': (ctx, body) =>
      operatorSoftware(ctx, 'resolve', { candidateId: object(body).candidateId }),
    'POST /software/action': (ctx, body) => {
      const { action, planId } = object(body);
      if (!['download', 'install', 'verify'].includes(action))
        throw new HttpError(400, 'BAD_REQUEST', 'Unsupported software action.');
      return operatorSoftware(ctx, action, { planId });
    },
    'POST /software/register-source': async (ctx, body) => {
      const { descriptor, credential } = object(body);
      await readyLedger();
      const registrationId = executionContext.run(
        { authenticated: true, scope: ctx.scope, origin: 'operator' },
        () => software().stageRegistration(descriptor, credential),
      );
      return operatorSoftware(ctx, 'registerProvider', { registrationId });
    },
    'POST /software/remove-source': (ctx, body) =>
      operatorSoftware(ctx, 'removeProvider', { registrationId: object(body).registrationId }),
    'POST /software/choose': async (ctx, body) => {
      const { discoveryId, candidateId } = object(body);
      await readyLedger();
      return executionContext.run(
        { authenticated: true, scope: ctx.scope, origin: 'operator', humanApproved: true },
        () => software().chooseCandidate(discoveryId, candidateId),
      );
    },
    'POST /software/cancel-choice': async (ctx, body) => {
      await readyLedger();
      return executionContext.run(
        { authenticated: true, scope: ctx.scope, origin: 'operator' },
        () => software().cancelChoice(object(body).discoveryId),
      );
    },
    // Needs a native file dialog owned by the Electron window; not available in a tab.
    'POST /software/pick-installer': unsupported,
    'POST /software/pick-directory': unsupported,
    'POST /software/reveal': unsupported,
    'POST /tool/select-offline-installer': unsupported,
    'POST /tool/request-offline-install': unsupported,
    // workspace:choose-directory
    'POST /workspace/choose-directory': async () => {
      const root = await pickDirectory();
      return { cancelled: !root, root: root || null };
    },
  };

  function unsupported() {
    throw new HttpError(
      501,
      'NOT_AVAILABLE_IN_BROWSER',
      'This action needs the desktop app window (native dialog). Use the installed app.',
    );
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const send = (status, payload, extra = {}) => {
      if (res.destroyed || res.headersSent) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...extra,
      });
      res.end(JSON.stringify(payload));
    };
    const denied = admit(req, { port: currentPort(), allowedOrigins });
    if (denied)
      return send(denied.status, {
        success: false,
        error: { code: 'FORBIDDEN', message: denied.error },
      });
    const cors = {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Headers': `Authorization, Content-Type, ${DEV_HEADER}`,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '600',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      const token = bearerToken(req.headers.authorization);
      if (url.pathname === '/health' && req.method === 'GET')
        return send(200, { ok: true, mode: 'dev-tool-host' }, cors);

      if (!token) throw new HttpError(401, 'AUTH_CONTEXT_REQUIRED', 'Sign in first.');
      const userId = await resolveUserId(token);
      const ctx = { userId, scope: scopeFor(userId), sender: hub.senderFor(userId) };

      if (url.pathname === '/events' && req.method === 'GET') {
        res.writeHead(200, {
          ...cors,
          'Content-Type': 'application/x-ndjson',
          'Cache-Control': 'no-store',
        });
        const write = (event) => !res.destroyed && res.write(`${JSON.stringify(event)}\n`);
        const unsubscribe = hub.subscribe(userId, write);
        const heartbeat = setInterval(() => !res.destroyed && res.write('\n'), 15000);
        heartbeat.unref();
        write({ channel: 'ready', data: {} });
        req.on('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return;
      }

      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) throw new HttpError(404, 'NOT_FOUND', 'Unknown tool host endpoint.');
      let body = {};
      if (req.method === 'POST') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || ''))
          throw new HttpError(415, 'BAD_REQUEST', 'JSON body required.');
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BODY) throw new HttpError(413, 'TOO_LARGE', 'Request too large.');
          chunks.push(chunk);
        }
        try {
          body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        } catch {
          throw new HttpError(400, 'BAD_REQUEST', 'Invalid JSON.');
        }
      }
      send(200, await handler(ctx, body), cors);
    } catch (error) {
      const known = error instanceof HttpError || error?.code;
      send(
        error.status || (known ? 400 : 500),
        {
          success: false,
          error: {
            code: error.code || 'TOOL_HOST_ERROR',
            message: known ? error.message : 'Tool host operation failed.',
          },
        },
        cors,
      );
    }
  });

  let boundPort = port;
  const currentPort = () => boundPort;
  return {
    server,
    hub,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      boundPort = server.address().port;
      return `http://127.0.0.1:${boundPort}`;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Windows folder picker. Fixed script, no interpolation of any input. */
function defaultPickDirectory() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const script =
    'Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.Form; $f.TopMost=$true; ' +
    "$d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Choose workspace directory'; " +
    "if($d.ShowDialog($f) -eq 'OK'){[Console]::Out.Write($d.SelectedPath)}";
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { timeout: 120000, windowsHide: false },
      (error, stdout) => resolve(error ? null : stdout.trim() || null),
    );
  });
}
