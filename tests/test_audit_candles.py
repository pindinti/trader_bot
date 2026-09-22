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
        rows = rows or [
            trade(),
            trade(PrecoNegocio="12,0", QuantidadeNegociada="3", HoraFechamento="090010100"),
            trade(PrecoNegocio="9,0", QuantidadeNegociada="4", HoraFechamento="090059999"),
        ]
        with self.source.open("w", encoding="utf-8", newline="") as target:
            writer = csv.DictWriter(target, fieldnames=SOURCE_FIELDS, delimiter=";")
            writer.writeheader()
            writer.writerows(rows)

    def write_candles(self, rows=None):
        rows = rows or [candle()]
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
            trade(HoraFechamento="090010000"),
            trade(HoraFechamento="090110000", PrecoNegocio="11,0"),
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
            trade(HoraFechamento="090050000", PrecoNegocio="11,0"),
            trade(HoraFechamento="090010000", PrecoNegocio="10,0"),
            trade(HoraFechamento="090050000", PrecoNegocio="12,0"),
        ])
        self.write_candles([candle(open="10", high="12", low="10", close="12", volume="6", trades="3")])
        result = self.audit()
        self.assertEqual(result["source_out_of_order_count"], 1)
        self.assertEqual(result["status"], "PASS")

    def test_invalid_source_record(self):
        self.write_source([trade(AcaoAtualizacao="2")])
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


if __name__ == "__main__":
    unittest.main()
