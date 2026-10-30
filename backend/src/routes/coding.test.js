import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

test('production coding status/model requests cannot consume inference quota or block Stop', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-coding-rate-'));
  process.env.APP_DATA_PATH = temporary;
  const ollama = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify(
        request.url === '/api/tags'
          ? { models: [{ name: 'fixture-coder:1', size: 100, digest: 'fixture' }] }
          : {
              capabilities: ['completion', 'tools'],
              model_info: { 'fixture.context_length': 8192 },
            },
      ),
    );
  });
  await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve));
  process.env.OLLAMA_URL = `http://127.0.0.1:${ollama.address().port}`;
  const { app } = await import('../app.js');
  const { db } = await import('../services/db.js');
  const { createSession } = await import('../services/sessionService.js');
  const userId = randomUUID();
  db.prepare(
    "INSERT INTO users (id,username,displayName,passwordHash,salt) VALUES (?,'coding-fixture','Fixture','x','y')",
  ).run(userId);
  const { token } = createSession(userId);
  const server = await new Promise((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/api/coding`;
  const request = async (route, body) => {
    const response = await fetch(endpoint + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    for (let index = 0; index < 70; index++) assert.equal((await request('/tasks')).status, 200);
    const models = await request('/models');
    assert.equal(models.status, 200);
    assert.equal(models.data.models[0].id, 'fixture-coder:1');
    // Invalid submissions still consume inference admission budget; no task is created.
    for (let index = 0; index < 20; index++)
      assert.equal((await request('/tasks', {})).status, 400);
    assert.equal((await request('/tasks', {})).status, 429);
    assert.equal((await request('/models')).status, 200);
    assert.equal((await request('/tasks')).status, 200);
    const missing = randomUUID();
    assert.equal((await request(`/tasks/${missing}/cancel`, {})).status, 404);
    assert.equal(
      (await request(`/tasks/${missing}/approval`, { approvalId: missing, approved: false }))
        .status,
      404,
    );
    assert.equal(
      (await request(`/tasks/${missing}/approval`, { approvalId: missing, approved: true })).status,
      429,
    );
    assert.equal(
      (await request(`/workspaces/${missing}/processes/${missing}/stop`, {})).status,
      404,
    );
    assert.equal((await fetch(endpoint + '/models')).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ollama.closeAllConnections();
    await new Promise((resolve) => ollama.close(resolve));
    db.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
