#!/usr/bin/env node
/**
 * Contract test for the OnDemand integration, gated 1:1 to
 * docs/ONDEMAND_API_CURRENT.md, runnable against EITHER surface:
 *
 *   --mode direct  talks to OnDemand directly (needs ONDEMAND_API_KEY)
 *   --mode proxy   talks to THIS repo's same-origin proxy (api/ondemand/*.js)
 *                  at --proxy-base <url> / ONDEMAND_PROXY_BASE -- NO key
 *
 * Auto-detect (when --mode is omitted): a proxy base present (flag or env)
 * selects proxy mode; otherwise direct mode is selected. Every run prints a
 * `MODE: ...` header line stating which mode it picked and why.
 *
 * Usage:
 *   ONDEMAND_API_KEY=... node scripts/ondemand-contract-test.mjs
 *   node scripts/ondemand-contract-test.mjs --mode proxy --proxy-base https://host/api/ondemand
 *   node scripts/ondemand-contract-test.mjs --dry-run [--mode proxy --proxy-base <url>]
 *   node scripts/ondemand-contract-test.mjs --json-out /path/report.json [...]
 *
 * Flags:
 *   --mode direct|proxy       force the mode instead of auto-detecting
 *   --proxy-base <url>        proxy origin + path prefix, e.g. https://h/api/ondemand
 *   --dry-run                 print the 10 planned requests and exit 0 (no network)
 *   --json-out <path>         write the JSON report (see the shape at the bottom
 *                             of this file, function buildReport())
 *   --timeout-ms <n>          per-request timeout, default 60000 (SSE steps default
 *                             to 120000 unless this flag is given, which then
 *                             applies to every request including SSE)
 *
 * Env (read ONLY from process.env -- a key is NEVER accepted as an argv value,
 * and process.env is never printed or logged in full):
 *   ONDEMAND_API_KEY                  required for --mode direct (irrelevant to proxy
 *                                     mode and to --dry-run)
 *   ONDEMAND_BASE_URL                 direct mode base url, default https://api.on-demand.io
 *   ONDEMAND_API_BASE                 direct mode base url alias (used when
 *                                     ONDEMAND_BASE_URL is unset)
 *   ONDEMAND_PROXY_BASE               proxy mode base url (alternative to --proxy-base)
 *   ONDEMAND_FULFILLMENT_ENDPOINT_ID  endpointId to send; direct mode falls back to
 *                                     'predefined-claude-sonnet-5' when unset (THIS
 *                                     DEFAULT LIVES ONLY IN THIS TEST SCRIPT -- the
 *                                     contract's §12 predefined-id list is documented
 *                                     as volatile); proxy mode OMITS endpointId when
 *                                     unset so the proxy applies the deployment's own
 *                                     default (server/ondemand/config.js)
 *   ONDEMAND_ENDPOINT_ID              alias for ONDEMAND_FULFILLMENT_ENDPOINT_ID
 *   ONDEMAND_SPATIAL_AGENT_ID         direct-mode pluginIds source for steps 4/9 (single
 *                                     id or comma/whitespace separated list)
 *   ONDEMAND_KNOWLEDGE_PLUGIN_IDS     alias for ONDEMAND_SPATIAL_AGENT_ID
 *   ONDEMAND_SPATIAL_FLOW_ID          direct-mode workflow id for step 8
 *
 * In proxy mode, steps 4 and 8 discover whether a default plugin / workflow is
 * configured by calling the proxy's own GET /health?envNames=1 (names only,
 * never values) -- they never read the LOCAL shell's env for that, since the
 * whole point of proxy mode is testing a deployment this process does not
 * control.
 *
 * Documented built-in plugin ids used below (never invented): image agent
 * `plugin-1713958591` (media §5 sample), audio agent `plugin-1713958830`
 * (§5 "file agents" list). Nothing else is hard-coded.
 *
 * Node 18+, ESM, zero dependencies (global fetch/FormData/Blob/AbortSignal/
 * node:crypto/node:zlib/node:fs only).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const MAX_BODY_EXCERPT = 200;
const AUDIO_AGENT_PLUGIN_ID = 'plugin-1713958830'; // §5 "file agents" Audio Agent
const IMAGE_AGENT_PLUGIN_ID = 'plugin-1713958591'; // §5.2 raw-upload sample
const DIRECT_DEFAULT_ENDPOINT_ID = 'predefined-claude-sonnet-5'; // volatile, direct-only, see header

// ---------------------------------------------------------------------------
// argv / env
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    mode: null,
    proxyBase: null,
    dryRun: false,
    jsonOut: null,
    timeoutMs: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--mode') out.mode = argv[++i] ?? null;
    else if (a.startsWith('--mode=')) out.mode = a.slice('--mode='.length);
    else if (a === '--proxy-base') out.proxyBase = argv[++i] ?? null;
    else if (a.startsWith('--proxy-base='))
      out.proxyBase = a.slice('--proxy-base='.length);
    else if (a === '--json-out') out.jsonOut = argv[++i] ?? null;
    else if (a.startsWith('--json-out='))
      out.jsonOut = a.slice('--json-out='.length);
    else if (a === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (a.startsWith('--timeout-ms='))
      out.timeoutMs = Number(a.slice('--timeout-ms='.length));
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
const DRY_RUN = ARGS.dryRun;
const JSON_OUT = ARGS.jsonOut;

if (ARGS.mode !== null && ARGS.mode !== 'direct' && ARGS.mode !== 'proxy') {
  console.error(`Invalid --mode "${ARGS.mode}"; expected "direct" or "proxy".`);
  process.exit(2);
}
const MODE_EXPLICIT = ARGS.mode !== null;
const proxyBaseRaw = ARGS.proxyBase || process.env.ONDEMAND_PROXY_BASE || '';

const MODE = MODE_EXPLICIT ? ARGS.mode : proxyBaseRaw ? 'proxy' : 'direct';

let PROXY_BASE = '';
if (MODE === 'proxy') {
  if (!proxyBaseRaw) {
    console.error(
      '--mode proxy requires --proxy-base <url> or the ONDEMAND_PROXY_BASE environment variable.',
    );
    process.exit(2);
  }
  try {
    const u = new URL(proxyBaseRaw);
    u.search = '';
    u.hash = '';
    PROXY_BASE = u.toString().replace(/\/+$/, '');
  } catch {
    console.error(`--proxy-base is not a valid URL: "${proxyBaseRaw}"`);
    process.exit(2);
  }
}

const API_KEY = process.env.ONDEMAND_API_KEY || '';
const BASE_URL = (
  process.env.ONDEMAND_BASE_URL ||
  process.env.ONDEMAND_API_BASE ||
  'https://api.on-demand.io'
).replace(/\/+$/, '');
const CHAT = `${BASE_URL}/chat/v1`;
const MEDIA = `${BASE_URL}/media/v1/public/file`;
const SERVICES = `${BASE_URL}/services/v1/public/service`;
const AUTOMATION = `${BASE_URL}/automation/api`;

const FULFILLMENT_ENDPOINT_ID =
  process.env.ONDEMAND_FULFILLMENT_ENDPOINT_ID ||
  process.env.ONDEMAND_ENDPOINT_ID ||
  '';
const SPATIAL_AGENT_IDS = (
  process.env.ONDEMAND_SPATIAL_AGENT_ID ||
  process.env.ONDEMAND_KNOWLEDGE_PLUGIN_IDS ||
  ''
)
  .split(/[,\s]+/)
  .map((s) => s.trim())
  .filter(Boolean);
const SPATIAL_FLOW_ID = process.env.ONDEMAND_SPATIAL_FLOW_ID || '';

const TIMEOUT_MS =
  Number.isFinite(ARGS.timeoutMs) && ARGS.timeoutMs > 0
    ? ARGS.timeoutMs
    : 60000;
const SSE_TIMEOUT_MS =
  Number.isFinite(ARGS.timeoutMs) && ARGS.timeoutMs > 0
    ? ARGS.timeoutMs
    : 120000;

function utcDateStamp(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC, per toISOString's contract)
}
const EXTERNAL_USER_ID = `godseye-contract-test-${utcDateStamp()}`;

function nowIso() {
  return new Date().toISOString();
}

function headerLine() {
  if (MODE === 'proxy') {
    let reason;
    if (MODE_EXPLICIT) reason = 'explicit --mode proxy';
    else if (!API_KEY) reason = 'forced: no ONDEMAND_API_KEY in env';
    else reason = 'auto-detected: --proxy-base/ONDEMAND_PROXY_BASE set';
    return `MODE: proxy (${reason}; base=${PROXY_BASE})`;
  }
  const reason = MODE_EXPLICIT
    ? 'explicit --mode direct'
    : 'auto-detected: no --proxy-base/ONDEMAND_PROXY_BASE set';
  return `MODE: direct (${reason}; base=${BASE_URL})`;
}

console.log(headerLine());

if (MODE === 'direct' && !API_KEY && !DRY_RUN) {
  console.error(
    'ONDEMAND_API_KEY is required for --mode direct (read from the environment only -- this script never accepts a key as a command-line argument). Aborting.',
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// --dry-run: print the 10 planned requests for the selected mode, no network
// ---------------------------------------------------------------------------

function proxyUrl(p) {
  return `${PROXY_BASE}/${p}`;
}

function buildDryPlan() {
  const sid = '<sessionId>';
  const eid = '<executionId>';
  if (MODE === 'proxy') {
    return [
      `STEP 1/10 session create + reuse \u2014 POST ${proxyUrl('sessions')} body:{userId} (then POST again, expect reused:true)`,
      `STEP 2/10 sync prompt \u2014 POST ${proxyUrl('chat')} body:{sessionId,query,responseMode${FULFILLMENT_ENDPOINT_ID ? ',endpointId' : ''}}`,
      `STEP 3/10 SSE stream \u2014 POST ${proxyUrl('chat')} body:{sessionId,query,responseMode}`,
      `STEP 4/10 built-in tool/plugin invocation \u2014 GET ${proxyUrl('health?envNames=1')} (gate) then POST ${proxyUrl('chat')} body:{sessionId,query,responseMode}`,
      `STEP 5/10 STT on in-script generated WAV \u2014 POST ${proxyUrl('media')} body:{file,name,sessionId,plugins,sizeBytes,responseMode} then POST ${proxyUrl('stt')} body:{audioUrl}`,
      `STEP 6/10 TTS \u2014 POST ${proxyUrl('tts?format=audio')} body:{input,voice,model}`,
      `STEP 7/10 Media PNG analysis \u2014 POST ${proxyUrl('media')} body:{file,name,sessionId,plugins,sizeBytes,responseMode}`,
      `STEP 8/10 workflow \u2014 GET ${proxyUrl('health?envNames=1')} (gate) then POST ${proxyUrl('workflow?action=execute')} then GET ${proxyUrl('workflow?action=status&executionId=')}${eid}`,
      `STEP 9/10 session-memory follow-up \u2014 POST ${proxyUrl('chat')} body:{sessionId,query,responseMode}`,
      `STEP 10/10 latency summary \u2014 (no network; computed from steps 1-9)`,
    ];
  }
  return [
    `STEP 1/10 session create + reuse \u2014 POST ${CHAT}/sessions body:{externalUserId,pluginIds} then GET ${CHAT}/sessions/${sid}`,
    `STEP 2/10 sync prompt \u2014 POST ${CHAT}/sessions/${sid}/query body:{query,endpointId,responseMode,pluginIds}`,
    `STEP 3/10 SSE stream \u2014 POST ${CHAT}/sessions/${sid}/query body:{query,endpointId,responseMode,pluginIds}`,
    `STEP 4/10 built-in tool/plugin invocation \u2014 POST ${CHAT}/sessions/${sid}/query body:{query,endpointId,responseMode,pluginIds} (pluginIds from env, else SKIP)`,
    `STEP 5/10 STT on in-script generated WAV \u2014 POST ${MEDIA}/raw body:{file,name,sessionId,plugins,sizeBytes,responseMode} then POST ${SERVICES}/execute/speech_to_text body:{audioUrl}`,
    `STEP 6/10 TTS \u2014 POST ${SERVICES}/execute/text_to_speech body:{input,voice,model}`,
    `STEP 7/10 Media PNG analysis \u2014 POST ${MEDIA}/raw body:{file,name,sessionId,plugins,sizeBytes,responseMode}`,
    `STEP 8/10 workflow \u2014 POST ${AUTOMATION}/workflow/${SPATIAL_FLOW_ID || '<flowId>'}/execute (no body) then GET ${AUTOMATION}/execution/${eid} (else SKIP if ONDEMAND_SPATIAL_FLOW_ID unset)`,
    `STEP 9/10 session-memory follow-up \u2014 POST ${CHAT}/sessions/${sid}/query body:{query,endpointId,responseMode,pluginIds}`,
    `STEP 10/10 latency summary \u2014 (no network; computed from steps 1-9)`,
  ];
}

if (DRY_RUN) {
  for (const line of buildDryPlan()) console.log(line);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// HTTP plumbing (never logs headers; never prints process.env)
// ---------------------------------------------------------------------------

class Skip extends Error {}

class StepHttpError extends Error {
  constructor(status, contentType, bodyExcerpt) {
    super(
      `HTTP ${status} (${contentType || 'no content-type'}): ${bodyExcerpt}`,
    );
    this.status = status;
    this.contentType = contentType;
    this.bodyExcerpt = bodyExcerpt;
  }
}

/** Collapse response text to a single-line, capped excerpt -- keeps a STEP
 * console line on one line even when the upstream error page is multi-line
 * HTML/plaintext (e.g. a platform 404 page). */
