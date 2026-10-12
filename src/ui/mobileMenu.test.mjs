import test from 'node:test';
import assert from 'node:assert/strict';
import { MobileCameraVisibility, MobileMenu } from './mobileMenu.js';

test('Street reveal opens Active details and resizes only its viewer; desktop remains untouched', () => {
  let opens = 0,
    moves = 0,
    resizes = 0,
    scrolls = 0;
  const frames = [];
  const controller = {
    mobile: true,
    destroyed: false,
    sections: new Map([
      ['layers', { details: { open: true } }],
      ['details', { details: { open: false } }],
    ]),
    dialog: { open: false },
    moveLateControls() {
      moves++;
    },
    open() {
      opens++;
      this.dialog.open = true;
    },
    win: {
      requestAnimationFrame(fn) {
        frames.push(fn);
      },
    },
    doc: {
      getElementById(id) {
        assert.equal(id, 'street-level-panel');
        return {
          scrollIntoView() {
            scrolls++;
          },
        };
      },
    },
    shell: {
      _streetLevelControls: {
        onPanelResized() {
          resizes++;
        },
      },
    },
  };
  MobileMenu.prototype.revealStreetLevel.call(controller);
  assert.equal(controller.sections.get('layers').details.open, false);
  assert.equal(controller.sections.get('details').details.open, true);
  frames.shift()();
  assert.equal(opens, 1);
  assert.equal(moves, 1);
  assert.equal(resizes, 1);
  assert.equal(scrolls, 1);
  controller.mobile = false;
  MobileMenu.prototype.revealStreetLevel.call(controller);
  assert.equal(opens, 1);
  assert.equal(moves, 1);
});
test('restored and automatic camera selections keep the map clear until explicitly opened', () => {
  const state = new MobileCameraVisibility();
  state.update('saved');
  assert.equal(state.visible, false);
  state.update(null);
  state.update('chosen');
  assert.equal(state.visible, false);
  state.show();
  assert.equal(state.visible, true);
});
test('minimizing survives stream changes; returning opens it; Close removes the return target', () => {
  const state = new MobileCameraVisibility();
  state.update(null);
  state.update('first');
  state.minimize();
  state.update('next');
  assert.equal(state.visible, false);
  assert.equal(state.activeId, 'next');
  state.show();
  assert.equal(state.visible, true);
  state.update(null);
  assert.equal(state.visible, false);
  assert.equal(state.activeId, null);
});

test('opening an empty chooser survives catalogue notifications without an active camera', () => {
  const state = new MobileCameraVisibility();
  state.update(null);
  state.show();
  state.update(null);
  assert.equal(state.visible, true);
  state.minimize();
  state.update(null);
  assert.equal(state.visible, false);
});

test('desktop expansion survives camera/retry notifications but restores on closing or entering phone mode', () => {
  let exits = 0;
  const controller = {
    mobile: false,
    expandedMode: 'desktop',
    camera: { activeId: 'first' },
    returnCamera: {},
    expandButton: {},
    dialog: { open: false },
    doc: { body: { classList: { toggle() {} } } },
    exitCameraFullscreen() {
      exits++;
    },
  };
  MobileMenu.prototype.syncCamera.call(controller);
  controller.camera.activeId = 'second';
  MobileMenu.prototype.syncCamera.call(controller);
  assert.equal(exits, 0);
  assert.equal(controller.expandButton.disabled, false);
  controller.camera.activeId = null;
  MobileMenu.prototype.syncCamera.call(controller);
  assert.equal(exits, 1);
  assert.equal(controller.expandButton.disabled, true);
  controller.camera.activeId = 'second';
  controller.cameraEnabled = false;
  MobileMenu.prototype.syncCamera.call(controller);
  assert.equal(exits, 2);
  assert.equal(controller.expandButton.disabled, true);
  controller.cameraEnabled = true;
  controller.camera.activeId = 'second';
  controller.mobile = true;
  MobileMenu.prototype.syncCamera.call(controller);
  assert.equal(exits, 3);
});

test('page expansion never inspects browser fullscreen capabilities or duplicates the playing surface', () => {
  const node = () => ({
    before() {},
    setAttribute() {},
    focus() {},
    getBoundingClientRect: () => ({ x: 800, y: 80, width: 340, height: 450 }),
  });
  const panel = node(),
    nodes = new Map([
      ['cctv-panel', panel],
      ['cctv-source-badge', node()],
      ['cctv-retry-status', node()],
      ['cesium-credits', node()],
    ]),
    moved = [];
  const doc = {
    getElementById: (id) => nodes.get(id),
    createComment: () => ({}),
  };
  Object.defineProperty(doc, 'fullscreenEnabled', {
    get() {
      throw new Error('desktop must not enter browser fullscreen');
    },
  });
  const controller = {
    mobile: false,
    camera: { activeId: 'playing' },
    expandedDialog: {
      open: false,
      classList: { toggle() {} },
      setAttribute() {},
      showModal() {
        this.open = true;
      },
    },
    expandedSurface: {
      prepend: (n) => moved.push(n),
      requestFullscreen() {
        throw new Error('native fullscreen forbidden');
      },
    },
    expandedFooter: { append: (n) => moved.push(n) },
    doc,
    fullscreenButton: node(),
    expandButton: node(),
    refreshCameraSurface() {},
    animateDesktopExpansion() {},
  };
  MobileMenu.prototype.enterCameraFullscreen.call(controller, {
    pageOnly: true,
  });
  assert.equal(controller.expandedMode, 'desktop');
  assert.equal(controller.expandedDialog.open, true);
  assert.equal(moved[0], panel);
  assert.equal(moved.length, 4);
  assert.equal(new Set(moved).size, 4);
  assert.equal(controller.expandButton.textContent, 'RESTORE');
  MobileMenu.prototype.enterCameraFullscreen.call(controller, {
    pageOnly: true,
  });
  assert.equal(moved.length, 4);
});

test('desktop zoom uses uniform scaling and reduced motion disables it while canceling stale animation', () => {
  let animations = [],
    canceled = 0,
    reduced = false;
  const controller = {
    win: { matchMedia: () => ({ matches: reduced }) },
    expandedSurface: {
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 1400, height: 900 }),
      animate: (frames, options) => {
        animations.push({ frames, options });
        return {
          cancel() {
            canceled++;
          },
        };
      },
    },
  };
  const origin = { x: 1000, y: 100, width: 340, height: 500 };
  MobileMenu.prototype.animateDesktopExpansion.call(controller, origin);
  assert.equal(animations.length, 1);
  assert.match(animations[0].frames[0].transform, /scale\([\d.]+\)/);
  assert.equal(animations[0].options.duration, 260);
  reduced = true;
  MobileMenu.prototype.animateDesktopExpansion.call(controller, origin);
  assert.equal(canceled, 1);
  assert.equal(animations.length, 1);
  assert.equal(controller.expansionAnimation, null);
});
