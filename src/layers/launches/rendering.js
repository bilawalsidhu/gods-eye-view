import { rgbaFromCss } from '../shared/color.js';
import * as geo from '../../geo/index.js';
import { appClock } from '../../time/clock.js';
import {
  TRAJECTORY_STAGE_COLORS,
  REPLAY_ORBIT_DURATION_SEC,
  REPLAY_TILE_SETTLE_DELAY_SEC,
  STAGE_REENTRY_ALTITUDE_M,
} from './policy.js';

// Cesium's PolylineDash patterns of the mission paths as the contract's
// dashes: dashLength 12 px with 0xaaaa is 0.75 px on, 0.75 px off; 8 px and
// 24 px with 0xf0f0 are 2 and 6 px on, as much off.
const RECOVERY_DASH = Object.freeze({ lengthPx: 0.75, gapPx: 0.75 });
const REENTRY_DASH = Object.freeze({ lengthPx: 2, gapPx: 2 });
const TRANSFER_DASH = Object.freeze({ lengthPx: 6, gapPx: 6 });

export function createRendering({
  state: layerState,
  services,
  parts,
  source,
  getRenderer,
}) {
  const { getSatelliteOrbitTrack, findSatelliteOrbitTrackInTle } =
    services.satellites;

  /** An element's position now (a function position is read). */
  function elementPosition(element) {
    return typeof element?.position === 'function'
      ? element.position()
      : element?.position;
  }

  /** Draws an element's graphics as its own and its graphics' flags say. */
  function syncElement(element) {
    if (element.point) element.point.show = element.shown && element.pointShown;
    if (element.reticle)
      element.reticle.show = element.shown && element.reticleShown;
    if (element.line)
      element.line.show =
        element.shown && !layerState._pendingLaunchIds.has(element.launchId);
  }

  /** Selection isolation: whether the element belongs in the view. */
  function setElementShown(element, shown) {
    const next = Boolean(shown);
    if (element.shown === next) return;
    element.shown = next;
    syncElement(element);
  }

  /**
   * One mission element (a launch site, path, payload or vehicle) the layer
   * records and the display draws: `point` { pixelSize, color },
   * `reticle` (the hover reticle), `polyline` { positions, width, color,
   * dash, arc }.
   */
  function addMissionElement({
    id,
    position,
    point,
    reticle,
    polyline,
    properties,
  }) {
    const display = getRenderer();
    const element = {
      id,
      launchId: parts.selection.entityLaunchId(id),
      position,
      positions: polyline?.positions ?? null,
      properties,
      shown: true,
      pointShown: true,
      reticleShown: false,
      pointStyle: point ?? null,
      point: null,
      reticle: null,
      line: null,
    };
    if (point)
      element.point = display.addPoint({
        id,
        position,
        sizePx: point.pixelSize,
        color: point.color,
      });
    if (reticle)
      element.reticle = display.addReticle({
        id,
        position,
        image: parts.overlays.missionHoverReticleImage(),
      });
    if (polyline)
      element.line = display.addLine({
        id,
        pickId: id,
        positions: polyline.positions,
        widthPx: polyline.width,
        color: polyline.color,
        dash: polyline.dash,
        arc: polyline.arc,
      });
    layerState._missionElements.set(id, element);
    syncElement(element);
    return element;
  }

  /** Removes every mission element and what the display draws for it. */
  function removeMissionElements() {
    for (const element of layerState._missionElements.values()) {
      element.point?.remove();
      element.reticle?.remove();
      element.line?.remove();
    }
    layerState._missionElements.clear();
  }

  // Away from live, a launch shows from its lift-off on, so scrubbing the
  // world time forward brings the launches up in the order they flew. The
  // selected mission stays, whenever it flies.
  function syncPendingLaunches() {
    const pending = new Set();
    for (const { launch } of layerState._missionOverlayRecords.values()) {
      if (layerState.launchHidden(launch)) pending.add(launch.id);
    }
    const previous = layerState._pendingLaunchIds;
    if (
      pending.size === previous.size &&
      [...pending].every((id) => previous.has(id))
    )
      return;
    layerState._pendingLaunchIds = pending;
    parts.overlays.syncMissionOverlayEntries();
    parts.orbitRendering.syncMissionOrbitPrimitiveVisibility();
  }

  function updateMissionFrame() {
    const display = getRenderer();
    if (!layerState._enabled || !display?.visible()) {
      parts.overlays.hideReplayVehicleOverlay();
      return;
    }
    syncPendingLaunches();
    parts.panel.updateMissionTelemetry();
    const { occluder } = display;
    const cameraPosition = layerState._engine.camera.livePosition;
    parts.overlays.updateReplayVehicleOverlay(occluder);
    parts.overlays.refreshSelectedMissionOverlayText();
    for (const element of layerState._missionElements.values()) {
      if (!element.shown) continue;
      const id = element.launchId;
      if (!id) continue;
      const pending = layerState._pendingLaunchIds.has(id);
      if (element.line) element.line.show = !pending;
      if (!element.position) continue;
      const position = elementPosition(element);
      let horizonVisible =
        !pending && Boolean(position && occluder.isPointVisible(position));
      const launchAnchor = element.id.startsWith('rocket-launch:');
      if (launchAnchor) {
        horizonVisible =
          !pending &&
          parts.overlays.missionAnchorVisible(
            cameraPosition,
            position,
            id,
            layerState._selectedLaunchId,
          );
        // Keep `shown` reserved for mission-selection isolation. Horizon
        // state is applied to the individual graphics below so a rear-side
        // anchor remains eligible for reevaluation as the camera moves.
      }
      if (element.point && element.pointShown !== horizonVisible) {
        element.pointShown = horizonVisible;
        syncElement(element);
      }
      if (launchAnchor && element.reticle) {
        const reticleShown =
          horizonVisible && id === layerState._hoveredRosterLaunchId;
        if (element.reticleShown !== reticleShown) {
          element.reticleShown = reticleShown;
          syncElement(element);
        }
      }
    }
  }

  // The source snapshot owns its ephemeris epoch. A renderer attached later
  // must reconstruct the same ascent and orbit, including a paused replay.
  const orbitSolutions = new WeakMap();
  function orbitForLaunch(launch, activeTleText, orbitAllowed) {
    const known = orbitSolutions.get(launch);
    if (known && known.activeTleText === activeTleText) return known;
    const coreTrack =
      orbitAllowed && launch.satelliteQuery
        ? getSatelliteOrbitTrack(launch.satelliteQuery, {
            launchTime: launch.launchTime,
          })
        : null;
    const satelliteTrack =
      coreTrack ||
      (orbitAllowed && activeTleText && launch.satelliteQuery
        ? findSatelliteOrbitTrackInTle(activeTleText, launch.satelliteQuery, {
            launchTime: launch.launchTime,
          })
        : null);
    const orbitPath = !orbitAllowed
      ? null
      : satelliteTrack?.orbitPath?.length > 1
        ? satelliteTrack.orbitPath
        : parts.paths.approximateOrbitPath(launch);
    const solution = { activeTleText, satelliteTrack, orbitPath };
    orbitSolutions.set(launch, solution);
    return solution;
  }

  function addLaunchElements(
    launch,
    activeTleText = layerState._activeTleText,
  ) {
    const position = geo.cartesian3.fromDegrees(launch.lon, launch.lat);
    const overlayRecord = {
      launch,
      anchorPosition: position,
      elementEntryFactories: [],
      liveEventTime: null,
    };
    layerState._missionOverlayRecords.set(launch.id, overlayRecord);
    const orbitAllowed = parts.policyHelpers.launchStatusAllowsOrbit(
      launch.status,
    );
    const { satelliteTrack, orbitPath } = orbitForLaunch(
      launch,
      activeTleText,
      orbitAllowed,
    );
    launch.recoveryStages.forEach((stage) => {
      stage.endpoint = parts.paths.landingEndpoint(
        stage,
        launch,
        orbitPath?.[0] || null,
      );
    });
    if (satelliteTrack) layerState._orbitMatches++;
    addMissionElement({
      id: `rocket-launch:${launch.id}`,
      position,
      point: {
        pixelSize: 5,
        color: parts.model.missionMarkerColor(launch),
      },
      reticle: true,
      properties: {
        launchId: launch.id,
        launchName: launch.name,
        launchTime: launch.launchTime,
        launchSite: launch.launchSite,
        provider: launch.provider,
        mission: launch.mission,
        status: launch.status,
        source: launch.source,
        orbit: JSON.stringify(launch.orbit || {}),
        satelliteName: satelliteTrack?.name || '',
        noradId: satelliteTrack?.noradId || '',
      },
    });
    const points = launch.trajectory
      .filter(
        (point) =>
          Number.isFinite(Number(point.latitude)) &&
          Number.isFinite(Number(point.longitude)),
      )
      .map((point) => ({
        stage: String(
          point.stage ||
            point.stage_name ||
            point.phase ||
            point.stageName ||
            'trajectory',
        ),
        position: geo.cartesian3.fromDegrees(
          Number(point.longitude),
          Number(point.latitude),
          Number(point.altitude || 0),
        ),
      }));
    if (points.length > 1) {
      const segments = [];
      points.forEach((point) => {
        const previous = segments.at(-1);
        if (!previous || previous.stage !== point.stage)
          segments.push({ stage: point.stage, positions: [] });
        segments.at(-1).positions.push(point.position);
      });
      segments.forEach((segment, index) => {
        if (segment.positions.length < 2) return;
        addMissionElement({
          id: `rocket-trajectory:${launch.id}:${index}`,
          polyline: {
            positions: parts.paths.surfaceSafePath(segment.positions),
            width: 2,
            color: rgbaFromCss(
              TRAJECTORY_STAGE_COLORS[index % TRAJECTORY_STAGE_COLORS.length],
            ).withAlpha(0.8),
            arc: 'none',
          },
          properties: {
            launchId: launch.id,
            stage: segment.stage,
            source: launch.source,
          },
        });
      });
    }
    if (orbitPath?.length > 1) {
      const orbitCurrent = satelliteTrack?.current || {
        longitude: launch.lon,
        latitude: launch.lat,
        altitude: 0,
      };
      const orbitPeriodSec =
        satelliteTrack?.periodSec ||
        parts.paths.estimatedOrbitPeriodSeconds(orbitPath);
      const launchEpochMs = Date.parse(launch.launchTime);
      const disclosedInsertionOffsetSec =
        parts.paths.orbitInsertionOffsetSeconds(launch);
      const insertionDurationSec = Number.isFinite(disclosedInsertionOffsetSec)
        ? Math.max(0, disclosedInsertionOffsetSec)
        : 600;
      const insertionEpochMs = Number.isFinite(launchEpochMs)
        ? launchEpochMs + insertionDurationSec * 1000
        : Number.NaN;
      let insertionReference = points.at(-1)?.position || null;
      if (
        !insertionReference &&
        satelliteTrack?.positionAt &&
        Number.isFinite(insertionEpochMs)
      ) {
        const propagatedInsertion = satelliteTrack.positionAt(
          new Date(insertionEpochMs),
        );
        if (propagatedInsertion) {
          insertionReference = geo.cartesian3.fromDegrees(
            propagatedInsertion.longitude,
            propagatedInsertion.latitude,
            propagatedInsertion.altitude,
          );
        }
      }
      if (!insertionReference && !satelliteTrack) {
        // A projected orbit has no authoritative historical phase. Start its
        // plane over the launch site, advance only by the estimated powered
        // ascent duration, and join the forward orbit tangent. Using the UTC
        // epoch as phase sent some ascents toward the far side of Earth and
        // forced a visible 180-degree corrective hook before insertion.
        const insertionProgress = geo.math.clamp(
          insertionDurationSec / orbitPeriodSec,
          1 / 96,
          0.16,
        );
        insertionReference = parts.paths.samplePath(
          orbitPath,
          insertionProgress,
        );
      }
      const { ascentPath, animatedOrbitPath } = parts.paths.buildMissionPaths(
        position,
        points.map((point) => point.position),
        orbitPath,
        insertionReference,
      );
      const ascentDurationSec = parts.replay.replayAscentDurationSeconds(
        launch,
        ascentPath,
      );
      // A frame can read the replay position several times (the camera, the
      // overlay, the vehicle element). Camera tracking and the HTML replay overlay must
      // use the exact same replay epoch as those callbacks; sampling appClock.now()
      // independently made the vehicle advance relative to the camera and then
      // snap back on the next frame.
      let replayStateForFrame = null;
      const sampleReplayState = () =>
        parts.replay.replayState(
          launch,
          layerState._animationStarts.get(launch.id) || appClock.now(),
          ascentDurationSec,
          REPLAY_ORBIT_DURATION_SEC,
          orbitPeriodSec,
          layerState._replaySpeed,
          parts.replay.replayClockNow(launch.id),
          REPLAY_TILE_SETTLE_DELAY_SEC,
          layerState._replayCameraLaunchId !== launch.id,
        );
      // The replay camera seeds one state in preUpdate and every consumer of
      // that frame, through postRender, sees the same timestamp.
      const beginReplayFrame = () => {
        replayStateForFrame = sampleReplayState();
        return replayStateForFrame;
      };
      const getReplayState = () => {
        if (!replayStateForFrame) {
          replayStateForFrame = sampleReplayState();
        }
        return replayStateForFrame;
      };
      launch.recoveryStages.forEach((stage, stageIndex) => {
        stage.endpoint = parts.paths.landingEndpoint(
          stage,
          launch,
          ascentPath.at(-1),
        );
        const path = parts.paths.stageReentryRecoveryPath(
          ascentPath,
          stage.endpoint,
          stageIndex,
          launch.recoveryStages.length,
        );
        if (path.length < 2) return;
        const reentryIndex = parts.paths.atmosphericReentryIndex(path);
        const reentryPath = path.slice(reentryIndex);
        const color = rgbaFromCss(
          TRAJECTORY_STAGE_COLORS[
            (stageIndex + 1) % TRAJECTORY_STAGE_COLORS.length
          ],
        );
        addMissionElement({
          id: `rocket-reentry-recovery:${launch.id}:${stageIndex}`,
          polyline: {
            positions: path,
            width: 2,
            color: color.withAlpha(0.82),
            dash: RECOVERY_DASH,
            arc: 'none',
          },
          properties: {
            launchId: launch.id,
            stageId: stage.id,
            phase: 'STAGE_REENTRY_RECOVERY',
            accuracy: stage.endpoint.accuracy,
            source: launch.source,
          },
        });
        if (reentryPath.length > 1) {
          addMissionElement({
            id: `rocket-reentry:${launch.id}:${stageIndex}`,
            polyline: {
              positions: reentryPath,
              width: 2.5,
              color: rgbaFromCss('#ffd166').withAlpha(0.9),
              dash: REENTRY_DASH,
              arc: 'none',
            },
            properties: {
              launchId: launch.id,
              stageId: stage.id,
              phase: 'ATMOSPHERIC_REENTRY',
              altitudeM: STAGE_REENTRY_ALTITUDE_M,
              source: 'Estimated 100 km atmospheric interface',
            },
          });
          const reentryPosition = path[reentryIndex];
          overlayRecord.elementEntryFactories.push(() =>
            parts.overlays.createRocketMissionElementOverlayEntry({
              id: `reentry:${launch.id}:${stageIndex}`,
              position: reentryPosition,
              text: 'STAGE RE-ENTRY',
              accent: '#ffd166',
              priority: 700_000 - stageIndex,
              gapPx: 8,
            }),
          );
        }
        addMissionElement({
          id: `rocket-recovery-end:${launch.id}:${stageIndex}`,
          position: path.at(-1),
          point: { pixelSize: 4, color },
          properties: {
            launchId: launch.id,
            stageId: stage.id,
            phase: 'RECOVERY_ENDPOINT',
            source: launch.source,
          },
        });
      });
      layerState._replayTracks.set(launch.id, {
        ascentPath,
        animatedOrbitPath,
        orbitFrameSphere:
          parts.camera.replayOrbitFrameSphere(animatedOrbitPath),
        ascentDurationSec,
        beginReplayFrame,
        getReplayState,
        lastCameraHeading: Math.PI,
        orbitCameraWorldFrame: false,
        lastVehicleRotation: 0,
        lastOverlayWindowPosition: null,
        lastOverlayMode: null,
      });
      let livePosition = geo.cartesian3.fromDegrees(
        orbitCurrent.longitude,
        orbitCurrent.latitude,
        orbitCurrent.altitude,
      );
      const liveTime = new Date(layerState.orbitNow());
      const liveTelemetry = { speedMps: null };
      layerState._satelliteTelemetry.set(launch.id, liveTelemetry);
      let liveFrameNumber = -1;
      const fallbackPeriodSec =
        parts.paths.estimatedOrbitPeriodSeconds(orbitPath);
      // At most once per engine frame: every reader in a frame (the dot,
      // the panel, the label) sees one propagation.
      const updateLiveState = () => {
        const frameNumber = getRenderer()?.frameNumber() ?? -1;
        if (frameNumber !== -1 && frameNumber === liveFrameNumber) return;
        liveFrameNumber = frameNumber;
        const nowMs = layerState.orbitNow();
        liveTime.setTime(nowMs);
        if (satelliteTrack) {
          const propagated =
            satelliteTrack.positionAt?.(liveTime) || satelliteTrack.current;
          if (propagated) {
            geo.cartesian3.fromDegrees(
              propagated.longitude,
              propagated.latitude,
              propagated.altitude,
              undefined,
              livePosition,
            );
            liveTelemetry.speedMps = Number.isFinite(propagated.speedMps)
              ? propagated.speedMps
              : null;
          }
        } else {
          // In-place write keeps one Cartesian3 for the mission's lifetime —
          // the estimated branch previously reallocated per propagation.
          livePosition =
            parts.paths.samplePath(
              orbitPath,
              parts.paths.orbitProgressAtTime(nowMs, fallbackPeriodSec),
              livePosition,
            ) || livePosition;
        }
      };
      addMissionElement({
        id: `rocket-satellite:${launch.id}`,
        position: () => {
          updateLiveState();
          return livePosition;
        },
        point: {
          pixelSize: 6,
          color: rgbaFromCss(satelliteTrack ? '#7bed9f' : '#ffd166'),
        },
        properties: {
          launchId: launch.id,
          noradId: satelliteTrack?.noradId || '',
          phase: satelliteTrack
            ? 'CURRENT_SATELLITE_POSITION'
            : 'ESTIMATED_ORBIT_POSITION',
          source: satelliteTrack
            ? 'Satellites layer'
            : 'Approximate mission orbit',
        },
      });
      overlayRecord.liveEventTime = () => liveTime;
      overlayRecord.elementEntryFactories.push(() => {
        const name = satelliteTrack
          ? parts.overlays
              .shortMissionLabel(satelliteTrack.name, 22)
              .toUpperCase()
          : 'EST. ORBIT POSITION';
        return parts.overlays.createRocketMissionElementOverlayEntry({
          id: `payload-position:${launch.id}`,
          position: () => livePosition,
          text: `${name}\n${parts.policyHelpers.formatMissionEventTime(liveTime)}`,
          accent: satelliteTrack ? '#7bed9f' : '#ffd166',
          priority: 900_000,
          gapPx: 12,
        });
      });
      // Live satellite rings are lines with a model matrix so the core
      // Satellite GMST transform can rotate their baked ECEF geometry without
      // rebuilding it. Estimated launch-site-relative rings are fixed.
      const primitiveOrbitAdded = parts.orbitRendering.addMissionOrbitPrimitive(
        launch,
        orbitPath,
        satelliteTrack,
      );
      if (!primitiveOrbitAdded) {
        addMissionElement({
          id: `rocket-orbit:${launch.id}`,
          polyline: {
            positions: orbitPath,
            // The 3 px canvas gives the periodic dot room to read as round; the
            // pattern masks the ten intervening dashes down to a thin center stroke.
            width: 3,
            color: rgbaFromCss('#c084fc').withAlpha(0.95),
            dash: 'tactical',
            arc: 'none',
          },
          properties: {
            launchId: launch.id,
            satelliteName: '',
            noradId: '',
            source: 'Approximate mission orbit',
          },
        });
      }
      const orbitLabelBakePosition = ascentPath.at(-1);
      let orbitLabelPosition = orbitLabelBakePosition;
      const primitivePath = layerState._missionOrbitPrimitives.get(launch.id);
      if (primitivePath) {
        primitivePath.labelBakePosition = orbitLabelBakePosition;
        primitivePath.labelPosition = geo.matrix4.multiplyByPoint(
          primitivePath.modelMatrix,
          orbitLabelBakePosition,
          geo.cartesian3.create(),
        );
        orbitLabelPosition = () => primitivePath.labelPosition;
      }
      overlayRecord.elementEntryFactories.push(() =>
        parts.overlays.createRocketMissionElementOverlayEntry({
          id: `orbit:${launch.id}`,
          position: orbitLabelPosition,
          text: satelliteTrack ? 'ORBIT' : 'PROJECTED ORBIT',
          accent: satelliteTrack ? '#22e6e6' : '#c084fc',
          priority: 800_000,
          gapPx: 8,
        }),
      );
      const replayPosition = () => {
        const state = getReplayState();
        return state.ascending
          ? parts.paths.samplePath(ascentPath, state.phaseProgress)
          : parts.paths.samplePath(animatedOrbitPath, state.phaseProgress);
      };
      // The replay vehicle draws as the screen overlay; its element has no
      // graphics.
      addMissionElement({
        id: `rocket-vehicle:${launch.id}`,
        position: replayPosition,
        properties: {
          launchId: launch.id,
          noradId: satelliteTrack?.noradId || '',
          phase: 'ASCENT_THEN_ORBIT',
          source: satelliteTrack
            ? 'Satellite trajectory animation'
            : 'Approximate trajectory animation',
        },
      });
      addMissionElement({
        id: `rocket-transfer:${launch.id}`,
        polyline: {
          positions: ascentPath,
          width: 1.5,
          // The animated vehicle uses Cartesian interpolation between these
          // exact samples. Straight segments keep the line from separating
          // from it as geodesic arcs would.
          arc: 'none',
          color: rgbaFromCss('#7bed9f').withAlpha(0.8),
          dash: TRANSFER_DASH,
        },
        properties: {
          launchId: launch.id,
          phase: 'APPROXIMATE_TRANSFER',
          source: satelliteTrack
            ? 'Launch site to propagated insertion'
            : 'Launch site to forward projected insertion',
        },
      });
    }
  }
  return {
    elementPosition,
    setElementShown,
    addMissionElement,
    removeMissionElements,
    updateMissionFrame,
    addLaunchElements,
  };
}
