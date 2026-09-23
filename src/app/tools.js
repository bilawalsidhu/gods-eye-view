import { SceneDirector } from '../scenes/director.js';
import { initAnnotations } from '../annotations/index.js';
import { initDrawTool } from '../annotations/drawTool.js';
import { initImageryBoxTool } from '../ui/imageryBoxTool.js';
import { createRecentImageryPanel } from '../ui/recentImagery.js';
import { initGevVoiceCommands } from '../voice/gevRealtime.js';
import { installScopeMask, destroyScopeMask } from '../scopeMask.js';
import {
  installRenderGovernor,
  getRenderGovernorDiagnostics,
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';
import { AtcRadioSystem } from '../data/atcRadio.js';
import { AtcRadioCard } from '../data/atcRadioCard.js';

/** Attach scene tools, rendering listeners and the application debug handle. */
export function createApplicationTools({
  scene,
  controls,
  data,
  loadingScreen,
  placeSearch,
  voice = {},
  startChrome,
  onSceneDirector,
  sceneDataPacks,
  signal,
  defer,
}) {
  const { viewer, tileset, mapStackController, operations } = scene;
  const { styleManager, weatherEffects, cockpitCloudEffects } = controls;
  const { dataManager } = data;
  const sceneDirector = new SceneDirector(viewer, styleManager, dataManager, {
    dataPacks: sceneDataPacks,
    isMapStackAvailable: (id) =>
      mapStackController?.isStackAvailable(id) === true,
  });
  dataManager.layers
    .get('bhote-koshi-2026')
    ?.module.attachSceneController(sceneDirector);
  defer(() => sceneDirector.destroy());
  onSceneDirector?.(sceneDirector);
  const annotations = initAnnotations({
    viewer,
    tileset,
    placeSearch,
    resolver: operations.annotationResolver,
  });
  defer(() => {
    if (window.__gevAnnotations === annotations) delete window.__gevAnnotations;
    annotations.destroy();
  });
  // DISPLAY ▸ Draw: the same whiteboard, drawn by hand. It claims the pointer
  // while a session is open, so its teardown belongs to the application
  // lifetime rather than to whoever last pressed the button.
  const drawTool = initDrawTool({ viewer, annotations });
  defer(() => drawTool?.destroy());
  // DATA ▸ Recent Imagery: the box tool claims the pointer like Draw and the
  // panel lives on the right rail, so both belong to the application
  // lifetime. The tileset lets the layer drape while the globe is hidden.
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
  if (startChrome)
    defer(startChrome({ loadingScreen, styleManager, dataManager, signal }));
  // Idle render governor: flips the scene into requestRenderMode whenever
  // nothing animates per frame. Installed AFTER every module above has had
  // its chance to register pre-install holds. (perf wave 2)
  installRenderGovernor(viewer);

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
    const hidden = document.hidden;
    viewer.useDefaultRenderLoop = !hidden;
    cockpitCloudEffects?.setSuspended?.(hidden);
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

  window.__godsEyeView = {
    viewer,
    styleManager,
    tileset,
    dataManager,
    sceneDirector,
    mapStackController,
    annotations,
    weatherEffects,
    cockpitCloudEffects,
    getRenderGovernorDiagnostics,
    surfaceServices: operations.surface,
    requestRender: governorRequestRender,
  };
  const debug = window.__godsEyeView;
  defer(() => {
    if (window.__godsEyeView === debug) delete window.__godsEyeView;
  });
  const voiceCommands = initGevVoiceCommands({
    ...voice,
    floorServices: operations.surface.groundFloor,
    annotationResolver: operations.annotationResolver,
    searchNavigation: operations.searchAndFlyTo,
    signal,
    placeSearch,
    viewer,
    styleManager,
    dataManager,
    sceneDirector,
    annotations,
  });
  defer(() => {
    voiceCommands.stop({ removeUi: true });
    if (window.__gevVoiceCommands === voiceCommands)
      delete window.__gevVoiceCommands;
  });
  const flightsLayer = dataManager.layers.get('flights')?.module;
  const radioLayer = dataManager.layers.get('radio')?.module;
  const atcRadio = new AtcRadioSystem({ viewer, radioLayer });
  const atcRadioCard = new AtcRadioCard({ atcRadio });

  const syncAtcTracking = () => {
    try {
      const info =
        flightsLayer?.getTrackedInfo?.() ||
        styleManager?.cockpitView?.readAircraftInfo?.();
      if (
        info &&
        Number.isFinite(info.latitude) &&
        Number.isFinite(info.longitude)
      ) {
        atcRadioCard.show();
        atcRadio.updateAircraftTelemetry({
          lat: info.latitude,
          lon: info.longitude,
          altitudeM: info.altitudeM,
          verticalRateMps: info.verticalRateMps ?? 0,
          velocityMps: info.velocityMps,
          onGround: info.onGround,
          callsign: info.callsign || info.icao24,
        });
      } else {
        atcRadioCard.hide();
        atcRadio.clearAircraftTelemetry();
      }
    } catch (err) {
      console.warn('[ATC Radio] Tracking sync error:', err);
    }
  };

  const removeAtcTrackingListener =
    viewer.trackedEntityChanged.addEventListener(syncAtcTracking);

  let lastAtcUpdateTime = 0;
  const onPreRenderAtc = () => {
    if (!viewer.trackedEntity) return;
    const now = performance.now();
    if (now - lastAtcUpdateTime < 500) return;
    lastAtcUpdateTime = now;
    syncAtcTracking();
  };
  viewer.scene.preRender.addEventListener(onPreRenderAtc);

  const onGlobalKeydown = (e) => {
    if (
      e.key?.toLowerCase() === 'a' &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.repeat &&
      !e.isComposing &&
      !e.target?.closest?.(
        'input, textarea, select, [contenteditable], [role="textbox"], #first-run-launcher',
      )
    ) {
      atcRadioCard.toggle();
    }
  };
  document.addEventListener('keydown', onGlobalKeydown);

  defer(() => {
    document.removeEventListener('keydown', onGlobalKeydown);
    removeAtcTrackingListener?.();
    viewer.scene.preRender.removeEventListener(onPreRenderAtc);
    atcRadioCard.destroy?.();
    atcRadio.destroy?.();
  });

  debug.atcRadio = atcRadio;
  debug.atcRadioCard = atcRadioCard;

  return { sceneDirector, annotations, voiceCommands, atcRadio, atcRadioCard };
}
