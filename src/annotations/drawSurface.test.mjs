import '../testSupport/registerDom.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import {
  isPointerFree,
  pointerOwner,
  resetPointerOwnership,
} from '../data/inputOwnership.js';
import { createSessionDrawTool } from './drawTool.js';
import { createCesiumMoversEngine } from '../testSupport/cesiumMoversEngine.mjs';
import { createFakeEventHandlers } from '../globe/cesium/testing/fakeViewer.mjs';
import * as Cesium from 'cesium';
import * as geo from '../geo/index.js';

/** The board double the tool draws on (its calls are what Draw sends). */
function fakeAnnotations() {
  const calls = { annotate: [], frame: [] };
  return {
    calls,
    async annotate(specs, options) {
      calls.annotate.push({ specs, options });
      return { drawn: specs.length };
    },
    clear() {},
    list: () => [],
    onChange: () => () => {},
    frame: (id) => calls.frame.push(id),
  };
}

function harness(t, kind) {
  resetPointerOwnership();
  document.body.replaceChildren();
  const toggle = document.createElement('button');
  toggle.id = 'draw-toggle';
  document.body.append(toggle);
  // Over (0, 0): the canvas centre is the ellipsoid under the camera.
  const handlers = createFakeEventHandlers();
  const fixture =
    kind === 'fake'
      ? null
      : createCesiumMoversEngine({
          engineOptions: { createEventHandler: handlers.create },
        });
  const engine = fixture?.engine ?? createFakeEngine({ altitude: 20000 });
  engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(0, 0, 20000),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });
  // Read the contract writes while the real primitives also receive them.
  const lines = new Map();
  const createLine = engine.lines.createLine;
  engine.lines.createLine = (options) => {
    const line = createLine(options);
    const record = { options, positions: [], shown: true };
    lines.set(options.id, record);
    const { setPositions, setColor, show, destroy } = line;
    line.setColor = (color) => {
      record.color = color;
      setColor(color);
    };
    line.setPositions = (points) => {
      record.positions = points.flatMap((point) => [point.x, point.y, point.z]);
      setPositions(points);
    };
    line.show = (shown) => {
      record.shown = shown;
      show(shown);
    };
    line.destroy = () => {
      lines.delete(options.id);
      destroy();
    };
    return line;
  };
  const input = (type, event) => {
    if (!fixture) return engine.fake.input(type, event);
    const types = {
      click: Cesium.ScreenSpaceEventType.LEFT_CLICK,
      move: Cesium.ScreenSpaceEventType.MOUSE_MOVE,
      doubleClick: Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    };
    for (const handler of handlers.handlers) handler.fire(types[type], event);
  };
  const annotations = fakeAnnotations();
  let actions = null;
  const tool = createSessionDrawTool({
    annotations,
    connect: (next) => {
      actions = next;
      return () => (actions = null);
    },
  });
  t.after(() => {
    tool.destroy();
    engine.destroy();
    resetPointerOwnership();
  });
  const attach = () => tool.attachScene({ engine });
  attach();
  const click = (x, y) => input('click', { position: { x, y } });
  const key = (name) =>
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true }),
    );
  return {
    engine,
    input,
    tool,
    annotations,
    attach,
    click,
    key,
    act: (name, ...args) => actions?.[name]?.(...args),
    line: () => lines.get('gev-draw-preview'),
    dots: () =>
      engine.movers.list().find(({ id }) => id === 'gev-draw-vertices'),
  };
}

