import { randomUUID } from 'node:crypto';
import { plain } from './ToolRequestValidator.js';

/** Local JSON-RPC adapter. Authentication is supplied by the existing bridge,
 * never by JSON-RPC parameters. No writes or approval methods are exposed. */
export class ReadOnlyMcpServer {
  constructor(ledger) {
    this.ledger = ledger;
  }
  async handle(message, owner) {
    const error = (code, text) => ({
      jsonrpc: '2.0',
      id: message?.id ?? null,
      error: { code, message: text },
    });
    if (
      plain(message) &&
      message.jsonrpc === '2.0' &&
      message.method === 'notifications/initialized' &&
      !Object.hasOwn(message, 'id')
    )
      return null;
    if (
      !plain(message) ||
      message.jsonrpc !== '2.0' ||
      !['string', 'number'].includes(typeof message.id)
    )
      return error(-32600, 'Invalid request');
    let result;
    if (message.method === 'initialize')
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'chanakya-local-read-only', version: '1.0.0' },
      };
    else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list')
      result = {
        tools: (this.ledger.toolRegistry?.list() ?? [])
          .filter((d) => d.risk === 'READ' && d.mcpExposed && d.transport !== 'BLOCKED')
          .map((d) => ({
            name: d.name,
            description: d.description,
            inputSchema: jsonSchema(d.parameterSchema),
          })),
      };
    else if (message.method === 'tools/call') {
      const p = message.params;
      if (
        !plain(p) ||
        Object.keys(p).some((k) => !['name', 'arguments'].includes(k)) ||
        typeof p.name !== 'string'
      )
        return error(-32602, 'Invalid tool parameters');
      const d = this.ledger.toolRegistry?.get(p.name);
      // Independent server-side check, even for an accidentally exposed write.
      if (!d) return error(-32602, 'UNKNOWN_TOOL');
      if (d.risk !== 'READ') return error(-32602, 'MCP_WRITE_NOT_ALLOWED');
      if (!d.mcpExposed || d.transport === 'BLOCKED') return error(-32602, 'TOOL_BLOCKED');
      const [tool, action] = d.name.split('.'),
        id = randomUUID();
      const output = await this.ledger.execute(
        owner,
        {
          tool,
          action,
          params: p.arguments ?? {},
          toolCallId: id,
          requestId: id,
          idempotencyKey: id,
        },
        null,
        { backend: true, transport: 'MCP' },
      );
      result = {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        isError: output.success !== true,
      };
    } else return error(-32601, 'Method not found');
    return { jsonrpc: '2.0', id: message.id, result };
  }
}
function jsonSchema(schema) {
  const properties = {},
    required = [];
  for (const [name, r] of Object.entries(schema)) {
    properties[name] = {
      type:
        r.type === 'enum'
          ? 'string'
          : r.type === 'path'
            ? 'string'
            : r.type === 'number' && r.integer
              ? 'integer'
              : r.type,
    };
    if (r.values) properties[name].enum = r.values;
    for (const [from, to] of [
      ['min', 'minimum'],
      ['max', 'maximum'],
      ['minLength', 'minLength'],
      ['maxLength', 'maxLength'],
    ])
      if (r[from] != null) properties[name][to] = r[from];
    if (r.required) required.push(name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}
