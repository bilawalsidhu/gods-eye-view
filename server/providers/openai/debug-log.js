import { defaultSourceRoot } from '../common/source-root.js';
import path from 'node:path';
import { readRequestBody } from '../common/request.js';
import { promises as fsp } from 'node:fs';
import { makeRateLimiter, clientKey } from '../common/rate-limit.js';

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

function createDebugLogHandler({ sourceRoot = defaultSourceRoot } = {}) {
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
      const record = JSON.parse(body || '{}');
      // SECURITY: strip keys that would corrupt the log record's integrity.
      // The spread MUST come BEFORE loggedAt so a client-supplied timestamp
      // can never override the server-generated one (log forgery). Also strip
      // prototype-pollution keys that could corrupt JSON tooling downstream.
      delete record.loggedAt;
      delete record.__proto__;
      delete record.constructor;
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

export { createDebugLogHandler };
