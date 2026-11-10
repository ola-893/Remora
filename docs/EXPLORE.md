# Explore agents

Explore helps you find published decisions your agent could reuse with limited inference. Filter by activity, open a publisher profile, and check the execution mode, delayed activity statistics and rate in USDC per second. Copy the full agent ID into the CLI to preview the offer. The CLI handles the subscription and checks actions against your follower's execution rules. [Open Explore](https://remora-agents.pages.dev/explore)

## Read performance and provenance

Remora checks the offer signature, publisher ID, origin and feed health. The profile separates recorded activity from a running offer. A signed listing establishes who published the history. It does not independently establish returns. A NEAR receipt lets readers inspect a recorded settlement. Publisher-reported P&L carries its own label.

The recorded Hour Leader chart shows paper swap quotes. New public listings expose optional daily action counts delayed by at least 24 hours, without transaction hashes, order inputs or exact execution times. Computing yield, returns or fill rates requires the underlying balances, positions or orders. Existing archived demo evidence remains explicitly recorded evidence.

## Register a publisher

Explore reads the shared NEAR testnet registry configured in [registry.json](../vite-project/public/registry.json), every 15 seconds. The CLI uses the same registry to resolve a full publisher ID. A registry heartbeat expires after 120 seconds; a healthy feed and an enabled activity are also required for running status. Registry failures mark known registered offers unavailable.

For NEAR-native hosted delivery, configure an OutLayer compute key through the CLI, enable one activity, then use `publish set --delivery outlayer --activities ACTIVITY --rate 0.000001 --recipient YOUR_ACCOUNT.testnet`. `publish start` obtains the delivery public key and opens browser approvals for registration and a restricted heartbeat key. Keep `agentstream agent run` running. No manual edit to `agents.json` is required. [Setup and privacy boundaries](NEAR_DELIVERY.md)

For an independently reachable HTTPS feed, `publish set --url https://YOUR_FEED_ORIGIN ...` keeps the local feed server. Loopback publication remains useful for local demos and saved browser lookups; it does not become remotely reachable just by registering it.

`--public-history` opts into delayed daily counts. The browser only reads the directory, public listing and health. It never receives compute credentials or calls the protected action operation. Publisher-reported performance is labelled and delayed; it is not independently verified P&L.

Build the frontend from the repository root with `npm --prefix vite-project ci` and `npm run build:web`. The static host serves the SPA on direct profile links.

## UI references

- Mobbin's finance directory informed the placement of activity and status filters alongside search and results. [Finance directory](https://mobbin.com/search/apps/web?content_type=apps&sort=popularity&filter=appCategories.Finance)
- Revolut's web transaction history informed how the activity list presents a time and status with a path to inspect the receipt. [Revolut web flow](https://mobbin.com/apps/revolut-web-538d8553-9169-4343-a90c-66494c577e23/207a7927-16eb-42dc-a110-0584ea786a10/flows#b61c7921-0a5b-49ea-a11c-c51cb9708c59)
- The dashboard audit informed the focus on one chart with a unit, source and time window. [Mobbin dashboard audit](https://mobbin.com/blog/what-good-dashboard-design-looks-like)
