// Testnet faucet tokens; the owner reviews and signs in the browser. --check is read-only.
import { parseArgs } from 'node:util';
import { withDemoOutput, demoOutputOptions, demoError } from './demo-support.mjs';

async function main() {
  const { values } = parseArgs({ options: demoOutputOptions });
  await withDemoOutput(values, ['demo', 'compute-top-up'], async ({ root, output, moduleAt }) => {
    if (values.help) return output.emit('node scripts/demo-compute-top-up.mjs [--check] [--json] [--color=always]');
    const { connectedOwner, ownerTransaction } = await moduleAt('owner-wallet');
    const owner = await connectedOwner({ required: true });
    if (owner.network !== 'testnet') throw new Error('Only a connected testnet wallet is permitted.');
    if (values.check) return output.emit({ type: 'demo-check', packageRoot: root, network: 'testnet', operation: 'Read-only: funding would request 0.1 test USDC.e for compute key #2. No transaction sent.' });
    const call = (methodName, args, gas, deposit = '0') => ({ type: 'FunctionCall', params: { methodName, args, gas, deposit } });
    const receipt = await ownerTransaction({ ownerId: owner.accountId, receiverId: 'usdc.fakes.testnet', rpcUrl: owner.rpcUrl,
      label: 'Demo: mint 0.1 test USDC.e and top up OutLayer compute key #2',
      actions: [call('mint', { account_id: owner.accountId, amount: '100000' }, '30000000000000'), call('ft_transfer_call', { receiver_id: 'outlayer.testnet', amount: '100000', msg: JSON.stringify({ action: 'top_up_payment_key', nonce: 2 }) }, '150000000000000', '1')],
      context: { kind: 'demo-compute-funding', amount: '100000', nonce: 2 } });
    output.emit({ type: 'compute-funded', network: 'testnet', computeKey: 2, amountRaw: '100000', tokenId: 'usdc.fakes.testnet', transactionHash: receipt.hash, explorerUrl: receipt.explorerUrl });
  });
}
main().catch(demoError);
