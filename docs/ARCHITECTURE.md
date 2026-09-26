# Trade Bot architecture

## Current system

The implemented system has two distinct paths: an offline data-preparation path and an authenticated browser research path.

```text
B3 historical trade files
  -> local WDO filtering
  -> one-minute candle construction
  -> independent candle audit
  -> audited JSON export and manifest
  -> manual administrative upload
  -> private Supabase Storage
  -> authorized Explorer session
  -> chart, drawings, analyses, and replay
```

### 1. Local historical-data pipeline

Historical B3 files remain local under ignored `data/` directories.

- [`scripts/filter_wdo.py`](../scripts/filter_wdo.py) selects WDO instrument rows from raw files.
- [`scripts/build_candles.py`](../scripts/build_candles.py) validates selected WDOV26 trades and builds chronological one-minute OHLCV candles. Minutes without trades are not synthesized.
- [`scripts/audit_candles.py`](../scripts/audit_candles.py) independently reconstructs expected candles from filtered trades and writes a PASS/FAIL audit report.
- [`scripts/export_explorer.py`](../scripts/export_explorer.py) accepts an explicit contract and date list, requires a compatible overall and per-day audit PASS, validates each candle file again, and atomically writes compact JSON where practical.

The exporter creates a schema-version-1 `manifest.json` and daily objects at paths such as `WDOV26/2026-09-21.json`. The manifest declares a one-minute source timeframe and identifies available dates, object paths, and candle counts. Raw trades, filtered trades, candle CSVs, and audit reports are not browser inputs.

Exported objects are staged in ignored `data/explorer_storage/` and uploaded manually, with daily objects uploaded before the manifest. Detailed update commands remain in [the Explorer README](../explorer/README.md).

### 2. Private data and authorization boundary

Supabase is the runtime boundary for protected data:

- Supabase Auth handles email/password sign-in, recovery, persisted sessions, and token refresh.
- `public.research_members` is the explicit authorization allowlist.
- `public.research_annotations` stores shared structured analyses and embedded drawing JSON.
- The private `trade-bot-candles` Storage bucket holds the manifest and daily candle objects.

The [research migration](../explorer/supabase/migrations/202609220001_research_annotations.sql) enables RLS: members may read shared analyses, create records as themselves, and update or delete only their own records. Anonymous table access is revoked. The [Storage migration](../explorer/supabase/migrations/202609220002_private_candle_storage.sql) grants authenticated object reads only when `public.is_research_member()` succeeds and creates no client write policy.

The browser uses only the Supabase project URL and browser-safe publishable key. It contains no service-role key and does not use public or signed candle URLs. Authorization still depends on the live Supabase configuration and on the absence of unrelated permissive policies.

### 3. Protected Explorer lifecycle

The frontend is a Vite/vanilla JavaScript application using TradingView Lightweight Charts. [`explorer/src/auth-lifecycle.js`](../explorer/src/auth-lifecycle.js) separates unauthenticated, authorizing, initializing, authorized, unauthorized, and recovery states. The chart, private-data loader, drawing tools, history, and replay are mounted only after authentication and membership authorization. Sign-out, session changes, or stale asynchronous initialization unmount and clear the protected application.

After authorization, [`explorer/src/candle-storage.js`](../explorer/src/candle-storage.js) downloads private JSON through the authenticated Storage client. [`explorer/src/data.js`](../explorer/src/data.js) validates the manifest and day payload before chart use. [`explorer/src/aggregate.js`](../explorer/src/aggregate.js) derives the 2, 5, 10, 15, 30, and 60-minute views from the one-minute source, aligns buckets to wall-clock interval boundaries, preserves volume and trade totals, and does not synthesize missing minutes.

Optional SMA and EMA overlays use 9, 21, or 200 completed closes from the active chart timeframe. EMA is seeded with the SMA of its first `N` values and then uses `alpha = 2 / (N + 1)`. The authenticated daily cache loads preceding available manifest sessions, newest first, until the largest enabled period has enough prior completed bars or history is exhausted. Those prior candles are visible chart context; they are never inserted into replay's detector-facing market view. Exact parity with Nelogica Profit's EMA implementation remains unverified.

### 4. Drawings and analyses

Drawings are embedded in their parent analysis using drawing schema version 1. Horizontal lines, trend lines, rectangles, and Fibonacci drawings store timestamp/price anchors rather than pixels. The current compatibility boundary retains that schema for existing records.

The accepted display limitation is important: drawings are supported for use in the timeframe in which they were created. Cross-timeframe visual stability remains unresolved. The code does not automatically hide drawings when another timeframe is selected.

