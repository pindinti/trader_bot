import { serializeDrawings } from './drawings.js';
import { SUPPORTED_TIMEFRAMES } from './aggregate.js';

export const RESEARCH_SCHEMA_VERSION = 1;
export const PATTERNS = Object.freeze(['false_breakout', 'pullback', 'inside_bar', 'doji', 'other']);
export const DIRECTIONS = Object.freeze(['long', 'short', 'undetermined']);
export const MARKET_CONTEXTS = Object.freeze(['uptrend', 'downtrend', 'sideways', 'transition']);
export const FACTOR_ROLES = Object.freeze(['required', 'supporting', 'disqualifying', 'undetermined']);
export const ASSESSMENTS = Object.freeze(['consider', 'discard', 'wait', 'undetermined']);
export const RESEARCH_STATUSES = Object.freeze(['observation', 'candidate', 'clarification', 'review']);
export const ANALYSIS_TYPES = Object.freeze(['retrospective', 'replay']);
export const FACTOR_TYPES = Object.freeze(['vwap', 'ma21', 'ma200', 'fibonacci', 'support_resistance', 'higher_timeframe', 'candlestick', 'volume', 'other']);

const isText = (value) => typeof value === 'string';
const requiredText = (value, label, errors) => {
  if (!isText(value) || !value.trim()) errors.push(`${label} is required`);
};

export function captureAnalysisContext(replay) {
  if (!replay?.pause || !replay?.getState) throw new TypeError('Replay state is unavailable');
  replay.pause();
  const snapshot = replay.getState();
  return Object.freeze(snapshot.active
    ? {
      analysisType: 'replay',
      replayTimestamp: snapshot.simulatedTimestamp,
      replayPosition: snapshot.position,
    }
    : {
      analysisType: 'retrospective',
      replayTimestamp: null,
      replayPosition: null,
    });
}

export function researchFormDatetimeToTimestamp(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) {
    throw new TypeError(`Data/hora do corte inválida: ${text || 'vazia'}. Use AAAA-MM-DD HH:MM.`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '00'] = match;
  const parts = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const [year, month, day, hour, minute, second] = parts;
  const milliseconds = Date.UTC(year, month - 1, day, hour, minute, second);
  const parsed = new Date(milliseconds);
  if (
    parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day
    || parsed.getUTCHours() !== hour || parsed.getUTCMinutes() !== minute || parsed.getUTCSeconds() !== second
  ) {
    throw new TypeError(`Data/hora do corte inválida: ${text}. Revise a data e o horário.`);
  }
  return milliseconds / 1000;
}

export function validateResearchDraft(draft) {
  const errors = [];
  const analysisType = draft?.analysisType ?? 'retrospective';
  if (draft?.schemaVersion !== RESEARCH_SCHEMA_VERSION) errors.push('Unsupported research schema version');
  requiredText(draft?.contract, 'Contract', errors);
  requiredText(draft?.tradingDate, 'Trading date', errors);
  if (!SUPPORTED_TIMEFRAMES.includes(draft?.timeframeMinutes)) errors.push('A supported timeframe is required');
  if (!Number.isFinite(draft?.startTimestamp) || !Number.isFinite(draft?.endTimestamp) || draft.startTimestamp > draft.endTimestamp) {
    errors.push('A valid movement selection is required');
  }
  if (!Number.isFinite(draft?.analysisCutoffTimestamp) || draft.analysisCutoffTimestamp < draft.startTimestamp) {
    errors.push('Analysis cutoff must not precede the selected movement');
  }
  if (!ANALYSIS_TYPES.includes(analysisType)) errors.push('Analysis type is invalid');
  if (analysisType === 'replay') {
    if (!Number.isFinite(draft?.replayTimestamp)) errors.push('Replay timestamp is required');
    if (!Number.isInteger(draft?.replayPosition) || draft.replayPosition < 0) errors.push('Replay position is required');
    if (Number.isFinite(draft?.replayTimestamp)
      && (draft.endTimestamp > draft.replayTimestamp || draft.analysisCutoffTimestamp > draft.replayTimestamp)) {
      errors.push('Replay analysis cannot include a movement or cutoff beyond its snapshot');
    }
  } else if (draft?.replayTimestamp != null || draft?.replayPosition != null) {
    errors.push('Retrospective analysis cannot contain replay metadata');
  }
  if (!PATTERNS.includes(draft?.pattern)) errors.push('Primary pattern is required');
  if (draft?.pattern === 'other') requiredText(draft.patternDetail, 'Other pattern detail', errors);
  if (!DIRECTIONS.includes(draft?.direction)) errors.push('Direction is required');
  if (!MARKET_CONTEXTS.includes(draft?.marketContext)) errors.push('Market context is required');
  if (!Array.isArray(draft?.factors)) errors.push('Factors must be an array');
  else {
    const seen = new Set();
    draft.factors.forEach((factor, index) => {
      if (!FACTOR_TYPES.includes(factor?.type) || seen.has(factor.type)) errors.push(`Factor ${index + 1} is invalid or duplicated`);
      seen.add(factor?.type);
      requiredText(factor?.condition, `Factor ${index + 1} condition`, errors);
      if (!FACTOR_ROLES.includes(factor?.role)) errors.push(`Factor ${index + 1} role is required`);
      if (!Array.isArray(factor?.drawingIds)) errors.push(`Factor ${index + 1} drawing links must be an array`);
    });
  }
  if (!ASSESSMENTS.includes(draft?.assessment)) errors.push('Trader assessment is required');
  requiredText(draft?.assessmentExplanation, 'Assessment explanation', errors);
  if (!RESEARCH_STATUSES.includes(draft?.researchStatus)) errors.push('Research status is required');
  if (draft?.researchStatus !== 'observation') requiredText(draft?.candidateRule, 'Candidate bot rule', errors);
  if (!Array.isArray(draft?.drawings) || draft.drawings.length === 0) errors.push('At least one drawing is required');
  else try { serializeDrawings(draft.drawings); } catch (error) { errors.push(error.message); }
  return errors;
}

