import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  admit,
  bearerToken,
  isAllowedOrigin,
  isLoopbackHostHeader,
  defaultAllowedOrigins,
} from '../../dev-host/guard.js';
import { createDevToolHost } from '../../dev-host/server.js';
import { createDevToolBridge } from '../../src/services/devToolBridge.js';

const USER = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'valid-session-token-123';
const ORIGIN = 'http://localhost:5173';

test('guard: host, origin and header rules', () => {
  const allowed = defaultAllowedOrigins();
  assert.equal(isLoopbackHostHeader('127.0.0.1:3002', 3002), true);
  assert.equal(isLoopbackHostHeader('localhost:3002', 3002), true);
  assert.equal(isLoopbackHostHeader('evil.example:3002', 3002), false);
  assert.equal(isLoopbackHostHeader('127.0.0.1:9999', 3002), false);
  assert.equal(isAllowedOrigin(ORIGIN, allowed), true);
  assert.equal(isAllowedOrigin('http://localhost:5174', allowed), false);
  assert.equal(isAllowedOrigin('null', allowed), false);
  assert.equal(isAllowedOrigin(undefined, allowed), false);
  assert.equal(bearerToken(`Bearer ${TOKEN}`), TOKEN);
  assert.equal(bearerToken('Basic abc'), null);
  const ok = {
    method: 'POST',
    headers: { host: 'localhost:3002', origin: ORIGIN, 'x-chanakya-dev-tools': '1' },
  };
  assert.equal(admit(ok, { port: 3002, allowedOrigins: allowed }), null);
  const noHeader = { ...ok, headers: { ...ok.headers, 'x-chanakya-dev-tools': undefined } };
  assert.equal(admit(noHeader, { port: 3002, allowedOrigins: allowed }).status, 403);
});

function fakeLedger() {
  const calls = [];
  const gate = new Map();
  return {
    calls,
    gate,
    ready: Promise.resolve(),
    router: { gate: { getRecord: (id) => gate.get(id) }, services: new Map() },
    desktopDiagnostics: () => ({ desktopControl: { ready: true, reasons: [] } }),
    execute: async (scope, request, sender, trusted) => {
      calls.push({ scope, request, sender, trusted });
      sender.send('tool:progress', { stage: 'x', message: request.action });
      return { success: true, data: { echoed: request.action } };
    },
    dispatch: async () => ({ success: true, data: { tools: [] } }),
    cancel: (scope, requestId) => ({ cancelled: true, requestId, scope }),
    renewConfirmation: async () => ({ renewed: true }),
  };
}

async function withHost(run, { ledger = fakeLedger(), secret = 's'.repeat(64) } = {}) {
  const host = createDevToolHost({
    ledger,
    bridgeSecret: secret,
    port: 0,
    resolveUserId: async (token) => {
      if (token !== TOKEN)
        throw Object.assign(new Error('Authenticated tool session required.'), {
          status: 401,
          code: 'AUTH_CONTEXT_REQUIRED',
        });
      return USER;
    },
    pickDirectory: async () => 'C:\\Work',
  });
  const url = await host.listen();
  const port = new URL(url).port;
  try {
    await run({ url, port, ledger, secret, host });
  } finally {
    await host.close();
  }
}

const headers = (extra = {}) => ({
  Origin: ORIGIN,
  Authorization: `Bearer ${TOKEN}`,
  'X-Chanakya-Dev-Tools': '1',
  'Content-Type': 'application/json',
  ...extra,
});
const post = (url, route, body, h = headers()) =>
  fetch(url + route, { method: 'POST', headers: h, body: JSON.stringify(body) });

test('host: rejects foreign origin, missing origin, missing header, missing/invalid token', async () => {
  await withHost(async ({ url, ledger }) => {
    assert.equal(
      (await post(url, '/tool/execute', {}, headers({ Origin: 'https://evil.example' }))).status,
      403,
    );
    const noOrigin = headers();
    delete noOrigin.Origin;
    assert.equal((await post(url, '/tool/execute', {}, noOrigin)).status, 403);
    const noHeader = headers();
    delete noHeader['X-Chanakya-Dev-Tools'];
    assert.equal((await post(url, '/tool/execute', {}, noHeader)).status, 403);
    const noToken = headers();
    delete noToken.Authorization;
    assert.equal((await post(url, '/tool/execute', {}, noToken)).status, 401);
    assert.equal(
      (await post(url, '/tool/execute', {}, headers({ Authorization: 'Bearer wrong-token-value' })))
        .status,
      401,
    );
    assert.equal(ledger.calls.length, 0);
  });
});

test('host: preflight only answers the allowed origin', async () => {
  await withHost(async ({ url }) => {
    const good = await fetch(url + '/tool/execute', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN },
    });
    assert.equal(good.status, 204);
    assert.equal(good.headers.get('access-control-allow-origin'), ORIGIN);
    const bad = await fetch(url + '/tool/execute', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  });
});

