import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createCesiumCredits, creditMarkup } from './credits.js';
import { findCredits } from '../rendererOf.js';

/** A credit display as Cesium keeps it: static credits and a frame's. */
function fakeDisplay() {
  const frame = { screen: [], lightbox: [] };
  const display = {
    _staticCredits: [],
    _currentFrameCredits: {
      screenCredits: { values: frame.screen },
      lightboxCredits: { values: frame.lightbox },
    },
    _currentCesiumCredit: undefined,
    addStaticCredit(credit) {
      if (!display._staticCredits.some((c) => Cesium.Credit.equals(c, credit)))
        display._staticCredits.push(credit);
    },
    removeStaticCredit(credit) {
      const i = display._staticCredits.indexOf(credit);
      if (i >= 0) display._staticCredits.splice(i, 1);
    },
    /** A drawn frame: the static credits, then `extra`, as Cesium adds them. */
    draw(extra = []) {
      frame.screen.length = 0;
      frame.lightbox.length = 0;
      const put = (credit, count) =>
        (credit.showOnScreen ? frame.screen : frame.lightbox).push({
          credit,
          count,
        });
      for (const credit of display._staticCredits)
        put(credit, Number.MAX_VALUE);
      for (const credit of extra) put(credit, 1);
    },
  };
  return display;
}

function setup({ display = fakeDisplay() } = {}) {
  const postRender = new Set();
  const scene = {
    postRender: {
      addEventListener(cb) {
        postRender.add(cb);
        return () => postRender.delete(cb);
      },
    },
  };
  const errors = [];
  let renders = 0;
  const part = createCesiumCredits({
    display,
    scene,
    report: (error) => errors.push(error),
    requestRender: () => (renders += 1),
  });
  return {
    display,
    part,
    port: part.port,
    errors,
    renders: () => renders,
    listeners: postRender,
    /** One drawn frame with `extra` per-frame credits. */
    frame(extra) {
      display.draw(extra);
      for (const cb of [...postRender]) cb();
    },
  };
}

test('Cesium’s own credits are listed as plain data, the logo first', () => {
  const t = setup();
  t.display._currentCesiumCredit = new Cesium.Credit(
    '<a href="https://cesium.com/" target="_blank"><img src="/ion-credit.png" title="Cesium ion"/></a>',
    true,
  );
  t.display.addStaticCredit(
    new Cesium.Credit(
      'Data &copy; <a href="https://example.com/a">Example</a> &amp; others',
      false,
    ),
  );
  assert.deepEqual(t.port.list(), [
    {
      text: 'Cesium ion',
      href: 'https://cesium.com/',
      logoUrl: '/ion-credit.png',
      inline: true,
    },
    {
      text: 'Data © Example & others',
      href: 'https://example.com/a',
      inline: false,
    },
  ]);
});

test('per-frame credits come and go with the frames, with one change each', () => {
  const t = setup();
  const lists = [];
  t.port.on('change', (list) => lists.push(list.map((c) => c.text)));
  const tile = new Cesium.Credit('Imagery © Tiles', true);
  t.frame([tile]);
  t.frame([tile]);
  assert.deepEqual(lists, [['Imagery © Tiles']], 'one change, not per frame');
  assert.deepEqual(
    t.port.list().map((c) => c.text),
    ['Imagery © Tiles'],
  );
  t.frame([]);
  assert.deepEqual(lists, [['Imagery © Tiles'], []]);
  t.frame([]);
  assert.equal(lists.length, 2);
});

test('a static credit added outside the port is listed at once and changes on the next frame', () => {
  const t = setup();
  const lists = [];
  t.port.on('change', (list) => lists.push(list.length));
  const credit = new Cesium.Credit('Layer data', false);
  t.display.addStaticCredit(credit);
  assert.equal(t.port.list().length, 1);
  t.frame();
  t.frame();
  assert.deepEqual(lists, [1]);
  t.display.removeStaticCredit(credit);
  assert.equal(t.port.list().length, 0, 'not owed once removed');
  t.frame();
  assert.deepEqual(lists, [1, 0]);
});

