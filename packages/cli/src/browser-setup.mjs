import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, PublicKey, actions, baseEncode, decodeSignedTransaction, keyToImplicitAddress } from 'near-api-js';
import { AGENT_METHODS, NearAgentStreamsClient, USDC, decodeOutcome } from '@ola-893/agentstreams-core/near';
import { deploymentPlan, inspectTestnet } from '@ola-893/agentstreams-core/internal-preflight';
import { DEFAULT_POLICY, writeKey } from '@ola-893/agentstreams-core/internal-deployment';
import { configHome, initProject, projectConfig } from './config.mjs';
import { atomicWrite, readOptional, safeTarget } from './files.mjs';
import { connectedOwner, ownerTransaction } from './owner-wallet.mjs';

const call = (methodName, args, gas = '100000000000000', deposit = '0') => ({ type: 'FunctionCall', params: { methodName, args, gas, deposit } });
const full = publicKey => ({ type: 'AddKey', params: { publicKey, accessKey: { nonce: 0, permission: 'FullAccess' } } });
const vaultArgs = (plan, agentPublicKey, policyPublicKey) => ({ owner_id: plan.ownerId, token_id: plan.tokenId ?? USDC.testnet, agent_id: plan.agentId, agent_key: agentPublicKey, policy_key: policyPublicKey, policy: { ...DEFAULT_POLICY, recipients: [plan.recipientId] } });
const vaultDeposit = '5000000000000000000000000';
const agentDeposit = '500000000000000000000000';
const agentAllowance = '250000000000000000000000';

export function browserDeploymentSteps({ plan, ownerPublicKey, agentPublicKey, policyPublicKey, wasm }) {
  return [
    { name: 'create-vault', receiverId: plan.vaultId, label: 'Create and initialize your agentStreams vault (5 test NEAR)', actions: [
      { type: 'CreateAccount' }, { type: 'Transfer', params: { deposit: vaultDeposit } }, full(ownerPublicKey),
      { type: 'DeployContract', params: { codeBase64: Buffer.from(wasm).toString('base64') } },
      call('new', vaultArgs(plan, agentPublicKey, policyPublicKey)),
    ] },
    { name: 'create-agent', receiverId: plan.agentId, label: 'Create your restricted agent account (0.5 test NEAR)', actions: [
      { type: 'CreateAccount' }, { type: 'Transfer', params: { deposit: agentDeposit } }, full(ownerPublicKey),
      { type: 'AddKey', params: { publicKey: agentPublicKey, accessKey: { nonce: 0, permission: { receiverId: plan.vaultId, methodNames: [...AGENT_METHODS], allowance: agentAllowance } } } },
    ] },
  ];
}

export function bootstrapActions(role, record, wasm, bootstrapPublicKey) {
  const { plan, ownerPublicKey, agentPublicKey, policyPublicKey } = record;
  const setup = role === 'vault' ? [
    actions.deployContract(wasm),
    actions.functionCall('new', vaultArgs(plan, agentPublicKey, policyPublicKey), 100000000000000n, 0n),
  ] : [actions.addFunctionCallAccessKey(PublicKey.fromString(agentPublicKey), plan.vaultId, [...AGENT_METHODS], BigInt(agentAllowance))];
  return [...setup, actions.addFullAccessKey(PublicKey.fromString(ownerPublicKey)), actions.deleteKey(bootstrapPublicKey)];
}

