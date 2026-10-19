# Product scope

FabX Miner Desk helps people inspect FabX mining economics on X Layer through a static, bilingual, read-only interface.

## Supported workflows

- Compare the modeled cost of building output with measurable official rig listings, using OKB per FAB/day.
- Inspect an address's confirmed rigs, pending rewards, measured production, and replacement-cost estimates.
- Explore symmetric price scenarios and network-growth assumptions without executing a trade.
- Learn the basic roles of FabX, FAB, NAND, and LATCH, with links to official pages.
- Optionally enter a custom harvest rule; it starts empty and disabled and stays in browser storage.

## Product constraints

1. Read-only: no signing, approvals, claims, purchases, or transaction submission. Wallet extensions supply an address only after a user action.
2. Traceable numbers: show source, observation time, block, cache age, and coverage where applicable.
3. Honest missing data: unavailable measurements remain unknown. Partial listing enumeration must not produce a ranking; incomplete wallet discovery must be labeled.
4. Consistent measurements: wallet assets and listing comparisons use the same approximately ten-minute live-reward method with claim, state, and rate checks.
5. Limited scope: official FabX rig listings only; no claim of comprehensive market coverage, investment recommendations, or future returns.
6. Static distribution: no application backend or credentials. Providers still receive read requests, and browser storage retains preferences and cached observations.

## Acceptance criteria

- New visitors can read risks and reach the build-versus-buy and payback views without a wallet.
- Existing holders can paste an address or use the clearly labeled public example.
- English and Chinese interfaces remain usable on mobile.
- Prices, measured output, static estimates, and assumptions are distinguishable.
- Offline `node --test` checks calculations, failure paths, coverage, caching, and UI behavior using fake providers.

See [README.md](README.md) for contract addresses, calculations, setup, safety, and limitations. Historical mobile captures in [docs/screenshots/](docs/screenshots/) illustrate past observations rather than current availability; see the README verification section for their scope.
