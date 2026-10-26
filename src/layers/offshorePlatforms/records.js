/** Portable inventory validation. Absence of a removal date is not operational status. */
export const OFFSHORE_LAYER_ID = 'offshore-platforms';
const SURFACE_TYPES = new Set(['CAIS', 'CT', 'FIXED', 'FPSO', 'MTLP', 'SEMI', 'SPAR', 'TLP', 'WP']);
const SUBSEA_TYPES = new Set(['SSANC', 'SSMNF', 'SSTMP', 'UCOMP']);
const date = (value) => value === null || (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)));

export function structureKind(code) {
  return SUBSEA_TYPES.has(code) ? 'subsea' : SURFACE_TYPES.has(code) ? 'surface' : 'unknown';
}

export function normalizeOffshoreSnapshot(input) {
  if (input?.schemaVersion !== 1 || !Array.isArray(input.records) ||
      !input.metadata?.releaseDate || !date(input.metadata.releaseDate) ||
      !input.metadata?.retrievedDate || !date(input.metadata.retrievedDate)) {
    throw new TypeError('Invalid offshore inventory snapshot');
  }
  const ids = new Set();
  const records = input.records.map((raw) => {
    if (!raw || !/^\d+:\d+$/.test(raw.id) || ids.has(raw.id) ||
        raw.id !== `${raw.complexId}:${raw.structureNumber}` ||
        !Number.isFinite(raw.lon) || raw.lon < -180 || raw.lon > 180 ||
        !Number.isFinite(raw.lat) || raw.lat < -90 || raw.lat > 90 ||
        !date(raw.installed) || !date(raw.removed) || !date(raw.revised)) {
      throw new TypeError('Invalid offshore inventory record');
    }
    ids.add(raw.id);
    return Object.freeze({
      id: raw.id, complexId: raw.complexId, structureNumber: raw.structureNumber,
      name: typeof raw.name === 'string' ? raw.name : null,
      lon: raw.lon, lat: raw.lat,
      installed: raw.installed, removed: raw.removed, revised: raw.revised,
      typeCode: typeof raw.typeCode === 'string' ? raw.typeCode : null,
      kind: structureKind(raw.typeCode),
      area: typeof raw.area === 'string' ? raw.area : null,
      block: typeof raw.block === 'string' ? raw.block : null,
    });
  }).filter((record) => !record.removed && record.typeCode !== 'MOPU');
  return Object.freeze({
    metadata: Object.freeze({releaseDate: input.metadata.releaseDate, retrievedDate: input.metadata.retrievedDate}),
    records: Object.freeze(records),
  });
}