function excerptOf(text) {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_BODY_EXCERPT
    ? collapsed.slice(0, MAX_BODY_EXCERPT)
    : collapsed;
}

/** Format (and throw) a non-2xx response, with a friendlier message for the
 * "this proxy base doesn't even have the route" case (task spec §C). */
function throwHttpOrProxyError(status, contentType, bodyExcerpt) {
  if (MODE === 'proxy' && status === 404) {
    throw new Error(
      `proxy route not present at ${PROXY_BASE} (HTTP 404 ${bodyExcerpt})`,
    );
  }
  throw new StepHttpError(status, contentType, bodyExcerpt);
}

/** Bare fetch wrapper: JSON-encodes a plain-object body, adds `apikey` only
 * in direct mode, and always applies a request timeout. Never adds any
 * header a caller didn't ask for besides those two. */
async function doFetch(url, init = {}, timeoutMs = TIMEOUT_MS) {
  const headers = { ...(init.headers || {}) };
  let body = init.body;
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const isBuffer = Buffer.isBuffer(body);
  if (
    body !== undefined &&
    body !== null &&
    !isForm &&
    !isBuffer &&
    typeof body !== 'string'
  ) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  if (MODE === 'direct' && !init.noKey) {
    headers.apikey = API_KEY;
  }
  const res = await fetch(url, {
    method: init.method || 'GET',
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Remembered per step so the JSON report can carry the HTTP status of the
  // step's final upstream call (reset by runStep before each step runs).
  lastHttpStatus = res.status;
  return res;
}

/** doFetch + response-body handling: throws StepHttpError-or-friendlier on a
 * non-2xx response, throws on non-JSON, otherwise returns {status,
 * contentType, json}. Never includes request headers in any error. */
async function fetchJson(url, init = {}, timeoutMs = TIMEOUT_MS) {
  let res;
  try {
    res = await doFetch(url, init, timeoutMs);
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new Error(
      timedOut
        ? `request timed out after ${timeoutMs}ms`
        : `network error: ${err?.message || String(err)}`,
    );
  }
  const contentType = res.headers.get('content-type') || '';
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  if (!res.ok) throwHttpOrProxyError(res.status, contentType, excerptOf(text));
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `non-JSON 2xx response (${contentType || 'no content-type'}): ${excerptOf(text)}`,
    );
  }
  return { status: res.status, contentType, json };
}

