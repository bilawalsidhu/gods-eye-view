/** Bounded, demand-owned HLS sessions. No subprocess, disk cache or idle sweep. */
import { randomUUID } from 'node:crypto';

export const HLS_LIMITS = Object.freeze({
  sessions: 2,
  leasesPerSession: 8,
  playlistBytes: 256 * 1024,
  segmentBytes: 4 * 1024 * 1024,
  initBytes: 256 * 1024,
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

/** Clear MPEG-TS or whole-file fMP4; encrypted and byte-range inputs fail closed. */
export function parseHlsMedia(text, base, limit = HLS_LIMITS.segments) {
  if (
    !text.startsWith('#EXTM3U') ||
    /#EXT-X-(?:KEY|SESSION-KEY|BYTERANGE|I-FRAMES-ONLY)/.test(text)
  )
    throw new Error('Unsupported HLS playlist');
  let seq = 0;
  let duration = null;
  let discontinuity = false;
  let initUri = null;
  let format = null;
  const segments = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      seq = Number(line.slice(22));
      if (!Number.isSafeInteger(seq) || seq < 0)
        throw new Error('Invalid media sequence');
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      // Whole initialization files only; no ranges or additional attributes.
      const map = /^#EXT-X-MAP:URI="([^"\r\n]+)"$/.exec(line);
      if (!map || duration !== null)
        throw new Error('Unsupported HLS initialization map');
      initUri = sameOriginHlsUrl(map[1], base);
      if (!/\.(?:mp4|m4s)$/i.test(new URL(initUri).pathname))
        throw new Error('Unsupported HLS initialization file');
    } else if (line.startsWith('#EXTINF:')) {
      duration = Number.parseFloat(line.slice(8));
      if (!Number.isFinite(duration) || duration <= 0 || duration > 60)
        throw new Error('Invalid segment duration');
    } else if (line && !line.startsWith('#')) {
      if (duration === null || !Number.isSafeInteger(seq))
        throw new Error('Invalid HLS segment');
      const uri = sameOriginHlsUrl(line, base);
      const pathname = new URL(uri).pathname;
      const nextFormat = initUri ? 'mp4' : 'ts';
      if (
        (initUri && !/\.(?:mp4|m4s)$/i.test(pathname)) ||
        (!initUri && !pathname.endsWith('.ts')) ||
        (format && format !== nextFormat)
      )
        throw new Error('Unsupported or mixed HLS segment format');
      format = nextFormat;
      segments.push({ seq: seq++, duration, uri, initUri, discontinuity });
      discontinuity = false;
      duration = null;
    }
  }
  return segments.slice(-limit);
}

