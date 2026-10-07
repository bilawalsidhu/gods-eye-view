/**
 * DISPLAY ▸ Import: put your own GeoJSON, KML, KMZ or GPX files on the globe.
 *
 * Files come in through the Import button or by dropping them onto the globe.
 * Each one becomes its own Cesium data source, clamped to the ground, with a
 * row in the panel to show or hide it, fly to it, or remove it. Files are read
 * in the browser and never uploaded; see `src/data/geoFileImport.js` for what
 * is accepted and what is stripped from KML before Cesium reads it.
 *
 * Imported files last for the page session: a reload starts empty.
 *
 * Imports run one batch at a time (a second pick or drop waits for the
 * first), so the file cap is checked against what is really on the globe.
 * Fly-to goes through the app's navigation policy (`navigation`, the
 * application shell): the button is an immediate navigation, and the fly
 * after an import is a deferred one, stamped when the import starts and
 * re-asserted just before flying, so a camera move, Cockpit or any newer
 * navigation in between wins over a slow file.
 * `destroy()` removes every imported data source, revokes every blob URL and
 * gives back every listener and the `window.__gevGeoImport` handle.
 */
import {
  GEO_FILE_ACCEPT,
  GeoImportError,
  MAX_IMPORTED_FILES,
  loadGeoFile,
} from '../data/geoFileImport.js';
import { flyToDataSource } from './flyToDataSource.js';

// One color per file, in import order, from the whiteboard palette.
const COLORS = ['#39d0ff', '#ffb547', '#5dff9f', '#ff6b6b', '#8be9ff'];

/**
 * Wire the Import control.
 * @param {{viewer: object, load?: Function, document?: Document}} deps
 *   `load(file, {viewer, color})` defaults to `loadGeoFile`; tests pass a double.
 * @returns {{destroy: Function, importFiles: Function, list: Function,
 *   setVisible: Function, flyTo: Function, remove: Function,
 *   diagnostics: Function}|null}
 */
