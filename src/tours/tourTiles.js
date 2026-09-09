/**
 * Tour visual readiness: tile settle, mesh coverage probe, overlay preload, prefetch.
 * @module tours/tourTiles
 */

import * as Cesium from 'cesium';
import { cachedGroundFloor, warmGroundFloor, corridorFloorCells } from '../data/groundFloor.js';
import {
  holdContinuousRender,
  releaseContinuousRender,
  governorRequestRender,
} from '../renderGovernor.js';

const PLAYBACK_HOLD = 'tour-playback';
const SETTLE_HOLD = 'tour-tiles-settle';
const PREFETCH_HOLD = 'tour-tiles-prefetch';

const MESH_SPARSE_DELTA_M = 7;
const DEFAULT_SPACE_ALT_M = 3.2e7;
const DEFAULT_ESTABLISH_ALT_M = 10000;
const DEFAULT_APPROACH_SEC = 12;

/**
 * @param {import('cesium').Viewer} viewer
 * @returns {import('cesium').Cesium3DTileset | null}
 */
export function resolveTourTileset(viewer) {
  try {
    const fromWindow = typeof window !== 'undefined'
      ? (window.__godsEyeView?.tileset || window.__godsEyeView?.mapStackController?.googleTileset)
      : null;
    if (fromWindow?.tilesLoaded !== undefined) return fromWindow;
  } catch { /* ignore */ }
  const primitives = viewer?.scene?.primitives;
  if (!primitives?.length) return null;
  for (let i = 0; i < primitives.length; i += 1) {
    const prim = primitives.get(i);
    if (prim && prim.tilesLoaded !== undefined && prim.show !== false) return prim;
  }
  return null;
}

export function holdTourPlaybackRender() {
  holdContinuousRender(PLAYBACK_HOLD);
}

export function releaseTourPlaybackRender() {
  releaseContinuousRender(PLAYBACK_HOLD);
}

export function getSpaceApproachParams(cam = {}) {
  return {
    spaceAlt: Number.isFinite(cam.spaceAlt) ? cam.spaceAlt : DEFAULT_SPACE_ALT_M,
    establishAlt: Number.isFinite(cam.alt) ? cam.alt : DEFAULT_ESTABLISH_ALT_M,
    approachSec: Number.isFinite(cam.approachSec)
      ? cam.approachSec
      : (Number.isFinite(cam.durationSec) && cam.durationSec >= 8 ? cam.durationSec : DEFAULT_APPROACH_SEC),
    heading: Number.isFinite(cam.heading) ? cam.heading : 20,
    pitch: Number.isFinite(cam.pitch) ? cam.pitch : -42,
  };
}

/**
 * After the camera arrives, wait until photoreal tiles for the *current* view
 * report loaded and stay quiet for stableMs.
 */
export async function waitForTourVisuals(viewer, {
  timeoutMs = 14000,
  stableMs = 500,
  minWaitMs = 200,
  isCancelled = () => false,
  onSlow,
} = {}) {
  const started = Date.now();
  let slowNotified = false;
  holdContinuousRender(SETTLE_HOLD);
  try {
    if (minWaitMs > 0) await sleep(minWaitMs);
    const tileset = resolveTourTileset(viewer);
    if (!tileset) {
      await sleep(350);
      return { ok: true, skipped: true, waitedMs: Date.now() - started };
    }

    let stableSince = null;
    while (Date.now() - started < timeoutMs) {
      if (isCancelled()) return { ok: false, cancelled: true, waitedMs: Date.now() - started };
      if (!slowNotified && Date.now() - started > 1500) {
        slowNotified = true;
        try { onSlow?.('Loading the view…'); } catch { /* ignore */ }
      }
      try { governorRequestRender('tour-tiles-settle'); } catch { /* optional */ }

      const loaded = tileset.tilesLoaded === true;
      const pending = readPendingRequests(tileset);
      const quiet = loaded && (pending == null || pending === 0);

      if (quiet) {
        if (stableSince == null) stableSince = Date.now();
        if (Date.now() - stableSince >= stableMs) {
          return { ok: true, waitedMs: Date.now() - started };
        }
      } else {
        stableSince = null;
      }
      await sleep(120);
    }
    return { ok: true, timedOut: true, waitedMs: Date.now() - started };
  } finally {
    releaseContinuousRender(SETTLE_HOLD);
  }
}

