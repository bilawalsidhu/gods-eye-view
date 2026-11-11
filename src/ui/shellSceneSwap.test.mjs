import { createFakeEngine } from '../globe/testing/fakeEngine.js';
// The shell lives for the page: an engine switch detaches only its
// globe-bound parts and attaches them to the next globe, keeping the shell's
// session objects (navigation, location search, HUD, share link, display
// bindings, panel controls) and never publishing empty stores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { StyleManager } from './applicationShell.js';
import { createSceneHost } from '../app/sceneHost.js';
import { shellScenePart } from '../app/shellPart.js';

function fakeShell() {
  const log = [];
  const record =
    (name, value) =>
    (...args) => {
      log.push(name);
      return typeof value === 'function' ? value(...args) : value;
    };
  const shell = Object.create(StyleManager.prototype);
  const session = {
    navigation: {
      setScene: record('navigation.setScene'),
      tracking: null,
    },
    location: {
      attachScene: record('location.attachScene'),
      detachScene: record('location.detachScene'),
    },
    hud: { attachEngine: record('hud.attachEngine') },
    shareLink: { attachEngine: record('shareLink.attachEngine') },
    display: { attachEngine: record('display.attachEngine') },
    context: {
      canRetainScene: () => true,
      restoreForDisposal: record('context.restore'),
      stop: record('context.stop'),
      disconnect: record('context.disconnect'),
    },
  };
  Object.assign(shell, {
    _scene: { viewer: {}, engine: createFakeEngine({ kind: 'cesium' }), mapStackController: {} },
    _disposed: false,
    _layerSession: null,
    services: {
      destroyTrackedReadout: record('destroyTrackedReadout'),
      worldOverlayFor: () => ({ destroy: record('destroyWorldOverlay') }),
      destroyDetection: record('destroyDetection'),
      cctvLayer: 'cctv',
    },
    _navigation: session.navigation,
    _locationNavigation: session.location,
    hud: session.hud,
    shareLinkManager: session.shareLink,
    _displayBindings: session.display,
    _contextControls: session.context,
    _shareRestoration: {
      destroy: record('shareRestoration.destroy'),
    },
    _layerBindings: {
      stop: record('layerBindings.stop'),
      disconnect: record('layerBindings.disconnect'),
    },
    _cockpitCoordinator: {
      stop: record('cockpit.stop'),
      destroy: record('cockpit.destroy'),
    },
    _visualSettings: {
      stop: record('visual.stop'),
      releaseIrBoost: record('visual.releaseIrBoost'),
      destroy: record('visual.destroy'),
    },
    celestialRing: { destroy: record('celestial.destroy') },
    _mapSourceControls: { destroy: record('mapSource.destroy') },
    _cameraOrientationControls: { destroy: record('orientation.destroy') },
  });
  // The globe-bound builders, as attachScene runs them.
  for (const name of [
    '_buildSceneControls',
    '_buildSceneCockpit',
    '_initSceneOverlays',
    '_initMapStackControl',
    '_initCameraOrientationControls',
    '_initHudScene',
    '_initCockpitDisplayPortal',
    '_applyGlobalPostDefaults',
    '_startAnimationLoop',
    '_publishActiveStyle',
    '_layoutRightPanels',
    '_syncCctvPanelViewport',
    '_initCctvPanel',
  ])
    shell[name] = record(name);
  shell._buildSceneControls = () => {
    log.push('_buildSceneControls');
    shell._shareRestoration = {
      attachLinks: record('shareRestoration.attachLinks'),
      start: record('shareRestoration.start'),
      destroy: record('shareRestoration.destroy'),
    };
    shell._layerBindings = {
      observeCamera: record('layerBindings.observeCamera'),
      stop() {},
      disconnect() {},
    };
  };
  return { shell, session, log };
}

