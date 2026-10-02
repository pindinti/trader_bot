# Trade Bot

Trade Bot is a historical trading-research environment for studying and formalizing discretionary WDO trading methods from B3 trade-by-trade data. The current workflow:

1. reconstructs auditable one-minute WDO market data;
2. provides an authenticated, private Explorer for historical observation; and
3. stores structured analyses that may later support precise, testable strategy definitions.

It is not a live trading bot, broker-connected system, automated execution engine, validated production strategy, or production backtesting engine. The current phase is deliberately observational and formalization-oriented.

> The trader describes the method. We structure it afterwards.

For deeper detail, see [Project](docs/PROJECT.md), [Architecture](docs/ARCHITECTURE.md), [Decisions](docs/DECISIONS.md), and the [Explorer guide](explorer/README.md).

## Project status

Currently implemented:

- local ingestion and filtering of B3 WDO trade-by-trade files;
- cancellation-aware reconstruction of final active trades;
- one-minute OHLCV candles with exact per-minute trade notional;
- independent candle reconstruction and audit;
- schema-version-2 private Explorer exports;
- Supabase email/password authentication, explicit membership authorization, and private Storage delivery;
- 1m, 2m, 5m, 10m, 15m, 30m, and 60m chart views;
- SMA and EMA overlays for 9, 21, and 200 completed candles;
- exact session VWAP;
- automatic previous-available-session chart context and additional older-session indicator warmup;
- deterministic candle replay without future-data leakage;
- movement selection and timestamp/price drawings: horizontal lines, trend lines, arrows, Fibonacci, and price zones;
- persisted drawing colors, line widths, stable IDs, and analysis-linked highlighting;
- structured retrospective and replay analyses, shared history, restoration, editing, and author-restricted deletion; and
- an experimental standalone false-breakout observer, kept separate from the Explorer workflow and not treated as a validated strategy.

## Data pipeline

Filtered source files stay local under `data/wdo/`. The builder processes each `*_WDO.csv` independently and never uses raw or filtered trade files in the browser.

### Build candles

From the repository root:

```powershell
python scripts/build_candles.py
```

The default contract is `WDOV26`. Select another contract explicitly with:

```powershell
python scripts/build_candles.py --contract WDOX26
```

By default, the builder reads `data/wdo/*_WDO.csv` and atomically writes one file per successful trading date to `data/candles/1min/YYYY-MM-DD_CONTRACT_1min.csv`. A failed input is not partially published; other input files are still processed, and the command exits nonzero if any file fails.

Final candle columns are:

```text
datetime,contract,open,high,low,close,volume,notional,trades
```

`notional` is the sum of `trade price × trade quantity` over the final active trades in that minute. It allows exact session VWAP reconstruction rather than an OHLC approximation. Minutes with no final active trades are not synthesized.

### B3 trade cancellations

The builder resolves update actions using this scoped trade identity:

```text
(
  DataNegocio,
  CodigoInstrumento,
  TipoSessaoPregao,
  TipoDoCanal,
  CodigoIdentificadorNegocio
)
```

Supported actions are:

- `0` — New trade;
- `2` — Delete / cancellation.

A Delete must match an earlier active New with the same scoped identity, price, and quantity. Its timestamp must not precede the New. The cancelled New is removed before OHLC, volume, notional, and trade-count aggregation. The Delete timestamp represents the cancellation event and is not used to place the trade in a candle.

Processing fails closed for unmatched or before-New Deletes, duplicate Deletes, duplicate New identities, inconsistent price or quantity, unsupported action or session values, malformed selected rows, missing required columns, and multiple selected trading dates in one source file. Duplicate New identities are rejected rather than leaving multiple possible cancellation matches.

### Timestamp handling

`HoraFechamento` is interpreted as `HHMMSSmmm`. This matches the observed source files but is not yet recorded in this repository as an authoritative B3 specification.

Final active New trades are ordered by their parsed timestamp. Original source-row order breaks timestamp ties, so the earliest key determines candle open and the latest key determines candle close. Out-of-order source transitions are reported without replacing this deterministic ordering rule.

## Independent candle audit

Run the independent auditor from the repository root:

```powershell
python scripts/audit_candles.py
```

It reads `data/wdo/` and `data/candles/1min/` by default and atomically writes `data/audit/candle_audit_WDOV26.json`. Use `--contract` for another contract.

The auditor independently parses the filtered source, resolves New/Delete events, and reconstructs final active trades and expected candles. It reports selected source rows, New events, successful cancellations, and final active trades. It compares the generated output for:

- candle timestamps and OHLC values;
- volume, trade count, and exact notional totals;
- duplicates, ordering, missing/extra candles, and OHLC invariants.

Gaps are informational. Candle ranges and consecutive close movements of 20 points or more are warnings by default; `--range-warning` and `--move-warning` adjust those thresholds. Integrity failures produce `FAIL` and a nonzero exit code.

An audit `PASS` means the generated candles faithfully represent the selected filtered source under the documented reconstruction rules. It does not establish that a session is suitable for research. Liquidity, contract dominance, rollover, and session completeness still require separate judgment.

### Pipeline tests

The Python tests use the standard-library runner:

```powershell
python -m unittest discover -s tests -v
```

## Explorer dataset

The exporter accepts only an explicit contract and date list and refuses missing, stale, incompatible, or non-passing audits:

```powershell
python scripts/export_explorer.py --contract WDOV26 --dates 2026-09-22 2026-09-23
```

The default ignored staging layout is:

```text
data/explorer_storage/
├── manifest.json
└── WDOV26/
    ├── 2026-09-22.json
    └── 2026-09-23.json
```

The manifest and daily files use `schemaVersion: 2` and a one-minute source timeframe. Each compact daily row follows:

```text
datetime,open,high,low,close,volume,notional,trades
```

