import {
  DEFAULT_CORRIDOR_ID,
  DEFAULT_ROUTING_MODEL,
  BENCHMARK_CORRIDOR_IDS,
  getCorridorDiff,
  getTrainingSummary,
  getFleetSimulation,
  getShadowPairs,
  getWearableStatus,
  simulatePickup,
  SafeSpotTelemetryClient,
  formatDistance,
} from '../../data/safespot.js';
import { SafeSpotRouteRenderer, ROUTE_COLORS } from './rendering.js';
import { SafeSpotPickupRenderer, PICKUP_COLORS } from './pickup.js';
import { SafeSpotTelemetryVisualizer, TELEMETRY_COLORS } from './telemetry.js';
import { SafeSpotFleetSimulator } from './fleet.js';
import { SafeSpotHdMapController, HD_MAP_MODES } from './hdMap.js';
import {
  showScorecardModal,
  closeScorecardModal,
  isScorecardModalOpen,
} from './scorecardModal.js';
import { buildSafeSpotRowControls } from './controls.js';
import { msg } from '../../i18n/index.js';

/**
 * @module layers/safespot
 * @description SafeSpotSG 3D Visual Routing, Model Comparison Arena, Autonomous
 * Full-Singapore Test Fleet (Cars & Buses), High-DPI Street Map Enhancer,
 * Pickup Simulation, and Garmin Watch Evaluation Lab layer module for God's Eye View.
 */

export const SAFESPOT_LAYER_ID = 'safespot-lab';
export const SAFESPOT_LAYER_NAME = 'SafeSpotSG Evaluation Lab';
export const SAFESPOT_LAYER_ICON = '🛡️';
export const SAFESPOT_LAYER_SOURCE = 'SafeSpotSG · LTA · Garmin';

/**
 * Construct the SafeSpotSG Evaluation Lab layer module.
 * @param {object} [options]
 * @param {object} [options.surface] Application surface services (groundFloor, meshFloor)
 * @returns {object} Standard GEV Layer Module
 */
