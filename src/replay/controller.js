import * as Cesium from 'cesium';
import { msg, t } from '../i18n/index.js';
import { initImageryBoxTool } from '../ui/imageryBoxTool.js';
import { buildTicks, groupTracks, replayWindow, tickIndexAt } from './model.js';

const LIVE_LAYERS = ['flights', 'military', 'ais-live-vessels'];
const LAYER_COLORS = {
  air: '#00d4ff',
  mil: '#ffb000',
  vessel: '#4dff9a',
  local: '#c77dff',
};
const TRAIL_SECONDS = 600;
const SPEEDS = [0.5, 1, 2, 5, 10, 30, 60];
const WINDOW_HOURS = [1, 6, 24];
const NOTIFY_MS = 250;

/**
 * Replays recorded positions on the globe. Each contact becomes an entity with
 * a sampled position, and the slider moves the viewer clock, so Cesium does the
 * animating. Live layers are switched off while replaying and restored after.
 */
export function createReplayController({
  viewer,
  dataManager,
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const listeners = new Set();
  let source = null;
  let ticks = [];
  let range = null;
  let active = false;
  let loading = false;
  let error = '';
  let speed = 10;
  let hidden = [];
  let savedClock = null;
  let lastNotify = 0;
  let destroyed = false;
  let windowHours = 6;
  let rawRange = null;
  let status = null;
  let contacts = 0;
  let events = [];
  let fences = [];
  let drawing = false;
  let hint = '';
  let boxTool = null;
  let boxMode = 'fence';
  let region = null;
  let customFromSec = null;
  let track = null;
  let trackPoints = [];
  const trackSource = new Cesium.CustomDataSource('replay-track');
  viewer.dataSources.add(trackSource);
  const fenceSource = new Cesium.CustomDataSource('replay-fences');
  viewer.dataSources.add(fenceSource);
  const layers = new Set(['air', 'mil', 'vessel', 'local']);

  const state = () => ({
    active,
    loading,
    error,
    ticks,
    speed,
    speeds: SPEEDS,
    layers: [...layers],
    range,
    status,
    events,
    fences,
    drawing,
    region,
    track,
    customFromSec,
    hint,
    contacts,
    windowHours,
    windows: WINDOW_HOURS,
    playing: active && viewer.clock.shouldAnimate,
    index: active ? tickIndexAt(ticks, currentMs()) : ticks.length - 1,
    timeMs: active ? currentMs() : Date.now(),
  });
  const currentMs = () =>
    Cesium.JulianDate.toDate(viewer.clock.currentTime).getTime();
  const notify = () => {
    lastNotify = Date.now();
    for (const listener of listeners) listener(state());
  };
  // Clicking a replayed contact follows it; its trail keeps drawing.
  const onSelect = (entity) => {
    if (active && String(entity?.id).startsWith('replay:'))
      viewer.trackedEntity = entity;
  };
  const onTick = () => {
    if (!active) return;
    const end = Date.parse(ticks.at(-1));
    if (currentMs() >= end) viewer.clock.shouldAnimate = false;
    if (Date.now() - lastNotify > NOTIFY_MS) notify();
  };

  async function getJson(path) {
    const response = await fetchImpl(path);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  /** Ask the recorder what it holds; resolves to the replay window, or null. */
  async function refreshRange() {
    try {
      status = await getJson('/api/history/status');
      rawRange = status;
      events = (await getJson('/api/history/events?limit=5')).events;
      fences = (await getJson('/api/history/fences')).fences;
      drawFences();
      range = replayWindow(rawRange, windowHours);
    } catch {
      status = rawRange = range = null;
      events = [];
      fences = [];
      drawFences();
    }
    notify();
    return range;
  }

  /** Show each watched area as an outlined box on the map. */
  function drawFences() {
    fenceSource.entities.removeAll();
    const color = Cesium.Color.fromCssColorString('#8be9ff');
    for (const f of fences) {
      const west = f.west;
      const east = f.west <= f.east ? f.east : f.east + 360;
      const corners = Cesium.Cartesian3.fromDegreesArray([
        west,
        f.south,
        east,
        f.south,
        east,
        f.north,
        west,
        f.north,
        west,
        f.south,
      ]);
      // A ground-draped rectangle cannot draw an outline, so the edge is its
      // own dashed polyline, as in the imagery box tool.
      fenceSource.entities.add({
        id: `replay-fence:${f.id}`,
        name: f.name,
        rectangle: {
          coordinates: Cesium.Rectangle.fromDegrees(
            west,
            f.south,
            east,
            f.north,
          ),
          material: color.withAlpha(0.18),
          classificationType: Cesium.ClassificationType.BOTH,
        },
      });
      fenceSource.entities.add({
        id: `replay-fence-edge:${f.id}`,
        name: f.name,
        polyline: {
          positions: corners,
          width: 2,
          clampToGround: true,
          classificationType: Cesium.ClassificationType.BOTH,
          material: new Cesium.PolylineDashMaterialProperty({
            color: color.withAlpha(0.95),
            dashLength: 12,
          }),
        },
      });
    }
    viewer.scene.requestRender?.();
  }

  async function sendJson(path, init) {
    const response = await fetchImpl(path, {
      ...init,
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function addFence(box) {
    try {
      await sendJson('/api/history/fences', {
        method: 'POST',
        body: JSON.stringify({
          name: `Area ${fences.reduce((m, f) => Math.max(m, f.id), 0) + 1}`,
          ...box,
          layers: [],
        }),
      });
      hint = '';
    } catch {
      hint = msg('Could not save the area');
    }
    await refreshRange();
  }

  const REGION_COLOR = '#ffb000';
  const regionSource = new Cesium.CustomDataSource('replay-region');
  viewer.dataSources.add(regionSource);

  async function setRegion(box) {
    region = box;
    regionSource.entities.removeAll();
    if (box)
      regionSource.entities.add({
        id: 'replay-region',
        rectangle: {
          coordinates: Cesium.Rectangle.fromDegrees(
            box.west,
            box.south,
            box.east,
            box.north,
          ),
          material:
            Cesium.Color.fromCssColorString(REGION_COLOR).withAlpha(0.1),
          outline: false,
          classificationType: Cesium.ClassificationType.BOTH,
        },
      });
    viewer.scene.requestRender?.();
    if (active) await enter();
    else notify();
  }

  /** Draw a contact's whole recorded path, its first and last fix, and gaps. */
  function drawTrack() {
    trackSource.entities.removeAll();
    if (track) {
      const at = (p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt || 0);
      const gold = Cesium.Color.fromCssColorString('#ffd24d');
      const red = Cesium.Color.fromCssColorString('#ff5c5c');
      trackSource.entities.add({
        id: 'replay-track:path',
        polyline: { positions: trackPoints.map(at), width: 3, material: gold },
      });
      const byTs = new Map(trackPoints.map((p) => [p.ts, p]));
      track.gaps.forEach((gap, i) => {
        const a = byTs.get(gap.from);
        const b = byTs.get(gap.to);
        if (a && b)
          trackSource.entities.add({
            id: `replay-track:gap:${i}`,
            polyline: {
              positions: [at(a), at(b)],
              width: 3,
              material: new Cesium.PolylineDashMaterialProperty({
                color: red,
                dashLength: 10,
              }),
            },
          });
      });
      for (const [key, p, label, color] of [
        ['first', track.first, t('FIRST'), '#4dff9a'],
        ['last', track.last, t('LAST'), '#ff5c5c'],
      ])
        trackSource.entities.add({
          id: `replay-track:${key}`,
          position: at(p),
          point: {
            pixelSize: 9,
            color: Cesium.Color.fromCssColorString(color),
          },
          label: {
            text: label,
            font: '11px monospace',
            pixelOffset: new Cesium.Cartesian2(0, -16),
            fillColor: Cesium.Color.WHITE,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          },
        });
    }
    viewer.scene.requestRender?.();
  }

  async function findTrack(rawId) {
    const id = String(rawId ?? '').trim();
    track = null;
    trackPoints = [];
    hint = '';
    if (id) {
      try {
        const to = Math.floor(Date.now() / 1000) + 60;
        const data = await getJson(
          `/api/history/track/${encodeURIComponent(id)}?from=0&to=${to}`,
        );
        if (data.points.length) {
          trackPoints = data.points;
          track = {
            id,
            count: data.count,
            first: data.first,
            last: data.last,
            gaps: data.gaps,
          };
        } else hint = msg('No recorded track for that identifier');
      } catch {
        hint = msg('Search failed');
      }
    }
    drawTrack();
    if (track) viewer.flyTo(trackSource, { duration: 1.5 });
    notify();
  }

  function buildEntities(points) {
    const next = new Cesium.CustomDataSource('replay');
    for (const track of groupTracks(points).values()) {
      if (track.points.length < 2 || !layers.has(track.layer)) continue;
      const position = new Cesium.SampledPositionProperty();
      for (const p of track.points)
        position.addSample(
          Cesium.JulianDate.fromDate(new Date(p.ts * 1000)),
          Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt || 0),
        );
      const color = Cesium.Color.fromCssColorString(
        LAYER_COLORS[track.layer] || '#ffffff',
      );
      next.entities.add({
        id: `replay:${track.layer}:${track.id}`,
        name: track.id,
        availability: new Cesium.TimeIntervalCollection([
          new Cesium.TimeInterval({
            start: Cesium.JulianDate.fromDate(
              new Date(track.points[0].ts * 1000),
            ),
            stop: Cesium.JulianDate.fromDate(
              new Date(track.points.at(-1).ts * 1000),
            ),
          }),
        ]),
        position,
        point: { pixelSize: 5, color },
        path: {
          resolution: 30,
          trailTime: TRAIL_SECONDS,
          leadTime: 0,
          width: 1.5,
          material: color.withAlpha(0.6),
        },
      });
    }
    return next;
  }

  async function setLive(on) {
    if (on) {
      hidden = LIVE_LAYERS.filter(
        (id) => dataManager?.layers?.get(id)?.enabled,
      );
      await Promise.all(hidden.map((id) => dataManager.setEnabled(id, false)));
    } else {
      const restore = hidden;
      hidden = [];
      await Promise.all(restore.map((id) => dataManager?.setEnabled(id, true)));
    }
  }

  async function enter() {
    if (destroyed || loading) return;
    loading = true;
    error = '';
    notify();
    try {
      let window = (await refreshRange()) || null;
      if (!window) throw new Error('Nothing recorded yet');
      if (customFromSec != null) {
        const fromSec = Math.max(
          rawRange.from_ts,
          Math.min(customFromSec, rawRange.to_ts - 60),
        );
        window = {
          fromSec,
          toSec: Math.min(rawRange.to_ts, fromSec + windowHours * 3600),
        };
      }
      const query = new URLSearchParams({
        from: String(Math.floor(window.fromSec)),
        to: String(Math.floor(window.toSec)),
        layers: [...layers].join(','),
      });
      if (region)
        query.set(
          'bbox',
          [region.west, region.south, region.east, region.north].join(','),
        );
      const { points } = await getJson(`/api/history/window?${query}`);
      if (destroyed) return;
      if (!active) {
        await setLive(true);
        const c = viewer.clock;
        savedClock = {
          current: c.currentTime.clone(),
          start: c.startTime.clone(),
          stop: c.stopTime.clone(),
          range: c.clockRange,
          multiplier: c.multiplier,
          animate: c.shouldAnimate,
        };
        viewer.clock.onTick.addEventListener(onTick);
        viewer.selectedEntityChanged.addEventListener(onSelect);
      }
      if (source) viewer.dataSources.remove(source, true);
      source = buildEntities(points);
      contacts = source.entities.values.length;
      await viewer.dataSources.add(source);
      ticks = buildTicks(window.fromSec * 1000, window.toSec * 1000);
      const c = viewer.clock;
      c.startTime = Cesium.JulianDate.fromDate(new Date(ticks[0]));
      c.stopTime = Cesium.JulianDate.fromDate(new Date(ticks.at(-1)));
      c.currentTime = c.startTime.clone();
      c.clockRange = Cesium.ClockRange.CLAMPED;
      c.multiplier = speed;
      c.shouldAnimate = false;
      active = true;
      viewer.scene.requestRender?.();
    } catch {
      error = 'failed';
    } finally {
      loading = false;
      notify();
    }
  }

  async function exit() {
    customFromSec = null;
    if (!active) return;
    active = false;
    viewer.clock.onTick.removeEventListener(onTick);
    viewer.selectedEntityChanged.removeEventListener(onSelect);
    if (String(viewer.trackedEntity?.id).startsWith('replay:'))
      viewer.trackedEntity = undefined;
    if (source) viewer.dataSources.remove(source, true);
    source = null;
    if (savedClock) {
      const c = viewer.clock;
      c.startTime = savedClock.start;
      c.stopTime = savedClock.stop;
      c.currentTime = savedClock.current;
      c.clockRange = savedClock.range;
      c.multiplier = savedClock.multiplier;
      c.shouldAnimate = savedClock.animate;
      savedClock = null;
    }
    await setLive(false);
    viewer.scene.requestRender?.();
    notify();
  }

  function seek(index) {
    if (!active || !ticks[index]) return;
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(
      new Date(ticks[index]),
    );
    viewer.scene.requestRender?.();
    notify();
  }

  // Keep alerts and fences fresh while the page is open.
  const poll = setInterval(() => {
    if (!destroyed && !loading) refreshRange();
  }, 15000);

  return {
    state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refreshRange,
    enter,
    exit,
    seek,
    step(direction) {
      seek(Math.max(0, Math.min(ticks.length - 1, state().index + direction)));
    },
    togglePlay() {
      if (!active) return;
      const c = viewer.clock;
      if (!c.shouldAnimate && currentMs() >= Date.parse(ticks.at(-1))) seek(0);
      c.shouldAnimate = !c.shouldAnimate;
      notify();
    },
    /** Fly the camera to the replayed contacts. */
    fit() {
      if (source?.entities.values.length)
        viewer.flyTo(source, { duration: 1.5 });
    },
    async setWindowHours(hours) {
      if (!WINDOW_HOURS.includes(hours)) return;
      windowHours = hours;
      range = replayWindow(rawRange, windowHours);
      if (active) await enter();
      else notify();
    },
    /** Replay from this time (epoch ms) instead of the newest history. */
    async jumpTo(ms) {
      if (!Number.isFinite(ms) || !rawRange?.from_ts) return;
      customFromSec = ms / 1000;
      await enter();
    },
    findTrack,
    /** Limit replay to a drawn box; a second call clears it. */
    region() {
      if (region) return setRegion(null);
      return this.watch('region');
    },
    /** Draw a box on the globe to watch; a second call cancels. */
    watch(mode = 'fence') {
      boxMode = mode;
      boxTool ??= initImageryBoxTool({
        viewer,
        onBox: (box) => (boxMode === 'region' ? setRegion(box) : addFence(box)),
        onCancel: (_reason, message) => {
          hint = message || '';
          notify();
        },
        onActive: (on) => {
          drawing = on;
          if (on) hint = '';
          notify();
        },
      });
      if (!boxTool) return;
      if (boxTool.isActive()) boxTool.cancel('toggle');
      else boxTool.start();
    },
    async removeFence(id) {
      try {
        await sendJson(`/api/history/fences/${id}`, { method: 'DELETE' });
      } catch {
        hint = msg('Could not remove the area');
      }
      await refreshRange();
    },
    setSpeed(value) {
      if (!SPEEDS.includes(value)) return;
      speed = value;
      if (active) viewer.clock.multiplier = value;
      notify();
    },
    async toggleLayer(layer) {
      if (layers.has(layer) && layers.size > 1) layers.delete(layer);
      else layers.add(layer);
      if (active) await enter();
      else notify();
    },
    async destroy() {
      destroyed = true;
      clearInterval(poll);
      await boxTool?.destroy();
      viewer.dataSources.remove(fenceSource, true);
      viewer.dataSources.remove(trackSource, true);
      viewer.dataSources.remove(regionSource, true);
      await exit();
      listeners.clear();
    },
  };
}
