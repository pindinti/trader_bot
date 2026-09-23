import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_FIBONACCI_LEVELS,
  DRAWING_TYPES,
  createDrawing,
  distanceToSegment,
  drawingGeometry,
  fibonacciPrices,
  hitTestDrawings,
  parseFibonacciLevels,
  projectCoordinateTime,
  projectTimeCoordinate,
  serializeDrawings,
} from '../src/drawings.js';
import { SUPPORTED_TIMEFRAMES } from '../src/aggregate.js';
import { reprojectLogicalRange } from '../src/chart.js';

test('creates and serializes timestamp/price drawings without pixel geometry', () => {
  const drawing = createDrawing('trend', [{ time: 1000, price: 10.5 }, { time: 2000, price: 12 }], { id: 'trend-1' });
  const serialized = serializeDrawings([drawing]);
  assert.deepEqual(serialized, [drawing]);
  assert.equal(JSON.stringify(serialized).includes('"x"'), false);
});

test('projects preserved timestamps between higher-timeframe candles without snapping', () => {
  const candles = [{ time: 100 }, { time: 400 }];
  const coordinate = (time) => ({ 100: 10, 400: 70 }[time] ?? null);
  assert.equal(projectTimeCoordinate(250, candles, coordinate), 40);
  assert.equal(projectTimeCoordinate(250, candles, coordinate) === coordinate(100), false);
});

test('future-space drawing anchors round-trip through logical chart coordinates', () => {
  const candles = [{ time: 1000 }];
  const logicalScale = {
    intervalSeconds: 60,
    coordinateToLogical: (x) => x / 10,
    logicalToCoordinate: (logical) => logical * 10,
  };
  const timeToCoordinate = (time) => time === 1000 ? 20 : null;

  assert.equal(projectTimeCoordinate(1180, candles, timeToCoordinate, logicalScale), 50);
  assert.equal(projectCoordinateTime(50, candles, {
    ...logicalScale,
    timeToCoordinate,
  }), 1180);
});

test('future timestamp anchors remain stable as replay candles arrive and timeframes change', () => {
  const anchorTime = 1600;
  const oneMinute = [{ time: 1000 }, { time: 1060 }];
  const fiveMinute = [{ time: 900 }, { time: 1200 }];
  const scale = (intervalSeconds, referenceTime, referenceX) => ({
    intervalSeconds,
    coordinateToLogical: (x) => x / 10,
    logicalToCoordinate: (logical) => logical * 10,
    timeToCoordinate: (time) => time === referenceTime ? referenceX : null,
  });

  const before = scale(60, 1060, 20);
  const after = scale(60, 1360, 70);
  const higher = scale(300, 1200, 30);
  assert.equal(projectTimeCoordinate(anchorTime, oneMinute, before.timeToCoordinate, before), 110);
  assert.equal(projectTimeCoordinate(anchorTime, [...oneMinute, { time: 1360 }], after.timeToCoordinate, after), 110);
  assert.equal(projectTimeCoordinate(anchorTime, fiveMinute, higher.timeToCoordinate, higher), 43.33333333333333);

  const drawing = createDrawing('trend', [{ time: 1180, price: 10.5 }, { time: anchorTime, price: 12 }], { id: 'future' });
  assert.deepEqual(serializeDrawings([drawing])[0].anchors, drawing.anchors);
  assert.equal(drawing.schemaVersion, 1);
});

test('all drawing types preserve timestamp and price anchors across every timeframe', () => {
  const origin = Date.UTC(2026, 8, 21, 10) / 1000;
  for (const timeframe of SUPPORTED_TIMEFRAMES) {
    const intervalSeconds = timeframe * 60;
    const candles = [0, 1, 2].map((index) => ({ time: origin + index * intervalSeconds }));
    const coordinates = new Map(candles.map(({ time }, index) => [time, index * 10]));
    const scale = {
      intervalSeconds,
      coordinateToLogical: (x) => x / 10,
      logicalToCoordinate: (logical) => logical * 10,
    };
    const project = {
      timeToX: (time) => projectTimeCoordinate(time, candles, (value) => coordinates.get(value) ?? null, scale),
      priceToY: (value) => value,
    };
    const anchors = [
      { time: origin + intervalSeconds / 2, price: 5100.5 },
      { time: origin + intervalSeconds * 4.5, price: 5120.5 },
    ];

    for (const type of DRAWING_TYPES) {
      const drawing = createDrawing(type, type === 'horizontal' ? anchors.slice(0, 1) : anchors, {
        id: `${type}-${timeframe}`,
      });
      const geometry = drawingGeometry(drawing, project, 500);
      assert.equal(geometry.anchors[0].x, 5, `${type} ${timeframe}m first anchor`);
      if (type !== 'horizontal') assert.equal(geometry.anchors[1].x, 45, `${type} ${timeframe}m future anchor`);
      assert.deepEqual(serializeDrawings([drawing])[0].anchors, drawing.anchors);
    }
  }
});

