/** Pure frame parsing and row copy for the precipitation tiers. */

const DIMENSION_PATTERN = /<Dimension\s+name="([a-z_]+)"([^>]*)>/gi;
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
 * Read the server's own default time steps.
 *
 * The frame is never composed client-side: GeoMet declares `nearestValue="0"`,
 * so a timestamp that drifts past an hour boundary fails outright instead of
 * snapping to the nearest step.
 */
export function readFrame(xml) {
  const text = String(xml || '');
  if (isServiceException(text))
    throw new Error('Precipitation service returned an exception document');
  const defaults = new Map();
  for (const [, name, attributes] of text.matchAll(DIMENSION_PATTERN)) {
    const value = DEFAULT_ATTRIBUTE.exec(attributes)?.[1];
    if (value) defaults.set(name.toLowerCase(), value);
  }
  const validTime = defaults.get('time') || null;
  if (!validTime) throw new Error('Precipitation frame time is unavailable');
  if (Number.isNaN(Date.parse(validTime)))
    throw new Error('Precipitation frame time is malformed');
  const referenceTime = defaults.get('reference_time') || null;
  return {
    validTime,
    // Observation services publish no run; only a model has one.
    referenceTime:
      referenceTime && !Number.isNaN(Date.parse(referenceTime))
        ? referenceTime
        : null,
  };
}

/** Hours between the model run and the step being drawn, or null for an observation. */
export function forecastLeadHours(frame) {
  if (!frame?.referenceTime) return null;
  const lead =
    (Date.parse(frame.validTime) - Date.parse(frame.referenceTime)) / HOUR_MS;
  return Number.isFinite(lead) ? Math.round(lead) : null;
}

function hourStamp(iso) {
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
  const valid = frame ? hourStamp(frame.validTime) : null;
  if (!valid) return null;
  return `${tier?.inlayLabel || tier?.label} ${valid}`;
}
