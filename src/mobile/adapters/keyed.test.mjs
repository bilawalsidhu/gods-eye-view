import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlightsDirectSource } from './flightsDirect.js';
import { createVesselsLiveSource } from './vesselsLive.js';
import {
  createVoiceBackend,
  requestVoiceSession,
} from './voiceDirect.js';
import {
  createGooglePlacesDirect,
  createHudSummaryDirect,
  createTomtomDirectSource,
} from './meteredDirect.js';

/** Wrap a payload in a real Response so adapter body readers stay honest. */
function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Registry refusal, mirroring nativeFetch's `{ code }` contract. */
function refusalError() {
  return Object.assign(new Error('Upstream not allowed for host "x": test'), {
    code: 'UPSTREAM_NOT_ALLOWED',
  });
}

/**
 * Record calls with the Authorization header redacted to presence-only, so
 * no test artifact can ever carry a vault value.
 */
function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    calls.push({
      url: String(url),
      method: init.method || 'GET',
      auth: headers.get('authorization') ? 'PRESENT-REDACTED' : null,
      apiKeyHeader: headers.get('x-goog-api-key') ? 'PRESENT-REDACTED' : null,
    });
    return handler(String(url), init, calls);
  };
  return { calls, fetchImpl };
}

/** Assert no recorded artifact contains the fake vault secret. */
function assertNoSecretLeak(seen, secret = 'vault-secret') {
  assert.ok(
    !JSON.stringify(seen).includes(secret),
    'recorded traffic must never carry the vault value',
  );
}

/**
 * Abort-then-resolve: the adapter must discard the late body and surface the
 * abort, because CapacitorHttp cannot cancel in flight.
 */
async function assertDiscardsLateResponse(invoke) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fetchImpl = async () => {
    await gate;
    return jsonResponse({ unexpected: true });
  };
  const controller = new AbortController();
  const pending = invoke(fetchImpl, controller.signal);
  controller.abort();
  release();
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
}

const OPENSKY_STATES_FIXTURE = {
  time: 1_790_000_000,
  states: [
    ['abc123', 'UAL123 ', null, 1, 2, -122.4, 37.7, 10668, false, 230, 270, 0, null, 10972, '1234', false, 0, 4],
  ],
};

const ADSB_LOL_FIXTURE = {
  now: 1_790_000_000,
  ac: [
    {
      hex: 'abc123',
      flight: 'UAL123 ',
      lat: 37.7,
      lon: -122.4,
      seen_pos: 1,
      seen: 2,
      alt_baro: 35000,
      gs: 450,
      track: 270,
    },
  ],
};

// ---------------------------------------------------------------------------
// flightsDirect
// ---------------------------------------------------------------------------

test('flights direct fetches anonymously when the vault holds no creds', async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    jsonResponse(OPENSKY_STATES_FIXTURE, 200, {
      'X-Rate-Limit-Remaining': '2000',
    }),
  );
  const source = createFlightsDirectSource({
    fetchImpl,
    getClientId: async () => null,
    getClientSecret: async () => null,
  });
  const snapshot = await source.getStates({});
  assert.equal(snapshot.source, 'opensky');
  assert.equal(snapshot.states.length, 1);
  assert.match(calls[0].url, /^https:\/\/opensky-network\.org\/api\/states\/all/);
  assert.equal(calls[0].auth, null);
  assertNoSecretLeak(calls);
});

test('flights direct mints an OAuth token and retries after an anon 401', async () => {
  const tokenRequests = [];
  const { calls, fetchImpl } = stubFetch((url, init) => {
    if (url.includes('openid-connect/token')) {
      const params = new URLSearchParams(init.body);
      tokenRequests.push({
        grantType: params.get('grant_type'),
        hasSecret: params.has('client_secret'),
      });
      return jsonResponse({ access_token: 'ephemeral', expires_in: 1800 });
    }
    if (!init.headers?.Authorization && !new Headers(init.headers || {}).get('authorization')) {
      return jsonResponse({ error: 'auth required' }, 401);
    }
    return jsonResponse(OPENSKY_STATES_FIXTURE);
  });
  const source = createFlightsDirectSource({
    fetchImpl,
    getClientId: async () => 'vault-id',
    getClientSecret: async () => 'vault-secret',
  });
  const snapshot = await source.getStates({});
  assert.equal(snapshot.source, 'opensky');
  assert.deepEqual(tokenRequests, [{ grantType: 'client_credentials', hasSecret: true }]);
  assert.equal(calls.at(-1).auth, 'PRESENT-REDACTED');
  assertNoSecretLeak([...calls, ...tokenRequests]);
});

