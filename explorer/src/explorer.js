import { createMarketChart } from './chart.js';
import { candleReference } from './candle-reference.js';
import { validateManifest, wallClockToTimestamp } from './data.js';
import { DRAWING_COLOR_PALETTE, DRAWING_LINE_WIDTH, parseFibonacciLevels } from './drawings.js';
import {
  DIRECTION_LABELS,
  PATTERN_LABELS,
  buildAnalysisRestorePlan,
  canAccessAnalysisHistory,
  canCreateAnalysis,
  filterAnalysisHistory,
  historyCardData,
  deleteOwnedAnalysis,
  marketContextLabel,
} from './history.js';
import {
  buildChartContext,
  createAuthenticatedDayCache,
  loadWarmupSessions,
} from './indicator-context.js';
import { calculateMovingAverages, largestMovingAveragePeriod } from './moving-averages.js';
import { buildIndicatorLegend, INDICATOR_STYLES } from './indicators.js';
import { calculateSessionVwap, hasExactVwap } from './vwap.js';
import { createCandleReplay } from './replay.js';
import {
  RESEARCH_SCHEMA_VERSION,
  captureAnalysisContext,
  exportResearchRecords,
  researchFormDatetimeToTimestamp,
  validateResearchDraft,
} from './research.js';
import {
  deleteResearchRecord,
  downloadCandleJson,
  listResearchHistory,
  listResearchRecords,
  saveResearchRecord,
} from './supabase.js';

export async function createExplorer({ root, template, session, member, onSignOut, isCurrent = () => true }) {
const mount = document.createElement('div');
mount.className = 'protected-mount';
mount.append(template.content.cloneNode(true));
root.replaceChildren(mount);

const elements = Object.fromEntries([
  'contractValue', 'chartContract', 'chartDate', 'chartTimeframe', 'dateSelect', 'timeframeControl',
  'chartState', 'datasetNote', 'candleReference', 'valueOpen', 'valueHigh', 'valueLow', 'valueClose',
  'valueVolume', 'valueTrades', 'drawingTools', 'fibConfig', 'fibLevels', 'selectedDrawing',
  'deleteDrawing', 'drawingColorPalette', 'decreaseLineWidth', 'increaseLineWidth', 'lineWidthValue', 'selectionStatus', 'openResearch', 'analysisGrid', 'researchPanel', 'researchTitle',
  'researchKind', 'researchWarningTitle', 'researchWarningText',
  'dirtyState', 'closeResearch', 'researchForm', 'movementSummary', 'analysisCutoff', 'factorList',
  'formErrors', 'saveResearch', 'newResearch', 'deleteResearch', 'saveState', 'savedRecords',
  'exportResearch', 'authButton', 'historyButton',
  'historyDialog', 'closeHistory', 'historyState', 'historyList',
  'historySearch', 'movingAverageControl', 'movingAverageState', 'indicatorLegend',
  'replayToggle', 'replayPrevious', 'replayPlay', 'replayPause', 'replayNext',
  'replayTimestamp', 'replayPosition',
].map((id) => [id, mount.querySelector(`#${id}`)]));

const FACTORS = [
  ['vwap', 'VWAP'], ['ma21', 'Média móvel 21'], ['ma200', 'Média móvel 200'],
  ['fibonacci', 'Fibonacci'], ['support_resistance', 'Suporte / resistência'],
  ['higher_timeframe', 'Confirmação em tempo maior'], ['candlestick', 'Padrão de candle'],
  ['volume', 'Volume'], ['other', 'Outro'],
];
const DRAWING_LABELS = { horizontal: 'Horizontal', trend: 'Tendência', arrow: 'Seta', fibonacci: 'Fibonacci', rectangle: 'Zona' };
const number = new Intl.NumberFormat('pt-BR');
const price = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 4 });
const dateLabel = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

const state = {
  contract: null,
  dates: [],
  currentDate: null,
  baseCandles: [],
  candles: [],
  chartCandles: [],
  priorSessions: [],
  enabledIndicators: new Set(),
  timeframe: 1,
  selection: null,
  session,
  member,
  records: [],
  historyRecords: [],
  currentRecordId: null,
  dirty: false,
  suppressDirty: false,
  historyQuery: '',
};
let active = true;
let loadingDay = false;
let replayWasActive = false;
let restoringAnalysis = false;
let preserveTimeRangeOnce = false;
let indicatorLoadGeneration = 0;
let dayCache = null;

elements.movingAverageControl.querySelectorAll('button[data-average], button[data-indicator]').forEach((button) => {
  const key = button.dataset.average ?? button.dataset.indicator;
  if (INDICATOR_STYLES[key]) button.style.setProperty('--indicator-color', INDICATOR_STYLES[key].color);
});

const drawingColorButtons = DRAWING_COLOR_PALETTE.map(({ value, label }) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.color = value;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-pressed', 'false');
  button.style.setProperty('--drawing-color', value);
  button.disabled = true;
  return button;
});
elements.drawingColorPalette.replaceChildren(...drawingColorButtons);

function showChartState(kind, title, detail) {
  elements.chartState.className = `chart-state ${kind}`;
  elements.chartState.innerHTML = kind === 'loading'
    ? `<span class="loader" aria-hidden="true"></span><strong>${title}</strong><small>${detail}</small>`
    : `<span class="state-symbol" aria-hidden="true">${kind === 'error' ? '!' : '—'}</span><strong>${title}</strong><small>${detail}</small>`;
  elements.chartState.hidden = false;
}

