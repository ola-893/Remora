import { tool, jsonSchema } from 'ai';
import { definitionsFor, createToolHandlers, validateToolInput } from './tools.mjs';

export function agentStreamsTools(client) {
  const handlers = createToolHandlers(client);
  const definitions = definitionsFor(client);
  return Object.fromEntries(Object.entries(definitions).map(([name, def]) => [name, tool({
    description: def.description,
    inputSchema: jsonSchema({ type: 'object', properties: def.properties, required: def.required, additionalProperties: false }, {
      validate(value) { try { return { success: true, value: validateToolInput(name, value, definitions) }; } catch (error) { return { success: false, error }; } },
    }),
    execute: handlers[name],
  })]));
}
