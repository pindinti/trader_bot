export const DEFAULT_FALSE_BREAKOUT_LOOKBACK = 20;

const OBSERVER = 'same-candle-false-breakout';
const DEFINITION_VERSION = '0.1';

function validateLookback(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError('False-breakout lookback must be a positive integer.');
  }
  return value;
}

function validateCandles(candles) {
  if (!Array.isArray(candles)) {
    throw new TypeError('False-breakout candles must be an array.');
  }

  let previousTime = -Infinity;
  for (const candle of candles) {
    const values = [candle?.open, candle?.high, candle?.low, candle?.close, candle?.volume, candle?.trades];
    if (
      !Number.isFinite(candle?.time)
      || candle.time <= previousTime
      || !values.every(Number.isFinite)
      || candle.high < Math.max(candle.open, candle.close, candle.low)
      || candle.low > Math.min(candle.open, candle.close, candle.high)
      || candle.volume <= 0
      || candle.trades <= 0
    ) {
      throw new TypeError('False-breakout candles must be chronological completed candles with valid OHLCV values.');
    }
    previousTime = candle.time;
  }
}

function observation(direction, candidate, referenceLevel, lookback) {
  return Object.freeze({
    observer: OBSERVER,
    definitionVersion: DEFINITION_VERSION,
    direction,
    candidateTimestamp: candidate.time,
    confirmationTimestamp: candidate.time,
    referenceLevel,
    lookback,
  });
}

/**
 * Experimental definition v0.1. Evaluates completed one-minute candles only.
 * Each candidate is compared with the preceding lookback candles, excluding
 * the candidate itself. Results describe price behavior, not trade signals.
 */
export function observeSameCandleFalseBreakouts(
  candles,
  { lookback = DEFAULT_FALSE_BREAKOUT_LOOKBACK } = {},
) {
  const validatedLookback = validateLookback(lookback);
  validateCandles(candles);

  const observations = [];
  for (let index = validatedLookback; index < candles.length; index += 1) {
    const candidate = candles[index];
    let upperReference = -Infinity;
    let lowerReference = Infinity;
    for (let referenceIndex = index - validatedLookback; referenceIndex < index; referenceIndex += 1) {
      upperReference = Math.max(upperReference, candles[referenceIndex].high);
      lowerReference = Math.min(lowerReference, candles[referenceIndex].low);
    }

    if (candidate.high > upperReference && candidate.close < upperReference) {
      observations.push(observation('upper', candidate, upperReference, validatedLookback));
    }
    if (candidate.low < lowerReference && candidate.close > lowerReference) {
      observations.push(observation('lower', candidate, lowerReference, validatedLookback));
    }
  }

  return Object.freeze(observations);
}

/**
 * Restricts the experimental observer to an active replay market view.
 */
export function observeReplayFalseBreakouts(
  marketView,
  config,
) {
  if (marketView?.active !== true) {
    throw new Error('False-breakout replay observation requires an active market view.');
  }
  if (!Number.isFinite(marketView.simulatedTimestamp) || !Array.isArray(marketView.candles)) {
    throw new TypeError('False-breakout replay market view is invalid.');
  }
  if (marketView.candles.some(({ time }) => time > marketView.simulatedTimestamp)) {
    throw new RangeError('False-breakout replay market view contains future candles.');
  }
  return observeSameCandleFalseBreakouts(marketView.candles, config);
}
