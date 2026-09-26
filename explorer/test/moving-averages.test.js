import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateCandles } from '../src/aggregate.js';
import { calculateEma, calculateMovingAverages, calculateSma } from '../src/moving-averages.js';

const START = Date.UTC(2026, 8, 21, 9, 0) / 1000;
const candles = (count, { step = 60, start = START } = {}) => Array.from({ length: count }, (_, index) => ({
  time: start + index * step,
  open: index + 1,
  high: index + 2,
  low: index,
  close: index + 1,
  volume: 1,
  trades: 1,
}));

for (const period of [9, 21, 200]) {
  test(`SMA${period} uses exactly ${period} completed closes`, () => {
    const source = candles(period + 1);
    const result = calculateSma(source, period);
    assert.equal(result.length, 2);
    assert.equal(result[0].time, source[period - 1].time);
    assert.equal(result[0].value, (period + 1) / 2);
    assert.equal(result[1].value, (period + 3) / 2);
  });

  test(`EMA${period} is seeded by SMA and follows the documented recurrence`, () => {
    const source = candles(period + 1);
    const result = calculateEma(source, period);
    const seed = (period + 1) / 2;
    const alpha = 2 / (period + 1);
    assert.equal(result[0].value, seed);
    assert.equal(result[1].value, alpha * (period + 1) + (1 - alpha) * seed);
    assert.deepEqual(calculateEma(source, period), result, 'EMA is deterministic');
  });
}

test('moving averages are calculated from active-timeframe closes, not raw one-minute closes', () => {
  const source = candles(18);
  const twoMinute = aggregateCandles(source, 2);
  const fromTwoMinute = calculateMovingAverages(twoMinute, new Set(['sma-9']))['sma-9'];
  const fromOneMinute = calculateMovingAverages(source, new Set(['sma-9']))['sma-9'];
  assert.equal(fromTwoMinute.length, 1);
  assert.equal(fromTwoMinute[0].value, 10);
  assert.notEqual(fromTwoMinute[0].value, fromOneMinute.at(-1).value);
});

test('insufficient history emits no average and missing minutes are not synthesized', () => {
  assert.deepEqual(calculateSma(candles(8), 9), []);
  assert.deepEqual(calculateEma(candles(20), 21), []);
  const source = candles(18).filter((_, index) => index !== 4);
  const twoMinute = aggregateCandles(source, 2);
  assert.equal(twoMinute.length, 9);
  assert.equal(calculateSma(twoMinute, 9).length, 1);
});

test('moving-average calculations do not mutate source candles', () => {
  const source = candles(21);
  const snapshot = structuredClone(source);
  calculateSma(source, 9);
  calculateEma(source, 21);
  assert.deepEqual(source, snapshot);
});
