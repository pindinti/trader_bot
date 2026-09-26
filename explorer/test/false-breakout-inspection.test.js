import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  InspectionError,
  REPORT_FILENAMES,
  buildInspectionReport,
  loadSelectedCandleDays,
  parseArguments,
  renderObservationsCsv,
  renderShortlist,
  renderSummary,
  resolveResearchOutputDirectory,
  selectInspectionShortlist,
  writeInspectionReport,
} from '../scripts/inspect-false-breakouts.mjs';

function row(date, minute, changes = {}) {
  const values = {
    open: '100', high: '105', low: '95', close: '100', volume: 10, trades: 2, ...changes,
  };
  return [`${date} 10:${String(minute).padStart(2, '0')}:00`, values.open, values.high, values.low, values.close, values.volume, values.trades];
}

function payload(contract, date, candles) {
  return {
    schemaVersion: 1,
    contract,
    date,
    sourceTimeframeMinutes: 1,
    columns: ['datetime', 'open', 'high', 'low', 'close', 'volume', 'trades'],
    candles,
  };
}

function manifest(contract, entries) {
  return {
    schemaVersion: 1,
    sourceTimeframeMinutes: 1,
    contracts: [{
      symbol: contract,
      dates: entries.map(({ date, count }) => ({ date, file: `${contract}/${date}.json`, candles: count })),
    }],
  };
}

