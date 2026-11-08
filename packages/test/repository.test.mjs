import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeRepository, repositoryResponse } from '../cli/src/repository-analysis.mjs';

test('repository analysis returns real locations, never source or secret dependency URLs, and fingerprints edits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentpay-analysis-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'api.js'), 'const secret = "DO_NOT_EXPORT_SOURCE";\nconst result = eval(input);\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { example: 'https://user:SECRET_TOKEN@registry.invalid/pkg' } }));
  await mkdir(join(root, '.local')); await writeFile(join(root, '.local', 'credentials.js'), 'eval(PRIVATE_KEY);');
  await mkdir(join(root, 'node_modules')); await writeFile(join(root, 'node_modules', 'dependency.js'), 'eval(input);');
  await writeFile(join(root, '.env'), 'SECRET_TOKEN=not-public');
  await symlink(join(root, '.local', 'credentials.js'), join(root, 'link.js'));
  const first = await analyzeRepository(root);
  assert.equal(first.coverage.files, 2);
  assert.deepEqual(first.findings.map(f => [f.rule, f.file, f.line]), [['dynamic-eval', 'api.js', 2]]);
  assert.equal(first.dependencies[0].name, 'example');
  assert.doesNotMatch(JSON.stringify(first), /DO_NOT_EXPORT_SOURCE|SECRET_TOKEN|PRIVATE_KEY|user:|registry.invalid/);
  assert.equal((await analyzeRepository(root)).fingerprint, first.fingerprint);
  await writeFile(join(root, 'api.js'), 'const result = JSON.parse(input);');
  const second = await analyzeRepository(root);
  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.equal(second.findings.length, 0);
});

test('syntax analysis ignores examples in strings and resolves shell imports rather than safe execFile wrappers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentpay-analysis-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'safe.mjs'), `import {execFile} from 'node:child_process';\nimport {promisify} from 'node:util';\nconst exec=promisify(execFile);\nawait exec('node',['--version']);\nconst example='eval(input); dangerouslySetInnerHTML rejectUnauthorized: false';`);
  assert.equal((await analyzeRepository(root)).findings.length, 0);
  await writeFile(join(root, 'shell.mjs'), `import {exec as runShell} from 'node:child_process';\nrunShell(command);`);
  const findings = (await analyzeRepository(root)).findings;
  assert.deepEqual(findings.map(f => [f.rule, f.file, f.line]), [['shell-execution', 'shell.mjs', 2]]);
});

test('repository analysis bounds input, filters findings and refuses path traversal or unrecognized query parameters', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentpay-analysis-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'a.js'), 'eval(input);\n// TODO review\n');
  await writeFile(join(root, 'b.js'), 'x'.repeat(100));
  const snapshot = await analyzeRepository(root, { maxFileBytes: 50 });
  assert.equal(snapshot.coverage.files, 1); assert.equal(snapshot.coverage.skipped, 1);
  const filtered = repositoryResponse(snapshot, new URLSearchParams('view=findings&severity=high'));
  assert.equal(filtered.body.findings.length, 1); assert.equal(filtered.body.findings[0].line, 1);
  for (const query of ['file=../a.js', 'file=/etc/passwd', 'file=.local/key.js', 'view=nope', 'view=overview&view=findings', 'repository=/etc', 'limit=31', 'offset=-1']) assert.equal(repositoryResponse(snapshot, new URLSearchParams(query)).status, 400);
  assert.equal(repositoryResponse(snapshot, new URLSearchParams('view=dependencies')).body.vulnerabilityDatabaseChecked, false);
  const limited = await analyzeRepository(root, { maxFiles: 1 });
  assert.equal(limited.coverage.files, 1); assert.equal(limited.coverage.limited, true);
});
