import { createHash } from "node:crypto";

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function auditHash(event) {
  return createHash("sha256").update(canonical(event)).digest("hex");
}
export function verifyRun(run) {
  if (run.schemaVersion !== 1 || !["sandbox", "testnet"].includes(run.network))
    throw new Error("Invalid run schema.");
  let previousHash = "0".repeat(64);
  for (const [index, event] of run.events.entries()) {
    const { eventHash, ...body } = event;
    if (
      event.runId !== run.runId ||
      event.sequence !== index + 1 ||
      event.previousHash !== previousHash ||
      auditHash(body) !== eventHash
    )
      throw new Error("Run event chain is invalid.");
    previousHash = eventHash;
  }
  for (const receipt of [
    ...run.receipts,
    ...(run.providerPayout ? [run.providerPayout] : []),
  ]) {
    if (
      !/^[1-9A-HJ-NP-Za-km-z]{40,46}$/.test(receipt.hash) ||
      !receipt.receiptIds?.length ||
      receipt.receiptFailures?.length
    )
      throw new Error("Run contains an invalid or failed receipt.");
  }
  for (const event of run.events.filter((e) => e.type === "settled")) {
    if (
      BigInt(event.stream.earned) + BigInt(event.stream.refunded) !==
      BigInt(event.stream.deposit)
    )
      throw new Error("Settlement does not conserve funds.");
  }
  return {
    events: run.events.length,
    transactions: run.receipts.length + Number(Boolean(run.providerPayout)),
    finalHash: previousHash,
  };
}
