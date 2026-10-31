/** Scene panel elements and text-only project presentation; the shot list
 * and scene options are the SceneShotList and SceneOptions views. */
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

export function sceneElements(root = document) {
  const ids = {
    panel: 'scene-panel',
    select: 'scene-select',
    new: 'scene-new-btn',
    delete: 'scene-delete-btn',
    capture: 'scene-capture-btn',
    update: 'scene-update-shot-btn',
    start: 'scene-start-btn',
    stop: 'scene-stop-btn',
    next: 'scene-next-btn',
    export: 'scene-export-btn',
    import: 'scene-import-btn',
    file: 'scene-import-file',
    download: 'scene-download-btn',
    status: 'scene-status',
    progress: 'scene-progress-fill',
    runtime: 'scene-runtime',
  };
  return Object.fromEntries(
    Object.entries(ids).map(([name, id]) => [name, root.getElementById(id)]),
  );
}

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
export function presentSceneButtons(
  elements,
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
  ]) {
    if (elements[name]) elements[name].disabled = running || !!idleOff[name];
  }
  if (elements.stop) elements.stop.disabled = !running;
  if (elements.download) elements.download.disabled = !hasRun;
  elements.panel?.classList.toggle('running', running);
}

export function presentSceneProgress(element, progress) {
  if (!element) return;
  const percentage = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  element.style.width = `${percentage}%`;
  element.textContent = `${percentage}%`;
}

export function presentSceneRuntime(element, text) {
  if (!element) return;
  element.textContent = text;
  element.classList.toggle('active', !!text);
}
