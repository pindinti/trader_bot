import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAnalysisRestorePlan, canAccessAnalysisHistory, canCreateAnalysis } from '../src/history.js';

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
    drawings: [drawing],
  };
  assert.deepEqual(buildAnalysisRestorePlan(record, ['2026-09-18', '2026-09-21']), {
    tradingDate: '2026-09-18',
    timeframeMinutes: 15,
    selection,
    drawings: [drawing],
  });
});