/**
 * Soft gate for app restore + enabled data layers so establish doesn't advance
 * while share/layer restore is still settling.
 */
export async function waitForTourAppReady({
  styleManager = null,
  timeoutMs = 5500,
  isCancelled = () => false,
  onStatus,
} = {}) {
  const started = Date.now();
  const gev = typeof window !== 'undefined' ? window.__godsEyeView : null;
  const sm = styleManager || gev?.styleManager || null;
  const dataManager = sm?._dataManager || gev?.dataManager || null;

  try { onStatus?.('Preparing layers…'); } catch { /* ignore */ }

  const tasks = [];
  if (sm?.initialRestorePromise && typeof sm.initialRestorePromise.then === 'function') {
    tasks.push(Promise.race([
      sm.initialRestorePromise.catch(() => null),
      sleep(timeoutMs),
    ]));
  }

  if (dataManager && typeof dataManager.getEnabledLayerIds === 'function'
    && typeof dataManager.waitForLayerSettled === 'function') {
    let enabled = [];
    try { enabled = dataManager.getEnabledLayerIds() || []; } catch { enabled = []; }
    // Cap how many layers we wait on — tour shouldn't block on every data feed.
    const waitIds = enabled.filter(Boolean).slice(0, 6);
    for (const layerId of waitIds) {
      tasks.push(Promise.race([
        dataManager.waitForLayerSettled(layerId).catch(() => null),
        sleep(Math.min(4000, timeoutMs)),
      ]));
    }
  }

  if (!tasks.length) {
    await sleep(200);
    return { ok: true, skipped: true, waitedMs: Date.now() - started };
  }

  await Promise.race([
    Promise.allSettled(tasks),
    sleep(timeoutMs),
    waitUntil(() => isCancelled(), timeoutMs),
  ]);

  if (isCancelled()) return { ok: false, cancelled: true, waitedMs: Date.now() - started };
  const timedOut = Date.now() - started >= timeoutMs - 50;
  if (timedOut) {
    try { onStatus?.('Still loading some layers…'); } catch { /* ignore */ }
  }
  return { ok: true, timedOut, waitedMs: Date.now() - started };
}

/**
 * Probe whether photoreal mesh at a hold is useful vs missing/sparse DEM skin.
 */
export async function probeTourMeshCoverage(viewer, { lat, lon } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !viewer?.scene) {
    return { quality: 'missing', reason: 'no_coords' };
  }
  try { warmGroundFloor([{ lat, lon }]); } catch { /* optional */ }
  await sleep(120);

  const demG = readDem(lat, lon);
  const offsets = [
    [0, 0],
    [0.0007, 0],
    [-0.0007, 0],
    [0, 0.0007],
    [0, -0.0007],
  ];
  const samples = [];
  for (const [dLat, dLon] of offsets) {
    const h = await sampleMeshHeight(viewer, lat + dLat, lon + dLon);
    if (Number.isFinite(h)) samples.push(h);
  }

  if (!samples.length) {
    // One retry after a short stream window.
    await sleep(700);
    try { governorRequestRender('tour-mesh-probe'); } catch { /* ignore */ }
    for (const [dLat, dLon] of offsets.slice(0, 3)) {
      const h = await sampleMeshHeight(viewer, lat + dLat, lon + dLon);
      if (Number.isFinite(h)) samples.push(h);
    }
  }

  if (!samples.length) {
    return { quality: 'missing', demG, meshH: null, reason: 'no_mesh_sample' };
  }

  const meshH = median(samples);
  if (!Number.isFinite(demG)) {
    return { quality: 'useful', demG, meshH, reason: 'mesh_without_dem' };
  }
  const delta = Math.abs(meshH - demG);
  if (delta < MESH_SPARSE_DELTA_M) {
    return { quality: 'sparse', demG, meshH, delta, reason: 'flat_vs_dem' };
  }
  return { quality: 'useful', demG, meshH, delta };
}

