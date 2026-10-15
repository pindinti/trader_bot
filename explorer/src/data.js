import { validateCandleObjectPath } from './candle-storage.js';

const CANDLE_COLUMNS = Object.freeze({
  1: ['datetime', 'open', 'high', 'low', 'close', 'volume', 'trades'],
  2: ['datetime', 'open', 'high', 'low', 'close', 'volume', 'notional', 'trades'],
});

export function wallClockToTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new TypeError(`Invalid exported datetime: ${value}`);
  return Date.UTC(...match.slice(1).map((part, index) => Number(part) - (index === 1 ? 1 : 0))) / 1000;
}

export function validateManifest(manifest) {
  if (
    ![1, 2].includes(manifest?.schemaVersion)
    || manifest?.sourceTimeframeMinutes !== 1
    || !Array.isArray(manifest.contracts)
    || manifest.contracts.length === 0
  ) {
    throw new TypeError('Manifesto de dados incompatível. Execute novamente o exportador.');
  }
  const contracts = [];
  const sessions = [];
  const seenContracts = new Set();
  const seenDates = new Set();
  for (const contract of manifest.contracts) {
    const symbol = contract?.symbol;
    if (typeof symbol !== 'string' || !/^[A-Z0-9]+$/.test(symbol) || !Array.isArray(contract.dates)) {
      throw new TypeError('Manifesto não contém contratos exportados válidos.');
    }
    if (seenContracts.has(symbol)) throw new TypeError(`Manifesto contém contrato duplicado: ${symbol}.`);
    seenContracts.add(symbol);
    const dates = [];
    for (const entry of contract.dates) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(entry?.date)
        || !isCalendarDate(entry.date)
        || seenDates.has(entry.date)
        || entry.file !== `${symbol}/${entry.date}.json`
      ) {
        throw new TypeError('Manifesto contém uma referência diária inválida ou ambígua.');
      }
      validateCandleObjectPath(entry.file);
      const session = Object.freeze({ ...entry, contract: symbol });
      dates.push(session);
      sessions.push(session);
      seenDates.add(entry.date);
    }
    contracts.push(Object.freeze({ symbol, dates: Object.freeze(dates) }));
  }
  sessions.sort((left, right) => left.date.localeCompare(right.date));
  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    sourceTimeframeMinutes: manifest.sourceTimeframeMinutes,
    contracts: Object.freeze(contracts),
    sessions: Object.freeze(sessions),
  });
}

function isCalendarDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function resolvePublishedSession(sessions, { contract = null, date }) {
  if (!Array.isArray(sessions) || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
    throw new TypeError('Referência de pregão inválida.');
  }
  const matches = sessions.filter((session) => (
    session.date === date && (contract === null || session.contract === contract)
  ));
  if (matches.length !== 1) {
    const identity = contract ? `${contract} em ${date}` : date;
    throw new TypeError(`O pregão ${identity} não está disponível de forma inequívoca no Explorer.`);
  }
  return matches[0];
}

export function parseDayPayload(payload, expectedContract, expectedDate) {
  const expectedColumns = CANDLE_COLUMNS[payload?.schemaVersion];
  if (
    !expectedColumns ||
    payload?.sourceTimeframeMinutes !== 1 ||
    payload?.contract !== expectedContract ||
    payload?.date !== expectedDate ||
    JSON.stringify(payload?.columns) !== JSON.stringify(expectedColumns) ||
    !Array.isArray(payload?.candles)
  ) {
    throw new TypeError('Arquivo diário incompatível com o Explorer.');
  }

  let previous = -Infinity;
  return payload.candles.map((row) => {
    if (!Array.isArray(row) || row.length !== expectedColumns.length) {
      throw new TypeError('Linha de candle exportada é inválida.');
    }
    const [datetime, ...values] = row;
    const time = wallClockToTimestamp(datetime);
    const numeric = values.map(Number);
    const [open, high, low, close, volume] = numeric;
    const notional = payload.schemaVersion === 2 ? numeric[5] : null;
    const trades = numeric[payload.schemaVersion === 2 ? 6 : 5];
    if (
      time <= previous ||
      ![open, high, low, close, volume, trades].every(Number.isFinite) ||
      (payload.schemaVersion === 2 && (!Number.isFinite(notional) || notional <= 0)) ||
      high < Math.max(open, close, low) ||
      low > Math.min(open, close, high) ||
      volume <= 0 || trades <= 0
    ) {
      throw new TypeError(`Candle exportado inválido em ${datetime}.`);
    }
    previous = time;
    return { time, open, high, low, close, volume, notional, trades };
  });
}
