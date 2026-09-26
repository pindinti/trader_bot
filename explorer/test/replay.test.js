import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateCompletedReplayCandles,
  createCandleReplay,
} from '../src/replay.js';
import { SUPPORTED_TIMEFRAMES } from '../src/aggregate.js';

const START = Date.UTC(2026, 8, 21, 10, 30) / 1000;

function candle(index, overrides = {}) {
  const open = 5300 + index;
  return {
    time: START + index * 60,
    open,
    high: open + 2,
    low: open - 1,
    close: open + 1,
    volume: 10 + index,
    trades: 2 + index,
    ...overrides,
  };
}

test('steps forward and backward without crossing replay boundaries', () => {
  const replay = createCandleReplay();
  replay.load([candle(0), candle(1), candle(2)]);

  assert.equal(replay.enter(), true);
  assert.deepEqual(replay.getState(), {
    active: true,
    playing: false,
    position: 0,
    total: 3,
    stepMinutes: 1,
    atStart: true,
    atEnd: false,
    simulatedTimestamp: START,
  });
  assert.equal(replay.previous(), false);
  assert.equal(replay.next(), true);
  assert.equal(replay.getState().position, 1);
  assert.equal(replay.previous(), true);
  assert.equal(replay.getState().position, 0);
  assert.equal(replay.next(), true);
  assert.equal(replay.next(), true);
  assert.equal(replay.next(), false);
  assert.equal(replay.getState().position, 2);
});

test('play advances one candle per tick and pauses automatically at the end', () => {
  let callback;
  const cleared = [];
  const replay = createCandleReplay({
    setIntervalFn: (next) => {
      callback = next;
      return 42;
    },
    clearIntervalFn: (timer) => cleared.push(timer),
  });
  replay.load([candle(0), candle(1), candle(2)]);
  replay.enter();

  assert.equal(replay.play(), true);
  assert.equal(replay.getState().playing, true);
  callback();
  assert.equal(replay.getState().position, 1);
  assert.equal(replay.getState().playing, true);
  callback();
  assert.equal(replay.getState().position, 2);
  assert.equal(replay.getState().playing, false);
  assert.deepEqual(cleared, [42]);
});

test('loading another day resets replay state and stops playback', () => {
  const cleared = [];
  const replay = createCandleReplay({
    setIntervalFn: () => 7,
    clearIntervalFn: (timer) => cleared.push(timer),
  });
  replay.load([candle(0), candle(1)]);
  replay.enter();
  replay.play();

  const nextDay = [candle(0, { time: START + 86400 })];
  replay.load(nextDay);

  assert.deepEqual(replay.getState(), {
    active: false,
    playing: false,
    position: 0,
    total: 1,
    stepMinutes: 1,
    atStart: true,
    atEnd: true,
    simulatedTimestamp: null,
  });
  assert.deepEqual(cleared, [7]);
  assert.equal(replay.getMarketView().candles[0].time, START + 86400);
});

test('market view exposes only the available prefix and does not mutate its source', () => {
  const source = [candle(0), candle(1), candle(2)];
  const snapshot = structuredClone(source);
  const replay = createCandleReplay();
  replay.load(source);
  replay.enter();
  replay.next();

  const view = replay.getMarketView();
  assert.deepEqual(view.candles.map(({ time }) => time), [START, START + 60]);
  assert.equal(view.simulatedTimestamp, START + 60);
  assert.deepEqual(source, snapshot);
  assert.throws(() => view.candles.push(candle(3)), TypeError);
  assert.throws(() => {
    view.candles[0].close = 0;
  }, TypeError);
});

test('higher timeframes omit the current incomplete replay bucket', () => {
  const prefixAt1034 = Array.from({ length: 5 }, (_, index) => candle(index));
  assert.deepEqual(
    aggregateCompletedReplayCandles(prefixAt1034, 5, START + 4 * 60),
    [{
      time: START,
      open: 5300,
      high: 5306,
      low: 5299,
      close: 5305,
      volume: 60,
      trades: 20,
    }],
  );

  const prefixAt1036 = Array.from({ length: 7 }, (_, index) => candle(index));
  assert.equal(
    aggregateCompletedReplayCandles(prefixAt1036, 5, START + 6 * 60).length,
    1,
  );
  assert.equal(
    aggregateCompletedReplayCandles(prefixAt1036, 1, START + 6 * 60).length,
    7,
  );
});

