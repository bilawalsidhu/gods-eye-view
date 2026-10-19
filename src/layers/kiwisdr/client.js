import { msg } from '../../i18n/marker.js';
import {
  AUDIO_RATE,
  FULL_BANDWIDTH_KHZ,
  MAX_ZOOM,
  clampFrequencyKhz,
  commands,
  createAdpcmDecoder,
  decodePcm16,
  defaultModeFor,
  fatalReason,
  parseFrame,
  waterfallCenterKhz,
} from './protocol.js';

const KEEPALIVE_MS = 5000;
const OPEN_TIMEOUT_MS = 10_000;
const STALL_MS = 15_000;
// Receivers announce readiness with `sample_rate` (audio) and `wf_setup`
// (waterfall). If firmware never does, start anyway after this long.
const SETUP_FALLBACK_MS = 3000;

const KIWI_DEFAULT_PORT = 8073;

/**
 * Ports worth trying, best first. The directory lists many receivers behind
 * kiwisdr.com's own proxy (`*.proxy.kiwisdr.com`) as plain port 80, but that
 * port only answers a websocket handshake with a 307 redirect to :8073, and
 * browsers refuse to follow redirects on a websocket. So those hosts, and any
 * receiver listed on a bare http port, go to 8073 directly.
 */
export function kiwiPorts(station) {
  return kiwiEndpoints(station).map((e) => e.port);
}

/**
 * Where to try connecting, best first. Some proxied receivers live on a
 * secondary frp server (`NAME.proxy2.kiwisdr.com`, which in turn only
 * accepts websockets on :8073): the primary answers them with a 307 to it,
 * which a websocket cannot follow, so we go there ourselves when the primary
 * does not accept the connection.
 */
export function kiwiEndpoints(station) {
  const bare = !station.secure && station.port === 80;
  const proxy = /^(.+)\.proxy\.kiwisdr\.com$/i.exec(station.host);
  if (proxy && bare)
    return [
      { host: station.host, port: KIWI_DEFAULT_PORT },
      { host: `${proxy[1]}.proxy2.kiwisdr.com`, port: KIWI_DEFAULT_PORT },
    ];
  const base = { host: station.host, port: station.port };
  return bare
    ? [base, { host: station.host, port: KIWI_DEFAULT_PORT }]
    : [base];
}

/** Websocket URL for one stream; `legacy` drops the `/kiwi` prefix older firmware used. */
export function kiwiSocketUrl(
  station,
  stream,
  stamp,
  legacy = false,
  port = station.port,
  host = station.host,
) {
  const scheme = station.secure ? 'wss' : 'ws';
  const prefix = legacy ? '' : '/kiwi';
  const shown = port === 80 && !station.secure ? host : `${host}:${port}`;
  return `${scheme}://${shown}${prefix}/${stamp}/${stream}`;
}

/**
 * One listening session on one receiver: an audio socket and a waterfall
 * socket sharing a tuning state. All I/O is injected so the protocol can be
 * driven by a fake socket in tests.
 *
 * Events (via `on`): `state`, `audio`, `smeter`, `waterfall`, `error`, `view`,
 * `tuning`, `waterfallLost`, `diag` (why a socket closed).
 */
