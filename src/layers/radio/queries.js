import * as Cesium from 'cesium';
import { normalizeRadioCountryInput } from '../../data/radioCountry.js';

export function createQueries({ state: layerState, services, parts, source }) {
  function radioAngularDistance(station, anchor) {
    const lat1 = Cesium.Math.toRadians(Number(anchor?.lat));
    const lon1 = Cesium.Math.toRadians(Number(anchor?.lon));
    const lat2 = Cesium.Math.toRadians(Number(station?.lat));
    const lon2 = Cesium.Math.toRadians(Number(station?.lon));
    if (![lat1, lon1, lat2, lon2].every(Number.isFinite))
      return Number.POSITIVE_INFINITY;
    const deltaLat = lat2 - lat1;
    const deltaLon = lon2 - lon1;
    const haversine =
      Math.sin(deltaLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
    return 2 * Math.asin(Math.min(1, Math.sqrt(Math.max(0, haversine))));
  }

  /** Rank a copied station list by viewport distance, with an optional English-first tier. */

  function rankRadioStationsForViewport(
    stations,
    anchor,
    { preferEnglish = false } = {},
  ) {
    return (Array.isArray(stations) ? stations : [])
      .map((station, index) => ({
        station,
        index,
        distance: radioAngularDistance(station, anchor),
        languageTier:
          preferEnglish && !parts.categories.isEnglishRadioStation(station)
            ? 1
            : 0,
      }))
      .sort(
        (a, b) =>
          a.languageTier - b.languageTier ||
          a.distance - b.distance ||
          a.index - b.index,
      )
      .map(({ station }) => station);
  }

  /** Rank stations for an explicit voice/player request without moving the camera. */

  function rankRadioStationsForRequest(
    stations,
    { categoryId = 'all', anchor = null, country = '', stationQuery = '' } = {},
  ) {
    const countryFilter = normalizeRadioCountryInput(country);
    if (!countryFilter.valid) return [];
    const query = parts.categories.normalizeRadioTag(stationQuery);
    let matches = parts.categories.filterRadioStations(stations, categoryId);
    if (countryFilter.code || countryFilter.name) {
      matches = matches.filter((station) => {
        const stationCode = String(station?.countryCode || '')
          .trim()
          .toUpperCase();
        const stationCountry = normalizeRadioCountryInput(station?.country);
        return (
          (countryFilter.code && stationCode === countryFilter.code) ||
          (countryFilter.code &&
            stationCountry.valid &&
            stationCountry.code === countryFilter.code)
        );
      });
    }
    if (query) {
      matches = matches.filter((station) =>
        [
          station?.id,
          station?.name,
          station?.state,
          station?.country,
          station?.countryCode,
          ...(Array.isArray(station?.tags) ? station.tags : []),
        ].some((value) =>
          parts.categories.normalizeRadioTag(value).includes(query),
        ),
      );
    }
    return anchor
      ? rankRadioStationsForViewport(matches, anchor)
      : matches.slice();
  }

  function selectedStation() {
    return layerState._selectedId
      ? layerState._stationById.get(layerState._selectedId) || null
      : null;
  }

  function selectedPresentationStation() {
    if (layerState._tuningActive)
      return parts.model.tuningResolutionStation(layerState._tuningPreviewId);
    return layerState._cancelledTuningPresentationStation || selectedStation();
  }

  function visibleStations() {
    return parts.categories.filterRadioStations(
      layerState._stations,
      layerState._filter,
    );
  }

  function viewportRadioAnchor() {
    const camera = layerState._viewer?.camera;
    const scene = layerState._viewer?.scene;
    if (!camera) return null;
    const altitudeM = Number(camera.positionCartographic?.height);
    let cartographic = null;
    const canvas = scene?.canvas;
    if (canvas && typeof camera.pickEllipsoid === 'function') {
      const center = new Cesium.Cartesian2(
        canvas.clientWidth / 2,
        canvas.clientHeight / 2,
      );
      const position = camera.pickEllipsoid(
        center,
        scene.globe?.ellipsoid || Cesium.Ellipsoid.WGS84,
      );
      if (position) cartographic = Cesium.Cartographic.fromCartesian(position);
    }
    cartographic ||= camera.positionCartographic || null;
    if (!cartographic) return null;
    return {
      lat: Cesium.Math.toDegrees(cartographic.latitude),
      lon: Cesium.Math.toDegrees(cartographic.longitude),
      altitudeM,
      globalView: parts.navigation.radioViewIsGlobal(altitudeM),
    };
  }

  function rankedVisibleStations() {
    const anchor = viewportRadioAnchor();
    return rankRadioStationsForViewport(visibleStations(), anchor, {
      preferEnglish: Boolean(anchor?.globalView),
    });
  }
  return {
    radioAngularDistance,
    rankRadioStationsForViewport,
    rankRadioStationsForRequest,
    selectedStation,
    selectedPresentationStation,
    visibleStations,
    viewportRadioAnchor,
    rankedVisibleStations,
  };
}
