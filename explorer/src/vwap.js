function sessionKey(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

/** Exact session VWAP from cancellation-resolved trade notional and quantity. */
export function calculateSessionVwap(candles) {
  const output = [];
  let currentSession = null;
  let cumulativeNotional = 0;
  let cumulativeVolume = 0;
  let previousTime = -Infinity;

  for (const candle of candles) {
    if (
      !Number.isFinite(candle?.time) || candle.time <= previousTime
      || !Number.isFinite(candle?.notional) || candle.notional <= 0
      || !Number.isFinite(candle?.volume) || candle.volume <= 0
    ) {
      throw new TypeError('VWAP requires increasing candles with exact positive notional and volume.');
    }
    previousTime = candle.time;
    const day = sessionKey(candle.time);
    if (day !== currentSession) {
      currentSession = day;
      cumulativeNotional = 0;
      cumulativeVolume = 0;
    }
    cumulativeNotional += candle.notional;
    cumulativeVolume += candle.volume;
    output.push({ time: candle.time, value: cumulativeNotional / cumulativeVolume });
  }
  return output;
}

export function hasExactVwap(candles) {
  return candles.length > 0 && candles.every((candle) => (
    Number.isFinite(candle.notional) && candle.notional > 0
    && Number.isFinite(candle.volume) && candle.volume > 0
  ));
}