function renderInfo(candle = state.candles.at(-1)) {
  const values = candle
    ? [price.format(candle.open), price.format(candle.high), price.format(candle.low), price.format(candle.close), number.format(candle.volume), number.format(candle.trades)]
    : ['—', '—', '—', '—', '—', '—'];
  [elements.valueOpen, elements.valueHigh, elements.valueLow, elements.valueClose, elements.valueVolume, elements.valueTrades]
    .forEach((element, index) => { element.textContent = values[index]; });
  elements.candleReference.textContent = candleReference(state.chartCandles, candle, state.timeframe) ?? '—';
}

function markDirty() {
  const activeRecord = state.records.find((record) => record.id === state.currentRecordId);
  if (state.suppressDirty || elements.researchPanel.hidden || (activeRecord && activeRecord.authorId !== state.session?.user.id)) return;
  state.dirty = true;
  elements.dirtyState.textContent = 'Alterações não salvas';
  elements.dirtyState.classList.add('dirty');
}

function markClean(message = 'Sem alterações') {
  state.dirty = false;
  elements.dirtyState.textContent = message;
  elements.dirtyState.classList.remove('dirty');
}

function setChartMode(mode) {
  elements.drawingTools.querySelectorAll('[data-tool]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.tool === mode));
  });
  elements.fibConfig.hidden = mode !== 'fibonacci';
}

const chart = createMarketChart(mount.querySelector('#chart'), {
  onHover: renderInfo,
  onDrawingsChange: () => { markDirty(); renderFactorList(captureFactors()); renderSelection(); },
  onSelectionChange: (selection) => {
    const selectedDayStart = state.currentDate ? wallClockToTimestamp(`${state.currentDate} 00:00:00`) : null;
    if (selection && (!Number.isFinite(selectedDayStart)
      || selection.startTimestamp < selectedDayStart
      || selection.endTimestamp >= selectedDayStart + 86400)) {
      state.selection = null;
      chart.setSelection(null);
      renderSelection();
      elements.selectionStatus.textContent = 'Selecione um movimento no pregão atual; candles anteriores servem apenas como contexto';
      return;
    }
    state.selection = selection;
    renderSelection();
    if (!elements.researchPanel.hidden) {
      elements.analysisCutoff.value = timestampToInput(selection.endTimestamp);
      markDirty();
    }
  },
  onModeChange: setChartMode,
  onSelectedChange: (drawing) => {
    elements.selectedDrawing.textContent = drawing ? `${DRAWING_LABELS[drawing.type]} · ${drawing.id.slice(0, 8)}` : 'Nenhum desenho selecionado';
    elements.deleteDrawing.disabled = !drawing;
    elements.decreaseLineWidth.disabled = !drawing || drawing.lineWidth <= DRAWING_LINE_WIDTH.min;
    elements.increaseLineWidth.disabled = !drawing || drawing.lineWidth >= DRAWING_LINE_WIDTH.max;
    elements.lineWidthValue.textContent = drawing ? price.format(drawing.lineWidth) : price.format(DRAWING_LINE_WIDTH.default);
    drawingColorButtons.forEach((button) => {
      button.disabled = !drawing;
      button.setAttribute('aria-pressed', String(drawing?.color === button.dataset.color));
    });
  },
});

const replay = createCandleReplay({ onChange: handleReplayChange });

function timestampToInput(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 19);
}

function inputToTimestamp(value) {
  return value ? researchFormDatetimeToTimestamp(value) : NaN;
}

function formatTimestamp(timestamp) {
  const value = new Date(timestamp * 1000).toISOString();
  return `${value.slice(11, 16)}`;
}

