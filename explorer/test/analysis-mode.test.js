import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANALYSIS_MODE,
  captureAnalysisSaveIntent,
  enterCreateAnalysisMode,
  enterEditAnalysisMode,
} from '../src/analysis-mode.js';

function createStore() {
  const records = new Map();
  const operations = [];
  let nextId = 1;
  return {
    records,
    operations,
    save(draft, intent) {
      if (intent.mode === ANALYSIS_MODE.CREATE) {
        const id = `analysis-${nextId++}`;
        records.set(id, { id, ...structuredClone(draft) });
        operations.push({ type: 'insert', id });
        return records.get(id);
      }
      const previous = records.get(intent.recordId);
      if (!previous) throw new Error('missing record');
      records.set(intent.recordId, { ...previous, ...structuredClone(draft) });
      operations.push({ type: 'update', id: intent.recordId });
      return records.get(intent.recordId);
    },
  };
}

function saveAndEnterEdit(state, store, draft) {
  const saved = store.save(draft, captureAnalysisSaveIntent(state));
  enterEditAnalysisMode(state, saved.id);
  return saved;
}

test('saving A then starting a new replay analysis inserts B without modifying A', () => {
  const selectionA = { startTimestamp: 100, endTimestamp: 160 };
  const drawingsA = [{ id: 'drawing-a' }];
  const state = {
    currentRecordId: null,
    replayPosition: 10,
    timeframe: 5,
    selection: selectionA,
    drawings: drawingsA,
  };
  const store = createStore();

  const savedA = saveAndEnterEdit(state, store, { setup: 'A' });
  const originalA = structuredClone(savedA);
  assert.equal(store.records.size, 1);

  const selectionB = { startTimestamp: 220, endTimestamp: 280 };
  const drawingsB = [{ id: 'drawing-b' }];
  Object.assign(state, { replayPosition: 24, selection: selectionB, drawings: drawingsB });
  assert.equal(enterCreateAnalysisMode(state), true);
  assert.equal(state.currentRecordId, null);
  assert.equal(state.replayPosition, 24);
  assert.equal(state.timeframe, 5);
  assert.equal(state.selection, selectionB);
  assert.equal(state.drawings, drawingsB);

  const savedB = saveAndEnterEdit(state, store, { setup: 'B' });
  assert.notEqual(savedB.id, savedA.id);
  assert.equal(store.records.size, 2);
  assert.deepEqual(store.records.get(savedA.id), originalA);
  assert.deepEqual(store.operations, [
    { type: 'insert', id: savedA.id },
    { type: 'insert', id: savedB.id },
  ]);
});

test('explicit edit updates the opened record without changing record count', () => {
  const state = { currentRecordId: null };
  const store = createStore();
  const savedA = saveAndEnterEdit(state, store, { setup: 'A' });

  enterEditAnalysisMode(state, savedA.id);
  saveAndEnterEdit(state, store, { setup: 'A edited' });

  assert.equal(store.records.size, 1);
  assert.equal(store.records.get(savedA.id).setup, 'A edited');
  assert.deepEqual(store.operations.map(({ type }) => type), ['insert', 'update']);
});

test('starting new after opening an existing record inserts a distinct record', () => {
  const state = { currentRecordId: null };
  const store = createStore();
  const savedA = saveAndEnterEdit(state, store, { setup: 'A' });
  const originalA = structuredClone(savedA);

  enterEditAnalysisMode(state, savedA.id);
  enterCreateAnalysisMode(state);
  const savedB = saveAndEnterEdit(state, store, { setup: 'B' });

  assert.equal(store.records.size, 2);
  assert.notEqual(savedB.id, savedA.id);
  assert.deepEqual(store.records.get(savedA.id), originalA);
});

test('rejecting discard keeps edit identity and context untouched', () => {
  const selection = { startTimestamp: 100, endTimestamp: 160 };
  const drawings = [{ id: 'drawing-a' }];
  const state = { currentRecordId: 'analysis-a', replayPosition: 12, timeframe: 2, selection, drawings };

  assert.equal(enterCreateAnalysisMode(state, { confirmDiscard: () => false }), false);
  assert.deepEqual(state, {
    currentRecordId: 'analysis-a', replayPosition: 12, timeframe: 2, selection, drawings,
  });
});

test('confirming discard enters create mode without resetting replay research context', () => {
  const selection = { startTimestamp: 100, endTimestamp: 160 };
  const drawings = [{ id: 'drawing-a' }];
  const state = { currentRecordId: 'analysis-a', replayPosition: 12, timeframe: 2, selection, drawings };

  assert.equal(enterCreateAnalysisMode(state, { confirmDiscard: () => true }), true);
  assert.equal(state.currentRecordId, null);
  assert.equal(state.replayPosition, 12);
  assert.equal(state.timeframe, 2);
  assert.equal(state.selection, selection);
  assert.equal(state.drawings, drawings);
});
