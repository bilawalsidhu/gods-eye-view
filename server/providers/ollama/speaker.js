import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Speaker identity for the local voice path. The Python worker turns a 16 kHz
 * utterance into a 512-d WeSpeaker CAM++ voice print (op "embed"); this module
 * keeps named profiles of those prints in .gev-cache/voice-profiles.json,
 * scores a fresh print against each profile's centroid by cosine similarity
 * and remembers the last few utterance WAVs per session so "remember my voice
 * as Anthony" can enroll what was just said. Only embeddings are persisted;
 * audio stays in memory and never leaves the machine.
 */
export const SPEAKER_THRESHOLD = 0.62;
export const MAX_RECENT_UTTERANCES = 3;
export const MAX_EMBEDDINGS_PER_PROFILE = 24;
export const PROFILE_FILE = join('.gev-cache', 'voice-profiles.json');
const EMBED_TIMEOUT_MS = 15_000;

export function cosine(a, b) {
  if (!a?.length || a.length !== b?.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

/** L2-normalized mean of a profile's embeddings, or null when it has none. */
export function centroid(embeddings) {
  const rows = (embeddings || []).filter((row) => row?.length);
  if (!rows.length) return null;
  const sum = new Array(rows[0].length).fill(0);
  for (const row of rows) for (let i = 0; i < sum.length; i++) sum[i] += row[i];
  const norm = Math.sqrt(sum.reduce((acc, v) => acc + v * v, 0));
  return norm ? sum.map((v) => v / norm) : null;
}

export function normalizeName(name) {
  return String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

const sameName = (a, b) =>
  normalizeName(a).toLowerCase() === normalizeName(b).toLowerCase();

/** Cosine to every profile centroid, best first. */
export function scoreProfiles(embedding, profiles) {
  return (profiles || [])
    .map((profile) => ({
      name: profile.name,
      score:
        Math.round(cosine(embedding, centroid(profile.embeddings)) * 1000) /
        1000,
    }))
    .sort((a, b) => b.score - a.score);
}

export function matchSpeaker(
  embedding,
  profiles,
  { threshold = SPEAKER_THRESHOLD } = {},
) {
  const [best] = scoreProfiles(embedding, profiles);
  return best && best.score >= threshold ? best : null;
}

/** Named voice profiles persisted as JSON; loaded lazily, written atomically. */
export function createProfileStore({
  file = join(process.cwd(), PROFILE_FILE),
  now = Date.now,
} = {}) {
  let loaded = null;
  async function load() {
    if (loaded) return loaded;
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      loaded = Array.isArray(parsed?.profiles)
        ? parsed.profiles.filter((p) => p?.name && Array.isArray(p.embeddings))
        : [];
    } catch {
      loaded = [];
    }
    return loaded;
  }
  async function save() {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(
      tmp,
      JSON.stringify({ version: 1, profiles: loaded || [] }, null, 0),
    );
    await rename(tmp, file);
  }
  const summary = (profile) => ({
    name: profile.name,
    samples: profile.embeddings.length,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    model: profile.model || null,
  });
  return {
    file,
    profiles: load,
    async list() {
      return (await load()).map(summary);
    },
    async get(name) {
      return (await load()).find((p) => sameName(p.name, name)) || null;
    },
    async enroll(name, embeddings, { model = null } = {}) {
      const clean = normalizeName(name);
      if (!clean) throw new Error('A name is required');
      const rows = (embeddings || []).filter((row) => row?.length);
      if (!rows.length) throw new Error('No embeddings to enroll');
      const profiles = await load();
      let profile = profiles.find((p) => sameName(p.name, clean));
      const at = new Date(now()).toISOString();
      if (!profile) {
        profile = { name: clean, embeddings: [], createdAt: at, updatedAt: at };
        profiles.push(profile);
      }
      profile.embeddings = [...profile.embeddings, ...rows].slice(
        -MAX_EMBEDDINGS_PER_PROFILE,
      );
      profile.updatedAt = at;
      if (model) profile.model = model;
      await save();
      return { ...summary(profile), added: rows.length };
    },
    async forget(name) {
      const profiles = await load();
      const index = profiles.findIndex((p) => sameName(p.name, name));
      if (index < 0) return false;
      profiles.splice(index, 1);
      await save();
      return true;
    },
  };
}

/** One store per server process (Vite may configure the server twice). */
export function sharedProfileStore(options) {
  const key = '__gevVoiceProfiles';
  if (!globalThis[key]) globalThis[key] = createProfileStore(options);
  return globalThis[key];
}

// The most recent session that spoke; the HTTP route enrolls from it because
// "remember my voice as X" arrives as a tool call, not on the WebSocket.
let activeSession = null;
export function activeVoiceSession() {
  return activeSession;
}
export function setActiveVoiceSession(session) {
  activeSession = session || null;
}

/** Keep the last few utterance WAVs on the session (bounded) for enrollment. */
export function rememberUtterance(
  session,
  bytes,
  { max = MAX_RECENT_UTTERANCES, now = Date.now } = {},
) {
  if (!session) return null;
  const entry = { wav: Buffer.from(bytes), at: now(), embedding: null };
  session.recentUtterances = [...(session.recentUtterances || []), entry].slice(
    -max,
  );
  activeSession = session;
  return entry;
}

/** Voice print for one remembered utterance, computed once and cached on it. */
export async function embedUtterance(worker, entry) {
  if (entry.embedding?.length) return entry.embedding;
  if (typeof worker?.embed !== 'function')
    throw new Error('Speaker embeddings are not available');
  const result = await worker.embed(entry.wav, { timeoutMs: EMBED_TIMEOUT_MS });
  if (!Array.isArray(result?.embedding) || !result.embedding.length)
    throw new Error('Speaker model returned no embedding');
  entry.embedding = result.embedding;
  entry.model = result.model || null;
  return entry.embedding;
}

/**
 * Tag one utterance with the enrolled speaker it matches, or null. Never
 * throws: without profiles it costs nothing, and a missing model or a failed
 * embed only means the transcript goes out without a speaker.
 */
export async function identifySpeaker(
  worker,
  bytes,
  session,
  { store = sharedProfileStore(), threshold, log = () => {} } = {},
) {
  const entry = rememberUtterance(session, bytes);
  try {
    const profiles = await store.profiles();
    if (!profiles.length || !entry) return null;
    const embedding = await embedUtterance(worker, entry);
    const match = matchSpeaker(embedding, profiles, { threshold });
    if (session) session.lastSpeaker = match;
    return match;
  } catch (error) {
    log('speaker.error', { error: error?.message });
    return null;
  }
}

const unavailable = (error) =>
  /not found|not loaded|not available|no embedding/i.test(error?.message || '');

/** The four route operations; returns { status, body } for the HTTP handler. */
export async function runSpeakerOp(
  body,
  {
    worker,
    store = sharedProfileStore(),
    session = activeVoiceSession(),
    threshold,
  } = {},
) {
  const op = String(body?.op || '').toLowerCase();
  const utterances = () =>
    body?.wav
      ? [{ wav: Buffer.from(String(body.wav), 'base64'), embedding: null }]
      : (session?.recentUtterances || []).slice();
  if (op === 'list') {
    const profiles = await store.list();
    return {
      status: 200,
      body: {
        ok: true,
        count: profiles.length,
        profiles,
        threshold: threshold ?? SPEAKER_THRESHOLD,
        available: worker?.health?.().speaker !== false,
      },
    };
  }
  if (op === 'forget') {
    const name = normalizeName(body?.name);
    if (!name)
      return { status: 400, body: { ok: false, error: 'A name is required' } };
    const removed = await store.forget(name);
    return {
      status: 200,
      body: removed
        ? { ok: true, name, forgotten: true }
        : { ok: false, name, error: `No voice is enrolled as "${name}"` },
    };
  }
  if (op === 'enroll') {
    const name = normalizeName(body?.name);
    if (!name)
      return { status: 400, body: { ok: false, error: 'A name is required' } };
    const entries = utterances();
    if (!entries.length)
      return {
        status: 409,
        body: {
          ok: false,
          error: 'Nothing to enroll yet: say a sentence first, then ask again.',
        },
      };
    const embeddings = [];
    let failure = null;
    let model = null;
    for (const entry of entries) {
      try {
        embeddings.push(await embedUtterance(worker, entry));
        model = entry.model || model;
      } catch (error) {
        failure = error;
      }
    }
    if (!embeddings.length)
      return {
        status: unavailable(failure) ? 503 : 500,
        body: { ok: false, error: failure?.message || 'Enrollment failed' },
      };
    const profile = await store.enroll(name, embeddings, { model });
    if (session) session.lastSpeaker = { name: profile.name, score: 1 };
    return {
      status: 200,
      body: {
        ok: true,
        name: profile.name,
        added: profile.added,
        samples: profile.samples,
        enrolled: (await store.list()).length,
      },
    };
  }
  if (op === 'identify') {
    const profiles = await store.profiles();
    if (!profiles.length)
      return {
        status: 200,
        body: {
          ok: true,
          speaker: null,
          candidates: [],
          enrolled: 0,
          hint: 'No voices are enrolled yet; offer enroll_voice.',
        },
      };
    const entry = utterances().at(-1);
    if (!entry)
      return {
        status: 409,
        body: { ok: false, error: 'Nothing heard yet in this session.' },
      };
    try {
      const embedding = await embedUtterance(worker, entry);
      const candidates = scoreProfiles(embedding, profiles).slice(0, 5);
      const speaker = matchSpeaker(embedding, profiles, { threshold });
      if (session) session.lastSpeaker = speaker;
      return {
        status: 200,
        body: {
          ok: true,
          speaker,
          candidates,
          enrolled: profiles.length,
          threshold: threshold ?? SPEAKER_THRESHOLD,
          ...(speaker
            ? {}
            : { hint: 'Voice not recognised; offer enroll_voice.' }),
        },
      };
    } catch (error) {
      return {
        status: unavailable(error) ? 503 : 500,
        body: { ok: false, error: error?.message || 'Identification failed' },
      };
    }
  }
  return { status: 400, body: { ok: false, error: `Unknown op "${op}"` } };
}
