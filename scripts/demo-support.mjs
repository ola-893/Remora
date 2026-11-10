import { realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createPresentation, presentationContext, printCliError } from '../packages/cli/src/presentation.mjs';
import { colorFromArgs } from '../packages/cli/src/output-mode.mjs';

export const checkoutRoot = fileURLToPath(new URL('..', import.meta.url));
export const checkoutCliRoot = join(checkoutRoot, 'packages/cli');
export const demoOutputOptions = { 'cli-root': { type: 'string' }, color: { type: 'string', default: 'auto' }, json: { type: 'boolean' }, verbose: { type: 'boolean' }, check: { type: 'boolean' }, help: { type: 'boolean' } };

export async function resolveDemoCliRoot(requested = checkoutCliRoot) {
  const actual = await realpath(requested);
  if (actual !== await realpath(checkoutCliRoot)) throw new Error(`DEMO_CLI_ROOT_MISMATCH: use this checkout: ${checkoutCliRoot}. No operation was started.`);
  return actual;
}

export async function withDemoOutput(values, command, work) {
  const root = await resolveDemoCliRoot(values['cli-root']);
  const output = createPresentation({ color: values.color, json: values.json, verbose: values.verbose, command });
  output.configure({ network: 'testnet' });
  return presentationContext.run({ output }, async () => {
    try { return await work({ root, output, moduleAt: name => import(pathToFileURL(join(root, 'src', `${name}.mjs`)).href) }); }
    finally { output.finish(); }
  });
}

export function demoError(error) {
  printCliError(error, { json: process.argv.includes('--json'), color: colorFromArgs(process.argv.slice(2)) });
  process.exitCode = 1;
}
