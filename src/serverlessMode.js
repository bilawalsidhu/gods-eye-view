/**
 * Serverless-deployment notice banner.
 *
 * `VITE_SERVERLESS_MODE` is a Vite build-time flag (set for the build the
 * Vercel deployment runs — see vercel.json's `buildCommand`). When it is on,
 * a couple of features that need a persistent server process instead of a
 * Vercel Function — the live-vessel AISStream relay
 * (src/sources/live/standalone.js `createAisStreamSource`) and voice
 * control's OpenAI Realtime token minting (src/voice/realtimeBackend.js
 * `requestToken`) — are short-circuited at their source rather than left to
 * fail per-request against an endpoint that can only ever answer 501 for
 * them (see server/serverless/app.js). This module is the user-visible half
 * of that: a small, dismissible, non-blocking banner naming what is off.
 *
 * Deliberately imported ONLY from src/main.js. Nothing else in the app
 * reaches this module, so it never has to satisfy
 * scripts/check-import-directions.mjs's portable-export / browser-global
 * rules for any Node-reachable graph (package.json's `exports` map has no
 * entry pointing here) — see that script's `portableExport` roots.
 */

const DISMISSED_KEY = 'gev.serverlessNoticeDismissed';

/** True only in a build produced with VITE_SERVERLESS_MODE=true (see vercel.json). */
function isServerlessBuild() {
  return ['true', '1', 'yes'].includes(
    String(import.meta.env?.VITE_SERVERLESS_MODE ?? '').toLowerCase(),
  );
}

/**
 * Inject the notice banner, once, when this is a serverless build. No-op
 * (returns null) otherwise, or if the visitor already dismissed it this
 * session.
 * @param {Document} [doc]
 * @returns {HTMLElement|null}
 */
function installServerlessNotice(doc = document) {
  if (!isServerlessBuild()) return null;
  try {
    if (window.sessionStorage?.getItem(DISMISSED_KEY) === '1') return null;
  } catch {
    /* storage may be unavailable (private browsing); show the notice anyway */
  }

  const banner = doc.createElement('div');
  banner.setAttribute('role', 'status');
  banner.setAttribute('data-gev-serverless-notice', '');
  banner.style.cssText = [
    'position:fixed',
    'left:12px',
    'right:12px',
    'bottom:12px',
    'z-index:2147483000',
    'max-width:640px',
    'margin:0 auto',
    'padding:10px 14px',
    'border-radius:8px',
    'background:rgba(20,20,24,0.92)',
    'color:#f2f2f2',
    'font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
    'box-shadow:0 4px 18px rgba(0,0,0,0.35)',
    'display:flex',
    'align-items:flex-start',
    'gap:10px',
  ].join(';');

  const text = doc.createElement('span');
  text.style.cssText = 'flex:1 1 auto';
  text.textContent =
    'Unavailable in serverless deployment: live vessels (AISStream relay) ' +
    'and voice control (OpenAI Realtime) are turned off in this deployment.';
  banner.appendChild(text);

  const dismiss = doc.createElement('button');
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '\u00d7';
  dismiss.style.cssText =
    'flex:0 0 auto;background:transparent;border:0;color:inherit;' +
    'font-size:16px;line-height:1;cursor:pointer;padding:0 2px';
  dismiss.addEventListener('click', () => {
    banner.remove();
    try {
      window.sessionStorage?.setItem(DISMISSED_KEY, '1');
    } catch {
      /* ignore */
    }
  });
  banner.appendChild(dismiss);

  (doc.body || doc.documentElement).appendChild(banner);
  return banner;
}

export { installServerlessNotice, isServerlessBuild };
