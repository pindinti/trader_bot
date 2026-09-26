# Trade Bot project

## Purpose

Trade Bot is a private research environment for two intended users: a trader and a development partner. Its current purpose is to study historical B3 WDO data, preserve discretionary observations in a structured form, and turn only sufficiently clear observations into testable automation hypotheses.

The project separates three activities:

1. Produce and independently audit historical candle data.
2. Review that data visually and record human analyses.
3. Implement deterministic observers for explicit research hypotheses, then validate their definitions before broader automation.

An observation, annotation, or candidate rule is not evidence of a profitable strategy.

## Current access model

The Explorer is a static Vite application deployed through GitHub Pages. Supabase supplies email/password authentication, session restoration, an explicit `research_members` allowlist, private candle-object delivery, and persisted shared analyses.

Authentication alone is insufficient. The protected Explorer is initialized only after membership authorization succeeds. Authorized members can read shared analyses; an analysis can be changed or deleted only by its author. The intended group currently has two researchers, although membership remains an explicit administrative database operation rather than a hard-coded user count.

See [the Explorer README](../explorer/README.md) and [the research migration](../explorer/supabase/migrations/202609220001_research_annotations.sql) for operational details.

## Implemented and verified

The repository currently provides:

- A local Python pipeline that filters WDO trades, builds one-minute OHLCV candles, independently audits them, and exports only explicitly selected dates that have a passing audit.
- A compact manifest plus one JSON object per contract and trading day, staged locally for manual upload to private Supabase Storage.
- An authenticated Explorer with one-, two-, five-, ten-, fifteen-, thirty-, and sixty-minute views derived from audited one-minute candles.
- Optional SMA and EMA overlays for 9, 21, and 200 completed active-timeframe closes, with private prior-session warmup kept separate from replay market data.
- Interactive chart navigation, OHLCV inspection, a visible 10:30–15:00 research window, movement selection, and schema-version-1 drawings.
- Structured retrospective and replay analyses, searchable shared history with market context, author-restricted editing/deletion, and JSON export of research records.
- Deterministic replay over completed one-minute candles, timeframe-aware stepping, pause/play controls, replay snapshots, and restoration without later candles.
- An experimental standalone same-candle false-breakout observer (definition v0.1) with synthetic deterministic tests and no chart or persistence integration.
- A GitHub Pages build and deployment workflow that excludes local historical-data directories and retrieves candles from private Storage at runtime.

Automated coverage exists for the pipeline, authentication lifecycle, private Storage boundary, aggregation, indicators, drawings, analyses, replay behavior, migrations, and production-data exclusion. The production smoke test is reported as passed.

## Human research and future automation

Pattern labels such as false breakout, pullback, inside bar, and doji remain human classifications when stored with an analysis. Drawings, selected movements, assessments, and candidate rules remain human research material. The separate experimental false-breakout observer does not alter or validate those annotations.

The next research step is to validate, revise, or reject provisional false-breakout definition v0.1 with the trader. The implemented observer reads only the market history available at an active replay timestamp and emits inspectable observations, not orders or recommendations. Additional observers, composition, trade simulation, and backtesting come later only if the evidence and definitions justify them.

## Scope and non-goals

The current scope is historical research on the available audited WDO dataset. It does not include:

- a live market feed or intrabar reconstruction;
- brokerage integration, order entry, or automated trading;
- simulated positions, margin, P&L, or transaction-cost modeling;
- a validated strategy, performance result, or profitability claim;
- a validated detector suite or confluence logic.

Historical B3-derived data must not be placed in the Git repository or production bundle. Any redistribution remains subject to verification of the applicable licensing and redistribution terms.

## Known limitations and open questions

- Replay advances across completed one-minute records. It does not reveal trade-by-trade evolution inside a candle.
- Explorer EMA values use an explicit SMA seed followed by `2 / (N + 1)` smoothing; exact byte-for-byte parity with Nelogica Profit remains to be validated visually.
- The available dataset is a small, explicitly selected historical sample. It is not evidence that a proposed rule generalizes.
- Drawings use timestamp/price anchors and retain schema version 1. They are supported for use in the timeframe in which they were created; cross-timeframe visual stability remains unresolved.
- The repository contains unit and boundary tests, but live Supabase policy behavior also depends on the deployed project configuration.
- False-breakout definition v0.1 is explicit but provisional and has not been validated with the trader; the other named patterns do not yet have agreed quantitative definitions.
- The shape and versioning policy for future detector observations remain open and should follow evidence from concrete observer use rather than precede it.