test('trend endpoints keep their screen time and price through timeframe switches with future whitespace', () => {
  const origin = Date.UTC(2026, 8, 21, 10) / 1000;
  const source = Array.from({ length: 61 }, (_, index) => ({ time: origin + index * 60 }));
  const sourceRange = { from: 0, to: 120 };
  const stored = createDrawing('trend', [
    { time: origin + 30 * 60, price: 5100.5 },
    { time: origin + 90 * 60, price: 5120.5 },
  ], { id: 'trend-replay-future' });
  const serialized = serializeDrawings([stored])[0];

  for (const timeframe of SUPPORTED_TIMEFRAMES) {
    const intervalSeconds = timeframe * 60;
    const candles = source.filter(({ time }) => (time - origin) % intervalSeconds === 0);
    const visibleRange = reprojectLogicalRange(sourceRange, source, 60, candles, intervalSeconds);
    const width = 1000;
    const logicalToCoordinate = (logical) => ((logical - visibleRange.from) / (visibleRange.to - visibleRange.from)) * width;
    const coordinateToLogical = (x) => visibleRange.from + (x / width) * (visibleRange.to - visibleRange.from);
    const coordinates = new Map(candles.map(({ time }, index) => [time, logicalToCoordinate(index)]));
    const geometry = drawingGeometry(serialized, {
      timeToX: (time) => projectTimeCoordinate(time, candles, (value) => coordinates.get(value) ?? null, {
        intervalSeconds,
        coordinateToLogical,
        logicalToCoordinate,
      }),
      priceToY: (value) => value,
    }, width);

    assert.deepEqual(
      geometry.anchors.map(({ x, y, anchor }) => ({ x, y, time: anchor.time, price: anchor.price })),
      [
        { x: 250, y: 5100.5, time: origin + 30 * 60, price: 5100.5 },
        { x: 750, y: 5120.5, time: origin + 90 * 60, price: 5120.5 },
      ],
      `${timeframe}m trend projection`,
    );
  }
  assert.deepEqual(serializeDrawings([stored])[0], serialized);
});

test('Fibonacci preserves direction and uses anchor1 + delta × level', () => {
  const up = createDrawing('fibonacci', [{ time: 1, price: 100 }, { time: 2, price: 120 }]);
  assert.deepEqual(fibonacciPrices(up).map(({ price }) => price), DEFAULT_FIBONACCI_LEVELS.map((level) => 100 + 20 * level));
  const down = createDrawing('fibonacci', [{ time: 1, price: 120 }, { time: 2, price: 100 }], { levels: [0, 0.5, 1] });
  assert.deepEqual(fibonacciPrices(down), [{ level: 0, price: 120 }, { level: 0.5, price: 110 }, { level: 1, price: 100 }]);
});

test('validates configurable Fibonacci levels', () => {
  assert.deepEqual(parseFibonacciLevels('0, .5, 1'), [0, 0.5, 1]);
  assert.throws(() => parseFibonacciLevels('0'), /2–12/);
  assert.throws(() => parseFibonacciLevels('0,,1'), /empty/);
  assert.throws(() => parseFibonacciLevels('0,nope,1'), /finite/);
});

test('geometry hit testing selects anchors before line bodies', () => {
  const drawing = createDrawing('trend', [{ time: 10, price: 10 }, { time: 40, price: 40 }], { id: 'line' });
  const project = { timeToX: (value) => value, priceToY: (value) => value };
  assert.deepEqual(hitTestDrawings([drawing], { x: 10, y: 10 }, project, 100), { drawingId: 'line', anchorIndex: 0 });
  assert.deepEqual(hitTestDrawings([drawing], { x: 25, y: 25 }, project, 100), { drawingId: 'line', anchorIndex: null });
  assert.equal(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
});
