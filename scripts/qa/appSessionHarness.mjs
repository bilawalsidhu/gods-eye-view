// Shared setup for the application-session switch gates
// (scripts/qa-app-once.mjs, scripts/qa-voice-engine-switch.mjs): a headless
// page on a keyless local preview, with every paid map, model and voice
// endpoint blocked, a fake microphone and Realtime transport, and readers for
// the session ids, listener counts and transport counters.
import puppeteer from 'puppeteer';
import { SESSION_BLOCKED_URLS } from '../qa-map-policy.mjs';
import { CHROME_ARGS, waitForEngine } from '../qa-strict-harness.mjs';

/** The page address: Boston on OSM, no welcome, on the given engine. */
export function sessionAddress(base, { engine = 'cesium', extra = {} } = {}) {
  const url = new URL(base.href);
  url.pathname = '/';
  url.search = new URLSearchParams({
    welcome: '0',
    look: 'cinematic',
    engine,
    ...extra,
  }).toString();
  url.hash =
    'v=2&lat=42.3554&lon=-71.0605&alt=6000&heading=0&pitch=-90&map=osm&l=e';
  return url.href;
}

export function launch() {
  return puppeteer.launch({
    headless: true,
    args: [
      ...CHROME_ARGS,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
}

// Installed before any page script: counts microphone requests and
// transports, and replaces the Realtime peer connection with a local fake
// whose data channel records what the client sends and lets the script play
// the server's events. No request reaches a model.
function installFakeVoice() {
  const evidence = {
    getUserMedia: 0,
    peerConnections: 0,
    peerConnectionsClosed: 0,
    channelsClosed: 0,
    webSockets: 0,
    webSocketsClosed: 0,
    tokenRequests: 0,
    sent: [],
    channel: null,
  };
  window.__qaVoice = evidence;
  localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
  const media = navigator.mediaDevices;
  if (media?.getUserMedia) {
    const getUserMedia = media.getUserMedia.bind(media);
    media.getUserMedia = (constraints) => {
      evidence.getUserMedia += 1;
      return getUserMedia(constraints);
    };
  }
  class FakeChannel extends EventTarget {
    constructor(label) {
      super();
      this.label = label;
      this.readyState = 'connecting';
      this.bufferedAmount = 0;
      this.id = 1;
    }
    send(data) {
      if (this.readyState !== 'open') throw new Error('Channel not open');
      try {
        evidence.sent.push(JSON.parse(data));
      } catch {
        evidence.sent.push(data);
      }
    }
    close() {
      if (this.readyState === 'closed') return;
      this.readyState = 'closed';
      evidence.channelsClosed += 1;
      this.dispatchEvent(new Event('close'));
    }
  }
  class FakePeerConnection extends EventTarget {
    constructor() {
      super();
      evidence.peerConnections += 1;
      this.connectionState = 'new';
      this.iceConnectionState = 'new';
      this.iceGatheringState = 'complete';
      this.signalingState = 'stable';
      this.channels = [];
    }
    addTrack() {
      return {};
    }
    getSenders() {
      return [];
    }
    getReceivers() {
      return [];
    }
    getTransceivers() {
      return [];
    }
    createDataChannel(label) {
      const channel = new FakeChannel(label);
      this.channels.push(channel);
      evidence.channel = channel;
      return channel;
    }
    async createOffer() {
      return { type: 'offer', sdp: 'v=0\r\n' };
    }
    async setLocalDescription(description) {
      this.localDescription = description;
    }
    async setRemoteDescription(description) {
      this.remoteDescription = description;
      setTimeout(() => {
        if (this.connectionState === 'closed') return;
        this.connectionState = 'connected';
        this.iceConnectionState = 'connected';
        this.onconnectionstatechange?.();
        this.oniceconnectionstatechange?.();
        for (const channel of this.channels) {
          channel.readyState = 'open';
          channel.dispatchEvent(new Event('open'));
        }
      }, 0);
    }
    async getStats() {
      return new Map();
    }
    close() {
      if (this.connectionState === 'closed') return;
      this.connectionState = 'closed';
      evidence.peerConnectionsClosed += 1;
      for (const channel of this.channels) channel.close();
    }
  }
  window.RTCPeerConnection = FakePeerConnection;
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      evidence.webSockets += 1;
      this.addEventListener('close', () => {
        evidence.webSocketsClosed += 1;
      });
    }
  };
  const fetch = window.fetch.bind(window);
  window.fetch = (input, options) => {
    const url = new URL(input?.url ?? input, document.baseURI);
    if (url.pathname === '/api/realtime/token') {
      evidence.tokenRequests += 1;
      return Promise.resolve(
        Response.json({
          value: 'qa-local-token',
          expires_at: Math.floor(Date.now() / 1000) + 600,
        }),
      );
    }
    if (url.hostname === 'api.openai.com')
      return Promise.resolve(
        new Response('v=0\r\n', {
          status: 201,
          headers: { 'Content-Type': 'application/sdp' },
        }),
      );
    if (url.pathname.startsWith('/api/openai/'))
      return Promise.resolve(
        Response.json({ error: 'blocked in QA' }, { status: 503 }),
      );
    // Empty feeds keep the gate offline and quick.
    const fixtures = {
      '/api/flights': () => ({ time: Date.now() / 1000, states: [] }),
      '/api/military': () => ({ now: Date.now(), ac: [] }),
      '/api/military-installations': () => ({ elements: [], status: 'ok' }),
      '/api/vessels': () => ({ status: 'live', rows: [] }),
    };
    const fixture = fixtures[url.pathname];
    return fixture
      ? Promise.resolve(Response.json(fixture()))
      : fetch(input, options);
  };
}

/** A page with the paid endpoints blocked and the voice transport faked. */
export async function openSessionPage(browser, address) {
  const page = await browser.newPage();
  await browser
    .defaultBrowserContext()
    .overridePermissions(new URL(address).origin, ['microphone']);
  const network = await page.createCDPSession();
  await network.send('Network.enable');
  await network.send('Network.setBlockedURLs', { urls: [...SESSION_BLOCKED_URLS] });
  await page.evaluateOnNewDocument(installFakeVoice);
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(address, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  return { page, errors };
}

/**
 * Pick an engine the way the picker does, without moving focus to it, so a
 * focused field keeps its focus through the switch.
 */
export function requestEngine(page, kind) {
  return page.evaluate((kind) => {
    const select = document.querySelector('#globe-engine');
    select.value = kind;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, kind);
}

export async function switchEngine(page, kind) {
  await requestEngine(page, kind);
  await waitForEngine(page, kind, { timeout: 90_000 });
}

/** Session object ids and counters (src/app/sessionDiagnostics.js). */
export function readSession(page) {
  return page.evaluate(() => ({
    ids: window.__gevSession?.ids ?? null,
    counters: window.__gevSession?.counters ?? null,
  }));
}

/**
 * Live listeners on window and document, counted per event type. With
 * `bySource`, each key also names the script that added the listener (its
 * file name), so a listener held by the parked renderer can be told apart
 * from one the session leaked.
 */
export async function listenerCounts(page, { bySource = false } = {}) {
  const client = await page.createCDPSession();
  try {
    const scripts = new Map();
    if (bySource) {
      client.on('Debugger.scriptParsed', ({ scriptId, url }) =>
        scripts.set(scriptId, url),
      );
      await client.send('Debugger.enable');
    }
    const counts = {};
    for (const name of ['window', 'document']) {
      const { result } = await client.send('Runtime.evaluate', {
        expression: name,
      });
      const { listeners } = await client.send('DOMDebugger.getEventListeners', {
        objectId: result.objectId,
      });
      for (const listener of listeners) {
        const source = bySource
          ? `@${(scripts.get(listener.scriptId) ?? '')
              .split('/')
              .pop()
              .replace(/-[\w-]{8}\.js$/, '.js')}`
          : '';
        const key = `${name}:${listener.type}${source}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      await client.send('Runtime.releaseObject', {
        objectId: result.objectId,
      });
    }
    if (bySource) await client.send('Debugger.disable');
    return counts;
  } finally {
    await client.detach();
  }
}

/** Keys whose counts differ between two listener snapshots. */
export function listenerDifference(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Object.fromEntries(
    [...keys]
      .filter((key) => (before[key] ?? 0) !== (after[key] ?? 0))
      .map((key) => [
        key,
        { before: before[key] ?? 0, after: after[key] ?? 0 },
      ]),
  );
}

/** Ids that differ between two session snapshots. */
export function idDifference(before, after) {
  return Object.fromEntries(
    Object.keys({ ...before, ...after })
      .filter((key) => before?.[key] !== after?.[key])
      .map((key) => [key, { before: before?.[key], after: after?.[key] }]),
  );
}

/** Transport counters of the fake voice transport. */
export function readVoiceEvidence(page) {
  return page.evaluate(() => {
    const { sent, channel, ...counts } = window.__qaVoice;
    return {
      ...counts,
      channelState: channel?.readyState ?? null,
      sentCount: sent.length,
    };
  });
}
