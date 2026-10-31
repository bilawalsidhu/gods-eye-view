/** Session-local file controls, serial loading and application-owned navigation. */
import {
  GEO_FILE_ACCEPT,
  GeoImportError,
  MAX_IMPORTED_FILES,
  loadGeoFile,
} from '../data/geoFileImport.js';
import {
  formatNumber,
  msg,
  registerUnsavedWork,
  t,
  tn,
  translateKnown,
} from '../i18n/index.js';
import { flyToDataSource } from './flyToDataSource.js';

// One color per file, in import order, from the whiteboard palette.
const COLORS = ['#39d0ff', '#ffb547', '#5dff9f', '#ff6b6b', '#8be9ff'];

/**
 * Wire the Import control.
 * @param {{viewer: object, load?: Function, document?: Document,
 *   publish?: Function}} deps
 *   `load(file, {viewer, color})` defaults to `loadGeoFile`; tests pass a double.
 *   `publish({rows, hint})` hands the file list and hint to the view that
 *   renders them; it may return a promise that settles once they render.
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
  ground = null,
  subscribeMapSource = null,
  publish = () => {},
}) {
  const button = doc?.getElementById('geo-import-button');
  const input = doc?.getElementById('geo-import-input');
  const listEl = doc?.getElementById('geo-import-list');
  if (!viewer || !button || !input || !listEl) return null;

  const imports = [];
  const listeners = [];
  let queue = Promise.resolve();
  let seq = 0;
  let colorAt = 0;
  let destroyed = false;
  let dragDepth = 0;
  let cameraIntent = 0;
  let hint = '';
  const lifetime = new AbortController();
  let removeMapSource;
  // Imports live for the page session: switching language (a reload) asks
  // first while any are on the map.
  const unregisterUnsavedWork = registerUnsavedWork(() =>
    !destroyed && imports.length ? msg('imported map files') : null,
  );

  const listen = (target, type, listener, options) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, listener, options);
    listeners.push([target, type, listener, options]);
  };
  const setHint = (text) => {
    hint = text || '';
    present();
  };
  const render = () => viewer.scene?.requestRender?.();
  let groundTimer,
    groundQueued = false,
    groundAgain = false;
  const groundRemovers = [];
  const scheduleGround = () => {
    if (destroyed || !imports.length) return;
    if (groundQueued) {
      groundAgain = true;
      return;
    }
    clearTimeout(groundTimer);
    groundTimer = setTimeout(() => {
      groundQueued = true;
      queue = queue
        .catch(() => {})
        .then(async () => {
          try {
            for (const item of imports) {
              if (destroyed) return;
              if (item.visible) await item.refreshGround?.(lifetime.signal);
            }
            render();
          } catch {
            if (!destroyed)
              setHint(
                t(
                  'Ground heights could not be refreshed. Try the file again when the map has loaded.',
                ),
              );
          } finally {
            groundQueued = false;
            if (groundAgain) {
              groundAgain = false;
              scheduleGround();
            }
          }
        });
    }, 200);
  };
  removeMapSource = subscribeMapSource?.(scheduleGround);
  const ownEvent = (event, listener) => {
    const remove = event?.addEventListener?.(listener);
    if (remove) groundRemovers.push(remove);
  };
  ownEvent(viewer.camera?.moveEnd, scheduleGround);
  ownEvent(viewer.scene?.globe?.tileLoadProgressEvent, (pending) => {
    if (!pending) scheduleGround();
  });

  /** Which row button has focus, so a re-render can give it back. */
  function focusedAction() {
    const active = doc.activeElement;
    if (!active || !listEl.contains?.(active)) return null;
    const row = active.closest?.('[data-import-id]');
    return row
      ? {
          id: row.dataset.importId,
          action: active.dataset?.action,
          element: active,
          next: [],
        }
      : null;
  }

  function restoreFocus(was) {
    // Focus moved on while the list rendered: leave it where it went.
    const active = doc.activeElement;
    if (active && active !== was.element && active !== doc.body) return;
    const rows = [...listEl.querySelectorAll('[data-import-id]')];
    const rowOf = (id) => rows.find((r) => r.dataset.importId === id);
    // The row is gone (removed): the next row's same control, else the
    // previous row's, else the Import button.
    const row = [was.id, ...was.next].map(rowOf).find(Boolean);
    const target =
      row?.querySelector?.(`button[data-action="${was.action}"]`) ||
      (row ? row.querySelector?.('button') : button);
    target?.focus?.();
  }

  /** Publish the file list and hint; the view renders them. */
  function present() {
    return publish({
      rows: imports.map((item) => ({
        id: item.id,
        name: item.name,
        // KML and KMZ draw with their own styles; their swatch says so
        // instead of claiming a color the globe does not show.
        ownStyles: item.ownStyles,
        color: item.color,
        title: `${item.name} — ${item.format.toUpperCase()}, ${tn(
          item.entityCount,
          '{count} map object',
          '{count} map objects',
          { count: formatNumber(item.entityCount) },
        )}${item.ownStyles ? t(', drawn with its own styles') : ''}`,
        actions: [
          {
            icon: item.visible ? 'visibility' : 'visibility_off',
            label: item.visible
              ? t('Hide {name}', { name: item.name })
              : t('Show {name}', { name: item.name }),
            action: 'toggle',
            pressed: String(item.visible),
          },
          {
            icon: 'my_location',
            label: t('Fly to {name}', { name: item.name }),
            action: 'fly',
          },
          {
            icon: 'close',
            label: t('Remove {name}', { name: item.name }),
            action: 'remove',
          },
        ],
      })),
      hint,
    });
  }

  // The focus to give back once the view renders; a second change before
  // then keeps the first, whose control the page still shows.
  let pendingFocus = null;

  function renderList(keep = focusedAction()) {
    pendingFocus ||= keep;
    const rendered = present();
    const was = pendingFocus;
    // A removed row leaves the page only once the view renders.
    if (was)
      Promise.resolve(rendered).then(() => {
        if (destroyed || pendingFocus !== was) return;
        pendingFocus = null;
        restoreFocus(was);
      });
  }

  const find = (id) => imports.find((item) => item.id === id) || null;

  /** Show or hide one imported file. */
  function setVisible(id, visible) {
    const item = find(id);
    if (!item) return false;
    item.visible = Boolean(visible);
    item.dataSource.show = item.visible;
    if (item.visible) scheduleGround();
    renderList();
    render();
    return true;
  }

  // Not viewer.flyTo: it frames ground-clamped points underground until the
  // destination's terrain has loaded (see ./flyToDataSource.js).
  const fly = (item) => {
    if (!item.visible) setVisible(item.id, true);
    flyToSource(viewer, item.dataSource, { ground });
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
    if (keep)
      keep.next = [
        ...imports.slice(at + 1),
        ...imports.slice(0, at).reverse(),
      ].map((other) => other.id);
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
    if (destroyed || !list.length) return Promise.resolve([]);
    // Capture the user's intent when the files are chosen, including time
    // spent waiting for an earlier batch. Later navigation must still win.
    const generation = beginAutoFly();
    const intent = ++cameraIntent;
    const run = queue.then(() => importBatch(list, generation, intent));
    queue = run.catch(() => {});
    return run;
  }

  async function importBatch(list, generation, intent) {
    const outcomes = [];
    if (destroyed || !list.length) return outcomes;
    for (const file of list) {
      if (destroyed) break;
      const fileName = String(file?.name || 'file');
      if (imports.length >= MAX_IMPORTED_FILES) {
        outcomes.push({
          name: fileName,
          ok: false,
          error: t('At most {count} files at once — remove one first.', {
            count: formatNumber(MAX_IMPORTED_FILES),
          }),
        });
        continue;
      }
      setHint(t('Reading {name}…', { name: fileName }));
      const color = COLORS[colorAt % COLORS.length];
      let loaded;
      try {
        loaded = await load(file, { viewer, color, signal: lifetime.signal });
      } catch (error) {
        outcomes.push({
          name: fileName,
          ok: false,
          error:
            error instanceof GeoImportError || error?.name === 'GeoImportError'
              ? t(error.template || error.message, error.values)
              : t('That file could not be read.'),
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
        refreshGround: loaded.refreshGround,
      };
      await viewer.dataSources.add(item.dataSource);
      if (destroyed) {
        viewer.dataSources.remove?.(item.dataSource, true);
        item.revoke?.();
        break;
      }
      loaded.mount?.();
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
        intent === cameraIntent &&
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
  const gesture = () => {
    cameraIntent += 1;
  };
  listen(viewer.scene?.canvas || container, 'pointerdown', gesture, {
    passive: true,
  });
  listen(viewer.scene?.canvas || container, 'wheel', gesture, {
    passive: true,
  });
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
  listen(doc, 'dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  listen(container, 'dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) setDragging(false);
  });
  listen(doc, 'drop', (event) => {
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
      unregisterUnsavedWork();
      lifetime.abort();
      removeMapSource?.();
      clearTimeout(groundTimer);
      for (const remove of groundRemovers) remove();
      for (const item of imports.splice(0)) {
        viewer.dataSources?.remove?.(item.dataSource, true);
        item.revoke?.();
      }
      for (const [target, type, listener, options] of listeners.splice(0))
        target.removeEventListener(type, listener, options);
      setDragging(false);
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
  if (added)
    parts.push(
      tn(added, 'Added {count} file.', 'Added {count} files.', {
        count: formatNumber(added),
      }),
    );
  // Import errors stay English in the outcome; they translate here.
  const error = translateKnown(failed[0]?.error);
  if (failed.length === 1) parts.push(`${failed[0].name}: ${error}`);
  else if (failed.length > 1)
    parts.push(
      tn(
        failed.length,
        '{count} file could not be added ({name}: {error})',
        '{count} files could not be added ({name}: {error})',
        { count: formatNumber(failed.length), name: failed[0].name, error },
      ),
    );
  const stripped = outcomes.reduce(
    (n, o) => n + (o.ok ? o.removed || 0 : 0),
    0,
  );
  if (added && stripped) parts.push(t('Some KML content was left out.'));
  return parts.join(' ');
}
