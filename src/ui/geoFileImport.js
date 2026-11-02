/** Session-local file controls, serial loading and application-owned navigation. */
import {
  GeoImportError,
  MAX_IMPORTED_FILES,
  loadGeoFile,
} from '../data/geoFileImport.js';
import { formatNumber, t, tn, translateKnown } from '../i18n/index.js';
import { flyToDataSource } from './flyToDataSource.js';

// One color per file, in import order, from the whiteboard palette.
const COLORS = ['#39d0ff', '#ffb547', '#5dff9f', '#ff6b6b', '#8be9ff'];

/** An import error's values, with its counts and limits in local numerals. */
function localizedValues(values) {
  return Object.fromEntries(
    Object.entries(values || {}).map(([name, value]) => [
      name,
      typeof value === 'number' ? formatNumber(value) : value,
    ]),
  );
}

/**
 * Run the Import control.
 * @param {{viewer: object, load?: Function, document?: Document,
 *   publish?: Function, connect?: Function}} deps
 *   `load(file, {viewer, color})` defaults to `loadGeoFile`; tests pass a double.
 *   `publish({rows, hint})` hands the file list and hint to the view that
 *   renders them. `connect(actions)` answers the view's pick and row buttons
 *   and returns their disconnect.
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
  connect = () => () => {},
}) {
  // A page without the Import control (the Display controls view omitted)
  // has no file import.
  if (!viewer || !doc?.getElementById('geo-import-button')) return null;

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

  const find = (id) => imports.find((item) => item.id === id) || null;

  /** Show or hide one imported file. */
  function setVisible(id, visible) {
    const item = find(id);
    if (!item) return false;
    item.visible = Boolean(visible);
    item.dataSource.show = item.visible;
    if (item.visible) scheduleGround();
    present();
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
    const [item] = imports.splice(at, 1);
    viewer.dataSources?.remove?.(item.dataSource, true);
    item.revoke?.();
    present();
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
              ? t(
                  error.template || error.message,
                  localizedValues(error.values),
                )
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
      present();
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
  // The view opens the picker; its pick and the row buttons call these.
  const disconnect = connect({
    importGeoFiles: (files) => void importFiles(files),
    toggleGeoImport: (id) => setVisible(id, !find(id)?.visible),
    flyToGeoImport: flyTo,
    removeGeoImport: remove,
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

  present();

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
      disconnect();
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
