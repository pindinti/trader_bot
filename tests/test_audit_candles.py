import csv
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from scripts.audit_candles import audit_file


SOURCE_FIELDS = [
    "DataReferencia", "CodigoInstrumento", "AcaoAtualizacao", "PrecoNegocio",
    "QuantidadeNegociada", "HoraFechamento", "CodigoIdentificadorNegocio",
    "TipoSessaoPregao", "DataNegocio", "CodigoParticipanteComprador",
    "CodigoParticipanteVendedor", "TipoDoCanal",
]
CANDLE_FIELDS = ["datetime", "contract", "open", "high", "low", "close", "volume", "trades"]


def trade(**changes):
    row = {
        "DataReferencia": "2026-09-21", "CodigoInstrumento": "WDOV26",
        "AcaoAtualizacao": "0", "PrecoNegocio": "10,0", "QuantidadeNegociada": "2",
        "HoraFechamento": "090010100", "CodigoIdentificadorNegocio": "1",
        "TipoSessaoPregao": "1", "DataNegocio": "2026-09-21",
        "CodigoParticipanteComprador": "1", "CodigoParticipanteVendedor": "2", "TipoDoCanal": "1",
    }
    row.update(changes)
    return row


def delete_of(original, **changes):
    row = dict(original)
    row.update(
        AcaoAtualizacao="2",
        HoraFechamento="100000000",
        CodigoParticipanteComprador="",
        CodigoParticipanteVendedor="",
    )
    row.update(changes)
    return row


