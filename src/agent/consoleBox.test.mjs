import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentConsoleDom,
  fakeStorage,
} from '../testSupport/agentConsoleDom.mjs';
import { RESIZE_DIRECTIONS } from '../ui/panelResize.js';
import {
  CONSOLE_BOX_STORAGE_KEY,
  CONSOLE_DEFAULT_SIZE,
  CONSOLE_MIN_SIZE,
  DEFAULT_BOTTOM_CLEARANCE_PX,
  DOUBLE_PRESS_MS,
  VIEWPORT_MARGIN_PX,
  attachConsoleBox,
  clampBox,
  defaultBox,
  readStoredBox,
  startsDrag,
  writeStoredBox,
} from './consoleBox.js';

const DESKTOP = { viewportWidth: 1440, viewportHeight: 900 };

test('a window inside the viewport is kept exactly where it is', () => {
  const box = { left: 100, top: 200, width: 480, height: 380 };
  assert.deepEqual(clampBox(box, DESKTOP), box);
});

test('a window past an edge is pulled back inside the margin', () => {
  const pushed = clampBox(
    { left: 1400, top: 880, width: 480, height: 380 },
    DESKTOP,
  );
  assert.equal(
    pushed.left + pushed.width,
    DESKTOP.viewportWidth - VIEWPORT_MARGIN_PX,
  );
  assert.equal(
    pushed.top + pushed.height,
    DESKTOP.viewportHeight - VIEWPORT_MARGIN_PX,
  );
  const negative = clampBox(
    { left: -500, top: -500, width: 480, height: 380 },
    DESKTOP,
  );
  assert.equal(negative.left, VIEWPORT_MARGIN_PX);
  assert.equal(negative.top, VIEWPORT_MARGIN_PX);
});

test('a window too big for the viewport shrinks rather than hanging off it', () => {
  const huge = clampBox(
    { left: 0, top: 0, width: 5000, height: 5000 },
    DESKTOP,
  );
  assert.equal(huge.width, DESKTOP.viewportWidth - 2 * VIEWPORT_MARGIN_PX);
  assert.equal(huge.height, DESKTOP.viewportHeight - 2 * VIEWPORT_MARGIN_PX);
  assert.equal(huge.left, VIEWPORT_MARGIN_PX);
});

test('the minimum size wins over a viewport too small to hold it', () => {
  const tiny = clampBox(
    { left: 0, top: 0, width: 10, height: 10 },
    { viewportWidth: 200, viewportHeight: 150 },
  );
  assert.equal(tiny.width, CONSOLE_MIN_SIZE.width);
  assert.equal(tiny.height, CONSOLE_MIN_SIZE.height);
  // The corner stays reachable rather than being pushed negative.
  assert.equal(tiny.left, VIEWPORT_MARGIN_PX);
  assert.equal(tiny.top, VIEWPORT_MARGIN_PX);
});

test('geometry is rounded, so no sub-pixel value reaches a style property', () => {
  const box = clampBox(
    { left: 10.4, top: 20.6, width: 480.5, height: 380.2 },
    DESKTOP,
  );
  for (const value of Object.values(box))
    assert.equal(value, Math.round(value));
});

test('the default window sits on the left, clear of the map attribution', () => {
  const box = defaultBox(DESKTOP);
  assert.equal(box.left, 14, 'the default should hug the left edge');
  assert.ok(
    box.left + box.width < DESKTOP.viewportWidth / 2,
    'the default should not cross the middle of the screen',
  );
  // The credit line is a licence condition, so the window must end above it.
  assert.equal(
    box.top + box.height,
    DESKTOP.viewportHeight - DEFAULT_BOTTOM_CLEARANCE_PX,
  );
  assert.equal(box.width, CONSOLE_DEFAULT_SIZE.width);
  assert.equal(box.height, CONSOLE_DEFAULT_SIZE.height);
});

