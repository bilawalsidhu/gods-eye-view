import { defaultSourceRoot } from '../common/source-root.js';
import path from 'node:path';
import { readRequestBody } from '../common/request.js';
import { promises as fsp } from 'node:fs';
import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { allowedMethods } from '../common/methods.js';

/** Cap on one request body. */
const REALTIME_DEBUG_LOG_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Ceiling for the live log before it rotates. One generation is kept
 * (`…jsonl.1`), so the sink is bounded at twice this however long a session
 * runs. REALTIME_DEBUG_LOG_MAX_BYTES caps a single request; it never bounded
 * the file those requests accumulate into.
 */
const REALTIME_DEBUG_LOG_MAX_FILE_BYTES = 32 * 1024 * 1024;

/**
 * Per-IP write ceiling. Always on, unlike the opt-in limiter the cost-bearing
 * OpenAI routes share: throttling those by default would change what a user
 * spends, while this sink spends disk and event-loop time. A voice session
 * writes far below this, so the cap needs no configuration to stay invisible.
 */
const REALTIME_DEBUG_LOG_MAX_PER_MIN = 120;

/**
 * Fields that carry what people said or heard: transcripts, typed and spoken
 * text, streamed deltas, tool arguments/results and the span's quoted
 * replies. They are dropped from the persisted log unless content logging is explicitly enabled
 * (GEV_VOICE_LOG_CONTENT=1), so timing and tool diagnostics never retain
 * speech by default.
 */
const VOICE_TEXT_FIELDS = new Set([
  'transcript',
  'text',
  'delta',
  'answer_text',
  'preamble_text',
]);
const VOICE_CONTENT_MAX_DEPTH = 12;
const VOICE_CONTENT_MAX_DEPTH_MARKER = '[omitted: max depth]';

/** Replace spoken or typed content and complete tool argument/result bodies. */
function omitVoiceContent(value, depth = 0) {
  if (depth > VOICE_CONTENT_MAX_DEPTH) return VOICE_CONTENT_MAX_DEPTH_MARKER;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value))
    return value.map((item) => omitVoiceContent(item, depth + 1));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    // Tool bodies have open-ended schemas: omit the whole body rather than
    // chasing query, label, say, display, or future tool-specific fields.
    // Protocol response.output arrays still carry useful event metadata; only
    // string output is a serialized function result and must be opaque.
    if (
      key === 'arguments' ||
      key === 'result' ||
      (key === 'output' && typeof item === 'string')
    ) {
      output[key] =
        typeof item === 'string'
          ? `[omitted ${item.length} chars]`
          : '[omitted]';
      continue;
    }
    if (VOICE_TEXT_FIELDS.has(key) && typeof item === 'string') {
      output[key] = `[omitted ${item.length} chars]`;
      continue;
    }
    output[key] = omitVoiceContent(item, depth + 1);
  }
  return output;
}

function createDebugLogHandler({
  sourceRoot = defaultSourceRoot,
  includeContent = process.env.GEV_VOICE_LOG_CONTENT === '1',
} = {}) {
  const logDir = path.join(sourceRoot, '.gev-logs');
  const logFile = path.join(logDir, 'realtime-conversations.jsonl');
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: REALTIME_DEBUG_LOG_MAX_PER_MIN,
    globalMax: 400,
  });

  // Appends are chained rather than fired concurrently because the rotation
  // check is a read-then-write on file size: run in parallel, every caller
  // stats a file still under the ceiling, none of them rotates, and the log
  // grows past it. The records themselves are O_APPEND and never interleave.
  let queue = Promise.resolve();

  function append(line) {
    const done = queue.then(async () => {
      await fsp.mkdir(logDir, { recursive: true });
      const size = await fsp.stat(logFile).then(
        (stat) => stat.size,
        () => 0,
      );
      if (size + Buffer.byteLength(line) > REALTIME_DEBUG_LOG_MAX_FILE_BYTES) {
        // Node does not replace an existing destination on Windows. Remove the
        // retained generation explicitly so every rotation behaves the same on
        // supported platforms rather than failing after the first 64 MB.
        await fsp.rm(`${logFile}.1`, { force: true });
        await fsp.rename(logFile, `${logFile}.1`);
      }
      await fsp.appendFile(logFile, line);
    });
    // The caller still sees its own rejection, but one failed append must not
    // poison the chain for every request queued behind it.
    queue = done.catch(() => {});
    return done;
  }

  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Allow', allowedMethods('POST'));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    if (!allow(clientKey(req))) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '60',
      });
      res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
      return;
    }

    try {
      const body = await readRequestBody(req, REALTIME_DEBUG_LOG_MAX_BYTES);
      const parsed = JSON.parse(body || '{}');
      const record = includeContent ? parsed : omitVoiceContent(parsed);
      // The server's own timestamp comes last, so a record cannot supply one.
      await append(
        `${JSON.stringify({
          ...record,
          loggedAt: new Date().toISOString(),
        })}\n`,
      );
      res.statusCode = 204;
      res.end();
    } catch (error) {
      // A malformed record or an oversized body is the caller's fault; a failed
      // write is ours, and only the second is worth a log line. Neither answer
      // carries the error text, which for an fs failure is an errno and an
      // absolute path.
      const callerFault =
        error instanceof SyntaxError || error?.code === 'BODY_TOO_LARGE';
      if (!callerFault) console.warn('[realtime-debug-log] append failed');
      res.statusCode = callerFault ? 400 : 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Failed to write Realtime debug log' }));
    }
  };
}

export { createDebugLogHandler, omitVoiceContent };
