import { opendir, open, realpath } from 'node:fs/promises';
import { resolve, relative, extname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const excluded = new Set(['.git', '.local', '.agentpay', '.agentstreams', '.aws', '.ssh', '.codex', '.agents', 'node_modules', 'target', 'dist', 'build', 'coverage', 'vendor', 'artifacts', 'cache']);
const extensions = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.rs', '.sol', '.py']);
const rules = [
  { id: 'dynamic-eval', severity: 'high', pattern: /\beval\s*\(/, title: 'Dynamic evaluation', recommendation: 'Replace eval with a parser or an explicit operation allowlist; check whether external input reaches this call.' },
  { id: 'tls-verification-disabled', severity: 'high', pattern: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/, title: 'TLS certificate verification disabled', recommendation: 'Enable certificate verification and configure the required CA instead.' },
  { id: 'shell-execution', severity: 'medium', pattern: /\b(?:exec|execSync)\s*\(/, title: 'Shell execution needs input review', recommendation: 'Prefer execFile with a fixed executable and separate arguments; inspect any user-controlled command interpolation.' },
  { id: 'raw-html', severity: 'medium', pattern: /dangerouslySetInnerHTML|\.innerHTML\s*=/, title: 'Raw HTML insertion', recommendation: 'Use text rendering or a maintained sanitizer before inserting untrusted content.' },
  { id: 'fetch-deadline', severity: 'medium', title: 'Fetch deadline needs review', recommendation: 'No explicit AbortSignal is present at this call. Check whether the Request already carries a deadline; otherwise add AbortSignal.timeout or an owner-controlled cancellation signal so a stalled service cannot hold the operation indefinitely.' },
  { id: 'wildcard-cors', severity: 'medium', pattern: /['"]access-control-allow-origin['"]\s*[:,]\s*['"]\*['"]/i, title: 'Wildcard cross-origin access', recommendation: 'Check whether this endpoint should expose data to every origin; use an origin allowlist when required.' },
  { id: 'unfinished-work', severity: 'info', pattern: /\b(?:TODO|FIXME)\b/, title: 'Unfinished work marker', recommendation: 'Review this marker and track required work before release.' },
];
const hash = text => createHash('sha256').update(text).digest('hex');

function sourceFindings(text, file) {
  if (!['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'].includes(extname(file))) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.jsx') ? ts.ScriptKind.JSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const shellNames = new Set(), shellNamespaces = new Set(), found = [];
  const isChildProcess = value => ts.isStringLiteral(value) && ['child_process', 'node:child_process'].includes(value.text);
  const propertyName = node => node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : '';
  function bindings(node) {
    if (ts.isImportDeclaration(node) && isChildProcess(node.moduleSpecifier)) {
      const imports = node.importClause;
      if (imports?.name) shellNamespaces.add(imports.name.text);
      if (imports?.namedBindings && ts.isNamespaceImport(imports.namedBindings)) shellNamespaces.add(imports.namedBindings.name.text);
      if (imports?.namedBindings && ts.isNamedImports(imports.namedBindings)) for (const item of imports.namedBindings.elements) if (['exec', 'execSync'].includes((item.propertyName || item.name).text)) shellNames.add(item.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === 'require' && node.initializer.arguments[0] && isChildProcess(node.initializer.arguments[0])) {
      if (ts.isIdentifier(node.name)) shellNamespaces.add(node.name.text);
      if (ts.isObjectBindingPattern(node.name)) for (const item of node.name.elements) if (['exec', 'execSync'].includes((item.propertyName || item.name).getText(source))) shellNames.add(item.name.getText(source));
    }
    ts.forEachChild(node, bindings);
  }
  bindings(source);
  const add = (id, node) => {
    const rule = rules.find(rule => rule.id === id), line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    if (!found.some(item => item.rule === id && item.line === line)) found.push({ id: hash(`${file}:${line}:${id}`).slice(0, 16), rule: id, severity: rule.severity, file, line, title: rule.title, recommendation: rule.recommendation });
  };
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression) && expression.text === 'eval') add('dynamic-eval', node);
      if (ts.isIdentifier(expression) && expression.text === 'fetch' && node.arguments.length && !(ts.isNewExpression(node.arguments[0]) && node.arguments[0].expression.getText(source) === 'Request')) {
        const options = node.arguments[1];
        if (!options || (ts.isObjectLiteralExpression(options) && !options.properties.some(property => ts.isSpreadAssignment(property) || propertyName(property.name) === 'signal'))) add('fetch-deadline', node);
      }
      if ((ts.isIdentifier(expression) && shellNames.has(expression.text)) || (ts.isPropertyAccessExpression(expression) && shellNamespaces.has(expression.expression.getText(source)) && ['exec', 'execSync'].includes(expression.name.text))) add('shell-execution', node);
      if (ts.isPropertyAccessExpression(expression) && ['setHeader', 'header', 'set'].includes(expression.name.text) && node.arguments.length >= 2 && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text.toLowerCase() === 'access-control-allow-origin' && ts.isStringLiteral(node.arguments[1]) && node.arguments[1].text === '*') add('wildcard-cors', node);
    }
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name === 'rejectUnauthorized' && node.initializer.kind === ts.SyntaxKind.FalseKeyword) add('tls-verification-disabled', node);
      if (name.toLowerCase() === 'access-control-allow-origin' && ts.isStringLiteral(node.initializer) && node.initializer.text === '*') add('wildcard-cors', node);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'innerHTML') add('raw-html', node);
      if (node.left.getText(source) === 'process.env.NODE_TLS_REJECT_UNAUTHORIZED' && (ts.isStringLiteral(node.right) && node.right.text === '0')) add('tls-verification-disabled', node);
    }
    if (ts.isJsxAttribute(node) && propertyName(node.name) === 'dangerouslySetInnerHTML') add('raw-html', node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) if ([ts.SyntaxKind.SingleLineCommentTrivia, ts.SyntaxKind.MultiLineCommentTrivia].includes(token) && /\b(?:TODO|FIXME)\b/.test(scanner.getTokenText())) {
    const line = source.getLineAndCharacterOfPosition(scanner.getTokenPos()).line + 1, rule = rules.find(r => r.id === 'unfinished-work');
    found.push({ id: hash(`${file}:${line}:${rule.id}`).slice(0, 16), rule: rule.id, severity: rule.severity, file, line, title: rule.title, recommendation: rule.recommendation });
  }
  return found.sort((a, b) => a.line - b.line);
}