export function createKiwiSession({
  station,
  WebSocketImpl = globalThis.WebSocket,
  now = () => Date.now(),
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (id) => clearInterval(id),
  setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutImpl = (id) => clearTimeout(id),
  audioOutRate = 44_100,
  identity = 'GodsEyeView',
  startKhz = 10_000,
} = {}) {
  if (!station?.host) throw new TypeError('A receiver is required');
  if (typeof WebSocketImpl !== 'function')
    throw new TypeError('WebSocket is not available');
  const handlers = new Map();
  const emit = (name, payload) => {
    for (const fn of handlers.get(name) || []) {
      try {
        fn(payload);
      } catch (error) {
        console.warn('[KiwiSDR] listener failed', error);
      }
    }
  };

  const tuning = {
    freqKhz: clampFrequencyKhz(startKhz, station.lowHz, station.highHz),
    mode: defaultModeFor(startKhz),
  };
  const view = {
    zoom: 0,
    centerKhz: FULL_BANDWIDTH_KHZ / 2,
    fullKhz: FULL_BANDWIDTH_KHZ,
  };
  let state = 'idle';
  let closed = false;
  let fatal = null;
  let adpcm = null;
  let warnedCompressed = false;
  let modePinned = false;
  let lastAudioAt = 0;
  let lastTickAt = 0;
  let keepalive = null;
  let inRate = AUDIO_RATE;
  let rateAcked = false;
  const ready = { snd: false, wf: false };
  const setupTimers = { snd: null, wf: null };
  const streams = { snd: null, wf: null };

  const setState = (next, detail = null) => {
    if (closed && next !== 'closed') return;
    state = next;
    emit('state', { state, detail });
  };

  function fail(message) {
    if (fatal) return;
    fatal = message;
    emit('error', { message });
    close('error', message);
  }

  function send(stream, text) {
    const entry = streams[stream];
    if (entry?.socket?.readyState === 1) entry.socket.send(text);
  }

  function sendTuning() {
    if (ready.snd) send('snd', commands.tune(tuning));
  }
  function sendView() {
    if (ready.wf)
      send(
        'wf',
        commands.waterfallView({ zoom: view.zoom, centerKhz: view.centerKhz }),
      );
    emit('view', { ...view });
  }

  function ackAudioRate(rate) {
    if (rateAcked) return;
    rateAcked = true;
    if (Number.isFinite(rate) && rate > 0) inRate = rate;
    send('snd', commands.audioRate(inRate, audioOutRate));
  }

  /** The reference client only sends these once the receiver says it is ready. */
  function beginSound() {
    if (ready.snd || closed) return;
    ready.snd = true;
    clearTimeoutImpl(setupTimers.snd);
    ackAudioRate(inRate);
    send('snd', commands.noCompression());
    send('snd', commands.squelchOff());
    send('snd', commands.agc());
    sendTuning();
    send('snd', commands.keepalive());
  }
  function beginWaterfall() {
    if (ready.wf || closed) return;
    ready.wf = true;
    clearTimeoutImpl(setupTimers.wf);
    send('wf', commands.waterfallNoCompression());
    send('wf', commands.waterfallRange());
    send('wf', commands.waterfallSpeed(2));
    sendView();
    send('wf', commands.keepalive());
  }

  function onSoundOpen() {
    send('snd', commands.auth());
    send('snd', commands.ident(identity));
    setupTimers.snd = setTimeoutImpl(beginSound, SETUP_FALLBACK_MS);
  }
  function onWaterfallOpen() {
    send('wf', commands.auth());
    send('wf', commands.ident(identity));
    setupTimers.wf = setTimeoutImpl(beginWaterfall, SETUP_FALLBACK_MS);
  }

  function onMessage(stream, event) {
    const data = event.data;
    if (typeof data === 'string') return;
    const frame = parseFrame(data);
    if (frame.kind === 'msg') {
      const reason = fatalReason(frame.fields);
      if (reason) return fail(reason);
      if (stream === 'wf') {
        const bw = Number(frame.fields.bandwidth);
        if (Number.isFinite(bw) && bw >= 1_000_000 && bw <= 40_000_000) {
          view.fullKhz = bw / 1000;
          view.centerKhz = waterfallCenterKhz(
            view.zoom ? view.centerKhz : view.fullKhz / 2,
            view.zoom,
            view.fullKhz,
          );
          emit('view', { ...view });
        }
      }
      if (stream === 'snd') {
        if ('audio_rate' in frame.fields)
          ackAudioRate(Number(frame.fields.audio_rate));
        if ('sample_rate' in frame.fields) beginSound();
      } else if ('wf_setup' in frame.fields) {
        beginWaterfall();
      }
      return;
    }
    if (frame.kind === 'snd') {
      lastAudioAt = now();
      if (state !== 'live') setState('live');
      let samples;
      if (frame.compressed) {
        if (!warnedCompressed) {
          warnedCompressed = true;
          console.warn(
            '[KiwiSDR] receiver sent ADPCM audio; decoding best-effort',
          );
        }
        adpcm ||= createAdpcmDecoder();
        samples = adpcm.decode(frame.data);
      } else {
        samples = decodePcm16(frame.data, frame.littleEndian);
      }
      if (frame.stereo) {
        // IQ framing: keep only I so the player stays mono.
        const mono = new Float32Array(samples.length >> 1);
        for (let i = 0; i < mono.length; i++) mono[i] = samples[i * 2];
        samples = mono;
      }
      emit('smeter', { dbm: frame.dbm });
      emit('audio', { samples, rate: inRate });
      return;
    }
    if (frame.kind === 'wf') {
      emit('waterfall', { bins: frame.bins, view: { ...view } });
    }
  }

  /** Audio is the point of a session; a dead waterfall only costs the picture. */
  function streamFailed(stream, message) {
    if (stream === 'wf') {
      streams.wf = null;
      emit('waterfallLost', { message });
      return;
    }
    fail(message);
  }

  /** Open one stream, retrying other ports and the legacy path if it dies before opening. */
  function openStream(stream, name, onOpen, stamp) {
    const tries = kiwiEndpoints(station).flatMap(({ host, port }) => [
      { host, port, legacy: false },
      { host, port, legacy: true },
    ]);
    const attempt = (index) => {
      const { host, port, legacy } = tries[index];
      const last = index === tries.length - 1;
      let opened = false;
      const startedAt = now();
      const socket = new WebSocketImpl(
        kiwiSocketUrl(station, name, stamp, legacy, port, host),
      );
      socket.binaryType = 'arraybuffer';
      const entry = { socket, timer: null };
      streams[stream] = entry;
      entry.timer = setTimeoutImpl(() => {
        if (!opened && !closed) {
          try {
            socket.close();
          } catch {
            /* already closing */
          }
          if (!last) attempt(index + 1);
          else streamFailed(stream, msg('The receiver did not answer.'));
        }
      }, OPEN_TIMEOUT_MS);
      socket.onopen = () => {
        opened = true;
        clearTimeoutImpl(entry.timer);
        onOpen();
      };
      socket.onmessage = (event) => {
        if (streams[stream] === entry) onMessage(stream, event);
      };
      socket.onerror = () => {};
      socket.onclose = (event) => {
        clearTimeoutImpl(entry.timer);
        if (streams[stream] !== entry || closed) return;
        // Browsers give no reason for a refused connection (code 1006), but the
        // code, timing and which path was tried still tell a blocked socket
        // from a full or password-protected receiver.
        emit('diag', {
          stream: name,
          host,
          port,
          legacy,
          opened,
          code: event?.code ?? 0,
          reason: String(event?.reason ?? '').slice(0, 120),
          elapsedMs: now() - startedAt,
        });
        if (!opened && !last) return attempt(index + 1);
        streamFailed(
          stream,
          opened
            ? msg('The receiver closed the connection.')
            : msg('Could not connect to the receiver.'),
        );
      };
    };
    attempt(0);
  }

  const session = {
    station,
    get state() {
      return state;
    },
    get tuning() {
      return { ...tuning };
    },
    get view() {
      return { ...view };
    },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name)?.delete(fn);
    },
    start() {
      if (closed || state !== 'idle') return;
      setState('connecting');
      // One shared stamp: the receiver pairs the audio and waterfall sockets
      // of a listener by it. Different stamps look like two clients, which
      // trips "one connection per IP" limits and gets the audio socket
      // dropped.
      const stamp = now();
      openStream('snd', 'SND', onSoundOpen, stamp);
      openStream('wf', 'W/F', onWaterfallOpen, stamp);
      lastTickAt = now();
      keepalive = setTimer(() => {
        const t = now();
        const lateBy = t - lastTickAt - KEEPALIVE_MS;
        lastTickAt = t;
        send('snd', commands.keepalive());
        send('wf', commands.keepalive());
        // A tick this late means the page itself was starved (a busy main
        // thread, a throttled tab): audio frames may be sitting unread in the
        // socket queue, so say nothing about the receiver and start counting
        // again from here.
        if (lateBy > KEEPALIVE_MS) {
          lastAudioAt = t;
          return;
        }
        if (state === 'live' && t - lastAudioAt > STALL_MS)
          fail(msg('The receiver stopped sending audio.'));
      }, KEEPALIVE_MS);
    },
    tune({ freqKhz, mode } = {}) {
      if (freqKhz !== undefined)
        tuning.freqKhz = clampFrequencyKhz(
          freqKhz,
          station.lowHz,
          station.highHz,
        );
      if (mode !== undefined) tuning.mode = mode;
      else if (freqKhz !== undefined && !modePinned)
        tuning.mode = defaultModeFor(tuning.freqKhz);
      if (mode !== undefined) modePinned = true;
      sendTuning();
      // Keep a zoomed waterfall following the tuned frequency off its edge.
      if (view.zoom > 0) {
        const half = view.fullKhz / 2 ** view.zoom / 2;
        if (Math.abs(tuning.freqKhz - view.centerKhz) > half * 0.9) {
          view.centerKhz = waterfallCenterKhz(
            tuning.freqKhz,
            view.zoom,
            view.fullKhz,
          );
          sendView();
        }
      }
      emit('tuning', { ...tuning });
    },
    setZoom(zoom, centerKhz = tuning.freqKhz) {
      view.zoom = Math.min(MAX_ZOOM, Math.max(0, Math.round(zoom)));
      view.centerKhz = waterfallCenterKhz(
        view.zoom === 0 ? view.fullKhz / 2 : centerKhz,
        view.zoom,
        view.fullKhz,
      );
      sendView();
    },
    close(reason = 'closed') {
      close('closed', reason);
    },
  };

  function close(nextState, detail) {
    if (closed) return;
    closed = true;
    if (keepalive !== null) clearTimer(keepalive);
    for (const key of ['snd', 'wf']) {
      const entry = streams[key];
      streams[key] = null;
      if (!entry) continue;
      clearTimeoutImpl(entry.timer);
      clearTimeoutImpl(setupTimers[key]);
      entry.socket.onclose = null;
      entry.socket.onmessage = null;
      try {
        entry.socket.close();
      } catch {
        /* already closed */
      }
    }
    state = nextState;
    emit('state', { state: nextState, detail });
    handlers.clear();
  }

  return session;
}
