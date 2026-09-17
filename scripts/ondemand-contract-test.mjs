#!/usr/bin/env node
/**
 * Contract test against the LIVE OnDemand API, gated 1:1 to
 * docs/ONDEMAND_API_CURRENT.md (generated 2026-09-17T06:14Z, audited commit
 * 0d41b6be5490db1f10a171f238be75db4d4ec3b4).
 *
 * REGENERATION NOTE: this script was regenerated from scratch by subagent S3
 * on 2026-09-17. No previous copy of scripts/ondemand-contract-test.mjs
 * existed anywhere in this workspace at the time of writing — see
 * docs/ONDEMAND_PROXY_DESIGN.md "Contract-test regeneration" for the note
 * this task asked to record.
 *
 * Usage:
 *   ONDEMAND_API_KEY=... node scripts/ondemand-contract-test.mjs
 *   node scripts/ondemand-contract-test.mjs --dry-run     (no network, no key required)
 *
 * Env (read ONLY from process.env — a key is NEVER accepted as an argv value):
 *   ONDEMAND_API_KEY                  required for a real run; irrelevant for --dry-run
 *   ONDEMAND_BASE_URL                 optional, default https://api.on-demand.io
 *   ONDEMAND_FULFILLMENT_ENDPOINT_ID  optional, default 'predefined-claude-sonnet-5'
 *                                     (THIS DEFAULT LIVES ONLY IN THIS TEST SCRIPT —
 *                                     from the contract §12 table, which the docs
 *                                     themselves call volatile; the proxy itself
 *                                     never hardcodes a model id)
 *   ONDEMAND_SPATIAL_FLOW_ID          optional — enables the workflow execute+poll
 *                                     path in step 10; without it, step 10 only
 *                                     lists workflows and SKIPs the execute part
 *   ONDEMAND_SPATIAL_AGENT_ID         optional — used as a pluginIds default in step 1
 *   ONDEMAND_CONTRACT_SKIP_PAID=1     optional — SKIP steps 8 (TTS) and 9 (STT),
 *                                     which incur real cost against the account
 *
 * Node 18+, ESM, zero dependencies (global fetch/ReadableStream/AbortSignal only).
 */

const DRY_RUN = process.argv.includes('--dry-run');

const BASE_URL = (process.env.ONDEMAND_BASE_URL || 'https://api.on-demand.io').replace(/\/+$/, '');
const CHAT = `${BASE_URL}/chat/v1`; // §1 "Base URL per API family"
const MEDIA = `${BASE_URL}/media/v1/public/file`;
const SERVICES = `${BASE_URL}/services/v1/public/service`;
const AUTOMATION = `${BASE_URL}/automation/api`;

const ENDPOINT_ID = process.env.ONDEMAND_FULFILLMENT_ENDPOINT_ID || 'predefined-claude-sonnet-5';
const FLOW_ID = process.env.ONDEMAND_SPATIAL_FLOW_ID || '';
const AGENT_ID = process.env.ONDEMAND_SPATIAL_AGENT_ID || '';
const SKIP_PAID = process.env.ONDEMAND_CONTRACT_SKIP_PAID === '1';
const EXTERNAL_USER_ID = `ondemand-contract-test-${Date.now()}`;

// ---------------------------------------------------------------------------
// The 10-step plan, described declaratively so --dry-run and the real run
// can both be driven off the same data for the parts that don't depend on
// ids only known after earlier steps run (sessionId, executionId, audioUrl).
// ---------------------------------------------------------------------------
const DRY_PLAN = [
  { n: 1, name: 'create session', section: '\u00a72.1', method: 'POST', url: `${CHAT}/sessions`, bodyFields: ['externalUserId', 'pluginIds'] },
  { n: 2, name: 'get session', section: '\u00a72.3', method: 'GET', url: `${CHAT}/sessions/<sessionId>`, bodyFields: [] },
  { n: 3, name: 'list sessions (externalUserId filter)', section: '\u00a72.2', method: 'GET', url: `${CHAT}/sessions?externalUserId=<externalUserId>&limit=10`, bodyFields: [] },
  { n: 4, name: 'sync query', section: '\u00a73.2', method: 'POST', url: `${CHAT}/sessions/<sessionId>/query`, bodyFields: ['query', 'endpointId', 'responseMode', 'pluginIds'] },
  { n: 5, name: 'stream query', section: '\u00a73.4/\u00a74', method: 'POST', url: `${CHAT}/sessions/<sessionId>/query`, bodyFields: ['query', 'endpointId', 'responseMode', 'pluginIds'] },
  { n: 6, name: 'list messages', section: '\u00a72.5', method: 'GET', url: `${CHAT}/sessions/<sessionId>/messages?limit=10`, bodyFields: [] },
  { n: 7, name: 'media list', section: '\u00a75.3', method: 'GET', url: `${MEDIA}?page=1&limit=1`, bodyFields: [] },
  { n: 8, name: 'text to speech', section: '\u00a76.2', method: 'POST', url: `${SERVICES}/execute/text_to_speech`, bodyFields: ['input', 'voice', 'model'] },
  { n: 9, name: 'speech to text (using step 8 audioUrl)', section: '\u00a76.1', method: 'POST', url: `${SERVICES}/execute/speech_to_text`, bodyFields: ['audioUrl'] },
  {
    n: 10,
    name: FLOW_ID ? 'workflow execute + poll + logs' : 'workflow list (execute part SKIPped, no ONDEMAND_SPATIAL_FLOW_ID)',
    section: '\u00a77.1/\u00a77.3',
    method: FLOW_ID ? 'POST' : 'GET',
    url: FLOW_ID ? `${AUTOMATION}/workflow/${FLOW_ID}/execute` : `${AUTOMATION}/workflow/?limit=1`,
    bodyFields: [],
  },
];

