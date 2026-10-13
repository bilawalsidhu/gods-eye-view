/** Bounded, demand-owned HLS sessions. No subprocess, disk cache or idle sweep. */
import { randomUUID } from 'node:crypto';

export const HLS_LIMITS = Object.freeze({
  sessions: 2,
  leasesPerSession: 8,
  playlistBytes: 256 * 1024,
  segmentBytes: 4 * 1024 * 1024,
  sessionBytes: 24 * 1024 * 1024,
  segments: 12,
  pollMs: 2000,
  idleMs: 15000,
  timeoutMs: 10000,
  readyMs: 12000,
});

/** Refuse redirects; count actual streamed bytes, including chunked responses. */
export async function fetchHlsBytes(
  url,
  {
    fetchImpl = fetch,
    signal,
    maxBytes,
    timeoutMs = HLS_LIMITS.timeoutMs,
  } = {},
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  let reader;
  let response;
  try {
    controller.signal.throwIfAborted();
    response = await fetchImpl(url, {
      redirect: 'error',
      signal: controller.signal,
      headers: { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' },
    });
    if (
      !response.ok ||
      response.redirected ||
      (response.url && new URL(response.url).href !== new URL(url).href)
    )
      throw new Error('HLS upstream refused');
    if (Number(response.headers.get('content-length')) > maxBytes)
      throw new Error('HLS response too large');
    reader = response.body?.getReader?.();
    if (!reader) throw new Error('HLS response is not streamable');
    const chunks = [];
    let length = 0;
    for (;;) {
      controller.signal.throwIfAborted();
      const { done, value } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error('HLS response too large');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, length);
  } finally {
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
    else await response?.body?.cancel().catch(() => {});
    reader?.releaseLock();
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function sameOriginHlsUrl(value, base) {
  const url = new URL(value, base);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.origin !== new URL(base).origin ||
    url.username ||
    url.password
  )
    throw new Error('HLS reference escapes registered origin');
  return url.href;
}

/** Only clear MPEG-TS media playlists: encrypted, fMP4 and byte ranges fail closed. */
export function parseHlsMedia(text, base, limit = HLS_LIMITS.segments) {
  if (
    !text.startsWith('#EXTM3U') ||
    /#EXT-X-(?:KEY|MAP|BYTERANGE|I-FRAMES-ONLY)/.test(text)
  )
    throw new Error('Unsupported HLS playlist');
  let seq = 0;
  let duration = null;
  let discontinuity = false;
  const segments = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      seq = Number(line.slice(22));
      if (!Number.isSafeInteger(seq) || seq < 0)
        throw new Error('Invalid media sequence');
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
    } else if (line.startsWith('#EXTINF:')) {
      duration = Number.parseFloat(line.slice(8));
      if (!Number.isFinite(duration) || duration <= 0 || duration > 60)
        throw new Error('Invalid segment duration');
    } else if (line && !line.startsWith('#')) {
      if (duration === null || !Number.isSafeInteger(seq))
        throw new Error('Invalid HLS segment');
      const uri = sameOriginHlsUrl(line, base);
      if (!new URL(uri).pathname.endsWith('.ts'))
        throw new Error('Only MPEG-TS segments are supported');
      segments.push({ seq: seq++, duration, uri, discontinuity });
      discontinuity = false;
      duration = null;
    }
  }
  return segments.slice(-limit);
}

