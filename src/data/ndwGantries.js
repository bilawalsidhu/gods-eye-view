/**
 * Fold NDW measurement sites into the gantries a driver would recognise.
 *
 * A cross-section of motorway publishes one site per lane and vehicle class:
 * measured on the A20 at Kethelplein, fourteen sites share a single
 * coordinate. Drawn raw that is fourteen stacked points saying fourteen
 * different numbers about one place. Folding them by position gives one point
 * per gantry, and the number that matters is the SLOWEST lane — a blocked lane
 * is what a jam is, and averaging it against a free one hides exactly the
 * thing the layer exists to show.
 *
 * Pure: no network, no Cesium, no Node built-ins.
 */

/** Colour bands, slowest first. `upTo` is exclusive. */
export const NDW_SPEED_BANDS = Object.freeze([
  Object.freeze({ id: 'jam', upTo: 25, label: 'stilstaand' }),
  Object.freeze({ id: 'slow', upTo: 50, label: 'stapvoets' }),
  Object.freeze({ id: 'busy', upTo: 80, label: 'druk' }),
  Object.freeze({ id: 'flowing', upTo: Infinity, label: 'vrij' }),
]);

/**
 * Band for one speed. A null speed has no band: a site that measured nothing
 * must not be coloured as free-flowing.
 * @param {?number} kph
 * @returns {?string}
 */
export function speedBand(kph) {
  if (!Number.isFinite(kph) || kph < 0) return null;
  return NDW_SPEED_BANDS.find((b) => kph < b.upTo)?.id ?? 'flowing';
}

/** Six decimals ≈ 11 cm: the same mast, never two different ones. */
function positionKey(lat, lon) {
  return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

/**
 * Join measurements to their sites and fold them by position.
 *
 * @param {Array<{siteId:string, speedKph:?number, flowVph:?number, lanes:number, at:?string}>} measurements
 * @param {Map<string,{lat:number, lon:number, name:string}>} sites
 * @returns {Array<{key:string, lat:number, lon:number, name:string, slowestKph:number,
 *   fastestKph:number, flowVph:number, sensors:number, band:string, at:?string}>}
 */
export function aggregateByGantry(measurements, sites) {
  const byPosition = new Map();
  for (const m of measurements || []) {
    if (!Number.isFinite(m?.speedKph)) continue; // no speed, nothing to colour
    const site = sites?.get(m.siteId);
    if (!site) continue;
    const key = positionKey(site.lat, site.lon);
    let g = byPosition.get(key);
    if (!g) {
      g = {
        key,
        lat: site.lat,
        lon: site.lon,
        name: site.name || '',
        slowestKph: m.speedKph,
        fastestKph: m.speedKph,
        flowVph: 0,
        sensors: 0,
        at: m.at || null,
      };
      byPosition.set(key, g);
    }
    if (m.speedKph < g.slowestKph) g.slowestKph = m.speedKph;
    if (m.speedKph > g.fastestKph) g.fastestKph = m.speedKph;
    if (Number.isFinite(m.flowVph)) g.flowVph += m.flowVph;
    g.sensors += 1;
    // Prefer a human name over a MONICA code: Rijkswaterstaat names its sites
    // `00D01001D404D007000B`, the provinces name theirs `N470 km 8.949 Re`.
    if (isCodedName(g.name) && !isCodedName(site.name)) g.name = site.name;
  }
  for (const g of byPosition.values()) g.band = speedBand(g.slowestKph);
  return [...byPosition.values()];
}

/**
 * Is this a machine identifier rather than a road name?
 * Rijkswaterstaat publishes MONICA hex codes where the provinces publish text.
 * @param {string} name
 * @returns {boolean}
 */
export function isCodedName(name) {
  return /^[0-9A-F]{12,}$/i.test(String(name ?? '').trim());
}

/**
 * Gantries inside a bounding box, nearest the centre first, capped.
 * @param {Array<object>} gantries
 * @param {{south:number, west:number, north:number, east:number}} box
 * @param {number} [limit=600]
 * @returns {Array<object>}
 */
export function gantriesInBox(gantries, box, limit = 600) {
  if (!box || ![box.south, box.west, box.north, box.east].every(Number.isFinite)) return [];
  const midLat = (box.south + box.north) / 2;
  const midLon = (box.west + box.east) / 2;
  const inside = (gantries || []).filter((g) => g.lat >= box.south && g.lat <= box.north
    && g.lon >= box.west && g.lon <= box.east);
  if (inside.length <= limit) return inside;
  // Over the cap the centre of the view is what the driver is looking at, so
  // distance decides — never the feed's own order, which is by supplier.
  return inside
    .map((g) => ({ g, d: ((g.lat - midLat) * 111) ** 2 + ((g.lon - midLon) * 68) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.g);
}
