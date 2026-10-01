import { serializeDrawings } from './drawings.js';
import { SUPPORTED_TIMEFRAMES } from './aggregate.js';

export const PATTERN_LABELS = Object.freeze({
  false_breakout: 'Falso rompimento', pullback: 'Pullback', inside_bar: 'Inside bar', doji: 'Doji', other: 'Outro / combinação',
});
export const DIRECTION_LABELS = Object.freeze({ long: 'Compra', short: 'Venda', undetermined: 'Indeterminada' });
export const MARKET_CONTEXT_LABELS = Object.freeze({
  uptrend: 'Tendência de alta', downtrend: 'Tendência de baixa', sideways: 'Lateralização', transition: 'Transição / indefinido',
});
export const ASSESSMENT_LABELS = Object.freeze({
  trade_taken: 'Trade feito', trade_not_taken: 'Trade não feito', consider: 'Considerar operação', discard: 'Descartar',
  wait: 'Aguardar confirmação (legado)', undetermined: 'Indeterminado (legado)',
});

export function normalizeHistorySearch(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim()
    .replace(/\s+/g, ' ');
}

export function marketContextLabel(record) {
  return MARKET_CONTEXT_LABELS[record?.marketContext] ?? 'Contexto não informado';
}

function searchableDate(record) {
  const day = String(record?.tradingDate ?? '');
  return `${day} ${day.split('-').reverse().join('/')}`;
}

function searchableTimestamp(timestamp) {
  if (!Number.isFinite(timestamp)) return '';
  const iso = new Date(timestamp * 1000).toISOString();
  return `${iso.slice(0, 16).replace('T', ' ')} ${iso.slice(0, 10).split('-').reverse().join('/')} ${iso.slice(11, 16)}`;
}

export function filterAnalysisHistory(records, query) {
  const needle = normalizeHistorySearch(query);
  if (!needle) return [...records];
  return records.filter((record) => normalizeHistorySearch([
    searchableDate(record),
    record.contract,
    record.analysisType, record.analysisType === 'replay' ? 'Análise em replay' : 'Análise retrospectiva',
    searchableTimestamp(record.replayTimestamp), searchableTimestamp(record.startTimestamp),
    searchableTimestamp(record.endTimestamp), searchableTimestamp(record.analysisCutoffTimestamp),
    record.pattern, PATTERN_LABELS[record.pattern], record.patternDetail,
    record.direction, DIRECTION_LABELS[record.direction],
    record.marketContext, marketContextLabel(record), record.contextExplanation,
    record.description, record.trigger, record.entryOrder, record.stop, record.target,
    record.assessment, record.assessmentExplanation,
    record.missingConfirmation, record.invalidationConditions,
    record.author?.display_name, record.author?.email,
    ...(record.factors ?? []).flatMap((factor) => [factor.type, factor.condition, factor.role]),
  ].join(' ')).includes(needle));
}

export function historyCardData(record) {
  const pattern = record?.pattern === 'other' && String(record?.patternDetail ?? '').trim()
    ? record.patternDetail.trim()
    : (PATTERN_LABELS[record?.pattern] ?? record?.pattern ?? 'Estrutura não informada');
  const context = marketContextLabel(record);
  const interval = Number.isFinite(record?.startTimestamp) && Number.isFinite(record?.endTimestamp)
    ? `${new Date(record.startTimestamp * 1000).toISOString().slice(11, 16)}–${new Date(record.endTimestamp * 1000).toISOString().slice(11, 16)}`
    : 'intervalo não informado';
  return Object.freeze({
    setup: pattern,
    context,
    contextExplanation: String(record?.contextExplanation ?? '').trim(),
    contractInterval: `${record?.contract ?? '—'} · ${interval}`,
    dateTimeframe: `${String(record?.tradingDate ?? '').split('-').reverse().join('/')} · ${record?.timeframeMinutes ?? '—'}m`,
  });
}

export async function deleteOwnedAnalysis({ record, userId, confirmDelete, deleteRecord }) {
  if (!record?.id || record.authorId !== userId) throw new Error('Somente o autor pode excluir esta análise.');
  if (!confirmDelete()) return false;
  await deleteRecord(record.id);
  return true;
}

export function canCreateAnalysis(selection, drawings) {
  return Boolean(
    selection
    && Number.isFinite(selection.startTimestamp)
    && Number.isFinite(selection.endTimestamp)
    && selection.startTimestamp <= selection.endTimestamp
    && Array.isArray(drawings)
    && drawings.length > 0
  );
}

export function canAccessAnalysisHistory(member) {
  return Boolean(member?.user_id);
}

export function buildAnalysisRestorePlan(record, availableDates) {
  if (!record?.id || !availableDates.includes(record.tradingDate)) {
    throw new TypeError('A data desta análise não está disponível no Explorer.');
  }
  if (!SUPPORTED_TIMEFRAMES.includes(record.timeframeMinutes)) {
    throw new TypeError('A análise possui um timeframe incompatível.');
  }
  if (!Number.isFinite(record.startTimestamp) || !Number.isFinite(record.endTimestamp)) {
    throw new TypeError('A análise possui um intervalo inválido.');
  }
  const analysisType = record.analysisType ?? 'retrospective';
  if (!['retrospective', 'replay'].includes(analysisType)) {
    throw new TypeError('A análise possui um tipo incompatível.');
  }
  const replay = analysisType === 'replay'
    ? {
      simulatedTimestamp: record.replayTimestamp,
      position: record.replayPosition,
    }
    : null;
  if (replay && (!Number.isFinite(replay.simulatedTimestamp) || !Number.isInteger(replay.position) || replay.position < 0)) {
    throw new TypeError('A análise em replay possui um snapshot incompatível.');
  }
  if (replay && (record.endTimestamp > replay.simulatedTimestamp
    || record.analysisCutoffTimestamp > replay.simulatedTimestamp)) {
    throw new TypeError('A análise em replay contém dados posteriores ao snapshot.');
  }
  return {
    analysisType,
    tradingDate: record.tradingDate,
    timeframeMinutes: record.timeframeMinutes,
    selection: { startTimestamp: record.startTimestamp, endTimestamp: record.endTimestamp },
    drawings: serializeDrawings(record.drawings ?? []),
    replay,
  };
}
