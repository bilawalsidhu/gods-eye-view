/**
 * English pack — the Radio layer: station categories, music-genre chips,
 * cluster badges and directory status sentences. Station names and the
 * "{freq} FM — {name}" label format stay data-driven.
 */
export default {
  radio: {
    category: {
      all: 'All',
      news: 'News',
      talk: 'Talk',
      weather: 'Weather / Emergency',
      publicSafety: 'Public Safety',
      aviationMarine: 'Aviation / Marine',
      trafficTransit: 'Traffic / Transit',
      music: 'Music',
      other: 'Other',
    },
    genre: {
      alternative: 'Alternative',
      ambient: 'Ambient',
      blues: 'Blues',
      classical: 'Classical',
      country: 'Country',
      dance: 'Dance',
      electronic: 'Electronic',
      folk: 'Folk',
      funk: 'Funk',
      hipHop: 'Hip-Hop',
      house: 'House',
      indie: 'Indie',
      jazz: 'Jazz',
      latin: 'Latin',
      metal: 'Metal',
      oldies: 'Oldies',
      pop: 'Pop',
      punk: 'Punk',
      rb: 'R&B',
      reggae: 'Reggae',
      rock: 'Rock',
      soul: 'Soul',
      techno: 'Techno',
      trance: 'Trance',
      world: 'World',
    },
    cluster: {
      news: 'NEWS',
      talk: 'TALK',
      weather: 'WEATHER',
      publicSafety: 'SAFETY',
      aviationMarine: 'AIR / SEA',
      trafficTransit: 'TRANSIT',
      music: 'MUSIC',
      other: 'OTHER',
    },
    status: {
      degradedPrevious:
        'Directory refresh degraded; showing the previous station catalog.',
      degraded: 'Radio directory coverage is degraded.',
      failedPrevious:
        'Directory refresh failed; showing the previous station catalog.',
      unavailable: 'Radio directory is temporarily unavailable.',
    },
  },
};
