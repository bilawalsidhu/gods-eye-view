/**
 * Radio-in-the-loop tool pack: transcribe a live broadcaster stream on the
 * server (ffmpeg + Whisper, see server/providers/ollama/radio.js) and let the
 * assistant answer "what did they just say". The station comes from the
 * Radio layer's current playback when no name is given; otherwise the loaded
 * radio directory is searched by name/tag/place.
 */
const ROUTE = '/api/voice/radio';
const DIRECTORY = '/api/radio/stations';
const DIRECTORY_SEARCH = '/api/radio/search';
const PLAYING = new Set(['loading', 'buffering', 'playing']);

/** Result timeouts (ms) the server should allow for these tools. */
export const timeouts = Object.freeze({
  radio_listen: 30_000,
  radio_transcript: 20_000,
});

export const schemas = [
  {
    name: 'radio_listen',
    description:
      'Start transcribing a live radio station on the server so you can answer questions about what is being said. Omit station to use the station playing in the Radio layer right now; give a name ("BBC World Service", "KUT Austin", "France Info") to search the radio directory. Transcription starts about 20 seconds after this returns; do not read the stream yourself. Afterwards, for "what did they say / what are they talking about", call radio_transcript and summarize its text.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        station: {
          type: 'string',
          description:
            'Station name, call sign or place to search for. Leave empty for the station currently playing.',
        },
      },
    },
  },
  {
    name: 'radio_stop',
    description:
      'Stop transcribing radio. The transcript stays available for a while.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'radio_transcript',
    description:
      'Return what the radio said in the last N minutes as timestamped lines. Use this to answer "what did they just say", "what are they talking about", "any news about X", "summarize the last ten minutes": call it, then answer from the text in your own words (do not read every line). Requires radio_listen first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        minutes: {
          type: 'number',
          minimum: 1,
          maximum: 60,
          description: 'How far back to look. Default 5.',
        },
      },
    },
  },
  {
    name: 'radio_search',
    description:
      'Find lines in the radio transcript that mention a word or phrase ("did they mention the highway", "when did they say Dodgers"). Returns matching timestamped lines; summarize them for the user. Requires radio_listen first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Word or phrase to look for.' },
        minutes: {
          type: 'number',
          minimum: 1,
          maximum: 60,
          description: 'How far back to search. Default 30.',
        },
      },
      required: ['query'],
    },
  },
];

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Rank directory stations for a spoken name: exact > prefix > contains > tags/place. */
export function rankStationsByName(stations, query) {
  const wanted = normalize(query);
  if (!wanted) return [];
  const words = wanted.split(' ').filter(Boolean);
  const scored = [];
  for (const [index, station] of (stations || []).entries()) {
    if (!station?.streamUrl) continue;
    const name = normalize(station.name);
    let score = 0;
    if (name === wanted) score = 100;
    else if (name.startsWith(wanted)) score = 80;
    else if (name.includes(wanted)) score = 60;
    else if (words.length > 1 && words.every((word) => name.includes(word)))
      score = 50;
    else {
      const rest = normalize(
        [station.state, station.country, ...(station.tags || [])].join(' '),
      );
      if (rest.includes(wanted) || words.every((word) => rest.includes(word)))
        score = 20;
    }
    if (score) scored.push({ score, index, station });
  }
  // Directory order is by popularity, so ties keep the more-listened station.
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.station);
}

function stationSummary(station) {
  if (!station) return null;
  return {
    id: station.id || null,
    name: station.name,
    country: station.country || null,
    state: station.state || null,
    tags: (station.tags || []).slice(0, 6),
  };
}

