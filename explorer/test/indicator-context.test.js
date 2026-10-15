import assert from 'node:assert/strict';
import test from 'node:test';

import { observeReplayFalseBreakouts } from '../src/false-breakout-observer.js';
import {
  buildChartContext,
  candleSessionKey,
  createAuthenticatedDayCache,
  loadWarmupSessions,
} from '../src/indicator-context.js';
import { calculateSma } from '../src/moving-averages.js';
import { createCandleReplay } from '../src/replay.js';

function candles(day, count, startMinute = 0) {
  const start = Date.UTC(2026, 8, day, 9, startMinute) / 1000;
  return Array.from({ length: count }, (_, index) => ({
    time: start + index * 60,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 10,
    trades: 2,
  }));
}

test('indicator warmup extends beyond the baseline previous session when needed', async () => {
  const entries = ['2026-09-17', '2026-09-18', '2026-09-21'].map((date) => ({ contract: 'WDOV26', date }));
  const source = new Map([
    ['2026-09-17', candles(17, 10)],
    ['2026-09-18', candles(18, 10)],
  ]);
  const loaded = [];
  const sessions = await loadWarmupSessions({
    entries, currentContract: 'WDOV26', currentDate: '2026-09-21', timeframe: 5, requiredBars: 3,
    loadDay: async ({ date }) => { loaded.push(date); return source.get(date); },
  });
  assert.deepEqual(loaded, ['2026-09-18', '2026-09-17']);
  assert.deepEqual(sessions.map(({ date }) => date), ['2026-09-17', '2026-09-18']);
});

test('baseline context loads exactly one previous available manifest session without indicators', async () => {
  const entries = ['2026-09-17', '2026-09-18', '2026-09-21'].map((date) => ({ contract: 'WDOV26', date }));
  const loaded = [];
  const sessions = await loadWarmupSessions({
    entries, currentContract: 'WDOV26', currentDate: '2026-09-21', timeframe: 1, requiredBars: 0,
    loadDay: async ({ date }) => { loaded.push(date); return candles(Number(date.slice(-2)), 3); },
  });
  assert.deepEqual(loaded, ['2026-09-18']);
  assert.deepEqual(sessions.map(({ date }) => date), ['2026-09-18']);
});

test('baseline context follows manifest order across calendar gaps', async () => {
  const entries = ['2026-09-01', '2026-09-04', '2026-09-08'].map((date) => ({ contract: 'WDOV26', date }));
  const sessions = await loadWarmupSessions({
    entries, currentContract: 'WDOV26', currentDate: '2026-09-08', timeframe: 1,
    loadDay: async ({ date }) => candles(Number(date.slice(-2)), 2),
  });
  assert.deepEqual(sessions.map(({ date }) => date), ['2026-09-04']);
});

test('first manifest session has no prior context and does not fail', async () => {
  let loadCalls = 0;
  const sessions = await loadWarmupSessions({
    entries: [{ contract: 'WDOV26', date: '2026-09-01' }], currentContract: 'WDOV26', currentDate: '2026-09-01', timeframe: 1,
    loadDay: async () => { loadCalls += 1; return []; },
  });
  assert.deepEqual(sessions, []);
  assert.equal(loadCalls, 0);
});

test('authenticated daily cache reuses a private object and rejects dates outside the manifest', async () => {
  const calls = [];
  const date = '2026-09-21';
  const payload = {
    schemaVersion: 1, sourceTimeframeMinutes: 1, contract: 'WDOV26', date,
    columns: ['datetime', 'open', 'high', 'low', 'close', 'volume', 'trades'],
    candles: [['2026-09-21 09:00:00', 100, 102, 99, 101, 10, 2]],
  };
  const cache = createAuthenticatedDayCache({
    sessions: [{ contract: 'WDOV26', date, file: `WDOV26/${date}.json` }],
    download: async (path) => { calls.push(path); return payload; },
  });
  assert.equal((await cache.load('WDOV26', date))[0].close, 101);
  await cache.load('WDOV26', date);
  assert.equal(calls.length, 1);
  await assert.rejects(cache.load('WDOV26', '2026-09-18'), /não está no manifesto/);
});

