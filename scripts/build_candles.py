"""Build one-minute OHLCV candles from filtered B3 WDO trade files."""

from __future__ import annotations

import argparse
import csv
import re
import sys
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_INPUT_DIR = BASE_DIR / "data" / "wdo"
DEFAULT_OUTPUT_DIR = BASE_DIR / "data" / "candles" / "1min"

REQUIRED_COLUMNS = {
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
TIMESTAMP_PATTERN = re.compile(r"^\d{9}$")
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CONTRACT_PATTERN = re.compile(r"^[A-Z0-9]+$")
MAX_REPORTED_ERRORS = 20

TradeIdentity = tuple[date, str, str, str, str]


@dataclass(frozen=True)
class ActiveTrade:
    identity: TradeIdentity
    timestamp: datetime
    row_number: int
    price: Decimal
    quantity: int
    trade_date: date


@dataclass
class Candle:
    timestamp: datetime
    contract: str
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: int
    trades: int
    first_key: tuple[datetime, int]
    last_key: tuple[datetime, int]

    def add(self, timestamp: datetime, row_number: int, price: Decimal, quantity: int) -> None:
        order_key = (timestamp, row_number)
        if order_key < self.first_key:
            self.first_key = order_key
            self.open = price
        if order_key > self.last_key:
            self.last_key = order_key
            self.close = price
        self.high = max(self.high, price)
        self.low = min(self.low, price)
        self.volume += quantity
        self.trades += 1


@dataclass
class ProcessingSummary:
    input_path: Path
    contract: str
    input_rows: int = 0
    selected_rows: int = 0
    new_trade_count: int = 0
    cancelled_trade_count: int = 0
    active_trade_count: int = 0
    # Compatibility alias: accepted trades means final active New trades.
    accepted_trades: int = 0
    candle_count: int = 0
    first_timestamp: datetime | None = None
    last_timestamp: datetime | None = None
    out_of_order_count: int = 0
    trade_dates: set[date] = field(default_factory=set)
    validation_error_count: int = 0
    validation_errors: list[str] = field(default_factory=list)
    output_path: Path | None = None

    def add_error(self, row_number: int | None, message: str) -> None:
        self.validation_error_count += 1
        if len(self.validation_errors) < MAX_REPORTED_ERRORS:
            location = self.input_path.name
            if row_number is not None:
                location += f":{row_number}"
            self.validation_errors.append(f"{location}: {message}")


class FileProcessingError(Exception):
    """Raised when a file fails validation and must not be published."""

    def __init__(self, summary: ProcessingSummary):
        self.summary = summary
        super().__init__(
            f"{summary.input_path.name}: {summary.validation_error_count} validation error(s)"
        )


def parse_date(value: str, field_name: str) -> date:
    text = (value or "").strip()
    if not DATE_PATTERN.fullmatch(text):
        raise ValueError(f"{field_name} must use YYYY-MM-DD, got {text!r}")
    try:
        return date.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(f"invalid {field_name} {text!r}") from exc


def parse_timestamp(value: str, trade_date: date) -> datetime:
    text = (value or "").strip()
    if not TIMESTAMP_PATTERN.fullmatch(text):
        raise ValueError(f"HoraFechamento must use HHMMSSmmm, got {text!r}")
    try:
        return datetime(
            trade_date.year,
            trade_date.month,
            trade_date.day,
            int(text[0:2]),
            int(text[2:4]),
            int(text[4:6]),
            int(text[6:9]) * 1_000,
        )
    except ValueError as exc:
        raise ValueError(f"invalid HoraFechamento {text!r}") from exc


def parse_price(value: str) -> Decimal:
    text = (value or "").strip()
    if not text or "." in text or text.count(",") > 1:
        raise ValueError(f"invalid decimal-comma PrecoNegocio {text!r}")
    try:
        price = Decimal(text.replace(",", "."))
    except InvalidOperation as exc:
        raise ValueError(f"invalid PrecoNegocio {text!r}") from exc
    if not price.is_finite() or price <= 0:
        raise ValueError(f"PrecoNegocio must be positive and finite, got {text!r}")
    return price


def parse_quantity(value: str) -> int:
    text = (value or "").strip()
    try:
        quantity = int(text)
    except ValueError as exc:
        raise ValueError(f"invalid QuantidadeNegociada {text!r}") from exc
    if quantity <= 0:
        raise ValueError(f"QuantidadeNegociada must be positive, got {text!r}")
    return quantity


def decimal_text(value: Decimal) -> str:
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def _parse_positive_identifier(value: str, field_name: str) -> str:
    text = (value or "").strip()
    if not text.isascii() or not text.isdigit() or int(text) <= 0:
        raise ValueError(f"{field_name} must be a positive integer, got {text!r}")
    return str(int(text))


def _validate_selected_row(
    row: dict[str, str], row_number: int
) -> tuple[str, TradeIdentity, datetime, Decimal, int, date]:
    errors: list[str] = []

    action = (row["AcaoAtualizacao"] or "").strip()
    if action not in {"0", "2"}:
        errors.append(
            f"unsupported AcaoAtualizacao {row['AcaoAtualizacao']!r}; only '0' and '2' are accepted"
        )

    instrument = (row["CodigoInstrumento"] or "").strip().upper()
    if not CONTRACT_PATTERN.fullmatch(instrument):
        errors.append(f"invalid CodigoInstrumento {row['CodigoInstrumento']!r}")

    session = (row["TipoSessaoPregao"] or "").strip()
    if session != "1":
        errors.append(f"unsupported TipoSessaoPregao {row['TipoSessaoPregao']!r}; only '1' is accepted")

    trade_identifier = channel = None
    try:
        trade_identifier = _parse_positive_identifier(
            row["CodigoIdentificadorNegocio"], "CodigoIdentificadorNegocio"
        )
    except ValueError as exc:
        errors.append(str(exc))
    try:
        channel = _parse_positive_identifier(row["TipoDoCanal"], "TipoDoCanal")
    except ValueError as exc:
        errors.append(str(exc))

    reference_date = trade_date = None
    timestamp = price = quantity = None
    for parser, value, label in (
        (parse_date, row["DataReferencia"], "DataReferencia"),
        (parse_date, row["DataNegocio"], "DataNegocio"),
    ):
        try:
            parsed = parser(value, label)
            if label == "DataReferencia":
                reference_date = parsed
            else:
                trade_date = parsed
        except ValueError as exc:
            errors.append(str(exc))

    if reference_date is not None and trade_date is not None and reference_date != trade_date:
        errors.append(
            f"DataReferencia {reference_date.isoformat()} differs from DataNegocio {trade_date.isoformat()}"
        )

    if trade_date is not None:
        try:
            timestamp = parse_timestamp(row["HoraFechamento"], trade_date)
        except ValueError as exc:
            errors.append(str(exc))
    else:
        errors.append("HoraFechamento cannot be combined with an invalid DataNegocio")

    try:
        price = parse_price(row["PrecoNegocio"])
    except ValueError as exc:
        errors.append(str(exc))
    try:
        quantity = parse_quantity(row["QuantidadeNegociada"])
    except ValueError as exc:
        errors.append(str(exc))

    if errors:
        raise ValueError("; ".join(errors))
    assert (
        action in {"0", "2"}
        and trade_identifier is not None
        and channel is not None
        and timestamp is not None
        and price is not None
        and quantity is not None
        and trade_date is not None
    )
    identity = (trade_date, instrument, session, channel, trade_identifier)
    return action, identity, timestamp, price, quantity, trade_date


def _aggregate_active_trades(
    active_trades: dict[TradeIdentity, ActiveTrade], contract: str
) -> dict[datetime, Candle]:
    candles: dict[datetime, Candle] = {}
    for trade in active_trades.values():
        minute = trade.timestamp.replace(second=0, microsecond=0)
        order_key = (trade.timestamp, trade.row_number)
        candle = candles.get(minute)
        if candle is None:
            candles[minute] = Candle(
                timestamp=minute,
                contract=contract,
                open=trade.price,
                high=trade.price,
                low=trade.price,
                close=trade.price,
                volume=trade.quantity,
                trades=1,
                first_key=order_key,
                last_key=order_key,
            )
        else:
            candle.add(trade.timestamp, trade.row_number, trade.price, trade.quantity)
    return candles


def _write_candles(output_path: Path, candles: dict[datetime, Candle]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = output_path.parent / f".{output_path.name}.{uuid.uuid4().hex}.tmp"
    try:
        with temp_path.open("w", encoding="utf-8", newline="") as target:
            writer = csv.writer(target, lineterminator="\n")
            writer.writerow(("datetime", "contract", "open", "high", "low", "close", "volume", "trades"))
            for minute in sorted(candles):
                candle = candles[minute]
                writer.writerow(
                    (
                        minute.strftime("%Y-%m-%d %H:%M:%S"),
                        candle.contract,
                        decimal_text(candle.open),
                        decimal_text(candle.high),
                        decimal_text(candle.low),
                        decimal_text(candle.close),
                        candle.volume,
                        candle.trades,
                    )
                )
        temp_path.replace(output_path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def process_file(input_path: Path, output_dir: Path, contract: str = "WDOV26") -> ProcessingSummary:
    contract = contract.strip().upper()
    if not CONTRACT_PATTERN.fullmatch(contract):
        raise ValueError("contract must contain only ASCII letters and digits")

    summary = ProcessingSummary(input_path=input_path, contract=contract)
    active_trades: dict[TradeIdentity, ActiveTrade] = {}
    seen_new_identities: set[TradeIdentity] = set()
    cancelled_identities: set[TradeIdentity] = set()
    previous_timestamp: datetime | None = None

    try:
        source = input_path.open("r", encoding="utf-8-sig", newline="")
    except OSError as exc:
        summary.add_error(None, str(exc))
        raise FileProcessingError(summary) from exc

    with source:
        reader = csv.DictReader(source, delimiter=";")
        fieldnames = set(reader.fieldnames or ())
        missing = sorted(REQUIRED_COLUMNS - fieldnames)
        if missing:
            summary.add_error(None, f"missing required column(s): {', '.join(missing)}")
            raise FileProcessingError(summary)

        for row_number, row in enumerate(reader, start=2):
            summary.input_rows += 1
            instrument = (row.get("CodigoInstrumento") or "").strip().upper()
            if instrument != contract:
                continue
            summary.selected_rows += 1

            try:
                action, identity, timestamp, price, quantity, trade_date = _validate_selected_row(
                    row, row_number
                )
            except (KeyError, ValueError) as exc:
                summary.add_error(row_number, str(exc))
                continue

            summary.trade_dates.add(trade_date)
            if previous_timestamp is not None and timestamp < previous_timestamp:
                summary.out_of_order_count += 1
            previous_timestamp = timestamp

            if summary.first_timestamp is None or timestamp < summary.first_timestamp:
                summary.first_timestamp = timestamp
            if summary.last_timestamp is None or timestamp > summary.last_timestamp:
                summary.last_timestamp = timestamp

            if action == "0":
                summary.new_trade_count += 1
                if identity in seen_new_identities:
                    summary.add_error(
                        row_number,
                        "duplicate New trade identity "
                        f"{identity[-1]!r} within date/instrument/session/channel scope",
                    )
                    continue
                seen_new_identities.add(identity)
                active_trades[identity] = ActiveTrade(
                    identity=identity,
                    timestamp=timestamp,
                    row_number=row_number,
                    price=price,
                    quantity=quantity,
                    trade_date=trade_date,
                )
                continue

            if identity in cancelled_identities:
                summary.add_error(
                    row_number,
                    f"duplicate Delete for trade identity {identity[-1]!r}",
                )
                continue
            original = active_trades.get(identity)
            if original is None:
                summary.add_error(
                    row_number,
                    "unmatched Delete (or Delete before New) for trade identity "
                    f"{identity[-1]!r} within date/instrument/session/channel scope",
                )
                continue
            delete_errors: list[str] = []
            if timestamp < original.timestamp:
                delete_errors.append("Delete timestamp precedes the original New timestamp")
            if price != original.price:
                delete_errors.append(
                    f"Delete price {decimal_text(price)} differs from New price "
                    f"{decimal_text(original.price)}"
                )
            if quantity != original.quantity:
                delete_errors.append(
                    f"Delete quantity {quantity} differs from New quantity {original.quantity}"
                )
            if delete_errors:
                summary.add_error(row_number, "; ".join(delete_errors))
                continue
            del active_trades[identity]
            cancelled_identities.add(identity)
            summary.cancelled_trade_count += 1

    if len(summary.trade_dates) > 1:
        dates = ", ".join(sorted(value.isoformat() for value in summary.trade_dates))
        summary.add_error(None, f"selected records contain multiple DataNegocio values: {dates}")

    summary.active_trade_count = len(active_trades)
    summary.accepted_trades = summary.active_trade_count
    candles = _aggregate_active_trades(active_trades, contract)
    summary.candle_count = len(candles)

    if active_trades:
        active_timestamps = [trade.timestamp for trade in active_trades.values()]
        summary.first_timestamp = min(active_timestamps)
        summary.last_timestamp = max(active_timestamps)
    else:
        summary.first_timestamp = None
        summary.last_timestamp = None
    if summary.validation_error_count:
        raise FileProcessingError(summary)

    if summary.active_trade_count:
        trade_date = next(iter(summary.trade_dates))
        output_path = output_dir / f"{trade_date.isoformat()}_{contract}_1min.csv"
        try:
            _write_candles(output_path, candles)
        except OSError as exc:
            summary.add_error(None, f"could not publish output: {exc}")
            raise FileProcessingError(summary) from exc
        summary.output_path = output_path
    return summary


def print_summary(summary: ProcessingSummary, failed: bool = False) -> None:
    status = "FAILED" if failed else "OK"
    print(f"\n[{status}] {summary.input_path.name}")
    print(f"  Input rows: {summary.input_rows:,}")
    print(f"  Selected-contract rows ({summary.contract}): {summary.selected_rows:,}")
    print(f"  New trade events: {summary.new_trade_count:,}")
    print(f"  Cancelled trades: {summary.cancelled_trade_count:,}")
    print(f"  Final active trades: {summary.active_trade_count:,}")
    print(f"  Candles: {summary.candle_count:,}")
    print(f"  First timestamp: {summary.first_timestamp or '-'}")
    print(f"  Last timestamp: {summary.last_timestamp or '-'}")
    print(f"  Out-of-order transitions: {summary.out_of_order_count:,}")
    print(f"  Validation errors: {summary.validation_error_count:,}")
    for error in summary.validation_errors:
        print(f"    - {error}")
    omitted = summary.validation_error_count - len(summary.validation_errors)
    if omitted > 0:
        print(f"    - ... {omitted:,} additional error(s) omitted")
    if summary.output_path is not None:
        print(f"  Output: {summary.output_path}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", default="WDOV26", help="contract to select (default: WDOV26)")
    parser.add_argument("--input-dir", type=Path, default=DEFAULT_INPUT_DIR)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    contract = args.contract.strip().upper()
    try:
        if not CONTRACT_PATTERN.fullmatch(contract):
            raise ValueError("contract must contain only ASCII letters and digits")
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    files = sorted(args.input_dir.glob("*_WDO.csv"))
    if not files:
        print(f"No *_WDO.csv files found in {args.input_dir}", file=sys.stderr)
        return 1

    failures = 0
    for input_path in files:
        try:
            summary = process_file(input_path, args.output_dir, contract)
        except FileProcessingError as exc:
            failures += 1
            print_summary(exc.summary, failed=True)
        else:
            print_summary(summary)

    print(f"\nProcessed {len(files)} file(s): {len(files) - failures} succeeded, {failures} failed.")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
