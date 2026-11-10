#!/usr/bin/env node
// Offline, presentation-only rehearsal. Never starts a wallet server or calls an API.
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { createPresentation } from '../packages/cli/src/presentation.mjs';
import { approval, events, follow } from '../packages/test/fixtures/presentation.mjs';

const { values } = parseArgs({ options: { json: { type: 'boolean' }, width: { type: 'string', default: '72' }, 'no-delay': { type: 'boolean' } } });
if (!/^\d+$/.test(values.width) || Number(values.width) < 30 || Number(values.width) > 120) throw new Error('Use --width 30–120.');
const surface = stream => ({ isTTY: stream.isTTY, columns: Number(values.width), write: chunk => stream.write(chunk) });
const output = createPresentation({ stream: surface(process.stdout), diagnostics: surface(process.stderr), json: values.json, command: ['agent', 'run'] });
output.configure({ network: 'testnet', inference: { provider: 'local', model: 'fixture-model' } });
if (output.human) output.block('Presentation fixtures · no live execution', [], 'Synthetic events, including receipt labels. No network calls, wallet approvals or payments occur.');
else output.emit({ fixture: true, liveExecution: false });
output.start({ name: 'Follower (fixture)' }, { follow });
output.wallet(approval, 'http://127.0.0.1:5389/#fixture-only-not-a-live-request');
for (const event of events) {
  output.emit(event);
  if (!values['no-delay']) await pause(400);
}
output.finish();
