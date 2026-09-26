export const MOVING_AVERAGE_PERIODS = Object.freeze([9, 21, 200]);
export const MOVING_AVERAGE_TYPES = Object.freeze(['sma', 'ema']);

function validatePeriod(period) {
  if (!MOVING_AVERAGE_PERIODS.includes(period)) {
    throw new RangeError(`Unsupported moving-average period: ${period}`);
  }
}

function closes(candles) {
  let previousTime = -Infinity;
  return candles.map((candle) => {
    if (!Number.isFinite(candle?.time) || candle.time <= previousTime || !Number.isFinite(candle?.close)) {
      throw new TypeError('Moving-average candles must have increasing timestamps and numeric closes.');
    }
    previousTime = candle.time;
    return candle.close;
  });
}

export function calculateSma(candles, period) {
  validatePeriod(period);
  const values = closes(candles);
  if (values.length < period) return [];
  const output = [];
  let sum = values.slice(0, period).reduce((total, value) => total + value, 0);
  output.push({ time: candles[period - 1].time, value: sum / period });
  for (let index = period; index < values.length; index += 1) {
    sum += values[index] - values[index - period];
    output.push({ time: candles[index].time, value: sum / period });
  }
  return output;
}

export function calculateEma(candles, period) {
  validatePeriod(period);
  const values = closes(candles);
  if (values.length < period) return [];
  const alpha = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((total, value) => total + value, 0) / period;
  const output = [{ time: candles[period - 1].time, value: ema }];
  for (let index = period; index < values.length; index += 1) {
    ema = alpha * values[index] + (1 - alpha) * ema;
    output.push({ time: candles[index].time, value: ema });
  }
  return output;
}

export function movingAverageKey(type, period) {
  if (!MOVING_AVERAGE_TYPES.includes(type)) throw new RangeError(`Unsupported moving-average type: ${type}`);
  validatePeriod(period);
  return `${type}-${period}`;
}

export function calculateMovingAverages(candles, enabledKeys) {
  return Object.fromEntries([...enabledKeys].map((key) => {
    const match = /^(sma|ema)-(9|21|200)$/.exec(key);
    if (!match) throw new RangeError(`Unsupported moving average: ${key}`);
    const [, type, periodText] = match;
    const period = Number(periodText);
    return [key, type === 'sma' ? calculateSma(candles, period) : calculateEma(candles, period)];
  }));
}

export function largestMovingAveragePeriod(enabledKeys) {
  return Math.max(0, ...[...enabledKeys].map((key) => {
    const match = /^(?:sma|ema)-(9|21|200)$/.exec(key);
    if (!match) throw new RangeError(`Unsupported moving average: ${key}`);
    return Number(match[1]);
  }));
}
