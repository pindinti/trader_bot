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

export function candleSessionKey(contract, date) {
  if (typeof contract !== 'string' || !contract || typeof date !== 'string' || !date) {
    throw new TypeError('Contract and date are required for a candle cache key');
  }
  return `${contract}:${date}`;
}

export function createAuthenticatedDayCache({ sessions, download }) {
  const byKey = new Map(sessions.map((session) => [candleSessionKey(session.contract, session.date), session]));
  if (byKey.size !== sessions.length) throw new TypeError('Candle cache sessions must have unique contract/date identities');
  const cache = new Map();

  function load(contract, date) {
    const key = candleSessionKey(contract, date);
    const entry = byKey.get(key);
    if (!entry) return Promise.reject(new Error(`O pregão ${date} não está no manifesto de ${contract}.`));
    if (!cache.has(key)) {
      cache.set(key, Promise.resolve(download(entry.file))
        .then((payload) => parseDayPayload(payload, contract, date))
        .catch((error) => {
          cache.delete(key);
          throw error;
        }));
    }
    return cache.get(key);
  }

  return { load, clear: () => cache.clear(), has: (contract, date) => cache.has(candleSessionKey(contract, date)) };
}

export async function loadWarmupSessions({ entries, currentContract, currentDate, timeframe, requiredBars = 0, baselineSessions = 1, loadDay }) {
  if (!Number.isInteger(requiredBars) || requiredBars < 0) throw new TypeError('Required bars must be a non-negative integer');
  if (!Number.isInteger(baselineSessions) || baselineSessions < 0) throw new TypeError('Baseline sessions must be a non-negative integer');
  const contractEntries = entries
    .filter(({ contract }) => contract === currentContract)
    .sort((left, right) => left.date.localeCompare(right.date));
  const currentIndex = contractEntries.findIndex(({ date }) => date === currentDate);
  if (currentIndex < 0) {
    throw new Error(`O pregão ${currentContract} em ${currentDate} não está no manifesto.`);
  }
  const precedingEntries = contractEntries.slice(0, currentIndex).reverse();

  const reverseChronological = [];
  let completedBars = 0;
  for (const entry of precedingEntries) {
    if (reverseChronological.length >= baselineSessions && completedBars >= requiredBars) break;
    const candles = await loadDay(entry);
    reverseChronological.push({ contract: entry.contract, date: entry.date, candles });
    completedBars += aggregateCompletedSession(candles, timeframe).length;
  }
  return reverseChronological.reverse();
}
