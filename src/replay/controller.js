import { inputFor } from '../input/dispatcher.js';
import { msg } from '../i18n/index.js';
import { cameraOf, frameOf } from '../render/rendererOf.js';
import { initImageryBoxTool } from '../ui/imageryBoxTool.js';
import { createAnalysis } from './analysis.js';
import { createReplayClock } from './clock.js';
import { CONTACT_SET, createContacts } from './contacts.js';
import {
  buildTicks,
  classifyGaps,
  feedOutages,
  replayWindow,
  tickIndexAt,
} from './model.js';
import { createOverlays } from './overlays.js';
import { boundingSphere, ecefOf } from './sampling.js';

// Live layer id -> recorded layer that replaces it.
const LIVE_LAYERS = {
  flights: 'air',
  military: 'mil',
  'ais-live-vessels': 'vessel',
  satellites: 'sat',
};
const LAYER_COLORS = {
  air: '#00d4ff',
  mil: '#ffb000',
  vessel: '#4dff9a',
  local: '#c77dff',
  sat: '#ff5ea8',
};
const SPEEDS = [0.5, 1, 2, 5, 10, 30, 60];
const WINDOW_HOURS = [1, 6, 24];
const NOTIFY_MS = 250;
const FOLLOW_EASE_MS = 2000;

/**
 * Replays recorded positions on the globe through the renderer contract. Each
 * contact is a point placed where its recording puts it at the replay time
 * (`replay/contacts`), and the slider moves the replay clock (`replay/clock`),
 * which sets the scene's time. Live layers are switched off while replaying and
 * restored after.
 */
