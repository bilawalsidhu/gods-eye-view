/** The Scene panel's text and button presentation; the panel views render
 * it. */
import { formatNumber, msg, t } from '../i18n/index.js';

// Labels for what a shot stores; anything else shows as stored. Style names
// match STYLE_STATUS_LABELS in visualPresets.js, which this package cannot
// import (it pulls in the shaders).
const STYLE_LABELS = Object.freeze({
  normal: msg('NORMAL'),
  retro: msg('CRT'),
  surveillance: msg('NVG'),
  thermal: msg('FLIR'),
  anime: msg('ANIME'),
  noir: msg('NOIR'),
});

const DETECTION_MODE_LABELS = Object.freeze({
  OFF: msg('OFF'),
  SPARSE: msg('SPARSE'),
  BALANCED: msg('BALANCED'),
  DENSE: msg('DENSE'),
});

/**
 * A shot's summary line: its style, detection mode and timing.
 * @param {object} shot
 * @returns {string}
 */
export function describeShot(shot) {
  const mode = shot.visual?.detection?.mode || 'OFF';
  const style = shot.visual?.style || 'normal';
  const styleLabel = STYLE_LABELS[style]
    ? t(STYLE_LABELS[style])
    : style.toUpperCase();
  const modeLabel = DETECTION_MODE_LABELS[mode]
    ? t(DETECTION_MODE_LABELS[mode])
    : mode;
  const seconds = (value) =>
    formatNumber(value, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  // English keeps its compact "4.0s + 0.9s"; other languages space the unit.
  const timing = t('{duration}s + {hold}s', {
    duration: seconds(shot.durationSec),
    hold: seconds(shot.holdSec),
  });
  return `${styleLabel} · ${modeLabel} · ${timing}`;
}

/**
 * While a scene plays, the authoring and file actions here are off and STOP
 * is on. Otherwise a button is off when it would do nothing: DELETE, SAVE TO
 * STORIES, THUMBNAIL and the tag chips without a scene, UPDATE SHOT
 * without a selected shot, SAVE TO STORIES when the scene has no shot, PLAY
 * and NEXT without a scene or when no scene in the project has a shot (both
 * continue into the following scenes). CAPTURE SHOT without a scene starts
 * one. EDIT DETAILS (which needs a shot) and SHARE SCENE keep their own
 * checks during playback.
 */
export function sceneButtonsDisabled(
  running,
  hasRun,
  {
    hasScene = true,
    sceneShots = 1,
    playableShots = 1,
    hasSelectedShot = true,
  } = {},
) {
  const idleOff = {
    delete: !hasScene,
    stories: !hasScene || sceneShots === 0,
    thumb: !hasScene,
    tags: !hasScene,
    update: !hasSelectedShot,
    start: !hasScene || playableShots === 0,
    next: !hasScene || playableShots === 0,
  };
  const disabled = {};
  for (const name of [
    'start',
    'next',
    'new',
    'delete',
    'capture',
    'update',
    'thumb',
    'tags',
    'stories',
    'export',
    'import',
  ])
    disabled[name] = running || !!idleOff[name];
  disabled.stop = !running;
  disabled.download = !hasRun;
  disabled.details = !hasScene || !hasSelectedShot;
  disabled.share = !hasScene;
  return disabled;
}

/** @returns {number} Whole percent, 0–100. */
export function scenePercent(progress) {
  return Math.round(Math.max(0, Math.min(1, progress)) * 100);
}