test('the default window still fits a short viewport', () => {
  for (const viewportHeight of [1080, 900, 768, 600, 400]) {
    const box = defaultBox({ viewportWidth: 1280, viewportHeight });
    assert.ok(
      box.top >= VIEWPORT_MARGIN_PX,
      `top ${box.top} at ${viewportHeight}`,
    );
    assert.ok(
      box.top + box.height <= viewportHeight - VIEWPORT_MARGIN_PX,
      `bottom ${box.top + box.height} at ${viewportHeight}`,
    );
    assert.ok(box.height >= CONSOLE_MIN_SIZE.height);
  }
});

test('a remembered window round-trips, and junk in storage is ignored', () => {
  const storage = fakeStorage();
  assert.equal(readStoredBox(storage), null);
  const box = { left: 1, top: 2, width: 480, height: 380 };
  writeStoredBox(box, storage);
  assert.deepEqual(readStoredBox(storage), box);
  for (const junk of [
    'not json',
    '7',
    '{"left":1}',
    '{"left":"x","top":2,"width":3,"height":4}',
  ]) {
    storage.setItem(CONSOLE_BOX_STORAGE_KEY, junk);
    assert.equal(readStoredBox(storage), null, `accepted ${junk}`);
  }
});

test('writing null forgets the window', () => {
  const storage = fakeStorage();
  writeStoredBox({ left: 1, top: 2, width: 3, height: 4 }, storage);
  writeStoredBox(null, storage);
  assert.equal(readStoredBox(storage), null);
});

test('storage that throws degrades to no preference instead of breaking', () => {
  const storage = fakeStorage({ throws: true });
  assert.equal(readStoredBox(storage), null);
  assert.doesNotThrow(() =>
    writeStoredBox({ left: 1, top: 2, width: 3, height: 4 }, storage),
  );
});

test('a press on a header control is that control, not a drag', () => {
  const plain = { button: 0, target: { closest: () => null } };
  assert.equal(startsDrag(plain), true);
  const onSelect = { button: 0, target: { closest: () => ({}) } };
  assert.equal(startsDrag(onSelect), false);
  const rightClick = { button: 2, target: { closest: () => null } };
  assert.equal(startsDrag(rightClick), false);
});

/** Mount the box controller over the fixture's dialog and header. */
function mounted({ storage = fakeStorage() } = {}) {
  const dom = agentConsoleDom();
  const box = attachConsoleBox({
    dialog: dom.dialog,
    handle: dom.header,
    root: dom.document,
    view: dom.view,
    storage,
  });
  return { dom, box, storage };
}

/** Drive one pointer gesture from `from` by (dx, dy). */
function drag(dom, element, from, dx, dy) {
  dom.pointer(element, 'pointerdown', from);
  dom.pointer(element, 'pointermove', {
    x: from.x + dx / 2,
    y: from.y + dy / 2,
  });
  dom.pointer(element, 'pointermove', { x: from.x + dx, y: from.y + dy });
  dom.pointer(element, 'pointerup', { x: from.x + dx, y: from.y + dy });
}

test('attaching requires something to position and something to grab', () => {
  assert.throws(
    () => attachConsoleBox({ dialog: null, handle: {} }),
    TypeError,
  );
  assert.throws(
    () => attachConsoleBox({ dialog: {}, handle: null }),
    TypeError,
  );
});

test('a resize handle is added for every direction, and removed on destroy', () => {
  const { dom, box } = mounted();
  const grips = dom.dialog.children.filter((child) => child.dataset.dir);
  assert.deepEqual(
    grips.map((grip) => grip.dataset.dir).sort(),
    [...RESIZE_DIRECTIONS].sort(),
  );
  // The corner grip reuses the app's existing handle classes rather than
  // introducing a second set.
  assert.equal(
    grips.find((g) => g.dataset.dir === 'se').className,
    'panel-resize-grip',
  );
  assert.equal(
    grips.find((g) => g.dataset.dir === 'n').className,
    'panel-resize-edge',
  );
  for (const grip of grips)
    assert.equal(grip.getAttribute('aria-hidden'), 'true');
  box.destroy();
  assert.equal(
    dom.dialog.children.filter((child) => child.dataset.dir).length,
    0,
  );
});

