import { retainsLayerSession } from './layerSession.js';
import { SceneDirector } from '../scenes/director.js';
import {
  claimPointer,
  isPointerFree,
  releasePointer,
} from '../data/inputOwnership.js';
import { initImageryBoxTool } from '../ui/imageryBoxTool.js';
import { createRecentImageryPanel } from '../ui/recentImagery.js';
import { attachSessionVoice } from './sessionVoice.js';
import {
  sessionAnnotations,
  sessionDrawTool,
  sessionGeoImport,
} from './sessionTools.js';
import {
  attachScenePart,
  currentSceneOf,
  detachPartsOnTeardown,
} from './sceneParts.js';
import { installViews, isEmbeddedInline, keepPanelRendering } from './embed.js';
import {
  installScopeMask,
  destroyScopeMask,
  isScopeMaskEnabled,
} from '../scopeMask.js';
import { KEYHOLE_OUTER_RADIUS } from '../celestialRing.js';
import { installGlobeInViewRecovery } from '../globe/cesium/viewer.js';
import { installLayerReleaseTrim } from '../sceneCommandRelease.js';
import { renderGovernorFor } from '../renderGovernor.js';

/**
 * Attach scene tools, rendering listeners and the application debug handle.
 * The Director, the annotation board, Draw, Import, voice and the debug
 * handle belong to the application; the tools bound to one globe (render
 * governor, release trim, scope mask, imagery box, tracking and visibility
 * listeners, embedded views, the debug handle's globe fields) attach to each
 * engine the page shows (src/app/sceneParts.js), one tree for every engine
 * (attachEngineTools): each engine kind's tool backend says where the shared
 * tools draw on it, and the tools that still drive the Cesium viewer attach
 * only where there is one. The Director follows the attached engine.
 */
