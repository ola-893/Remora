import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { readOptional, atomicWrite, safeTarget } from './files.mjs';

export function configHome() {
  const override = process.env.AGENTSTREAMS_HOME || process.env.AGENTPAY_HOME;
  if (override) return resolve(override);
  const current = join(homedir(), '.agentstreams');
  const legacy = join(homedir(), '.agentpay');
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
}
export async function projectPath(path = '.') { return realpath(resolve(path)); }
const idFor = project => createHash('sha256').update(project).digest('hex');

export async function projectConfig(project) {
  const current = await readOptional(await safeTarget(project, '.agentstreams/config.json'));
  return current ?? readOptional(await safeTarget(project, '.agentpay/config.json'));
}

export async function readProject(project) {
  const text = await projectConfig(project);
  if (text === null) throw new Error('Project is not initialized. Run agentstreams init --network testnet.');
  const config = JSON.parse(text);
  if (config.version !== 1 || !['offline', 'testnet'].includes(config.mode)) throw new Error('Unsupported agentStreams configuration.');
  if (config.mode === 'testnet' && config.profileId !== idFor(project)) throw new Error('Live profile belongs to a different project; initialize this project explicitly.');
  return config;
}

export async function initProject(project, { deployment, enablePayments = false } = {}) {
  const path = await safeTarget(project, '.agentstreams/config.json');
  if (await projectConfig(project) !== null) throw new Error('Project already initialized. Use a separate project for another mode; agentstreams payments changes live enablement.');
  if (!deployment) throw new Error('Use --network testnet --deployment /absolute/path/deployment.json.');
  const { readConfig, readKey } = await import('@ola-893/agentstreams-core/internal-config');
  const sourcePath = resolve(deployment);
  const source = await readConfig(sourcePath);
  if (source.network !== 'testnet') throw new Error('Live profiles currently support testnet only.');
  const agent = await readKey(resolve(dirname(sourcePath), source.agentKeyFile));
  const policy = await readKey(resolve(dirname(sourcePath), source.policyKeyFile));
  if (agent.accountId !== source.agentId || agent.publicKey === policy.publicKey) throw new Error('CREDENTIAL_IDENTITY_MISMATCH');
  const home = configHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (((await stat(home)).mode & 0o077) !== 0) throw new Error('AGENTSTREAMS_HOME must have permissions 0700.');
  const profileId = idFor(project);
  const directory = join(home, 'profiles', profileId);
  const profilePath = await safeTarget(home, join('profiles', profileId, 'profile.json'));
  if (await readOptional(profilePath)) throw new Error('A private profile already exists for this project; refusing to overwrite keys.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const agentKeyFile = await safeTarget(home, join('profiles', profileId, 'agent.json'));
  const policyKeyFile = await safeTarget(home, join('profiles', profileId, 'policy.json'));
  for (const [file, credential] of [[agentKeyFile, agent], [policyKeyFile, policy]]) {
    if (await readOptional(file)) throw new Error('Credential already exists; refusing to replace it.');
    await atomicWrite(file, JSON.stringify({ account_id: credential.accountId, public_key: credential.publicKey, private_key: credential.privateKey }));
  }
  const runtime = Object.fromEntries(['network', 'rpcUrl', 'serviceUrl', 'vaultId', 'agentId', 'ownerId', 'recipientId', 'tokenId', 'runtimePolicy', 'service'].map(k => [k, source[k]]));
  const configPath = join(directory, 'deployment.json');
  await atomicWrite(configPath, JSON.stringify({ ...runtime, agentKeyFile, policyKeyFile }, null, 2));
  await atomicWrite(profilePath, JSON.stringify({ version: 1, paymentsEnabled: Boolean(enablePayments) }));
  await atomicWrite(path, JSON.stringify({ version: 1, mode: 'testnet', profileId }, null, 2) + '\n');
  return { mode: 'testnet', paymentsEnabled: Boolean(enablePayments), vaultId: runtime.vaultId, agentId: runtime.agentId, importedAuthorities: ['agent', 'policy'], next: 'agentstreams doctor' };
}

export async function liveProfile(project) {
  const config = await readProject(project);
  if (config.mode !== 'testnet') throw new Error('This project has no live testnet profile.');
  const home = configHome();
  const file = await safeTarget(home, join('profiles', config.profileId, 'profile.json'));
  if (((await stat(file)).mode & 0o077) !== 0) throw new Error('Private profile must have permissions 0600.');
  const profile = JSON.parse(await readOptional(file));
  return { ...profile, file, configPath: await safeTarget(home, join('profiles', config.profileId, 'deployment.json')), stateRoot: join(home, 'state') };
}

export async function setPayments(project, enabled) {
  const profile = await liveProfile(project);
  const { file, configPath, stateRoot, ...saved } = profile;
  await atomicWrite(profile.file, JSON.stringify({ ...saved, paymentsEnabled: Boolean(enabled) }));
  return { mode: 'testnet', paymentsEnabled: Boolean(enabled) };
}

export async function gatewayFor(project) {
  const config = await readProject(project);
  if (config.mode === 'offline') throw new Error('A native NEAR testnet profile is required. Initialize a new project with agentstreams init --network testnet.');
  const { createNearGateway } = await import('@ola-893/agentstreams-core/near');
  return createNearGateway({ ...await liveProfile(project), paymentsEnabled: async () => Boolean((await liveProfile(project)).paymentsEnabled) });
}
