import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeapSnapshotSizes } from './heapSnapshotSizes.mjs';

test('a streamed heap snapshot is sized per node type, however it is chunked', () => {
  const snapshot = JSON.stringify({
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'],
        node_types: [['hidden', 'object', 'code'], 'string', 'number'],
      },
      node_count: 4,
    },
    nodes: [1, 0, 1, 100, 0, 2, 0, 2, 4000, 0, 1, 0, 3, 23, 0, 0, 0, 4, 7, 0],
    edges: [9, 9],
    strings: ['x'],
  });
  for (const size of [snapshot.length, 7, 1]) {
    const sizes = createHeapSnapshotSizes();
    for (let i = 0; i < snapshot.length; i += size)
      sizes.push(snapshot.slice(i, i + size));
    assert.deepEqual(sizes.result(), { object: 123, code: 4000, hidden: 7 });
  }
});
