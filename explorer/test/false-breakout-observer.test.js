import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_FALSE_BREAKOUT_LOOKBACK,
  observeReplayFalseBreakouts,
  observeSameCandleFalseBreakouts,
} from '../src/false-breakout-observer.js';

const START = Date.UTC(2026, 8, 21, 10, 30) / 1000;

function candle(index, changes = {}) {
  return {
    time: START + index * 60,
    open: 100,
    high: 105,
    low: 95,
    close: 100,
    volume: 10,
    trades: 2,
    ...changes,
  };
}

function expected(direction, candidateTimestamp, referenceLevel, lookback = 3) {
  return {
    observer: 'same-candle-false-breakout',
    definitionVersion: '0.1',
    direction,
    candidateTimestamp,
    confirmationTimestamp: candidateTimestamp,
    referenceLevel,
    lookback,
  };
}

test('uses 20 preceding candles by default for an upper false breakout', () => {
  const source = Array.from({ length: DEFAULT_FALSE_BREAKOUT_LOOKBACK }, (_, index) => candle(index));
  source.push(candle(20, { high: 106, close: 104 }));

  assert.deepEqual(observeSameCandleFalseBreakouts(source), [
    expected('upper', source[20].time, 105, DEFAULT_FALSE_BREAKOUT_LOOKBACK),
  ]);
});

test('detects a lower false breakout', () => {
  const source = [candle(0), candle(1), candle(2), candle(3, { low: 94, close: 96 })];
  assert.deepEqual(observeSameCandleFalseBreakouts(source, { lookback: 3 }), [
    expected('lower', source[3].time, 95),
  ]);
});

test('strict inequalities reject breakout touches and closes exactly at either reference', () => {
  const upperTouch = [candle(0), candle(1), candle(2), candle(3, { high: 105, close: 104 })];
  const lowerTouch = [candle(0), candle(1), candle(2), candle(3, { low: 95, close: 96 })];
  const upperEquality = [candle(0), candle(1), candle(2), candle(3, { high: 106, close: 105 })];
  const lowerEquality = [candle(0), candle(1), candle(2), candle(3, { low: 94, close: 95 })];

  assert.deepEqual(observeSameCandleFalseBreakouts(upperTouch, { lookback: 3 }), []);
  assert.deepEqual(observeSameCandleFalseBreakouts(lowerTouch, { lookback: 3 }), []);
  assert.deepEqual(observeSameCandleFalseBreakouts(upperEquality, { lookback: 3 }), []);
  assert.deepEqual(observeSameCandleFalseBreakouts(lowerEquality, { lookback: 3 }), []);
});

test('emits nothing without the configured preceding history', () => {
  const source = [candle(0), candle(1, { high: 110, low: 90, close: 100 })];
  assert.deepEqual(observeSameCandleFalseBreakouts(source, { lookback: 2 }), []);
});

test('reference window excludes the candidate candle', () => {
  const source = [
    candle(0, { high: 101 }),
    candle(1, { high: 103 }),
    candle(2, { high: 102 }),
    candle(3, { high: 110, close: 102 }),
  ];

  assert.deepEqual(observeSameCandleFalseBreakouts(source, { lookback: 3 }), [
    expected('upper', source[3].time, 103),
  ]);
});

test('does not emit when a breakout closes beyond its reference level', () => {
  const upperContinues = [candle(0), candle(1), candle(2), candle(3, { high: 110, close: 106 })];
  const lowerContinues = [candle(0), candle(1), candle(2), candle(3, { low: 90, close: 94 })];

  assert.deepEqual(observeSameCandleFalseBreakouts(upperContinues, { lookback: 3 }), []);
  assert.deepEqual(observeSameCandleFalseBreakouts(lowerContinues, { lookback: 3 }), []);
});

test('emits independent upper and lower observations for the same candidate', () => {
  const source = [candle(0), candle(1), candle(2), candle(3, { high: 110, low: 90, close: 100 })];

  assert.deepEqual(observeSameCandleFalseBreakouts(source, { lookback: 3 }), [
    expected('upper', source[3].time, 105),
    expected('lower', source[3].time, 95),
  ]);
});

test('repeated evaluation is deterministic and future candles do not change earlier observations', () => {
  const prefix = [candle(0), candle(1), candle(2), candle(3, { high: 110, close: 100 })];
  const first = observeSameCandleFalseBreakouts(prefix, { lookback: 3 });
  const second = observeSameCandleFalseBreakouts(prefix, { lookback: 3 });
  const withFuture = observeSameCandleFalseBreakouts([
    ...prefix,
    candle(4, { low: 90, close: 100 }),
  ], { lookback: 3 });

  assert.deepEqual(second, first);
  assert.deepEqual(
    withFuture.filter(({ confirmationTimestamp }) => confirmationTimestamp <= prefix.at(-1).time),
    first,
  );
});

test('replay adapter refuses inactive or future-contaminated market views', () => {
  const candles = [candle(0), candle(1), candle(2), candle(3, { high: 110, close: 100 })];
  assert.throws(
    () => observeReplayFalseBreakouts({ active: false, simulatedTimestamp: null, candles }),
    /active market view/,
  );
  assert.throws(
    () => observeReplayFalseBreakouts({ active: true, simulatedTimestamp: candles[2].time, candles }),
    /future candles/,
  );
  assert.deepEqual(
    observeReplayFalseBreakouts({ active: true, simulatedTimestamp: candles[3].time, candles }, { lookback: 3 }),
    [expected('upper', candles[3].time, 105)],
  );
});

test('observer does not mutate candle objects or their order', () => {
  const source = [candle(0), candle(1), candle(2), candle(3, { high: 110, low: 90, close: 100 })];
  const snapshot = structuredClone(source);

  observeSameCandleFalseBreakouts(source, { lookback: 3 });

  assert.deepEqual(source, snapshot);
  assert.deepEqual(source.map(({ time }) => time), snapshot.map(({ time }) => time));
});

test('requires a positive integer lookback', () => {
  assert.throws(() => observeSameCandleFalseBreakouts([], { lookback: 0 }), /positive integer/);
  assert.throws(() => observeSameCandleFalseBreakouts([], { lookback: 1.5 }), /positive integer/);
});
