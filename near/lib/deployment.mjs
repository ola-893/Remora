import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const DEFAULT_POLICY = Object.freeze({ budget: "100000", max_deposit: "10000", max_rate: "100", max_duration_seconds: 0, recipients: [] });
export async function writeKey(directory, name, accountId, key) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, `${name}.json`);
  await writeFile(path, JSON.stringify({ account_id: accountId, public_key: key.getPublicKey().toString(), private_key: key.toString() }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return path;
}
