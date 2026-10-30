import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import {
  HUD_SUMMARY_FEED_STATES,
  HUD_SUMMARY_INSTRUCTIONS,
  HUD_SUMMARY_MAX_UNSPACED_CHARS,
  HUD_SUMMARY_RESPONSE_FORMAT,
  HUD_SUMMARY_UNCONFIGURED_CODE,
  hudSummaryInput,
  hudSummaryInstructions,
  hudSummaryLayerContext,
  hudSummaryLocale,
  hudSummaryMatchesProvenance,
  hudTelemetryProvenance,
  isHudSummaryUnconfigured,
  keylessHudSummaryResponse,
  provenanceTag,
} from './hudSummaryResponse.js';
import { openAiRealtimeProxy } from '../vite.config.js';

const UNCONFIGURED_PAYLOAD = {
  configured: false,
  code: HUD_SUMMARY_UNCONFIGURED_CODE,
  error: null,
  summary: null,
};

function installOpenAiRoutes() {
  const routes = new Map();
  openAiRealtimeProxy().configureServer({
    middlewares: {
      use(path, handler) {
        routes.set(path, handler);
      },
    },
  });
  return routes;
}

function invokeRoute(
  handler,
  { method = 'GET', url = '/', remoteAddress = '127.0.0.1' } = {},
) {
  return new Promise((resolve, reject) => {
    const headers = new Map();
    const req = {
      method,
      url,
      headers: {},
      socket: { remoteAddress },
    };
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers.set(String(name).toLowerCase(), String(value));
      },
      end(body = '') {
        resolve({
          statusCode: this.statusCode,
          headers: Object.fromEntries(headers),
          body: body ? JSON.parse(String(body)) : null,
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('builds an HTTP-success capability response only for a blank key', () => {
  assert.deepEqual(keylessHudSummaryResponse(undefined), {
    statusCode: 200,
    payload: UNCONFIGURED_PAYLOAD,
  });
  assert.deepEqual(keylessHudSummaryResponse('  '), {
    statusCode: 200,
    payload: UNCONFIGURED_PAYLOAD,
  });
  assert.equal(keylessHudSummaryResponse('configured-key'), null);
});

test('recognizes only the exact deliberate no-key fallback response', () => {
  assert.equal(isHudSummaryUnconfigured(200, UNCONFIGURED_PAYLOAD), true);
  assert.equal(isHudSummaryUnconfigured(503, UNCONFIGURED_PAYLOAD), false);
  assert.equal(
    isHudSummaryUnconfigured(200, {
      ...UNCONFIGURED_PAYLOAD,
      error: 'provider failed',
    }),
    false,
  );
  assert.equal(
    isHudSummaryUnconfigured(200, {
      ...UNCONFIGURED_PAYLOAD,
      summary: 'Unexpected provider output',
    }),
    false,
  );
  assert.equal(
    isHudSummaryUnconfigured(200, {
      ...UNCONFIGURED_PAYLOAD,
      configured: true,
    }),
    false,
  );
  assert.equal(
    isHudSummaryUnconfigured(200, {
      ...UNCONFIGURED_PAYLOAD,
      unexpected: true,
    }),
    false,
  );
  assert.equal(
    isHudSummaryUnconfigured(200, {
      code: HUD_SUMMARY_UNCONFIGURED_CODE,
    }),
    false,
  );
});

test('does not hide real provider and HTTP failures', () => {
  assert.equal(
    isHudSummaryUnconfigured(502, {
      code: HUD_SUMMARY_UNCONFIGURED_CODE,
    }),
    false,
  );
  assert.equal(isHudSummaryUnconfigured(503, UNCONFIGURED_PAYLOAD), false);
  assert.equal(
    isHudSummaryUnconfigured(200, { error: 'provider failed' }),
    false,
  );
});

test('the installed keyless HUD route stays successful after the voice quota is exhausted', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousLimit = process.env.GEV_RATELIMIT_OPENAI_PER_MIN;
  process.env.OPENAI_API_KEY = '';
  process.env.GEV_RATELIMIT_OPENAI_PER_MIN = '1';
  try {
    const routes = installOpenAiRoutes();
    const token = routes.get('/api/realtime/token');
    const hud = routes.get('/api/openai/hud-summary');
    assert.equal(typeof token, 'function');
    assert.equal(typeof hud, 'function');

    const firstToken = await invokeRoute(token);
    const secondToken = await invokeRoute(token);
    assert.equal(firstToken.statusCode, 503);
    assert.deepEqual(firstToken.body, { error: 'OPENAI_API_KEY is not set' });
    assert.equal(secondToken.statusCode, 429);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await invokeRoute(hud, { method: 'POST' });
      assert.equal(response.statusCode, 200);
      assert.equal(
        response.headers['content-type'],
        'application/json; charset=utf-8',
      );
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(response.body, UNCONFIGURED_PAYLOAD);
    }
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousLimit === undefined)
      delete process.env.GEV_RATELIMIT_OPENAI_PER_MIN;
    else process.env.GEV_RATELIMIT_OPENAI_PER_MIN = previousLimit;
  }
});

test('HUD summary context and telemetry tag carry chip-identical feed-state', () => {
  const now = 1_000_000;
  const layers = [
    {
      id: 'flights',
      name: 'Live Flights',
      enabled: true,
      stats: {
        stale: true,
        count: 12,
        lastUpdate: now - 240_000,
        source: 'OpenSky Network',
      },
    },
    {
      id: 'earthquakes',
      name: 'Earthquakes',
      enabled: false,
      stats: { count: 3, lastUpdate: now },
    },
  ];
  const context = hudSummaryLayerContext(layers, { now });
  assert.deepEqual(context.enabledLayerLabels, ['Live Flights']);
  assert.equal(context.enabledLayers[0].feedState, 'stale');
  assert.equal(context.feedProvenance.overall, 'stale');
  assert.deepEqual(hudTelemetryProvenance(layers, { now }), {
    state: 'stale',
    names: ['Live Flights'],
  });
  assert.equal(
    hudTelemetryProvenance(
      [
        {
          id: 'flights',
          name: 'Live Flights',
          enabled: true,
          stats: { count: 4, lastUpdate: now },
        },
      ],
      { now },
    ),
    null,
  );
});

test('HUD summary instructions ask for the canonical feedState as its own field', () => {
  assert.match(
    HUD_SUMMARY_INSTRUCTIONS,
    /Set feedState to feedProvenance\.overall exactly/,
  );
  assert.match(
    HUD_SUMMARY_INSTRUCTIONS,
    /do not present the view as live or healthy/,
  );
  assert.match(
    HUD_SUMMARY_INSTRUCTIONS,
    /partial, do not present the coverage as complete/,
  );
  assert.deepEqual(HUD_SUMMARY_RESPONSE_FORMAT.schema.required, [
    'summary',
    'feedState',
  ]);
  assert.deepEqual(
    HUD_SUMMARY_RESPONSE_FORMAT.schema.properties.feedState.enum,
    [...HUD_SUMMARY_FEED_STATES],
  );
  assert.ok(HUD_SUMMARY_FEED_STATES.includes('partial'));
});

test('the instructions name the UI language, with English as the fallback', () => {
  assert.match(hudSummaryInstructions('es'), /in Spanish \(es\)/);
  assert.match(hudSummaryInstructions('ru-RU'), /in Russian \(ru\)/);
  assert.equal(hudSummaryInstructions('en'), HUD_SUMMARY_INSTRUCTIONS);
  assert.equal(hudSummaryInstructions('xx-YY'), HUD_SUMMARY_INSTRUCTIONS);
  assert.equal(hudSummaryInstructions(undefined), HUD_SUMMARY_INSTRUCTIONS);
  assert.equal(hudSummaryLocale('es-MX'), 'es');
  const english = { locale: 'en', placeLabels: ['Austin'] };
  assert.equal(hudSummaryInput(english), JSON.stringify(english));
  assert.match(
    hudSummaryInput({ locale: 'ru' }),
    /^Summary language: Russian \(ru\)\.\n\{/,
  );
  assert.equal(hudSummaryLocale(42), 'en');
});

test('shipped catalogs get their exact language, and CJK a character limit', () => {
  assert.match(hudSummaryInstructions('pt'), /in Brazilian Portuguese \(pt\)/);
  assert.match(
    hudSummaryInstructions('zh-Hant'),
    /in Chinese in Traditional characters \(mainland wording\) \(zh-Hant\)/,
  );
  assert.match(hudSummaryInstructions('zh-CN'), /in Simplified Chinese/);
  assert.match(
    hudSummaryInstructions('ja'),
    new RegExp(`at most ${HUD_SUMMARY_MAX_UNSPACED_CHARS} characters`),
  );
  assert.doesNotMatch(hudSummaryInstructions('es'), /at most/);
  assert.match(hudSummaryInstructions('es'), /names in enabledLayerLabels/);
});

let hudSummaryClient = 0;

async function postHudSummary(context, reply) {
  // A fresh address per request: the per-IP limiter outlives a single test.
  hudSummaryClient += 1;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'test-key';
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ output_text: reply }),
    };
  };
  try {
    // The handler itself: the installed route adds a same-site gate that a
    // bare test request does not pass.
    const { handleHudSummary: hud } =
      await import('../server/providers/openai/hud-summary.js');
    const req = Object.assign(
      Readable.from([Buffer.from(JSON.stringify(context))]),
      {
        method: 'POST',
        url: '/',
        headers: {},
        socket: { remoteAddress: `10.0.0.${hudSummaryClient}` },
      },
    );
    const response = await new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        setHeader() {},
        end(body = '') {
          resolve({ statusCode: this.statusCode, body: JSON.parse(body) });
        },
      };
      Promise.resolve(hud(req, res)).catch(reject);
    });
    return { sent, response };
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
}