A new analysis requires a selected movement and at least one drawing. Analyses also store contract, date, timeframe, cutoff, human pattern classification, direction, market context, factors, assessment, candidate rule, and research status. Existing records default to retrospective. The additive [replay-analysis migration](../explorer/supabase/migrations/202609230001_replay_analyses.sql) distinguishes replay analyses with a simulated timestamp and source position while preserving the original authorization rules.

The history is independent of drawing creation. An authorized member can open any readable record; restoration loads its date, timeframe, selection, drawings, and form data. Replay records additionally restore the saved replay snapshot and exclude later candles. History entries display the persisted market context and can be filtered client-side with case-insensitive, accent-insensitive substring search over loaded record text without changing stored rows or their ordering.

### 5. Replay and market-data boundary

[`explorer/src/replay.js`](../explorer/src/replay.js) owns simulated time and an immutable copy of the audited one-minute source. Its detector-facing read-only interface is:

```js
getMarketView() -> {
  active,
  simulatedTimestamp,
  candles
}
```

While replay is active, `candles` is a frozen copy of the one-minute prefix through `simulatedTimestamp`; future source candles are not returned. While replay is inactive, the current implementation returns a copy of the full loaded day and `simulatedTimestamp` is `null`. Any replay observer, including the experimental false-breakout adapter, must therefore require `active === true` and consume only this returned prefix, not chart state or the Explorer's full source array.

Manual navigation and playback share the same timeframe-aware stops. At one minute, each source candle is a stop. At higher timeframes, stops correspond to clock-aligned completed bucket boundaries. Switching timeframe pauses replay and deterministically rewinds to the latest stop at or before the current position. A remaining partial higher-timeframe bucket is neither displayed as complete nor offered as a replay step. Missing one-minute records are not fabricated.

Indicator warmup has a separate input: completed prior-session chart context plus the visible completed selected-session prefix. `getMarketView()` continues to expose only the selected session, so warmup cannot change detector inputs and future selected-day candles cannot affect replay indicator values.

Replay contains no intrabar state. Each source item is already a completed one-minute candle. Drawings and analyses are not included in `getMarketView()` and therefore are not market-data inputs.

### 6. Experimental false-breakout observer

[`explorer/src/false-breakout-observer.js`](../explorer/src/false-breakout-observer.js) is a standalone experimental consumer of completed one-minute candle prefixes. Its pure function evaluates provisional same-candle definition v0.1; a small adapter requires `active === true` and rejects a market view containing candles after `simulatedTimestamp`. The module has no DOM, chart, drawing, Supabase, annotation, or replay-controller dependency and is not mounted in the Explorer UI.

Its output is deliberately local to this experiment. It is not a project-wide event contract, trading signal, or persisted record.

### 7. Build and deployment

Production builds use the `/trader_bot/` Vite base and disable Vite public-directory copying. The build verification rejects a generated `dist/data` boundary. [The GitHub Pages workflow](../.github/workflows/deploy-pages.yml) installs dependencies, runs frontend tests, builds `explorer/dist/`, and deploys it with the official Pages actions. Browser-safe Supabase values are supplied as repository variables.

The static bundle contains application code, not the private candle manifest or daily objects. A frontend login alone would not protect static files; privacy is provided by keeping candle objects out of the bundle and enforcing authenticated membership at Storage.

## Proposed detector architecture

Only the first experimental observer exists. Standardized events, additional independent observers, composition, and trade simulation remain proposed:

```text
active replay getMarketView() prefix
  -> experimental false-breakout observer (implemented)
  -> additional independent pattern observers (proposed)
  -> standardized observation events
  -> explicit confluence/composition
  -> possible later trade simulation
```

Each pattern observer should be deterministic, independently testable, and dependent only on the completed one-minute prefix and simulated timestamp. It should emit observations rather than orders or trading recommendations. Observers should not depend on each other's internal state; later composition should consume their outputs explicitly.

Human research annotations remain separate from detector events. They may later be compared, but neither should silently overwrite or become the other. No final event schema is defined yet; the first concrete observer should establish the minimum fields needed for inspection and deterministic tests before a reusable contract is standardized.

Trade entry/exit rules, transaction costs, simulated positions, and backtesting are intentionally outside the current architecture.

## Boundaries and constraints

- Local `data/` directories are ignored and must not enter Git or the Pages artifact.
- Only audited, explicitly selected one-minute exports may reach private Storage.
- Storage uploads are administrative; the frontend has read access only.
- Membership, annotation ownership, and Storage reads are enforced by Supabase RLS/policies, not by hidden UI alone.
- Replay observers must not read future candles, drawings, selected movements, or saved analyses through the market-data interface.
- Chart timestamps represent exchange-local wall-clock values projected into Unix seconds for display consistency; they are not a claim about feed timezone semantics.
- B3-derived historical-data redistribution terms still require independent verification.
