import { cp, mkdir, rm, copyFile, access, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { verifyRun } from '../near/lib/audit.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = resolve(root, 'packages/core/runtime');
await rm(runtime, { recursive: true, force: true });
const files = ['sdk/index.mjs', 'sdk/index.d.ts', 'lib/config.mjs', 'lib/runtime-policy.mjs', 'lib/permit.mjs', 'lib/session.mjs', 'lib/outlayer.mjs', 'lib/outlayer-network.json', 'lib/stream.mjs', 'lib/policy.mjs', 'lib/worker-client.mjs', 'lib/deployment.mjs', 'lib/testnet-preflight.mjs', 'lib/evidence.mjs', 'lib/audit.mjs', 'policy-worker.mjs', 'provider.mjs'];
for (const file of files) {
  const dest = resolve(runtime, 'near', file);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(resolve(root, 'near', file), dest);
}
for (const name of ['core', 'cli']) await copyFile(resolve(root, 'LICENSE'), resolve(root, 'packages', name, 'LICENSE'));
await copyFile(resolve(root, 'near/sdk/index.d.ts'), resolve(runtime, 'near/sdk/index.d.mts'));
if (!process.argv.includes('--runtime-only')) {
  await import('./build-wallet-ui.mjs');
  const artifacts = resolve(root, 'packages/cli/artifacts');
  await mkdir(artifacts, { recursive: true });
  const wasm = await readFile(resolve(root, 'near/contracts/target/wasm32-unknown-unknown/release/agentpay_vault.wasm'));
  if (!WebAssembly.validate(wasm)) throw new Error('INVALID_BUNDLED_VAULT_WASM');
  await writeFile(resolve(artifacts, 'agentpay_vault.wasm'), wasm);
  await copyFile(resolve(root, 'near/contracts/target/wasm32-unknown-unknown/release/remora_registry.wasm'), resolve(artifacts, 'remora_registry.wasm'));
  for (const version of ['2.0.0','2.1.0']) await copyFile(resolve(root, `near/contracts/historical/vault-v${version}.wasm`), resolve(artifacts, `vault-v${version}.wasm`));
  await writeFile(resolve(artifacts, 'manifest.json'), JSON.stringify({ sha256: createHash('sha256').update(wasm).digest('hex'), source: 'near/contracts/vault', build: 'npm run build:near', network: 'testnet' }, null, 2));
  const ui = resolve(root, 'packages/cli/ui');
  await access(resolve(root, 'vite-project/dist/index.html'));
  await rm(ui, { recursive: true, force: true });
  await mkdir(resolve(ui, 'near'), { recursive: true });
  await copyFile(resolve(root, 'vite-project/dist/index.html'), resolve(ui, 'index.html'));
  await copyFile(resolve(root, 'vite-project/public/agentstreams.svg'), resolve(ui, 'agentstreams.svg'));
  await cp(resolve(root, 'vite-project/dist/assets'), resolve(ui, 'assets'), { recursive: true });
  for (const [source, target] of [['sandbox.json', 'sandbox.json'], ['testnet.json', 'testnet.json']]) {
    const data = JSON.parse(await readFile(resolve(root, 'vite-project/public/near', source), 'utf8'));
    verifyRun(data);
    if (data.events.some(e => e.simulated === true) || data.simulated === true) throw new Error('SIMULATED_REPLAY_REFUSED');
    await copyFile(resolve(root, 'vite-project/public/near', source), resolve(ui, 'near', target));
  }
}
process.stdout.write(`Distribution ${process.argv.includes('--runtime-only') ? 'native runtime' : 'runtime and recorded UI'} built.\n`);
