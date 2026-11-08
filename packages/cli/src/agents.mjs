import { createHash } from 'node:crypto';
import { mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { configHome, projectConfig, readProject, liveProfile } from './config.mjs';
import { atomicWrite, readOptional, safeTarget } from './files.mjs';
import { readInferenceProfile } from './inference-profile.mjs';

export const fingerprint = value => createHash('sha256').update(value).digest('hex');
const namePattern = /^[a-z][a-z0-9-]{0,30}$/;

async function directory(project, create = true) {
  const home = configHome();
  if (create) await mkdir(home, { recursive: true, mode: 0o700 });
  const info = await stat(home).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!info) return null;
  if ((info.mode & 0o077) !== 0) throw new Error('AGENTSTREAMS_HOME must have permissions 0700.');
  const path = await safeTarget(home, join('agents', fingerprint(project)));
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}

async function agentPath(project, name) {
  if (!namePattern.test(name ?? '')) throw new Error('Agent names use lowercase letters, digits and hyphens, starting with a letter.');
  return safeTarget(await directory(project), name);
}

export async function selectedAgent(project, explicit) {
  const pathToAgents = await directory(project, false);
  const name = explicit ?? (pathToAgents && (await readOptional(join(pathToAgents, 'selected')))?.trim());
  if (!name) return null;
  const path = await agentPath(project, name);
  const json = await readOptional(join(path, 'agent.json'));
  if (!json) throw new Error(`Agent ${name} does not exist in this project.`);
  const metadata = JSON.parse(json);
  return { ...metadata, name, path };
}

export async function createAgent(project, name) {
  const path = await agentPath(project, name);
  const key = KeyPair.fromRandom('ed25519');
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Agent ${name} already exists.`); throw error; }
  const publicKey = key.getPublicKey().toString();
  const agent = { version: 1, name, id: `ap_${fingerprint(publicKey)}`, publicKey, createdAt: new Date().toISOString() };
  await atomicWrite(join(path, 'feed-key'), key.toString());
  await atomicWrite(join(path, 'agent.json'), JSON.stringify(agent));
  await selectAgent(project, name);
  return { ...agent, next: 'agentstreams task list', paymentSetup: 'agentstreams agent setup --network testnet' };
}

export async function selectAgent(project, name) {
  const agent = await selectedAgent(project, name);
  await atomicWrite(join(await directory(project), 'selected'), agent.name + '\n');
  return { selected: agent.name, id: agent.id };
}

export async function listAgents(project) {
  const path = await directory(project);
  const selected = (await readOptional(join(path, 'selected')))?.trim() ?? null;
  const agents = [];
  for (const item of await readdir(path, { withFileTypes: true })) {
    if (!item.isDirectory() || !namePattern.test(item.name)) continue;
    const text = await readOptional(join(path, item.name, 'agent.json'));
    if (text) agents.push(JSON.parse(text));
  }
  return { selected, agents: agents.sort((a, b) => a.name.localeCompare(b.name)) };
}

export async function readAgentState(agent) {
  const text = await readOptional(join(agent.path, 'copy-state.json'));
  return text ? JSON.parse(text) : { version: 1, tasks: {}, history: [], subscribers: [], directory: {} };
}

export async function withAgentState(agent, update) {
  const lockPath = join(agent.path, 'copy-state.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('AGENT_BUSY: another command is updating this agent. If it crashed, reconcile before removing its lock.'); throw error; }
  try {
    await lock.writeFile(`${process.pid}\n`);
    const state = await readAgentState(agent);
    const save = () => atomicWrite(join(agent.path, 'copy-state.json'), JSON.stringify(state, null, 2));
    const result = await update(state, save);
    await save();
    return result;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function agentSetupState(agent) {
  const inference = (await readInferenceProfile(agent.path))?.inference ?? (await readAgentState(agent)).inference;
  if (await projectConfig(agent.path) === null) return { configured: false, ...(inference ? { inference } : {}) };
  await readProject(agent.path);
  const profile = await liveProfile(agent.path);
  const config = JSON.parse(await readOptional(profile.configPath));
  return { configured: true, network: config.network, vaultId: config.vaultId, nearAgentId: config.agentId, ownerId: config.ownerId, inference: inference ?? profile.inference ?? null, paymentsEnabled: profile.paymentsEnabled };
}

export async function feedKey(agent) {
  const file = await safeTarget(agent.path, 'feed-key');
  if (((await stat(file)).mode & 0o077) !== 0) throw new Error('Feed signing key must have permissions 0600.');
  const key = KeyPair.fromString((await readOptional(file)).trim());
  if (key.getPublicKey().toString() !== agent.publicKey) throw new Error('FEED_KEY_MISMATCH');
  return key;
}
