import { timingSafeEqual } from 'node:crypto';

/**
 * Access gate for a hosted deployment.
 *
 * The provider middleware under `server/providers/` brokers this deployment's
 * API keys, so anyone who can load the page can spend the operator's OpenAI,
 * Google, AISStream, TomTom and FIRMS quota (SECURITY.md, "Threat model").
 * Upstream ships no gate because it binds to localhost; a hosted deployment
 * has to supply one.
 *
 * Credentials come from GEV_BASIC_AUTH_USER / GEV_BASIC_AUTH_PASS. Both set
 * gates the deployment; neither set leaves it open with a loud warning; only
 * one set is a misconfiguration and refuses to boot, because the failure mode
 * of guessing is a publicly spendable key broker.
 *
 * /healthz answers before the gate so a platform health check does not need
 * the credentials.
 */

const REALM = "God's Eye View";

/** Compare without revealing where two strings first differ. */
function constantTimeEqual(candidate, expected) {
  const left = Buffer.from(candidate, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function credentialsFromRequest(header) {
  const [scheme, encoded] = String(header ?? '').split(' ');
  if (scheme?.toLowerCase() !== 'basic' || !encoded) return null;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 1) return null;
  return {
    user: decoded.slice(0, separator),
    pass: decoded.slice(separator + 1),
  };
}

function accessGate({
  user = process.env.GEV_BASIC_AUTH_USER,
  pass = process.env.GEV_BASIC_AUTH_PASS,
} = {}) {
  if (Boolean(user) !== Boolean(pass)) {
    throw new Error(
      'Access gate misconfigured: set BOTH GEV_BASIC_AUTH_USER and ' +
        'GEV_BASIC_AUTH_PASS, or neither. Refusing to start rather than ' +
        'serving a key-brokering proxy without the gate you asked for.',
    );
  }
  const gated = Boolean(user && pass);

  const install = ({ middlewares }) => {
    // Health first: a platform probe must not need the credentials, and it
    // must not be a way to reach anything else.
    middlewares.use((req, res, next) => {
      if (req.url?.split('?')[0] !== '/healthz') {
        next();
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end('ok\n');
    });

    if (!gated) return;

    middlewares.use((req, res, next) => {
      const supplied = credentialsFromRequest(req.headers.authorization);
      if (supplied) {
        // Both halves are always compared: returning early on the username
        // would leak which half matched.
        const userOk = constantTimeEqual(supplied.user, user);
        const passOk = constantTimeEqual(supplied.pass, pass);
        if (userOk && passOk) {
          next();
          return;
        }
      }
      res.statusCode = 401;
      res.setHeader(
        'WWW-Authenticate',
        `Basic realm="${REALM}", charset="UTF-8"`,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Authentication required.\n');
    });
  };

  return {
    name: 'gev-deploy-access-gate',
    configureServer: install,
    configurePreviewServer: install,
    configResolved() {
      if (gated) {
        console.log('[deploy] access gate ON (HTTP basic auth).');
        return;
      }
      console.warn(
        '[deploy] WARNING: no access gate. Every key-brokering proxy on this ' +
          'server is reachable by anyone who can reach the URL, and upstream ' +
          'usage is billed to you. Set GEV_BASIC_AUTH_USER and ' +
          'GEV_BASIC_AUTH_PASS to gate it.',
      );
    },
  };
}

export { accessGate };