/**
 * Prefetch routes, annotations, and DEM corridor for a tour (mutates travel.polyline in memory).
 */
export async function preloadTourOverlays({
  tour,
  annotations = null,
  buildAnnotationRequests = null,
  fetchTourRoute = null,
  isCancelled = () => false,
} = {}) {
  if (!tour?.beats?.length) return { ok: false, error: 'no_tour' };
  const result = { ok: true, routes: 0, annotations: false, dem: 0 };

  // 1) Transit polylines
  if (typeof fetchTourRoute === 'function') {
    for (let i = 0; i < tour.beats.length; i += 1) {
      if (isCancelled()) return { ...result, ok: false, cancelled: true };
      const beat = tour.beats[i];
      const needsRoute = beat.kind === 'transit'
        || beat.camera?.mode === 'routeDolly'
        || beat.travel;
      if (!needsRoute) continue;
      if (Array.isArray(beat.travel?.polyline) && beat.travel.polyline.length >= 2) continue;
      const prev = tour.beats.slice(0, i).reverse().find((b) => Number.isFinite(b?.place?.lat));
      const from = prev?.place || (Number.isFinite(prev?.camera?.lat)
        ? { lat: prev.camera.lat, lon: prev.camera.lon }
        : null);
      const to = beat.place || (Number.isFinite(beat.camera?.lat)
        ? { lat: beat.camera.lat, lon: beat.camera.lon }
        : null);
      if (!from || !to) continue;
      try {
        const routed = await fetchTourRoute(from, to);
        if (routed?.ok && Array.isArray(routed.polyline) && routed.polyline.length >= 2) {
          if (!beat.travel) beat.travel = {};
          beat.travel.polyline = routed.polyline;
          if (routed.mode) beat.travel.mode = routed.mode;
          result.routes += 1;
        }
      } catch { /* continue */ }
    }
  }

  // 2) Establish annotations (warm resolver + draw early if engine provided)
  if (annotations?.annotate && typeof buildAnnotationRequests === 'function') {
    const establish = tour.beats.find((b) => b.kind === 'establish') || tour.beats[0];
    const authored = Array.isArray(establish?.annotations) ? establish.annotations : null;
    const requests = authored?.length ? authored : buildAnnotationRequests(tour, establish);
    if (requests?.length) {
      try {
        await annotations.annotate(requests, {
          persist: true,
          flyTo: false,
          clearPrevious: true,
        });
        result.annotations = true;
      } catch { /* optional */ }
    }
  }

  // 3) DEM corridor warm
  const places = collectUpcomingTourPlaces(tour, 0, { count: 8, routeSamples: 8 });
  try {
    warmGroundFloor(places);
    result.dem = places.length;
    const polys = tour.beats
      .map((b) => b.travel?.polyline)
      .filter((p) => Array.isArray(p) && p.length >= 2);
    for (const poly of polys.slice(0, 4)) {
      try {
        const cells = corridorFloorCells(poly);
        if (cells?.length) warmGroundFloor(cells);
      } catch { /* optional */ }
    }
  } catch { /* optional */ }

  return result;
}

/**
 * Prioritize streaming for upcoming tour places while they are in frustum.
 */
