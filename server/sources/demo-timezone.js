/**
 * server/sources/demo-timezone.js — `demo.timezone`, the dynamic-capability
 * probe of the capability loop (docs/audit/capability-loop-verification.md):
 * a deterministic, network-free adapter (nautical time zone = longitude /
 * 15°, rounded) registered with ZERO frontend changes to prove that
 * OnDemand selects a capability it has never seen before purely from the
 * registry catalogue. Not a production time-zone service (no political
 * boundaries, no DST) — completeness is therefore always 'estimated'.
 */

import { validateParams, provenance, isoUtc } from './_shared.js';

export const PROVIDER = 'demo.timezone (nautical zones, computed locally)';
export const SOURCE_URL = 'local://demo-timezone';
export const LICENSE = Object.freeze({
  name: 'Repository (MIT, computed value — no upstream data)',
  url: 'https://github.com/bilawalsidhu/gods-eye-view/blob/main/LICENSE',
  attribution: "God's Eye View demo.timezone (nautical zone estimate)",
});
export const SPEC = Object.freeze({
  lat: { type: 'number', required: true, min: -90, max: 90 },
  lon: { type: 'number', required: true, min: -180, max: 180 },
  at: { type: 'iso-date' },
});

export async function fetchTimezone(query, { now = () => new Date() } = {}) {
  const v = validateParams(query, SPEC);
  if (!v.ok) return v;
  const { lat, lon, at } = v.params;
  const offsetHours = Math.max(-12, Math.min(12, Math.round(lon / 15)));
  const sign = offsetHours >= 0 ? '+' : '-';
  const abs = Math.abs(offsetHours);
  const utcOffset = `${sign}${String(abs).padStart(2, '0')}:00`;
  const reference = at ? new Date(at) : now();
  const local = new Date(reference.getTime() + offsetHours * 3600 * 1000);
  const fetchedAt = isoUtc(now());
  return {
    ok: true,
    status: 200,
    data: {
      source: PROVIDER,
      count: 1,
      items: [
        {
          id: `nautical-zone-${utcOffset}`,
          latitude: lat,
          longitude: lon,
          utc_offset: utcOffset,
          utc_offset_hours: offsetHours,
          reference_utc: reference.toISOString(),
          local_time_estimate: local.toISOString().replace('Z', utcOffset),
          method: 'nautical zone (longitude / 15°, rounded)',
        },
      ],
    },
    provenance: provenance({
      provider: PROVIDER,
      source_url: SOURCE_URL,
      license: LICENSE,
      fetched_at: fetchedAt,
      freshness: { kind: 'live', computed_at: fetchedAt },
      coverage: { kind: 'global', method: 'nautical' },
      completeness: {
        status: 'estimated',
        reason: 'nautical zone only; ignores political boundaries and DST',
      },
    }),
  };
}
