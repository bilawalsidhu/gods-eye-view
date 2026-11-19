import { fromDegrees, fromDegreesInto } from '../../geo/ellipsoid.js';
import { horizonFrom } from '../../geo/horizon.js';
import { clamp } from '../../geo/vector.js';
import { hexColor } from '../../render/color.js';
import { drawOf, findCamera, findQuery } from '../../render/rendererOf.js';
import {
  TRAJECTORY_STAGE_COLORS,
  REPLAY_ORBIT_DURATION_SEC,
  REPLAY_TILE_SETTLE_DELAY_SEC,
  STAGE_REENTRY_ALTITUDE_M,
} from './policy.js';

/** Layer instances made so far: each one's draw sets get their own ids. */
let instances = 0;

/** The mission draw sets: shown and hidden together, as one layer. */
const MISSION_SETS = ['lines', 'sites', 'markers', 'reticles'];

/** The reticle a hovered roster row draws over its launch site. */
const RETICLE_KEY = 'rocket-mission-hover-reticle';

/** The launch id in a mission item id (`rocket-<kind>:<launch id>...`). */
function launchIdOf(id) {
  if (typeof id !== 'string') return null;
  const match = id.match(/^rocket-[^:]+:([^:]+)/);
  return match?.[1] || null;
}

const copy = (p) => ({ x: p.x, y: p.y, z: p.z });

