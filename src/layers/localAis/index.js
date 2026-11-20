import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { msg } from '../../i18n/index.js';
import { localAisCardModel } from './card.js';
import { localAisStatus, SOURCE } from './status.js';

export const LOCAL_AIS_LAYER_ID = 'local-ais';
const ROUTE = '/api/local-receivers/vessels';
const PICK_PREFIX = 'local-ais:';
const MAX_AGE_MS = 600_000;
const CARD_SOURCE_ID = 'local-ais';
const CARD_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const MARKER =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
      '<circle cx="32" cy="32" r="29" fill="#0c2435" stroke="#28d8ec" stroke-width="3"/>' +
      '<path d="M12 35h40l-8 12H21zM30 14h4v21M24 25h16v10" fill="#28d8ec" stroke="#28d8ec" stroke-width="2"/>' +
      '</svg>',
  );
// A distress or test beacon is not a vessel: an orange warning triangle with
// a double ring, so it cannot be mistaken for a ship at any zoom.
const BEACON_MARKER =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
      '<circle cx="32" cy="32" r="30" fill="none" stroke="#ff8a3d" stroke-width="2" stroke-dasharray="6 4"/>' +
      '<circle cx="32" cy="32" r="25" fill="#2b1608" stroke="#ff8a3d" stroke-width="3"/>' +
      '<path d="M32 14 51 46H13z" fill="#ff8a3d" stroke="#ff8a3d" stroke-width="3" stroke-linejoin="round"/>' +
      '<path d="M32 24v12" stroke="#2b1608" stroke-width="5" stroke-linecap="round"/>' +
      '<circle cx="32" cy="42" r="3" fill="#2b1608"/>' +
      '</svg>',
  );
const BEACON_TYPES = new Set(['sart', 'mob', 'epirb']);

/**
 * The only fix that may be shown as a plain position to the hosted model:
 * validated by the receiver and not approximate. Anything else, including a
 * flag that is missing or not a boolean, is withheld.
 */
function exactFix(record) {
  return record?.validated === true && record?.approx === false;
}

/**
 * The user's AIS-catcher, independent of public AISStream. Its records and
 * pick IDs do not overlap public vessel objects; station positions are absent.
 */
