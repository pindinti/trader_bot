import {
  DEFAULT_FIBONACCI_LEVELS,
  createDrawing,
  drawingGeometry,
  hitTestDrawings,
  projectTimeCoordinate,
  serializeDrawings,
} from './drawings.js';

const DRAW_TOOLS = new Set(['horizontal', 'trend', 'fibonacci', 'rectangle']);
const COLORS = {
  normal: '#75a88e',
  selected: '#d7ed62',
  fill: 'rgba(117, 168, 142, 0.12)',
  selection: 'rgba(184, 206, 69, 0.13)',
  selectionBorder: 'rgba(184, 206, 69, 0.8)',
};

function cloneAnchors(anchors) {
  return anchors.map((anchor) => ({ ...anchor }));
}

export function createDrawingOverlay({ container, chart, series, getCandles, onDrawingsChange, onSelectionChange, onModeChange, onSelectedChange }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'drawing-canvas';
  canvas.setAttribute('aria-label', 'Camada de desenhos e seleção de movimento');
  container.append(canvas);
  const context = canvas.getContext('2d');

  let drawings = [];
  let selectedId = null;
  let mode = 'navigate';
  let fibonacciLevels = [...DEFAULT_FIBONACCI_LEVELS];
  let pendingAnchors = [];
  let previewAnchor = null;
  let selection = null;
  let selectionPreview = null;
  let gesture = null;
  let animationFrame = null;

  const project = {
    timeToX: (time) => projectTimeCoordinate(time, getCandles(), (value) => chart.timeScale().timeToCoordinate(value)),
    priceToY: (price) => series.priceToCoordinate(price),
  };

  function domainPoint(event) {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const time = chart.timeScale().coordinateToTime(x);
    const price = series.coordinateToPrice(y);
    if (time === null || price === null || typeof time !== 'number' || !Number.isFinite(price) || price <= 0) return null;
    return { x, y, time: Math.round(time), price: Number(price.toFixed(4)) };
  }

  function nearestCandleTime(time) {
    const candles = getCandles();
    if (!candles.length) return null;
    let low = 0;
    let high = candles.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (candles[middle].time < time) low = middle + 1;
      else high = middle;
    }
    if (low === 0) return candles[0].time;
    const before = candles[low - 1];
    const after = candles[low];
    return Math.abs(before.time - time) <= Math.abs(after.time - time) ? before.time : after.time;
  }

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    render();
  }

  function drawHandle(anchor, selected) {
    if (anchor.x === null || anchor.y === null) return;
    context.beginPath();
    context.arc(anchor.x, anchor.y, selected ? 5 : 3, 0, Math.PI * 2);
    context.fillStyle = '#091812';
    context.fill();
    context.strokeStyle = selected ? COLORS.selected : COLORS.normal;
    context.lineWidth = selected ? 2 : 1;
    context.stroke();
  }

  function drawItem(drawing, temporary = false) {
    const isSelected = drawing.id === selectedId && !temporary;
    const geometry = drawingGeometry(drawing, project, container.clientWidth);
    context.save();
    context.strokeStyle = isSelected ? COLORS.selected : COLORS.normal;
    context.fillStyle = COLORS.fill;
    context.lineWidth = isSelected ? 2 : 1.25;
    context.setLineDash(temporary ? [5, 4] : []);
    for (const segment of geometry.segments) {
      context.beginPath();
      context.moveTo(segment.start.x, segment.start.y);
      context.lineTo(segment.end.x, segment.end.y);
      context.stroke();
      if (drawing.type === 'fibonacci') {
        context.fillStyle = isSelected ? COLORS.selected : COLORS.normal;
        context.font = '10px monospace';
        context.fillText(`${(segment.level * 100).toFixed(1)}% · ${segment.price.toFixed(1)}`, Math.min(segment.start.x, segment.end.x) + 5, segment.start.y - 4);
        context.fillStyle = COLORS.fill;
      }
    }
    for (const rectangle of geometry.rectangles) {
      context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
      context.strokeRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    }
    geometry.anchors.forEach((anchor) => drawHandle(anchor, isSelected || temporary));
    context.restore();
  }

  function drawSelection(value) {
    if (!value) return;
    const startX = chart.timeScale().timeToCoordinate(value.startTimestamp);
    const endX = chart.timeScale().timeToCoordinate(value.endTimestamp);
    if (startX === null || endX === null) return;
    const left = Math.min(startX, endX);
    const width = Math.max(2, Math.abs(endX - startX));
    context.fillStyle = COLORS.selection;
    context.fillRect(left, 0, width, container.clientHeight - 27);
    context.strokeStyle = COLORS.selectionBorder;
    context.lineWidth = 1;
    context.setLineDash([4, 4]);
    context.strokeRect(left, 0, width, container.clientHeight - 27);
    context.setLineDash([]);
  }

  function render() {
    context.clearRect(0, 0, container.clientWidth, container.clientHeight);
    drawSelection(selectionPreview ?? selection);
    drawings.forEach((drawing) => drawItem(drawing));
    if (DRAW_TOOLS.has(mode) && pendingAnchors.length === 1 && previewAnchor) {
      drawItem(createDrawing(mode, [pendingAnchors[0], previewAnchor], { id: '__preview__', levels: fibonacciLevels }), true);
    }
  }

  function setSelected(id) {
    selectedId = id;
    onSelectedChange?.(drawings.find((drawing) => drawing.id === id) ?? null);
    render();
  }

  function setMode(nextMode) {
    if (!['navigate', 'edit', 'selection', ...DRAW_TOOLS].includes(nextMode)) throw new TypeError(`Unsupported chart mode: ${nextMode}`);
    mode = nextMode;
    pendingAnchors = [];
    previewAnchor = null;
    selectionPreview = null;
    gesture = null;
    canvas.style.pointerEvents = mode === 'navigate' ? 'none' : 'auto';
    canvas.style.cursor = mode === 'navigate' ? 'default' : mode === 'edit' ? 'default' : 'crosshair';
    onModeChange?.(mode);
    render();
  }

  function finishDrawing(anchor) {
    const anchors = mode === 'horizontal' ? [anchor] : [...pendingAnchors, anchor];
    if (anchors.length < (mode === 'horizontal' ? 1 : 2)) {
      pendingAnchors = anchors;
      previewAnchor = anchor;
      render();
      return;
    }
    const drawing = createDrawing(mode, anchors, { levels: fibonacciLevels });
    drawings.push(drawing);
    onDrawingsChange?.(serializeDrawings(drawings));
    setSelected(drawing.id);
    setMode('navigate');
  }

  canvas.addEventListener('pointerdown', (event) => {
    const point = domainPoint(event);
    if (!point) return;
    if (DRAW_TOOLS.has(mode)) {
      finishDrawing({ time: point.time, price: point.price });
      return;
    }
    if (mode === 'selection') {
      const start = nearestCandleTime(point.time);
      if (start === null) return;
      gesture = { kind: 'selection', start };
      selectionPreview = { startTimestamp: start, endTimestamp: start };
      canvas.setPointerCapture(event.pointerId);
      render();
      return;
    }
    if (mode === 'edit') {
      const hit = hitTestDrawings(drawings, point, project, container.clientWidth);
      if (!hit) {
        setSelected(null);
        return;
      }
      setSelected(hit.drawingId);
      const drawing = drawings.find((item) => item.id === hit.drawingId);
      gesture = {
        kind: 'drawing',
        drawingId: drawing.id,
        anchorIndex: hit.anchorIndex,
        origin: { time: point.time, price: point.price },
        anchors: cloneAnchors(drawing.anchors),
      };
      canvas.setPointerCapture(event.pointerId);
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    const point = domainPoint(event);
    if (!point) return;
    if (DRAW_TOOLS.has(mode) && pendingAnchors.length) {
      previewAnchor = { time: point.time, price: point.price };
      render();
      return;
    }
    if (gesture?.kind === 'selection') {
      const end = nearestCandleTime(point.time);
      if (end !== null) selectionPreview = { startTimestamp: Math.min(gesture.start, end), endTimestamp: Math.max(gesture.start, end) };
      render();
      return;
    }
    if (gesture?.kind === 'drawing') {
      const drawing = drawings.find((item) => item.id === gesture.drawingId);
      if (!drawing) return;
      if (gesture.anchorIndex !== null) {
        drawing.anchors[gesture.anchorIndex] = { time: point.time, price: point.price };
      } else {
        const timeDelta = point.time - gesture.origin.time;
        const priceDelta = point.price - gesture.origin.price;
        drawing.anchors = gesture.anchors.map((anchor) => ({
          time: Math.round(anchor.time + timeDelta),
          price: Number((anchor.price + priceDelta).toFixed(4)),
        }));
      }
      render();
    }
  });

  canvas.addEventListener('pointerup', (event) => {
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (gesture?.kind === 'selection' && selectionPreview) {
      selection = { ...selectionPreview };
      selectionPreview = null;
      onSelectionChange?.({ ...selection });
      setMode('navigate');
      return;
    }
    if (gesture?.kind === 'drawing') onDrawingsChange?.(serializeDrawings(drawings));
    gesture = null;
  });

  function handleEscape(event) {
    if (event.key !== 'Escape' || mode === 'navigate') return;
    event.preventDefault();
    setMode('navigate');
  }
  window.addEventListener('keydown', handleEscape);

  chart.timeScale().subscribeVisibleLogicalRangeChange(render);
  chart.subscribeCrosshairMove(render);
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  setMode('navigate');
  resize();
  const animationLoop = () => {
    render();
    animationFrame = window.requestAnimationFrame(animationLoop);
  };
  animationFrame = window.requestAnimationFrame(animationLoop);

  return {
    setMode,
    getMode: () => mode,
    setFibonacciLevels(levels) { fibonacciLevels = [...levels]; },
    setDrawings(value) { drawings = serializeDrawings(value); setSelected(null); render(); },
    getDrawings: () => serializeDrawings(drawings),
    deleteSelected() {
      if (!selectedId) return false;
      drawings = drawings.filter((drawing) => drawing.id !== selectedId);
      setSelected(null);
      onDrawingsChange?.(serializeDrawings(drawings));
      return true;
    },
    setSelection(value) { selection = value ? { ...value } : null; render(); },
    getSelection: () => selection ? { ...selection } : null,
    redraw: render,
    destroy() {
      observer.disconnect();
      window.removeEventListener('keydown', handleEscape);
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      canvas.remove();
    },
  };
}
