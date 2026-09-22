import assert from 'node:assert/strict';
import test from 'node:test';

import { wallClockToTimestamp } from '../src/data.js';
import {
  exportResearchRecords,
  fromDatabaseRecord,
  researchFormDatetimeToTimestamp,
  toDatabaseRecord,
  validateResearchDraft,
} from '../src/research.js';

const validDraft = () => ({
  schemaVersion: 1,
  contract: 'WDOV26',
  tradingDate: '2026-09-21',
  timeframeMinutes: 5,
  startTimestamp: 1000,
  endTimestamp: 1300,
  analysisCutoffTimestamp: 1300,
  pattern: 'pullback',
  patternDetail: '',
  direction: 'long',
  marketContext: 'uptrend',
  contextExplanation: 'Higher highs before the selected interval.',
  factors: [{ type: 'vwap', condition: 'Price reclaimed VWAP.', role: 'supporting', drawingIds: [] }],
  assessment: 'wait',
  assessmentExplanation: 'Wait for a close above the local high.',
  missingConfirmation: 'Strong close.',
  invalidationConditions: 'Loss of the zone.',
  candidateRule: '',
  researchStatus: 'observation',
  drawings: [{ schemaVersion: 1, id: 'h1', type: 'horizontal', anchors: [{ time: 1100, price: 5140.5 }] }],
});

test('validates required structured research fields', () => {
  assert.deepEqual(validateResearchDraft(validDraft()), []);
  const invalid = validDraft();
  invalid.assessmentExplanation = '';
  invalid.factors[0].condition = '';
  invalid.startTimestamp = 2000;
  assert.equal(validateResearchDraft(invalid).length, 4);
});

test('parses minute-precision research input without weakening exported candle parsing', () => {
  const input = '2026-09-21 13:47';
  assert.equal(researchFormDatetimeToTimestamp(input), Date.UTC(2026, 8, 21, 13, 47) / 1000);
  assert.equal(researchFormDatetimeToTimestamp('2026-09-21T13:47'), Date.UTC(2026, 8, 21, 13, 47) / 1000);
  assert.throws(() => wallClockToTimestamp(input), /Invalid exported datetime/);
});

test('requires candidate text for non-observation statuses', () => {
  const draft = validDraft();
  draft.researchStatus = 'candidate';
  assert.match(validateResearchDraft(draft).join(' '), /Candidate bot rule/);
});

test('requires at least one drawing for a new analysis', () => {
  const draft = validDraft();
  draft.drawings = [];
  assert.match(validateResearchDraft(draft).join(' '), /At least one drawing/);
});

test('maps records to and from database shape', () => {
  const database = toDatabaseRecord(validDraft());
  const restored = fromDatabaseRecord({ id: 'id', author_id: 'user', created_at: 'now', updated_at: 'now', ...database });
  assert.equal(database.analysis_cutoff_timestamp, 1300);
  assert.equal(restored.marketContext, 'uptrend');
  assert.deepEqual(restored.factors, validDraft().factors);
});

test('JSON export includes schema version and drawing geometry', () => {
  const draft = validDraft();
  draft.drawings = [{ schemaVersion: 1, id: 'h1', type: 'horizontal', anchors: [{ time: 1100, price: 5140.5 }] }];
  const output = exportResearchRecords([draft]);
  assert.equal(output.schemaVersion, 1);
  assert.deepEqual(output.records[0].drawings[0].anchors[0], { time: 1100, price: 5140.5 });
});
