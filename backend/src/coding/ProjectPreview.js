import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { relativeWorkspacePath } from './WorkspaceFiles.js';
import { fail } from './contracts.js';

const types = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
};

/** Static preview uses the same native guarded reads as editing, with no npm install or project script. */
export async function startProjectPreview({ root, files, entryPath, port = 0 }, { signal } = {}) {
  signal?.throwIfAborted();
  const identity = await fs.lstat(root);
  const directory = path.posix.dirname(entryPath);
  const prefix = `/${randomUUID()}/`;
  let active = 0,
    resolveDone,
    ended = false;
  const completion = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const reject = (code) => {
      response.writeHead(code);
      response.end(http.STATUS_CODES[code]);
    };
    if (!['GET', 'HEAD'].includes(request.method)) return reject(405);
    const address = server.address();
    if (!address) return reject(503);
    const origin = `http://127.0.0.1:${address.port}`;
    if (
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin && request.headers.origin !== origin)
    )
      return reject(403);
    const url = request.url.split(/[?#]/)[0];
    if (url.length > 4096 || !url.startsWith(prefix)) return reject(404);
    if (active >= 8) return reject(503);
    active++;
    try {
      const current = await fs.lstat(root);
      if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino)
        throw fail('WORKSPACE_CHANGED', 'Project root changed.');
      const relative = relativeWorkspacePath(
        decodeURIComponent(url.slice(prefix.length)) || path.posix.basename(entryPath),
      );
      const type = types[path.posix.extname(relative).toLowerCase()];
      if (!type) return reject(403);
      const file = relativeWorkspacePath(path.posix.join(directory, relative));
      const data = files.operate
        ? Buffer.from(
            (await files.operate('read', { path: file }, { signal })).contentBase64,
            'base64',
          )
        : Buffer.from((await files.read({ path: file }, { signal })).content);
      response.writeHead(200, {
        'Content-Type': type + (type.startsWith('text/') ? '; charset=utf-8' : ''),
        'Content-Length': data.length,
      });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (!response.headersSent && !response.destroyed)
        reject(['FILE_NOT_FOUND', 'ENOENT'].includes(error.code) ? 404 : 403);
    } finally {
      active--;
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  const finish = (result) => {
    if (ended) return;
    ended = true;
    signal?.removeEventListener('abort', stop);
    resolveDone(result);
  };
  const stop = () => {
    if (ended) return;
    server.closeAllConnections();
    server.close();
    finish({ exitCode: 0, code: 'CANCELLED', cancelled: true });
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    await new Promise((resolve, reject) => {
      const abort = () => reject(fail('CANCELLED', 'Preview start was cancelled.'));
      signal?.addEventListener('abort', abort, { once: true });
      server.once('error', (error) => {
        signal?.removeEventListener('abort', abort);
        reject(error);
      });
      server.listen({ host: '127.0.0.1', port, signal }, () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      });
      if (signal?.aborted) abort();
    });
  } catch (error) {
    stop();
    throw fail(
      error.code === 'EADDRINUSE' ? 'PREVIEW_PORT_BUSY' : error.code || 'PREVIEW_START_FAILED',
      error.code === 'EADDRINUSE'
        ? 'That localhost port is already in use. Choose another port.'
        : 'The HTML preview could not start.',
    );
  }
  server.on('error', () => {
    server.closeAllConnections();
    server.close();
    finish({
      exitCode: 1,
      code: 'PREVIEW_FAILED',
      error: 'The HTML preview stopped unexpectedly.',
    });
  });
  const actualPort = server.address().port;
  server.unref();
  return {
    port: actualPort,
    previewUrl: `http://127.0.0.1:${actualPort}${prefix}${encodeURIComponent(path.posix.basename(entryPath))}`,
    stop,
    completion,
  };
}
