# Trade Bot roadmap

This roadmap favors small increments that can be inspected against historical charts and verified with deterministic tests. It assigns no calendar deadlines and does not assume that discretionary pattern names already have quantitative definitions.

## Completed foundation

### Historical-data preparation — completed

**Objective:** Produce trustworthy one-minute WDO candles from local historical trade files.

**Evidence and acceptance:** The repository contains separate filtering, candle-building, independent auditing, and fail-closed export stages, with Python tests for construction, audit, and deterministic export. See [`scripts/`](../scripts/) and [`tests/`](../tests/).

### Explorer and structured research — completed

**Objective:** Let authorized researchers inspect audited candles, draw, select movements, and preserve structured analyses without presenting them as signals.

**Evidence and acceptance:** The Explorer supports six chart timeframes, OHLCV inspection, schema-version-1 drawings, retrospective analyses, shared history, JSON research export, and author-restricted changes. Focused frontend tests cover aggregation, drawings, research mapping, and history restoration.

### Private access and data delivery — completed

**Objective:** Keep candle objects out of the public application bundle and gate both research and candle reads by authenticated membership.

**Evidence and acceptance:** The repository contains the membership/RLS and private Storage migrations, protected initialization lifecycle, authenticated Storage loader, production-boundary tests, and a Pages build with no public data directory. Live password login, research persistence, and private candle loading were manually verified for the first account; the current project context reports a passing production smoke test.

### Deterministic replay and replay analyses — completed

**Objective:** Review historical data through a controlled completed-candle prefix and preserve the exact replay context of an analysis.

**Evidence and acceptance:** Replay provides previous/next/play/pause controls, timeframe-aware stops, deterministic rewind, higher-timeframe completion filtering, immutable `getMarketView()` output, teardown cleanup, and replay analysis restoration without later candles. The additive migration preserves existing retrospective records. Tests cover boundaries, all supported timeframes, no-future leakage, snapshot mapping, and restoration.

**Known limitation:** Drawings are supported for use in the creation timeframe. Cross-timeframe visual stability remains unresolved and is not a prerequisite for beginning detector research if observations are inspected in their source timeframe.

## Next increment: Sprint 2 — first false-breakout observer

**Objective:** Turn the trader's false-breakout concept into one explicit, testable historical observation rule and implement it as an independent replay observer.

**Work:**

1. Review positive, negative, and ambiguous historical examples with the trader.
2. Write a quantitative definition, including required inputs, timing, boundary conditions, and cases that must not qualify.
3. Implement one standalone detector that reads only an active replay's completed one-minute prefix and simulated timestamp.
4. Emit inspectable observations, not orders, position advice, or trading recommendations.
5. Display or otherwise inspect those observations against historical charts without merging them into human annotations.
6. Add deterministic fixtures for qualifying and non-qualifying cases, boundary behavior, repeatability, and future-data isolation.

**Acceptance criteria:**

- The trader and developer can state the same testable definition without relying on unstated visual judgment.
- The observer has no access to candles after `simulatedTimestamp` and does not read chart drawings or persisted analyses as market data.
- Replaying the same candle prefix produces the same observations.
- Tests prove that appending future candles cannot change observations emitted for an earlier prefix.
- Historical examples can be reviewed with enough context to explain why each observation was or was not emitted.
- Output is clearly labeled as a pattern observation, with no order, entry, exit, P&L, or profitability claim.

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

- What exact candle sequence and confirmation conditions define a false breakout?
- Which conditions invalidate an observation, and when is the observation timestamped?
- Should observer inspection first use chart overlays, a separate event list, or both?
- What minimal event fields are demonstrated by the first observer rather than guessed in advance?
- How should automated observations be compared with manual analyses without treating either as ground truth?
- What broader historical sample is needed before evaluating generalization?
