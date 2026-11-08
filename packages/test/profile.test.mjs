import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm, mkdir, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { initProject, liveProfile, setPayments, readProject, configHome } from '../cli/src/config.mjs';

test('live profile imports only separate runtime credentials, defaults readonly and binds to its project', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentpay-profile-')));
  const original = process.env.AGENTSTREAMS_HOME;
  process.env.AGENTSTREAMS_HOME = join(root, 'private');
  t.after(async () => { if (original === undefined) delete process.env.AGENTSTREAMS_HOME; else process.env.AGENTSTREAMS_HOME = original; await rm(root, { recursive: true, force: true }); });
  const project = join(root, 'project');
  await mkdir(project);
  const agent = KeyPair.fromRandom('ed25519'), policy = KeyPair.fromRandom('ed25519');
  for (const [name, key] of [['agent', agent], ['policy', policy]]) await writeFile(join(root, `${name}.json`), JSON.stringify({ account_id: name === 'agent' ? 'agent.testnet' : undefined, private_key: key.toString() }), { mode: 0o600 });
  const source = {
    network: 'testnet', rpcUrl: 'https://test.rpc.fastnear.com', serviceUrl: 'http://127.0.0.1:5321', vaultId: 'vault.testnet', agentId: 'agent.testnet', ownerId: 'owner.testnet', recipientId: 'provider.testnet', tokenId: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
    agentKeyFile: join(root, 'agent.json'), policyKeyFile: join(root, 'policy.json'), ownerKeyFile: '/DO-NOT-READ/owner.json', providerKeyFile: '/DO-NOT-READ/provider.json', unrelatedSecret: 'must-not-copy',
  };
  const deployment = join(root, 'deployment.json');
  await writeFile(deployment, JSON.stringify(source));
  assert.equal((await initProject(project, { deployment })).paymentsEnabled, false);
  let profile = await liveProfile(project);
  const runtime = JSON.parse(await readFile(profile.configPath, 'utf8'));
  assert.equal(runtime.ownerKeyFile, undefined);
  assert.equal(runtime.providerKeyFile, undefined);
  assert.equal(runtime.unrelatedSecret, undefined);
  assert.notEqual(runtime.agentKeyFile, runtime.policyKeyFile);
  for (const path of [profile.file, profile.configPath, runtime.agentKeyFile, runtime.policyKeyFile]) assert.equal((await stat(path)).mode & 0o777, 0o600);
  const config = await readFile(join(project, '.agentstreams/config.json'), 'utf8');
  assert.equal(config.includes('private_key'), false);
  assert.equal(config.includes(root), false);
  await setPayments(project, true);
  profile = await liveProfile(project);
  assert.equal(profile.paymentsEnabled, true);
  const other = join(root, 'other');
  await mkdir(join(other, '.agentstreams'), { recursive: true });
  await writeFile(join(other, '.agentstreams/config.json'), config);
  await assert.rejects(readProject(other), /different project/);
  await rename(join(project, '.agentstreams'), join(project, '.agentpay'));
  assert.equal((await liveProfile(project)).paymentsEnabled, true);
  await assert.rejects(initProject(project, { deployment }), /already initialized/);
  const legacyHome = process.env.AGENTPAY_HOME;
  try {
    delete process.env.AGENTSTREAMS_HOME;
    process.env.AGENTPAY_HOME = join(root, 'private');
    assert.equal(configHome(), join(root, 'private'));
    assert.equal((await liveProfile(project)).paymentsEnabled, true);
  } finally {
    if (legacyHome === undefined) delete process.env.AGENTPAY_HOME;
    else process.env.AGENTPAY_HOME = legacyHome;
  }
});
