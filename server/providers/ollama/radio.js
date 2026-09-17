import { spawn } from 'node:child_process';
import { lookup as lookupDns } from 'node:dns/promises';
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { isNonGlobalIpv4 } from '../radio/stations.js';
import { resolveRadioProxyAddresses } from '../radio/transport.js';

/**
 * Radio-in-the-loop: ffmpeg decodes a public broadcaster stream to 16 kHz
 * mono PCM, the audio worker (faster-whisper) transcribes it in 15 s slices,
 * and a per-listener ring keeps the last hour so the voice assistant can
 * answer "what did they just say about the storm". Everything stays in this
 * process: no audio or text leaves the machine.
 */
export const SAMPLE_RATE = 16_000;
export const CHUNK_SECONDS = 15;
/** 16 kHz * 2 bytes * 15 s. */
export const CHUNK_BYTES = SAMPLE_RATE * 2 * CHUNK_SECONDS;
export const MAX_LISTENERS = 2;
export const MAX_LISTEN_MS = 60 * 60 * 1000;
export const RING_MS = 60 * 60 * 1000;
/** Slices queued behind the in-flight transcription before the oldest is dropped. */
export const MAX_BACKLOG = 2;
/** Ignore a final partial slice shorter than this when ffmpeg exits. */
const MIN_TAIL_BYTES = SAMPLE_RATE * 2;
const MAX_LABEL_CHARS = 140;
const MAX_QUERY_CHARS = 200;
const MAX_RETAINED_LISTENERS = 6;

/** Wrap raw s16le PCM in a 44-byte RIFF header (mono, 16-bit). */
export function wavFromPcm16(pcm, sampleRate = SAMPLE_RATE) {
  const raw = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  // Whole 16-bit samples only; a partial trailing byte would skew the frame.
  const data = raw.length % 2 ? raw.subarray(0, raw.length - 1) : raw;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Slice an unbounded PCM byte stream into fixed-size chunks. */
export function createPcmChunker({ chunkBytes = CHUNK_BYTES } = {}) {
  let pending = [];
  let pendingBytes = 0;
  return {
    /** Feed bytes; returns every complete chunk they produced (possibly none). */
    push(bytes) {
      if (!bytes?.length) return [];
      pending.push(bytes);
      pendingBytes += bytes.length;
      if (pendingBytes < chunkBytes) return [];
      const merged = Buffer.concat(pending, pendingBytes);
      const chunks = [];
      let offset = 0;
      while (merged.length - offset >= chunkBytes) {
        chunks.push(merged.subarray(offset, offset + chunkBytes));
        offset += chunkBytes;
      }
      const rest = merged.subarray(offset);
      pending = rest.length ? [Buffer.from(rest)] : [];
      pendingBytes = rest.length;
      return chunks;
    },
    /** Return whatever is buffered (a partial chunk) and reset. */
    flush() {
      if (!pendingBytes) return null;
      const rest = Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      return rest;
    },
    get buffered() {
      return pendingBytes;
    },
  };
}

/** Time-bounded transcript lines: { t (epoch ms), text, language }. */
export function createTranscriptRing({
  maxAgeMs = RING_MS,
  now = Date.now,
} = {}) {
  const lines = [];
  const prune = () => {
    const cutoff = now() - maxAgeMs;
    while (lines.length && lines[0].t < cutoff) lines.shift();
  };
  return {
    push(line) {
      const text = String(line?.text || '').trim();
      if (!text) return false;
      lines.push({
        t: Number.isFinite(line.t) ? line.t : now(),
        text,
        language: line.language || null,
      });
      prune();
      return true;
    },
    /** Lines from the last `minutes` (all retained lines when omitted). */
    entries(minutes) {
      prune();
      if (!(Number(minutes) > 0)) return lines.slice();
      const cutoff = now() - Number(minutes) * 60_000;
      return lines.filter((line) => line.t >= cutoff);
    },
    /** Lines whose text contains the whole query or every query word. */
    search(query, minutes) {
      const phrase = normalizeSearchText(query);
      if (!phrase) return [];
      const words = phrase.split(' ').filter(Boolean);
      return this.entries(minutes).filter((line) => {
        const haystack = normalizeSearchText(line.text);
        return (
          haystack.includes(phrase) ||
          words.every((word) => haystack.includes(word))
        );
      });
    },
    get size() {
      prune();
      return lines.length;
    },
  };
}

function normalizeSearchText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Format ring lines as "[HH:MM:SS] text" for the model. */
export function formatTranscript(lines) {
  return lines.map((line) => `[${clockTime(line.t)}] ${line.text}`).join('\n');
}

function clockTime(epochMs) {
  const date = new Date(epochMs);
  const two = (n) => String(n).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/**
 * Admit only public http(s) broadcaster URLs: the same host policy the radio
 * directory applies (no loopback, link-local, private or literal-IPv6 hosts,
 * no credentials), extended to plain http because some directory stations are
 * http-only and ffmpeg, unlike the browser, may fetch them.
 */
export function publicRadioStreamUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    const hostname = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '');
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !hostname
    )
      return null;
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      isNonGlobalIpv4(hostname) ||
      hostname.includes(':')
    )
      return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/** Per-read network timeout handed to ffmpeg (microseconds). */