test('addStatic lists the credit as given and shows it through Cesium', () => {
  const t = setup();
  const lists = [];
  t.port.on('change', (list) => lists.push(list));
  const credit = {
    text: 'Roads <data>',
    href: 'https://example.com/roads',
    logoUrl: 'https://example.com/logo.png',
    inline: true,
  };
  const off = t.port.addStatic(credit);
  assert.equal(JSON.stringify(t.port.list()), JSON.stringify([credit]));
  assert.equal(lists.length, 1, 'change at once');
  assert.notEqual(t.port.list()[0], t.port.list()[0], 'copies');
  const [shown] = t.display._staticCredits;
  assert.equal(shown.showOnScreen, true);
  assert.equal(
    shown.html,
    '<a href="https://example.com/roads" target="_blank" rel="noopener"><img src="https://example.com/logo.png" alt="" style="max-height:1.5em;vertical-align:middle"> Roads &lt;data&gt;</a>',
  );
  assert.equal(t.renders(), 1);
  t.frame();
  assert.equal(lists.length, 1, 'its frame is not a second change');
  assert.equal(t.port.list().length, 1, 'listed once, as Core gave it');
  off();
  off();
  assert.deepEqual(t.port.list(), []);
  assert.deepEqual(t.display._staticCredits, []);
  assert.equal(lists.length, 2);
  t.frame();
  assert.equal(lists.length, 2, 'the frame after is not a change either');
});

test('credits of the same markup share one Cesium credit until the last goes', () => {
  const t = setup();
  const a = t.port.addStatic({ text: 'Same' });
  const b = t.port.addStatic({ text: 'Same' });
  assert.equal(t.port.list().length, 2);
  assert.equal(t.display._staticCredits.length, 1);
  a();
  assert.equal(t.display._staticCredits.length, 1, 'still shown');
  b();
  assert.equal(t.display._staticCredits.length, 0);
});

test('credits of the same markup but another placement are shown apart', () => {
  const t = setup();
  const listed = t.port.addStatic({ text: 'Same', inline: false });
  t.port.addStatic({ text: 'Same', inline: true });
  assert.equal(t.display._staticCredits.length, 2);
  listed();
  assert.deepEqual(
    t.display._staticCredits.map((c) => c.showOnScreen),
    [true],
  );
});

test('a frame’s credits are listed most frequent first, as Cesium shows them', () => {
  const t = setup();
  const a = new Cesium.Credit('A once', true);
  const b = new Cesium.Credit('B twice', true);
  const lists = [];
  t.port.on('change', (list) => lists.push(list.map((c) => c.text)));
  t.display.draw([a, b]);
  t.display._currentFrameCredits.screenCredits.values[1].count = 2;
  for (const cb of [...t.listeners]) cb();
  assert.deepEqual(lists, [['B twice', 'A once']]);
  assert.deepEqual(
    t.port.list().map((c) => c.text),
    ['B twice', 'A once'],
  );
});

test('Core’s credits are listed where the display shows them', () => {
  const t = setup();
  t.display.addStaticCredit(new Cesium.Credit('Engine listed', false));
  t.port.addStatic({ text: 'Core listed' });
  t.port.addStatic({ text: 'Core inline', inline: true });
  t.display.addStaticCredit(new Cesium.Credit('Engine inline', true));
  t.frame([new Cesium.Credit('Tile', true)]);
  assert.deepEqual(
    t.port.list().map((c) => c.text),
    ['Core inline', 'Engine inline', 'Tile', 'Engine listed', 'Core listed'],
  );
});

test('a credit needs its text; unknown fields are dropped', () => {
  const t = setup();
  assert.throws(() => t.port.addStatic({ href: 'https://example.com' }));
  assert.throws(() => t.port.addStatic(null));
  t.port.addStatic({ text: 'x', extra: 1, href: undefined });
  assert.deepEqual(t.port.list(), [{ text: 'x' }]);
});

