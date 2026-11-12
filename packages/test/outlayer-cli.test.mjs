import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../cli/bin/agentstreams.mjs', import.meta.url));

test('users cannot configure or be prompted for an OutLayer compute key', async t => {
  const home = await mkdtemp(join(tmpdir(), 'remora-compute-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const options = { cwd: home, env: { ...process.env, AGENTSTREAMS_HOME: home, NO_COLOR: '1' }, timeout: 5000 };
  const { stdout: help } = await exec(process.execPath, [bin, '--help'], options);
  assert.doesNotMatch(help, /outlayer key|OutLayer compute key/);
  assert.match(help, /outlayer show/);
  assert.match(help, /inference set --provider near-ai --model MODEL --api-key/);
  await assert.rejects(exec(process.execPath, [bin, 'outlayer', 'key', '--api-key', '--json'], options), error => {
    assert.equal(error.code, 1);
    assert.equal(error.killed, false);
    assert.match(JSON.parse(error.stderr || error.stdout).error, /Unknown command/);
    assert.doesNotMatch(error.stdout + error.stderr, /input hidden|Enter.*key/i);
    return true;
  });
  assert.equal(await stat(join(home, 'outlayer-key.json')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)), null);
});