def candle(**changes):
    row = {
        "datetime": "2026-09-21 09:00:00", "contract": "WDOV26",
        "open": "10", "high": "12", "low": "9", "close": "9",
        "volume": "9", "trades": "3",
    }
    row.update(changes)
    return row


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "input_WDO.csv"
        self.candles = self.root / "candles"
        self.candles.mkdir()
        self.output = self.candles / "2026-09-21_WDOV26_1min.csv"

    def tearDown(self):
        self.temp.cleanup()

    def write_source(self, rows=None):
        rows = rows if rows is not None else [
            trade(CodigoIdentificadorNegocio="1"),
            trade(CodigoIdentificadorNegocio="2", PrecoNegocio="12,0", QuantidadeNegociada="3", HoraFechamento="090010100"),
            trade(CodigoIdentificadorNegocio="3", PrecoNegocio="9,0", QuantidadeNegociada="4", HoraFechamento="090059999"),
        ]
        with self.source.open("w", encoding="utf-8", newline="") as target:
            writer = csv.DictWriter(target, fieldnames=SOURCE_FIELDS, delimiter=";")
            writer.writeheader()
            writer.writerows(rows)

    def write_candles(self, rows=None):
        rows = rows if rows is not None else [candle()]
        with self.output.open("w", encoding="utf-8", newline="") as target:
            writer = csv.DictWriter(target, fieldnames=CANDLE_FIELDS)
            writer.writeheader()
            writer.writerows(rows)

    def audit(self):
        return audit_file(self.source, self.candles, range_warning=Decimal("100"), move_warning=Decimal("100"))

    def test_fully_matching_and_duplicate_millisecond(self):
        self.write_source()
        self.write_candles()
        result = self.audit()
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["source_trade_count"], 3)
        self.assertTrue(result["diagnostic_samples"][0]["match"])

    def test_each_ohlc_field_mismatch(self):
        self.write_source()
        for field, value in (("open", "11"), ("high", "13"), ("low", "8"), ("close", "10")):
            with self.subTest(field=field):
                self.write_candles([candle(**{field: value})])
                result = self.audit()
                self.assertEqual(result["status"], "FAIL")
                self.assertGreaterEqual(result["field_mismatch_count"], 1)

    def test_volume_and_trade_count_mismatch(self):
        self.write_source()
        self.write_candles([candle(volume="8", trades="2")])
        result = self.audit()
        self.assertEqual(result["field_mismatch_count"], 2)
        self.assertFalse(result["source_quantity_matches"])
        self.assertFalse(result["source_trade_count_matches"])

    def test_missing_candle(self):
        self.write_source()
        self.write_candles([candle(datetime="2026-09-21 09:01:00", open="1", high="1", low="1", close="1", volume="1", trades="1")])
        result = self.audit()
        self.assertEqual(result["missing_candle_count"], 1)
        self.assertEqual(result["extra_candle_count"], 1)

    def test_extra_candle(self):
        self.write_source()
        self.write_candles([candle(), candle(datetime="2026-09-21 09:01:00")])
        self.assertEqual(self.audit()["extra_candle_count"], 1)

    def test_duplicate_candle(self):
        self.write_source()
        self.write_candles([candle(), candle()])
        result = self.audit()
        self.assertEqual(result["duplicate_candle_count"], 1)
        self.assertEqual(result["status"], "FAIL")

    def test_out_of_order_candles(self):
        self.write_source([
            trade(CodigoIdentificadorNegocio="1", HoraFechamento="090010000"),
            trade(CodigoIdentificadorNegocio="2", HoraFechamento="090110000", PrecoNegocio="11,0"),
        ])
        self.write_candles([
            candle(datetime="2026-09-21 09:01:00", open="11", high="11", low="11", close="11", volume="2", trades="1"),
            candle(open="10", high="10", low="10", close="10", volume="2", trades="1"),
        ])
        result = self.audit()
        self.assertEqual(result["out_of_order_candle_count"], 1)
        self.assertEqual(result["status"], "FAIL")

    def test_source_out_of_order_is_reconstructed_chronologically(self):
        self.write_source([
            trade(CodigoIdentificadorNegocio="1", HoraFechamento="090050000", PrecoNegocio="11,0"),
            trade(CodigoIdentificadorNegocio="2", HoraFechamento="090010000", PrecoNegocio="10,0"),
            trade(CodigoIdentificadorNegocio="3", HoraFechamento="090050000", PrecoNegocio="12,0"),
        ])
        self.write_candles([candle(open="10", high="12", low="10", close="12", volume="6", trades="3")])
        result = self.audit()
        self.assertEqual(result["source_out_of_order_count"], 1)
        self.assertEqual(result["status"], "PASS")

    def test_invalid_source_record(self):
        self.write_source([trade(AcaoAtualizacao="1")])
        self.write_candles()
        result = self.audit()
        self.assertEqual(result["status"], "FAIL")
        self.assertTrue(any("AcaoAtualizacao" in error for error in result["errors"]))

    def test_invalid_candle_record(self):
        self.write_source()
        self.write_candles([candle(open="not-a-price")])
        result = self.audit()
        self.assertEqual(result["status"], "FAIL")
        self.assertTrue(any("invalid decimal-point" in error for error in result["errors"]))

    def test_audit_does_not_modify_existing_files(self):
        self.write_source()
        self.write_candles()
        source_before = self.source.read_bytes()
        output_before = self.output.read_bytes()
        self.audit()
        self.assertEqual(self.source.read_bytes(), source_before)
        self.assertEqual(self.output.read_bytes(), output_before)

    def assert_cancellation_passes(self, rows, expected_candle, active_count):
        self.write_source(rows)
        self.write_candles([expected_candle])
        result = self.audit()
        self.assertEqual(result["status"], "PASS", result["errors"] + result["mismatches"])
        self.assertEqual(result["source_new_trade_count"], active_count + 1)
        self.assertEqual(result["source_cancelled_trade_count"], 1)
        self.assertEqual(result["source_trade_count"], active_count)
        return result

    def test_new_followed_by_delete_is_removed_and_uses_new_timestamp(self):
        removed = trade(CodigoIdentificadorNegocio="1", PrecoNegocio="10,0", QuantidadeNegociada="7", HoraFechamento="090010000")
        retained = trade(CodigoIdentificadorNegocio="2", PrecoNegocio="11,0", QuantidadeNegociada="3", HoraFechamento="090020000")
        result = self.assert_cancellation_passes(
            [removed, retained, delete_of(removed, HoraFechamento="091500000")],
            candle(open="11", high="11", low="11", close="11", volume="3", trades="1"),
            1,
        )
        self.assertEqual(result["source_selected_row_count"], 3)
        self.assertEqual(result["source_quantity_sum"], 3)

    def test_deleted_high_is_recomputed(self):
        opening = trade(CodigoIdentificadorNegocio="1", PrecoNegocio="10,0", QuantidadeNegociada="2", HoraFechamento="090010000")
        high = trade(CodigoIdentificadorNegocio="2", PrecoNegocio="12,0", QuantidadeNegociada="3", HoraFechamento="090020000")
        close = trade(CodigoIdentificadorNegocio="3", PrecoNegocio="11,0", QuantidadeNegociada="4", HoraFechamento="090030000")
        self.assert_cancellation_passes(
            [opening, high, close, delete_of(high)],
            candle(open="10", high="11", low="10", close="11", volume="6", trades="2"),
            2,
        )

    def test_deleted_low_is_recomputed(self):
        opening = trade(CodigoIdentificadorNegocio="1", PrecoNegocio="10,0", QuantidadeNegociada="2", HoraFechamento="090010000")
        low = trade(CodigoIdentificadorNegocio="2", PrecoNegocio="8,0", QuantidadeNegociada="3", HoraFechamento="090020000")
        close = trade(CodigoIdentificadorNegocio="3", PrecoNegocio="9,0", QuantidadeNegociada="4", HoraFechamento="090030000")
        self.assert_cancellation_passes(
            [opening, low, close, delete_of(low)],
            candle(open="10", high="10", low="9", close="9", volume="6", trades="2"),
            2,
        )

    def test_deleted_open_is_recomputed(self):
        opening = trade(CodigoIdentificadorNegocio="1", PrecoNegocio="10,0", QuantidadeNegociada="2", HoraFechamento="090010000")
        next_trade = trade(CodigoIdentificadorNegocio="2", PrecoNegocio="11,0", QuantidadeNegociada="3", HoraFechamento="090020000")
        close = trade(CodigoIdentificadorNegocio="3", PrecoNegocio="9,0", QuantidadeNegociada="4", HoraFechamento="090030000")
        self.assert_cancellation_passes(
            [opening, next_trade, close, delete_of(opening)],
            candle(open="11", high="11", low="9", close="9", volume="7", trades="2"),
            2,
        )

    def test_deleted_close_is_recomputed(self):
        opening = trade(CodigoIdentificadorNegocio="1", PrecoNegocio="10,0", QuantidadeNegociada="2", HoraFechamento="090010000")
        prior = trade(CodigoIdentificadorNegocio="2", PrecoNegocio="11,0", QuantidadeNegociada="3", HoraFechamento="090020000")
        closing = trade(CodigoIdentificadorNegocio="3", PrecoNegocio="9,0", QuantidadeNegociada="4", HoraFechamento="090030000")
        self.assert_cancellation_passes(
            [opening, prior, closing, delete_of(closing)],
            candle(open="10", high="11", low="10", close="11", volume="5", trades="2"),
            2,
        )

    def test_deleted_interior_trade_changes_only_volume_and_count(self):
        opening = trade(CodigoIdentificadorNegocio="1", PrecoNegocio="10,0", QuantidadeNegociada="2", HoraFechamento="090010000")
        high = trade(CodigoIdentificadorNegocio="2", PrecoNegocio="12,0", QuantidadeNegociada="3", HoraFechamento="090020000")
        interior = trade(CodigoIdentificadorNegocio="3", PrecoNegocio="11,0", QuantidadeNegociada="4", HoraFechamento="090030000")
        closing = trade(CodigoIdentificadorNegocio="4", PrecoNegocio="9,0", QuantidadeNegociada="5", HoraFechamento="090040000")
        self.assert_cancellation_passes(
            [opening, high, interior, closing, delete_of(interior)],
            candle(open="10", high="12", low="9", close="9", volume="10", trades="3"),
            3,
        )

    def test_cancellation_removes_only_trade_in_minute(self):
        removed = trade(CodigoIdentificadorNegocio="1", HoraFechamento="090010000")
        retained = trade(CodigoIdentificadorNegocio="2", PrecoNegocio="11,0", QuantidadeNegociada="3", HoraFechamento="090100000")
        self.write_source([removed, retained, delete_of(removed)])
        self.write_candles([
            candle(datetime="2026-09-21 09:01:00", open="11", high="11", low="11", close="11", volume="3", trades="1")
        ])
        result = self.audit()
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["expected_candle_count"], 1)

    def assert_resolution_failure(self, rows, message):
        self.write_source(rows)
        self.write_candles([])
        result = self.audit()
        self.assertEqual(result["status"], "FAIL")
        self.assertTrue(any(message in error for error in result["errors"]), result["errors"])

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
        self.assert_resolution_failure([original, delete_of(original, QuantidadeNegociada="3")], "Delete quantity")

    def test_same_identifier_for_other_instrument_does_not_match(self):
        original = trade()
        self.write_source([original, delete_of(original, CodigoInstrumento="WDOX26")])
        self.write_candles([candle(open="10", high="10", low="10", close="10", volume="2", trades="1")])
        result = self.audit()
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["source_cancelled_trade_count"], 0)

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


if __name__ == "__main__":
    unittest.main()
