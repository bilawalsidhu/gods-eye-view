import { classifyAircraft } from '../../data/aircraftClass.js';
import { stickyText } from '../../data/aircraftMeta.js';
import { createEnrichmentQueue } from '../flights/enrichmentQueue.js';

const ICAO = /^[0-9a-f]{6}$/i;
/** Airline-style callsigns only (LLL + digit); GA tails do not resolve. */
const AIRLINE_CALLSIGN = /^[A-Z]{3}\d/;
/** Bound on the per-session metadata map. */
const META_LIMIT = 2_000;

/**
 * Class of a locally heard aircraft: the adsbdb ICAO type when known, else
 * the emitter category it broadcasts. `evidence` is false when neither is
 * known, so the card never presents the classifier's default as fact.
 * @param {{category?:string|null}} record
 * @param {{typeCode?:string|null}} [meta]
 * @returns {{klass:string, evidence:boolean}}
 */
export function localAdsbClass(record, meta = null) {
  const typeCode = meta?.typeCode || null;
  const category = record?.category || null;
  return {
    klass: classifyAircraft({ typeCode, category }),
    evidence:
      Boolean(typeCode) || /^(?:A[1-7]|B1|C[1-5])$/.test(category || ''),
  };
}

/**
 * Local ADS-B uses the Flights enrichment queue and cached proxy. A temporary
 * failure can be retried after the cool-down.
 * Only the selected aircraft (type + route) and aircraft that
 * are about to render as 3D models (type) are ever looked up — never one
 * request per contact per tick.
 * @param {object} options
 * @param {{getEnrichment?: Function}|null} options.source Flights source.
 * @param {() => void} options.onChange Called when metadata arrives.
 * @param {() => number} [options.now]
 * @returns {object}
 */
export function createLocalAdsbEnrichment({
  source,
  onChange,
  now = () => Date.now(),
}) {
  const meta = new Map();
  let lifetime = new AbortController();
  const queue = createEnrichmentQueue({
    source: () => source,
    signal: () => lifetime.signal,
    now,
  });

  function entry(icao) {
    let value = meta.get(icao);
    if (!value) {
      value = {};
      meta.set(icao, value);
      if (meta.size > META_LIMIT) meta.delete(meta.keys().next().value);
    }
    return value;
  }

  function enqueue(key, query, apply, priority) {
    if (typeof source?.getEnrichment !== 'function') return;
    queue.enqueue(
      key,
      query,
      (data) => {
        apply(data);
        onChange?.();
      },
      priority,
    );
  }

  return {
    /** @param {string} icao @returns {object|null} */
    get(icao) {
      return meta.get(String(icao || '').toLowerCase()) || null;
    },

    /**
     * Ask for the aircraft's type (and, when selected, its route).
     * @param {object} record Local ADS-B record.
     * @param {{selected?: boolean}} [options]
     */
    request(record, { selected = false } = {}) {
      const icao = String(record?.icao || '').toLowerCase();
      if (!ICAO.test(icao)) return;
      enqueue(
        `t:${icao}`,
        { kind: 'type', id: icao },
        (data) => {
          const value = entry(icao);
          value.typeCode = stickyText(data.typeCode, value.typeCode) || null;
          value.typeName = stickyText(data.typeName, value.typeName) || null;
          value.registration =
            stickyText(data.registration, value.registration) || null;
        },
        selected,
      );
      const callsign = String(record.callsign || '')
        .trim()
        .toUpperCase();
      if (!selected || !AIRLINE_CALLSIGN.test(callsign)) return;
      enqueue(
        `r:${callsign}`,
        { kind: 'route', id: callsign },
        (data) => {
          const value = entry(icao);
          value.airline = stickyText(data.airline, value.airline) || null;
          if (data.origin && data.destination)
            value.route = {
              callsign,
              origin: data.origin,
              destination: data.destination,
            };
        },
        true,
      );
    },

    destroy() {
      lifetime.abort();
      lifetime = new AbortController();
      queue.reset();
    },
  };
}