async function fixture(t, entries) {
  const root = await mkdtemp(join(tmpdir(), 'trade-bot-inspection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contract = 'TEST1';
  await mkdir(join(root, contract), { recursive: true });
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest(
    contract,
    entries.map(({ date, candles }) => ({ date, count: candles.length })),
  )));
  for (const entry of entries) {
    if (entry.skipFile) continue;
    const value = entry.raw ?? payload(contract, entry.date, entry.candles);
    await writeFile(join(root, contract, `${entry.date}.json`), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return { root, contract };
}

test('loads and validates only explicitly selected manifest days', async (t) => {
  const selectedDate = '2026-01-02';
  const unavailableDate = '2026-01-03';
  const { root, contract } = await fixture(t, [
    { date: selectedDate, candles: [row(selectedDate, 0), row(selectedDate, 1)] },
    { date: unavailableDate, candles: [row(unavailableDate, 0)], skipFile: true },
  ]);

  const dataset = await loadSelectedCandleDays({ inputDir: root, contract, dates: [selectedDate] });
  assert.equal(dataset.contract, contract);
  assert.deepEqual(dataset.days.map(({ date }) => date), [selectedDate]);
  assert.equal(dataset.days[0].candles.length, 2);
  assert.equal(dataset.days[0].candles[0].open, 100);
});

test('requires explicit selection and fails for missing contracts, dates, or files', async (t) => {
  const date = '2026-01-02';
  const { root, contract } = await fixture(t, [{ date, candles: [row(date, 0)], skipFile: true }]);

  assert.throws(() => parseArguments(['--input-dir', root, '--contract', contract]), /date must be selected/i);
  await assert.rejects(
    loadSelectedCandleDays({ inputDir: root, contract: 'OTHER1', dates: [date] }),
    /contract OTHER1 is not present/,
  );
  await assert.rejects(
    loadSelectedCandleDays({ inputDir: root, contract, dates: ['2026-01-03'] }),
    /date 2026-01-03 is not present/,
  );
  await assert.rejects(
    loadSelectedCandleDays({ inputDir: root, contract, dates: [date] }),
    /Cannot load TEST1 candles/,
  );
});

test('fails clearly for malformed JSON, schema, and timestamps', async (t) => {
  const manifestDate = '2026-01-01';
  const badManifest = await fixture(t, [{ date: manifestDate, candles: [row(manifestDate, 0)] }]);
  await writeFile(join(badManifest.root, 'manifest.json'), JSON.stringify({ schemaVersion: 2, contracts: [] }));
  await assert.rejects(
    loadSelectedCandleDays({ inputDir: badManifest.root, contract: badManifest.contract, dates: [manifestDate] }),
    /manifest has an incompatible/i,
  );

  const malformedDate = '2026-01-02';
  const malformed = await fixture(t, [{ date: malformedDate, candles: [row(malformedDate, 0)], raw: '{nope' }]);
  await assert.rejects(
    loadSelectedCandleDays({ inputDir: malformed.root, contract: malformed.contract, dates: [malformedDate] }),
    /Cannot parse TEST1 candles/,
  );

  const schemaDate = '2026-01-03';
  const badSchema = await fixture(t, [{
    date: schemaDate,
    candles: [row(schemaDate, 0)],
    raw: { ...payload('TEST1', schemaDate, [row(schemaDate, 0)]), columns: ['wrong'] },
  }]);
  await assert.rejects(
    loadSelectedCandleDays({ inputDir: badSchema.root, contract: badSchema.contract, dates: [schemaDate] }),
    /incompatível|incompatible/i,
  );

  const unorderedDate = '2026-01-04';
  const unordered = await fixture(t, [{
    date: unorderedDate,
    candles: [row(unorderedDate, 1), row(unorderedDate, 0)],
  }]);
  await assert.rejects(
    loadSelectedCandleDays({ inputDir: unordered.root, contract: unordered.contract, dates: [unorderedDate] }),
    /inválido|invalid/i,
  );

  const invalidDate = '2026-01-05';
  const invalidTimestamp = await fixture(t, [{
    date: invalidDate,
    candles: [[`${invalidDate} 10:99:00`, '100', '105', '95', '100', 10, 2]],
  }]);
  await assert.rejects(
    loadSelectedCandleDays({ inputDir: invalidTimestamp.root, contract: invalidTimestamp.contract, dates: [invalidDate] }),
    /invalid candle timestamp/i,
  );
});

test('resets lookback per day and maps observations to candidate OHLC without mutation', async (t) => {
  const firstDate = '2026-01-02';
  const secondDate = '2026-01-03';
  const { root, contract } = await fixture(t, [
    {
      date: firstDate,
      candles: [row(firstDate, 0), row(firstDate, 1), row(firstDate, 2, {
        open: '104', high: '106', low: '99', close: '104',
      })],
    },
    {
      date: secondDate,
      candles: [row(secondDate, 0, { open: '104', high: '110', low: '99', close: '104' })],
    },
  ]);
  const dataset = await loadSelectedCandleDays({ inputDir: root, contract, dates: [secondDate, firstDate] });
  const snapshot = structuredClone(dataset);
  const report = buildInspectionReport(dataset, { lookback: 2 });

  assert.deepEqual(report.days, [
    { date: firstDate, candleCount: 3, upper: 1, lower: 0, total: 1 },
    { date: secondDate, candleCount: 1, upper: 0, lower: 0, total: 0 },
  ]);
  assert.deepEqual(report.observations[0], {
    contract,
    date: firstDate,
    candleTimestamp: Date.UTC(2026, 0, 2, 10, 2) / 1000,
    exchangeLocalDisplayTime: '10:02',
    direction: 'upper',
    referenceLevel: 105,
    candidateOpen: 104,
    candidateHigh: 106,
    candidateLow: 99,
    candidateClose: 104,
    lookback: 2,
    observerName: 'same-candle-false-breakout',
    definitionVersion: '0.1',
  });
  assert.deepEqual(dataset, snapshot);
});

function inspectionDataset() {
  const days = [
    ['2026-01-02', [
      { time: Date.UTC(2026, 0, 2, 10, 0) / 1000, open: 100, high: 105, low: 95, close: 100, volume: 1, trades: 1 },
      { time: Date.UTC(2026, 0, 2, 10, 1) / 1000, open: 100, high: 106, low: 96, close: 104, volume: 1, trades: 1 },
    ]],
    ['2026-01-03', [
      { time: Date.UTC(2026, 0, 3, 10, 0) / 1000, open: 100, high: 105, low: 95, close: 100, volume: 1, trades: 1 },
      { time: Date.UTC(2026, 0, 3, 10, 1) / 1000, open: 100, high: 104, low: 94, close: 96, volume: 1, trades: 1 },
    ]],
    ['2026-01-04', [
      { time: Date.UTC(2026, 0, 4, 10, 0) / 1000, open: 100, high: 105, low: 95, close: 100, volume: 1, trades: 1 },
      { time: Date.UTC(2026, 0, 4, 10, 1) / 1000, open: 100, high: 106, low: 94, close: 100, volume: 1, trades: 1 },
    ]],
  ];
  return { contract: 'TEST1', days: days.map(([date, candles]) => ({ date, candles })) };
}

test('renders deterministic CSV, summary, and direction-aware shortlist', () => {
  const report = buildInspectionReport(inspectionDataset(), { lookback: 1 });
  const first = {
    csv: renderObservationsCsv(report),
    summary: renderSummary(report),
    shortlist: renderShortlist(report),
  };
  const second = {
    csv: renderObservationsCsv(report),
    summary: renderSummary(report),
    shortlist: renderShortlist(report),
  };

  assert.deepEqual(second, first);
  assert.match(first.csv, /^contract,date,candle_timestamp,exchange_local_display_time,/);
  assert.match(first.csv, /TEST1,2026-01-02,\d+,10:01,upper,105,100,106,96,104,1,same-candle-false-breakout,0\.1/);
  assert.match(first.summary, /2026-01-04 \| 2 \| 1 \| 1 \| 2/);
  assert.match(first.summary, /Total observations: \*\*4\*\*/);
  assert.match(first.shortlist, /earliest dual-direction candle/);
  assert.match(first.shortlist, /earliest additional upper observation/);
  assert.match(first.shortlist, /earliest additional lower observation/);
  assert.deepEqual(selectInspectionShortlist(report).map(({ date }) => date), [
    '2026-01-04', '2026-01-02', '2026-01-03',
  ]);
});

test('writes only inside an allowed ignored research directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'trade-bot-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowedRoot = join(root, 'data', 'research');
  const outputDir = join(allowedRoot, 'false_breakout_v0_1');
  const report = buildInspectionReport(inspectionDataset(), { lookback: 1 });

  assert.equal(resolveResearchOutputDirectory(outputDir, allowedRoot), resolve(outputDir));
  assert.throws(
    () => resolveResearchOutputDirectory(join(root, 'tracked-output'), allowedRoot),
    InspectionError,
  );
  const files = await writeInspectionReport(report, { outputDir, allowedRoot });
  assert.deepEqual(Object.keys(files).sort(), ['csv', 'shortlist', 'summary']);
  assert.equal(await readFile(join(outputDir, REPORT_FILENAMES.csv), 'utf8'), renderObservationsCsv(report));
  assert.equal(await readFile(join(outputDir, REPORT_FILENAMES.summary), 'utf8'), renderSummary(report));
  assert.equal(await readFile(join(outputDir, REPORT_FILENAMES.shortlist), 'utf8'), renderShortlist(report));

  const rootIgnore = await readFile(new URL('../../.gitignore', import.meta.url), 'utf8');
  assert.match(rootIgnore, /^data\/research\/$/m);
});
