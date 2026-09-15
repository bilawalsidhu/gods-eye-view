import { defaultSourceRoot } from '../common/source-root.js';
import path from 'node:path';
import { readRequestBody } from '../common/request.js';
import fs from 'node:fs';

const REALTIME_DEBUG_LOG_MAX_BYTES = 8 * 1024 * 1024;

function createDebugLogHandler({ sourceRoot = defaultSourceRoot } = {}) {
  const REALTIME_DEBUG_LOG_DIR = path.join(sourceRoot, '.gev-logs');
  const REALTIME_DEBUG_LOG_FILE = path.join(
    REALTIME_DEBUG_LOG_DIR,
    'realtime-conversations.jsonl',
  );
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    try {
      const body = await readRequestBody(req, REALTIME_DEBUG_LOG_MAX_BYTES);
      const record = JSON.parse(body || '{}');
      fs.mkdirSync(REALTIME_DEBUG_LOG_DIR, { recursive: true });
      fs.appendFileSync(
        REALTIME_DEBUG_LOG_FILE,
        `${JSON.stringify({
          loggedAt: new Date().toISOString(),
          ...record,
        })}\n`,
      );
      res.statusCode = 204;
      res.end();
    } catch (error) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: error?.message || 'Failed to write Realtime debug log',
        }),
      );
    }
  };
}

export { createDebugLogHandler };
