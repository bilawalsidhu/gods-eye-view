import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  atEndOfTick,
  billboardCollectionOf,
  billboardLoadError,
  cameraFlightActive,
  closeRenderLoopLatch,
  clusterPointCollection,
  commandExtents,
  creditDisplayContents,
  defaultView,
  lastRenderTime,
  lastSeenCamera,
  onEngineWorkCompleted,
  pickOffscreenView,
  renderPending,
  trimGlobeTiles,
  updateCameraChanged,
  webglContext,
} from './internals.js';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const require = createRequire(import.meta.url);
const packageSource = (name) =>
  path.join(path.dirname(require.resolve(`${name}/package.json`)), 'Source');
const ENGINE = packageSource('@cesium/engine');
const WIDGETS = packageSource('@cesium/widgets');

test('every private field Core reaches is still declared by the installed Cesium', () => {
  const fields = [
    [ENGINE, 'Scene/Scene.js', '_defaultView'],
    [ENGINE, 'Scene/Scene.js', '_picking'],
    [ENGINE, 'Scene/Picking.js', '_pickOffscreenView'],
    [ENGINE, 'Scene/View.js', '_commandExtents'],
    [ENGINE, 'Scene/Billboard.js', '_billboardCollection'],
    [ENGINE, 'DataSources/EntityCluster.js', '_clusterPointCollection'],
    [ENGINE, 'Widget/CesiumWidget.js', '_renderLoopRunning'],
    [WIDGETS, 'Viewer/Viewer.js', '_cesiumWidget'],
    [ENGINE, 'Renderer/Context.js', '_gl'],
    [ENGINE, 'Scene/Camera.js', '_currentFlight'],
    [ENGINE, 'Widget/CesiumWidget.js', '_entityView'],
    [ENGINE, 'Scene/Scene.js', '_renderRequested'],
    [ENGINE, 'Scene/Scene.js', '_logDepthBufferDirty'],
    [ENGINE, 'Scene/Scene.js', '_hdrDirty'],
    [ENGINE, 'Scene/Scene.js', '_lastRenderTime'],
    [ENGINE, 'Scene/Scene.js', '_view'],
    [ENGINE, 'Scene/View.js', '_cameraClone'],
    [ENGINE, 'Scene/Scene.js', '_frameState'],
    [ENGINE, 'Scene/Globe.js', '_surface'],
    [ENGINE, 'Scene/QuadtreePrimitive.js', '_tileReplacementQueue'],
    [ENGINE, 'Scene/CreditDisplay.js', '_staticCredits'],
    [ENGINE, 'Scene/CreditDisplay.js', '_currentFrameCredits'],
    [ENGINE, 'Scene/CreditDisplay.js', '_currentCesiumCredit'],
  ];
  const missing = fields.filter(
    ([root, file, field]) =>
      !new RegExp(`this\\.${field}\\s*=`).test(
        fs.readFileSync(path.join(root, file), 'utf8'),
      ),
  );
  assert.deepEqual(missing, []);
  const camera = fs.readFileSync(path.join(ENGINE, 'Scene/Camera.js'), 'utf8');
  assert.match(camera, /Camera\.prototype\._updateCameraChanged = function/);
  const billboard = fs.readFileSync(
    path.join(ENGINE, 'Scene/Billboard.js'),
    'utf8',
  );
  assert.match(billboard, /\n {2}loadError: \{/, 'Billboard#loadError');
  const read = (file) => fs.readFileSync(path.join(ENGINE, file), 'utf8');
  assert.match(
    read('Core/RequestScheduler.js'),
    /\nRequestScheduler\.requestCompletedEvent = /,
  );
  assert.match(
    read('Core/TaskProcessor.js'),
    /\nTaskProcessor\.taskCompletedEvent = /,
  );
  assert.match(read('Scene/FrameState.js'), /this\.afterRender = \[\]/);
  // What makes them matter: each completion redraws the scene.
  const scene = read('Scene/Scene.js');
  // Every tick empties the after-render queue, outside its draw.
  const render = scene.slice(
    scene.indexOf('Scene.prototype.render = function'),
  );
  const body = render.slice(0, render.indexOf('\n};'));
  assert.match(
    body,
    /\n {2}callAfterRenderFunctions\(this\);\n/,
    'callAfterRenderFunctions runs at the top level of Scene#render',
  );
  for (const event of [
    'RequestScheduler.requestCompletedEvent',
    'TaskProcessor.taskCompletedEvent',
  ])
    assert.match(
      scene,
      new RegExp(
        `${event.replace('.', '\\.')}\\.addEventListener\\(\\s*requestRenderAfterFrame\\(this\\)`,
      ),
      event,
    );
});

test('the helpers read and write exactly those fields', () => {
  const view = { _commandExtents: [{ command: {} }] };
  assert.equal(defaultView({ _defaultView: view }), view);
  assert.equal(
    pickOffscreenView({ _picking: { _pickOffscreenView: view } }),
    view,
  );
  assert.equal(commandExtents(view), view._commandExtents);
  assert.deepEqual(commandExtents(undefined), []);
  const collection = {};
  assert.equal(
    billboardCollectionOf({ _billboardCollection: collection }),
    collection,
  );
  assert.equal(
    clusterPointCollection({ _clusterPointCollection: collection }),
    collection,
  );
  assert.equal(clusterPointCollection(undefined), null);
  const widget = { _renderLoopRunning: true };
  closeRenderLoopLatch({ _cesiumWidget: widget });
  assert.equal(widget._renderLoopRunning, false);
  closeRenderLoopLatch({});
  assert.equal(renderPending({}), false);
  assert.equal(renderPending({ _renderRequested: true }), true);
  assert.equal(renderPending({ _hdrDirty: true }), true);
  assert.equal(renderPending({ _logDepthBufferDirty: true }), true);
  const time = {};
  assert.equal(lastRenderTime({ _lastRenderTime: time }), time);
  const clone = {};
  assert.equal(lastSeenCamera({ _view: { _cameraClone: clone } }), clone);
  assert.equal(lastSeenCamera({}), undefined);
  const error = new Error('404');
  assert.equal(billboardLoadError({ loadError: error }), error);
  const gl = {};
  assert.equal(webglContext({ context: { _gl: gl } }), gl);
  assert.equal(cameraFlightActive({ _currentFlight: {} }), true);
  assert.equal(cameraFlightActive({ _currentFlight: undefined }), false);
  let checked = 0;
  updateCameraChanged({ _updateCameraChanged: () => (checked += 1) });
  assert.equal(checked, 1);
  const afterRender = [];
  const fn = () => {};
  atEndOfTick({ _frameState: { afterRender } }, fn);
  assert.deepEqual(afterRender, [fn]);
  const logo = {};
  const statics = [{}];
  const screen = [{ credit: {}, count: 1 }];
  const lightbox = [];
  assert.deepEqual(
    creditDisplayContents({
      _staticCredits: statics,
      _currentFrameCredits: {
        screenCredits: { values: screen },
        lightboxCredits: { values: lightbox },
      },
      _currentCesiumCredit: logo,
    }),
    { statics, screen, lightbox, logo },
  );
  assert.deepEqual(creditDisplayContents(undefined), {
    statics: [],
    screen: [],
    lightbox: [],
    logo: undefined,
  });
  const event = () => {
    const listeners = new Set();
    return {
      addEventListener(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      raise: () => listeners.forEach((cb) => cb('ignored')),
    };
  };
  const RequestScheduler = { requestCompletedEvent: event() };
  const TaskProcessor = { taskCompletedEvent: event() };
  const calls = [];
  const off = onEngineWorkCompleted(
    { RequestScheduler, TaskProcessor },
    (...args) => calls.push(args),
  );
  RequestScheduler.requestCompletedEvent.raise();
  TaskProcessor.taskCompletedEvent.raise();
  assert.deepEqual(calls, [[], []]);
  off();
  TaskProcessor.taskCompletedEvent.raise();
  assert.equal(calls.length, 2);
});

test('private Cesium fields are reached only through internals.js', () => {
  // A private field is one Cesium assigns as `this._name`. Core's own objects
  // use underscore fields too, and some share a name with one of Cesium's,
  // so a name Core itself defines (on `this`, a state object or as a key) is
  // Core's; any other `._name` from Cesium's set is a private Cesium read.
  const walk = (dir, filter) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full, filter);
      return filter(entry.name) ? [full] : [];
    });
  const cesiumPrivate = new Set();
  for (const file of [
    ...walk(ENGINE, (name) => name.endsWith('.js')),
    ...walk(WIDGETS, (name) => name.endsWith('.js')),
  ])
    for (const [, name] of fs
      .readFileSync(file, 'utf8')
      .matchAll(/this\._([A-Za-z]\w*)/g))
      cesiumPrivate.add(name);

  const INTERNALS = 'src/render/cesium/internals.js';
  const sources = walk(path.join(ROOT, 'src'), (name) =>
    /\.(js|vue)$/.test(name),
  )
    .map((file) => path.relative(ROOT, file))
    .filter((file) => file !== INTERNALS)
    .map((file) => [
      file,
      fs
        .readFileSync(path.join(ROOT, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, ''),
    ]);
  const coreOwn = new Set();
  const definitions = [
    /\b(?:this|\w*[sS]tate|owner|self|parts|anno|entry|record|rec|cal|label|controller)\._([A-Za-z]\w*)\s*=(?!=)/g,
    /^\s*(?:static\s+)?(?:async\s+)?_([A-Za-z]\w*)\s*[(=:;]/gm,
    /[{,]\s*_([A-Za-z]\w*)\s*:/g,
  ];
  for (const [, code] of sources)
    for (const pattern of definitions)
      for (const [, name] of code.matchAll(pattern)) coreOwn.add(name);

  // A Cesium object's private field is flagged whatever Core names its own
  // fields: on a receiver that is a Cesium object, or by bracket access.
  const CESIUM_RECEIVER =
    /\b_?(?:viewer|scene|camera|globe|context|frameState|clustering|tileset|imageryProvider|terrainProvider|screenSpaceCameraController|cesiumWidget|imageryLayers|primitives|dataSources|entities|clock)\??\._([A-Za-z]\w*)\b/g;
  const BRACKET = /\[\s*['"`]_([A-Za-z]\w*)['"`]\s*\]/g;
  const offenders = [];
  for (const [file, code] of sources) {
    for (const [, name] of code.matchAll(/\._([A-Za-z]\w*)\b/g))
      if (cesiumPrivate.has(name) && !coreOwn.has(name))
        offenders.push(`${file} ._${name}`);
    for (const pattern of [CESIUM_RECEIVER, BRACKET])
      for (const [, name] of code.matchAll(pattern))
        if (cesiumPrivate.has(name)) offenders.push(`${file} ._${name}`);
  }
  assert.deepEqual([...new Set(offenders)], []);
});

test('trimGlobeTiles empties the globe cache of what the frame did not draw', () => {
  const trims = [];
  trimGlobeTiles({
    _surface: { _tileReplacementQueue: { trimTiles: (n) => trims.push(n) } },
  });
  trimGlobeTiles(undefined);
  assert.deepEqual(trims, [0]);
});
