/**
 * Data acquisition source for ABYSS deep-sea layer.
 * Manages GEBCO bathymetry configuration, NOAA PMEL hydrothermal vent records,
 * and NOAA Ocean Exploration ROV dive locations and tracks.
 */

import {
  normalizeBathymetryConfig,
  normalizeVentSnapshot,
  normalizeDiveSnapshot,
  normalizeDiveTrackRecord,
} from './records.js';
import bundledVents from './vents.json' with { type: 'json' };

const NOAA_EX_DIVES_URL =
  'https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/EX_ROV_Dive_Pts/FeatureServer/0/query';
const NOAA_EX_TRACKS_URL =
  'https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/EX_rov_nav_gdb/FeatureServer/0/query';

const DIVE_QUERY_FIELDS = [
  'OBJECTID',
  'cruise_id',
  'dive_id',
  'cruise_dive_id',
  'vessel',
  'platform',
  'Year',
  'Cruise',
  'Cruise_Dates',
  'latitude',
  'longitude',
  'Summary',
  'OE_Link',
  'ROV_Summary_Products',
  'Archive',
  'MaxDepth',
  'DiveDuration',
].join(',');

const TRACK_QUERY_FIELDS = [
  'OBJECTID',
  'CruiseDiveID',
  'CruiseID',
  'DiveID',
  'Vessel',
  'Platform',
  'Year',
  'Cruise',
  'Cruise_Dates',
  'Summary',
  'MaxVehicleDepth',
  'OE_Link',
  'Shape__Length',
].join(',');

export function createAbyssSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiUrl = '/api/abyss',
  bathymetryOptions,
} = {}) {
  const bathymetryConfig = normalizeBathymetryConfig(bathymetryOptions);

  return Object.freeze({
    /** Get verified GEBCO WMS bathymetry configuration */
    getBathymetryConfig() {
      return bathymetryConfig;
    },

    /**
     * Retrieve documented hydrothermal vent sites.
     * Attempts server proxy or direct access, falling back to verified NOAA PMEL catalog snapshot.
     */
    async getVentsSnapshot({ signal } = {}) {
      try {
        const response = await fetchImpl(`${apiUrl}/vents`, {
          signal,
          headers: { Accept: 'application/json' },
        });
        if (response.ok) {
          const data = await response.json();
          const normalized = normalizeVentSnapshot(data);
          if (Array.isArray(normalized) && normalized.length > 0) {
            return normalized;
          }
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        // On network error or unavailable proxy, seamlessly fall back to verified bundled snapshot
      }

      // Authoritative fallback: bundled NOAA PMEL catalog snapshot
      const fallback = normalizeVentSnapshot(bundledVents);
      return fallback || [];
    },

    /**
     * Retrieve NOAA Ocean Exploration ROV dive locations.
     */
    async getExpeditionsSnapshot({ signal } = {}) {
      const url = `${NOAA_EX_DIVES_URL}?${new URLSearchParams({
        where: '1=1',
        outFields: DIVE_QUERY_FIELDS,
        outSR: '4326',
        f: 'json',
        resultRecordCount: '2000',
      }).toString()}`;

      try {
        const response = await fetchImpl(url, { signal });
        if (!response.ok) {
          throw new Error(`NOAA Ocean Exploration HTTP ${response.status}`);
        }
        const data = await response.json();
        return normalizeDiveSnapshot(data) || [];
      } catch (err) {
        if (signal?.aborted) throw err;
        console.warn('[ABYSS:Source] Failed to load expedition dives:', err);
        return [];
      }
    },

    /**
     * Retrieve a specific ROV dive track on demand by CruiseDiveID.
     */
    async getDiveTrack({ cruiseDiveId, signal } = {}) {
      if (!cruiseDiveId || typeof cruiseDiveId !== 'string') return null;

      const safeId = cruiseDiveId.replace(/[^A-Za-z0-9_-]/g, '');
      const url = `${NOAA_EX_TRACKS_URL}?${new URLSearchParams({
        where: `CruiseDiveID = '${safeId}'`,
        outFields: TRACK_QUERY_FIELDS,
        outSR: '4326',
        f: 'json',
        resultRecordCount: '1',
      }).toString()}`;

      try {
        const response = await fetchImpl(url, { signal });
        if (!response.ok) return null;
        const data = await response.json();
        if (Array.isArray(data.features) && data.features.length > 0) {
          return normalizeDiveTrackRecord(data.features[0]);
        }
        return null;
      } catch (err) {
        if (signal?.aborted) throw err;
        return null;
      }
    },
  });
}