async function bootstrap(role, record, wasm, provider, save) {
  const name = `initialize-${role}`;
  const file = record.keyFiles[`${role}Bootstrap`];
  if (!record.steps.some(step => step.name === name)) {
    const accountId = record.plan[`${role}Id`];
    const signer = KeyPairSigner.fromSecretKey(JSON.parse(await readFile(file)).private_key);
    const publicKey = await signer.getPublicKey();
    if (keyToImplicitAddress(publicKey) !== accountId) throw new Error('BOOTSTRAP_ACCOUNT_MISMATCH');
    let pending = record.pendingBootstrap;
    if (pending && pending.role !== role) throw new Error('BOOTSTRAP_STEP_MISMATCH');
    let outcome, signed;
    if (pending) {
      // If the process died before broadcast, resubmit the identical signed transaction.
      const transaction = { txHash: pending.hash, accountId };
      outcome = await provider.viewTransactionStatus({ ...transaction, waitUntil: 'NONE' }).catch(error => {
        if (error.name !== 'UnknownTransactionError') throw error;
      });
      if (outcome && outcome.final_execution_status !== 'FINAL') outcome = await provider.viewTransactionStatus({ ...transaction, waitUntil: 'FINAL' });
      if (!outcome) signed = decodeSignedTransaction(Buffer.from(pending.signed, 'base64'));
    } else {
      const account = new Account(accountId, provider, signer);
      signed = await account.createSignedTransaction({ receiverId: accountId, actions: bootstrapActions(role, record, wasm, publicKey) });
      pending = { role, hash: baseEncode(createHash('sha256').update(signed.transaction.encode()).digest()), signed: Buffer.from(signed.encode()).toString('base64') };
      record.pendingBootstrap = pending;
      await save();
    }
    if (!outcome) {
      try {
        outcome = await provider.sendTransactionUntil(signed, 'FINAL');
      } catch (error) {
        if (error.name === 'TransactionExpiredError') {
          const key = await provider.viewAccessKey({ accountId, publicKey, blockQuery: { finality: 'final' } });
          if (BigInt(key.nonce) < signed.transaction.nonce) {
            // The expired transaction cannot land, and its nonce was never consumed.
            delete record.pendingBootstrap;
            await save();
            throw new Error('BOOTSTRAP_TRANSACTION_EXPIRED: repeat agent setup --resume --deploy.');
          }
        }
        throw error;
      }
    }
    if (outcome.final_execution_status !== 'FINAL' || outcome.transaction?.hash !== pending.hash) throw new Error(`BOOTSTRAP_OUTCOME_UNCONFIRMED: ${pending.hash}`);
    if (outcome.status?.Failure) {
      delete record.pendingBootstrap;
      await save();
      throw new Error(`BOOTSTRAP_TRANSACTION_FAILED: ${pending.hash} ${JSON.stringify(outcome.status.Failure)}`);
    }
    const receipt = decodeOutcome(outcome);
    if (receipt.receiptFailures.length) throw new Error(`BOOTSTRAP_RECEIPT_FAILED: ${pending.hash}`);
    const { keys } = await provider.viewAccessKeyList({ accountId, blockQuery: { finality: 'final' } });
    const ownerControlsAccount = keys.some(key => key.public_key === record.ownerPublicKey && key.access_key.permission === 'FullAccess');
    const bootstrapKeyRemoved = keys.every(key => key.public_key !== publicKey.toString());
    if (!ownerControlsAccount || !bootstrapKeyRemoved || keys.length !== (role === 'vault' ? 1 : 2)) throw new Error('BOOTSTRAP_KEY_ROTATION_UNCONFIRMED');
    record.steps.push({ name, ...receipt });
    delete record.pendingBootstrap;
    await save();
  }
  await rm(file, { force: true });
}

