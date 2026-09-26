import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
} from 'lightweight-charts';
import { createDrawingOverlay } from './drawing-overlay.js';
import { projectTimeCoordinate } from './drawings.js';

const COLORS = {
  ink: '#dce8df',
  muted: '#71857a',
  grid: 'rgba(169, 192, 180, 0.10)',
  up: '#38d996',
  down: '#f05b62',
};

function formatClock(time) {
  const date = new Date(time * 1000);
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

export function findDayBoundaryTimes(candles) {
  const boundaries = new Set();
  let previousDay = null;
  for (const candle of candles) {
    const day = new Date(candle.time * 1000).toISOString().slice(0, 10);
    if (previousDay !== null && day !== previousDay) boundaries.add(candle.time);
    previousDay = day;
  }
  return boundaries;
}

export function formatTimeAxisTick(time, dayBoundaryTimes = new Set()) {
  const timestamp = Number(time);
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp * 1000);
  const clock = `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  return dayBoundaryTimes.has(timestamp)
    ? `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')} ${clock}`
    : clock;
}

function logicalToTimestamp(logical, candles, intervalSeconds) {
  if (!Number.isFinite(logical) || !candles.length) return null;
  const referenceIndex = Math.max(0, Math.min(candles.length - 1, Math.round(logical)));
  return candles[referenceIndex].time + (logical - referenceIndex) * intervalSeconds;
}

function timestampToLogical(timestamp, candles, intervalSeconds) {
  if (!Number.isFinite(timestamp) || !candles.length) return null;
  let referenceIndex = 0;
  for (let index = 1; index < candles.length; index += 1) {
    if (Math.abs(candles[index].time - timestamp) < Math.abs(candles[referenceIndex].time - timestamp)) {
      referenceIndex = index;
    }
  }
  return referenceIndex + (timestamp - candles[referenceIndex].time) / intervalSeconds;
}

export function reprojectLogicalRange(range, fromCandles, fromIntervalSeconds, toCandles, toIntervalSeconds) {
  if (!range || !fromCandles.length || !toCandles.length) return null;
  const fromTime = logicalToTimestamp(range.from, fromCandles, fromIntervalSeconds);
  const toTime = logicalToTimestamp(range.to, fromCandles, fromIntervalSeconds);
  const projected = {
    from: timestampToLogical(fromTime, toCandles, toIntervalSeconds),
    to: timestampToLogical(toTime, toCandles, toIntervalSeconds),
  };
  return Number.isFinite(projected.from) && Number.isFinite(projected.to) ? projected : null;
}