function formatReplayTimestamp(timestamp) {
  if (!Number.isFinite(timestamp)) return '—';
  return new Date(timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function renderReplayControls() {
  const replayState = replay.getState();
  const editingAnalysis = !elements.researchPanel.hidden;
  elements.replayToggle.textContent = replayState.active ? 'Sair do replay' : 'Iniciar replay';
  elements.replayToggle.setAttribute('aria-pressed', String(replayState.active));
  elements.replayToggle.disabled = editingAnalysis;
  elements.replayPrevious.disabled = editingAnalysis || !replayState.active || replayState.atStart;
  elements.replayNext.disabled = editingAnalysis || !replayState.active || replayState.atEnd;
  elements.replayPlay.disabled = editingAnalysis || !replayState.active || replayState.playing || replayState.atEnd;
  elements.replayPause.disabled = editingAnalysis || !replayState.active || !replayState.playing;
  elements.replayTimestamp.textContent = formatReplayTimestamp(replayState.simulatedTimestamp);
  elements.replayPosition.textContent = replayState.active
    ? `${replayState.position + 1} / ${replayState.total}`
    : 'Dados completos';
}

function handleReplayChange(replayState = replay.getState()) {
  renderReplayControls();
  if (!loadingDay && !restoringAnalysis && state.currentDate && state.baseCandles.length) {
    const enteringReplay = replayState.active && !replayWasActive;
    const preserveViewport = preserveTimeRangeOnce
      ? 'time'
      : (replayState.active && !enteringReplay ? 'logical' : false);
    renderTimeframe({ preserveViewport });
  }
  preserveTimeRangeOnce = false;
  replayWasActive = replayState.active;
}

function renderSelection() {
  const drawings = chart.getDrawings();
  if (!state.selection) {
    elements.selectionStatus.textContent = 'Selecione um movimento e adicione ao menos um desenho';
    elements.selectionStatus.dataset.state = 'requirement';
    elements.openResearch.disabled = true;
    elements.openResearch.title = 'Selecione um movimento e adicione ao menos um desenho';
    elements.movementSummary.textContent = '—';
    return;
  }
  const single = state.selection.startTimestamp === state.selection.endTimestamp;
  const text = single
    ? `1 candle · ${formatTimestamp(state.selection.startTimestamp)} · ${state.timeframe}m`
    : `${formatTimestamp(state.selection.startTimestamp)}–${formatTimestamp(state.selection.endTimestamp)} · ${state.timeframe}m`;
  elements.movementSummary.textContent = `${state.contract} · ${state.currentDate} · ${text}`;
  if (!canCreateAnalysis(state.selection, drawings)) {
    elements.selectionStatus.textContent = `${text} · adicione ao menos um desenho`;
    elements.selectionStatus.dataset.state = 'requirement';
    elements.openResearch.disabled = true;
    elements.openResearch.title = 'Adicione ao menos um desenho ao movimento selecionado';
    return;
  }
  elements.selectionStatus.textContent = `${text} · ${drawings.length} desenho${drawings.length === 1 ? '' : 's'}`;
  elements.selectionStatus.dataset.state = 'selected';
  elements.openResearch.disabled = false;
  elements.openResearch.title = replay.getState().active
    ? 'Criar uma análise em replay deste movimento'
    : 'Criar uma análise retrospectiva deste movimento';
}

function renderTimeframe({ preserveViewport = replay.getState().active ? 'logical' : false } = {}) {
  const marketView = replay.getMarketView();
  const chartContext = buildChartContext({
    priorSessions: state.priorSessions,
    selectedCandles: marketView.candles,
    timeframe: state.timeframe,
    simulatedTimestamp: marketView.simulatedTimestamp,
  });
  state.candles = chartContext.selectedCandles;
  state.chartCandles = chartContext.candles;
  const movingAverageKeys = new Set([...state.enabledIndicators].filter((key) => key !== 'vwap'));
  const indicators = calculateMovingAverages(chartContext.candles, movingAverageKeys);
  if (state.enabledIndicators.has('vwap') && hasExactVwap(chartContext.selectedCandles)) {
    indicators.vwap = calculateSessionVwap(chartContext.selectedCandles);
  }
  elements.chartTimeframe.textContent = `· ${state.timeframe} minuto${state.timeframe === 1 ? '' : 's'}`;
  elements.datasetNote.textContent = marketView.active
    ? `${marketView.candles.length} de ${state.baseCandles.length} candles de 1 minuto · buckets completos${chartContext.contextCandles.length ? ` · ${chartContext.contextCandles.length} de contexto` : ''}`
    : `${state.candles.length} candles do pregão${chartContext.contextCandles.length ? ` · ${chartContext.contextCandles.length} de contexto` : ''} · base auditada de 1 minuto`;
  chart.setData(chartContext.candles, {
    preserveViewport,
    sourceIntervalSeconds: state.timeframe * 60,
    indicators,
  });
  const legend = buildIndicatorLegend(state.enabledIndicators, indicators);
  elements.indicatorLegend.replaceChildren(...legend.map((item) => {
    const element = document.createElement('span');
    element.className = 'indicator-legend-item';
    const swatch = document.createElement('i');
    swatch.style.backgroundColor = item.color;
    const value = item.value == null ? '—' : price.format(item.value);
    element.append(swatch, document.createTextNode(`${item.label} · ${value}`));
    return element;
  }));
  renderInfo();
  renderSelection();
  if (state.candles.length) elements.chartState.hidden = true;
  else if (marketView.active && state.timeframe > 1) {
    showChartState('empty', 'Aguardando candle completo', `Avance o replay até fechar o primeiro candle de ${state.timeframe} minutos.`);
  }
  else showChartState('empty', 'Nenhum candle disponível', 'O arquivo selecionado não contém dados para exibir.');
}

async function refreshIndicatorContext({ preserveViewport = 'time' } = {}) {
  const generation = ++indicatorLoadGeneration;
  state.priorSessions = [];
  const requiredBars = largestMovingAveragePeriod(new Set([...state.enabledIndicators].filter((key) => key !== 'vwap')));
  if (!requiredBars || !state.currentDate || !dayCache) {
    elements.movingAverageState.textContent = requiredBars
      ? 'Contexto indisponível'
      : (state.enabledIndicators.size ? 'Indicador da sessão atual' : 'Nenhum indicador ativo');
    if (state.currentDate && state.baseCandles.length) renderTimeframe({ preserveViewport });
    return;
  }

  elements.movingAverageState.textContent = 'Carregando contexto…';
  try {
    const sessions = await loadWarmupSessions({
      entries: state.dates,
      currentDate: state.currentDate,
      timeframe: state.timeframe,
      requiredBars,
      loadDay: (date) => dayCache.load(date),
    });
    if (!active || generation !== indicatorLoadGeneration) return;
    state.priorSessions = sessions;
    const completed = sessions.reduce(
      (total, session) => total + buildChartContext({ priorSessions: [session], selectedCandles: [], timeframe: state.timeframe }).contextCandles.length,
      0,
    );
    elements.movingAverageState.textContent = sessions.length
      ? `${completed} candles de aquecimento · ${sessions.length} pregão${sessions.length === 1 ? '' : 'es'}`
      : 'Histórico anterior indisponível';
    renderTimeframe({ preserveViewport });
  } catch (error) {
    if (!active || generation !== indicatorLoadGeneration) return;
    state.priorSessions = [];
    elements.movingAverageState.textContent = `Contexto indisponível: ${error.message}`;
    renderTimeframe({ preserveViewport });
  }
}

function clearActiveResearch({ clearDrawings = true } = {}) {
  state.currentRecordId = null;
  state.selection = null;
  chart.setSelection(null);
  if (clearDrawings) chart.setDrawings([]);
  resetForm();
  renderSelection();
  markClean();
}

function confirmDiscard() {
  return !state.dirty || window.confirm('Descartar as alterações não salvas desta análise?');
}

async function loadDay(day, { preserveResearch = false, replayContext = null } = {}) {
  loadingDay = true;
  indicatorLoadGeneration += 1;
  state.baseCandles = [];
  state.candles = [];
  state.chartCandles = [];
  state.priorSessions = [];
  replay.load([]);
  showChartState('loading', 'Carregando o pregão', 'Lendo somente candles exportados e auditados…');
  elements.dateSelect.disabled = true;
  try {
    if (!dayCache) throw new Error('O cache autenticado de candles não foi inicializado.');
    const candles = await dayCache.load(day);
    if (!active) return;
    state.baseCandles = candles;
    state.currentDate = day;
    const vwapButton = elements.movingAverageControl.querySelector('[data-indicator="vwap"]');
    const exactVwapAvailable = hasExactVwap(candles);
    vwapButton.disabled = !exactVwapAvailable;
    vwapButton.title = exactVwapAvailable ? 'Exibir ou ocultar VWAP da sessão' : 'VWAP exata indisponível neste export legado';
    if (!exactVwapAvailable) state.enabledIndicators.delete('vwap');
    replay.load(state.baseCandles);
    if (replayContext) replay.restore(replayContext);
    elements.chartDate.textContent = dateLabel.format(new Date(`${day}T00:00:00Z`));
    if (!preserveResearch) clearActiveResearch();
    await refreshIndicatorContext({ preserveViewport: false });
    await loadSavedRecords();
  } catch (error) {
    state.baseCandles = [];
    state.candles = [];
    state.chartCandles = [];
    state.priorSessions = [];
    replay.load([]);
    renderInfo(null);
    showChartState('error', 'Não foi possível abrir os dados', error.message || 'Erro inesperado.');
  } finally {
    loadingDay = false;
    renderReplayControls();
    elements.dateSelect.disabled = false;
  }
}

function captureFactors() {
  return [...elements.factorList.querySelectorAll('.factor-card')]
    .filter((card) => card.querySelector('input[type="checkbox"]').checked)
    .map((card) => ({
      type: card.dataset.factor,
      condition: card.querySelector('.factor-condition').value,
      role: card.querySelector('.factor-role').value,
      drawingIds: [...card.querySelector('.factor-drawings').selectedOptions].map((option) => option.value),
    }));
}

function renderFactorList(factors = []) {
  const byType = new Map(factors.map((factor) => [factor.type, factor]));
  const drawings = chart.getDrawings();
  elements.factorList.replaceChildren(...FACTORS.map(([type, label]) => {
    const saved = byType.get(type);
    const card = document.createElement('div');
    card.className = 'factor-card';
    card.dataset.factor = type;
    const checkLabel = document.createElement('label');
    checkLabel.className = 'factor-check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(saved);
    checkLabel.append(checkbox, document.createTextNode(label));
    const detail = document.createElement('div');
    detail.className = 'factor-detail';
    detail.hidden = !saved;
    const condition = document.createElement('textarea');
    condition.className = 'factor-condition';
    condition.rows = 2;
    condition.placeholder = 'Condição específica observada';
    condition.value = saved?.condition ?? '';
    const role = document.createElement('select');
    role.className = 'factor-role';
    role.innerHTML = '<option value="">Papel do fator</option><option value="required">Condição necessária</option><option value="supporting">Confluência de apoio</option><option value="disqualifying">Fator desqualificante</option><option value="undetermined">Indeterminado</option>';
    role.value = saved?.role ?? '';
    const links = document.createElement('select');
    links.className = 'factor-drawings';
    links.multiple = true;
    links.setAttribute('aria-label', `Desenhos relacionados a ${label}`);
    if (!drawings.length) {
      const option = document.createElement('option'); option.disabled = true; option.textContent = 'Nenhum desenho disponível'; links.append(option);
    } else drawings.forEach((drawing, index) => {
      const option = document.createElement('option');
      option.value = drawing.id;
      option.textContent = `${DRAWING_LABELS[drawing.type]} ${index + 1}`;
      option.selected = saved?.drawingIds?.includes(drawing.id) ?? false;
      links.append(option);
    });
    const drawingReferences = document.createElement('div');
    drawingReferences.className = 'drawing-references';
    for (const drawingId of saved?.drawingIds ?? []) {
      const drawingIndex = drawings.findIndex((drawing) => drawing.id === drawingId);
      if (drawingIndex < 0) continue;
      const reference = document.createElement('button');
      reference.type = 'button';
      reference.textContent = `${DRAWING_LABELS[drawings[drawingIndex].type]} ${drawingIndex + 1}`;
      reference.addEventListener('click', () => chart.highlightDrawing(drawingId));
      drawingReferences.append(reference);
    }
    checkbox.addEventListener('change', () => { detail.hidden = !checkbox.checked; markDirty(); });
    [condition, role, links].forEach((input) => input.addEventListener('input', markDirty));
    links.addEventListener('change', () => {
      const selectedId = links.selectedOptions[0]?.value;
      if (selectedId) chart.highlightDrawing(selectedId);
    });
    detail.append(condition, role, links, drawingReferences);
    card.append(checkLabel, detail);
    return card;
  }));
}

function resetForm() {
  state.suppressDirty = true;
  elements.researchForm.querySelectorAll('option[data-legacy="true"]').forEach((option) => option.remove());
  elements.researchForm.querySelectorAll('input, textarea, select').forEach((input) => { input.disabled = false; });
  elements.saveResearch.disabled = false;
  elements.researchForm.reset();
  elements.analysisCutoff.value = state.selection ? timestampToInput(state.selection.endTimestamp) : '';
  renderFactorList([]);
  elements.formErrors.hidden = true;
  elements.saveState.textContent = '';
  elements.researchTitle.textContent = 'Nova análise';
  renderAnalysisType(replay.getState().active ? 'replay' : 'retrospective');
  elements.deleteResearch.hidden = true;
  state.suppressDirty = false;
}

function renderAnalysisType(analysisType) {
  const isReplay = analysisType === 'replay';
  elements.researchKind.textContent = isReplay ? 'Análise em replay' : 'Análise retrospectiva';
  elements.researchPanel.setAttribute('aria-label', elements.researchKind.textContent);
  elements.researchWarningTitle.textContent = isReplay ? 'Replay' : 'Retrospectiva';
  elements.researchWarningText.textContent = isReplay
    ? 'O registro preserva o timestamp simulado e o prefixo de mercado disponível no momento do salvamento.'
    : 'O corte registra a informação que você pretende considerar. Ele não oculta candles futuros nem elimina viés retrospectivo.';
}

function showResearchPanel() {
  if (!state.selection) return;
  replay.pause();
  elements.researchPanel.hidden = false;
  elements.analysisGrid.classList.add('panel-open');
  renderSelection();
  if (!elements.analysisCutoff.value) elements.analysisCutoff.value = timestampToInput(state.selection.endTimestamp);
  renderReplayControls();
}

function closeResearchPanel() {
  if (!confirmDiscard()) return;
  elements.researchPanel.hidden = true;
  elements.analysisGrid.classList.remove('panel-open');
  markClean();
  renderReplayControls();
}

function collectDraft(analysisContext) {
  const form = elements.researchForm.elements;
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    contract: state.contract,
    tradingDate: state.currentDate,
    timeframeMinutes: state.timeframe,
    startTimestamp: state.selection?.startTimestamp,
    endTimestamp: state.selection?.endTimestamp,
    analysisCutoffTimestamp: inputToTimestamp(form.analysisCutoff.value),
    ...analysisContext,
    pattern: form.pattern.value,
    patternDetail: form.patternDetail.value,
    description: form.description.value,
    direction: form.direction.value,
    marketContext: form.marketContext.value,
    contextExplanation: form.contextExplanation.value,
    factors: captureFactors(),
    assessment: form.assessment.value,
    assessmentExplanation: form.assessmentExplanation.value,
    missingConfirmation: form.missingConfirmation.value,
    invalidationConditions: form.invalidationConditions.value,
    trigger: form.trigger.value,
    entryOrder: form.entryOrder.value,
    stop: form.stop.value,
    target: form.target.value,
    researchStatus: state.records.find((record) => record.id === state.currentRecordId)?.researchStatus ?? 'observation',
    drawings: chart.getDrawings(),
  };
}

function showFormErrors(errors) {
  elements.formErrors.textContent = errors.join(' · ');
  elements.formErrors.hidden = !errors.length;
}

function populateForm(record) {
  state.suppressDirty = true;
  const form = elements.researchForm.elements;
  form.analysisCutoff.value = timestampToInput(record.analysisCutoffTimestamp);
  form.pattern.value = record.pattern;
  form.patternDetail.value = record.patternDetail;
  form.description.value = record.description ?? '';
  form.direction.value = record.direction;
  form.marketContext.value = record.marketContext;
  form.contextExplanation.value = record.contextExplanation;
  if (![...form.assessment.options].some((option) => option.value === record.assessment)) {
    const legacyOption = document.createElement('option');
    legacyOption.value = record.assessment;
    legacyOption.textContent = record.assessment === 'wait' ? 'Aguardar confirmação (legado)' : 'Indeterminado (legado)';
    legacyOption.dataset.legacy = 'true';
    form.assessment.append(legacyOption);
  }
  form.assessment.value = record.assessment;
  form.assessmentExplanation.value = record.assessmentExplanation;
  form.missingConfirmation.value = record.missingConfirmation;
  form.invalidationConditions.value = record.invalidationConditions;
  form.trigger.value = record.trigger ?? '';
  form.entryOrder.value = record.entryOrder ?? '';
  form.stop.value = record.stop ?? '';
  form.target.value = record.target ?? '';
  renderFactorList(record.factors);
  renderAnalysisType(record.analysisType);
  elements.researchTitle.textContent = PATTERN_LABELS[record.pattern] ?? 'Análise';
  elements.deleteResearch.hidden = record.authorId !== state.session?.user.id;
  const own = record.authorId === state.session?.user.id;
  elements.researchForm.querySelectorAll('input, textarea, select').forEach((input) => { input.disabled = !own; });
  elements.saveResearch.disabled = !own;
  elements.formErrors.hidden = true;
  state.suppressDirty = false;
  markClean(`Salva · ${new Date(record.updatedAt).toLocaleString('pt-BR')}`);
}

async function openRecord(record) {
  if (!confirmDiscard()) return false;
  try {
    const plan = buildAnalysisRestorePlan(record, state.dates.map(({ date }) => date));
    replay.pause();
    restoringAnalysis = true;
    state.currentRecordId = record.id;
    chart.setMode('navigate');
    state.timeframe = plan.timeframeMinutes;
    state.priorSessions = [];
    indicatorLoadGeneration += 1;
    elements.timeframeControl.querySelectorAll('button').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.minutes) === state.timeframe)));
    replay.setStepMinutes(state.timeframe);
    if (plan.tradingDate !== state.currentDate) {
      elements.dateSelect.value = plan.tradingDate;
      await loadDay(plan.tradingDate, { preserveResearch: true, replayContext: plan.replay });
      if (!active) return false;
      if (state.currentDate !== plan.tradingDate || !state.baseCandles.length) throw new Error('Não foi possível carregar o pregão desta análise.');
    } else if (plan.replay) {
      replay.restore(plan.replay);
    } else {
      replay.exit();
    }
    restoringAnalysis = false;
    await refreshIndicatorContext({ preserveViewport: 'time' });
    state.selection = plan.selection;
    chart.setSelection(state.selection);
    chart.setDrawings(plan.drawings);
    renderSelection();
    showResearchPanel();
    populateForm(record);
    chart.focusRange(record.startTimestamp, record.endTimestamp);
    renderSavedRecords();
    if (elements.historyDialog.open) elements.historyDialog.close();
    return true;
  } catch (error) {
    elements.historyState.textContent = error.message;
    elements.historyState.className = 'history-state error';
    return false;
  } finally {
    restoringAnalysis = false;
  }
}