export async function prefetchTourPlaces(viewer, places, {
  timeoutMs = 9000,
  isCancelled = () => false,
} = {}) {
  const list = normalizePlaces(places);
  if (!list.length) return { ok: true, count: 0 };
  try { warmGroundFloor(list); } catch { /* optional */ }

  const scene = viewer?.scene;
  if (!scene || typeof scene.sampleHeightMostDetailed !== 'function') {
    return { ok: true, count: list.length, demOnly: true };
  }

  holdContinuousRender(PREFETCH_HOLD);
  try {
    if (isCancelled()) return { ok: false, cancelled: true };
    const cartos = list.map((p) => Cesium.Cartographic.fromDegrees(p.lon, p.lat));
    try { governorRequestRender('tour-tiles-prefetch'); } catch { /* optional */ }
    await Promise.race([
      scene.sampleHeightMostDetailed(cartos).catch(() => null),
      sleep(timeoutMs),
      waitUntil(() => isCancelled(), timeoutMs),
    ]);
    return { ok: !isCancelled(), count: list.length };
  } finally {
    releaseContinuousRender(PREFETCH_HOLD);
  }
}

/** Collect lat/lon targets from upcoming beats (places + camera + route samples). */
export function collectUpcomingTourPlaces(tour, fromIndex, { count = 4, routeSamples = 4 } = {}) {
  const beats = tour?.beats || [];
  const out = [];
  const seen = new Set();
  const push = (lat, lon) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ lat, lon });
  };

  for (let i = fromIndex; i < beats.length && out.length < count * 3; i += 1) {
    const beat = beats[i];
    push(beat?.place?.lat, beat?.place?.lon);
    push(beat?.camera?.lat, beat?.camera?.lon);
    const poly = beat?.travel?.polyline;
    if (Array.isArray(poly) && poly.length >= 2 && routeSamples > 0) {
      const step = Math.max(1, Math.floor((poly.length - 1) / routeSamples));
      for (let p = 0; p < poly.length; p += step) {
        push(poly[p]?.lat, poly[p]?.lon);
      }
      const last = poly[poly.length - 1];
      push(last?.lat, last?.lon);
    }
  }
  return out.slice(0, Math.max(count, routeSamples + count));
}

export function isCloseHoldBeat(beat) {
  if (!beat) return false;
  if (beat.kind === 'establish') return false;
  const mode = beat.camera?.mode || (beat.kind === 'transit' ? 'routeDolly' : 'lookAt');
  if (mode === 'flyTo') {
    const alt = beat.camera?.alt;
    return Number.isFinite(alt) ? alt < 4000 : false;
  }
  // Gallery playback jumps to the place (no route dolly), so transit needs the
  // same mesh probe as holds before a close cinematic shot starts.
  if (mode === 'routeDolly') return beat.kind === 'transit' || beat.kind === 'hold';
  return mode === 'lookAt' || mode === 'orbitHold' || beat.kind === 'hold' || beat.kind === 'transit';
}

function readDem(lat, lon) {
  try {
    const v = cachedGroundFloor?.(lat, lon);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

async function sampleMeshHeight(viewer, lat, lon) {
  const scene = viewer?.scene;
  if (!scene) return null;
  try {
    if (typeof scene.sampleHeightMostDetailed === 'function') {
      const carto = Cesium.Cartographic.fromDegrees(lon, lat);
      const result = await Promise.race([
        scene.sampleHeightMostDetailed([carto]),
        sleep(1500).then(() => null),
      ]);
      const height = Array.isArray(result) ? result[0]?.height : carto.height;
      return Number.isFinite(height) ? height : null;
    }
  } catch { /* fall through */ }
  try {
    if (typeof scene.sampleHeight === 'function') {
      const carto = Cesium.Cartographic.fromDegrees(lon, lat);
      const height = scene.sampleHeight(carto);
      return Number.isFinite(height) ? height : null;
    }
  } catch { /* ignore */ }
  return null;
}

function readPendingRequests(tileset) {
  try {
    const stats = tileset.statistics;
    if (stats && Number.isFinite(stats.numberOfPendingRequests)) {
      return stats.numberOfPendingRequests;
    }
  } catch { /* ignore */ }
  return null;
}

function normalizePlaces(places) {
  if (!Array.isArray(places)) return [];
  return places.filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(100);
  }
  return false;
}
