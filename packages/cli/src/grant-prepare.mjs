import { grantAccount, signGrantedTransaction } from './agent-grant.mjs';
import { rawAmount } from './copy-activity.mjs';
import { connectedOwner } from './owner-wallet.mjs';
import { DCL, EXCHANGE, LENDING, tokenId } from './strategy-actions.mjs';
import { integerAmount, testnetViews } from './strategy-markets.mjs';

const WRAP = 'wrap.testnet';
const venues = {
  'portfolio-rebalance': EXCHANGE,
  'liquidity-ranges': DCL,
  'limit-orders': DCL,
  'yield-reallocation': LENDING,
};

export async function prepareGrant({ agentId, ownerId, activity, token, balance = '0' }, {
  connect = connectedOwner, accountFor = grantAccount, views = testnetViews, transact = signGrantedTransaction,
} = {}) {
  const venue = Object.hasOwn(venues, activity) ? venues[activity] : null;
  if (!venue || !tokenId(token) || (balance !== '0' && !rawAmount(balance))) {
    throw new Error('Provide a supported grant --activity, --token and an optional --balance-raw target.');
  }
  const wallet = await connect({ required: true, ownerId });
  const account_id = await accountFor(wallet.accountId, agentId, activity);
  if (!account_id) throw new Error('A matching grant is required.');
  const { rpcUrl } = wallet;
  const read = async (contract, method, args) => (await views(rpcUrl)).view(contract, method, args);
  const receipts = [];
  async function submit(receiverId, methodName, args, deposit, check) {
    const receipt = await transact({
      ownerId: wallet.accountId, agentId, executionAccountId: account_id, receiverId, rpcUrl,
      context: { kind: 'grant-preparation', activity },
      actions: [{ type: 'FunctionCall', params: { methodName, args, deposit, gas: '150000000000000' } }],
    }, { beforeSubmit: async () => {
      if (!await check()) throw new Error('GRANT_PREPARATION_CHANGED: run the same target again.');
    } });
    receipts.push(receipt);
    return receipt;
  }
  async function register(contract) {
    const registered = () => read(contract, 'storage_balance_of', { account_id });
    if (await registered()) return;
    const { min } = await read(contract, 'storage_balance_bounds', {});
    if (!rawAmount(min)) throw new Error('GRANT_STORAGE_COST_UNKNOWN');
    await submit(contract, 'storage_deposit', { account_id, registration_only: true }, min, async () => !await registered());
    if (!await registered()) throw new Error('GRANT_STORAGE_UNCONFIRMED');
  }
  const walletBalance = async () => integerAmount(await read(token, 'ft_balance_of', { account_id }));
  const exchangeBalance = async () => integerAmount((await read(EXCHANGE, 'get_deposits', { account_id }))[token] ?? '0');
  const target = BigInt(balance);
  await register(token);
  await register(venue);
  const deposited = venue === EXCHANGE && target ? await exchangeBalance() : 0n;
  const needed = target > deposited ? target - deposited : 0n;
  if (needed) {
    const held = await walletBalance();
    if (held < needed) {
      if (token !== WRAP) throw new Error(`Fund the execution account ${account_id} with ${token}, then retry the same target.`);
      await submit(WRAP, 'near_deposit', {}, (needed - held).toString(), async () => await walletBalance() === held);
      if (await walletBalance() < needed) throw new Error('GRANT_WRAP_UNCONFIRMED');
    }
    if (venue === EXCHANGE) {
      const amount = needed.toString();
      const receipt = await submit(token, 'ft_transfer_call', { receiver_id: EXCHANGE, amount, msg: '' }, '1',
        async () => await exchangeBalance() === deposited && await walletBalance() >= needed);
      if (receipt.value !== amount || await exchangeBalance() < target) throw new Error(`GRANT_DEPOSIT_UNCONFIRMED: inspect ${receipt.explorerUrl}.`);
    }
  }
  return { executionAccountId: account_id, activity, token, targetBalance: balance,
    balanceLocation: venue === EXCHANGE ? 'exchange' : 'execution-wallet', receipts };
}
