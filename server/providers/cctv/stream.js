/**
 * Live HLS delivery strategies for the CCTV media proxy.
 *
 * Both strategies own a per-camera segment store on disk (seg_<n>.ts in a
 * temp dir) and generate the playlist the browser sees, so upstream session
 * behaviour never reaches the client:
 *
 *   createHlsPuller  — for http(s) .m3u8 upstreams. Pure Node, no dependencies.
 *   createHlsRemuxer — for RTMP and other stream kinds, via ffmpeg (-c copy).
 *                      Optional: absent, those cameras fall back to stills.
 *
 * Both expose the same surface: ensure(cameraId, url) -> entry,
 * waitReady(entry), buildPlaylist(entry, cameraId), shutdown(). The media
 * route in ../cctv.js picks a strategy by URL and serves files from entry.dir.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { spawn } from 'node:child_process';
import { CCTV_MEDIA_FETCH_TIMEOUT_MS } from './constants.js';

/**
 * Read a text response with a byte cap, cancelling the body on overflow.
 * media.js keeps its byte-buffer reader private; playlists need text.
 * @returns {Promise<{tooLarge:boolean,text:string}>}
 */
export async function readCappedResponseText(upstream, maxBytes) {
  const declared = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await upstream.body?.cancel(); } catch { /* no-op */ }
    return { tooLarge: true, text: '' };
  }
  if (!upstream.body || typeof upstream.body[Symbol.asyncIterator] !== 'function') {
    const text = await upstream.text();
    return text.length > maxBytes ? { tooLarge: true, text: '' } : { tooLarge: false, text };
  }
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for await (const chunk of upstream.body) {
    total += chunk.length;
    if (total > maxBytes) {
      try { await upstream.body.cancel(); } catch { /* no-op */ }
      return { tooLarge: true, text: '' };
    }
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return { tooLarge: false, text };
}

/**
 * Per-camera HLS puller with a proxy-owned segment store (no ffmpeg).
 *
 * Wowza-style upstreams expire sessions fast, but their segment numbering is
 * stream-global (EXT-X-MEDIA-SEQUENCE carries across sessions). So the proxy
 * polls the chunklist every ~2 s (which also keeps the session warm), re-reads
 * the master the moment a poll is refused, and downloads every segment it has
 * not yet seen, keyed by that global sequence. Zero overlap, zero loss across
 * session rotations, exact EXTINF durations from upstream, PTS continuous
 * because it is the same encoder. Serves the same file layout as
 * createHlsRemuxer (seg_<n>.ts in a per-camera dir) so the media route is
 * shared. Idle cameras are reaped after IDLE_MS.
 */
