/**
 * Capture the exact Realtime session config production mints.
 *
 * Rather than re-typing the session fields, this drives the production token
 * handler (`server/providers/openai/realtime.js`) with a fake upstream fetch
 * and returns the body it would have POSTed to OpenAI. Instructions, tools,
 * tool_choice, reasoning, and truncation therefore cannot drift from what a
 * real GEV mic session receives.
 */
import { createRealtimeTokenHandler } from '../../server/providers/openai/realtime.js';
import { realtimeInstructions } from '../../server/providers/openai/instructions.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';

export { realtimeInstructions, GEV_REALTIME_TOOLS };

/** Return production's `{ session: {...} }` client-secret body for `model`. */
export async function captureProductionSession(model) {
  let captured = null;
  const handler = createRealtimeTokenHandler({
    resolveApiKey: () => 'bench-placeholder',
    models: { standard: model, mini: model },
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(init.body);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    end() {},
  };
  await handler({ method: 'POST', url: '/api/realtime/token', headers: {}, socket: {} }, res);
  if (!captured?.session) throw new Error('production token handler did not produce a session config');
  return captured.session;
}
