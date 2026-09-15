/** Connect the portable Director runner to the existing scene presentation. */
export function createScenePlaybackAdapter(director, defaultShotDurationSec) {
  let timing;
  let travel;
  return {
    async releaseScene(scene, token) {
      const released = await director._releaseSceneLayers(scene, token);
      if (!token || released) director._loadedSceneId = null;
      return released;
    },
    selectShot({ scene, shot, index, total }) {
      director._selectedSceneId = scene.id;
      director._selectedShotId = shot.id;
      director._renderSceneSelect();
      director._renderShotList();
      director._updateStatus(
        `Running ${index + 1}/${total}: ${scene.title} / ${shot.title}`,
      );
      director._logEvent('shot_start', {
        sceneId: scene.id,
        shotId: shot.id,
        title: shot.title,
        index,
      });
    },
    applyVisual({ shot, token }) {
      return director.styleManager.applyVisualState(
        director._visualStateForShot(shot),
        { isCurrent: () => !token.cancelled && !token.signal?.aborted },
      );
    },
    applyLayers({ scene, shot, token }) {
      return director._applyLayerStates(
        director._layerStatesForShot(scene, shot),
        token,
      );
    },
    travel({ scene, shot, token }) {
      director._loadedSceneId = scene.id;
      const duration = shot.durationSec || defaultShotDurationSec;
      timing = director._startSceneClockTicker(scene, shot, token);
      travel = director._beginShotTravel(scene, shot, duration);
      const flight = director._flyCamera(shot.camera, duration, token);
      director._publishShotTravel(scene, shot, travel);
      return flight;
    },
    settle({ scene, shot, token }) {
      director._settleShotLayerStates(scene, shot, token, travel);
    },
    hold({ scene, shot, token }) {
      return director._holdShot(scene, shot, token);
    },
    completeShot({ scene, shot, index }) {
      clearInterval(director._sceneClockTimer);
      director._sceneClockTimer = null;
      director._publishSceneClock(scene, shot, timing.endElapsedSec, {
        running: true,
      });
      director._logEvent('shot_end', {
        sceneId: scene.id,
        shotId: shot.id,
        index,
      });
    },
    complete() {
      director._setProgress(1);
      director._updateStatus('Scene run complete');
      director._logEvent('scene_run_complete', {});
    },
  };
}
