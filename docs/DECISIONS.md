# Trade Bot decision log

Dates below are used only when supported by repository history or dated migration files. “Date not recorded” means the decision is documented as current direction but its original decision date is not verifiable from the repository.

## Date not recorded — historical research before live execution

The project studies historical B3 WDO data before considering live feeds, brokerage integration, or execution. Current observations and candidate rules are research artifacts, not validated strategies or profitability claims.

## Date not recorded — one shared Explorer

Chart review, drawings, structured analysis, history, and replay belong in the same protected Explorer. Replay is not a separate application. This keeps a single data-loading and authorization boundary while preserving distinct retrospective and replay contexts.

## 2026-09-22 — private storage and membership-gated access

The migrations dated 2026-09-22 establish `research_members`, annotation RLS, and the private `trade-bot-candles` bucket. Authentication alone is insufficient: membership is required for shared research and candle-object reads. The frontend has no Storage write policy and uses no privileged key.

References: [research migration](../explorer/supabase/migrations/202609220001_research_annotations.sql), [Storage migration](../explorer/supabase/migrations/202609220002_private_candle_storage.sql).

## 2026-09-22 — GitHub Pages project deployment

Commit `0ef6ef9` configured the Vite production base for `/trader_bot/` and a GitHub Actions Pages workflow. Candle history remains outside the Pages artifact and is downloaded from private Storage after authorization.

Reference: [deployment workflow](../.github/workflows/deploy-pages.yml).

## 2026-09-23 — completed-candle replay in the existing Explorer

Commit `ea635d1` added replay over audited, completed one-minute candles. Replay owns simulated time and exposes a read-only candle prefix. There is no trade-by-trade or intrabar simulation.

Reference: [`replay.js`](../explorer/src/replay.js).

## 2026-09-23 — timeframe-aware navigation and deterministic rewind

Replay steps at the selected chart timeframe while retaining one-minute candles as its source and clock. Higher-timeframe buckets are displayed only after their clock-aligned closing boundary. A timeframe change pauses replay and rewinds to the latest valid stop at or before the current position so Previous and Next remain symmetric without future leakage.

References: [`replay.js`](../explorer/src/replay.js), [replay tests](../explorer/test/replay.test.js).

## 2026-09-23 — replay analyses are explicit and backward-compatible

Replay analyses store an explicit type, simulated timestamp, and source position. Existing records remain retrospective by default. Opening a replay analysis restores its date, timeframe, snapshot, selection, drawings, and structured assessment without exposing later candles. The migration does not change grants or RLS.

Reference: [replay-analysis migration](../explorer/supabase/migrations/202609230001_replay_analyses.sql).

## Date not recorded — detectors remain independent of replay UI and each other

Observers should consume the active replay's `getMarketView()` result rather than DOM, chart, drawing, or Explorer state. Each observer should be independently testable. Future confluence should compose explicit observer outputs rather than couple observer internals.

One standalone experimental false-breakout observer now follows this boundary. No detector registry, additional observer set, or composition layer exists today.

## Date not recorded — human annotations remain separate from detector events

Persisted research annotations record human interpretation and authorship. Future automated observations are a different kind of evidence and must not reuse or silently overwrite the annotation schema. A final detector-event schema will not be defined until a concrete observer demonstrates its requirements.

## Date not recorded — avoid premature strategy and backtesting infrastructure

The project will not add orders, P&L, trade simulation, or a generic detector framework before pattern definitions and observation behavior are explicit and testable. Simulation and backtesting are later, conditional increments.

## Date not recorded — drawing schema version 1 is retained

Existing drawings persist timestamp/price anchors under schema version 1. Compatibility with saved analyses takes priority over introducing a new drawing schema without a demonstrated migration need.

Reference: [`drawings.js`](../explorer/src/drawings.js).

## Date not recorded — cross-timeframe drawing display remains limited

Drawings are supported for use in the timeframe in which they were created. Cross-timeframe visual stability remains unresolved. Stored schema-version-1 anchors are retained, and the current code does not automatically hide drawings on other timeframes.

Projection-focused unit tests describe intended coordinate behavior but do not establish browser-level cross-timeframe visual stability. The [Explorer README](../explorer/README.md) therefore documents the same creation-timeframe support boundary.

## 2026-09-25 — indicator warmup is chart context, not replay market data

SMA and EMA overlays use completed closes from the active chart timeframe. EMA is deterministically seeded with the first `N`-close SMA and then uses `alpha = 2 / (N + 1)`; exact parity with Nelogica Profit is not yet claimed. Preceding available sessions may be loaded from private Storage and shown as chart context, but `getMarketView()` retains only the selected session's one-minute replay prefix. The two inputs remain separate so indicators gain warmup without expanding observer access.

References: [`moving-averages.js`](../explorer/src/moving-averages.js), [`indicator-context.js`](../explorer/src/indicator-context.js).
