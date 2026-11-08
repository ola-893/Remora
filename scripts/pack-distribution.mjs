import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(root, '.local/distribution');
await mkdir(out, { recursive: true });
const manifest = [];
for (const name of ['core', 'cli']) {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', out], { cwd: resolve(root, 'packages', name), encoding: 'utf8' }))[0];
  for (const file of packed.files) if (/^(?:\.env|\.local|node_modules)\b|(?:^|\/)(?:credentials|agent|policy|owner)\.json$/.test(file.path)) throw new Error(`Unexpected private file in package: ${file.path}`);
  const tar = gunzipSync(await readFile(resolve(out, packed.filename)));
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, '').trim(), 8) || 0;
    const content = tar.subarray(offset + 512, offset + 512 + size).toString('utf8');
    if (/ed25519:[1-9A-HJ-NP-Za-km-z]{80,100}/.test(content) || content.includes(root.replace(/\/$/, ''))) throw new Error(`Private key or developer path detected in ${name}`);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  manifest.push({ name: packed.name, version: packed.version, filename: packed.filename, shasum: packed.shasum, integrity: packed.integrity, files: packed.files.map(f => f.path) });
}
await writeFile(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(JSON.stringify(manifest.map(({ name, filename, integrity }) => ({ name, filename, integrity })), null, 2) + '\n');
