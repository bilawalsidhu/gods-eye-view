import { twoline2satrec } from 'satellite.js';
import * as Cesium from 'cesium';
import { msg } from '../../i18n/index.js';
import { noradIdFromSatnum, tleLineLaunchYear } from '../../sources/tle.js';
import { CATALOG_GROUPS, ISS_NORAD, POINT_STYLES } from './policy.js';
import { classifySatellite, parseSatcatCsv } from './classes.js';
import { matchImagingSensor } from './sensors.js';

/**
 * How long a catalog rebuild waits for SATCAT before it classifies without
 * it, ms. SATCAT can hang for the proxy's whole upstream timeout (20 s); the
 * late answer reclassifies in place.
 */
export const SATCAT_WAIT_MS = 3000;

/**
 * How long a complete, current SATCAT read is kept before the layer asks
 * again, ms. SATCAT changes daily and the proxy caches it a day, so the
 * five-minute TLE update does not read all eleven groups each time.
 */
export const SATCAT_KEEP_MS = 6 * 60 * 60 * 1000;

export function createIngestion({
  state: layerState,
  services,
  parts,
  source,
}) {
  /**
   * The local packs the classes and zoom steps are read from: the UCS pack
   * and the imaging-sensor pack. Neither is needed to render: a failed read
   * leaves the last pack (or none) and classification falls back to names
   * and groups.
   */
  async function _readLocalEvidence() {
    const ucs = layerState._ucs
      ? Promise.resolve(layerState._ucs)
      : Promise.resolve()
          .then(() => source.readUcs?.())
          .then((pack) => (pack instanceof Map ? pack : null))
          .catch((error) => {
            console.warn('[Data:Satellites] UCS pack unavailable:', error);
            return null;
          });
    // The sensor pack only adds zoom steps in the orbital view; without it
    // every satellite keeps the base steps.
    const sensors = layerState._sensors
      ? Promise.resolve(layerState._sensors)
      : Promise.resolve()
          .then(() => source.readSensors?.())
          .then((index) => (index?.byNorad instanceof Map ? index : null))
          .catch((error) => {
            console.warn(
              '[Data:Satellites] Imaging sensor pack unavailable:',
              error,
            );
            return null;
          });
    const [pack, sensorIndex] = await Promise.all([ucs, sensors]);
    if (pack) layerState._ucs = pack;
    if (sensorIndex) layerState._sensors = sensorIndex;
  }

  /**
   * CelesTrak SATCAT for every core group: type and status, which refine the
   * classes. A group whose read failed gives null.
   * @returns {Promise<Array<{records: Map, stale: boolean}|null>>}
   */
  function _readSatcat(signal) {
    if (typeof source.readSatcat !== 'function') return Promise.resolve([]);
    // A complete, current read is kept; a stale or failed one is asked again.
    if (
      layerState._satcatState === 'current' &&
      Date.now() - layerState._satcatReadAtMs < SATCAT_KEEP_MS
    )
      return Promise.resolve([]);
    return Promise.all(
      CATALOG_GROUPS.map((groupDef) =>
        source
          .readSatcat(groupDef.path, { signal })
          .then((res) =>
            res?.ok
              ? { records: parseSatcatCsv(res.text), stale: Boolean(res.stale) }
              : null,
          )
          .catch((error) => {
            if (signal.aborted || error?.name === 'AbortError') throw error;
            return null;
          }),
      ),
    );
  }

  /**
   * Merge SATCAT reads and say how current they are: 'current', 'stale' (a
   * group came from the proxy's last copy) or 'unavailable' (a group failed;
   * its earlier records, if any, stay).
   */
  function _mergeSatcat(groups) {
    let satcatState = 'current';
    for (const group of groups) {
      if (!group) {
        satcatState = 'unavailable';
        continue;
      }
      if (group.stale && satcatState === 'current') satcatState = 'stale';
      for (const [noradId, record] of group.records) {
        // A group served from the proxy's last copy never overrules a
        // current read of the same object, from this merge or an earlier one.
        const held = layerState._satcat.get(noradId);
        if (group.stale && held && !held.stale) continue;
        layerState._satcat.set(
          noradId,
          group.stale ? { ...record, stale: true } : record,
        );
      }
    }
    if (!groups.length) return;
    const changed = layerState._satcatState !== satcatState;
    layerState._satcatState = satcatState;
    layerState._satcatReadAtMs = Date.now();
    if (satcatState !== 'current')
      console.warn(`[Data:Satellites] SATCAT ${satcatState}: classes may lag`);
    // The row's info line says so (getRowControls).
    if (changed) parts.controls._notifyRowControls();
  }

  /**
   * Classify the catalog again once SATCAT lands after it was built: only
   * entries whose SATCAT record changed are read again; a changed class
   * restyles its point and refreshes visibility, the legend and the overlay.
   */
  function _reclassifyFromSatcat() {
    let changed = false;
    for (const [noradId, sat] of layerState._catalog) {
      if (sat.group === 'dense') continue;
      const satcat = layerState._satcat.get(noradId) || null;
      if (satcat === sat.satcat) continue;
      sat.satcat = satcat;
      // The Cockpit identity (owner, COSPAR id) reads SATCAT too.
      sat.cockpitIdentity = undefined;
      const next = classifySatellite({
        noradId,
        name: sat.name,
        group: sat.group,
        groups: sat.groups,
        ucs: sat.ucs,
        satcat,
        launchYear: sat.launchYear,
      });
      if (next === sat.satelliteClass) continue;
      sat.satelliteClass = next;
      changed = true;
      const point = layerState._points.get(noradId);
      if (point) {
        const style = parts.controls._pointStyleFor(noradId, sat.group);
        point.pixelSize = style.pixelSize;
        point.color = style.color;
        point.outlineColor = style.outlineColor;
        point.outlineWidth = style.outlineWidth;
      }
    }
    if (!changed) return;
    parts.controls._applyClassVisibility();
    layerState._catalogRevision++;
    parts.controls._notifyRowControls();
  }

  /** Resolve null after `ms`, or at once when `signal` aborts. */
  function _waitOrAbort(ms, signal) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms, null);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve(null);
        },
        { once: true },
      );
    });
  }

  const methods = {
    async update(viewer, { signal = null } = {}) {
      const trackingRefreshEpoch = ++layerState._trackingRefreshEpoch;
      layerState._lastTrackingRefreshOutcome = {
        epoch: trackingRefreshEpoch,
        status: 'source-unavailable',
        failedGroups: [],
      };
      const resourceController = new AbortController();
      layerState._activeUpdateControllers.add(resourceController);
      const updateSignal = signal
        ? AbortSignal.any([signal, resourceController.signal])
        : resourceController.signal;
      try {
        updateSignal.throwIfAborted();
        // Load all core groups in parallel; a failed/empty group degrades
        // gracefully (parseTLE of an upstream error body yields []).
        const localEvidence = _readLocalEvidence();
        const satcat = _readSatcat(updateSignal);
        // An abort can reject this before the groups settle and it is awaited.
        satcat.catch(() => {});
        const results = await Promise.all(
          CATALOG_GROUPS.map(async (groupDef) => {
            try {
              const res = await source.readGroup(groupDef.path, {
                signal: updateSignal,
              });
              if (!res.ok) return { ...groupDef, entries: [], ok: false };
              const entries = parts.orbits.parseTLE(res.text);
              updateSignal.throwIfAborted();
              return {
                ...groupDef,
                entries,
                ok: entries.length > 0,
                stale: Boolean(res.stale),
              };
            } catch (error) {
              if (updateSignal.aborted || error?.name === 'AbortError')
                throw error;
              return { ...groupDef, entries: [], ok: false };
            }
          }),
        );
        await localEvidence;
        // SATCAT only refines classes: wait a moment for it, then classify
        // with what is held and let a late answer reclassify in place.
        const satcatInTime = await Promise.race([
          satcat.then((groups) => ({ groups })),
          _waitOrAbort(SATCAT_WAIT_MS, updateSignal),
        ]).catch(() => null);
        updateSignal.throwIfAborted();
        if (satcatInTime) _mergeSatcat(satcatInTime.groups);
        else
          satcat
            .then((groups) => {
              if (updateSignal.aborted || !layerState._enabled) return;
              _mergeSatcat(groups);
              _reclassifyFromSatcat();
            })
            .catch(() => {});

        const failed = results.filter((r) => !r.ok).map((r) => r.path);
        if (failed.length > 0) {
          console.warn(
            `[Data:Satellites] Groups failed or empty: ${failed.join(', ')}`,
          );
        }
        console.log(
          `[Data:Satellites] Loaded ${results.map((r) => `${r.tag}:${r.entries.length}`).join(' ')}`,
        );

        // CelesTrak outage guard (H3): if EVERY group failed, bail BEFORE clearing.
        // Wiping the collection + catalog here would blank every satellite while
        // the chip still read "just now". Keep the existing (stale) catalog on
        // screen and surface the outage instead — do NOT stamp _lastUpdate.
        if (results.every((r) => !r.ok)) {
          // English data (stats reach the voice tools); the panel translates it.
          layerState._lastError = msg('CelesTrak unreachable');
          console.warn(
            '[Data:Satellites] All CelesTrak groups failed — keeping existing catalog, surfacing outage',
          );
          // Re-apply dense mode is skipped (no fresh core catalog); tracking untouched.
          return;
        }

        // At least one group loaded — proceed with a fresh rebuild, but keep the
        // partial outage visible at the layer control instead of presenting the
        // reduced catalog as a fully healthy refresh.
        // i18n-ignore: English data; the panel shows it through FEED_ERROR_PATTERNS (ui/statusText.js)
        layerState._lastError = failed.length
          ? `${failed.length} CelesTrak group${failed.length === 1 ? '' : 's'} unavailable`
          : null;

        // Clear existing
        layerState._pointCollection.removeAll();
        layerState._points.clear();
        for (const path of layerState._orbitPaths.values())
          viewer.scene.primitives.remove(path.primitive);
        layerState._orbitPaths.clear();
        layerState._catalog.clear();
        // The detection overlay caches one record per satellite and stamps its
        // id/class at creation only. A rebuild can re-tag a satellite (a failed
        // group shifts which one wins dedupe), so the cache must go with the
        // catalog or those labels stay stale for the life of the session.
        layerState._detectionObjects.clear();
        layerState._denseIds = [];
        layerState._denseStale = false;
        layerState._denseCursor = 0;
        layerState._denseLoadController?.abort();
        layerState._denseLoadController = null;
        layerState._denseLoadToken++; // cancel any in-flight dense load against the old catalog
        parts.labels._syncIssOverlay();

        const now = new Date(layerState.now());

        // Process all TLE entries in CATALOG_GROUPS order
        const allEntries = [];
        for (const r of results) {
          for (const e of r.entries)
            allEntries.push({ ...e, group: r.tag, stale: r.stale });
        }

        // Every group each TLE came in, keyed by its catalog-number column:
        // the shown tag is the first, but classification reads them all.
        const groupsByNumber = new Map();
        for (const entry of allEntries) {
          const number = String(entry.line1 || '')
            .slice(2, 7)
            .trim();
          const groups = groupsByNumber.get(number);
          if (!groups) groupsByNumber.set(number, [entry.group]);
          else if (!groups.includes(entry.group)) groups.push(entry.group);
        }

        // Deduplicate by NORAD ID — first (most specific) group tag wins
        const seen = new Set();
        let coreStale = false;

        for (const entry of allEntries) {
          const satrec = twoline2satrec(entry.line1, entry.line2);
          if (!satrec || satrec.error !== 0) continue;

          const noradId = noradIdFromSatnum(satrec.satnum);
          if (seen.has(noradId)) continue;
          seen.add(noradId);

          // Store in catalog
          const launchYear = tleLineLaunchYear(entry.line1);
          const ucs = layerState._ucs?.get(noradId) || null;
          const satcat = layerState._satcat.get(noradId) || null;
          const groups = groupsByNumber.get(
            String(entry.line1 || '')
              .slice(2, 7)
              .trim(),
          ) || [entry.group];
          layerState._catalog.set(noradId, {
            name: entry.name,
            satrec,
            group: entry.group,
            groups,
            // satellite.js does not keep the designator the year match reads.
            launchYear,
            line1: entry.line1,
            line2: entry.line2,
            satelliteClass: classifySatellite({
              noradId,
              name: entry.name,
              group: entry.group,
              groups,
              ucs,
              satcat,
              launchYear,
            }),
            ucs,
            satcat,
            sensor: matchImagingSensor(layerState._sensors, {
              noradId,
              name: entry.name,
            }),
          });

          coreStale ||= entry.stale;

          // Propagate initial position
          const pos = parts.orbits.propagatePosition(satrec, now);
          if (!pos) continue;

          const cartesian = Cesium.Cartesian3.fromDegrees(
            pos.longitude,
            pos.latitude,
            pos.altitude,
          );

          // Add point primitive (styling from the shared table, WS-D3)
          const style = parts.controls._pointStyleFor(noradId, entry.group);
          const point = layerState._pointCollection.add({
            position: cartesian,
            pixelSize: style.pixelSize,
            color: style.color,
            outlineColor: style.outlineColor,
            outlineWidth: style.outlineWidth,
            scaleByDistance: new Cesium.NearFarScalar(1e6, 1.5, 2e7, 0.6),
            id: noradId,
          });
          // Hidden classes keep their point, so a toggle needs no rebuild.
          point.show = parts.controls._classVisible(noradId);

          layerState._points.set(noradId, point);
        }

        // Show ISS orbital path by default
        if (layerState._catalog.has(ISS_NORAD)) {
          parts.rendering._showOrbitPath(ISS_NORAD, POINT_STYLES.iss.color);
          parts.controls._syncIssOrbit();

          parts.labels._syncIssOverlay();
        }

        layerState._coreStale = coreStale;
        layerState._count = layerState._points.size;
        layerState._catalogRevision++;
        layerState._lastUpdate = Date.now();
        layerState._lastPropagation = Date.now();
        layerState._lastTrackingRefreshOutcome = {
          epoch: trackingRefreshEpoch,
          status: failed.length ? 'partial' : 'accepted',
          failedGroups: [...failed],
        };
        console.log(
          `[Data:Satellites] ${layerState._count} satellites active, ISS path shown`,
        );

        // Re-apply dense mode after a full catalog rebuild (fire-and-forget —
        // _loadDenseCatalog handles its own errors and token invalidation).
        layerState._denseLoadPromise =
          layerState._params.catalog === 'dense'
            ? parts.catalog._loadDenseCatalog({ signal: updateSignal })
            : Promise.resolve({ status: 'not-requested' });
        // The catalog the published voice subject was resolved against is gone.
        // Re-resolve it, or release the slot if the subject provably did not
        // survive. Deliberately not awaited: it waits on dense settlement, and
        // the rebuild must not block on that.
        void parts.tracking._reconcileTrackedSubjectContext();
        parts.tracking._applyPendingTrackingRestore();
        layerState.coverageChanged();
      } catch (e) {
        if (updateSignal.aborted || e?.name === 'AbortError') {
          throw new DOMException('Satellite update aborted', 'AbortError');
        }
        console.warn('[Data:Satellites] Fetch error:', e);
      } finally {
        layerState._activeUpdateControllers.delete(resourceController);
      }
    },
  };

  return { methods };
}