test('dispose clears a running timer and protected replay data', () => {
  const cleared = [];
  const replay = createCandleReplay({
    setIntervalFn: () => 99,
    clearIntervalFn: (timer) => cleared.push(timer),
  });
  replay.load([candle(0), candle(1)]);
  replay.enter();
  replay.play();
  replay.dispose();

  assert.deepEqual(cleared, [99]);
  assert.equal(replay.getMarketView().candles.length, 0);
  assert.equal(replay.getState().active, false);
});

test('manual stepping and playback use every supported chart timeframe', () => {
  const source = Array.from({ length: 121 }, (_, index) => candle(index));

  for (const interval of SUPPORTED_TIMEFRAMES) {
    let tick;
    const replay = createCandleReplay({ setIntervalFn: (callback) => { tick = callback; return 1; } });
    replay.load(source);
    replay.setStepMinutes(interval);
    replay.enter();

    const bucketSeconds = interval * 60;
    const firstCompletion = interval === 1
      ? START + 60
      : Math.floor(START / bucketSeconds) * bucketSeconds + bucketSeconds - 60;
    assert.equal(replay.next(), true, `${interval}m has a next completed step`);
    assert.equal(replay.getState().simulatedTimestamp, firstCompletion, `${interval}m next boundary`);
    assert.equal(replay.previous(), true, `${interval}m previous is symmetric`);
    assert.equal(replay.getState().simulatedTimestamp, START, `${interval}m returns to its origin`);

    assert.equal(replay.play(), true, `${interval}m playback starts`);
    tick();
    assert.equal(replay.getState().simulatedTimestamp, firstCompletion, `${interval}m playback uses the same step`);
    replay.dispose();
  }
});

test('changing timeframe at a non-aligned position rewinds to the last completed boundary', () => {
  const replay = createCandleReplay();
  replay.load(Array.from({ length: 20 }, (_, index) => candle(index)));
  replay.enter();
  Array.from({ length: 7 }).forEach(() => replay.next());
  assert.equal(replay.getState().simulatedTimestamp, START + 7 * 60);

  replay.setStepMinutes(5);
  assert.equal(replay.getState().simulatedTimestamp, START + 4 * 60);
  assert.equal(replay.next(), true);
  assert.equal(replay.getState().simulatedTimestamp, START + 9 * 60);
  assert.equal(replay.previous(), true);
  assert.equal(replay.getState().simulatedTimestamp, START + 4 * 60);
});

test('two-minute replay steps on aligned completed boundaries and rewinds symmetrically', () => {
  const replay = createCandleReplay();
  replay.load(Array.from({ length: 8 }, (_, index) => candle(index)));
  replay.enter();
  Array.from({ length: 4 }).forEach(() => replay.next());
  assert.equal(replay.getState().simulatedTimestamp, START + 4 * 60);

  replay.setStepMinutes(2);
  assert.equal(replay.getState().playing, false);
  assert.equal(replay.getState().simulatedTimestamp, START + 3 * 60);
  assert.equal(replay.next(), true);
  assert.equal(replay.getState().simulatedTimestamp, START + 5 * 60);
  assert.equal(replay.previous(), true);
  assert.equal(replay.getState().simulatedTimestamp, START + 3 * 60);
});

test('a partial final higher-timeframe bucket is not a replay step', () => {
  const replay = createCandleReplay();
  replay.load(Array.from({ length: 8 }, (_, index) => candle(index)));
  replay.setStepMinutes(5);
  replay.enter();

  assert.equal(replay.next(), true);
  assert.equal(replay.getState().simulatedTimestamp, START + 4 * 60);
  assert.equal(replay.getState().atEnd, true);
  assert.equal(replay.next(), false);
  assert.equal(replay.getMarketView().candles.length, 5);
  assert.equal(aggregateCompletedReplayCandles(
    replay.getMarketView().candles,
    5,
    replay.getState().simulatedTimestamp,
  ).length, 1);
});

test('restoring a replay snapshot exposes no candles after its timestamp', () => {
  const replay = createCandleReplay();
  replay.load(Array.from({ length: 20 }, (_, index) => candle(index)));
  replay.setStepMinutes(5);
  replay.restore({ simulatedTimestamp: START + 9 * 60, position: 9 });

  const view = replay.getMarketView();
  assert.equal(view.candles.length, 10);
  assert.equal(view.candles.at(-1).time, START + 9 * 60);
  assert.equal(view.candles.some(({ time }) => time > view.simulatedTimestamp), false);
});
