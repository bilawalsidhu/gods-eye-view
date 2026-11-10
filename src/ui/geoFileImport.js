/** Session-local file controls, serial loading and application-owned navigation. */
import { GeoImportError, loadGeoFile } from '../data/geoFileImport.js';
import { MAX_IMPORTED_FILES } from '../data/geoImportLimits.js';
import { drawImportedFile } from '../data/geoImportDisplay.js';
import { formatNumber, t, tn, translateKnown } from '../i18n/index.js';
import { flyToFootprint } from './flyToDataSource.js';

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
 * The Import control for the page session.
 * @param {{load?: Function, drawFile?: Function, document?: Document,
 *   publish?: Function, connect?: Function}} deps
 *   `load(file, {color, signal})` defaults to `loadGeoFile` (the file's
 *   plain records) and `drawFile(engine, records, {visible, signal,
 *   isCurrent})` to
 *   `drawImportedFile` (their drawing: { report, setShow, refreshGround,
 *   footprint, destroy }); tests pass doubles. `publish({rows, hint})` hands the file
 *   list and hint to the view that renders them. `connect(actions)` answers
 *   the view's pick and row buttons and returns their disconnect.
 *
 * The imported files belong to the session; their drawing belongs to the
 * attached globe. `attachScene({ engine })` draws them on a globe engine,
 * the same on every engine, and flies its camera to them. A file kept while
 * no globe was attached is read again from its bytes; the control listens
 * for drops and camera gestures on the attached globe. `detachScene()` takes
 * the files off the globe and keeps the list. Without a globe the list
 * stays, and import and fly-to wait for one.
 * @returns {{destroy: Function, importFiles: Function, list: Function,
 *   setVisible: Function, flyTo: Function, remove: Function,
 *   diagnostics: Function, attachScene: Function, detachScene: Function}|null}
 */
