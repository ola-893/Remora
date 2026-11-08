import { useEffect, useId, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useOutletContext, useParams } from 'react-router-dom';
import { Activity, ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronDown, Clock3, Copy, Database, ExternalLink, Fingerprint, ListFilter, Radio, Search, ShieldCheck, Terminal } from 'lucide-react';
import logo from '../../../../brand/remora/assets/remora-lockup-color.svg';
import mark from '../../../../brand/remora/assets/remora-mark.svg';
import loader from '../../../../brand/remora/assets/remora-loader.svg';
import art from '../../../../brand/remora/hero/assets/cybernetic-pair.png';
import recorded from './recorded.json';
import { activities, directoryEntries, explorerUrl, feedOrigin, previewCommand, probePublisher, publisherId, usdcPerSecond } from './directory.mjs';
import './remora.css';

const archive = { ...recorded, state: 'recorded' };
const npmUrl = 'https://www.npmjs.com/package/@ola-893/agentstreams-cli';
const install = 'npm install -g @ola-893/agentstreams-cli';
const quickstart = ['agentstream agent create my-agent', 'agentstream agent use my-agent', 'agentstream wallet connect --network testnet', 'agentstream agent setup --network testnet --deploy'];
const status = { running: 'Running', recorded: 'Recorded', unavailable: 'Unavailable', unconfigured: 'Activity disabled', checking: 'Checking' };
const mode = { paper: 'Paper execution', 'agent-connect': 'NEAR Intents', wallet: 'Browser wallet', unconfigured: 'Execution disabled' };
const events = { 'paper-fill': 'Paper fill', 'intent-fill': 'Intent fill', 'wallet-action': 'Wallet action' };
const storageKey = 'remora.publisher-directory.v1';
const dateTime = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
const day = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortTime = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
const num = new Intl.NumberFormat('en', { maximumFractionDigits: 6 });
const allowLoopback = ['localhost', '127.0.0.1'].includes(window.location.hostname);

function loadLocal() {
  try { return directoryEntries(JSON.parse(localStorage.getItem(storageKey)), allowLoopback); }
  catch { return []; }
}

function useDirectory() {
  const [configured, setConfigured] = useState([]);
  const [local, setLocal] = useState(loadLocal);
  const [offers, setOffers] = useState({});
  const [catalogError, setCatalogError] = useState(false);
  const [catalogReady, setCatalogReady] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/agents.json', { cache: 'no-store', signal: controller.signal }).then(response => {
      if (!response.ok) throw new Error('Directory unavailable');
      return response.json();
    }).then(list => setConfigured(directoryEntries(list, allowLoopback))).catch(() => {
      if (!controller.signal.aborted) setCatalogError(true);
    }).finally(() => {
      if (!controller.signal.aborted) setCatalogReady(true);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const entries = directoryEntries([...local, ...configured], allowLoopback);
    let cancelled = false;
    let timer;
    let request;
    async function refresh() {
      request = new AbortController();
      await Promise.all(entries.map(async entry => {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(6000)]);
        try {
          const next = await probePublisher(entry, signal);
          if (!cancelled) setOffers(previous => ({ ...previous, [entry.id]: next }));
        } catch {
          if (!cancelled) setOffers(previous => {
            const cached = previous[entry.id];
            return { ...previous, [entry.id]: { ...(cached?.origin === entry.origin ? cached : {}), ...entry, state: 'unavailable' } };
          });
        }
      }));
      if (!cancelled && entries.length) timer = setTimeout(refresh, 15000);
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); request?.abort(); };
  }, [configured, local]);

  const agents = [...directoryEntries([...local, ...configured], allowLoopback).map(entry => {
    const offer = offers[entry.id];
    return offer?.origin === entry.origin ? offer : { ...entry, state: 'checking' };
  }), archive];

  async function addPublisher(id, input) {
    if (!publisherId.test(id)) throw new Error('Enter the complete publisher ID beginning with ap_.');
    const entry = { id, origin: feedOrigin(input, allowLoopback) };
    if (configured.some(item => item.id === id && item.origin !== entry.origin)) throw new Error('This ID is already listed with a different origin.');
    const offer = await probePublisher(entry).catch(() => { throw new Error('Could not verify this offer. Check the ID, feed URL, and browser access to the public endpoints.'); });
    const next = directoryEntries([entry, ...local.filter(item => item.id !== id)], allowLoopback);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Still available for the current visit. */ }
    setOffers(previous => ({ ...previous, [id]: offer }));
    setLocal(next);
  }

  function removePublisher(id) {
    const next = local.filter(entry => entry.id !== id);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Still removed for this visit. */ }
    setLocal(next);
  }

  return { agents, addPublisher, removePublisher, localIds: local.map(entry => entry.id), catalogError, catalogReady };
}

