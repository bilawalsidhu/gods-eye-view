import os from 'node:os';

/**
 * Peer federation for the local voice assistant: two or more God's Eye View
 * instances share spoken alerts and saved places. This instance dials every
 * peer's companion hub (/api/voice/remote, remote.js) as an ordinary remote
 * client, introduces itself with {type:'hello', peer:{name}} and watches the
 * mirrored session frames. Two frame types cross the wire:
 *
 *   notice      a spoken alert on the peer, replayed here as
 *               "From <peer>: ..." through the active voice session (or to
 *               this hub's remotes when no session is open)
 *   peer_place  a saved place sent with share_place; the receiving hub
 *               (remote.js) mirrors it to its remotes and delivers it to the
 *               local voice session as a peer_place frame
 *
 * Loop protection: everything forwarded carries `origin` (the display name of
 * the instance it came from) and frames that already carry an origin are never
 * forwarded again, so a full mesh delivers each alert once and a chain of
 * peers stops after one hop.
 *
 * Config: GEV_PEERS = comma-separated ws://host:port/api/voice/remote URLs (a
 * bare host:port means that path), GEV_PEER_NAME = this instance's display
 * name (default os.hostname()). See docs/FEDERATION.md.
 */
export const PEERS_ROUTE = '/api/voice/peers';
export const PEER_HUB_PATH = '/api/voice/remote';
export const MAX_NOTICE_CHARS = 400;
export const MAX_PEER_NAME_CHARS = 80;
export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
const OPEN = 1;

/** This instance's display name as peers will see it. */
export function peerName(env = process.env) {
  return (
    String(env.GEV_PEER_NAME || '')
      .trim()
      .slice(0, MAX_PEER_NAME_CHARS) || os.hostname()
  );
}

/**
 * A peer URL as it may be logged or reported: credentials in the userinfo
 * part (ws://user:pass@host) are dropped, everything else is kept verbatim.
 * @param {string} url
 * @returns {string}
 */
export function publicPeerUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return String(url);
  }
}

