import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAW_COLORS,
  DRAW_COLOR_CSS,
  drawMarkFallbackName,
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
