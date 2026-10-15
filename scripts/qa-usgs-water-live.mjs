#!/usr/bin/env node
/** Bounded live acquisition; writes aggregate evidence only, never station/observation payloads. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createUsgsWaterSource } from 'gods-eye-view/layers/usgs-water/source';
import { normalizeUsgsWaterSnapshot } from '../src/layers/usgsWater/records.js';

const startedAt = new Date().toISOString();
const raw = await createUsgsWaterSource().getSnapshot();
const snapshot = normalizeUsgsWaterSnapshot(raw);
const siteIds = new Set(
  raw.observations.map((row) => row.monitoring_location_id),
);
const seriesIds = new Set(raw.observations.map((row) => row.time_series_id));
assert.equal(
  raw.stations.length,
  siteIds.size,
  'all station identities joined',
);
assert.equal(raw.series.length, seriesIds.size, 'all series identities joined');
assert.equal(
  snapshot.records.length,
  siteIds.size,
  'one marker per monitoring location',
);
assert.equal(
  snapshot.readingCount,
  seriesIds.size,
  'separate readings per series',
);
const summarize = (sites) => ({
  locations: sites.length,
  readings: sites.reduce((total, site) => total + site.readings.length, 0),
  numericReadings: sites.reduce(
    (total, site) => total + site.numericReadingCount,
    0,
  ),
  numericLocations: sites.filter((site) => site.numericReadingCount > 0).length,
  noNumericLocations: sites.filter((site) => site.numericReadingCount === 0)
    .length,
  parameters: [
    ...new Set(
      sites.flatMap((site) => site.readings.map((row) => row.parameterCode)),
    ),
  ].sort(),
  siteTypes: Object.fromEntries(
    [...new Set(sites.map((site) => site.siteType))].map((type) => [
      type,
      sites.filter((site) => site.siteType === type).length,
    ]),
  ),
  approvalStatuses: Object.fromEntries(
    [
      ...new Set(
        sites.flatMap((site) => site.readings.map((row) => row.approvalStatus)),
      ),
    ].map((status) => [
      status,
      sites
        .flatMap((site) => site.readings)
        .filter((row) => row.approvalStatus === status).length,
    ]),
  ),
});
const evidence = {
  startedAt,
  fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
  windowStart: new Date(snapshot.windowStart).toISOString(),
  windowEnd: new Date(snapshot.windowEnd).toISOString(),
  area: summarize(snapshot.records),
  bexarSubset: summarize(snapshot.records.filter((site) => site.bexar)),
  stationJoins: { requested: siteIds.size, joined: raw.stations.length },
  seriesJoins: { requested: seriesIds.size, joined: raw.series.length },
  excludedOutsideWindow: snapshot.excludedOldCount,
};
const directory = path.resolve(
  process.env.QA_SHOTS_DIR || 'qa-shots/usgs-water',
);
await fs.mkdir(directory, { recursive: true });
await fs.writeFile(
  path.join(directory, 'live-summary.json'),
  JSON.stringify(evidence, null, 2),
);
console.log(JSON.stringify(evidence, null, 2));
