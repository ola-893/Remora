// Only testnet faucet tokens. The owner reviews and signs in their browser wallet.
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const {values}=parseArgs({options:{'cli-root':{type:'string'},help:{type:'boolean'}}});
if(values.help){console.log('node scripts/demo-compute-top-up.mjs --cli-root INSTALLED_CLI_PATH');process.exit(0);}
if(!values['cli-root'])throw new Error('--cli-root is required.');
const {connectedOwner,ownerTransaction}=await import(pathToFileURL(join(resolve(values['cli-root']),'src/owner-wallet.mjs')).href);
const owner=await connectedOwner({required:true});
if(owner.network!=='testnet')throw new Error('Only a connected testnet wallet is permitted.');
const call=(methodName,args,gas,deposit='0')=>({type:'FunctionCall',params:{methodName,args,gas,deposit}});
const receipt=await ownerTransaction({ownerId:owner.accountId,receiverId:'usdc.fakes.testnet',rpcUrl:owner.rpcUrl,
 label:'Demo: mint 0.1 test USDC.e and top up OutLayer compute key #2',
 actions:[call('mint',{account_id:owner.accountId,amount:'100000'},'30000000000000'),call('ft_transfer_call',{receiver_id:'outlayer.testnet',amount:'100000',msg:JSON.stringify({action:'top_up_payment_key',nonce:2})},'150000000000000','1')],
 context:{kind:'demo-compute-funding',amount:'100000',nonce:2}});
console.log(JSON.stringify({testnet:true,computeKey:2,amount:'0.1 test USDC.e',transactionHash:receipt.hash},null,2));
