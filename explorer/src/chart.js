import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
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

export function createMarketChart(container, researchBand, callbacks = {}) {
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
      tickMarkFormatter: (time) => formatClock(time),
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

  let candleLookup = new Map();
  let currentCandles = [];
  let researchStart = null;
  let researchEnd = null;

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
    onDrawingsChange: callbacks.onDrawingsChange,
    onSelectionChange: callbacks.onSelectionChange,
    onModeChange: callbacks.onModeChange,
    onSelectedChange: callbacks.onSelectedChange,
  });

  return {
    setData(candles, researchWindow) {
      currentCandles = candles;
      candleLookup = new Map(candles.map((item) => [item.time, item]));
      candleSeries.setData(candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
      volumeSeries.setData(candles.map(({ time, volume, close, open }) => ({
        time,
        value: volume,
        color: close >= open ? 'rgba(56, 217, 150, 0.30)' : 'rgba(240, 91, 98, 0.30)',
      })));
      researchStart = researchWindow.start;
      researchEnd = researchWindow.end;
      chart.timeScale().fitContent();
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
