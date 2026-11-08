import "dotenv/config";
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  families,
  providers,
  makeTask,
  grade,
  decide,
  validateReply,
} from "../policy/toolbuyer-core.ts";
import {
  startProviders,
  visibleTasks,
  providerAnswer,
  purchaseUrl,
} from "./lib/toolbuyer-providers.mjs";
import { readConfig } from "./lib/config.mjs";
import { NearAgentStreamsClient } from "./sdk/index.mjs";

const { values } = parseArgs({
  options: {
    offline: { type: "boolean" },
    config: { type: "string" },
    seeds: { type: "string", default: "17" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  strict: true,
});
if (values.help)
  console.log(
    "Native ToolBuyer: node near/toolbuyer.mjs [--offline | --config <NEAR deployment>] [--seeds 17,29,43] [--json]\nSynthetic providers, benchmark credits, no wallet signing. Optional NEAR vault read establishes eligibility only."
  );
else {
  let service;
  try {
    if (!/^[1-9][0-9]*(,[1-9][0-9]*)*$/.test(values.seeds))
      throw new Error("Use comma-separated positive seeds.");
    const seeds = values.seeds.split(",").map(Number);
    if (
      seeds.length > 10 ||
      new Set(seeds).size !== seeds.length ||
      seeds.some((s) => !Number.isSafeInteger(s) || s > 1000000)
    )
      throw new Error("Use up to 10 unique seeds, each at most 1000000.");
    let eligibility = null;
    if (!values.offline && (values.config || process.env.NEAR_CONFIG)) {
      const config = await readConfig(values.config),
        client = new NearAgentStreamsClient({
          vaultId: config.vaultId,
          rpcUrl: config.rpcUrl,
        });
      const vault = await client.getVault();
      const remaining =
        BigInt(vault.policy.budget) -
        BigInt(vault.spent) -
        BigInt(vault.reserved);
      const raw =
        remaining < BigInt(vault.available)
          ? remaining
          : BigInt(vault.available);
      eligibility = {
        network: config.network,
        vaultId: config.vaultId,
        observedAt: vault.now,
        availableRaw: (vault.paused ? 0n : raw).toString(),
      };
    }
    service = await startProviders();
    const cohorts = [],
      rows = [];
    const request = async (kind, strategy, provider, task) => {
      const response = await fetch(
        purchaseUrl(service.url, kind, strategy, provider, task),
        { signal: AbortSignal.timeout(10000) }
      );
      if (!response.ok) throw new Error("Benchmark provider request failed.");
      return validateReply(
        task,
        provider,
        await response.json(),
        kind === "trial"
      );
    };
    for (const seed of seeds)
      for (const family of families) {
        const config = {
          seed,
          family,
          batchSize: 20,
          rewardRaw: 1000,
          budgetRaw: 20000,
          maxTrialSpendRaw: 2000,
          maxTrialsPerProvider: 12,
        };
        const balance = eligibility?.availableRaw || String(config.budgetRaw),
          observations = [],
          trace = [];
        let decision;
        for (let round = 0; round <= 36; round++) {
          decision = decide(config, observations, balance);
          trace.push(decision);
          if (decision.action !== "TRIAL") break;
          const task = makeTask(
            family,
            seed,
            100 +
              observations.filter((o) => o.provider === decision.provider)
                .length
          );
          const reply = await request(
            "trial",
            "toolbuyer",
            decision.provider,
            task
          );
          if (observations.some((o) => o.receiptId === reply.receiptId))
            throw new Error("Duplicate trial receipt.");
          observations.push({
            task,
            provider: reply.provider,
            answer: reply.answer,
            costRaw: reply.costRaw,
            receiptId: reply.receiptId,
          });
        }
        if (decision.action === "TRIAL")
          throw new Error("Trial limit exceeded.");
        const heldout = Array.from({ length: 20 }, (_, i) =>
          makeTask(family, seed, 10000 + i)
        );
        const inputKey = (t) =>
          JSON.stringify({ family: t.family, input: t.input });
        const seen = new Set(
          [...visibleTasks, ...observations.map((o) => o.task)].map(inputKey)
        );
        assert.ok(
          heldout.every((task) => !seen.has(inputKey(task))),
          "Held-out task leakage."
        );
        const eligible = Math.min(
          config.budgetRaw,
          Number(BigInt(balance) > 20000n ? 20000n : BigInt(balance))
        );
        const outcomes = [];
        for (const [strategy, proposed] of [
          ["toolbuyer", decision.provider],
          ["cheapest", "budget"],
          ["fixed-showcase", "showcase"],
          ["fixed-expert", "expert"],
        ]) {
          const trialCostRaw = strategy === "toolbuyer" ? decision.spentRaw : 0;
          const price = providers.find(
            (p) => p.id === proposed
          )?.serviceCostRaw;
          const provider =
            price && trialCostRaw + 20 * price <= eligible ? proposed : null;
          const answers = [];
          for (const task of heldout) {
            const reply = provider
              ? await request("service", strategy, provider, task)
              : { answer: null, costRaw: 0 };
            answers.push({ ...reply, correct: grade(task, reply.answer) });
          }
          const correct = answers.filter((a) => a.correct).length,
            serviceCostRaw = answers.reduce((s, a) => s + a.costRaw, 0);
          const row = {
            seed,
            family,
            strategy,
            provider,
            tasks: 20,
            correct,
            trialCostRaw,
            serviceCostRaw,
            totalCostRaw: trialCostRaw + serviceCostRaw,
            utilityRaw: correct * 1000 - trialCostRaw - serviceCostRaw,
            answers,
          };
          rows.push(row);
          outcomes.push(row);
        }
        cohorts.push({
          config,
          observations,
          trace,
          decision,
          heldout,
          outcomes,
        });
      }
    const totals = [
      "toolbuyer",
      "cheapest",
      "fixed-showcase",
      "fixed-expert",
    ].map((strategy) => {
      const selected = rows.filter((r) => r.strategy === strategy),
        sum = (key) => selected.reduce((s, r) => s + r[key], 0);
      assert.equal(
        service.ledger
          .filter((r) => r.account === strategy)
          .reduce((s, r) => s + r.costRaw, 0),
        sum("totalCostRaw")
      );
      return {
        strategy,
        tasks: sum("tasks"),
        correct: sum("correct"),
        totalCostRaw: sum("totalCostRaw"),
        utilityRaw: sum("utilityRaw"),
      };
    });
    const result = {
      schemaVersion: 1,
      runtime: "standalone-policy",
      network: eligibility?.network || "offline",
      billingMode: "benchmark-credits",
      tokenTransfers: false,
      eligibility,
      seeds,
      visible: providers.map((p) => ({
        provider: p.id,
        correct: visibleTasks.filter((t) => grade(t, providerAnswer(p.id, t)))
          .length,
        tasks: visibleTasks.length,
      })),
      totals,
      cohorts,
      ledger: service.ledger,
      limits: [
        "Synthetic providers; no commercial model quality claim.",
        "One-step information value is myopic.",
        "Eligibility reads do not reserve funds or settle purchases.",
      ],
    };
    const directory = `.local/near/toolbuyer/${randomUUID()}`;
    await mkdir(directory, { recursive: true });
    await writeFile(
      `${directory}/result.json`,
      JSON.stringify(result, null, 2)
    );
    if (values.json) console.log(JSON.stringify(result));
    else {
      console.table(totals);
      console.log(`Benchmark credits only. Evidence: ${directory}/result.json`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await service?.close();
  }
}
