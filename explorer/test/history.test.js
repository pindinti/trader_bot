import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAnalysisRestorePlan,
  canAccessAnalysisHistory,
  canCreateAnalysis,
  deleteOwnedAnalysis,
  filterAnalysisHistory,
  historyCardData,
  marketContextLabel,
} from '../src/history.js';

const selection = { startTimestamp: 1000, endTimestamp: 1300 };
const drawing = { schemaVersion: 1, id: 'h1', type: 'horizontal', anchors: [{ time: 1100, price: 5140.5 }] };

test('authorized history access does not depend on movement selection or drawings', () => {
  assert.equal(canAccessAnalysisHistory({ user_id: 'member-1' }), true);
  assert.equal(canCreateAnalysis(null, []), false);
  assert.equal(canAccessAnalysisHistory(null), false);
});

test('new analysis requires both a selected movement and at least one drawing', () => {
  assert.equal(canCreateAnalysis(selection, []), false);
  assert.equal(canCreateAnalysis(null, [drawing]), false);
  assert.equal(canCreateAnalysis(selection, [drawing]), true);
});

test('opening saved analysis restores date, timeframe, interval, and drawings', () => {
  const record = {
    id: 'analysis-1',
    tradingDate: '2026-09-18',
    timeframeMinutes: 15,
    startTimestamp: 1000,
    endTimestamp: 1300,
    analysisCutoffTimestamp: 1300,
    drawings: [drawing],
  };
  assert.deepEqual(buildAnalysisRestorePlan(record, ['2026-09-18', '2026-09-21']), {
    analysisType: 'retrospective',
    tradingDate: '2026-09-18',
    timeframeMinutes: 15,
    selection,
    drawings: [{ ...drawing, lineWidth: 1.25, color: '#75a88e' }],
    replay: null,
  });
});

test('opening a replay analysis includes its deterministic restoration snapshot', () => {
  const record = {
    id: 'analysis-replay',
    analysisType: 'replay',
    tradingDate: '2026-09-21',
    timeframeMinutes: 5,
    startTimestamp: 1000,
    endTimestamp: 1300,
    analysisCutoffTimestamp: 1300,
    replayTimestamp: 1600,
    replayPosition: 10,
    drawings: [drawing],
  };
  assert.deepEqual(buildAnalysisRestorePlan(record, ['2026-09-21']).replay, {
    simulatedTimestamp: 1600,
    position: 10,
  });
});

test('two-minute analyses are valid restoration targets', () => {
  const plan = buildAnalysisRestorePlan({
    id: 'analysis-2m', tradingDate: '2026-09-21', timeframeMinutes: 2,
    startTimestamp: 1000, endTimestamp: 1060, analysisCutoffTimestamp: 1060, drawings: [drawing],
  }, ['2026-09-21']);
  assert.equal(plan.timeframeMinutes, 2);
});

test('history renders market context safely and search is accent/case insensitive without reordering', () => {
  const records = [
    { id: 'first', tradingDate: '2026-09-21', marketContext: 'uptrend', contextExplanation: 'Média ascendente', pattern: 'pullback', direction: 'long', researchStatus: 'candidate', candidateRule: 'Recuo curto', trigger: 'Fechamento acima da máxima' },
    { id: 'second', tradingDate: '2026-09-18', pattern: 'false_breakout', direction: 'short', researchStatus: 'observation', assessmentExplanation: 'Rompimento rejeitado' },
    { id: 'third', tradingDate: '2026-09-17', marketContext: 'sideways', pattern: 'doji', direction: 'undetermined', researchStatus: 'review' },
  ];
  assert.equal(marketContextLabel(records[0]), 'Tendência de alta');
  assert.equal(marketContextLabel(records[1]), 'Contexto não informado');
  assert.deepEqual(filterAnalysisHistory(records, '  MEDIA  ').map(({ id }) => id), ['first']);
  assert.deepEqual(filterAnalysisHistory(records, 'rompimento').map(({ id }) => id), ['second']);
  assert.deepEqual(filterAnalysisHistory(records, 'lateralizacao').map(({ id }) => id), ['third']);
  assert.deepEqual(filterAnalysisHistory(records, 'fechamento acima').map(({ id }) => id), ['first']);
  assert.deepEqual(filterAnalysisHistory(records, 'recuo curto').map(({ id }) => id), []);
  assert.deepEqual(filterAnalysisHistory(records, 'pronta revisao').map(({ id }) => id), []);
  assert.deepEqual(filterAnalysisHistory(records, '  ').map(({ id }) => id), ['first', 'second', 'third']);
});

test('history card data prioritizes setup, context, contract interval, date, and timeframe', () => {
  assert.deepEqual(historyCardData({
    pattern: 'inside_bar', marketContext: 'uptrend', contextExplanation: 'MM21 como suporte',
    contract: 'WDOV26', startTimestamp: Date.UTC(2026, 8, 24, 11, 34) / 1000,
    endTimestamp: Date.UTC(2026, 8, 24, 11, 46) / 1000, tradingDate: '2026-09-24', timeframeMinutes: 2,
  }), {
    setup: 'Inside bar', context: 'Tendência de alta', contextExplanation: 'MM21 como suporte',
    contractInterval: 'WDOV26 · 11:34–11:46', dateTimeframe: '24/09/2026 · 2m',
  });
});

test('analysis deletion requires ownership, confirmation, and propagates failures', async () => {
  const calls = [];
  const record = { id: 'analysis-1', authorId: 'owner' };
  assert.equal(await deleteOwnedAnalysis({ record, userId: 'owner', confirmDelete: () => false, deleteRecord: () => calls.push('delete') }), false);
  assert.deepEqual(calls, []);
  assert.equal(await deleteOwnedAnalysis({ record, userId: 'owner', confirmDelete: () => true, deleteRecord: async (id) => calls.push(id) }), true);
  assert.deepEqual(calls, ['analysis-1']);
  await assert.rejects(() => deleteOwnedAnalysis({ record, userId: 'other', confirmDelete: () => true, deleteRecord: async () => {} }), /Somente o autor/);
  await assert.rejects(() => deleteOwnedAnalysis({ record, userId: 'owner', confirmDelete: () => true, deleteRecord: async () => { throw new Error('RLS denied'); } }), /RLS denied/);
});