/** Read an SSE response body (verbatim event:/data: framing, tolerant of
 * `data:` with or without a following space) and summarize it. */
async function readSseStream(url, body, { collectStatusLogs = false } = {}) {
  const startedAt = Date.now();
  const res = await doFetch(url, { method: 'POST', body }, SSE_TIMEOUT_MS);
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    throwHttpOrProxyError(res.status, contentType, excerptOf(text));
  }
  if (!contentType.startsWith('text/event-stream')) {
    throw new Error(
      `Content-Type does not start with text/event-stream: "${contentType}"`,
    );
  }

  let buf = '';
  let event = 'message';
  let sawDone = false;
  let sawError = null;
  let sawHeartbeat = false;
  let fulfillmentDeltas = 0;
  let timeToFirstDeltaMs = null;
  const statusLogs = [];
  const decoder = new TextDecoder();

  outer: for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
        if (event === 'heartbeat') sawHeartbeat = true;
        continue;
      }
      if (!line.startsWith('data:')) continue;
      const data = line.slice('data:'.length).trim(); // tolerant of "data:{" (no space)
      if (data === '') continue;
      if (data === '[DONE]') {
        sawDone = true;
        break outer;
      }
      if (data.startsWith('[ERROR]:')) {
        sawError = data.slice('[ERROR]:'.length);
        break outer;
      }
      if (event === 'heartbeat') continue;
      let evt;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      if (evt.eventType === 'fulfillment' || typeof evt.answer === 'string') {
        fulfillmentDeltas += 1;
        if (timeToFirstDeltaMs === null)
          timeToFirstDeltaMs = Date.now() - startedAt;
      }
      if (
        collectStatusLogs &&
        evt.eventType === 'statusLog' &&
        evt.currentStatusLog
      ) {
        statusLogs.push(evt.currentStatusLog);
      }
    }
  }

  return {
    contentType,
    sawDone,
    sawError,
    sawHeartbeat,
    fulfillmentDeltas,
    timeToFirstDeltaMs,
    statusLogs,
  };
}

