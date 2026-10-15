import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDayPayload, resolvePublishedSession, validateManifest } from '../src/data.js';

const base = {
  sourceTimeframeMinutes: 1, contract: 'WDOV26', date: '2026-09-21',
};

const day = (contract, date) => ({
  date,
  file: `${contract}/${date}.json`,
  candles: 570,
  volume: 1000,
  notional: '5000000',
  trades: 500,
});

const manifest = (contracts) => ({ schemaVersion: 2, sourceTimeframeMinutes: 1, contracts });

test('single-contract manifests retain their published sessions', () => {
  const legacyManifest = manifest([{ symbol: 'WDOV26', dates: [day('WDOV26', '2026-09-29')] }]);
  legacyManifest.schemaVersion = 1;
  const validated = validateManifest(legacyManifest);
  assert.deepEqual(validated.sessions.map(({ contract, date, file }) => ({ contract, date, file })), [{
    contract: 'WDOV26', date: '2026-09-29', file: 'WDOV26/2026-09-29.json',
  }]);
});

test('multiple contracts produce one chronological published-session index regardless of contract order', () => {
  const contracts = [
    { symbol: 'WDOX26', dates: [day('WDOX26', '2026-10-01'), day('WDOX26', '2026-09-30')] },
    { symbol: 'WDOV26', dates: [day('WDOV26', '2026-09-29')] },
  ];
  const chronological = validateManifest(manifest(contracts)).sessions;
  const reversed = validateManifest(manifest([...contracts].reverse())).sessions;
  const identities = (sessions) => sessions.map(({ contract, date }) => `${date}:${contract}`);
  assert.deepEqual(identities(chronological), [
    '2026-09-29:WDOV26', '2026-09-30:WDOX26', '2026-10-01:WDOX26',
  ]);
  assert.deepEqual(identities(reversed), identities(chronological));
  assert.equal(resolvePublishedSession(chronological, { date: '2026-09-29' }).contract, 'WDOV26');
  assert.equal(resolvePublishedSession(chronological, { date: '2026-09-30' }).contract, 'WDOX26');
  assert.throws(
    () => resolvePublishedSession(chronological, { contract: 'WDOV26', date: '2026-09-30' }),
    /não está disponível/,
  );
});

test('ambiguous dates, duplicate symbols, and malformed later contracts fail closed', () => {
  assert.throws(() => validateManifest(manifest([
    { symbol: 'WDOV26', dates: [day('WDOV26', '2026-09-30')] },
    { symbol: 'WDOX26', dates: [day('WDOX26', '2026-09-30')] },
  ])), /inválida ou ambígua/);
  assert.throws(() => validateManifest(manifest([
    { symbol: 'WDOV26', dates: [] }, { symbol: 'WDOV26', dates: [] },
  ])), /contrato duplicado/);
  assert.throws(() => validateManifest(manifest([
    { symbol: 'WDOV26', dates: [day('WDOV26', '2026-09-29')] },
    { symbol: 'WDOX26', dates: null },
  ])), /contratos exportados válidos/);
});

test('missing published dates are not synthesized', () => {
  const sessions = validateManifest(manifest([{ symbol: 'WDOX26', dates: [
    day('WDOX26', '2026-10-08'), day('WDOX26', '2026-10-13'),
  ] }])).sessions;
  assert.deepEqual(sessions.map(({ date }) => date), ['2026-10-08', '2026-10-13']);
  assert.throws(() => resolvePublishedSession(sessions, { date: '2026-10-09' }), /não está disponível/);
});

test('schema 2 daily payload carries exact trade notional into candle data', () => {
  const [candle] = parseDayPayload({
    ...base, schemaVersion: 2,
    columns: ['datetime', 'open', 'high', 'low', 'close', 'volume', 'notional', 'trades'],
    candles: [['2026-09-21 10:00:00', '10', '12', '9', '11', 5, '54', 3]],
  }, 'WDOV26', '2026-09-21');
  assert.equal(candle.notional, 54);
});

test('schema 1 remains readable but explicitly lacks exact VWAP notional', () => {
  const [candle] = parseDayPayload({
    ...base, schemaVersion: 1,
    columns: ['datetime', 'open', 'high', 'low', 'close', 'volume', 'trades'],
    candles: [['2026-09-21 10:00:00', '10', '12', '9', '11', 5, 3]],
  }, 'WDOV26', '2026-09-21');
  assert.equal(candle.notional, null);
});

test('daily payload contract or date mismatch fails closed', () => {
  const payload = {
    ...base, schemaVersion: 2,
    columns: ['datetime', 'open', 'high', 'low', 'close', 'volume', 'notional', 'trades'],
    candles: [['2026-09-21 10:00:00', '10', '12', '9', '11', 5, '54', 3]],
  };
  assert.throws(() => parseDayPayload(payload, 'WDOX26', payload.date), /incompatível/);
  assert.throws(() => parseDayPayload(payload, payload.contract, '2026-09-22'), /incompatível/);
});
