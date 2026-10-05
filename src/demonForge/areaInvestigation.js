import { appendLedgerEvent, verifyLedger } from './ledger.js';
import { deriveVaultKey, encryptJson, decryptJson } from './crypto.js';

export const AREA_SOURCES = Object.freeze([
  {
    id: 'earthquakes',
    tool: 'get_earthquakes',
    label: 'USGS earthquakes',
    url: 'https://earthquake.usgs.gov/',
    period: 'Last 24 hours, M2.5+',
  },
  {
    id: 'dams',
    tool: 'find_infrastructure',
    kind: 'dams',
    label: 'OpenStreetMap dams',
    url: 'https://www.openstreetmap.org/copyright',
    period: 'Bundled inventory; observation date unknown',
  },
  {
    id: 'datacenters',
    tool: 'find_infrastructure',
    kind: 'datacenters',
    label: 'OpenStreetMap datacenters',
    url: 'https://www.openstreetmap.org/copyright',
    period: 'Bundled inventory; observation date unknown',
  },
  {
    id: 'imagery',
    tool: 'get_recent_imagery',
    label: 'NASA recent imagery',
    url: 'https://hls.gsfc.nasa.gov/',
    period: 'Latest available image, not a historical search',
  },
]);

/** Validate the only information permitted to leave the local case workspace. */
export function validateInvestigationArea(area) {
  if (
    !area ||
    !Number.isFinite(area.lat) ||
    Math.abs(area.lat) > 90 ||
    !Number.isFinite(area.lon) ||
    Math.abs(area.lon) > 180 ||
    !Number.isFinite(area.radius_km) ||
    area.radius_km < 0.1 ||
    area.radius_km > 100
  )
    throw new TypeError(
      'Area needs valid coordinates and a radius of 0.1–100 km.',
    );
  return { lat: area.lat, lon: area.lon, radius_km: area.radius_km };
}

/** Run a bounded public-source query; preserve partial failures as evidence. */
export async function queryInvestigationArea({
  catalog,
  area,
  sourceIds,
  signal,
  now = Date.now,
}) {
  const scope = validateInvestigationArea(area);
  const sources = AREA_SOURCES.filter((source) =>
    sourceIds.includes(source.id),
  );
  if (
    !sources.length ||
    sourceIds.some((id) => !AREA_SOURCES.some((source) => source.id === id))
  )
    throw new TypeError('Select supported public sources.');
  return Promise.all(
    sources.map(async (source) => {
      const retrievedAtMs = now();
      try {
        const args = {
          area: scope,
          ...(source.kind ? { kind: source.kind } : {}),
          ...(source.id !== 'imagery' ? { limit: 25 } : {}),
        };
        const result = await catalog.call(source.tool, args, { signal });
        signal?.throwIfAborted();
        const rows = (result.data.rows ?? []).slice(0, 25).map((row) =>
          Object.fromEntries(
            Object.entries(row)
              .filter(
                ([, value]) =>
                  value === null ||
                  ['string', 'number', 'boolean'].includes(typeof value),
              )
              .map(([key, value]) => [
                key,
                typeof value === 'string' ? value.slice(0, 2000) : value,
              ]),
          ),
        );
        return {
          sourceId: source.id,
          source: source.label,
          sourceUrl: source.url,
          coverage: source.period,
          area: scope,
          retrievedAtMs,
          status: 'available',
          summary: String(result.summary).slice(0, 4000),
          rows,
          total: result.data.total ?? rows.length,
          truncated: Boolean(result.data.truncated),
          attribution: result.data.attribution ?? null,
          stale: result.data.stale ?? null,
          observedAt: result.data.fetched_at ?? result.data.image?.day ?? null,
          image: result.data.image ?? null,
          missingSources:
            result.data.missing_sources ?? result.data.search_errors ?? [],
          confidence: 'unassessed',
        };
      } catch (error) {
        signal?.throwIfAborted();
        return {
          sourceId: source.id,
          source: source.label,
          sourceUrl: source.url,
          coverage: source.period,
          area: scope,
          retrievedAtMs,
          status: 'unavailable',
          error: [
            'unavailable',
            'unsupported',
            'retry_later',
            'invalid_arguments',
            'malformed',
          ].includes(error?.code)
            ? error.code
            : 'unavailable',
          summary: 'No usable result. This does not establish absence.',
          rows: [],
          confidence: 'unassessed',
        };
      }
    }),
  );
}