export function createRendering({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { getSatelliteOrbitTrack, findSatelliteOrbitTrackInTle } =
    services.satellites;

  /** The ids of this layer's draw sets, by name. */
  let setIds = null;
  /** Frames the mission sets have been walked in, the live cache's key. */
  let frameNumber = 0;

  /**
   * Every drawn mission item by set and id, with what decides whether it
   * shows: `isolated` (the mission's selection), and for points and icons
   * `graphicShow` (the horizon, and for the reticle the roster's hover).
   */
  const records = new Map();
  /** Items to write at the next flush, by set name. */
  const pending = new Map();

  /** A launch's marker colour. */
  function markerColor(launch) {
    const [r, g, b, a] = parts.model.missionMarkerColor(launch);
    return [r, g, b, a];
  }

  const recordKey = (set, id) => `${set}\u0000${id}`;

  /** Queue `item` for its set, replacing one queued under its id. */
  function queue(set, item) {
    let items = pending.get(set);
    if (!items) pending.set(set, (items = new Map()));
    items.set(item.id, item);
  }

  /** Write what was queued, one upsert a set. */
  function flush() {
    const sets = layerState._missionSets;
    if (!sets) {
      pending.clear();
      return;
    }
    for (const [name, items] of pending)
      if (items.size) sets[name].upsert([...items.values()]);
    pending.clear();
  }

  /** What a record draws now. */
  const drawnShow = (record) => record.isolated && record.graphicShow;

  /** Add a mission item; it draws once flushed. */
  function addItem(set, item, { graphicShow = true, position = null } = {}) {
    const record = {
      set,
      id: item.id,
      launchId: launchIdOf(item.id),
      // Every item shows until the selection isolates a mission, as the
      // entities did; `isolateMission` runs once a build is done.
      isolated: true,
      graphicShow,
      // Where the horizon pass reads it; null for lines.
      position,
      item: { ...item, show: graphicShow },
    };
    records.set(recordKey(set, item.id), record);
    queue(set, record.item);
    return record;
  }

  /** Write a record again if what it draws changed. */
  function refresh(record, moved = null) {
    const show = drawnShow(record);
    if (record.item.show === show && !moved) return;
    record.item = moved
      ? { ...record.item, pos: moved, show }
      : { ...record.item, show };
    queue(record.set, record.item);
  }

  /**
   * The layer's draw sets, hidden until enabled. The live satellite rings
   * (`orbits`) and the pad zone (`pad`) show by their own rules.
   */
  function attach(viewer) {
    const draw = drawOf(viewer);
    const base = `rocket-launches:${++instances}`;
    setIds = {
      lines: `${base}:lines`,
      sites: `${base}:sites`,
      markers: `${base}:markers`,
      reticles: `${base}:reticles`,
      orbits: `${base}:orbits`,
      pad: `${base}:pad`,
    };
    const sets = {
      lines: draw.lines({ id: setIds.lines, show: false }),
      sites: draw.points({ id: setIds.sites, show: false }),
      markers: draw.points({ id: setIds.markers, show: false }),
      reticles: draw.icons({ id: setIds.reticles, show: false }),
      // Their inertial rings turn at the frame's time, the world time the
      // sky is drawn at, so away from live they sit under the payload.
      orbits: draw.lines({ id: setIds.orbits, motionClock: { kind: 'scene' } }),
      pad: draw.shapes({ id: setIds.pad }),
    };
    layerState._missionSets = sets;
  }

  function detach() {
    const sets = layerState._missionSets;
    layerState._missionSets = null;
    records.clear();
    pending.clear();
    if (!sets) return;
    for (const set of Object.values(sets)) set.dispose();
  }

  /** Whether the missions are shown. */
  function missionsShown() {
    return Boolean(layerState._missionSets?.lines.show);
  }

  /** Show or hide the missions. */
  function showMissions(shown) {
    const sets = layerState._missionSets;
    if (!sets) return;
    for (const name of MISSION_SETS) sets[name].show = shown;
  }

  /** Remove every mission item, ahead of a rebuild. */
  function clearLaunchEntities() {
    const sets = layerState._missionSets;
    records.clear();
    pending.clear();
    if (!sets) return;
    for (const name of MISSION_SETS) sets[name].clear();
  }

  /** Whether a hit is one of this layer's mission items. */
  function missionHit(hit) {
    if (!hit || !setIds) return false;
    return (
      hit.set === setIds.lines ||
      hit.set === setIds.sites ||
      hit.set === setIds.markers ||
      hit.set === setIds.reticles
    );
  }

  /** The launch of the first mission item among a click's drilled hits. */
  function launchIdFromPicks(hits) {
    for (const hit of hits) {
      if (!missionHit(hit)) continue;
      const launchId = launchIdOf(hit.id);
      if (launchId) return launchId;
    }
    return null;
  }

  /** The mission items under a screen position (CSS px), at most `limit`. */
  function missionHitsAt(position, limit = 12) {
    const query = findQuery(layerState._viewer);
    if (!query || !position) return [];
    return query.drillPick(position.x, position.y, { limit });
  }

  /** Whether a mission item is under a screen position (CSS px). */
  function launchMarkerAt(position) {
    return Boolean(launchIdFromPicks(missionHitsAt(position)));
  }

  /**
   * Note the selected launch site. Nothing draws it differently; the
   * selected mission is the layer's own (`_selectedLaunchId`).
   */
  function selectLaunchEntity() {}

  /**
   * Show only the selected mission's items, or every site marker and
   * nothing else when none is selected.
   */
  function isolateMission(launchId) {
    if (!layerState._missionSets) return;
    for (const record of records.values()) {
      record.isolated = launchId
        ? record.launchId === launchId
        : record.id.startsWith('rocket-launch:');
      refresh(record);
    }
    flush();
  }

  /**
   * The projected (estimated) orbit drawn as a mission line for a launch,
   * ECEF; null when its orbit is a live satellite ring or it has none.
   */
  function projectedOrbitPath(launchId) {
    return layerState._replayTracks.get(launchId)?.projectedOrbitPath ?? null;
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
    frameNumber += 1;
    if (!layerState._enabled || !layerState._viewer || !missionsShown()) {
      parts.overlays.hideReplayVehicleOverlay();
      return;
    }
    syncPendingLaunches();
    parts.panel.updateMissionTelemetry();
    const eye = findCamera(layerState._viewer)?.pose().position;
    const occluder = eye ? horizonFrom(eye) : null;
    parts.overlays.updateReplayVehicleOverlay(occluder);
    parts.overlays.refreshSelectedMissionOverlayText();
    for (const record of records.values()) {
      if (!record.isolated) continue;
      // Away from live, a launch shows from its lift-off on.
      const pending = layerState._pendingLaunchIds.has(record.launchId);
      if (!record.position) {
        record.graphicShow = !pending;
        refresh(record);
        continue;
      }
      const live = typeof record.position === 'function';
      const position = live ? record.position() : record.position;
      let horizonVisible =
        !pending && Boolean(position && occluder?.isPointVisible(position));
      if (record.id.startsWith('rocket-launch:')) {
        horizonVisible =
          !pending &&
          parts.overlays.missionAnchorVisible(
            eye,
            position,
            record.launchId,
            layerState._selectedLaunchId,
          );
        // The selection's isolation stays its own; horizon state is kept
        // apart, so a rear-side anchor is judged again as the camera moves.
      }
      record.graphicShow =
        record.set === 'reticles'
          ? horizonVisible &&
            record.launchId === layerState._hoveredRosterLaunchId
          : horizonVisible;
      refresh(record, live && position ? copy(position) : null);
    }
    flush();
  }

  /**
   * Draw a launch's items. With `defer`, they wait for `flushLaunchEntities`,
   * so a whole roster writes each set once.
   */
  function addLaunchEntity(
    launch,
    activeTleText = layerState._activeTleText,
    { defer = false } = {},
  ) {
    const position = fromDegrees(launch.lon, launch.lat);
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
    launch.recoveryStages.forEach((stage) => {
      stage.endpoint = parts.paths.landingEndpoint(
        stage,
        launch,
        orbitPath?.[0] || null,
      );
    });
    if (satelliteTrack) layerState._orbitMatches++;
    const siteMeta = {
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
    };
    const color = markerColor(launch);
    addItem(
      'sites',
      {
        id: `rocket-launch:${launch.id}`,
        pos: position,
        pixelSize: 5,
        color,
        outlineColor: color,
        outlineWidth: 0,
        disableDepthTest: Number.POSITIVE_INFINITY,
        meta: siteMeta,
      },
      { position },
    );
    addItem(
      'reticles',
      {
        id: `rocket-launch:${launch.id}`,
        pos: position,
        image: {
          canvas: parts.overlays.missionHoverReticleImage(),
          key: RETICLE_KEY,
        },
        size: [24, 24],
        anchor: 'center',
        disableDepthTest: Number.POSITIVE_INFINITY,
        meta: siteMeta,
      },
      { position, graphicShow: false },
    );
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
        position: fromDegrees(
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
        addItem('lines', {
          id: `rocket-trajectory:${launch.id}:${index}`,
          positions: parts.paths.surfaceSafePath(segment.positions).map(copy),
          widthPx: 2,
          mode: '3d',
          style: {
            kind: 'solid',
            color: hexColor(
              TRAJECTORY_STAGE_COLORS[index % TRAJECTORY_STAGE_COLORS.length],
              0.8,
            ),
          },
          meta: {
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
          insertionReference = fromDegrees(
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
        const insertionProgress = clamp(
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
      // Camera tracking and the HTML replay overlay must use the exact same
      // replay epoch within a frame; sampling Date.now() independently made
      // the vehicle advance relative to the camera and then snap back on the
      // next frame.
      let replayStateForFrame = null;
      const sampleReplayState = () =>
        parts.replay.replayState(
          launch,
          layerState._animationStarts.get(launch.id) || Date.now(),
          ascentDurationSec,
          REPLAY_ORBIT_DURATION_SEC,
          orbitPeriodSec,
          layerState._replaySpeed,
          parts.replay.replayClockNow(launch.id),
          REPLAY_TILE_SETTLE_DELAY_SEC,
          layerState._replayCameraLaunchId !== launch.id,
        );
      // The replay camera seeds one state in preUpdate, and every consumer
      // through postRender reads that one.
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
        const stageColor =
          TRAJECTORY_STAGE_COLORS[
            (stageIndex + 1) % TRAJECTORY_STAGE_COLORS.length
          ];
        addItem('lines', {
          id: `rocket-reentry-recovery:${launch.id}:${stageIndex}`,
          positions: path.map(copy),
          widthPx: 2,
          mode: '3d',
          style: {
            kind: 'dash',
            color: hexColor(stageColor, 0.82),
            length: 12,
            pattern16: 0xaaaa,
          },
          meta: {
            launchId: launch.id,
            stageId: stage.id,
            phase: 'STAGE_REENTRY_RECOVERY',
            accuracy: stage.endpoint.accuracy,
            source: launch.source,
          },
        });
        if (reentryPath.length > 1) {
          addItem('lines', {
            id: `rocket-reentry:${launch.id}:${stageIndex}`,
            positions: reentryPath.map(copy),
            widthPx: 2.5,
            mode: '3d',
            style: {
              kind: 'dash',
              color: hexColor('#ffd166', 0.9),
              length: 8,
              pattern16: 0xf0f0,
            },
            meta: {
              launchId: launch.id,
              stageId: stage.id,
              phase: 'ATMOSPHERIC_REENTRY',
              altitudeM: STAGE_REENTRY_ALTITUDE_M,
              source: 'Estimated 100 km atmospheric interface',
            },
          });
          const reentryPosition = copy(path[reentryIndex]);
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
        const endpoint = copy(path.at(-1));
        addItem(
          'markers',
          {
            id: `rocket-recovery-end:${launch.id}:${stageIndex}`,
            pos: endpoint,
            pixelSize: 4,
            color: hexColor(stageColor),
            outlineWidth: 0,
            disableDepthTest: Number.POSITIVE_INFINITY,
            meta: {
              launchId: launch.id,
              stageId: stage.id,
              phase: 'RECOVERY_ENDPOINT',
              source: launch.source,
            },
          },
          { position: endpoint },
        );
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
      let livePosition = fromDegrees(
        orbitCurrent.longitude,
        orbitCurrent.latitude,
        orbitCurrent.altitude,
      );
      const liveTime = new Date(layerState.orbitNow());
      const liveTelemetry = {
        speedMps: null,
        // Where the payload draws now, for the mission panel.
        position: () => {
          updateLiveState();
          return livePosition;
        },
      };
      layerState._satelliteTelemetry.set(launch.id, liveTelemetry);
      let liveFrameNumber = -1;
      const fallbackPeriodSec =
        parts.paths.estimatedOrbitPeriodSeconds(orbitPath);
      // Propagated at most once a frame, so the marker and the label
      // reading the same cache never stand at different instants.
      const updateLiveState = () => {
        if (frameNumber !== 0 && frameNumber === liveFrameNumber) return;
        liveFrameNumber = frameNumber;
        const nowMs = layerState.orbitNow();
        liveTime.setTime(nowMs);
        if (satelliteTrack) {
          const propagated =
            satelliteTrack.positionAt?.(liveTime) || satelliteTrack.current;
          if (propagated) {
            fromDegreesInto(
              propagated.longitude,
              propagated.latitude,
              propagated.altitude,
              livePosition,
            );
            liveTelemetry.speedMps = Number.isFinite(propagated.speedMps)
              ? propagated.speedMps
              : null;
          }
        } else {
          // In-place write keeps one position for the mission's lifetime.
          livePosition =
            parts.paths.samplePath(
              orbitPath,
              parts.paths.orbitProgressAtTime(nowMs, fallbackPeriodSec),
              livePosition,
            ) || livePosition;
        }
      };
      updateLiveState();
      addItem(
        'markers',
        {
          id: `rocket-satellite:${launch.id}`,
          pos: copy(livePosition),
          pixelSize: 6,
          color: hexColor(satelliteTrack ? '#7bed9f' : '#ffd166'),
          outlineWidth: 0,
          disableDepthTest: Number.POSITIVE_INFINITY,
          meta: {
            launchId: launch.id,
            noradId: satelliteTrack?.noradId || '',
            phase: satelliteTrack
              ? 'CURRENT_SATELLITE_POSITION'
              : 'ESTIMATED_ORBIT_POSITION',
            source: satelliteTrack
              ? 'Satellites layer'
              : 'Approximate mission orbit',
          },
        },
        {
          position: () => {
            updateLiveState();
            return livePosition;
          },
        },
      );
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
      // A live satellite's ring is drawn in the inertial frame its GMST
      // bake puts it in, so it turns with the sky as the payload does.
      // An estimated, launch-site-relative ring is an ordinary line.
      const ringPath = parts.orbitRendering.addMissionOrbitPrimitive(
        launch,
        orbitPath,
        satelliteTrack,
      );
      if (ringPath) queue('orbits', ringPath.item);
      else {
        addItem('lines', {
          id: `rocket-orbit:${launch.id}`,
          positions: orbitPath.map(copy),
          // The 3 px width gives the periodic dot room to read as round;
          // the pattern masks the intervening dashes down to a thin
          // centre stroke.
          widthPx: 3,
          mode: '3d',
          style: parts.orbitRendering.missionOrbitPatternStyle('#c084fc'),
          meta: {
            launchId: launch.id,
            satelliteName: '',
            noradId: '',
            source: 'Approximate mission orbit',
          },
        });
        layerState._replayTracks.get(launch.id).projectedOrbitPath = orbitPath;
      }
      const orbitLabelBakePosition = copy(ascentPath.at(-1));
      let orbitLabelPosition = orbitLabelBakePosition;
      if (ringPath) {
        ringPath.labelBakePosition = orbitLabelBakePosition;
        ringPath.labelPosition = parts.orbitRendering.drawnRingPoint(
          ringPath,
          orbitLabelBakePosition,
          Date.now(),
        );
        orbitLabelPosition = () => ringPath.labelPosition;
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
      addItem('lines', {
        id: `rocket-transfer:${launch.id}`,
        positions: ascentPath.map(copy),
        widthPx: 1.5,
        // The replay vehicle moves straight between these exact samples:
        // the line runs straight between them too, so the dot stays on it.
        mode: '3d',
        style: {
          kind: 'dash',
          color: hexColor('#7bed9f', 0.8),
          length: 24,
          pattern16: 0xf0f0,
        },
        meta: {
          launchId: launch.id,
          phase: 'APPROXIMATE_TRANSFER',
          source: satelliteTrack
            ? 'Launch site to propagated insertion'
            : 'Launch site to forward projected insertion',
        },
      });
    }
    if (!defer) flush();
  }
  return {
    attach,
    detach,
    missionsShown,
    showMissions,
    clearLaunchEntities,
    launchIdFromPicks,
    missionHitsAt,
    launchMarkerAt,
    selectLaunchEntity,
    isolateMission,
    projectedOrbitPath,
    updateMissionFrame,
    addLaunchEntity,
    flushLaunchEntities: flush,
    get setIds() {
      return setIds;
    },
  };
}
