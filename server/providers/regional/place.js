import { fetchRegionalJson } from './http.js';
import { normalizeRegionalPlace } from '../../../src/data/regionalModel.js';

/** Construct the serialized Nominatim adapter with a trusted endpoint. */
export function createRegionalPlaceProvider({
  endpoint = 'https://nominatim.openstreetmap.org/reverse',
  requestJson = fetchRegionalJson,
} = {}) {
  let _nominatimQueue = Promise.resolve();

  let _nominatimLastRequestAt = 0;

  function fetchRegionalPlace(point) {
    const task = _nominatimQueue.then(async () => {
      const waitMs = Math.max(0, 1100 - (Date.now() - _nominatimLastRequestAt));
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      _nominatimLastRequestAt = Date.now();
      const params = new URLSearchParams({
        format: 'jsonv2',
        lat: point.latitude.toFixed(5),
        lon: point.longitude.toFixed(5),
        zoom: '10',
        addressdetails: '1',
        'accept-language': 'en',
      });
      const payload = await requestJson(`${endpoint}?${params}`, {
        headers: {
          'User-Agent':
            'GodsEyeView/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)',
          Referer: 'https://github.com/bilawalsidhu/gods-eye-view',
        },
      });
      return normalizeRegionalPlace(payload);
    });
    _nominatimQueue = task.catch(() => null);
    return task;
  }

  return fetchRegionalPlace;
}

export const fetchRegionalPlace = createRegionalPlaceProvider();
