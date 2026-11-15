import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAW_COLORS,
  DRAW_COLOR_CSS,
  drawMarkActions,
  drawMarkActionsFor,
  drawMarkFallbackName,
  drawMarkGeometry,
  presentDrawMarks,
} from './drawMarks.js';

test('an unnamed shape is called by its kind, and an unnamed line by its length too', () => {
  assert.equal(drawMarkFallbackName({ type: 'area' }), 'Area');
  assert.equal(drawMarkFallbackName({ type: 'pin' }), 'Pin');
  assert.equal(
    drawMarkFallbackName({ type: 'route', label: '300 m' }),
    'Line · 300 m',
  );
  assert.equal(
    drawMarkFallbackName({
      type: 'route',
      name: 'Walk',
      label: 'Walk — 300 m',
    }),
    'Line',
  );
});

test('rows list only hand-drawn marks, in board order, with their words', () => {
  const rows = presentDrawMarks([
    {
      id: 'a1',
      type: 'route',
      manual: true,
      name: null,
      label: '950 m',
      color: 'amber',
    },
    { id: 'a2', type: 'area', manual: false, label: 'Texas', color: 'primary' },
    {
      id: 'a3',
      type: 'pin',
      manual: true,
      name: 'Camp',
      color: 'teal',
      hidden: true,
    },
  ]);
  assert.deepEqual(
    rows.map(({ id, name, placeholder, color, hidden }) => ({
      id,
      name,
      placeholder,
      color,
      hidden,
    })),
    [
      {
        id: 'a1',
        name: '',
        placeholder: 'Line · 950 m',
        color: 'amber',
        hidden: false,
      },
      {
        id: 'a3',
        name: 'Camp',
        placeholder: 'Pin',
        color: 'primary',
        hidden: true,
      },
    ],
  );
  assert.equal(rows[0].labels.toggle, 'Hide Line · 950 m');
  assert.equal(rows[1].labels.toggle, 'Show Camp');
  assert.equal(rows[1].labels.fly, 'Fly to Camp');
  assert.equal(rows[1].labels.colors, 'Colour of Camp');
});

test('every colour has its swatch', () => {
  assert.deepEqual(Object.keys(DRAW_COLOR_CSS), [...DRAW_COLORS]);
});

test("a drawn shape's geometry is GeoJSON in [lon, lat]: a closed area, a line, no pin", () => {
  assert.deepEqual(
    drawMarkGeometry({
      type: 'area',
      ring: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    }),
    {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    },
  );
  assert.deepEqual(
    drawMarkGeometry({
      type: 'area',
      ring: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    }).coordinates[0].at(-1),
    [0, 0],
    'an open ring is closed',
  );
  assert.equal(
    drawMarkGeometry({
      type: 'area',
      ring: [
        [0, 0],
        [1, 0],
      ],
    }),
    null,
  );
  assert.deepEqual(
    drawMarkGeometry({
      type: 'route',
      path: [
        { lon: 1, lat: 2, height: 9 },
        { lon: 3, lat: 4, height: 0 },
      ],
    }),
    {
      type: 'LineString',
      coordinates: [
        [1, 2],
        [3, 4],
      ],
    },
  );
  assert.equal(
    drawMarkGeometry({ type: 'pin', longitude: 1, latitude: 2 }),
    null,
  );
  const square = (x) => [
    [x, 0],
    [x + 1, 0],
    [x + 1, 1],
    [x, 0],
  ];
  assert.deepEqual(
    drawMarkGeometry({
      type: 'area',
      ring: square(0),
      polygons: [[square(0)], [square(5)]],
    }),
    { type: 'MultiPolygon', coordinates: [[square(0)], [square(5)]] },
    'an area handle with several parts keeps them all',
  );
  assert.equal(
    drawMarkGeometry({
      type: 'area',
      polygons: [
        [
          square(0),
          [
            [0.2, 0.2],
            [0.3, 0.2],
          ],
        ],
      ],
    }),
    null,
    'a hole that cannot be given whole is never dropped silently',
  );
});

test('longitudes are wrapped into range, and a shape across the antimeridian has no geometry', () => {
  assert.deepEqual(
    drawMarkGeometry({
      type: 'route',
      path: [
        [370, 1],
        [371, 1],
      ],
    }).coordinates,
    [
      [10, 1],
      [11, 1],
    ],
  );
  assert.deepEqual(
    drawMarkGeometry({
      type: 'area',
      ring: [
        [180, 0],
        [179, 0],
        [179, 1],
      ],
    }).coordinates[0][0],
    [180, 0],
    'the antimeridian itself stays put',
  );
  assert.equal(
    drawMarkGeometry({
      type: 'area',
      ring: [
        [179.9, 0],
        [-179.9, 0],
        [-179.9, 1],
      ],
    }),
    null,
  );
  assert.equal(
    drawMarkGeometry({
      type: 'route',
      path: [
        [179.5, 0],
        [180.5, 0],
      ],
    }),
    null,
  );
  assert.equal(
    drawMarkGeometry({
      type: 'route',
      path: [
        [0, 91],
        [1, 0],
      ],
    }),
    null,
  );
});

test('row actions are checked once: malformed ones and repeated ids are dropped', () => {
  const run = () => {};
  const label = () => 'x';
  const actions = drawMarkActions([
    { id: 'Bad Id', icon: 'a', label, run, shapes: ['area'] },
    { id: 'tag', icon: 'a', label: 'not a function', run, shapes: ['area'] },
    {
      id: 'tag',
      icon: 'sell',
      label,
      run,
      shapes: ['area', 'line', 'pin'],
    },
    { id: 'tag', icon: 'other', label, run, shapes: ['area'] },
    null,
  ]);
  assert.deepEqual(
    actions.map(({ id, icon, shapes }) => ({ id, icon, shapes: [...shapes] })),
    [{ id: 'tag', icon: 'sell', shapes: ['area', 'line'] }],
  );
  assert.deepEqual(drawMarkActions('nope'), []);
  const area = {
    type: 'area',
    ring: [
      [0, 0],
      [1, 0],
      [1, 1],
    ],
  };
  const offer = drawMarkActionsFor(area, actions);
  assert.equal(offer.shape, 'area');
  assert.deepEqual(
    offer.actions.map((a) => a.id),
    ['tag'],
  );
  const refusing = drawMarkActions([
    {
      id: 'measure',
      icon: 'a',
      label,
      run,
      shapes: ['area'],
      accepts: () => {
        throw new Error('no');
      },
    },
  ]);
  assert.deepEqual(
    drawMarkActionsFor(area, refusing).actions,
    [],
    'an accepts that throws offers nothing',
  );
  assert.deepEqual(
    presentDrawMarks([{ id: 'p', type: 'pin', manual: true }], actions)[0]
      .actions,
    [],
  );
});
