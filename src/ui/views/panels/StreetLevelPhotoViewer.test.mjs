// The Street Level photo viewer (KartaView, Panoramax) on a page: the photo
// viewer presents it, the store carries it, and StreetLevelPhotoViewer draws
// it into the viewer host, forwards its events and hands its elements back.
import '../../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { createPhotoViewer } from '../../../layers/streetLevel/photoViewer.js';
import { subscribePhotoViewers } from '../../../layers/streetLevel/photoViewers.js';
import { useStreetLevelPhotoStore } from '../../stores/streetLevelPhoto.js';
import StreetLevelPhotoViewer from './StreetLevelPhotoViewer.vue';

const PHOTOS = {
  f: { id: 'f', sequenceId: 's', lon: 1, lat: 2, heading: 0, isPano: false },
  g: { id: 'g', sequenceId: 's', lon: 1, lat: 2, heading: 0, isPano: false },
  p: { id: 'p', sequenceId: 's', lon: 1, lat: 2, heading: 0, isPano: true },
};
const SOURCES = {
  hasPano: (photo) => photo.isPano,
  panoFirst: (photo) => ({ url: `${photo.id}-pano`, width: 2048 }),
  panoSharp: () => null,
  flatFirst: (photo) => [`https://photos.test/${photo.id}.jpg`],
  flatSharp: () => null,
  describe: () => ({ externalUrl: 'https://example.org' }),
};

/**
 * The view in an app, a viewer per provider published to its store as the
 * street-level layer does, and a panel host.
 */
function mount(t, options = {}, providerIds = ['panoramax']) {
  document.body.replaceChildren();
  const wrap = document.body.appendChild(document.createElement('div'));
  wrap.className = 'sl-viewer-wrap';
  const host = wrap.appendChild(document.createElement('div'));
  host.id = 'sl-viewer';
  const pinia = createPinia();
  const app = createApp(StreetLevelPhotoViewer).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  const store = useStreetLevelPhotoStore(pinia);
  const renderers = [];
  const stepped = [];
  const create = (providerId) =>
    createPhotoViewer({
    providerId,
    name: providerId === 'panoramax' ? 'Panoramax' : 'KartaView',
    sources: SOURCES,
    getPhoto: async (id) => PHOTOS[id],
    // f, then g: the whole sequence.
    step: async (photo, delta) =>
      ({ f: { 1: 'g' }, g: { '-1': 'f' } })[photo.id]?.[delta] ?? null,
    onStep: (id) => stepped.push(id),
    load: async (url) => ({ src: url }),
    createRenderer: (canvas) => {
      const view = { yaw: 0, pitch: 0, fov: 80 };
      const renderer = {
        canvas,
        setImage() {},
        setView: (next) => Object.assign(view, next),
        getView: () => ({ ...view }),
        resize() {},
        clear() {},
        destroy() {},
      };
      renderers.push(renderer);
      return renderer;
    },
    ...options,
  });
  const viewers = providerIds.map(create);
  const unsubscribe = subscribePhotoViewers(viewers, (view) =>
    store.publish(view),
  );
  t.after(() => {
    for (const viewer of viewers) viewer.unmount();
    unsubscribe();
    app.unmount();
  });
  return { viewer: viewers[0], viewers, host, wrap, renderers, stepped };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the viewer draws in its host with the markup its stylesheet reads', async (t) => {
  const { viewer, host } = mount(t);
  await viewer.mount(host);
  const root = host.querySelector(':scope > .sl-photo-viewer');
  assert.ok(root, 'drawn in the host');
  assert.equal(root.dataset.provider, 'panoramax');
  assert.equal(root.getAttribute('tabindex'), '0');
  assert.equal(root.getAttribute('role'), 'group');
  assert.match(root.getAttribute('aria-label'), /^Panoramax photo\. ← and →/);
  assert.equal(root.hasAttribute('data-kind'), false, 'nothing shown yet');
  const [picture, canvas, prev, next] = root.children;
  assert.equal(picture.tagName, 'IMG');
  assert.equal(picture.className, 'sl-photo-flat');
  assert.equal(picture.getAttribute('alt'), 'Panoramax street-level photo');
  assert.equal(picture.getAttribute('draggable'), 'false');
  assert.equal(picture.hidden, true);
  assert.equal(picture.hasAttribute('src'), false);
  assert.equal(picture.style.objectFit, 'contain');
  assert.equal(canvas.tagName, 'CANVAS');
  assert.equal(canvas.className, 'sl-photo-pano');
  assert.equal(canvas.hidden, true);
  for (const [button, side, glyph, label] of [
    [prev, 'prev', '‹', 'Previous photo in this sequence (←)'],
    [next, 'next', '›', 'Next photo in this sequence (→)'],
  ]) {
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.type, 'button');
    assert.ok(button.classList.contains('sl-photo-step'));
    assert.ok(button.classList.contains(`sl-photo-step-${side}`));
    assert.equal(button.textContent.trim(), glyph);
    assert.equal(button.getAttribute('aria-label'), label);
    assert.equal(button.getAttribute('title'), label);
    assert.equal(button.disabled, true);
    assert.equal(button.hasAttribute('aria-pressed'), false);
  }
  viewer.setRenderMode('fill');
  await nextTick();
  assert.equal(picture.style.objectFit, 'cover');
  viewer.unmount();
  await nextTick();
  assert.equal(host.children.length, 0, 'unmounted: gone from the host');
});

