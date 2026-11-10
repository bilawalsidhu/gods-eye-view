import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Window } from 'happy-dom';
import {
  SOLUNAR_BODY_ID,
  SOLUNAR_ID,
  SPOT_MARKER_ID,
  mapCenterSpot,
  mountSolunarForShell,
  pickSpot,
} from './solunarShell.js';

const DEG = Math.PI / 180;

// pickGroundPosition rejects a Cartesian near the Earth's centre, so the fake
// carries a real-sized z; the fake ellipsoid reads only x and y.
const onGlobe = (x, y) => ({ x, y, z: 7_000_000 });
function fakeViewer({ hit = onGlobe } = {}) {
  const added = [];
  const removed = [];
  const canvas = new Window().document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: 800 });
  Object.defineProperty(canvas, 'clientHeight', { value: 600 });
  canvas.getBoundingClientRect = () => ({ left: 10, top: 20 });
  // pixel (x, y) -> lat 30 + y/100, lon -100 + x/100 (rad conversion in the fake ellipsoid)
  const ellipsoid = {
    cartesianToCartographic: (c) => ({
      latitude: (30 + c.y / 100) * DEG,
      longitude: (-100 + c.x / 100) * DEG,
    }),
  };
  const viewer = {
    added,
    removed,
    renders: { n: 0 },
    scene: {
      canvas,
      globe: { ellipsoid },
      requestRender() {
        this.owner.renders.n++;
      },
    },
    camera: {
      positionCartographic: { latitude: 10 * DEG, longitude: 20 * DEG },
      pickEllipsoid: (px) => hit(px.x, px.y),
    },
    entities: {
      add: (e) => {
        added.push(e);
        return e;
      },
      remove: (e) => removed.push(e),
    },
  };
  viewer.scene.owner = viewer;
  return viewer;
}

function setup({ open = false, viewer = fakeViewer() } = {}) {
  const window = new Window();
  const doc = window.document;
  const root = doc.createElement('div');
  root.id = SOLUNAR_ID;
  root.className = open ? '' : 'collapsed';
  const body = doc.createElement('div');
  body.id = SOLUNAR_BODY_ID;
  root.append(body);
  doc.body.append(root);
  const mount = mountSolunarForShell(
    { viewer },
    { document: doc, now: () => Date.UTC(2026, 10, 3, 18) },
  );
  const fire = (type, { timeStamp, ...init } = {}) => {
    const event = new window.MouseEvent(type, { button: 0, ...init });
    if (timeStamp != null)
      Object.defineProperty(event, 'timeStamp', { value: timeStamp });
    return viewer.scene.canvas.dispatchEvent(event);
  };
  const tick = () => new Promise((r) => setTimeout(r, 5));
  return { window, doc, root, body, viewer, mount, fire, tick };
}
const spotText = (body) =>
  body.querySelector('.gev-sl-spot')?.textContent ?? '';

test('pickSpot converts a pixel pick to degrees, and says null for the sky', () => {
  const v = fakeViewer();
  const s = pickSpot(v, 100, 200);
  assert.ok(Math.abs(s.latDeg - 32) < 1e-9 && Math.abs(s.lonDeg - -99) < 1e-9);
  assert.equal(pickSpot(fakeViewer({ hit: () => undefined }), 1, 1), null);
  assert.equal(pickSpot(null, 1, 1), null);
});

test('mapCenterSpot picks the middle pixel, else the camera position', () => {
  const picks = [];
  const v = fakeViewer({
    hit: (x, y) => {
      picks.push([x, y]);
      return onGlobe(x, y);
    },
  });
  mapCenterSpot(v);
  assert.deepEqual(picks, [[400, 300]]);
  const sky = mapCenterSpot(fakeViewer({ hit: () => undefined }));
  assert.ok(
    Math.abs(sky.latDeg - 10) < 1e-9 && Math.abs(sky.lonDeg - 20) < 1e-9,
  );
});

