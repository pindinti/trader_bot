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

No candle is created for a minute without trades. If selected records are malformed, contain unsupported update/session values, or span multiple trade dates, that input file fails without publishing a partial result. Other input files are still processed and the command exits nonzero if any file failed.

## Tests

The project uses Python's built-in test runner because `pytest` is not currently installed:

```powershell
python -m unittest discover -s tests -v
```

`HoraFechamento` is interpreted as `HHMMSSmmm`. This matches the observed data but still needs confirmation against authoritative B3 documentation. If source timestamps go backward, the summary reports the count and candle open/close are determined by timestamp with original source-row order as the tie-breaker. Trades are never deduplicated.

## Audit candles

Independently reconstruct and compare all generated candles with the filtered source trades:

```powershell
python scripts/audit_candles.py
```

The read-only audit writes an atomic JSON report to `data/audit/candle_audit_WDOV26.json`. Gaps are informational. Candle ranges and consecutive close movements of 20 points or more are warnings by default; adjust them with `--range-warning` and `--move-warning`. Integrity discrepancies cause a nonzero exit code.
