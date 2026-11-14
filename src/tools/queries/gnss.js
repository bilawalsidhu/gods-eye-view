/** Read-only GNSS quality observations, not proof of jamming or spoofing. */
import {
  GNSS_PROVENANCE,
  GNSS_WINDOW_MS,
  accumulateGnssObservations,
  binGnssCells,
} from '../../layers/gnss/records.js';
import { defineTool, ToolError } from '../catalog.js';
import { POINT_SCHEMA, resolvePoint } from '../area.js';
import { LIMIT_SCHEMA, capRows, isoTime } from '../results.js';

const HEX = /^~?[0-9a-f]{6}$/;

/** Classify one regional snapshot through the same pure logic as the layer. */
export const getGnssIntegrity = defineTool({
  name: 'get_gnss_integrity',
  title: 'GNSS navigation integrity',
  description:
    'Aircraft-reported navigation-integrity cells around a point. ' +
    'These are unvalidated low-accuracy indicators, NOT confirmed GPS interference.',
  inputSchema: {
    type: 'object',
    properties: { location: POINT_SCHEMA, limit: LIMIT_SCHEMA },
    required: ['location'],
    additionalProperties: false,
  },
  requires: ['gnss'],
  async run(args, { services, signal }) {
    const point = await resolvePoint(args.location, { services, signal });
    const snapshot = await services.gnss.getSnapshot(
      { latitude: point.lat, longitude: point.lon },
      { signal },
    );
    if (
      !Array.isArray(snapshot?.rows) ||
      !Number.isFinite(snapshot.ageMs) ||
      snapshot.ageMs < 0
    )
      throw new ToolError(
        'malformed',
        'GNSS snapshot has no valid observation window',
      );

    const now = Date.now();
    const stale = snapshot.stale === true || snapshot.ageMs > GNSS_WINDOW_MS;
    const observations = new Map();
    if (!stale) {
      const valid = snapshot.rows.filter(
        (row) =>
          typeof row?.hex === 'string' &&
          HEX.test(row.hex) &&
          Number.isFinite(row.lat) &&
          Math.abs(row.lat) <= 90 &&
          Number.isFinite(row.lon) &&
          Math.abs(row.lon) <= 180 &&
          typeof row.degraded === 'boolean',
      );
      accumulateGnssObservations(observations, valid, now, {
        observedAt: now - snapshot.ageMs,
      });
    }
    const cells = binGnssCells(observations)
      .sort(
        (a, b) =>
          ({ high: 2, medium: 1, low: 0 })[b.level] -
            { high: 2, medium: 1, low: 0 }[a.level] || a.id.localeCompare(b.id),
      )
      .map((cell) => ({
        id: cell.id,
        lat: cell.lat,
        lon: cell.lon,
        level: cell.level,
        state: cell.state,
        aircraft: cell.aircraft,
        degraded: cell.degraded,
        percent_degraded: cell.percentDegraded,
        interpretation: cell.interpretation,
      }));
    const anomalies = cells.filter((cell) => cell.level !== 'low').length;
    const summary = stale
      ? `GNSS observations near ${point.label} are stale; no current assessment.`
      : cells.length
        ? `${cells.length} navigation-integrity ${cells.length === 1 ? 'cell' : 'cells'} near ${point.label}, ${anomalies} anomalous. This does not prove GNSS interference.`
        : `No sufficiently sampled navigation-integrity cells near ${point.label}; this does not establish normal GPS operation.`;
    return {
      summary,
      data: {
        location: point,
        stale,
        observed_at: stale ? null : isoTime(now - snapshot.ageMs),
        observation_age_ms: snapshot.ageMs,
        window_ms: GNSS_WINDOW_MS,
        classifier: snapshot.classifier ?? GNSS_PROVENANCE.classifier.id,
        provenance: GNSS_PROVENANCE,
        caveat:
          'Low aircraft-reported position accuracy has multiple causes; GNSS interference is unconfirmed.',
        anomaly_cells: anomalies,
        ...capRows(cells, args.limit),
      },
    };
  },
});
