import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { verifyRun } from '@ola-893/agentstreams-core/internal-evidence-audit';

const uiRoot = fileURLToPath(new URL('../ui/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
export async function startUi({ port = 0, recording = 'testnet', runFile } = {}) {
  if (!['testnet', 'sandbox'].includes(recording)) throw new Error('Choose --recording testnet or sandbox.');
  const captured = JSON.parse(await readFile(runFile ? resolve(runFile) : resolve(uiRoot, 'near', `${recording}.json`), 'utf8'));
  verifyRun(captured);
  if ((!runFile && captured.network !== recording) || captured.simulated) throw new Error('REPLAY_PROVENANCE_MISMATCH');
  const server = createServer(async (req, res) => {
    const send = (status, body, type = 'text/plain') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    try {
      if (!['GET', 'HEAD'].includes(req.method)) return send(405, 'Recorded viewer is read-only.');
      if (![`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`].includes(req.headers.host)) return send(403, 'Host denied.');
      const decoded = decodeURIComponent(req.url.split('?')[0]);
      if (decoded.split('/').some(x => x === '..' || x.startsWith('.')) || decoded.includes('\\') || decoded.includes('\0')) return send(403, 'Path denied.');
      if (decoded.startsWith('/api/') || decoded === '/api') return send(404, 'No signing API is exposed by this viewer.');
      if (runFile && ['/near/latest.json', '/near/testnet.json', '/near/sandbox.json'].includes(decoded)) return send(200, JSON.stringify(captured), 'application/json');
      let path = ['/', '/docs'].includes(decoded) ? '/index.html' : decoded;
      if (path === '/near/latest.json') path = `/near/${recording === 'sandbox' ? 'sandbox' : 'testnet'}.json`;
      const file = await realpath(resolve(uiRoot, `.${path}`));
      if (!file.startsWith(resolve(uiRoot) + sep)) return send(403, 'Path denied.');
      let content = await readFile(file);
      if (path === '/index.html') content = content.toString()
        .replace('<head>', '<head><script>window.__AGENTSTREAMS_RECORDED_ONLY__=true;</script>')
        .replace(/<title>[^<]*<\/title>/, '<title>Remora · Payment evidence</title>');
      send(200, content, mime[extname(file)] || 'application/octet-stream');
    } catch { send(404, 'Not found. Build the distribution before opening the viewer.'); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) };
}

export function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(command, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}