The exporter requires both overall and per-day audit `PASS`, then revalidates chronology, uniqueness, numeric values, OHLC invariants, counts, totals, and audit freshness before writing. Daily JSON and the manifest are written atomically where practical.

These objects are private research data. They are uploaded administratively to the private `trade-bot-candles` Supabase Storage bucket; the frontend has read access only. See the [Explorer guide](explorer/README.md#update-audited-private-candle-data) for the reviewed manual upload procedure. Do not place historical data under `explorer/public/` or redistribute B3-derived data without verifying applicable terms.

## Historical Explorer

The frontend is a Vite/vanilla JavaScript application under `explorer/`, using TradingView Lightweight Charts. Run it locally with:

```powershell
cd explorer
npm ci
npm run dev
```

Supabase Auth restores email/password sessions. The full Explorer is initialized only after the authenticated account is found in `research_members`. Candle objects are then downloaded from private Storage through the authenticated client; no public or signed candle URL and no service-role key is used.

Frontend validation commands are:

```powershell
cd explorer
npm test
npm run build
```

The production build includes a private-data exclusion check.

### Session context

Opening a trading date automatically loads exactly one immediately previous **available manifest session** for the same contract as baseline visual context. It does not assume the previous calendar day. For example:

```text
2026-09-23 -> 2026-09-22
2026-09-08 -> 2026-09-04  (when no intervening session exists in the manifest)
```

If the selected date is the first available session, the Explorer continues with the active session only.

```text
baseline chart context = active session + one previous available session
indicator warmup       = baseline context + older available sessions as required
```

Previous-session candles are visual and indicator context only. They never enter replay's detector-facing active-session market view. Candle numbering resets per session, candle references include `DD/MM HH:mm`, and the first displayed tick of each session uses `DD/MM HH:mm`; ordinary intraday ticks use `HH:mm`.

## Indicators

Supported overlays are:

- SMA 9, SMA 21, and SMA 200;
- EMA 9, EMA 21, and EMA 200;
- session VWAP.

Moving averages use completed closes from the active chart timeframe. SMA begins after `N` values. EMA is seeded with the first `N`-close SMA and then applies `2 / (N + 1)` smoothing. The authenticated day cache walks backward through available manifest sessions when the baseline session does not provide enough warmup bars.

VWAP is exact: cumulative cancellation-resolved trade notional divided by cumulative volume. It resets at each session. During replay it advances only with the completed active-session prefix. Legacy schema-version-1 candle objects remain readable, but VWAP is unavailable because those objects do not contain exact notional.

## Replay

Replay owns simulated time and an immutable copy of the selected day's audited one-minute candles. Manual stepping and playback advance through completed boundaries of the selected chart timeframe. Higher-timeframe views contain only complete clock-aligned buckets; missing minutes and intrabar paths are not fabricated.

The chart may display earlier sessions for context, but detector-facing replay data remains:

```js
getMarketView() -> {
  active,
  simulatedTimestamp,
  candles // completed one-minute prefix of the selected active session only
}
```

Future active-session candles, previous-session context, drawings, movements, and saved analyses do not enter this interface. Replay is candle replay, not tick replay, and makes no claim about intrabar event order.

## Drawings

Drawing schema version 1 stores stable IDs and timestamp/price anchors rather than screen pixels. Supported drawing types are:

- horizontal line;
- trend line;
- arrow;
- Fibonacci;
- rectangle / price zone.

Per-drawing line width and a curated color are persisted in the existing drawing JSON. Legacy drawings without those properties receive compatible defaults. Fibonacci drawings also persist their level array. Edit handles appear only in Edit mode; analysis-linked highlighting is temporary and does not mutate the saved color, width, identity, or geometry.

Drawings are supported for use in the timeframe in which they were created. Cross-timeframe visual stability remains unresolved.

## Research analyses

The analysis workflow records what the trader observed; it does not prematurely encode an executable strategy. Creating a new analysis requires a selected movement and at least one drawing. Current structured content includes:

- contract, date, timeframe, movement interval, and analysis cutoff;
- retrospective or replay analysis context;
- observed structure/setup, optional detail, direction, and free-form description;
- market context and explanation;
- confluences/factors, their roles, and linked drawing references;
- descriptive trigger, entry/order, stop, and target;
- trader assessment, explanation, missing confirmation, and invalidation conditions; and
- complete drawing JSON.

New assessments use the UI vocabulary **Trade feito**, **Trade não feito**, **Considerar operação**, and **Descartar**. Historical assessment and research-status values remain readable for compatibility, while new writes keep `research_status = 'observation'` as internal metadata.

Authorized members can read shared analyses. Records can be reopened with their date, timeframe, movement, drawings, and form data; replay records also restore their saved simulated timestamp without exposing later candles. Only the author can edit or delete a record. History search is client-side over already authorized records.

## Research philosophy

> The trader describes the method. We structure it afterwards.

The project treats the following as research layers, not as a completed trading model:

1. context / regime;
2. structure / location;
3. necessary conditions;
4. supporting confluences;
5. trigger;
6. execution;
7. dynamic invalidation / management.

Candlestick labels, Fibonacci levels, moving averages, VWAP, drawings, and observed outcomes are evidence to inspect and formalize. They are not independently the strategy, and the trading method has not been validated.

## Scope boundaries

Implemented today: audited historical-data reconstruction, private authenticated exploration, completed-candle indicators and replay, chart annotations, structured human analyses, shared history, and one isolated experimental observer.

Not implemented:

- live market feeds;
- broker integration or order execution;
- automated trading;
- production risk management;
- complete contract-rollover automation;
- a validated trading strategy or profitability claim;
- a production backtesting engine.

Historical data remains local or in private Storage and is excluded from Git and the production frontend bundle.
