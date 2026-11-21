import { MUSIC_GENRES, CATEGORY_MATCHERS } from './policy.js';
import { t } from '../../i18n/index.js';

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

  const tagsInclude = (tags, needles) =>
    needles.some((needle) =>
      tags.some((tag) => tag === needle || tag.includes(needle)),
    );

  // A station's tags decide its categories, and neither changes while the
  // station record lives. Matching used to normalise every tag again for
  // every needle of every category of every station: about 0.9 s and a
  // 445 ms freeze per directory load of 750 stations, repeated for the active
  // filter on every horizon scan. Keyed by the record and its tags value, so
  // a record given new tags is read again.
  const membershipByStation = new WeakMap();

  function stationMembership(station) {
    const keyed = station !== null && typeof station === 'object';
    const known = keyed ? membershipByStation.get(station) : null;
    if (known && known.source === station.tags) return known;
    const tags = stationTags(station);
    const genres = MUSIC_GENRES.filter(([genre]) =>
      tagsInclude(tags, [genre]),
    ).map(([genre]) => genre);
    const categories = new Set(genres.map((genre) => `genre:${genre}`));
    for (const [id, needles] of Object.entries(CATEGORY_MATCHERS))
      if (tagsInclude(tags, needles)) categories.add(id);
    const sorted = categories.size > genres.length;
    if (genres.length > 0 || tagsInclude(tags, ['music', 'hits', 'songs']))
      categories.add('music');
    else if (!sorted) categories.add('other');
    const membership = { source: station?.tags, tags, genres, categories };
    if (keyed) membershipByStation.set(station, membership);
    return membership;
  }

  function hasTag(station, needles) {
    return tagsInclude(stationMembership(station).tags, needles);
  }

  function detectedGenres(station) {
    return [...stationMembership(station).genres];
  }

  /** Return whether a station belongs in a station-tag category. */

  function stationMatchesRadioCategory(station, categoryId) {
    if (categoryId === 'all') return true;
    return stationMembership(station).categories.has(categoryId);
  }

  /** Build canonical and detected-genre categories from station-level tags. */

  function buildRadioCategories(stations) {
    const rows = Array.isArray(stations) ? stations : [];
    const categories = [
      { id: 'all', label: t('All', { context: 'radio tag' }) },
      { id: 'news', label: t('News') },
      { id: 'talk', label: t('Talk') },
      { id: 'weather', label: t('Weather / Emergency') },
      { id: 'public-safety', label: t('Public Safety') },
      {
        id: 'aviation-marine',
        label: t('Aviation / Marine'),
      },
      {
        id: 'traffic-transit',
        label: t('Traffic / Transit'),
      },
      { id: 'music', label: t('Music') },
    ];

    for (const [genre, label] of MUSIC_GENRES) {
      const id = `genre:${genre}`;
      if (rows.some((station) => stationMatchesRadioCategory(station, id))) {
        categories.push({ id, label: t(label) });
      }
    }
    categories.push({ id: 'other', label: t('Other') });
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
