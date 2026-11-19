/**
 * Mirror of OpenTrafficMap's full `/ws_ext` stream (opt-in high-bandwidth mode).
 * Vehicle tracks in the stream are ignored; only current stations are kept.
 *
 * Unlike the tiled socket, this stream carries every station the network
 * hears: one `snapshot` (~16 MB uncompressed) followed by `delta` messages
 * of whole upserted features several times a second, plus
 * `traffic-light-map-batch` / `traffic-light-map` geometry messages.
 * The merged shape matches the tile store so the same compaction applies.
 */
/** Mirror ceiling; the whole network is ~4,300 stations today. */
export const CITS_FULL_MAX_POINTS = 50_000;
export const CITS_FULL_MAX_MAPS = 10_000;

export function createCitsFullStore() {
  const points = new Map();
  const maps = new Map();
  let mapsVersion = 0;
  let ready = false;

  const featureId = (feature) =>
    feature?.id != null ? String(feature.id) : feature?.properties?.mac;
  const features = (collection) =>
    Array.isArray(collection)
      ? collection
      : Array.isArray(collection?.features)
        ? collection.features
        : Object.values(collection || {});

  function setMap(entry) {
    if (!entry?.mac) return;
    if (entry.map && !maps.has(entry.mac) && maps.size >= CITS_FULL_MAX_MAPS)
      return;
    if (entry.map) maps.set(entry.mac, entry);
    else maps.delete(entry.mac);
    mapsVersion++;
  }

  return {
    /** Apply one decoded upstream message; ignores types it does not mirror. */
    apply(message) {
      switch (message?.type) {
        case 'snapshot':
        case 'fullstatus':
          points.clear();
          for (const feature of features(message.points)) {
            const id = featureId(feature);
            if (id && points.size < CITS_FULL_MAX_POINTS)
              points.set(id, feature);
          }
          ready = true;
          break;
        case 'delta':
          for (const feature of features(message.upsertPoints)) {
            const id = featureId(feature);
            if (!id) continue;
            if (!points.has(id) && points.size >= CITS_FULL_MAX_POINTS)
              continue;
            points.set(id, feature);
          }
          for (const id of message.removePoints || [])
            points.delete(String(id));
          break;
        case 'traffic-light-map-batch':
          for (const entry of message.entries || []) setMap(entry);
          break;
        case 'traffic-light-map':
          setMap(message);
          break;
        default:
          break;
      }
    },

    clear() {
      points.clear();
      if (maps.size) mapsVersion++;
      maps.clear();
      ready = false;
    },

    get ready() {
      return ready;
    },
    get mapsVersion() {
      return mapsVersion;
    },
    get size() {
      return points.size;
    },

    merged: () => ({ points, maps }),
  };
}