test('a switch detaches the globe-bound parts and keeps the session objects', async () => {
  const { shell, session, log } = fakeShell();
  await shell.detachScene({ handoff: true });
  assert.deepEqual(log, [
    'shareRestoration.destroy',
    'navigation.setScene',
    'layerBindings.stop',
    'cockpit.stop',
    'visual.stop',
    'visual.releaseIrBoost',
    'cockpit.destroy',
    'layerBindings.disconnect',
    'destroyTrackedReadout',
    'destroyDetection',
    'destroyWorldOverlay',
    'celestial.destroy',
    'visual.destroy',
    'mapSource.destroy',
    'orientation.destroy',
    'display.attachEngine',
    'location.detachScene',
    'hud.attachEngine',
    'shareLink.attachEngine',
  ]);
  assert.equal(shell.engine, null);
  assert.equal(shell.viewer, null);
  assert.equal(shell._navigation, session.navigation);
  assert.equal(shell.hud, session.hud);
  assert.equal(shell.shareLinkManager, session.shareLink);
  log.length = 0;
  await shell.detachScene();
  assert.deepEqual(log, [], 'a second detach does nothing');
});

test('the next globe gets new globe-bound parts and the restore runs on it', async () => {
  const { shell, session, log } = fakeShell();
  await shell.detachScene({ handoff: true });
  log.length = 0;
  const engine = createFakeEngine({ kind: 'navara' });
  await shell.attachScene({
    viewer: null,
    engine,
    mapStackController: {},
    services: { cctvLayer: 'cctv' },
  });
  assert.equal(shell.engine, engine);
  assert.deepEqual(log, [
    'navigation.setScene',
    'location.attachScene',
    'hud.attachEngine',
    'shareLink.attachEngine',
    'display.attachEngine',
    '_buildSceneControls',
    '_buildSceneCockpit',
    'shareRestoration.attachLinks',
    '_initSceneOverlays',
    '_initMapStackControl',
    '_initCameraOrientationControls',
    '_initHudScene',
    '_initCockpitDisplayPortal',
    '_applyGlobalPostDefaults',
    '_startAnimationLoop',
    '_publishActiveStyle',
    'shareRestoration.start',
    'layerBindings.observeCamera',
    '_layoutRightPanels',
    '_syncCctvPanelViewport',
  ]);
  assert.equal(shell._navigation, session.navigation);
  await shell.attachScene({ engine });
  await assert.rejects(
    shell.attachScene({ engine: createFakeEngine({ kind: 'cesium' }) }),
    /attached to a globe/,
  );
});

test('a panel whose layer is another instance in the new catalog is rebuilt', async () => {
  const { shell, log } = fakeShell();
  await shell.detachScene({ handoff: true });
  log.length = 0;
  await shell.attachScene({
    engine: createFakeEngine({ kind: 'cesium' }),
    services: { cctvLayer: 'other' },
  });
  assert.ok(log.includes('_initCctvPanel'));
});

test('a Context transition in flight is restored before the globe goes', async () => {
  const { shell, session, log } = fakeShell();
  session.context.canRetainScene = () => false;
  session.context._contextModeGeneration = 4;
  await shell.detachScene({ handoff: true });
  assert.ok(log.indexOf('context.restore') > log.indexOf('visual.stop'));
  assert.equal(session.context._contextModeGeneration, 5);
  assert.equal(session.context._contextModeChanging, false);
});

test('an attachment that throws part-way leaves the shell detached and attachable', async () => {
  const { shell, log } = fakeShell();
  await shell.detachScene({ handoff: true });
  shell._initSceneOverlays = () => {
    throw new Error('overlay host failed');
  };
  await assert.rejects(
    shell.attachScene({ engine: createFakeEngine({ kind: 'navara' }) }),
    /overlay host failed/,
  );
  // The shell releases what it built and is detached when that settles.
  await shell.detachScene();
  assert.equal(shell.engine, null);
  log.length = 0;
  shell._initSceneOverlays = () => log.push('_initSceneOverlays');
  const engine = createFakeEngine({ kind: 'cesium' });
  await shell.attachScene({ engine });
  assert.equal(shell.engine, engine);
  assert.ok(log.includes('shareRestoration.start'));
});

