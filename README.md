# Trade Bot data preparation

This phase converts filtered B3 WDO trade-by-trade files into one-minute candles. It does not implement strategies, backtesting, rollover, or live trading.

## Build candles

From the repository root, run:

```powershell
python scripts/build_candles.py
```

The command reads each `data/wdo/*_WDO.csv` file separately, selects `WDOV26`, and atomically writes one CSV per trade date to `data/candles/1min/`. Choose another contract with `--contract`, for example:

```powershell
python scripts/build_candles.py --contract WDOX26
```

Before aggregation, the builder resolves B3 update actions by the scoped trade identity `(DataNegocio, CodigoInstrumento, TipoSessaoPregao, TipoDoCanal, CodigoIdentificadorNegocio)`. Action `0` creates an active trade and action `2` cancels its uniquely matched earlier New trade; price and quantity must also match. Unmatched, duplicate, ambiguous, or inconsistent cancellations fail without publishing output. The Delete timestamp is the cancellation-event time and is never used for candle placement.

No candle is created for a minute without final active trades. If selected records are malformed, contain unsupported update/session values, or span multiple trade dates, that input file fails without publishing a partial result. Other input files are still processed and the command exits nonzero if any file failed. Summaries report New events, successfully cancelled trades, and final active trades separately; `ProcessingSummary.accepted_trades` remains a compatibility alias for the final active-trade count.

## Tests

The project uses Python's built-in test runner because `pytest` is not currently installed:

```powershell
python -m unittest discover -s tests -v
```

`HoraFechamento` is interpreted as `HHMMSSmmm`. This matches the observed data but still needs confirmation against authoritative B3 documentation. If source timestamps go backward, the summary reports the count and candle open/close are determined by the active New trade's timestamp with its original source-row order as the tie-breaker. Duplicate New identities fail closed rather than being silently deduplicated.

## Audit candles

Independently reconstruct and compare all generated candles with the filtered source trades:

```powershell
python scripts/audit_candles.py
```

The read-only audit writes an atomic JSON report to `data/audit/candle_audit_WDOV26.json`. It independently resolves cancellations and reports selected rows, valid New events, successful cancellations, and the final active count; the existing `source_trade_count` field means final active trades. Gaps are informational. Candle ranges and consecutive close movements of 20 points or more are warnings by default; adjust them with `--range-warning` and `--move-warning`. Integrity discrepancies cause a nonzero exit code.