export function createSafeSpotLayer({ surface = null } = {}) {
  let _viewer = null;
  let _renderer = null;
  let _pickupRenderer = null;
  let _telemetryVisualizer = null;
  let _fleetSimulator = null;
  let _hdMapController = null;
  let _wsClient = null;
  let _enabled = false;
  let _initialized = false;
  let _corridorData = null;
  let _pickupData = null;
  let _trainingSummary = null;
  let _fleetPollTimer = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _lastTelemetryTick = null;
  let _lastAlert = null;
  let _hasActiveAlert = false;

  const _params = {
    corridorId: DEFAULT_CORRIDOR_ID,
    model: DEFAULT_ROUTING_MODEL,
    showHeatmap: true,
    showDivergence: true,
    showGoogleReference: true,
    thresholdMeters: 35.0,
    isRaining: false,
    showPickupSimulation: true,
    showTelemetry: true,
    showFleetSimulation: true,
    fleetSpeedMultiplier: 10,
    hdMapMode: HD_MAP_MODES.RETINA_VOYAGER,
    seniorLocation: { lat: 1.3327, lng: 103.8479 },
    driverLocation: { lat: 1.3390, lng: 103.8420 },
  };

  async function fetchFleetTick({ signal = null } = {}) {
    if (!_enabled || !_params.showFleetSimulation) return null;
    try {
      const payload = await getFleetSimulation({
        model: _params.model,
        speedMultiplier: _params.fleetSpeedMultiplier,
        signal,
      });
      if (_fleetSimulator && _enabled) {
        _fleetSimulator.ingestFleetState(payload);
      }
      return payload;
    } catch {
      return null;
    }
  }

  function startFleetPolling() {
    stopFleetPolling();
    if (!_enabled || !_params.showFleetSimulation) return;
    _fleetPollTimer = setInterval(() => {
      if (!_enabled || !_params.showFleetSimulation) return;
      const stats = _fleetSimulator?.coverageStats;
      if (stats?.isComplete) return;
      void fetchFleetTick();
    }, 2500);
  }

  function stopFleetPolling() {
    if (_fleetPollTimer) {
      clearInterval(_fleetPollTimer);
      _fleetPollTimer = null;
    }
  }

  async function fetchAndUpdate(signal = null) {
    if (!_enabled) return true;
    try {
      signal?.throwIfAborted?.();

      // 1. Fetch active corridor comparison & cross-track divergence with active model
      const diffPromise = getCorridorDiff(_params.corridorId, {
        model: _params.model,
        thresholdMeters: _params.thresholdMeters,
        signal,
      });

      // 2. Fetch senior pickup simulation if enabled
      const pickupPromise = _params.showPickupSimulation
        ? simulatePickup(
            {
              seniorLocation: _params.seniorLocation,
              driverLocation: _params.driverLocation,
              isRaining: _params.isRaining,
            },
            { signal }
          ).catch((err) => {
            console.warn('[SafeSpotLab] Pickup sim fetch error:', err);
            return null;
          })
        : Promise.resolve(null);

      // 3. Fetch training summary if not yet cached
      const summaryPromise = !_trainingSummary
        ? getTrainingSummary({ signal }).catch(() => null)
        : Promise.resolve(_trainingSummary);

      // 4. Advance autonomous test fleet & road network coverage
      const fleetPromise = _params.showFleetSimulation
        ? fetchFleetTick({ signal })
        : Promise.resolve(null);

      const [diff, pickup, summary] = await Promise.all([
        diffPromise,
        pickupPromise,
        summaryPromise,
        fleetPromise,
      ]);
      signal?.throwIfAborted?.();

      _corridorData = diff;
      if (pickup) {
        _pickupData = pickup;
      }
      if (summary) {
        _trainingSummary = summary;
      }
      _lastError = null;
      _lastUpdate = Date.now();

      if (_enabled) {
        if (_renderer && _corridorData) {
          _renderer.renderCorridorDiff(_corridorData, _params);
        }
        if (_pickupRenderer && _pickupData) {
          _pickupRenderer.renderPickupSimulation(_pickupData, {
            seniorLocation: _params.seniorLocation,
            driverLocation: _params.driverLocation,
          });
        }
        if (isScorecardModalOpen()) {
          showScorecardModal({
            trainingSummary: _trainingSummary,
            activeScorecard: _corridorData?.scorecard,
            activeModel: _params.model,
            fleetStats: _fleetSimulator?.coverageStats,
          });
        }
      }
      return true;
    } catch (err) {
      if (signal?.aborted) return false;
      _lastError = err;
      console.warn(`[SafeSpotLab] Failed to update corridor ${_params.corridorId}:`, err);
      return false;
    }
  }

  async function triggerPickupSimulation() {
    try {
      const res = await simulatePickup({
        seniorLocation: _params.seniorLocation,
        driverLocation: _params.driverLocation,
        isRaining: _params.isRaining,
      });
      _pickupData = res;
      if (_pickupRenderer && _enabled) {
        _pickupRenderer.renderPickupSimulation(_pickupData, {
          seniorLocation: _params.seniorLocation,
          driverLocation: _params.driverLocation,
        });
      }
      return true;
    } catch (err) {
      console.warn('[SafeSpotLab] Trigger pickup error:', err);
      return false;
    }
  }

  function toggleCorridor() {
    const nextId =
      _params.corridorId === 'novena-to-mbs'
        ? 'toa-payoh-to-raffles-place'
        : 'novena-to-mbs';
    _params.corridorId = nextId;
    if (_enabled) {
      void fetchAndUpdate();
    }
  }

  function setModel(modelId) {
    if (!modelId || modelId === _params.model) return;
    _params.model = modelId;
    if (_enabled) {
      void fetchAndUpdate();
    }
  }

  function toggleScorecardModal() {
    if (isScorecardModalOpen()) {
      closeScorecardModal();
      return;
    }
    showScorecardModal({
      trainingSummary: _trainingSummary,
      activeScorecard: _corridorData?.scorecard,
      activeModel: _params.model,
      fleetStats: _fleetSimulator?.coverageStats,
    });
  }

  function toggleFleet() {
    _params.showFleetSimulation = !_params.showFleetSimulation;
    if (!_fleetSimulator) return;
    if (_params.showFleetSimulation && _enabled) {
      _fleetSimulator.attach();
      _fleetSimulator.setRunning(true);
      void fetchFleetTick();
      startFleetPolling();
    } else {
      stopFleetPolling();
      _fleetSimulator.detach();
    }
  }

  function triggerFleetSweep() {
    if (!_enabled) return;
    const stats = _fleetSimulator?.coverageStats;
    const currentPct = stats?.coveragePct ?? 0;
    if (currentPct >= 100) {
      // Reset and start a fresh island-wide coverage run
      _fleetSimulator?.clearTracks();
      void getFleetSimulation({
        model: _params.model,
        speedMultiplier: _params.fleetSpeedMultiplier,
        reset: true,
      }).then((payload) => {
        if (_fleetSimulator && payload) _fleetSimulator.ingestFleetState(payload);
      });
      return;
    }
    // Cycle the simulation speed (1x → 10x → 50x → 200x). Coverage is only ever
    // earned by vehicles driving each carriageway; there is no instant sweep.
    const nextMult = _fleetSimulator ? _fleetSimulator.cycleSpeedMultiplier() : 50;
    _params.fleetSpeedMultiplier = nextMult;
    void fetchFleetTick();
  }

  function cycleHdMap() {
    if (!_hdMapController) return;
    _params.hdMapMode = _hdMapController.cycleMode();
  }

  function toggleRain() {
    _params.isRaining = !_params.isRaining;
    if (_enabled) {
      void triggerPickupSimulation();
    }
  }

  function toggleTelemetryStream() {
    if (!_wsClient) return;
    if (_wsClient.isConnected) {
      _wsClient.disconnect();
    } else {
      _wsClient.connect();
    }
  }

  function triggerFallAlert() {
    if (_hasActiveAlert) {
      _hasActiveAlert = false;
      _lastAlert = null;
      _telemetryVisualizer?.clearAlert();
    } else {
      _hasActiveAlert = true;
      const alertPayload = {
        eventType: 'FALL_DETECTED',
        deviceId: 'fenix-6-solar-demo',
        floorsAbove: _lastTelemetryTick?.floorsAbove ?? 4,
        severity: 'CRITICAL',
        timestamp: Date.now(),
      };
      _lastAlert = alertPayload;
      if (_wsClient?.isConnected) {
        _wsClient.injectEvent(alertPayload);
      }
      _telemetryVisualizer?.triggerFallAlert(alertPayload);
    }
  }

  function focusActive() {
    if (_pickupRenderer && _pickupData) {
      _pickupRenderer.flyToPickupArea();
    } else if (_renderer && _corridorData) {
      _renderer.flyToActiveCorridor();
    }
  }

  const layer = {
    id: SAFESPOT_LAYER_ID,
    name: msg(SAFESPOT_LAYER_NAME),
    icon: SAFESPOT_LAYER_ICON,
    source: msg(SAFESPOT_LAYER_SOURCE),
    showInTogglePanel: true,
    updateInterval: 0, // Event-driven updates

    /**
     * One-time setup of Cesium primitives, data sources, fleet engine, HD map, and WebSocket bridge.
     */
    async init(viewer, { signal } = {}) {
      signal?.throwIfAborted?.();
      _viewer = viewer;
      _renderer = new SafeSpotRouteRenderer(viewer);
      _pickupRenderer = new SafeSpotPickupRenderer(viewer);
      _telemetryVisualizer = new SafeSpotTelemetryVisualizer(viewer, { surface });
      _fleetSimulator = new SafeSpotFleetSimulator(viewer);
      _fleetSimulator.setSpeedMultiplier(_params.fleetSpeedMultiplier);
      _hdMapController = new SafeSpotHdMapController(viewer);

      _wsClient = new SafeSpotTelemetryClient({
        autoReconnect: true,
      });

      _wsClient.on('tick', (tick) => {
        _lastTelemetryTick = tick;
        if (_enabled && _params.showTelemetry && _telemetryVisualizer) {
          _telemetryVisualizer.updateTelemetry(tick);
        }
      });

      _wsClient.on('alert', (alert) => {
        _lastAlert = alert;
        _hasActiveAlert = true;
        if (_enabled && _telemetryVisualizer) {
          _telemetryVisualizer.triggerFallAlert(alert);
        }
      });

      _initialized = true;
      return true;
    },

    /**
     * Activate rendering, attach primitives, launch autonomous test fleet, enhance map DPI, and connect WS.
     */
    async enable(viewer, { signal } = {}) {
      signal?.throwIfAborted?.();
      _viewer = viewer;
      _enabled = true;

      if (_renderer) {
        _renderer.attach();
      }
      if (_pickupRenderer) {
        _pickupRenderer.attach();
      }
      if (_telemetryVisualizer) {
        _telemetryVisualizer.attach();
      }
      if (_fleetSimulator && _params.showFleetSimulation) {
        _fleetSimulator.attach();
      }
      if (_hdMapController) {
        _hdMapController.attach(_params.hdMapMode);
      }

      if (_wsClient) {
        _wsClient.connect();
      }

      startFleetPolling();

      getWearableStatus({ signal })
        .then((status) => {
          if (_enabled && _telemetryVisualizer && !_lastTelemetryTick) {
            _telemetryVisualizer.updateTelemetry(status);
          }
        })
        .catch(() => {
          // Ignore offline status
        });

      void fetchAndUpdate(signal);
      return true;
    },

    /**
     * Deactivate rendering, detach primitives, close scorecard modal, and disconnect telemetry streaming.
     */
    async disable(viewer, { signal } = {}) {
      _enabled = false;
      stopFleetPolling();
      closeScorecardModal();

      if (_renderer) {
        _renderer.detach();
      }
      if (_pickupRenderer) {
        _pickupRenderer.detach();
      }
      if (_telemetryVisualizer) {
        _telemetryVisualizer.detach();
      }
      if (_fleetSimulator) {
        _fleetSimulator.detach();
      }
      if (_hdMapController) {
        _hdMapController.detach();
      }

      if (_wsClient) {
        _wsClient.disconnect();
      }

      return true;
    },

    /**
     * Scheduled or on-demand update tick: loads active corridor diff, fleet tick, and pickup simulation.
     */
    async update(viewer, { signal } = {}) {
      if (!_enabled) return true;
      return fetchAndUpdate(signal);
    },

    /**
     * Update parameter state (active corridor, routing model, fleet toggle, HD map mode, rain weather, etc.).
     */
    setParams(params = {}) {
      if (!params || typeof params !== 'object') return false;
      const corridorChanged =
        typeof params.corridorId === 'string' &&
        params.corridorId &&
        params.corridorId !== _params.corridorId;

      const modelChanged =
        typeof params.model === 'string' &&
        params.model &&
        params.model !== _params.model;

      const rainChanged =
        typeof params.isRaining === 'boolean' &&
        params.isRaining !== _params.isRaining;

      const hdMapChanged =
        typeof params.hdMapMode === 'string' &&
        params.hdMapMode !== _params.hdMapMode;

      Object.assign(_params, params);

      if (_enabled) {
        if (hdMapChanged && _hdMapController) {
          _hdMapController.setMode(_params.hdMapMode);
        }
        if (corridorChanged || modelChanged) {
          void fetchAndUpdate();
        } else if (rainChanged) {
          void triggerPickupSimulation();
        } else {
          if (_renderer && _corridorData) {
            _renderer.renderCorridorDiff(_corridorData, _params);
          }
          if (_pickupRenderer && _pickupData) {
            _pickupRenderer.renderPickupSimulation(_pickupData, {
              seniorLocation: _params.seniorLocation,
              driverLocation: _params.driverLocation,
            });
          }
        }
      }
      return true;
    },

    /**
     * Retrieve current parameter state.
     */
    getParams() {
      return { ..._params };
    },

    /**
     * Expose autonomous test Cars (`CAR-xxxx`) and Buses (`BUS-xxxx`) to God's Eye View's
     * screen-space Detection Overlay (`getDetectableObjects`).
     */
    getDetectableObjects(options = {}) {
      if (!_enabled || !_params.showFleetSimulation || !_fleetSimulator) return [];
      return _fleetSimulator.getDetectableObjects(options);
    },

    /**
     * Interactive chips and legend controls rendered inside GEV's layer tray.
     */
    getRowControls() {
      return buildSafeSpotRowControls({
        params: _params,
        corridorData: _corridorData,
        pickupData: _pickupData,
        telemetryTick: _lastTelemetryTick,
        fleetStats: _fleetSimulator?.coverageStats ?? null,
        isScorecardOpen: isScorecardModalOpen(),
        isStreaming: _wsClient?.isConnected ?? false,
        hasActiveAlert: _hasActiveAlert,
        enabled: _enabled,
        actions: {
          toggleCorridor,
          setModel,
          toggleScorecardModal,
          toggleFleet,
          triggerFleetSweep,
          cycleHdMap,
          toggleHeatmap: () => layer.setParams({ showHeatmap: !_params.showHeatmap }),
          toggleDivergence: () => layer.setParams({ showDivergence: !_params.showDivergence }),
          toggleRef: () => layer.setParams({ showGoogleReference: !_params.showGoogleReference }),
          toggleRain,
          triggerPickup: triggerPickupSimulation,
          toggleTelemetry: toggleTelemetryStream,
          triggerFallAlert,
          focusRoute: focusActive,
        },
      });
    },

    /**
     * Retrieve status, record counts, model scorecard, and road network coverage telemetry.
     */
    getStats() {
      const divInfo = _corridorData?.divergence || _corridorData?.comparison;
      const candidates = _pickupData?.candidates || [];
      const topPick = candidates[0];
      const fleetStats = _fleetSimulator?.coverageStats;

      return {
        count: (_corridorData ? 2 : 0) + (fleetStats?.totalVehicles ?? 0),
        lastUpdate: _lastUpdate,
        activeCorridor: _params.corridorId,
        activeModel: _params.model,
        scorecard: _corridorData?.scorecard ?? null,
        absoluteErrorPct: _corridorData?.scorecard?.absoluteErrorPct ?? null,
        queryLatencyMs: _corridorData?.scorecard?.queryLatencyMs ?? null,
        isDivergent: divInfo?.isDivergent ?? divInfo?.divergenceDetected ?? false,
        maxSeparationMeters: divInfo?.maxSeparationMeters ?? 0,
        divergentSpansCount: divInfo?.divergentSpans?.length ?? 0,
        isRaining: _params.isRaining,
        pickupCandidatesCount: candidates.length,
        bestCandidateId: topPick?.id ?? null,
        shelteredPercentage: topPick?.shelteredPercentage ?? null,
        fleetCoveragePct: fleetStats?.coveragePct ?? 0,
        fleetCoveredEdges: fleetStats?.coveredEdges ?? 0,
        fleetTotalEdges: fleetStats?.totalDrivableEdges ?? 229433,
        fleetActiveCars: fleetStats?.activeCars ?? 0,
        fleetActiveBuses: fleetStats?.activeBuses ?? 0,
        hdMapMode: _params.hdMapMode,
        telemetryConnected: _wsClient?.isConnected ?? false,
        lastTick: _lastTelemetryTick,
        lastAlert: _lastAlert,
        hasActiveAlert: _hasActiveAlert,
        error: _lastError,
      };
    },

    /**
     * Teardown all resources, primitives, modals, and WebSocket listeners.
     */
    async destroy(viewer) {
      _enabled = false;
      stopFleetPolling();
      closeScorecardModal();
      if (_wsClient) {
        _wsClient.destroy();
        _wsClient = null;
      }
      if (_renderer) {
        _renderer.destroy();
        _renderer = null;
      }
      if (_pickupRenderer) {
        _pickupRenderer.destroy();
        _pickupRenderer = null;
      }
      if (_telemetryVisualizer) {
        _telemetryVisualizer.destroy();
        _telemetryVisualizer = null;
      }
      if (_fleetSimulator) {
        _fleetSimulator.destroy();
        _fleetSimulator = null;
      }
      if (_hdMapController) {
        _hdMapController.destroy();
        _hdMapController = null;
      }
      _viewer = null;
      _corridorData = null;
      _pickupData = null;
      _trainingSummary = null;
      _lastUpdate = null;
      _lastError = null;
      _initialized = false;
      _hasActiveAlert = false;
      return true;
    },
  };

  return layer;
}
