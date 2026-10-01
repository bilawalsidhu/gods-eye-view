/**
 * Notification channels: Slack, Discord and generic JSON webhooks.
 *
 * Destinations are restricted so a user-supplied URL cannot turn the server
 * into a request relay: HTTPS only, no credentials or custom ports, and the
 * host must be Slack's or Discord's webhook host or listed by the operator
 * in GEV_WEBHOOK_HOSTS (comma-separated). Redirects are refused.
 */

const BUILTIN_HOSTS = Object.freeze({
  slack: ['hooks.slack.com'],
  discord: ['discord.com', 'discordapp.com'],
});

export function allowedHosts(type, env = process.env) {
  if (type === 'webhook')
    return String(env.GEV_WEBHOOK_HOSTS || '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
  return BUILTIN_HOSTS[type] || [];
}

const fail = (msg) => {
  const e = new Error(msg);
  e.code = 'BAD_REQUEST';
  throw e;
};

export function validateChannel(input, env = process.env) {
  const name = typeof input?.name === 'string' ? input.name.trim().slice(0, 80) : '';
  if (!name) fail('channel needs a name');
  const type = ['slack', 'discord', 'webhook'].includes(input?.type) ? input.type : fail('type must be slack, discord or webhook');
  let url;
  try {
    url = new URL(String(input?.url || ''));
  } catch {
    fail('url is not valid');
  }
  if (url.protocol !== 'https:') fail('url must be https');
  if (url.username || url.password) fail('url may not contain credentials');
  if (url.port) fail('url may not set a port');
  const host = url.hostname.toLowerCase();
  const hosts = allowedHosts(type, env);
  if (!hosts.length) fail('generic webhooks need GEV_WEBHOOK_HOSTS set by the operator');
  if (!hosts.includes(host)) fail(`host must be one of: ${hosts.join(', ')}`);
  if (type === 'slack' && !url.pathname.startsWith('/services/')) fail('not a Slack incoming-webhook URL');
  if (type === 'discord' && !url.pathname.startsWith('/api/webhooks/')) fail('not a Discord webhook URL');
  return { name, type, url: url.toString() };
}

/** Never send a stored webhook URL back to the browser in full. */
export function maskChannel(c) {
  let shown = '';
  try {
    const u = new URL(c.url);
    shown = `${u.host}${u.pathname.slice(0, 14)}…`;
  } catch {
    shown = 'invalid';
  }
  return { id: c.id, name: c.name, type: c.type, url: shown };
}

export function channelPayload(type, alert) {
  const when = new Date(alert.t).toISOString().replace('.000Z', 'Z');
  const where = Number.isFinite(alert.lat) ? ` at ${alert.lat.toFixed(4)}, ${alert.lon.toFixed(4)}` : '';
  const text = `[${alert.severity.toUpperCase()}] ${alert.title}${where} (${when})`;
  if (type === 'slack') return { text };
  if (type === 'discord') return { content: text.slice(0, 1900) };
  return {
    source: 'gods-eye-view',
    alert: {
      id: alert.id,
      t: alert.t,
      kind: alert.kind,
      severity: alert.severity,
      title: alert.title,
      domain: alert.domain,
      asset: alert.asset,
      lat: alert.lat,
      lon: alert.lon,
    },
  };
}

/**
 * Create a deliverer with a per-channel rate limit (default 30/minute).
 * @param {{fetchImpl?: typeof fetch, perMinute?: number, now?: () => number}} [o]
 */
export function createDeliverer({ fetchImpl = fetch, perMinute = 30, now = Date.now } = {}) {
  const windows = new Map();
  const stats = { sent: 0, failed: 0, limited: 0 };
  async function deliver(channel, alert, env = process.env) {
    // Re-validate at send time: GEV_WEBHOOK_HOSTS may have changed.
    try {
      validateChannel(channel, env);
    } catch {
      stats.failed++;
      return { ok: false, reason: 'channel_no_longer_allowed' };
    }
    const t = now();
    const w = windows.get(channel.id) || { start: t, count: 0 };
    if (t - w.start >= 60_000) {
      w.start = t;
      w.count = 0;
    }
    if (w.count >= perMinute) {
      stats.limited++;
      return { ok: false, reason: 'rate_limited' };
    }
    w.count++;
    windows.set(channel.id, w);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetchImpl(channel.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'gods-eye-view-alerts/1.0' },
        body: JSON.stringify(channelPayload(channel.type, alert)),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!res.ok) {
        stats.failed++;
        return { ok: false, reason: `status_${res.status}` };
      }
      stats.sent++;
      return { ok: true };
    } catch {
      stats.failed++;
      return { ok: false, reason: 'network_error' };
    } finally {
      clearTimeout(timer);
    }
  }
  return { deliver, stats: () => ({ ...stats }) };
}
