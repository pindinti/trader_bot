import { validateCandleObjectPath } from './candle-storage.js';

const EXPECTED_COLUMNS = ['datetime', 'open', 'high', 'low', 'close', 'volume', 'trades'];

export function wallClockToTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new TypeError(`Invalid exported datetime: ${value}`);
  return Date.UTC(...match.slice(1).map((part, index) => Number(part) - (index === 1 ? 1 : 0))) / 1000;
}

export function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || manifest?.sourceTimeframeMinutes !== 1 || !Array.isArray(manifest.contracts)) {
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
  if (
    payload?.schemaVersion !== 1 ||
    payload?.sourceTimeframeMinutes !== 1 ||
    payload?.contract !== expectedContract ||
    payload?.date !== expectedDate ||
    JSON.stringify(payload?.columns) !== JSON.stringify(EXPECTED_COLUMNS) ||
    !Array.isArray(payload?.candles)
  ) {
    throw new TypeError('Arquivo diário incompatível com o Explorer.');
  }

  let previous = -Infinity;
  return payload.candles.map((row) => {
    if (!Array.isArray(row) || row.length !== EXPECTED_COLUMNS.length) {
      throw new TypeError('Linha de candle exportada é inválida.');
    }
    const [datetime, ...values] = row;
    const time = wallClockToTimestamp(datetime);
    const [open, high, low, close, volume, trades] = values.map(Number);
    if (
      time <= previous ||
      ![open, high, low, close, volume, trades].every(Number.isFinite) ||
      high < Math.max(open, close, low) ||
      low > Math.min(open, close, high) ||
      volume <= 0 || trades <= 0
    ) {
      throw new TypeError(`Candle exportado inválido em ${datetime}.`);
    }
    previous = time;
    return { time, open, high, low, close, volume, trades };
  });
}
