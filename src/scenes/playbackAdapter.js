/** Connect the portable Director runner to the existing scene presentation. */
import { t } from '../i18n/index.js';
import { displaySceneTitle, displayShotTitle } from './recipes.js';

/**
 * A run resumed partway into its first shot carries the seek state of that
 * moment (`resume`). Inside the shot's hold, its layers take that moment's
 * state as a seek gives it and then play on from it, and the hold waits for a
 * clip started again or else only its rest; inside
 * its flight, the camera goes on from where it is along the rest of the path.
 */
const inHold = (resume) => resume?.holdElapsedSec > 0;

export function createScenePlaybackAdapter(
  director,
  defaultShotDurationSec,
  { releaseAuthority } = {},
) {
  let timing;
  let travel;
  return {
    async releaseScene(scene, token) {
      const released = await director._releaseSceneLayers(
        scene,
        token,
        releaseAuthority,
      );
      if (!token || released) director._loadedSceneId = null;
      return released;
    },
    selectShot({ scene, shot, index, total }) {
      director._selectedSceneId = scene.id;
      director._selectedShotId = shot.id;
      director._renderSceneSelect();
      director._renderShotList();
      director._updateStatus(() =>
        t('Running {index}/{total}: {scene} / {shot}', {
          index: index + 1,
          total,
          scene: displaySceneTitle(scene),
          shot: displayShotTitle(shot.title, shot, scene),
        }),
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
    async applyLayers({ scene, shot, token, resume }) {
      director._setSceneMediaPlayback(scene, shot, token);
      const result = await director._applyLayerStates(
        director._layerStatesForShot(
          scene,
          shot,
          inHold(resume) ? { cameraSettled: true, sceneSeek: resume } : {},
        ),
        token,
      );
      if (
        !token.cancelled &&
        !result.refused.length &&
        !(await director._applyDataPacks(scene, shot, token))
      )
        throw new Error('Data packs unavailable');
      return result;
    },
    travel({ scene, shot, token, resume }) {
      director._loadedSceneId = scene.id;
      const duration = shot.durationSec || defaultShotDurationSec;
      const cameraProgress = resume?.cameraProgress ?? 0;
      timing = director._startSceneClockTicker(
        scene,
        shot,
        token,
        resume?.shotElapsedSec ?? 0,
      );
      if (cameraProgress >= 1) {
        travel = null;
        director._setCameraView(resume.camera);
        return;
      }
      travel = director._beginShotTravel(
        scene,
        shot,
        duration * (1 - cameraProgress),
      );
      const flight = director._flyShotCamera(
        scene,
        shot,
        duration,
        token,
        cameraProgress,
      );
      director._publishShotTravel(scene, shot, travel);
      return flight;
    },
    settle({ scene, shot, token }) {
      // Resumed inside the hold too: the layers placed at that moment go back
      // to running playback from it. Their reveals go on, and scene media
      // starts its clip again, since a clip cannot be joined partway.
      director._settleShotLayerStates(scene, shot, token, travel);
    },
    hold({ scene, shot, token, resume }) {
      return director._holdShot(scene, shot, token, resume);
    },
    completeShot({ scene, shot, index }) {
      director._clock.stopSceneTimer();
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
      director._updateStatus(() => t('Scene run complete'));
      director._logEvent('scene_run_complete', {});
    },
  };
}