test('a closed card shows nothing until it opens; opening picks the map centre and marks it', async () => {
  const { root, body, viewer, tick } = setup();
  assert.equal(body.querySelector('.gev-sl-day'), null);
  assert.equal(viewer.added.length, 0);
  root.classList.remove('collapsed');
  await tick();
  assert.equal(body.querySelectorAll('.gev-sl-day').length, 7);
  assert.match(spotText(body), /^33\.000°N 96\.000°W/);
  assert.equal(viewer.added.length, 1);
  assert.equal(viewer.added[0].id, SPOT_MARKER_ID);
  root.classList.add('collapsed');
  await tick();
  assert.equal(viewer.removed.length, 1, 'marker leaves with the card');
});

test('a click on the map picks the spot only while the card is open', async () => {
  const { root, body, fire, tick, viewer } = setup();
  fire('pointerdown', { clientX: 110, clientY: 220 });
  fire('pointerup', { clientX: 110, clientY: 220 });
  assert.equal(
    body.querySelector('.gev-sl-day'),
    null,
    'closed card ignores the map',
  );
  root.classList.remove('collapsed');
  await tick();
  fire('pointerdown', { clientX: 110, clientY: 220 });
  fire('pointerup', { clientX: 110, clientY: 220 });
  // client (110, 220) -> canvas (100, 200)
  assert.match(spotText(body), /^32\.000°N 99\.000°W/);
  assert.equal(viewer.added.length, 2);
  assert.equal(viewer.removed.length, 1, 'the old dot is replaced');
});

test('a drag or a long press is not a click', async () => {
  const { root, body, fire, tick } = setup({ open: true });
  await tick();
  const before = spotText(body);
  fire('pointerdown', { clientX: 110, clientY: 220 });
  fire('pointerup', { clientX: 150, clientY: 260 });
  assert.equal(spotText(body), before);
  // held for 2 s by the event clock (a busy page can delay the handlers, not the stamps)
  fire('pointerdown', { clientX: 110, clientY: 220, timeStamp: 1000 });
  fire('pointerup', { clientX: 110, clientY: 220, timeStamp: 3000 });
  assert.equal(spotText(body), before);
  // a slow page between the two handlers is still a click
  fire('pointerdown', { clientX: 110, clientY: 220, timeStamp: 5000 });
  await new Promise((r) => setTimeout(r, 700));
  fire('pointerup', { clientX: 110, clientY: 220, timeStamp: 5080 });
  assert.match(spotText(body), /^32\.000°N 99\.000°W/);
  body.querySelector('.gev-sl-center').click();
  assert.equal(spotText(body), before);
  fire('pointerup', { clientX: 110, clientY: 220, button: 2 });
  assert.equal(spotText(body), before, 'a right button never picks');
  assert.ok(root);
});

test('a click on the sky keeps the old spot', async () => {
  let sky = false;
  const viewer = fakeViewer({
    hit: (x, y) => (sky ? undefined : onGlobe(x, y)),
  });
  const { body, fire, tick } = setup({ open: true, viewer });
  await tick();
  const before = spotText(body);
  sky = true;
  fire('pointerdown', { clientX: 110, clientY: 220 });
  fire('pointerup', { clientX: 110, clientY: 220 });
  assert.equal(spotText(body), before);
});

test('a chosen spot survives closing and reopening; "Use map centre" goes back', async () => {
  const { root, body, fire, tick } = setup({ open: true });
  await tick();
  fire('pointerdown', { clientX: 110, clientY: 220 });
  fire('pointerup', { clientX: 110, clientY: 220 });
  root.classList.add('collapsed');
  await tick();
  root.classList.remove('collapsed');
  await tick();
  assert.match(spotText(body), /^32\.000°N 99\.000°W/);
  body.querySelector('.gev-sl-center').click();
  assert.match(spotText(body), /^33\.000°N 96\.000°W/);
});