function CopyButton({ value, label = 'Copy', beforeCopy, className = '' }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function copy() {
    setBusy(true);
    try {
      await beforeCopy?.();
      await navigator.clipboard.writeText(value);
      setMessage('Copied');
    } catch (error) {
      setMessage(error.message || 'Copy unavailable. Select and copy the text.');
    } finally { setBusy(false); }
  }
  return <span className={'rm-copy ' + className}>
    <button type="button" className="rm-button rm-outline" onClick={copy} disabled={busy}>
      {message === 'Copied' ? <Check size={16} /> : <Copy size={16} />}
      {busy ? 'Checking…' : message === 'Copied' ? 'Copied' : label}
    </button>
    <span role="status" className={message === 'Copied' ? 'sr-only' : 'rm-copy-status'}>{message}</span>
  </span>;
}

export function RemoraLayout() {
  const { pathname } = useLocation();
  const directory = useDirectory();
  useEffect(() => {
    const heading = document.querySelector('#remora-main h1')?.textContent;
    document.title = heading ? heading + ' · Remora' : 'Remora';
    window.scrollTo(0, 0);
    document.getElementById('remora-main')?.focus({ preventScroll: true });
  }, [pathname]);

  return <div className="rm">
    <a className="skip-link" href="#remora-main">Skip to content</a>
    <header className="rm-header">
      <div className="rm-wrap rm-nav">
        <Link to="/" className="rm-brand" aria-label="Remora home"><img src={logo} alt="" width="131" height="42" /></Link>
        <nav aria-label="Main navigation">
          <NavLink to="/" end>Home</NavLink>
          <NavLink to="/explore">Explore agents</NavLink>
        </nav>
        <a className="rm-button rm-outline rm-nav-cli" href={npmUrl} aria-label="CLI on npm"><Terminal size={16} /> <span>CLI on npm</span><ArrowUpRight size={14} /></a>
      </div>
    </header>
    <main id="remora-main" tabIndex={-1}><Outlet context={directory} /></main>
    <footer className="rm-footer"><div className="rm-wrap">
      <Link to="/" aria-label="Remora home"><img src={logo} alt="" width="113" height="35" /></Link>
      <span>Built on NEAR · Testnet</span>
      <Link to="/workflow">Payment evidence <ArrowUpRight size={13} /></Link>
      <a href="https://github.com/ola-893/agentStreams">GitHub <ArrowUpRight size={13} /></a>
    </div></footer>
  </div>;
}

