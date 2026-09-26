# Trade Bot roadmap

This roadmap favors small increments that can be inspected against historical charts and verified with deterministic tests. It assigns no calendar deadlines and does not assume that discretionary pattern names already have quantitative definitions.

## Completed foundation

### Historical-data preparation — completed

**Objective:** Produce trustworthy one-minute WDO candles from local historical trade files.

**Evidence and acceptance:** The repository contains separate filtering, candle-building, independent auditing, and fail-closed export stages, with Python tests for construction, audit, and deterministic export. See [`scripts/`](../scripts/) and [`tests/`](../tests/).

### Explorer and structured research — completed

**Objective:** Let authorized researchers inspect audited candles, draw, select movements, and preserve structured analyses without presenting them as signals.

**Evidence and acceptance:** The Explorer supports seven chart timeframes (1, 2, 5, 10, 15, 30, and 60 minutes), OHLCV inspection, optional SMA/EMA overlays for 9/21/200 completed active-timeframe closes, schema-version-1 drawings, retrospective analyses, searchable shared history with market context, JSON research export, and author-restricted changes. Prior-session indicator warmup is visible on the chart but remains outside `getMarketView()`. Focused frontend tests cover aggregation, indicators, drawings, research mapping, search, and history restoration.

### Private access and data delivery — completed

**Objective:** Keep candle objects out of the public application bundle and gate both research and candle reads by authenticated membership.

**Evidence and acceptance:** The repository contains the membership/RLS and private Storage migrations, protected initialization lifecycle, authenticated Storage loader, production-boundary tests, and a Pages build with no public data directory. Live password login, research persistence, and private candle loading were manually verified for the first account; the current project context reports a passing production smoke test.

### Deterministic replay and replay analyses — completed

**Objective:** Review historical data through a controlled completed-candle prefix and preserve the exact replay context of an analysis.

**Evidence and acceptance:** Replay provides previous/next/play/pause controls, timeframe-aware stops, deterministic rewind, higher-timeframe completion filtering, immutable `getMarketView()` output, teardown cleanup, and replay analysis restoration without later candles. The additive migration preserves existing retrospective records. Tests cover boundaries, all supported timeframes, no-future leakage, snapshot mapping, and restoration.

**Known limitation:** Drawings are supported for use in the creation timeframe. Cross-timeframe visual stability remains unresolved and is not a prerequisite for beginning detector research if observations are inspected in their source timeframe.

## Sprint 2 — first false-breakout observer (in progress)

### Sprint 2.1 — experimental same-candle observer (implemented)

**Objective:** Implement one deterministic observer for a provisional false-breakout definition without treating it as a validated trading rule.

Definition v0.1 evaluates each completed one-minute candidate candle against the preceding `N` completed one-minute candles, excluding the candidate. The initial default is `N = 20`; this is a test configuration with no claimed trading significance.

- Upper observation: the candidate high is strictly above the highest preceding high and its close is strictly below that reference.
- Lower observation: the candidate low is strictly below the lowest preceding low and its close is strictly above that reference.
- A close exactly at the reference does not qualify. A candle meeting both definitions produces two independent observations.

Confirmation is based only on the completed candidate candle. OHLC data cannot establish whether the high or low occurred first, so the observer does not infer intrabar ordering. It reads only an active replay's returned candle prefix and emits price-behavior observations, not orders or recommendations.

**Acceptance evidence:** Synthetic tests cover both directions, strict equality, insufficient history, candidate exclusion, closes beyond the reference, dual observations, deterministic repetition, future-prefix isolation, inactive replay refusal, and input immutability.

### Sprint 2.2 — local historical inspection (implemented)

**Objective:** Run definition v0.1 over explicitly selected local exported days and produce deterministic material for trader review without exposing historical data or adding Explorer UI.

[`inspect-false-breakouts.mjs`](../explorer/scripts/inspect-false-breakouts.mjs) validates the local schema-version-1 manifest and daily files, invokes the existing observer independently for each day, and writes a CSV, summary, and deterministic shortlist only under the ignored `data/research/` boundary. The shortlist prioritizes the earliest dual-direction candle, then the earliest additional example of each direction, then the earliest remaining candidates; it is not a quality or profitability ranking.

