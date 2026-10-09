import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ReadOnlyMcpServer } from '../../tools/security/ReadOnlyMcpServer.js';

export async function createToolBridgeServer(ledger) {
  const mcp = new ReadOnlyMcpServer(ledger);
  const secret = randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    const send = (status, payload) => {
      if (!res.destroyed) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      }
    };
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${secret}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      send(401, { error: 'Bridge authentication required.' });
      return;
    }
    const scope = req.headers['x-execution-owner'];
    if (typeof scope !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(scope)) {
      send(400, { error: 'Execution owner required.' });
      return;
    }
    const owner = `backend:${scope}`;
    try {
      if (req.method === 'GET' && req.url === '/health') {
        send(200, { ok: true });
        return;
      }
      if (
        req.method !== 'POST' ||
        ![
          '/',
          '/approve',
          '/mcp',
          '/cancel',
          '/status',
          '/reconcile',
          '/confirmations/renew',
          '/confirmations/cancel',
        ].includes(req.url)
      ) {
        send(404, { error: 'Unknown bridge endpoint.' });
        return;
      }
      let body = '';
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 256 * 1024) {
          send(413, { error: 'Request too large.' });
          return;
        }
        body += chunk.toString();
      }
      let request;
      try {
        request = JSON.parse(body);
      } catch {
        send(400, { error: 'Invalid JSON.' });
        return;
      }
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        send(400, { error: 'Object required.' });
        return;
      }
      if (req.headers['x-model-route'] !== 'windows' && ['/', '/approve'].includes(req.url)) {
        send(403, {
          error: 'Only the server-selected Windows Agent route may request computer tools.',
        });
        return;
      }
      if (req.url === '/mcp') {
        const result = await mcp.handle(request, owner);
        if (result === null) {
          res.writeHead(202);
          res.end();
        } else send(200, result);
        return;
      }
      if (req.url === '/status') {
        send(200, ledger.status(owner, request.idempotencyKey));
        return;
      }
      if (req.url === '/cancel') {
        send(200, ledger.cancel(owner, request.requestId));
        return;
      }
      if (req.url === '/reconcile') {
        send(
          200,
          request.request?.repair
            ? await ledger.reconcileRepair(owner, request.request, request.review)
            : ledger.reconcile(owner, request.request, request.review),
        );
        return;
      }
      if (req.url === '/confirmations/renew') {
        send(200, await ledger.renewConfirmation(request.confirmationId, request.renewalId, owner));
        return;
      }
      if (req.url === '/confirmations/cancel') {
        send(200, ledger.cancelConfirmation(request.confirmationId, owner));
        return;
      }
      const cancel = () => {
        if (!res.writableEnded && request.requestId) ledger.cancel(owner, request.requestId);
      };
      res.once('close', cancel);
      try {
        send(
          200,
          await ledger.execute(owner, request, null, {
            backend: true,
            modelRoute: 'windows',
            humanApproved:
              req.url === '/approve' && request.tool === '_system' && request.action === 'confirm',
          }),
        );
      } finally {
        res.off('close', cancel);
      }
    } catch (error) {
      send(error.status || 500, {
        error: error.status ? error.message : 'Bridge operation failed.',
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  return { server, secret, url: `http://127.0.0.1:${server.address().port}` };
}
