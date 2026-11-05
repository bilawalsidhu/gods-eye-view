import * as Cesium from 'cesium';
import {
  decodeXml,
  kmzImageResolver,
  kmzMainDocument,
  parseXml,
  readZipEntries,
  resolveKmzPath,
} from '../../data/geoFileImport.js';
import {
  formatNumber,
  formatUtcDayMonth,
  msg,
  t,
  tn,
} from '../../i18n/index.js';
import { createHorizonCull } from '../streetLevel/view.js';
import { readGhostMapsKml } from './kml.js';
import { fieldLabel, parseDescriptionFields, wrapCardText } from './records.js';
export * from './catalog.js';
export * from './records.js';
export { readGhostMapsKml } from './kml.js';
export { createGhostMapsSource } from './source.js';

export const GHOSTMAPS_LAYER_ID = 's2-ghostmaps';
export const GHOSTMAPS_OVERLAY_SOURCE_ID = 's2-ghostmaps';
const PICK_PREFIX = 'ghostmaps:';
const STORAGE_KEY = 'gev.ghostmaps.products';
const ACCENT = '#c8ff00';
const MAX_ICON_BYTES = 512 * 1024;
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const MAX_CARD_LINES = 12;

/** Panel names for the catalog's product ids (the catalog sends English). */
const PRODUCT_LABELS = Object.freeze({
  cip: msg('Intel Picture'),
  'kinetic-30d': msg('Kinetic 30d'),
  'border-crisis': msg('Border Crisis'),
  'iran-cip': msg('Iran Picture'),
  'iran-kinetic': msg('Iran Kinetic'),
  'yemen-flot': msg('Yemen FLOT'),
  'latest-drop': msg('Latest Drop'),
});

/** One distinct fallback marker color per product. */
const PRODUCT_COLORS = Object.freeze({
  cip: '#c8ff00',
  'kinetic-30d': '#ff5a36',
  'border-crisis': '#ffb547',
  'iran-cip': '#39d0ff',
  'iran-kinetic': '#ff3b8d',
  'yemen-flot': '#5dff9f',
  'latest-drop': '#b48cff',
});

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readStoredSelection(storage) {
  try {
    const value = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
    return Array.isArray(value) ? new Set(value.map(String)) : null;
  } catch {
    return null;
  }
}

function writeStoredSelection(storage, selected) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify([...selected]));
  } catch {
    /* private window or blocked storage: the selection lasts this session */
  }
}

/** A round marker for placemarks whose icon is missing or remote. */
const markerCache = new Map();
function markerImage(color) {
  if (markerCache.has(color)) return markerCache.get(color);
  let url = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 20;
    const ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.arc(10, 10, 7, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.stroke();
    url = canvas.toDataURL();
  } catch {
    url = null;
  }
  markerCache.set(color, url);
  return url;
}

const cesiumColor = (rgba, fallback, alpha) =>
  rgba
    ? new Cesium.Color(rgba[0], rgba[1], rgba[2], alpha ?? rgba[3])
    : Cesium.Color.fromCssColorString(fallback).withAlpha(alpha ?? 1);

function anchorOf(geometry) {
  if (geometry.type === 'point') return geometry.position;
  const ring =
    geometry.type === 'polygon' ? geometry.outer : geometry.positions;
  let lon = 0;
  let lat = 0;
  for (const [x, y] of ring) {
    lon += x;
    lat += y;
  }
  return [lon / ring.length, lat / ring.length];
}

/**
 * S2 Underground GhostMaps: the current editions of S2's public KMZ intel
 * products, kept in step with the GitHub repository. The proxy watches the
 * branch head and pushes each new commit; only changed products reload.
 */
