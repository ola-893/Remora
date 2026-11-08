import { parseArgs } from "node:util";
import { readConfig } from "../lib/config.mjs";
import { claimVault } from "../../packages/cli/src/owner-actions.mjs";
const { values } = parseArgs({
  options: {
    config: { type: "string" },
    help: { type: "boolean" },
  },
  strict: true,
});
if (values.help)
  console.log(
    "Connect the recipient wallet, then run npm run claim:near -- --config PATH."
  );
else
  try {
    const config = await readConfig(values.config);
    if (config.network !== "testnet") throw new Error("Browser wallet claims require a testnet vault.");
    const receipt = await claimVault(config);
    console.log(JSON.stringify(receipt ?? { reason: "NOTHING_CLAIMABLE" }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
