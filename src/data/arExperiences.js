import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  hitTestWorldOverlay,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { governorRequestRender } from '../renderGovernor.js';
import { registerDynamicCredit } from './dataCredits.js';
import { registerPickOwner, resolvePickId, unregisterPickOwner } from './pickRegistry.js';
import {
  AR_PROVIDER_ID_PATTERN,
  DEFAULT_AR_PROVIDER_SELECTION,
  normalizeArProviderSelection,
} from './arProviderContract.js';

export { DEFAULT_AR_PROVIDER_SELECTION, normalizeArProviderSelection } from './arProviderContract.js';

export const AR_EXPERIENCES_LAYER_ID = 'ar-experiences';
export const AR_OVERLAY_SOURCE_ID = 'ar-experiences';
export const AR_OVERLAY_COHORT_LIMIT = 80;
export const AR_OVERLAY_COLLISION_CAPACITY = 56;
export const DEFAULT_AR_INCLUDE_PAST = false;
const DEFAULT_OVERLAY_HOST = Object.freeze({
  clearSource: clearOverlaySource,
  hitTest: hitTestWorldOverlay,
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
});

function cleanText(value, maxLength = 240) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, maxLength).trim() : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeLaunchUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'arpoisedeeplink:') {
      return url.href;
    }
  } catch {
    // Treat malformed provider links as non-launchable hotspots.
  }
  return null;
}