/** Shared, bounded media and initialization files for registered HLS sources. */
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
    entry.inits.clear();
    entry.initByUri.clear();
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
  const evictOldest = (entry) => {
    const oldest = entry.segments.keys().next().value;
    const removed = entry.segments.get(oldest);
    entry.segments.delete(oldest);
    entry.bytes -= removed.body.length;
    if (removed.discontinuity) entry.discontinuitiesRemoved++;
    if (removed.initId !== null) {
      const init = entry.inits.get(removed.initId);
      if (--init.refs === 0) {
        entry.inits.delete(init.id);
        entry.bytes -= init.body.length;
        if (entry.initByUri.get(init.uri) === init.id)
          entry.initByUri.delete(init.uri);
      }
    }
  };
  const upstreamKey = (segment) =>
    JSON.stringify([segment.uri, segment.initUri]);
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
      const format = segments[0]?.initUri ? 'mp4' : 'ts';
      if (segments.length && entry.format && entry.format !== format)
        throw new Error('HLS container changed during session');
      if (segments.length) entry.format = format;
      const newest = segments.at(-1)?.seq ?? -1;
      const restarted =
        newest < entry.upstreamNewest ||
        segments.some((segment) => {
          const prior = entry.upstream.get(segment.seq);
          return prior && prior !== upstreamKey(segment);
        });
      if (restarted) {
        entry.upstream.clear();
        // A restarted encoder can replace an init file at the same URI.
        // Retained segments keep their old init; new media refetches it.
        entry.initByUri.clear();
        entry.pendingDiscontinuity = true;
      }
      entry.upstreamNewest = newest;
      for (const segment of segments) {
        if (entry.stopping) return;
        if (entry.upstream.has(segment.seq)) continue;
        let init = null;
        if (segment.initUri) {
          if (segment.discontinuity) entry.initByUri.delete(segment.initUri);
          init = entry.inits.get(entry.initByUri.get(segment.initUri));
          if (!init) {
            const body = await read(
              entry,
              segment.initUri,
              limits.initBytes ?? HLS_LIMITS.initBytes,
            );
            if (entry.stopping) return;
            init = {
              id: entry.nextInitId++,
              uri: segment.initUri,
              body,
              refs: 0,
            };
          }
        }
        const body = await read(entry, segment.uri, limits.segmentBytes);
        if (entry.stopping) return;
        // Both media and shared init files count against the same budget.
        // One bounded init and one media download may exist outside the cache.
        const addedBytes = () =>
          body.length +
          (init && !entry.inits.has(init.id) ? init.body.length : 0);
        while (
          entry.segments.size &&
          (entry.bytes + addedBytes() > limits.sessionBytes ||
            entry.segments.size >= limits.segments)
        )
          evictOldest(entry);
        if (entry.bytes + addedBytes() > limits.sessionBytes)
          throw new Error('Segment and init exceed session budget');
        if (init) {
          if (!entry.inits.has(init.id)) {
            entry.inits.set(init.id, init);
            entry.bytes += init.body.length;
          }
          entry.initByUri.set(init.uri, init.id);
          init.refs++;
        }
        const initId = init?.id ?? null;
        const initChanged =
          entry.lastInitId !== undefined && entry.lastInitId !== initId;
        const seq = entry.nextSeq++;
        entry.segments.set(seq, {
          ...segment,
          seq,
          body,
          initId,
          discontinuity:
            segment.discontinuity || entry.pendingDiscontinuity || initChanged,
        });
        entry.lastInitId = initId;
        entry.pendingDiscontinuity = false;
        entry.upstream.set(segment.seq, upstreamKey(segment));
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
      inits: new Map(),
      initByUri: new Map(),
      nextInitId: 0,
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
    const hasInit = segments.some((s) => s.initId !== null);
    const mediaRoot = '/api/cctv/media/' + encodeURIComponent(cameraId);
    const query =
      '?session=' + entry.token + '&lease=' + encodeURIComponent(leaseId);
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:' + (hasInit ? 7 : 3),
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...segments.map((s) => s.duration)))}`,
      `#EXT-X-MEDIA-SEQUENCE:${segments[0].seq}`,
      `#EXT-X-DISCONTINUITY-SEQUENCE:${entry.discontinuitiesRemoved}`,
    ];
    let previous;
    let previousInit;
    for (const segment of segments) {
      if (
        segment.discontinuity ||
        (previous !== undefined && segment.seq !== previous + 1)
      )
        lines.push('#EXT-X-DISCONTINUITY');
      if (segment.initId !== null && segment.initId !== previousInit)
        lines.push(
          '#EXT-X-MAP:URI="' +
            mediaRoot +
            '/init_' +
            segment.initId +
            '.mp4' +
            query +
            '"',
        );
      const extension = segment.initId === null ? 'ts' : 'mp4';
      lines.push(
        '#EXTINF:' + segment.duration.toFixed(3) + ',',
        mediaRoot + '/seg_' + segment.seq + '.' + extension + query,
      );
      previous = segment.seq;
      previousInit = segment.initId;
    }
    return lines.join('\n') + '\n';
  };
  const getEntry = (cameraId, token, leaseId) => {
    const entry = active.get(cameraId);
    return entry && entry.token === token && entry.leases.has(leaseId)
      ? entry
      : null;
  };
  const getSegment = (cameraId, token, seq, leaseId = 'legacy') => {
    const entry = getEntry(cameraId, token, leaseId);
    const body = entry?.segments.get(seq)?.body;
    if (body) touch(entry, leaseId);
    return body || null;
  };
  const getAsset = (cameraId, token, name, leaseId = 'legacy') => {
    const entry = getEntry(cameraId, token, leaseId);
    const match = /^(seg|init)_(0|[1-9]\d*)\.(ts|mp4)$/.exec(name);
    if (!entry || !match || !Number.isSafeInteger(Number(match[2])))
      return null;
    const index = Number(match[2]);
    const isInit = match[1] === 'init';
    const asset = isInit ? entry.inits.get(index) : entry.segments.get(index);
    if (!asset) return null;
    const extension = isInit || asset.initId !== null ? 'mp4' : 'ts';
    if (match[3] !== extension) return null;
    touch(entry, leaseId);
    return {
      body: asset.body,
      contentType: extension === 'mp4' ? 'video/mp4' : 'video/mp2t',
    };
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
    getAsset,
    stop,
    release,
    shutdown,
    stats: () => ({
      sessions: active.size,
      bytes: [...active.values()].reduce((total, e) => total + e.bytes, 0),
    }),
  };
}
