import { Link } from "react-router-dom";
import "../near.css";

export default function NearDocs() {
  return (
    <article className="near-page near-docs">
      <div className="near-kicker">AGENTSTREAMS / DOCUMENTATION</div>
      <h1>Agent payments with a human limit.</h1>
      <p>
        agentStreams gives an AI agent a funded API session on NEAR. The owner
        controls the money and policy. The agent can request access, reuse its
        session and submit approved lifecycle actions.
      </p>
      <h2>Publish and copy spot trades</h2>
      <p>
        Named agents can publish a private journal and subscribe to another
        agent. In paper mode, the CLI verifies a signed NEAR Intents 1Click dry
        quote before updating virtual balances. Access to the journal uses a
        real NEAR testnet USDC stream.
      </p>
      <pre><code>{"agentstreams agent create leader\nagentstreams task list\nagentstreams task portfolio"}</code></pre>
      <h2>The payment lifecycle</h2>
      <ol>
        <li>
          The owner deposits USDC into the vault and sets the budget, approved
          recipients, maximum rate and session duration.
        </li>
        <li>
          The agent encounters HTTP 402 and asks to buy access. A separate
          policy worker checks the provider, quote, available funds and payment
          rules.
        </li>
        <li>
          The worker signs the exact session intent. The agent’s restricted key
          submits it. The NEAR vault independently checks the signature, nonce,
          expiry and financial limits.
        </li>
        <li>
          The provider verifies a signed agent session against the active
          onchain stream. Many requests share that session without another
          payment transaction.
        </li>
        <li>
          On detected service failure, the worker approves closure. Earned funds
          become claimable by the provider; the unused amount returns to the
          vault.
        </li>
      </ol>
      <h2>Configure and run an agent</h2>
      <p>Build the CLI from the source checkout with npm run pack:distribution. The package README lists the tarballs to install.</p>
      <pre><code>{"agentstreams config limits --budget 0.10 --max-stream 0.01 --max-rate 0.0001 --max-duration 1000\nagentstreams config set --max-5xx 3 --idle-timeout 60 --max-requests 100 --reuse true\nagentstreams service set --url https://YOUR-API.example --request-path /research\nagentstreams inference set --base-url http://localhost:11434/v1 --model YOUR_MODEL\nagentstreams payments --enable\nagentstreams agent run --prompt \"Use the configured paid API to research payment streams.\""}</code></pre>
      <p>Use an OpenAI-compatible local or cloud inference endpoint, or install the MCP tools into Cursor, Codex or another MCP harness. Service rules include separate consecutive 5xx, transport and health failure thresholds. The paid API must implement agentStreams’s NEAR quote, health, payment challenge and session protocol; other protocols need adapters.</p>
      <h2>Verify the public NEAR testnet run</h2>
      <pre><code>{"agentstreams verify\nagentstreams ui"}</code></pre>
      <p>
        The verify command reads the public testnet RPC without keys or funds:
        it checks deployed WASM, final payment receipts and settled stream state.
        The viewer replays a real run with its capture date and explorer links;
        its balances are historical. HTTP observations remain offchain evidence.
      </p>
      <h2>Make your own NEAR testnet transactions</h2>
      <pre><code>{"agentstreams wallet connect --network testnet\nagentstreams init --network testnet\n# Review preflight, then approve each deployment transaction in the wallet.\nagentstreams init --network testnet --deploy\n# Request Circle testnet USDC for the connected owner.\nagentstreams fund 0.1\n# Configure limits, service and inference before enabling payments.\nagentstreams request --tier basic --query 'q=payment+streams'\nagentstreams stream status\nagentstreams stream close\nagentstreams payments --disable"}</code></pre>
      <p>
        Fresh setup bundles the vault WASM: no Rust or deployment.json is needed.
        It requires at least 6 test NEAR available after storage reserve in an
        owner-controlled named testnet account. Setup and funding are explicit
        owner actions; routine payment tools load only restricted runtime keys.
        The local research fixture uses real testnet settlement. There is no gas sponsor.
      </p>
      <h2>Automatic closure</h2>
      <p>Run the standalone agent, MCP server or <code>agentstreams monitor</code> for health and idle checks between requests. Separate CLI requests reuse matching, chain-verified session state. A stopped local process cannot close automatically; the contract bounds accrual by the prepaid amount and any configured session expiry. The CLI has no demo or simulation command.</p>
      <h2>Source-checkout sandbox</h2>
      <pre>
        <code>
          {
            "npm run install:all\nrustup target add wasm32-unknown-unknown\nnpm run build:near\nnpm run dev:live"
          }
        </code>
      </pre>
      <p>
        Open <code>http://127.0.0.1:5327</code>, choose Live local, and run the
        agent. This starts an isolated NEAR blockchain and a local research
        API using a six-decimal test token. No wallet or model key is needed for
        the scripted demonstration.
      </p>
      <pre>
        <code>
          {
            "npm run demo:agent -- --sandbox\nnpm run demo:agent -- --sandbox --ai\nnpm run test:near\nnpm run demo:capture"
          }
        </code>
      </pre>
      <p>
        Configure the AI option from the checkout with <code>npm run agentstreams -- agent create demo</code>
        {" "}and <code>npm run agentstreams -- inference set --provider near-ai --model MODEL_ID</code>.
        Enter your inference API key at the CLI prompt. The model only selects a service tier. Quotes,
        recipients, amounts and signing stay with the host and policy worker.
      </p>
      <h2>What protects the funds</h2>
      <p>
        The agent key can call only the vault’s open and close methods. The
        contract checks the registered agent key and a distinct policy
        signature, then enforces approved recipients, one active session,
        per-session limits, cumulative spending, nonce and expiry. The owner can
        pause new sessions, change policy and recover an active stream.
      </p>
      <p>
        Function-call key allowance pays for gas. The USDC budget lives in the
        contract. A session’s full deposit counts against the remaining budget
        while active. The provider claims earnings after settlement, and failed
        token transfers restore the claim for retry.
      </p>
      <h2>Availability and trust</h2>
      <p>
        The policy worker and its HTTP observations remain trusted. A signature
        authenticates that worker; it does not prove API answer quality. Funds
        accrue by elapsed time until closure or the session cap. A stopped
        worker cannot cancel a stream automatically. Owner recovery and
        permissionless expiry settlement remain available.
      </p>
      <p>
        Owner and publisher private keys stay in their wallets. The CLI checks
        the signed connection and verifies transaction approvals on NEAR. It
        generates and stores the restricted agent and policy keys locally.
      </p>
      <h2>Networks and evidence</h2>
      <p>
        Sandbox runs use an isolated NEAR node and an explicitly labeled token
        fixture. Testnet deployment uses Circle’s native test USDC. Recorded
        runs display their network and capture date; local transaction hashes
        have no public explorer. A testnet deployment and local sandbox are
        distinct evidence.
      </p>
      <p>
        The repository’s <code>docs/NEAR.md</code> includes testnet deployment,
        provider setup, recovery and the migration boundaries.{" "}
        <code>docs/HACKATHON_NEAR.md</code> identifies the inherited baseline
        and NEAR work.
      </p>
      <p>
        <Link to={window.__AGENTSTREAMS_RECORDED_ONLY__ ? '/' : '/workflow'}>Open the NEAR workflow →</Link>
      </p>
    </article>
  );
}
