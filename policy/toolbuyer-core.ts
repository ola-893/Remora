import { z } from "zod";

export const families = ["invoice", "units", "routing"] as const;
export type Family = (typeof families)[number];
export const providerIds = ["budget", "expert", "showcase"] as const;
export type ProviderId = (typeof providerIds)[number];
export const providers = [
  { id: "budget", label: "Cheap / weak", trialCostRaw: 30, serviceCostRaw: 80 },
  {
    id: "expert",
    label: "Costly / strong",
    trialCostRaw: 90,
    serviceCostRaw: 300,
  },
  {
    id: "showcase",
    label: "Visible-example specialist",
    trialCostRaw: 45,
    serviceCostRaw: 150,
  },
] as const;
export type Task = { id: string; family: Family; input: any };
export type Observation = {
  task: Task;
  provider: ProviderId;
  answer: string;
  costRaw: number;
  receiptId: string;
};
export const taskSchema = z
  .object({
    id: z.string().min(1).max(100),
    family: z.enum(families),
    input: z.record(z.unknown()),
  })
  .strict();
export const replySchema = z
  .object({
    taskId: z.string(),
    provider: z.enum(providerIds),
    answer: z.string().max(1000),
    costRaw: z.number().int().nonnegative(),
    receiptId: z.string().min(1),
    billingMode: z.literal("benchmark-credits"),
  })
  .strict();
export type CoreConfig = {
  seed: number;
  family: Family;
  batchSize: number;
  rewardRaw: number;
  budgetRaw: number;
  maxTrialSpendRaw: number;
  maxTrialsPerProvider: number;
};