test('a flat photo shows, ‹ › and ← → step along its sequence, and close hides it', async (t) => {
  const { viewer, host, stepped } = mount(t);
  await viewer.mount(host);
  await viewer.open('f');
  await nextTick();
  const root = host.querySelector('.sl-photo-viewer');
  const [picture, canvas, prev, next] = root.children;
  assert.equal(root.dataset.kind, 'flat');
  assert.equal(picture.hidden, false);
  assert.equal(canvas.hidden, true);
  assert.equal(picture.getAttribute('src'), 'https://photos.test/f.jpg');
  // ‹ is disabled once its end is known; › stays.
  await tick();
  await nextTick();
  assert.equal(prev.disabled, true);
  assert.equal(next.disabled, false);
  let bubbled = 0;
  host.addEventListener('click', () => bubbled++);
  next.click();
  await tick();
  assert.deepEqual(stepped, ['g']);
  assert.equal(bubbled, 0, 'the click stays in the viewer');
  await viewer.open('g');
  root.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
  );
  await tick();
  assert.deepEqual(stepped, ['g', 'f']);
  viewer.close();
  await nextTick();
  assert.equal(root.dataset.kind, '');
  assert.equal(picture.hidden, true);
  assert.equal(picture.hasAttribute('src'), false);
});

test('a step button that disables under the keyboard hands focus to the viewer', async (t) => {
  // The sequence's end is known only once the user is on ›.
  let answer;
  const asked = new Promise((resolve) => (answer = resolve));
  const { viewer, host } = mount(t, {
    step: async (photo, delta) => (delta > 0 ? asked : null),
  });
  await viewer.mount(host);
  await viewer.open('g');
  await nextTick();
  const root = host.querySelector('.sl-photo-viewer');
  const next = root.children[3];
  assert.equal(next.disabled, false);
  next.focus();
  assert.ok(document.activeElement === next, 'on ›');
  answer(null);
  await tick();
  await nextTick();
  assert.equal(next.disabled, true, 'g is the last photo');
  assert.ok(document.activeElement === root, 'focus moved to the viewer');
});

