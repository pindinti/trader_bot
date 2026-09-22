import { aggregateCandles } from './aggregate.js';
import { createMarketChart } from './chart.js';
import { parseDayPayload, validateManifest, wallClockToTimestamp } from './data.js';
import { parseFibonacciLevels } from './drawings.js';
import { buildAnalysisRestorePlan, canAccessAnalysisHistory, canCreateAnalysis } from './history.js';
import {
  RESEARCH_SCHEMA_VERSION,
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
  'chartState', 'researchBand', 'datasetNote', 'valueOpen', 'valueHigh', 'valueLow', 'valueClose',
  'valueVolume', 'valueTrades', 'drawingTools', 'fibConfig', 'fibLevels', 'selectedDrawing',
  'deleteDrawing', 'selectionStatus', 'openResearch', 'analysisGrid', 'researchPanel', 'researchTitle',
  'dirtyState', 'closeResearch', 'researchForm', 'movementSummary', 'analysisCutoff', 'factorList',
  'formErrors', 'saveResearch', 'newResearch', 'deleteResearch', 'saveState', 'savedRecords',
  'exportResearch', 'authButton', 'historyButton',
  'historyDialog', 'closeHistory', 'historyState', 'historyList',
].map((id) => [id, mount.querySelector(`#${id}`)]));

const FACTORS = [
  ['vwap', 'VWAP'], ['ma21', 'Média móvel 21'], ['ma200', 'Média móvel 200'],
  ['fibonacci', 'Fibonacci'], ['support_resistance', 'Suporte / resistência'],
  ['higher_timeframe', 'Confirmação em tempo maior'], ['candlestick', 'Padrão de candle'],
  ['volume', 'Volume'], ['other', 'Outro'],
];
const PATTERN_LABELS = {
  false_breakout: 'Falso rompimento', pullback: 'Pullback', inside_bar: 'Inside bar', doji: 'Doji', other: 'Outro / combinação',
};
const DIRECTION_LABELS = { long: 'Compra', short: 'Venda', undetermined: 'Indeterminada' };
const STATUS_LABELS = { observation: 'Somente observação', candidate: 'Regra candidata', clarification: 'Precisa de esclarecimento', review: 'Pronta para revisão' };
const DRAWING_LABELS = { horizontal: 'Horizontal', trend: 'Tendência', fibonacci: 'Fibonacci', rectangle: 'Zona' };
const number = new Intl.NumberFormat('pt-BR');
const price = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 4 });
const dateLabel = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

const state = {
  contract: null,
  dates: [],
  currentDate: null,
  baseCandles: [],
  candles: [],
  timeframe: 1,
  selection: null,
  session,
  member,
  records: [],
  historyRecords: [],
  currentRecordId: null,
  dirty: false,
  suppressDirty: false,
};
let active = true;

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

const chart = createMarketChart(mount.querySelector('#chart'), elements.researchBand, {
  onHover: renderInfo,
  onDrawingsChange: () => { markDirty(); renderFactorList(captureFactors()); renderSelection(); },
  onSelectionChange: (selection) => {
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
  },
});

function researchWindow(day) {
  return { start: wallClockToTimestamp(`${day} 10:30:00`), end: wallClockToTimestamp(`${day} 15:00:00`) };
}

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
  elements.openResearch.title = 'Criar uma análise retrospectiva deste movimento';
}

function renderTimeframe() {
  state.candles = aggregateCandles(state.baseCandles, state.timeframe);
  elements.chartTimeframe.textContent = `· ${state.timeframe} minuto${state.timeframe === 1 ? '' : 's'}`;
  elements.datasetNote.textContent = `${state.candles.length} candles · base auditada de 1 minuto`;
  chart.setData(state.candles, researchWindow(state.currentDate));
  renderInfo();
  renderSelection();
  if (state.candles.length) elements.chartState.hidden = true;
  else showChartState('empty', 'Nenhum candle disponível', 'O arquivo selecionado não contém dados para exibir.');
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

async function loadDay(day, { preserveResearch = false } = {}) {
  showChartState('loading', 'Carregando o pregão', 'Lendo somente candles exportados e auditados…');
  elements.dateSelect.disabled = true;
  try {
    const entry = state.dates.find((item) => item.date === day);
    if (!entry) throw new Error('O pregão selecionado não está no manifesto.');
    const payload = await downloadCandleJson(entry.file);
    if (!active) return;
    state.baseCandles = parseDayPayload(payload, state.contract, day);
    state.currentDate = day;
    elements.chartDate.textContent = dateLabel.format(new Date(`${day}T00:00:00Z`));
    if (!preserveResearch) clearActiveResearch();
    renderTimeframe();
    await loadSavedRecords();
  } catch (error) {
    state.baseCandles = [];
    state.candles = [];
    renderInfo(null);
    showChartState('error', 'Não foi possível abrir os dados', error.message || 'Erro inesperado.');
  } finally {
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
    checkbox.addEventListener('change', () => { detail.hidden = !checkbox.checked; markDirty(); });
    [condition, role, links].forEach((input) => input.addEventListener('input', markDirty));
    detail.append(condition, role, links);
    card.append(checkLabel, detail);
    return card;
  }));
}