test('applying places the default window and writes it to the style', () => {
  const { dom, box } = mounted();
  box.apply();
  const expected = defaultBox(DESKTOP);
  assert.deepEqual(box.box, expected);
  assert.equal(dom.dialog.style.left, `${expected.left}px`);
  assert.equal(dom.dialog.style.top, `${expected.top}px`);
  assert.equal(dom.dialog.style.width, `${expected.width}px`);
  assert.equal(dom.dialog.style.height, `${expected.height}px`);
  // The stylesheet's corner anchor has to be cleared or both would apply.
  assert.equal(dom.dialog.style.right, 'auto');
  assert.equal(dom.dialog.style.bottom, 'auto');
});

test('applying prefers a remembered window over the default', () => {
  const storage = fakeStorage();
  writeStoredBox({ left: 300, top: 120, width: 600, height: 400 }, storage);
  const { box } = mounted({ storage });
  box.apply();
  assert.deepEqual(box.box, { left: 300, top: 120, width: 600, height: 400 });
});

test('a remembered window from a bigger screen is clamped, not restored off-screen', () => {
  const storage = fakeStorage();
  writeStoredBox({ left: 3000, top: 1800, width: 900, height: 700 }, storage);
  const { box } = mounted({ storage });
  box.apply();
  assert.ok(
    box.box.left + box.box.width <= DESKTOP.viewportWidth - VIEWPORT_MARGIN_PX,
  );
  assert.ok(
    box.box.top + box.box.height <= DESKTOP.viewportHeight - VIEWPORT_MARGIN_PX,
  );
});

test('dragging the header moves the window and remembers where it was left', () => {
  const { dom, box, storage } = mounted();
  box.apply();
  const before = box.box;
  drag(dom, dom.header, { x: before.left + 100, y: before.top + 10 }, 200, -80);
  assert.deepEqual(box.box, {
    ...before,
    left: before.left + 200,
    top: before.top - 80,
  });
  assert.deepEqual(readStoredBox(storage), box.box);
  assert.equal(dom.dialog.classList.contains('agent-console-dragging'), false);
});

test('a drag never carries the window out of the viewport', () => {
  const { dom, box } = mounted();
  box.apply();
  const before = box.box;
  drag(
    dom,
    dom.header,
    { x: before.left + 100, y: before.top + 10 },
    5000,
    5000,
  );
  assert.equal(
    box.box.left + box.box.width,
    DESKTOP.viewportWidth - VIEWPORT_MARGIN_PX,
  );
  assert.equal(
    box.box.top + box.box.height,
    DESKTOP.viewportHeight - VIEWPORT_MARGIN_PX,
  );
});

test('a press that never travels is not a drag', () => {
  const { dom, box } = mounted();
  box.apply();
  const before = box.box;
  dom.pointer(dom.header, 'pointerdown', {
    x: before.left + 100,
    y: before.top + 10,
  });
  dom.pointer(dom.header, 'pointermove', {
    x: before.left + 102,
    y: before.top + 11,
  });
  dom.pointer(dom.header, 'pointerup', {
    x: before.left + 102,
    y: before.top + 11,
  });
  assert.deepEqual(box.box, before, 'a 2px twitch moved the window');
});

test('a press on a header control does not drag the window', () => {
  const { dom, box } = mounted();
  box.apply();
  const before = box.box;
  // The provider select lives in the header; pressing it must reach the select.
  dom.providerSelect.parent = dom.header;
  drag(
    dom,
    dom.providerSelect,
    { x: before.left + 60, y: before.top + 30 },
    150,
    40,
  );
  assert.deepEqual(box.box, before);
});

test('the corner grip resizes without moving the opposite corner', () => {
  const { dom, box } = mounted();
  box.apply();
  const before = box.box;
  const grip = dom.dialog.children.find((child) => child.dataset.dir === 'se');
  drag(
    dom,
    grip,
    { x: before.left + before.width, y: before.top + before.height },
    90,
    20,
  );
  assert.equal(box.box.left, before.left, 'the left edge moved');
  assert.equal(box.box.top, before.top, 'the top edge moved');
  assert.equal(box.box.width, before.width + 90);
  assert.equal(box.box.height, before.height + 20);
});

