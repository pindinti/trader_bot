import csv
import json
import os
import tempfile
import unittest
from pathlib import Path

from scripts.export_explorer import ExportError, export_dataset


COLUMNS = ["datetime", "contract", "open", "high", "low", "close", "volume", "trades"]


def candle(**changes):
    row = {
        "datetime": "2026-09-21 09:00:00", "contract": "WDOV26",
        "open": "10.0", "high": "12.0", "low": "9.5", "close": "11.5",
        "volume": "8", "trades": "3",
    }
    row.update(changes)
    return row


class ExplorerExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.candle_dir = self.root / "candles"
        self.output_dir = self.root / "storage-staging"
        self.candle_dir.mkdir()
        self.candle_path = self.candle_dir / "2026-09-21_WDOV26_1min.csv"
        self.audit_path = self.root / "audit.json"
        self.write_candles([candle(), candle(datetime="2026-09-21 09:01:00", open="11.5", high="13", low="11", close="12", volume="5", trades="2")])
        self.write_audit()

    def tearDown(self):
        self.temp.cleanup()

    def write_candles(self, rows):
        with self.candle_path.open("w", encoding="utf-8", newline="") as target:
            writer = csv.DictWriter(target, fieldnames=COLUMNS)
            writer.writeheader()
            writer.writerows(rows)

    def write_audit(self, **changes):
        result = {
            "date": "2026-09-21", "contract": "WDOV26", "candle_file": str(self.candle_path),
            "status": "PASS", "source_trade_count": 5, "source_quantity_sum": 13,
            "expected_candle_count": 2, "actual_candle_count": 2,
            "field_mismatch_count": 0, "missing_candle_count": 0, "extra_candle_count": 0,
            "duplicate_candle_count": 0, "out_of_order_candle_count": 0,
            "source_quantity_matches": True, "source_trade_count_matches": True,
            "ohlc_invariant_error_count": 0, "errors": [], "mismatches": [],
        }
        result.update(changes.pop("result", {}))
        report = {"overall_status": "PASS", "contract": "WDOV26", "generated_at": "2026-09-22T12:00:00-03:00", "results": [result]}
        report.update(changes)
        self.audit_path.write_text(json.dumps(report), encoding="utf-8")
        audit_time = self.candle_path.stat().st_mtime_ns + 1_000_000
        os.utime(self.audit_path, ns=(audit_time, audit_time))

    def run_export(self):
        return export_dataset("WDOV26", ["2026-09-21"], self.candle_dir, self.audit_path, self.output_dir)

    def test_exports_compact_day_and_manifest_deterministically(self):
        source_before = self.candle_path.read_bytes()
        manifest = self.run_export()
        day_path = self.output_dir / "WDOV26" / "2026-09-21.json"
        manifest_path = self.output_dir / "manifest.json"
        first_bytes = (day_path.read_bytes(), manifest_path.read_bytes())
        day = json.loads(day_path.read_text(encoding="utf-8"))
        self.run_export()
        self.assertEqual(manifest["schemaVersion"], 1)
        self.assertEqual(manifest["contracts"][0]["dates"][0]["candles"], 2)
        self.assertEqual(day["candles"][0], ["2026-09-21 09:00:00", "10", "12", "9.5", "11.5", 8, 3])
        self.assertNotIn("audit", json.dumps(day).lower())
        self.assertEqual(self.candle_path.read_bytes(), source_before)
        self.assertEqual((day_path.read_bytes(), manifest_path.read_bytes()), first_bytes)

    def test_refuses_failed_missing_or_incompatible_audit(self):
        cases = [
            {"result": {"status": "FAIL"}},
            {"overall_status": "FAIL"},
            {"results": []},
            {"results": [{"date": "2026-09-21"}]},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                self.write_audit(**changes)
                with self.assertRaises(ExportError):
                    self.run_export()
                self.assertFalse((self.output_dir / "manifest.json").exists())

    def test_refuses_stale_audit(self):
        old = self.candle_path.stat().st_mtime_ns - 1_000_000
        os.utime(self.audit_path, ns=(old, old))
        with self.assertRaisesRegex(ExportError, "predates"):
            self.run_export()

    def test_rejects_order_duplicates_numeric_and_ohlc_errors(self):
        bad_cases = [
            [candle(datetime="2026-09-21 09:01:00"), candle()],
            [candle(), candle()],
            [candle(open="x"), candle(datetime="2026-09-21 09:01:00")],
            [candle(high="8"), candle(datetime="2026-09-21 09:01:00")],
        ]
        for rows in bad_cases:
            with self.subTest(rows=rows):
                self.write_candles(rows)
                self.write_audit()
                with self.assertRaises(ExportError):
                    self.run_export()

    def test_failure_does_not_replace_existing_storage_staging_files(self):
        self.output_dir.mkdir()
        existing = self.output_dir / "manifest.json"
        existing.write_text("known-good\n", encoding="utf-8")
        self.write_candles([candle(high="1"), candle(datetime="2026-09-21 09:01:00")])
        self.write_audit()
        with self.assertRaises(ExportError):
            self.run_export()
        self.assertEqual(existing.read_text(encoding="utf-8"), "known-good\n")


if __name__ == "__main__":
    unittest.main()
