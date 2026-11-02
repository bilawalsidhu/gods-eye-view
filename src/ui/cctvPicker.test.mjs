// src/ui/cctvPicker.test.mjs — the camera picker lists the cameras in view and
// says how many more the view leaves out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CctvControls } from './cctvControls.js';

/** The slice of a <select> and its document the picker touches. */
function pickerDocument() {
  const select = new EventTarget();
  const option = () => ({
    value: '',
    textContent: '',
    disabled: false,
    dataset: {},
    remove() {
      select.options = select.options.filter((entry) => entry !== this);
    },
  });
  Object.assign(select, {
    options: [],
    disabled: false,
    selectedIndex: -1,
    get value() {
      return this.options[this.selectedIndex]?.value ?? '';
    },
    set value(id) {
      this.selectedIndex = this.options.findIndex((o) => o.value === id);
    },
    replaceChildren(fragment) {
      this.options = [...fragment.children];
      this.selectedIndex = this.options.length ? 0 : -1;
    },
    prepend(child) {
      this.options.unshift(child);
    },
  });
  const document = {
    activeElement: null,
    createElement: option,
    createDocumentFragment: () => ({
      children: [],
      appendChild(child) {
        this.children.push(child);
      },
    }),
  };
  return { document, select };
}

function fixture(t) {
  const { document, select } = pickerDocument();
  const previous = globalThis.document;
  globalThis.document = document;
  const controls = new CctvControls({
    elements: { _cctvSelect: select },
    cctv: {},
    actions: { isEnabled: () => true, setPanelCollapsed() {} },
  });
  t.after(() => {
    controls.destroy();
    globalThis.document = previous;
  });
  return { controls, select };
}

const camera = (id) => ({ id, city: 'Austin', name: `Cam ${id}` });

test('the picker closes with the count of cameras outside the view', (t) => {
  const { controls, select } = fixture(t);
  controls._renderCctvState({
    enabled: true,
    count: 40,
    cameraIndex: [camera('a'), camera('b')],
  });
  assert.deepEqual(
    select.options.map((o) => o.value),
    ['a', 'b', ''],
  );
  const note = select.options[2];
  assert.equal(note.disabled, true);
  assert.equal(
    note.textContent,
    '38 more cameras outside this view · pan or zoom out',
  );
  assert.equal(select.selectedIndex, -1, 'nothing active, nothing picked');

  controls._renderCctvState({
    enabled: true,
    count: 2,
    cameraIndex: [camera('a'), camera('b')],
  });
  assert.deepEqual(
    select.options.map((o) => o.value),
    ['a', 'b'],
    'a view holding every camera has no note',
  );
});

test('with no camera in view, the closed picker shows the note', (t) => {
  const { controls, select } = fixture(t);
  controls._renderCctvState({ enabled: true, count: 1, cameraIndex: [] });
  assert.equal(select.options.length, 1);
  assert.equal(
    select.options[select.selectedIndex].textContent,
    '1 more camera outside this view · pan or zoom out',
  );
});

test('a disabled layer has no note', (t) => {
  const { controls, select } = fixture(t);
  controls._renderCctvState({ enabled: false, count: 40, cameraIndex: [] });
  assert.equal(select.options.length, 0);
  assert.equal(select.selectedIndex, -1);
});

test('a camera activated under a focused picker counts against the note', (t) => {
  const { controls, select } = fixture(t);
  const a = camera('a');
  const b = camera('b');
  controls._renderCctvState({
    enabled: true,
    count: 3,
    cameraIndex: [a],
    activeCameraId: 'a',
    activeCamera: a,
  });
  assert.equal(
    select.options.at(-1).textContent,
    '2 more cameras outside this view · pan or zoom out',
  );
  globalThis.document.activeElement = select;
  controls._renderCctvState({
    enabled: true,
    count: 3,
    cameraIndex: [b, a],
    activeCameraId: 'b',
    activeCamera: b,
  });
  assert.deepEqual(
    select.options.map((o) => o.value),
    ['b', 'a', ''],
  );
  assert.equal(
    select.options.at(-1).textContent,
    '1 more camera outside this view · pan or zoom out',
  );
  assert.equal(select.value, 'b');
});

test('a focused picker does not pick a stale camera when the view empties', (t) => {
  const { controls, select } = fixture(t);
  controls._renderCctvState({
    enabled: true,
    count: 3,
    cameraIndex: [camera('a')],
  });
  globalThis.document.activeElement = select;
  controls._renderCctvState({ enabled: true, count: 3, cameraIndex: [] });
  assert.equal(select.selectedIndex, -1);
});
