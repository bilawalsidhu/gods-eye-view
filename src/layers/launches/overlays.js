import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import {
  createCyberSonarSampler,
  isCyberContactSonarActive as isCyberSonarActive,
} from '../../cyberSonar.js';
import {
  ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
  ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID,
  ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID,
  ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_OPTIONS,
  ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_OPTIONS,
} from './policy.js';

export function createOverlays({ state: layerState, services, parts, source }) {
  /**
   * Resolve whether a surface mission anchor is safely on the camera-facing
   * side of Earth. The small positive limb margin prevents labels anchored just
   * beyond the horizon from leaking through the hidden Cesium globe.
   * @param {Cesium.Cartesian3} cameraPosition Camera world position.
   * @param {Cesium.Cartesian3} markerPosition Mission anchor world position.
   * @param {number} [limbMargin] Additional normalized horizon clearance.
   * @returns {boolean} Whether the marker belongs on the visible hemisphere.
   */

  function missionAnchorHorizonVisible(
    cameraPosition,
    markerPosition,
    limbMargin = 0.012,
  ) {
    if (!cameraPosition || !markerPosition) return false;
    const cameraMagnitude = Cesium.Cartesian3.magnitude(cameraPosition);
    if (
      !Number.isFinite(cameraMagnitude) ||
      cameraMagnitude <= Cesium.Ellipsoid.WGS84.maximumRadius
    ) {
      return false;
    }
    const cameraDirection = Cesium.Cartesian3.normalize(
      cameraPosition,
      new Cesium.Cartesian3(),
    );
    const markerDirection = Cesium.Cartesian3.normalize(
      markerPosition,
      new Cesium.Cartesian3(),
    );
    const limbThreshold =
      Cesium.Ellipsoid.WGS84.maximumRadius / cameraMagnitude;
    return (
      Cesium.Cartesian3.dot(cameraDirection, markerDirection) >
      limbThreshold + limbMargin
    );
  }

  /**
   * Resolve launch-anchor visibility for overview and selected-mission views.
   * @param {Cesium.Cartesian3} cameraPosition Camera world position.
   * @param {Cesium.Cartesian3} markerPosition Mission anchor world position.
   * @param {string} markerId Mission represented by this anchor.
   * @param {string|null} selectedLaunchId Explicitly selected mission.
   * @returns {boolean} Whether the launch anchor should render.
   */

  function missionAnchorVisible(
    cameraPosition,
    markerPosition,
    markerId,
    selectedLaunchId = null,
  ) {
    if (selectedLaunchId && markerId !== selectedLaunchId) return false;
    return missionAnchorHorizonVisible(cameraPosition, markerPosition);
  }

  function shortMissionLabel(name, maxLength = 24) {
    const text = String(name || 'Unnamed mission')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' | ')[0];
    const compact = text.split(' — ')[0].trim();
    return compact.length > maxLength
      ? `${compact.slice(0, maxLength - 1).trimEnd()}…`
      : compact;
  }

  /**
   * Reduce generic launch-complex names to their identifying pad or area suffix.
   * @param {string|null} launchSite Launch Library pad name.
   * @returns {string|null} Compact launch-site identifier.
   */

  function compactLaunchSiteName(launchSite) {
    const text = String(launchSite || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text || /^(unknown|unavailable|n\/a)$/i.test(text)) return null;
    const genericPrefix =
      /^(?:orbital\s+launch\s+pad|space\s+launch\s+complex|launch\s+(?:area|complex|pad|site))\s*[-·:]?\s*/i;
    const compact = text.replace(genericPrefix, '').trim();
    return compact || null;
  }

  /**
   * Build the source-owned launch-site marker presentation. Overview markers
   * compete in the bounded ambient-label domain; the selected mission moves to
   * the protected selected lane and gains the former launch-site detail line.
   * @param {object} launch Normalized Launch Library mission.
   * @param {Cesium.Cartesian3|function():Cesium.Cartesian3} position Existing display position.
   * @param {boolean} [selected=false] Whether the mission owns the selected view.
   * @returns {object}
   */

  function createRocketMissionMarkerOverlayEntry(
    launch,
    position,
    selected = false,
  ) {
    const mission = shortMissionLabel(launch?.name, 26).toUpperCase();
    const siteName = compactLaunchSiteName(launch?.launchSite);
    const launchTimeMs = Date.parse(launch?.launchTime);
    const details = selected
      ? [
          siteName
            ? t('layers.missions.launchSiteValue', {
                site: shortMissionLabel(siteName, 20).toUpperCase(),
              })
            : t('layers.missions.launchSite'),
        ]
      : [];
    return {
      id: `launch:${launch?.id}`,
      position,
      variant: 'label',
      title: mission,
      details,
      accent: '#22e6e6',
      priority: selected
        ? Number.MAX_SAFE_INTEGER
        : Number.isFinite(launchTimeMs)
          ? Math.floor(launchTimeMs / 1000)
          : 0,
      selected,
      protected: selected,
      paintLane: selected ? 'selected' : 'ambient-label',
      collisionGroup: 'ambient-label',
      interactive: false,
      distanceScale: {
        near: 1000,
        nearValue: 1.08,
        far: 20_000_000,
        farValue: 0.78,
      },
      gapPx: 12,
      verticalOnly: true,
      placement: 'above',
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
    };
  }

  /**
   * Build one protected label belonging to the selected mission's trajectory,
   * live payload position, or orbit. Copy is already source-formatted by the
   * caller; newline semantics become explicit host detail rows.
   * @param {object} input
   * @param {string} input.id Stable mission-element identity.
   * @param {Cesium.Cartesian3|function():Cesium.Cartesian3} input.position Existing cached position.
   * @param {string} input.text Former native-label text, including newlines.
   * @param {string} input.accent Source-owned label color.
   * @param {number} [input.priority=0] Protected placement order.
   * @param {number} [input.gapPx=8] Anchor-to-label gap.
   * @returns {object}
   */

  function createRocketMissionElementOverlayEntry({
    id,
    position,
    text,
    accent,
    priority = 0,
    gapPx = 8,
  }) {
    const [title, ...details] = String(text || '').split('\n');
    return {
      id: String(id),
      position,
      variant: 'label',
      title,
      details,
      accent,
      priority,
      selected: true,
      protected: true,
      paintLane: 'selected',
      collisionGroup: 'ambient-label',
      interactive: false,
      gapPx,
      verticalOnly: true,
      placement: 'above',
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
    };
  }

  /** Keep the newest ambient mission markers with stable identity tie-breaking. */

  function selectRocketMissionMarkerOverlayCohort(
    entries,
    limit = ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
  ) {
    const cap = Math.max(
      0,
      Math.min(
        ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
        Math.floor(Number(limit) || 0),
      ),
    );
    if (!Array.isArray(entries) || cap === 0) return [];
    return entries
      .slice()
      .sort(
        (a, b) =>
          b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
      )
      .slice(0, cap);
  }

  function missionHoverReticleImage() {
    if (layerState._missionHoverReticleImage)
      return layerState._missionHoverReticleImage;
    const canvas = document.createElement('canvas');
    const size = 48;
    const inset = 6;
    const arm = 12;
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    context.strokeStyle = '#22e6e6';
    context.lineWidth = 2;
    context.lineCap = 'square';
    context.shadowColor = 'rgba(34, 230, 230, .72)';
    context.shadowBlur = 5;
    context.beginPath();
    context.moveTo(inset, inset + arm);
    context.lineTo(inset, inset);
    context.lineTo(inset + arm, inset);
    context.moveTo(size - inset - arm, inset);
    context.lineTo(size - inset, inset);
    context.lineTo(size - inset, inset + arm);
    context.moveTo(inset, size - inset - arm);
    context.lineTo(inset, size - inset);
    context.lineTo(inset + arm, size - inset);
    context.moveTo(size - inset - arm, size - inset);
    context.lineTo(size - inset, size - inset);
    context.lineTo(size - inset, size - inset - arm);
    context.stroke();
    layerState._missionHoverReticleImage = canvas;
    return canvas;
  }

  /**
   * Resolve the one permitted screen-space replay overlay state.
   * @param {object} input Overlay state.
   * @param {boolean} input.replayActive Whether replay owns the camera.
   * @param {boolean} input.ascending Whether the replay marker is on ascent.
   * @param {boolean} input.countdownActive Whether the T-minus hold is active.
   * @returns {'countdown'|'ascent'|'orbit'|null}
   */

  function replayOverlayMode({
    replayActive,
    ascending,
    countdownActive,
    preCountdownActive = false,
  }) {
    if (!replayActive) return null;
    if (preCountdownActive) return null;
    if (countdownActive) return 'countdown';
    return ascending ? 'ascent' : 'orbit';
  }

  function createReplayVehicleOverlay() {
    if (layerState._replayVehicleOverlay || typeof document === 'undefined')
      return;
    const host = document.getElementById('cesiumContainer') || document.body;
    layerState._replayVehicleOverlay = document.createElement('div');
    layerState._replayVehicleOverlay.className =
      'mission-replay-vehicle-overlay';
    layerState._replayVehicleOverlay.hidden = true;
    layerState._replayVehicleOverlay.setAttribute('aria-hidden', 'true');
    layerState._replayVehicleOverlay.innerHTML = `
    <div class="mission-replay-flight-symbol">
      <svg class="mission-replay-rocket" viewBox="0 0 48 72" aria-hidden="true">
        <path class="mission-replay-rocket-body" d="M24 5C16 14 14 27 15 45L9 54L18 51L24 58L30 51L39 54L33 45C34 27 32 14 24 5Z"></path>
        <circle class="mission-replay-rocket-port" cx="24" cy="29" r="3.4"></circle>
      </svg>
      <svg class="mission-replay-thrust" viewBox="0 0 72 72" aria-hidden="true">
        <ellipse style="--thrust-index:0" cx="36" cy="7" rx="5" ry="1.8"></ellipse>
        <ellipse style="--thrust-index:1" cx="36" cy="15" rx="8" ry="2.4"></ellipse>
        <ellipse style="--thrust-index:2" cx="36" cy="24" rx="11" ry="3"></ellipse>
        <ellipse style="--thrust-index:3" cx="36" cy="35" rx="15" ry="3.8"></ellipse>
        <ellipse style="--thrust-index:4" cx="36" cy="48" rx="20" ry="4.7"></ellipse>
        <ellipse style="--thrust-index:5" cx="36" cy="63" rx="26" ry="5.8"></ellipse>
      </svg>
    </div>
    <div class="mission-replay-orbit-dot" aria-hidden="true"></div>
    <div class="mission-replay-overlay-callout">
      <strong data-replay-overlay-title></strong>
      <span data-replay-overlay-detail></span>
    </div>`;
    host.appendChild(layerState._replayVehicleOverlay);
    layerState._replayVehicleOverlay._sonarIcons = [
      ...layerState._replayVehicleOverlay.querySelectorAll(
        '.mission-replay-flight-symbol, .mission-replay-orbit-dot',
      ),
    ];
    layerState._replayVehicleOverlay._sonarLabel =
      layerState._replayVehicleOverlay.querySelector(
        '.mission-replay-overlay-callout',
      );
  }

  function hideReplayVehicleOverlay() {
    if (!layerState._replayVehicleOverlay) return;
    layerState._replayVehicleOverlay.hidden = true;
    layerState._replayVehicleOverlay.classList.remove(
      'is-thrusting',
      'is-paused',
    );
  }

  function destroyReplayVehicleOverlay() {
    layerState._replayVehicleOverlay?.remove();
    layerState._replayVehicleOverlay = null;
    layerState._replayVehicleOverlayText = '';
  }

  function clearMissionOverlaySources() {
    layerState._selectedMissionOverlayTimeText = null;
    layerState._missionOverlayHost.clearSource(
      ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID,
    );
    layerState._missionOverlayHost.setVisible(
      ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID,
      false,
    );
    layerState._missionOverlayHost.clearSource(
      ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID,
    );
    layerState._missionOverlayHost.setVisible(
      ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID,
      false,
    );
  }

  function syncMissionOverlayEntries() {
    if (!layerState._enabled || !layerState._dataSource?.show) {
      clearMissionOverlaySources();
      return;
    }
    const selectedRecord = layerState._selectedLaunchId
      ? layerState._missionOverlayRecords.get(layerState._selectedLaunchId)
      : null;
    if (selectedRecord) {
      layerState._missionOverlayHost.clearSource(
        ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID,
      );
      layerState._missionOverlayHost.setVisible(
        ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID,
        false,
      );
      const entries = selectedRecord.elementEntryFactories.map((createEntry) =>
        createEntry(),
      );
      if (layerState._replayCameraLaunchId !== selectedRecord.launch.id) {
        entries.unshift(
          createRocketMissionMarkerOverlayEntry(
            selectedRecord.launch,
            selectedRecord.anchorPosition,
            true,
          ),
        );
      }
      layerState._missionOverlayHost.setEntries(
        ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID,
        entries,
        ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_OPTIONS,
      );
      layerState._missionOverlayHost.setVisible(
        ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID,
        true,
      );
      layerState._selectedMissionOverlayTimeText = selectedRecord.liveEventTime
        ? parts.policyHelpers.formatMissionEventTime(
            selectedRecord.liveEventTime(),
          )
        : null;
      return;
    }

    layerState._missionOverlayHost.clearSource(
      ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID,
    );
    layerState._missionOverlayHost.setVisible(
      ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID,
      false,
    );
    layerState._selectedMissionOverlayTimeText = null;
    const entries = selectRocketMissionMarkerOverlayCohort(
      Array.from(layerState._missionOverlayRecords.values(), (record) => {
        const entry = createRocketMissionMarkerOverlayEntry(
          record.launch,
          record.anchorPosition,
        );
        if (record.launch.id === layerState._hoveredRosterLaunchId) {
          entry.pinned = true;
          entry.priority = Number.MAX_SAFE_INTEGER - 1;
        }
        return entry;
      }),
    );
    layerState._missionOverlayHost.setEntries(
      ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID,
      entries,
      ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_OPTIONS,
    );
    layerState._missionOverlayHost.setVisible(
      ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID,
      true,
    );
  }

  function refreshSelectedMissionOverlayText() {
    const selectedRecord = layerState._selectedLaunchId
      ? layerState._missionOverlayRecords.get(layerState._selectedLaunchId)
      : null;
    if (!selectedRecord?.liveEventTime) return;
    const nextText = parts.policyHelpers.formatMissionEventTime(
      selectedRecord.liveEventTime(),
    );
    if (nextText !== layerState._selectedMissionOverlayTimeText)
      syncMissionOverlayEntries();
  }

  function updateReplayVehicleOverlay(occluder) {
    if (
      !layerState._viewer ||
      !layerState._replayVehicleOverlay ||
      !layerState._selectedLaunchId
    ) {
      hideReplayVehicleOverlay();
      return null;
    }
    const launch = layerState._launches.find(
      (item) => item.id === layerState._selectedLaunchId,
    );
    const track = layerState._replayTracks.get(layerState._selectedLaunchId);
    if (!launch || !track) {
      hideReplayVehicleOverlay();
      return null;
    }
    const replayActive = layerState._replayCameraLaunchId === launch.id;
    const state = track.getReplayState();
    const mode = replayOverlayMode({
      replayActive,
      ascending: state.ascending,
      countdownActive: state.countdownActive,
      preCountdownActive: state.preCountdownActive,
    });
    if (!mode) {
      track.lastOverlayWindowPosition = null;
      track.lastOverlayMode = null;
      hideReplayVehicleOverlay();
      return null;
    }
    const path = state.ascending ? track.ascentPath : track.animatedOrbitPath;
    // Do not call scene.sampleHeight() from this post-render path. A selected
    // mission can remain visible from globe range, and a periodic remote height
    // probe forces Google Photorealistic 3D Tiles to reconsider its refinement
    // set even though the camera is stationary. That presented as a one-second
    // shrink/expand pulse across the globe. Replay follows its already-built,
    // surface-safe Cartesian path and therefore needs no runtime pad sampling.
    const position = parts.paths.samplePath(path, state.phaseProgress);
    if (!position || !occluder.isPointVisible(position)) {
      hideReplayVehicleOverlay();
      return null;
    }
    const windowPosition = Cesium.SceneTransforms.worldToWindowCoordinates(
      layerState._viewer.scene,
      position,
    );
    if (!windowPosition) {
      hideReplayVehicleOverlay();
      return null;
    }
    const canvas = layerState._viewer.scene.canvas;
    if (
      windowPosition.x < -80 ||
      windowPosition.y < -100 ||
      windowPosition.x > canvas.clientWidth + 80 ||
      windowPosition.y > canvas.clientHeight + 100
    ) {
      hideReplayVehicleOverlay();
      return null;
    }
    // The replay camera already targets this same frame-cached world position.
    // Applying a second temporal filter here made the DOM vehicle trail the
    // camera until the snap threshold was crossed, producing a repeating
    // forward/back jump. Keep smoothing only for the non-tracked close-up pad
    // marker, where the user can move the camera independently.
    const renderedWindowPosition =
      !replayActive && track.lastOverlayMode === mode
        ? parts.replay.smoothReplayWindowPosition(
            track.lastOverlayWindowPosition,
            windowPosition,
          )
        : windowPosition;
    track.lastOverlayWindowPosition = renderedWindowPosition;
    track.lastOverlayMode = mode;
    const sonar = isCyberSonarActive()
      ? createCyberSonarSampler(canvas.clientWidth, canvas.clientHeight)
      : null;
    const factor =
      sonar?.at(renderedWindowPosition.x, renderedWindowPosition.y) ?? 1;
    for (const icon of layerState._replayVehicleOverlay._sonarIcons || [])
      icon.style.opacity = String(factor);
    if (layerState._replayVehicleOverlay._sonarLabel)
      layerState._replayVehicleOverlay._sonarLabel.style.opacity = String(
        sonar ? sonar.label(factor) : 1,
      );
    layerState._replayVehicleOverlay.hidden = false;
    layerState._replayVehicleOverlay.dataset.mode = mode;
    layerState._replayVehicleOverlay.classList.toggle(
      'is-thrusting',
      replayActive && state.ascending && !state.countdownActive,
    );
    layerState._replayVehicleOverlay.classList.toggle(
      'is-paused',
      replayActive && layerState._replayPaused,
    );
    layerState._replayVehicleOverlay.style.transform = `translate3d(${renderedWindowPosition.x}px, ${renderedWindowPosition.y}px, 0) translate(-50%, -50%)`;
    let vehicleRotation = 0;
    if (replayActive && !state.countdownActive) {
      const tangentStep = Math.max(0.002, 0.8 / Math.max(2, path.length - 1));
      const forwardProgress = Math.min(1, state.phaseProgress + tangentStep);
      const backwardProgress = Math.max(0, state.phaseProgress - tangentStep);
      const useForward = forwardProgress > state.phaseProgress;
      const tangentPosition = parts.paths.samplePath(
        path,
        useForward ? forwardProgress : backwardProgress,
      );
      const tangentWindowPosition = tangentPosition
        ? Cesium.SceneTransforms.worldToWindowCoordinates(
            layerState._viewer.scene,
            tangentPosition,
          )
        : null;
      if (tangentWindowPosition) {
        const screenDelta = Math.hypot(
          tangentWindowPosition.x - windowPosition.x,
          tangentWindowPosition.y - windowPosition.y,
        );
        // When the path points almost directly into/out of the camera, its
        // screen projection has no trustworthy direction. Keep the last valid
        // path-facing pose instead of snapping the rocket to a camera-facing
        // upright orientation.
        if (screenDelta >= 2) {
          vehicleRotation = useForward
            ? parts.replay.replayVehicleScreenRotation(
                windowPosition,
                tangentWindowPosition,
              )
            : parts.replay.replayVehicleScreenRotation(
                tangentWindowPosition,
                windowPosition,
              );
          track.lastVehicleRotation = vehicleRotation;
        } else if (Number.isFinite(track.lastVehicleRotation)) {
          vehicleRotation = track.lastVehicleRotation;
        }
      }
    }
    layerState._replayVehicleOverlay.style.setProperty(
      '--mission-replay-rotation',
      `${Cesium.Math.toDegrees(vehicleRotation)}deg`,
    );

    const mission = shortMissionLabel(launch.name, 22).toUpperCase();
    const siteName = compactLaunchSiteName(launch.launchSite);
    const siteCallout = siteName
      ? t('layers.missions.launchSiteValue', {
          site: shortMissionLabel(siteName, 20).toUpperCase(),
        })
      : t('layers.missions.launchSite');
    let title = mission;
    let detail = siteCallout;
    if (mode === 'countdown') {
      title = t('layers.missions.replay.countdown', {
        time: String(state.countdownSeconds).padStart(2, '0'),
        mission,
      });
      detail = `${t('layers.missions.replay.standbyDetail')}\n${siteCallout}`;
    } else if (mode === 'ascent') {
      title =
        state.elapsedSinceStart < 1
          ? t('layers.missions.replay.liftoff', { mission })
          : t(
              launch.trajectory.length > 1
                ? 'layers.missions.replay.ascentReplay'
                : 'layers.missions.replay.ascentEstimate',
              { mission },
            );
      detail = parts.policyHelpers.formatMissionEventTime(state.eventTime);
    } else if (mode === 'recovery') {
      title = t('layers.missions.replay.recovery', { mission });
      detail = parts.policyHelpers.formatMissionEventTime(state.eventTime);
    } else if (mode === 'orbit') {
      title = t('layers.missions.replay.orbit', { mission });
      detail = parts.policyHelpers.formatMissionEventTime(state.eventTime);
    }
    if (layerState._replayPaused)
      title = t('layers.missions.replay.pausedPrefix', { title });
    const nextText = `${title}\n${detail}`;
    if (nextText !== layerState._replayVehicleOverlayText) {
      layerState._replayVehicleOverlayText = nextText;
      layerState._replayVehicleOverlay.querySelector(
        '[data-replay-overlay-title]',
      ).textContent = title;
      layerState._replayVehicleOverlay.querySelector(
        '[data-replay-overlay-detail]',
      ).textContent = detail;
    }
    return mode;
  }
  return {
    missionAnchorHorizonVisible,
    missionAnchorVisible,
    shortMissionLabel,
    compactLaunchSiteName,
    createRocketMissionMarkerOverlayEntry,
    createRocketMissionElementOverlayEntry,
    selectRocketMissionMarkerOverlayCohort,
    missionHoverReticleImage,
    replayOverlayMode,
    createReplayVehicleOverlay,
    hideReplayVehicleOverlay,
    destroyReplayVehicleOverlay,
    clearMissionOverlaySources,
    syncMissionOverlayEntries,
    refreshSelectedMissionOverlayText,
    updateReplayVehicleOverlay,
  };
}
