import csv
import tempfile
import unittest
from pathlib import Path

from scripts.build_candles import FileProcessingError, process_file


FIELDS = [
    "DataReferencia",
    "CodigoInstrumento",
    "AcaoAtualizacao",
    "PrecoNegocio",
    "QuantidadeNegociada",
    "HoraFechamento",
    "CodigoIdentificadorNegocio",
    "TipoSessaoPregao",
    "DataNegocio",
    "CodigoParticipanteComprador",
    "CodigoParticipanteVendedor",
    "TipoDoCanal",
]


def trade(**overrides):
    row = {
        "DataReferencia": "2026-09-21",
        "CodigoInstrumento": "WDOV26",
        "AcaoAtualizacao": "0",
        "PrecoNegocio": "5143,500",
        "QuantidadeNegociada": "1",
        "HoraFechamento": "090045159",
        "CodigoIdentificadorNegocio": "10",
        "TipoSessaoPregao": "1",
        "DataNegocio": "2026-09-21",
        "CodigoParticipanteComprador": "1",
        "CodigoParticipanteVendedor": "2",
        "TipoDoCanal": "1",
    }
    row.update(overrides)
    return row


def delete_of(original, **overrides):
    row = dict(original)
    row.update(
        AcaoAtualizacao="2",
        HoraFechamento="100000000",
        CodigoParticipanteComprador="",
        CodigoParticipanteVendedor="",
    )
    row.update(overrides)
    return row


class CandleBuilderTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.input_path = self.root / "input_WDO.csv"
        self.output_dir = self.root / "out"

    def tearDown(self):
        self.temp_dir.cleanup()

    def write_rows(self, rows):
        with self.input_path.open("w", encoding="utf-8", newline="") as target:
            writer = csv.DictWriter(target, fieldnames=FIELDS, delimiter=";")
            writer.writeheader()
            writer.writerows(rows)

    def output_rows(self):
        output = self.output_dir / "2026-09-21_WDOV26_1min.csv"
        with output.open("r", encoding="utf-8", newline="") as source:
            return list(csv.DictReader(source))

    def assert_invalid(self, **overrides):
        self.write_rows([trade(**overrides)])
        with self.assertRaises(FileProcessingError) as caught:
            process_file(self.input_path, self.output_dir)
        self.assertEqual(caught.exception.summary.validation_error_count, 1)
        self.assertFalse(list(self.output_dir.glob("*")) if self.output_dir.exists() else [])

    def test_ohlcv_duplicate_millisecond_decimal_comma_and_minute_boundary(self):
        self.write_rows(
            [
                trade(CodigoIdentificadorNegocio="1", PrecoNegocio="5143,500", QuantidadeNegociada="2", HoraFechamento="090045159"),
                trade(CodigoIdentificadorNegocio="2", PrecoNegocio="5144,000", QuantidadeNegociada="3", HoraFechamento="090045159"),
                trade(CodigoIdentificadorNegocio="3", PrecoNegocio="5142,500", QuantidadeNegociada="4", HoraFechamento="090059999"),
                trade(CodigoIdentificadorNegocio="4", PrecoNegocio="5145,000", QuantidadeNegociada="5", HoraFechamento="090100000"),
            ]
        )
        summary = process_file(self.input_path, self.output_dir)
        rows = self.output_rows()
        self.assertEqual(summary.accepted_trades, 4)
        self.assertEqual(summary.candle_count, 2)
        self.assertEqual(
            rows[0],
            {
                "datetime": "2026-09-21 09:00:00",
                "contract": "WDOV26",
                "open": "5143.5",
                "high": "5144",
                "low": "5142.5",
                "close": "5142.5",
                "volume": "9",
                "trades": "3",
            },
        )
        self.assertEqual(rows[1]["datetime"], "2026-09-21 09:01:00")

    def test_contract_filtering_and_no_synthetic_empty_minute(self):
        self.write_rows(
            [
                trade(HoraFechamento="090000000"),
                trade(CodigoInstrumento="WDOX26", CodigoIdentificadorNegocio="2", HoraFechamento="090100000"),
                trade(CodigoIdentificadorNegocio="3", HoraFechamento="090200000"),
            ]
        )
        summary = process_file(self.input_path, self.output_dir)
        rows = self.output_rows()
        self.assertEqual(summary.input_rows, 3)
        self.assertEqual(summary.selected_rows, 2)
        self.assertEqual([row["datetime"] for row in rows], ["2026-09-21 09:00:00", "2026-09-21 09:02:00"])

    def test_out_of_order_uses_timestamp_then_source_row_for_open_close(self):
        self.write_rows(
            [
                trade(CodigoIdentificadorNegocio="1", PrecoNegocio="11,0", HoraFechamento="090050000"),
                trade(CodigoIdentificadorNegocio="2", PrecoNegocio="10,0", HoraFechamento="090010000"),
                trade(CodigoIdentificadorNegocio="3", PrecoNegocio="12,0", HoraFechamento="090050000"),
            ]
        )
        summary = process_file(self.input_path, self.output_dir)
        row = self.output_rows()[0]
        self.assertEqual(summary.out_of_order_count, 1)
        self.assertEqual(row["open"], "10")
        self.assertEqual(row["close"], "12")
        self.assertEqual(row["trades"], "3")

    def test_invalid_timestamp(self):
        self.assert_invalid(HoraFechamento="250000000")

    def test_invalid_date(self):
        self.assert_invalid(DataNegocio="2026-02-30")

    def test_invalid_price(self):
        self.assert_invalid(PrecoNegocio="0,0")

    def test_invalid_quantity(self):
        self.assert_invalid(QuantidadeNegociada="-1")

    def test_unsupported_update_action(self):
        self.assert_invalid(AcaoAtualizacao="1")

    def test_unsupported_session_type(self):
        self.assert_invalid(TipoSessaoPregao="2")

    def test_multiple_trade_dates_fail(self):
        self.write_rows(
            [
                trade(),
                trade(
                    CodigoIdentificadorNegocio="2",
                    DataReferencia="2026-09-22",
                    DataNegocio="2026-09-22",
                    HoraFechamento="090100000",
                ),
            ]
        )
        with self.assertRaises(FileProcessingError) as caught:
            process_file(self.input_path, self.output_dir)
        self.assertIn("multiple DataNegocio", caught.exception.summary.validation_errors[0])
        self.assertFalse(self.output_dir.exists())

    def test_failure_does_not_publish_partial_or_replace_existing_output(self):
        self.output_dir.mkdir()
        output = self.output_dir / "2026-09-21_WDOV26_1min.csv"
        output.write_text("known-good\n", encoding="utf-8")
        self.write_rows([trade(), trade(CodigoIdentificadorNegocio="2", HoraFechamento="bad")])
        with self.assertRaises(FileProcessingError):
            process_file(self.input_path, self.output_dir)
        self.assertEqual(output.read_text(encoding="utf-8"), "known-good\n")
        self.assertEqual(list(self.output_dir.glob("*.tmp")), [])

    def assert_cancelled_candle(self, rows, expected):
        self.write_rows(rows)
        summary = process_file(self.input_path, self.output_dir)
        actual = self.output_rows()[0]
        for field, value in expected.items():
            self.assertEqual(actual[field], str(value), field)
        return summary

    def test_new_followed_by_delete_is_removed_and_uses_new_timestamp(self):
        cancelled = trade(
            CodigoIdentificadorNegocio="1",
            PrecoNegocio="10,0",
            QuantidadeNegociada="7",
            HoraFechamento="090010000",
        )
        remaining = trade(
            CodigoIdentificadorNegocio="2",
            PrecoNegocio="11,0",
            QuantidadeNegociada="3",
            HoraFechamento="090020000",
        )
        summary = self.assert_cancelled_candle(
            [cancelled, remaining, delete_of(cancelled, HoraFechamento="091500000")],
            {"datetime": "2026-09-21 09:00:00", "open": "11", "high": "11", "low": "11", "close": "11", "volume": "3", "trades": "1"},
        )
        self.assertEqual(summary.selected_rows, 3)
        self.assertEqual(summary.new_trade_count, 2)
        self.assertEqual(summary.cancelled_trade_count, 1)
        self.assertEqual(summary.active_trade_count, 1)
        self.assertEqual(summary.accepted_trades, 1)
        self.assertEqual(len(self.output_rows()), 1)

    def test_deleted_high_is_recomputed(self):
        low = trade(CodigoIdentificadorNegocio="1", PrecoNegocio="10,0", QuantidadeNegociada="2", HoraFechamento="090010000")
        high = trade(CodigoIdentificadorNegocio="2", PrecoNegocio="12,0", QuantidadeNegociada="3", HoraFechamento="090020000")
        close = trade(CodigoIdentificadorNegocio="3", PrecoNegocio="11,0", QuantidadeNegociada="4", HoraFechamento="090030000")
        self.assert_cancelled_candle(
            [low, high, close, delete_of(high)],
            {"open": "10", "high": "11", "low": "10", "close": "11", "volume": "6", "trades": "2"},
        )

    def test_deleted_low_is_recomputed(self):
        opening = trade(CodigoIdentificadorNegocio="1", PrecoNegocio="10,0", QuantidadeNegociada="2", HoraFechamento="090010000")
        low = trade(CodigoIdentificadorNegocio="2", PrecoNegocio="8,0", QuantidadeNegociada="3", HoraFechamento="090020000")
        close = trade(CodigoIdentificadorNegocio="3", PrecoNegocio="9,0", QuantidadeNegociada="4", HoraFechamento="090030000")
        self.assert_cancelled_candle(
            [opening, low, close, delete_of(low)],
            {"open": "10", "high": "10", "low": "9", "close": "9", "volume": "6", "trades": "2"},
        )

    def test_deleted_open_is_recomputed(self):
        opening = trade(CodigoIdentificadorNegocio="1", PrecoNegocio="10,0", QuantidadeNegociada="2", HoraFechamento="090010000")
        next_trade = trade(CodigoIdentificadorNegocio="2", PrecoNegocio="11,0", QuantidadeNegociada="3", HoraFechamento="090020000")
        close = trade(CodigoIdentificadorNegocio="3", PrecoNegocio="9,0", QuantidadeNegociada="4", HoraFechamento="090030000")
        self.assert_cancelled_candle(
            [opening, next_trade, close, delete_of(opening)],
            {"open": "11", "high": "11", "low": "9", "close": "9", "volume": "7", "trades": "2"},
        )

    def test_deleted_close_is_recomputed(self):
        opening = trade(CodigoIdentificadorNegocio="1", PrecoNegocio="10,0", QuantidadeNegociada="2", HoraFechamento="090010000")
        prior = trade(CodigoIdentificadorNegocio="2", PrecoNegocio="11,0", QuantidadeNegociada="3", HoraFechamento="090020000")
        closing = trade(CodigoIdentificadorNegocio="3", PrecoNegocio="9,0", QuantidadeNegociada="4", HoraFechamento="090030000")
        self.assert_cancelled_candle(
            [opening, prior, closing, delete_of(closing)],
            {"open": "10", "high": "11", "low": "10", "close": "11", "volume": "5", "trades": "2"},
        )

    def test_deleted_interior_trade_changes_only_volume_and_count(self):
        opening = trade(CodigoIdentificadorNegocio="1", PrecoNegocio="10,0", QuantidadeNegociada="2", HoraFechamento="090010000")
        high = trade(CodigoIdentificadorNegocio="2", PrecoNegocio="12,0", QuantidadeNegociada="3", HoraFechamento="090020000")
        interior = trade(CodigoIdentificadorNegocio="3", PrecoNegocio="11,0", QuantidadeNegociada="4", HoraFechamento="090030000")
        close = trade(CodigoIdentificadorNegocio="4", PrecoNegocio="9,0", QuantidadeNegociada="5", HoraFechamento="090040000")
        self.assert_cancelled_candle(
            [opening, high, interior, close, delete_of(interior)],
            {"open": "10", "high": "12", "low": "9", "close": "9", "volume": "10", "trades": "3"},
        )

    def test_cancellation_removes_only_trade_in_minute(self):
        removed = trade(CodigoIdentificadorNegocio="1", HoraFechamento="090010000")
        retained = trade(CodigoIdentificadorNegocio="2", HoraFechamento="090100000")
        self.write_rows([removed, retained, delete_of(removed, HoraFechamento="100000000")])
        process_file(self.input_path, self.output_dir)
        self.assertEqual([row["datetime"] for row in self.output_rows()], ["2026-09-21 09:01:00"])

    def assert_resolution_failure(self, rows, message):
        self.write_rows(rows)
        with self.assertRaises(FileProcessingError) as caught:
            process_file(self.input_path, self.output_dir)
        self.assertTrue(any(message in error for error in caught.exception.summary.validation_errors))
        self.assertFalse(self.output_dir.exists())

    def test_unmatched_delete_fails_closed(self):
        self.assert_resolution_failure([delete_of(trade())], "unmatched Delete")

    def test_duplicate_delete_fails_closed(self):
        original = trade()
        self.assert_resolution_failure([original, delete_of(original), delete_of(original)], "duplicate Delete")

    def test_duplicate_new_identity_fails_closed(self):
        self.assert_resolution_failure([trade(), trade(HoraFechamento="090020000")], "duplicate New")

    def test_delete_price_mismatch_fails_closed(self):
        original = trade()
        self.assert_resolution_failure([original, delete_of(original, PrecoNegocio="11,0")], "Delete price")

    def test_delete_quantity_mismatch_fails_closed(self):
        original = trade()
        self.assert_resolution_failure([original, delete_of(original, QuantidadeNegociada="2")], "Delete quantity")

    def test_same_identifier_for_other_instrument_does_not_match(self):
        original = trade()
        foreign_delete = delete_of(original, CodigoInstrumento="WDOX26")
        self.write_rows([original, foreign_delete])
        summary = process_file(self.input_path, self.output_dir)
        self.assertEqual(summary.active_trade_count, 1)
        self.assertEqual(summary.cancelled_trade_count, 0)

    def test_same_identifier_on_other_date_does_not_match(self):
        original = trade()
        other_date = delete_of(original, DataReferencia="2026-09-22", DataNegocio="2026-09-22")
        self.assert_resolution_failure([original, other_date], "unmatched Delete")

    def test_same_identifier_in_other_session_does_not_match(self):
        original = trade()
        self.assert_resolution_failure([original, delete_of(original, TipoSessaoPregao="2")], "TipoSessaoPregao")

    def test_same_identifier_in_other_channel_does_not_match(self):
        original = trade()
        self.assert_resolution_failure([original, delete_of(original, TipoDoCanal="2")], "unmatched Delete")

    def test_delete_before_new_fails_closed(self):
        original = trade()
        self.assert_resolution_failure([delete_of(original), original], "Delete before New")

    def test_cancellation_failure_does_not_replace_existing_output(self):
        self.output_dir.mkdir()
        output = self.output_dir / "2026-09-21_WDOV26_1min.csv"
        output.write_text("known-good\n", encoding="utf-8")
        self.write_rows([delete_of(trade())])
        with self.assertRaises(FileProcessingError):
            process_file(self.input_path, self.output_dir)
        self.assertEqual(output.read_text(encoding="utf-8"), "known-good\n")


if __name__ == "__main__":
    unittest.main()
