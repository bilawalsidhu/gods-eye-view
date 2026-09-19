import { getServerlessApi } from '../server/serverless/app.js';
import {
  rehydrateBody,
  resolveRequestUrl,
} from '../server/serverless/vercel-adapter.js';

/**
 * Single Vercel Serverless Function fronting every `/api/*` route.
 *
 * Vercel's filesystem router matches a literal file (e.g. `api/ondemand/chat.js`)
 * before this dynamic catch-all, so this function only ever sees requests no
 * more specific function claimed. It rebuilds the request into the plain-Node
 * `(req, res)` shape the existing Vite provider middlewares
 * (server/providers/**) already expect, and hands it to the same
 * Connect-compatible router the local dev/preview server would have used —
 * see server/serverless/app.js and docs/SERVERLESS_LIMITATIONS.md.
 */
export default async function handler(req, res) {
  req.url = resolveRequestUrl(req);
  rehydrateBody(req);
  const api = await getServerlessApi();
  await api.handle(req, res);
}