async function loadSavedRecords() {
  if (!state.member || !state.contract || !state.currentDate) {
    state.records = [];
    renderSavedRecords();
    return;
  }
  elements.savedRecords.innerHTML = '<p class="empty-copy">Carregando análises…</p>';
  try {
    const records = await listResearchRecords(state.contract, state.currentDate);
    if (!active) return;
    state.records = records;
    renderSavedRecords();
  } catch (error) {
    elements.savedRecords.textContent = `Falha ao carregar: ${error.message}`;
  }
}

function renderSavedRecords() {
  elements.exportResearch.disabled = !state.records.length;
  if (!state.member) {
    elements.savedRecords.innerHTML = '<p class="empty-copy">Entre com uma conta autorizada para carregar as análises compartilhadas.</p>';
    return;
  }
  if (!state.records.length) {
    elements.savedRecords.innerHTML = '<p class="empty-copy">Nenhuma análise salva neste pregão.</p>';
    return;
  }
  const cards = state.records.map((record) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `record-card${record.id === state.currentRecordId ? ' active' : ''}`;
    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = PATTERN_LABELS[record.pattern] ?? record.pattern;
    const author = document.createElement('span');
    const own = record.authorId === state.session?.user.id;
    author.className = own ? 'own' : '';
    author.textContent = own ? 'Você' : (record.author?.display_name || 'Outro pesquisador');
    header.append(title, author);
    const summary = document.createElement('p');
    const analysisLabel = record.analysisType === 'replay'
      ? `REPLAY · ${formatTimestamp(record.replayTimestamp)}`
      : 'ANÁLISE RETROSPECTIVA';
    summary.textContent = `${analysisLabel} · ${formatTimestamp(record.startTimestamp)}–${formatTimestamp(record.endTimestamp)} · ${record.timeframeMinutes}m · ${marketContextLabel(record)}`;
    card.append(header, summary);
    card.addEventListener('click', () => openRecord(record));
    return card;
  });
  elements.savedRecords.replaceChildren(...cards);
}

