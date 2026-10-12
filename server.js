/**
 * Hosted production entry point (e.g. Hostinger "Node.js web app").
 *
 *   npm run build && npm start
 *
 * Serves the built app from dist/ plus the same /api provider routes as the
 * local dev server, behind a mandatory password gate. Local development
 * (`npm run dev`) is unchanged and ungated.
 *
 * Fails closed: if GEV_ACCESS_PASSWORD or GEV_SESSION_SECRET is missing or
 * weak, every request answers 503 and nothing else is served.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { BROWSER_HEADERS } from './build/vite.js';
import {
  accessGateConfigProblems,
  accessGatePlugin,
  createAccessGate,
  failClosedMiddleware,
} from './server/hosted/accessGate.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const env = process.env;

const problems = accessGateConfigProblems(env);
if (!existsSync(new URL('./dist/index.html', import.meta.url)))
  problems.push('dist/ is missing: run `npm run build` before starting');

// Behind the host's reverse proxy: trust X-Forwarded-Proto/For for the
// same-site gate and login limiter. Only set once the password gate is active.
const trustProxy = env.GEV_TRUST_PROXY !== '0';
if (!problems.length && trustProxy) env.GEV_TRUSTED_PROXY = '1';

const innerGate = problems.length
  ? failClosedMiddleware(problems)
  : createAccessGate({
      password: env.GEV_ACCESS_PASSWORD,
      secret: env.GEV_SESSION_SECRET,
      secureCookie: env.GEV_INSECURE_COOKIE !== '1',
      trustProxy,
    });

// Gate responses (login page, 401, 503) carry the same CSP and framing
// headers as the app itself.
const gate = (req, res, next) => {
  for (const [name, value] of Object.entries(BROWSER_HEADERS))
    res.setHeader(name, value);
  res.setHeader('Referrer-Policy', 'same-origin');
  return innerGate(req, res, next);
};

if (problems.length) {
  console.error(
    `[gev] Refusing to serve the app (fail closed):\n- ${problems.join('\n- ')}`,
  );
}

const server = await preview({
  root,
  configFile: fileURLToPath(new URL('./vite.config.js', import.meta.url)),
  mode: 'production',
  plugins: [accessGatePlugin(gate)],
  preview: {
    host: env.HOST || '0.0.0.0',
    port: Number(env.PORT) || 3000,
    strictPort: true,
    open: false,
  },
});
server.printUrls();
