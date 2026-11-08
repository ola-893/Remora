import { NearConnector } from '@hot-labs/near-connect';
import './wallet.css';

const fragment = location.hash.slice(1);
if (fragment) sessionStorage.setItem('agentstreams.owner-session', fragment);
const token = fragment || sessionStorage.getItem('agentstreams.owner-session');
history.replaceState(null, '', location.pathname);
const $ = id => document.getElementById(id);
async function api(path, data) {
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'content-type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Wallet request failed'); return result;
}
function message(text, error = false) { $('status').textContent = text; $('status').className = error ? 'error' : ''; }
let session, connector;
function wireActions(actions) {
  return actions.map(action => action.type === 'DeployContract' ? { type: 'DeployContract', params: { code: Uint8Array.from(atob(action.params.codeBase64), x => x.charCodeAt(0)) } } : action);
}
async function wallet() {
  let connected; try { connected = await connector.wallet(); } catch { connected = await connector.connect(); }
  const accounts = await connected.getAccounts();
  const expected = session.plan?.ownerId ?? session.challenge.accountId;
  if (expected && !accounts.some(a => a.accountId === expected)) throw new Error(`Select the wallet account ${expected}, then retry.`);
  return connected;
}
try {
  session = await api('/api/session');
  connector = new NearConnector({ network: 'testnet', excludedWallets: ['near-cli'], features: { signMessage: true, signAndSendTransaction: true, signInWithoutAddKey: true, testnet: true } });
  $('title').textContent = session.kind === 'connect' ? 'Connect your owner wallet' : session.plan.label;
  $('network').textContent = 'NEAR testnet';
  $('description').textContent = session.kind === 'connect' ? 'Choose your wallet and approve a sign-in message. This does not grant spending access or send a transaction.' : 'Review this owner-only operation, then approve it in your wallet. Your private key stays in your wallet.';
  $('owner').textContent = session.plan?.ownerId ?? session.challenge.accountId ?? 'Choose a named .testnet account';
  $('receiver').textContent = session.plan?.receiverId ?? 'agentStreams owner connection';
  if (session.plan) {
    const details = session.plan.actions.map(action => action.type === 'DeployContract' ? { type: action.type, bytes: atob(action.params.codeBase64).length } : action);
    $('details').textContent = JSON.stringify(details, null, 2);
  } else $('details-box').hidden = true;
  $('approve').textContent = session.kind === 'connect' ? 'Connect and verify owner' : 'Approve in wallet';
  $('approve').disabled = false;
  if (session.complete || session.submitted) { $('approve').disabled = true; message('This request is complete or has already been submitted. Return to the CLI to check its outcome.'); }
} catch (error) { message(error.message, true); }

$('choose').onclick = async () => { try { await connector?.disconnect(); await connector.connect(); message('Wallet selected. Continue with the operation below.'); } catch (error) { message(error.message, true); } };
$('approve').onclick = async () => {
  $('approve').disabled = true; $('cancel').disabled = true;
  let submitted = false;
  try {
    const selected = await wallet();
    if (session.kind === 'connect') {
      message('Approve the sign-in message in your wallet.');
      const challenge = session.challenge;
      const signed = await selected.signMessage({ message: challenge.message, recipient: challenge.recipient, network: 'testnet', signerId: challenge.accountId, nonce: Uint8Array.from(atob(challenge.nonce), x => x.charCodeAt(0)) });
      const result = await api('/api/connect', { ...signed, walletId: selected.manifest?.id });
      message(`Connected ${result.accountId}. Return to your terminal.`);
    } else {
      await api('/api/submitting', {}); submitted = true;
      message('Approve this transaction in your wallet.');
      const result = await selected.signAndSendTransaction({ network: 'testnet', signerId: session.plan.ownerId, receiverId: session.plan.receiverId, actions: wireActions(session.plan.actions) });
      const hash = result?.transaction?.hash;
      if (!hash) throw new Error('The wallet did not return a transaction hash. Check the wallet, then run agentstream wallet reconcile.');
      message('Checking the final transaction on NEAR testnet…');
      const confirmed = await api('/api/transaction', { hash });
      message('Confirmed. Return to your terminal.');
      $('receipt').href = confirmed.explorerUrl; $('receipt').textContent = 'View transaction'; $('receipt').hidden = false;
    }
  } catch (error) {
    message(error.message, true);
    if (submitted) { await api('/api/error', {}).catch(() => {}); }
    else { $('approve').disabled = false; $('cancel').disabled = false; }
  }
};
$('cancel').onclick = async () => { try { await api('/api/cancel', {}); $('approve').disabled = true; message('Cancelled. No transaction was requested.'); } catch (error) { message(error.message, true); } };