async function loadAnalysisHistory() {
  if (!canAccessAnalysisHistory(state.member) || !state.contract) {
    state.historyRecords = [];
    renderAnalysisHistory();
    return;
  }
  elements.historyState.hidden = false;
  elements.historyState.className = 'history-state';
  elements.historyState.textContent = 'Carregando análises…';
  elements.historyList.replaceChildren();
  try {
    const records = await listResearchHistory(state.contract);
    if (!active) return;
    state.historyRecords = records;
    renderAnalysisHistory();
  } catch (error) {
    state.historyRecords = [];
    elements.historyState.textContent = `Não foi possível carregar o histórico: ${error.message}`;
    elements.historyState.className = 'history-state error';
  }
}

function renderAnalysisHistory() {
  elements.historyList.replaceChildren();
  if (!state.member) {
    elements.historyState.hidden = false;
    elements.historyState.textContent = 'Entre com uma conta autorizada para acessar o histórico.';
    return;
  }
  if (!state.historyRecords.length) {
    elements.historyState.hidden = false;
    elements.historyState.textContent = 'Nenhuma análise salva.';
    return;
  }
  const visibleRecords = filterAnalysisHistory(state.historyRecords, state.historyQuery);
  if (!visibleRecords.length) {
    elements.historyState.hidden = false;
    elements.historyState.textContent = 'Nenhuma análise corresponde à busca.';
    return;
  }
  elements.historyState.hidden = true;
  const entries = visibleRecords.map((record) => {
    const entry = document.createElement('article');
    entry.className = 'history-entry';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'history-open';
    const card = historyCardData(record);
    const identity = document.createElement('div');
    identity.className = 'history-identity';
    const title = document.createElement('strong');
    title.textContent = card.setup;
    const direction = document.createElement('small');
    direction.textContent = DIRECTION_LABELS[record.direction] ?? record.direction;
    identity.append(title, direction);
    const context = document.createElement('div');
    context.className = 'history-context';
    const contextHeading = document.createElement('strong');
    contextHeading.textContent = card.context;
    const contextValue = document.createElement('span');
    contextValue.className = 'history-context-value';
    contextValue.textContent = card.contextExplanation || 'Sem explicação adicional';
    context.append(contextHeading, contextValue);
    const market = document.createElement('div');
    market.className = 'history-market';
    const contractInterval = document.createElement('strong');
    contractInterval.textContent = card.contractInterval;
    const dateTimeframe = document.createElement('span');
    dateTimeframe.textContent = card.dateTimeframe;
    market.append(contractInterval, dateTimeframe);
    open.append(identity, context, market);
    open.addEventListener('click', () => openRecord(record));
    const actions = document.createElement('div');
    actions.className = 'history-entry-actions';
    const author = document.createElement('span');
    author.className = 'history-author';
    author.textContent = record.authorId === state.session?.user.id ? 'Você' : (record.author?.display_name || record.author?.email || 'Outro pesquisador');
    actions.append(author);
    if (record.authorId === state.session?.user.id) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'history-delete danger-quiet';
      remove.setAttribute('aria-label', `Excluir análise ${card.setup}`);
      remove.title = 'Excluir análise';
      remove.textContent = 'Excluir';
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          const deleted = await deleteOwnedAnalysis({
            record,
            userId: state.session?.user.id,
            confirmDelete: () => window.confirm('Excluir definitivamente esta análise e seus desenhos?'),
            deleteRecord: deleteResearchRecord,
          });
          if (!deleted || !active) return;
          state.historyRecords = state.historyRecords.filter((item) => item.id !== record.id);
          state.records = state.records.filter((item) => item.id !== record.id);
          if (state.currentRecordId === record.id) {
            clearActiveResearch();
            elements.researchPanel.hidden = true;
            elements.analysisGrid.classList.remove('panel-open');
            renderReplayControls();
          }
          renderAnalysisHistory();
          renderSavedRecords();
        } catch (error) {
          elements.historyState.hidden = false;
          elements.historyState.className = 'history-state error';
          elements.historyState.textContent = `Não foi possível excluir a análise: ${error.message}`;
        } finally { remove.disabled = false; }
      });
      actions.append(remove);
    }
    entry.append(open, actions);
    return entry;
  });
  elements.historyList.replaceChildren(...entries);
}