test('the north-west grip moves the near edges and pins the far ones', () => {
  const { dom, box } = mounted();
  box.apply();
  const before = box.box;
  const grip = dom.dialog.children.find((child) => child.dataset.dir === 'nw');
  drag(dom, grip, { x: before.left, y: before.top }, 40, 30);
  assert.equal(box.box.left, before.left + 40);
  assert.equal(box.box.top, before.top + 30);
  assert.equal(box.box.left + box.box.width, before.left + before.width);
  assert.equal(box.box.top + box.box.height, before.top + before.height);
});

test('a resize cannot shrink the window below its minimum', () => {
  const { dom, box } = mounted();
  box.apply();
  const grip = dom.dialog.children.find((child) => child.dataset.dir === 'se');
  const before = box.box;
  drag(
    dom,
    grip,
    { x: before.left + before.width, y: before.top + before.height },
    -5000,
    -5000,
  );
  assert.equal(box.box.width, CONSOLE_MIN_SIZE.width);
  assert.equal(box.box.height, CONSOLE_MIN_SIZE.height);
});

test('a double press on the header forgets the window and restores the default', () => {
  const { dom, box, storage } = mounted();
  box.apply();
  const home = box.box;
  drag(dom, dom.header, { x: home.left + 100, y: home.top + 10 }, 220, 90);
  assert.notDeepEqual(box.box, home);

  const moved = box.box;
  const spot = { x: moved.left + 100, y: moved.top + 10 };
  dom.pointer(dom.header, 'pointerdown', spot);
  dom.pointer(dom.header, 'pointerup', spot);
  dom.advance(DOUBLE_PRESS_MS / 2);
  dom.pointer(dom.header, 'pointerdown', spot);

  assert.deepEqual(box.box, home, 'the window did not return to its default');
  assert.equal(
    readStoredBox(storage),
    null,
    'the moved window is still remembered',
  );
});

test('two slow presses are two presses, not a double press', () => {
  const { dom, box } = mounted();
  box.apply();
  drag(
    dom,
    dom.header,
    { x: box.box.left + 100, y: box.box.top + 10 },
    220,
    90,
  );
  const moved = box.box;
  const spot = { x: moved.left + 100, y: moved.top + 10 };
  dom.pointer(dom.header, 'pointerdown', spot);
  dom.pointer(dom.header, 'pointerup', spot);
  dom.advance(DOUBLE_PRESS_MS * 2);
  dom.pointer(dom.header, 'pointerdown', spot);
  dom.pointer(dom.header, 'pointerup', spot);
  assert.deepEqual(box.box, moved, 'a slow second press reset the window');
});

test('a viewport that shrinks pulls the window back into view', () => {
  const { dom, box } = mounted();
  box.apply();
  drag(
    dom,
    dom.header,
    { x: box.box.left + 100, y: box.box.top + 10 },
    800,
    300,
  );
  dom.view.innerWidth = 700;
  dom.view.innerHeight = 500;
  dom.view.dispatchEvent(new Event('resize'));
  assert.ok(box.box.left + box.box.width <= 700 - VIEWPORT_MARGIN_PX);
  assert.ok(box.box.top + box.box.height <= 500 - VIEWPORT_MARGIN_PX);
});

test('a reclamp from a viewport change does not overwrite the remembered window', () => {
  const { dom, box, storage } = mounted();
  box.apply();
  drag(
    dom,
    dom.header,
    { x: box.box.left + 100, y: box.box.top + 10 },
    300,
    100,
  );
  const remembered = readStoredBox(storage);
  dom.view.innerWidth = 600;
  dom.view.dispatchEvent(new Event('resize'));
  // Shrinking a window to fit a temporarily small viewport must not become
  // the operator's saved preference for every later session.
  assert.deepEqual(readStoredBox(storage), remembered);
});

test('destroying releases every listener it added', () => {
  const { dom, box } = mounted();
  box.apply();
  const before = box.box;
  box.destroy();
  drag(dom, dom.header, { x: before.left + 100, y: before.top + 10 }, 200, 80);
  dom.view.innerWidth = 500;
  dom.view.dispatchEvent(new Event('resize'));
  assert.deepEqual(
    box.box,
    before,
    'a detached listener still moved the window',
  );
});
