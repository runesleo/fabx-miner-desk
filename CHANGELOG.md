# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The homepage becomes an unofficial **TapeOut ecosystem hub** ("TapeOut 生态站", marked 非官方/Unofficial in the header and title): open activity, an **ecosystem map** (`ecosystem.mjs`: TapeOut, Fab X, TapeOut Community Foundation, Ignix, TapeUP, TapeAI, TapeFoundry, each with site / X / Telegram links taken from the project's own X profile and checked 2026-11-01, plus recent radar counts by posting account; contract addresses are left to the official sites), and the FabX tools (payback calculator, rig check, network board, getting started). The calculator tab and `/rigs/` keep the FabX Miner Desk name.
- Radar tab redesign: a header with live counts (open now, posted in the last 24 hours, official sources), method filter chips, colour-coded cards with the source account, a "New" mark for posts from the last day, deadline countdowns, and three next steps (payback calculator, Telegram alerts, full radar). The header nav and the two homepage tabs are restyled to match.
- The homepage opens on a **TapeOut ecosystem radar** tab: open activity from TapeOut ecosystem official accounts (last 7 days, original post linked), read from the Leo Labs radar through the new same-origin `/api/radar` proxy (public fields only, 5-minute cache, CORS for the DeWeb copy). The calculator moves to the **Payback calculator** tab; `/rigs/`, `#calc` and shared asset links still open on it.
- Rig-stop alerts are now **rig income alerts**: the cron worker (`alerts/worker.mjs`) tracks verified on-chain conditions (revoked, stopped, demoted with kick/reclaim/start hints, NFT transfer, ≥30% measured output drop) and broadcasts FabX PodMining governance events (`Paused`, `ProcessorSet`, `Upgraded`, `BoostSet`) to every linked chat. Bot copy, the website sign-up box, README and schema (`alert_rig_state` chain fields, `alert_worker_state`, `alert_governance_seen`) follow the mechanism SSOT wording.

### Added

- TapeOut radar alerts in the Telegram bot: `/tapeout` (or the homepage link `t.me/fabx_miner_desk_bot?start=tapeout`) turns them on and replies with what is open now; the alerts cron then sends new open items the radar first saw after the chat subscribed, at most 2 per chat per Beijing day, each once, and only while the `tapeout` theme is `hot`. New D1 table `alert_radar_subs`; sends use `alert_deliveries` (scope `radar`). `/stop` clears it.
- Cheap official-listing alerts. The alerts cron reuses the site's buy-versus-build comparison and messages Telegram when a listing is at least the subscriber's threshold cheaper than building (default 20%). Each listing is sent once; a listing that leaves a complete scan is not sent again. The website button opens a one-time `t.me` link instead of asking for a username. Bot commands: `/cheap`, `/threshold`, `/stop`.

- Privacy-friendly usage stats for the hosted copy: `track.mjs` sends one page-load count to a Cloudflare Pages Function (`/api/hit`, D1) with day, page, language, referrer host and a random browser ID; no IP, user agent, wallet address, full URL or cookie. Skipped under Do Not Track or without local storage; silently inactive on DeWeb and local servers.
- Rig-stop alert beta: an optional Telegram sign-up below the asset card (`/api/alerts`) stores the looked-up address and Telegram username so rig stops or abnormal output drops can be reported. Free during the beta; a paid plan is planned.
- `schema.sql` D1 migration, `wrangler.toml` Pages config, `_routes.json` limiting functions to `/api/*`, and offline tests with a fake D1.
- Rig-stop alert delivery (`alerts/worker.mjs`): a separate cron Worker re-measures every signed-up address with `wallet()` and messages linked Telegram chats on mining→stopped, stopped→mining and ≥30% output drops; a Telegram bot (`/start`, `/watch`, `/unwatch`, `/list`, `/stop`) links usernames to chats and watches addresses directly. New D1 tables `alert_chats`, `alert_rig_state`, `alert_address_state`, `alert_events`; `desk.mjs` exports `chainHead()` (head block, timestamp, block time) so the worker measures without price reads. The website sign-up now points to the bot after a successful sign-up. Offline tests use Node's built-in SQLite against the real schema.

- Feedback channel: a one-line, no-login box above the footer (`/api/feedback`, D1 table `feedback`, text ≤500 characters + language + page) and the bot command `/feedback one line` (stored with the chat key so a fix can be answered).
- Bot language is chosen once and kept: the website's bot link carries `?start=<lang>`, `/zh` and `/en` switch it, and every later reply (`/watch`, `/list`, alerts) uses the stored language instead of the Telegram client language (10-21: `/start` answered in Chinese, `/watch` in English).

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