async function bootstrap() {
  try {
    const manifest = await downloadCandleJson('manifest.json');
    if (!active) return;
    const contract = validateManifest(manifest);
    state.contract = contract.symbol;
    state.dates = contract.dates;
    dayCache = createAuthenticatedDayCache({
      contract: state.contract,
      entries: state.dates,
      download: downloadCandleJson,
    });
    elements.contractValue.textContent = contract.symbol;
    elements.chartContract.textContent = contract.symbol;
    elements.dateSelect.innerHTML = contract.dates.map(({ date }) => `<option value="${date}">${date.split('-').reverse().join('/')}</option>`).join('');
    if (!contract.dates.length) return showChartState('empty', 'Nenhum pregão exportado', 'Execute o exportador para disponibilizar dados.');
    elements.dateSelect.value = contract.dates.at(-1).date;
    renderFactorList([]);
    await loadDay(elements.dateSelect.value);
    if (!active) return;
  } catch (error) {
    showChartState('error', 'Explorer sem dados', error.message || 'Não foi possível ler o manifesto.');
  }
  await loadAnalysisHistory();
}

elements.drawingTools.addEventListener('click', (event) => {
  const button = event.target.closest('[data-tool]');
  if (!button) return;
  const activeRecord = state.records.find((record) => record.id === state.currentRecordId);
  if (activeRecord && activeRecord.authorId !== state.session?.user.id && !['navigate', 'selection'].includes(button.dataset.tool)) {
    elements.selectionStatus.textContent = 'A análise de outro autor é somente leitura';
    return;
  }
  if (button.dataset.tool === 'fibonacci') {
    try {
      chart.setFibonacciLevels(parseFibonacciLevels(elements.fibLevels.value));
      showFormErrors([]);
    } catch (error) {
      elements.selectionStatus.textContent = error.message;
      return;
    }
  }
  chart.setMode(button.dataset.tool);
});
elements.fibLevels.addEventListener('change', () => {
  try { chart.setFibonacciLevels(parseFibonacciLevels(elements.fibLevels.value)); }
  catch (error) { elements.selectionStatus.textContent = error.message; }
});
elements.deleteDrawing.addEventListener('click', () => {
  const activeRecord = state.records.find((record) => record.id === state.currentRecordId);
  if (activeRecord && activeRecord.authorId !== state.session?.user.id) return;
  chart.deleteSelectedDrawing();
});
elements.decreaseLineWidth.addEventListener('click', () => chart.adjustSelectedDrawingLineWidth(-DRAWING_LINE_WIDTH.step));
elements.increaseLineWidth.addEventListener('click', () => chart.adjustSelectedDrawingLineWidth(DRAWING_LINE_WIDTH.step));
elements.drawingColorPalette.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-color]');
  if (!button || button.disabled) return;
  chart.setSelectedDrawingColor(button.dataset.color);
});
elements.openResearch.addEventListener('click', () => {
  if (!canCreateAnalysis(state.selection, chart.getDrawings())) return;
  resetForm();
  showResearchPanel();
  markDirty();
});
elements.closeResearch.addEventListener('click', closeResearchPanel);
elements.newResearch.addEventListener('click', () => {
  if (!confirmDiscard()) return;
  state.currentRecordId = null;
  chart.setDrawings([]);
  resetForm();
  elements.researchPanel.hidden = true;
  elements.analysisGrid.classList.remove('panel-open');
  renderSelection();
  renderSavedRecords();
  renderReplayControls();
});

