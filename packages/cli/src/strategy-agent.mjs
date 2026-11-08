import { readAgentState } from './agents.mjs';
import { runModelAgent } from './agent.mjs';
import { activityBlocker, nativeWalletActivities, strategyAction } from './strategy-actions.mjs';
import { runStrategyTask } from './strategy-runtime.mjs';

const shape = {
  'staking-moves': '{"pool":"lst.ref-dev.testnet","operation":"stake|unstake|withdraw","amount":"yoctoNEAR"}',
  'liquidity-ranges': '{"pool":"token_x|token_y|fee","left":integer,"right":integer,"amountX":"atomic units","amountY":"atomic units","minX":"atomic units","minY":"atomic units"}',
  'portfolio-rebalance': '{"poolId":integer,"base":"testnet token ID","amount":"maximum base atomic units","weights":{"testnet token ID":basis points}}',
  'yield-reallocation': '{"token":"testnet token ID","operation":"supply|withdraw","amount":"atomic units"}',
  'limit-orders': '{"pool":"token_x|token_y|fee","operation":"place","sellToken":"testnet token ID","point":integer,"amount":"atomic units"} or {"pool":"token_x|token_y|fee","operation":"cancel|claim","placement":"confirmed placement action ID"}',
};
const actionTool = description => ({ description, properties: { action: { type: 'string', description: 'JSON action using the schema in the system instructions.' } }, required: ['action'] });

export async function runStrategyAgent(agent, activity, inference, options = {}) {
  const loadState = options.loadState ?? readAgentState;
  const runTask = options.runTask ?? runStrategyTask;
  const state = await loadState(agent);
  if (!nativeWalletActivities.has(activity)) throw new Error(activityBlocker);
  if (state.tasks[activity]?.mode !== 'wallet') throw new Error('Enable the NEAR testnet activity first.');
  let preview, result;
  const results = [];
  const parse = args => {
    if (Object.keys(args ?? {}).length !== 1 || typeof args.action !== 'string' || args.action.length > 8192) throw new Error('INVALID_ACTIVITY_ACTION');
    return strategyAction(activity, JSON.parse(args.action));
  };
  const summary = fill => ({ status: fill.status, action: fill.action, actionId: fill.actionId ?? null,
    inputs: fill.inputs, evidence: fill.evidence, explorerUrl: fill.receipt?.explorerUrl ?? null,
    transactionHash: fill.receipt?.hash ?? null, signing: fill.receipt?.signing ?? null, sweep: fill.receipt?.sweep ?? null });
  const outcome = await runModelAgent(inference, {
    ...options,
    instructions: `Use the configured ${activity} on NEAR testnet. Action shape: ${shape[activity]}. Use atomic integer strings and basis points. Read the guard, then preview and apply once for every action the user requested. Preview again before every apply. A grant signs granted methods without a browser prompt and reports signing "grant". Say a wallet approval is required only when signing is "browser-wallet". Do not stop after the first confirmation. Limits cannot be changed through tools. Never invent a fill, reward, hash or transaction.`,
    definitions: {
      strategy_guard: { description: 'Read the testnet execution guard.', properties: {}, required: [] },
      strategy_preview: actionTool('Preview a guarded action using current venue data.'),
      strategy_apply: actionTool('Submit one previewed action. Preview again before submitting another. A grant signs it; otherwise the owner approves that action in the browser.'),
    },
    handlers: {
      async strategy_guard(args) {
        if (!args || Object.keys(args).length) throw new Error('INVALID_GUARD_QUERY');
        const current = await loadState(agent);
        return { policy: current.strategyPolicies?.[activity] };
      },
      async strategy_preview(args) {
        const action = parse(args);
        const checked = await runTask(agent, activity, action, { signal: options.signal });
        preview = { action: JSON.stringify(action), executionAccountId: checked.executionAccountId, at: Date.now() };
        return summary(checked);
      },
      async strategy_apply(args) {
        const action = parse(args);
        if (!preview || preview.action !== JSON.stringify(action) || preview.applied || Date.now() - preview.at > 30000) throw new Error('MATCHING_STRATEGY_PREVIEW_REQUIRED');
        preview.applied = true;
        result = await runTask(agent, activity, action, { execute: true, expectedExecutionAccountId: preview.executionAccountId, signal: options.signal });
        results.push(result);
        return summary(result);
      },
    },
  });
  return { ...outcome, activity, mode: 'wallet', result: result ?? null, results };
}
