import "dotenv/config";
import { readConfig } from "../lib/config.mjs";
import { startProvider } from "../provider.mjs";
const config = await readConfig();
const service = await startProvider(config);
console.log(`agentStreams ${config.network} research fixture · ${service.origin}`);
process.once("SIGINT", () => service.close());
process.once("SIGTERM", () => service.close());