export async function createApplicationTools({
  scene,
  controls,
  data,
  loadingScreen,
  placeSearch,
  voice = {},
  startChrome,
  onSceneDirector,
  sceneDataPacks,
  layerSession,
  drawMarkActions = [],
  signal,
  defer,
}) {
  const { operations } = scene;
  const first = currentSceneOf(scene);
  const { styleManager } = controls;
  const { dataManager } = data;
  // The shell leaves its globe before the data layers detach (registered
  // after them, so it detaches first): its share restoration and Context
  // transactions end while the layers and the viewer still exist.
  await attachScenePart(
    scene,
    {
      name: 'shell-release',
      detachScene: (options, transaction) =>
        styleManager.detachScene?.(options, transaction),
    },
    { defer },
  );
  const isStackAvailable = (mapStackController) => (id) =>
    mapStackController?.isStackAvailable(id) === true;
  const sceneDirector =
    layerSession?.director ??
    new SceneDirector(first, styleManager, dataManager, {
      dataPacks: sceneDataPacks,
      isMapStackAvailable: isStackAvailable(first.mapStackController),
    });
  // The Director built on this globe is attached to it already.
  let directorScene = layerSession?.director ? null : first;
  if (layerSession) layerSession.director = sceneDirector;
  dataManager.layers
    .get('bhote-koshi-2026')
    ?.module.attachSceneController(sceneDirector);
  defer(() => {
    if (retainsLayerSession(layerSession)) {
      sceneDirector.suspendScene();
    } else {
      if (layerSession) layerSession.director = null;
      return sceneDirector.destroy();
    }
  });
  onSceneDirector?.(sceneDirector);
  await attachScenePart(
    scene,
    {
      name: 'globe-in-view',
      // Cesium only for now: it reads Cesium's camera (positionWC, its
      // running flight).
      attachScene(next, { defer: deferScene }) {
        const viewer = cesiumViewerOf(next.engine);
        if (!viewer) return;
        deferScene(
          installGlobeInViewRecovery(viewer, {
            // The scope mask hides everything outside its keyhole.
            keyholeRadius: () =>
              isScopeMaskEnabled() ? KEYHOLE_OUTER_RADIUS : 0,
            // An authored scene frames its own shots, holds included.
            paused: () => sceneDirector.running,
          }),
        );
      },
    },
    { defer },
  );
  await attachScenePart(
    scene,
    {
      name: 'director',
      attachScene(next) {
        if (next === directorScene) return;
        directorScene = null;
        sceneDirector.attachScene(
          next,
          styleManager,
          isStackAvailable(next.mapStackController),
        );
      },
      // The session keeps the Director; the page teardown destroys it.
      detachScene: () => sceneDirector.suspendScene(),
    },
    { defer },
  );

  // The application's debug handle, the same object on every globe; its
  // globe fields follow the engine.
  const debug = {
    viewer: null,
    engine: null,
    styleManager,
    tileset: null,
    dataManager,
    sceneDirector,
    mapStackController: null,
    annotations: null,
    weatherEffects: controls.weatherEffects ?? null,
    cockpitCloudEffects: null,
    voiceCommands: null,
    getRenderGovernorDiagnostics: () =>
      renderGovernorFor(debug.engine)?.getRenderGovernorDiagnostics(),
    surfaceServices: operations.surface,
    requestRender: (reason) =>
      renderGovernorFor(debug.engine)?.governorRequestRender(reason),
  };
  defer(() => {
    if (window.__godsEyeView === debug) delete window.__godsEyeView;
  });

  // The attached engine's tools; `annotations` and the voice handle answer
  // for the engine attached now.
  const attached = { annotations: null, voiceCommands: null };
  let startupChromeOptions;
  const context = {
    controls,
    data,
    operations,
    placeSearch,
    voice,
    sceneDirector,
    layerSession,
    drawMarkActions,
    styleManager,
    dataManager,
  };
  await attachScenePart(
    scene,
    {
      name: 'tools',
      async attachScene(next, attachment) {
        const tools = await attachEngineTools(next, context, attachment);
        startupChromeOptions ??= tools.startupChrome;
        attached.annotations = tools.annotations;
        attached.voiceCommands = tools.voiceCommands;
        attachment.defer(() => {
          attached.annotations = null;
        });
      },
    },
    { defer },
  );
  // The debug handle names the attached globe once every part is on it.
  await attachScenePart(
    scene,
    {
      name: 'debug-handle',
      attachScene(next) {
        Object.assign(debug, {
          viewer: next.viewer ?? null,
          engine: next.engine,
          tileset: next.tileset ?? null,
          mapStackController: next.mapStackController ?? null,
          annotations: attached.annotations,
          cockpitCloudEffects: controls.cockpitCloudEffects ?? null,
          voiceCommands: attached.voiceCommands,
        });
        // Present only while a globe is attached, as when every engine
        // built its own application: scripts read `engine.kind` from it.
        window.__godsEyeView = debug;
      },
      detachScene() {
        if (window.__godsEyeView === debug) delete window.__godsEyeView;
        Object.assign(debug, {
          viewer: null,
          engine: null,
          tileset: null,
          mapStackController: null,
          annotations: null,
          cockpitCloudEffects: null,
        });
      },
    },
    { defer },
  );
  detachPartsOnTeardown(scene, defer, () => ({
    handoff: retainsLayerSession(layerSession),
  }));
  // Startup chrome belongs to the page and keeps the first backend
  // policy across later engine attachments.
  if (startChrome)
    defer(
      startChrome({
        loadingScreen,
        styleManager,
        dataManager,
        signal,
        ...startupChromeOptions,
      }),
    );
  return {
    sceneDirector,
    get annotations() {
      return attached.annotations;
    },
    get voiceCommands() {
      return attached.voiceCommands;
    },
    pointer: {
      claim: claimPointer,
      release: releasePointer,
      isFree: isPointerFree,
    },
  };
}

/**
 * The Cesium viewer under an engine, or null on an engine without one: the
 * one place the tools read it.
 */
const cesiumViewerOf = (engine) => engine?.extensions?.cesium?.viewer ?? null;

/**
 * The tool backend of each engine kind (see attachEngineTools). Cesium's
 * holds the tools that still drive its viewer, so they stay absent on
 * other engines; Navara's loads with its mode (src/app/navaraMode.js), so
 * the Cesium-mode bundle carries none of it.
 */
const TOOL_BACKENDS = Object.freeze({
  cesium: async () => cesiumToolBackend,
  navara: async () => (await import('./navaraMode.js')).navaraToolBackend,
});

