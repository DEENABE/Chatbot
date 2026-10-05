import { runPowerShell } from '../src/runner.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { root } from '../src/config.mjs';

const checks = [
  ['system.inspect', {}], ['network.inspect', {}], ['wifi.inspect', {}], ['radio.inspect', {}],
  ['display.inspect', {}], ['brightness.get', {}], ['audio.inspect', {}], ['power.inspect', {}],
  ['personalization.inspect', {}], ['privacy.get', { capability: 'location' }],
  ['firewall.get', {}], ['service.inspect', { name: 'Spooler' }],
  ['registry.get', { target: 'machine-build' }], ['updates.status', {}]
];
const results = [];
for (const [operation, parameters] of checks) {
  const start = Date.now();
  const result = await runPowerShell({ operation, parameters, mode: 'execute', enableUia: false });
  // Do not persist personal device names, IP addresses or file paths in the report.
  const item = { operation, ok: result.ok, status: result.status, error: result.error, elapsedMs: Date.now() - start };
  if (operation === 'system.inspect' && result.ok) item.environment = result.data;
  results.push(item); console.log(JSON.stringify(item));
}
await mkdir(path.join(root, 'var'), { recursive: true });
await writeFile(path.join(root, 'var', 'smoke-results.json'), JSON.stringify({ created: new Date().toISOString(), mutationsExecuted: false, results }, null, 2));
process.exitCode = results.some(r => !r.ok) ? 1 : 0;
