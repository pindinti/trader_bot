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
                trade(PrecoNegocio="5143,500", QuantidadeNegociada="2", HoraFechamento="090045159"),
                trade(PrecoNegocio="5144,000", QuantidadeNegociada="3", HoraFechamento="090045159"),
                trade(PrecoNegocio="5142,500", QuantidadeNegociada="4", HoraFechamento="090059999"),
                trade(PrecoNegocio="5145,000", QuantidadeNegociada="5", HoraFechamento="090100000"),
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
                trade(CodigoInstrumento="WDOX26", HoraFechamento="090100000"),
                trade(HoraFechamento="090200000"),
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
                trade(PrecoNegocio="11,0", HoraFechamento="090050000"),
                trade(PrecoNegocio="10,0", HoraFechamento="090010000"),
                trade(PrecoNegocio="12,0", HoraFechamento="090050000"),
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
        self.assert_invalid(AcaoAtualizacao="2")

    def test_unsupported_session_type(self):
        self.assert_invalid(TipoSessaoPregao="2")

    def test_multiple_trade_dates_fail(self):
        self.write_rows(
            [
                trade(),
                trade(
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
        self.write_rows([trade(), trade(HoraFechamento="bad")])
        with self.assertRaises(FileProcessingError):
            process_file(self.input_path, self.output_dir)
        self.assertEqual(output.read_text(encoding="utf-8"), "known-good\n")
        self.assertEqual(list(self.output_dir.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
