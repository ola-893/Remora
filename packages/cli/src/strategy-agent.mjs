import { readAgentState } from './agents.mjs';
import { runModelAgent } from './agent.mjs';
import { activityBlocker, nativeWalletActivities, strategyAction } from './strategy-actions.mjs';
import { runStrategyTask } from './strategy-runtime.mjs';

const shape = {
  'staking-moves': '{"pool":"lst.ref-dev.testnet","operation":"stake|unstake|withdraw","amount":"yoctoNEAR"}',
  'liquidity-ranges': '{"pool":"token_x|token_y|fee","left":integer,"right":integer,"amountX":"atomic units","amountY":"atomic units","minX":"atomic units","minY":"atomic units"}',
  'portfolio-rebalance': '{"poolId":integer,"base":"testnet token ID","amount":"maximum base atomic units","weights":{"testnet token ID":basis points}}',
  'yield-reallocation': '{"token":"testnet token ID","operation":"supply|withdraw","amount":"atomic units"}',
  'reward-reinvestment': '{"operation":"compound"}',
};
const actionTool = description => ({ description, properties: { action: { type: 'string', description: 'JSON action using the schema in the system instructions.' } }, required: ['action'] });

export async function runStrategyAgent(agent, activity, inference, options) {
  const state = await readAgentState(agent);
  if (!nativeWalletActivities.has(activity)) throw new Error(activityBlocker);
  if (state.tasks[activity]?.mode !== 'wallet') throw new Error('Enable the NEAR testnet activity first.');
  let preview, result, approvalRequested = false;
  const parse = args => {
    if (Object.keys(args ?? {}).length !== 1 || typeof args.action !== 'string' || args.action.length > 8192) throw new Error('INVALID_ACTIVITY_ACTION');
    return strategyAction(activity, JSON.parse(args.action));
  };
  const summary = fill => ({ status: fill.status, action: fill.action, actionId: fill.actionId ?? null,
    inputs: fill.inputs, evidence: fill.evidence, explorerUrl: fill.receipt?.explorerUrl });
  const outcome = await runModelAgent(inference, {
    ...options,
    instructions: `Use the configured ${activity} on NEAR testnet. The connected owner must approve each transaction in their browser. Action shape: ${shape[activity]}. Use atomic integer strings and basis points. Read the guard, preview, and apply the exact same action only if asked. Limits cannot be changed through tools. Never invent a fill, reward or transaction.`,
    definitions: {
      strategy_guard: { description: 'Read the testnet execution guard.', properties: {}, required: [] },
      strategy_preview: actionTool('Preview a guarded action using current venue data.'),
      strategy_apply: actionTool('Request browser wallet approval for the same previewed action after checking fresh testnet data.'),
    },
    handlers: {
      async strategy_guard(args) {
        if (!args || Object.keys(args).length) throw new Error('INVALID_GUARD_QUERY');
        const current = await readAgentState(agent);
        return { policy: current.strategyPolicies?.[activity] };
      },
      async strategy_preview(args) {
        const action = parse(args);
        const checked = await runStrategyTask(agent, activity, action, { noOpen: options.noOpen, signal: options.signal });
        preview = { action: JSON.stringify(action), at: Date.now() };
        return summary(checked);
      },
      async strategy_apply(args) {
        const action = parse(args);
        if (approvalRequested) throw new Error('STRATEGY_APPROVAL_ALREADY_REQUESTED');
        if (!preview || preview.action !== JSON.stringify(action) || Date.now() - preview.at > 30000) throw new Error('MATCHING_STRATEGY_PREVIEW_REQUIRED');
        approvalRequested = true;
        result = await runStrategyTask(agent, activity, action, { execute: true, noOpen: options.noOpen, signal: options.signal });
        return summary(result);
      },
    },
    finishOnTool: item => item.status === 'wallet-confirmed' ? `NEAR testnet ${activity} confirmed. ${item.explorerUrl}` : undefined,
  });
  return { ...outcome, activity, mode: 'wallet', result: result ?? null };
}
