// functions/api/openzenith/[[path]].js
/**
 * `/api/openzenith/<kind>` — Cloudflare Pages Function (catch-all).
 *
 * Thin wrapper: the whole contract (allowlisted kinds, validation, the cache
 * tiers, stale-on-error) lives in `_handler.js` so the dev middleware in
 * `vite.config.js` executes the SAME code instead of a forked copy. See that
 * module for the full contract and cache documentation.
 */
import { handleOpenZenithRequest } from './_handler.js';

export async function onRequest(context) {
  return handleOpenZenithRequest(context.request, context.env);
}