test('a panorama draws on the view’s canvas; drag, wheel and a lost context reach the viewer', async (t) => {
  const { viewer, host, renderers } = mount(t);
  await viewer.mount(host);
  await viewer.open('p');
  await nextTick();
  const root = host.querySelector('.sl-photo-viewer');
  const canvas = root.children[1];
  assert.ok(renderers[0].canvas === canvas, 'the canvas the view drew');
  assert.equal(root.dataset.kind, 'pano');
  assert.equal(canvas.hidden, false);
  assert.equal(root.children[0].hidden, true);
  canvas.dispatchEvent(
    new PointerEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: 0,
      clientY: 0,
    }),
  );
  await nextTick();
  assert.ok(canvas.classList.contains('sl-photo-dragging'));
  canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
  await nextTick();
  assert.equal(canvas.classList.contains('sl-photo-dragging'), false);
  const wheel = new WheelEvent('wheel', { deltaY: 100, cancelable: true });
  canvas.dispatchEvent(wheel);
  assert.equal(wheel.defaultPrevented, true, 'the page does not scroll');
  assert.ok(renderers[0].getView().fov > 80, 'zoomed out');
  // A lost context: a fresh canvas in its place, which the next renderer takes.
  canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  await nextTick();
  const fresh = root.children[1];
  assert.ok(fresh !== canvas, 'a new canvas');
  assert.equal(fresh.className, 'sl-photo-pano');
  assert.equal(canvas.isConnected, false, 'the lost one is gone');
  await viewer.open('p');
  assert.ok(renderers[1].canvas === fresh, 'the next renderer takes it');
});

test('docked, Esc in the viewer’s box is offered to the provider first', async (t) => {
  let asked = 0;
  const { viewer, host } = mount(t, { onEscape: () => ++asked > 0 });
  await viewer.mount(host);
  const root = host.querySelector('.sl-photo-viewer');
  const escape = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  let reachedPage = false;
  document.body.addEventListener('keydown', () => (reachedPage = true));
  root.dispatchEvent(escape);
  assert.equal(asked, 1);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(reachedPage, false, 'the panel does not collapse');
});

test('without a view, the viewer cannot mount', async () => {
  const viewer = createPhotoViewer({
    providerId: 'test',
    name: 'Test',
    sources: SOURCES,
    getPhoto: async (id) => PHOTOS[id],
    step: async () => null,
    onStep() {},
  });
  await assert.rejects(
    viewer.mount(document.createElement('div')),
    /no view to draw it/,
  );
});

test('a viewer mounted in the tick another unmounts gets elements of its own', async (t) => {
  const { viewers, host, renderers } = mount(t, {}, ['kartaview', 'panoramax']);
  const [kartaView, panoramax] = viewers;
  await kartaView.mount(host);
  await kartaView.open('p');
  const root = host.querySelector('.sl-photo-viewer');
  const canvas = root.children[1];
  assert.ok(renderers[0].canvas === canvas);
  // The core switches source: one unmounts and the other mounts at once.
  kartaView.unmount();
  const mounting = panoramax.mount(host);
  await mounting;
  await panoramax.open('p');
  const fresh = host.querySelector('.sl-photo-viewer');
  assert.equal(host.children.length, 1);
  assert.ok(fresh !== root, 'a root of its own');
  assert.equal(fresh.dataset.provider, 'panoramax');
  assert.ok(fresh.children[1] !== canvas, 'not the destroyed renderer’s canvas');
  assert.ok(renderers[1].canvas === fresh.children[1]);
  assert.equal(fresh.dataset.kind, 'pano', 'not the front view');
});

test('a mount overtaken before it is drawn closes, and never shows later', async (t) => {
  const { viewers, host } = mount(t, {}, ['kartaview', 'panoramax']);
  const [kartaView, panoramax] = viewers;
  // KartaView starts mounting; Panoramax mounts before the view draws it.
  const overtaken = kartaView.mount(host);
  const current = panoramax.mount(host);
  // It settles, rather than wait for a draw that never comes.
  const outcome = await Promise.race([
    overtaken.then(
      () => 'mounted',
      (error) => error.message,
    ),
    new Promise((resolve) => setTimeout(() => resolve('still pending'), 100)),
  ]);
  assert.match(outcome, /viewer was closed/);
  await current;
  await nextTick();
  assert.equal(host.children.length, 1);
  assert.equal(host.children[0].dataset.provider, 'panoramax');
  await assert.rejects(kartaView.open('f'), /not mounted/);
  // Once Panoramax goes, nothing is left in the host.
  panoramax.unmount();
  await nextTick();
  assert.equal(host.children.length, 0);
});