// Deterministic test inputs, not recorded model answers. Trial and evaluation
// namespaces occupy disjoint numeric ranges, and labels never enter decisions.
export function makeTask(family: Family, seed: number, index: number): Task {
  let state = ((seed * 2654435761) ^ (index * 2246822519)) >>> 0;
  const next = (n: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % n;
  };
  let input: any;
  if (family === "invoice")
    input = {
      lines: Array.from({ length: 2 + next(4) }, () => ({
        unitRaw: 101 + next(100000),
        quantity: 1 + next(6),
      })),
      discountBps: [0, 100, 500, 1250][next(4)],
    };
  else if (family === "units")
    input = {
      usdc: `${1 + next(900)}.${String(next(1000000)).padStart(6, "0")}`,
    };
  else
    input = {
      routes: Array.from({ length: 3 }, (_, i) => ({
        id: `route-${i}`,
        feeRaw: 10 + next(200),
        latencyMs: 1 + next(100),
      })),
      maxLatencyMs: [30, 60, 100][next(3)],
    };
  return { id: `${family}-${seed}-${index}`, family, input };
}
export function expectedAnswer(task: Task): string {
  const x = task.input;
  if (task.family === "invoice")
    return (
      (x.lines.reduce(
        (sum: bigint, l: any) => sum + BigInt(l.unitRaw) * BigInt(l.quantity),
        0n
      ) *
        BigInt(10000 - x.discountBps)) /
      10000n
    ).toString();
  if (task.family === "units") {
    const [whole, fraction = ""] = x.usdc.split(".");
    return (
      BigInt(whole) * 1000000n +
      BigInt(fraction.padEnd(6, "0"))
    ).toString();
  }
  const routes = x.routes
    .filter((r: any) => r.latencyMs <= x.maxLatencyMs)
    .sort((a: any, b: any) => a.feeRaw - b.feeRaw || a.id.localeCompare(b.id));
  return routes[0]?.id || "NONE";
}
export function grade(task: Task, answer: string): boolean {
  return answer === expectedAnswer(task);
}
export function summarize(observations: Observation[]) {
  return providers.map((p) => {
    const trials = observations.filter((o) => o.provider === p.id);
    const wins = trials.filter((o) => grade(o.task, o.answer)).length;
    const alpha = 1 + wins,
      beta = 1 + trials.length - wins;
    const mean = alpha / (alpha + beta);
    return {
      ...p,
      trials: trials.length,
      successes: wins,
      alpha,
      beta,
      mean,
      sd: Math.sqrt(
        (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1))
      ),
    };
  });
}
export function decide(
  c: CoreConfig,
  observations: Observation[],
  balanceRaw: string
) {
  const stats = summarize(observations),
    spentRaw = observations.reduce((s, o) => s + o.costRaw, 0);
  const available = Math.min(
    c.budgetRaw,
    Number(
      BigInt(balanceRaw) > BigInt(c.budgetRaw)
        ? BigInt(c.budgetRaw)
        : BigInt(balanceRaw)
    )
  );
  const utility = (p: (typeof stats)[number], mean = p.mean) =>
    c.batchSize * (c.rewardRaw * mean - p.serviceCostRaw);
  const feasible = stats.filter(
    (p) => spentRaw + c.batchSize * p.serviceCostRaw <= available
  );
  const best = feasible
    .slice()
    .sort((a, b) => utility(b) - utility(a) || a.id.localeCompare(b.id))[0];
  const current = Math.max(0, ...feasible.map((p) => utility(p)));
  const candidates = stats
    .filter(
      (p) =>
        p.trials < c.maxTrialsPerProvider &&
        spentRaw + p.trialCostRaw <= c.maxTrialSpendRaw &&
        spentRaw + p.trialCostRaw <= available
    )
    .map((p) => {
      // Exact one-step expected value of sample information under independent
      // Beta(1,1)-Bernoulli beliefs. Abstaining (utility zero) is always possible.
      const after = (success: boolean) =>
        Math.max(
          0,
          ...stats
            .filter(
              (q) =>
                spentRaw + p.trialCostRaw + c.batchSize * q.serviceCostRaw <=
                available
            )
            .map((q) =>
              utility(
                q,
                q.id === p.id
                  ? (p.alpha + Number(success)) / (p.alpha + p.beta + 1)
                  : q.mean
              )
            )
        );
      const grossValueRaw =
        p.mean * after(true) + (1 - p.mean) * after(false) - current;
      return {
        provider: p.id,
        grossValueRaw,
        costRaw: p.trialCostRaw,
        netValueRaw: grossValueRaw - p.trialCostRaw,
      };
    })
    .sort(
      (a, b) =>
        b.netValueRaw - a.netValueRaw || a.provider.localeCompare(b.provider)
    );
  const next = candidates[0];
  if (next && next.netValueRaw > 1e-8)
    return {
      action: "TRIAL" as const,
      provider: next.provider,
      reason: "EXPECTED_INFORMATION_VALUE_EXCEEDS_COST",
      spentRaw,
      stats,
      candidates,
      expectedNetUtilityRaw: current - spentRaw,
    };
  return {
    action: best && utility(best) > 0 ? ("BUY" as const) : ("ABSTAIN" as const),
    provider: best && utility(best) > 0 ? best.id : null,
    reason: candidates.length
      ? "NO_POSITIVE_ONE_STEP_INFORMATION_VALUE"
      : "TRIAL_LIMIT_OR_BUDGET",
    spentRaw,
    stats,
    candidates,
    expectedNetUtilityRaw: current - spentRaw,
  };
}
export function validateReply(
  task: Task,
  provider: ProviderId,
  value: unknown,
  trial: boolean
) {
  const r = replySchema.parse(value),
    quote = providers.find((p) => p.id === provider)!;
  if (
    r.taskId !== task.id ||
    r.provider !== provider ||
    r.costRaw !== (trial ? quote.trialCostRaw : quote.serviceCostRaw)
  )
    throw new Error(
      "Provider reply does not match task, provider or quoted raw-unit cost"
    );
  return r;
}
export function plan(
  c: CoreConfig,
  balanceRaw: string,
  buyTrial: (task: Task, provider: ProviderId) => unknown
) {
  const observations: Observation[] = [],
    trace: any[] = [];
  for (let round = 0; round <= 3 * c.maxTrialsPerProvider; round++) {
    const d = decide(c, observations, balanceRaw);
    trace.push(d);
    if (d.action !== "TRIAL") return { decision: d, observations, trace };
    const n = observations.filter((o) => o.provider === d.provider).length;
    const task = makeTask(c.family, c.seed, 100 + n);
    const reply = validateReply(
      task,
      d.provider!,
      buyTrial(task, d.provider!),
      true
    );
    if (observations.some((o) => o.receiptId === reply.receiptId))
      throw new Error("Duplicate trial receipt");
    observations.push({
      task,
      provider: d.provider!,
      answer: reply.answer,
      costRaw: reply.costRaw,
      receiptId: reply.receiptId,
    });
  }
  throw new Error("Trial loop exceeded its bound");
}
