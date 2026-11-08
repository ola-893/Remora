import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { definitionsFor, createToolHandlers } from '@ola-893/agentstreams-core/tools';
import { startMonitor } from '@ola-893/agentstreams-core/monitor';

export async function startMcp(client) {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const server = new McpServer({ name: 'agentstreams', version }, { maxToolInputElements: 20 });
  const handlers = createToolHandlers(client);
  for (const [name, def] of Object.entries(definitionsFor(client))) {
    const inputSchema = z.object(Object.fromEntries(Object.entries(def.properties).map(([key, value]) => [key,
      value.enum ? z.enum(value.enum) : value.pattern ? z.string().regex(new RegExp(value.pattern)) : z.string().min(value.minLength ?? 1).max(value.maxLength ?? 128),
    ]).map(([key, schema]) => [key, def.required.includes(key) ? schema : schema.optional()]))).strict();
    server.registerTool(name, { description: `${def.description} Current mode: ${client.mode}.`, inputSchema, annotations: { readOnlyHint: def.readOnly, destructiveHint: !def.readOnly, idempotentHint: def.readOnly, openWorldHint: client.mode !== 'offline' } }, async args => {
      try {
        const result = await handlers[name](args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        const reason = /^[A-Z_]+$/.test(error.message) ? error.message : error.decision?.reason || 'AGENTSTREAMS_OPERATION_FAILED';
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ decision: 'DENY', reason }) }] };
      }
    });
  }
  await server.connect(new StdioServerTransport());
  const monitor = client.status ? startMonitor(client, { onEvent: event => process.stderr.write(JSON.stringify({ type: 'agentstreams-monitor', ...event }) + '\n'), onError: () => process.stderr.write('agentStreams monitor failed; inspect doctor/status before further payment.\n') }) : null;
  let stopping;
  const stop = () => stopping ??= (async () => {
    await monitor?.stop();
    if (client.runtimePolicy?.closeOnExit) { try { await client.close(); } catch { process.stderr.write('Stream closure unconfirmed; run doctor and reconcile.\n'); } }
    await client.dispose(); await server.close();
  })();
  process.stdin.once('end', () => void stop());
  process.once('SIGINT', () => void stop().then(() => process.exit(130)));
  process.once('SIGTERM', () => void stop().then(() => process.exit(143)));
  return server;
}