/** The Cesium tool backend: the shared tools and its own on the viewer. */
function cesiumToolBackend({ engine, tileset }) {
  const viewer = cesiumViewerOf(engine);
  const {
    governorRequestRender,
    holdContinuousRender,
    releaseContinuousRender,
  } = renderGovernorFor(engine);
  return {
    viewer,
    startupChrome: {},
    board: () => ({ viewer, engine, tileset }),
    // The tileset lets the layer drape while the globe is hidden.
    recentImagery(layer) {
      layer.attachTileset(tileset);
      return { viewer };
    },
    attach({ dataManager }, { defer }) {
      // Cesium keeps a turned-off layer's draw commands (and so all its
      // entities) alive in reused per-pass arrays; trim them after each
      // disable.
      defer(
        installLayerReleaseTrim({
          scene: viewer.scene,
          dataManager,
          requestRender: governorRequestRender,
        }),
      );
      // The follow camera recomputes the tracked target's dead-reckon
      // position every frame — tracking anything is a per-frame animation.
      // (perf wave 2)
      const removeTrackingListener =
        viewer.trackedEntityChanged.addEventListener(() => {
          if (viewer.trackedEntity) holdContinuousRender('tracked-entity');
          else releaseContinuousRender('tracked-entity');
        });
      defer(() => {
        removeTrackingListener();
        releaseContinuousRender('tracked-entity');
      });
    },
    // Hidden-state suspension (perf wave 2): when the window/tab is hidden,
    // stop the default render loop outright — a hidden canvas repaints for
    // nobody, and browser rAF throttling still lets throttled frames burn
    // GPU.
    suspend(hidden, { cockpitCloudEffects }) {
      viewer.useDefaultRenderLoop = !hidden;
      cockpitCloudEffects?.setSuspended?.(hidden);
    },
    // An inline panel the host reports hidden stops Cesium's render loop.
    keepRendering: (options) => keepPanelRendering(viewer, options),
  };
}

/**
 * The tools of one globe, on any engine: the annotation board, Draw,
 * Import, the Recent Imagery box and panel, the render governor, the scope
 * mask, hidden-tab handling and voice, and the engine's own tools. The
 * engine kind's backend (TOOL_BACKENDS) says where the shared tools draw:
 * `board()` and `draw()` give their attachScene arguments (null: not on
 * this engine), `recentImagery(layer)` the panel's globe,
 * `attach(context, attachment)` adds
 * the engine's own tools, `suspend(hidden, controls)` its hidden-tab
 * handling and `keepRendering` what keeps an inline panel drawing. The
 * shared tools keep their session state across engines. Returns the
 * annotation board (null without one) and voice commands.
 */
