import {
  DEFAULT_FIBONACCI_LEVELS,
  DRAWING_LINE_WIDTH,
  DRAWING_TEXT_STYLE,
  createDrawing,
  drawingRenderStyle,
  drawingWithColor,
  drawingWithText,
  drawingGeometry,
  hitTestDrawings,
  normalizeDrawingText,
  projectCoordinateTime,
  projectTimeCoordinate,
  serializeDrawings,
  textDrawingLayout,
} from './drawings.js';

const DRAW_TOOLS = new Set(['horizontal', 'trend', 'arrow', 'fibonacci', 'rectangle', 'text']);
const COLORS = {
  selected: 'rgba(215, 237, 98, 0.45)',
  highlighted: 'rgba(243, 201, 105, 0.35)',
  selection: 'rgba(184, 206, 69, 0.08)',
};

function colorWithAlpha(color, alphaHex) {
  return `${color}${alphaHex}`;
}

export function drawingHandlesVisible(mode) {
  return mode === 'edit';
}

export function movementSelectionRectangle(value, timeToX, intervalSeconds, width, height) {
  if (!value || typeof timeToX !== 'function' || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return null;
  const startX = timeToX(value.startTimestamp);
  const endX = timeToX(value.endTimestamp);
  if (!Number.isFinite(startX) || !Number.isFinite(endX)) return null;
  const nextX = timeToX(value.startTimestamp + intervalSeconds);
  const halfBar = Number.isFinite(nextX) ? Math.max(1, Math.abs(nextX - startX) / 2) : 3;
  const left = Math.max(0, Math.min(startX, endX) - halfBar);
  const right = Math.min(width, Math.max(startX, endX) + halfBar);
  return { x: left, y: 0, width: Math.max(0, right - left), height: Math.max(0, height) };
}

export function paintMovementSelection(context, rectangle) {
  if (!rectangle) return;
  context.fillStyle = COLORS.selection;
  context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
}

function cloneAnchors(anchors) {
  return anchors.map((anchor) => ({ ...anchor }));
}

export function createDrawingOverlay({ container, chart, series, getCandles, getIntervalSeconds, onDrawingsChange, onSelectionChange, onModeChange, onSelectedChange }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'drawing-canvas';
  canvas.setAttribute('aria-label', 'Camada de desenhos e seleção de movimento');
  container.append(canvas);
  const context = canvas.getContext('2d');
  const textEditor = document.createElement('div');
  textEditor.className = 'drawing-text-editor';
  textEditor.hidden = true;
  const textArea = document.createElement('textarea');
  textArea.rows = 4;
  textArea.placeholder = 'Escreva uma observação no gráfico';
  textArea.setAttribute('aria-label', 'Texto da anotação');
  const textEditorActions = document.createElement('div');
  const confirmText = document.createElement('button');
  confirmText.type = 'button';
  confirmText.textContent = 'Confirmar';
  const cancelText = document.createElement('button');
  cancelText.type = 'button';
  cancelText.textContent = 'Cancelar';
  textEditorActions.append(confirmText, cancelText);
  textEditor.append(textArea, textEditorActions);
  container.append(textEditor);

  let drawings = [];
  let selectedId = null;
  let highlightedId = null;
  let mode = 'navigate';
  let fibonacciLevels = [...DEFAULT_FIBONACCI_LEVELS];
  let pendingAnchors = [];
  let previewAnchor = null;
  let selection = null;
  let selectionPreview = null;
  let gesture = null;
  let animationFrame = null;
  let textEditorState = null;

  const project = {
    timeToX: (time) => projectTimeCoordinate(
      time,
      getCandles(),
      (value) => chart.timeScale().timeToCoordinate(value),
      {
        intervalSeconds: getIntervalSeconds(),
        coordinateToLogical: (x) => chart.timeScale().coordinateToLogical(x),
        logicalToCoordinate: (logical) => chart.timeScale().logicalToCoordinate(logical),
      },
    ),
    priceToY: (price) => series.priceToCoordinate(price),
  };

  function domainPoint(event) {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const time = projectCoordinateTime(x, getCandles(), {
      intervalSeconds: getIntervalSeconds(),
      timeToCoordinate: (value) => chart.timeScale().timeToCoordinate(value),
      coordinateToLogical: (coordinate) => chart.timeScale().coordinateToLogical(coordinate),
    });
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

  function drawHandle(anchor, selected, color) {
    if (anchor.x === null || anchor.y === null) return;
    context.beginPath();
    context.arc(anchor.x, anchor.y, selected ? 5 : 3, 0, Math.PI * 2);
    context.fillStyle = '#091812';
    context.fill();
    context.strokeStyle = selected ? '#d7ed62' : color;
    context.lineWidth = selected ? 2 : 1;
    context.stroke();
  }

  function measureTextLine(line) {
    context.save();
    context.font = DRAWING_TEXT_STYLE.font;
    const measurement = context.measureText(line);
    context.restore();
    return measurement;
  }

  function drawItem(drawing, temporary = false) {
    const isSelected = drawing.id === selectedId && !temporary;
    const isHighlighted = drawing.id === highlightedId && !temporary;
    const style = drawingRenderStyle(drawing, { selected: isSelected, highlighted: isHighlighted });
    const geometry = drawingGeometry(drawing, project, container.clientWidth);
    context.save();
    context.strokeStyle = style.color;
    context.fillStyle = colorWithAlpha(style.color, '1f');
    context.lineWidth = style.lineWidth;
    context.shadowColor = isHighlighted ? COLORS.highlighted : isSelected ? COLORS.selected : 'transparent';
    context.shadowBlur = isHighlighted ? 4 : isSelected ? 3 : 0;
    context.setLineDash(temporary ? [5, 4] : []);
    if (drawing.type === 'text') {
      context.font = DRAWING_TEXT_STYLE.font;
      context.textBaseline = 'top';
      const layout = textDrawingLayout(drawing, project, measureTextLine);
      if (layout) {
        context.fillStyle = isSelected ? 'rgba(9, 24, 18, 0.90)' : 'rgba(9, 24, 18, 0.78)';
        context.fillRect(layout.bounds.x, layout.bounds.y, layout.bounds.width, layout.bounds.height);
        context.fillStyle = style.color;
        layout.lines.forEach((line, index) => {
          context.fillText(line, layout.textX, layout.textY + index * DRAWING_TEXT_STYLE.lineHeight);
        });
      }
    }
    for (const segment of geometry.segments) {
      context.beginPath();
      context.moveTo(segment.start.x, segment.start.y);
      context.lineTo(segment.end.x, segment.end.y);
      context.stroke();
      if (drawing.type === 'arrow') {
        const angle = Math.atan2(segment.end.y - segment.start.y, segment.end.x - segment.start.x);
        const size = 9 + style.lineWidth;
        context.beginPath();
        context.moveTo(segment.end.x, segment.end.y);
        context.lineTo(segment.end.x - size * Math.cos(angle - Math.PI / 6), segment.end.y - size * Math.sin(angle - Math.PI / 6));
        context.moveTo(segment.end.x, segment.end.y);
        context.lineTo(segment.end.x - size * Math.cos(angle + Math.PI / 6), segment.end.y - size * Math.sin(angle + Math.PI / 6));
        context.stroke();
      }
      if (drawing.type === 'fibonacci') {
        context.fillStyle = style.color;
        context.font = '10px monospace';
        context.fillText(`${(segment.level * 100).toFixed(1)}% · ${segment.price.toFixed(1)}`, Math.min(segment.start.x, segment.end.x) + 5, segment.start.y - 4);
        context.fillStyle = colorWithAlpha(style.color, '1f');
      }
    }
    for (const rectangle of geometry.rectangles) {
      context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
      context.strokeRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    }
    if (drawingHandlesVisible(mode) && !temporary) {
      geometry.anchors.forEach((anchor) => drawHandle(anchor, isSelected, style.color));
    }
    context.restore();
  }

  function drawSelection(value) {
    paintMovementSelection(context, movementSelectionRectangle(
      value,
      project.timeToX,
      getIntervalSeconds(),
      container.clientWidth,
      container.clientHeight - 27,
    ));
  }

  function render() {
    context.clearRect(0, 0, container.clientWidth, container.clientHeight);
    drawSelection(selectionPreview ?? selection);
    drawings.forEach((drawing) => drawItem(drawing));
    if (DRAW_TOOLS.has(mode) && pendingAnchors.length === 1 && previewAnchor) {
      drawItem(createDrawing(mode, [pendingAnchors[0], previewAnchor], { id: '__preview__', levels: fibonacciLevels }), true);
    }
    positionTextEditor();
  }

  function setSelected(id) {
    selectedId = id;
    onSelectedChange?.(drawings.find((drawing) => drawing.id === id) ?? null);
    render();
  }

  function setMode(nextMode) {
    if (!['navigate', 'edit', 'selection', ...DRAW_TOOLS].includes(nextMode)) throw new TypeError(`Unsupported chart mode: ${nextMode}`);
    if (textEditorState) closeTextEditor();
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

  function positionTextEditor() {
    if (!textEditorState) return;
    const x = project.timeToX(textEditorState.anchor.time);
    const y = project.priceToY(textEditorState.anchor.price);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      textEditor.hidden = true;
      return;
    }
    textEditor.hidden = false;
    const editorWidth = Math.min(260, Math.max(180, container.clientWidth - 16));
    const left = Math.max(8, Math.min(container.clientWidth - editorWidth - 8, x + 10));
    const top = Math.max(8, Math.min(container.clientHeight - 150, y + 10));
    textEditor.style.width = `${editorWidth}px`;
    textEditor.style.left = `${left}px`;
    textEditor.style.top = `${top}px`;
  }

  function closeTextEditor() {
    textEditorState = null;
    textArea.value = '';
    textArea.setCustomValidity('');
    textEditor.hidden = true;
    canvas.style.pointerEvents = mode === 'navigate' ? 'none' : 'auto';
  }

  function openTextEditor({ anchor, drawing = null }) {
    textEditorState = {
      anchor: { ...anchor },
      drawingId: drawing?.id ?? null,
      returnMode: drawing ? 'edit' : 'navigate',
    };
    textArea.value = drawing?.text ?? '';
    textArea.setCustomValidity('');
    canvas.style.pointerEvents = 'none';
    positionTextEditor();
    window.requestAnimationFrame(() => {
      textArea.focus();
      textArea.setSelectionRange(textArea.value.length, textArea.value.length);
    });
  }

  function commitTextEditor() {
    if (!textEditorState) return false;
    let text;
    try {
      text = normalizeDrawingText(textArea.value);
    } catch (error) {
      textArea.setCustomValidity(error.message);
      textArea.reportValidity();
      return false;
    }
    const editor = { ...textEditorState, anchor: { ...textEditorState.anchor } };
    let drawing;
    if (editor.drawingId) {
      const index = drawings.findIndex((item) => item.id === editor.drawingId);
      if (index < 0) return false;
      drawings[index] = drawingWithText(drawings[index], text);
      drawing = drawings[index];
    } else {
      drawing = createDrawing('text', [editor.anchor], { text });
      drawings.push(drawing);
    }
    closeTextEditor();
    onDrawingsChange?.(serializeDrawings(drawings));
    setSelected(drawing.id);
    setMode(editor.returnMode);
    return true;
  }

  function cancelTextEditor() {
    if (!textEditorState) return false;
    const returnMode = textEditorState.returnMode;
    closeTextEditor();
    setMode(returnMode);
    return true;
  }

  function finishDrawing(anchor) {
    if (mode === 'text') {
      openTextEditor({ anchor });
      return;
    }
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
      const hit = hitTestDrawings(
        drawings,
        point,
        project,
        container.clientWidth,
        8,
        measureTextLine,
      );
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
    if (event.key !== 'Escape') return;
    if (textEditorState) {
      event.preventDefault();
      cancelTextEditor();
      return;
    }
    if (mode === 'navigate') return;
    event.preventDefault();
    setMode('navigate');
  }
  window.addEventListener('keydown', handleEscape);
  confirmText.addEventListener('click', commitTextEditor);
  cancelText.addEventListener('click', cancelTextEditor);
  textArea.addEventListener('input', () => textArea.setCustomValidity(''));
  textArea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelTextEditor();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      commitTextEditor();
    }
  });

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
    setDrawings(value) {
      closeTextEditor();
      drawings = serializeDrawings(value);
      highlightedId = null;
      setSelected(null);
      render();
    },
    getDrawings: () => serializeDrawings(drawings),
    deleteSelected() {
      if (!selectedId) return false;
      drawings = drawings.filter((drawing) => drawing.id !== selectedId);
      setSelected(null);
      onDrawingsChange?.(serializeDrawings(drawings));
      return true;
    },
    adjustSelectedLineWidth(delta) {
      const drawing = drawings.find((item) => item.id === selectedId);
      if (!drawing || !Number.isFinite(delta)) return false;
      drawing.lineWidth = Math.min(
        DRAWING_LINE_WIDTH.max,
        Math.max(DRAWING_LINE_WIDTH.min, drawing.lineWidth + delta),
      );
      onDrawingsChange?.(serializeDrawings(drawings));
      onSelectedChange?.(serializeDrawings([drawing])[0]);
      render();
      return true;
    },
    setSelectedColor(color) {
      const index = drawings.findIndex((item) => item.id === selectedId);
      if (index < 0) return false;
      drawings[index] = drawingWithColor(drawings[index], color);
      onDrawingsChange?.(serializeDrawings(drawings));
      onSelectedChange?.(serializeDrawings([drawings[index]])[0]);
      render();
      return true;
    },
    editSelectedText() {
      const drawing = drawings.find((item) => item.id === selectedId);
      if (drawing?.type !== 'text') return false;
      openTextEditor({ anchor: drawing.anchors[0], drawing });
      return true;
    },
    highlightDrawing(id) {
      highlightedId = drawings.some((drawing) => drawing.id === id) ? id : null;
      render();
      return highlightedId !== null;
    },
    setSelection(value) { selection = value ? { ...value } : null; render(); },
    getSelection: () => selection ? { ...selection } : null,
    redraw: render,
    destroy() {
      observer.disconnect();
      window.removeEventListener('keydown', handleEscape);
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      canvas.remove();
      textEditor.remove();
    },
  };
}