function resetForm() {
  state.suppressDirty = true;
  elements.researchForm.querySelectorAll('input, textarea, select').forEach((input) => { input.disabled = false; });
  elements.saveResearch.disabled = false;
  elements.researchForm.reset();
  elements.researchForm.elements.researchStatus.value = 'observation';
  elements.analysisCutoff.value = state.selection ? timestampToInput(state.selection.endTimestamp) : '';
  renderFactorList([]);
  elements.formErrors.hidden = true;
  elements.saveState.textContent = '';
  elements.researchTitle.textContent = 'Nova análise';
  elements.deleteResearch.hidden = true;
  state.suppressDirty = false;
}

function showResearchPanel() {
  if (!state.selection) return;
  elements.researchPanel.hidden = false;
  elements.analysisGrid.classList.add('panel-open');
  renderSelection();
  if (!elements.analysisCutoff.value) elements.analysisCutoff.value = timestampToInput(state.selection.endTimestamp);
}

function closeResearchPanel() {
  if (!confirmDiscard()) return;
  elements.researchPanel.hidden = true;
  elements.analysisGrid.classList.remove('panel-open');
  markClean();
}

function collectDraft() {
  const form = elements.researchForm.elements;
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    contract: state.contract,
    tradingDate: state.currentDate,
    timeframeMinutes: state.timeframe,
    startTimestamp: state.selection?.startTimestamp,
    endTimestamp: state.selection?.endTimestamp,
    analysisCutoffTimestamp: inputToTimestamp(form.analysisCutoff.value),
    pattern: form.pattern.value,
    patternDetail: form.patternDetail.value,
    direction: form.direction.value,
    marketContext: form.marketContext.value,
    contextExplanation: form.contextExplanation.value,
    factors: captureFactors(),
    assessment: form.assessment.value,
    assessmentExplanation: form.assessmentExplanation.value,
    missingConfirmation: form.missingConfirmation.value,
    invalidationConditions: form.invalidationConditions.value,
    candidateRule: form.candidateRule.value,
    researchStatus: form.researchStatus.value,
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
  form.direction.value = record.direction;
  form.marketContext.value = record.marketContext;
  form.contextExplanation.value = record.contextExplanation;
  form.assessment.value = record.assessment;
  form.assessmentExplanation.value = record.assessmentExplanation;
  form.missingConfirmation.value = record.missingConfirmation;
  form.invalidationConditions.value = record.invalidationConditions;
  form.candidateRule.value = record.candidateRule;
  form.researchStatus.value = record.researchStatus;
  renderFactorList(record.factors);
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
    state.currentRecordId = record.id;
    chart.setMode('navigate');
    if (plan.tradingDate !== state.currentDate) {
      elements.dateSelect.value = plan.tradingDate;
      await loadDay(plan.tradingDate, { preserveResearch: true });
      if (!active) return false;
      if (state.currentDate !== plan.tradingDate) throw new Error('Não foi possível carregar o pregão desta análise.');
    }
    state.timeframe = plan.timeframeMinutes;
    elements.timeframeControl.querySelectorAll('button').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.minutes) === state.timeframe)));
    renderTimeframe();
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
    summary.textContent = `${formatTimestamp(record.startTimestamp)}–${formatTimestamp(record.endTimestamp)} · ${record.timeframeMinutes}m · ${record.researchStatus}`;
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
  elements.historyState.hidden = true;
  const entries = state.historyRecords.map((record) => {
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.className = 'history-entry';
    const identity = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${record.tradingDate} · ${record.contract}`;
    const timeframe = document.createElement('small');
    timeframe.textContent = `${record.timeframeMinutes}m · ${formatTimestamp(record.startTimestamp)}–${formatTimestamp(record.endTimestamp)}`;
    identity.append(title, timeframe);
    const metadata = document.createElement('div');
    const pattern = document.createElement('strong');
    pattern.textContent = PATTERN_LABELS[record.pattern] ?? record.pattern;
    const details = document.createElement('span');
    details.textContent = `${DIRECTION_LABELS[record.direction] ?? record.direction} · ${STATUS_LABELS[record.researchStatus] ?? record.researchStatus}`;
    metadata.append(pattern, details);
    const author = document.createElement('span');
    author.className = 'history-author';
    author.textContent = record.authorId === state.session?.user.id ? 'Você' : (record.author?.display_name || record.author?.email || 'Outro pesquisador');
    entry.append(identity, metadata, author);
    entry.addEventListener('click', () => openRecord(record));
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
  elements.timeframeControl.querySelectorAll('button').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
  renderTimeframe();
  markDirty();
});
elements.researchForm.addEventListener('input', markDirty);
elements.researchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  let draft;
  let errors;
  try {
    draft = collectDraft();
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
  try { await onSignOut(); } catch (error) { elements.saveState.textContent = error.message; }
});
elements.historyButton.addEventListener('click', async () => {
  if (!canAccessAnalysisHistory(state.member)) return;
  elements.historyDialog.showModal();
  await loadAnalysisHistory();
});
elements.closeHistory.addEventListener('click', () => elements.historyDialog.close());
const handleBeforeUnload = (event) => { if (state.dirty) event.preventDefault(); };
window.addEventListener('beforeunload', handleBeforeUnload);

function destroy() {
  if (!active) return;
  active = false;
  state.session = null;
  state.member = null;
  state.baseCandles = [];
  state.candles = [];
  state.records = [];
  state.historyRecords = [];
  state.selection = null;
  state.currentRecordId = null;
  state.dirty = false;
  window.removeEventListener('beforeunload', handleBeforeUnload);
  if (elements.historyDialog.open) elements.historyDialog.close();
  chart.destroy();
  mount.remove();
}

await bootstrap();
if (!isCurrent()) {
  destroy();
  return () => {};
}
return destroy;
}
