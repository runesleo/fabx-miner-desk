# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Privacy-friendly usage stats for the hosted copy: `track.mjs` sends one page-load count to a Cloudflare Pages Function (`/api/hit`, D1) with day, page, language, referrer host and a random browser ID; no IP, user agent, wallet address, full URL or cookie. Skipped under Do Not Track or without local storage; silently inactive on DeWeb and local servers.
- Rig-stop alert beta: an optional Telegram sign-up below the asset card (`/api/alerts`) stores the looked-up address and Telegram username so rig stops or abnormal output drops can be reported. Free during the beta; a paid plan is planned.
- `schema.sql` D1 migration, `wrangler.toml` Pages config, `_routes.json` limiting functions to `/api/*`, and offline tests with a fake D1.

### Changed

- Privacy documentation, product constraints and method notes now describe the two optional functions instead of "no backend"; the dashboard remains read-only and never asks to sign.

## [0.1.0] - 2026-10-19

### Added

- Static, read-only FabX mining dashboard for X Layer with English and Chinese interfaces.
- Build-versus-buy comparison in OKB per FAB/day, with complete official-market listing scans and measured-output ranking.
- Address-based rig discovery with pinned-block ownership confirmation, pending rewards, and approximately ten-minute production measurements.
- Rig asset cards showing replacement-cost estimates, static gross APR, payback, and price/network-growth scenarios.
- On-chain NAND best-ask pricing, FAB/BEM pool reference pricing, and public BEM/USD and OKB-USDT price sources.
- Batched read calls, RPC failover, bounded queries, caching, and explicit unknown or partial-coverage states.
- Newcomer explanations, contract-risk disclosures, official links, and optional browser-local custom rules that start empty and disabled.
- Offline tests using mocked providers and fixed fixtures, plus separate read-only live diagnostics.
- Bilingual setup, privacy and data-methodology documentation, product scope, and historical mobile screenshots.
- MIT license.