/** Append a timestamped observation, hypothesis or contradiction without rewriting history. */
export function appendInvestigationEntry(record, entry, nowMs = Date.now()) {
  if (
    ![
      'observation',
      'hypothesis',
      'contradiction',
      'note',
      'manual-follow-up',
    ].includes(entry.kind)
  )
    throw new TypeError('Unsupported evidence kind.');
  if (
    typeof entry.text !== 'string' ||
    !entry.text.trim() ||
    entry.text.length > 8000
  )
    throw new TypeError('Evidence text is required (maximum 8000 characters).');
  if (
    !['unassessed', 'low', 'medium', 'high'].includes(
      entry.confidence ?? 'unassessed',
    )
  )
    throw new TypeError('Invalid confidence.');
  if ((record.workflow?.length ?? 0) >= 500)
    throw new TypeError('Case limit reached (500 entries).');
  const value = {
    ...entry,
    text: entry.text.trim(),
    confidence: entry.confidence ?? 'unassessed',
    atMs: nowMs,
  };
  const ledger = appendLedgerEvent(
    record.ledger ?? [],
    { type: 'AREA_EVIDENCE_ADDED', actor: 'operator', payload: value },
    nowMs,
  );
  return { ...record, ledger, workflow: [...(record.workflow ?? []), value] };
}

/** Export only an authenticated encrypted backup with a separately supplied passphrase. */
export async function encryptInvestigationBackup(
  record,
  passphrase,
  cryptoApi = globalThis.crypto,
) {
  if (typeof passphrase !== 'string' || passphrase.length < 12)
    throw new TypeError('Backup passphrase needs at least 12 characters.');
  const key = await deriveVaultKey(
    passphrase,
    cryptoApi.getRandomValues(new Uint8Array(16)),
    cryptoApi,
  );
  return {
    format: 'gods-eye-view/area-case',
    version: 1,
    envelope: await encryptJson(
      key,
      record,
      cryptoApi.getRandomValues(new Uint8Array(12)),
      cryptoApi,
    ),
  };
}

/** Authenticate and validate a backup before allowing creation in a separate vault. */
export async function decryptInvestigationBackup(
  text,
  passphrase,
  cryptoApi = globalThis.crypto,
) {
  if (
    typeof text !== 'string' ||
    new TextEncoder().encode(text).length > 8 * 1024 * 1024
  )
    throw new TypeError('Backup limit is 8 MiB.');
  const backup = JSON.parse(text);
  if (backup.format !== 'gods-eye-view/area-case' || backup.version !== 1)
    throw new TypeError('Unsupported backup.');
  const binary = atob(
    backup.envelope.salt.replaceAll('-', '+').replaceAll('_', '/'),
  );
  const key = await deriveVaultKey(
    passphrase,
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    cryptoApi,
  );
  const record = await decryptJson(key, backup.envelope, cryptoApi);
  validateInvestigationArea(record.area);
  if (
    record.kind !== 'area-investigation' ||
    !Array.isArray(record.workflow) ||
    record.workflow.length > 500 ||
    !verifyLedger(record.ledger).ok ||
    record.ledger.length !== record.workflow.length + 1
  )
    throw new TypeError('Invalid case history.');
  if (
    record.ledger[0]?.type !== 'AREA_CASE_CREATED' ||
    JSON.stringify(record.ledger[0]?.payload?.area) !==
      JSON.stringify(record.area)
  )
    throw new TypeError('Invalid case origin.');
  for (let i = 0; i < record.workflow.length; i++) {
    const entry = record.workflow[i];
    if (
      ![
        'observation',
        'hypothesis',
        'contradiction',
        'note',
        'manual-follow-up',
      ].includes(entry.kind) ||
      typeof entry.text !== 'string' ||
      entry.text.length > 8000 ||
      !Number.isSafeInteger(entry.atMs) ||
      entry.atMs < 0 ||
      entry.atMs > 8.64e15 ||
      !['unassessed', 'low', 'medium', 'high'].includes(entry.confidence) ||
      JSON.stringify(record.ledger[i + 1].payload) !== JSON.stringify(entry)
    )
      throw new TypeError('Invalid evidence history.');
    if (entry.snapshot) {
      const source = AREA_SOURCES.find(
        (source) => source.id === entry.snapshot.sourceId,
      );
      if (
        !source ||
        entry.snapshot.sourceUrl !== source.url ||
        !Number.isSafeInteger(entry.snapshot.retrievedAtMs) ||
        entry.snapshot.retrievedAtMs < 0 ||
        entry.snapshot.retrievedAtMs > 8.64e15 ||
        !Array.isArray(entry.snapshot.rows) ||
        entry.snapshot.rows.length > 25
      )
        throw new TypeError('Invalid source snapshot.');
      validateInvestigationArea(entry.snapshot.area);
    }
  }
  return record;
}
