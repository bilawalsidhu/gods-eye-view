import * as Cesium from 'cesium';
import { recordFix, updatePlayback, attachFloorToPlace } from './movement.js';
import { seek, setRate, mergeHistory } from '../../data/contactPlayback.js';
import { getRegisteredTransitFeed } from '../../data/transitFeeds.js';
/**
 * Test seams. Each one reaches into THIS instance's state, so a test that
 * swaps the overlay host or inspects vehicles cannot leak into another layer.
 * @param {object} context
 * @returns {object}
 */
import { transitIconCacheSize } from '../../data/transitIcons.js';

export function createTesting({ state, parts }) {
  let stopProbe = null;
  return {
    _setTransitFixtureFloorsForTest(keys, heightM) {
      state._qaFixtureFloors = new Map(keys.map((key) => [key, heightM]));
    },
    _stopTransitProbeForTest() {
      stopProbe?.();
    },
    /** Deterministic observed-position fixtures, independent of upstream availability. */
    _loadTransitFleetForTest(count, origin, spacingM = 6, routes = ['741']) {
      parts.selection.clearSelection();
      parts.ingestion.abortAllInFlight();
      state._activeFeeds.clear();
      for (const key of state._vehicles.keys())
        parts.ingestion.removeVehicle(key);
      clearTimeout(state._cameraDebounceTimer);
      state._cameraDebounceTimer = null;
      const feed = getRegisteredTransitFeed('mbta');
      const now = Date.now(),
        mono = performance.now();
      const cols = Math.ceil(Math.sqrt(count));
      const vehicles = Array.from({ length: count }, (_, i) => ({
        id: `qa-${i}`,
        routeId: routes[i % routes.length],
        tripId: 'qa',
        lat:
          origin.lat + ((Math.floor(i / cols) - cols / 2) * spacingM) / 111320,
        lon:
          origin.lon +
          (((i % cols) - cols / 2) * spacingM) /
            (111320 * Math.cos((origin.lat * Math.PI) / 180)),
        timestamp: (now - 120000) / 1000,
        timestampSource: 'vehicle',
        bearing: 0,
      }));
      parts.ingestion.applySnapshot(
        feed,
        { fetchedAt: now, vehicles },
        { stale: false },
      );
      let fixtureIndex = 0;
      for (const entry of state._vehicles.values()) {
        entry.qaIndex = fixtureIndex++;
        entry.qaFixture = true;
        entry.qaFloorM = 20;
        for (let j = 1; j <= 8; j++) {
          const t = now - 120000 + j * 15000;
          recordFix(
            entry,
            {
              t,
              lat: entry.record.lat + (j * 15) / 111320,
              lon: entry.record.lon,
              bearingDeg: 0,
            },
            {
              receivedAt: t + 1000,
              wallNowMs: t + 1000,
              monoNowMs: mono - now + t + 1000,
            },
          );
        }
        mergeHistory(
          entry.track,
          Array.from({ length: 119 }, (_, i) => {
            const t = now - 899000 + i * (764000 / 118);
            return {
              t,
              lat: entry.record.lat + (t - now + 120000) / 1000 / 111320,
              lon: entry.record.lon,
              bearingDeg: 0,
              epoch: entry.currentEpoch,
            };
          }),
        );
        // This fixture deliberately provides a flat, known surface for load measurements.
        for (const fix of entry.fixes) attachFloorToPlace(entry, fix, 20);
        entry.heightPending = false;
        entry.surfaceReady = true;
        entry.displayPaths = new Map();
        const fixes = entry.fixes;
        for (let i = 0; i + 1 < fixes.length; i++) {
          if (fixes[i + 1].t < now - 72000) continue;
          entry.displayPaths.set(fixes[i].seq, {
            toSeq: fixes[i + 1].seq,
            positions: [
              Cesium.Cartesian3.fromDegrees(fixes[i].lon, fixes[i].lat, 20),
              Cesium.Cartesian3.fromDegrees(
                fixes[i + 1].lon,
                fixes[i + 1].lat,
                20,
              ),
            ],
          });
        }
        entry.clocks.wallNowMs = now;
        entry.clocks.monoNowMs = mono;
        seek(entry.track, now - 72000, entry.clocks);
        setRate(entry.track, 1, entry.clocks);
        updatePlayback(entry, now, mono);
        parts.rendering.placeSample(entry);
      }
      clearTimeout(state._floorTimer);
      state._floorTimer = null;
      // Establish the fixture clock without the live re-entry reset.
      for (const entry of state._vehicles.values()) state._visible.add(entry);
      state._visibilityAt = 0;
      parts.rendering.refreshVisibility();
      parts.rendering.maintainPresentation();
      return {
        count: state._vehicles.size,
        moving: state._moving.size,
        fixBytes: state._historyBudget.allocatedBytes,
      };
    },
    _resetTransitFixtureClockForTest() {
      const now = Date.now(),
        mono = performance.now();
      for (const entry of state._vehicles.values()) {
        // A backwards QA seek revisits paths pruned during the timing run.
        // Rebuild the same explicitly flat fixture surface before allocation QA.
        const fixes = entry.fixes;
        entry.displayPaths = new Map();
        for (let i = 0; i + 1 < fixes.length; i++) {
          if (fixes[i + 1].t < fixes.at(-1).t - 72000) continue;
          entry.displayPaths.set(fixes[i].seq, {
            toSeq: fixes[i + 1].seq,
            positions: [
              Cesium.Cartesian3.fromDegrees(fixes[i].lon, fixes[i].lat, 20),
              Cesium.Cartesian3.fromDegrees(
                fixes[i + 1].lon,
                fixes[i + 1].lat,
                20,
              ),
            ],
          });
        }
        entry.clocks.wallNowMs = now;
        entry.clocks.monoNowMs = mono;
        seek(entry.track, entry.fixes.at(-1).t - 72000, entry.clocks);
        setRate(entry.track, 1, entry.clocks);
        updatePlayback(entry, now, mono);
        parts.rendering.placeSample(entry);
        parts.rendering.schedulePlayback(entry);
      }
      parts.rendering.syncRenderHold();
    },
    /** Measure inside Cesium postRender with fixed typed storage; no sample objects per frame. */
    _measureTransitFramesForTest(durationMs = 12000) {
      stopProbe?.();
      const scene = state._viewer.scene;
      const capacity = 20000,
        stride = 12,
        data = new Float64Array(capacity * stride);
      const previousPositions = new Float64Array(state._vehicles.size * 3);
      const gl = scene.context._gl;
      let active = false,
        upload = 0,
        cpu = 0,
        count = 0,
        previous = 0;
      const saved = [];
      for (const name of ['bufferData', 'bufferSubData']) {
        const original = gl[name];
        gl[name] = function (...args) {
          if (active) {
            const value = args[name === 'bufferData' ? 1 : 2];
            const offset = args[name === 'bufferData' ? 3 : 3] || 0;
            const length = args[4];
            upload +=
              typeof value === 'number'
                ? value
                : value
                  ? length !== undefined
                    ? length * (value.BYTES_PER_ELEMENT || 1)
                    : value.byteLength - offset * (value.BYTES_PER_ELEMENT || 1)
                  : 0;
          }
          return original.apply(this, args);
        };
        saved.push(() => {
          gl[name] = original;
        });
      }
      for (const collection of [state._markers, state._animatedMarkers]) {
        const original = collection.update;
        collection.update = function (frame) {
          active = true;
          try {
            return original.call(this, frame);
          } finally {
            active = false;
          }
        };
        saved.push(() => {
          collection.update = original;
        });
      }
      state._preRenderRemove?.();
      const removePre = scene.preRender.addEventListener(() => {
        upload = 0;
        const start = performance.now();
        parts.rendering.onPreRender();
        cpu = performance.now() - start;
      });
      let removePost, timer;
      return new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          removePre();
          removePost?.();
          for (const restore of saved) restore();
          if (state._enabled)
            state._preRenderRemove = scene.preRender.addEventListener(
              parts.rendering.onPreRender,
            );
          stopProbe = null;
          const rows = [];
          for (let i = 1; i < count; i++) {
            const k = i * stride;
            rows.push({
              intervalMs: data[k],
              cpuMs: data[k + 1],
              uploadBytes: data[k + 2],
              moving: data[k + 3],
              x: data[k + 4],
              y: data[k + 5],
              z: data[k + 6],
              displayT: data[k + 7],
              expectedMps: data[k + 8],
              segment: data[k + 9],
            });
          }
          resolve({
            rows,
            dpr: devicePixelRatio,
            width: scene.canvas.clientWidth,
            height: scene.canvas.clientHeight,
          });
        };
        stopProbe = finish;
        removePost = scene.postRender.addEventListener(() => {
          const now = performance.now();
          if (count >= capacity) return;
          const k = count++ * stride;
          const entry = state._vehicles.get('mbta:qa-0');
          data[k] = previous ? now - previous : 0;
          previous = now;
          data[k + 1] = cpu;
          data[k + 2] = upload;
          let actuallyMoved = 0;
          for (const vehicle of state._visible) {
            const p = vehicle.marker.position,
              index = vehicle.qaIndex * 3;
            if (
              count > 1 &&
              Math.hypot(
                p.x - previousPositions[index],
                p.y - previousPositions[index + 1],
                p.z - previousPositions[index + 2],
              ) > 0.00001
            )
              actuallyMoved++;
            previousPositions[index] = p.x;
            previousPositions[index + 1] = p.y;
            previousPositions[index + 2] = p.z;
          }
          data[k + 3] = actuallyMoved;
          if (entry?.marker) {
            const p = entry.marker.position;
            data[k + 4] = p.x;
            data[k + 5] = p.y;
            data[k + 6] = p.z;
            data[k + 7] = entry.sample.displayT;
            data[k + 8] = entry.sample.segmentSpeedMps;
            data[k + 9] = entry.sample.fromSeq;
          }
        });
        timer = setTimeout(finish, durationMs);
      });
    },
    _transitVisibilityForTest() {
      return [...state._vehicles.values()].map((entry) => {
        const gate = entry.visibility || {};
        const why = [];
        if (!entry.marker) why.push('no marker');
        if (gate.bounds === false && gate.boundsApplied) why.push('bounds');
        if (gate.occluder === false) why.push('occluder');
        if (gate.frustum === false) why.push('frustum');
        if (entry.heightPending) why.push('heightPending');
        if (entry.surfaceReady === false) why.push('surfaceReady');
        if (!entry.sample || !Number.isFinite(entry.sample.lat))
          why.push('no sample');
        if (!state._enabled) why.push('disabled');
        return {
          key: entry.key,
          shown: entry.marker?.show === true,
          why,
          ...gate,
          heightPending: !!entry.heightPending,
          surfaceReady: entry.surfaceReady ?? null,
          moving: state._moving.has(entry),
          held: state._renderHeld,
          heightM: entry.heightM,
          phase: entry.sample?.phase,
        };
      });
    },
    /** What the sprites are currently styled for, and how many rasters exist. */
    _transitStylingForTest() {
      return {
        stylePreset: state._stylePreset,
        cockpitVision: state._cockpitVision,
        iconCacheSize: transitIconCacheSize(),
      };
    },
    _setTransitOverlayHostForTest(host) {
      state._overlayHost = host || state.DEFAULT_OVERLAY_HOST;
    },
    _transitStateForTest() {
      return state;
    },
    _transitPartsForTest() {
      return parts;
    },
  };
}
