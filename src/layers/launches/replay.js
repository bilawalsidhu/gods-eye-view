import * as Cesium from 'cesium';
import {
  REPLAY_ASCENT_FALLBACK_SEC,
  REPLAY_ASCENT_MIN_SEC,
  REPLAY_ASCENT_MAX_SEC,
  REPLAY_SPEED_MIN,
  REPLAY_SPEED_MAX,
  REPLAY_SPEED_STEP,
  REPLAY_TILE_SETTLE_DELAY_SEC,
  REPLAY_COUNTDOWN_DURATION_SEC,
  REPLAY_ORBIT_PULLBACK_FRACTION,
  REPLAY_ORBIT_DURATION_SEC,
  REPLAY_INITIAL_RANGE_M,
} from './policy.js';

export function createReplay({ state: layerState, services, parts, source }) {
  /**
   * Rotate an upright screen-space rocket so its nose follows a projected path.
   * @param {{x: number, y: number}} from Current screen point.
   * @param {{x: number, y: number}} to Forward screen point.
   * @returns {number} Clockwise CSS rotation in radians.
   */

  function replayVehicleScreenRotation(from, to) {
    const dx = Number(to?.x) - Number(from?.x);
    const dy = Number(to?.y) - Number(from?.y);
    if (
      !Number.isFinite(dx) ||
      !Number.isFinite(dy) ||
      Math.hypot(dx, dy) < 0.01
    )
      return 0;
    return Math.atan2(dx, -dy);
  }

  /**
   * Reduce small screen-space reprojection jitter without allowing the marker
   * to lag behind a camera jump or a phase transition.
   * @param {{x:number,y:number}|null} previous Previous rendered position.
   * @param {{x:number,y:number}} next Current path projection.
   * @param {number} [alpha] Interpolation amount.
   * @param {number} [snapDistance] Maximum distance to smooth.
   * @returns {{x:number,y:number}}
   */

  function smoothReplayWindowPosition(
    previous,
    next,
    alpha = 0.55,
    snapDistance = 24,
  ) {
    if (!previous || !next) return next;
    const distance = Math.hypot(next.x - previous.x, next.y - previous.y);
    if (!Number.isFinite(distance) || distance > snapDistance) return next;
    const amount = Cesium.Math.clamp(Number(alpha) || 0, 0, 1);
    return {
      x: Cesium.Math.lerp(previous.x, next.x, amount),
      y: Cesium.Math.lerp(previous.y, next.y, amount),
    };
  }

  /**
   * Derive a compressed but mission-specific ascent replay duration.
   * Launch Library timelines are authoritative when they expose insertion,
   * SECO, or separation timing. Sparse records fall back to the reconstructed
   * path length and a conservative ascent velocity estimate.
   * @param {object} launch Normalized launch record.
   * @param {Cesium.Cartesian3[]} ascentPath Reconstructed or supplied ascent.
   * @returns {number} Replay duration in seconds.
   */

  function replayAscentDurationSeconds(launch, ascentPath = []) {
    const disclosedSeconds = parts.paths.orbitInsertionOffsetSeconds(launch);
    let realAscentSeconds = disclosedSeconds > 0 ? disclosedSeconds : null;
    if (!realAscentSeconds && ascentPath.length > 1) {
      const pathLength = ascentPath
        .slice(1)
        .reduce(
          (total, point, index) =>
            total + Cesium.Cartesian3.distance(ascentPath[index], point),
          0,
        );
      realAscentSeconds = Math.max(180, pathLength / 9000);
    }
    if (!realAscentSeconds) realAscentSeconds = REPLAY_ASCENT_FALLBACK_SEC * 50;
    return Cesium.Math.clamp(
      REPLAY_ASCENT_FALLBACK_SEC * (realAscentSeconds / 600),
      REPLAY_ASCENT_MIN_SEC,
      REPLAY_ASCENT_MAX_SEC,
    );
  }

  /**
   * Clamp and snap a replay speed multiplier to the supported slider range.
   * @param {number|string} value Requested playback multiplier.
   * @returns {number} Supported multiplier between 0.25x and 4x.
   */

  function normalizeReplaySpeed(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 1;
    const clamped = Cesium.Math.clamp(
      numeric,
      REPLAY_SPEED_MIN,
      REPLAY_SPEED_MAX,
    );
    return Math.round(clamped / REPLAY_SPEED_STEP) * REPLAY_SPEED_STEP;
  }

  /**
   * Preserve replay elapsed time when resuming after a pause.
   * @param {number} startedAt Original replay start epoch in milliseconds.
   * @param {number} pausedAt Pause epoch in milliseconds.
   * @param {number} resumedAt Resume epoch in milliseconds.
   * @returns {number} Shifted start epoch.
   */

  function replayStartAfterPause(startedAt, pausedAt, resumedAt) {
    if (![startedAt, pausedAt, resumedAt].every(Number.isFinite))
      return startedAt;
    return startedAt + Math.max(0, resumedAt - pausedAt);
  }

  function replayState(
    launch,
    startedAt,
    ascentDurationSec,
    orbitDurationSec,
    orbitPeriodSec,
    speed = 1,
    nowMs = Date.now(),
    preCountdownDurationSec = 0,
    loop = true,
  ) {
    const animationDurationSec = ascentDurationSec + orbitDurationSec;
    const realSecondsSinceStart = (nowMs - startedAt) / 1000;
    const preCountdownDuration = Math.max(
      0,
      Number(preCountdownDurationSec) || 0,
    );
    const preCountdownActive =
      preCountdownDuration > 0 && realSecondsSinceStart < -preCountdownDuration;
    const countdownActive = realSecondsSinceStart < 0 && !preCountdownActive;
    const countdownSeconds = countdownActive
      ? Math.ceil(-realSecondsSinceStart)
      : 0;
    const elapsedSinceStart = Math.max(
      0,
      realSecondsSinceStart * normalizeReplaySpeed(speed),
    );
    const elapsed = loop
      ? elapsedSinceStart % animationDurationSec
      : Math.min(elapsedSinceStart, Math.max(0, animationDurationSec - 1e-6));
    const insertionOffsetSec = parts.paths.orbitInsertionOffsetSeconds(launch);
    const ascending = elapsed < ascentDurationSec;
    const phaseProgress = ascending
      ? elapsed / ascentDurationSec
      : (elapsed - ascentDurationSec) / orbitDurationSec;
    const missionOffsetSec =
      insertionOffsetSec === null
        ? null
        : ascending
          ? phaseProgress * insertionOffsetSec
          : insertionOffsetSec + phaseProgress * orbitPeriodSec;
    const launchEpoch = Date.parse(launch.launchTime);
    const eventTime =
      Number.isFinite(launchEpoch) && missionOffsetSec !== null
        ? new Date(launchEpoch + missionOffsetSec * 1000)
        : null;
    return {
      ascending,
      phaseProgress,
      eventTime,
      elapsedSinceStart,
      countdownActive,
      preCountdownActive,
      countdownSeconds,
    };
  }

  function syncReplayButton() {
    const button = layerState._missionPanel?.querySelector(
      '[data-mission-replay]',
    );
    const transport = layerState._missionPanel?.querySelector(
      '[data-mission-replay-transport]',
    );
    const speedControl = layerState._missionPanel?.querySelector(
      '.mission-replay-speed-control',
    );
    if (!button) return;
    const active = Boolean(
      layerState._replayCameraLaunchId &&
      layerState._replayCameraLaunchId === layerState._selectedLaunchId,
    );
    const replayAvailable = Boolean(
      layerState._selectedLaunchId &&
      layerState._replayTracks.has(layerState._selectedLaunchId),
    );
    if (speedControl) speedControl.hidden = !replayAvailable;
    button.hidden = active || !replayAvailable;
    button.disabled = !replayAvailable;
    button.textContent = 'REPLAY ASCENT';
    button.classList.remove('active');
    button.setAttribute('aria-pressed', String(active));
    button.title = 'Replay the estimated ascent with a following camera';
    if (transport) {
      transport.hidden = !active;
      transport.classList.toggle(
        'is-paused',
        active && layerState._replayPaused,
      );
      const toggleButton = transport.querySelector(
        '[data-mission-replay-toggle]',
      );
      if (toggleButton) {
        toggleButton.disabled = !active;
        toggleButton.textContent = layerState._replayPaused ? '▶' : 'Ⅱ';
        toggleButton.setAttribute(
          'aria-label',
          layerState._replayPaused ? 'Resume replay' : 'Pause replay',
        );
        toggleButton.title = layerState._replayPaused
          ? 'Resume replay'
          : 'Pause replay';
      }
    }
  }

  function syncReplayCountdownButton(state) {
    const transport = layerState._missionPanel?.querySelector(
      '[data-mission-replay-transport]',
    );
    if (!transport || !layerState._replayCameraLaunchId) return;
    const phase = state.countdownActive
      ? `T minus ${state.countdownSeconds}`
      : state.preCountdownActive
        ? 'Preparing launch site'
        : state.elapsedSinceStart < 1
          ? 'Liftoff'
          : state.ascending
            ? 'Ascent replay'
            : 'Orbit replay';
    transport.setAttribute(
      'aria-label',
      `${phase}${layerState._replayPaused ? ', paused' : ''}`,
    );
  }

  function syncReplaySpeedControl() {
    const input = layerState._missionPanel?.querySelector(
      '[data-mission-replay-speed]',
    );
    const output = layerState._missionPanel?.querySelector(
      '[data-mission-replay-speed-output]',
    );
    if (input) {
      input.value = String(layerState._replaySpeed);
      const progress =
        ((layerState._replaySpeed - REPLAY_SPEED_MIN) /
          (REPLAY_SPEED_MAX - REPLAY_SPEED_MIN)) *
        100;
      input.style.setProperty('--replay-speed-progress', `${progress}%`);
    }
    if (output)
      output.textContent = `${layerState._replaySpeed.toFixed(layerState._replaySpeed % 1 ? 2 : 0)}×`;
  }

  function setReplaySpeed(value) {
    const nextSpeed = normalizeReplaySpeed(value);
    const previousSpeed = layerState._replaySpeed;
    if (nextSpeed === previousSpeed) {
      syncReplaySpeedControl();
      return;
    }
    const now =
      layerState._replayPaused && Number.isFinite(layerState._replayPausedAtMs)
        ? layerState._replayPausedAtMs
        : Date.now();
    for (const [launchId, startedAt] of layerState._animationStarts) {
      if (!Number.isFinite(startedAt)) continue;
      const elapsedMissionMs = (now - startedAt) * previousSpeed;
      layerState._animationStarts.set(
        launchId,
        now - elapsedMissionMs / nextSpeed,
      );
    }
    layerState._replaySpeed = nextSpeed;
    syncReplaySpeedControl();
  }

  function replayClockNow(launchId) {
    if (
      layerState._replayPaused &&
      layerState._replayCameraLaunchId === launchId &&
      Number.isFinite(layerState._replayPausedAtMs)
    ) {
      return layerState._replayPausedAtMs;
    }
    return Date.now();
  }

  function pauseMissionReplay() {
    if (!layerState._replayCameraLaunchId || layerState._replayPaused)
      return false;
    layerState._replayPausedAtMs = Date.now();
    layerState._replayPaused = true;
    syncReplayButton();
    return true;
  }

  function resumeMissionReplay() {
    if (
      !layerState._replayCameraLaunchId ||
      !layerState._replayPaused ||
      !Number.isFinite(layerState._replayPausedAtMs)
    ) {
      return false;
    }
    const resumedAt = Date.now();
    const startedAt = layerState._animationStarts.get(
      layerState._replayCameraLaunchId,
    );
    if (Number.isFinite(startedAt)) {
      layerState._animationStarts.set(
        layerState._replayCameraLaunchId,
        replayStartAfterPause(
          startedAt,
          layerState._replayPausedAtMs,
          resumedAt,
        ),
      );
    }
    layerState._replayPaused = false;
    layerState._replayPausedAtMs = null;
    syncReplayButton();
    return true;
  }

  function stopMissionReplay() {
    const stoppedLaunchId = layerState._replayCameraLaunchId;
    layerState._replayCameraToken++;
    if (layerState._replayCameraRemover) layerState._replayCameraRemover();
    layerState._replayCameraRemover = null;
    layerState._viewer?.camera?.cancelFlight();
    if (layerState._viewer?.camera)
      layerState._viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    layerState._replayCameraLaunchId = null;
    layerState._replayPaused = false;
    layerState._replayPausedAtMs = null;
    if (stoppedLaunchId)
      layerState._animationStarts.set(stoppedLaunchId, Date.now());
    syncReplayButton();
    parts.overlays.syncMissionOverlayEntries();
  }

  function startMissionReplay(launchId) {
    const launch = layerState._launches.find((item) => item.id === launchId);
    const track = layerState._replayTracks.get(launchId);
    if (!layerState._viewer || !launch || !track) return false;
    if (layerState._replayCameraLaunchId === launchId) {
      stopMissionReplay();
      return false;
    }

    parts.selection.stopMissionZoomAnchor();
    stopMissionReplay();
    layerState._replayCameraLaunchId = launchId;
    layerState._replayPaused = false;
    layerState._replayPausedAtMs = null;
    const token = ++layerState._replayCameraToken;
    const ascentDurationSec = track.ascentDurationSec;
    // Start broadside to the ascent/orbit direction so the launch profile is
    // visible. The chase heading then eases toward the path tangent after the
    // camera is established.
    const initialHeading = parts.camera.replayInitialCameraHeading(
      track.ascentPath,
    );
    track.lastCameraHeading = initialHeading;
    syncReplayButton();
    parts.overlays.syncMissionOverlayEntries();
    parts.policyHelpers.releaseAircraftTracking(layerState._dataManager);
    layerState._viewer.trackedEntity = undefined;
    layerState._viewer.camera.cancelFlight();
    layerState._animationStarts.set(
      launchId,
      Date.now() +
        (REPLAY_TILE_SETTLE_DELAY_SEC + REPLAY_COUNTDOWN_DURATION_SEC) * 1000,
    );
    let cameraReady = false;
    let lastCameraUpdateMs = null;

    // Move the chase camera before scene traversal. Mutating it in preRender
    // makes Cesium discover a new view after 3D-tile refinement, which can cause
    // a self-sustaining refinement loop and visible stutter during slow replay.
    layerState._replayCameraRemover =
      layerState._viewer.scene.preUpdate.addEventListener(() => {
        if (
          token !== layerState._replayCameraToken ||
          layerState._replayCameraLaunchId !== launchId
        )
          return;
        const state = track.beginReplayFrame();
        syncReplayCountdownButton(state);
        if (!cameraReady) return;
        const path = state.ascending
          ? track.ascentPath
          : track.animatedOrbitPath;
        const position = parts.paths.samplePath(path, state.phaseProgress);
        if (!position) return;
        const pathHeading = parts.camera.cameraHeadingForPath(
          path,
          state.phaseProgress,
          track.lastCameraHeading,
        );
        const orbitBlend = !state.ascending
          ? Cesium.Math.clamp(
              (Number(state.phaseProgress) || 0) /
                REPLAY_ORBIT_PULLBACK_FRACTION,
              0,
              1,
            )
          : 0;
        const desiredHeading = parts.camera.replayChaseCameraHeading(
          pathHeading,
          orbitBlend,
        );
        if (state.ascending) track.orbitCameraWorldFrame = false;
        const nowMs = performance.now();
        const frameDurationMs = Number.isFinite(lastCameraUpdateMs)
          ? Cesium.Math.clamp(nowMs - lastCameraUpdateMs, 4, 50)
          : 1000 / 60;
        lastCameraUpdateMs = nowMs;
        track.lastCameraHeading = parts.camera.smoothReplayCameraHeading(
          track.lastCameraHeading,
          desiredHeading,
          (Cesium.Math.toRadians(2) * frameDurationMs) / (1000 / 60),
        );
        const cartographic =
          Cesium.Ellipsoid.WGS84.cartesianToCartographic(position);
        const altitude = Math.max(0, cartographic?.height || 0);
        const cameraView = parts.camera.replayCameraView(state, altitude);
        const defaultOrbitTarget = !state.ascending
          ? parts.camera.replayOrbitGlobeAnchor(position, orbitBlend)
          : position;
        const cameraTarget = !state.ascending
          ? parts.camera.replayOrbitCameraTarget(
              defaultOrbitTarget,
              track.orbitFrameSphere?.center,
              orbitBlend,
            )
          : defaultOrbitTarget;
        const cameraRange = !state.ascending
          ? parts.camera.replayOrbitGlobeRange(
              cameraView.range,
              altitude,
              orbitBlend,
              track.orbitFrameSphere?.radius,
            )
          : cameraView.range;
        if (state.ascending) {
          layerState._viewer.camera.lookAt(
            cameraTarget,
            new Cesium.HeadingPitchRange(
              track.lastCameraHeading,
              cameraView.pitch,
              cameraRange,
            ),
          );
        } else {
          const tangentStep = Math.max(
            0.002,
            0.8 / Math.max(2, path.length - 1),
          );
          const tangentProgress = Math.min(
            1,
            state.phaseProgress + tangentStep,
          );
          const tangentPosition = parts.paths.samplePath(
            path,
            tangentProgress > state.phaseProgress
              ? tangentProgress
              : Math.max(0, state.phaseProgress - tangentStep),
          );
          const orbitPose = parts.camera.replayOrbitCameraPose(
            position,
            tangentPosition,
            cameraTarget,
            cameraRange,
            cameraView.pitch,
          );
          if (orbitPose) {
            if (!track.orbitCameraWorldFrame) {
              layerState._viewer.camera.lookAtTransform(
                Cesium.Matrix4.IDENTITY,
              );
              track.orbitCameraWorldFrame = true;
            }
            layerState._viewer.camera.setView({
              destination: orbitPose.destination,
              orientation: {
                direction: orbitPose.direction,
                up: orbitPose.up,
              },
            });
          }
        }
        if (
          state.elapsedSinceStart >=
          ascentDurationSec + REPLAY_ORBIT_DURATION_SEC
        ) {
          stopMissionReplay();
        }
      });

    layerState._viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(track.ascentPath[0], 0),
      {
        offset: new Cesium.HeadingPitchRange(
          initialHeading,
          Cesium.Math.toRadians(-20),
          REPLAY_INITIAL_RANGE_M,
        ),
        duration: 1.4,
        easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
        complete: () => {
          cameraReady = true;
        },
        cancel: () => {
          if (
            token === layerState._replayCameraToken &&
            layerState._replayCameraLaunchId === launchId
          )
            stopMissionReplay();
        },
      },
    );
    return true;
  }
  return {
    replayVehicleScreenRotation,
    smoothReplayWindowPosition,
    replayAscentDurationSeconds,
    normalizeReplaySpeed,
    replayStartAfterPause,
    replayState,
    syncReplayButton,
    syncReplayCountdownButton,
    syncReplaySpeedControl,
    setReplaySpeed,
    replayClockNow,
    pauseMissionReplay,
    resumeMissionReplay,
    stopMissionReplay,
    startMissionReplay,
  };
}
