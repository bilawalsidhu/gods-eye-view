/**
 * Thin client for the history, alerts and cameras APIs. Errors surface as
 * Error objects whose message is the server's short error code/detail.
 */

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers:
      body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = data?.detail || data?.error || `HTTP ${res.status}`;
    const error = new Error(msg);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

const qs = (params) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

export const api = {
  historyStatus: () => request('GET', '/api/history/status'),
  range: (p) => request('GET', `/api/history/range${qs(p)}`),
  track: (p) => request('GET', `/api/history/track${qs(p)}`),
  trackExportUrl: (p) => `/api/history/track${qs(p)}`,
  assets: (p) => request('GET', `/api/history/assets${qs(p)}`),

  watchState: () => request('GET', '/api/watch/state'),
  put: (plural, id, body) =>
    request('PUT', `/api/watch/${plural}/${encodeURIComponent(id)}`, body),
  remove: (plural, id) =>
    request('DELETE', `/api/watch/${plural}/${encodeURIComponent(id)}`),
  testChannel: (id) =>
    request('POST', `/api/watch/channels/${encodeURIComponent(id)}/test`),
  alerts: (p) => request('GET', `/api/watch/alerts${qs(p)}`),
  ack: (id) =>
    request('POST', `/api/watch/alerts/${encodeURIComponent(id)}/ack`),
  passes: (p) => request('GET', `/api/watch/passes${qs(p)}`),

  coverage: (p) => request('GET', `/api/cameras/coverage${qs(p)}`),
  cameraHealth: (p) => request('GET', `/api/cameras/health${qs(p)}`),
  cameraSeries: (p) => request('GET', `/api/cameras/health/series${qs(p)}`),
};
