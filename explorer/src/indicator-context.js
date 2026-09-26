import { parseDayPayload } from './data.js';
import { aggregateCompletedReplayCandles } from './replay.js';

export function aggregateCompletedSession(candles, timeframe) {
  if (!candles.length) return [];
  return aggregateCompletedReplayCandles(candles, timeframe, candles.at(-1).time);
}

export function buildChartContext({ priorSessions = [], selectedCandles, timeframe, simulatedTimestamp = null }) {
  const contextCandles = priorSessions.flatMap(({ candles }) => aggregateCompletedSession(candles, timeframe));
  const selected = selectedCandles.length
    ? aggregateCompletedReplayCandles(
      selectedCandles,
      timeframe,
      simulatedTimestamp ?? selectedCandles.at(-1).time,
    )
    : [];
  return {
    contextCandles,
    selectedCandles: selected,
    candles: [...contextCandles, ...selected],
  };
}

export function createAuthenticatedDayCache({ contract, entries, download }) {
  const byDate = new Map(entries.map((entry) => [entry.date, entry]));
  const cache = new Map();

  function load(date) {
    const entry = byDate.get(date);
    if (!entry) return Promise.reject(new Error(`O pregão ${date} não está no manifesto de ${contract}.`));
    if (!cache.has(date)) {
      cache.set(date, Promise.resolve(download(entry.file))
        .then((payload) => parseDayPayload(payload, contract, date))
        .catch((error) => {
          cache.delete(date);
          throw error;
        }));
    }
    return cache.get(date);
  }

  return { load, clear: () => cache.clear(), has: (date) => cache.has(date) };
}

export async function loadWarmupSessions({ entries, currentDate, timeframe, requiredBars, loadDay }) {
  if (!Number.isInteger(requiredBars) || requiredBars <= 0) return [];
  if (!entries.some(({ date }) => date === currentDate)) {
    throw new Error(`O pregão ${currentDate} não está no manifesto.`);
  }
  const precedingEntries = entries
    .filter(({ date }) => date < currentDate)
    .sort((left, right) => right.date.localeCompare(left.date));

  const reverseChronological = [];
  let completedBars = 0;
  for (const entry of precedingEntries) {
    if (completedBars >= requiredBars) break;
    const candles = await loadDay(entry.date);
    reverseChronological.push({ date: entry.date, candles });
    completedBars += aggregateCompletedSession(candles, timeframe).length;
  }
  return reverseChronological.reverse();
}
