#!/usr/bin/env python3
"""Offline PTY integration checks: no wallet, inference or blockchain calls.

Runs copies of the real shell launchers with a fake npm CLI. This exercises
two-terminal coordination, command order, foreground Ctrl+C, and close failure.
"""
import json
import os
from pathlib import Path
import pty
import select
import shlex
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent
FAKE = r'''
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
const a = process.argv.slice(2), json = a.includes('--json');
const args = a.filter(x => x !== '--json' && !x.startsWith('--color='));
const role = process.env.AGENTSTREAMS_HOME?.endsWith('follower-state') ? 'remora' : 'shark';
const demo = process.cwd(), file = path.join(demo, role+'.fixture.json');
const restart = process.env.FIXTURE_RESTART==='1';
let s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {created:restart,grant:restart,expired:restart,publication:restart&&role==='shark',paused:restart&&role==='remora',active:false,cap:'1000000000000000000000'};
const save=()=>fs.writeFileSync(file,JSON.stringify(s));
const id = 'ap_'+(role==='shark'?'a':'b').repeat(64);
const agentName = role==='shark'?'shark-agent':'remora-agents';
if(args[0]!=='--version') fs.appendFileSync(path.join(demo,'calls.jsonl'),JSON.stringify({role,args,json})+'\n');
const out=x=>console.log(json?JSON.stringify(x):'\x1b[36m› '+args.slice(0,2).join(' ')+'\x1b[0m · result');
const cmd=args.slice(0,2).join(' ');
if(args[0]==='--version') console.log('0.13.1');
else if(cmd==='agent list') {fs.mkdirSync(path.join(process.env.AGENTSTREAMS_HOME,'agents'),{recursive:true});out({agents:s.created?[{name:agentName}]:[]});}
else if(cmd==='agent create') {s.created=true;save();out({id});}
else if(args[0]==='status') out({pendingTrade:false,subscription:s.paused?{status:'paused'}:null,publicationEnabled:s.publication});
else if(cmd==='publish status') out({publication:{origin:'http://127.0.0.1:5380'},registry:null});
else if(cmd==='publish stop') {s.publication=false;save();out({enabled:false});}
else if(cmd==='wallet show') out({network:'testnet',signer:'browser-wallet',accountId:'rudepuma4060.testnet'});
else if(args[0]==='outlayer') throw Error('the demo must not request OutLayer credentials');
else if(cmd==='inference show') out({provider:role==='shark'?'near-ai':'local',apiKeyStored:true});
else if(cmd==='agent show') out({id,setup:{configured:true}});
else if(cmd==='grant show') out(s.grant?{granted:!s.expired,state:'active',agentId:id,activities:['portfolio-rebalance'],expiresAt:Date.now()+(s.expired?-1000:7200000),remaining:14}:{granted:false});
else if(cmd==='grant revoke') {s.grant=false;s.expired=false;save();out({cleared:true});}
else if(cmd==='grant create') {s.grant=true;s.expired=false;save();out({granted:true});}
else if(args[0]==='balance') out({vault:{available:'2000',pending_total:'0',active_session:s.active?'session':null}});
else if(cmd==='guard set') {if(args.includes('--max-inputs')) {s.cap=args[args.indexOf('--max-inputs')+1].split('=')[1];save();}out({okay:true});}
else if(cmd==='guard show') out({strategyExecution:{'portfolio-rebalance':{caps:{'nep141:wrap.testnet':s.cap}}}});
else if(cmd==='copy start') {s.active=true;save();out({status:'active'});}
else if(cmd==='copy mode') {if(!s.active) throw Error('mode before subscription');out({mode:'veto'});}
else if(cmd==='copy stop') {
  if(process.env.FIXTURE_CLOSE_FAIL==='1'){console.error('fixture: uncertain close');process.exit(1);}
  s.active=false;s.paused=false;save();out({status:'stopped',closeHash:'fixture-only'});
}
else if(cmd==='copy status') out({subscription:{status:s.active?'active':s.paused?'paused':'stopped'},tradePending:false});
else if(cmd==='copy history') out({history:[
  {at:new Date().toISOString(),type:'strategy',status:'wallet-confirmed'},
  {at:new Date().toISOString(),type:'strategy',status:'skipped',reason:'STRATEGY_INPUT_LIMIT: nep141:wrap.testnet'}]});
else if(cmd==='agent run' && !args.includes('--prompt')) {
  if(role==='shark') http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({body:{id}}));}).listen(0,'127.0.0.1',function(){fs.writeFileSync(path.join(demo,'fixture-port.txt'),String(this.address().port));});
  console.log('fixture runner foreground');setInterval(()=>{},1000);
} else out({okay:true});
'''


