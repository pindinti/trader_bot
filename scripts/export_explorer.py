"""Export explicitly selected, audited candles for Trade Bot Explorer."""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import uuid
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any


BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_CANDLE_DIR = BASE_DIR / "data" / "candles" / "1min"
DEFAULT_AUDIT_DIR = BASE_DIR / "data" / "audit"
DEFAULT_STORAGE_DATA_DIR = BASE_DIR / "data" / "explorer_storage"

EXPECTED_COLUMNS = ("datetime", "contract", "open", "high", "low", "close", "volume", "trades")
PRICE_FIELDS = ("open", "high", "low", "close")
CONTRACT_RE = re.compile(r"^[A-Z0-9]+$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$")
DECIMAL_RE = re.compile(r"^\d+(?:\.\d+)?$")
INTEGER_RE = re.compile(r"^\d+$")
SCHEMA_VERSION = 1


class ExportError(ValueError):
    """Raised when audited data is not safe to export."""


@dataclass(frozen=True)
class ValidatedDay:
    trading_date: str
    source_path: Path
    rows: list[list[Any]]
    volume: int
    trades: int


def canonical_decimal(value: Decimal) -> str:
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def parse_date(value: str) -> str:
    text = value.strip()
    if not DATE_RE.fullmatch(text):
        raise ExportError(f"date must use YYYY-MM-DD: {value!r}")
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError as exc:
        raise ExportError(f"invalid date: {value!r}") from exc


def parse_price(value: str, field: str, location: str) -> Decimal:
    text = (value or "").strip()
    if not DECIMAL_RE.fullmatch(text):
        raise ExportError(f"{location}: invalid decimal-point {field} {text!r}")
    try:
        number = Decimal(text)
    except InvalidOperation as exc:
        raise ExportError(f"{location}: invalid {field} {text!r}") from exc
    if not number.is_finite() or number <= 0:
        raise ExportError(f"{location}: {field} must be positive and finite")
    return number


def parse_positive_int(value: str, field: str, location: str) -> int:
    text = (value or "").strip()
    if not INTEGER_RE.fullmatch(text) or int(text) <= 0:
        raise ExportError(f"{location}: {field} must be a positive integer, got {text!r}")
    return int(text)


