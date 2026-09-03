// Loading-screen API health roster.
//
// Streams `/api/health` (NDJSON) into the startup cover so every upstream
// shows its state before the globe is revealed. Presentation is pure and
// injectable so the roster copy can be unit-tested without a DOM.

/** The cover never waits longer than this for the health run. */
export const LOADING_HEALTH_TIMEOUT_MS = 12_000;

/** With problems on the roster the cover holds this long unless dismissed. */
export const LOADING_HEALTH_REVIEW_DWELL_MS = 10_000;

const STATE_COPY = Object.freeze({
  pending: 'CHECKING',
  ok: 'LIVE',
  configured: 'KEY SET',
  degraded: 'DEGRADED',
  'key-missing': 'NO KEY',
  'key-invalid': 'KEY REJECTED',
  down: 'DOWN',
});

/** Short uppercase badge for one probe state. */
export function healthStateLabel(state) {
  return STATE_COPY[state] || STATE_COPY.pending;
}

/** Whether a state should read as a problem on the cover. */
export function healthStateSeverity(state) {
  if (state === 'down' || state === 'key-invalid') return 'error';
  if (state === 'degraded') return 'warn';
  if (state === 'key-missing') return 'muted';
  if (state === 'ok' || state === 'configured') return 'good';
  return 'pending';
}

/**
 * Headline for the roster. `results` is the list of settled rows; `total`
 * the manifest length (so an in-flight run can show progress).
 */
export function summarizeLoadingHealth(results = [], total = results.length, { timedOut = false, unavailable = false } = {}) {
  if (unavailable) return { tone: 'muted', text: 'API HEALTH CHECK UNAVAILABLE' };
  const settled = results.length;
  let live = 0;
  let noKey = 0;
  let degraded = 0;
  let failed = 0;
  let requiredFailed = false;
  for (const r of results) {
    const sev = healthStateSeverity(r.state);
    if (sev === 'good') live += 1;
    else if (sev === 'muted') noKey += 1;
    else if (sev === 'warn') degraded += 1;
    else if (sev === 'error') failed += 1;
    if (r.tier === 'required' && sev !== 'good') requiredFailed = true;
  }
  if (settled < total && !timedOut) {
    return { tone: 'pending', text: `CHECKING APIS ${settled}/${total}` };
  }
  const parts = [`${live} LIVE`];
  if (degraded) parts.push(`${degraded} DEGRADED`);
  if (noKey) parts.push(`${noKey} NO KEY`);
  if (failed) parts.push(`${failed} DOWN`);
  if (timedOut && settled < total) parts.push(`${total - settled} UNANSWERED`);
  return {
    tone: requiredFailed ? 'error' : failed ? 'warn' : 'good',
    text: parts.join(' · '),
  };
}

/** Rows that should stop the cover: down, rejected key, or degraded. */
export function healthProblems(results = []) {
  return results.filter((r) => {
    const sev = healthStateSeverity(r.state);
    return sev === 'error' || sev === 'warn';
  });
}

/** Copy for the top-center banner shown after the cover yields. */
export function healthNoticeCopy(results = [], { timedOut = false, total = results.length } = {}) {
  const problems = healthProblems(results);
  const unanswered = timedOut ? Math.max(0, total - results.length) : 0;
  if (!problems.length && !unanswered) return null;
  const errors = problems.filter((r) => healthStateSeverity(r.state) === 'error').length;
  const warns = problems.length - errors;
  const parts = [];
  if (errors) parts.push(`${errors} DOWN`);
  if (warns) parts.push(`${warns} DEGRADED`);
  if (unanswered) parts.push(`${unanswered} UNANSWERED`);
  const names = problems.slice(0, 3).map((r) => `${r.label} ${healthStateLabel(r.state)}`);
  if (unanswered) names.push(`${unanswered} UNANSWERED`);
  const more = problems.length > 3 ? ` +${problems.length - 3}` : '';
  // The banner hides its detail span in error/cancelled states, so the
  // names ride in the label; the counts are kept as detail for callers.
  return {
    label: `API HEALTH: ${names.join(' · ')}${more}`,
    detail: parts.join(' · '),
    // 'cancelled' is the banner's amber style; there is no dedicated warn state.
    state: errors || unanswered ? 'error' : 'cancelled',
  };
}

/** Parse one NDJSON chunk stream into events. Returns the leftover buffer. */
export function consumeNdjson(buffer, chunk, onEvent) {
  let text = buffer + chunk;
  let index;
  while ((index = text.indexOf('\n')) >= 0) {
    const line = text.slice(0, index).trim();
    text = text.slice(index + 1);
    if (!line) continue;
    try { onEvent(JSON.parse(line)); } catch { /* skip malformed line */ }
  }
  return text;
}

/**
 * Start the health roster on the loading cover.
 *
 * @param {object} options
 * @param {HTMLElement|null} options.listEl    `<ul>` that receives one row per service
 * @param {HTMLElement|null} options.summaryEl headline element
 * @param {HTMLElement|null} [options.continueEl] button revealed when the
 *   roster has problems; the cover holds until it is pressed or `reviewDwellMs`
 *   elapses, so a failure is never hidden by a fast boot.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.reviewDwellMs]
 * @param {(message: string, rows: object[]) => void} [options.log]
 * @returns {{ done: Promise<{results: object[], total: number, timedOut: boolean, unavailable: boolean, problems: object[]}> }}
 */