test('authenticated cache keys distinguish contract and date', async () => {
  const date = '2026-09-30';
  const sessions = ['WDOV26', 'WDOX26'].map((contract) => ({ contract, date, file: `${contract}/${date}.json` }));
  const cache = createAuthenticatedDayCache({
    sessions,
    download: async (file) => {
      const contract = file.split('/')[0];
      const close = contract === 'WDOV26' ? 101 : 201;
      return {
        schemaVersion: 1, sourceTimeframeMinutes: 1, contract, date,
        columns: ['datetime', 'open', 'high', 'low', 'close', 'volume', 'trades'],
        candles: [[`${date} 09:00:00`, close - 1, close + 1, close - 2, close, 10, 2]],
      };
    },
  });
  assert.notEqual(candleSessionKey('WDOV26', date), candleSessionKey('WDOX26', date));
  assert.equal((await cache.load('WDOV26', date))[0].close, 101);
  assert.equal((await cache.load('WDOX26', date))[0].close, 201);
  assert.equal(cache.has('WDOV26', date), true);
  assert.equal(cache.has('WDOX26', date), true);
});

test('baseline context and moving-average warmup never cross a contract boundary', async () => {
  const entries = [
    { contract: 'WDOV26', date: '2026-09-29' },
    { contract: 'WDOX26', date: '2026-09-30' },
    { contract: 'WDOX26', date: '2026-10-01' },
  ];
  const loaded = [];
  const firstX = await loadWarmupSessions({
    entries, currentContract: 'WDOX26', currentDate: '2026-09-30', timeframe: 1,
    loadDay: async (entry) => { loaded.push(`${entry.contract}:${entry.date}`); return candles(30, 3); },
  });
  assert.deepEqual(firstX, []);
  assert.deepEqual(loaded, []);

  const laterX = await loadWarmupSessions({
    entries, currentContract: 'WDOX26', currentDate: '2026-10-01', timeframe: 1, requiredBars: 200,
    loadDay: async (entry) => { loaded.push(`${entry.contract}:${entry.date}`); return candles(30, 3); },
  });
  assert.deepEqual(laterX.map(({ contract, date }) => `${contract}:${date}`), ['WDOX26:2026-09-30']);
  assert.deepEqual(loaded, ['WDOX26:2026-09-30']);
});

test('prior-session context enables an MA without entering replay market data', () => {
  const previous = candles(18, 9);
  const selected = candles(21, 3);
  const replay = createCandleReplay();
  replay.load(selected);
  replay.enter();
  replay.next();
  const marketView = replay.getMarketView();
  const chartView = buildChartContext({
    priorSessions: [{ date: '2026-09-18', candles: previous }],
    selectedCandles: marketView.candles,
    timeframe: 1,
    simulatedTimestamp: marketView.simulatedTimestamp,
  });
  assert.equal(calculateSma(marketView.candles, 9).length, 0);
  assert.equal(calculateSma(chartView.candles, 9).length > 0, true);
  assert.deepEqual(replay.getMarketView().candles.map(({ time }) => time), selected.slice(0, 2).map(({ time }) => time));
  assert.equal(replay.getMarketView().candles.some(({ time }) => time < selected[0].time), false);
});

test('future selected-session candles cannot alter earlier replay MA values or enter the observer', () => {
  const previous = candles(18, 9);
  const selected = candles(21, 12);
  const replay = createCandleReplay();
  replay.load(selected);
  replay.enter();
  replay.next();
  const earlyView = replay.getMarketView();
  const earlyChart = buildChartContext({
    priorSessions: [{ date: '2026-09-18', candles: previous }],
    selectedCandles: earlyView.candles,
    timeframe: 1,
    simulatedTimestamp: earlyView.simulatedTimestamp,
  });
  const earlyAverage = calculateSma(earlyChart.candles, 9);
  Array.from({ length: 5 }).forEach(() => replay.next());
  const laterView = replay.getMarketView();
  const laterChart = buildChartContext({
    priorSessions: [{ date: '2026-09-18', candles: previous }],
    selectedCandles: laterView.candles,
    timeframe: 1,
    simulatedTimestamp: laterView.simulatedTimestamp,
  });
  assert.deepEqual(calculateSma(laterChart.candles, 9).slice(0, earlyAverage.length), earlyAverage);
  const observations = observeReplayFalseBreakouts(laterView, { lookback: 1 });
  assert.equal(observations.every(({ candidateTimestamp }) => candidateTimestamp >= selected[0].time), true);
  assert.equal(laterView.candles.at(-1).time, laterView.simulatedTimestamp);
});

test('higher-timeframe context contains prior sessions but excludes the selected partial bucket', () => {
  const previous = candles(18, 4);
  const selected = candles(21, 3);
  const view = buildChartContext({
    priorSessions: [{ date: '2026-09-18', candles: previous }],
    selectedCandles: selected,
    timeframe: 2,
    simulatedTimestamp: selected.at(-1).time,
  });
  assert.equal(view.contextCandles.length, 2);
  assert.equal(view.selectedCandles.length, 1);
  assert.equal(view.candles[1].time < view.candles[2].time, true);
});
