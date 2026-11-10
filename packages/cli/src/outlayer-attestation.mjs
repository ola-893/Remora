import { setTimeout as sleep } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outlayerNetwork } from '@ola-893/agentstreams-core/internal-outlayer';

const exec = promisify(execFile);
export const verifierRevision = '90c27d9d4fc843194ddc6f8ebaafa4eb320c3bb6';
let ready;
export async function requireOutlayerVerifier() {
  ready ??= exec('outlayer-verify', ['--help'], { timeout: 10000, maxBuffer: 32768 }).catch(() => {
    ready = undefined;
    throw new Error(`OUTLAYER_VERIFIER_REQUIRED: run cargo install --git https://github.com/out-layer/outlayer-verify --rev ${verifierRevision} --locked outlayer-verify. No paid request was submitted.`);
  });
  await ready;
}

export async function verifyOutlayerCall({ callId, input, output, version, caller }, { run = exec } = {}) {
  if (!/^[a-f0-9-]{36}$/.test(callId ?? '')) throw new Error('OUTLAYER_ATTESTATION_CALL_REQUIRED');
  const directory = await mkdtemp(join(tmpdir(), 'remora-attestation-'));
  const inputPath = join(directory, 'input.json'), outputPath = join(directory, 'output.json'), bundlePath = join(directory, 'proof.json');
  try {
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
    await writeFile(outputPath, JSON.stringify(output), { mode: 0o600 });
    let stdout;
    for (let attempt = 0; ; attempt++) {
      try {
        ({ stdout } = await run('outlayer-verify', ['call', callId, '--network', outlayerNetwork.network, '--api', outlayerNetwork.origin,
          '--input', inputPath, '--output', outputPath, '--bundle', bundlePath, '--json'], { timeout: 60000, maxBuffer: 262144 }));
        break;
      } catch (error) {
        // Result publication and quote upload are separate steps. Retry only the
        // proof lookup for this same call, never the paid POST or a failed proof.
        const transient = /no record found|HTTP (404|429|502|503|504)|timed out/i.test(error.stderr ?? '');
        if (attempt < 2 && transient) { await sleep(750 * (attempt + 1)); continue; }
        throw new Error('OUTLAYER_ATTESTATION_UNPROVEN: call ' + callId + ' rejected; reconcile instead of repeating a paid request.');
      }
    }
    const proof = JSON.parse(stdout), bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
    const record = bundle.attestation;
    if (bundle.network !== outlayerNetwork.network || record?.wasm_hash !== version || record?.call_id !== callId ||
        record?.caller_account_id !== caller || record?.project_id !== outlayerNetwork.project ||
        record?.task_type !== 'execute' || proof.format !== 'V1' ||
        ['authenticity', 'identity', 'binding', 'input', 'output'].some(layer => proof[layer]?.verdict !== 'pass') ||
        proof.uncovered_fields?.length || bundle.register_contract !== 'worker.outlayer.testnet' ||
        !Number.isSafeInteger(record.timestamp) || Math.abs(Date.now() / 1000 - record.timestamp) > 300) {
      throw new Error('OUTLAYER_ATTESTATION_BINDING_MISMATCH');
    }
    return { verified: true, callId, wasmHash: version, taskId: proof.task_id };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