export function createHlsPuller({
  fetchImpl = fetch,
  limits = HLS_LIMITS,
} = {}) {
  const active = new Map();
  let closed = false;
  const stop = (cameraId, token) => {
    const entry = active.get(cameraId);
    if (!entry || (token && token !== entry.token)) return;
    active.delete(cameraId);
    entry.stopping = true;
    entry.controller.abort();
    clearTimeout(entry.timer);
    for (const lease of entry.leases.values()) clearTimeout(lease.timer);
    entry.leases.clear();
    entry.segments.clear();
    entry.upstream.clear();
    entry.bytes = 0;
  };
  const release = (cameraId, leaseId) => {
    const entry = active.get(cameraId);
    const lease = entry?.leases.get(leaseId);
    if (!lease) return;
    clearTimeout(lease.timer);
    entry.leases.delete(leaseId);
    if (!entry.leases.size) stop(cameraId, entry.token);
  };
  const touch = (entry, leaseId, create = false) => {
    let lease = entry.leases.get(leaseId);
    if (!lease) {
      if (!create || entry.leases.size >= limits.leasesPerSession)
        throw new Error('HLS lease capacity reached');
      lease = {};
      entry.leases.set(leaseId, lease);
    }
    clearTimeout(lease.timer);
    lease.timer = setTimeout(
      () => release(entry.cameraId, leaseId),
      limits.idleMs,
    );
    lease.timer.unref?.();
  };
  const read = (entry, url, maxBytes) =>
    fetchHlsBytes(url, {
      fetchImpl,
      signal: entry.controller.signal,
      maxBytes,
      timeoutMs: limits.timeoutMs,
    });
  const poll = async (entry) => {
    try {
      let base = entry.chunklistUrl || entry.url;
      let text = (await read(entry, base, limits.playlistBytes)).toString(
        'utf8',
      );
      if (!text.includes('#EXTINF:')) {
        const variant = text
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line && !line.startsWith('#'));
        if (!variant || !text.includes('#EXT-X-STREAM-INF:'))
          throw new Error('Missing HLS variant');
        base = sameOriginHlsUrl(variant, entry.url);
        text = (await read(entry, base, limits.playlistBytes)).toString('utf8');
      }
      entry.chunklistUrl = base;
      const segments = parseHlsMedia(text, base, limits.segments);
      const newest = segments.at(-1)?.seq ?? -1;
      const restarted =
        newest < entry.upstreamNewest ||
        segments.some((segment) => {
          const prior = entry.upstream.get(segment.seq);
          return prior && prior !== segment.uri;
        });
      if (restarted) {
        entry.upstream.clear();
        entry.pendingDiscontinuity = true;
      }
      entry.upstreamNewest = newest;
      for (const segment of segments) {
        if (entry.stopping) return;
        if (entry.upstream.has(segment.seq)) continue;
        const body = await read(entry, segment.uri, limits.segmentBytes);
        if (entry.stopping) return;
        // Evict BEFORE retaining the incoming segment. One bounded download may
        // exist in addition to the cache; no unbounded disk output is possible.
        while (
          entry.segments.size &&
          (entry.bytes + body.length > limits.sessionBytes ||
            entry.segments.size >= limits.segments)
        ) {
          const oldest = entry.segments.keys().next().value;
          const removed = entry.segments.get(oldest);
          entry.bytes -= removed.body.length;
          if (removed.discontinuity) entry.discontinuitiesRemoved++;
          entry.segments.delete(oldest);
        }
        if (body.length > limits.sessionBytes)
          throw new Error('Segment exceeds session budget');
        const seq = entry.nextSeq++;
        entry.segments.set(seq, {
          ...segment,
          seq,
          body,
          discontinuity: segment.discontinuity || entry.pendingDiscontinuity,
        });
        entry.pendingDiscontinuity = false;
        entry.upstream.set(segment.seq, segment.uri);
        while (entry.upstream.size > limits.segments * 2)
          entry.upstream.delete(entry.upstream.keys().next().value);
        entry.bytes += body.length;
      }
      entry.failures = 0;
    } catch {
      entry.chunklistUrl = null;
      entry.failures++;
      if (entry.failures >= 3) {
        stop(entry.cameraId, entry.token);
        return;
      }
    } finally {
      if (!entry.stopping) {
        entry.timer = setTimeout(() => {
          entry.polling = poll(entry);
        }, limits.pollMs);
        entry.timer.unref?.();
      }
    }
  };
  const ensure = async (cameraId, url, leaseId = 'legacy') => {
    if (closed) throw new Error('HLS service closed');
    sameOriginHlsUrl(url, url);
    let entry = active.get(cameraId);
    if (entry && entry.url !== url) {
      stop(cameraId);
      entry = null;
    }
    if (entry) {
      touch(entry, leaseId, true);
      return entry;
    }
    // Reserve synchronously, before any await: concurrent creation is singleflight.
    if (active.size >= limits.sessions)
      throw new Error('HLS session capacity reached');
    entry = {
      cameraId,
      url,
      token: randomUUID(),
      controller: new AbortController(),
      segments: new Map(),
      bytes: 0,
      stopping: false,
      failures: 0,
      nextSeq: 0,
      upstream: new Map(),
      leases: new Map(),
      upstreamNewest: -1,
      pendingDiscontinuity: false,
      discontinuitiesRemoved: 0,
    };
    active.set(cameraId, entry);
    touch(entry, leaseId, true);
    entry.polling = poll(entry);
    return entry;
  };
  const waitReady = async (entry, signal) => {
    const until = Date.now() + limits.readyMs;
    while (!entry.stopping && !signal?.aborted && Date.now() < until) {
      if (entry.segments.size >= 2) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };
  const buildPlaylist = async (entry, cameraId, leaseId = 'legacy') => {
    if (entry.stopping || entry.segments.size < 2) return null;
    touch(entry, leaseId);
    const segments = [...entry.segments.values()].sort((a, b) => a.seq - b.seq);
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...segments.map((s) => s.duration)))}`,
      `#EXT-X-MEDIA-SEQUENCE:${segments[0].seq}`,
      `#EXT-X-DISCONTINUITY-SEQUENCE:${entry.discontinuitiesRemoved}`,
    ];
    let previous;
    for (const segment of segments) {
      if (
        segment.discontinuity ||
        (previous !== undefined && segment.seq !== previous + 1)
      )
        lines.push('#EXT-X-DISCONTINUITY');
      lines.push(
        `#EXTINF:${segment.duration.toFixed(3)},`,
        `/api/cctv/media/${encodeURIComponent(cameraId)}/seg_${segment.seq}.ts?session=${entry.token}&lease=${encodeURIComponent(leaseId)}`,
      );
      previous = segment.seq;
    }
    return lines.join('\n') + '\n';
  };
  const getSegment = (cameraId, token, seq, leaseId = 'legacy') => {
    const entry = active.get(cameraId);
    if (!entry || entry.token !== token || !entry.leases.has(leaseId))
      return null;
    const body = entry.segments.get(seq)?.body;
    if (body) touch(entry, leaseId);
    return body || null;
  };
  const shutdown = async () => {
    closed = true;
    const entries = [...active.values()];
    for (const entry of entries) stop(entry.cameraId);
    await Promise.allSettled(entries.map((entry) => entry.polling));
  };
  return {
    ensure,
    waitReady,
    buildPlaylist,
    getSegment,
    stop,
    release,
    shutdown,
    stats: () => ({
      sessions: active.size,
      bytes: [...active.values()].reduce((total, e) => total + e.bytes, 0),
    }),
  };
}
