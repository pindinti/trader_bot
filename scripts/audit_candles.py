"""Independently audit one-minute WDO candles against filtered B3 trades."""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any


BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE_DIR = BASE_DIR / "data" / "wdo"
DEFAULT_CANDLE_DIR = BASE_DIR / "data" / "candles" / "1min"
DEFAULT_REPORT_DIR = BASE_DIR / "data" / "audit"

SOURCE_COLUMNS = {
    "DataReferencia",
    "CodigoInstrumento",
    "AcaoAtualizacao",
    "PrecoNegocio",
    "QuantidadeNegociada",
    "HoraFechamento",
    "CodigoIdentificadorNegocio",
    "TipoSessaoPregao",
    "DataNegocio",
    "TipoDoCanal",
}
CANDLE_COLUMNS = {"datetime", "contract", "open", "high", "low", "close", "volume", "trades"}
SOURCE_TIME_RE = re.compile(r"^\d{9}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
OUTPUT_TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")
CONTRACT_RE = re.compile(r"^[A-Z0-9]+$")
SOURCE_PRICE_RE = re.compile(r"^\d+(?:,\d+)?$")
OUTPUT_PRICE_RE = re.compile(r"^\d+(?:\.\d+)?$")
INTEGER_RE = re.compile(r"^\d+$")
MAX_DIAGNOSTICS = 20


def decimal_text(value: Decimal) -> str:
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def parse_iso_date(value: str, field: str) -> date:
    text = (value or "").strip()
    if not DATE_RE.fullmatch(text):
        raise ValueError(f"{field} must use YYYY-MM-DD, got {text!r}")
    try:
        return date.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(f"invalid {field} {text!r}") from exc


def parse_source_time(value: str, trading_date: date) -> datetime:
    text = (value or "").strip()
    if not SOURCE_TIME_RE.fullmatch(text):
        raise ValueError(f"HoraFechamento must use HHMMSSmmm, got {text!r}")
    try:
        return datetime(
            trading_date.year,
            trading_date.month,
            trading_date.day,
            int(text[:2]),
            int(text[2:4]),
            int(text[4:6]),
            int(text[6:]) * 1_000,
        )
    except ValueError as exc:
        raise ValueError(f"invalid HoraFechamento {text!r}") from exc


def parse_decimal(value: str, field: str, source_format: bool) -> Decimal:
    text = (value or "").strip()
    pattern = SOURCE_PRICE_RE if source_format else OUTPUT_PRICE_RE
    if not pattern.fullmatch(text):
        expected = "decimal-comma" if source_format else "decimal-point"
        raise ValueError(f"invalid {expected} {field} {text!r}")
    try:
        number = Decimal(text.replace(",", "."))
    except InvalidOperation as exc:
        raise ValueError(f"invalid {field} {text!r}") from exc
    if not number.is_finite() or number <= 0:
        raise ValueError(f"{field} must be positive and finite, got {text!r}")
    return number


def parse_positive_int(value: str, field: str) -> int:
    text = (value or "").strip()
    if not INTEGER_RE.fullmatch(text):
        raise ValueError(f"invalid {field} {text!r}")
    number = int(text)
    if number <= 0:
        raise ValueError(f"{field} must be positive, got {text!r}")
    return number


def parse_identity_number(value: str, field: str) -> str:
    text = (value or "").strip()
    if not text.isascii() or not INTEGER_RE.fullmatch(text) or int(text) <= 0:
        raise ValueError(f"{field} must be a positive integer, got {text!r}")
    return str(int(text))


def empty_result(source_path: Path, contract: str) -> dict[str, Any]:
    return {
        "date": None,
        "contract": contract,
        "source_file": str(source_path),
        "candle_file": None,
        "status": "FAIL",
        "source_selected_row_count": 0,
        "source_new_trade_count": 0,
        "source_cancelled_trade_count": 0,
        "source_trade_count": 0,
        "source_quantity_sum": 0,
        "expected_candle_count": 0,
        "actual_candle_count": 0,
        "field_mismatch_count": 0,
        "missing_candle_count": 0,
        "extra_candle_count": 0,
        "duplicate_candle_count": 0,
        "out_of_order_candle_count": 0,
        "source_out_of_order_count": 0,
        "source_first_timestamp": None,
        "source_last_timestamp": None,
        "candle_first_timestamp": None,
        "candle_last_timestamp": None,
        "source_quantity_matches": False,
        "source_trade_count_matches": False,
        "ohlc_invariant_error_count": 0,
        "gaps": [],
        "warnings": [],
        "errors": [],
        "mismatches": [],
        "diagnostic_samples": [],
        "ordering_assumption": (
            "final active New trades after identity-scoped cancellations; "
            "original New timestamp, then original source row number"
        ),
    }


def add_limited(items: list[Any], item: Any) -> None:
    if len(items) < MAX_DIAGNOSTICS:
        items.append(item)


def read_expected(source_path: Path, contract: str, result: dict[str, Any]) -> dict[datetime, dict[str, Any]]:
    expected: dict[datetime, dict[str, Any]] = {}
    trade_dates: set[date] = set()
    previous_time: datetime | None = None
    active: dict[tuple[date, str, str, str, str], dict[str, Any]] = {}
    seen_new: set[tuple[date, str, str, str, str]] = set()
    cancelled: set[tuple[date, str, str, str, str]] = set()

    try:
        source = source_path.open("r", encoding="utf-8-sig", newline="")
    except OSError as exc:
        result["errors"].append(f"{source_path.name}: {exc}")
        return expected

    with source:
        reader = csv.DictReader(source, delimiter=";")
        missing = sorted(SOURCE_COLUMNS - set(reader.fieldnames or ()))
        if missing:
            result["errors"].append(f"{source_path.name}: missing source columns: {', '.join(missing)}")
            return expected

        for line_number, row in enumerate(reader, 2):
            instrument = (row.get("CodigoInstrumento") or "").strip().upper()
            if instrument != contract:
                continue
            result["source_selected_row_count"] += 1
            row_errors: list[str] = []
            action = (row.get("AcaoAtualizacao") or "").strip()
            if action not in {"0", "2"}:
                row_errors.append(
                    f"unsupported AcaoAtualizacao {row.get('AcaoAtualizacao')!r}; expected '0' or '2'"
                )
            session = (row.get("TipoSessaoPregao") or "").strip()
            if session != "1":
                row_errors.append(f"unsupported TipoSessaoPregao {row.get('TipoSessaoPregao')!r}")

            trade_identifier = channel = None
            try:
                trade_identifier = parse_identity_number(
                    row.get("CodigoIdentificadorNegocio"), "CodigoIdentificadorNegocio"
                )
            except ValueError as exc:
                row_errors.append(str(exc))
            try:
                channel = parse_identity_number(row.get("TipoDoCanal"), "TipoDoCanal")
            except ValueError as exc:
                row_errors.append(str(exc))

            reference_date = trading_date = timestamp = price = quantity = None
            try:
                reference_date = parse_iso_date(row.get("DataReferencia"), "DataReferencia")
            except ValueError as exc:
                row_errors.append(str(exc))
            try:
                trading_date = parse_iso_date(row.get("DataNegocio"), "DataNegocio")
            except ValueError as exc:
                row_errors.append(str(exc))
            if reference_date is not None and trading_date is not None and reference_date != trading_date:
                row_errors.append("DataReferencia differs from DataNegocio")
            if trading_date is not None:
                try:
                    timestamp = parse_source_time(row.get("HoraFechamento"), trading_date)
                except ValueError as exc:
                    row_errors.append(str(exc))
            try:
                price = parse_decimal(row.get("PrecoNegocio"), "PrecoNegocio", True)
            except ValueError as exc:
                row_errors.append(str(exc))
            try:
                quantity = parse_positive_int(row.get("QuantidadeNegociada"), "QuantidadeNegociada")
            except ValueError as exc:
                row_errors.append(str(exc))

            if row_errors:
                add_limited(result["errors"], f"{source_path.name}:{line_number}: {'; '.join(row_errors)}")
                continue

            assert (
                action in {"0", "2"}
                and trading_date is not None
                and timestamp is not None
                and price is not None
                and quantity is not None
                and trade_identifier is not None
                and channel is not None
            )
            trade_dates.add(trading_date)
            if previous_time is not None and timestamp < previous_time:
                result["source_out_of_order_count"] += 1
            previous_time = timestamp

            identity = (trading_date, instrument, session, channel, trade_identifier)
            if action == "0":
                result["source_new_trade_count"] += 1
                if identity in seen_new:
                    add_limited(
                        result["errors"],
                        f"{source_path.name}:{line_number}: duplicate New trade identity "
                        f"{trade_identifier!r} within date/instrument/session/channel scope",
                    )
                    continue
                seen_new.add(identity)
                active[identity] = {
                    "timestamp": timestamp,
                    "line_number": line_number,
                    "price": price,
                    "quantity": quantity,
                }
                continue

            if identity in cancelled:
                add_limited(
                    result["errors"],
                    f"{source_path.name}:{line_number}: duplicate Delete for trade identity "
                    f"{trade_identifier!r}",
                )
                continue
            original = active.get(identity)
            if original is None:
                add_limited(
                    result["errors"],
                    f"{source_path.name}:{line_number}: unmatched Delete (or Delete before New) "
                    f"for trade identity {trade_identifier!r}",
                )
                continue
            delete_errors: list[str] = []
            if timestamp < original["timestamp"]:
                delete_errors.append("Delete timestamp precedes the original New timestamp")
            if price != original["price"]:
                delete_errors.append(
                    f"Delete price {decimal_text(price)} differs from New price "
                    f"{decimal_text(original['price'])}"
                )
            if quantity != original["quantity"]:
                delete_errors.append(
                    f"Delete quantity {quantity} differs from New quantity {original['quantity']}"
                )
            if delete_errors:
                add_limited(
                    result["errors"],
                    f"{source_path.name}:{line_number}: {'; '.join(delete_errors)}",
                )
                continue
            del active[identity]
            cancelled.add(identity)
            result["source_cancelled_trade_count"] += 1

    active_rows = list(active.values())
    result["source_trade_count"] = len(active_rows)
    result["source_quantity_sum"] = sum(row["quantity"] for row in active_rows)
    if active_rows:
        result["source_first_timestamp"] = min(row["timestamp"] for row in active_rows)
        result["source_last_timestamp"] = max(row["timestamp"] for row in active_rows)

    for trade in active_rows:
        timestamp = trade["timestamp"]
        price = trade["price"]
        quantity = trade["quantity"]
        line_number = trade["line_number"]
        minute = timestamp.replace(second=0, microsecond=0)
        order_key = (timestamp, line_number)
        candle = expected.get(minute)
        if candle is None:
            expected[minute] = {
                "timestamp": minute,
                "contract": contract,
                "open": price,
                "high": price,
                "low": price,
                "close": price,
                "volume": quantity,
                "trades": 1,
                "first_key": order_key,
                "last_key": order_key,
            }
        else:
            if order_key < candle["first_key"]:
                candle["first_key"] = order_key
                candle["open"] = price
            if order_key > candle["last_key"]:
                candle["last_key"] = order_key
                candle["close"] = price
            candle["high"] = max(candle["high"], price)
            candle["low"] = min(candle["low"], price)
            candle["volume"] += quantity
            candle["trades"] += 1

    if len(trade_dates) != 1:
        rendered = ", ".join(sorted(item.isoformat() for item in trade_dates)) or "none"
        result["errors"].append(f"expected exactly one selected trade date, found: {rendered}")
    else:
        trading_date = next(iter(trade_dates))
        result["date"] = trading_date.isoformat()
    result["expected_candle_count"] = len(expected)
    return expected


def parse_output_time(value: str) -> datetime:
    text = (value or "").strip()
    if not OUTPUT_TIME_RE.fullmatch(text):
        raise ValueError(f"datetime must use YYYY-MM-DD HH:MM:SS, got {text!r}")
    try:
        parsed = datetime.strptime(text, "%Y-%m-%d %H:%M:%S")
    except ValueError as exc:
        raise ValueError(f"invalid datetime {text!r}") from exc
    if parsed.second != 0:
        raise ValueError(f"candle datetime is not minute-aligned: {text!r}")
    return parsed


def read_actual(candle_path: Path, result: dict[str, Any]) -> dict[datetime, list[dict[str, Any]]]:
    actual: dict[datetime, list[dict[str, Any]]] = {}
    previous_time: datetime | None = None
    try:
        source = candle_path.open("r", encoding="utf-8-sig", newline="")
    except OSError as exc:
        result["errors"].append(f"{candle_path.name}: {exc}")
        return actual

    with source:
        reader = csv.DictReader(source)
        missing = sorted(CANDLE_COLUMNS - set(reader.fieldnames or ()))
        if missing:
            result["errors"].append(f"{candle_path.name}: missing candle columns: {', '.join(missing)}")
            return actual
        for line_number, row in enumerate(reader, 2):
            result["actual_candle_count"] += 1
            try:
                timestamp = parse_output_time(row.get("datetime"))
                parsed = {
                    "timestamp": timestamp,
                    "contract": (row.get("contract") or "").strip(),
                    "open": parse_decimal(row.get("open"), "open", False),
                    "high": parse_decimal(row.get("high"), "high", False),
                    "low": parse_decimal(row.get("low"), "low", False),
                    "close": parse_decimal(row.get("close"), "close", False),
                    "volume": parse_positive_int(row.get("volume"), "volume"),
                    "trades": parse_positive_int(row.get("trades"), "trades"),
                }
            except ValueError as exc:
                add_limited(result["errors"], f"{candle_path.name}:{line_number}: {exc}")
                continue

            if previous_time is not None and timestamp < previous_time:
                result["out_of_order_candle_count"] += 1
            previous_time = timestamp
            if result["candle_first_timestamp"] is None:
                result["candle_first_timestamp"] = timestamp
            result["candle_last_timestamp"] = timestamp
            actual.setdefault(timestamp, []).append(parsed)

            if not (
                parsed["high"] >= parsed["open"]
                and parsed["high"] >= parsed["close"]
                and parsed["high"] >= parsed["low"]
                and parsed["low"] <= parsed["open"]
                and parsed["low"] <= parsed["close"]
            ):
                result["ohlc_invariant_error_count"] += 1
                add_limited(result["errors"], f"{candle_path.name}:{line_number}: OHLC invariant violation")

    result["duplicate_candle_count"] = sum(len(rows) - 1 for rows in actual.values() if len(rows) > 1)
    return actual


def public_candle(candle: dict[str, Any] | None) -> dict[str, Any] | None:
    if candle is None:
        return None
    return {
        "datetime": candle["timestamp"].strftime("%Y-%m-%d %H:%M:%S"),
        "contract": candle["contract"],
        "open": decimal_text(candle["open"]),
        "high": decimal_text(candle["high"]),
        "low": decimal_text(candle["low"]),
        "close": decimal_text(candle["close"]),
        "volume": candle["volume"],
        "trades": candle["trades"],
    }


def select_sample_minutes(expected: dict[datetime, dict[str, Any]]) -> list[tuple[str, datetime]]:
    minutes = sorted(expected)
    if not minutes:
        return []
    candidates = [
        ("first", minutes[0]),
        ("last", minutes[-1]),
        ("highest_volume", max(minutes, key=lambda item: (expected[item]["volume"], -minutes.index(item)))),
        ("largest_range", max(minutes, key=lambda item: (expected[item]["high"] - expected[item]["low"], -minutes.index(item)))),
        ("intermediate_25pct", minutes[(len(minutes) - 1) // 4]),
        ("intermediate_50pct", minutes[(len(minutes) - 1) // 2]),
        ("intermediate_75pct", minutes[((len(minutes) - 1) * 3) // 4]),
    ]
    return candidates


def compare(
    expected: dict[datetime, dict[str, Any]],
    actual: dict[datetime, list[dict[str, Any]]],
    result: dict[str, Any],
    range_warning: Decimal,
    move_warning: Decimal,
) -> None:
    expected_times = set(expected)
    actual_times = set(actual)
    missing = sorted(expected_times - actual_times)
    extra = sorted(actual_times - expected_times)
    result["missing_candle_count"] = len(missing)
    result["extra_candle_count"] = len(extra)
    for timestamp in missing:
        add_limited(result["mismatches"], {"minute": str(timestamp), "field": "candle", "expected": "present", "actual": "missing"})
    for timestamp in extra:
        add_limited(result["mismatches"], {"minute": str(timestamp), "field": "candle", "expected": "absent", "actual": "extra"})

    fields = ("contract", "open", "high", "low", "close", "volume", "trades")
    for timestamp in sorted(expected_times & actual_times):
        if len(actual[timestamp]) != 1:
            continue
        expected_row = expected[timestamp]
        actual_row = actual[timestamp][0]
        for field in fields:
            if expected_row[field] != actual_row[field]:
                result["field_mismatch_count"] += 1
                add_limited(
                    result["mismatches"],
                    {
                        "minute": str(timestamp),
                        "field": field,
                        "expected": decimal_text(expected_row[field]) if isinstance(expected_row[field], Decimal) else expected_row[field],
                        "actual": decimal_text(actual_row[field]) if isinstance(actual_row[field], Decimal) else actual_row[field],
                    },
                )

    actual_rows = [rows[0] for timestamp, rows in actual.items() if len(rows) == 1]
    result["source_trade_count_matches"] = sum(row["trades"] for row in actual_rows) == result["source_trade_count"]
    result["source_quantity_matches"] = sum(row["volume"] for row in actual_rows) == result["source_quantity_sum"]

    sorted_times = sorted(actual)
    for earlier, later in zip(sorted_times, sorted_times[1:]):
        missing_minutes = int((later - earlier) / timedelta(minutes=1)) - 1
        if missing_minutes > 0:
            result["gaps"].append(
                {"after": str(earlier), "before": str(later), "missing_minutes": missing_minutes}
            )

    previous_close: Decimal | None = None
    for timestamp in sorted(expected):
        candle = expected[timestamp]
        candle_range = candle["high"] - candle["low"]
        if candle_range >= range_warning:
            result["warnings"].append(
                f"large range at {timestamp}: {decimal_text(candle_range)} >= {decimal_text(range_warning)}"
            )
        if previous_close is not None:
            movement = abs(candle["close"] - previous_close)
            if movement >= move_warning:
                result["warnings"].append(
                    f"large close movement at {timestamp}: {decimal_text(movement)} >= {decimal_text(move_warning)}"
                )
        previous_close = candle["close"]

    for label, timestamp in select_sample_minutes(expected):
        rows = actual.get(timestamp, [])
        actual_row = rows[0] if len(rows) == 1 else None
        result["diagnostic_samples"].append(
            {
                "label": label,
                "minute": str(timestamp),
                "source_derived": public_candle(expected[timestamp]),
                "output": public_candle(actual_row),
                "match": actual_row is not None and all(expected[timestamp][field] == actual_row[field] for field in fields),
            }
        )


def audit_file(
    source_path: Path,
    candle_dir: Path,
    contract: str = "WDOV26",
    range_warning: Decimal = Decimal("20"),
    move_warning: Decimal = Decimal("20"),
) -> dict[str, Any]:
    contract = contract.strip().upper()
    if not CONTRACT_RE.fullmatch(contract):
        raise ValueError("contract must contain only ASCII letters and digits")
    result = empty_result(source_path, contract)
    expected = read_expected(source_path, contract, result)
    if result["date"] is None:
        return serialize_result(result)

    candle_path = candle_dir / f"{result['date']}_{contract}_1min.csv"
    result["candle_file"] = str(candle_path)
    actual = read_actual(candle_path, result)
    compare(expected, actual, result, range_warning, move_warning)

    integrity_failures = (
        len(result["errors"])
        + result["field_mismatch_count"]
        + result["missing_candle_count"]
        + result["extra_candle_count"]
        + result["duplicate_candle_count"]
        + result["out_of_order_candle_count"]
        + result["ohlc_invariant_error_count"]
        + (not result["source_trade_count_matches"])
        + (not result["source_quantity_matches"])
    )
    result["status"] = "PASS" if integrity_failures == 0 else "FAIL"
    return serialize_result(result)


def serialize_result(result: dict[str, Any]) -> dict[str, Any]:
    serialized = dict(result)
    for key in (
        "source_first_timestamp",
        "source_last_timestamp",
        "candle_first_timestamp",
        "candle_last_timestamp",
    ):
        value = serialized[key]
        serialized[key] = value.isoformat(sep=" ", timespec="milliseconds") if isinstance(value, datetime) else value
    return serialized


def write_report(report_path: Path, report: dict[str, Any]) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = report_path.parent / f".{report_path.name}.{uuid.uuid4().hex}.tmp"
    try:
        with temp_path.open("w", encoding="utf-8", newline="\n") as target:
            json.dump(report, target, indent=2, ensure_ascii=False)
            target.write("\n")
        temp_path.replace(report_path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def print_result(result: dict[str, Any]) -> None:
    print(f"\n[{result['status']}] {result['date'] or Path(result['source_file']).name}")
    print(
        f"  Source rows/new/cancelled/active: {result['source_selected_row_count']:,} / "
        f"{result['source_new_trade_count']:,} / {result['source_cancelled_trade_count']:,} / "
        f"{result['source_trade_count']:,}"
    )
    print(
        f"  Source trades/quantity: {result['source_trade_count']:,} / {result['source_quantity_sum']:,} | "
        f"Candles expected/actual: {result['expected_candle_count']:,} / {result['actual_candle_count']:,}"
    )
    print(
        f"  Field mismatches: {result['field_mismatch_count']:,} | "
        f"Missing/extra: {result['missing_candle_count']:,}/{result['extra_candle_count']:,} | "
        f"Duplicate/out-of-order: {result['duplicate_candle_count']:,}/{result['out_of_order_candle_count']:,}"
    )
    print(f"  Source first/last: {result['source_first_timestamp']} / {result['source_last_timestamp']}")
    print(f"  Candle first/last: {result['candle_first_timestamp']} / {result['candle_last_timestamp']}")
    print(f"  Gaps: {len(result['gaps']):,} | Warnings: {len(result['warnings']):,}")
    for error in result["errors"][:3]:
        print(f"  ERROR: {error}")
    for mismatch in result["mismatches"][:3]:
        print(f"  MISMATCH: {mismatch}")
    print("  Diagnostic samples (source-derived == output):")
    for sample in result["diagnostic_samples"]:
        print(f"    {sample['label']}: {sample['minute']} -> {sample['match']}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", default="WDOV26")
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_SOURCE_DIR)
    parser.add_argument("--candle-dir", type=Path, default=DEFAULT_CANDLE_DIR)
    parser.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR)
    parser.add_argument("--range-warning", type=Decimal, default=Decimal("20"), metavar="POINTS")
    parser.add_argument("--move-warning", type=Decimal, default=Decimal("20"), metavar="POINTS")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    contract = args.contract.strip().upper()
    if not CONTRACT_RE.fullmatch(contract):
        print("error: contract must contain only ASCII letters and digits", file=sys.stderr)
        return 2
    if args.range_warning <= 0 or args.move_warning <= 0:
        print("error: warning thresholds must be positive", file=sys.stderr)
        return 2
    source_files = sorted(args.source_dir.glob("*_WDO.csv"))
    if not source_files:
        print(f"No *_WDO.csv files found in {args.source_dir}", file=sys.stderr)
        return 1

    results = []
    for source_path in source_files:
        result = audit_file(source_path, args.candle_dir, contract, args.range_warning, args.move_warning)
        results.append(result)
        print_result(result)

    overall_status = "PASS" if all(item["status"] == "PASS" for item in results) else "FAIL"
    report = {
        "overall_status": overall_status,
        "contract": contract,
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "warning_thresholds": {
            "candle_range_points": decimal_text(args.range_warning),
            "close_movement_points": decimal_text(args.move_warning),
        },
        "results": results,
    }
    report_path = args.report_dir / f"candle_audit_{contract}.json"
    try:
        write_report(report_path, report)
    except OSError as exc:
        print(f"Could not write audit report: {exc}", file=sys.stderr)
        return 1
    print(f"\nOverall: {overall_status}")
    print(f"Report: {report_path}")
    return 0 if overall_status == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
