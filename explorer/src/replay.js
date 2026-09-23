import { SUPPORTED_TIMEFRAMES, aggregateCandles } from './aggregate.js';

const EMPTY_CANDLES = Object.freeze([]);

function stepPositions(candles, intervalMinutes) {
  if (!candles.length) return [];
  if (intervalMinutes === 1) return candles.map((_, index) => index);

  const bucketSeconds = intervalMinutes * 60;
  const bucketStarts = [...new Set(candles.map(
    ({ time }) => Math.floor(time / bucketSeconds) * bucketSeconds,
  ))];
  const positions = [0];
  let sourceIndex = 0;

  for (const bucketStart of bucketStarts) {
    const completionTime = bucketStart + bucketSeconds - 60;
    while (sourceIndex < candles.length && candles[sourceIndex].time < completionTime) {
      sourceIndex += 1;
    }
    if (sourceIndex < candles.length && positions.at(-1) !== sourceIndex) positions.push(sourceIndex);
  }

  return positions;
}

function copyCandles(candles) {
  if (!Array.isArray(candles)) {
    throw new TypeError('Replay candles must be an array.');
  }

  let previousTime = -Infinity;
  const copied = candles.map((candle) => {
    if (!Number.isFinite(candle?.time) || candle.time <= previousTime) {
      throw new TypeError('Replay candles must have unique, chronological timestamps.');
    }
    previousTime = candle.time;
    return Object.freeze({ ...candle });
  });

  return Object.freeze(copied);
}

/**
 * Aggregates only completed candles from the available 1-minute replay prefix.
 * A higher-timeframe bucket is complete when its clock-aligned closing boundary
 * is no later than the end of the current simulated 1-minute candle.
 */
export function aggregateCompletedReplayCandles(candles, intervalMinutes, simulatedTimestamp) {
  const aggregated = aggregateCandles(candles, intervalMinutes);
  if (intervalMinutes === 1) return aggregated;
  if (!Number.isFinite(simulatedTimestamp)) {
    throw new TypeError('Replay requires a valid simulated timestamp.');
  }

  const availableThrough = simulatedTimestamp + 60;
  return aggregated.filter(
    (candle) => candle.time + intervalMinutes * 60 <= availableThrough,
  );
}

/**
 * Owns simulated time and exposes a read-only market-data prefix. Future
 * detectors may consume getMarketView() without knowing about UI state.
 */
export function createCandleReplay({
  onChange = () => {},
  intervalMs = 700,
  setIntervalFn = (callback, delay) => globalThis.setInterval(callback, delay),
  clearIntervalFn = (timer) => globalThis.clearInterval(timer),
} = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError('Replay interval must be positive.');
  }

  let source = EMPTY_CANDLES;
  let active = false;
  let playing = false;
  let position = -1;
  let stepMinutes = 1;
  let stops = [];
  let timer = null;
  let disposed = false;

  function getState() {
    const previousPosition = [...stops].reverse().find((candidate) => candidate < position);
    const nextPosition = stops.find((candidate) => candidate > position);
    return Object.freeze({
      active,
      playing,
      position,
      total: source.length,
      stepMinutes,
      atStart: !active || previousPosition === undefined,
      atEnd: !active || nextPosition === undefined,
      simulatedTimestamp: active && position >= 0 ? source[position].time : null,
    });
  }

  function getMarketView() {
    const candles = active ? source.slice(0, position + 1) : [...source];
    return Object.freeze({
      active,
      simulatedTimestamp: active && position >= 0 ? source[position].time : null,
      candles: Object.freeze(candles),
    });
  }

  function notify() {
    if (!disposed) onChange(getState());
  }

  function stopTimer() {
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
    playing = false;
  }

  function advance() {
    const target = stops.find((candidate) => candidate > position);
    if (!active || target === undefined) {
      stopTimer();
      notify();
      return false;
    }

    position = target;
    if (!stops.some((candidate) => candidate > position)) stopTimer();
    notify();
    return true;
  }

  function load(candles) {
    stopTimer();
    source = copyCandles(candles);
    stops = stepPositions(source, stepMinutes);
    active = false;
    position = source.length - 1;
    notify();
  }

  function enter() {
    if (disposed || source.length === 0) return false;
    stopTimer();
    active = true;
    position = 0;
    notify();
    return true;
  }

  function restore({ simulatedTimestamp, position: savedPosition = null }) {
    if (disposed || !Number.isFinite(simulatedTimestamp)) {
      throw new TypeError('Replay restoration requires a valid simulated timestamp.');
    }
    let target = Number.isInteger(savedPosition) && savedPosition >= 0
      && source[savedPosition]?.time === simulatedTimestamp
      ? savedPosition
      : source.findIndex(({ time }) => time === simulatedTimestamp);
    if (target < 0) throw new RangeError('The saved replay timestamp is not available in this trading day.');
    if (!stops.includes(target)) {
      throw new RangeError('The saved replay timestamp is not a completed step for this timeframe.');
    }
    stopTimer();
    active = true;
    position = target;
    notify();
  }

  function exit() {
    stopTimer();
    active = false;
    position = source.length - 1;
    notify();
  }

  function next() {
    if (!active) return false;
    stopTimer();
    return advance();
  }

  function previous() {
    if (!active) return false;
    stopTimer();
    const target = [...stops].reverse().find((candidate) => candidate < position);
    if (target === undefined) {
      notify();
      return false;
    }
    position = target;
    notify();
    return true;
  }

  function play() {
    if (!active || playing || !stops.some((candidate) => candidate > position)) return false;
    playing = true;
    timer = setIntervalFn(advance, intervalMs);
    notify();
    return true;
  }

  function pause() {
    if (!playing && timer === null) return false;
    stopTimer();
    notify();
    return true;
  }

  function setStepMinutes(intervalMinutes) {
    if (!SUPPORTED_TIMEFRAMES.includes(intervalMinutes)) {
      throw new RangeError(`Unsupported replay timeframe: ${intervalMinutes}`);
    }
    stopTimer();
    stepMinutes = intervalMinutes;
    stops = stepPositions(source, stepMinutes);
    if (active) {
      position = [...stops].reverse().find((candidate) => candidate <= position) ?? 0;
    }
    notify();
  }

  function dispose() {
    stopTimer();
    source = EMPTY_CANDLES;
    stops = [];
    active = false;
    position = -1;
    disposed = true;
  }

  return {
    dispose,
    enter,
    exit,
    getMarketView,
    getState,
    load,
    next,
    pause,
    play,
    previous,
    restore,
    setStepMinutes,
  };
}