test('host: execute uses the exe scope shape and assigns stable identities', async () => {
  await withHost(async ({ url, ledger }) => {
    const response = await post(url, '/tool/execute', {
      tool: 'file',
      action: 'read',
      params: { path: 'a.txt' },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.echoed, 'read');
    const call = ledger.calls[0];
    assert.equal(call.scope, `renderer:${USER}-1`);
    assert.ok(call.request.toolCallId && call.request.requestId && call.request.idempotencyKey);
    assert.equal(call.trusted.modelRoute, undefined);
  });
});

test('host: a forged routeGrant does not grant the windows route; a valid one does', async () => {
  await withHost(async ({ url, ledger, secret }) => {
    await post(url, '/tool/execute', {
      tool: 'app',
      action: 'openApp',
      params: {},
      toolCallId: 't1',
      routeGrant: 'forged.grant',
    });
    assert.equal(ledger.calls.at(-1).trusted.modelRoute, undefined);
    const { parameterHash } = await import('../security/ToolRequestValidator.js');
    const now = Date.now();
    const data = Buffer.from(
      JSON.stringify({
        version: 1,
        route: 'windows',
        userId: USER,
        toolCallId: 't2',
        tool: 'app',
        action: 'openApp',
        params: {},
        issuedAt: now - 10,
        expiresAt: now + 60000,
      }),
    ).toString('base64url');
    assert.ok(parameterHash({}));
    const grant = `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
    await post(url, '/tool/execute', {
      tool: 'app',
      action: 'openApp',
      params: {},
      toolCallId: 't2',
      routeGrant: grant,
    });
    assert.equal(ledger.calls.at(-1).trusted.modelRoute, 'windows');
  });
});

test('host: approve is a human approval and replays recorded authorization', async () => {
  const ledger = fakeLedger();
  ledger.gate.set('c1', {
    metadata: { authorization: { modelRoute: 'windows', taskId: 'task-9', origin: 'model' } },
  });
  await withHost(
    async ({ url }) => {
      await post(url, '/tool/approve', { params: { confirmationId: 'c1' } });
      const { trusted, request } = ledger.calls[0];
      assert.equal(request.tool, '_system');
      assert.equal(request.action, 'confirm');
      assert.equal(trusted.humanApproved, true);
      assert.equal(trusted.taskId, 'task-9');
      assert.equal(trusted.origin, 'model');
    },
    { ledger },
  );
});

test('host: software action allow-list, unsupported dialogs and folder picker', async () => {
  await withHost(async ({ url }) => {
    assert.equal(
      (await post(url, '/software/action', { action: 'rm -rf', planId: 'p' })).status,
      400,
    );
    const unsupported = await post(url, '/software/pick-installer', {});
    assert.equal(unsupported.status, 501);
    assert.equal((await unsupported.json()).error.code, 'NOT_AVAILABLE_IN_BROWSER');
    assert.deepEqual(await (await post(url, '/workspace/choose-directory', {})).json(), {
      cancelled: false,
      root: 'C:\\Work',
    });
  });
});

test('host: non-JSON bodies are refused', async () => {
  await withHost(async ({ url }) => {
    const response = await post(
      url,
      '/tool/execute',
      {},
      headers({ 'Content-Type': 'text/plain' }),
    );
    assert.equal(response.status, 415);
  });
});

test('host: progress events reach only the signed-in user stream', async () => {
  await withHost(async ({ url, host }) => {
    const controller = new AbortController();
    const response = await fetch(url + '/events', {
      headers: headers(),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const read = async () => decoder.decode((await reader.read()).value);
    assert.match(await read(), /"channel":"ready"/);
    host.hub.publish('someone-else', 'tool:progress', { stage: 'leak' });
    host.hub.publish(USER, 'tool:progress', { stage: 'mine' });
    const text = await read();
    assert.match(text, /"stage":"mine"/);
    assert.doesNotMatch(text, /leak/);
    controller.abort();
  });
});

test('shim: maps preload-shaped calls to the host and reports a stopped host clearly', async () => {
  const seen = [];
  const fetchImpl = async (u, init) => {
    seen.push({ u, init });
    return { status: 200, json: async () => ({ success: true }) };
  };
  const { toolEngine, softwareAPI } = createDevToolBridge('http://127.0.0.1:3002/', {
    fetchImpl,
    tokenSource: async () => TOKEN,
  });
  await toolEngine.execute('file', 'read', { path: 'x' }, 'call-1', {
    requestId: 'r1',
    idempotencyKey: 'k1',
  });
  const sent = JSON.parse(seen[0].init.body);
  assert.equal(seen[0].u, 'http://127.0.0.1:3002/tool/execute');
  assert.equal(sent.tool, 'file');
  assert.equal(sent.requestId, 'r1');
  assert.equal(seen[0].init.headers['X-Chanakya-Dev-Tools'], '1');
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  await toolEngine.confirm('c1', { toolCallId: 't' });
  assert.equal(seen[1].u.endsWith('/tool/approve'), true);
  assert.equal((await softwareAPI.pickInstaller()).error.code, 'NOT_AVAILABLE_IN_BROWSER');

  const down = createDevToolBridge('http://127.0.0.1:3002', {
    fetchImpl: async () => {
      throw new Error('refused');
    },
    tokenSource: async () => TOKEN,
  });
  assert.equal((await down.toolEngine.getDesktopStatus()).error.code, 'TOOL_HOST_UNREACHABLE');
  const signedOut = createDevToolBridge('http://127.0.0.1:3002', {
    fetchImpl,
    tokenSource: async () => null,
  });
  assert.equal(
    (await signedOut.toolEngine.execute('file', 'read', {})).error.code,
    'AUTH_CONTEXT_REQUIRED',
  );
});
