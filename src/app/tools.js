import { SceneDirector } from '../scenes/director.js';
import { createSessionAnnotations } from '../annotations/index.js';
import { createSessionDrawTool } from '../annotations/drawTool.js';
import { createGeoFileImport } from '../ui/geoFileImport.js';
import { useDisplayStore } from '../ui/stores/display.js';
import { applicationPinia } from '../ui/vueRuntime.js';
import { initImageryBoxTool } from '../ui/imageryBoxTool.js';
import { createRecentImageryPanel } from '../ui/recentImagery.js';
import { attachSessionVoice } from './sessionVoice.js';
import {
  attachScenePart,
  currentSceneOf,
  detachPartsOnTeardown,
} from './sceneParts.js';
import { installViews, isEmbeddedInline } from './embed.js';
import { installScopeMask, destroyScopeMask } from '../scopeMask.js';
import { installLayerReleaseTrim } from '../sceneCommandRelease.js';
import {
  installRenderGovernor,
  getRenderGovernorDiagnostics,
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';

/**
 * The annotation board: the page session's when there is one (created once,
 * destroyed with the page), else this application's.
 */
export function sessionAnnotations({
  layerSession,
  placeSearch,
  resolver,
  defer,
}) {
  const create = () => createSessionAnnotations({ placeSearch, resolver });
  if (!layerSession) {
    const annotations = create();
    defer(() => destroyAnnotations(annotations));
    return annotations;
  }
  if (!layerSession.annotations) {
    const annotations = (layerSession.annotations = create());
    layerSession.lifetime.signal.addEventListener(
      'abort',
      () => destroyAnnotations(annotations),
      { once: true },
    );
  }
  return layerSession.annotations;
}

/**
 * A tool of the page session (created once, destroyed with the page) when
 * there is one, else of this application. `create()` may return null.
 */
function sessionTool(layerSession, name, defer, create) {
  if (!layerSession) {
    const tool = create();
    defer(() => tool?.destroy());
    return tool;
  }
  const tools = (layerSession.tools ??= {});
  if (!(name in tools)) {
    const tool = (tools[name] = create());
    layerSession.lifetime.signal.addEventListener(
      'abort',
      () => tool?.destroy(),
      { once: true },
    );
  }
  return tools[name];
}

function destroyAnnotations(annotations) {
  if (window.__gevAnnotations === annotations) delete window.__gevAnnotations;
  annotations.destroy();
}

/**
 * Attach scene tools, rendering listeners and the application debug handle.
 * The Director, the annotation board, Draw, Import, voice and the debug
 * handle belong to the application; the tools bound to one globe (render
 * governor, release trim, scope mask, imagery box, tracking and visibility
 * listeners, embedded views, the debug handle's globe fields) attach to each
 * engine the page shows (src/app/sceneParts.js). Without a viewer (the
 * experimental Navara engine) the viewer-bound tools are not attached and
 * their handles are null; voice runs on the engine there
 * (src/app/navaraMode.js).
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
      detachScene: () => styleManager.detachScene?.(),
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

  // The application's debug handle; its globe fields follow the engine.
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
  window.__godsEyeView = debug;
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
      },
      detachScene() {
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
  const displayStore = useDisplayStore(applicationPinia());
  // The Display panel's controls answer through the store; returns the
  // disconnect.
  const connectDisplay = (actions) => {
    const token = displayStore.connect(actions);
    return () => displayStore.detach(token);
  };
  // UTILITIES ▸ Draw: the same whiteboard, drawn by hand. The marks and the
  // chosen shape belong to the page session; the tool claims this viewer's
  // pointer while a sketch is open, so an engine switch ends the sketch. A
  // row's fly-to goes through the shell's navigation policy, as Import's does.
  const drawTool = sessionTool(layerSession, 'draw', defer, () =>
    createSessionDrawTool({
      annotations,
      navigation: styleManager,
      publish: (view) => displayStore.publishDraw(view),
      connect: connectDisplay,
    }),
  );
  drawTool?.attachScene({ viewer, navigation: styleManager });
  defer(() => drawTool?.detachScene());
  // UTILITIES ▸ Import: the person's own GeoJSON/KML/KMZ/GPX files, each its
  // own data source. They live for the page session: an engine switch takes
  // them off this viewer, and the next Cesium viewer reads them again. The
  // drop listeners belong to this viewer.
  const geoFileImport = sessionTool(layerSession, 'geoImport', defer, () =>
    createGeoFileImport({
      navigation: styleManager,
      ground: operations.surface?.groundFloor,
      publish: (view) => displayStore.publishGeoImport(view),
      connect: connectDisplay,
    }),
  );
  geoFileImport?.attachScene({
    viewer,
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
  installScopeMask(viewer);
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