export function createHandlers({ getGlobe, fetchJson }) {
  const radioModule = () => {
    try {
      return getGlobe?.()?.dataManager?.layers?.get?.('radio')?.module || null;
    } catch {
      return null;
    }
  };

  /** Station in the Radio layer that is playing (or at least selected). */
  function currentStation() {
    const radio = radioModule();
    const state = radio?.getRadioUIState?.();
    if (!state) return { station: null, playing: false };
    const catalog = radio.getRadioAcceptedCatalogSnapshot?.()?.stations || [];
    const playingId = state.playingStationId;
    const playing = Boolean(playingId) && PLAYING.has(state.audioState);
    let station = null;
    if (playing) {
      station =
        state.selected?.id === playingId
          ? state.selected
          : catalog.find((s) => s.id === playingId) || null;
    }
    if (!station && state.selected?.streamUrl) station = state.selected;
    return { station, playing: Boolean(station) && playing };
  }

  async function directoryStations() {
    const radio = radioModule();
    const loaded = radio?.getRadioAcceptedCatalogSnapshot?.()?.stations;
    if (Array.isArray(loaded) && loaded.length) return loaded;
    const body = await fetchJson(DIRECTORY);
    return Array.isArray(body?.stations) ? body.stations : [];
  }

  async function findStation(query) {
    const stations = await directoryStations();
    const radio = radioModule();
    // The layer's own matcher (name, place, tags, country) narrows first when
    // it is available; the name ranking then picks the best of those.
    let candidates = stations;
    if (typeof radio?.rankRadioStationsForRequest === 'function') {
      try {
        const narrowed = radio.rankRadioStationsForRequest(stations, {
          stationQuery: query,
        });
        if (Array.isArray(narrowed) && narrowed.length) candidates = narrowed;
      } catch {
        /* fall back to the plain ranking */
      }
    }
    let ranked = rankStationsByName(candidates, query);
    if (!ranked.length) {
      // Not in the curated catalog: ask the directory by name (BBC World
      // Service, a small local station, ...).
      try {
        const body = await fetchJson(
          `${DIRECTORY_SEARCH}?name=${encodeURIComponent(query)}`,
        );
        const remote = Array.isArray(body?.stations) ? body.stations : [];
        ranked = rankStationsByName(remote, query);
        if (!ranked.length && remote.length) ranked = remote.slice(0, 4);
      } catch {
        /* directory search is best effort */
      }
    }
    return { best: ranked[0] || null, alternatives: ranked.slice(1, 4) };
  }

  return {
    async radio_listen({ station } = {}) {
      const query = String(station || '').trim();
      let target = null;
      let how = null;
      let playing = false;
      let alternatives = [];
      if (!query) {
        const current = currentStation();
        target = current.station;
        playing = current.playing;
        how = playing
          ? 'playing in the Radio layer'
          : 'selected in the Radio layer';
        if (!target)
          return {
            ok: false,
            error:
              'No station is playing in the Radio layer. Say which station to listen to, or start one in the Radio layer first.',
          };
      } else {
        const found = await findStation(query);
        target = found.best;
        alternatives = found.alternatives.map(stationSummary);
        how = `matched "${query}" in the radio directory`;
        if (!target)
          return {
            ok: false,
            error: `No radio station in the directory matches "${query}". Try a different name or a city.`,
          };
      }
      if (!target.streamUrl)
        return { ok: false, error: `${target.name} has no stream URL` };
      const result = await fetchJson(ROUTE, {
        op: 'start',
        url: target.streamUrl,
        label: target.name,
      });
      return {
        ok: true,
        listening: target.name,
        station: stationSummary(target),
        resolvedBy: how,
        playingInRadioLayer: playing,
        listenerId: result?.id || null,
        alreadyListening: Boolean(result?.alreadyListening),
        alternatives,
        note: 'Transcription is running on the server. Call radio_transcript in about 20 seconds to hear what was said.',
      };
    },
    async radio_stop() {
      const result = await fetchJson(ROUTE, { op: 'stop' });
      return {
        ok: true,
        stopped: result?.stopped || [],
        stillListening: (result?.listening || []).map((l) => l.label),
      };
    },
    async radio_transcript({ minutes } = {}) {
      const result = await fetchJson(ROUTE, {
        op: 'transcript',
        minutes: Number(minutes) > 0 ? Number(minutes) : 5,
      });
      return {
        ok: true,
        station: result?.label || null,
        active: Boolean(result?.active),
        minutes: result?.minutes,
        lineCount: result?.lineCount || 0,
        text: result?.text || '',
        note:
          result?.note ||
          (result?.lineCount
            ? undefined
            : 'Nothing transcribed in that window yet.'),
      };
    },
    async radio_search({ query, minutes } = {}) {
      const clean = String(query || '').trim();
      if (!clean) return { ok: false, error: 'query is required' };
      const result = await fetchJson(ROUTE, {
        op: 'search',
        query: clean,
        minutes: Number(minutes) > 0 ? Number(minutes) : 30,
      });
      return {
        ok: true,
        station: result?.label || null,
        query: clean,
        minutes: result?.minutes,
        matchCount: result?.matchCount || 0,
        text: result?.text || '',
        note: result?.matchCount
          ? undefined
          : `"${clean}" was not mentioned in that window.`,
      };
    },
  };
}
