import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { readOptional, safeTarget } from './files.mjs';
import { readAgentState, withAgentState } from './agents.mjs';

function marker(agent, item) {
  const hash = createHash('sha256').update(item.sessionId + ':' + item.action.id).digest('hex');
  return join(agent.path, 'veto', hash + '.json');
}
export async function hasVeto(agent, item) {
  if (!item || !Number.isSafeInteger(item.blockUntil)) return false;
  const text = await readOptional(marker(agent, item));
  if (text === null) return false;
  let block;
  try { block = JSON.parse(text); } catch { throw new Error('COPY_VETO_RECORD_INVALID'); }
  if (block.actionId !== item.action.id || block.sessionId !== item.sessionId || !Number.isSafeInteger(block.at) || block.at >= item.blockUntil) throw new Error('COPY_VETO_RECORD_INVALID');
  return true;
}
export async function honorVeto(agent, item) {
  if (!await hasVeto(agent, item)) return false;
  item.status = 'blocked'; item.reason = 'OWNER_VETO'; return true;
}

// A block must remain writable while an RPC/attestation request holds agent state.
// A successful marker is created before the deadline. Submission checks it after
// that deadline, so accepted blocks cannot lose a race to a slow state lock.
export async function blockCopyAction(agent, id) {
  const state = await readAgentState(agent), item = state.pending?.[id], follow = state.follow;
  if (!follow) throw new Error('No copy subscription.');
  if (follow.status !== 'active' || follow.mode !== 'veto' || item?.sessionId !== follow.sessionId || item.status !== 'pending') throw new Error('Action is not pending for the active veto subscription.');
  if (await hasVeto(agent, item)) return { actionId: id, status: 'blocked' };
  if (Date.now() >= item.blockUntil) throw new Error('COPY_VETO_WINDOW_CLOSED');
  if (Date.now() >= item.action.expiresAt) throw new Error('ACTION_EXPIRED');
  const directory = await safeTarget(agent.path, 'veto');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let file;
  try { file = await open(await safeTarget(agent.path, 'veto/' + basename(marker(agent,item))), 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST' && await hasVeto(agent,item)) return { actionId:id,status:'blocked' }; throw error; }
  try {
    const at = Date.now();
    if (at >= item.blockUntil) throw new Error('COPY_VETO_WINDOW_CLOSED');
    await file.writeFile(JSON.stringify({ actionId:id,sessionId:item.sessionId,at }));
    await file.sync();
  } finally { await file.close(); }
  try { await withAgentState(agent, current => {
    if (current.pending?.[id]?.sessionId === item.sessionId && current.pending[id].status === 'pending') current.pending[id].status = 'blocked';
  }); } catch (error) { if (!error.message.startsWith('AGENT_BUSY')) throw error; }
  return { actionId:id,status:'blocked' };
}