def run_case(close_fail, restart=False):
    with tempfile.TemporaryDirectory(prefix='remora-launcher-test-') as tmp:
        base = Path(tmp)
        demo = base / 'demo'
        demo.mkdir()
        fake = base / 'npm-cli'
        (fake / 'bin').mkdir(parents=True)
        (fake / 'package.json').write_text('{"version":"0.13.1","type":"module"}')
        (fake / 'bin/agentstreams.mjs').write_text(FAKE)
        for name in ['demo-live-common.sh', 'demo-shark.sh', 'demo-remora.sh']:
            text = (ROOT / name).read_text()
            if name == 'demo-live-common.sh':
                needle = 'CLI_ROOT="$(npm root -g)/@ola-893/agentstreams-cli"'
                assert needle in text
                text = text.replace(needle, 'CLI_ROOT='+shlex.quote(str(fake)))
                needle = 'models=$(curl --fail --silent --show-error --max-time 10 http://127.0.0.1:11434/v1/models)'
                assert needle in text
                text = text.replace(needle, 'models=\'{"data":[{"id":"qwen2.5:1.5b"}]}\'')
            if name == 'demo-shark.sh':
                text = text.replace('feed_ready=0', 'until [[ -f "$DEMO/fixture-port.txt" ]]; do sleep 0.1; done\nFEED_URL="http://127.0.0.1:$(cat "$DEMO/fixture-port.txt")"\nfeed_ready=0')
            (base / name).write_text(text)
        env = {**os.environ, 'REMORA_DEMO': str(demo), 'FIXTURE_CLOSE_FAIL': '1' if close_fail else '0', 'FIXTURE_RESTART':'1' if restart else '0', 'TERM': 'xterm-256color'}
        env.pop('NO_COLOR', None)
        children, fds, seen, texts = [], [], [0, 0], ['', '']
        try:
            for name in ['demo-shark.sh', 'demo-remora.sh']:
                master, slave = pty.openpty()
                p = subprocess.Popen(['/bin/bash', str(base/name)], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
                os.close(slave)
                children.append(p)
                fds.append(master)
            deadline = time.monotonic()+35
            interrupted = False
            while time.monotonic() < deadline:
                for fd in select.select(fds, [], [], .1)[0]:
                    index = fds.index(fd)
                    try:
                        chunk = os.read(fd, 65536).decode(errors='replace')
                    except OSError:
                        chunk = ''
                    texts[index] += chunk
                    prompts = texts[index].count('Press Enter to continue:')
                    if prompts > seen[index]:
                        os.write(fd, b'\n')
                        seen[index] = prompts
                if not interrupted and list(demo.glob('*-close')):
                    os.killpg(children[1].pid, signal.SIGINT)
                    interrupted = True
                if children[1].poll() is not None and (close_fail or children[0].poll() is not None):
                    break
            else:
                raise AssertionError('launchers timed out\n'+ '\n'.join(texts))
            assert interrupted, '\n'.join(texts)
            assert children[1].returncode == (1 if close_fail else 0), '\n'.join(texts)
            calls = [json.loads(x) for x in (demo/'calls.jsonl').read_text().splitlines()]
            remora = [x for x in calls if x['role']=='remora']
            keys = [' '.join(x['args'][:2]) for x in remora]
            assert keys.index('copy start') < keys.index('copy mode') < keys.index('agent run')
            assert keys.count('copy stop') == 1, 'an uncertain close was retried'
            assert not any(x['args'][0] in ('fund', 'wallet') and x['args'][:2]!=['wallet','show'] for x in calls)
            assert not any(x['json'] for x in remora if x['args'][:2]==['agent','run'])
            revokes = [x for x in calls if x['args'][:2]==['grant','revoke']]
            assert len(revokes)==(2 if restart else 0)
            if restart:
                assert 'Resetting the previous local publication' in texts[0]
                assert 'vault confirms it is closed' in texts[1]
                assert all('recover its supported assets' in text for text in texts)
            assert not any(x['args'][0]=='outlayer' for x in calls)
            publish = next(x['args'] for x in calls if x['args'][:2]==['publish','set'])
            assert publish[publish.index('--delivery')+1]=='local'
            assert all('--url' in x['args'] for x in remora if x['args'][0]=='copy' and (x['args'][1]=='start' or x['args'][1].startswith('ap_')))
            if close_fail:
                assert not list(demo.glob('*-closed'))
                assert 'Closure is unconfirmed' in texts[1]
            else:
                assert children[0].returncode == 0, texts[0]
                assert list(demo.glob('*-closed'))
                assert any(x['args'][:2]==['payments','--disable'] for x in remora)
                assert any(x['args'][:2]==['publish','stop'] for x in calls)
            print('PASS:', 'restart with orphaned publication, closed paused subscription and expired grants' if restart else 'uncertain close stops without retry' if close_fail else 'two-terminal workflow, foreground interrupt, confirmed close')
        finally:
            # Release the peer's wait only after assertions, so even the failed
            # close scenario can shut its own fixture publisher down normally.
            if (demo/'shark-ready.json').exists():
                ready = json.loads((demo/'shark-ready.json').read_text())
                (demo/(ready['run']+'-closed')).write_text('fixture teardown only')
            for p in children:
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        p.terminate()
                    except ProcessLookupError:
                        pass
                    p.wait(timeout=5)
            for fd in fds:
                os.close(fd)


if __name__ == '__main__':
    run_case(False)
    run_case(True)
    run_case(False, restart=True)
