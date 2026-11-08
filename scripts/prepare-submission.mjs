// Prepare local source artifacts without changing the user's Git index, commits or remotes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, rm, copyFile, chmod, lstat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyQuoteSignature } from '@defuse-protocol/one-click-sdk-typescript';
import { createHash } from 'node:crypto';
const exec = promisify(execFile), root = resolve('.');
const baseline = 'a52becad8121de9d3caa9e9a4400fd1e0e5999ef';
const out = resolve('.local/submission'); await mkdir(out, { recursive: true });
const git = (args, options = {}) => exec('git', args, { cwd: root, maxBuffer: 10000000, ...options });
const sourceRepo = await git(['rev-parse', '--show-toplevel']).then(({ stdout }) => stdout.trim() === root, () => false);
async function listSource() {
  const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
  if (sourceRepo) return (await git(args)).stdout;
  const metadata = await mkdtemp(join(tmpdir(), 'agentstreams-source-'));
  try {
    await git(['init', '--bare', '--quiet', metadata]);
    return (await git([`--git-dir=${metadata}`, `--work-tree=${root}`, ...args])).stdout;
  } finally {
    await rm(metadata, { recursive: true, force: true });
  }
}

const privateKeyPattern = /ed25519:[1-9A-HJ-NP-Za-km-z]{80,100}/;
const credentialPatterns = [privateKeyPattern, /\bsk-[a-zA-Z0-9]{24,}/, /-----BEGIN (?:RSA |EC|OPENSSH )?PRIVATE KEY-----/];
const hasCredential = text => credentialPatterns.some(pattern => pattern.test(text));

function findPublicQuotes(value, signatures) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.signature === 'string' && privateKeyPattern.test(value.signature) && value.quoteRequest?.dry === true) {
    try { if (verifyQuoteSignature(value)) signatures.add(value.signature); } catch { /* Unverifiable values remain scannable. */ }
  }
  for (const child of Object.values(value)) findPublicQuotes(child, signatures);
}

const listed = (await listSource()).split('\0').filter(Boolean);
const files = [], findings = [], copyEvidence = new Map();
for (const file of [...new Set(listed)].sort()) {
  if (/[\r\n]/.test(file) || file.startsWith('-') || file.split('/').some(p => ['.git', '.local', 'node_modules', 'target'].includes(p)) || /(?:^|\/)\.env(?:$|\.)/.test(file) && !file.endsWith('.example')) throw new Error('Unexpected private or unsupported archive path: ' + file);
  let info; try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (!info.isFile()) throw new Error('Only regular source files may be exported: ' + file);
  const bytes = await readFile(file), text = bytes.toString('utf8');
  if (file.startsWith('docs/evidence/copy-trading/') && /\.(json|txt)$/.test(file)) copyEvidence.set(file, text);
  else if (hasCredential(text)) findings.push(file);
  files.push({ path: file, bytes: info.size, sha256: createHash('sha256').update(bytes).digest('hex'), mode: info.mode & 0o777 });
}
const publicSignatures = new Set();
for (const [file, text] of copyEvidence) {
  if (file.endsWith('.json')) findPublicQuotes(JSON.parse(text), publicSignatures);
}
for (const [file, text] of copyEvidence) {
  // JSON and its printed terminal transcripts carry the same public signatures.
  const scannable = text.replace(/"signature"\s*:\s*"(ed25519:[1-9A-HJ-NP-Za-km-z]{80,100})"/g,
    (field, signature) => publicSignatures.has(signature) ? '' : field);
  if (hasCredential(scannable)) findings.push(file);
}
if (findings.length) throw new Error('Potential credential material in source export; inspect these files (values withheld): ' + findings.join(', '));
const listPath = join(out, 'files.txt'); await writeFile(listPath, files.map(f => f.path).join('\n') + '\n');
const archive = join(out, 'agentstreams-source.tar.gz');
await exec('tar', ['-czf', archive, '-T', listPath], { cwd: root });
const baselineArchive = join(out, 'inherited-baseline.tar');
const patchPath = join(out, 'near-migration.patch');
const baselineAvailable = sourceRepo && await git(['cat-file', '-e', `${baseline}^{commit}`]).then(() => true, () => false);
if (baselineAvailable) {
  const { stdout: baselineBytes } = await git(['archive', '--format=tar', baseline], { encoding: 'buffer', maxBuffer: 200000000 });
  await writeFile(baselineArchive, baselineBytes);
  const comparison = await mkdtemp(join(out, 'comparison-'));
  try {
    const oldRoot = join(comparison, 'baseline'), newRoot = join(comparison, 'submission');
    await mkdir(oldRoot, { recursive: true });
    await mkdir(newRoot, { recursive: true });
    await exec('tar', ['-xf', baselineArchive, '-C', oldRoot]);
    for (const file of files) {
      const dest = join(newRoot, file.path);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(join(root, file.path), dest);
      await chmod(dest, file.mode);
    }
    let patch;
    try { patch = (await git(['diff', '--no-index', '--binary', '--src-prefix=a/', '--dst-prefix=b/', 'baseline', 'submission'], { cwd: comparison, maxBuffer: 200000000 })).stdout; }
    catch (error) { if (error.code !== 1) throw error; patch = error.stdout; }
    await writeFile(patchPath, patch);
  } finally {
    await rm(comparison, { recursive: true, force: true });
  }
} else {
  await Promise.all([rm(baselineArchive, { force: true }), rm(patchPath, { force: true })]);
}
const manifest = { createdAt: new Date().toISOString(), inheritedBaseline: baseline, baselineAvailable, sourceArchive: 'agentstreams-source.tar.gz', sourceArchiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), fileCount: files.length, credentialScan: 'No Ed25519 private-key, sk-style token or PEM private-key patterns found. Verified public dry-quote signatures are excluded from the pattern check.', gitStateChanged: false, files };
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ directory: out, baselineAvailable, fileCount: files.length, sourceArchiveSha256: manifest.sourceArchiveSha256, gitStateChanged: false, published: false }, null, 2));