test('mounting twice does nothing; destroy removes listeners and the dot', async () => {
  const { doc, mount, root, viewer, body, fire, tick } = setup({ open: true });
  await tick();
  assert.equal(mountSolunarForShell({ viewer }, { document: doc }), null);
  mount.destroy();
  assert.equal(viewer.removed.length, 1);
  assert.equal(body.children.length, 0);
  fire('pointerdown', { clientX: 1, clientY: 1 });
  fire('pointerup', { clientX: 1, clientY: 1 });
  assert.equal(body.children.length, 0);
  assert.equal(root.dataset.solunarMounted, undefined);
});

test('no card or no viewer: nothing mounts', () => {
  const doc = new Window().document;
  assert.equal(
    mountSolunarForShell({ viewer: fakeViewer() }, { document: doc }),
    null,
  );
  assert.equal(mountSolunarForShell({}, { document: doc }), null);
});

// ── rail wiring  ──
const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const count = (text, needle) => text.split(needle).length - 1;

test('the SOLUNAR card is a collapsed rail launcher after RECENT IMAGERY', () => {
  const context = read('src/ui/views/ContextView.vue');
  const tag = context.match(/<RailPanel\s+id="solunar-panel"[^>]*>/)?.[0] ?? '';
  assert.match(tag, /start-collapsed/);
  assert.doesNotMatch(tag, /\bhidden\b/, 'the menu item is always on offer');
  assert.match(tag, /sideways/);
  assert.match(tag, /:title="t\('SOLUNAR'\)"/);
  assert.match(context, /id="gev-solunar-body"/);
  const at = (id) => context.indexOf(`id="${id}"`);
  assert.ok(
    at('recent-imagery-panel') < at('solunar-panel') &&
      at('solunar-panel') < at('global-context-panel'),
  );
});

