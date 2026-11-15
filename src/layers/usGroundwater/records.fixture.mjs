/** Invented USGWD-shaped records for tests; no downloaded source data. */
import { displayCoordinate } from './historicalPack.mjs';

const resource = '8b02895f02c14dd1a749bcc5584a5c55';
const release = 'a'.repeat(64);
const input = 'b'.repeat(64);
const url = `https://www.hydroshare.org/resource/${resource}/data/contents/USGWD-Tabular/USGWD_Texas.csv`;
const retrievedAt = '2026-01-01T00:00:00Z';

export const USGWD_ACQUISITION = Object.freeze({
  collection: 'usgwd-historical-baseline',
  url,
  retrievedAt,
  releaseSha256: release,
  inputSha256: input,
  normalizationManifestSha256: 'd'.repeat(64),
  license: 'CC-BY-4.0',
  attribution: 'Invented fixture; no downloaded records',
});

const quantity = (unit, value = null) =>
  value === null
    ? { value: null, quality: 'missing', issue: null, unit }
    : { value, quality: 'valid', issue: null, unit };

/** One valid Texas record. `lon`/`lat` are NAD83 source degrees. */
export function usgwdRecord(
  n = 1,
  { lon = -97.74, lat = 30.27, depthFt } = {},
) {
  const p = displayCoordinate(String(lon), String(lat), 'Texas');
  const sourceRecordId = `SYN_${n}`;
  const id = `USGWD-${release}-${sourceRecordId}`;
  return {
    id,
    source: 'USGWD',
    sourceUrl: `https://www.hydroshare.org/resource/${resource}/`,
    coordinateReference: 'EPSG:4326',
    longitude: p.longitude,
    latitude: p.latitude,
    readings: [],
    metadataRetrievedAt: retrievedAt,
    metadataSourceUrl: url,
    metadata: {
      id,
      recordType: 'historical-well-catalog-record',
      sourceRecordId,
      releaseSha256: release,
      sourceState: 'Texas',
      activeWellStatus: 'not-verified',
      waterSafetyStatus: 'not-assessed',
      sourceCoordinates: {
        longitude: String(lon),
        latitude: String(lat),
        crs: 'EPSG:4269',
        datum: 'NAD83',
        unit: 'decimal-degrees',
      },
      coordinateOperation: {
        operation: p.code,
        sourceCrs: 'EPSG:4269',
        targetCrs: 'EPSG:4326',
        method: 'EPSG:9603',
        translationMetres: p.translation,
        operationAccuracyMetres: p.accuracy,
        intermediateHeightMetres: 0,
        outputHeight: null,
        epoch: null,
      },
      locationFlags: {
        'Location Verified': 'Unknown',
        'Flag County': '0',
        'Flag State': '0',
        'Flag US': '0',
        'Flag Duplicate': '0',
      },
      provenance: {
        inputSha256: input,
        releaseSha256: release,
        sourceRow: 1 + n,
      },
      normalizedContentSha256: 'c'.repeat(64),
      quantities: {
        'Well Depth (Feet)': quantity('ft', depthFt ?? null),
        'Screen Depth (Feet)': quantity('ft'),
        'Length of Screen (Feet)': quantity('ft'),
        'Well Capacity (GPM)': quantity('gal/min'),
        'Surface Elevation (Feet)': quantity('ft'),
      },
      quantityErrors: [],
    },
  };
}

/** A valid snapshot pack holding `records`. */
export function usgwdPack(records = [usgwdRecord()], coverage = {}) {
  return {
    schemaVersion: 1,
    kind: 'gev-us-groundwater-wells',
    mode: 'snapshot',
    coverage: { country: 'US', complete: false, indexed: true, ...coverage },
    acquisitions: [{ ...USGWD_ACQUISITION }],
    records,
  };
}