export function createGhostMapsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
  storage = defaultStorage(),
} = {}) {
  if (typeof source?.getCatalog !== 'function')
    throw new TypeError('GhostMaps layer requires a catalog source');
  let _viewer = null;
  let _enabled = false;
  let _catalog = null;
  let _lastError = null;
  let _unsubscribe = null;
  let _stream = 'closed';
  let _queue = Promise.resolve();
  let _clickHandler = null;
  let _rowListener = null;
  let _selectedKey = null;
  let _selectedCardId = null;
  let _selectedLink = null;
  let _lifetime = new AbortController();
  let _selection = readStoredSelection(storage);
  /** productId → {version, dataSource, urls, count, features} */
  const _loaded = new Map();
  /** productId → in-flight version */
  const _loading = new Map();
  /** productId → error text */
  const _failed = new Map();

  const notifyRow = () => _rowListener?.();
  const render = () => _viewer?.scene?.requestRender?.();
  // Pins skip the depth test, and with Google 3D tiles the globe is hidden,
  // so nothing else stops far-side pins drawing through the planet.
  const _horizon = createHorizonCull({
    getViewer: () => _viewer,
    items: function* () {
      for (const item of _loaded.values()) yield* item.pins;
    },
    onChange: render,
  });
  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  function wanted(product) {
    return _selection ? _selection.has(product.id) : product.defaultOn;
  }

  function selectedIds() {
    return (_catalog?.products || []).filter(wanted).map(({ id }) => id);
  }

  function unload(id) {
    const item = _loaded.get(id);
    if (!item) return;
    _loaded.delete(id);
    _viewer?.dataSources?.remove(item.dataSource, true);
    item.urls.forEach((url) => URL.revokeObjectURL(url));
    if (_selectedKey?.startsWith(`${id}:`)) clearSelection();
  }

  /** Build one product's data source off-scene, then swap it in. */
  async function load(product, signal) {
    const bytes = await source.getFile(product.id, product.version, { signal });
    signal.throwIfAborted();
    const entries = await readZipEntries(bytes);
    signal.throwIfAborted();
    const main = kmzMainDocument(entries);
    if (!main) throw new Error(msg('That KMZ holds no KML document.'));
    const urls = [];
    const resolvePacked = kmzImageResolver(entries, main, (url) =>
      urls.push(url),
    );
    // Icons only: ArcGIS exports also pack multi-megabyte photo attachments,
    // which fall back to the product marker instead of being decoded.
    const resolveImage = (href) => {
      const path = resolveKmzPath(href, main, entries);
      return path && entries.get(path).length <= MAX_ICON_BYTES
        ? resolvePacked(href)
        : null;
    };
    try {
      const parsed = readGhostMapsKml(
        parseXml(decodeXml(entries.get(main)), 'KML'),
        resolveImage,
      );
      entries.clear();
      signal.throwIfAborted();
      const color = PRODUCT_COLORS[product.id] || ACCENT;
      const dataSource = new Cesium.CustomDataSource(
        `${GHOSTMAPS_LAYER_ID}:${product.id}`,
      );
      const features = [];
      const pins = [];
      dataSource.entities.suspendEvents();
      parsed.features.forEach((feature, index) => {
        const key = `${product.id}:${index}`;
        const { style } = feature;
        feature.geometries.forEach((geometry, part) => {
          const id = `${PICK_PREFIX}${key}:${part}`;
          if (geometry.type === 'point') {
            const position = Cesium.Cartesian3.fromDegrees(
              ...geometry.position,
            );
            const entity = dataSource.entities.add({
              id,
              position,
              billboard: {
                image: style.icon || markerImage(color),
                scale: Math.min(
                  1.5,
                  Math.max(0.35, (style.iconScale ?? 1) * 0.7),
                ),
                color:
                  style.icon && style.iconColor
                    ? cesiumColor(style.iconColor)
                    : undefined,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                verticalOrigin: Cesium.VerticalOrigin.CENTER,
                // Ground-clamped icons would sink into terrain and 3D tiles; the
                // horizon cull hides the far side instead (see `_horizon`).
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
            });
            pins.push({
              position,
              get show() {
                return entity.show;
              },
              set show(value) {
                entity.show = value;
              },
            });
          } else if (geometry.type === 'line') {
            dataSource.entities.add({
              id,
              polyline: {
                positions: Cesium.Cartesian3.fromDegreesArray(
                  geometry.positions.flat(),
                ),
                width: Math.min(8, Math.max(1.5, style.lineWidth ?? 2)),
                material: cesiumColor(style.lineColor, color),
                clampToGround: true,
              },
            });
          } else {
            const ring = (points) =>
              Cesium.Cartesian3.fromDegreesArray(points.flat());
            dataSource.entities.add({
              id,
              polygon: {
                hierarchy: new Cesium.PolygonHierarchy(
                  ring(geometry.outer),
                  geometry.holes.map(
                    (hole) => new Cesium.PolygonHierarchy(ring(hole)),
                  ),
                ),
                material:
                  style.fill === false
                    ? Cesium.Color.TRANSPARENT
                    : cesiumColor(
                        style.polyColor,
                        color,
                        style.polyColor ? undefined : 0.25,
                      ),
                classificationType: Cesium.ClassificationType.BOTH,
              },
            });
            if (style.outline !== false)
              dataSource.entities.add({
                id: `${id}:outline`,
                polyline: {
                  positions: ring([...geometry.outer, geometry.outer[0]]),
                  width: Math.min(6, Math.max(1.5, style.lineWidth ?? 2)),
                  material: cesiumColor(style.lineColor, color),
                  clampToGround: true,
                },
              });
          }
        });
        features.push({
          name: feature.name,
          folder: feature.folder,
          description: feature.description,
          anchor: anchorOf(feature.geometries[0]),
        });
      });
      dataSource.entities.resumeEvents();
      return { version: product.version, dataSource, urls, features, pins };
    } catch (error) {
      urls.forEach((url) => URL.revokeObjectURL(url));
      throw error;
    }
  }

  /** Bring the globe in line with the catalog and the chip selection. */
  function sync() {
    const run = _queue.then(async () => {
      if (!_enabled || !_viewer || !_catalog) return;
      const signal = _lifetime.signal;
      const products = new Map(_catalog.products.map((p) => [p.id, p]));
      for (const id of [..._loaded.keys()]) {
        const product = products.get(id);
        if (!product || !wanted(product)) unload(id);
      }
      for (const product of _catalog.products) {
        if (!wanted(product) || signal.aborted) continue;
        if (_loaded.get(product.id)?.version === product.version) continue;
        _loading.set(product.id, product.version);
        _failed.delete(product.id);
        notifyRow();
        try {
          const next = await load(product, signal);
          if (signal.aborted || !_enabled) {
            next.urls.forEach((url) => URL.revokeObjectURL(url));
            return;
          }
          // Cull before the first frame so far-side pins never flash.
          _horizon.update(next.pins);
          await _viewer.dataSources.add(next.dataSource);
          // The new edition is on the globe before the old one leaves.
          unload(product.id);
          _loaded.set(product.id, next);
        } catch (error) {
          if (signal.aborted) return;
          console.warn(`[Data:GhostMaps] ${product.id}:`, error);
          _failed.set(
            product.id,
            error?.template ||
              error?.message ||
              msg('GhostMaps file could not be read'),
          );
        } finally {
          _loading.delete(product.id);
          notifyRow();
          render();
        }
      }
    });
    _queue = run.catch(() => {});
    return run;
  }

  function applyCatalog(catalog) {
    _catalog = catalog;
    _lastError = catalog.error || null;
    notifyRow();
    return sync();
  }

  function toggleProduct(id) {
    // The first change pins the whole current selection, defaults included.
    if (!_selection) _selection = new Set(selectedIds());
    if (_selection.has(id)) _selection.delete(id);
    else _selection.add(id);
    writeStoredSelection(storage, _selection);
    notifyRow();
    void sync();
  }

  // ---- selection card ----------------------------------------------------
  function featureFor(key) {
    const [productId, index] = key.split(':');
    return {
      product: _catalog?.products.find((p) => p.id === productId) || null,
      feature: _loaded.get(productId)?.features[Number(index)] || null,
    };
  }

  function publishCard() {
    if (!canSelect()) return;
    const { product, feature } = _selectedKey ? featureFor(_selectedKey) : {};
    if (!feature) {
      _selectedKey = null;
      _selectedCardId = null;
      _selectedLink = null;
      overlayHost.setEntries(
        GHOSTMAPS_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const { fields, links } = parseDescriptionFields(feature.description);
    _selectedLink = links[0] || null;
    const heading = [t(PRODUCT_LABELS[product?.id] || product?.title || '')];
    if (feature.folder) heading.push(fieldLabel(feature.folder));
    if (product?.dateMs) heading.push(formatUtcDayMonth(product.dateMs));
    const details = [heading.filter(Boolean).join(' · ')];
    for (const { label, value } of fields) {
      if (details.length >= MAX_CARD_LINES) break;
      // ArcGIS repeats the feature type as the first row; the title has it.
      if (value === feature.name) continue;
      const line = label ? `${fieldLabel(label)}: ${value}` : value;
      details.push(
        ...wrapCardText(line, 60, Math.min(4, MAX_CARD_LINES - details.length)),
      );
    }
    if (_selectedLink && openExternal)
      details.push(
        tn(
          links.length,
          '{count} source link ↗ · click card to open',
          '{count} source links ↗ · click card to open the first',
          { count: formatNumber(links.length) },
        ),
      );
    const title = t('S2 · {name}', {
      name: fieldLabel(feature.name || feature.folder) || t('Report'),
    });
    const card = {
      id: `ghostmaps-card:${_selectedKey}`,
      selected: true,
      interactive: Boolean(_selectedLink && openExternal),
      title,
      details,
      accent: PRODUCT_COLORS[product?.id] || ACCENT,
      priority: Number.MAX_SAFE_INTEGER,
      gapPx: 15,
      verticalOnly: true,
      placement: 'above',
      // A click card comes and goes with the click, as CCTV cards do, rather
      // than holding the label arbiter's 2.5 s minimum lifetime; and it hides
      // when its marker turns behind the planet.
      stateless: true,
      horizonCull: true,
      position: Cesium.Cartesian3.fromDegrees(...feature.anchor),
    };
    if (card.interactive) {
      const link = _selectedLink;
      card.accessibilityLabel = t('Open the source for {title}', { title });
      card.activate = () => {
        openExternal(link);
        return true;
      };
    }
    _selectedCardId = card.id;
    overlayHost.setEntries(
      GHOSTMAPS_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
    overlayHost.setVisible?.(GHOSTMAPS_OVERLAY_SOURCE_ID, true);
  }

  function clearSelection() {
    _selectedKey = null;
    _selectedCardId = null;
    _selectedLink = null;
    // An empty publish, as the perimeter cards deselect: it releases the
    // selected card's paint lane, which clearing the source alone left drawn.
    overlayHost?.setEntries(GHOSTMAPS_OVERLAY_SOURCE_ID, [], CARD_HOST_OPTIONS);
  }

  function pickedKey(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const [productId, index] = pickId.slice(PICK_PREFIX.length).split(':');
    return _loaded.get(productId)?.features[Number(index)]
      ? `${productId}:${index}`
      : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      GHOSTMAPS_LAYER_ID,
      (pickedId) =>
        typeof pickedId === 'string' && pickedId.startsWith(PICK_PREFIX),
    );
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: GHOSTMAPS_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) {
        if (_selectedLink && openExternal) openExternal(_selectedLink);
        return;
      }
      const picked = _viewer.scene.pick(click.position);
      const key = picked ? pickedKey(picked) : null;
      if (key) {
        _selectedKey = key;
        publishCard();
        render();
        return;
      }
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(GHOSTMAPS_LAYER_ID, pickId))
          return;
      }
      if (_selectedKey) {
        clearSelection();
        render();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    _clickHandler?.destroy();
    _clickHandler = null;
    picking?.unregisterPickOwner?.(GHOSTMAPS_LAYER_ID);
  }

  function featureCount() {
    let count = 0;
    for (const item of _loaded.values()) count += item.features.length;
    return count;
  }

  const layer = {
    id: GHOSTMAPS_LAYER_ID,
    name: 'S2 GhostMaps',
    icon: '👻',
    source: 'S2 Underground',
    // Pushes arrive within seconds over the event stream; this interval is
    // the backstop if the stream is down.
    updateInterval: 300000,

    init(viewer) {
      if (_viewer) throw new Error('GhostMaps layer is already initialized');
      _viewer = viewer;
    },

    enable() {
      _enabled = true;
      _lifetime = new AbortController();
      for (const item of _loaded.values()) item.dataSource.show = true;
      installClickHandler();
      if (!_unsubscribe && typeof source.subscribe === 'function')
        _unsubscribe = source.subscribe(
          (catalog) => {
            if (_enabled) void applyCatalog(catalog);
          },
          (state) => {
            if (_stream === state) return;
            _stream = state;
            notifyRow();
          },
        );
    },

    disable() {
      _enabled = false;
      _lifetime.abort();
      _unsubscribe?.();
      _unsubscribe = null;
      _stream = 'closed';
      removeClickHandler();
      clearSelection();
      _horizon.stop();
      for (const id of [..._loaded.keys()]) unload(id);
      render();
    },

    async update(_viewerArg, { signal } = {}) {
      if (!_enabled || signal?.aborted) return false;
      try {
        const catalog = await source.getCatalog({ signal });
        if (!_enabled) return false;
        await applyCatalog(catalog);
        return true;
      } catch (error) {
        if (signal?.aborted || !_enabled) return false;
        console.warn('[Data:GhostMaps] catalog error:', error);
        _lastError = error?.message || msg('GhostMaps catalog unavailable');
        notifyRow();
        // Keep the layer on; the event stream or the next interval recovers.
        return true;
      }
    },

    destroy() {
      layer.disable();
      _viewer = null;
      _catalog = null;
      _rowListener = null;
    },

    setRowControlsListener(listener) {
      _rowListener = listener;
    },

    getRowControls() {
      const products = _catalog?.products || [];
      const commit = _catalog?.commit;
      const info = commit
        ? _stream === 'open'
          ? t('LIVE · GitHub {commit} · {message} · checked every {seconds}s', {
              commit: commit.slice(0, 7),
              message: _catalog.message || '—',
              seconds: formatNumber(
                Math.round((_catalog.pollMs || 15000) / 1000),
              ),
            })
          : t('GitHub {commit} · {message} · reconnecting for live updates', {
              commit: commit.slice(0, 7),
              message: _catalog.message || '—',
            })
        : t('Connecting to the S2 GhostMaps repository…');
      return {
        chips: products.map((product) => {
          const loaded = _loaded.get(product.id);
          const failed = _failed.get(product.id);
          return {
            id: product.id,
            label: t(PRODUCT_LABELS[product.id] || product.title),
            active: wanted(product),
            busy: _loading.has(product.id),
            state: failed ? 'error' : undefined,
            color: PRODUCT_COLORS[product.id],
            title: [
              product.fileTitle,
              loaded
                ? tn(
                    loaded.features.length,
                    '{count} placemark',
                    '{count} placemarks',
                    {
                      count: formatNumber(loaded.features.length),
                    },
                  )
                : null,
              failed ? t(failed) : null,
            ]
              .filter(Boolean)
              .join(' · '),
            onClick: () => toggleProduct(product.id),
          };
        }),
        legend: [],
        info,
        infoTitle: t(
          'S2 Underground publishes these KMZ products to GitHub. New uploads are detected within seconds and replace the previous edition automatically. Click a marker for its report.',
        ),
      };
    },

    getStats() {
      return {
        count: featureCount(),
        products: [..._loaded.keys()],
        commit: _catalog?.commit || null,
        lastUpdate: _catalog?.committedAt || _catalog?.changedAt || null,
        checkedAt: _catalog?.checkedAt || null,
        stream: _stream,
        loading: _loading.size > 0,
        error: _lastError || [..._failed.values()][0] || null,
        fallback: false,
      };
    },

    /** Loaded placemarks as plain records, for tools and QA. */
    getAnalystRecords(maxCount = Infinity) {
      if (!_enabled) return [];
      const out = [];
      for (const [productId, item] of _loaded) {
        for (const feature of item.features) {
          if (out.length >= maxCount) return out;
          out.push({
            product: productId,
            name: feature.name,
            folder: feature.folder,
            lon: feature.anchor[0],
            lat: feature.anchor[1],
          });
        }
      }
      return out;
    },
  };
  return layer;
}