export function createHlsPuller() {
  const OUT_ROOT = path.join(os.tmpdir(), 'gev-hls-pull');
  const IDLE_MS = 60_000;
  const READY_TIMEOUT_MS = 20_000;
  const POLL_MS = 2_000;
  const PLAYLIST_WINDOW = 15;
  const KEEP_ON_DISK = 24;
  const MIN_READY_SEGMENTS = 3;
  const FETCH_TIMEOUT_MS = CCTV_MEDIA_FETCH_TIMEOUT_MS;
  const MAX_PLAYLIST_BYTES = 256 * 1024;
  const UA = 'gods-eye-view-cctv-proxy/1.0';
  /** @type {Map<string, any>} */
  const active = new Map();
  const headers = { 'User-Agent': UA };
  const fetchText = async (url) => {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
    const { tooLarge, text } = await readCappedResponseText(r, MAX_PLAYLIST_BYTES);
    if (tooLarge) throw new Error('playlist too large');
    return text;
  };
  /** Follow a master playlist to its first media playlist (or return it if already one). */
  const resolveChunklist = async (masterUrl) => {
    const text = await fetchText(masterUrl);
    if (text.includes('#EXTINF')) return { url: masterUrl, text };
    const first = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (!first) throw new Error('master playlist has no variants');
    const url = new URL(first, masterUrl);
    if (url.origin !== new URL(masterUrl).origin) throw new Error('variant escapes origin');
    return { url: url.toString(), text: await fetchText(url.toString()) };
  };
  /** Parse a media playlist into [{seq, duration, uri}] using MEDIA-SEQUENCE + index. */
  const parseMedia = (text, baseUrl) => {
    let mediaSeq = 0;
    let target = 0;
    let dur = null;
    const out = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSeq = Number(line.slice(22)) || 0;
      else if (line.startsWith('#EXT-X-TARGETDURATION:')) target = Number(line.slice(22)) || 0;
      else if (line.startsWith('#EXTINF:')) dur = parseFloat(line.slice(8)) || null;
      else if (!line.startsWith('#')) {
        let uri;
        try { uri = new URL(line, baseUrl); } catch { continue; }
        if (uri.origin !== new URL(baseUrl).origin) continue;
        const m = /_(\d+)\.ts(\?|$)/i.exec(uri.pathname);
        const seq = m ? Number(m[1]) : mediaSeq + out.length;
        out.push({ seq, duration: dur || target || 2, uri: uri.toString() });
        dur = null;
      }
    }
    return { segments: out, target };
  };
  const downloadSegment = async (entry, seg) => {
    const r = await fetch(seg.uri, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`segment ${seg.seq} HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const file = path.join(entry.dir, `seg_${seg.seq}.ts`);
    await fsp.writeFile(`${file}.part`, buf);
    await fsp.rename(`${file}.part`, file);
    entry.segments.set(seg.seq, { duration: seg.duration });
  };
  const prune = (entry) => {
    const seqs = [...entry.segments.keys()].sort((a, b) => a - b);
    while (seqs.length > KEEP_ON_DISK) {
      const n = seqs.shift();
      entry.segments.delete(n);
      fsp.rm(path.join(entry.dir, `seg_${n}.ts`), { force: true }).catch(() => {});
    }
  };
  const poll = async (cameraId, entry) => {
    if (entry.stopping || entry.polling) return;
    entry.polling = true;
    try {
      let text;
      if (!entry.chunklistUrl) {
        const r = await resolveChunklist(entry.masterUrl);
        entry.chunklistUrl = r.url;
        text = r.text;
      } else {
        try {
          text = await fetchText(entry.chunklistUrl);
        } catch (err) {
          if (err.status === 403 || err.status === 404) {
            // Session rotated: re-read the master for the live chunklist.
            const r = await resolveChunklist(entry.masterUrl);
            if (r.url !== entry.chunklistUrl) console.info(`[CCTV:pull ${cameraId}] session rotated`);
            entry.chunklistUrl = r.url;
            text = r.text;
          } else {
            throw err;
          }
        }
      }
      const { segments } = parseMedia(text, entry.chunklistUrl);
      for (const seg of segments) {
        if (entry.stopping) break;
        if (entry.segments.has(seg.seq) || entry.inFlight.has(seg.seq)) continue;
        if (entry.lastSeq !== null && seg.seq <= entry.lastSeq) continue; // older than what we hold
        entry.inFlight.add(seg.seq);
        try {
          await downloadSegment(entry, seg);
          entry.lastSeq = Math.max(entry.lastSeq ?? -1, seg.seq);
        } catch (err) {
          console.warn(`[CCTV:pull ${cameraId}]`, err.message);
        } finally {
          entry.inFlight.delete(seg.seq);
        }
      }
      prune(entry);
      entry.failures = 0;
    } catch (err) {
      entry.failures += 1;
      if (entry.failures === 1 || entry.failures % 10 === 0) {
        console.warn(`[CCTV:pull ${cameraId}] poll failed (${entry.failures}):`, err.message);
      }
      if (entry.failures >= 3) entry.chunklistUrl = null; // force master re-resolve
    } finally {
      entry.polling = false;
    }
  };
  const ensure = async (cameraId, masterUrl) => {
    let entry = active.get(cameraId);
    if (entry) {
      entry.lastAccess = Date.now();
      return entry;
    }
    const dir = path.join(OUT_ROOT, cameraId.replace(/[^a-zA-Z0-9_-]/g, '_'));
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(dir, { recursive: true });
    entry = {
      dir,
      masterUrl,
      chunklistUrl: null,
      segments: new Map(),
      inFlight: new Set(),
      lastSeq: null,
      lastAccess: Date.now(),
      failures: 0,
      polling: false,
      stopping: false,
      timer: null,
    };
    active.set(cameraId, entry);
    entry.timer = setInterval(() => { poll(cameraId, entry); }, POLL_MS);
    entry.timer.unref?.();
    poll(cameraId, entry);
    return entry;
  };
  const waitReady = async (entry) => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (entry.segments.size >= MIN_READY_SEGMENTS) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };
  const buildPlaylist = async (entry, cameraId) => {
    const seqs = [...entry.segments.keys()].sort((a, b) => a - b);
    if (seqs.length < 2) return null;
    const window = seqs.slice(-PLAYLIST_WINDOW);
    const prefix = `/api/cctv/media/${encodeURIComponent(cameraId)}/`;
    const maxDur = Math.max(...window.map((n) => entry.segments.get(n).duration));
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(maxDur)}`,
      `#EXT-X-MEDIA-SEQUENCE:${window[0]}`,
    ];
    let prev = null;
    for (const n of window) {
      if (prev !== null && n !== prev + 1) lines.push('#EXT-X-DISCONTINUITY');
      lines.push(`#EXTINF:${entry.segments.get(n).duration.toFixed(3)},`, `${prefix}seg_${n}.ts`);
      prev = n;
    }
    return lines.join('\n') + '\n';
  };
  const stopEntry = (entry) => {
    entry.stopping = true;
    if (entry.timer) { clearInterval(entry.timer); entry.timer = null; }
    fsp.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
  };
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of active) {
      if (now - entry.lastAccess > IDLE_MS) { stopEntry(entry); active.delete(id); }
    }
  }, 30_000);
  sweep.unref?.();
  const shutdown = () => {
    clearInterval(sweep);
    for (const [, entry] of active) stopEntry(entry);
    active.clear();
  };
  return { isAvailable: () => true, ensure, waitReady, buildPlaylist, shutdown };
}
/**
 * Per-camera ffmpeg segment producer with a proxy-owned playlist.
 *
 * Wowza-style upstreams expire HLS sessions fast and irregularly; no single
 * long-lived reader survives them (ffmpeg's HLS demuxer exits on a master
 * playlist 403 above the -reconnect layer). So ffmpeg is treated as
 * disposable: it only writes numbered MPEG-TS segments (-f segment) into a
 * per-camera dir, and when it dies it is respawned with -segment_start_number
 * continuing from the last file on disk. The playlist is generated here from
 * whatever segments exist, with a monotonic media sequence, so respawns are
 * invisible to hls.js. -c copy: no re-encode, no quality loss. Processes are
 * reaped after IDLE_MS with no client access; dirs are pruned to a window.
 */
