import { runModelAgent } from './agent.mjs';
import { readAgentState, withAgentState } from './agents.mjs';
import { spot, spotOrder } from './copy-activity.mjs';
import { runSpotTask } from './copy-runtime.mjs';
import { describePaperFill } from './paper-trading.mjs';

const orderProperties = {
  from: { type: 'string', description: 'Exact input asset ID from the portfolio tool.' },
  to: { type: 'string', description: 'Exact output asset ID allowed by the execution policy.' },
  amount: { type: 'string', description: 'Positive integer input amount in atomic units, encoded as a string.' },
};
const definitions = {
  agentstreams_trade_portfolio: { description: 'Read paper balances and the operator execution policy.', properties: {}, required: [] },
  agentstreams_trade_quote: { description: 'Get a live signed 1Click dry quote for an exact order. Does not fill it.', properties: orderProperties, required: Object.keys(orderProperties) },
  agentstreams_trade_execute: { description: 'Apply the same quoted order to the virtual portfolio with a fresh checked quote. At most one fill per run.', properties: orderProperties, required: Object.keys(orderProperties) },
};

function orderFrom(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 3 ||
      Object.keys(args).some(key => !Object.hasOwn(orderProperties, key))) throw new Error('INVALID_TRADE_ORDER');
  return spotOrder(args);
}

export async function runTradingAgent(agent, inference, options) {
  const state = await readAgentState(agent);
  if (state.tasks[spot]?.mode !== 'paper') throw new Error('Enable spot-trading with --paper-balances for prompted trading.');
  if (!state.executionPolicy) throw new Error('Set an execution guard with agentstreams guard set execution before running a trading prompt.');
  let quoted, fill, outcome, lastDenial;
  const handlers = {
    async agentstreams_trade_portfolio(args) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw new Error('INVALID_PORTFOLIO_QUERY');
      const current = await readAgentState(agent);
      return { mode: 'paper', balances: current.paper.balances, policy: current.executionPolicy };
    },
    async agentstreams_trade_quote(args) {
      const order = orderFrom(args);
      const result = await runSpotTask(agent, order, false, { requirePaper: true });
      const { signedResponse, ...quote } = result.quote;
      quoted = { order, quote };
      return quote;
    },
    async agentstreams_trade_execute(args) {
      const order = orderFrom(args);
      if (fill) throw new Error('RUN_TRADE_LIMIT');
      if (!quoted || Object.keys(order).some(key => order[key] !== quoted.order[key])) throw new Error('MATCHING_QUOTE_REQUIRED');
      options.signal?.throwIfAborted();
      const result = await runSpotTask(agent, order, true, { requirePaper: true, referenceQuote: quoted.quote });
      fill = result.fill;
      return result;
    },
  };
  try {
    outcome = await runModelAgent(inference, {
      ...options, definitions, handlers,
      instructions: 'You trade in an operator-configured paper portfolio. Read the portfolio, select an eligible order based on the user prompt and get a signed quote. If the user asks to place a trade and the quote satisfies their instructions, execute the same order with the trade execution tool. A quote alone does not place a trade. Tool inputs and portfolio balances use atomic integer units. Use the quote’s formatted amounts when discussing token quantities. The CLI reports the fill after a successful trade. If limits or balances block a trade, report the denial.',
      finishOnTool: result => result.status === 'paper-filled' ? describePaperFill(result.fill) : undefined,
      emit(event) {
        if (event.result?.decision === 'DENY') lastDenial = event.result.reason;
        options.emit?.(event);
      },
    });
    return { ...outcome, activity: spot, mode: 'paper', fill: fill ?? null, ...(lastDenial ? { lastDenial } : {}) };
  } finally {
    await withAgentState(agent, current => {
      current.lastRun = { at: new Date().toISOString(), activity: spot, mode: 'paper', provider: inference.provider, model: inference.model,
        completed: Boolean(outcome), fillId: fill?.id ?? null, ...(lastDenial ? { lastDenial } : {}) };
    });
  }
}
