import assert from 'node:assert/strict';
import test from 'node:test';

import { SUPPORTED_TIMEFRAMES } from '../src/aggregate.js';
import { candleReference } from '../src/candle-reference.js';
import { buildIndicatorLegend } from '../src/indicators.js';

test('candle numbering follows emitted candles at every supported timeframe', () => {
  const start = Date.UTC(2026, 8, 21, 10) / 1000;
  for (const timeframe of SUPPORTED_TIMEFRAMES) {
    const candles = [0, 1, 2].map((index) => ({ time: start + index * timeframe * 60 }));
    const displayTime = new Date(candles[1].time * 1000).toISOString().slice(11, 16);
    assert.equal(candleReference(candles, candles[1], timeframe), `Candle 2 · ${timeframe}m · ${displayTime}`);
  }
});

test('replay candle numbering cannot count hidden future candles', () => {
  const start = Date.UTC(2026, 8, 21, 10) / 1000;
  const full = [0, 1, 2].map((index) => ({ time: start + index * 60 }));
  const prefix = full.slice(0, 2);
  assert.equal(candleReference(prefix, prefix.at(-1), 1), 'Candle 2 · 1m · 10:01');
  assert.equal(candleReference(prefix, full.at(-1), 1), null);
});

test('candle numbering resets independently for prior and active sessions', () => {
  const previousStart = Date.UTC(2026, 8, 22, 16) / 1000;
  const activeStart = Date.UTC(2026, 8, 23, 9) / 1000;
  const previous = [0, 1, 2].map((index) => ({ time: previousStart + index * 2 * 60 }));
  const active = [0, 1].map((index) => ({ time: activeStart + index * 2 * 60 }));
  const chartCandles = [...previous, ...active];
  assert.equal(candleReference(chartCandles, previous[2], 2), 'Candle 3 · 2m · 16:04');
  assert.equal(candleReference(chartCandles, active[0], 2), 'Candle 1 · 2m · 09:00');
  assert.equal(candleReference(chartCandles, active[1], 2), 'Candle 2 · 2m · 09:02');
});

test('external indicator legend uses the latest completed available value', () => {
  const series = { 'ema-21': [{ time: 1, value: 10 }, { time: 2, value: 11 }] };
  assert.deepEqual(buildIndicatorLegend(new Set(['ema-21']), series), [
    { key: 'ema-21', label: 'EMA 21', color: '#5fa9ef', value: 11 },
  ]);
  assert.equal(buildIndicatorLegend(new Set(['ema-21']), { 'ema-21': series['ema-21'].slice(0, 1) })[0].value, 10);
});
