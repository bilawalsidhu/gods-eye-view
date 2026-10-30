import { t } from '../i18n/index.js';

const coordinate = (value, limit) =>
  Number.isFinite(Number(value)) && Math.abs(Number(value)) <= limit
    ? Number(value)
    : null;

export function selectClickablePlaces(places, { limit = 10 } = {}) {
  const seen = new Set();
  return (Array.isArray(places) ? places : [])
    .map((place) => ({
      ...place,
      name: String(place?.name || place?.displayName || '').trim(),
      latitude: coordinate(place?.latitude, 90),
      longitude: coordinate(place?.longitude, 180),
      distanceM: Number.isFinite(Number(place?.distanceM))
        ? Number(place.distanceM)
        : Number.POSITIVE_INFINITY,
    }))
    .filter((place) => {
      const key = place.name.toLocaleLowerCase();
      if (
        !key ||
        place.latitude == null ||
        place.longitude == null ||
        seen.has(key)
      )
        return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.distanceM - b.distanceM || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, Math.min(20, Number(limit) || 10)));
}

export function placePeekCandidates(summary, nearby = []) {
  const out = selectClickablePlaces(nearby).map((place) => ({
    name: place.name,
    kind: 'nearby',
    latitude: place.latitude,
    longitude: place.longitude,
  }));
  const seen = new Set(out.map((item) => item.name.toLocaleLowerCase()));
  const add = (value, kind) => {
    const name = String(value || '').trim();
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    out.push({ name, kind });
  };
  add(summary?.formattedAddress, 'address');
  add(summary?.locality, 'locality');
  add(summary?.region, 'region');
  for (const label of summary?.labels || []) add(label, 'address');
  return out.slice(0, 12);
}

export function spotTitle(summary, latitude, longitude) {
  const name = String(
    summary?.locality || summary?.formattedAddress || summary?.region || '',
  ).trim();
  if (name) return name;
  const lat = coordinate(latitude, 90);
  const lon = coordinate(longitude, 180);
  if (lat == null || lon == null) return 'This spot';
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
}

function pickedPoint(viewer, position, cesium) {
  try {
    const canvas = viewer.scene.canvas;
    const hit = viewer.camera.pickEllipsoid(
      position,
      viewer.scene.ellipsoid || viewer.scene.globe?.ellipsoid,
    );
    const cartographic = hit && cesium.Cartographic.fromCartesian(hit);
    return cartographic
      ? {
          latitude: cesium.Math.toDegrees(cartographic.latitude),
          longitude: cesium.Math.toDegrees(cartographic.longitude),
          x: Math.max(8, Math.min(position.x + 8, canvas.clientWidth - 328)),
          y: Math.max(8, Math.min(position.y + 8, canvas.clientHeight - 240)),
        }
      : null;
  } catch {
    return null;
  }
}