export function initGeoFileImport({
  viewer,
  load = loadGeoFile,
  document: doc = globalThis.document,
  flyToSource = flyToDataSource,
  navigation = null,
}) {
  const button = doc?.getElementById('geo-import-button');
  const input = doc?.getElementById('geo-import-input');
  const listEl = doc?.getElementById('geo-import-list');
  const hint = doc?.getElementById('geo-import-hint');
  if (!viewer || !button || !input || !listEl) return null;

  const imports = [];
  const listeners = [];
  let queue = Promise.resolve();
  let seq = 0;
  let colorAt = 0;
  let destroyed = false;
  let dragDepth = 0;

  const listen = (target, type, listener, options) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, listener, options);
    listeners.push([target, type, listener, options]);
  };
  const setHint = (text) => {
    if (hint) hint.textContent = text || '';
  };
  const render = () => viewer.scene?.requestRender?.();

  /** Which row button has focus, so a re-render can give it back. */
  function focusedAction() {
    const active = doc.activeElement;
    if (!active || !listEl.contains?.(active)) return null;
    const row = active.closest?.('[data-import-id]');
    return row
      ? { id: row.dataset.importId, action: active.dataset?.action }
      : null;
  }

  function restoreFocus(was) {
    if (!was) return;
    const rows = [...listEl.querySelectorAll('[data-import-id]')];
    let row = rows.find((r) => r.dataset.importId === was.id);
    // The row is gone (removed): the next row's same control, else the
    // previous row's, else the Import button.
    if (!row && was.index != null)
      row = rows[Math.min(was.index, rows.length - 1)];
    const target =
      row?.querySelector?.(`button[data-action="${was.action}"]`) ||
      (row ? row.querySelector?.('button') : button);
    target?.focus?.();
  }

  function renderList(keep = focusedAction()) {
    listEl.replaceChildren(
      ...imports.map((item) => {
        const row = doc.createElement('li');
        row.className = 'geo-import-row';
        row.dataset.importId = item.id;
        const swatch = doc.createElement('span');
        // KML and KMZ draw with their own styles; their swatch says so
        // instead of claiming a color the globe does not show.
        swatch.className = `geo-import-swatch${item.ownStyles ? ' own-styles' : ''}`;
        if (!item.ownStyles) swatch.style.background = item.color;
        const name = doc.createElement('span');
        name.className = 'geo-import-name';
        // textContent, never markup: the name comes from the file system.
        name.textContent = item.name;
        name.title = `${item.name} — ${item.format.toUpperCase()}, ${item.entityCount.toLocaleString()} feature${item.entityCount === 1 ? '' : 's'}${item.ownStyles ? ', drawn with its own styles' : ''}`;
        const actions = [
          [
            item.visible ? 'visibility' : 'visibility_off',
            item.visible ? `Hide ${item.name}` : `Show ${item.name}`,
            'toggle',
          ],
          ['my_location', `Fly to ${item.name}`, 'fly'],
          ['close', `Remove ${item.name}`, 'remove'],
        ].map(([icon, label, action]) => {
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'geo-import-action';
          btn.dataset.action = action;
          btn.title = label;
          btn.setAttribute('aria-label', label);
          if (action === 'toggle')
            btn.setAttribute('aria-pressed', String(item.visible));
          const glyph = doc.createElement('span');
          glyph.className = 'material-symbols-outlined';
          glyph.setAttribute('aria-hidden', 'true');
          glyph.textContent = icon;
          btn.append(glyph);
          return btn;
        });
        row.append(swatch, name, ...actions);
        return row;
      }),
    );
    listEl.classList.toggle('visible', imports.length > 0);
    restoreFocus(keep);
  }

  const find = (id) => imports.find((item) => item.id === id) || null;

  /** Show or hide one imported file. */
  function setVisible(id, visible) {
    const item = find(id);
    if (!item) return false;
    item.visible = Boolean(visible);
    item.dataSource.show = item.visible;
    renderList();
    render();
    return true;
  }

  // Not viewer.flyTo: it frames ground-clamped points underground until the
  // destination's terrain has loaded (see ./flyToDataSource.js).
  const fly = (item) => {
    if (!item.visible) setVisible(item.id, true);
    flyToSource(viewer, item.dataSource);
    return true;
  };

  /**
   * Fly the camera to one imported file: an immediate navigation, so Cockpit
   * can refuse it and the current follow/track owner is released first.
   */
  function flyTo(id) {
    const item = find(id);
    if (!item) return false;
    if (typeof navigation?.runImmediateNavigation === 'function')
      return (
        navigation.runImmediateNavigation('file', () => fly(item)) !== false
      );
    return fly(item);
  }

  /** Stamp a deferred fly for an import batch; false when refused. */
  const beginAutoFly = () =>
    typeof navigation?.beginDeferredLocationNavigation === 'function'
      ? navigation.beginDeferredLocationNavigation()
      : null;
  /** Re-assert the stamp right before flying; false when superseded. */
  const autoFlyStillOwns = (generation) => {
    if (generation === false) return false;
    if (generation === null) return true;
    return typeof navigation?.reassertDeferredLocationNavigation === 'function'
      ? navigation.reassertDeferredLocationNavigation(generation) === true
      : true;
  };

  /** Remove one imported file from the globe and the list. */
  function remove(id) {
    const at = imports.findIndex((item) => item.id === id);
    if (at < 0) return false;
    const keep = focusedAction();
    if (keep) keep.index = at;
    const [item] = imports.splice(at, 1);
    viewer.dataSources?.remove?.(item.dataSource, true);
    item.revoke?.();
    renderList(keep);
    render();
    return true;
  }

  /**
   * Import files, one after another. Returns one outcome per file.
   * @param {Iterable<File>} files
   * @returns {Promise<Array<{name: string, ok: boolean, id?: string,
   *   removed?: number, error?: string}>>}
   */
  function importFiles(files) {
    const list = [...(files || [])];
    const run = queue.then(() => importBatch(list));
    queue = run.catch(() => {});
    return run;
  }

  async function importBatch(list) {
    const outcomes = [];
    if (destroyed || !list.length) return outcomes;
    // Stamped now, re-asserted before the fly: whatever navigation happens
    // while the files load (a drag, a search, Cockpit) supersedes this one.
    const generation = beginAutoFly();
    for (const file of list) {
      if (destroyed) break;
      const fileName = String(file?.name || 'file');
      if (imports.length >= MAX_IMPORTED_FILES) {
        outcomes.push({
          name: fileName,
          ok: false,
          error: `At most ${MAX_IMPORTED_FILES} files at once — remove one first.`,
        });
        continue;
      }
      setHint(`Reading ${fileName}…`);
      const color = COLORS[colorAt % COLORS.length];
      let loaded;
      try {
        loaded = await load(file, { viewer, color });
      } catch (error) {
        outcomes.push({
          name: fileName,
          ok: false,
          error:
            error instanceof GeoImportError || error?.name === 'GeoImportError'
              ? error.message
              : `That file could not be read${error?.message ? `: ${error.message}` : '.'}`,
        });
        continue;
      }
      if (destroyed) {
        loaded.revoke?.();
        break;
      }
      colorAt += 1;
      seq += 1;
      const item = {
        id: `import-${seq}`,
        name: loaded.name || fileName,
        format: loaded.format,
        ownStyles: loaded.format === 'kml' || loaded.format === 'kmz',
        entityCount: loaded.entityCount,
        removed: loaded.removed || 0,
        color,
        visible: true,
        dataSource: loaded.dataSource,
        revoke: loaded.revoke,
      };
      await viewer.dataSources.add(item.dataSource);
      if (destroyed) {
        viewer.dataSources.remove?.(item.dataSource, true);
        item.revoke?.();
        break;
      }
      imports.push(item);
      renderList();
      render();
      outcomes.push({
        name: fileName,
        ok: true,
        id: item.id,
        removed: item.removed,
      });
      // Fly to the first file of a batch that lands, so a drop shows its
      // result, unless something else took the camera meanwhile.
      if (
        outcomes.filter((o) => o.ok).length === 1 &&
        autoFlyStillOwns(generation)
      )
        fly(item);
    }
    if (!destroyed) setHint(summarize(outcomes));
    return outcomes;
  }

  // ---- controls ----------------------------------------------------------
  input.accept = GEO_FILE_ACCEPT;
  listen(button, 'click', () => input.click());
  listen(input, 'change', () => {
    const files = [...(input.files || [])];
    // Clear the selection so choosing the same file again fires `change`.
    input.value = '';
    if (files.length) void importFiles(files);
  });
  listen(listEl, 'click', (event) => {
    const btn = event.target?.closest?.('button[data-action]');
    const id = btn?.closest?.('[data-import-id]')?.dataset.importId;
    if (!btn || !id) return;
    const action = btn.dataset.action;
    if (action === 'toggle') setVisible(id, !find(id)?.visible);
    else if (action === 'fly') flyTo(id);
    else if (action === 'remove') remove(id);
  });

  // ---- drop onto the globe ----------------------------------------------
  const container = viewer.container;
  const hasFiles = (event) =>
    [...(event.dataTransfer?.types || [])].includes('Files');
  const setDragging = (on) =>
    doc.body?.classList?.toggle('gev-geo-import-drag', on);
  listen(container, 'dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    setDragging(true);
  });
  listen(container, 'dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  listen(container, 'dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) setDragging(false);
  });
  listen(container, 'drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    setDragging(false);
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) void importFiles(files);
  });

  renderList();

  const handle = {
    importFiles,
    list: () =>
      imports.map(({ id, name, format, entityCount, removed, visible }) => ({
        id,
        name,
        format,
        entityCount,
        removed,
        visible,
      })),
    setVisible,
    flyTo,
    remove,
    diagnostics: () => ({
      files: imports.length,
      entities: imports.reduce((n, item) => n + item.entityCount, 0),
      listeners: listeners.length,
      destroyed,
    }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const item of imports.splice(0)) {
        viewer.dataSources?.remove?.(item.dataSource, true);
        item.revoke?.();
      }
      for (const [target, type, listener, options] of listeners.splice(0))
        target.removeEventListener(type, listener, options);
      setDragging(false);
      listEl.replaceChildren();
      listEl.classList.remove('visible');
      setHint('');
      if (globalThis.window?.__gevGeoImport === handle)
        delete globalThis.window.__gevGeoImport;
    },
  };
  if (globalThis.window) globalThis.window.__gevGeoImport = handle;
  return handle;
}

/**
 * One line for the hint after an import batch.
 * @param {Array<{name: string, ok: boolean, error?: string, removed?: number}>} outcomes
 * @returns {string}
 */
export function summarize(outcomes) {
  const failed = outcomes.filter((o) => !o.ok);
  const added = outcomes.length - failed.length;
  const parts = [];
  if (added) parts.push(`Added ${added} file${added === 1 ? '' : 's'}.`);
  if (failed.length === 1) parts.push(`${failed[0].name}: ${failed[0].error}`);
  else if (failed.length > 1)
    parts.push(
      `${failed.length} files could not be added (${failed[0].name}: ${failed[0].error})`,
    );
  const stripped = outcomes.reduce(
    (n, o) => n + (o.ok ? o.removed || 0 : 0),
    0,
  );
  if (added && stripped)
    parts.push('Network links and remote images in KML were left out.');
  return parts.join(' ');
}
