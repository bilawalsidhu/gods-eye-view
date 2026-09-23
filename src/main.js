import * as Cesium from 'cesium';
// Cesium's widget stylesheets size the viewer chain (`.cesium-viewer` →
// `.cesium-viewer-cesiumWidgetContainer` → `.cesium-widget` → canvas) to its
// container. They used to arrive transitively from vite-plugin-cesium; since
// that plugin was removed (PWA phase 1.2) the canvas kept its intrinsic
// 300x150 size and the globe rendered in a corner box while every
// screen-space overlay projected into the same tiny viewport (L9 matrix
// D-wave). CesiumWidget.css alone was still not enough: without Viewer.css
// the `.cesium-viewer`/container wrappers have auto height, so the widget's
// 100% height resolves against nothing and the canvas collapses to a strip —
// 280px of a 760px viewport on mobile (attribution lightbox, 2026-09-12).
// All of this app's Cesium widget chrome is disabled with `!important` rules
// in style.css, so these stock sheets cannot resurrect it.
import '../node_modules/cesium/Source/Widgets/CesiumWidget/CesiumWidget.css';
import '../node_modules/cesium/Source/Widgets/Viewer/Viewer.css';
import { StyleManager } from './ui.js';
import { resolveRenderContextOptions } from './renderContextOptions.js';
import { flyToAustin } from './camera.js';
import { DataLayerManager } from './data/manager.js';
import flightsLayer from './data/flights.js';
import militaryFlightsLayer from './data/militaryFlights.js';
import earthquakesLayer from './data/earthquakes.js';
import satellitesLayer from './data/satellites.js';
import planetsLayer from './data/planets.js';
import rocketLaunchesLayer from './data/rocketLaunches.js';
import trafficLayer from './data/traffic.js';
import cctvLayer from './data/cctv.js';
import radioLayer from './data/radio.js';
import bikeshareLayer from './data/bikeshare.js';
import transitVehiclesLayer from './data/transitVehicles.js';
import syntheticTrafficLayer from './data/syntheticTraffic.js';
import aisLiveVesselsLayer from './data/aisLiveVessels.js';
import militaryInstallationsLayer from './data/militaryInstallations.js';
import militaryAwarenessLayer from './data/militaryAwareness.js';
import localDataLayers from './data/localLayers.js';
import { LAYER_STATE_REGISTRY } from './data/layerState.js';
import { registerDataCredits } from './data/dataCredits.js';
import { SceneDirector } from './scenes/director.js';
import { initGevVoiceCommands } from './voice/gevRealtime.js';
import { MapStackController } from './mapStackController.js';
import { initAnnotations } from './annotations/index.js';
import { initLogoGaze } from './logoGaze.js';
import { initCockpitCloudEffects } from './cockpitCloudEffects.js';
import {
  installRenderGovernor,
  getRenderGovernorDiagnostics,
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from './renderGovernor.js';
import { setLogLevel, getLogLevel, peekLogBuffer, drainLogBuffer } from './logger.js';
import { applyTilesetCachePolicy } from './tilesetCachePolicy.js';
import { applySceneRenderScale } from './sceneRenderScale.js';
import { installScopeMask } from './scopeMask.js';
import { initFirstRunExperience } from './firstRunExperience.js';

initLogoGaze();

/**
 * Extract a human-readable error message from any thrown value.
 * Handles Error objects, strings, and plain objects with message/error fields.
 * @param {*} error — caught exception value
 * @returns {string} best-effort error description
 */
function describeError(error) {
  if (!error) return 'Unknown initialization error';
  if (error instanceof Error) {
    if (error.message && error.message.trim()) return error.message.trim();
    return error.name || 'Initialization error';
  }
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (typeof error === 'object') {
    const maybeMessage = String(error.message || error.error || '').trim();
    if (maybeMessage) return maybeMessage;
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return serialized;
    } catch {
      // ignore serialization error
    }
  }
  return String(error);
}

/**
 * GOD'S EYE VIEW — Main Entry Point
 * Initializes CesiumJS with Google Photorealistic 3D Tiles,
 * style system, intelligence HUD, location presets, and share links.
 */