if (DRY_RUN) {
  console.log('ONDEMAND CONTRACT TEST -- DRY RUN (no network calls, no API key required)');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`endpointId: ${ENDPOINT_ID}  (default lives only in this script; see header comment)`);
  for (const p of DRY_PLAN) {
    const fields = p.bodyFields.length ? ` body:{${p.bodyFields.join(',')}}` : '';
    console.log(`STEP ${p.n}/10 ${p.name} (${p.section}) \u2014 ${p.method} ${p.url}${fields}`);
  }
  process.exit(0);
}

const API_KEY = process.env.ONDEMAND_API_KEY;
if (!API_KEY) {
  console.error(
    'ONDEMAND_API_KEY is required (read from the environment only -- this script never accepts a key as a command-line argument). Aborting.',
  );
  process.exit(2);
}

/** Thrown to mark a step SKIP rather than PASS/FAIL. */
class Skip extends Error {}

let passed = 0;
let failed = 0;
let skipped = 0;

function nowIso() {
  return new Date().toISOString();
}

/** apikey-header fetch wrapper matching contract \u00a71 (never logs the key). */
async function ondemand(url, init = {}) {
  const headers = { ...(init.headers || {}), apikey: API_KEY };
  let body = init.body;
  if (body !== undefined && body !== null && typeof body === 'object') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  return fetch(url, { ...init, headers, body });
}

async function runStep(n, name, section, fn) {
  const ts = nowIso();
  const start = Date.now();
  try {
    const value = await fn();
    const ms = Date.now() - start;
    passed += 1;
    console.log(`STEP ${n}/10 ${name} (${section}) ${ts} \u2026 PASS (${ms}ms)`);
    return value;
  } catch (err) {
    const ms = Date.now() - start;
    if (err instanceof Skip) {
      skipped += 1;
      console.log(`STEP ${n}/10 ${name} (${section}) ${ts} \u2026 SKIP (${ms}ms) - ${err.message}`);
      return undefined;
    }
    failed += 1;
    console.log(`STEP ${n}/10 ${name} (${section}) ${ts} \u2026 FAIL (${ms}ms) - ${err.message}`);
    return undefined;
  }
}

