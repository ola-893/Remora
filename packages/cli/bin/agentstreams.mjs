#!/usr/bin/env node
import { run } from '../src/cli.mjs';
import { printCliError } from '../src/presentation.mjs';
try { await run(process.argv.slice(2)); }
catch (error) {
  printCliError(error, { json: process.argv.includes('--json') });
  process.exitCode = 1;
}