export function createLocalAisLayer({
  overlayHost = null,
  picking = null,
  pointer = null,
  input = (viewer) => inputFor(viewer),
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
} = {}) {
  let viewer = null;
  let icons = null;
  let enabled = false;
  let pending = null;
  let removeClick = null;
  let lastUpdate = null;
  let configured = false;
  let feeds = [];
  let requestFailed = false;
  let selectedId = null;
  let records = new Map();

  const frame = () => {
    if (viewer) findFrame(viewer)?.requestRender('local-ais');
  };
  function hideCard() {
    selectedId = null;
    overlayHost?.setEntries(CARD_SOURCE_ID, [], CARD_OPTIONS);
  }
  function showCard() {
    if (!selectedId || !overlayHost) return;
    const record = records.get(selectedId);
    if (!record) return hideCard();
    const card = localAisCardModel(record);
    overlayHost.setEntries(
      CARD_SOURCE_ID,
      [
        {
          id: `local-ais-card:${record.mmsi}`,
          selected: true,
          title: card.title,
          details: card.details,
          accent: card.accent,
          priority: Number.MAX_SAFE_INTEGER,
          verticalOnly: true,
          placement: 'above',
          stateless: true,
          horizonCull: true,
          position: fromDegrees(record.lon, record.lat),
        },
      ],
      CARD_OPTIONS,
    );
    overlayHost.setVisible?.(CARD_SOURCE_ID, true);
  }
  function redraw() {
    if (!icons) return;
    icons.set(
      [...records.values()].map((record) => ({
        id: `${PICK_PREFIX}${record.mmsi}`,
        pos: fromDegrees(record.lon, record.lat),
        image: record.beaconType ? BEACON_MARKER : MARKER,
        size: record.beaconType ? [26, 26] : [22, 22],
        height: 'clampGround',
        disableDepthTest: Number.POSITIVE_INFINITY,
        show: true,
      })),
    );
    showCard();
    frame();
  }
  function attachClick() {
    if (!viewer || removeClick || !picking || !overlayHost) return;
    picking.registerPickOwner?.(
      LOCAL_AIS_LAYER_ID,
      (id) => typeof id === 'string' && id.startsWith(PICK_PREFIX),
    );
    let dispatcher;
    try {
      dispatcher = input(viewer);
    } catch {
      dispatcher = null;
    }
    removeClick = dispatcher?.onClick?.((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      if (picking.clickCard?.(click)) return;
      const id = click.topHit ? picking.resolvePickId?.(click.topHit) : null;
      if (typeof id === 'string' && id.startsWith(PICK_PREFIX)) {
        const mmsi = id.slice(PICK_PREFIX.length);
        if (records.has(mmsi)) {
          selectedId = mmsi;
          showCard();
          frame();
          return;
        }
      }
      if (id && picking.isOwnedByOtherLayer?.(LOCAL_AIS_LAYER_ID, id)) return;
      if (selectedId) hideCard();
    });
  }
  function detachClick() {
    removeClick?.();
    removeClick = null;
    picking?.unregisterPickOwner?.(LOCAL_AIS_LAYER_ID);
    hideCard();
  }

  const layer = {
    id: LOCAL_AIS_LAYER_ID,
    name: msg('Local AIS'),
    icon: '🚢',
    source: SOURCE,
    updateInterval: 5000,
    statsRefreshInterval: 1000,
    init(nextViewer) {
      if (viewer) throw new Error('Local AIS already initialized');
      viewer = nextViewer;
      icons = drawOf(viewer).icons({
        id: 'local-ais:markers',
        horizonCull: true,
        show: false,
      });
    },
    enable() {
      enabled = true;
      if (icons) icons.show = true;
      attachClick();
      frame();
    },
    disable() {
      enabled = false;
      pending?.abort();
      pending = null;
      if (icons) icons.show = false;
      detachClick();
      frame();
    },
    async update() {
      if (!enabled || !icons) return false;
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      try {
        const response = await fetchImpl(ROUTE, {
          signal: controller.signal,
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        if (!response?.ok) throw new Error('Local AIS proxy unavailable');
        const data = await response.json();
        if (!enabled || controller.signal.aborted || pending !== controller)
          return false;
        if (data?.configured !== true) {
          records.clear();
          configured = false;
          feeds = [];
          requestFailed = false;
          lastUpdate = null;
          hideCard();
          redraw();
          return true;
        }
        if (!Array.isArray(data.records) || !Array.isArray(data.feeds))
          throw new Error('Malformed Local AIS snapshot');
        const time = now();
        const clockOffset = Number.isFinite(data.generatedAt)
          ? time - data.generatedAt
          : 0;
        const next = new Map();
        for (const record of data.records.slice(0, 5000)) {
          if (
            !/^\d{9}$/.test(record?.mmsi || '') ||
            !Number.isFinite(record.lat) ||
            !Number.isFinite(record.lon) ||
            Math.abs(record.lat) > 90 ||
            Math.abs(record.lon) > 180
          )
            continue;
          const observedAt = record.lastSeenAt + clockOffset;
          if (!Number.isFinite(observedAt) || time - observedAt > MAX_AGE_MS)
            continue;
          next.set(record.mmsi, {
            ...record,
            // Only a known beacon kind; anything else is a vessel.
            beaconType: BEACON_TYPES.has(record.beaconType)
              ? record.beaconType
              : null,
            lastSeenAt: observedAt,
          });
        }
        records = next;
        configured = true;
        feeds = data.feeds.map((feed) => {
          // Live only if the feed's newest vessel or beacon is still inside
          // the window when this snapshot is read: a row 599 s old at the
          // server can be 601 s old here, and that feed is quiet, not live.
          // A feed that does not report `newestAt` keeps the server's word.
          const aged =
            feed?.status === 'live' &&
            feed.newestAt !== undefined &&
            !(
              Number.isFinite(feed.newestAt) &&
              time - (feed.newestAt + clockOffset) <= MAX_AGE_MS
            );
          return {
            label: feed?.label,
            status: aged ? 'stale' : feed?.status,
            count: Number.isFinite(feed?.count) ? feed.count : 0,
            dropped: Number.isFinite(feed?.dropped) ? feed.dropped : 0,
            // Rows the server rejected as invalid (not base stations or old
            // rows), so a receiver sending them reads as rejected, not silent.
            // A feed demoted for age is quiet, not rejecting.
            rejected:
              !aged && Number.isFinite(feed?.rejected) ? feed.rejected : 0,
            heardAt: Number.isFinite(feed?.heardAt) ? feed.heardAt : null,
          };
        });
        requestFailed = false;
        // Dated by the newest message the receivers heard, not by this poll,
        // so a deaf receiver ages instead of looking freshly updated.
        const heardAt = data.feeds
          .map((feed) => feed?.heardAt)
          .filter(Number.isFinite)
          .map((at) => at + clockOffset);
        lastUpdate = heardAt.length ? Math.max(...heardAt) : null;
        if (selectedId && !records.has(selectedId)) hideCard();
        redraw();
        return true;
      } catch (error) {
        if (controller.signal.aborted || !enabled || pending !== controller)
          return false;
        requestFailed = true;
        // Retain only observations that are still within the original expiry.
        const current = now();
        records = new Map(
          [...records].filter(([, r]) => current - r.lastSeenAt <= MAX_AGE_MS),
        );
        if (selectedId && !records.has(selectedId)) hideCard();
        redraw();
        return false;
      } finally {
        if (pending === controller) pending = null;
      }
    },
    destroy() {
      layer.disable();
      icons?.dispose();
      icons = null;
      records.clear();
      viewer = null;
    },
    getStats() {
      const beaconCount = [...records.values()].filter(
        (record) => record.beaconType,
      ).length;
      return {
        count: enabled ? records.size : 0,
        lastUpdate,
        ...localAisStatus({
          configured,
          feeds,
          heard: records.size - beaconCount,
          beacons: beaconCount,
          requestFailed,
        }),
      };
    },
    /**
     * May this vessel's position go to the hosted model (pointer, entity
     * context, gestures)? Default-deny: only a held, validated, exact fix.
     * @param {string} id MMSI or `local-ais:<MMSI>`.
     * @returns {boolean}
     */
    isPositionTrusted(id) {
      if (!enabled) return false;
      const key = String(id ?? '');
      const mmsi = key.startsWith(PICK_PREFIX)
        ? key.slice(PICK_PREFIX.length)
        : key;
      return exactFix(records.get(mmsi));
    },
    /**
     * Snapshot of the vessels heard locally as plain JSON-safe records for the
     * analyst query engine; [] while the layer is off. Unknown measurements
     * stay null. Default-deny for positions in the text tools: the voice
     * payload carries only the manifest fields, so a fix that is not
     * validated, or is approximate, has `lat` and `lon` set to null here. The
     * model still sees that the vessel or beacon is heard, but this text path
     * does not hand it a flagged fix as coordinates. The map still draws the
     * marker, so a screenshot or a pixel read can locate it. Only
     * `validated === true && approx === false` sends a position.
     * @param {number} [maxCount=2000] Most records to return.
     * @returns {Array<Object>} {id, mmsi, name, lat, lon, speedKts, courseDeg,
     *   validated, approx, beaconType}.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!enabled) return [];
      return [...records.values()].slice(0, maxCount).map((record) => {
        const trusted = exactFix(record);
        return {
          id: record.mmsi,
          mmsi: record.mmsi,
          name: record.name || null,
          lat: trusted ? record.lat : null,
          lon: trusted ? record.lon : null,
          speedKts: record.speed,
          courseDeg: record.course,
          validated: record.validated === true,
          approx: record.approx === true,
          // null for a vessel; sart, mob or epirb for a beacon.
          beaconType: record.beaconType || null,
        };
      });
    },
  };
  return layer;
}
