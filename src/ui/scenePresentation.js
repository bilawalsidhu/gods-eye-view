/** Scene panel elements and text-only project presentation. */
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
  snow: msg('SNOW'),
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
    shots: 'scene-shot-list',
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

export function renderSceneOptions(element, { scenes, selectedSceneId }) {
  if (!element) return;
  element.textContent = '';
  for (const scene of scenes) {
    const option = document.createElement('option');
    option.value = scene.id;
    option.textContent = scene.title;
    element.appendChild(option);
  }
  if (selectedSceneId) element.value = selectedSceneId;
}

export function renderSceneShots(
  element,
  state,
  { listen, select, rename, load, remove },
) {
  if (!element) return;
  const scene = state.scenes.find((item) => item.id === state.selectedSceneId);
  element.textContent = '';
  if (!scene || scene.shots.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'scene-shot-empty';
    empty.textContent = t(
      'No shots yet. Use CAPTURE SHOT to save current look.',
    );
    element.appendChild(empty);
    return;
  }
  for (const shot of scene.shots) {
    // Built-in titles arrive localized as displayTitle; the stored title
    // stays English, so a rename happens only when the shown text changes.
    const shownTitle = shot.displayTitle || shot.title;
    const row = document.createElement('div');
    row.className = 'scene-shot-row';
    row.dataset.sceneShotId = shot.id;
    row.classList.toggle('active', shot.id === state.selectedShotId);
    const top = document.createElement('div');
    top.className = 'scene-shot-top';
    const label = document.createElement('div');
    label.className = 'scene-shot-label';
    label.textContent = shownTitle;
    label.title = t('Double-click to rename');
    listen(label, 'click', () => select(shot.id));
    listen(label, 'dblclick', () => {
      if (label.children.length) return;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'scene-shot-rename';
      input.setAttribute('aria-label', t('Shot name'));
      input.value = shownTitle;
      let finished = false;
      const finish = (save) => {
        if (finished) return;
        finished = true;
        const title = input.value.trim();
        label.textContent = shownTitle;
        if (save && title && title !== shownTitle)
          rename(scene.id, shot.id, title);
      };
      listen(input, 'keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter' || event.key === 'Escape') {
          event.preventDefault();
          finish(event.key === 'Enter');
        }
      });
      listen(input, 'blur', () => finish(true));
      label.textContent = '';
      label.appendChild(input);
      input.focus();
      input.select();
    });
    const actions = document.createElement('div');
    actions.className = 'scene-shot-actions';
    const loadButton = document.createElement('button');
    loadButton.className = 'scene-shot-btn';
    loadButton.textContent = t('LOAD');
    listen(loadButton, 'click', () => load(scene.id, shot.id));
    const deleteButton = document.createElement('button');
    deleteButton.className = 'scene-shot-btn scene-shot-danger';
    deleteButton.textContent = t('DEL');
    listen(deleteButton, 'click', () => remove(scene.id, shot.id));
    actions.appendChild(loadButton);
    actions.appendChild(deleteButton);
    top.appendChild(label);
    top.appendChild(actions);
    const meta = document.createElement('div');
    meta.className = 'scene-shot-meta';
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
    meta.textContent = `${styleLabel} · ${modeLabel} · ${timing}`;
    row.appendChild(top);
    row.appendChild(meta);
    element.appendChild(row);
  }
}

export function presentSceneSelection(element, selectedShotId) {
  for (const row of element?.children || []) {
    row.classList.toggle('active', row.dataset.sceneShotId === selectedShotId);
  }
}

export function presentSceneButtons(elements, running, hasRun) {
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
    if (elements[name]) elements[name].disabled = running;
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