export function replaceChartData({ timeScale, candleSeries, volumeSeries, candles, preserveViewport, projectedLogicalRange = null }) {
  const logicalRange = preserveViewport === 'logical' ? timeScale.getVisibleLogicalRange() : null;
  candleSeries.setData(candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
  volumeSeries.setData(candles.map(({ time, volume, close, open }) => ({
    time,
    value: volume,
    color: close >= open ? 'rgba(56, 217, 150, 0.30)' : 'rgba(240, 91, 98, 0.30)',
  })));
  if (logicalRange) timeScale.setVisibleLogicalRange(logicalRange);
  else if (projectedLogicalRange) timeScale.setVisibleLogicalRange(projectedLogicalRange);
  else timeScale.fitContent();
}

export function createMarketChart(container, researchBand, callbacks = {}) {
  let dayBoundaryTimes = new Set();
  const chart = createChart(container, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: '#091812' },
      textColor: COLORS.muted,
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: 11,
      attributionLogo: false,
      panes: { separatorColor: '#182a22', separatorHoverColor: '#284235' },
    },
    grid: {
      vertLines: { color: COLORS.grid },
      horzLines: { color: COLORS.grid },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: '#b8ce45', labelBackgroundColor: '#b8ce45' },
      horzLine: { color: '#b8ce45', labelBackgroundColor: '#50601b' },
    },
    rightPriceScale: { borderColor: '#1b3027', scaleMargins: { top: 0.08, bottom: 0.25 } },
    timeScale: {
      borderColor: '#1b3027',
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 5,
      barSpacing: 7,
      tickMarkFormatter: (time) => formatTimeAxisTick(time, dayBoundaryTimes),
    },
    localization: { timeFormatter: (time) => formatClock(time) },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
  });

  const candleSeries = chart.addSeries(CandlestickSeries, {
    upColor: COLORS.up,
    downColor: COLORS.down,
    wickUpColor: COLORS.up,
    wickDownColor: COLORS.down,
    borderVisible: false,
    priceFormat: { type: 'price', precision: 1, minMove: 0.5 },
  }, 0);
  const volumeSeries = chart.addSeries(HistogramSeries, {
    priceFormat: { type: 'volume' },
    priceScaleId: 'volume',
    lastValueVisible: false,
    priceLineVisible: false,
  }, 0);
  chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

  const movingAverageStyles = {
    'sma-9': { color: '#f3c969', lineWidth: 1 },
    'sma-21': { color: '#db8f55', lineWidth: 1 },
    'sma-200': { color: '#dd6673', lineWidth: 2 },
    'ema-9': { color: '#70d9d2', lineWidth: 1 },
    'ema-21': { color: '#5fa9ef', lineWidth: 1 },
    'ema-200': { color: '#ab83e8', lineWidth: 2 },
  };
  const movingAverageSeries = Object.fromEntries(Object.entries(movingAverageStyles).map(([key, options]) => [
    key,
    chart.addSeries(LineSeries, {
      ...options,
      title: key.toUpperCase().replace('-', ' '),
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    }, 0),
  ]));

  let candleLookup = new Map();
  let currentCandles = [];
  let researchStart = null;
  let researchEnd = null;
  let intervalSeconds = 60;

  function updateBand() {
    if (!researchStart || !researchEnd) return;
    const coordinate = (time) => projectTimeCoordinate(time, currentCandles, (value) => chart.timeScale().timeToCoordinate(value));
    const startX = coordinate(researchStart);
    const endX = coordinate(researchEnd);
    if (startX === null || endX === null) {
      researchBand.hidden = true;
      return;
    }
    const left = Math.max(0, startX);
    const right = Math.min(container.clientWidth, endX);
    researchBand.hidden = right <= 0 || left >= container.clientWidth || right <= left;
    researchBand.style.left = `${left}px`;
    researchBand.style.width = `${Math.max(0, right - left)}px`;
  }

  chart.timeScale().subscribeVisibleLogicalRangeChange(updateBand);
  chart.subscribeCrosshairMove((param) => {
    if (!param.time) return callbacks.onHover?.(null);
    callbacks.onHover?.(candleLookup.get(Number(param.time)) ?? null);
  });
  const resizeObserver = new ResizeObserver(updateBand);
  resizeObserver.observe(container);

  const drawings = createDrawingOverlay({
    container,
    chart,
    series: candleSeries,
    getCandles: () => currentCandles,
    getIntervalSeconds: () => intervalSeconds,
    onDrawingsChange: callbacks.onDrawingsChange,
    onSelectionChange: callbacks.onSelectionChange,
    onModeChange: callbacks.onModeChange,
    onSelectedChange: callbacks.onSelectedChange,
  });

  return {
    setData(candles, researchWindow, { preserveViewport = false, sourceIntervalSeconds = 60, movingAverages = {} } = {}) {
      const projectedLogicalRange = preserveViewport === 'time'
        ? reprojectLogicalRange(
          chart.timeScale().getVisibleLogicalRange(),
          currentCandles,
          intervalSeconds,
          candles,
          sourceIntervalSeconds,
        )
        : null;
      currentCandles = candles;
      intervalSeconds = sourceIntervalSeconds;
      candleLookup = new Map(candles.map((item) => [item.time, item]));
      dayBoundaryTimes = findDayBoundaryTimes(candles);
      replaceChartData({
        timeScale: chart.timeScale(),
        candleSeries,
        volumeSeries,
        candles,
        preserveViewport,
        projectedLogicalRange,
      });
      Object.entries(movingAverageSeries).forEach(([key, series]) => series.setData(movingAverages[key] ?? []));
      researchStart = researchWindow.start;
      researchEnd = researchWindow.end;
      requestAnimationFrame(updateBand);
      requestAnimationFrame(drawings.redraw);
    },
    setMode: drawings.setMode,
    setFibonacciLevels: drawings.setFibonacciLevels,
    setDrawings: drawings.setDrawings,
    getDrawings: drawings.getDrawings,
    deleteSelectedDrawing: drawings.deleteSelected,
    setSelection: drawings.setSelection,
    getSelection: drawings.getSelection,
    focusRange(startTimestamp, endTimestamp) {
      const padding = Math.max(300, (endTimestamp - startTimestamp) * 0.35);
      chart.timeScale().setVisibleRange({ from: startTimestamp - padding, to: endTimestamp + padding });
    },
    destroy() {
      resizeObserver.disconnect();
      drawings.destroy();
      chart.remove();
    },
  };
}
