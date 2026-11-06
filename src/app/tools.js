import { SceneDirector } from '../scenes/director.js';
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
import { installViews, isEmbeddedInline } from './embed.js';
import {
  installScopeMask,
  destroyScopeMask,
  isScopeMaskEnabled,
} from '../scopeMask.js';
import { KEYHOLE_OUTER_RADIUS } from '../celestialRing.js';
import { installGlobeInViewRecovery } from './viewer.js';
import { installLayerReleaseTrim } from '../sceneCommandRelease.js';
import {
  installRenderGovernor,
  getRenderGovernorDiagnostics,
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';

/**
 * Attach scene tools, rendering listeners and the application debug handle.
 * The Director, the annotation board, Draw, Import, voice and the debug
 * handle belong to the application; the tools bound to one globe (render
 * governor, release trim, scope mask, imagery box, tracking and visibility
 * listeners, embedded views, the debug handle's globe fields) attach to each
 * engine the page shows (src/app/sceneParts.js). Navara attaches the shared
 * annotation board, Draw, Import, scope mask and voice through its engine
 * adapters (src/app/navaraMode.js); the Director follows the attached engine.
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
      detachScene: (options) => styleManager.detachScene?.(options),
    },
    { defer },
  );
  const isStackAvailable = (mapStackController) => (id) =>
    mapStackController?.isStackAvailable(id) === true;
  const sceneDirector =
    layerSession?.director ??
    new SceneDirector(first.viewer, styleManager, dataManager, {
      engine: first.engine,
      dataPacks: { ...sceneDataPacks, native: first.packRenderer },
      isMapStackAvailable: isStackAvailable(first.mapStackController),
    });
  // The Director built on this globe is attached to it already.
  let directorScene = layerSession?.director ? null : first;
  if (layerSession) layerSession.director = sceneDirector;
  dataManager.layers
    .get('bhote-koshi-2026')
    ?.module.attachSceneController(sceneDirector);
  defer(() => {
    if (layerSession?.handoffLayers && !layerSession.lifetime.signal.aborted) {
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
        if (!next.viewer) return;
        deferScene(
          installGlobeInViewRecovery(next.viewer, {
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
          next.viewer,
          next.engine,
          styleManager,
          next.packRenderer,
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
    getRenderGovernorDiagnostics,
    surfaceServices: operations.surface,
    requestRender: governorRequestRender,
  };
  defer(() => {
    if (window.__godsEyeView === debug) delete window.__godsEyeView;
  });

  // The attached engine's tools; `annotations` and the voice handle answer
  // for the engine attached now.
  const attached = { annotations: null, voiceCommands: null };
  const context = {
    controls,
    data,
    operations,
    placeSearch,
    voice,
    sceneDirector,
    layerSession,
    styleManager,
    dataManager,
  };
  await attachScenePart(
    scene,
    {
      name: 'tools',
      async attachScene(next, attachment) {
        const tools = next.viewer
          ? attachViewerTools(next, context, attachment)
          : await import('./navaraMode.js').then(({ attachViewerlessTools }) =>
              attachViewerlessTools(next, context, attachment),
            );
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
    handoff: Boolean(
      layerSession?.handoffLayers && !layerSession.lifetime.signal.aborted,
    ),
  }));
  // The startup chrome belongs to the page: no first-run welcome on Navara
  // (its choices turn on data layers).
  if (startChrome)
    defer(
      startChrome({
        loadingScreen,
        styleManager,
        dataManager,
        signal,
        ...(first.viewer ? {} : { initializeWelcome: null }),
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
  };
}

/** The tools bound to a Cesium viewer. Returns its annotations and voice. */
function attachViewerTools(
  scene,
  {
    controls,
    data,
    operations,
    placeSearch,
    voice,
    sceneDirector,
    layerSession,
    styleManager,
    dataManager,
  },
  { signal, defer },
) {
  const { viewer, engine, tileset, mapStackController } = scene;
  // The annotation board belongs to the page session when there is one: an
  // engine switch only takes its drawing off this viewer.
  const annotations = sessionAnnotations({
    layerSession,
    placeSearch,
    resolver: operations.annotationResolver,
    defer,
  });
  annotations.attachScene({ viewer, tileset });
  defer(() => annotations.detachScene());
  // UTILITIES ▸ Draw on this viewer (src/app/sessionTools.js): the tool
  // claims this viewer's pointer while a sketch is open.
  const drawTool = sessionDrawTool({
    layerSession,
    annotations,
    styleManager,
    defer,
  });
  drawTool?.attachScene({ viewer, navigation: styleManager });
  defer(() => drawTool?.detachScene());
  // UTILITIES ▸ Import on this viewer: the next Cesium viewer reads the
  // session's files again. The drop listeners belong to this viewer.
  const geoFileImport = sessionGeoImport({
    layerSession,
    styleManager,
    operations,
    defer,
  });
  geoFileImport?.attachScene({
    viewer,
    engine,
    navigation: styleManager,
    subscribeMapSource: (listener) => mapStackController?.subscribe?.(listener),
  });
  defer(() => geoFileImport?.detachScene());
  // DATA ▸ Recent Imagery: the box tool claims the pointer like Draw and the
  // panel lives on the right rail, so both belong to this globe. The tileset
  // lets the layer drape while the globe is hidden.
  const recentImagery = dataManager.layers.get('recent-imagery')?.module;
  if (recentImagery) {
    recentImagery.attachTileset(tileset);
    const imageryBoxTool = initImageryBoxTool({
      viewer,
      onBox: (box) => recentImagery.setBox(box),
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
        viewer,
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
  // Idle render governor: flips the scene into requestRenderMode whenever
  // nothing animates per frame. Installed AFTER every module above has had
  // its chance to register pre-install holds. (perf wave 2) A parked viewer
  // uninstalls it (src/app/scene.js suspend).
  installRenderGovernor(viewer);
  // Cesium keeps a turned-off layer's draw commands (and so all its entities)
  // alive in reused per-pass arrays; trim them after each disable.
  defer(
    installLayerReleaseTrim({
      scene: viewer.scene,
      dataManager,
      requestRender: governorRequestRender,
    }),
  );

  // Install the explicit scope mask used by the DISPLAY controls.
  installScopeMask(engine);
  defer(() => destroyScopeMask());

  // The follow camera recomputes the tracked target's dead-reckon position
  // every frame — tracking anything is a per-frame animation. (perf wave 2)
  const removeTrackingListener = viewer.trackedEntityChanged.addEventListener(
    () => {
      if (viewer.trackedEntity) holdContinuousRender('tracked-entity');
      else releaseContinuousRender('tracked-entity');
    },
  );

  // Hidden-state suspension (perf wave 2): when the window/tab is hidden,
  // stop the default render loop outright — a hidden canvas repaints for
  // nobody, and browser rAF throttling still lets throttled frames burn
  // GPU. Holder/data state is untouched, so return is seamless: restore
  // the loop, refresh the one DOM surface we gated, render a frame.
  const syncVisibilitySuspension = () => {
    // A panel's host may report it hidden while it is on screen; the panel
    // keeps drawing itself (see keepPanelRendering in embed.js).
    const hidden = document.hidden && !isEmbeddedInline();
    viewer.useDefaultRenderLoop = !hidden;
    controls.cockpitCloudEffects?.setSuspended?.(hidden);
    if (!hidden) {
      data.presentation.flushVisible();
      governorRequestRender('visibility-restore');
    }
  };
  document.addEventListener('visibilitychange', syncVisibilitySuspension);
  defer(() =>
    document.removeEventListener('visibilitychange', syncVisibilitySuspension),
  );
  defer(() => {
    removeTrackingListener();
    releaseContinuousRender('tracked-entity');
  });
  // Apply the CURRENT state too — bootstrap can complete while the tab is
  // already hidden, and waiting for the next transition would leave the
  // loop burning behind a hidden tab. (perf wave 2 fix)
  syncVisibilitySuspension();

  const voiceCommands = attachSessionVoice({
    layerSession,
    voice,
    operations,
    placeSearch,
    dataManager,
    scene: { viewer, engine, styleManager, sceneDirector, annotations },
    signal,
    defer,
  });
  defer(
    installViews({
      shell: styleManager,
      viewer,
      dataManager,
      run: (name, args) => voiceCommands.runner(name, args, { signal }),
      signal,
    }),
  );
  return { annotations, voiceCommands };
}
