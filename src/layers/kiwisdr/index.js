import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import { msg } from '../../i18n/marker.js';
import { horizonOccluder } from '../../data/iconOrientation.js';
import { createKiwiPanel } from './controls.js';
import { stationStyle } from './palette.js';
import { createKiwiStore } from './storage.js';

export { createKiwiSdrSource } from './source.js';

const PICK_PREFIX = 'kiwisdr:';
const LIFT_M = 30;

/** Globe markers for public KiwiSDR receivers; click one to listen. */
export function createKiwiSdrLayer({
  source,
  services,
  createPanel = createKiwiPanel,
  store = createKiwiStore(),
}) {
  if (typeof source?.getDirectory !== 'function')
    throw new TypeError('KiwiSDR requires a directory source');
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const { registerSpriteCollection, restoreSpriteOrder } = services.sprites;
  const { isPointerFree } = services.input;
  const { governorRequestRender } = services.render;
  const { claimCameraSensitivity, releaseCameraSensitivity } = services.camera;

  let viewer = null;
  let points = null;
  let handler = null;
  let tooltip = null;
  let panel = null;
  let request = null;
  let enabled = false;
  let cameraAttached = false;
  let selectedId = null;
  let lastHover = null;
  const byId = new Map(); // station id -> { station, point, position }
  let count = 0;
  let lastUpdate = null;
  let lastError = null;
  let cullTimer = null;
  let tray = null;
  let unsubStore = null;

  function applyStyle(entry, selected) {
    const style = stationStyle(entry.station);
    const color = Cesium.Color.fromCssColorString(style.css).withAlpha(
      style.alpha,
    );
    entry.point.color = color;
    entry.point.pixelSize = style.size + (selected ? 4 : 0);
    entry.point.outlineColor = selected
      ? Cesium.Color.WHITE
      : Cesium.Color.BLACK.withAlpha(Math.min(0.8, style.alpha));
    entry.point.outlineWidth = selected ? 3 : 1;
  }

  /** Hide receivers on the far side of the planet; their depth test is off. */
  function cull() {
    cullTimer = null;
    if (!viewer || !points || !enabled) return;
    const occluder = horizonOccluder(viewer.camera);
    for (const entry of byId.values()) {
      const visible = occluder.isPointVisible(entry.position);
      entry.point.show = visible;
      if (entry.ring) entry.ring.show = visible;
    }
    governorRequestRender('kiwisdr-cull');
  }
  const scheduleCull = () => {
    if (cullTimer === null) cullTimer = setTimeout(cull, 60);
  };

  /** Favorites get a white ring around their dot, on top of the load colour. */
  function syncRings() {
    if (!points) return;
    for (const entry of byId.values()) {
      const favorite = store.isFavorite(entry.station.id);
      if (favorite && !entry.ring) {
        entry.ring = points.add({
          position: entry.position,
          id: PICK_PREFIX + entry.station.id,
          color: Cesium.Color.TRANSPARENT,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          pixelSize: stationStyle(entry.station).size + 9,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(2e5, 1.3, 2.5e7, 0.65),
        });
      } else if (!favorite && entry.ring) {
        points.remove(entry.ring);
        entry.ring = null;
      }
    }
    renderTray();
    governorRequestRender('kiwisdr-favorites');
    scheduleCull();
  }

  function openStation(entry) {
    select(entry);
    hideTooltip();
    panel.open(entry.station);
  }

  function flyToStation(entry) {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        entry.station.lon,
        entry.station.lat,
        1_500_000,
      ),
      duration: 1.6,
    });
  }

  /** Bottom-left "★ Favorites" button and the list it opens. */
  function renderTray() {
    const favorites = store.getFavorites();
    if (!enabled || !favorites.length) {
      tray?.root.remove();
      tray = null;
      return;
    }
    if (!tray) {
      const root = document.createElement('div');
      root.className = 'kiwisdr-favs';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'kiwisdr-favs-toggle';
      toggle.setAttribute('aria-expanded', 'false');
      const list = document.createElement('ul');
      list.className = 'kiwisdr-favs-list';
      list.hidden = true;
      toggle.addEventListener('click', () => {
        list.hidden = !list.hidden;
        toggle.setAttribute('aria-expanded', String(!list.hidden));
      });
      root.append(toggle, list);
      document.body.append(root);
      tray = { root, toggle, list };
    }
    tray.toggle.textContent = t('★ Favorites ({count})', {
      count: favorites.length,
    });
    tray.list.replaceChildren(
      ...favorites.map((fav) => {
        const entry = byId.get(fav.id);
        const li = document.createElement('li');
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'kiwisdr-fav';
        const name = document.createElement('span');
        name.textContent = fav.name;
        const where = document.createElement('small');
        where.textContent = entry ? fav.loc : t('Not in the current directory');
        go.append(name, where);
        go.disabled = !entry;
        go.addEventListener('click', () => {
          if (!entry) return;
          flyToStation(entry);
          openStation(entry);
          tray.list.hidden = true;
          tray.toggle.setAttribute('aria-expanded', 'false');
        });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'kiwisdr-chip kiwisdr-chip-x';
        remove.textContent = '×';
        remove.setAttribute('aria-label', t('Remove from favorites'));
        remove.addEventListener('click', () => store.removeFavorite(fav.id));
        li.append(go, remove);
        return li;
      }),
    );
  }

  function stationFromPick(picked) {
    const id = picked?.primitive?.id ?? picked?.id;
    if (typeof id !== 'string' || !id.startsWith(PICK_PREFIX)) return null;
    return byId.get(id.slice(PICK_PREFIX.length)) ?? null;
  }

  function select(entry) {
    const previous = selectedId && byId.get(selectedId);
    if (previous) applyStyle(previous, false);
    selectedId = entry?.station.id ?? null;
    if (entry) applyStyle(entry, true);
    governorRequestRender('kiwisdr-select');
  }

  function showTooltip(entry, position) {
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'kiwisdr-tooltip';
      tooltip.setAttribute('role', 'tooltip');
      document.body.append(tooltip);
    }
    const s = entry.station;
    tooltip.textContent =
      s.users >= s.usersMax
        ? t('{name} · {users}/{max} listening (full)', {
            name: s.name,
            users: s.users,
            max: s.usersMax,
          })
        : t('{name} · {users}/{max} listening', {
            name: s.name,
            users: s.users,
            max: s.usersMax,
          });
    tooltip.style.left = `${position.x + 14}px`;
    tooltip.style.top = `${position.y + 14}px`;
    tooltip.hidden = false;
  }
  function hideTooltip() {
    if (tooltip) tooltip.hidden = true;
  }

  function installHandler() {
    if (handler || !viewer) return;
    handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((click) => {
      if (!isPointerFree()) return;
      const entry = stationFromPick(viewer.scene.pick(click.position));
      if (!entry) return;
      openStation(entry);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction((move) => {
      if (!isPointerFree()) return hideTooltip();
      const entry = stationFromPick(viewer.scene.pick(move.endPosition));
      if (entry === lastHover) {
        if (entry) showTooltip(entry, move.endPosition);
        return;
      }
      lastHover = entry;
      viewer.scene.canvas.style.cursor = entry ? 'pointer' : '';
      if (entry) showTooltip(entry, move.endPosition);
      else hideTooltip();
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  }
  function removeHandler() {
    handler?.destroy();
    handler = null;
    lastHover = null;
    hideTooltip();
    if (viewer) viewer.scene.canvas.style.cursor = '';
  }

  const layer = {
    id: 'kiwisdr',
    name: 'KiwiSDR',
    icon: '📡',
    source: 'KiwiSDR.com · LIVE',
    updateInterval: 600_000,

    init(v) {
      if (viewer) throw new Error('KiwiSDR layer is already initialized');
      viewer = v;
      points = new Cesium.PointPrimitiveCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      viewer.scene.primitives.add(points);
      registerSpriteCollection('kiwisdr', points);
      points.show = false;
      panel = createPanel({ onClose: () => select(null), store });
    },

    enable(v = viewer) {
      enabled = true;
      lastError = null;
      points.show = true;
      installHandler();
      registerPickOwner('kiwisdr', (id) => String(id).startsWith(PICK_PREFIX));
      if (!cameraAttached) {
        v.camera.changed.addEventListener(scheduleCull);
        claimCameraSensitivity(v.camera, 'kiwisdr', 0.05);
        cameraAttached = true;
      }
      restoreSpriteOrder(v);
      unsubStore ||= store.onChange((what) => {
        if (what === 'favorites') syncRings();
      });
      renderTray();
      scheduleCull();
    },

    disable(v = viewer) {
      enabled = false;
      request?.abort();
      request = null;
      panel?.close();
      unsubStore?.();
      unsubStore = null;
      tray?.root.remove();
      tray = null;
      removeHandler();
      unregisterPickOwner('kiwisdr');
      if (cameraAttached) {
        v.camera.changed.removeEventListener(scheduleCull);
        releaseCameraSensitivity(v.camera, 'kiwisdr');
        cameraAttached = false;
      }
      clearTimeout(cullTimer);
      cullTimer = null;
      if (points) points.show = false;
    },

    async update() {
      if (!enabled || !points) return false;
      request?.abort();
      const mine = new AbortController();
      request = mine;
      try {
        const { stations } = await source.getDirectory({ signal: mine.signal });
        if (mine.signal.aborted || request !== mine || !enabled) return false;
        const openId = panel?.stationId ?? null;
        points.removeAll();
        byId.clear();
        for (const station of stations) {
          const position = Cesium.Cartesian3.fromDegrees(
            station.lon,
            station.lat,
            LIFT_M,
          );
          const point = points.add({
            position,
            id: PICK_PREFIX + station.id,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(2e5, 1.3, 2.5e7, 0.65),
          });
          const entry = { station, point, position, ring: null };
          byId.set(station.id, entry);
          applyStyle(entry, station.id === (selectedId ?? openId));
        }
        syncRings();
        count = stations.length;
        lastUpdate = Date.now();
        lastError = null;
        cull();
        return true;
      } catch (error) {
        if (mine.signal.aborted || request !== mine || !enabled) return false;
        console.warn('[Data:KiwiSDR] Fetch error:', error);
        lastError = error?.message || msg('KiwiSDR directory unavailable');
        return false;
      } finally {
        if (request === mine) request = null;
      }
    },

    destroy(v = viewer) {
      if (enabled) layer.disable(v);
      panel?.destroy();
      panel = null;
      tooltip?.remove();
      tooltip = null;
      if (points && v) v.scene.primitives.remove(points);
      points = null;
      byId.clear();
      viewer = null;
      count = 0;
      lastUpdate = null;
      lastError = null;
    },

    getStats() {
      return { count, lastUpdate, error: lastError };
    },
  };
  return layer;
}
