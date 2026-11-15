import { msg, t, tn } from '../../i18n/index.js';
import {
  ACTIVATION_ENTER_ALTITUDE_M,
  BIKESHARE_AVAILABILITY_BANDS,
  BIKESHARE_DESCRIPTION,
  STATUS_POLL_MS,
  bikeshareAvailabilityBand,
} from './policy.js';
import { GBFS_CITY_REGISTRY } from './registry.js';

export function createControls({ state: layerState, services, parts, source }) {
  const methods = {
    id: 'bikeshare',

    name: 'Bikeshare',

    icon: '🚲',

    source: 'GBFS',

    updateInterval: STATUS_POLL_MS,

    /**
     * Kept so camera moves can repaint the row before the next status poll.
     * @param {object} dataManager DataLayerManager instance.
     */
    attachDataManager(dataManager) {
      layerState._dataManager = dataManager;
    },

    /**
     * Return a sampled array of detectable station objects for HUD overlay rendering.
     * @param {Object} [options] - Sampling options (maxCount, seed).
     * @returns {Array<{ position: Cesium.Cartesian3, id: string, type: string, skipLabel: boolean }>}
     */
    getDetectableObjects(options = {}) {
      return parts.queries.collectDetectableStations(options);
    },

    /**
     * Snapshot loaded bikeshare stations as plain JSON-safe records for the analyst
     * query engine. On demand only (once per spoken query); [] while the
     * layer is off.
     * @param {number} [maxCount=Infinity] Most records to return.
     * @returns {Array<Object>} {id, name, city, lat, lon, bikesAvailable, docksAvailable, capacity, renting}.
     */
    getAnalystRecords(maxCount = Infinity) {
      if (!layerState._enabled) return [];
      const num = (v) => (Number.isFinite(v) ? v : null);
      const result = [];
      for (const record of layerState._stationRenderMap.values()) {
        if (result.length >= maxCount) break;
        const info = layerState._stationInfoCache
          .get(record.cityId)
          ?.get(record.stationId);
        if (!Number.isFinite(info?.lat) || !Number.isFinite(info?.lon))
          continue;
        result.push({
          id: record.stationName || `Dock ${record.stationId}`,
          name: record.stationName || null,
          city: record.cityId || null,
          lat: info.lat,
          lon: info.lon,
          bikesAvailable: num(record.bikesAvailable),
          docksAvailable: num(record.docksAvailable),
          capacity: num(record.capacity),
          renting: record.isRenting !== false,
        });
      }
      return result;
    },

    /**
     * The Bike Share row's own legend: the availability ramp the stations are
     * drawn in, with the number of stations in each band.
     *
     * This is the SAME ramp for every city in the merged layer: Velib' is
     * one more GBFS city, so its stations are coloured by the very function
     * that colours New York's, and they land in these same bands. There is
     * no second scheme for the French network.
     *
     * The band counts come from bikeshareAvailabilityBand, the one
     * classification the renderer uses, so a point's colour and the band
     * that counts it can never disagree.
     */
    getRowControls() {
      let bikes = 0;
      const counts = new Map(
        BIKESHARE_AVAILABILITY_BANDS.map((band) => [band.id, 0]),
      );
      for (const record of layerState._stationRenderMap.values()) {
        bikes += Number(record.bikesAvailable) || 0;
        const band = bikeshareAvailabilityBand(
          {
            bikesAvailable: record.bikesAvailable,
            isInstalled: record.isInstalled,
            isRenting: record.isRenting,
            isReturning: record.isReturning,
          },
          record.capacity,
        );
        counts.set(band, (counts.get(band) || 0) + 1);
      }
      const onTheGround = tn(
        bikes,
        '{count} bike on the ground',
        '{count} bikes on the ground',
      );
      return {
        chips: [],
        legend: BIKESHARE_AVAILABILITY_BANDS.map((band, index) => ({
          label: t(band.label),
          color: band.color,
          count: counts.get(band.id) || 0,
          ...(index === 0
            ? {
                blurb: t(
                  'Colour shows how much of the station capacity holds a bike, not how many bikes the city owns. A station with no status yet is drawn in the neutral colour.',
                ),
              }
            : {}),
        })),
        info:
          layerState._failedCityIds.size > 0
            ? t('GBFS fetch error')
            : layerState._count === 0
              ? t(BIKESHARE_DESCRIPTION)
              : t('{description} · {bikes}', {
                  description: t(BIKESHARE_DESCRIPTION),
                  bikes: onTheGround,
                }),
        infoTitle: t(
          'Every city in this row is a GBFS feed read through the same proxy. Availability is per station, not per bike.',
        ),
      };
    },

    /**
     * Return current layer statistics for the UI status display.
     * @returns {{ count: number, lastUpdate: number|null, loading: boolean, loadingLabel?: string, error?: string, degraded?: boolean, stale?: boolean, status?: string, statusMessage?: string }}
     */
    getStats() {
      // A city in range without points is loading even before its fetch
      // starts: the row repaints on entry, ahead of beginLoading().
      const loading =
        layerState._loading ||
        [...layerState._activeCityIds].some(
          (cityId) =>
            !layerState._cityRuntime.has(cityId) &&
            !layerState._failedCityIds.has(cityId),
        );
      const stats = {
        count: layerState._count,
        lastUpdate: layerState._lastUpdate,
        loading,
      };
      // No system in range: the camera is too high or no system is near. A
      // failed city also leaves range empty and reports its failure below.
      if (
        layerState._enabled &&
        !loading &&
        layerState._activeCityIds.size === 0 &&
        layerState._failedCityIds.size === 0
      ) {
        // English: the analyst's empty note and the row's prompt, both shown
        // through translateStatusMessage (ui/statusText.js).
        const note = layerState._altitudeGateEnabled
          ? `No bike share here yet · ${GBFS_CITY_REGISTRY.length} systems available`
          : `Fly below ${Math.round(ACTIVATION_ENTER_ALTITUDE_M / 1000).toLocaleString('en-US')} km to a covered city`;
        return { ...stats, status: 'zoom-in', statusMessage: note };
      }
      if (loading) {
        stats.loadingLabel =
          layerState._activeCityIds.size > 0
            ? t('syncing {count} city feeds...', {
                count: layerState._activeCityIds.size,
              })
            : t('scanning nearby systems...');
      }
      // A failed city is only the layer's failure when it left nothing on the
      // map. While other cities still render, the partial failure reads
      // DEGRADED; when every in-range city failed and only previously drawn
      // points remain, they read STALE.
      if (layerState._failedCityIds.size > 0) {
        if (layerState._stationRenderMap.size === 0) {
          stats.error = msg('GBFS fetch error');
        } else {
          stats.degraded = true;
          const allFailed = Array.from(layerState._activeCityIds).every(
            (cityId) => layerState._failedCityIds.has(cityId),
          );
          if (allFailed) stats.stale = true;
        }
      }
      return stats;
    },
  };

  return { methods };
}