export const FFMPEG_RW_TIMEOUT_US = 15_000_000;

/** ffmpeg arguments that turn any stream into raw 16 kHz mono s16le on stdout. */
export function ffmpegArgs(url) {
  return [
    '-nostdin',
    '-loglevel',
    'error',
    // Redirects and playlist entries come from the broadcaster: keep ffmpeg on
    // plain network protocols (no file:, concat:, data:) and bound each read.
    '-protocol_whitelist',
    'http,https,tcp,tls',
    '-rw_timeout',
    String(FFMPEG_RW_TIMEOUT_US),
    '-i',
    url,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(SAMPLE_RATE),
    '-f',
    's16le',
    '-',
  ];
}

const WINGET_PACKAGES = ['Microsoft', 'WinGet', 'Packages'];

/**
 * Locate ffmpeg: FFMPEG_PATH, then PATH, then the winget install folder
 * (Gyan.FFmpeg_*\ffmpeg-*\bin\ffmpeg.exe) that is not on PATH by default.
 * Returns null when nothing is found so callers can explain what to install.
 */
export function resolveFfmpegPath({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  readdir = readdirSync,
} = {}) {
  const exe = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const explicit = String(env.FFMPEG_PATH || '').trim();
  if (explicit) return exists(explicit) ? explicit : null;
  const pathEntries = String(env.PATH || env.Path || '')
    .split(delimiter)
    .filter(Boolean);
  for (const dir of pathEntries) {
    const candidate = join(dir, exe);
    if (exists(candidate)) return candidate;
  }
  if (platform === 'win32' && env.LOCALAPPDATA) {
    const packages = join(env.LOCALAPPDATA, ...WINGET_PACKAGES);
    const list = (dir) => {
      try {
        return readdir(dir).map(String).sort().reverse();
      } catch {
        return [];
      }
    };
    for (const pkg of list(packages)) {
      if (!/^Gyan\.FFmpeg/i.test(pkg)) continue;
      for (const build of list(join(packages, pkg))) {
        if (!/^ffmpeg-/i.test(build)) continue;
        const candidate = join(packages, pkg, build, 'bin', exe);
        if (exists(candidate)) return candidate;
      }
    }
  }
  return null;
}

/**
 * Own every live listener: spawn, slice, transcribe, retain, expire.
 * `worker` is the shared audio worker (transcribe(wav, { language })).
 */
