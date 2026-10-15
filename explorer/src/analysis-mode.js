export const ANALYSIS_MODE = Object.freeze({
  CREATE: 'create',
  EDIT: 'edit',
});

export function enterCreateAnalysisMode(state, { confirmDiscard = () => true } = {}) {
  if (!confirmDiscard()) return false;
  state.currentRecordId = null;
  return true;
}

export function enterEditAnalysisMode(state, recordId) {
  if (typeof recordId !== 'string' || !recordId.trim()) {
    throw new TypeError('A saved analysis id is required for edit mode');
  }
  state.currentRecordId = recordId;
}

export function captureAnalysisSaveIntent(state) {
  const recordId = state.currentRecordId ?? null;
  return Object.freeze({
    mode: recordId === null ? ANALYSIS_MODE.CREATE : ANALYSIS_MODE.EDIT,
    recordId,
  });
}