Run from the repository root with explicit local inputs:

```powershell
node explorer/scripts/inspect-false-breakouts.mjs --input-dir data/explorer_storage --output-dir data/research/false_breakout_v0_1 --contract WDOV26 --dates 2026-09-14 2026-09-15 2026-09-16 2026-09-17 2026-09-18 2026-09-21 --lookback 20
```

Generated historical reports remain local and must not be committed. Sprint 2 remains in progress because definition v0.1 still requires trader validation against the selected examples.

### Remaining Sprint 2 research (planned)

**Objective:** Validate, revise, or reject definition v0.1 with the trader before treating it as a stable research definition.

**Work:**

1. Review positive, negative, and ambiguous historical examples with the trader.
2. Decide whether the same-candle return through the level captures the intended discretionary observation.
3. Inspect emitted observations against historical charts without merging them into human annotations.
4. Refine boundary and timing semantics only from documented examples.

**Acceptance criteria:**

- The trader and developer can state the same testable definition without relying on unstated visual judgment.
- Historical examples can be reviewed with enough context to explain why each observation was or was not emitted.
- Any revision remains deterministic and retains explicit no-future-leakage tests.
- Output remains a pattern observation with no order, entry, exit, P&L, or profitability claim.

## Later increments

### Additional independent pattern observers

**Objective:** Add pullback, inside-bar, and doji observers one at a time after each definition is agreed with the trader.

**Acceptance criteria:** Each observer has an explicit definition, independent implementation, deterministic positive/negative fixtures, no-future-leakage tests, and inspectable historical output. No observer depends on another observer's internal state.

### Observation-event contract

**Objective:** Standardize the smallest shared event shape only after at least one concrete observer demonstrates the required fields.

**Acceptance criteria:** The contract distinguishes pattern identity, observation time, supporting candle references, detector/version identity, and optional explanatory evidence without encoding orders. It is versioned, validated, and does not replace the human research schema.

### Explicit confluence and composition

**Objective:** Combine independent observation events through documented rules rather than hidden coupling between detectors.

**Acceptance criteria:** Composition inputs and temporal rules are explicit; the same input events produce the same result; individual observer results remain inspectable; and tests cover conflicting, missing, and differently timed observations. Composition still emits research observations, not trades.

### Compare detections with manual analyses

**Objective:** Create a research workflow for comparing automated observations with the trader's existing structured analyses.

**Acceptance criteria:** Comparisons preserve authorship and original records, distinguish disagreement from missing data, and allow false positives, false negatives, and ambiguous cases to be reviewed without silently relabeling either source.

### Define trade hypotheses, if warranted

**Objective:** Decide whether accumulated observation evidence is sufficient to specify entries, exits, invalidation, sizing assumptions, and evaluation criteria.

**Acceptance criteria:** Any proposed trading rule is explicit and testable; unresolved discretionary terms are identified; and no simulation begins while material entry/exit semantics remain implicit.

### Transaction costs and simulated trades, if warranted

**Objective:** Model trades only after the strategy hypothesis and evaluation assumptions are explicit.

**Acceptance criteria:** Costs, slippage assumptions, session constraints, and position accounting are documented and tested. Simulated execution remains clearly separated from live execution.

### Backtesting, if warranted

**Objective:** Evaluate a fixed, versioned strategy hypothesis across data not used to invent it.

**Acceptance criteria:** The test separates development and evaluation data, reports limitations and sensitivity, prevents future leakage, and makes no profitability claim beyond the evidence. Brokerage integration and live trading remain separate decisions.

## Open research questions

- Does provisional same-candle definition v0.1 match the trader's intended false-breakout observation, and what revisions do historical examples support?
- Which conditions invalidate an observation, and when is the observation timestamped?
- Should observer inspection first use chart overlays, a separate event list, or both?
- What minimal event fields are demonstrated by the first observer rather than guessed in advance?
- How should automated observations be compared with manual analyses without treating either as ground truth?
- What broader historical sample is needed before evaluating generalization?
