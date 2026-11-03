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
 * Run the Import control on one viewer: the session's control (see
 * createGeoFileImport) attached to `viewer`. Null without a viewer or the
 * Import markup.
 */
export function initGeoFileImport({ viewer, ...options }) {
  if (!viewer) return null;
  const tool = createGeoFileImport(options);
  tool?.attachScene({ viewer });
  return tool;
}

/**
 * The Import control for the page session.
 * @param {{load?: Function, document?: Document, publish?: Function,
 *   connect?: Function}} deps
 *   `load(file, {viewer, color})` defaults to `loadGeoFile`; tests pass a double.
 *   `publish({rows, hint})` hands the file list and hint to the view that
 *   renders them. `connect(actions)` answers the view's pick and row buttons
 *   and returns their disconnect.
 *
 * The imported files belong to the session; their drawing belongs to the
 * attached globe. `attachScene({ viewer })` draws them on a Cesium viewer;
 * `attachScene({ engine, draw })` on a globe engine without one (Navara),
 * where `draw(dataSource)` resolves with that engine's drawing of a file
 * ({ report, setShow, refresh, destroy }: src/layers/shared/render/navaraStory.js).
 * A file kept while no globe was attached is read again from its bytes; the
 * control listens for drops and camera gestures on the attached globe.
 * `detachScene()` takes the files off the globe and keeps the list. Without a
 * globe the list stays, and import and fly-to wait for one.
 * @returns {{destroy: Function, importFiles: Function, list: Function,
 *   setVisible: Function, flyTo: Function, remove: Function,
 *   diagnostics: Function, attachScene: Function, detachScene: Function}|null}
 */
export function createGeoFileImport({
  load = loadGeoFile,
  document: doc = globalThis.document,
  flyToSource = flyToDataSource,
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
  // The attached globe ({ viewer, engine, draw, controller }): a Cesium
  // viewer, or an engine and its drawing; null while none is attached.
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
  const render = () => {
    if (scene?.viewer) scene.viewer.scene?.requestRender?.();
    else scene?.engine?.render.request('geo-import');
  };
  let groundTimer,
    groundQueued = false,
    groundAgain = false;
  let groundRemovers = [];
  const scheduleGround = () => {
    if (destroyed || !scene || !imports.length) return;
    if (groundQueued) {
      groundAgain = true;
      return;
    }
    clearTimeout(groundTimer);
    groundTimer = setTimeout(() => {
      groundQueued = true;
      const attached = scene;
      queue = queue
        .catch(() => {})
        .then(async () => {
          try {
            for (const item of imports) {
              if (destroyed || scene !== attached) return;
              if (item.visible) {
                await item.refreshGround?.(attached.controller.signal);
                item.drawing?.refresh?.();
              }
            }
            render();
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
            }
          }
        });
    }, 200);
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
    if (item.dataSource) item.dataSource.show = item.visible;
    item.drawing?.setShow(item.visible);
    if (item.visible) scheduleGround();
    present();
    render();
    return true;
  }

  const fly = (item) => {
    if (!scene || !item.dataSource) return false;
    if (!item.visible) setVisible(item.id, true);
    flyToSource(scene.viewer ?? scene.engine, item.dataSource, { ground });
    return true;
  };

  /**
   * Fly the camera to one imported file: an immediate navigation, so Cockpit
   * can refuse it and the current follow/track owner is released first.
   */
  function flyTo(id) {
    const item = find(id);
    if (!item || !scene || !item.dataSource) return false;
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
  function undraw(item, from = scene) {
    if (item.dataSource)
      from?.viewer?.dataSources?.remove?.(item.dataSource, true);
    item.drawing?.destroy();
    item.drawing = null;
    item.revoke?.();
    item.dataSource = null;
    item.revoke = null;
    item.refreshGround = null;
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
    item.dataSource = loaded.dataSource;
    item.revoke = loaded.revoke;
    item.refreshGround = loaded.refreshGround;
    item.dataSource.show = item.visible;
    if (attached.viewer) await attached.viewer.dataSources.add(item.dataSource);
    else {
      try {
        item.drawing = await attached.draw(item.dataSource);
      } catch (error) {
        undraw(item, attached);
        throw error;
      }
    }
    if (destroyed || scene !== attached) {
      undraw(item, attached);
      return false;
    }
    // What this globe leaves out of the file (Navara: labels, models...).
    item.undrawn = item.drawing?.report?.undrawn ?? 0;
    loaded.mount?.();
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
          viewer: attached.viewer,
          engine: attached.engine,
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
        dataSource: null,
        drawing: null,
        undrawn: 0,
        revoke: null,
        refreshGround: null,
      };
      try {
        if (!(await draw(item, attached, loaded))) break;
      } catch (error) {
        // A Cesium viewer's own failure stops the batch, as it always did.
        if (attached.viewer) throw error;
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
      if (item.dataSource || !imports.includes(item)) continue;
      try {
        const loaded = await load(item.file, {
          viewer: attached.viewer,
          engine: attached.engine,
          color: item.color,
          signal: attached.controller.signal,
        });
        if (destroyed || scene !== attached || !imports.includes(item)) {
          loaded.revoke?.();
          return;
        }
        await draw(item, attached, loaded);
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
    for (const item of imports) undraw(item, previous);
  }

  function attachScene({
    viewer = null,
    engine = null,
    draw: drawOnEngine = null,
    navigation: nextNavigation = navigation,
    subscribeMapSource: nextMapSource = subscribeMapSource,
  } = {}) {
    if (destroyed) return;
    detachScene();
    if (!viewer && !(engine && drawOnEngine)) return;
    // The shell and the map sources of this attachment.
    navigation = nextNavigation;
    const offMapSource = nextMapSource?.(scheduleGround);
    if (typeof offMapSource === 'function') groundRemovers.push(offMapSource);
    const attached = (scene = {
      viewer,
      engine: viewer ? null : engine,
      draw: viewer ? null : drawOnEngine,
      controller: new AbortController(),
    });
    ownEvent(
      viewer ? viewer.camera?.moveEnd : engine.camera.moveEnd,
      scheduleGround,
    );
    ownEvent(viewer?.scene?.globe?.tileLoadProgressEvent, (pending) => {
      if (!pending) scheduleGround();
    });
    const container = viewer ? viewer.container : engine.host.container;
    const canvas = viewer
      ? viewer.scene?.canvas || container
      : engine.host.canvas;
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
    if (imports.some((item) => !item.dataSource)) {
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
      drawn: imports.filter((item) => item.dataSource).length,
      entities: imports.reduce((n, item) => n + item.entityCount, 0),
      listeners: listeners.length,
      attached: Boolean(scene),
      destroyed,
    }),
    destroy() {
      if (destroyed) return;
      const last = scene;
      detachScene();
      destroyed = true;
      disconnect();
      lifetime.abort();
      for (const item of imports.splice(0)) undraw(item, last);
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
export function undrawnHint(items) {
  return t('Map objects this engine leaves out of {name}: {count}.', {
    name: items[0].name,
    count: formatNumber(items.reduce((n, item) => n + item.undrawn, 0)),
  });
}
