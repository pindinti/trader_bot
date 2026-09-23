import assert from 'node:assert/strict';
import test from 'node:test';

import { replaceChartData, reprojectLogicalRange } from '../src/chart.js';

const candle = { time: 100, open: 10, high: 12, low: 9, close: 11, volume: 20 };

test('replay data replacement preserves the visible logical range without fitting', () => {
  const calls = [];
  const visibleRange = { from: -5.5, to: 24.5 };
  const timeScale = {
    getVisibleLogicalRange: () => visibleRange,
    setVisibleLogicalRange: (range) => calls.push(['restore', range]),
    fitContent: () => calls.push(['fit']),
  };
  const candleSeries = { setData: (data) => calls.push(['candles', data]) };
  const volumeSeries = { setData: (data) => calls.push(['volume', data]) };

  replaceChartData({ timeScale, candleSeries, volumeSeries, candles: [candle], preserveViewport: 'logical' });

  assert.deepEqual(calls.at(-1), ['restore', visibleRange]);
  assert.equal(calls.some(([type]) => type === 'fit'), false);
});

test('timeframe replacement preserves the visible wall-clock range', () => {
  const calls = [];
  const projectedRange = { from: -2, to: 6 };
  const timeScale = {
    setVisibleLogicalRange: (range) => calls.push(['restore-time', range]),
    fitContent: () => calls.push(['fit']),
  };

  replaceChartData({
    timeScale,
    candleSeries: { setData: () => {} },
    volumeSeries: { setData: () => {} },
    candles: [candle],
    preserveViewport: 'time',
    projectedLogicalRange: projectedRange,
  });

  assert.deepEqual(calls, [['restore-time', projectedRange]]);
});

test('timeframe viewport reprojection retains future whitespace', () => {
  const origin = Date.UTC(2026, 8, 21, 10) / 1000;
  const oneMinuteCandles = Array.from({ length: 61 }, (_, index) => ({ time: origin + index * 60 }));
  const fiveMinuteCandles = Array.from({ length: 13 }, (_, index) => ({ time: origin + index * 300 }));

  assert.deepEqual(
    reprojectLogicalRange({ from: 0, to: 120 }, oneMinuteCandles, 60, fiveMinuteCandles, 300),
    { from: 0, to: 24 },
  );
});

test('an initial chart context fits content once', () => {
  const calls = [];
  const timeScale = {
    getVisibleLogicalRange: () => ({ from: 0, to: 1 }),
    setVisibleLogicalRange: () => calls.push('restore'),
    fitContent: () => calls.push('fit'),
  };

  replaceChartData({
    timeScale,
    candleSeries: { setData: () => {} },
    volumeSeries: { setData: () => {} },
    candles: [candle],
    preserveViewport: false,
  });

  assert.deepEqual(calls, ['fit']);
});
