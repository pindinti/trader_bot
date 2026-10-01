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
  if (![1, 2].includes(manifest?.schemaVersion) || manifest?.sourceTimeframeMinutes !== 1 || !Array.isArray(manifest.contracts)) {
    throw new TypeError('Manifesto de dados incompatível. Execute novamente o exportador.');
  }
  const contract = manifest.contracts[0];
  if (!contract?.symbol || !Array.isArray(contract.dates)) {
    throw new TypeError('Manifesto não contém contratos exportados.');
  }
  const seenDates = new Set();
  for (const entry of contract.dates) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(entry?.date)
      || seenDates.has(entry.date)
      || entry.file !== `${contract.symbol}/${entry.date}.json`
    ) {
      throw new TypeError('Manifesto contém uma referência diária inválida.');
    }
    validateCandleObjectPath(entry.file);
    seenDates.add(entry.date);
  }
  return contract;
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