elements.dateSelect.addEventListener('change', async () => {
  const next = elements.dateSelect.value;
  if (!confirmDiscard()) { elements.dateSelect.value = state.currentDate; return; }
  await loadDay(next);
});
elements.timeframeControl.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-minutes]');
  if (!button || !state.baseCandles.length) return;
  state.timeframe = Number(button.dataset.minutes);
  state.priorSessions = [];
  indicatorLoadGeneration += 1;
  elements.timeframeControl.querySelectorAll('button').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
  preserveTimeRangeOnce = true;
  replay.setStepMinutes(state.timeframe);
  void refreshIndicatorContext({ preserveViewport: 'time' });
  markDirty();
});
elements.movingAverageControl.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-average], button[data-indicator]');
  if (!button || !state.baseCandles.length) return;
  const key = button.dataset.average ?? button.dataset.indicator;
  if (!INDICATOR_STYLES[key]) return;
  if (state.enabledIndicators.has(key)) state.enabledIndicators.delete(key);
  else state.enabledIndicators.add(key);
  button.setAttribute('aria-pressed', String(state.enabledIndicators.has(key)));
  button.style.setProperty('--indicator-color', INDICATOR_STYLES[key].color);
  void refreshIndicatorContext({ preserveViewport: 'time' });
});
elements.replayToggle.addEventListener('click', () => {
  if (replay.getState().active) replay.exit();
  else replay.enter();
});
elements.replayPrevious.addEventListener('click', replay.previous);
elements.replayNext.addEventListener('click', replay.next);
elements.replayPlay.addEventListener('click', replay.play);
elements.replayPause.addEventListener('click', replay.pause);
elements.researchForm.addEventListener('input', markDirty);
elements.researchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  let draft;
  let errors;
  try {
    const analysisContext = captureAnalysisContext(replay);
    draft = collectDraft(analysisContext);
    errors = validateResearchDraft(draft);
  } catch (error) {
    showFormErrors([`Não foi possível validar a análise: ${error.message}`]);
    elements.saveState.textContent = 'Revise os campos destacados';
    return;
  }
  if (!state.member) errors.unshift('Entre com uma conta incluída na lista de pesquisadores');
  showFormErrors(errors);
  if (errors.length) return;
  elements.saveResearch.disabled = true;
  elements.saveState.textContent = 'Salvando…';
  try {
    const saved = await saveResearchRecord(draft, state.currentRecordId);
    if (!active) return;
    state.currentRecordId = saved.id;
    elements.saveState.textContent = 'Análise salva';
    markClean('Salva agora');
    await loadSavedRecords();
    await loadAnalysisHistory();
    const fresh = state.records.find((record) => record.id === saved.id) ?? saved;
    populateForm(fresh);
  } catch (error) {
    elements.saveState.textContent = 'Falha ao salvar';
    showFormErrors([error.message]);
  } finally {
    elements.saveResearch.disabled = false;
    renderReplayControls();
  }
});
elements.deleteResearch.addEventListener('click', async () => {
  const record = state.records.find((item) => item.id === state.currentRecordId);
  if (!record || record.authorId !== state.session?.user.id || !window.confirm('Excluir definitivamente esta análise?')) return;
  elements.saveState.textContent = 'Excluindo…';
  try {
    await deleteResearchRecord(record.id);
    if (!active) return;
    clearActiveResearch();
    elements.researchPanel.hidden = true;
    elements.analysisGrid.classList.remove('panel-open');
    renderReplayControls();
    await loadSavedRecords();
    await loadAnalysisHistory();
  } catch (error) { showFormErrors([error.message]); }
});
elements.exportResearch.addEventListener('click', () => {
  const blob = new Blob([`${JSON.stringify(exportResearchRecords(state.records), null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `trade-bot-research-${state.contract}-${state.currentDate}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

elements.authButton.textContent = `${member.display_name || member.email} · sair`;
elements.authButton.classList.add('member');
elements.historyButton.hidden = false;
elements.authButton.addEventListener('click', async () => {
  if (state.dirty && !confirmDiscard()) return;
  replay.pause();
  try { await onSignOut(); } catch (error) { elements.saveState.textContent = error.message; }
});
elements.historyButton.addEventListener('click', async () => {
  if (!canAccessAnalysisHistory(state.member)) return;
  elements.historyDialog.showModal();
  await loadAnalysisHistory();
});
elements.closeHistory.addEventListener('click', () => elements.historyDialog.close());
elements.historySearch.addEventListener('input', () => {
  state.historyQuery = elements.historySearch.value;
  renderAnalysisHistory();
});
const handleBeforeUnload = (event) => { if (state.dirty) event.preventDefault(); };
window.addEventListener('beforeunload', handleBeforeUnload);

function destroy() {
  if (!active) return;
  active = false;
  state.session = null;
  state.member = null;
  state.baseCandles = [];
  state.candles = [];
  state.chartCandles = [];
  state.priorSessions = [];
  state.enabledIndicators.clear();
  state.records = [];
  state.historyRecords = [];
  state.selection = null;
  state.currentRecordId = null;
  state.dirty = false;
  indicatorLoadGeneration += 1;
  dayCache?.clear();
  dayCache = null;
  replay.dispose();
  window.removeEventListener('beforeunload', handleBeforeUnload);
  if (elements.historyDialog.open) elements.historyDialog.close();
  chart.destroy();
  mount.remove();
}

renderReplayControls();
await bootstrap();
if (!isCurrent()) {
  destroy();
  return () => {};
}
return destroy;
}
