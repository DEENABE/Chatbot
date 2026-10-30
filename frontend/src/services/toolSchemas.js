function properties(schema) {
  return Object.fromEntries(
    Object.entries(schema).map(([name, rule]) => [
      name,
      {
        type: ['path', 'enum'].includes(rule.type) ? 'string' : rule.type || 'string',
        description: rule.description || `Parameter ${name}`,
        ...(rule.values ? { enum: rule.values } : {}),
        ...(rule.properties
          ? {
              properties: properties(rule.properties),
              required: Object.keys(rule.properties).filter((k) => rule.properties[k].required),
              additionalProperties: false,
            }
          : {}),
        ...(rule.itemSchema ? { items: properties({ item: rule.itemSchema }).item } : {}),
      },
    ]),
  );
}
export function mapToolsToOllamaSchema(toolsMap) {
  if (
    !toolsMap ||
    typeof toolsMap !== 'object' ||
    Object.values(toolsMap).some((actions) => !Array.isArray(actions))
  )
    throw Object.assign(new Error('Tool discovery returned an invalid capability map.'), {
      code: toolsMap?.error?.code || 'TOOL_DISCOVERY_FAILED',
    });
  return Object.entries(toolsMap).flatMap(([service, actions]) =>
    actions.map((action) => ({
      type: 'function',
      function: {
        name: `${service}_${action.action}`,
        description: action.description || `Call ${service}.${action.action}`,
        parameters: {
          type: 'object',
          properties: properties(action.schema || {}),
          required: Object.keys(action.schema || {}).filter((k) => action.schema[k].required),
          additionalProperties: false,
        },
      },
    })),
  );
}
