// The shell lives for the page: an engine switch detaches only its
// globe-bound parts and attaches them to the next globe, keeping the shell's
// session objects (navigation, location search, HUD, share link, display
// bindings, panel controls) and never publishing empty stores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { StyleManager } from './applicationShell.js';

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
    display: { attachViewer: record('display.attachViewer') },
    context: {
      canRetainScene: () => true,
      restoreForDisposal: record('context.restore'),
      stop: record('context.stop'),
      disconnect: record('context.disconnect'),
    },
  };
  Object.assign(shell, {
    _scene: { viewer: {}, engine: { kind: 'cesium' }, mapStackController: {} },
    _disposed: false,
    _layerSession: null,
    services: {
      destroyTrackedReadout: record('destroyTrackedReadout'),
      destroyWorldOverlay: record('destroyWorldOverlay'),
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
    'display.attachViewer',
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
  const engine = { kind: 'navara' };
  shell.attachScene({
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
    'display.attachViewer',
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
  assert.throws(() => shell.attachScene({ engine }), /attached to a globe/);
});

test('a panel whose layer is another instance in the new catalog is rebuilt', async () => {
  const { shell, log } = fakeShell();
  await shell.detachScene({ handoff: true });
  log.length = 0;
  shell.attachScene({
    engine: { kind: 'cesium' },
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
