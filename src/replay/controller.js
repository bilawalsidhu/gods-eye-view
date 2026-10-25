import * as Cesium from 'cesium';
import { buildTicks, groupTracks, replayWindow, tickIndexAt } from './model.js';

const LIVE_LAYERS = ['flights', 'military', 'ais-live-vessels'];
const LAYER_COLORS = {
  air: '#00d4ff',
  mil: '#ffb000',
  vessel: '#4dff9a',
};
const TRAIL_SECONDS = 600;
const SPEEDS = [1, 10, 100];
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
  let speed = SPEEDS[1];
  let hidden = [];
  let savedClock = null;
  let lastNotify = 0;
  let destroyed = false;
  let windowHours = 6;
  let rawRange = null;
  let status = null;
  let contacts = 0;
  const layers = new Set(['air', 'mil', 'vessel']);

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
      range = replayWindow(rawRange, windowHours);
    } catch {
      status = rawRange = range = null;
    }
    notify();
    return range;
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
      const window = (await refreshRange()) || null;
      if (!window) throw new Error('Nothing recorded yet');
      const query = new URLSearchParams({
        from: String(Math.floor(window.fromSec)),
        to: String(Math.floor(window.toSec)),
        layers: [...layers].join(','),
      });
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
      await exit();
      listeners.clear();
    },
  };
}
