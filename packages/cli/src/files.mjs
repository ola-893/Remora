import { realpath, lstat, mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';

export async function readOptional(path) {
  try { return await readFile(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export async function safeTarget(root, target) {
  const base = await realpath(root);
  const path = resolve(base, target);
  const rel = relative(base, path);
  if (rel.startsWith(`..${sep}`) || rel === '..' || !rel) throw new Error('UNSAFE_CONFIG_PATH');
  let cursor = base;
  for (const part of rel.split(sep)) {
    cursor = resolve(cursor, part);
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('SYMLINK_CONFIG_REFUSED'); }
    catch (e) { if (e.code === 'ENOENT') break; throw e; }
  }
  return path;
}

export async function atomicWrite(path, content, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.agentstreams-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temp, content, { flag: 'wx', mode });
  await rename(temp, path);
  await chmod(path, mode);
}
