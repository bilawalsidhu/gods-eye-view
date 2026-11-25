import assert from 'node:assert/strict';

const describe = (node) =>
  node?.nodeType === 1
    ? `<${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}>`
    : String(node);

/**
 * Assert that two DOM nodes (or a node and null) are the same. Never hand
 * happy-dom nodes to assert.equal or deepEqual: a failure prints both, and a
 * node reaches the whole page and window, which runs the process out of
 * memory.
 */
export function assertSameNode(actual, expected, message = '') {
  assert.ok(
    actual === expected,
    `${message ? `${message}: ` : ''}${describe(actual)} is not ${describe(expected)}`,
  );
}