test('an es request reaches the model in Spanish and returns the canonical state', async () => {
  const { sent, response } = await postHudSummary(
    {
      locale: 'es',
      placeLabels: ['Austin'],
      feedProvenance: { overall: 'stale' },
    },
    JSON.stringify({
      summary: 'Austin vuelos con datos antiguos',
      feedState: 'stale',
    }),
  );
  assert.match(sent.instructions, /in Spanish \(es\)/);
  assert.equal(sent.text.format.name, 'hud_summary');
  const [lead, json] = sent.input.split('\n');
  assert.equal(lead, 'Summary language: Spanish (es).');
  assert.equal(JSON.parse(json).locale, 'es');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    summary: 'Austin vuelos con datos antiguos',
    feedState: 'stale',
    error: null,
  });
});

test('a Japanese summary is capped in characters, not words', async () => {
  const long = 'テキサス州議会議事堂周辺の航空機データは古くなっています';
  const { response } = await postHudSummary(
    { locale: 'ja', feedProvenance: { overall: 'stale' } },
    JSON.stringify({ summary: long, feedState: 'stale' }),
  );
  assert.equal(
    response.body.summary,
    [...long].slice(0, HUD_SUMMARY_MAX_UNSPACED_CHARS).join(''),
  );
});

for (const [locale, summary] of [
  ['en', 'Shibuya 渋谷 live flights overhead'],
  ['es', 'Vuelos sobre 東京駅 datos antiguos'],
  ['ru', 'Башня Тайбэй 101 台北101 рейсы'],
]) {
  test(`a ${locale} summary with a Han place name keeps its five words`, async () => {
    const { response } = await postHudSummary(
      { locale, feedProvenance: { overall: 'stale' } },
      JSON.stringify({ summary, feedState: 'stale' }),
    );
    assert.equal(response.body.summary, summary);
  });
}