/** Parse GEV_PEERS into unique { url, label } hub endpoints. */
export function parsePeerList(value) {
  const peers = [];
  const seen = new Set();
  for (const raw of String(value || '').split(/[,\s]+/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(entry)
      ? entry.replace(/^https?:/i, (scheme) =>
          scheme.toLowerCase() === 'https:' ? 'wss:' : 'ws:',
        )
      : `ws://${entry}`;
    let parsed;
    try {
      parsed = new URL(withScheme);
    } catch {
      continue;
    }
    if (!/^wss?:$/.test(parsed.protocol) || !parsed.host) continue;
    if (parsed.pathname === '/' || parsed.pathname === '')
      parsed.pathname = PEER_HUB_PATH;
    const url = parsed.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    peers.push({ url, label: parsed.host });
  }
  return peers;
}

const OPTIONAL_PLACE_NUMBERS = ['alt', 'heading', 'pitch', 'roll'];

/** Keep only the fields a saved place needs; null when it cannot be flown to. */
export function sanitizePlace(place) {
  if (!place || typeof place !== 'object') return null;
  const name = String(place.name || '')
    .trim()
    .slice(0, MAX_PEER_NAME_CHARS);
  const lat = Number(place.lat);
  const lon = Number(place.lon);
  if (
    !name ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return null;
  const clean = { name, lat, lon };
  for (const key of OPTIONAL_PLACE_NUMBERS) {
    const value = Number(place[key]);
    if (
      place[key] !== undefined &&
      place[key] !== null &&
      Number.isFinite(value)
    )
      clean[key] = value;
  }
  return clean;
}

const cleanName = (value) =>
  String(value || '')
    .trim()
    .slice(0, MAX_PEER_NAME_CHARS);

/**
 * One outbound connection to a peer hub. Reconnects with exponential backoff
 * (1 s doubling to 30 s, reset on a successful open) until close() is called.
 * `WebSocketImpl` is the ws-style constructor: new WebSocketImpl(url) with
 * on('open'|'message'|'close'|'error'), send(), close(), readyState/OPEN.
 */
export function createPeerLink({
  url,
  label = new URL(url).host,
  me,
  WebSocketImpl,
  onOpen = () => {},
  onFrame = () => {},
  log = () => {},
  timers = { setTimeout, clearTimeout },
  now = () => Date.now(),
  backoff = { min: BACKOFF_MIN_MS, max: BACKOFF_MAX_MS },
}) {
  const shownUrl = publicPeerUrl(url);
  let socket = null;
  let timer = null;
  let delay = backoff.min;
  let closed = false;
  const link = {
    url,
    label,
    /** Name the peer hub reported in its hello reply; label until then. */
    name: null,
    connected: false,
    lastSeen: null,
    attempts: 0,
  };

  function schedule() {
    if (closed || timer) return;
    const wait = delay;
    timer = timers.setTimeout(() => {
      timer = null;
      connect();
    }, wait);
    delay = Math.min(delay * 2, backoff.max);
  }

  function connect() {
    if (closed || socket) return;
    link.attempts += 1;
    let ws;
    try {
      ws = new WebSocketImpl(url);
    } catch (error) {
      log('peer.dial_failed', { url: shownUrl, error: error?.message });
      schedule();
      return;
    }
    socket = ws;
    ws.on('open', () => {
      if (ws !== socket) return;
      link.connected = true;
      link.lastSeen = now();
      delay = backoff.min;
      log('peer.open', { url: shownUrl, attempts: link.attempts });
      send({ type: 'hello', peer: { name: me } });
      onOpen(link);
    });
    ws.on('message', (raw, isBinary) => {
      if (ws !== socket || isBinary) return;
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!frame || typeof frame.type !== 'string') return;
      link.lastSeen = now();
      if (frame.type === 'hello') {
        link.name = cleanName(frame.peer?.name) || link.name;
        return;
      }
      onFrame(frame, link);
    });
    const drop = (reason) => (detail) => {
      if (ws !== socket) return;
      socket = null;
      link.connected = false;
      log('peer.close', {
        url: shownUrl,
        reason,
        detail: detail?.message ?? (typeof detail === 'number' ? detail : null),
      });
      schedule();
    };
    ws.on('close', drop('close'));
    ws.on('error', drop('error'));
  }

  function send(frame) {
    if (!socket || (socket.readyState ?? OPEN) !== (socket.OPEN ?? OPEN))
      return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  return Object.assign(link, {
    connect,
    send,
    close() {
      closed = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      const ws = socket;
      socket = null;
      link.connected = false;
      try {
        ws?.close();
      } catch {
        /* already gone */
      }
    },
    status() {
      return {
        name: link.name || label,
        url: shownUrl,
        connected: link.connected,
        lastSeen: link.lastSeen,
      };
    },
    /** Next reconnect wait in ms (tests). */
    nextDelay() {
      return delay;
    },
  });
}

/**
 * All peer links of this instance plus the forwarding rules between them and
 * the local hub. `hub` is the shared remote hub (remote.js); its `name` is set
 * so hello replies and published envelopes identify this instance.
 */
export function createPeerFederation({
  peers = [],
  name = peerName(),
  hub = null,
  WebSocketImpl,
  log = () => {},
  timers,
  now,
  backoff,
}) {
  if (hub) hub.name = name;
  const links = peers.map((peer) =>
    createPeerLink({
      ...peer,
      me: name,
      WebSocketImpl,
      log,
      timers,
      now,
      backoff,
      onFrame: (frame, link) => federation.handlePeerFrame(frame, link),
    }),
  );

  const originOf = (envelope, link) =>
    cleanName(envelope.peer) || link?.name || link?.label || 'peer';

  const federation = {
    name,
    links,
    start() {
      for (const link of links) link.connect();
      return federation;
    },
    close() {
      for (const link of links) link.close();
    },
    status() {
      return links.map((link) => link.status());
    },
    /**
     * A frame from a peer hub. Only `session` envelopes carrying a `notice`
     * or `peer_place` without an origin are acted on; returns what was done
     * or null when the frame was ignored.
     */
    handlePeerFrame(envelope, link = null) {
      if (!envelope || envelope.type !== 'session') return null;
      const frame = envelope.frame;
      if (!frame || typeof frame.type !== 'string') return null;
      // Already travelled one hop (ours or a third peer's): never re-forward.
      if (frame.origin) return null;
      const origin = originOf(envelope, link);
      const target = hub?.activeSession ?? null;
      if (frame.type === 'notice') {
        const body = String(frame.text || '').trim();
        if (!body) return null;
        const text = `From ${origin}: ${body}`.slice(0, MAX_NOTICE_CHARS);
        if (typeof target?.handlers?.notify === 'function') {
          // speakNotice publishes the spoken notice (tagged origin) to the
          // local remotes itself, so no direct publish here.
          log('peer.notice', { origin, text, spoken: true });
          target.handlers.notify(text, { origin });
          return { type: 'notice', origin, text, spoken: true };
        }
        const delivered = hub?.publish(null, { type: 'notice', text, origin });
        log('peer.notice', { origin, text, spoken: false, delivered });
        return { type: 'notice', origin, text, spoken: false };
      }
      if (frame.type === 'peer_place') {
        const place = sanitizePlace(frame.place);
        if (!place) return null;
        const tagged = { type: 'peer_place', place, origin };
        log('peer.place', { origin, name: place.name });
        hub?.publish(target?.id ?? null, tagged);
        target?.handlers?.deliver?.(tagged);
        return { type: 'peer_place', origin, place };
      }
      return null;
    },
    /** Send one saved place to every connected peer hub. */
    sharePlace(place) {
      const clean = sanitizePlace(place);
      if (!clean)
        return { ok: false, error: 'A place needs a name, lat and lon' };
      const frame = { type: 'peer_place', place: clean, origin: name };
      const sent = links
        .filter((link) => link.send(frame))
        .map((link) => link.status().name);
      log('peer.share_place', { name: clean.name, sent });
      return { ok: true, place: clean, sent, peers: links.length };
    },
  };
  return federation;
}