test('flights direct falls back to adsb.lol on stale snapshots and outages', async () => {
  const stale = { time: 1_790_000_000 - 600, states: [] };
  const outageFetch = stubFetch((url) => {
    if (url.includes('adsb.lol')) return jsonResponse(ADSB_LOL_FIXTURE);
    return jsonResponse(stale);
  });
  const staleSource = createFlightsDirectSource({
    fetchImpl: outageFetch.fetchImpl,
    getClientId: async () => null,
    getClientSecret: async () => null,
    now: () => 1_790_000_000_000,
  });
  const staleSnapshot = await staleSource.getStates({ lat: 37.7, lon: -122.4 });
  assert.equal(staleSnapshot.source, 'adsb.lol');
  assert.equal(staleSnapshot.states.length, 1);
  assert.ok(outageFetch.calls.some((call) => call.url.includes('api.adsb.lol')));

  const failingSource = createFlightsDirectSource({
    fetchImpl: stubFetch(() => {
      throw new Error('offline');
    }).fetchImpl,
    getClientId: async () => null,
    getClientSecret: async () => null,
  });
  await assert.rejects(failingSource.getStates({}), /offline/);
});

test('flights direct reports registry refusal honestly and feeds the governor', async () => {
  const remaining = [];
  const governor = {
    reportRemaining: async (value) => {
      remaining.push(value);
    },
  };
  const source = createFlightsDirectSource({
    fetchImpl: stubFetch(() => {
      throw refusalError();
    }).fetchImpl,
    getClientId: async () => null,
    getClientSecret: async () => null,
    governor,
  });
  await assert.rejects(source.getStates({}), (error) => {
    assert.equal(error.code, 'UPSTREAM_NOT_ALLOWED');
    return true;
  });

  const { fetchImpl } = stubFetch(() =>
    jsonResponse(OPENSKY_STATES_FIXTURE, 200, {
      'X-Rate-Limit-Remaining': '120',
    }),
  );
  const governed = createFlightsDirectSource({
    fetchImpl,
    getClientId: async () => null,
    getClientSecret: async () => null,
    governor,
  });
  await governed.getStates({});
  assert.deepEqual(remaining, [120]);
});

test('flights direct refuses a keyed URL over plain http without fetching', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse(OPENSKY_STATES_FIXTURE));
  const source = createFlightsDirectSource({
    fetchImpl,
    getClientId: async () => 'vault-id',
    getClientSecret: async () => 'vault-secret',
    statesUrl: 'http://opensky-network.org/api/states/all?extended=1',
  });
  await assert.rejects(source.getStates({}), (error) => {
    assert.equal(error.code, 'KEYED_HTTP_REFUSED');
    return true;
  });
  assert.equal(calls.length, 0);
});

test('flights direct discards a late response after abort', async () => {
  await assertDiscardsLateResponse((fetchImpl, signal) =>
    createFlightsDirectSource({
      fetchImpl,
      getClientId: async () => null,
      getClientSecret: async () => null,
    }).getStates({ signal }),
  );
});

// ---------------------------------------------------------------------------
// vesselsLive
// ---------------------------------------------------------------------------

/** Emitter-style socket stub (ws semantics the adapter also accepts). */
function stubSocketHost() {
  const sockets = [];
  const createSocket = (url) => {
    const socket = {
      url: String(url),
      sent: [],
      closed: false,
      handlers: new Map(),
      on(event, handler) {
        const list = socket.handlers.get(event) || [];
        list.push(handler);
        socket.handlers.set(event, list);
        return socket;
      },
      send(text) {
        socket.sent.push(String(text));
      },
      close() {
        socket.closed = true;
      },
      emit(event, ...args) {
        for (const handler of socket.handlers.get(event) || []) handler(...args);
      },
    };
    sockets.push(socket);
    return socket;
  };
  return { sockets, createSocket };
}

function aisEnvelope(mmsi, lat, lon) {
  return JSON.stringify({
    MessageType: 'PositionReport',
    Message: { PositionReport: { UserID: mmsi, Latitude: lat, Longitude: lon } },
    MetaData: { MMSI: mmsi },
  });
}

