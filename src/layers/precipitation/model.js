/** Pure frame parsing and row copy for the precipitation tiers. */

/**
 * One XML tag. Attribute values are matched as quoted runs so a `>` inside one
 * cannot end the tag early, and the `?` and `!` forms — the declaration,
 * comments, CDATA — never match at all.
 */
const TAG_PATTERN =
  /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
const NAME_ATTRIBUTE = /\bname="([^"]*)"/i;
const DEFAULT_ATTRIBUTE = /\bdefault="([^"]+)"/i;
const HOUR_MS = 60 * 60 * 1000;

/**
 * A WMS server answers a bad request with HTTP 200 and an exception document,
 * which Cesium would render as an empty layer. Every response is screened.
 */
export function isServiceException(text) {
  return /<(?:\w+:)?ServiceException/i.test(String(text || ''));
}

/** Build the single-layer capabilities URL; the unfiltered document is ~39 MB. */
export function capabilitiesUrl(tier) {
  const url = new URL(tier.service);
  url.searchParams.set('SERVICE', 'WMS');
  url.searchParams.set('VERSION', '1.3.0');
  url.searchParams.set('REQUEST', 'GetCapabilities');
  url.searchParams.set('LAYERS', tier.wmsLayer);
  return url.href;
}

/**
 * The default time steps one named layer advertises, inherited steps included.
 *
 * Scanning the whole document for the first `<Dimension name="time">` only
 * works while every service honours `&LAYERS=` and answers with a single
 * layer. Not all of them do, and a document carrying several would silently
 * pin some other layer's step into the tile requests — the wrong data,
 * arriving with no error. So the parse is scoped to the `<Layer>` whose
 * `<Name>` is the one being drawn.
 *
 * Two details of WMS shape the walk. `<Layer>` nests, and a child inherits its
 * ancestors' dimensions, so the enclosing scopes are merged outermost first
 * and a nearer declaration wins. And `<Dimension>` comes *after* `<Name>`
 * within a layer, so a match is resolved as that layer closes rather than at
 * the point its name is recognised.
 */
function layerDimensions(text, wmsLayer) {
  // One Map of dimensions per open <Layer>, outermost first.
  const enclosing = [];
  // The element stack, so a <Style><Name> is never read as a layer's name.
  const elements = [];
  let nameStart = -1;
  let targetDepth = -1;

  TAG_PATTERN.lastIndex = 0;
  for (let tag; (tag = TAG_PATTERN.exec(text)) !== null;) {
    const [, closing, raw, attributes, selfClosing] = tag;
    // Drop any namespace prefix: `wms:Layer` and `Layer` are the same element.
    const element = raw.toLowerCase().replace(/^[^:]*:/, '');
    const parent = elements.at(-1);

    if (closing) {
      if (element === 'name' && nameStart >= 0) {
        if (text.slice(nameStart, tag.index).trim() === wmsLayer)
          targetDepth = enclosing.length;
        nameStart = -1;
      }
      if (element === 'layer') {
        if (enclosing.length === targetDepth) {
          const resolved = new Map();
          for (const scope of enclosing)
            for (const [key, value] of scope) resolved.set(key, value);
          return resolved;
        }
        enclosing.pop();
      }
      elements.pop();
      continue;
    }

    if (element === 'layer') {
      enclosing.push(new Map());
      if (selfClosing) enclosing.pop();
    } else if (element === 'dimension' && parent === 'layer') {
      const key = NAME_ATTRIBUTE.exec(attributes)?.[1]?.toLowerCase();
      const value = DEFAULT_ATTRIBUTE.exec(attributes)?.[1];
      if (key && value) enclosing.at(-1)?.set(key, value);
    } else if (element === 'name' && parent === 'layer' && !selfClosing) {
      nameStart = TAG_PATTERN.lastIndex;
    }
    if (!selfClosing) elements.push(element);
  }
  return null;
}

/**
 * Read the server's own default time steps for the layer being drawn.
 *
 * The frame is never composed client-side: GeoMet declares `nearestValue="0"`,
 * so a timestamp that drifts past an hour boundary fails outright instead of
 * snapping to the nearest step.
 */
export function readFrame(xml, wmsLayer) {
  const text = String(xml || '');
  if (isServiceException(text))
    throw new Error('Precipitation service returned an exception document');
  if (!wmsLayer)
    throw new TypeError('Reading a frame requires the layer to read it from');
  const defaults = layerDimensions(text, wmsLayer);
  if (!defaults)
    throw new Error(
      `Precipitation layer ${wmsLayer} is not in the capabilities`,
    );
  const validTime = defaults.get('time') || null;
  if (!validTime) throw new Error('Precipitation frame time is unavailable');
  if (Number.isNaN(Date.parse(validTime)))
    throw new Error('Precipitation frame time is malformed');
  const referenceTime = defaults.get('reference_time') || null;
  return {
    key: validTime,
    validTime,
    // Observation services publish no run; only a model has one.
    referenceTime:
      referenceTime && !Number.isNaN(Date.parse(referenceTime))
        ? referenceTime
        : null,
  };
}

/**
 * A frame for a service that publishes no time dimension at all.
 *
 * IEM serves whatever is current and advertises no `time`, so there is nothing
 * to read or pin. The poll stamp is the change key so a refresh still rebuilds
 * the layer, but no valid time is claimed on the row.
 */
export function liveFrame(now = Date.now()) {
  return { key: `live:${now}`, validTime: null, referenceTime: null };
}

/** Hours between the model run and the step being drawn, or null for an observation. */
export function forecastLeadHours(frame) {
  if (!frame?.referenceTime) return null;
  const lead =
    (Date.parse(frame.validTime) - Date.parse(frame.referenceTime)) / HOUR_MS;
  return Number.isFinite(lead) ? Math.round(lead) : null;
}

function hourStamp(iso) {
  // `new Date(null)` is the epoch, not an invalid date — guard before parsing.
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const hours = String(parsed.getUTCHours()).padStart(2, '0');
  const minutes = String(parsed.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}Z`;
}

/**
 * The count slot carries the forecast lead, because an imagery layer counts
 * nothing and the lead is what tells a reader how much to trust the field.
 */
export function leadLabel(frame) {
  if (!frame?.validTime) return 'LIVE';
  const lead = forecastLeadHours(frame);
  if (lead === null) return 'LIVE';
  return `+${lead}H`;
}

/**
 * Row copy: what kind of field this is, which run produced it, and the step it
 * is valid for. The service name is already carried by the layer's `source`.
 */
export function frameMessage(tier, frame) {
  if (!frame) return null;
  if (!frame.validTime) return tier?.forecast ? 'MODEL' : 'OBSERVED · LIVE';
  const parts = [tier?.forecast ? 'MODEL' : 'OBSERVED'];
  if (frame.referenceTime) {
    const run = hourStamp(frame.referenceTime);
    if (run) parts.push(`${run.slice(0, 2)}Z RUN`);
  }
  const valid = hourStamp(frame.validTime);
  if (valid) parts.push(`VALID ${valid}`);
  return parts.join(' · ');
}

/** Compact note that a sharper source is covering part of the view. */
export function inlayMessage(tier, frame) {
  if (!frame) return null;
  const label = tier?.inlayLabel || tier?.label;
  const valid = hourStamp(frame.validTime);
  // An undated service states that it is live rather than inventing a stamp.
  return valid ? `${label} ${valid}` : `${label} LIVE`;
}
