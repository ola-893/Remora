import { readFile } from "node:fs/promises";
import { verifyRun } from "../lib/audit.mjs";
const path = process.argv[2] || "vite-project/public/near/latest.json";
const result = verifyRun(JSON.parse(await readFile(path, "utf8")));
console.log(
  `NEAR recording verified: ${result.events} hash-linked events, ${result.transactions} final transactions. ${result.finalHash}`
);
