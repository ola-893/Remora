#!/usr/bin/env node
import { run } from '../src/cli.mjs';
try { await run(process.argv.slice(2)); }
catch (error) {
  process.stderr.write(`agentStreams: ${error.message}\n`);
  process.exitCode = 1;
}
