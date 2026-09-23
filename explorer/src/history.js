import { serializeDrawings } from './drawings.js';

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
  if (![1, 5, 10, 15, 30, 60].includes(record.timeframeMinutes)) {
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