function buildStreamRequest(query, { pluginIds } = {}) {
  if (MODE === 'proxy') {
    const body = { sessionId, query, responseMode: 'stream' };
    if (pluginIds !== undefined) body.pluginIds = pluginIds;
    return { url: proxyUrl('chat'), body };
  }
  const body = {
    query,
    endpointId: FULFILLMENT_ENDPOINT_ID || DIRECT_DEFAULT_ENDPOINT_ID,
    responseMode: 'stream',
    pluginIds: pluginIds !== undefined ? pluginIds : [],
  };
  return {
    url: `${CHAT}/sessions/${encodeURIComponent(sessionId)}/query`,
    body,
  };
}

// ---------------------------------------------------------------------------
// In-memory media generation (WAV for STT, PNG for image analysis)
// ---------------------------------------------------------------------------

/** 16 kHz mono 16-bit PCM WAV, 1.2s: a 1.0s 440 Hz tone + a 0.2s silence tail. */
function generateWav() {
  const sampleRate = 16000;
  const totalSamples = Math.round(sampleRate * 1.2);
  const toneSamples = Math.round(sampleRate * 1.0);
  const freq = 440;
  const amplitude = 0.3 * 32767;

  const data = Buffer.alloc(totalSamples * 2);
  for (let i = 0; i < totalSamples; i++) {
    const sample =
      i < toneSamples
        ? Math.round(
            amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate),
          )
        : 0;
    data.writeInt16LE(sample, i * 2);
  }

  const byteRate = sampleRate * 2; // mono, 16-bit
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format: PCM
  header.writeUInt16LE(1, 22); // channels: mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** A valid 32x32 8-bit RGB PNG with a simple checkerboard pattern, encoded
 * by hand (IHDR/IDAT/IEND + deflateSync + a from-scratch CRC32 table). */
function generatePng() {
  const width = 32;
  const height = 32;

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: RGB
  ihdrData[10] = 0; // compression method
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace method

  const rowBytes = width * 3;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0; // per-scanline filter type: none
    for (let x = 0; x < width; x++) {
      const idx = rowStart + 1 + x * 3;
      const on = ((x >> 2) + (y >> 2)) % 2 === 0;
      raw[idx] = on ? 255 : 30;
      raw[idx + 1] = on ? 60 : 200;
      raw[idx + 2] = on ? 60 : 220;
    }
  }

  const png = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdrData),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('generated PNG missing a valid 8-byte signature');
  }
  return png;
}