function normalizedIso(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function isExpiredExperience(experience, nowMs) {
  if (!experience?.endsAt) return false;
  const endsAt = Date.parse(experience.endsAt);
  return Number.isFinite(endsAt) && endsAt < nowMs;
}

function colorFromCss(value) {
  try {
    return Cesium.Color.fromCssColorString(value) || Cesium.Color.CYAN;
  } catch {
    return Cesium.Color.CYAN;
  }
}

function providerAvailable(provider) {
  return provider?.configured === true && provider?.enabled === true;
}

function normalizeProvider(provider) {
  const id = cleanText(provider?.id, 64)?.toLowerCase();
  if (!id || !AR_PROVIDER_ID_PATTERN.test(id)) return null;
  return {
    id,
    label: cleanText(provider?.label, 80) || id,
    protocol: cleanText(provider?.protocol, 40)?.toLowerCase() || id,
    configured: provider?.configured === true,
    enabled: provider?.enabled === true,
    reason: cleanText(provider?.reason || provider?.error, 180),
    color: cleanText(provider?.color, 24) || '#4aa8ff',
    attribution: cleanText(provider?.attribution, 180),
    website: safeLaunchUrl(provider?.website),
    status: cleanText(provider?.status, 24)?.toLowerCase() || null,
    error: cleanText(provider?.error, 180),
  };
}

export function resolveSelectedArProviderIds(selection, providers) {
  const available = providers.filter(providerAvailable).map(({ id }) => id);
  const normalized = normalizeArProviderSelection(selection);
  if (normalized === 'all') return available;
  if (normalized === 'none') return [];
  const requested = new Set(normalized.split(','));
  return available.filter((id) => requested.has(id));
}

function canonicalSelection(ids, providers) {
  const available = providers.filter(providerAvailable).map(({ id }) => id);
  const selected = available.filter((id) => ids.has(id));
  if (selected.length === available.length && available.length > 0) return 'all';
  return selected.length ? selected.join(',') : 'none';
}

export function toggleArProviderSelection(selection, providerId, providers) {
  const provider = providers.find(({ id }) => id === providerId);
  if (!providerAvailable(provider)) return normalizeArProviderSelection(selection);
  const selected = new Set(resolveSelectedArProviderIds(selection, providers));
  if (selected.has(providerId)) selected.delete(providerId);
  else selected.add(providerId);
  return canonicalSelection(selected, providers);
}

export function createArProviderChips(providers, selection, includePast) {
  const selected = new Set(resolveSelectedArProviderIds(selection, providers));
  const chips = providers.map((provider) => {
    const available = providerAvailable(provider);
    const error = provider.status === 'error' || provider.status === 'unconfigured' || !available;
    return {
      id: `provider:${provider.id}`,
      label: provider.label,
      active: available && selected.has(provider.id),
      disabled: !available,
      state: error ? 'error' : (selected.has(provider.id) ? 'active' : 'idle'),
      title: provider.reason || provider.error
        || `${selected.has(provider.id) ? 'Hide' : 'Show'} ${provider.label} AR experiences`,
      params: available
        ? { providers: toggleArProviderSelection(selection, provider.id, providers) }
        : null,
    };
  });
  chips.push({
    id: 'include-past',
    label: 'Past',
    active: includePast === true,
    disabled: false,
    state: includePast ? 'active' : 'idle',
    title: includePast ? 'Hide expired AR experiences' : 'Include expired AR experiences',
    params: { includePast: includePast !== true },
  });
  return chips;
}

export function normalizeArExperience(candidate) {
  const id = cleanText(candidate?.id, 160);
  const providerId = cleanText(candidate?.providerId, 64)?.toLowerCase();
  const lat = finiteNumber(candidate?.lat);
  const lon = finiteNumber(candidate?.lon);
  if (!id || !providerId || lat === null || lon === null
    || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return {
    id,
    providerId,
    providerLabel: cleanText(candidate?.providerLabel, 80) || providerId,
    protocol: cleanText(candidate?.protocol, 40)?.toLowerCase() || providerId,
    title: cleanText(candidate?.title, 120) || 'Untitled AR experience',
    description: cleanText(candidate?.description, 500),
    creator: cleanText(candidate?.creator, 120),
    lat,
    lon,
    altitudeM: finiteNumber(candidate?.altitudeM),
    distanceM: finiteNumber(candidate?.distanceM),
    contentType: cleanText(candidate?.contentType, 80),
    launchUrl: safeLaunchUrl(candidate?.launchUrl),
    sourceUrl: safeLaunchUrl(candidate?.sourceUrl),
    updatedAt: normalizedIso(candidate?.updatedAt),
    startsAt: normalizedIso(candidate?.startsAt),
    endsAt: normalizedIso(candidate?.endsAt),
    attribution: cleanText(candidate?.attribution, 180),
  };
}

function compactUpper(value, maxLength = 30) {
  const text = cleanText(value, maxLength);
  return text ? text.toUpperCase() : null;
}

function distanceLabel(distanceM) {
  if (!Number.isFinite(distanceM) || distanceM < 0) return null;
  if (distanceM >= 1000) {
    const kilometers = distanceM / 1000;
    return `${kilometers >= 10 ? Math.round(kilometers) : kilometers.toFixed(1)} KM AWAY`;
  }
  return `${Math.max(1, Math.round(distanceM))} M AWAY`;
}

export function createArOverlayEntry(experience, position, {
  accent = '#4aa8ff',
  launch = launchArExperience,
} = {}) {
  if (!experience || !position) return null;
  const provider = compactUpper(experience.providerLabel, 24);
  const contentType = compactUpper(experience.contentType, 24);
  const proximity = distanceLabel(experience.distanceM);
  const creator = compactUpper(experience.creator, 28);
  const details = [
    [provider, contentType].filter(Boolean).join(' · '),
    [proximity, creator].filter(Boolean).join(' · '),
  ].filter(Boolean);
  const launchable = Boolean(experience.launchUrl || experience.sourceUrl);
  return {
    id: `${experience.providerId}:${experience.id}`,
    position,
    variant: 'card',
    title: experience.title,
    details,
    accent,
    priority: Math.max(0, 1_000_000 - Math.round(experience.distanceM || 0)),
    collisionGroup: 'ambient-card',
    paintLane: 'ambient-card',
    interactive: launchable,
    accessibilityLabel: launchable
      ? `Open ${experience.title} from ${experience.providerLabel}`
      : '',
    activate: launchable
      ? () => launch(experience) !== false
      : null,
    anchorRadiusPx: 8,
    minAnchorGapPx: 5,
    verticalOnly: true,
    placement: 'above',
    gapPx: 10,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    maxDistance: 20_000_000,
    distanceScale: {
      near: 500,
      nearValue: 1.08,
      far: 20_000_000,
      farValue: 0.82,
    },
    altitudeFadeStart: 1_000_000,
    altitudeFadeEnd: 3_000_000,
  };
}

export function launchArExperience(experience) {
  const target = safeLaunchUrl(experience?.launchUrl || experience?.sourceUrl);
  if (!target || typeof window === 'undefined') return false;
  const protocol = new URL(target).protocol;
  if (protocol === 'arpoisedeeplink:') {
    window.location.assign(target);
    return true;
  }
  window.open(target, '_blank', 'noopener,noreferrer');
  return true;
}

function defaultQueryResolver(viewer) {
  const camera = viewer?.camera;
  if (!camera) return null;
  const canvas = viewer.scene?.canvas;
  const center = new Cesium.Cartesian2(
    (Number(canvas?.clientWidth) || Number(canvas?.width) || 1) / 2,
    (Number(canvas?.clientHeight) || Number(canvas?.height) || 1) / 2,
  );
  let cartographic = null;
  try {
    const picked = camera.pickEllipsoid?.(center, Cesium.Ellipsoid.WGS84);
    if (picked) cartographic = Cesium.Cartographic.fromCartesian(picked);
  } catch {
    // Fall through to the camera subpoint when center picking is unavailable.
  }
  cartographic ||= camera.positionCartographic || null;
  if (!cartographic) return null;
  const lat = Cesium.Math.toDegrees(cartographic.latitude);
  const lon = Cesium.Math.toDegrees(cartographic.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const height = Math.max(0, Number(camera.positionCartographic?.height) || 0);
  return {
    lat: Math.round(lat * 1_000_000) / 1_000_000,
    lon: Math.round(lon * 1_000_000) / 1_000_000,
    radiusM: Math.round(Math.max(1_500, Math.min(100_000, height * 0.5 || 5_000))),
  };
}

async function defaultFetchJson(url, { signal } = {}) {
  const response = await fetch(url, { signal, cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `AR content request returned HTTP ${response.status}`);
  return payload;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function providerCredit(provider) {
  const label = escapeHtml(provider.attribution || provider.label);
  const linked = provider.website
    ? `<a href="${escapeHtml(provider.website)}" target="_blank" rel="noopener">${label}</a>`
    : label;
  const protocol = provider.protocol === 'oscp' ? ' via Open AR Cloud OSCP' : '';
  return {
    key: `ar-provider:${provider.id}`,
    html: `AR experiences: ${linked}${protocol}`,
  };
}

export function createArExperiencesLayer({
  queryResolver = defaultQueryResolver,
  fetchJson = defaultFetchJson,
  overlayHost = DEFAULT_OVERLAY_HOST,
  handlerFactory = (viewer) => new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
  launch = launchArExperience,
  now = Date.now,
} = {}) {
  let viewer = null;
  let dataSource = null;
  let enabled = false;
  let providers = [];
  let experiences = [];
  let providerSelection = DEFAULT_AR_PROVIDER_SELECTION;
  let includePast = DEFAULT_AR_INCLUDE_PAST;
  let lastUpdate = null;
  let loading = false;
  let error = null;
  let degraded = false;
  let stale = false;
  let available = true;
  let source = 'AR providers';
  let handler = null;
  let removeMoveEnd = null;
  let requestController = null;
  let requestGeneration = 0;
  let rowControlsListener = null;
  let renderFingerprint = '';
  const experienceByEntityId = new Map();
  const experienceByOverlayId = new Map();

  function selectedIds() {
    return new Set(resolveSelectedArProviderIds(providerSelection, providers));
  }

  function visualFingerprint(nextProviders, nextExperiences) {
    return JSON.stringify({
      providers: nextProviders.map(({ id, label, color, configured, enabled }) => ({
        id,
        label,
        color,
        configured,
        enabled,
      })),
      experiences: nextExperiences,
    });
  }

  function render() {
    if (!dataSource) return;
    dataSource.entities.removeAll();
    experienceByEntityId.clear();
    experienceByOverlayId.clear();
    const selected = selectedIds();
    const entries = [];
    const renderedAt = now();
    for (const experience of experiences) {
      if (!selected.has(experience.providerId)) continue;
      if (!includePast && isExpiredExperience(experience, renderedAt)) continue;
      const provider = providers.find(({ id }) => id === experience.providerId);
      if (!provider) continue;
      const position = Cesium.Cartesian3.fromDegrees(
        experience.lon,
        experience.lat,
        experience.altitudeM || 0,
      );
      const entityId = `ar-experience:${experience.providerId}:${experience.id}`;
      const color = colorFromCss(provider.color);
      dataSource.entities.add({
        id: entityId,
        position,
        point: {
          pixelSize: 10,
          color: color.withAlpha(0.92),
          outlineColor: Cesium.Color.WHITE.withAlpha(0.78),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          heightReference: experience.altitudeM === null
            ? Cesium.HeightReference.CLAMP_TO_GROUND
            : Cesium.HeightReference.NONE,
        },
        properties: {
          layerId: AR_EXPERIENCES_LAYER_ID,
          providerId: experience.providerId,
          experienceId: experience.id,
          name: experience.title,
        },
      });
      experienceByEntityId.set(entityId, experience);
      const entry = createArOverlayEntry(experience, position, { accent: provider.color, launch });
      if (entry) {
        entries.push(entry);
        experienceByOverlayId.set(entry.id, experience);
      }
    }
    if (enabled) {
      overlayHost.setEntries(AR_OVERLAY_SOURCE_ID, entries, {
        cohortLimit: AR_OVERLAY_COHORT_LIMIT,
        collisionCapacity: AR_OVERLAY_COLLISION_CAPACITY,
        moving: false,
      });
    }
    governorRequestRender('ar-experiences-render');
  }

  function installInteraction() {
    if (handler || !viewer) return;
    handler = handlerFactory(viewer);
    handler.setInputAction((click) => {
      if (!enabled) return;
      const pickedId = resolvePickId(viewer.scene?.pick?.(click.position));
      let experience = pickedId ? experienceByEntityId.get(String(pickedId)) : null;
      if (!experience) {
        const hit = overlayHost.hitTest?.(click.position?.x, click.position?.y, {
          sourceId: AR_OVERLAY_SOURCE_ID,
        });
        experience = hit ? experienceByOverlayId.get(hit.entryId) : null;
      }
      if (experience) launch(experience);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function registerCredits() {
    for (const provider of providers) {
      if (providerAvailable(provider)) registerDynamicCredit(viewer, providerCredit(provider));
    }
  }

  function sourceLabel() {
    const active = providers.filter((provider) => selectedIds().has(provider.id));
    if (active.length === 1) return active[0].label;
    if (active.length > 1) return `${active.length} AR providers`;
    return 'AR providers';
  }

  async function update(targetViewer = viewer, { signal } = {}) {
    const query = queryResolver(targetViewer);
    if (!query) {
      error = 'Map center is unavailable';
      available = false;
      return true;
    }
    requestController?.abort();
    const controller = new AbortController();
    requestController = controller;
    const generation = ++requestGeneration;
    const forwardAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener?.('abort', forwardAbort, { once: true });
    loading = true;
    error = null;
    rowControlsListener?.();
    try {
      const params = new URLSearchParams({
        lat: String(query.lat),
        lon: String(query.lon),
        radiusM: String(query.radiusM),
        providers: providerSelection,
        includePast: includePast ? '1' : '0',
      });
      const payload = await fetchJson(`/api/ar-content?${params}`, { signal: controller.signal });
      if (generation !== requestGeneration || controller.signal.aborted) return true;
      const nextProviders = (Array.isArray(payload?.providers) ? payload.providers : [])
        .map(normalizeProvider)
        .filter(Boolean);
      const nextExperiences = (Array.isArray(payload?.experiences) ? payload.experiences : [])
        .map(normalizeArExperience)
        .filter(Boolean);
      const nextFingerprint = visualFingerprint(nextProviders, nextExperiences);
      providers = nextProviders;
      experiences = nextExperiences;
      registerCredits();
      if (nextFingerprint !== renderFingerprint) {
        renderFingerprint = nextFingerprint;
        render();
      }
      const selected = selectedIds();
      const selectedProviders = providers.filter((provider) => selected.has(provider.id));
      const failures = selectedProviders.filter((provider) => provider.status === 'error');
      const staleProviders = selectedProviders.filter((provider) => provider.status === 'stale');
      const providerIssues = [...failures, ...staleProviders];
      available = providers.some(providerAvailable);
      stale = staleProviders.length > 0;
      degraded = providerIssues.length > 0;
      error = providerIssues.length > 0
        ? providerIssues.map((provider) => (
          provider.error || `${provider.label} ${provider.status === 'stale' ? 'is using cached data' : 'is unavailable'}`
        )).join(' · ')
        : null;
      source = sourceLabel();
      if (!stale) lastUpdate = now();
      rowControlsListener?.();
      return true;
    } catch (caught) {
      if (controller.signal.aborted || caught?.name === 'AbortError') return true;
      error = cleanText(caught?.message, 180) || 'AR provider request failed';
      degraded = experiences.length > 0;
      stale = experiences.length > 0;
      available = experiences.length > 0;
      return true;
    } finally {
      signal?.removeEventListener?.('abort', forwardAbort);
      if (requestController === controller) requestController = null;
      if (generation === requestGeneration) {
        loading = false;
        rowControlsListener?.();
      }
    }
  }

  const layer = {
    id: AR_EXPERIENCES_LAYER_ID,
    name: 'AR Experiences',
    icon: '◇',
    source: 'AR providers',
    updateInterval: 120_000,

    init(targetViewer) {
      viewer = targetViewer;
      dataSource = new Cesium.CustomDataSource(AR_EXPERIENCES_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      registerPickOwner(AR_EXPERIENCES_LAYER_ID, (pickedId) => (
        experienceByEntityId.has(String(pickedId))
      ));
      installInteraction();
      removeMoveEnd = viewer.camera?.moveEnd?.addEventListener?.(() => {
        if (enabled) void update(viewer);
      }) || null;
      overlayHost.setVisible(AR_OVERLAY_SOURCE_ID, false);
      return true;
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(AR_OVERLAY_SOURCE_ID, true);
      render();
      return true;
    },

    disable() {
      enabled = false;
      requestController?.abort();
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(AR_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AR_OVERLAY_SOURCE_ID, false);
      return true;
    },

    update,

    destroy(targetViewer = viewer) {
      enabled = false;
      requestController?.abort();
      requestController = null;
      removeMoveEnd?.();
      removeMoveEnd = null;
      handler?.destroy?.();
      handler = null;
      unregisterPickOwner(AR_EXPERIENCES_LAYER_ID);
      overlayHost.clearSource(AR_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AR_OVERLAY_SOURCE_ID, false);
      if (dataSource) targetViewer?.dataSources?.remove?.(dataSource, true);
      dataSource = null;
      experienceByEntityId.clear();
      experienceByOverlayId.clear();
      providers = [];
      experiences = [];
      renderFingerprint = '';
      rowControlsListener = null;
      return true;
    },

    setParams(params = {}) {
      let shouldRefresh = false;
      let visibilityFilterChanged = false;
      if (Object.hasOwn(params, 'providers')) {
        const next = normalizeArProviderSelection(params.providers);
        if (next !== providerSelection) {
          providerSelection = next;
          shouldRefresh = true;
          visibilityFilterChanged = true;
        }
      }
      if (Object.hasOwn(params, 'includePast') && typeof params.includePast === 'boolean') {
        if (params.includePast !== includePast) {
          includePast = params.includePast;
          shouldRefresh = true;
          visibilityFilterChanged = true;
        }
      }
      if (!shouldRefresh) return true;
      if (visibilityFilterChanged) render();
      rowControlsListener?.();
      if (enabled && shouldRefresh) void update(viewer);
      return true;
    },

    getParams() {
      return {
        providers: providerSelection,
        includePast,
      };
    },

    getRowControls() {
      return { chips: createArProviderChips(providers, providerSelection, includePast) };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      return {
        count: experienceByEntityId.size,
        lastUpdate,
        source,
        loading,
        degraded,
        stale,
        available,
        status: !available && !loading ? 'unavailable' : undefined,
        error,
      };
    },
  };

  return layer;
}

const arExperiencesLayer = createArExperiencesLayer();

export default arExperiencesLayer;