export function createRadioListenManager({
  worker,
  spawnImpl = spawn,
  ffmpegPath = null,
  lookupImpl = lookupDns,
  now = Date.now,
  log = () => {},
  maxListeners = MAX_LISTENERS,
  maxListenMs = MAX_LISTEN_MS,
  ringMs = RING_MS,
  chunkBytes = CHUNK_BYTES,
  maxBacklog = MAX_BACKLOG,
} = {}) {
  const listeners = new Map();
  let sequence = 0;
  let disposed = false;

  const active = () => [...listeners.values()].filter((l) => l.active);
  // A string pins the binary; a function (tests) or null defers to the
  // FFMPEG_PATH / PATH / winget resolution above.
  const ffmpegBinary = () =>
    typeof ffmpegPath === 'function'
      ? ffmpegPath()
      : ffmpegPath || resolveFfmpegPath();

  function summarize(listener) {
    return {
      id: listener.id,
      label: listener.label,
      url: listener.url,
      active: listener.active,
      startedAt: new Date(listener.startedAt).toISOString(),
      endedAt: listener.endedAt
        ? new Date(listener.endedAt).toISOString()
        : null,
      endedReason: listener.endedReason,
      seconds: Math.round(
        ((listener.endedAt || now()) - listener.startedAt) / 1000,
      ),
      chunks: listener.chunks,
      transcribed: listener.transcribed,
      dropped: listener.dropped,
      lines: listener.ring.size,
      lastText: listener.lastText,
      error: listener.error,
    };
  }

  function pruneRetained() {
    const ended = [...listeners.values()]
      .filter((l) => !l.active)
      .sort((a, b) => a.endedAt - b.endedAt);
    while (listeners.size > MAX_RETAINED_LISTENERS && ended.length)
      listeners.delete(ended.shift().id);
  }

  function pick(id) {
    if (id) return listeners.get(String(id)) || null;
    const running = active();
    if (running.length) return running[running.length - 1];
    let latest = null;
    for (const listener of listeners.values())
      if (!latest || listener.startedAt > latest.startedAt) latest = listener;
    return latest;
  }

  async function start({ url, label } = {}) {
    if (disposed) throw httpError(503, 'Radio listener is shutting down');
    const safeUrl = publicRadioStreamUrl(url);
    if (!safeUrl)
      throw httpError(400, 'Stream URL must be a public http(s) address');
    if (active().length >= maxListeners)
      throw httpError(
        409,
        `Already listening to ${maxListeners} station(s); stop one first`,
      );
    for (const listener of active())
      if (listener.url === safeUrl)
        return { ok: true, alreadyListening: true, ...summarize(listener) };
    const binary = ffmpegBinary();
    if (!binary)
      throw httpError(
        501,
        'ffmpeg was not found. Install it (winget install Gyan.FFmpeg) or set FFMPEG_PATH.',
      );
    // Same admission the directory proxy applies: every resolved address
    // must be public. ffmpeg resolves again on its own, so this is a guard
    // against obvious loopback/LAN targets rather than DNS rebinding.
    try {
      await resolveRadioProxyAddresses(new URL(safeUrl).hostname, lookupImpl);
    } catch (error) {
      throw httpError(
        400,
        `Stream host is not allowed: ${error?.message || error}`,
      );
    }
    if (active().length >= maxListeners)
      throw httpError(409, `Already listening to ${maxListeners} station(s)`);

    const id = `radio-${++sequence}`;
    const listener = {
      id,
      url: safeUrl,
      label: cleanText(label, MAX_LABEL_CHARS) || new URL(safeUrl).hostname,
      startedAt: now(),
      endedAt: null,
      endedReason: null,
      active: true,
      chunks: 0,
      transcribed: 0,
      dropped: 0,
      lastText: null,
      error: null,
      ring: createTranscriptRing({ maxAgeMs: ringMs, now }),
      chunker: createPcmChunker({ chunkBytes }),
      queue: [],
      inFlight: null,
      proc: null,
      timer: null,
      stderr: [],
    };
    listeners.set(id, listener);
    pruneRetained();

    let proc;
    try {
      proc = spawnImpl(binary, ffmpegArgs(safeUrl), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      listeners.delete(id);
      throw httpError(
        500,
        `Could not start ffmpeg: ${error?.message || error}`,
      );
    }
    listener.proc = proc;
    log('radio.start', {
      id,
      label: listener.label,
      url: safeUrl,
      pid: proc.pid,
    });

    proc.stdout?.on('data', (bytes) => {
      if (!listener.active) return;
      for (const chunk of listener.chunker.push(bytes))
        enqueue(listener, chunk);
    });
    proc.stderr?.setEncoding?.('utf8');
    proc.stderr?.on('data', (text) => {
      for (const line of String(text).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        listener.stderr.push(trimmed);
        if (listener.stderr.length > 10) listener.stderr.shift();
      }
    });
    proc.on('error', (error) =>
      end(listener, `ffmpeg error: ${error?.message || error}`),
    );
    proc.on('exit', (code, signal) => {
      if (!listener.active) return;
      const tail = listener.stderr.at(-1);
      end(
        listener,
        `ffmpeg exited (code ${code}, signal ${signal})${tail ? `: ${tail}` : ''}`,
      );
    });
    listener.timer = setTimeout(() => end(listener, 'time limit'), maxListenMs);
    listener.timer.unref?.();
    return { ok: true, ...summarize(listener) };
  }

  function enqueue(listener, pcm) {
    listener.chunks += 1;
    // Chunk timestamps mark when its audio started, not when Whisper finished.
    listener.queue.push({
      pcm,
      t: now() - (pcm.length / (SAMPLE_RATE * 2)) * 1000,
    });
    while (listener.queue.length > maxBacklog) {
      listener.queue.shift();
      listener.dropped += 1;
    }
    pump(listener);
  }

  function pump(listener) {
    if (listener.inFlight || !listener.queue.length) return;
    const job = listener.queue.shift();
    listener.inFlight = (async () => {
      try {
        const result = await worker.transcribe(wavFromPcm16(job.pcm), {
          language: 'auto',
        });
        listener.transcribed += 1;
        const text = String(result?.text || '').trim();
        if (text && !result?.noSpeech) {
          listener.ring.push({
            t: job.t,
            text,
            language: result.language || null,
          });
          listener.lastText = text;
        }
      } catch (error) {
        listener.error = error?.message || String(error);
        log('radio.transcribe_error', {
          id: listener.id,
          error: listener.error,
        });
      } finally {
        listener.inFlight = null;
        pump(listener);
      }
    })();
  }

  function end(listener, reason) {
    if (!listener.active) return;
    listener.active = false;
    listener.endedAt = now();
    listener.endedReason = reason;
    if (listener.timer) clearTimeout(listener.timer);
    listener.timer = null;
    const tail = listener.chunker.flush();
    if (tail && tail.length >= MIN_TAIL_BYTES && reason !== 'stopped')
      enqueue(listener, tail);
    const proc = listener.proc;
    listener.proc = null;
    if (proc && proc.exitCode === null && !proc.killed) {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }
    log('radio.end', { id: listener.id, reason, lines: listener.ring.size });
  }

  function stop({ id } = {}) {
    const targets = id ? [listeners.get(String(id))].filter(Boolean) : active();
    if (id && !targets.length) throw httpError(404, `No radio listener ${id}`);
    const stopped = [];
    for (const listener of targets) {
      if (listener.active) end(listener, 'stopped');
      stopped.push(listener.id);
    }
    return { ok: true, stopped, listening: active().map(summarize) };
  }

  function status() {
    return {
      ok: true,
      ffmpeg: Boolean(ffmpegBinary()),
      maxListeners,
      listening: active().map(summarize),
      recent: [...listeners.values()].filter((l) => !l.active).map(summarize),
    };
  }

  function transcript({ id, minutes = 5 } = {}) {
    const listener = pick(id);
    if (!listener)
      throw httpError(404, 'No radio listener. Call radio_listen first.');
    const span = clampMinutes(minutes, 5);
    const lines = listener.ring.entries(span);
    return {
      ok: true,
      id: listener.id,
      label: listener.label,
      active: listener.active,
      minutes: span,
      lineCount: lines.length,
      lines: lines.map(publicLine),
      text: formatTranscript(lines),
      note:
        !lines.length && listener.active && listener.transcribed === 0
          ? 'Still warming up: the first slice takes about 20 seconds.'
          : undefined,
    };
  }

  function search({ id, query, minutes = 30 } = {}) {
    const listener = pick(id);
    if (!listener)
      throw httpError(404, 'No radio listener. Call radio_listen first.');
    const clean = cleanText(query, MAX_QUERY_CHARS);
    if (!clean) throw httpError(400, 'query is required');
    const span = clampMinutes(minutes, 30);
    const lines = listener.ring.search(clean, span);
    return {
      ok: true,
      id: listener.id,
      label: listener.label,
      query: clean,
      minutes: span,
      matchCount: lines.length,
      lines: lines.map(publicLine),
      text: formatTranscript(lines),
    };
  }

  function dispose() {
    disposed = true;
    for (const listener of listeners.values()) end(listener, 'stopped');
  }

  return { start, stop, status, transcript, search, dispose, summarize };
}

function publicLine(line) {
  return {
    t: new Date(line.t).toISOString(),
    text: line.text,
    language: line.language,
  };
}

function clampMinutes(value, fallback) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  return Math.min(60, minutes);
}

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** One manager per server process; ffmpeg children die with the server. */
export function sharedRadioListenManager(options) {
  const key = '__gevRadioListen';
  if (!globalThis[key]) {
    const manager = createRadioListenManager(options);
    globalThis[key] = manager;
    process.once('exit', () => manager.dispose());
  }
  return globalThis[key];
}