export function createHlsRemuxer() {
  const OUT_ROOT = path.join(os.tmpdir(), 'gev-hls');
  const IDLE_MS = 60_000;
  const READY_TIMEOUT_MS = 20_000;
  const SEGMENT_SECONDS = 4;
  const STALL_MS = 15_000;
  const PLAYLIST_WINDOW = 15; // segments listed
  const KEEP_ON_DISK = 24; // segments retained w/ in-flight fetches
  const MIN_READY_SEGMENTS = 3;
  const RESPAWN_DELAY_MS = 500;
  const SEG_RE = /^seg_(\d+)\.ts$/;
  /** @type {Map<string,{proc:import('node:child_process').ChildProcess|null,dir:string,upstreamUrl:string,lastAccess:number,nextSeg:number,respawnTimer:NodeJS.Timeout|null,stopping:boolean}>} */
  const active = new Map();
  let available = null;
  const isAvailable = () => {
    if (available !== null) return available;
    try {
      const probe = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      probe.on('error', () => { available = false; });
      available = true;
    } catch {
      available = false;
    }
    return available;
  };
  /** Sorted ascending list of segment numbers currently on disk */
  const listSegments = async (dir) => {
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return []; }
    return names
      .map((n) => SEG_RE.exec(n))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  };
  /** seg number -> duration, from every list_*.csv in the dir. */
  const readDurations = async (dir) => {
    const out = new Map();
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return out; }
    for (const n of names) {
      if (!/^list_\d+\.csv$/.test(n)) continue;
      const txt = await fsp.readFile(path.join(dir, n), 'utf8').catch(() => '');
      for (const line of txt.split('\n')) {
        const [file, start, end] = line.split(',');
        const m = file && SEG_RE.exec(file.trim());
        if (m && start && end) out.set(Number(m[1]), Math.max(0.1, Number(end) - Number(start)));
      }
    }
    return out;
  };
  const spawnProducer = (cameraId, entry) => {
    if (entry.stopping) return;
    entry.boundaries.push(entry.nextSeg);
    const proc = spawn('ffmpeg', [
      '-nostdin', '-loglevel', 'warning',
      ...(/^rtmp/i.test(entry.upstreamUrl)
        ? ['-rtmp_live', 'live', '-rw_timeout', '10000000',
           '-fflags', 'nobuffer', '-analyzeduration', '1000000', '-probesize', '500000']
        : ['-user_agent', 'gods-eye-view-cctv-proxy/1.0',
         '-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '1']),
      '-i', entry.upstreamUrl,
      '-c', 'copy',
      '-f', 'segment',
      '-segment_format', 'mpegts',
      '-segment_time', String(SEGMENT_SECONDS),
      '-segment_start_number', String(entry.nextSeg),
      '-segment_list_type', 'csv',
      '-segment_list_size', '0',
      '-segment_list', path.join(entry.dir, `list_${entry.nextSeg}.csv`),
      '-reset_timestamps', '0',
      path.join(entry.dir, 'seg_%d.ts'),
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    entry.proc = proc;
    proc.stderr?.on('data', (d) => {
      const line = String(d).trim();
      if (line) console.warn(`[CCTV:ffmpeg ${cameraId}]`, line);
    });
    proc.on('exit', async (code) => {
      if (entry.proc !== proc) return;
      entry.proc = null;
      const segs = await listSegments(entry.dir);
      entry.nextSeg = segs.length ? segs[segs.length - 1] + 1 : entry.nextSeg;
      if (entry.stopping || active.get(cameraId) !== entry) return;
      const idle = Date.now() - entry.lastAccess > IDLE_MS;
      console.warn(`[CCTV:ffmpeg ${cameraId}] exited (${code}); next seg ${entry.nextSeg}${idle ? ' - idle, not respawning' : ' - respawning'}`);
      if (idle) return;
      entry.respawnTimer = setTimeout(() => {
        entry.respawnTimer = null;
        spawnProducer(cameraId, entry);
      }, RESPAWN_DELAY_MS);
    });
  };
  const ensure = async (cameraId, upstreamUrl) => {
    let entry = active.get(cameraId);
    if (entry) {
      entry.lastAccess = Date.now();
      if (!entry.proc && !entry.respawnTimer && !entry.stopping) spawnProducer(cameraId, entry);
      return entry;
    }
    const dir = path.join(OUT_ROOT, cameraId.replace(/[^a-zA-Z0-9_-]/g, '_'));
    await fsp.mkdir(dir, { recursive: true });
    const existing = await listSegments(dir);
    entry = {
      proc: null,
      dir,
      upstreamUrl,
      lastAccess: Date.now(),
      nextSeg: existing.length ? existing[existing.length - 1] + 1 : 0,
      respawnTimer: null,
      stopping: false,
      boundaries: [],
    };
    active.set(cameraId, entry);
    spawnProducer(cameraId, entry);
    return entry;
  };
  const waitReady = async (entry) => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const segs = await listSegments(entry.dir);
      if (segs.length >= MIN_READY_SEGMENTS) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };
  /**
   * Build the playlist from the segments on disk and prune old files.
   * Newest segment may still be mid-write so it is excluded.
   * @returns {Promise<string|null>} playlist text, or null if not enough segments.
   */
  const buildPlaylist = async (entry, cameraId) => {
    const segs = await listSegments(entry.dir);
    if (segs.length < 2) return null;
    const complete = segs.slice(0, -1);
    const window = complete.slice(-PLAYLIST_WINDOW);
    const keepFrom = segs.length > KEEP_ON_DISK ? segs[segs.length - KEEP_ON_DISK] : -1;
    for (const n of segs) {
      if (n < keepFrom) fsp.rm(path.join(entry.dir, `seg_${n}.ts`), { force: true }).catch(() => {});
    }
    const prefix = `/api/cctv/media/${encodeURIComponent(cameraId)}/`;
    const first = window[0];
    const priorBoundaries = entry.boundaries.filter((b) => b > 0 && b <= first).length;
    const durations = await readDurations(entry.dir);
    const maxDur = Math.max(SEGMENT_SECONDS, ...window.map((n) => durations.get(n) || SEGMENT_SECONDS));
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(maxDur)}`,
      `#EXT-X-MEDIA-SEQUENCE:${first}`,
      `#EXT-X-DISCONTINUITY-SEQUENCE:${priorBoundaries}`,
    ];
    let prev = null;
    for (const n of window) {
      const isBoundary = n !== first && entry.boundaries.includes(n);
      const isGap = prev !== null && n !== prev + 1;
      const dur = durations.get(n) || SEGMENT_SECONDS;
      if (isBoundary || isGap) lines.push('#EXT-X-DISCONTINUITY');
      lines.push(`#EXTINF:${dur.toFixed(3)},`, `${prefix}seg_${n}.ts`);
      prev = n;
    }
    return lines.join('\n') + '\n';
  };
  const stopEntry = (entry) => {
    entry.stopping = true;
    if (entry.respawnTimer) { clearTimeout(entry.respawnTimer); entry.respawnTimer = null; }
    if (entry.proc) entry.proc.kill('SIGTERM');
    fsp.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
  };
  const sweep = setInterval(async () => {
    const now = Date.now();
    for (const [id, entry] of active) {
      if (now - entry.lastAccess > IDLE_MS) { stopEntry(entry); active.delete(id); continue; }
      if (entry.proc) {
        const segs = await listSegments(entry.dir);
        const newest = segs.length ? segs[segs.length - 1] : -1;
        if (newest !== entry.watchSeg) { entry.watchSeg = newest; entry.watchAt = now; }
        else if (now - (entry.watchAt || now) > STALL_MS) {
          console.warn(`[CCTV:ffmpeg ${id}] no new segment for ${STALL_MS / 1000}s — killing producer`);
          entry.watchAt = now;
          entry.proc.kill('SIGKILL');
        }
      }
    }
  }, 5_000);
  sweep.unref?.();
  const shutdown = () => {
    clearInterval(sweep);
    for (const [, entry] of active) stopEntry(entry);
    active.clear();
  };

  return { isAvailable, ensure, waitReady, buildPlaylist, shutdown };
}