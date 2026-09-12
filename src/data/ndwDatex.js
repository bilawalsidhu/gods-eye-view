/**
 * DATEX II readers for the Dutch national road-traffic feeds (NDW).
 *
 * Two feeds, joined on measurement-site id:
 *  - `trafficspeed.xml.gz`  — 20k sites, refreshed each minute, 50 MB of XML
 *                             and NOT ONE COORDINATE in it.
 *  - `measurement.xml.gz`   — the site table that holds the coordinates: 336 MB.
 *
 * Neither fits in a string: a 336 MB document is ~670 MB of UTF-16. So both
 * readers are fed chunks and split on record boundaries, carrying the tail
 * across chunk edges. That makes them streamable in the proxy and testable
 * against a handful of bytes in node:test.
 *
 * Pure string work: no network, no Node built-ins, no XML dependency.
 */

/** Text of the first `<tag>…</tag>` in `xml`, or null. */
function tagText(xml, tag) {
  const open = xml.indexOf(`<${tag}>`);
  if (open === -1) return null;
  const from = open + tag.length + 2;
  const close = xml.indexOf(`</${tag}>`, from);
  return close === -1 ? null : xml.slice(from, close);
}

/** Value of `attr` on the first occurrence of `tag`, or null. */
function attrOf(xml, tag, attr) {
  const at = xml.indexOf(`<${tag} `);
  if (at === -1) return null;
  const end = xml.indexOf('>', at);
  const head = xml.slice(at, end === -1 ? undefined : end);
  const m = new RegExp(`${attr}="([^"]*)"`).exec(head);
  return m ? m[1] : null;
}

/**
 * One `<measurementSiteRecord>` → its id, display point and name.
 *
 * `locationForDisplay` is the point DATEX II publishes for showing the site on
 * a map, which is what this is for. A record without one is skipped rather
 * than positioned from the alertC linear reference, which would need the whole
 * TMC location table to resolve.
 * @param {string} record - One record's XML.
 * @returns {?{id:string, lat:number, lon:number, name:string}}
 */
export function parseSiteRecord(record, wanted = null) {
  const id = attrOf(record, 'measurementSiteRecord', 'id');
  if (!id) return null;
  // The site table holds 87,771 records; a live traffic body references 20,532
  // of them. Filtering on the id before parsing the rest of a 17 KB record is
  // what keeps the table from costing half a gigabyte of heap.
  if (wanted && !wanted.has(id)) return null;
  const display = record.indexOf('<locationForDisplay>');
  if (display === -1) return null;
  const scope = record.slice(display, display + 400);
  const lat = Number(tagText(scope, 'latitude'));
  const lon = Number(tagText(scope, 'longitude'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  // measurementSiteName wraps its text in <values><value lang="nl">…
  let name = '';
  const nameAt = record.indexOf('<measurementSiteName>');
  if (nameAt !== -1) {
    const nameEnd = record.indexOf('</measurementSiteName>', nameAt);
    const chunk = record.slice(nameAt, nameEnd === -1 ? nameAt + 400 : nameEnd);
    // `<values>` also starts with `<value`, so the plural wrapper matches first
    // and the name comes back with its own tag glued to the front. The trailing
    // space is what separates `<value lang="nl">` from `<values>`.
    const valueAt = chunk.indexOf('<value ');
    if (valueAt !== -1) {
      const from = chunk.indexOf('>', valueAt) + 1;
      const to = chunk.indexOf('</value>', from);
      if (to !== -1) name = chunk.slice(from, to).trim();
    }
  }
  return { id, lat, lon, name };
}

/**
 * One `<siteMeasurements>` block → the site's speed and flow.
 *
 * A site publishes one measuredValue per lane and vehicle class. Speeds are
 * averaged over the lanes that actually measured: `speed` is -1 and
 * `numberOfInputValuesUsed` is 0 when a loop had no vehicle to time, and
 * averaging those in drags every quiet road towards zero. Flow is summed,
 * because each lane's rate is a separate share of the same carriageway.
 * @param {string} block - One block's XML.
 * @returns {?{siteId:string, speedKph:?number, flowVph:?number, lanes:number, at:?string}}
 */
export function parseSiteMeasurement(block) {
  const siteId = attrOf(block, 'measurementSiteReference', 'id');
  if (!siteId) return null;

  let speedSum = 0;
  let speedCount = 0;
  let flowSum = 0;
  let flowCount = 0;

  const SPEED = '<averageVehicleSpeed';
  for (let i = block.indexOf(SPEED); i !== -1; i = block.indexOf(SPEED, i + 1)) {
    const head = block.slice(i, block.indexOf('>', i));
    const used = /numberOfInputValuesUsed="(\d+)"/.exec(head);
    if (used && Number(used[1]) === 0) continue;
    const speed = Number(tagText(block.slice(i, i + 200), 'speed'));
    if (!Number.isFinite(speed) || speed < 0) continue;
    speedSum += speed;
    speedCount += 1;
  }

  const FLOW = '<vehicleFlowRate>';
  for (let i = block.indexOf(FLOW); i !== -1; i = block.indexOf(FLOW, i + 1)) {
    const rate = Number(tagText(block.slice(i, i + 60), 'vehicleFlowRate'));
    if (!Number.isFinite(rate) || rate < 0) continue;
    flowSum += rate;
    flowCount += 1;
  }

  if (speedCount === 0 && flowCount === 0) return null;
  return {
    siteId,
    speedKph: speedCount ? Math.round(speedSum / speedCount) : null,
    flowVph: flowCount ? flowSum : null,
    lanes: speedCount,
    at: tagText(block, 'measurementTimeDefault'),
  };
}

/**
 * Chunk-fed reader: hands each complete `<tag>…</tag>` record to `onRecord`.
 *
 * Records straddle chunk boundaries — a 50 MB body arrives in thousands of
 * pieces — so the unterminated tail is carried into the next call.
 * @param {string} tag - Record element name.
 * @param {(record: string) => void} onRecord
 * @returns {{push:(chunk:string)=>void, end:()=>void}}
 */
export function createRecordScanner(tag, onRecord) {
  const close = `</${tag}>`;
  const open = `<${tag}`;
  /**
   * An element may open with attributes (`<siteMeasurements xmlns:…>`) or
   * without (`<siteMeasurements>`), and a longer sibling name must not match:
   * `measurementSiteRecordVersionTime` starts with `measurementSiteRecord`.
   */
  const opensHere = (text, at) => {
    const next = text[at + open.length];
    return next === ' ' || next === '>' || next === '\t' || next === '\n' || next === '\r';
  };
  let carry = '';
  return {
    push(chunk) {
      carry += chunk;
      let at = carry.indexOf(close);
      while (at !== -1) {
        const end = at + close.length;
        let start = carry.lastIndexOf(open, at);
        while (start !== -1 && !opensHere(carry, start)) {
          start = carry.lastIndexOf(open, start - 1);
        }
        if (start !== -1) onRecord(carry.slice(start, end));
        carry = carry.slice(end);
        at = carry.indexOf(close);
      }
      // A carry that can never complete would grow without bound; one record is
      // ~17 KB, so anything past a megabyte is a malformed document.
      if (carry.length > 1_000_000) carry = carry.slice(-1_000_000);
    },
    end() { carry = ''; },
  };
}
