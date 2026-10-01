export function candleReference(candles, candle, timeframeMinutes) {
  if (!candle || !Array.isArray(candles)) return null;
  const session = new Date(candle.time * 1000).toISOString().slice(0, 10);
  let ordinal = 0;
  let found = false;
  for (const item of candles) {
    if (new Date(item.time * 1000).toISOString().slice(0, 10) === session) ordinal += 1;
    if (item.time === candle.time) {
      found = true;
      break;
    }
  }
  if (!found) return null;
  const time = new Date(candle.time * 1000).toISOString().slice(11, 16);
  return `Candle ${ordinal} · ${timeframeMinutes}m · ${time}`;
}
