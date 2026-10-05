import {
  RADIO_CATEGORY_COLORS,
  RADIO_CLUSTER_LABELS,
  RADIO_MARKER_CATEGORY_ORDER,
} from './policy.js';

export function createModel({ state: layerState, services, parts, source }) {
  /** Return the shared CSS color for a canonical or detected-genre category. */

  function radioCategoryColor(categoryId = 'other') {
    const normalized = String(categoryId || 'other');
    const canonical = normalized.startsWith('genre:') ? 'music' : normalized;
    return RADIO_CATEGORY_COLORS[canonical] || RADIO_CATEGORY_COLORS.other;
  }

  /** Format the concise count/category badge shown above a Radio cluster. */

  function radioClusterBadgeText(categoryId = 'other', count = 0) {
    const normalized = String(categoryId || 'other');
    const canonical = normalized.startsWith('genre:') ? 'music' : normalized;
    const label = RADIO_CLUSTER_LABELS[canonical] || RADIO_CLUSTER_LABELS.other;
    const stationCount = Math.max(0, Math.floor(Number(count) || 0));
    return `${stationCount} ${label}`;
  }

  /** Choose the category advertised by a cluster in the active station-tag view. */

  function radioClusterCategoryId(stations, activeFilter = 'all') {
    const filter = String(activeFilter || 'all');
    if (filter !== 'all') {
      if (
        filter.startsWith('genre:') ||
        RADIO_MARKER_CATEGORY_ORDER.includes(filter) ||
        filter === 'other'
      ) {
        return filter;
      }
      return 'other';
    }
    const categoryCounts = new Map();
    for (const station of Array.isArray(stations) ? stations : []) {
      const categoryId = radioStationCategoryId(station);
      categoryCounts.set(categoryId, (categoryCounts.get(categoryId) || 0) + 1);
    }
    let clusterCategory = 'other';
    let clusterCategoryCount = 0;
    for (const categoryId of RADIO_MARKER_CATEGORY_ORDER) {
      const count = categoryCounts.get(categoryId) || 0;
      if (count > clusterCategoryCount) {
        clusterCategory = categoryId;
        clusterCategoryCount = count;
      }
    }
    if ((categoryCounts.get('other') || 0) > clusterCategoryCount)
      return 'other';
    return clusterCategory;
  }

  /** Choose one stable display category for a station that may match several filters. */

  function radioStationCategoryId(station) {
    return (
      RADIO_MARKER_CATEGORY_ORDER.find((categoryId) =>
        parts.categories.stationMatchesRadioCategory(station, categoryId),
      ) || 'other'
    );
  }

  /** Pure stale-response guard shared by the async directory update path. */

  function radioRequestIsCurrent(
    generation,
    currentGeneration,
    enabled,
    sessionGeneration = null,
    currentSessionGeneration = sessionGeneration,
  ) {
    return (
      generation === currentGeneration &&
      Boolean(enabled) &&
      sessionGeneration === currentSessionGeneration
    );
  }

  /** Compare every station field that determines tuner presentation and playback. */

  function radioStationResolutionMatches(frozenStation, currentStation) {
    if (!frozenStation || !currentStation) return false;
    for (const key of [
      'id',
      'name',
      'lat',
      'lon',
      'streamUrl',
      'homepage',
      'state',
      'country',
      'countryCode',
      'metadataTrust',
      'codec',
      'bitrate',
    ]) {
      if (frozenStation[key] !== currentStation[key]) return false;
    }
    return ['tags', 'languages'].every((key) => {
      const frozenValues = Array.isArray(frozenStation[key])
        ? frozenStation[key]
        : [];
      const currentValues = Array.isArray(currentStation[key])
        ? currentStation[key]
        : [];
      return (
        frozenValues.length === currentValues.length &&
        frozenValues.every((value, index) => value === currentValues[index])
      );
    });
  }

  function tuningResolutionStation(id) {
    return id ? layerState._tuningStationById.get(String(id)) || null : null;
  }
  return {
    radioCategoryColor,
    radioClusterBadgeText,
    radioClusterCategoryId,
    radioStationCategoryId,
    radioRequestIsCurrent,
    radioStationResolutionMatches,
    tuningResolutionStation,
  };
}
