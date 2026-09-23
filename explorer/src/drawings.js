export const DRAWING_SCHEMA_VERSION = 1;
export const DEFAULT_FIBONACCI_LEVELS = Object.freeze([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
export const DRAWING_TYPES = Object.freeze(['horizontal', 'trend', 'fibonacci', 'rectangle']);

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

export function parseFibonacciLevels(value) {
  const parts = Array.isArray(value) ? value : String(value).split(',').map((item) => item.trim());
  if (parts.some((item) => item === '')) throw new TypeError('Fibonacci levels cannot contain empty values');
  const levels = parts.map(Number);
  if (levels.length < 2 || levels.length > 12 || levels.some((level) => !finite(level))) {
    throw new TypeError('Fibonacci levels must contain 2–12 finite numbers');
  }
  return levels;
}

export function validateAnchor(anchor) {
  if (!anchor || !finite(anchor.time) || !finite(anchor.price) || anchor.time <= 0 || anchor.price <= 0) {
    throw new TypeError('Drawing anchors require positive timestamp and price values');
  }
  return { time: Math.round(anchor.time), price: Number(anchor.price) };
}

export function createDrawing(type, anchors, options = {}) {
  if (!DRAWING_TYPES.includes(type)) throw new TypeError(`Unsupported drawing type: ${type}`);
  const requiredAnchors = type === 'horizontal' ? 1 : 2;
  if (!Array.isArray(anchors) || anchors.length !== requiredAnchors) {
    throw new TypeError(`${type} requires ${requiredAnchors} anchor(s)`);
  }
  const drawing = {
    schemaVersion: DRAWING_SCHEMA_VERSION,
    id: options.id || crypto.randomUUID(),
    type,
    anchors: anchors.map(validateAnchor),
  };
  if (type === 'fibonacci') {
    drawing.levels = parseFibonacciLevels(options.levels ?? DEFAULT_FIBONACCI_LEVELS);
  }
  return drawing;
}

export function fibonacciPrices(drawing) {
  if (drawing?.type !== 'fibonacci' || drawing.anchors?.length !== 2) {
    throw new TypeError('A two-anchor Fibonacci drawing is required');
  }
  const [first, second] = drawing.anchors.map(validateAnchor);
  return parseFibonacciLevels(drawing.levels).map((level) => ({
    level,
    price: first.price + (second.price - first.price) * level,
  }));
}

export function serializeDrawings(drawings) {
  if (!Array.isArray(drawings)) throw new TypeError('Drawings must be an array');
  return drawings.map((drawing) => createDrawing(drawing.type, drawing.anchors, {
    id: drawing.id,
    levels: drawing.levels,
  }));
}

export function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy));
}

export function projectTimeCoordinate(time, candles, timeToCoordinate, logicalScale = null) {
  const exact = timeToCoordinate(time);
  if (exact !== null) return exact;
  if (!Array.isArray(candles) || candles.length === 0) return null;

  if (logicalScale && Number.isFinite(logicalScale.intervalSeconds) && logicalScale.intervalSeconds > 0) {
    const bucketTime = Math.floor(time / logicalScale.intervalSeconds) * logicalScale.intervalSeconds;
    let reference = candles[0];
    for (const candle of candles) {
      if (Math.abs(candle.time - bucketTime) < Math.abs(reference.time - bucketTime)) reference = candle;
    }
    const referenceX = timeToCoordinate(reference.time);
    const referenceLogical = referenceX === null ? null : logicalScale.coordinateToLogical(referenceX);
    if (referenceLogical !== null && Number.isFinite(referenceLogical)) {
      return logicalScale.logicalToCoordinate(
        referenceLogical + (time - reference.time) / logicalScale.intervalSeconds,
      );
    }
  }

  if (candles.length < 2) return null;
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].time < time) low = middle + 1;
    else high = middle;
  }
  const rightIndex = Math.min(candles.length - 1, Math.max(1, low));
  const leftIndex = rightIndex - 1;
  const left = candles[leftIndex];
  const right = candles[rightIndex];
  const leftX = timeToCoordinate(left.time);
  const rightX = timeToCoordinate(right.time);
  if (leftX === null || rightX === null || right.time === left.time) return null;
  return leftX + ((time - left.time) / (right.time - left.time)) * (rightX - leftX);
}