def load_audit(audit_path: Path, contract: str) -> dict[str, dict[str, Any]]:
    try:
        report = json.loads(audit_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ExportError(f"cannot read compatible audit report {audit_path}: {exc}") from exc

    required_top = {"overall_status", "contract", "generated_at", "results"}
    if not isinstance(report, dict) or not required_top.issubset(report):
        raise ExportError("audit report has an incompatible top-level schema")
    if report["overall_status"] != "PASS" or report["contract"] != contract:
        raise ExportError(f"audit report does not establish overall PASS for {contract}")
    if not isinstance(report["results"], list):
        raise ExportError("audit report results must be a list")

    required_result = {
        "date", "contract", "candle_file", "status", "source_trade_count",
        "source_quantity_sum", "expected_candle_count", "actual_candle_count",
        "field_mismatch_count", "missing_candle_count", "extra_candle_count",
        "duplicate_candle_count", "out_of_order_candle_count",
        "source_quantity_matches", "source_trade_count_matches",
        "ohlc_invariant_error_count", "errors", "mismatches",
    }
    by_date: dict[str, dict[str, Any]] = {}
    for item in report["results"]:
        if not isinstance(item, dict) or not required_result.issubset(item):
            raise ExportError("audit report contains an incompatible result record")
        item_date = item["date"]
        if not isinstance(item_date, str) or item_date in by_date:
            raise ExportError("audit report contains an invalid or duplicated date")
        by_date[item_date] = item
    return by_date


def require_passing_audit(
    record: dict[str, Any], contract: str, trading_date: str, candle_path: Path, audit_path: Path
) -> None:
    if record["contract"] != contract or record["status"] != "PASS":
        raise ExportError(f"audit does not establish PASS for {contract} on {trading_date}")
    if Path(record["candle_file"]).name != candle_path.name:
        raise ExportError(f"audit candle reference does not match {candle_path.name}")

    zero_checks = (
        "field_mismatch_count", "missing_candle_count", "extra_candle_count",
        "duplicate_candle_count", "out_of_order_candle_count", "ohlc_invariant_error_count",
    )
    if any(type(record[key]) is not int or record[key] != 0 for key in zero_checks):
        raise ExportError(f"audit contains integrity failures for {trading_date}")
    positive_counts = ("source_trade_count", "source_quantity_sum", "expected_candle_count", "actual_candle_count")
    if any(type(record[key]) is not int or record[key] <= 0 for key in positive_counts):
        raise ExportError(f"audit contains invalid counts for {trading_date}")
    if record["expected_candle_count"] != record["actual_candle_count"]:
        raise ExportError(f"audit candle counts differ for {trading_date}")
    if record["source_quantity_matches"] is not True or record["source_trade_count_matches"] is not True:
        raise ExportError(f"audit aggregate totals do not match for {trading_date}")
    if record["errors"] != [] or record["mismatches"] != []:
        raise ExportError(f"audit diagnostics are not clean for {trading_date}")
    try:
        if audit_path.stat().st_mtime_ns < candle_path.stat().st_mtime_ns:
            raise ExportError(f"audit report predates {candle_path.name}; rerun the audit")
    except OSError as exc:
        raise ExportError(f"cannot verify audit freshness for {candle_path.name}: {exc}") from exc


def validate_candle_file(
    candle_path: Path, contract: str, trading_date: str, audit_record: dict[str, Any]
) -> ValidatedDay:
    rows: list[list[Any]] = []
    total_volume = 0
    total_trades = 0
    previous: datetime | None = None

    try:
        source = candle_path.open("r", encoding="utf-8-sig", newline="")
    except OSError as exc:
        raise ExportError(f"cannot read candle file {candle_path}: {exc}") from exc
    with source:
        reader = csv.DictReader(source)
        if tuple(reader.fieldnames or ()) != EXPECTED_COLUMNS:
            raise ExportError(f"{candle_path.name}: expected columns {EXPECTED_COLUMNS!r}")
        for line_number, row in enumerate(reader, 2):
            location = f"{candle_path.name}:{line_number}"
            timestamp_text = (row["datetime"] or "").strip()
            if not DATETIME_RE.fullmatch(timestamp_text):
                raise ExportError(f"{location}: invalid minute timestamp {timestamp_text!r}")
            try:
                timestamp = datetime.strptime(timestamp_text, "%Y-%m-%d %H:%M:%S")
            except ValueError as exc:
                raise ExportError(f"{location}: invalid datetime {timestamp_text!r}") from exc
            if timestamp.date().isoformat() != trading_date:
                raise ExportError(f"{location}: timestamp is outside requested date {trading_date}")
            if previous is not None and timestamp <= previous:
                problem = "duplicate" if timestamp == previous else "out-of-order"
                raise ExportError(f"{location}: {problem} timestamp {timestamp_text}")
            previous = timestamp
            if (row["contract"] or "").strip() != contract:
                raise ExportError(f"{location}: unexpected contract {row['contract']!r}")

            prices = {field: parse_price(row[field], field, location) for field in PRICE_FIELDS}
            if not (
                prices["high"] >= prices["open"]
                and prices["high"] >= prices["close"]
                and prices["high"] >= prices["low"]
                and prices["low"] <= prices["open"]
                and prices["low"] <= prices["close"]
            ):
                raise ExportError(f"{location}: OHLC invariant violation")
            volume = parse_positive_int(row["volume"], "volume", location)
            trades = parse_positive_int(row["trades"], "trades", location)
            total_volume += volume
            total_trades += trades
            rows.append([
                timestamp.strftime("%Y-%m-%d %H:%M:%S"),
                canonical_decimal(prices["open"]),
                canonical_decimal(prices["high"]),
                canonical_decimal(prices["low"]),
                canonical_decimal(prices["close"]),
                volume,
                trades,
            ])

    if not rows:
        raise ExportError(f"{candle_path.name}: no candles")
    if len(rows) != audit_record["actual_candle_count"]:
        raise ExportError(f"{candle_path.name}: candle count no longer matches audit")
    if total_volume != audit_record["source_quantity_sum"]:
        raise ExportError(f"{candle_path.name}: volume no longer matches audit")
    if total_trades != audit_record["source_trade_count"]:
        raise ExportError(f"{candle_path.name}: trade count no longer matches audit")
    return ValidatedDay(trading_date, candle_path, rows, total_volume, total_trades)


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    try:
        with temp_path.open("w", encoding="utf-8", newline="\n") as target:
            json.dump(value, target, ensure_ascii=False, separators=(",", ":"))
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        temp_path.replace(path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def export_dataset(
    contract: str,
    dates: list[str],
    candle_dir: Path = DEFAULT_CANDLE_DIR,
    audit_path: Path | None = None,
    storage_data_dir: Path = DEFAULT_STORAGE_DATA_DIR,
) -> dict[str, Any]:
    contract = contract.strip().upper()
    if not CONTRACT_RE.fullmatch(contract):
        raise ExportError("contract must contain only ASCII letters and digits")
    selected_dates = sorted({parse_date(item) for item in dates})
    if not selected_dates:
        raise ExportError("at least one date must be selected explicitly")
    audit_path = audit_path or DEFAULT_AUDIT_DIR / f"candle_audit_{contract}.json"
    audit_by_date = load_audit(audit_path, contract)

    validated: list[ValidatedDay] = []
    for trading_date in selected_dates:
        record = audit_by_date.get(trading_date)
        if record is None:
            raise ExportError(f"audit report has no result for {trading_date}")
        candle_path = candle_dir / f"{trading_date}_{contract}_1min.csv"
        require_passing_audit(record, contract, trading_date, candle_path, audit_path)
        validated.append(validate_candle_file(candle_path, contract, trading_date, record))

    manifest_days = []
    contract_dir = storage_data_dir / contract
    for day in validated:
        payload = {
            "schemaVersion": SCHEMA_VERSION,
            "contract": contract,
            "date": day.trading_date,
            "sourceTimeframeMinutes": 1,
            "columns": ["datetime", "open", "high", "low", "close", "volume", "trades"],
            "candles": day.rows,
        }
        filename = f"{day.trading_date}.json"
        atomic_json(contract_dir / filename, payload)
        manifest_days.append({
            "date": day.trading_date,
            "file": f"{contract}/{filename}",
            "candles": len(day.rows),
            "volume": day.volume,
            "trades": day.trades,
        })

    selected_files = {f"{day.trading_date}.json" for day in validated}
    if contract_dir.exists():
        for stale in contract_dir.glob("*.json"):
            if stale.name not in selected_files:
                stale.unlink()

    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "sourceTimeframeMinutes": 1,
        "contracts": [{"symbol": contract, "dates": manifest_days}],
    }
    atomic_json(storage_data_dir / "manifest.json", manifest)
    return manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", required=True, help="explicit contract to export")
    parser.add_argument("--dates", required=True, nargs="+", help="explicit YYYY-MM-DD dates")
    parser.add_argument("--candle-dir", type=Path, default=DEFAULT_CANDLE_DIR)
    parser.add_argument("--audit-report", type=Path)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_STORAGE_DATA_DIR)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        manifest = export_dataset(
            args.contract,
            args.dates,
            candle_dir=args.candle_dir,
            audit_path=args.audit_report,
            storage_data_dir=args.output_dir,
        )
    except ExportError as exc:
        print(f"Export refused: {exc}", file=sys.stderr)
        return 1
    selected = manifest["contracts"][0]
    print(f"Exported {selected['symbol']}:")
    for item in selected["dates"]:
        print(f"  {item['date']}: {item['candles']:,} candles")
    print(f"Manifest: {args.output_dir / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