for (const kind of ['fake', 'cesium']) {
  const testCase = (name, run) => test(`${kind}: ${name}`, run);
  testCase(
    'a click is a vertex, the rubber band follows the pointer and a double click finishes',
    async (t) => {
      const h = harness(t, kind);
      h.act('toggleDraw');
      assert.equal(pointerOwner(), 'draw', 'the session holds the pointer');
      assert.equal(h.tool.diagnostics().sceneHandler, true);
      h.tool.setShape('area');
      h.click(500, 380);
      h.click(540, 380);
      h.click(540, 420);
      assert.equal(h.tool.session.vertices.length, 3);
      assert.equal(
        h.engine.movers.list().find(({ id }) => id === 'gev-draw-vertices')
          .count,
        3,
      );
      // The band: three vertices, the pointer and the closing vertex.
      h.input('move', {
        startPosition: { x: 540, y: 420 },
        endPosition: { x: 500, y: 420 },
      });
      const band = h.line();
      assert.equal(band.shown, true);
      assert.equal(band.positions.length, 5 * 3);
      assert.equal(band.options.dash.lengthPx, 8);
      assert.equal(band.options.dash.gapPx, 8);
      // The vertex hangs where the click landed (the ellipsoid here).
      const first = geo.cartographic.fromCartesian({
        x: band.positions[0],
        y: band.positions[1],
        z: band.positions[2],
      });
      assert.ok(Math.abs(first.height) < 1);
      h.input('doubleClick', { position: { x: 500, y: 420 } });
      await Promise.resolve();
      assert.equal(h.annotations.calls.annotate.length, 1);
      const [spec] = h.annotations.calls.annotate[0].specs;
      assert.equal(spec.type, 'area');
      assert.equal(spec.manual, true);
      assert.ok(spec.ring.length >= 3);
      assert.equal(h.tool.session.vertices.length, 0, 'a fresh shape is open');
    },
  );

  testCase(
    'Escape cancels the open shape, then leaves Draw and frees the pointer',
    (t) => {
      const h = harness(t, kind);
      h.act('toggleDraw');
      h.tool.setShape('line');
      h.click(500, 380);
      h.click(560, 380);
      assert.equal(h.tool.session.vertices.length, 2);
      h.key('Escape');
      assert.equal(
        h.tool.session.vertices.length,
        0,
        'the sketch is cancelled',
      );
      assert.equal(h.tool.active, true);
      h.key('Escape');
      assert.equal(h.tool.active, false);
      assert.equal(isPointerFree(), true);
      assert.equal(h.tool.diagnostics().sceneHandler, false);
    },
  );

  testCase(
    'a switch mid-sketch ends the sketch, takes the preview off the engine and keeps shape and colour',
    (t) => {
      const h = harness(t, kind);
      h.act('toggleDraw');
      h.tool.setShape('line');
      h.tool.setColor('amber');
      h.click(500, 380);
      h.click(560, 380);
      assert.ok(h.line());
      h.tool.detachScene();
      assert.equal(h.tool.active, false);
      assert.equal(
        isPointerFree(),
        true,
        'the pointer is free after the switch',
      );
      assert.equal(h.line(), undefined, 'the band left the engine');
      assert.equal(h.dots(), undefined);
      // A click on the old engine does nothing now.
      h.click(520, 400);
      assert.equal(h.tool.session, null);
      h.attach();
      assert.equal(h.tool.shape, 'line');
      assert.equal(h.tool.color, 'amber');
      h.act('toggleDraw');
      h.click(500, 380);
      assert.equal(h.tool.session.vertices.length, 1);
    },
  );
  testCase(
    'preview styles, pin visibility and clicked heights match the controls',
    (t) => {
      const h = harness(t, kind);
      h.tool.setActive(true);
      h.tool.setShape('line');
      h.tool.setColor('cyan');
      h.tool.addVertex(0, 0, 187.5);
      h.tool.addVertex(0.01, 0, 212.25);
      const band = h.line();
      assert.equal(band.options.arc, 'geodesic');
      assert.equal(band.options.widthPx, 3);
      assert.equal(band.options.depthFailAlpha, 0.35 / 0.9);
      assert.equal(band.color[3], 0.9);
      const heights = [0, 3].map(
        (i) =>
          geo.cartographic.fromCartesian({
            x: band.positions[i],
            y: band.positions[i + 1],
            z: band.positions[i + 2],
          }).height,
      );
      assert.ok(Math.abs(heights[0] - 187.5) < 0.01);
      assert.ok(Math.abs(heights[1] - 212.25) < 0.01);
      h.tool.setShape('pin');
      h.tool.addVertex(0, 0, 150);
      assert.equal(h.line().shown, false);
      assert.equal(h.dots().count, 1);
      h.tool.setActive(false);
      assert.equal(h.line().shown, false);
      assert.equal(h.dots().count, 0);
    },
  );
}
