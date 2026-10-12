import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotSelection } from './cameraSnapshotSelection.js';
test('no or tiny marks have no selected region', () => {
  assert.equal(snapshotSelection([], 320, 244), null);
  assert.equal(
    snapshotSelection(
      [{ mode: 'circle', points: [{ x: 0.2, y: 0.3 }] }],
      320,
      244,
    ),
    null,
  );
  assert.equal(
    snapshotSelection(
      [
        {
          mode: 'region',
          points: [
            { x: 0.2, y: 0.3 },
            { x: 0.201, y: 0.301 },
          ],
        },
      ],
      320,
      244,
    ),
    null,
  );
});
test('circle/freehand use a bounded crop from the latest valid mark in original-image coordinates', () => {
  const marks = [
    {
      mode: 'circle',
      points: [
        { x: 0.2, y: 0.3 },
        { x: 0.8, y: 0.7 },
      ],
    },
    {
      mode: 'marker',
      points: [
        { x: 0.5, y: 0.5 },
        { x: 0.9, y: 0.9 },
        { x: 0.6, y: 0.8 },
      ],
    },
  ];
  const selected = snapshotSelection(marks, 320, 244);
  assert.equal(selected.mode, 'marker');
  assert.equal(selected.markIndex, 1);
  assert.deepEqual(selected.pixelBounds, {
    x: 160,
    y: 122,
    width: 128,
    height: 98,
  });
  assert.deepEqual(snapshotSelection(marks.slice(0, 1), 320, 244).pixelBounds, {
    x: 64,
    y: 73,
    width: 192,
    height: 98,
  });
});
test('out-of-range points and tiny later taps cannot replace the last valid selection', () => {
  const marks = [
    {
      mode: 'region',
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 99, y: -4 },
      ],
    },
    { mode: 'circle', points: [{ x: 0.2, y: 0.2 }] },
  ];
  assert.deepEqual(snapshotSelection(marks, 320, 244).pixelBounds, {
    x: 0,
    y: 0,
    width: 320,
    height: 244,
  });
  assert.equal(snapshotSelection(marks, 0, 244), null);
});