test('a ja cap steps back to a space instead of cutting a Latin word', async () => {
  const { response } = await postHudSummary(
    { locale: 'ja', feedProvenance: { overall: 'stale' } },
    JSON.stringify({
      summary: 'San Francisco Bay Area flights',
      feedState: 'stale',
    }),
  );
  assert.equal(response.body.summary, 'San Francisco Bay');
});

test('a ja cap keeps the text before a Latin word it would split', async () => {
  const { response } = await postHudSummary(
    { locale: 'ja', feedProvenance: { overall: 'stale' } },
    JSON.stringify({
      summary: '東京 羽田空港周辺のFlightAware航空情報',
      feedState: 'stale',
    }),
  );
  assert.equal(response.body.summary, '東京 羽田空港周辺の');
});

for (const [locale, summary] of [
  ['ja', '東京 上空 の 航空 情報 は 古い'],
  ['zh-CN', 'SFO 附近 4 架 航班 数据 过期'],
  ['zh-Hant', 'SFO 附近 4 架 航班 數據 過期'],
]) {
  test(`a ${locale} phrase within the character cap is kept whole`, async () => {
    const { response } = await postHudSummary(
      { locale, feedProvenance: { overall: 'stale' } },
      JSON.stringify({ summary, feedState: 'stale' }),
    );
    assert.equal(response.body.summary, summary);
  });
}

