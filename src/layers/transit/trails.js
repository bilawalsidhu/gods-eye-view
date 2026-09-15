import { getRegisteredTransitFeed } from '../../data/transitFeeds.js';
import * as Cesium from 'cesium';
import {
  readFix,
  correctHeight,
  FIX_FLAGS,
  mergeHistory,
} from '../../data/contactPlayback.js';
import { createContactTrailRenderer } from '../../data/contactTrailRenderer.js';
import { fixDistanceM } from './movement.js';
import { transitStyleProfile } from '../../data/transitPresetStyle.js';

const MODE_COLOR = {
  bus: '#5EF08A',
  tram: '#FFC24A',
  subway: '#FF4538',
  rail: '#D9A6FF',
  ferry: '#5FD6FF',
  unknown: '#D8DDE5',
};
// Two ground lanes use up to 2,704 bytes per edge before instance attributes.
// Reserve head geometry and batch attributes inside the 2 MiB rebuild budget.
export const TRAIL_VERTEX_LIMIT = 640;
const STEP_M = 25;

/** Shared prepared paths. Floors are aligned to work with Google 3D tiles. */
export function createTrails({ state, services, parts, source }) {
  let historyRequest = null;
  let requestCount = 0,
    abortCount = 0;
  let renderer = null,
    selected = null,
    fadeTimer = null,
    revision = 0;
  function ensureRenderer() {
    if (!renderer && state._viewer)
      renderer = createContactTrailRenderer(state._viewer.scene);
    return renderer;
  }
  function style() {
    renderer?.setStyle(
      transitStyleProfile(state._stylePreset) === 'mono'
        ? '#FFFFFF'
        : MODE_COLOR[selected?.mode] || MODE_COLOR.unknown,
    );
  }
  function releaseSelectionGeometry(entry) {
    entry.trailSegments = [];
    entry.trailVertices = 0;
    entry.trailTruncated = false;
    entry.pathRevision = -1;
    entry.markerPathSeq = NaN;
    pruneMarkerPaths(entry, entry.sample);
  }
  function pruneMarkerPaths(entry, sample) {
    if (entry === selected || entry.markerPathSeq === sample.fromSeq) return;
    entry.markerPathSeq = sample.fromSeq;
    for (const seq of entry.displayPaths?.keys() || [])
      if (seq < sample.fromSeq) entry.displayPaths.delete(seq);
  }
  /** Runs only after reports, selection, or surface rereads. */
  function prepareEntry(entry, collect = null) {
    if (!entry.track?.count) return;
    if (entry !== selected) {
      entry.trailSegments = [];
      entry.trailVertices = 0;
    }
    const paths = new Map(),
      all = [],
      a = {},
      b = {};
    let vertices = 0,
      signature = '';
    const floor = (point) => {
      const answer = parts.height.requestHeight(point.lat, point.lon, entry);
      if (collect) collect(point, answer);
      return answer.height;
    };
    // Selected active corridor gets first access to both surface budgets.
    if (collect && entry.key === state._selectedKey) {
      readFix(
        entry.track,
        Math.max(0, entry.sample.fromSeq - entry.track.baseSeq),
        a,
      );
      readFix(
        entry.track,
        Math.max(0, entry.sample.toSeq - entry.track.baseSeq),
        b,
      );
      const n = Math.min(
        TRAIL_VERTEX_LIMIT - 1,
        Math.max(1, Math.ceil(fixDistanceM(a, b) / STEP_M)),
      );
      for (let i = 0; i <= n; i++)
        floor({
          lat: a.lat + ((b.lat - a.lat) * i) / n,
          lon: a.lon + ((b.lon - a.lon) * i) / n,
        });
    }
    for (let i = 0; i < entry.track.count; i++) {
      readFix(entry.track, i, a);
      const h = floor(a);
      if (h !== null) correctHeight(entry.track, a.seq, h);
    }
    const order = [];
    const activeIndex = Math.max(
      0,
      Math.min(
        entry.track.count - 2,
        entry.sample.fromSeq - entry.track.baseSeq,
      ),
    );
    for (let i = activeIndex; i + 1 < entry.track.count; i++) order.push(i);
    if (entry === selected)
      for (let i = activeIndex - 1; i >= 0; i--) order.push(i);
    entry.trailTruncated = false;
    for (const i of order) {
      readFix(entry.track, i, a);
      readFix(entry.track, i + 1, b);
      if (a.epoch !== b.epoch || b.flags & FIX_FLAGS.BREAK) continue;
      if (entry !== selected && b.t < entry.sample.displayT) continue;
      const n = Math.max(1, Math.ceil(fixDistanceM(a, b) / STEP_M));
      if (vertices + n + 1 > TRAIL_VERTEX_LIMIT) {
        entry.trailTruncated = true;
        continue;
      }
      const positions = [],
        heights = [];
      let valid = true;
      for (let k = 0; k <= n; k++) {
        const fraction = k / n;
        const point = {
          lat: a.lat + (b.lat - a.lat) * fraction,
          lon: a.lon + (((b.lon - a.lon + 540) % 360) - 180) * fraction,
        };
        const h = floor(point);
        heights.push(h);
        if (h === null) {
          valid = false;
          positions.push(null);
        } else
          positions.push(
            Cesium.Cartesian3.fromDegrees(point.lon, point.lat, h),
          );
      }
      signature += `${a.seq}/${b.seq}:${heights.join(',')};`;
      vertices += n + 1;
      if (!valid) continue;
      paths.set(a.seq, { positions, toSeq: b.seq });
      if (entry === selected && fixDistanceM(a, b) > 0) {
        for (let k = 0; k < n; k++)
          all.push({
            fromSeq: a.seq,
            toSeq: b.seq,
            fromT: a.t + ((b.t - a.t) * k) / n,
            toT: a.t + ((b.t - a.t) * (k + 1)) / n,
            positions: [positions[k], positions[k + 1]],
          });
      }
    }
    const changed =
      entry.pathSignature !== signature ||
      entry.pathRevision !== entry.track.revision;
    if (changed) {
      entry.displayPaths = paths;
      entry.pathSignature = signature;
      entry.pathRevision = entry.track.revision;
      state._heightDirty.add(entry);
      if (entry === selected) {
        all.sort((a, b) => a.fromT - b.fromT);
        ensureRenderer()?.replaceHistory({
          segments: all,
          revision: ++revision,
        });
        entry.trailVertices = vertices;
        entry.trailSegments = all;
        services.render.governorRequestRender('transit-trail-history');
      }
    }
    return changed;
  }
  /** Allocation-free sampling of the exact path also used by the trail. */
  function samplePosition(
    entry,
    sample,
    out,
    nearGround = parts.height.nearGround(),
  ) {
    pruneMarkerPaths(entry, sample);
    if (!nearGround) {
      const a = entry.fromCart,
        b = entry.toCart,
        f = sample.fraction;
      out.x = a.x + (b.x - a.x) * f;
      out.y = a.y + (b.y - a.y) * f;
      out.z = a.z + (b.z - a.z) * f;
      return out;
    }
    if (sample.fromSeq === sample.toSeq) {
      if (!Number.isFinite(entry.segment.from.h)) return null;
      Cesium.Cartesian3.clone(entry.fromCart, out);
      return out;
    }
    const path = entry.displayPaths?.get(sample.fromSeq);
    if (!path || path.toSeq !== sample.toSeq) return null;
    const scaled = sample.fraction * (path.positions.length - 1);
    const index = Math.min(path.positions.length - 2, Math.floor(scaled));
    // Keep scalar interpolation in this frame function. Passing the changing
    // fraction to the general Cesium helper boxes it in sampled V8 stacks.
    const a = path.positions[index],
      b = path.positions[index + 1],
      f = scaled - index;
    out.x = a.x + (b.x - a.x) * f;
    out.y = a.y + (b.y - a.y) * f;
    out.z = a.z + (b.z - a.z) * f;
    return out;
  }
  function update() {
    if (!selected || !renderer) return;
    renderer.setVisible(state._enabled && selected.marker?.show !== false);
    renderer.setDisplaySample(selected.sample, selected.marker?.position);
  }
  function select(entry) {
    clear();
    selected = entry;
    ensureRenderer();
    style();
    entry.pathRevision = -1;
    prepareEntry(entry);
    update();
    const feed = getRegisteredTransitFeed(entry.feedId);
    if (feed?.historyRetention) {
      const controller = new AbortController();
      historyRequest = controller;
      requestCount++;
      source
        .getHistory(entry.feedId, entry.record.id, {
          signal: controller.signal,
        })
        .then((payload) => {
          if (
            controller.signal.aborted ||
            !state._enabled ||
            selected !== entry ||
            historyRequest !== controller
          )
            return;
          const mapping = new Map();
          for (const epoch of payload.epochs) {
            let id = null;
            for (const [candidate, context] of entry.track.epochs) {
              if (
                context.trip === epoch.trip &&
                context.route === epoch.route &&
                context.mode === epoch.mode
              ) {
                id = candidate;
                break;
              }
            }
            if (id === null) {
              id = Math.max(0, ...entry.track.epochs.keys()) + 1;
              entry.track.epochs.set(id, {
                trip: epoch.trip,
                route: epoch.route,
                mode: epoch.mode,
              });
            }
            mapping.set(epoch.id, id);
          }
          mergeHistory(
            entry.track,
            payload.fixes.map(([t, lat, lon, flags, epoch]) => ({
              t,
              lat,
              lon,
              flags,
              epoch: mapping.get(epoch),
            })),
          );
          entry.track.truncated ||= payload.truncated;
          entry.pathRevision = -1;
          parts.height.anchorFloors();
          prepareEntry(entry);
          update();
          services.render.governorRequestRender('transit-trail-backfill');
        })
        .catch(() => {
          // Session history remains usable if the optional retained read fails.
        })
        .finally(() => {
          if (historyRequest === controller) historyRequest = null;
        });
    }
    fadeTimer = setInterval(() => {
      if (!state._enabled || selected !== entry) return;
      parts.rendering.sampleIdle(entry);
      update();
      services.render.governorRequestRender('transit-trail-age');
    }, 1000);
  }
  function clear() {
    if (historyRequest) {
      historyRequest.abort();
      abortCount++;
      historyRequest = null;
    }
    if (fadeTimer != null) clearInterval(fadeTimer);
    fadeTimer = null;
    const previous = selected;
    selected = null;
    if (previous) releaseSelectionGeometry(previous);
    renderer?.destroy();
    renderer = null;
  }
  return {
    prepareEntry,
    samplePosition,
    select,
    clear,
    update,
    style,
    destroy: clear,
    requestDiagnostics: () => ({
      requestCount,
      abortCount,
      pending: historyRequest !== null,
    }),
    diagnostics: () => renderer?.diagnostics() || null,
  };
}