export function createGeoFileImport({
  load = loadGeoFile,
  drawFile = drawImportedFile,
  document: doc = globalThis.document,
  flyToSource = flyToFootprint,
  navigation = null,
  ground = null,
  subscribeMapSource = null,
  publish = () => {},
  connect = () => () => {},
} = {}) {
  // A page without the Import control (the Utilities panel omitted, in
  // LayerPanelsView) has no file import.
  if (!doc?.getElementById('geo-import-button')) return null;

  const imports = [];
  let listeners = [];
  let queue = Promise.resolve();
  let seq = 0;
  let colorAt = 0;
  let destroyed = false;
  let dragDepth = 0;
  let cameraIntent = 0;
  let hint = '';
  const lifetime = new AbortController();
  // The attached globe ({ engine, controller }); null while none is
  // attached.
  let scene = null;

  const listen = (target, type, listener, options) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, listener, options);
    listeners.push([target, type, listener, options]);
  };
  const setHint = (text) => {
    hint = text || '';
    present();
  };
  const render = () => scene?.engine?.render.request('geo-import');
  let groundTimer,
    groundQueued = false,
    groundAgain = false,
    // Refreshes left while the map's tiles are still loading.
    groundWaits = 0;
  let groundRemovers = [];
  const scheduleGround = (delay = 200) => {
    if (destroyed || !scene || !imports.length) return;
    if (groundQueued) {
      groundAgain = true;
      return;
    }
    clearTimeout(groundTimer);
    groundTimer = setTimeout(() => {
      groundQueued = true;
      const attached = scene;
      let retry = false;
      queue = queue
        .catch(() => {})
        .then(async () => {
          try {
            for (const item of imports) {
              if (destroyed || scene !== attached) return;
              if (item.visible)
                await item.drawing?.refreshGround(attached.controller.signal);
            }
            render();
            // The ground is read from the tiles drawn now: read it again
            // once they have loaded.
            retry =
              attached.engine.surface.tilesLoaded?.() === false &&
              groundWaits > 0;
            groundWaits = retry ? groundWaits - 1 : 0;
          } catch {
            if (!destroyed && scene === attached)
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
            } else if (retry) scheduleGround(1000);
          }
        });
    }, delay);
  };
  const ownEvent = (event, listener) => {
    const remove = event?.addEventListener?.(listener);
    if (remove) groundRemovers.push(remove);
  };

  /** Publish the file list and hint; the view renders them. */
  function present() {
    return publish({
      rows: imports.map((item) => ({
        id: item.id,
        name: item.name,
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
    item.drawing?.setShow(item.visible);
    if (item.visible) scheduleGround();
    present();
    render();
    return true;
  }

  const fly = (item) => {
    if (!scene?.engine || !item.drawing) return false;
    if (!item.visible) setVisible(item.id, true);
    flyToSource(scene.engine, item.drawing.footprint(), { ground });
    return true;
  };

  /**
   * Fly the camera to one imported file: an immediate navigation, so Cockpit
   * can refuse it and the current follow/track owner is released first.
   */
  function flyTo(id) {
    const item = find(id);
    if (!item || !scene || !item.drawing) return false;
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

  /** Take one file's drawing off the globe; the file stays in the list. */
  function undraw(item) {
    item.drawing?.destroy();
    item.drawing = null;
    item.revoke?.();
    item.records = null;
    item.revoke = null;
  }

  /** Remove one imported file from the globe and the list. */
  function remove(id) {
    const at = imports.findIndex((item) => item.id === id);
    if (at < 0) return false;
    const [item] = imports.splice(at, 1);
    undraw(item);
    present();
    render();
    return true;
  }

  /** Draw a file read for the attached globe. False once that globe went. */
  async function draw(item, attached, loaded) {
    item.records = loaded.records;
    item.revoke = loaded.revoke;
    try {
      item.drawing = await drawFile(attached.engine, loaded.records, {
        visible: item.visible,
        signal: attached.controller.signal,
        isCurrent: () => !destroyed && scene === attached,
      });
    } catch (error) {
      undraw(item);
      // A draw cut short by a scene change is not a file error.
      if (destroyed || scene !== attached) return false;
      throw error;
    }
    if (destroyed || scene !== attached) {
      undraw(item);
      return false;
    }
    // What no engine draws of the file (walls, extruded polygons...).
    item.undrawn = item.drawing?.report?.undrawn ?? 0;
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
    if (!scene) {
      // Import draws on the attached globe; there is none.
      const error = t('Action unavailable or cancelled');
      setHint(error);
      return Promise.resolve(
        list.map((file) => ({
          name: String(file?.name || 'file'),
          ok: false,
          error,
        })),
      );
    }
    const generation = beginAutoFly();
    const intent = ++cameraIntent;
    const attached = scene;
    const run = queue.then(() =>
      importBatch(list, generation, intent, attached),
    );
    queue = run.catch(() => {});
    return run;
  }

  async function importBatch(list, generation, intent, attached) {
    const outcomes = [];
    if (destroyed || !list.length) return outcomes;
    for (const file of list) {
      if (destroyed || scene !== attached) break;
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
        loaded = await load(file, {
          color,
          signal: attached.controller.signal,
        });
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
      if (destroyed || scene !== attached) {
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
        // The bytes, so a later globe can read the file again.
        file,
        records: null,
        drawing: null,
        undrawn: 0,
        revoke: null,
      };
      try {
        if (!(await draw(item, attached, loaded))) break;
      } catch {
        outcomes.push({
          name: fileName,
          ok: false,
          error: t('That file could not be read.'),
        });
        continue;
      }
      imports.push(item);
      present();
      render();
      outcomes.push({
        name: fileName,
        ok: true,
        id: item.id,
        removed: item.removed,
        undrawn: item.undrawn,
      });
      if (
        outcomes.filter((o) => o.ok).length === 1 &&
        intent === cameraIntent &&
        autoFlyStillOwns(generation)
      )
        fly(item);
    }
    if (!destroyed && scene === attached) setHint(summarize(outcomes));
    return outcomes;
  }

  // Draw the files kept while no globe was attached, as they were.
  async function redraw(attached) {
    for (const item of [...imports]) {
      if (destroyed || scene !== attached) return;
      if (item.drawing || !imports.includes(item)) continue;
      try {
        const loaded = await load(item.file, {
          color: item.color,
          signal: attached.controller.signal,
        });
        if (destroyed || scene !== attached || !imports.includes(item)) {
          loaded.revoke?.();
          return;
        }
        await draw(item, attached, loaded);
        if (!imports.includes(item)) undraw(item);
      } catch {
        if (destroyed || scene !== attached) return;
        setHint(`${item.name}: ${t('That file could not be read.')}`);
      }
    }
    if (!destroyed && scene === attached) {
      // Say what this globe leaves out of the files it drew again.
      const left = imports.filter((item) => item.undrawn);
      if (left.length) setHint(undrawnHint(left));
      present();
      render();
    }
  }

  const disconnect = connect({
    importGeoFiles: (files) => void importFiles(files),
    toggleGeoImport: (id) => setVisible(id, !find(id)?.visible),
    flyToGeoImport: flyTo,
    removeGeoImport: remove,
  });

  const gesture = () => {
    cameraIntent += 1;
  };
  const hasFiles = (event) =>
    [...(event.dataTransfer?.types || [])].includes('Files');
  const setDragging = (on) =>
    doc.body?.classList?.toggle('gev-geo-import-drag', on);

  function detachScene() {
    if (!scene) return;
    const previous = scene;
    scene = null;
    previous.controller.abort();
    clearTimeout(groundTimer);
    for (const remove of groundRemovers.splice(0)) remove();
    for (const [target, type, listener, options] of listeners.splice(0))
      target.removeEventListener(type, listener, options);
    dragDepth = 0;
    setDragging(false);
    for (const item of imports) undraw(item);
  }

  function attachScene({
    engine = null,
    navigation: nextNavigation = navigation,
    subscribeMapSource: nextMapSource = subscribeMapSource,
  } = {}) {
    if (destroyed) return;
    detachScene();
    if (!engine) return;
    // The shell and the map sources of this attachment.
    navigation = nextNavigation;
    const ground = () => {
      groundWaits = 10;
      scheduleGround();
    };
    const offMapSource = nextMapSource?.(ground);
    if (typeof offMapSource === 'function') groundRemovers.push(offMapSource);
    const attached = (scene = {
      engine,
      controller: new AbortController(),
    });
    ownEvent(engine.camera.moveEnd, ground);
    const container = engine.host.container;
    const canvas = engine.host.canvas || container;
    listen(canvas, 'pointerdown', gesture, { passive: true });
    listen(canvas, 'wheel', gesture, { passive: true });
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
    if (imports.some((item) => !item.drawing)) {
      const run = queue.then(() => redraw(attached));
      queue = run.catch(() => {});
    }
  }

  present();

  const handle = {
    importFiles,
    list: () =>
      imports.map(
        ({ id, name, format, entityCount, removed, visible, undrawn }) => ({
          id,
          name,
          format,
          entityCount,
          removed,
          visible,
          undrawn,
        }),
      ),
    setVisible,
    flyTo,
    remove,
    attachScene,
    detachScene,
    diagnostics: () => ({
      files: imports.length,
      drawn: imports.filter((item) => item.drawing).length,
      entities: imports.reduce((n, item) => n + item.entityCount, 0),
      listeners: listeners.length,
      attached: Boolean(scene),
      destroyed,
    }),
    destroy() {
      if (destroyed) return;
      detachScene();
      destroyed = true;
      disconnect();
      lifetime.abort();
      for (const item of imports.splice(0)) undraw(item);
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
  const left = outcomes.filter((o) => o.ok && o.undrawn);
  if (left.length) parts.push(undrawnHint(left));
  return parts.join(' ');
}

/**
 * What the attached globe leaves out of the given files (each `{ name,
 * undrawn }`): the first file's name and the total count.
 */
function undrawnHint(items) {
  return t('Map objects this engine leaves out of {name}: {count}.', {
    name: items[0].name,
    count: formatNumber(items.reduce((n, item) => n + item.undrawn, 0)),
  });
}