async function uploadRawMedia({ bytes, mimeType, filename, pluginId }) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: mimeType }), filename);
  fd.append('name', filename);
  fd.append('sessionId', sessionId);
  fd.append('plugins', pluginId);
  fd.append('sizeBytes', String(bytes.length));
  fd.append('responseMode', 'sync');
  const url = MODE === 'proxy' ? proxyUrl('media') : `${MEDIA}/raw`;
  const { json } = await fetchJson(url, { method: 'POST', body: fd });
  return json;
}

async function assertAudioResponse(res) {
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    throwHttpOrProxyError(res.status, contentType, excerptOf(text));
  }
  if (res.status !== 200)
    throw new Error(`expected HTTP 200, got ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('audio response had zero bytes');
  // §6.2 only promises "the URL of the audio file" (the sample is an .mp3);
  // the object store that serves it may label the bytes as
  // application/octet-stream (observed live 2026-09-18). Accept an audio/*
  // Content-Type, or a generic octet-stream whose bytes carry a recognisable
  // audio container signature.
  const container = audioContainerOf(buf);
  const genericType =
    contentType === '' || contentType.startsWith('application/octet-stream');
  if (!contentType.startsWith('audio/') && !(genericType && container)) {
    throw new Error(
      `Content-Type "${contentType}" is not audio/* and the bytes carry no known audio signature`,
    );
  }
  return {
    value: true,
    contentType,
    bytes: buf.length,
    detail: `contentType=${contentType || 'none'} bytes=${buf.length} container=${container || 'n/a'}`,
  };
}

/** Sniff the audio container from the leading bytes (MP3 ID3 tag or frame
 * sync, RIFF/WAVE, OGG, FLAC, or an MP4/M4A ftyp box). Null when unknown. */
function audioContainerOf(buf) {
  if (buf.length < 12) return null;
  const head4 = buf.subarray(0, 4).toString('latin1');
  if (head4.startsWith('ID3')) return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  if (head4 === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE')
    return 'wav';
  if (head4 === 'OggS') return 'ogg';
  if (head4 === 'fLaC') return 'flac';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  return null;
}

// ---------------------------------------------------------------------------
// Step runner
// ---------------------------------------------------------------------------

let sessionId;
let CODEWORD = '';
let summary = null;
const stepsReport = [];
const stepStatus = {};
let passedCount = 0;
let failedCount = 0;
let skippedCount = 0;

let lastHttpStatus = null;

async function runStep(n, name, { dependsOn = [], run }) {
  const utc = nowIso();
  lastHttpStatus = null;
  const depFail = dependsOn.find(
    (d) => stepStatus[d] && stepStatus[d] !== 'PASS',
  );
  if (depFail !== undefined) {
    const reason = `dependency: step ${depFail} failed`;
    stepStatus[n] = 'SKIP';
    skippedCount += 1;
    console.log(`STEP ${n}/10 ${name} ${utc} \u2026 SKIP (0ms) [${reason}]`);
    stepsReport.push({
      step: n,
      name,
      ok: false,
      skipped: true,
      skipReason: reason,
      latencyMs: 0,
      utc,
      httpStatus: null,
    });
    return undefined;
  }

  const start = Date.now();
  try {
    const result = (await run()) || {};
    const ms = Date.now() - start;
    const { value, ...extra } = result;
    stepStatus[n] = 'PASS';
    passedCount += 1;
    console.log(
      `STEP ${n}/10 ${name} ${utc} \u2026 PASS (${ms}ms)${extra.detail ? ` [${extra.detail}]` : ''}`,
    );
    stepsReport.push({
      step: n,
      name,
      ok: true,
      skipped: false,
      skipReason: null,
      latencyMs: ms,
      utc,
      httpStatus: lastHttpStatus,
      ...extra,
    });
    return value;
  } catch (err) {
    const ms = Date.now() - start;
    if (err instanceof Skip) {
      stepStatus[n] = 'SKIP';
      skippedCount += 1;
      console.log(
        `STEP ${n}/10 ${name} ${utc} \u2026 SKIP (${ms}ms) [${err.message}]`,
      );
      stepsReport.push({
        step: n,
        name,
        ok: false,
        skipped: true,
        skipReason: err.message,
        latencyMs: ms,
        utc,
        httpStatus: lastHttpStatus,
      });
      return undefined;
    }
    stepStatus[n] = 'FAIL';
    failedCount += 1;
    console.log(
      `STEP ${n}/10 ${name} ${utc} \u2026 FAIL (${ms}ms) [${err.message}]`,
    );
    stepsReport.push({
      step: n,
      name,
      ok: false,
      skipped: false,
      skipReason: null,
      latencyMs: ms,
      utc,
      httpStatus: lastHttpStatus,
      error: err.message,
    });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The 10 steps
// ---------------------------------------------------------------------------

async function step1() {
  if (MODE === 'proxy') {
    const first = await fetchJson(proxyUrl('sessions'), {
      method: 'POST',
      body: { userId: EXTERNAL_USER_ID },
    });
    if (first.status !== 201)
      throw new Error(`expected HTTP 201 on first create, got ${first.status}`);
    if (first.json?.reused !== false)
      throw new Error('expected reused:false on first create');
    const sid = first.json?.sessionId;
    if (!sid) throw new Error('sessionId missing/empty in create response');

    const second = await fetchJson(proxyUrl('sessions'), {
      method: 'POST',
      body: { userId: EXTERNAL_USER_ID },
    });
    if (second.status !== 200)
      throw new Error(`expected HTTP 200 on reuse, got ${second.status}`);
    if (second.json?.reused !== true)
      throw new Error('expected reused:true on second create');
    if (second.json?.sessionId !== sid)
      throw new Error('sessionId changed between create and reuse');

    return { value: sid, detail: `sessionId=${sid}` };
  }

  const created = await fetchJson(`${CHAT}/sessions`, {
    method: 'POST',
    body: { externalUserId: EXTERNAL_USER_ID, pluginIds: [] },
  });
  const sid = created.json?.data?.id;
  if (!sid) throw new Error('data.id missing/empty in create-session response');

  const fetched = await fetchJson(
    `${CHAT}/sessions/${encodeURIComponent(sid)}`,
    { method: 'GET' },
  );
  if (fetched.json?.data?.id !== sid)
    throw new Error(
      'GET session id does not match created session (reuse check)',
    );

  return { value: sid, detail: `sessionId=${sid}` };
}

async function step2() {
  const codeword = `AMBER-${crypto.randomBytes(3).toString('hex')}`;
  CODEWORD = codeword;
  const query = `Remember this code word and reply only with "OK": ${codeword}`;

  let json;
  if (MODE === 'proxy') {
    const body = { sessionId, query, responseMode: 'sync' };
    if (FULFILLMENT_ENDPOINT_ID) body.endpointId = FULFILLMENT_ENDPOINT_ID;
    ({ json } = await fetchJson(proxyUrl('chat'), { method: 'POST', body }));
  } else {
    const body = {
      query,
      endpointId: FULFILLMENT_ENDPOINT_ID || DIRECT_DEFAULT_ENDPOINT_ID,
      responseMode: 'sync',
      pluginIds: [],
    };
    ({ json } = await fetchJson(
      `${CHAT}/sessions/${encodeURIComponent(sessionId)}/query`,
      { method: 'POST', body },
    ));
  }
  const answer = json?.data?.answer;
  if (typeof answer !== 'string' || answer.length === 0)
    throw new Error('data.answer missing or empty');
  return { value: answer, detail: `answer.length=${answer.length}` };
}

async function step3() {
  const { url, body } = buildStreamRequest('In one sentence, what is a TLE?');
  const r = await readSseStream(url, body);
  if (r.sawError)
    throw new Error(
      `stream reported [ERROR]: ${String(r.sawError).slice(0, 200)}`,
    );
  if (!r.sawDone)
    throw new Error(
      'no data:[DONE] terminal marker observed before the stream ended',
    );
  const out = {
    value: true,
    contentType: r.contentType,
    detail: `heartbeat=${r.sawHeartbeat} fulfillmentDeltas=${r.fulfillmentDeltas}`,
  };
  if (r.timeToFirstDeltaMs !== null) {
    out.timeToFirstDeltaMs = r.timeToFirstDeltaMs;
    out.detail += ` timeToFirstDeltaMs=${r.timeToFirstDeltaMs}`;
  }
  return out;
}

function assertToolInvocation(r) {
  if (r.sawError)
    throw new Error(
      `stream reported [ERROR]: ${String(r.sawError).slice(0, 200)}`,
    );
  const wanted = new Set([
    'agents_retrieved',
    'executing',
    'execution_completed',
  ]);
  const hit = r.statusLogs.find(
    (s) =>
      wanted.has(s.statusType) &&
      ((Array.isArray(s.retrievedAgents) && s.retrievedAgents.length > 0) ||
        (Array.isArray(s.executedAgents) && s.executedAgents.length > 0)),
  );
  if (!hit)
    throw new Error(
      'no statusLog frame with a non-empty retrievedAgents/executedAgents array observed',
    );
  const agents = [...(hit.retrievedAgents || []), ...(hit.executedAgents || [])]
    .map((a) => a.name || a.identifier || a.agentId)
    .filter(Boolean);
  return {
    value: agents,
    contentType: r.contentType,
    detail: `statusType=${hit.statusType} agents=${agents.join('|')}`,
  };
}

async function step4() {
  const query =
    'Use your tools to look up something small and tell me what tool you used.';
  const skipReason =
    'no default plugin configured on the deployment (ONDEMAND_SPATIAL_AGENT_ID / ONDEMAND_KNOWLEDGE_PLUGIN_IDS unset)';

  if (MODE === 'proxy') {
    const health = await fetchJson(proxyUrl('health?envNames=1'), {
      method: 'GET',
    });
    const src = health.json?.env?.sources?.defaultPluginIds;
    if (!src || src === 'unset') throw new Skip(skipReason);
    const { url, body } = buildStreamRequest(query); // no pluginIds -- proxy applies the deployment default
    return assertToolInvocation(
      await readSseStream(url, body, { collectStatusLogs: true }),
    );
  }

  let pluginIds = SPATIAL_AGENT_IDS;
  if (pluginIds.length === 0) {
    // No id supplied by env: ask the documented Agents API (§8, guide-only
    // `GET /plugin/v1/list`) which agents THIS account actually has, and use
    // the first one; an empty account skips honestly instead of inventing an id.
    const listing = await fetchJson(
      `${BASE_URL}/plugin/v1/list?page=1&limit=50`,
      {
        method: 'GET',
      },
    );
    const plugins = listing.json?.data?.plugins || [];
    const total = listing.json?.data?.total ?? plugins.length;
    const first = plugins
      .map((p) => p?.pluginId || p?.id)
      .find((id) => typeof id === 'string' && id.length > 0);
    if (!first) {
      throw new Skip(
        `no plugin id in env and the account's Agents API listing is empty (GET /plugin/v1/list -> HTTP ${listing.status}, total=${total}); no documented chat agent id was invented`,
      );
    }
    pluginIds = [first];
  }
  const { url, body } = buildStreamRequest(query, { pluginIds });
  return assertToolInvocation(
    await readSseStream(url, body, { collectStatusLogs: true }),
  );
}

async function step5() {
  const wav = generateWav();
  let media;
  try {
    media = await uploadRawMedia({
      bytes: wav,
      mimeType: 'audio/wav',
      filename: 'tone.wav',
      pluginId: AUDIO_AGENT_PLUGIN_ID,
    });
  } catch (err) {
    throw new Error(`media upload failed: ${err.message}`);
  }
  const audioUrl = media?.data?.url;
  if (typeof audioUrl !== 'string' || !audioUrl)
    throw new Error('media upload response missing data.url');

  let json;
  if (MODE === 'proxy') {
    ({ json } = await fetchJson(proxyUrl('stt'), {
      method: 'POST',
      body: { audioUrl },
    }));
  } else {
    ({ json } = await fetchJson(`${SERVICES}/execute/speech_to_text`, {
      method: 'POST',
      body: { audioUrl },
    }));
  }
  const text = json?.data?.text;
  if (typeof text !== 'string')
    throw new Error('data.text missing or not a string');
  return {
    value: text,
    detail: `mediaId=${media?.data?.id ?? '?'} textLength=${text.length}`,
  };
}

async function step6() {
  const input = "Contract test of the God's Eye View proxy.";
  if (MODE === 'proxy') {
    const res = await doFetch(proxyUrl('tts?format=audio'), {
      method: 'POST',
      body: { input, voice: 'alloy', model: 'tts-1' },
    });
    return assertAudioResponse(res);
  }
  const { json } = await fetchJson(`${SERVICES}/execute/text_to_speech`, {
    method: 'POST',
    body: { input, voice: 'alloy', model: 'tts-1' },
  });
  const audioUrl = json?.data?.audioUrl;
  if (typeof audioUrl !== 'string') throw new Error('data.audioUrl missing');
  const audioRes = await doFetch(audioUrl, { method: 'GET', noKey: true });
  return assertAudioResponse(audioRes);
}

async function step7() {
  const png = generatePng();
  const media = await uploadRawMedia({
    bytes: png,
    mimeType: 'image/png',
    filename: 'probe.png',
    pluginId: IMAGE_AGENT_PLUGIN_ID,
  });
  const data = media?.data;
  if (!data?.id) throw new Error('response missing data.id');
  const hasSignal =
    (typeof data.context === 'string' && data.context.length > 0) ||
    (typeof data.extractedText === 'string' && data.extractedText.length > 0) ||
    (typeof data.actionStatus === 'string' && data.actionStatus.length > 0);
  if (!hasSignal)
    throw new Error(
      'response missing all of data.context / data.extractedText / data.actionStatus',
    );
  const contextPreview =
    typeof data.context === 'string' ? data.context.slice(0, 120) : '';
  return {
    value: data.id,
    detail: `actionStatus=${data.actionStatus ?? '?'}${contextPreview ? ` context="${contextPreview}"` : ''}`,
  };
}

async function step8() {
  const skipReason =
    'ONDEMAND_SPATIAL_FLOW_ID unset on the deployment \u2014 auto-skipped by design';

  if (MODE === 'proxy') {
    const health = await fetchJson(proxyUrl('health?envNames=1'), {
      method: 'GET',
    });
    const src = health.json?.env?.sources?.spatialFlowId;
    if (!src || src === 'unset') throw new Skip(skipReason);
    const exec = await fetchJson(proxyUrl('workflow?action=execute'), {
      method: 'POST',
    });
    const executionId = exec.json?.executionID;
    if (!executionId) throw new Error('response missing executionID');
    const status = await fetchJson(
      proxyUrl(
        `workflow?action=status&executionId=${encodeURIComponent(executionId)}`,
      ),
      {
        method: 'GET',
      },
    );
    return {
      value: executionId,
      detail: `executionId=${executionId} status=${status.json?.data?.status ?? status.json?.status ?? '?'}`,
    };
  }

  if (!SPATIAL_FLOW_ID) throw new Skip(skipReason);
  const exec = await fetchJson(
    `${AUTOMATION}/workflow/${encodeURIComponent(SPATIAL_FLOW_ID)}/execute`,
    { method: 'POST' },
  );
  const executionId = exec.json?.executionID;
  if (!executionId) throw new Error('response missing executionID');
  const status = await fetchJson(
    `${AUTOMATION}/execution/${encodeURIComponent(executionId)}`,
    { method: 'GET' },
  );
  return {
    value: executionId,
    detail: `executionId=${executionId} status=${status.json?.data?.status ?? status.json?.status ?? '?'}`,
  };
}

async function step9() {
  const query =
    'What was the code word I asked you to remember? Reply with the code word only.';
  let json;
  if (MODE === 'proxy') {
    const body = { sessionId, query, responseMode: 'sync' };
    if (FULFILLMENT_ENDPOINT_ID) body.endpointId = FULFILLMENT_ENDPOINT_ID;
    ({ json } = await fetchJson(proxyUrl('chat'), { method: 'POST', body }));
  } else {
    const body = {
      query,
      endpointId: FULFILLMENT_ENDPOINT_ID || DIRECT_DEFAULT_ENDPOINT_ID,
      responseMode: 'sync',
      pluginIds: [],
    };
    ({ json } = await fetchJson(
      `${CHAT}/sessions/${encodeURIComponent(sessionId)}/query`,
      { method: 'POST', body },
    ));
  }
  const answer = json?.data?.answer;
  if (typeof answer !== 'string') throw new Error('data.answer missing');
  if (!CODEWORD || !answer.toUpperCase().includes(CODEWORD.toUpperCase())) {
    throw new Error(
      `answer does not contain the code word (answer excerpt: "${answer.slice(0, 120)}")`,
    );
  }
  return { value: answer, detail: 'answer contains the step-2 code word' };
}

async function step10() {
  const latencies = stepsReport
    .filter((s) => !s.skipped)
    .map((s) => s.latencyMs);
  const totalMs = latencies.reduce((a, b) => a + b, 0);
  const minMs = latencies.length ? Math.min(...latencies) : 0;
  const maxMs = latencies.length ? Math.max(...latencies) : 0;
  const meanMs = latencies.length ? Math.round(totalMs / latencies.length) : 0;
  summary = {
    passed: passedCount,
    failed: failedCount,
    skipped: skippedCount,
    totalMs,
    minMs,
    maxMs,
    meanMs,
  };
  return {
    value: summary,
    detail: `min=${minMs}ms max=${maxMs}ms mean=${meanMs}ms totalMs=${totalMs}`,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  sessionId = await runStep(1, 'session create + reuse', { run: step1 });
  await runStep(2, 'sync prompt', { dependsOn: [1], run: step2 });
  await runStep(3, 'SSE stream', { dependsOn: [1], run: step3 });
  await runStep(4, 'built-in tool/plugin invocation', {
    dependsOn: [1],
    run: step4,
  });
  await runStep(5, 'STT on in-script generated WAV', {
    dependsOn: [1],
    run: step5,
  });
  await runStep(6, 'TTS', { dependsOn: [1], run: step6 });
  await runStep(7, 'Media PNG analysis', { dependsOn: [1], run: step7 });
  await runStep(8, 'workflow', { dependsOn: [1], run: step8 });
  await runStep(9, 'session-memory follow-up', {
    dependsOn: [1, 2],
    run: step9,
  });
  await runStep(10, 'latency summary', { run: step10 });

  // step10 snapshots the counters before its own PASS is recorded; refresh so
  // the JSON summary and the CONTRACT RESULT line agree.
  if (summary) {
    summary = {
      ...summary,
      passed: passedCount,
      failed: failedCount,
      skipped: skippedCount,
    };
  }

  if (!summary) {
    summary = {
      passed: passedCount,
      failed: failedCount,
      skipped: skippedCount,
      totalMs: 0,
      minMs: 0,
      maxMs: 0,
      meanMs: 0,
    };
  }

  if (JSON_OUT) {
    const report = {
      generatedAtUtc: nowIso(),
      mode: MODE,
      proxyBase: MODE === 'proxy' ? PROXY_BASE : undefined,
      externalUserId: EXTERNAL_USER_ID,
      sessionId: sessionId || null,
      steps: stepsReport,
      summary,
    };
    fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
  }

  console.log(
    `CONTRACT RESULT: mode=${MODE} passed=${passedCount} failed=${failedCount} skipped=${skippedCount} totalMs=${summary.totalMs}`,
  );
  process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(
    'Unexpected contract-test crash:',
    err?.stack || err?.message || err,
  );
  console.log(
    `CONTRACT RESULT: mode=${MODE} passed=${passedCount} failed=${failedCount + 1} skipped=${skippedCount} totalMs=0`,
  );
  process.exit(1);
});