export function RemoraHome() {
  return <>
    <section className="rm-hero">
      <div className="rm-wrap rm-hero-inner">
        <img className="rm-hero-art" src={art} alt="A cybernetic shark leads a smaller teal remora" width="1536" height="1024" fetchPriority="high" />
        <div className="rm-hero-copy">
          <span className="rm-kicker"><span className="rm-dot" /> Intelligence by the second</span>
          <h1>Ride the<br /><em>signal.</em></h1>
          <p>Ride a smart agent’s decisions by the second, without handing it your wallet.</p>
          <div className="rm-hero-actions"><Link className="rm-button rm-primary" to="/explore">Explore agents <ArrowRight size={18} /></Link><a className="rm-button rm-outline" href="#install"><Terminal size={17} /> Install the CLI</a></div>
        </div>
        <div className="rm-hero-label"><span>01 / Leader</span><span>02 / Remora</span></div>
      </div>
    </section>
    <div className="rm-strip"><div className="rm-wrap"><span><Radio size={16} /> Pay by the second</span><span><ShieldCheck size={16} /> Local execution controls</span><span><Fingerprint size={16} /> Inspect the evidence</span></div></div>
    <section className="rm-wrap rm-onboard" id="install">
      <div><p className="rm-kicker">01 / Set up locally</p><h2>Your agent starts<br />in your terminal.</h2><p>Install AgentStreams, create a local agent, and connect a NEAR testnet wallet in your browser.</p><a className="rm-inline" href={npmUrl}>View package on npm <ArrowUpRight size={15} /></a></div>
      <div className="rm-terminal">
        <div className="rm-terminal-top"><Terminal size={17} /> Terminal <span>NEAR TESTNET</span></div>
        <div className="rm-terminal-command"><code>{install}</code><CopyButton value={install} label="Copy install" /></div>
        <pre>{quickstart.join('\n')}</pre>
      </div>
    </section>
    <section className="rm-wrap rm-next">
      <p className="rm-kicker">02 / Research a leader</p><h2>See what an agent actually does.</h2>
      <div className="rm-steps">
        <div><ListFilter /><h3>Filter by activity</h3><p>See which publishers are running and what activity they have enabled.</p></div>
        <div><Activity /><h3>Read its track record</h3><p>Compare the history, execution mode, evidence, and USDC rate.</p></div>
        <div><Copy /><h3>Take the ID to your CLI</h3><p>Preview the offer in your terminal before setting limits and starting a subscription.</p></div>
      </div>
      <Link to="/explore" className="rm-button rm-primary">Explore agents <ArrowRight size={18} /></Link>
    </section>
  </>;
}

function StateBadge({ state }) {
  return <span className={'rm-state rm-' + state}><i />{status[state]}</span>;
}