test('between engines a style key waits for the next engine instead of the released settings', async () => {
  const { shell } = fakeShell();
  const released = [];
  shell._visualSettings = {
    stop() {},
    releaseIrBoost() {},
    destroy() {},
    setStyle: (name) => released.push(name),
  };
  Object.defineProperty(shell, 'initialRestorePromise', {
    value: Promise.resolve(),
  });
  await shell.detachScene({ handoff: true });
  shell.setStyle('crt');
  assert.deepEqual(released, [], 'the released settings do not change');
  const applied = [];
  shell._buildSceneControls = () => {
    shell._shareRestoration = { attachLinks() {}, start() {}, destroy() {} };
    shell._layerBindings = { observeCamera() {}, stop() {}, disconnect() {} };
    shell._visualSettings = { setStyle: (name) => applied.push(name) };
  };
  await shell.attachScene({ engine: createFakeEngine({ kind: 'cesium' }) });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(applied, ['crt']);
});

test('shell recovery waits for failed attachment cleanup and serializes repeated detach', async () => {
  const { shell, session } = fakeShell();
  await shell.detachScene({ handoff: true });
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  session.context.canRetainScene = () => false;
  session.context.restoreForDisposal = () => pending;
  shell._initSceneOverlays = () => {
    throw new Error('overlay failed');
  };
  const failed = shell.attachScene({ engine: createFakeEngine({ kind: 'navara' }) });
  const rejected = assert.rejects(failed, /overlay failed/);
  await Promise.resolve();
  const detach = shell.detachScene();
  const again = shell.detachScene();
  shell._initSceneOverlays = () => {};
  const engine = createFakeEngine({ kind: 'cesium' });
  const recovered = shell.attachScene({ engine });
  await Promise.resolve();
  assert.notEqual(shell.engine, engine, 'recovery waits for cleanup');
  release();
  await Promise.all([rejected, detach, again, recovered]);
  assert.equal(shell.engine, engine);
  await shell.attachScene({ engine });
  assert.equal(shell.engine, engine, 'same attachment is idempotent');
});

test('shell attach waits for a deferred outgoing detach', async () => {
  const { shell, session } = fakeShell();
  let release;
  session.context.canRetainScene = () => false;
  session.context.restoreForDisposal = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const leaving = shell.detachScene({ handoff: true });
  const engine = createFakeEngine({ kind: 'navara' });
  const entering = shell.attachScene({ engine });
  await Promise.resolve();
  assert.notEqual(shell.engine, engine);
  release();
  await Promise.all([leaving, entering]);
  assert.equal(shell.engine, engine);
});

test('an engine without Wildlife Sightings gets no card instead of a failed start', () => {
  const shell = Object.create(StyleManager.prototype);
  // The stand-in a catalog gives for a layer the engine leaves out.
  Object.assign(shell, {
    services: { wildlifeSightingsLayer: {} },
    _scene: { viewer: null, engine: createFakeEngine({ kind: 'navara' }) },
  });
  assert.doesNotThrow(() => shell._initWildlifeSightingCard());
  assert.equal(shell._wildlifeSightingCard, null);
});

test('a hosted shell uses the enclosing transition while direct calls wait outside it', async () => {
  const { shell, session } = fakeShell();
  const host = createSceneHost();
  shell._sceneHost = host;
  const first = { engine: shell.engine };
  await host.attach(first);
  const catalog = { get: () => ({}) };
  await host.register(shellScenePart(shell, { builtOn: first, catalog }));
  let release;
  let entered;
  const detaching = new Promise((resolve) => { entered = resolve; });
  session.context.canRetainScene = () => false;
  session.context.restoreForDisposal = () => {
    entered();
    return new Promise((resolve) => { release = resolve; });
  };
  const next = { engine: createFakeEngine({ kind: 'navara' }), catalog };
  const switching = host.run(async (transaction) => {
    await host.detach({ handoff: true }, transaction);
    await host.attach(next, transaction);
  });
  await detaching;
  const outside = shell.detachScene();
  session.context.canRetainScene = () => true;
  release();
  await switching;
  await outside;
  assert.equal(shell.engine, null);
  assert.equal(host.current(), next);
});