async function main() {
  let sessionId;
  let ttsAudioUrl;

  sessionId = await runStep(1, 'create session', '\u00a72.1', async () => {
    const pluginIds = AGENT_ID ? [AGENT_ID] : [];
    const res = await ondemand(`${CHAT}/sessions`, {
      method: 'POST',
      body: { externalUserId: EXTERNAL_USER_ID, pluginIds },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    if (!json?.data?.id) throw new Error('response missing data.id');
    return json.data.id;
  });

  await runStep(2, 'get session', '\u00a72.3', async () => {
    if (!sessionId) throw new Error('no sessionId from step 1');
    const res = await ondemand(`${CHAT}/sessions/${sessionId}`, { method: 'GET' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (json?.data?.id !== sessionId) throw new Error('data.id mismatch');
    return json;
  });

  await runStep(3, 'list sessions (externalUserId filter)', '\u00a72.2', async () => {
    const res = await ondemand(`${CHAT}/sessions?externalUserId=${encodeURIComponent(EXTERNAL_USER_ID)}&limit=10`, {
      method: 'GET',
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!json?.pagination || typeof json.pagination !== 'object') throw new Error('response missing pagination object');
    return json;
  });

  await runStep(4, 'sync query', '\u00a73.2', async () => {
    if (!sessionId) throw new Error('no sessionId');
    const res = await ondemand(`${CHAT}/sessions/${sessionId}/query`, {
      method: 'POST',
      body: { query: 'What is AI? Answer in one short sentence.', endpointId: ENDPOINT_ID, responseMode: 'sync', pluginIds: [] },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    if (typeof json?.data?.answer !== 'string') throw new Error('data.answer is not a string');
    if (typeof json?.data?.status !== 'string') throw new Error('data.status missing');
    return json;
  });

  await runStep(5, 'stream query', '\u00a73.4/\u00a74', async () => {
    if (!sessionId) throw new Error('no sessionId');
    const res = await ondemand(`${CHAT}/sessions/${sessionId}/query`, {
      method: 'POST',
      body: { query: 'Say OK.', endpointId: ENDPOINT_ID, responseMode: 'stream', pluginIds: [] },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    let buf = '';
    let event = 'message';
    let sawFulfillment = false;
    let sawTerminal = false; // metricsLog event OR [DONE]
    const decoder = new TextDecoder();
    outer: for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '') continue;
        if (data === '[DONE]') {
          sawTerminal = true;
          break outer;
        }
        if (data.startsWith('[ERROR]:')) {
          let parsed;
          try {
            parsed = JSON.parse(data.slice(8));
          } catch {
            parsed = data.slice(8);
          }
          throw new Error(`stream [ERROR]: ${JSON.stringify(parsed)}`);
        }
        if (event === 'heartbeat') continue;
        let evt;
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }
        if (evt.eventType === 'fulfillment') sawFulfillment = true;
        if (evt.eventType === 'metricsLog') sawTerminal = true;
      }
    }
    if (!sawFulfillment) throw new Error('no eventType:"fulfillment" delta observed');
    if (!sawTerminal) throw new Error('no metricsLog event or [DONE] terminal marker observed');
    return { sawFulfillment, sawTerminal };
  });

  await runStep(6, 'list messages', '\u00a72.5', async () => {
    if (!sessionId) throw new Error('no sessionId');
    const res = await ondemand(`${CHAT}/sessions/${sessionId}/messages?limit=10`, { method: 'GET' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = Array.isArray(json?.data) ? json.data : [];
    if (!list.some((m) => typeof m?.query === 'string' && m.query.length > 0)) {
      throw new Error('no message with a non-empty query field found');
    }
    return list.length;
  });

  await runStep(7, 'media list', '\u00a75.3', async () => {
    const res = await ondemand(`${MEDIA}?page=1&limit=1`, { method: 'GET' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!Array.isArray(json?.data)) throw new Error('response missing data[]');
    return json;
  });

  ttsAudioUrl = await runStep(8, 'text to speech', '\u00a76.2', async () => {
    if (SKIP_PAID) throw new Skip('ONDEMAND_CONTRACT_SKIP_PAID=1');
    const res = await ondemand(`${SERVICES}/execute/text_to_speech`, {
      method: 'POST',
      body: { input: 'contract test', voice: 'alloy', model: 'tts-1' },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    if (typeof json?.data?.audioUrl !== 'string') throw new Error('data.audioUrl missing');
    const audioUrl = json.data.audioUrl;
    const fetched = await fetch(audioUrl, { method: 'GET' }); // storage host may not support HEAD; GET + cancel body
    if (!fetched.ok) throw new Error(`audioUrl fetch HTTP ${fetched.status}`);
    const contentType = fetched.headers.get('content-type') || '';
    if (!contentType.includes('audio')) throw new Error(`audioUrl content-type not audio: "${contentType}"`);
    try {
      await fetched.body?.cancel();
    } catch {
      /* ignore */
    }
    return audioUrl;
  });

  await runStep(9, 'speech to text (using step 8 audioUrl)', '\u00a76.1', async () => {
    if (SKIP_PAID || !ttsAudioUrl) throw new Skip('step 8 was skipped or produced no audioUrl');
    const res = await ondemand(`${SERVICES}/execute/speech_to_text`, {
      method: 'POST',
      body: { audioUrl: ttsAudioUrl },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    if (typeof json?.data?.text !== 'string') throw new Error('data.text missing');
    return json.data.text;
  });

  await runStep(
    10,
    FLOW_ID ? 'workflow execute + poll + logs' : 'workflow list (execute part SKIPped)',
    '\u00a77.1/\u00a77.3',
    async () => {
      if (!FLOW_ID) {
        const res = await ondemand(`${AUTOMATION}/workflow/?limit=1`, { method: 'GET' });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        throw new Skip('ONDEMAND_SPATIAL_FLOW_ID not set; listed workflows instead, execute part skipped');
      }
      const execRes = await ondemand(`${AUTOMATION}/workflow/${FLOW_ID}/execute`, { method: 'POST' });
      const execJson = await execRes.json().catch(() => ({}));
      if (!execRes.ok) throw new Error(`HTTP ${execRes.status}: ${JSON.stringify(execJson).slice(0, 300)}`);
      if (!execJson?.executionID) throw new Error('response missing executionID');
      const executionId = execJson.executionID;

      const deadline = Date.now() + 60000;
      let status;
      while (Date.now() < deadline) {
        const statusRes = await ondemand(`${AUTOMATION}/execution/${executionId}`, { method: 'GET' });
        const statusJson = await statusRes.json().catch(() => ({}));
        status = statusJson?.data?.status ?? statusJson?.status;
        if (status && status !== 'executing' && status !== 'processing') break;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      const logsRes = await ondemand(`${AUTOMATION}/execution/${executionId}/logs`, { method: 'GET' });
      if (!logsRes.ok) throw new Error(`logs HTTP ${logsRes.status}`);
      return { executionId, status };
    },
  );

  console.log(`CONTRACT RESULT: passed=${passed} failed=${failed} skipped=${skipped}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Unexpected contract-test crash:', err?.stack || err?.message || err);
  console.log(`CONTRACT RESULT: passed=${passed} failed=${failed + 1} skipped=${skipped}`);
  process.exit(1);
});