export function createReplayController({
  viewer,
  dataManager,
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const listeners = new Set();
  let ticks = [];
  let range = null;
  let active = false;
  let loading = false;
  let error = '';
  let speed = 10;
  let hidden = [];
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
  let pins = [];
  let trackPoints = [];
  const camera = cameraOf(viewer);
  const overlays = createOverlays(viewer);
  const contactDraw = createContacts(viewer, LAYER_COLORS);
  const clock = createReplayClock({ viewer, onTick: (ms) => tick(ms) });
  let stopClicks = null;
  const layers = new Set(['air', 'mil', 'vessel', 'local', 'sat']);

  const state = () => {
    const analysisState = analysis.state();
    return {
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
      pins,
      customFromSec,
      hint: hint || analysisState.hint,
      heat: analysisState.heat,
      compare: analysisState.compare,
      analysisBusy: analysisState.busy,
      contacts,
      windowHours,
      windows: WINDOW_HOURS,
      playing: active && clock.playing,
      index: active ? tickIndexAt(ticks, currentMs()) : ticks.length - 1,
      timeMs: active ? currentMs() : Date.now(),
    };
  };
  const currentMs = () => clock.ms;
  const notify = () => {
    lastNotify = Date.now();
    for (const listener of listeners) listener(state());
  };
  // Clicking a replayed contact follows it; its trail keeps drawing.
  const onClick = (event) => {
    const hit = event.drawHit;
    if (!active || hit?.set !== CONTACT_SET) return;
    const track = contactDraw.trackOf(hit.id);
    if (!track) return;
    camera.follow({
      key: hit.id,
      position: (ms) => contactDraw.ecefAt(track, ms),
      frame: 'enu',
      viewFrom: { x: 0, y: -6000, z: 4000 },
      transitionS: 1.2,
    });
    // The follow eases over wall time, so frames must run while it does, even paused.
    const release = frameOf(viewer).holdContinuous('replay-follow');
    setTimeout(release, FOLLOW_EASE_MS);
  };
  const tick = (ms) => {
    contactDraw.update(ms);
    if (active && Date.now() - lastNotify > NOTIFY_MS) notify();
  };
  const watchClicks = (on) => {
    stopClicks?.();
    stopClicks = on ? inputFor(viewer).onClick(onClick) : null;
  };

  async function getJson(path) {
    const response = await fetchImpl(path);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  /** Ask the recorder what it holds; resolves to the replay window, or null. */
  async function refreshRange() {
    try {
      const [s, e, f, p] = await Promise.all([
        getJson('/api/history/status'),
        getJson('/api/history/notices?limit=6'),
        getJson('/api/history/fences'),
        getJson('/api/history/pins'),
      ]);
      status = rawRange = s;
      events = e.notices;
      fences = f.fences;
      pins = p.pins.map((x) => x.id);
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
  const drawFences = () => overlays.setFences(fences);

  async function sendJson(path, init) {
    const response = await fetchImpl(path, {
      ...init,
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        message = (await response.json()).error || message;
      } catch {
        // Keep the status line.
      }
      throw new Error(message);
    }
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

  async function setRegion(box) {
    region = box;
    overlays.setRegion(box);
    if (active) await enter();
    else notify();
    await analysis.refreshHeat();
  }

  /** What a saved view keeps: where the window starts and its length, the area, layers and speed. */
  const viewSnapshot = () => ({
    // Empty unless a time was jumped to: such a view always opens on the newest history.
    fromSec: customFromSec,
    windowHours,
    layers: [...layers],
    region,
    speed,
  });

  /** Goes back to a saved view: its layers, area, window and speed, then replays. */
  async function applyView(view) {
    layers.clear();
    for (const layer of view.layers) layers.add(layer);
    windowHours = WINDOW_HOURS.includes(view.windowHours)
      ? view.windowHours
      : windowHours;
    if (SPEEDS.includes(view.speed)) speed = view.speed;
    customFromSec = view.fromSec ?? null;
    range = replayWindow(rawRange, windowHours);
    await setRegion(view.region ?? null);
    if (!active) await enter();
    clock.setSpeed(speed);
  }

  /** Draw a contact's whole recorded path, its first and last fix, and gaps. */
  const drawTrack = () => overlays.setTrack(track, trackPoints);

  /** Finds a contact by callsign, ship name, hex code or MMSI. */
  async function lookUp(text) {
    try {
      const { matches } = await getJson(
        `/api/history/search?q=${encodeURIComponent(text)}`,
      );
      return matches;
    } catch {
      return [];
    }
  }

  /** Which of a track's gaps fell while its feed was failing or not asked. */
  async function feedGapKinds(data) {
    if (!data.gaps.length) return { failing: 0, idle: 0 };
    try {
      const layer = data.points[0].layer;
      const query = new URLSearchParams({
        layer,
        from: String(data.first.ts),
        to: String(data.last.ts),
      });
      const { events } = await getJson(`/api/history/feeds?${query}`);
      return classifyGaps(data.gaps, feedOutages(events, data.last.ts));
    } catch {
      return { failing: 0, idle: 0 };
    }
  }

  async function findTrack(rawId) {
    const typed = String(rawId ?? '').trim();
    track = null;
    trackPoints = [];
    hint = '';
    if (typed) {
      // The best match is first: exact, then a prefix, then the newest. With no
      // name on record the text is tried as an id as it stands.
      const matches = await lookUp(typed);
      const id = matches[0]?.id ?? typed;
      const name = matches[0]?.name ?? '';
      try {
        const to = Math.floor(Date.now() / 1000) + 60;
        const data = await getJson(
          `/api/history/track/${encodeURIComponent(id)}?from=0&to=${to}`,
        );
        if (data.points.length) {
          trackPoints = data.points;
          const gapKinds = await feedGapKinds(data);
          track = {
            id,
            name,
            gapKinds,
            count: data.count,
            first: data.first,
            last: data.last,
            gaps: data.gaps,
          };
          if (matches.length > 1)
            hint = msg('Several matches, showing the best one');
        } else hint = msg('No recorded track for that identifier');
      } catch {
        hint = msg('Search failed');
      }
    }
    drawTrack();
    const sphere = track && boundingSphere(trackPoints.map(ecefOf));
    if (sphere)
      camera.flyToBounds(sphere, {
        offset: { heading: 0, pitch: -Math.PI / 4, range: 0 },
        durationS: 1.5,
      });
    notify();
  }

  async function setLive(on) {
    if (on) {
      // Satellites stay live unless they are being recorded too.
      const recorded = status?.layers;
      hidden = Object.keys(LIVE_LAYERS).filter(
        (id) =>
          dataManager?.layers?.get(id)?.enabled &&
          (!Array.isArray(recorded) || recorded.includes(LIVE_LAYERS[id])),
      );
      await Promise.all(hidden.map((id) => dataManager.setEnabled(id, false)));
    } else {
      const restore = hidden;
      hidden = [];
      await Promise.all(restore.map((id) => dataManager?.setEnabled(id, true)));
    }
  }

  let again = false;
  /** The period replay (and the heat map) covers: the newest hours, or from a jump. */
  function currentWindow() {
    const window = replayWindow(rawRange, windowHours);
    if (!window || customFromSec == null) return window;
    const fromSec = Math.max(
      rawRange.from_ts,
      Math.min(customFromSec, rawRange.to_ts - 60),
    );
    return {
      fromSec,
      toSec: Math.min(rawRange.to_ts, fromSec + windowHours * 3600),
    };
  }

  async function enter() {
    if (destroyed) return;
    if (loading) {
      // A filter changed mid-load: run once more when this load finishes.
      again = true;
      return;
    }
    loading = true;
    error = '';
    notify();
    try {
      await refreshRange();
      const window = currentWindow();
      if (!window) throw new Error('Nothing recorded yet');
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
      // A long window arrives in pages; follow the cursor, up to a cap so a
      // huge recording cannot exhaust memory.
      const points = [];
      for (let page = 0; page < 5; page++) {
        const got = await getJson(`/api/history/window?${query}`);
        points.push(...got.points);
        if (!got.nextCursor) break;
        query.set('cursor', got.nextCursor);
      }
      if (destroyed) return;
      if (!active) {
        await setLive(true);
        watchClicks(true);
      }
      contacts = contactDraw.load(points, layers);
      ticks = buildTicks(window.fromSec * 1000, window.toSec * 1000);
      clock.start(Date.parse(ticks[0]), Date.parse(ticks.at(-1)), speed);
      active = true;
    } catch {
      error = 'failed';
      // Do not leave the live layers hidden when replay never started.
      if (!active) {
        watchClicks(false);
        clock.stop();
        await setLive(false).catch(() => {});
      }
    } finally {
      loading = false;
      notify();
    }
    if (again) {
      again = false;
      await enter();
    }
  }

  async function exit() {
    customFromSec = null;
    if (!active) return;
    active = false;
    watchClicks(false);
    if (String(camera.followed?.key).startsWith(`${CONTACT_SET}:`))
      camera.follow(null);
    contactDraw.load([], layers);
    clock.stop();
    await setLive(false);
    notify();
  }

  function seek(index) {
    if (!active || !ticks[index]) return;
    clock.seek(ticks[index] ? Date.parse(ticks[index]) : currentMs());
    notify();
  }

  // Keep alerts and fences fresh while the page is open.
  const poll = setInterval(() => {
    if (!destroyed && !loading) refreshRange();
  }, 15000);

  // New area events and emergency squawks are checked more often than the rest
  // of the status, and each one is handed to the listeners once. Anything that
  // happened before the page opened is not announced.
  const noticeListeners = new Set();
  const seenNotices = new Set();
  let noticeSince = Math.floor(Date.now() / 1000);
  async function pollNotices() {
    if (destroyed || !status) return;
    try {
      const { notices } = await getJson(
        `/api/history/notices?since=${noticeSince}&limit=50`,
      );
      const fresh = notices
        .filter((n) => {
          const key = `${n.type}|${n.ts}|${n.kind}|${n.id}|${n.fence || ''}`;
          if (seenNotices.has(key)) return false;
          seenNotices.add(key);
          return true;
        })
        .reverse();
      if (!fresh.length) return;
      noticeSince = Math.max(noticeSince, fresh.at(-1).ts - 5);
      if (seenNotices.size > 1000)
        for (const key of [...seenNotices].slice(0, 500))
          seenNotices.delete(key);
      events = [...fresh.slice().reverse(), ...events].slice(0, 6);
      for (const notice of fresh)
        for (const listener of noticeListeners) listener(notice);
      notify();
    } catch {
      // The next poll tries again.
    }
  }
  const noticePoll = setInterval(pollNotices, 5000);

  const analysis = createAnalysis({
    viewer,
    getJson,
    getWindow: currentWindow,
    getFilters: () => ({
      layers: [...layers].join(','),
      ...(region
        ? {
            bbox: [region.west, region.south, region.east, region.north].join(
              ',',
            ),
          }
        : {}),
    }),
    onChange: () => notify(),
  });

  return {
    state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Calls back once for each new area event or emergency squawk. */
    onNotice(listener) {
      noticeListeners.add(listener);
      return () => noticeListeners.delete(listener);
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
      clock.toggle();
      notify();
    },
    /** Fly the camera to the replayed contacts. */
    fit() {
      // A jump can start just before a contact's first fix, so each contact
      // is placed where it is now, or at its first recorded fix.
      const sphere = contactDraw.sphereAt(currentMs());
      if (!sphere) return;
      camera.flyToBounds(sphere, {
        offset: {
          heading: 0,
          pitch: -Math.PI / 4,
          range: Math.max(sphere.radius * 2.5, 20000),
        },
        durationS: 1.5,
      });
    },
    async setWindowHours(hours) {
      if (!WINDOW_HOURS.includes(hours)) return;
      windowHours = hours;
      range = replayWindow(rawRange, windowHours);
      if (active) await enter();
      else notify();
      await analysis.refreshHeat();
    },
    /** Replay from this time (epoch ms) instead of the newest history. */
    async jumpTo(ms) {
      if (!Number.isFinite(ms) || !rawRange?.from_ts) return;
      customFromSec = ms / 1000;
      await enter();
      await analysis.refreshHeat();
    },
    findTrack,
    /** Drives and volumes a recording could go to, with their free space. */
    drives: () => getJson('/api/history/drives'),
    /** Changes how the recorder keeps data; { retention, maxMb, interval, layers }. */
    async saveSettings(values) {
      const result = await sendJson('/api/history/settings', {
        method: 'POST',
        body: JSON.stringify(values),
      });
      await refreshRange();
      return result;
    },
    /** Counts (dryRun) or removes extra old points; { olderThan, keepEvery, dryRun }. */
    async thin(params) {
      const result = await sendJson('/api/history/thin', {
        method: 'POST',
        body: JSON.stringify(params),
      });
      if (!params.dryRun) await refreshRange();
      return result;
    },
    /** The saved views: [{ name, savedTs, view }]. */
    async listViews() {
      return (await getJson('/api/history/views')).views;
    },
    /** Saves the replay state as a view under this name (replacing one). */
    saveView: (name) =>
      sendJson('/api/history/views', {
        method: 'POST',
        body: JSON.stringify({ name, view: viewSnapshot() }),
      }),
    deleteView: (name) =>
      sendJson('/api/history/views/delete', {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    applyView,
    /** The backups on disk, newest first: { folder, files: [{ name, path, bytes }] }. */
    listBackups: () => getJson('/api/history/backups'),
    /** Saves a complete copy of the history now; { path, count, bytes }. */
    backUp: () =>
      sendJson('/api/history/backup', { method: 'POST', body: '{}' }),
    /** Switches recording to a copy of a backup file; { count, previous, to }. */
    async restoreBackup(file) {
      const result = await sendJson('/api/history/restore', {
        method: 'POST',
        body: JSON.stringify({ file }),
      });
      await refreshRange();
      return result;
    },
    /** Shows or hides where contacts were densest in the current period. */
    toggleHeat: () => analysis.showHeat(!analysis.state().heat),
    /** Marks who appeared, went and stayed between two times (epoch ms). */
    compareTimes: (aMs, bMs) => analysis.compare(aMs, bMs),
    clearCompare: () => analysis.clearCompare(),
    /** Keep (or stop keeping) the searched contact's history past retention. */
    async togglePin() {
      if (!track) return;
      const id = track.id;
      try {
        if (pins.includes(id))
          await sendJson(`/api/history/pins/${encodeURIComponent(id)}`, {
            method: 'DELETE',
          });
        else
          await sendJson('/api/history/pins', {
            method: 'POST',
            body: JSON.stringify({ id }),
          });
      } catch {
        hint = msg('Could not change the pin');
      }
      await refreshRange();
    },
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
      clock.setSpeed(value);
      notify();
    },
    async toggleLayer(layer) {
      if (layers.has(layer) && layers.size > 1) layers.delete(layer);
      else layers.add(layer);
      if (active) await enter();
      else notify();
      await analysis.refreshHeat();
    },
    async destroy() {
      destroyed = true;
      clearInterval(poll);
      clearInterval(noticePoll);
      analysis.destroy();
      await boxTool?.destroy();
      await exit();
      overlays.dispose();
      contactDraw.dispose();
      listeners.clear();
    },
  };
}