async function init() {
  const loadingScreen = document.getElementById('loading-screen');
  const loaderStatus = loadingScreen.querySelector('.loader-status');

  try {
    loaderStatus.textContent = 'Configuring viewer...';

    // Tell bundled Cesium where to find its Workers + Assets at runtime.
    // This must be set BEFORE any Cesium viewer/imagery/terrain is constructed.
    Cesium.buildModuleUrl.setBaseUrl('/cesium/');

    // Set Cesium Ion token for World Terrain
    const cesiumToken = import.meta.env.CESIUM_ION_TOKEN;
    if (cesiumToken) {
      Cesium.Ion.defaultAccessToken = cesiumToken;
    }

    // Set Google Maps API key for 3D Tiles (optional — globe works with OSM without it)
    const googleApiKey = import.meta.env.GOOGLE_MAPS_API_KEY;
    // The scaffolded placeholder is a sentinel for "not configured yet", not a
    // key: sending it to tile.googleapis.com just 400s every boot (and the
    // voice nearby-places proxy forwards it into the same rejection). The
    // Places-library loader below already treated it as absent — apply that
    // consistently to every key consumer.
    const hasGoogleKey = Boolean(googleApiKey) && googleApiKey !== 'your_google_maps_api_key_here';
    if (hasGoogleKey) {
      Cesium.GoogleMaps.defaultApiKey = googleApiKey;
    } else {
      console.info('GOOGLE_MAPS_API_KEY not set — using OpenStreetMap basemap');
    }
    // Expose API key globally for geocoding in locations.js and Places autocomplete
    window.__GOOGLE_MAPS_API_KEY__ = hasGoogleKey ? googleApiKey : '';

    // Load Google Maps Places library for location search autocomplete
    window.__googleMapsReady__ = new Promise((resolve) => {
      if (!hasGoogleKey) {
        resolve(null);
        return;
      }
      if (window.google?.maps?.places) {
        resolve(window.google);
        return;
      }
      window.__mapsCallback__ = () => resolve(window.google);
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${googleApiKey}&libraries=places&callback=__mapsCallback__`;
      script.async = true;
      document.head.appendChild(script);
    });

    // Create the Cesium viewer with minimal chrome
    const viewer = new Cesium.Viewer('cesiumContainer', {
      timeline: false,
      animation: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      vrButton: false,
      selectionIndicator: false,
      infoBox: false,
      baseLayer: false,
      // Detached credit container — the operator removed the visible
      // attribution strip (2026-08-29), so this element is never appended to
      // the document and no credit line renders, in normal or recording
      // modes. NOTE: Google Maps Platform ToS requires visible attribution
      // for Photorealistic 3D Tiles; this is an operator decision recorded
      // here deliberately. Cesium still receives a valid container — it just
      // stays out of the layout.
      creditContainer: (() => {
        const el = document.createElement('div');
        el.id = 'cesium-credits';
        return el;
      })(),
      // MSAA 2× + unpreserved drawing buffer — the policy (and its ?msaa= /
      // ?preserveBuffer=1 escape hatches) lives in renderContextOptions.js.
      ...resolveRenderContextOptions(),
    });

    // Cap the default render loop at 60 fps. Cesium's loop otherwise runs at
    // the display's refresh rate — 120 Hz on ProMotion panels — doubling GPU
    // and CPU burn for zero visual benefit in a map app whose animation
    // cadences (poll interpolation, trail fades, style crossfades) are all
    // designed against wall-clock time, not frame count. Measured on the
    // 2026-08-05 perf investigation as a strict halving of idle burn on
    // 120 Hz hardware; a no-op on 60 Hz displays. (perf item 2)
    // From installRenderGovernor() onward the GOVERNOR owns this knob: with
    // the camera parked and every continuous-render holder a wall-clock-timed
    // animator (style loop, fleet dead-reckoning, satellites, …) it drops to
    // 30 fps — the world state is unchanged, only the sampling rate (Phase 9
    // Batch P, widened by the 2026-09-23 idle-GPU audit) — and restores 60 on
    // any camera-driven holder or camera motion.
    viewer.targetFrameRate = 60;

    // Render-resolution scale policy (Phase 9 Batch R — docs/PLAN.md, sceneRenderScale.js).
    // On HiDPI displays the scene otherwise renders at CSS × DPR backing-store
    // size — ~106 MiB of color+depth at 2560×1440 @ DPR 2 — for negligible
    // visible benefit against the photoreal tiles. The policy scales to 0.75
    // when DPR > 1.5 (cutting dedicated GPU memory ~44%) and 1.0 otherwise.
    // `?renderScale=N` (0.5..2) forces an explicit value for A/B capture.
    applySceneRenderScale(viewer);

    // Register per-layer data attribution into the "Data attribution" popover.
    // Required by each source's license (ODbL, CC BY-NC-SA, NASA FIRMS, etc.);
    // strings are verbatim from DATA_SOURCES.md. Static + always-present in the
    // expandable bottom-left credit lightbox (showOnScreen=false), so they never
    // clutter the on-globe attribution line.
    registerDataCredits(viewer);

    // Hide Cesium's default globe — Google Photorealistic 3D Tiles provide their own
    // globe at all LODs (street level → orbital). The default globe's 2D imagery
    // clips through 3D tile buildings at close range.
    viewer.scene.globe.show = false;

    // Keep a sky behind Google 3D Tiles, but soften Cesium's high-intensity
    // default atmosphere. With the globe hidden its bright limb otherwise
    // reads as a hard cyan seam where distant photoreal tiles meet the sky.
    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.skyAtmosphere.atmosphereLightIntensity = 18;
    viewer.scene.skyAtmosphere.saturationShift = -0.12;
    viewer.scene.skyAtmosphere.brightnessShift = -0.08;

    loaderStatus.textContent = 'Loading Google 3D Tiles...';
    let tileset = null;
    try {
      // Load Google Photorealistic 3D Tiles. The await is bounded: a stalled
      // connection to the tileset asset endpoint otherwise hangs boot forever
      // (the catch below only sees rejections, not hangs) — QA observed boot
      // waits exceeding 150s with no error. On timeout the existing fallback
      // (Cesium globe) engages like any other tileset failure.
      tileset = await Promise.race([
        Cesium.createGooglePhotorealistic3DTileset({
          onlyUsingWithGoogleGeocoder: true,
        }),
        new Promise((_, reject) => {
          const watchdog = setTimeout(
            () => reject(new Error('Google 3D Tiles asset load timed out after 60s')),
            60_000,
          );
          // Settle hygiene: don't keep the event loop referencing a spent timer.
          if (typeof watchdog.unref === 'function') watchdog.unref();
        }),
      ]);
      viewer.scene.primitives.add(tileset);
      // Photoreal tile-cache budget (Phase 9 Batch P): Google's helper asks
      // for 1536 MB cache + 1024 MB overflow (2.5 GB ceiling). Measured boot
      // residency is ~220 MB; 384/128 keeps a downtown fly-through resident
      // while bounding the worst-case VRAM spike. ?tileCacheMB= restores a
      // custom budget. Policy + rationale: tilesetCachePolicy.js.
      applyTilesetCachePolicy(tileset);
      // NOTE: Cesium World Terrain intentionally disabled — conflicts with Google 3D Tiles at high zoom.
      // Google Photorealistic 3D Tiles provide their own terrain/elevation.
      viewer.scene.globe.show = false;
    } catch (tileError) {
      console.warn('[Init] Google 3D Tiles unavailable, falling back to Cesium globe:', tileError);
      const tileErrorDetail = describeError(tileError);
      loaderStatus.textContent = `Google 3D Tiles unavailable (${tileErrorDetail}). Continuing in fallback mode...`;
      // Keep Cesium globe visible as fallback instead of aborting the app.
      viewer.scene.globe.show = true;
    }

    loaderStatus.textContent = 'Initializing systems...';

    const mapStackController = new MapStackController(viewer, {
      googleTileset: tileset,
      cesiumToken,
      initialStack: tileset ? 'photoreal' : 'osm',
      // Task 5 (height-datum fix): rebroadcast stack changes as a window
      // CustomEvent so data layers (CCTV per-regime ground resolution) can
      // react without coupling MapStackController to layer modules. Fires on
      // 'switching'/'ready'/'error'; listeners derive the surface regime from
      // live scene state, so intermediate emissions are harmless.
      onChange: (state) => {
        window.dispatchEvent(new CustomEvent('gev:map-stack-changed', { detail: state }));
      },
      onError: (message) => console.warn('[MapStack]', message),
    });
    await mapStackController.setStack(tileset ? 'photoreal' : 'osm', { silent: true });

    // Initialize the style manager (post-processing, HUD, locations, share links)
    const styleManager = new StyleManager(viewer, { mapStackController });
    // The previous multi-canvas weather compositor remains disabled. Cockpit
    // clouds use a separate, capped low-resolution GPU pass that never attaches
    // Cesium fog or post-process stages and is fully stopped in map mode.
    const weatherEffects = null;
    const cockpitCloudEffects = initCockpitCloudEffects(viewer);

    // If no share link state, do default fly-to Austin
    if (!styleManager.hasShareState) {
      loaderStatus.textContent = 'Flying to Austin, TX...';
      flyToAustin(viewer);
    } else {
      loaderStatus.textContent = 'Restoring shared view...';
    }

    // Initialize data layer manager
    const dataManager = new DataLayerManager(viewer, {
      allowQaRegistration: import.meta.env.DEV,
    });
    dataManager.register(flightsLayer);
    dataManager.register(militaryFlightsLayer);
    dataManager.register(earthquakesLayer);
    dataManager.register(satellitesLayer);
    dataManager.register(planetsLayer);
    dataManager.register(rocketLaunchesLayer);
    rocketLaunchesLayer.attachDataManager(dataManager);
    dataManager.register(trafficLayer);
    dataManager.register(cctvLayer);
    dataManager.register(radioLayer);
    dataManager.register(bikeshareLayer);
    dataManager.register(transitVehiclesLayer);
    dataManager.register(syntheticTrafficLayer);
    dataManager.register(aisLiveVesselsLayer);
    dataManager.register(militaryInstallationsLayer);
    dataManager.register(militaryAwarenessLayer);
    militaryAwarenessLayer.attachDataManager(dataManager);
    for (const layer of localDataLayers) {
      dataManager.register(layer);
    }
    // Restoration starts only after the complete production registry is sealed.
    dataManager.finalizeRegistrations(LAYER_STATE_REGISTRY);
    if (import.meta.env.DEV) {
      window.__gevQaRegisterLayer = (targetManager, layerModule) => {
        if (targetManager !== dataManager) throw new Error('QA layer manager mismatch');
        return dataManager.registerForQa(layerModule);
      };
      window.__gevQaUnregisterLayer = (targetManager, layerId) => {
        if (targetManager !== dataManager) throw new Error('QA layer manager mismatch');
        return dataManager.unregisterForQa(layerId);
      };
    }
    // buildTogglePanel builds the vanilla layer toggle rows into #data-toggles.
    // Without it #data-toggles stays empty and the app ships with no layer UI
    // at all — the regression the L9 matrix caught (layer rows, feed-state
    // chips, and the voice layer-state sync all read these rows).
    dataManager.buildTogglePanel(document.getElementById('data-toggles'));
    styleManager.attachDataManager(dataManager);

    // Restore "where you left off" camera position and style from localStorage.
    // Only runs when there is no share URL active; share URLs take precedence.
    const hasShareParams = (() => {
      const hash = window.location.hash.slice(1);
      if (!hash) return false;
      const params = new URLSearchParams(hash);
      return params.has('lat') && params.has('lon');
    })();
    if (!hasShareParams) {
      styleManager.restoreViewState();
    }

    // Initialize deterministic scene playback for social clip capture
    const sceneDirector = new SceneDirector(viewer, styleManager, dataManager);

    // Initialize the voice "whiteboard" annotation engine (world-space renderer)
    const annotations = initAnnotations({ viewer, tileset });

    // Keep startup chrome truthful: a share is not restored until camera,
    // visual/map/panel lanes, and every requested layer have terminated.
    void Promise.all([
      styleManager.initialRestorePromise,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]).finally(() => {
      loadingScreen.classList.add('hidden');
      // Reveal only after the loading cover has yielded. transitionend can be
      // absent under reduced motion, so a bounded fallback makes this reliable.
      let firstRunRevealed = false;
      const revealFirstRun = () => {
        if (firstRunRevealed) return;
        firstRunRevealed = true;
        // dataManager is passed explicitly: the globe missions enable bundled
        // keyless layers through it, and reaching for styleManager._dataManager
        // would make a private field part of this feature's contract.
        initFirstRunExperience({ styleManager, dataManager });
      };
      loadingScreen.addEventListener('transitionend', revealFirstRun, { once: true });
      setTimeout(revealFirstRun, 900);
    });

    // Expose for debugging
    // Idle render governor: flips the scene into requestRenderMode whenever
    // nothing animates per frame. Installed AFTER every module above has had
    // its chance to register pre-install holds. (perf wave 2)
    installRenderGovernor(viewer);

    // The explicit scope mask replaces the emergent six-pass artifact —
    // see src/scopeMask.js. Installed before the UI so the DISPLAY-rail
    // toggle finds it live.
    installScopeMask(viewer);

    // The follow camera recomputes the tracked target's dead-reckon position
    // every frame — tracking anything is a per-frame animation. (perf wave 2)
    viewer.trackedEntityChanged.addEventListener(() => {
      if (viewer.trackedEntity) holdContinuousRender('tracked-entity');
      else releaseContinuousRender('tracked-entity');
    });

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
        if (dataManager._panelRefreshPendingOnVisible) {
          dataManager._panelRefreshPendingOnVisible = false;
          dataManager._refreshTogglePanel();
        }
        governorRequestRender('visibility-restore');
      }
    };
    document.addEventListener('visibilitychange', syncVisibilitySuspension);
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
      requestRender: governorRequestRender,
      logger: {
        setLogLevel,
        getLogLevel,
        peekLogBuffer,
        drainLogBuffer,
      },
    };
    window.__godsEyeView.voiceCommands = initGevVoiceCommands({ viewer, styleManager, dataManager, sceneDirector, annotations });

    // Signal that the React scaffold can now consume window.__godsEyeView
    window.dispatchEvent(new CustomEvent('__gev_viewer_ready'));

    // ── PWA: service worker update prompt ─────────────────────────────────────
    // The vite-plugin-pwa plugin injects SW registration automatically (injectRegister: 'auto').
    // Here we listen for the controllerchange event to prompt the user when a new
    // version is available — without disrupting the current session.
    if ('serviceWorker' in navigator) {
      // When the controller changes (new SW activated), prompt to reload.
      // This fires after the new SW takes over — the user sees a non-disruptive
      // banner rather than an abrupt swap mid-session.
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!document.getElementById('gevv-update-banner')) {
          const banner = document.createElement('div');
          banner.id = 'gevv-update-banner';
          banner.setAttribute('role', 'status');
          banner.setAttribute('aria-live', 'polite');
          banner.style.cssText = [
            'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
            'background:#0f1f3d', 'border:1px solid #1a3a5a', 'border-radius:6px',
            'padding:12px 24px', 'font-family:"JetBrains Mono",monospace', 'font-size:12px',
            'color:#6b8aaa', 'letter-spacing:"0.05em"', 'z-index:99999',
            'display:flex', 'align-items:center', 'gap:16px', 'box-shadow:0 4px 24px rgba(0,0,0,0.6)',
          ].join(';');
          banner.innerHTML = `
            <span style="color:#c8d4e0">A new version is available.</span>
            <button id="gevv-reload-btn" style="
              background:#00d4ff; border:none; border-radius:4px;
              color:#0a0a0a; font-family:inherit; font-size:11px; font-weight:600;
              letter-spacing:0.08em; padding:6px 16px; cursor:pointer;
            ">RELOAD</button>
          `;
          banner.querySelector('#gevv-reload-btn').addEventListener('click', () => {
            window.location.reload();
          });
          document.body.appendChild(banner);
        }
      });
    }

  } catch (error) {
    console.error("God's Eye View initialization failed:", error);
    loaderStatus.textContent = `Error: ${describeError(error)}`;
    loaderStatus.style.color = '#ff4444';
  }
}

init();
