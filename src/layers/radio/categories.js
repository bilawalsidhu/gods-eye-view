import { MUSIC_GENRES, CATEGORY_MATCHERS } from './policy.js';

export function createCategories({
  state: layerState,
  services,
  parts,
  source,
}) {
  /** Normalize one directory tag to a stable, lower-case display token. */

  function normalizeRadioTag(value) {
    return String(value ?? '')
      .trim()
      .toLocaleLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 80);
  }

  function stationTags(station) {
    if (Array.isArray(station?.tags))
      return station.tags.map(normalizeRadioTag).filter(Boolean);
    return String(station?.tags ?? '')
      .split(',')
      .map(normalizeRadioTag)
      .filter(Boolean);
  }

  function hasTag(station, needles) {
    const tags = stationTags(station);
    return needles.some((needle) =>
      tags.some((tag) => tag === needle || tag.includes(needle)),
    );
  }

  function detectedGenres(station) {
    return MUSIC_GENRES.filter(([genre]) => hasTag(station, [genre])).map(
      ([genre]) => genre,
    );
  }

  /** Return whether a station belongs in a station-tag category. */

  function stationMatchesRadioCategory(station, categoryId) {
    if (categoryId === 'all') return true;
    if (categoryId.startsWith('genre:')) {
      return detectedGenres(station).includes(
        categoryId.slice('genre:'.length),
      );
    }
    if (categoryId === 'music') {
      return (
        detectedGenres(station).length > 0 ||
        hasTag(station, ['music', 'hits', 'songs'])
      );
    }
    if (categoryId === 'other') {
      return (
        !Object.entries(CATEGORY_MATCHERS).some(([id]) =>
          stationMatchesRadioCategory(station, id),
        ) && !stationMatchesRadioCategory(station, 'music')
      );
    }
    return hasTag(station, CATEGORY_MATCHERS[categoryId] || []);
  }

  /** Build canonical and detected-genre categories from station-level tags. */

  function buildRadioCategories(stations) {
    const rows = Array.isArray(stations) ? stations : [];
    const categories = [
      { id: 'all', label: 'All' },
      { id: 'news', label: 'News' },
      { id: 'talk', label: 'Talk' },
      { id: 'weather', label: 'Weather / Emergency' },
      { id: 'public-safety', label: 'Public Safety' },
      { id: 'aviation-marine', label: 'Aviation / Marine' },
      { id: 'traffic-transit', label: 'Traffic / Transit' },
      { id: 'music', label: 'Music' },
    ];

    for (const [genre, label] of MUSIC_GENRES) {
      const id = `genre:${genre}`;
      if (rows.some((station) => stationMatchesRadioCategory(station, id))) {
        categories.push({ id, label });
      }
    }
    categories.push({ id: 'other', label: 'Other' });
    return categories.map((category) => ({
      ...category,
      color: parts.model.radioCategoryColor(category.id),
      count: rows.filter((station) =>
        stationMatchesRadioCategory(station, category.id),
      ).length,
    }));
  }

  /** Filter stations without changing the active stream or selection. */

  function filterRadioStations(stations, categoryId = 'all') {
    return (Array.isArray(stations) ? stations : []).filter((station) =>
      stationMatchesRadioCategory(station, categoryId),
    );
  }

  /** Return whether Radio Browser metadata identifies a station as English-language. */

  function isEnglishRadioStation(station) {
    const languages = Array.isArray(station?.languages)
      ? station.languages
      : [];
    return languages.some((language) => {
      const normalized = normalizeRadioTag(language);
      return (
        normalized === 'en' ||
        normalized === 'eng' ||
        normalized.startsWith('english')
      );
    });
  }
  return {
    normalizeRadioTag,
    stationTags,
    hasTag,
    detectedGenres,
    stationMatchesRadioCategory,
    buildRadioCategories,
    filterRadioStations,
    isEnglishRadioStation,
  };
}
