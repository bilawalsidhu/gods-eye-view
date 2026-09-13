/** Scene panel elements and text-only project presentation. */
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
    empty.textContent = 'No shots yet. Use CAPTURE SHOT to save current look.';
    element.appendChild(empty);
    return;
  }
  for (const shot of scene.shots) {
    const row = document.createElement('div');
    row.className = 'scene-shot-row';
    row.dataset.sceneShotId = shot.id;
    row.classList.toggle('active', shot.id === state.selectedShotId);
    const top = document.createElement('div');
    top.className = 'scene-shot-top';
    const label = document.createElement('div');
    label.className = 'scene-shot-label';
    label.textContent = shot.title;
    listen(label, 'click', () => select(shot.id));
    listen(label, 'dblclick', () => {
      const title = window.prompt('Shot title', shot.title);
      if (title) rename(scene.id, shot.id, title);
    });
    const actions = document.createElement('div');
    actions.className = 'scene-shot-actions';
    const loadButton = document.createElement('button');
    loadButton.className = 'scene-shot-btn';
    loadButton.textContent = 'LOAD';
    listen(loadButton, 'click', () => load(scene.id, shot.id));
    const deleteButton = document.createElement('button');
    deleteButton.className = 'scene-shot-btn scene-shot-danger';
    deleteButton.textContent = 'DEL';
    listen(deleteButton, 'click', () => remove(scene.id, shot.id));
    actions.appendChild(loadButton);
    actions.appendChild(deleteButton);
    top.appendChild(label);
    top.appendChild(actions);
    const meta = document.createElement('div');
    meta.className = 'scene-shot-meta';
    const mode = shot.visual?.detection?.mode || 'OFF';
    const style = shot.visual?.style || 'normal';
    meta.textContent = `${style.toUpperCase()} · ${mode} · ${shot.durationSec.toFixed(1)}s + ${shot.holdSec.toFixed(1)}s`;
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
