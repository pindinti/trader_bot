import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_FIBONACCI_LEVELS,
  createDrawing,
  distanceToSegment,
  fibonacciPrices,
  hitTestDrawings,
  parseFibonacciLevels,
  projectTimeCoordinate,
  serializeDrawings,
} from '../src/drawings.js';

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
