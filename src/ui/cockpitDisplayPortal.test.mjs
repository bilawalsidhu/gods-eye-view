import test from 'node:test';
import assert from 'node:assert/strict';
import { CockpitDisplayPortal } from './cockpitDisplayPortal.js';

function fixture() {
  const prior = Object.fromEntries(
    ['document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame'].map(
      (key) => [key, globalThis[key]],
    ),
  );
  const frames = new Map();
  let nextFrame = 0;
  let focusCalls = 0;
  let layouts = 0;
  class Node extends EventTarget {
    constructor(name) {
      super();
      this.name = name;
      this.children = [];
      this.parentNode = null;
      this.scrollTop = 0;
      this.classList = { toggle() {}, remove() {} };
    }
    append(node) {
      node.remove();
      this.children.push(node);
      node.parentNode = this;
    }
    remove() {
      if (this.parentNode)
        this.parentNode.children.splice(
          this.parentNode.children.indexOf(this),
          1,
        );
      this.parentNode = null;
    }
    before(node) {
      node.remove();
      const parent = this.parentNode;
      parent.children.splice(parent.children.indexOf(this), 0, node);
      node.parentNode = parent;
    }
    after(node) {
      node.remove();
      const parent = this.parentNode;
      parent.children.splice(parent.children.indexOf(this) + 1, 0, node);
      node.parentNode = parent;
    }
    contains(node) {
      return (
        this === node || this.children.some((child) => child.contains(node))
      );
    }
    focus() {
      focusCalls += 1;
      document.activeElement = this;
    }
  }
  const standard = new Node('standard');
  standard.scrollTop = 71;
  const cockpit = new Node('cockpit');
  cockpit.scrollTop = 19;
  const group = new Node('group');
  const sibling = new Node('sibling');
  const slot = new Node('slot');
  standard.append(group);
  standard.append(sibling);
  cockpit.append(slot);
  cockpit.querySelector = () => slot;
  globalThis.document = {
    createComment: (name) => new Node(name),
    activeElement: group,
    body: { classList: { contains: () => false } },
  };
  globalThis.window = new EventTarget();
  globalThis.requestAnimationFrame = (fn) => {
    const id = ++nextFrame;
    frames.set(id, fn);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const create = () =>
    new CockpitDisplayPortal({
      standardPanel: standard,
      cockpitPanel: cockpit,
      groups: [['hud', group]],
      layout: () => {
        layouts += 1;
      },
    });
  return {
    standard,
    cockpit,
    group,
    sibling,
    slot,
    frames,
    create,
    get focusCalls() {
      return focusCalls;
    },
    get layouts() {
      return layouts;
    },
    flush() {
      while (frames.size) {
        const batch = [...frames.values()];
        frames.clear();
        batch.forEach((fn) => fn());
      }
    },
    restore() {
      Object.assign(globalThis, prior);
    },
  };
}

test('Display groups return to their exact home with independent scroll positions', () => {
  const f = fixture();
  try {
    const owner = f.create();
    owner.setActive(true);
    assert.equal(f.group.parentNode, f.slot);
    f.cockpit.scrollTop = 0;
    f.flush();
    assert.equal(f.cockpit.scrollTop, 19);
    assert.equal(f.focusCalls, 1);
    owner.setActive(false);
    f.standard.scrollTop = 0;
    f.flush();
    assert.equal(f.standard.scrollTop, 71);
    owner.destroy();
    assert.deepEqual(f.standard.children, [f.group, f.sibling]);
    assert.equal(f.frames.size, 0);
  } finally {
    f.restore();
  }
});

test('superseded portal frames cannot restore obsolete focus or scroll', () => {
  const f = fixture();
  try {
    const owner = f.create();
    owner.setActive(true);
    const obsolete = [...f.frames.values()];
    owner.setActive(false);
    f.cockpit.scrollTop = 93;
    obsolete.forEach((callback) => callback());
    assert.equal(f.focusCalls, 0);
    assert.equal(f.cockpit.scrollTop, 93);
    f.flush();
    assert.equal(f.focusCalls, 1);
    assert.equal(owner.restoreOwner, null);
    owner.destroy();
  } finally {
    f.restore();
  }
});

test('disposal restores groups and revokes mode listeners and queued focus work', () => {
  const f = fixture();
  try {
    const owner = f.create();
    window.dispatchEvent(
      new CustomEvent('gev:cockpit-mode-changed', { detail: { active: true } }),
    );
    assert.equal(f.group.parentNode, f.slot);
    const obsolete = [...f.frames.values()];
    owner.destroy();
    owner.destroy();
    obsolete.forEach((callback) => callback());
    window.dispatchEvent(
      new CustomEvent('gev:cockpit-mode-changed', { detail: { active: true } }),
    );
    owner.setActive(true);
    assert.deepEqual(f.standard.children, [f.group, f.sibling]);
    assert.equal(f.frames.size, 0);
    assert.equal(f.focusCalls, 0);
    assert.equal(f.layouts, 1);
  } finally {
    f.restore();
  }
});

test('a stopped portal waits for cleanup without running queued focus work', () => {
  const f = fixture();
  try {
    const owner = f.create();
    owner.setActive(true);
    const queued = [...f.frames.values()];
    owner.stop();
    queued.forEach((callback) => callback());
    owner.setActive(false);
    assert.equal(f.group.parentNode, f.slot);
    assert.equal(f.frames.size, 0);
    assert.equal(f.focusCalls, 0);
    owner.destroy();
    assert.deepEqual(f.standard.children, [f.group, f.sibling]);
  } finally {
    f.restore();
  }
});
