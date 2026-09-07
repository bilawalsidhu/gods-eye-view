import * as Cesium from 'cesium';
import {
  DroneMissionSimulator,
  createMissionEntitySnapshots,
  createTerrainAwareProfile,
  createTerrainSamplingPlan,
  insertWaypoint,
  moveWaypoint,
  removeWaypoint,
  reorderWaypoint,
  sampleTerrain,
} from './drone/index.js';
import {
  createDroneRouteFromDraft,
  missionConfirmationSummary,
  normalizeDroneSettings,
} from './droneMissionModel.js';
import { createCesiumTerrainSampler } from './droneTerrainAdapter.js';
import { registerPickOwner, resolvePickId, unregisterPickOwner } from './data/pickRegistry.js';
import { holdContinuousRender, releaseContinuousRender, governorRequestRender } from './renderGovernor.js';

const ENTITY_IDS = Object.freeze({
  route: 'synthetic-drone-mission-route',
  destinationPoint: 'synthetic-drone-mission-destination-point',
  destinationArea: 'synthetic-drone-mission-destination-area',
  drone: 'simulated-demo-drone',
  trail: 'synthetic-drone-mission-flown-trail',
});
const FIXED_STEP_SECONDS = 0.1;

function routePoints(route) {
  if (!route) return [];
  const destination = route.destination.type === 'area'
    ? route.destination.center
    : route.destination.point;
  return [route.launch, ...route.waypoints, destination];
}

