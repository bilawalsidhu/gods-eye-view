import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  handleHudSummary,
  hudSummaryCompatBody,
  hudSummaryCompatTarget,
} from './hud-summary.js';

test('compat target is off unless a http(s) base URL is set', () => {
  assert.equal(hudSummaryCompatTarget({}), null);
  assert.equal(
    hudSummaryCompatTarget({ GEV_HUD_SUMMARY_BASE_URL: 'file:///x' }),
    null,
  );
  assert.equal(
    hudSummaryCompatTarget({ GEV_HUD_SUMMARY_BASE_URL: 'nope' }),
    null,
  );
  assert.deepEqual(
    hudSummaryCompatTarget({
      GEV_HUD_SUMMARY_BASE_URL: 'http://127.0.0.1:9/v1/',
      GEV_HUD_SUMMARY_MODEL: 'm',
    }),
    {
      endpoint: 'http://127.0.0.1:9/v1/chat/completions',
      apiKey: null,
      model: 'm',
    },
  );
});

test('compat body carries upstream instructions and the context', () => {
  const body = hudSummaryCompatBody({ locale: 'en', place: 'San Diego' }, 'm');
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[1].content, /San Diego/);
  assert.equal(body.response_format.type, 'json_schema');
});

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(b) {
      this.body = b;
      this.done();
    },
  };
}

function fakeReq(method, url, body) {
  const chunks = body ? [Buffer.from(body)] : [];
  return Object.assign(
    (async function* () {
      yield* chunks;
    })(),
    {
      method,
      url,
      headers: { host: 'localhost' },
      socket: { remoteAddress: '127.0.0.1' },
      on(event, fn) {
        if (event === 'data') chunks.forEach(fn);
        if (event === 'end') fn();
        return this;
      },
    },
  );
}

async function call(req) {
  const res = fakeRes();
  await new Promise((done) => {
    res.done = done;
    handleHudSummary(req, res);
  });
  return { status: res.statusCode, json: JSON.parse(res.body) };
}

test('HUD summary uses the compatible server when configured', async () => {
  let seen = null;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen = {
        auth: req.headers.authorization,
        url: req.url,
        body: JSON.parse(raw),
      };
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '{"summary":"Busy San Diego skies","feedState":"nominal"}',
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const saved = { ...process.env };
  process.env.GEV_HUD_SUMMARY_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.GEV_HUD_SUMMARY_API_KEY = 'test-token';
  delete process.env.OPENAI_API_KEY;
  try {
    const status = await call(fakeReq('GET', '/status'));
    assert.equal(status.json.configured, true);
    const out = await call(
      fakeReq('POST', '/', JSON.stringify({ locale: 'en' })),
    );
    assert.equal(out.status, 200);
    assert.equal(out.json.summary, 'Busy San Diego skies');
    assert.equal(out.json.feedState, 'nominal');
    assert.equal(seen.url, '/v1/chat/completions');
    assert.equal(seen.auth, 'Bearer test-token');
  } finally {
    process.env = saved;
    server.close();
  }
});

test('unset keeps the keyless response', async () => {
  const saved = { ...process.env };
  delete process.env.GEV_HUD_SUMMARY_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  try {
    const status = await call(fakeReq('GET', '/status'));
    assert.equal(status.json.configured, false);
  } finally {
    process.env = saved;
  }
});