export function normalizeResearchDraft(draft) {
  const normalized = {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    contract: String(draft.contract).trim(),
    tradingDate: String(draft.tradingDate),
    timeframeMinutes: Number(draft.timeframeMinutes),
    startTimestamp: Math.round(draft.startTimestamp),
    endTimestamp: Math.round(draft.endTimestamp),
    analysisCutoffTimestamp: Math.round(draft.analysisCutoffTimestamp),
    analysisType: draft.analysisType ?? 'retrospective',
    replayTimestamp: draft.replayTimestamp == null ? null : Math.round(draft.replayTimestamp),
    replayPosition: draft.replayPosition == null ? null : Number(draft.replayPosition),
    pattern: draft.pattern,
    patternDetail: String(draft.patternDetail ?? '').trim(),
    direction: draft.direction,
    marketContext: draft.marketContext,
    contextExplanation: String(draft.contextExplanation ?? '').trim(),
    factors: (draft.factors ?? []).map((factor) => ({
      type: factor.type,
      condition: String(factor.condition ?? '').trim(),
      role: factor.role,
      drawingIds: [...(factor.drawingIds ?? [])],
    })),
    assessment: draft.assessment,
    assessmentExplanation: String(draft.assessmentExplanation ?? '').trim(),
    missingConfirmation: String(draft.missingConfirmation ?? '').trim(),
    invalidationConditions: String(draft.invalidationConditions ?? '').trim(),
    candidateRule: String(draft.candidateRule ?? '').trim(),
    researchStatus: draft.researchStatus,
    drawings: serializeDrawings(draft.drawings ?? []),
  };
  const errors = validateResearchDraft(normalized);
  if (errors.length) throw new TypeError(errors.join('; '));
  return normalized;
}

export function toDatabaseRecord(draft) {
  const item = normalizeResearchDraft(draft);
  return {
    schema_version: item.schemaVersion,
    contract: item.contract,
    trading_date: item.tradingDate,
    timeframe_minutes: item.timeframeMinutes,
    start_timestamp: item.startTimestamp,
    end_timestamp: item.endTimestamp,
    analysis_cutoff_timestamp: item.analysisCutoffTimestamp,
    analysis_type: item.analysisType,
    replay_timestamp: item.replayTimestamp,
    replay_position: item.replayPosition,
    pattern: item.pattern,
    pattern_detail: item.patternDetail,
    direction: item.direction,
    market_context: item.marketContext,
    context_explanation: item.contextExplanation,
    factors: item.factors,
    assessment: item.assessment,
    assessment_explanation: item.assessmentExplanation,
    missing_confirmation: item.missingConfirmation,
    invalidation_conditions: item.invalidationConditions,
    candidate_rule: item.candidateRule,
    research_status: item.researchStatus,
    drawings: item.drawings,
  };
}

export function fromDatabaseRecord(record) {
  return {
    id: record.id,
    authorId: record.author_id,
    author: record.author ?? null,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    schemaVersion: record.schema_version,
    contract: record.contract,
    tradingDate: record.trading_date,
    timeframeMinutes: record.timeframe_minutes,
    startTimestamp: Number(record.start_timestamp),
    endTimestamp: Number(record.end_timestamp),
    analysisCutoffTimestamp: Number(record.analysis_cutoff_timestamp),
    analysisType: record.analysis_type ?? 'retrospective',
    replayTimestamp: record.replay_timestamp == null ? null : Number(record.replay_timestamp),
    replayPosition: record.replay_position == null ? null : Number(record.replay_position),
    pattern: record.pattern,
    patternDetail: record.pattern_detail ?? '',
    direction: record.direction,
    marketContext: record.market_context,
    contextExplanation: record.context_explanation ?? '',
    factors: record.factors ?? [],
    assessment: record.assessment,
    assessmentExplanation: record.assessment_explanation,
    missingConfirmation: record.missing_confirmation ?? '',
    invalidationConditions: record.invalidation_conditions ?? '',
    candidateRule: record.candidate_rule ?? '',
    researchStatus: record.research_status,
    drawings: serializeDrawings(record.drawings ?? []),
  };
}

export function exportResearchRecords(records) {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    records: records.map((record) => ({ ...record, drawings: serializeDrawings(record.drawings ?? []) })),
  };
}
