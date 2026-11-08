import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { configHome } from './config.mjs';
import { atomicWrite, safeTarget } from './files.mjs';
import { inferenceConfig, validateInferenceKey } from './inference.mjs';

const profilePath = (home, project) => safeTarget(home, join('inference', createHash('sha256').update(project).digest('hex') + '.json'));

export async function readInferenceProfile(project, { withKey = false } = {}) {
  const home = configHome();
  let file;
  try { file = await open(await profilePath(home, project), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) || ((await stat(home)).mode & 0o077)) throw new Error('Inference credentials require a private configuration directory and file.');
    let saved;
    try { saved = JSON.parse(await file.readFile('utf8')); }
    catch { throw new Error('INVALID_INFERENCE_PROFILE'); }
    if (saved?.version !== 1 || !saved.inference) throw new Error('INVALID_INFERENCE_PROFILE');
    // A legacy credential reference should block inference, not inspection of the agent.
    const inference = inferenceConfig(withKey ? saved.inference : { ...saved.inference, apiKeyEnv: undefined });
    if (inference.apiKeyStored) validateInferenceKey(saved.apiKey);
    return { inference, ...(withKey && inference.apiKeyStored ? { apiKey: saved.apiKey } : {}) };
  } finally { await file.close(); }
}

export async function writeInferenceProfile(project, inference, apiKey) {
  const home = configHome();
  if ((await stat(home)).mode & 0o077) throw new Error('AGENTSTREAMS_HOME must have permissions 0700.');
  // Publish the endpoint and its credential together so interrupted updates cannot mix them.
  await atomicWrite(await profilePath(home, project), JSON.stringify({ version: 1, inference, apiKey }));
}

export async function promptInferenceKey() {
  const input = process.stdin;
  const terminal = Boolean(input.isTTY);
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const reader = createInterface({ input, output, terminal, historySize: 0, crlfDelay: Infinity });
  reader.once('SIGINT', () => reader.close());
  if (terminal) process.stderr.write('Inference API key (input hidden): ');
  try {
    for await (const line of reader) return validateInferenceKey(line);
    throw new Error('No inference API key entered.');
  } finally {
    reader.close();
    if (terminal) process.stderr.write('\n');
  }
}
