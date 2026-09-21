import { normalizeFirePerimeterSnapshot } from './records.js';

// NIFC WFIGS current interagency fire perimeters (public, keyless).
// maxAllowableOffset trades ~100 m of boundary fidelity for a payload small
// enough to refresh continuously (~1 MB for a typical fire season).
const API_URL =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/' +
  'WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?' +
  new URLSearchParams({
    where: '1=1',
    outFields: [
      'poly_IncidentName',
      'attr_UniqueFireIdentifier',
      'attr_IncidentSize',
      'attr_PercentContained',
      'attr_POOState',
      'attr_IncidentTypeCategory',
      'attr_FireDiscoveryDateTime',
      'poly_DateCurrent',
      'attr_FireCause',
      'attr_FireBehaviorGeneral',
      'attr_TotalIncidentPersonnel',
      'attr_POOCounty',
      'attr_EstimatedCostToDate',
      'attr_IncidentComplexityLevel',
      'attr_CpxName',
    ].join(','),
    maxAllowableOffset: '0.001',
    outSR: '4326',
    f: 'geojson',
  }).toString();

// The service caps a single response at its maxRecordCount (2000); a peak
// season can exceed that, so follow exceededTransferLimit with offset pages.
const MAX_PAGES = 5;

const exceededTransferLimit = (payload) =>
  payload?.exceededTransferLimit === true ||
  payload?.properties?.exceededTransferLimit === true;

/** Request and validate a complete WFIGS snapshot before it can replace displayed perimeters. */
export function createWfigsPerimeterSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const features = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        signal?.throwIfAborted();
        const url =
          page === 0 ? API_URL : `${API_URL}&resultOffset=${features.length}`;
        const response = await fetchImpl(url, { signal });
        if (!response.ok) throw new Error(`WFIGS HTTP ${response.status}`);
        const payload = await response.json();
        signal?.throwIfAborted();
        if (!Array.isArray(payload?.features))
          throw new Error('Malformed perimeter snapshot');
        features.push(...payload.features);
        if (!exceededTransferLimit(payload) || !payload.features.length) break;
      }
      const rows = normalizeFirePerimeterSnapshot({ features });
      if (!rows) throw new Error('Malformed perimeter snapshot');
      return rows;
    },
  };
}