export function startLoadingHealthCheck({
  listEl,
  summaryEl,
  continueEl = null,
  fetchImpl = (...args) => fetch(...args),
  timeoutMs = LOADING_HEALTH_TIMEOUT_MS,
  reviewDwellMs = LOADING_HEALTH_REVIEW_DWELL_MS,
  log = (message, rows) => {
    if (rows.length) {
      console.warn(message);
      console.table(rows.map((r) => ({ service: r.label, state: r.state, detail: r.detail })));
    } else {
      console.info(message);
    }
  },
} = {}) {
  /** @type {Map<string, HTMLElement>} */
  const rows = new Map();
  /** @type {Map<string, object>} */
  const results = new Map();
  let total = 0;
  let finished = false;

  const paintSummary = (extra = {}) => {
    if (!summaryEl) return;
    const summary = summarizeLoadingHealth([...results.values()], total, extra);
    summaryEl.textContent = summary.text;
    summaryEl.dataset.tone = summary.tone;
  };

  const ensureRow = (service) => {
    if (!listEl) return null;
    let row = rows.get(service.id);
    if (row) return row;
    row = document.createElement('li');
    row.className = 'loader-health-row';
    row.dataset.id = service.id;
    row.dataset.state = 'pending';
    row.dataset.tier = service.tier || '';
    row.dataset.severity = 'pending';
    const name = document.createElement('span');
    name.className = 'loader-health-name';
    name.textContent = service.label;
    const state = document.createElement('span');
    state.className = 'loader-health-state';
    state.textContent = healthStateLabel('pending');
    const detail = document.createElement('span');
    detail.className = 'loader-health-detail';
    row.append(name, state, detail);
    listEl.appendChild(row);
    rows.set(service.id, row);
    return row;
  };

  const applyResult = (result) => {
    results.set(result.id, result);
    const row = ensureRow(result);
    if (row) {
      row.dataset.state = result.state;
      row.dataset.severity = healthStateSeverity(result.state);
      row.querySelector('.loader-health-state').textContent = healthStateLabel(result.state);
      row.querySelector('.loader-health-detail').textContent = result.detail || '';
      row.title = `${result.label}: ${healthStateLabel(result.state)}${result.detail ? ` · ${result.detail}` : ''}`;
    }
    paintSummary();
  };

  const finish = (extra) => {
    finished = true;
    if (extra.timedOut && listEl) {
      for (const [id, row] of rows) {
        if (!results.has(id)) {
          row.dataset.state = 'down';
          row.dataset.severity = 'error';
          row.querySelector('.loader-health-state').textContent = 'NO ANSWER';
        }
      }
    }
    paintSummary(extra);
    if (listEl) listEl.hidden = rows.size === 0;
    const settled = [...results.values()];
    const problems = healthProblems(settled);
    const summary = summarizeLoadingHealth(settled, total, extra);
    log(`[API health] ${summary.text}`, problems);
    return { results: settled, total, problems, ...extra };
  };

  /**
   * Hold the cover while there is something to read. Resolves on CONTINUE
   * or after the dwell; a clean roster resolves immediately.
   */
  const review = (report) => {
    const unanswered = report.timedOut && report.results.length < report.total;
    if ((!report.problems.length && !unanswered) || !continueEl) return Promise.resolve(report);
    return new Promise((resolve) => {
      let remaining = Math.ceil(reviewDwellMs / 1000);
      const paint = () => { continueEl.textContent = `CONTINUE ▸ ${remaining}`; };
      const finishReview = () => {
        clearInterval(ticker);
        continueEl.removeEventListener('click', finishReview);
        continueEl.hidden = true;
        resolve(report);
      };
      const ticker = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) finishReview();
        else paint();
      }, 1000);
      paint();
      continueEl.hidden = false;
      continueEl.addEventListener('click', finishReview, { once: true });
      try { continueEl.focus({ preventScroll: true }); } catch { /* focus optional */ }
    });
  };

  const run = async () => {
    let response;
    try {
      response = await fetchImpl('/api/health', { headers: { Accept: 'application/x-ndjson' } });
    } catch {
      return finish({ timedOut: false, unavailable: true });
    }
    if (!response?.ok || !response.body) return finish({ timedOut: false, unavailable: true });
    if (listEl) listEl.hidden = false;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const onEvent = (event) => {
      if (event.type === 'manifest' && Array.isArray(event.services)) {
        total = event.services.length;
        for (const service of event.services) ensureRow(service);
        paintSummary();
      } else if (event.type === 'result') {
        if (!total) total = 1;
        applyResult(event);
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = consumeNdjson(buffer, decoder.decode(value, { stream: true }), onEvent);
    }
    consumeNdjson(buffer, '\n', onEvent);
    return finish({ timedOut: false, unavailable: total === 0 });
  };

  const timeout = new Promise((resolve) => {
    setTimeout(() => {
      if (!finished) resolve(finish({ timedOut: true, unavailable: false }));
    }, timeoutMs);
  });

  const done = Promise.race([run().catch(() => finish({ timedOut: false, unavailable: true })), timeout])
    .then(review);
  return { done };
}