/** Redact the subscribed API key out of recorded socket traffic. */
function redactedSent(socket) {
  return socket.sent.map((text) => text.replace(/"APIKey":"[^"]*"/, '"APIKey":"[REDACTED]"'));
}

test('vessels live stays offline without a key (no socket, honest marker)', async () => {
  const host = stubSocketHost();
  const source = createVesselsLiveSource({
    getKey: async () => null,
    createSocket: host.createSocket,
  });
  assert.deepEqual(await source.connect(), { unavailable: 'KEY_REQUIRED' });
  assert.equal(host.sockets.length, 0);
});

test('vessels live subscribes with the vault key and tracks 64-sample rings', async () => {
  const host = stubSocketHost();
  const seen = [];
  const source = createVesselsLiveSource({
    getKey: async () => 'vault-secret',
    createSocket: host.createSocket,
    onVessel: (vessel) => seen.push(vessel.mmsi),
  });
  await source.connect();
  assert.equal(host.sockets.length, 1);
  assert.match(host.sockets[0].url, /^wss:\/\//);
  host.sockets[0].emit('open');
  const logged = redactedSent(host.sockets[0]);
  assert.equal(host.sockets[0].sent.length, 1);
  assert.match(logged[0], /"APIKey":"\[REDACTED\]"/);
  assertNoSecretLeak(logged);
  host.sockets[0].emit('message', aisEnvelope('123456789', 37.7, -122.4));
  assert.deepEqual(seen, ['123456789']);
  assert.equal(source.snapshot().status, 'live');
  assert.equal(source.getTrack('123456789').length, 1);
  for (let index = 0; index < 70; index += 1) {
    host.sockets[0].emit('message', aisEnvelope('123456789', 37.7, -122.4));
  }
  assert.equal(source.getTrack('123456789').length, 64);
  source.dispose();
});

test('vessels live recycles a silent socket after 120s (5s-5min backoff)', async () => {
  let nowMs = 1_790_000_000_000;
  const host = stubSocketHost();
  const source = createVesselsLiveSource({
    getKey: async () => 'vault-secret',
    createSocket: host.createSocket,
    clock: () => nowMs,
  });
  await source.connect();
  host.sockets[0].emit('open');
  host.sockets[0].emit('message', aisEnvelope('1', 0, 0));
  assert.equal(source.snapshot().status, 'live');
  nowMs += 119_000;
  source.tick();
  assert.equal(host.sockets.length, 1);
  assert.equal(host.sockets[0].closed, false);
  nowMs += 2_000;
  source.tick();
  assert.equal(host.sockets[0].closed, true, 'silence past 120s closes the socket');
  assert.equal(host.sockets.length, 1, 'reconnect waits out the backoff');
  const firstDelay = source.snapshot().nextAttemptInMs;
  assert.ok(firstDelay > 4_000 && firstDelay <= 5_000, `first backoff ~5s, got ${firstDelay}`);
  nowMs += 5_000;
  source.tick();
  assert.equal(host.sockets.length, 2, 'backoff expiry reconnects');
  source.dispose();
});

test('vessels live refuses a keyed socket URL over plain ws', async () => {
  const host = stubSocketHost();
  const source = createVesselsLiveSource({
    getKey: async () => 'vault-secret',
    createSocket: host.createSocket,
    url: 'ws://stream.aisstream.io/v0/stream',
  });
  await assert.rejects(source.connect(), (error) => {
    assert.equal(error.code, 'KEYED_HTTP_REFUSED');
    return true;
  });
  assert.equal(host.sockets.length, 0);
});

// ---------------------------------------------------------------------------
// voiceDirect
// ---------------------------------------------------------------------------

test('voice token request posts client_secrets with the vault key (redacted)', async () => {
  let bodyModel = null;
  const { calls, fetchImpl } = stubFetch((url, init) => {
    bodyModel = JSON.parse(init.body).session?.model;
    return jsonResponse({ value: 'ephemeral-secret', expires_at: 1_800_000_000 });
  });
  const backend = createVoiceBackend({
    getKey: async () => 'vault-secret',
    fetchImpl,
  });
  const credential = await backend.requestToken({ tier: 'mini' });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/realtime/client_secrets');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].auth, 'PRESENT-REDACTED');
  assert.equal(bodyModel, 'gpt-realtime-2.1-mini');
  assert.equal(credential.token, 'ephemeral-secret');
  assertNoSecretLeak([...calls, { bodyModel }]);
});

test('voice token failure is honestly VOICE UNAVAILABLE with the mic never acquired', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse({ error: 'bad key' }, 401));
  const backend = createVoiceBackend({
    getKey: async () => 'vault-secret',
    fetchImpl,
  });
  await assert.rejects(backend.requestToken({}), /VOICE UNAVAILABLE/);
  let micCalls = 0;
  await assert.rejects(
    requestVoiceSession({
      backend,
      acquireMic: async () => {
        micCalls += 1;
        return { id: 'mic' };
      },
    }),
    /VOICE UNAVAILABLE/,
  );
  assert.equal(micCalls, 0);
});

