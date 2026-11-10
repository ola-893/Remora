import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { configHome } from './config.mjs';
import { usesColor } from './output-mode.mjs';

export async function cliDiagnostics({ color = 'auto', json = false } = {}) {
  const packageRoot = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const revision = await promisify(execFile)('git', ['-C', packageRoot, 'rev-parse', 'HEAD']).then(r => r.stdout.trim()).catch(() => 'Not a Git checkout');
  const rendererFingerprint = createHash('sha256').update(await readFile(new URL('./presentation.mjs', import.meta.url))).digest('hex');
  return { type: 'cli-diagnostics', packageRoot, executable: await realpath(process.argv[1]).catch(() => process.argv[1]), node: process.execPath, version, revision,
    rendererFingerprint, stateHome: configHome(), stdoutTTY: Boolean(process.stdout.isTTY), stderrTTY: Boolean(process.stderr.isTTY),
    term: process.env.TERM ?? 'Unset', noColor: Object.hasOwn(process.env, 'NO_COLOR'), forceColor: process.env.FORCE_COLOR,
    outputMode: json || !process.stdout.isTTY ? 'JSON' : 'Human', color: usesColor({ stream: process.stdout, color, json: json || !process.stdout.isTTY }) ? `Enabled (${color})` : `Disabled (${color})` };
}
