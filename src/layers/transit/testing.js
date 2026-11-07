import { fromDegrees } from '../../geo/ellipsoid.js';
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
  return {
    _setTransitFixtureFloorsForTest(keys, heightM) {
      state._qaFixtureFloors = new Map(keys.map((key) => [key, heightM]));
    },
    _stopTransitProbeForTest() {
      parts.rendering.stopFrameProbe();
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
              fromDegrees(fixes[i].lon, fixes[i].lat, 20),
              fromDegrees(fixes[i + 1].lon, fixes[i + 1].lat, 20),
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
              fromDegrees(fixes[i].lon, fixes[i].lat, 20),
              fromDegrees(fixes[i + 1].lon, fixes[i + 1].lat, 20),
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
    /** Measure inside the renderer's frames with fixed typed storage. */
    _measureTransitFramesForTest(durationMs = 12000) {
      return parts.rendering.measureFrames(durationMs);
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
          shown: parts.rendering.markerShown(entry),
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