test('a reply that skips the format carries no summary and no state', async () => {
  const { response } = await postHudSummary(
    { locale: 'ru', feedProvenance: { overall: 'stale' } },
    'Остин рейсы данные устарели сейчас',
  );
  assert.equal(response.body.summary, null);
  assert.equal(response.body.feedState, null);
  const unknown = await postHudSummary(
    { locale: 'ru', feedProvenance: { overall: 'stale' } },
    JSON.stringify({ summary: 'Остин рейсы', feedState: 'fine' }),
  );
  assert.equal(unknown.response.body.feedState, null);
});

test("a localized summary is shown only with the HUD's own canonical state", () => {
  const stale = { overall: 'stale' };
  assert.equal(
    hudSummaryMatchesProvenance(
      { summary: 'Остин рейсы данные устарели сейчас', feedState: 'stale' },
      stale,
    ),
    true,
  );
  assert.equal(
    hudSummaryMatchesProvenance(
      { summary: 'Austin vuelos en vivo ahora', feedState: 'nominal' },
      stale,
    ),
    false,
  );
  assert.equal(
    hudSummaryMatchesProvenance(
      { summary: 'Austin stale flights over downtown', feedState: null },
      stale,
    ),
    false,
  );
  assert.equal(
    hudSummaryMatchesProvenance(
      { summary: 'Austin flights' },
      { overall: 'partial' },
    ),
    false,
  );
  assert.equal(
    hudSummaryMatchesProvenance(
      { summary: 'Austin flights operating normally today' },
      { overall: 'nominal' },
    ),
    true,
  );
  assert.equal(hudSummaryMatchesProvenance({ summary: 'x' }, null), true);
});

test('a partial view keeps its warning tag, translated in es and ru', async () => {
  const now = 1_000_000;
  const layers = [
    {
      id: 'flights',
      name: 'Live Flights',
      enabled: true,
      stats: { partial: true, count: 4, lastUpdate: now },
    },
    {
      id: 'vessels',
      name: 'Live AIS Vessels',
      enabled: true,
      stats: { count: 9, lastUpdate: now },
    },
  ];
  const context = hudSummaryLayerContext(layers, { now });
  assert.equal(context.feedProvenance.overall, 'partial');
  assert.deepEqual(provenanceTag(context.feedProvenance), {
    state: 'partial',
    names: ['Live Flights'],
  });
  assert.deepEqual(hudTelemetryProvenance(layers, { now }), {
    state: 'partial',
    names: ['Live Flights'],
  });
  const { setLocale, t } = await import('./i18n/index.js');
  try {
    for (const locale of ['es', 'ru']) {
      setLocale(locale);
      assert.notEqual(t('PARTIAL'), 'PARTIAL', locale);
    }
  } finally {
    setLocale('en');
  }
});
