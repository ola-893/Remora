#!/usr/bin/env node
import { run } from '../src/cli.mjs';
import { printCliError } from '../src/presentation.mjs';
import { colorFromArgs } from '../src/output-mode.mjs';
try { await run(process.argv.slice(2)); }
catch (error) {
  printCliError(error, { json: process.argv.includes('--json'), color: colorFromArgs(process.argv.slice(2)) });
  process.exitCode = 1;
}