// Read only operator-selected regular files. Never execute repository code or follow symlinks.
export async function analyzeRepository(repository, { maxFiles = 500, maxBytes = 3000000, maxFileBytes = 200000, maxEntries = 10000 } = {}) {
  const root = await realpath(resolve(repository));
  const files = [], findings = [], dependencies = [];
  const languages = {};
  let bytes = 0, lines = 0, skipped = 0, entriesVisited = 0, limited = false;
  async function walk(directory) {
    const entries = [];
    for await (const entry of await opendir(directory)) {
      if (++entriesVisited > maxEntries) { limited = true; break; }
      entries.push(entry);
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || excluded.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      const name = relative(root, path).split(sep).join('/');
      if (entry.isDirectory()) { if (!limited) await walk(path); continue; }
      if (!entry.isFile() || (!extensions.has(extname(entry.name)) && entry.name !== 'package.json')) continue;
      if (files.length >= maxFiles || bytes >= maxBytes) { limited = true; continue; }
      // O_NOFOLLOW closes the symlink-swap window for the final file; verify canonical ancestry too.
      const canonical = await realpath(path);
      if (!canonical.startsWith(root + sep)) { skipped++; continue; }
      const { constants } = await import('node:fs');
      let handle;
      try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if (['ELOOP', 'ENOENT'].includes(error.code)) { skipped++; continue; } throw error; }
      let text;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > maxFileBytes || bytes + info.size > maxBytes) { skipped++; limited ||= bytes + info.size > maxBytes; continue; }
        const buffer = Buffer.alloc(Math.min(maxFileBytes, maxBytes - bytes) + 1);
        const read = await handle.read(buffer, 0, buffer.length, 0);
        if (read.bytesRead > maxFileBytes || bytes + read.bytesRead > maxBytes) { skipped++; limited = true; continue; }
        text = buffer.subarray(0, read.bytesRead).toString('utf8');
        bytes += read.bytesRead;
      } finally { await handle.close(); }
      if (text.includes('\0')) { skipped++; continue; }
      const fileLines = text.split(/\r?\n/);
      files.push({ path: name, lines: fileLines.length, sha256: hash(text) });
      lines += fileLines.length;
      const extension = extname(entry.name) || 'json';
      languages[extension] = (languages[extension] || 0) + 1;
      if (entry.name === 'package.json') {
        try {
          const pkg = JSON.parse(text);
          for (const [scope, values] of Object.entries({ dependencies: pkg.dependencies, devDependencies: pkg.devDependencies })) {
            if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
            // Do not return dependency values: URLs can carry registry credentials.
            for (const dependency of Object.keys(values)) if (/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(dependency)) dependencies.push({ manifest: name, name: dependency, scope });
          }
        } catch { findings.push({ id: hash(name + ':invalid-manifest').slice(0, 16), rule: 'invalid-manifest', severity: 'medium', file: name, line: 1, title: 'Invalid package manifest', recommendation: 'Correct package.json syntax so dependency tooling can read it.' }); }
        continue;
      }
      findings.push(...sourceFindings(text, name).slice(0, Math.max(0, 300 - findings.length)));
    }
  }
  await walk(root);
  return { schemaVersion: 1, source: 'agentStreams repository analysis', generatedAt: new Date().toISOString(), fingerprint: hash(JSON.stringify(files)), scope: 'Bounded syntax-based JS/TS heuristics, not a security audit or dataflow analysis. Other source languages contribute inventory only. No source code is executed. Findings need human review; absence of findings does not establish safety.', coverage: { files: files.length, lines, bytes, skipped, limited, maxFiles, maxBytes, maxFileBytes, entriesVisited, maxEntries, maxFindings: 300, findingLimitReached: findings.length === 300 }, languages, files, findings, dependencies };
}

