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
 * is on. Otherwise a button is off when it would do nothing: DELETE and
 * CAPTURE SHOT without a scene, UPDATE SHOT without a selected shot, PLAY and
 * NEXT when no scene in the project has a shot (both continue into the
 * following scenes).
 */
export function sceneButtonsDisabled(
  running,
  hasRun,
  { hasScene = true, playableShots = 1, hasSelectedShot = true } = {},
) {
  const idleOff = {
    delete: !hasScene,
    capture: !hasScene,
    update: !hasSelectedShot,
    start: playableShots === 0,
    next: playableShots === 0,
  };
  const disabled = {};
  for (const name of [
    'start',
    'next',
    'select',
    'new',
    'delete',
    'capture',
    'update',
    'export',
    'import',
  ])
    disabled[name] = running || !!idleOff[name];
  disabled.stop = !running;
  disabled.download = !hasRun;
  return disabled;
}

/** @returns {number} Whole percent, 0–100. */
export function scenePercent(progress) {
  return Math.round(Math.max(0, Math.min(1, progress)) * 100);
}
