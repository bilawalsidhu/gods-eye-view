/**
 * Cross-session memory for the local voice path: named places ("home", "the
 * office") and the last things the assistant flew to or tracked, so "go back
 * to that ship" and "take me home" work tomorrow. localStorage only; the
 * server receives a compact summary at session start for the system prompt.
 */
export const MEMORY_STORAGE_KEY = 'gev:voice-memory:v1';
const MAX_RECENT = 12;

export function createLocalMemory({
  storage = safeStorage(),
  now = () => Date.now(),
} = {}) {
  let state = load();

  function load() {
    try {
      const raw = storage?.getItem(MEMORY_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return {
        places:
          parsed?.places && typeof parsed.places === 'object'
            ? parsed.places
            : {},
        recent: Array.isArray(parsed?.recent) ? parsed.recent : [],
      };
    } catch {
      return { places: {}, recent: [] };
    }
  }
  function save() {
    try {
      storage?.setItem(MEMORY_STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch {
      return false;
    }
  }

  return {
    /** Save the current camera under a name (case-insensitive). */
    rememberPlace(name, camera) {
      const key = normalize(name);
      if (!key || !camera || !Number.isFinite(camera.lat)) return null;
      state.places[key] = {
        name: String(name).trim(),
        lat: camera.lat,
        lon: camera.lon,
        alt: camera.alt,
        heading: camera.heading ?? 0,
        pitch: camera.pitch ?? -45,
        roll: camera.roll ?? 0,
        savedAt: now(),
      };
      save();
      return state.places[key];
    },
    recallPlace(name) {
      const key = normalize(name);
      if (state.places[key]) return state.places[key];
      // Loose match: "the office" -> "office", "my home" -> "home".
      const loose = key.replace(/^(?:the|my|our)\s+/, '');
      if (state.places[loose]) return state.places[loose];
      const hit = Object.keys(state.places).find(
        (k) => k.includes(loose) || loose.includes(k),
      );
      return hit ? state.places[hit] : null;
    },
    forgetPlace(name) {
      const key = normalize(name);
      const existed = Boolean(state.places[key]);
      delete state.places[key];
      save();
      return existed;
    },
    listPlaces() {
      return Object.values(state.places).sort((a, b) => b.savedAt - a.savedAt);
    },
    /** Note a target the assistant navigated to or tracked. */
    noteTarget({ kind, id, label, layerId = null, extra = null }) {
      if (!kind || !label) return;
      state.recent = [
        {
          kind,
          id: id ?? null,
          label: String(label),
          layerId,
          extra,
          at: now(),
        },
        ...state.recent.filter(
          (item) =>
            !(
              item.kind === kind &&
              item.id === (id ?? null) &&
              item.label === label
            ),
        ),
      ].slice(0, MAX_RECENT);
      save();
    },
    recentTargets(kind = null) {
      return kind
        ? state.recent.filter((r) => r.kind === kind)
        : state.recent.slice();
    },
    /** Compact text the server can put in the system prompt. */
    summary() {
      const places = Object.values(state.places).map((p) => p.name);
      const recent = state.recent.slice(0, 6).map((r) => {
        const age = humanAge(now() - r.at);
        return `${r.kind} "${r.label}"${r.id ? ` (${r.id})` : ''} ${age}`;
      });
      return { places, recent };
    },
    reset() {
      state = { places: {}, recent: [] };
      save();
    },
  };
}

/** Local-only voice tools the adapter serves from memory. */
export const MEMORY_TOOL_NAMES = Object.freeze([
  'remember_place',
  'go_to_saved_place',
  'list_saved_places',
  'forget_place',
  'recall_recent_target',
]);

function normalize(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .replace(/\s+/g, ' ');
}

function humanAge(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function safeStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}
