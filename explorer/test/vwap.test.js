import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateSessionVwap } from '../src/vwap.js';

const candle = (time, volume, notional) => ({ time, volume, notional, open: 1, high: 1, low: 1, close: 1, trades: 1 });

test('session VWAP uses exact trade notional and resets at each session', () => {
  const day1 = Date.UTC(2026, 8, 21, 10) / 1000;
  const day2 = Date.UTC(2026, 8, 22, 10) / 1000;
  assert.deepEqual(calculateSessionVwap([
    candle(day1, 2, 20), candle(day1 + 60, 3, 36), candle(day2, 4, 60),
  ]), [
    { time: day1, value: 10 },
    { time: day1 + 60, value: 11.2 },
    { time: day2, value: 15 },
  ]);
});

test('VWAP calculated from a replay prefix cannot use appended future candles', () => {
  const start = Date.UTC(2026, 8, 21, 10) / 1000;
  const source = [candle(start, 2, 20), candle(start + 60, 3, 36), candle(start + 120, 100, 5000)];
  const snapshot = structuredClone(source);
  const prefix = calculateSessionVwap(source.slice(0, 2));
  assert.deepEqual(prefix, [{ time: start, value: 10 }, { time: start + 60, value: 11.2 }]);
  assert.deepEqual(calculateSessionVwap(source.slice(0, 2)), prefix);
  assert.deepEqual(source, snapshot);
});

test('VWAP fails closed without exact per-candle notional', () => {
  assert.throws(() => calculateSessionVwap([{ time: 1, volume: 2 }]), /exact positive notional/);
});