function coordinateLabel(point) {
  if (!point) return 'NOT SET';
  return `${point.latitude.toFixed(5)}°, ${point.longitude.toFixed(5)}°`;
}

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '—';
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const value = Math.max(0, Math.round(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

export class DroneMissionController {
  constructor(viewer, {
    pickWorldPosition,
    terrainSampler = createCesiumTerrainSampler(viewer, Cesium),
  } = {}) {
    if (!viewer?.scene || typeof pickWorldPosition !== 'function') {
      throw new TypeError('viewer and shared world-position picker are required');
    }
    this.viewer = viewer;
    this.pickWorldPosition = pickWorldPosition;
    this.terrainSampler = terrainSampler;
    this.draft = { launch: null, waypoints: [], destination: null };
    this.route = null;
    this.profile = null;
    this.simulator = null;
    this.telemetry = null;
    this.pendingPick = null;
    this.trail = [];
    this.routeLocked = false;
    this.preparing = false;
    this.preparationGeneration = 0;
    this.renderHeld = false;
    this.lastFrameMs = 0;
    this.accumulatorSeconds = 0;
    this.listeners = [];

    this.panel = document.getElementById('drone-mission-panel');
    this.openButton = document.getElementById('drone-planner-open');
    this.closeButton = document.getElementById('drone-planner-close');
    this.status = document.getElementById('drone-mission-status');
    this.pointList = document.getElementById('drone-route-points');
    this.confirmation = document.getElementById('drone-launch-confirmation');
    this.confirmationSummary = document.getElementById('drone-launch-summary');
    this.telemetryPanel = document.getElementById('drone-telemetry');
    this.progress = document.getElementById('drone-progress');
    this.pauseButton = document.getElementById('drone-pause');
    this.enterViewButton = document.getElementById('drone-enter-view');
    this.exitViewButton = document.getElementById('drone-exit-view');
    this.areaToggle = document.getElementById('drone-destination-area');
    this.radiusRow = document.getElementById('drone-radius-row');

    this._bindUi();
    this.clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    this.clickHandler.setInputAction(
      (click) => this._handleSceneClick(click?.position),
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );
    registerPickOwner('drone-mission', (id) => Object.values(ENTITY_IDS).includes(id));
    this.removePreUpdate = viewer.scene.preUpdate.addEventListener(() => this._onFrame());
    this._syncUi();
  }

  _listen(target, event, callback) {
    if (!target?.addEventListener) return;
    target.addEventListener(event, callback);
    this.listeners.push(() => target.removeEventListener(event, callback));
  }

  _bindUi() {
    this._listen(this.openButton, 'click', () => {
      this.panel.hidden = false;
      this.openButton.setAttribute('aria-expanded', 'true');
    });
    this._listen(this.closeButton, 'click', () => {
      this.panel.hidden = true;
      this.openButton.setAttribute('aria-expanded', 'false');
      this.cancelPick();
    });
    this._listen(document.getElementById('drone-set-launch'), 'click', () => (
      this.beginPick({ type: 'launch' }, 'Click the map to set the launch point.')
    ));
    this._listen(document.getElementById('drone-add-waypoint'), 'click', () => (
      this.beginPick({ type: 'waypoint', insertIndex: this.draft.waypoints.length }, 'Click the map to add a waypoint.')
    ));
    this._listen(document.getElementById('drone-set-destination'), 'click', () => (
      this.beginPick({ type: 'destination' }, 'Click the map to set the destination.')
    ));
    this._listen(document.getElementById('drone-cancel-pick'), 'click', () => this.cancelPick());
    this._listen(document.getElementById('drone-clear-route'), 'click', () => this.clear());
    this._listen(document.getElementById('drone-plan-launch'), 'click', () => this.showLaunchConfirmation());
    this._listen(document.getElementById('drone-confirm-launch'), 'click', () => this.confirmLaunch());
    this._listen(document.getElementById('drone-cancel-launch'), 'click', () => {
      this.confirmation.hidden = true;
      this._setStatus('Launch cancelled. Route remains editable.');
    });
    this._listen(this.pointList, 'click', (event) => this._handlePointAction(event));
    this._listen(this.areaToggle, 'change', () => {
      this.radiusRow.hidden = !this.areaToggle.checked;
      if (this.draft.destination) {
        const point = this.draft.destination.type === 'area'
          ? this.draft.destination.center
          : this.draft.destination.point;
        this.draft.destination = this.areaToggle.checked
          ? { type: 'area', center: point }
          : { type: 'point', point };
        this._commitDraft();
      }
    });
    for (const id of [
      'drone-min-clearance',
      'drone-speed',
      'drone-max-climb',
      'drone-max-descent',
      'drone-destination-radius',
    ]) {
      this._listen(document.getElementById(id), 'change', () => {
        if (id === 'drone-destination-radius' && this.draft.destination?.type === 'area') {
          this._commitDraft();
        } else {
          this._invalidatePreparedMission();
          this._renderPlan();
          this._syncUi();
          this._setStatus('Profile settings changed. Terrain validation is required before launch.');
        }
      });
    }
    this._listen(this.pauseButton, 'click', () => this.togglePause());
    this._listen(document.getElementById('drone-abort'), 'click', () => this.abort());
    this._listen(document.getElementById('drone-reset'), 'click', () => this.reset());
    this._listen(document.getElementById('drone-replay'), 'click', () => this.replay());
    this._listen(document.getElementById('drone-playback-speed'), 'change', (event) => {
      if (!this.simulator) return;
      this.simulator.setPlaybackSpeed(Number(event.target.value));
      this.telemetry = this.simulator.getTelemetry();
      this._renderTelemetry();
    });
    this._listen(this.enterViewButton, 'click', () => this.enterDroneView());
    this._listen(this.exitViewButton, 'click', () => this.exitDroneView());
    this._listen(document, 'keydown', (event) => {
      if (event.key === 'Escape' && this.pendingPick) this.cancelPick();
      else if (event.key === 'Escape' && document.body.classList.contains('drone-view')) {
        this.exitDroneView();
      }
    });
    this._listen(window, 'gev:drone-view-exit-request', () => this.exitDroneView());
  }

  _readSettings() {
    return normalizeDroneSettings({
      minimumAglMeters: document.getElementById('drone-min-clearance')?.value,
      groundSpeedMps: document.getElementById('drone-speed')?.value,
      maxClimbRateMps: document.getElementById('drone-max-climb')?.value,
      maxDescentRateMps: document.getElementById('drone-max-descent')?.value,
      destinationRadiusMeters: document.getElementById('drone-destination-radius')?.value,
    });
  }

  beginPick(pending, message) {
    if (this.routeLocked || this.preparing) {
      this._setStatus('Clear the DEMO mission before editing its route.', 'error');
      return;
    }
    this.pendingPick = pending;
    this.viewer.scene.canvas.classList.add('drone-picking');
    this._setStatus(message);
    this._syncUi();
  }

  cancelPick() {
    this.pendingPick = null;
    this.viewer.scene.canvas.classList.remove('drone-picking');
    this._setStatus('Point selection cancelled.');
    this._syncUi();
  }

  _handleSceneClick(position) {
    if (!position) return;
    if (!this.pendingPick) {
      const id = resolvePickId(this.viewer.scene.pick(position));
      if (id === ENTITY_IDS.drone) this.enterDroneView();
      return;
    }
    const canvas = this.viewer.scene.canvas;
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const picked = width && height
      ? this.pickWorldPosition(position.x / width, position.y / height)
      : null;
    if (!picked || !Number.isFinite(picked.lat) || !Number.isFinite(picked.lon)) {
      this._setStatus('No world position was available at that pixel. Pick visible terrain.', 'error');
      return;
    }
    const point = { latitude: picked.lat, longitude: picked.lon };
    const pending = this.pendingPick;
    this.pendingPick = null;
    canvas.classList.remove('drone-picking');

    if (pending.type === 'launch') {
      this.draft.launch = point;
    } else if (pending.type === 'destination') {
      this.draft.destination = this.areaToggle.checked
        ? { type: 'area', center: point }
        : { type: 'point', point };
    } else if (pending.type === 'move-waypoint' && this.route) {
      this._adoptRoute(moveWaypoint(this.route, pending.index, point));
      return;
    } else if (pending.type === 'waypoint' && this.route) {
      this._adoptRoute(insertWaypoint(this.route, pending.insertIndex, point));
      return;
    } else if (pending.type === 'move-waypoint') {
      this.draft.waypoints[pending.index] = {
        ...point,
        id: this.draft.waypoints[pending.index].id,
      };
    } else {
      this.draft.waypoints.splice(pending.insertIndex, 0, {
        ...point,
        id: `waypoint-${Date.now()}-${pending.insertIndex}`,
      });
    }
    this._commitDraft();
  }

  _handlePointAction(event) {
    const button = event.target.closest('button[data-action]');
    if (!button || this.routeLocked || this.preparing) return;
    const index = Number(button.dataset.index);
    try {
      if (button.dataset.action === 'move-launch') {
        this.beginPick({ type: 'launch' }, 'Click the map to move the launch point.');
      } else if (button.dataset.action === 'move-destination') {
        this.beginPick({ type: 'destination' }, 'Click the map to move the destination.');
      } else if (button.dataset.action === 'move') {
        this.beginPick({ type: 'move-waypoint', index }, `Click the map to move waypoint ${index + 1}.`);
      } else if (button.dataset.action === 'insert') {
        this.beginPick({ type: 'waypoint', insertIndex: index + 1 }, `Click the map to insert after waypoint ${index + 1}.`);
      } else if (button.dataset.action === 'remove') {
        if (this.route) this._adoptRoute(removeWaypoint(this.route, index));
        else {
          this.draft.waypoints.splice(index, 1);
          this._commitDraft();
        }
      } else if (button.dataset.action === 'up' || button.dataset.action === 'down') {
        const destination = button.dataset.action === 'up' ? index - 1 : index + 1;
        if (destination < 0 || destination >= this.draft.waypoints.length) return;
        if (this.route) this._adoptRoute(reorderWaypoint(this.route, index, destination));
        else {
          const [waypoint] = this.draft.waypoints.splice(index, 1);
          this.draft.waypoints.splice(destination, 0, waypoint);
          this._commitDraft();
        }
      }
    } catch (error) {
      this._setStatus(error.message, 'error');
    }
  }

  _adoptRoute(route) {
    this.route = route;
    this.draft = {
      launch: route.launch,
      waypoints: [...route.waypoints],
      destination: route.destination,
    };
    this.areaToggle.checked = route.destination.type === 'area';
    this.radiusRow.hidden = route.destination.type !== 'area';
    if (route.destination.type === 'area') {
      document.getElementById('drone-destination-radius').value = route.destination.radiusMeters;
    }
    this._invalidatePreparedMission();
    this._renderPlan();
    this._syncUi();
    this._setStatus('Route updated. Terrain validation is required before launch.');
  }

  _commitDraft() {
    this._invalidatePreparedMission();
    let validationError = null;
    try {
      this.route = createDroneRouteFromDraft(this.draft, this._readSettings());
    } catch (error) {
      this.route = null;
      validationError = error;
    }
    this._renderPlan();
    this._syncUi();
    this._setStatus(
      this.route
        ? 'Route ready for review. Terrain has not been sampled yet.'
        : (validationError?.message || 'Set a distinct launch and destination; waypoints are optional.'),
      validationError ? 'error' : 'info',
    );
  }

  _draftPoints() {
    const destination = this.draft.destination?.type === 'area'
      ? this.draft.destination.center
      : this.draft.destination?.point;
    return [this.draft.launch, ...this.draft.waypoints, destination].filter(Boolean);
  }

  _getEntity(id, options) {
    return this.viewer.entities.getById(id) || this.viewer.entities.add({ id, ...options });
  }

  _renderPlan() {
    const points = this.route ? routePoints(this.route) : this._draftPoints();
    const routeEntity = this._getEntity(ENTITY_IDS.route, {
      name: 'SIMULATED / DEMO drone route',
      polyline: {
        width: 3,
        material: Cesium.Color.CYAN.withAlpha(0.82),
        clampToGround: true,
      },
    });
    routeEntity.show = points.length >= 2;
    routeEntity.polyline.positions = points.map((point) => (
      Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude)
    ));

    const destination = this.draft.destination;
    const destinationPoint = this._getEntity(ENTITY_IDS.destinationPoint, {
      name: 'SIMULATED / DEMO destination',
      point: {
        pixelSize: 12,
        color: Cesium.Color.LIME,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
    });
    const destinationArea = this._getEntity(ENTITY_IDS.destinationArea, {
      name: 'SIMULATED / DEMO destination area',
      ellipse: {
        material: Cesium.Color.LIME.withAlpha(0.15),
        outline: true,
        outlineColor: Cesium.Color.LIME,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
    });
    destinationPoint.show = destination?.type === 'point';
    destinationArea.show = destination?.type === 'area';
    if (destination) {
      const anchor = destination.type === 'area' ? destination.center : destination.point;
      const position = Cesium.Cartesian3.fromDegrees(anchor.longitude, anchor.latitude);
      if (destination.type === 'point') destinationPoint.position = position;
      else {
        const enteredRadius = Number(document.getElementById('drone-destination-radius')?.value);
        const radius = Number.isFinite(enteredRadius) && enteredRadius > 0 ? enteredRadius : 1;
        destinationArea.position = position;
        destinationArea.ellipse.semiMajorAxis = radius;
        destinationArea.ellipse.semiMinorAxis = radius;
      }
    }
    governorRequestRender('drone-plan');
  }

  showLaunchConfirmation() {
    try {
      this.route = createDroneRouteFromDraft(this.draft, this._readSettings());
      const summary = missionConfirmationSummary(this.route, this._readSettings());
      this.confirmationSummary.textContent = `${summary.routePointCount} route points · `
        + `${summary.minimumAglMeters} m minimum AGL · ${summary.groundSpeedMps} m/s · `
        + `${summary.destinationType.toUpperCase()} destination · ${summary.provenance}`;
      this.confirmation.hidden = false;
      this._setStatus('Confirm the synthetic mission before terrain sampling and launch.');
    } catch (error) {
      this._setStatus(error.message, 'error');
    }
  }

  async confirmLaunch() {
    const generation = ++this.preparationGeneration;
    let settings;
    try {
      settings = this._readSettings();
      this.route = createDroneRouteFromDraft(this.draft, settings);
    } catch (error) {
      this._setStatus(error.message, 'error');
      return;
    }
    this.confirmation.hidden = true;
    this.preparing = true;
    this._setStatus('SAMPLING ACTIVE CESIUM TERRAIN — launch blocked until every sample resolves.');
    document.getElementById('drone-confirm-launch').disabled = true;
    this._syncUi();
    try {
      const plan = createTerrainSamplingPlan(this.route, { maxSpacingMeters: 100 });
      const sampledTerrain = await sampleTerrain(plan, this.terrainSampler);
      if (generation !== this.preparationGeneration) return;
      this.profile = createTerrainAwareProfile(sampledTerrain, settings);
      this.simulator = new DroneMissionSimulator({
        profile: this.profile,
        groundSpeedMps: settings.groundSpeedMps,
        playbackSpeed: Number(document.getElementById('drone-playback-speed').value),
      });
      this.routeLocked = true;
      this.trail = [];
      this.telemetry = this.simulator.launch();
      this._renderMissionSnapshots();
      this._setSimulationRunning(true);
      this._setStatus('SIMULATED / DEMO mission launched with complete terrain-aware profile.', 'success');
      this._syncUi();
    } catch (error) {
      if (generation !== this.preparationGeneration) return;
      this.profile = null;
      this.simulator = null;
      this.telemetry = null;
      this.routeLocked = false;
      this._setSimulationRunning(false);
      this._setStatus(`LAUNCH BLOCKED — ${error.message}`, 'error');
      this._syncUi();
    } finally {
      if (generation === this.preparationGeneration) {
        this.preparing = false;
        document.getElementById('drone-confirm-launch').disabled = false;
        this._syncUi();
      }
    }
  }

  _setSimulationRunning(running) {
    if (running && !this.renderHeld) {
      holdContinuousRender('drone-mission');
      this.renderHeld = true;
      this.lastFrameMs = performance.now();
      this.accumulatorSeconds = 0;
    } else if (!running && this.renderHeld) {
      releaseContinuousRender('drone-mission');
      this.renderHeld = false;
    }
    governorRequestRender('drone-mission-state');
  }

  _onFrame() {
    if (!this.simulator?.running) return;
    const now = performance.now();
    const elapsed = Math.min(0.5, Math.max(0, (now - this.lastFrameMs) / 1000));
    this.lastFrameMs = now;
    this.accumulatorSeconds += elapsed;
    let changed = false;
    while (this.accumulatorSeconds >= FIXED_STEP_SECONDS) {
      this.telemetry = this.simulator.tick(FIXED_STEP_SECONDS);
      this.accumulatorSeconds -= FIXED_STEP_SECONDS;
      changed = true;
    }
    if (changed) this._renderMissionSnapshots();
    if (!this.simulator.running) {
      this._setSimulationRunning(false);
      this._syncUi();
    }
  }

  _renderMissionSnapshots() {
    if (!this.route || !this.profile || !Number.isFinite(this.telemetry?.latitude)) return;
    const [droneSnapshot, routeSnapshot, destinationSnapshot] = createMissionEntitySnapshots({
      route: this.route,
      profile: this.profile,
      telemetry: this.telemetry,
      missionId: 'synthetic-demo-mission',
      droneId: ENTITY_IDS.drone,
    });

    const routeEntity = this._getEntity(ENTITY_IDS.route, { polyline: {} });
    routeEntity.name = 'SIMULATED / DEMO terrain-aware route';
    routeEntity.show = true;
    routeEntity.polyline.clampToGround = false;
    routeEntity.polyline.width = 3;
    routeEntity.polyline.material = Cesium.Color.CYAN.withAlpha(0.9);
    routeEntity.polyline.positions = routeSnapshot.positions.map((point) => (
      Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude, point.altitudeMsl)
    ));

    const drone = this._getEntity(ENTITY_IDS.drone, {
      name: 'SIMULATED / DEMO DRONE',
      point: {
        pixelSize: 14,
        color: Cesium.Color.CYAN,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
      },
      label: {
        text: 'SIMULATED DRONE',
        font: '12px monospace',
        fillColor: Cesium.Color.CYAN,
        pixelOffset: new Cesium.Cartesian2(0, -24),
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.72),
      },
    });
    drone.position = Cesium.Cartesian3.fromDegrees(
      droneSnapshot.position.longitude,
      droneSnapshot.position.latitude,
      droneSnapshot.position.altitudeMsl,
    );
    drone.properties = {
      simulated: true,
      provenance: 'synthetic-drone-mission',
      missionState: droneSnapshot.properties.missionState,
    };

    const lastTrail = this.trail.at(-1);
    if (!lastTrail || this.telemetry.distanceFlownMeters - lastTrail.distance >= 5
      || this.telemetry.distanceRemainingMeters === 0) {
      this.trail.push({
        distance: this.telemetry.distanceFlownMeters,
        position: drone.position.getValue
          ? drone.position.getValue(this.viewer.clock.currentTime)
          : drone.position,
      });
    }
    const trail = this._getEntity(ENTITY_IDS.trail, {
      name: 'SIMULATED / DEMO flown trail',
      polyline: {
        width: 4,
        material: Cesium.Color.ORANGE.withAlpha(0.9),
      },
    });
    trail.show = this.trail.length > 1;
    trail.polyline.positions = this.trail.map((item) => item.position);

    const destinationId = destinationSnapshot.type === 'area'
      ? ENTITY_IDS.destinationArea
      : ENTITY_IDS.destinationPoint;
    const destination = this.viewer.entities.getById(destinationId);
    if (destination) destination.name = 'SIMULATED / DEMO destination';
    this._renderTelemetry();
    governorRequestRender('drone-simulation-tick');
  }

  _renderTelemetry() {
    const telemetry = this.telemetry;
    if (!Number.isFinite(telemetry?.latitude)) {
      this.telemetryPanel.hidden = true;
      return;
    }
    this.telemetryPanel.hidden = false;
    const segmentCount = this.route ? this.route.waypoints.length + 1 : 0;
    const progress = this.profile?.totalLengthMeters
      ? telemetry.distanceFlownMeters / this.profile.totalLengthMeters
      : 0;
    this.progress.value = Math.min(1, Math.max(0, progress));
    const values = {
      state: telemetry.missionState.toUpperCase(),
      leg: `${Math.min(segmentCount, telemetry.currentSegment + 1)} / ${segmentCount}`,
      progress: `${Math.round(progress * 100)}%`,
      altitude: `${telemetry.altitudeMsl.toFixed(1)} m MSL`,
      clearance: `${telemetry.altitudeAgl.toFixed(1)} m AGL`,
      speed: `${telemetry.groundSpeedMps.toFixed(1)} m/s`,
      remaining: formatDistance(telemetry.distanceRemainingMeters),
      eta: formatDuration(telemetry.etaSeconds),
      position: `${telemetry.latitude.toFixed(5)}°, ${telemetry.longitude.toFixed(5)}°`,
    };
    for (const [key, value] of Object.entries(values)) {
      const element = document.querySelector(`[data-drone-telemetry="${key}"]`);
      if (element) element.textContent = value;
    }
  }

  togglePause() {
    if (!this.simulator) return;
    try {
      this.telemetry = this.simulator.state === 'paused'
        ? this.simulator.resume()
        : this.simulator.pause();
      this._setSimulationRunning(this.simulator.running);
      this._renderMissionSnapshots();
      this._syncUi();
      this._setStatus(this.simulator.running ? 'SIMULATED mission resumed.' : 'SIMULATED mission paused.');
    } catch (error) {
      this._setStatus(error.message, 'error');
    }
  }

  abort() {
    if (!this.simulator) return;
    try {
      this.telemetry = this.simulator.abort();
      this._setSimulationRunning(false);
      this._renderMissionSnapshots();
      this._syncUi();
      this._setStatus('SIMULATED / DEMO mission aborted.', 'error');
    } catch (error) {
      this._setStatus(error.message, 'error');
    }
  }

  reset() {
    if (!this.simulator) return;
    this.telemetry = this.simulator.reset();
    this.trail = [];
    this._setSimulationRunning(false);
    this._renderMissionSnapshots();
    this._syncUi();
    this._setStatus('SIMULATED mission reset to its terrain-validated launch point.');
  }

  replay() {
    if (!this.simulator) return;
    this.trail = [];
    this.telemetry = this.simulator.replay();
    this._setSimulationRunning(true);
    this._renderMissionSnapshots();
    this._syncUi();
    this._setStatus('Deterministic SIMULATED / DEMO replay started.');
  }

  enterDroneView() {
    const drone = this.viewer.entities.getById(ENTITY_IDS.drone);
    if (!drone) {
      this._setStatus('Launch the DEMO mission before entering DRONE VIEW.', 'error');
      return;
    }
    this.viewer.trackedEntity = drone;
    document.body.classList.add('drone-view');
    window.dispatchEvent(new CustomEvent('gev:drone-view-changed', {
      detail: { active: true, simulated: true, source: 'synthetic-drone-mission' },
    }));
    this.enterViewButton.hidden = true;
    this.exitViewButton.hidden = false;
    this._setStatus('DRONE VIEW · tracking SIMULATED / DEMO drone. Press Escape to exit.');
  }

  exitDroneView() {
    const drone = this.viewer.entities.getById(ENTITY_IDS.drone);
    if (this.viewer.trackedEntity === drone) this.viewer.trackedEntity = undefined;
    const wasActive = document.body.classList.contains('drone-view');
    document.body.classList.remove('drone-view');
    if (wasActive) {
      window.dispatchEvent(new CustomEvent('gev:drone-view-changed', {
        detail: { active: false, simulated: true, source: 'synthetic-drone-mission' },
      }));
    }
    this.enterViewButton.hidden = !drone;
    this.exitViewButton.hidden = true;
    this._setStatus('Exited DRONE VIEW. Mission simulation continues.');
  }

  _invalidatePreparedMission() {
    this.preparationGeneration += 1;
    this.preparing = false;
    if (this.simulator && ['ready', 'takeoff', 'climb', 'cruise', 'descent', 'paused', 'arrived'].includes(this.simulator.state)) {
      try { this.simulator.abort(); } catch { /* already terminal */ }
    }
    this._setSimulationRunning(false);
    this.exitDroneView();
    this.profile = null;
    this.simulator = null;
    this.telemetry = null;
    this.trail = [];
    this.routeLocked = false;
    for (const id of [ENTITY_IDS.drone, ENTITY_IDS.trail]) {
      const entity = this.viewer.entities.getById(id);
      if (entity) this.viewer.entities.remove(entity);
    }
  }

  clear() {
    this._invalidatePreparedMission();
    this.pendingPick = null;
    this.draft = { launch: null, waypoints: [], destination: null };
    this.route = null;
    this.confirmation.hidden = true;
    for (const id of Object.values(ENTITY_IDS)) {
      const entity = this.viewer.entities.getById(id);
      if (entity) this.viewer.entities.remove(entity);
    }
    this._syncUi();
    this._setStatus('DEMO mission cleared. Select a launch point to begin.');
    governorRequestRender('drone-clear');
  }

  _renderPointList() {
    this.pointList.replaceChildren();
    const rows = [
      { label: 'LAUNCH', point: this.draft.launch, action: 'move-launch' },
      ...this.draft.waypoints.map((point, index) => ({
        label: `WAYPOINT ${index + 1}`,
        point,
        index,
        waypoint: true,
      })),
      {
        label: this.draft.destination?.type === 'area' ? 'DESTINATION AREA' : 'DESTINATION',
        point: this.draft.destination?.type === 'area'
          ? this.draft.destination.center
          : this.draft.destination?.point,
        action: 'move-destination',
      },
    ];
    for (const row of rows) {
      const item = document.createElement('li');
      const text = document.createElement('span');
      const strong = document.createElement('strong');
      const small = document.createElement('small');
      strong.textContent = row.label;
      small.textContent = coordinateLabel(row.point);
      text.append(strong, small);
      const actions = document.createElement('span');
      actions.className = 'drone-point-actions';
      const addButton = (label, action, disabled = false) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.dataset.action = action;
        if (Number.isInteger(row.index)) button.dataset.index = row.index;
        button.disabled = disabled || this.routeLocked || this.preparing || !row.point;
        actions.append(button);
      };
      if (row.waypoint) {
        addButton('↑', 'up', row.index === 0);
        addButton('↓', 'down', row.index === this.draft.waypoints.length - 1);
        addButton('MOVE', 'move');
        addButton('+ AFTER', 'insert');
        addButton('REMOVE', 'remove');
      } else {
        addButton('MOVE', row.action);
      }
      item.append(text, actions);
      this.pointList.append(item);
    }
  }

  _syncUi() {
    this._renderPointList();
    const hasSimulator = Boolean(this.simulator);
    const running = Boolean(this.simulator?.running);
    const paused = this.simulator?.state === 'paused';
    this.pauseButton.disabled = !running && !paused;
    this.pauseButton.textContent = paused ? 'RESUME' : 'PAUSE';
    document.getElementById('drone-abort').disabled = !hasSimulator
      || ['aborted', 'landed'].includes(this.simulator?.state);
    document.getElementById('drone-reset').disabled = !hasSimulator;
    document.getElementById('drone-replay').disabled = !hasSimulator;
    document.getElementById('drone-plan-launch').disabled = !this.route || this.routeLocked || this.preparing;
    document.getElementById('drone-cancel-pick').disabled = !this.pendingPick;
    for (const id of [
      'drone-set-launch',
      'drone-add-waypoint',
      'drone-set-destination',
      'drone-destination-area',
      'drone-destination-radius',
      'drone-min-clearance',
      'drone-speed',
      'drone-max-climb',
      'drone-max-descent',
    ]) {
      const control = document.getElementById(id);
      if (control) control.disabled = this.routeLocked || this.preparing;
    }
    this.enterViewButton.hidden = !this.viewer.entities.getById(ENTITY_IDS.drone)
      || document.body.classList.contains('drone-view');
    this.exitViewButton.hidden = !document.body.classList.contains('drone-view');
    this._renderTelemetry();
  }

  _setStatus(message, tone = 'info') {
    if (!this.status) return;
    this.status.textContent = message;
    this.status.dataset.tone = tone;
  }

  destroy() {
    this.preparationGeneration += 1;
    this.preparing = false;
    this._setSimulationRunning(false);
    this.exitDroneView();
    this.clickHandler?.destroy();
    this.removePreUpdate?.();
    unregisterPickOwner('drone-mission');
    this.listeners.splice(0).forEach((remove) => remove());
  }
}

export function initDroneMission(options) {
  return new DroneMissionController(options.viewer, options);
}