test('listeners follow the listener rules, and other events are none', () => {
  const t = setup();
  t.port.on('change', () => {
    throw new Error('listener');
  });
  const seen = [];
  const off = t.port.on('change', () => seen.push(1));
  assert.equal(typeof t.port.on('other', () => {}), 'function');
  t.port.addStatic({ text: 'x' });
  assert.equal(t.errors.length, 1);
  assert.deepEqual(seen, [1]);
  off();
  t.port.addStatic({ text: 'y' });
  assert.deepEqual(seen, [1]);
});

test('without a credit display only Core’s credits are listed', () => {
  const postRender = { addEventListener: () => () => {} };
  const { port } = createCesiumCredits({
    display: undefined,
    scene: { postRender },
    report() {},
    requestRender() {},
  });
  const off = port.addStatic({ text: 'x' });
  assert.deepEqual(port.list(), [{ text: 'x' }]);
  off();
  assert.deepEqual(port.list(), []);
});

test('dispose detaches from the frame and takes Core’s credits off', () => {
  const t = setup();
  const seen = [];
  t.port.on('change', () => seen.push(1));
  const off = t.port.addStatic({ text: 'x' });
  t.part.dispose();
  assert.equal(t.listeners.size, 0);
  assert.deepEqual(t.display._staticCredits, []);
  off();
  t.port.addStatic({ text: 'late' });
  assert.deepEqual(t.display._staticCredits, [], 'nothing shown after');
  assert.deepEqual(seen, [1]);
  assert.equal(t.renders(), 1, 'no render asked of a disposed scene');
});

test('a credit let go after its display is destroyed leaves the display alone', () => {
  const t = setup();
  const off = t.port.addStatic({ text: 'x' });
  t.display.isDestroyed = () => true;
  t.display.removeStaticCredit = () => {
    throw new Error('destroyed');
  };
  off();
  assert.deepEqual(t.port.list(), []);
  t.part.dispose();
});

test('a released port stops following frames and keeps its credits until their Off', () => {
  const t = setup();
  const seen = [];
  t.port.on('change', () => seen.push(1));
  const off = t.port.addStatic({ text: 'x' });
  t.part.release();
  assert.equal(t.listeners.size, 0);
  assert.equal(t.display._staticCredits.length, 1, 'still shown');
  off();
  assert.equal(t.display._staticCredits.length, 0);
  assert.deepEqual(seen, [1], 'its listeners are gone');
});

test('credit markup escapes every value and links only web URLs', () => {
  assert.equal(
    creditMarkup({ text: 'a "b" & <c>' }),
    '<span>a &quot;b&quot; &amp; &lt;c&gt;</span>',
  );
  assert.equal(
    creditMarkup({ text: 'x', href: 'javascript:alert(1)' }),
    '<span>x</span>',
  );
  assert.equal(
    creditMarkup({ text: 'x', logoUrl: 'javascript:alert(1)' }),
    '<span>x</span>',
  );
  assert.equal(
    creditMarkup({ text: 'x', href: 'https://example.com/?a=1&b="2"' }),
    '<a href="https://example.com/?a=1&amp;b=%222%22" target="_blank" rel="noopener">x</a>',
  );
});

test('a Cesium viewer with no renderer gets a credits port over its display', () => {
  const display = fakeDisplay();
  const listeners = new Set();
  let renders = 0;
  const viewer = {
    creditDisplay: display,
    scene: {
      postRender: {
        addEventListener(cb) {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      },
      requestRender: () => (renders += 1),
    },
  };
  const port = findCredits(viewer);
  assert.equal(findCredits(viewer), port);
  port.addStatic({ text: 'Unbound' });
  assert.equal(display._staticCredits.length, 1);
  assert.equal(renders, 1);
  assert.equal(listeners.size, 1);
  assert.equal(findCredits({ creditDisplay: display }), null, 'no scene');
});