test('panel chrome, rail layout, dock catalog and the shell know the card', () => {
  assert.equal(count(read('src/ui/panelChrome.js'), "'solunar-panel'"), 1);
  assert.equal(
    count(read('src/ui/panelLayoutController.js'), '_solunarPanel'),
    3,
  );
  assert.match(
    read('src/ui/panelRailCatalog.js'),
    /'solunar-panel': \{ icon: 'dark_mode', label: msg\('SOLUNAR'\) \}/,
  );
  const shell = read('src/ui/applicationShell.js');
  assert.match(shell, /import\('\.\.\/solunar\/solunarShell\.js'\)/);
  assert.equal(count(shell, 'this._solunar?.destroy()'), 2);
  assert.match(read('style.css'), /styles\/solunar\.css/);
  assert.match(read('index.html'), /icon_names=[^"&]*\bdark_mode\b/);
});

test('every rail rule written for RECENT IMAGERY has its Solunar twin', () => {
  for (const file of [
    'layers.css',
    'responsive.css',
    'mobile-shell.css',
    'cyber.css',
  ]) {
    const css = read(`src/ui/styles/${file}`);
    assert.equal(
      count(css, 'solunar-panel'),
      count(css, 'recent-imagery-panel') +
        (file === 'layers.css' ? 2 : file === 'mobile-shell.css' ? 1 : 0),
      `${file} selector parity plus Solunar scrolling overrides`,
    );
  }
});

test('the SOLUNAR launcher wraps its title, hides its body while collapsed, and has 44px phone targets', () => {
  const css = read('src/ui/styles/solunar.css');
  const title = css.match(
    /#right-context-rail #solunar-panel \.panel-title \{([^}]*)\}/,
  )?.[1];
  assert.ok(title);
  assert.match(title, /white-space: normal/);
  assert.match(title, /min-width: 0/);
  assert.match(
    css,
    /#solunar-panel\.collapsed \.gev-sl-body \{\s*display: none !important;/,
  );
  const media = css.slice(
    css.indexOf('@media (max-width: 720px), (pointer: coarse)'),
  );
  assert.ok(media.includes('.gev-sl-controls .data-toggle-chip'));
  assert.ok(media.includes('min-height: 44px'));
});

test('reopening the card redraws it, so a card left closed overnight shows the new week', async () => {
  let nowMs = Date.UTC(2026, 10, 3, 18);
  const viewer = fakeViewer();
  const window = new Window();
  const doc = window.document;
  const root = doc.createElement('div');
  root.id = SOLUNAR_ID;
  const body = doc.createElement('div');
  body.id = SOLUNAR_BODY_ID;
  root.append(body);
  doc.body.append(root);
  mountSolunarForShell({ viewer }, { document: doc, now: () => nowMs });
  const first = () => body.querySelector('.gev-sl-day').dataset.date;
  assert.equal(first(), '2026-11-03');
  body.querySelector('.gev-sl-center'); // spot came from the centre
  // the user picks a spot, closes the card, a day passes, it is reopened
  const canvas = viewer.scene.canvas;
  canvas.dispatchEvent(
    new window.MouseEvent('pointerdown', {
      button: 0,
      clientX: 110,
      clientY: 220,
    }),
  );
  canvas.dispatchEvent(
    new window.MouseEvent('pointerup', {
      button: 0,
      clientX: 110,
      clientY: 220,
    }),
  );
  root.classList.add('collapsed');
  await new Promise((r) => setTimeout(r, 5));
  nowMs += 86_400_000;
  root.classList.remove('collapsed');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(first(), '2026-11-04');
  assert.match(
    body.querySelector('.gev-sl-spot').textContent,
    /^32\.000°N 99\.000°W/,
  );
});

test('showing and clearing the spot marker asks for a frame (the app idles between frames)', () => {
  const viewer = fakeViewer();
  const { root } = setup({ viewer });
  const before = viewer.renders.n;
  root.classList.remove('collapsed'); // opens: centre spot + marker
  return new Promise((r) => setTimeout(r, 5)).then(() => {
    assert.ok(viewer.renders.n > before, 'marker added -> frame requested');
    const afterAdd = viewer.renders.n;
    root.classList.add('collapsed'); // closes: marker removed
    return new Promise((r) => setTimeout(r, 5)).then(() => {
      assert.ok(
        viewer.renders.n > afterAdd,
        'marker removed -> frame requested',
      );
    });
  });
});

test("a card left open past the spot's local midnight redraws itself then, and stops when closed", () => {
  let nowMs = Date.UTC(2026, 10, 3, 18); // 12:00 CST
  const timers = [];
  const cleared = [];
  const window = new Window();
  const doc = window.document;
  const root = doc.createElement('div');
  root.id = SOLUNAR_ID;
  root.className = 'collapsed';
  const body = doc.createElement('div');
  body.id = SOLUNAR_BODY_ID;
  root.append(body);
  doc.body.append(root);
  const viewer = fakeViewer();
  mountSolunarForShell(
    { viewer },
    {
      document: doc,
      now: () => nowMs,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: (id) => cleared.push(id),
    },
  );
  const first = () => body.querySelector('.gev-sl-day').dataset.date;
  root.classList.remove('collapsed');
  return new Promise((r) => setTimeout(r, 5)).then(() => {
    // pixel (400,300) of the fake globe is 33.0N 96.0W: America/Chicago
    assert.equal(first(), '2026-11-03');
    const armed = timers.at(-1);
    assert.equal(armed.ms, 12 * 3_600_000 + 1000); // 12:00 -> next local midnight, +1 s
    nowMs = Date.UTC(2026, 10, 4, 6, 0, 1); // just after midnight
    armed.fn();
    assert.equal(first(), '2026-11-04');
    const rearmed = timers.at(-1);
    assert.notEqual(rearmed, armed);
    assert.ok(rearmed.ms > 23 * 3_600_000, 'next midnight is about a day away');
    root.classList.add('collapsed');
    return new Promise((r) => setTimeout(r, 5)).then(() => {
      assert.ok(cleared.length >= 1, 'closing clears the pending timer');
    });
  });
});
