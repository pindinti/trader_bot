export const SUPPORTED_TIMEFRAMES = Object.freeze([1, 5, 10, 15, 30, 60]);

/**
 * Aggregate chronologically ordered one-minute candles into wall-clock buckets.
 * Buckets align to exact multiples of the selected interval from 00:00.
 * Missing source minutes remain missing; no candles are synthesized.
 */
export function aggregateCandles(candles, intervalMinutes) {
  if (!SUPPORTED_TIMEFRAMES.includes(intervalMinutes)) {
    throw new RangeError(`Unsupported timeframe: ${intervalMinutes}`);
  }
  if (intervalMinutes === 1) {
    return candles.map((candle) => ({ ...candle }));
  }

  const bucketSeconds = intervalMinutes * 60;
  const output = [];
  let current = null;
  let previousTime = -Infinity;

  for (const candle of candles) {
    if (!Number.isFinite(candle.time) || candle.time <= previousTime) {
      throw new TypeError('Candles must have unique, increasing numeric timestamps');
    }
    previousTime = candle.time;
    const bucketTime = Math.floor(candle.time / bucketSeconds) * bucketSeconds;

    if (!current || current.time !== bucketTime) {
      current = {
        time: bucketTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        trades: candle.trades,
      };
      output.push(current);
      continue;
    }

    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    current.volume += candle.volume;
    current.trades += candle.trades;
  }

  return output;
}