export async function setupWithBrowser(project, options, { wasmFile, transact = ownerTransaction, provider: provided } = {}) {
  const wallet = await connectedOwner({ required: true, ownerId: options.ownerId });
  const ownerId = wallet.accountId;
  const requestedPlan = deploymentPlan({ ownerId, recipientId: options.recipientId || ownerId, vaultLabel: options.vaultLabel, agentLabel: options.agentLabel, rpcUrl: options.rpcUrl || wallet.rpcUrl, serviceUrl: options.serviceUrl });
  const provider = provided || new JsonRpcProvider({ url: requestedPlan.rpcUrl });
  const home = configHome();
  if ((await stat(home)).mode & 0o077) throw new Error('AGENTSTREAMS_HOME must have permissions 0700.');
  const directory = await safeTarget(home, join('setups', createHash('sha256').update(project).digest('hex')));
  const recordFile = join(directory, 'browser-record.json');
  let record = JSON.parse(await readOptional(recordFile) || 'null');
  if (options.resume && (!record || !options.deploy)) throw new Error('Use --resume --deploy for an interrupted browser deployment.');
  if (record && !options.resume) throw new Error('DEPLOYMENT_RESUME_REQUIRED: inspect your wallet transactions, then use agent setup --resume --deploy.');
  if (record && JSON.stringify(record.requestedPlan ?? record.plan) !== JSON.stringify(requestedPlan)) throw new Error('DEPLOYMENT_PLAN_CHANGED');
  if (record && record.ownerPublicKey !== wallet.publicKey) throw new Error('DEPLOYMENT_OWNER_KEY_CHANGED');
  if (await projectConfig(project) !== null) throw new Error('PROJECT_ALREADY_INITIALIZED');
  const wasm = await readFile(wasmFile);
  const wasmSha256 = createHash('sha256').update(wasm).digest('hex');
  if (record && record.wasmSha256 !== wasmSha256) throw new Error('DEPLOYMENT_CONTRACT_CHANGED: resume with the same CLI contract build.');
  // Meteor declines app-requested deploy actions even when the target is a new subaccount.
  const implicit = record ? Boolean(record.requestedPlan) : wallet.walletId === 'meteor-wallet';
  const bootstrapKeys = !record && implicit ? { vaultBootstrap: KeyPair.fromRandom('ed25519'), agentBootstrap: KeyPair.fromRandom('ed25519') } : {};
  const plan = record?.plan ?? (implicit ? { ...requestedPlan, vaultId: keyToImplicitAddress(bootstrapKeys.vaultBootstrap.getPublicKey()), agentId: keyToImplicitAddress(bootstrapKeys.agentBootstrap.getPublicKey()) } : requestedPlan);
  const deploymentMode = implicit ? 'implicit-accounts' : 'named-subaccounts';
  if (!record) {
    const preflight = await inspectTestnet(plan, { provider, readWasm: async () => wasm, ownerPublicKey: wallet.publicKey });
    if (!options.deploy) return { ...preflight, deploymentMode, ...(implicit ? { provisionalAddresses: true } : {}), ownerSigning: 'browser-wallet', next: 'Repeat agent setup with --deploy. Each owner transaction opens a wallet approval.' };
    if (!preflight.readyToDeploy) throw new Error('TESTNET_PREFLIGHT_FAILED: ' + preflight.checks.filter(c => c.status !== 'pass').map(c => c.detail).join('; '));
    await mkdir(join(directory, '..'), { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 }).catch(error => {
      if (error.code === 'EEXIST') throw new Error('DEPLOYMENT_DIRECTORY_EXISTS: inspect the saved setup before continuing.');
      throw error;
    });
    const keys = { agent: KeyPair.fromRandom('ed25519'), policy: KeyPair.fromRandom('ed25519'), ...bootstrapKeys };
    const files = {};
    for (const [name, key] of Object.entries(keys)) files[name] = await writeKey(join(directory, 'keys'), name, name === 'agent' ? plan.agentId : null, key);
    record = { version: 1, wasmSha256, createdAt: new Date().toISOString(), status: 'deploying', plan, ...(implicit ? { requestedPlan } : {}), ownerPublicKey: wallet.publicKey, agentPublicKey: keys.agent.getPublicKey().toString(), policyPublicKey: keys.policy.getPublicKey().toString(), keyFiles: files, steps: [] };
    await atomicWrite(recordFile, JSON.stringify(record));
  }
  const reader = new NearAgentStreamsClient({ vaultId: plan.vaultId, provider });
  const save = () => atomicWrite(recordFile, JSON.stringify(record));
  const step = async (definition, beforeSubmit) => {
    if (record.steps.some(s => s.name === definition.name)) return;
    // Recover an already-confirmed browser operation before requesting another signature.
    if (options.resume) {
      const files = await readdir(join(home, 'owner-operations')).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const name of files.filter(f => f.endsWith('.json') && f !== 'pending.json')) {
        const previous = JSON.parse(await readFile(join(configHome(), 'owner-operations', name)));
        if (previous.status === 'confirmed' && previous.context?.recordFile === recordFile && previous.context?.step === definition.name) {
          record.steps.push({ name: definition.name, ...previous.receipt }); delete record.pendingStep; await save(); return;
        }
      }
    }
    record.pendingStep = definition.name; await save();
    const receipt = await transact({ ownerId, receiverId: definition.receiverId, actions: definition.actions, label: definition.label, rpcUrl: plan.rpcUrl, context: { kind: 'deployment', recordFile, step: definition.name } }, { provider, beforeSubmit });
    record.steps.push({ name: definition.name, ...receipt }); delete record.pendingStep; await save();
  };
  try {
    if (implicit) {
      for (const [role, deposit, amount] of [['vault', vaultDeposit, '5'], ['agent', agentDeposit, '0.5']]) {
        const accountId = plan[`${role}Id`];
        await step({ name: `fund-${role}-account`, receiverId: accountId, label: `Create your agentStreams ${role} account (${amount} test NEAR)`, actions: [{ type: 'Transfer', params: { deposit } }] }, async () => {
          const existing = await provider.viewAccount({ accountId, blockQuery: { finality: 'final' } }).catch(error => {
            if (error.name !== 'AccountDoesNotExistError') throw error;
          });
          if (existing) throw new Error('DEPLOYMENT_ACCOUNT_ALREADY_FUNDED: reconcile the saved wallet transfer before resuming setup.');
        });
        await bootstrap(role, record, wasm, provider, save);
      }
    } else {
      for (const definition of browserDeploymentSteps({ ...record, wasm })) await step(definition);
    }
    if ((await provider.viewAccount({ accountId: plan.vaultId, blockQuery: { finality: 'final' } })).code_hash !== baseEncode(createHash('sha256').update(wasm).digest())) throw new Error('DEPLOYED_CODE_HASH_MISMATCH');
    for (const account_id of [...new Set([plan.vaultId, ownerId, plan.recipientId])]) {
      if (await reader.view('storage_balance_of', { account_id }, USDC.testnet)) continue;
      const bounds = await reader.view('storage_balance_bounds', {}, USDC.testnet);
      await step({ name: 'register-usdc-' + account_id, receiverId: USDC.testnet, label: `Register ${account_id} for test USDC`, actions: [call('storage_deposit', { account_id, registration_only: true }, '30000000000000', bounds.min)] });
    }
    const config = { version: 1, network: 'testnet', rpcUrl: plan.rpcUrl, serviceUrl: plan.serviceUrl, ownerId, vaultId: plan.vaultId, agentId: plan.agentId, recipientId: plan.recipientId, tokenId: USDC.testnet, ownerSigning: 'browser-wallet', ownerRecoveryPublicKey: wallet.publicKey, agentKeyFile: record.keyFiles.agent, policyKeyFile: record.keyFiles.policy };
    const agentKey = JSON.parse(await readFile(config.agentKeyFile));
    const agent = new NearAgentStreamsClient({ ...config, accountId: config.agentId, privateKey: agentKey.private_key, provider });
    await agent.assertRestrictedAgent();
    await atomicWrite(join(directory, 'deployment.json'), JSON.stringify(config));
    await initProject(project, { deployment: join(directory, 'deployment.json') });
    record.status = 'deployed'; await save();
    return { status: 'DEPLOYED', network: 'testnet', deploymentMode, ownerSigning: 'browser-wallet', ownerId, vaultId: plan.vaultId, agentId: plan.agentId, recipientId: plan.recipientId, ownerUSDCFundingAddress: ownerId, paymentsEnabled: false, ownerPrivateKeyStored: false,
      transactions: record.steps.map(s => ({ step: s.name, hash: s.hash, explorerUrl: `https://testnet.nearblocks.io/txns/${s.hash}` })), next: 'Fund your owner wallet with Circle test USDC, then agentstream fund AMOUNT. The browser wallet approves funding.' };
  } catch (error) { record.status = 'needs-reconciliation'; await save(); throw error; }
}
