import assert from 'node:assert/strict';
import test from 'node:test';
import { outerEdges } from './edges.js';

const square = (x0, y0, x1, y1) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

test('a lone piece keeps its lines as given', () => {
  const ring = square(0, 0, 1, 1);
  const outline = [ring.slice(0, 3)];
  assert.deepEqual(outerEdges([{ polygons: [[ring]], outline }]), [outline]);
});

test('a line along another piece of the fire is cut out, whichever way either runs', () => {
  const old = {
    polygons: [[square(0, 0, 1, 1)]],
    outline: [square(0, 0, 1, 1)],
  };
  // Growth east of it, its ring running the other way round.
  const east = square(1, 0, 2, 1).toReversed();
  const growth = {
    polygons: [[east]],
    outline: [
      [
        [1, 0],
        [2, 0],
        [2, 1],
        [1, 1],
      ],
    ],
  };
  assert.deepEqual(outerEdges([old, growth]), [
    [
      [
        [0, 0],
        [1, 0],
      ],
      [
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ],
    growth.outline,
  ]);
});

test('a line the piece shares with no other ring stays, even inside its own hole', () => {
  const hole = square(0.4, 0.4, 0.6, 0.6);
  const ring = square(0, 0, 1, 1);
  const pieces = [
    { polygons: [[ring, hole]], outline: [ring, hole] },
    // Another piece elsewhere in the fire.
    { polygons: [[square(5, 5, 6, 6)]], outline: [square(5, 5, 6, 6)] },
  ];
  assert.deepEqual(
    outerEdges(pieces).map((runs) => runs.length),
    [2, 1],
  );
});

test('a segment of no length goes as the one before it', () => {
  const old = {
    polygons: [[square(0, 0, 1, 1)]],
    outline: [
      [
        [0, 0],
        [1, 0],
        [1, 0],
        [1, 1],
      ],
    ],
  };
  const growth = {
    polygons: [[square(1, 0, 2, 1)]],
    outline: [square(1, 0, 2, 1).slice(0, 4)],
  };
  assert.deepEqual(outerEdges([old, growth])[0], [
    [
      [0, 0],
      [1, 0],
      [1, 0],
    ],
  ]);
  // After a cut, it starts no run of its own.
  const after = {
    ...old,
    outline: [
      [
        [1, 1],
        [1, 0],
        [1, 0],
        [0, 0],
      ],
    ],
  };
  assert.deepEqual(outerEdges([after, growth])[0], [
    [
      [1, 0],
      [0, 0],
    ],
  ]);
});