export function projectCoordinateTime(x, candles, scale) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  const targetLogical = scale.coordinateToLogical(x);
  if (!Number.isFinite(targetLogical) || !Number.isFinite(scale.intervalSeconds) || scale.intervalSeconds <= 0) return null;
  let reference = null;
  let referenceLogical = null;
  for (const candle of candles) {
    const coordinate = scale.timeToCoordinate(candle.time);
    const logical = coordinate === null ? null : scale.coordinateToLogical(coordinate);
    if (!Number.isFinite(logical)) continue;
    if (reference === null || Math.abs(logical - targetLogical) < Math.abs(referenceLogical - targetLogical)) {
      reference = candle;
      referenceLogical = logical;
    }
  }
  if (!reference) return null;
  return Math.round(reference.time + (targetLogical - referenceLogical) * scale.intervalSeconds);
}

export function drawingGeometry(drawing, project, width) {
  const anchors = drawing.anchors.map((anchor) => ({
    x: project.timeToX(anchor.time),
    y: project.priceToY(anchor.price),
    anchor,
  }));
  if (anchors.some(({ x, y }) => x === null || y === null)) return { anchors, segments: [], rectangles: [] };
  if (drawing.type === 'horizontal') {
    return { anchors, segments: [{ start: { x: 0, y: anchors[0].y }, end: { x: width, y: anchors[0].y } }], rectangles: [] };
  }
  if (drawing.type === 'trend') {
    return { anchors, segments: [{ start: anchors[0], end: anchors[1] }], rectangles: [] };
  }
  if (drawing.type === 'rectangle') {
    const x = Math.min(anchors[0].x, anchors[1].x);
    const y = Math.min(anchors[0].y, anchors[1].y);
    return { anchors, segments: [], rectangles: [{ x, y, width: Math.abs(anchors[1].x - anchors[0].x), height: Math.abs(anchors[1].y - anchors[0].y) }] };
  }
  const segments = fibonacciPrices(drawing).map(({ level, price }) => {
    const y = project.priceToY(price);
    return { level, price, start: { x: anchors[0].x, y }, end: { x: anchors[1].x, y } };
  }).filter(({ start, end }) => start.y !== null && end.y !== null);
  return { anchors, segments, rectangles: [] };
}

export function hitTestDrawings(drawings, point, project, width, tolerance = 8) {
  for (let drawingIndex = drawings.length - 1; drawingIndex >= 0; drawingIndex -= 1) {
    const drawing = drawings[drawingIndex];
    const geometry = drawingGeometry(drawing, project, width);
    const anchorIndex = geometry.anchors.findIndex(({ x, y }) => x !== null && y !== null && Math.hypot(point.x - x, point.y - y) <= tolerance);
    if (anchorIndex >= 0) return { drawingId: drawing.id, anchorIndex };
    if (geometry.segments.some(({ start, end }) => distanceToSegment(point, start, end) <= tolerance)) {
      return { drawingId: drawing.id, anchorIndex: null };
    }
    if (geometry.rectangles.some((rect) => (
      point.x >= rect.x - tolerance && point.x <= rect.x + rect.width + tolerance
      && point.y >= rect.y - tolerance && point.y <= rect.y + rect.height + tolerance
      && (Math.abs(point.x - rect.x) <= tolerance || Math.abs(point.x - rect.x - rect.width) <= tolerance
        || Math.abs(point.y - rect.y) <= tolerance || Math.abs(point.y - rect.y - rect.height) <= tolerance)
    ))) return { drawingId: drawing.id, anchorIndex: null };
  }
  return null;
}
