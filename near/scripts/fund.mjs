import "dotenv/config";
import { parseArgs } from "node:util";
import { readConfig, readKey } from "../lib/config.mjs";
import { NearAgentStreamsClient } from "../sdk/index.mjs";
const { values } = parseArgs({
  options: {
    amount: { type: "string" },
    config: { type: "string" },
    help: { type: "boolean" },
  },
  strict: true,
});
if (values.help)
  console.log(
    "npm run fund:near -- --amount <raw-six-decimal-USDC> [--config <file>]"
  );
else
  try {
    if (!/^[1-9][0-9]{0,20}$/.test(values.amount ?? ""))
      throw new Error(
        "Provide --amount in raw six-decimal USDC units, e.g. 100000 = 0.1 USDC."
      );
    const config = await readConfig(values.config),
      key = await readKey(
        process.env.NEAR_OWNER_KEY_FILE || config.ownerKeyFile
      );
    if (key.accountId !== config.ownerId)
      throw new Error("Owner key mismatch.");
    const client = new NearAgentStreamsClient({
      vaultId: config.vaultId,
      accountId: config.ownerId,
      privateKey: key.privateKey,
      rpcUrl: config.rpcUrl,
    });
    const receipt = await client.fund(values.amount);
    if (receipt.receiptFailures.length || receipt.value !== values.amount)
      throw new Error(
        `Funding did not complete for the full amount. Reconcile transaction ${receipt.hash}.`
      );
    console.log(JSON.stringify(receipt, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
