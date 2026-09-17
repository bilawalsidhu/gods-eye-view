import { SceneDirector } from '../scenes/director.js';
import { initAnnotations } from '../annotations/index.js';
import { initDrawTool } from '../annotations/drawTool.js';
import { initGeofenceTool } from '../annotations/geofenceTool.js';
import { initGeofenceMonitor } from '../annotations/geofenceMonitor.js';
import {
  createGeofenceAlert,
  formatBreachMessage,
} from '../annotations/geofenceAlert.js';
import { initGevVoiceCommands } from '../voice/gevRealtime.js';
import { installScopeMask, destroyScopeMask } from '../scopeMask.js';
import {
  installRenderGovernor,
  getRenderGovernorDiagnostics,
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';

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
  // Geofence: click-to-draw closed polygon with boundary + fill, edit + clear.
  const geofenceTool = initGeofenceTool({ viewer });
  defer(() => geofenceTool?.destroy());
  // Geofence monitor: spatial intersection on every live position update.
  const geofenceMonitor = initGeofenceMonitor({ geofenceTool, dataManager });
  defer(() => geofenceMonitor?.destroy());
  // Webhook URL config input -> monitor
  const webhookInput = document.getElementById('geofence-webhook-url');
  const onWebhookInput = () => {
    const val = webhookInput?.value || '';
    const ok = geofenceMonitor?.setWebhookUrl(val);
    if (webhookInput) {
      webhookInput.setAttribute('aria-invalid', String(!ok && val.trim().length > 0));
      webhookInput.title = ok || !val.trim() ? 'Target URL for breach POST' : 'Invalid URL — must be http(s)';
    }
  };
  webhookInput?.addEventListener('input', onWebhookInput);
  webhookInput?.addEventListener('change', onWebhookInput);
  defer(() => {
    webhookInput?.removeEventListener('input', onWebhookInput);
    webhookInput?.removeEventListener('change', onWebhookInput);
  });

  // Visual breach alert
  const geofenceAlert = createGeofenceAlert();
  defer(() => geofenceAlert.destroy());
  const unsubEnterAlert = geofenceMonitor?.onEnter?.((entity) => {
    geofenceAlert.show(formatBreachMessage(entity));
  });
  defer(() => unsubEnterAlert?.());

  // Test toggle: dispatch mock payload to verify webhook connectivity
  const testBtn = document.getElementById('geofence-test-webhook');
  const testHint = document.getElementById('geofence-test-hint');
  const onTestWebhook = async () => {
    if (!testBtn) return;
    const url = geofenceMonitor?.getWebhookUrl?.();
    if (!url) {
      if (testHint) testHint.textContent = 'Set webhook URL first.';
      return;
    }
    testBtn.disabled = true;
    if (testHint) testHint.textContent = 'Sending…';
    try {
      await geofenceMonitor.sendTestPayload();
      if (testHint) testHint.textContent = 'Test POST sent ✓';
      geofenceAlert.show('GEOFENCE TEST — mock payload sent');
    } catch (err) {
      if (testHint) testHint.textContent = `Failed: ${err?.message || err}`;
    } finally {
      testBtn.disabled = false;
      setTimeout(() => {
        if (testHint && testHint.textContent.startsWith('Test POST')) testHint.textContent = '';
      }, 4000);
    }
  };
  testBtn?.addEventListener('click', onTestWebhook);
  defer(() => testBtn?.removeEventListener('click', onTestWebhook));

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
    geofenceTool,
    geofenceMonitor,
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
  debug.voiceCommands = voiceCommands;
  return { sceneDirector, annotations, geofenceTool, geofenceMonitor, voiceCommands };
}
