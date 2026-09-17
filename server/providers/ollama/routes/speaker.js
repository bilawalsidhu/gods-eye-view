import { readRequestBody } from '../../common/request.js';
import { sharedAudioWorker } from '../worker.js';
import {
  activeVoiceSession,
  runSpeakerOp,
  sharedProfileStore,
} from '../speaker.js';

/**
 * POST /api/voice/speaker {op:'enroll'|'identify'|'forget'|'list', name?, wav?}
 * GET lists profiles. `wav` is an optional base64 16 kHz WAV; without it,
 * enroll and identify use the most recent voice session's last utterances.
 * The browser tool pack (src/voice/tools/speaker.js) is the only caller.
 */
export const SPEAKER_ROUTE = '/api/voice/speaker';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function respond(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function createSpeakerHandler({
  // Resolved per request: the voice socket creates the shared worker with its
  // own logger, and this route must not create it first without one.
  getWorker = () => sharedAudioWorker(),
  store = sharedProfileStore(),
  getSession = activeVoiceSession,
  threshold,
} = {}) {
  return async (req, res) => {
    let body;
    if (req.method === 'GET') body = { op: 'list' };
    else if (req.method !== 'POST')
      return respond(res, 405, { ok: false, error: 'Method not allowed' });
    else {
      try {
        body = JSON.parse((await readRequestBody(req, MAX_BODY_BYTES)) || '{}');
      } catch (error) {
        return respond(res, 400, {
          ok: false,
          error: error?.message || 'Invalid JSON body',
        });
      }
    }
    try {
      const result = await runSpeakerOp(body, {
        worker: getWorker(),
        store,
        session: getSession(),
        threshold,
      });
      respond(res, result.status, result.body);
    } catch (error) {
      respond(res, 500, {
        ok: false,
        error: error?.message || 'Speaker request failed',
      });
    }
  };
}

export function install(middlewares) {
  middlewares.use(SPEAKER_ROUTE, createSpeakerHandler());
}
