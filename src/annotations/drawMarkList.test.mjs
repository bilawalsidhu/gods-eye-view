import test from 'node:test';
import assert from 'node:assert/strict';
import { createDrawMarkList, drawMarkFallbackName } from './drawMarkList.js';

/** Just enough DOM for the list: rows, inputs, buttons, attributes, focus. */
function fakeDocument() {
  const doc = { activeElement: null };
  const matches = (node, selector) => {
    const attr = /^\[data-([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (!attr) return false;
    const key = attr[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return attr[2] === undefined
      ? node.dataset[key] !== undefined
      : node.dataset[key] === attr[2];
  };
  doc.createElement = (tag) => {
    const classes = new Set();
    const node = {
      tagName: tag.toUpperCase(),
      ownerDocument: doc,
      parent: null,
      children: [],
      dataset: {},
      style: {},
      attributes: new Map(),
      value: '',
      placeholder: '',
      title: '',
      textContent: '',
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      },
      set className(value) {
        classes.clear();
        for (const name of String(value).split(/\s+/).filter(Boolean))
          classes.add(name);
      },
      get className() {
        return [...classes].join(' ');
      },
      setAttribute(key, value) {
        this.attributes.set(key, String(value));
      },
      getAttribute(key) {
        return this.attributes.get(key) ?? null;
      },
      get parentNode() {
        return this.parent;
      },
      append(...nodes) {
        for (const child of nodes) this.insertBefore(child, null);
      },
      insertBefore(child, before) {
        child.remove();
        child.parent = this;
        const at = before ? this.children.indexOf(before) : -1;
        if (at < 0) this.children.push(child);
        else this.children.splice(at, 0, child);
      },
      remove() {
        // Like a browser, taking the focused node out of the page blurs it.
        if (doc.activeElement && this.contains(doc.activeElement))
          doc.activeElement = null;
        if (this.parent)
          this.parent.children = this.parent.children.filter(
            (node) => node !== this,
          );
        this.parent = null;
      },
      replaceChildren(...nodes) {
        for (const child of [...this.children]) child.remove();
        this.append(...nodes);
      },
      closest(selector) {
        let node = this;
        while (node && !matches(node, selector)) node = node.parent;
        return node || null;
      },
      querySelectorAll(selector) {
        const found = [];
        const walk = (node) => {
          for (const child of node.children) {
            if (matches(child, selector)) found.push(child);
            walk(child);
          }
        };
        walk(this);
        return found;
      },
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
      },
      contains(other) {
        for (let node = other; node; node = node.parent)
          if (node === this) return true;
        return false;
      },
      focus() {
        doc.activeElement = this;
      },
      blur() {
        if (doc.activeElement === this) doc.activeElement = null;
      },
    };
    return node;
  };
  return doc;
}

function harness(initial) {
  const doc = fakeDocument();
  const listEl = doc.createElement('ul');
  const listeners = {};
  const listen = (target, type, listener) => {
    listeners[type] = listener;
  };
  let marks = initial.map((mark) => ({ hidden: false, ...mark }));
  const changeListeners = new Set();
  const changed = () => changeListeners.forEach((listener) => listener());
  const calls = [];
  const annotations = {
    list: () => marks,
    onChange: (listener) => {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    remove(id) {
      calls.push(['remove', id]);
      marks = marks.filter((mark) => mark.id !== id);
      changed();
    },
    setHidden(id, hidden) {
      calls.push(['hide', id, hidden]);
      marks.find((mark) => mark.id === id).hidden = hidden;
      changed();
    },
    frame(id) {
      calls.push(['frame', id]);
    },
    restyle(id, change) {
      calls.push(['restyle', id, change]);
      Object.assign(
        marks.find((mark) => mark.id === id),
        change,
      );
      changed();
    },
  };
  const list = createDrawMarkList({ listEl, annotations, listen });
  const rows = () => listEl.children;
  const control = (row, name) => row.querySelector(`[data-control="${name}"]`);
  const click = (target) => listeners.click({ target });
  const addMark = (mark) => {
    marks = [...marks, { hidden: false, ...mark }];
    changed();
  };
  return {
    list,
    listEl,
    listeners,
    rows,
    control,
    click,
    calls,
    changed,
    addMark,
    changeListeners,
  };
}

const LINE = {
  id: 'a1',
  type: 'route',
  manual: true,
  name: null,
  label: '1.2 km',
  color: 'primary',
};
const PIN = {
  id: 'a2',
  type: 'pin',
  manual: true,
  name: 'Camp',
  label: 'Camp',
  color: 'amber',
};
const VOICE = {
  id: 'a3',
  type: 'area',
  manual: false,
  label: 'Texas',
  color: 'primary',
};

test('lists only hand-drawn marks, named or by shape, with Import-style actions', () => {
  const { rows, control, listEl } = harness([LINE, PIN, VOICE]);
  assert.deepEqual(
    rows().map((row) => row.dataset.markId),
    ['a1', 'a2'],
  );
  assert.ok(listEl.classList.contains('visible'));
  const [line, pin] = rows();
  assert.equal(control(line, 'name').value, '');
  assert.equal(control(line, 'name').placeholder, 'Line · 1.2 km');
  assert.equal(control(pin, 'name').value, 'Camp');
  assert.equal(control(pin, 'swatch').style.background, '#ffb547');
  assert.equal(control(pin, 'toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(control(pin, 'fly').getAttribute('aria-label'), 'Fly to Camp');
  assert.equal(
    control(pin, 'remove').getAttribute('aria-label'),
    'Remove Camp',
  );
});

test('show/hide, fly to and remove act on that one mark', () => {
  const { rows, control, click, calls } = harness([LINE, PIN]);
  click(control(rows()[1], 'toggle'));
  assert.deepEqual(calls.at(-1), ['hide', 'a2', true]);
  assert.equal(
    control(rows()[1], 'toggle').getAttribute('aria-pressed'),
    'false',
  );
  assert.ok(rows()[1].classList.contains('hidden-mark'));
  click(control(rows()[0], 'fly'));
  assert.deepEqual(calls.at(-1), ['frame', 'a1']);
  click(control(rows()[0], 'remove'));
  assert.deepEqual(calls.at(-1), ['remove', 'a1']);
  assert.deepEqual(
    rows().map((row) => row.dataset.markId),
    ['a2'],
  );
});

test('the swatch opens a colour picker in the row; a colour restyles the mark', () => {
  const { rows, control, click, calls } = harness([LINE]);
  click(control(rows()[0], 'swatch'));
  assert.equal(
    control(rows()[0], 'swatch').getAttribute('aria-expanded'),
    'true',
  );
  const red = control(rows()[0], 'color-red');
  assert.ok(red, 'the picker offers every colour');
  click(red);
  assert.deepEqual(calls.at(-1), ['restyle', 'a1', { color: 'red' }]);
  assert.equal(
    control(rows()[0], 'color-red'),
    null,
    'choosing closes the picker',
  );
  assert.equal(control(rows()[0], 'swatch').style.background, '#ff6b6b');
});

test('a name is committed on Enter or blur, and Escape undoes the edit without leaving Draw', () => {
  const { rows, control, listeners, calls } = harness([LINE, PIN]);
  const name = control(rows()[0], 'name');
  name.value = '  Ridge walk ';
  listeners.keydown({ key: 'Enter', target: name, preventDefault() {} });
  assert.deepEqual(calls.at(-1), ['restyle', 'a1', { name: 'Ridge walk' }]);

  const pinName = control(rows()[1], 'name');
  pinName.value = 'Base';
  let stopped = false;
  listeners.keydown({
    key: 'Escape',
    target: pinName,
    preventDefault() {},
    stopPropagation() {
      stopped = true;
    },
  });
  assert.equal(pinName.value, 'Camp', 'Escape restores the name');
  assert.ok(stopped, 'Escape stays in the field');

  const count = calls.length;
  listeners.focusout({ target: control(rows()[1], 'name') });
  assert.equal(calls.length, count, 'an unchanged name costs nothing');
  control(rows()[1], 'name').value = 'Base';
  listeners.focusout({ target: control(rows()[1], 'name') });
  assert.deepEqual(calls.at(-1), ['restyle', 'a2', { name: 'Base' }]);
});

test('a re-render keeps focus on the same control, and destroy stops listening', () => {
  const { rows, control, list, listEl, changed, changeListeners } = harness([
    LINE,
  ]);
  control(rows()[0], 'fly').focus();
  changed();
  assert.equal(listEl.ownerDocument.activeElement, control(rows()[0], 'fly'));
  list.destroy();
  assert.equal(changeListeners.size, 0, 'destroy unsubscribes from the board');
  assert.equal(rows().length, 0);
  assert.ok(!listEl.classList.contains('visible'));
  changed();
  assert.equal(rows().length, 0, 'a destroyed list does not re-render');
});

test('an unnamed shape is called by its kind', () => {
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

test('a board change while a name is being typed keeps the draft and the row', () => {
  const { rows, control, listEl, addMark, calls } = harness([LINE, PIN]);
  const name = control(rows()[0], 'name');
  name.focus();
  name.value = 'Half-typ';
  // A voice mark lands, and another hand-drawn one: neither may wipe the draft.
  addMark(VOICE);
  addMark({ ...PIN, id: 'a4', name: null, label: '' });
  assert.equal(control(rows()[0], 'name'), name, 'the row is not rebuilt');
  assert.equal(name.value, 'Half-typ', 'the typed text survives');
  assert.equal(listEl.ownerDocument.activeElement, name, 'focus stays');
  assert.equal(calls.length, 0, 'nothing is committed early');
  assert.deepEqual(
    rows().map((row) => row.dataset.markId),
    ['a1', 'a2', 'a4'],
  );
});

test('a click right after typing a name still reaches its button', () => {
  const { rows, control, listeners, click, calls } = harness([LINE, PIN]);
  const name = control(rows()[0], 'name');
  name.focus();
  name.value = 'Home';
  const hide = control(rows()[1], 'toggle');
  const remove = control(rows()[0], 'remove');
  // mousedown on a button blurs the field first, which commits the name.
  name.blur();
  listeners.focusout({ target: name });
  assert.deepEqual(calls.at(-1), ['restyle', 'a1', { name: 'Home' }]);
  assert.equal(control(rows()[1], 'toggle'), hide, 'the button is still there');
  click(hide);
  assert.deepEqual(calls.at(-1), ['hide', 'a2', true]);
  click(remove);
  assert.deepEqual(calls.at(-1), ['remove', 'a1']);
});

test('picking a colour returns focus to the swatch; Escape closes the picker', () => {
  const { rows, control, click, listeners, listEl, calls } = harness([LINE]);
  const doc = listEl.ownerDocument;
  click(control(rows()[0], 'swatch'));
  click(control(rows()[0], 'color-primary'));
  assert.equal(calls.length, 0, 'the colour it already has costs nothing');
  assert.equal(doc.activeElement, control(rows()[0], 'swatch'));

  click(control(rows()[0], 'swatch'));
  const amber = control(rows()[0], 'color-amber');
  amber.focus();
  let stopped = false;
  listeners.keydown({
    key: 'Escape',
    target: amber,
    preventDefault() {},
    stopPropagation() {
      stopped = true;
    },
  });
  assert.ok(stopped, 'Escape does not reach Draw');
  assert.equal(control(rows()[0], 'color-amber'), null, 'the picker closed');
  assert.equal(doc.activeElement, control(rows()[0], 'swatch'));
});
