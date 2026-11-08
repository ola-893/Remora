import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startUi } from '../cli/src/ui.mjs';

test('bundled viewer serves recorded assets, disables live mode and refuses signing/file access', async t => {
  const ui = await startUi();
  t.after(() => ui.close());
  const response = await fetch(ui.url);
  const html = await response.text();
  assert.match(html, /window.__AGENTSTREAMS_RECORDED_ONLY__=true/);
  const asset = /src="([^"]+\.js)"/.exec(html)[1];
  assert.equal((await fetch(ui.url + asset)).status, 200);
  const run = await (await fetch(ui.url + '/near/latest.json')).json();
  assert.equal(run.network, 'testnet');
  assert.equal((await fetch(ui.url + '/docs')).status, 200);
  assert.equal((await fetch(ui.url + '/api/near/state')).status, 404);
  assert.equal((await fetch(ui.url + '/api/near/run', { method: 'POST' })).status, 405);
  assert.equal((await fetch(ui.url + '/.env')).status, 403);
  assert.equal((await fetch(ui.url + '/missing-file')).status, 404);
  const raw = (path, headers) => new Promise((done, reject) => {
    const req = request(ui.url, { path, headers }, res => { res.resume(); done(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(await raw('/%2e%2e/README.md'), 403);
  assert.equal(await raw('/', { host: 'attacker.invalid' }), 403);
  const sandbox = await startUi({ recording: 'sandbox' });
  t.after(() => sandbox.close());
  assert.equal((await (await fetch(sandbox.url + '/near/latest.json')).json()).network, 'sandbox');
});