function PublisherForm({ addPublisher, close }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError('');
    setBusy(true);
    try { await addPublisher(form.get('id').trim(), form.get('origin').trim()); close(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <form className="rm-publisher rm-panel" onSubmit={submit}>
    <div><h2>Check a publisher</h2><p>Use the ID and origin the publisher shared. A verified offer is saved to this browser.</p></div>
    <label>Publisher ID<input name="id" required placeholder="ap_…" maxLength={67} /></label>
    <label>Feed origin<input name="origin" type="url" required placeholder="https://publisher.example" maxLength={250} /></label>
    <div className="rm-form-actions"><button className="rm-button rm-primary" disabled={busy}>{busy ? 'Verifying…' : 'Verify offer'}</button><button type="button" className="rm-button rm-outline" onClick={close}>Cancel</button></div>
    {error && <p role="alert" className="rm-alert">{error}</p>}
  </form>;
}

export function RemoraExplore() {
  const { agents, addPublisher, catalogError } = useOutletContext();
  const [query, setQuery] = useState('');
  const [activity, setActivity] = useState('');
  const [state, setState] = useState('');
  const [showForm, setShowForm] = useState(false);
  const running = agents.filter(a => a.state === 'running');
  const rows = agents.filter(a => (!activity || a.activity === activity) && (!state || a.state === state) &&
    (!query.trim() || [a.id, a.name, a.origin].some(item => item?.toLowerCase().includes(query.trim().toLowerCase()))))
    .sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running'));
  function reset() { setActivity(''); setState(''); setQuery(''); }
  return <div className="rm-wrap rm-page">
    <div className="rm-page-head">
      <div><p className="rm-kicker"><Radio size={15} /> Publisher directory</p><h1>Explore agents</h1><p>Research activity, check the evidence, and take a running publisher’s ID to your CLI.</p></div>
      <button className="rm-button rm-outline" aria-expanded={showForm} onClick={() => setShowForm(!showForm)}><Fingerprint size={17} /> Check a publisher</button>
    </div>
    <div className="rm-directory-summary"><span><span className="rm-dot" /> {running.length} running</span><span>{agents.length} listed</span><span><Database size={15} /> NEAR testnet</span></div>
    {showForm && <PublisherForm addPublisher={addPublisher} close={() => setShowForm(false)} />}
    {catalogError && <p role="status" className="rm-alert">The shared directory couldn’t load. Recorded and locally added publishers are shown below.</p>}
    <div className="rm-panel rm-table-panel">
      <div className="rm-filters">
        <label className="rm-search"><Search size={17} /><input aria-label="Search agents" placeholder="Search name, ID or origin" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <label className="rm-select"><ListFilter size={16} /><select aria-label="Filter by activity" value={activity} onChange={event => setActivity(event.target.value)}><option value="">All activities</option>{Object.entries(activities).map(([id, item]) => <option key={id} value={id}>{item.name}</option>)}</select></label>
        <label className="rm-select"><Radio size={16} /><select aria-label="Filter by status" value={state} onChange={event => setState(event.target.value)}><option value="">All statuses</option>{Object.entries(status).filter(([id]) => id !== 'checking').map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      </div>
      <div className="rm-table-scroll"><table>
        <thead><tr><th scope="col">Agent</th><th scope="col">Activity</th><th scope="col">Status</th><th scope="col">USDC / sec</th><th scope="col">Evidence</th><th scope="col"><span className="sr-only">Open profile</span></th></tr></thead>
        <tbody>{rows.map(agent => <tr key={agent.id}>
          <th scope="row"><Link to={'/explore/' + agent.id} className="rm-agent-link"><span className="rm-avatar"><img src={mark} alt="" /></span><span><strong>{agent.name ?? 'Publisher'}</strong><small>{agent.state === 'recorded' ? 'Recorded testnet run' : agent.id.slice(0, 13) + '…'}</small></span></Link></th>
          <td>{activities[agent.activity]?.name ?? 'Unknown'}</td><td><StateBadge state={agent.state} /></td>
          <td className="rm-number">{usdcPerSecond(agent.rate)}</td>
          <td>{agent.state === 'recorded' ? 'Recorded proof' : agent.checkedAt ? 'Signed offer' : 'Awaiting verification'}</td>
          <td><Link to={'/explore/' + agent.id} className="rm-open" aria-label={'Open ' + (agent.name ?? agent.id) + ' profile'}><ArrowRight size={18} /></Link></td>
        </tr>)}</tbody>
      </table></div>
      {!rows.length && <div className="rm-empty"><Search size={24} /><h2>{state === 'running' && !running.length ? 'No running publishers found' : 'No matching agents'}</h2><p>Change your filters or check a publisher using its ID and feed URL.</p><button className="rm-button rm-outline" onClick={reset}>Reset filters</button></div>}
      <div className="rm-table-footer">{rows.length} of {agents.length} shown<span>Only a fresh, signed offer from a running feed can be copied.</span></div>
    </div>
    <section className="rm-coverage"><div><p className="rm-kicker">Activity coverage</p><h2>What leaders can publish</h2></div><div className="rm-activity-grid">
      {Object.entries(activities).map(([id, item]) => <button type="button" aria-pressed={activity === id} key={id} onClick={() => { setActivity(id); document.querySelector('.rm-filters input')?.focus(); }}>
        <span>{item.name}</span><small>{running.filter(a => a.activity === id).length} running</small><ArrowUpRight size={16} />
      </button>)}
    </div></section>
  </div>;
}

function PerformanceChart({ agent, activity }) {
  const [windowSize, setWindowSize] = useState('all');
  const [active, setActive] = useState(null);
  const [chartWidth, setChartWidth] = useState(786);
  const panel = useRef(null);
  const gradientId = useId();
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setChartWidth(Math.max(240, Math.round(entry.contentRect.width))));
    observer.observe(panel.current);
    return () => observer.disconnect();
  }, []);
  const replay = agent.state === 'recorded';
  const reported = !!agent.points?.length;
  const source = replay ? agent.history.map(event => ({ at: Date.parse(event.at), value: event.value })) :
    reported ? agent.points.map(point => ({ at: Date.parse(point.date), value: point.pnl })) :
    (agent.history ?? []).map((event, index) => ({ at: Date.parse(event.at), value: index + 1 }));
  const last = source.at(-1)?.at;
  const visible = source.filter(point => windowSize === 'all' || point.at >= last - Number(windowSize) * (replay ? 60000 : 86400000));
  const unit = replay ? 'wNEAR / USDC' : reported ? 'publisher units' : 'actions';
  const title = replay ? 'Quoted swap output' : reported ? 'Reported P&L' : activity?.action ?? 'Published actions';
  const ranges = replay ? [['15', '15m'], ['30', '30m'], ['all', 'Full run']] : [['7', '7D'], ['30', '30D'], ['90', '90D'], ['all', 'All']];
  const min = Math.min(...visible.map(p => p.value));
  const max = Math.max(...visible.map(p => p.value));
  const low = reported || replay ? min - (max - min || Math.abs(min) || 1) * .16 : 0;
  const high = max + (max - min || Math.abs(max) || 1) * .12;
  const left = 76, right = chartWidth - 12, top = 20, bottom = 203;
  const first = visible[0]?.at;
  const width = Math.max(1, last - first);
  const plot = visible.map(p => ({ ...p, x: left + (p.at - first) / width * (right - left), y: bottom - (p.value - low) / (high - low) * (bottom - top) }));
  const line = plot.map(p => p.x + ',' + p.y).join(' ');
  const activeIndex = Math.min(active ?? plot.length - 1, plot.length - 1);
  const point = plot[activeIndex];
  const fmtDate = replay ? shortTime : day;
  const provenance = replay ? 'Recorded · signed dry-run quotes' : reported ? 'Publisher-reported · signed listing' : 'Publisher-signed activity history';
  return <section ref={panel} className="rm-panel rm-performance">
    <div className="rm-section-head"><div><p className="rm-kicker">Activity performance</p><h2>{title}</h2></div>
      {!!source.length && <div className="rm-ranges" aria-label="Chart range">{ranges.map(([id, label]) => <button key={id} aria-pressed={windowSize === id} onClick={() => { setWindowSize(id); setActive(null); }}>{label}</button>)}</div>}
    </div>
    {!point ? <div className="rm-empty"><Activity size={28} /><h3>No performance history published</h3><p>{activity?.focus ?? 'Performance appears after the publisher shares a signed history.'}</p></div> : <>
      <div className="rm-chart-value"><strong>{num.format(point.value)}</strong><span>{unit} · {fmtDate.format(point.at)}{replay ? ' UTC' : ''}</span></div>
      <svg className="rm-chart" viewBox={'0 0 ' + chartWidth + ' 233'} role="img" aria-label={title + ', ' + visible.length + ' observations'}>
        <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#35e9ce" stopOpacity=".26" /><stop offset="1" stopColor="#35e9ce" stopOpacity=".02" /></linearGradient></defs>
        {[0, 1, 2, 3, 4].map(i => {
          const y = top + (bottom - top) * i / 4;
          return <g key={i}><line x1={left} x2={right} y1={y} y2={y} stroke="#23384b" /><text x={left - 10} y={y + 4} textAnchor="end">{num.format(high - (high - low) * i / 4)}</text></g>;
        })}
        {plot.length > 1 && <><polygon points={plot[0].x + ',' + bottom + ' ' + line + ' ' + plot.at(-1).x + ',' + bottom} fill={'url(#' + gradientId + ')'} /><polyline points={line} fill="none" stroke="#35e9ce" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" /></>}
        <line x1={point.x} x2={point.x} y1={top} y2={bottom} stroke="#7b9cba" strokeDasharray="4 4" />
        <circle cx={point.x} cy={point.y} r="5" fill="#67f5ff" stroke="#0b1625" strokeWidth="2" />
        <text x={left} y="226">{fmtDate.format(first)}</text>{plot.length > 1 && <text x={right} y="226" textAnchor="end">{fmtDate.format(last)}</text>}
      </svg>
      {plot.length > 1 && <label className="rm-chart-slider"><span>Inspect chart point</span><input aria-label="Inspect chart point" aria-valuetext={num.format(point.value) + ' ' + unit + ' on ' + dateTime.format(point.at) + ' UTC'} type="range" min="0" max={plot.length - 1} value={activeIndex} onChange={event => setActive(Number(event.target.value))} /></label>}
      <p className="rm-chart-note"><span className="rm-dot" /> {provenance}<span>{replay ? 'Quote output at each fill. No realized P&L.' : reported ? 'The signature identifies the publisher. The figures are self-reported.' : 'Cumulative count of the recent actions the publisher shared.'}</span></p>
    </>}
  </section>;
}

function Evidence({ agent, activity }) {
  const history = agent.history ?? [];
  return <section className="rm-panel rm-evidence">
    <div className="rm-section-head"><div><p className="rm-kicker">Provenance</p><h2>Execution history</h2></div><span className="rm-muted">{history.length} entries</span></div>
    <p>{activity?.focus ?? 'The publisher’s signed activity is needed to show the evidence.'}</p>
    {history.length ? <div className="rm-receipts">{[...history].reverse().map((event, index) => <details key={event.at + '-' + index}>
      <summary><span className="rm-event-icon"><Activity size={17} /></span><strong>{event.label ?? events[event.kind]}</strong><time dateTime={event.at}>{dateTime.format(new Date(event.at))} UTC</time><ChevronDown size={17} /></summary>
      <div>{event.kind === 'paper-fill' ? 'Paper execution. This fill did not settle onchain.' : event.kind === 'wallet-action' ? 'The publisher included this NEAR receipt in its signed offer.' : 'The publisher reported a settled NEAR Intents fill. The listing contains no transaction reference for this fill.'}
        {event.quoteAt && <p>Quote observed {dateTime.format(new Date(event.quoteAt))} UTC.</p>}
        {event.receipt && <a className="rm-inline" href={explorerUrl(event.receipt)} target="_blank" rel="noreferrer">Open transaction <ExternalLink size={14} /></a>}
      </div>
    </details>)}</div> : <div className="rm-empty rm-empty-inline"><Fingerprint size={22} /><p>No public execution entries yet.</p></div>}
    {agent.source && <div className="rm-proof-links"><a className="rm-inline" href={agent.source} target="_blank" rel="noreferrer">Read the recorded run <ExternalLink size={14} /></a><p>The payment stream was on NEAR testnet. The swaps in this recording were paper fills.</p><div>{agent.payments.map(payment => <a key={payment.hash} href={explorerUrl(payment.hash)} target="_blank" rel="noreferrer">{payment.label} <ArrowUpRight size={14} /></a>)}</div></div>}
  </section>;
}

function CopyOffer({ agent }) {
  const running = agent.state === 'running';
  async function recheck() {
    const current = await probePublisher({ id: agent.id, origin: agent.origin }).catch(() => { throw new Error('The publisher’s live offer could not be verified.'); });
    if (current.state !== 'running') throw new Error('This publisher is no longer running.');
    if (['activity', 'rate', 'duration', 'recipient', 'execution'].some(key => current[key] !== agent[key])) throw new Error('The publisher changed its offer. Wait for the directory to refresh.');
  }
  return <aside className="rm-panel rm-offer">
    <p className="rm-kicker"><Terminal size={15} /> Use in your CLI</p>
    <h2>Copy this agent</h2>
    <div className="rm-rate"><strong>{usdcPerSecond(agent.rate)}</strong><span>USDC / second</span></div>
    <p className="rm-muted">{agent.state === 'recorded' ? 'Historical stream rate' : agent.rate ? 'Rate from the latest signed offer' : 'Rate unavailable'}</p>
    {agent.state !== 'recorded' && <div className="rm-id"><span>Publisher ID</span><code>{agent.id}</code></div>}
    {running ? <>
      <CopyButton value={agent.id} label="Copy agent ID" beforeCopy={recheck} />
      <div className="rm-preview-cmd"><span>Preview this offer in your terminal</span><code>{previewCommand(agent)}</code><CopyButton value={previewCommand(agent)} label="Copy preview command" beforeCopy={recheck} /></div>
      <p>Preview the terms first. Set your guards and approve payment in the CLI before starting a stream.</p>
    </> : <div className="rm-copy-blocked"><Clock3 size={18} /><p>{agent.state === 'recorded' ? 'This run is archived.' : 'This offer is currently unavailable.'} Only running publishers can be copied.</p></div>}
    {!!agent.rate && <dl><div><dt>Duration</dt><dd>{agent.duration ? num.format(agent.duration) + ' sec' : 'Until closed or depleted'}</dd></div>{agent.recipient && <div><dt>Recipient</dt><dd>{agent.recipient}</dd></div>}</dl>}
  </aside>;
}

export function RemoraAgent() {
  const { id } = useParams();
  const { agents, localIds, removePublisher, catalogReady } = useOutletContext();
  const agent = agents.find(a => a.id === id);
  useEffect(() => {
    if (agent?.name) document.title = agent.name + ' · Remora';
    else if (catalogReady) document.title = (agent ? 'Publisher profile' : 'Publisher not found') + ' · Remora';
  }, [agent?.name, agent, catalogReady]);
  if (!agent && !catalogReady) return <div className="rm-wrap rm-page rm-empty"><img src={loader} alt="" width="72" height="72" /><p role="status">Checking the publisher directory…</p></div>;
  if (!agent) return <div className="rm-wrap rm-page"><Link className="rm-inline" to="/explore"><ArrowLeft size={16} /> Explore agents</Link><div className="rm-empty"><h1>Publisher not found</h1><p>Find registered publishers in Explore, or check the publisher’s ID and feed URL there.</p></div></div>;
  const activity = activities[agent.activity];
  return <div className="rm-wrap rm-page">
    <Link className="rm-back" to="/explore"><ArrowLeft size={16} /> Explore agents</Link>
    <div className="rm-profile-head">
      <div className="rm-avatar rm-profile-avatar"><img src={mark} alt="" /></div>
      <div><p className="rm-kicker">{activity?.name ?? 'Publisher'} / NEAR testnet</p><h1>{agent.name ?? 'Publisher profile'}</h1><div className="rm-profile-meta"><StateBadge state={agent.state} /><span>{mode[agent.execution] ?? 'Execution mode unknown'}</span>{agent.state === 'recorded' ? <span>Recorded {dateTime.format(new Date(agent.startedAt))} UTC</span> : agent.checkedAt && <span>Checked {dateTime.format(agent.checkedAt)} UTC</span>}</div></div>
    </div>
    <div className="rm-profile-grid">
      <div className="rm-profile-content"><PerformanceChart key={id + '-' + agent.activity} agent={agent} activity={activity} /><Evidence agent={agent} activity={activity} /></div>
      <CopyOffer key={id} agent={agent} />
    </div>
    {localIds.includes(id) && <Link className="rm-inline rm-remove" to="/explore" onClick={() => removePublisher(id)}>Remove saved publisher</Link>}
  </div>;
}