export function repositoryResponse(snapshot, params) {
  if ([...params.keys()].some(key => !['view', 'severity', 'file', 'limit', 'offset'].includes(key)) || [...params.keys()].some(key => params.getAll(key).length !== 1)) return { status: 400, body: { error: 'Use view=overview, findings or dependencies; optional severity, exact relative file, limit (1-30) and offset.' } };
  const limit = Number(params.get('limit') || 5), offset = Number(params.get('offset') || 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000) return { status: 400, body: { error: 'INVALID_ANALYSIS_PAGINATION' } };
  const view = params.get('view') || 'overview', severity = params.get('severity'), file = params.get('file');
  if (!['overview', 'findings', 'dependencies'].includes(view) || (severity && !['high', 'medium', 'info'].includes(severity)) || (file && (file.startsWith('/') || file.includes('\\') || file.split('/').some(part => part === '..' || part.startsWith('.'))))) return { status: 400, body: { error: 'INVALID_ANALYSIS_QUERY' } };
  const { source, generatedAt, fingerprint, scope, coverage, languages } = snapshot;
  const body = { source, generatedAt, fingerprint, scope, coverage, view };
  if (view === 'overview') Object.assign(body, { languages, findingCounts: Object.fromEntries(['high', 'medium', 'info'].map(s => [s, snapshot.findings.filter(f => f.severity === s).length])), dependencyCount: snapshot.dependencies.length });
  if (view === 'findings') {
    const matching = snapshot.findings.filter(f => (!severity || f.severity === severity) && (!file || f.file === file));
    Object.assign(body, { findings: matching.slice(offset, offset + limit), matching: matching.length, offset, limit, truncated: matching.length > offset + limit });
  }
  if (view === 'dependencies') Object.assign(body, { dependencies: snapshot.dependencies.slice(0, 80), total: snapshot.dependencies.length, truncated: snapshot.dependencies.length > 80, vulnerabilityDatabaseChecked: false });
  return { status: 200, body };
}
