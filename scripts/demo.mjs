#!/usr/bin/env node
// Small command launcher for the existing CLI. No automatic funding or setup.
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { withDemoOutput, demoOutputOptions, demoError, checkoutRoot } from './demo-support.mjs';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { ...demoOutputOptions,
    role: { type: 'string', default: process.env.REMORA_ROLE ?? 'leader' }, project: { type: 'string', default: process.env.REMORA_DEMO ?? join(homedir(), 'remora-demo-013') },
    agent: { type: 'string' }, 'state-home': { type: 'string' }, action: { type: 'string' }, capture: { type: 'string' },
  } });
  if (!['leader', 'follower'].includes(values.role)) throw new Error('Choose --role leader or follower.');
  const project = await realpath(resolve(values.project)), name = values.agent ?? values.role;
  const action = values.check ? 'inspect' : positionals[0] ?? 'inspect';
  const stateHome = values['state-home'] ?? join(project, `${values.role}-state`);
  process.env.AGENTSTREAMS_HOME = stateHome;
  await withDemoOutput(values, ['demo', action], async ({ root, output, moduleAt }) => {
    if (values.help) return output.emit('remora inspect | run | decide | preview | subscribe | veto-mode | veto ACTION_ID | stop | tighten\nPreparation uses agentstream commands separately. This launcher never funds or deploys automatically.');
    const launch = async (args, bin = join(root, 'bin/agentstreams.mjs')) => {
      const machine = values.json ? ['--json'] : [];
      const full = [bin, ...args, ...machine, ...(values.verbose ? ['--verbose'] : []), `--color=${values.color}`];
      const command = values.capture ? '/usr/bin/script' : process.execPath;
      const childArgs = values.capture ? ['-q', values.capture, process.execPath, ...full] : full;
      if (values.capture && values.json) throw new Error('Use a human terminal transcript or --json, not both.');
      const code = await new Promise((done, fail) => {
        const child = spawn(command, childArgs, { cwd: project, env: { ...process.env, ...(values.capture ? { REMORA_TRANSCRIPT: '1' } : {}) }, stdio: 'inherit' });
        child.once('error', fail); child.once('exit', (code, signal) => done(signal === 'SIGINT' ? 130 : code ?? 1));
      });
      process.exitCode = code;
    };
    if (action === 'diagnostics') return launch(['diagnostics']);
    const { selectedAgent, readAgentState, agentSetupState } = await moduleAt('agents');
    const agent = await selectedAgent(project, name);
    if (!agent) throw new Error(`DEMO_NOT_PREPARED: create ${name} in ${project} with its separate state home first.`);
    const state = await readAgentState(agent), setup = await agentSetupState(agent);
    const args = ['--project', project, '--agent', name];
    if (action === 'inspect') {
      const runnerPid = await readFile(join(agent.path, 'runner.lock'), 'utf8').then(s => Number(s.trim())).catch(() => null);
      return output.emit({ type: 'demo-check', role: values.role, packageRoot: root, agent: name, network: setup.network,
        publicationEnabled: Boolean(state.publish?.enabled), subscriptionStatus: state.follow?.status, pendingTrade: Boolean(state.tradePending), runnerPid,
        inferenceProvider: setup.inference?.provider ?? 'Not configured', ready: Boolean(setup.inference && state.tasks['portfolio-rebalance'] && state.strategyPolicies?.['portfolio-rebalance'] && !state.tradePending),
        next: state.tradePending ? 'Reconcile before another execution.' : undefined });
    }
    if (action === 'run') return launch(['agent', 'run', ...args]);
    if (action === 'veto-mode') return launch(['copy', 'mode', 'veto', '--veto-seconds', '45', ...args]);
    if (action === 'decide') {
      if (values.role !== 'leader') throw new Error('Use decide in the leader terminal.');
      const objective = '{"poolId":0,"base":"wrap.testnet","amount":"2000000000000000000000","weights":{"wrap.testnet":2500,"rft.tokenfactory.testnet":7500}}';
      return launch(['agent', 'run', ...args, '--activity', 'portfolio-rebalance', '--max-steps', '8', '--prompt', `Evaluate this testnet rebalance objective: ${objective}. Read strategy_guard, call strategy_preview, examine its live Rhea evidence, and use strategy_apply exactly once if the guard and preview permit it. Explain your decision using the returned evidence. Stop after the confirmed result or a refusal.`]);
    }
    if (action === 'veto') {
      const id = values.action ?? positionals[1];
      if (!id) throw new Error('Use remora veto ACTION_ID before its veto deadline.');
      return launch(['copy', 'block', id, ...args]);
    }
    if (action === 'tighten') return launch(['guard', 'set', 'execution', ...args, '--activity', 'portfolio-rebalance', '--max-inputs', 'nep141:wrap.testnet=500000000000000000000']);
    if (action === 'stop') return launch(['--project', project, '--agent', name], join(checkoutRoot, 'scripts/demo-close-proof.mjs'));
    if (!['preview', 'subscribe'].includes(action)) throw new Error('Use remora inspect, run, decide, preview, subscribe, veto-mode, veto ACTION_ID, tighten or stop.');
    const id = (await readFile(join(project, 'leader-id.txt'), 'utf8')).trim();
    if (!/^ap_[a-f0-9]{64}$/.test(id)) throw new Error('Invalid saved leader ID.');
    if (action === 'preview') return launch(['copy', id, ...args]);
    return launch(['copy', 'start', id, '--activity', 'portfolio-rebalance', ...args]);
  });
}
main().catch(demoError);
