import "dotenv/config";
import { parseArgs } from "node:util";
import { readConfig, readKey } from "../lib/config.mjs";
import { NearAgentStreamsClient } from "../sdk/index.mjs";
const { values } = parseArgs({
  options: {
    config: { type: "string" },
    "key-file": { type: "string" },
    help: { type: "boolean" },
  },
  strict: true,
});
if (values.help)
  console.log(
    "npm run claim:near -- --key-file /absolute/path/provider.json [--config <file>]"
  );
else
  try {
    const config = await readConfig(values.config),
      key = await readKey(values["key-file"] || config.providerKeyFile);
    if (key.accountId !== config.recipientId)
      throw new Error("Provider key mismatch.");
    const client = new NearAgentStreamsClient({
      vaultId: config.vaultId,
      accountId: config.recipientId,
      privateKey: key.privateKey,
      rpcUrl: config.rpcUrl,
    });
    const receipt = await client.claim();
    console.log(JSON.stringify(receipt, null, 2));
    if (receipt.value !== true) {
      console.error(
        "Provider transfer failed. The claim was restored; check token storage registration before retrying."
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
