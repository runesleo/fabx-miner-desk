# Product scope

FabX Miner Desk helps people inspect FabX mining economics on X Layer through a static, bilingual, read-only interface.

## Supported workflows

- Compare the modeled cost of building output with measurable official rig listings, using OKB per FAB/day.
- Inspect an address's confirmed rigs, pending rewards, measured production, and replacement-cost estimates.
- Explore symmetric price scenarios and network-growth assumptions without executing a trade.
- Learn the basic roles of FabX, FAB, NAND, and LATCH, with links to official pages.
- Optionally enter a custom harvest rule; it starts empty and disabled and stays in browser storage.
- Optionally subscribe with one Telegram tap. The page opens a one-time link; Start in the bot finishes it. Cheap official listings default to at least 20% cheaper than building, and an address lookup can watch that address too. `/cheap`, `/threshold`, and `/stop` control it. Paid alerts are planned; the dashboard stays free.

## Product constraints

1. Read-only: no signing, approvals, claims, purchases, or transaction submission. Wallet extensions supply an address only after a user action.
2. Traceable numbers: show source, observation time, block, cache age, and coverage where applicable.
3. Honest missing data: unavailable measurements remain unknown. Partial listing enumeration must not produce a ranking; incomplete wallet discovery must be labeled.
4. Consistent measurements: wallet assets and listing comparisons use the same approximately ten-minute live-reward method with claim, state, and rate checks.
5. Limited scope: official FabX rig listings only; no claim of comprehensive market coverage, investment recommendations, or future returns.
6. Pages are statically hosted on FabX DeWeb; usage statistics, alert registration, feedback, and verification forwarding are provided by APIs on Cloudflare Pages (`/api/hit`, `/api/alerts`, `/api/feedback`, `/api/pod-verify`). DeWeb uses those hosted APIs through `api-url.mjs`. Chain and price reads go directly to public providers; verification sends the task ID and netlist through the Pages relay. Stats store day, page, language, referrer host, random browser ID, hosting surface, and time, with no IP, user agent, address, or URL; Do Not Track disables them. Registration and feedback are sent only on explicit submit. Browser storage retains preferences and cached observations.
7. Reliable checks and alerts: distinguish absent circuits, failed reads, and incomplete verification. Passing all official vectors does not prove every input correct or protect the optimal slot. Preserve valid monitoring fields and their timestamps across partial reads. Store events separately from per-recipient delivery receipts; retry confirmed failures and hold unknown outcomes for reconciliation. Weekly reports show ownership and measurement coverage and compare only complete adjacent weeks.

## Acceptance criteria

- New visitors can read risks and reach the build-versus-buy and payback views without a wallet.
- Existing holders can paste an address or use the clearly labeled public example.
- English and Chinese interfaces remain usable on mobile.
- Prices, measured output, static estimates, and assumptions are distinguishable.
- Offline `node --test` checks calculations, failure paths, coverage, caching, UI behavior, API validation, delivery retries, and weekly coverage using offline providers and an in-memory D1 substitute. Apply the commented Task K migration in `schema.sql` before running the updated alert worker.

See [README.md](README.md) for contract addresses, calculations, setup, safety, and limitations. Historical mobile captures in [docs/screenshots/](docs/screenshots/) illustrate past observations rather than current availability; see the README verification section for their scope.