test('voice without a key never touches the network', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ value: 'x' }));
  const backend = createVoiceBackend({ getKey: async () => null, fetchImpl });
  await assert.rejects(backend.requestToken({}), /VOICE UNAVAILABLE/);
  assert.equal(calls.length, 0);
});

test('voice negotiate posts the ephemeral SDP answer flow', async () => {
  const seen = [];
  const { calls, fetchImpl } = stubFetch((url, init) => {
    seen.push({ body: init.body, contentType: new Headers(init.headers || {}).get('content-type') });
    return new Response('v=0\r\nanswer', { status: 201 });
  });
  const backend = createVoiceBackend({
    getKey: async () => 'vault-secret',
    fetchImpl,
  });
  const answer = await backend.negotiate({
    offerSdp: 'v=0\r\noffer',
    credential: { token: 'ephemeral', expiresAt: 1_800_000_000 },
  });
  assert.match(calls[0].url, /^https:\/\/api\.openai\.com\/v1\/realtime\/calls$/);
  assert.equal(calls[0].auth, 'PRESENT-REDACTED');
  assert.deepEqual(seen, [{ body: 'v=0\r\noffer', contentType: 'application/sdp' }]);
  assert.match(answer, /answer/);
  assertNoSecretLeak([...calls, ...seen]);
});

test('voice token discards a late response after abort', async () => {
  await assertDiscardsLateResponse((fetchImpl, signal) =>
    createVoiceBackend({
      getKey: async () => 'vault-secret',
      fetchImpl,
    }).requestToken({ signal }),
  );
});

// ---------------------------------------------------------------------------
// meteredDirect: tomtom
// ---------------------------------------------------------------------------

function memoryBudget(limit = 6000) {
  let count = 0;
  return {
    trySpend: async () => {
      if (count >= limit) return false;
      count += 1;
      return true;
    },
  };
}

test('tomtom tile fetches flow bytes with the vault key over https', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const { calls, fetchImpl } = stubFetch(
    () => new Response(bytes, { status: 200 }),
  );
  const source = createTomtomDirectSource({
    fetchImpl,
    getKey: async () => 'vault-secret',
    budget: memoryBudget(),
  });
  const tile = await source.getFlowTile(12, 1, 2);
  assert.ok(tile instanceof Uint8Array);
  assert.match(
    calls[0].url,
    /^https:\/\/api\.tomtom\.com\/traffic\/map\/4\/tile\/flow\/relative\/12\/1\/2\.pbf\?/,
  );
  assertNoSecretLeak(calls.map(({ url, ...rest }) => ({ url: url.replace(/key=[^&]*/, 'key=[REDACTED]'), ...rest })));
});

test('tomtom tile validates coords, requires a key, and honors the budget', async () => {
  const { calls, fetchImpl } = stubFetch(() => new Response(new Uint8Array(), { status: 200 }));
  const source = createTomtomDirectSource({
    fetchImpl,
    getKey: async () => 'vault-secret',
    budget: memoryBudget(1),
  });
  await assert.rejects(source.getFlowTile(7, 0, 0), /tile/);
  await assert.rejects(source.getFlowTile(12, 4096, 0), /tile/);
  assert.equal(calls.length, 0);
  await source.getFlowTile(12, 0, 0);
  await assert.rejects(source.getFlowTile(12, 0, 1), (error) => {
    assert.equal(error.code, 'BUDGET_EXHAUSTED');
    return true;
  });
  assert.equal(calls.length, 1);
  const keyless = createTomtomDirectSource({
    fetchImpl,
    getKey: async () => null,
    budget: memoryBudget(),
  });
  await assert.rejects(keyless.getFlowTile(12, 0, 0), (error) => {
    assert.equal(error.keyRequired, true);
    return true;
  });
});

test('tomtom tile refuses keyed http and discards late responses', async () => {
  const { calls, fetchImpl } = stubFetch(() => new Response(new Uint8Array(), { status: 200 }));
  const source = createTomtomDirectSource({
    fetchImpl,
    getKey: async () => 'vault-secret',
    budget: memoryBudget(),
    tileRoot: 'http://api.tomtom.com/traffic/map/4/tile/flow/relative',
  });
  await assert.rejects(source.getFlowTile(12, 0, 0), (error) => {
    assert.equal(error.code, 'KEYED_HTTP_REFUSED');
    return true;
  });
  assert.equal(calls.length, 0);
  await assertDiscardsLateResponse((lateFetch, signal) =>
    createTomtomDirectSource({
      fetchImpl: lateFetch,
      getKey: async () => 'vault-secret',
      budget: memoryBudget(),
    }).getFlowTile(12, 0, 0, { signal }),
  );
});

