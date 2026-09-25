import test from 'node:test';
import assert from 'node:assert/strict';
import { attachCreditDock } from './creditsDock.js';

/** Minimal element stub — enough surface for the dock's DOM writes. */
class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentElement = null;
    this.className = '';
    this.dataset = {};
    this.isConnected = false;
  }

  appendChild(child) {
    child.parentElement = this;
    child.isConnected = this.isConnected || this.tagName === 'BODY';
    this.children.push(child);
    return child;
  }
}

function makeDoc() {
  const body = new FakeEl('BODY');
  const doc = { body, created: [] };
  doc.createElement = (tag) => {
    const el = new FakeEl(tag);
    doc.created.push(el);
    return el;
  };
  return doc;
}

test('attachCreditDock wraps the detached credit container and appends it to body', () => {
  const doc = makeDoc();
  const container = new FakeEl('div');
  const dock = attachCreditDock({ creditContainer: container }, doc);
  assert.equal(dock.className, 'gev-credit-dock');
  assert.equal(dock.dataset.testid, 'credit-dock');
  assert.equal(dock.parentElement, doc.body);
  assert.ok(doc.body.children.includes(dock));
  // The viewer's OWN container is docked, not re-created: Cesium's credit
  // display lives inside it, and C13/#cesium-credits depends on the id.
  assert.equal(dock.children[0], container);
});

test('attachCreditDock is idempotent — a connected container is never re-wrapped', () => {
  const doc = makeDoc();
  const container = new FakeEl('div');
  const first = attachCreditDock({ creditContainer: container }, doc);
  // Simulate the container being live in the document already.
  container.isConnected = true;
  const second = attachCreditDock({ creditContainer: container }, doc);
  assert.equal(second, first);
  assert.equal(doc.body.children.filter((el) => el.className === 'gev-credit-dock').length, 1);
});

test('attachCreditDock resolves the live element from cesiumWidget when the Viewer lacks creditContainer', () => {
  // Cesium's Viewer forwards the creditContainer option into the widget — the
  // Viewer itself has no such property (installed-source verified), so the
  // dock must read viewer.cesiumWidget.creditContainer.
  const doc = makeDoc();
  const container = new FakeEl('div');
  const dock = attachCreditDock({ cesiumWidget: { creditContainer: container } }, doc);
  assert.equal(dock.parentElement, doc.body);
  assert.equal(dock.children[0], container);
});

test('attachCreditDock returns null instead of throwing on missing inputs', () => {
  assert.equal(attachCreditDock(null, makeDoc()), null);
  assert.equal(attachCreditDock({}, makeDoc()), null);
  assert.equal(attachCreditDock({ creditContainer: new FakeEl("div") }, { created: [] }), null);
  // Default-document path: no crash when `document` is undefined (node).
  const saved = globalThis.document;
  delete globalThis.document;
  try {
    assert.equal(attachCreditDock({ creditContainer: new FakeEl('div') }), null);
  } finally {
    globalThis.document = saved;
  }
});