async function attachEngineTools(
  scene,
  {
    controls,
    data,
    operations,
    placeSearch,
    voice,
    sceneDirector,
    layerSession,
    drawMarkActions,
    styleManager,
    dataManager,
  },
  { signal, defer },
) {
  const { engine, mapStackController } = scene;
  const governor = scene.services?.render ?? renderGovernorFor(engine);
  const backend = (await TOOL_BACKENDS[engine.kind]())(scene);
  // The page session's board, Draw and Import (src/app/sessionTools.js):
  // an engine switch only takes their drawing off this globe.
  const annotations = attachBoard(
    backend.board(),
    { layerSession, placeSearch, operations },
    defer,
  );
  attachDraw(
    engine,
    { layerSession, annotations, styleManager, drawMarkActions },
    defer,
  );
  // Import draws through the globe contract, the same on every engine.
  attachGeoImport(
    { engine },
    { layerSession, styleManager, operations, mapStackController },
    defer,
  );
  // DATA ▸ Recent Imagery: the box tool claims the pointer like Draw and the
  // panel lives on the right rail, so both belong to this globe.
  const recentImagery = dataManager.layers.get('recent-imagery')?.module;
  if (recentImagery) {
    const panelGlobe = backend.recentImagery(recentImagery);
    const imageryBoxTool = initImageryBoxTool({
      engine,
      onBox: (box) => recentImagery.setBox(box),
      onPreview: (box) => recentImagery.setBoxPreview(box),
      onCancel: (reason, message, box) => {
        if (message) recentImagery.reportBoxRefusal(message, box);
      },
      onActive: (active) => recentImagery.setToolActive(active),
      // The tool takes Escape in a capture listener, so the panel's order
      // (clear a preview before cancelling the tool) is applied here.
      onEscape: () => recentImagery.clearPreview(),
    });
    // The readout mounts in its rail body through the layer panel, like the
    // weather readout.
    data.presentation.attachRecentImagery((container) =>
      createRecentImageryPanel({
        container,
        ...panelGlobe,
        layer: recentImagery,
        tool: imageryBoxTool,
      }),
    );
    // The live gate's handle (scripts/qa-recent-imagery.mjs).
    const recentImageryHandle = { layer: recentImagery, tool: imageryBoxTool };
    window.__gevRecentImagery = recentImageryHandle;
    defer(() => {
      if (window.__gevRecentImagery === recentImageryHandle)
        delete window.__gevRecentImagery;
      data.presentation.attachRecentImagery(null);
      imageryBoxTool?.destroy();
    });
  }
  // Installed AFTER every module above has had its chance to register
  // pre-install holds.
  governor.install();
  backend.attach?.({ data, styleManager, dataManager }, { signal, defer });

  // Install the explicit scope mask used by the DISPLAY controls: a canvas
  // in the engine's container, its terminus following the camera's height.
  installScopeMask(engine);
  defer(() => destroyScopeMask());

  // A hidden tab: the engine's own suspension, if any; holder/data state is
  // untouched, so return is seamless: restore the loop, refresh the one DOM
  // surface we gated, render a frame.
  const syncVisibilitySuspension = () => {
    // A panel's host may report it hidden while it is on screen; the panel
    // keeps drawing itself (see keepPanelRendering in embed.js).
    const hidden = document.hidden && !isEmbeddedInline();
    backend.suspend?.(hidden, controls);
    if (!hidden) {
      data.presentation.flushVisible();
      governor.governorRequestRender('visibility-restore');
    }
  };
  document.addEventListener('visibilitychange', syncVisibilitySuspension);
  defer(() =>
    document.removeEventListener('visibilitychange', syncVisibilitySuspension),
  );
  // Apply the CURRENT state to a suspending engine too — bootstrap can
  // complete while the tab is already hidden, and waiting for the next
  // transition would leave the loop burning behind a hidden tab. (perf wave
  // 2 fix)
  if (backend.suspend) syncVisibilitySuspension();

  // Voice uses the engine and shared session services; each action checks
  // the capabilities it needs on the attached scene.
  const voiceCommands = attachSessionVoice({
    layerSession,
    voice,
    operations,
    placeSearch,
    dataManager,
    scene: {
      viewer: backend.viewer ?? null,
      engine,
      styleManager,
      sceneDirector,
      annotations,
    },
    signal,
    defer,
  });
  // Annotation links and embed mode, on every engine.
  defer(
    installViews({
      shell: styleManager,
      engine,
      keepRendering: backend.keepRendering ?? null,
      dataManager,
      run: (name, args) => voiceCommands.runner(name, args, { signal }),
      signal,
    }),
  );
  return { annotations, voiceCommands, startupChrome: backend.startupChrome };
}

/** The annotation board drawn on this globe (`boardScene`), or null. */
function attachBoard(
  boardScene,
  { layerSession, placeSearch, operations },
  defer,
) {
  if (!boardScene) return null;
  // The board belongs to the page session when there is one: an engine
  // switch only takes its drawing off this globe.
  const annotations = sessionAnnotations({
    layerSession,
    placeSearch,
    resolver: operations.annotationResolver,
    defer,
  });
  annotations.attachScene(boardScene);
  defer(() => annotations.detachScene());
  return annotations;
}

/**
 * UTILITIES ▸ Draw on this globe (its engine input and preview):
 * the tool claims the globe's pointer while a sketch is open, so a switch
 * ends an open sketch and keeps the chosen shape and colour. Returns the
 * tool (null on a page without it or without the board).
 */
function attachDraw(
  engine,
  { layerSession, annotations, styleManager, drawMarkActions },
  defer,
) {
  if (!annotations) return null;
  const drawTool = sessionDrawTool({
    layerSession,
    annotations,
    styleManager,
    markActions: drawMarkActions,
    defer,
  });
  drawTool?.attachScene({ engine, navigation: styleManager });
  defer(() => drawTool?.detachScene());
  return drawTool;
}

/**
 * UTILITIES ▸ Import on this globe (`importScene`: its engine): the next
 * globe reads the session's files again. The drop listeners belong to
 * this globe. Returns the control (null on a page without it).
 */
function attachGeoImport(
  importScene,
  { layerSession, styleManager, operations, mapStackController },
  defer,
) {
  if (!importScene) return null;
  const geoFileImport = sessionGeoImport({
    layerSession,
    styleManager,
    operations,
    defer,
  });
  geoFileImport?.attachScene({
    ...importScene,
    navigation: styleManager,
    subscribeMapSource: (listener) => mapStackController?.subscribe?.(listener),
  });
  defer(() => geoFileImport?.detachScene());
  return geoFileImport;
}