// ---------------------------------------------------------------------------
// meteredDirect: google places + hud summary
// ---------------------------------------------------------------------------

const PLACES_FIXTURE = {
  places: [
    {
      id: 'place-1',
      displayName: { text: 'Test Museum' },
      formattedAddress: '1 Test St',
      location: { latitude: 48.85, longitude: 2.35 },
      primaryType: 'museum',
      types: ['museum', 'tourist_attraction'],
    },
  ],
};

test('google places nearby posts the keyed header and projects rows', async () => {
  const seen = [];
  const { calls, fetchImpl } = stubFetch((url, init) => {
    seen.push(JSON.parse(init.body));
    return jsonResponse(PLACES_FIXTURE);
  });
  const source = createGooglePlacesDirect({
    getKey: async () => 'vault-secret',
    fetchImpl,
  });
  const result = await source.searchNearby({ latitude: 48.85, longitude: 2.35 });
  assert.equal(result.places.length, 1);
  assert.equal(result.places[0].name, 'Test Museum');
  assert.match(calls[0].url, /^https:\/\/places\.googleapis\.com\/v1\/places:searchNearby$/);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].apiKeyHeader, 'PRESENT-REDACTED');
  assert.deepEqual(seen[0].locationRestriction.circle.center, { latitude: 48.85, longitude: 2.35 });
  assertNoSecretLeak([...calls, ...seen]);
});

test('google places text search biases to the view and stays keyless-honest', async () => {
  const seen = [];
  const { calls, fetchImpl } = stubFetch((url, init) => {
    seen.push(JSON.parse(init.body));
    return jsonResponse(PLACES_FIXTURE);
  });
  const source = createGooglePlacesDirect({
    getKey: async () => 'vault-secret',
    fetchImpl,
  });
  const result = await source.textSearch({ query: 'museum', latitude: 48.85, longitude: 2.35 });
  assert.equal(result.places.length, 1);
  assert.match(calls[0].url, /^https:\/\/places\.googleapis\.com\/v1\/places:searchText$/);
  assert.equal(seen[0].textQuery, 'museum');
  const keyless = createGooglePlacesDirect({ getKey: async () => null, fetchImpl });
  assert.deepEqual(await keyless.searchNearby({ latitude: 0, longitude: 0 }), {
    places: [],
    unavailable: 'KEY_REQUIRED',
  });
  assert.equal(calls.length, 1);
});

test('hud summary answers keyless-configured honestly and clamps to five words', async () => {
  const seen = [];
  const keyless = createHudSummaryDirect({ getKey: async () => null, fetchImpl: stubFetch(() => jsonResponse({})).fetchImpl });
  assert.deepEqual(await keyless.summarize({}), {
    summary: null,
    configured: false,
    code: 'OPENAI_NOT_CONFIGURED',
  });
  const { calls, fetchImpl } = stubFetch((url, init) => {
    seen.push(JSON.parse(init.body));
    return jsonResponse({ output_text: 'Calm skies over the morning harbor today' });
  });
  const direct = createHudSummaryDirect({ getKey: async () => 'vault-secret', fetchImpl });
  const result = await direct.summarize({ place: 'harbor' });
  assert.match(calls[0].url, /^https:\/\/api\.openai\.com\/v1\/responses$/);
  assert.equal(calls[0].auth, 'PRESENT-REDACTED');
  assert.equal(seen[0].model, 'gpt-5-nano');
  assert.equal(result.summary, 'Calm skies over the morning');
  assertNoSecretLeak([...calls, ...seen]);
});

test('hud summary failure stays honest and discards late responses', async () => {
  const failing = createHudSummaryDirect({
    getKey: async () => 'vault-secret',
    fetchImpl: stubFetch(() => jsonResponse({}, 500)).fetchImpl,
  });
  assert.deepEqual(await failing.summarize({}), {
    summary: null,
    error: 'OpenAI HUD summary request failed',
  });
  await assertDiscardsLateResponse((fetchImpl, signal) =>
    createHudSummaryDirect({
      getKey: async () => 'vault-secret',
      fetchImpl,
    }).summarize({}, { signal }),
  );
});