/** Current-provider place labels and a double-click Place Peek. */
export function initPlacePeek({
  viewer,
  placeSearch,
  navigation,
  fetchRegionalBrief,
  cesium,
  flyTo,
  pointerFree = () => true,
  subscribePointerOwnership = () => () => {},
  documentRef = globalThis.document,
} = {}) {
  if (!viewer?.scene || !placeSearch || !cesium || !flyTo || !documentRef?.body)
    return null;
  const layer = documentRef.createElement('div');
  layer.id = 'place-label-layer';
  documentRef.body.append(layer);
  let panel = null;
  let labels = [];
  let refreshController = null;
  let peekController = null;
  let destroyed = false;

  const closePeek = () => {
    peekController?.abort();
    peekController = null;
    panel?.remove();
    panel = null;
  };
  const go = (place, fallback) => {
    if (!pointerFree()) return;
    const latitude = place.latitude ?? fallback.latitude;
    const longitude = place.longitude ?? fallback.longitude;
    navigation?.runImmediateNavigation?.('place', () =>
      flyTo(viewer, latitude, longitude, {}),
    );
    closePeek();
  };
  const syncPointerOwnership = () => {
    const pointerEvents = pointerFree() ? 'auto' : 'none';
    if (panel) panel.style.pointerEvents = pointerEvents;
    for (const place of labels)
      place.button.style.pointerEvents = pointerEvents;
  };
  const renderLabels = () => {
    layer.replaceChildren();
    for (const place of labels) {
      const button = documentRef.createElement('button');
      button.type = 'button';
      button.textContent = place.name;
      button.title = t('Focus {label}', { label: place.name });
      button.addEventListener('click', () => go(place, place));
      place.position = cesium.Cartesian3.fromDegrees(
        place.longitude,
        place.latitude,
      );
      place.button = button;
      layer.append(button);
    }
    syncPointerOwnership();
  };
  const paint = () => {
    if (!labels.length) return;
    const scene = viewer.scene;
    const occluder = new cesium.EllipsoidalOccluder(
      scene.globe?.ellipsoid || scene.ellipsoid,
      viewer.camera.positionWC,
    );
    for (const place of labels) {
      const screen =
        occluder.isPointVisible(place.position) &&
        cesium.SceneTransforms.worldToWindowCoordinates(scene, place.position);
      place.button.hidden =
        !screen ||
        screen.x < 0 ||
        screen.y < 0 ||
        screen.x > scene.canvas.clientWidth ||
        screen.y > scene.canvas.clientHeight;
      if (!place.button.hidden) {
        place.button.style.left = `${screen.x}px`;
        place.button.style.top = `${screen.y}px`;
      }
    }
  };
  const refresh = async () => {
    refreshController?.abort();
    const point = pickedPoint(
      viewer,
      {
        x: viewer.scene.canvas.clientWidth / 2,
        y: viewer.scene.canvas.clientHeight / 2,
      },
      cesium,
    );
    if (!point || !placeSearch.capabilities?.nearby) {
      labels = [];
      renderLabels();
      return;
    }
    const controller = new AbortController();
    refreshController = controller;
    try {
      const nextLabels = selectClickablePlaces(
        await placeSearch.nearby(
          { ...point, radiusM: 5000 },
          { signal: controller.signal },
        ),
      );
      if (refreshController !== controller || controller.signal.aborted) return;
      labels = nextLabels;
      renderLabels();
    } catch {
      if (refreshController === controller && !controller.signal.aborted) {
        labels = [];
        renderLabels();
      }
    }
  };
  const showPeek = async (point) => {
    closePeek();
    const controller = new AbortController();
    peekController = controller;
    const results = await Promise.allSettled([
      placeSearch.reverseGeocode(point.latitude, point.longitude, {
        signal: controller.signal,
      }),
      placeSearch.capabilities?.nearby
        ? placeSearch.nearby(
            { ...point, radiusM: 1000 },
            { signal: controller.signal },
          )
        : [],
      fetchRegionalBrief?.(point.latitude, point.longitude, {
        signal: controller.signal,
      }),
    ]);
    if (destroyed || controller.signal.aborted || !pointerFree()) return;
    const brief = results[2].status === 'fulfilled' ? results[2].value : null;
    const summary =
      (results[0].status === 'fulfilled' ? results[0].value : null) ||
      brief?.place ||
      null;
    const nearby = results[1].status === 'fulfilled' ? results[1].value : [];
    const candidates = placePeekCandidates(summary, nearby);
    panel = documentRef.createElement('section');
    panel.id = 'place-peek-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', t('Details'));
    panel.style.left = `${point.x}px`;
    panel.style.top = `${point.y}px`;
    const heading = documentRef.createElement('h2');
    heading.textContent = spotTitle(summary, point.latitude, point.longitude);
    panel.append(heading);
    const close = documentRef.createElement('button');
    close.type = 'button';
    close.className = 'place-peek-close';
    close.setAttribute('aria-label', t('Cancel'));
    close.textContent = '×';
    close.addEventListener('click', closePeek);
    panel.append(close);
    for (const candidate of candidates.slice(0, 6)) {
      const button = documentRef.createElement('button');
      button.type = 'button';
      button.textContent = candidate.name;
      button.addEventListener('click', () => go(candidate, point));
      panel.append(button);
    }
    const articles = Array.isArray(brief?.articles)
      ? brief.articles.slice(0, 3)
      : [];
    if (articles.length) {
      const news = documentRef.createElement('div');
      news.className = 'place-peek-news';
      for (const article of articles) {
        const link = documentRef.createElement('a');
        link.href = article.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = article.title;
        news.append(link);
      }
      panel.append(news);
    }
    syncPointerOwnership();
    documentRef.body.append(panel);
    panel.querySelector('button, a')?.focus({ preventScroll: true });
  };
  const handler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((event) => {
    if (!pointerFree() || viewer.scene.pick?.(event.position)) return;
    const point = pickedPoint(viewer, event.position, cesium);
    if (point) void showPeek(point);
  }, cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  const removeRender = viewer.scene.postRender.addEventListener(paint);
  const removePointerOwnership =
    subscribePointerOwnership(syncPointerOwnership);
  const onMoveEnd = () => void refresh();
  viewer.camera.moveEnd.addEventListener(onMoveEnd);
  void refresh();
  return {
    close: closePeek,
    refresh,
    destroy() {
      destroyed = true;
      closePeek();
      refreshController?.abort();
      handler.destroy();
      removeRender?.();
      removePointerOwnership?.();
      viewer.camera.moveEnd.removeEventListener(onMoveEnd);
      layer.remove();
    },
  };
}
