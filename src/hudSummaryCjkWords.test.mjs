// revmain-astra-1 / revmain-sol-1: a ja/zh reply within the 20-character
// limit is still cut to its first five space-separated tokens.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { HUD_SUMMARY_MAX_UNSPACED_CHARS } from './hudSummaryResponse.js';

let client = 200;
async function postHudSummary(context, reply) {
  client += 1;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'test-key';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ output_text: reply }),
  });
  try {
    const { handleHudSummary } = await import(
      '../server/providers/openai/hud-summary.js'
    );
    const req = Object.assign(
      Readable.from([Buffer.from(JSON.stringify(context))]),
      {
        method: 'POST',
        url: '/',
        headers: {},
        socket: { remoteAddress: `10.0.1.${client}` },
      },
    );
    return await new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        setHeader() {},
        end(body = '') {
          resolve(JSON.parse(body));
        },
      };
      Promise.resolve(handleHudSummary(req, res)).catch(reject);
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
}

for (const [locale, summary] of [
  ['ja', '東京 上空 の 航空 情報 は 古い'],
  ['zh-CN', 'SFO 附近 4 架 航班 数据 过期'],
  ['zh-Hant', 'SFO 附近 4 架 航班 數據 過期'],
]) {
  test(`a ${locale} phrase within ${HUD_SUMMARY_MAX_UNSPACED_CHARS} characters is kept whole`, async () => {
    assert.ok([...summary].length <= HUD_SUMMARY_MAX_UNSPACED_CHARS);
    const body = await postHudSummary(
      { locale, feedProvenance: { overall: 'stale' } },
      JSON.stringify({ summary, feedState: 'stale' }),
    );
    assert.equal(body.summary, summary);
  });
}
