import { randomUUID } from 'node:crypto';
import readline from 'node:readline/promises';
import { configuration } from './config.mjs';
const config = configuration();
const args = process.argv.slice(2);
const sessionAt = args.indexOf('--session');
let sessionId = sessionAt >= 0 ? args[sessionAt + 1] : undefined;
if (sessionAt >= 0) args.splice(sessionAt, 2);
const allowChanges = args.includes('--changes');
const words = args.filter(x => x !== '--changes');
async function api(route, body) {
  const response = await fetch(`http://127.0.0.1:${config.port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(650000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}
if (words[0] === 'approve') {
  const planId = words[1];
  if (!/^[0-9a-f-]{36}$/i.test(planId || '')) throw new Error('Provide the plan UUID');
  const plan = await api(`/plans/${planId}`);
  console.log(JSON.stringify(plan, null, 2));
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question('Apply this exact plan? Type APPLY to proceed: ');
  prompt.close();
  if (answer !== 'APPLY') { console.log('No change made.'); process.exit(0); }
  console.log(JSON.stringify(await api(`/plans/${planId}/approve`, { sessionId: sessionId || plan.sessionId, approve: true }), null, 2));
} else {
  const message = words.join(' ');
  if (!message) throw new Error('Usage: npm run ask -- "request" [--changes] [--session UUID], or npm run ask -- approve PLAN_UUID');
  if (!sessionId) ({ sessionId } = await api('/sessions', {}));
  const requestId = randomUUID();
  console.log(`Session: ${sessionId}\nRequest: ${requestId}`);
  const result = await api('/chat', { sessionId, requestId, message, allowChanges });
  console.log(JSON.stringify(result, null, 2));
}
