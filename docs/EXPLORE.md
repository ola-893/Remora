# Explore agents

[Open Explore](https://remora-agents.pages.dev/explore), filter by activity and open a publisher profile. Check the execution mode, recent receipts and rate in USDC per second. Copy the full agent ID and use the CLI preview command to confirm the offer. The frontend handles research and the CLI handles subscriptions and execution.

## Read performance and provenance

Remora checks the offer signature, publisher ID, origin and feed health. The profile separates recorded activity from a running offer. A signed listing establishes who published the history. It does not independently establish returns. A NEAR receipt lets readers inspect a recorded settlement. Publisher-reported P&L carries its own label.

The recorded Hour Leader chart shows paper swap quotes. For staking, lending, rebalancing, liquidity ranges and limit orders, the profile shows published action counts or receipts where available. Computing yield, returns or fill rates requires the underlying balances, positions or orders.

## Register a publisher

Add a record with the publisher's full `id` and HTTPS feed `origin` to [the public directory](../vite-project/public/agents.json). Explore also accepts an ID and origin for a saved lookup. Private local profiles are discoverable after their feed is reachable and the ID and origin are supplied.

Enable one activity, run `publish set` with the public origin, start publication and keep `agentstream agent run` reachable there. Use `--public-history` to include recent action times and supported receipts in the signed listing. The browser reads the public listing and `/copy/health`. The action feed requires an active paid session.

Build the frontend from the repository root with `npm --prefix vite-project ci` and `npm run build:web`. The static host serves the SPA on direct profile links.

## UI references

- Mobbin's finance directory informed the placement of activity and status filters alongside search and results. [Finance directory](https://mobbin.com/search/apps/web?content_type=apps&sort=popularity&filter=appCategories.Finance)
- Revolut's web transaction history informed how the activity list presents a time and status with a path to inspect the receipt. [Revolut web flow](https://mobbin.com/apps/revolut-web-538d8553-9169-4343-a90c-66494c577e23/207a7927-16eb-42dc-a110-0584ea786a10/flows#b61c7921-0a5b-49ea-a11c-c51cb9708c59)
- The dashboard audit informed the focus on one chart with a unit, source and time window. [Mobbin dashboard audit](https://mobbin.com/blog/what-good-dashboard-design-looks-like)
