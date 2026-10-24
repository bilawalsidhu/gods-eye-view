import { readResponseJsonCapped } from '../sources/httpBody.js';
import { msg, t } from '../i18n/index.js';
import { createActionButton } from './actionButton.js';

/** Only web links from feed records become clickable; never resolve relative URLs. */
export function intelligenceLink(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** Distinguish the time a local service was queried from a source observation. */
export function intelligenceTime(value) {
  if (value == null || value === '') return t('Time unavailable');
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : t('Time unavailable');
}

const STATE_LABELS = Object.freeze({
  complete: msg('complete'),
  partial: msg('partial'),
  stale: msg('stale'),
  unavailable: msg('unavailable'),
});
const stateLabel = (value) =>
  t(STATE_LABELS[value] ?? STATE_LABELS.unavailable);

const text = (value, fallback = '') =>
  typeof value === 'string' && value.trim() ? value : fallback;
const empty = (node) => {
  while (node.firstChild || node.children?.length) {
    (node.firstChild || node.children[0]).remove();
  }
};

/**
 * Opt-in country briefing from a local World Monitor backend. Mount once when
 * World Monitor is configured; the application owns CSS. No network requests
 * occur until a country is explicitly loaded.
 */
export function createWorldMonitorBriefing({
  container = globalThis.document?.body,
  fetchImpl = (...args) => globalThis.fetch(...args),
  signal,
} = {}) {
  const doc = container?.ownerDocument;
  if (!doc?.createElement || signal?.aborted) return null;
  const lifetime = new AbortController();
  let disposed = false;
  let countryRequest = null;

  const make = (tag, className, content) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (content != null) node.textContent = content;
    return node;
  };
  const listen = (node, event, callback) =>
    node.addEventListener(event, callback, { signal: lifetime.signal });
  const button = (label, ariaLabel) =>
    createActionButton({ documentRef: doc, label, ariaLabel });

  const toggle = button(t('Intelligence'));
  toggle.id = 'world-monitor-toggle';
  toggle.setAttribute('aria-controls', 'world-monitor');
  toggle.setAttribute('aria-expanded', 'false');
  const panel = make('aside', 'world-monitor');
  panel.id = 'world-monitor';
  panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'world-monitor-title');
  const surface = make('div');
  surface.setAttribute('data-panel-surface', '');
  const header = make('header');
  header.setAttribute('data-panel-header', '');
  const heading = make('h2', 'panel-surface-title', t('Country briefing'));
  heading.id = 'world-monitor-title';
  const closeButton = button(t('Close'), t('Close country briefing'));
  header.append(heading, closeButton);
  const body = make('div', 'world-monitor-body');
  body.setAttribute('data-panel-body', '');

  const countryForm = make('form', 'world-monitor-country-form');
  const countryLabel = make('label', '', t('Country code'));
  countryLabel.htmlFor = 'world-monitor-country-code';
  const countryInput = make('input', 'gev-field');
  countryInput.id = 'world-monitor-country-code';
  countryInput.name = 'country';
  countryInput.value = 'US';
  countryInput.maxLength = 2;
  countryInput.required = true;
  countryInput.pattern = '[A-Za-z]{2}';
  countryInput.autocomplete = 'off';
  countryInput.spellcheck = false;
  countryInput.setAttribute('aria-describedby', 'world-monitor-country-help');
  const loadButton = button(t('Load briefing'));
  loadButton.type = 'submit';
  const refreshButton = button(t('Refresh news'));
  const countryHelp = make(
    'p',
    'world-monitor-muted',
    t(
      'Two-letter country code, for example US or GB. Refresh news to acquire feeds when the cache is empty or old.',
    ),
  );
  countryHelp.id = 'world-monitor-country-help';
  countryForm.append(countryLabel, countryInput, loadButton, refreshButton);
  const countryStatus = make(
    'p',
    'world-monitor-status',
    t('Load a country to request headlines and risk from World Monitor.'),
  );
  countryStatus.setAttribute('role', 'status');
  countryStatus.setAttribute('aria-live', 'polite');
  const countryResults = make('div', 'world-monitor-country-results');
  body.append(countryForm, countryHelp, countryStatus, countryResults);
  surface.append(header, body);
  panel.append(surface);
  container.append(toggle, panel);

  const showCountry = (data) => {
    empty(countryResults);
    const source = text(data.source, 'World Monitor (local)');
    const state = ['complete', 'partial', 'stale', 'unavailable'].includes(
      data.status,
    )
      ? data.status
      : 'unavailable';
    countryStatus.dataset.state = state;
    const retrieved = t('{source} · {state} · Retrieved {time}', {
      source,
      state: stateLabel(state),
      time: intelligenceTime(data.retrievedAt),
    });
    countryStatus.textContent = data.reason
      ? `${retrieved} · ${text(data.reason)}`
      : retrieved;
    countryResults.append(
      make('h4', '', text(data.countryName, data.countryCode)),
    );
    if (text(data.summary))
      countryResults.append(
        make('p', 'world-monitor-country-summary', data.summary),
      );
    const risk = data.risk || {};
    const score =
      typeof risk.score === 'number' && Number.isFinite(risk.score)
        ? String(risk.score)
        : null;
    const details = [text(risk.level), text(risk.trend)].filter(Boolean);
    countryResults.append(
      make(
        'p',
        'world-monitor-risk-score',
        score === null
          ? t('Risk score unavailable')
          : [t('Risk score {score}', { score }), ...details].join(' · '),
      ),
    );
    countryResults.append(
      make(
        'p',
        'world-monitor-muted',
        t('Risk {state} · Computed {time}', {
          state: stateLabel(risk.status),
          time: intelligenceTime(risk.computedAt),
        }),
      ),
    );
    const coverage = data.headlineCoverage;
    if (coverage) {
      const coverageState = text(coverage.state)
        ? stateLabel(coverage.state)
        : t('coverage unknown');
      countryResults.append(
        make(
          'p',
          'world-monitor-muted',
          Number.isFinite(coverage.feedCached) &&
            Number.isFinite(coverage.feedTotal)
            ? t('Headlines {state} · {cached}/{total} feeds cached', {
                state: coverageState,
                cached: coverage.feedCached,
                total: coverage.feedTotal,
              })
            : t('Headlines {state}', { state: coverageState }),
        ),
      );
    }
    const headlines = Array.isArray(data.headlines)
      ? data.headlines.slice(0, 12)
      : [];
    if (!headlines.length) {
      countryResults.append(
        make(
          'p',
          'world-monitor-muted',
          t(
            'No headlines returned. This does not establish that no events occurred.',
          ),
        ),
      );
      return;
    }
    const list = make('ul', 'world-monitor-headlines');
    for (const item of headlines) {
      if (!item || !text(item.title)) continue;
      const row = make('li');
      const href = intelligenceLink(item.url);
      const title = make(href ? 'a' : 'span', '', item.title);
      if (href) {
        title.href = href;
        title.target = '_blank';
        title.rel = 'noopener noreferrer';
      }
      row.append(
        title,
        make(
          'p',
          'world-monitor-muted',
          `${text(item.source, t('Source unavailable'))} · ${intelligenceTime(item.publishedAt)}`,
        ),
      );
      list.append(row);
    }
    countryResults.append(list);
  };

  async function loadCountry(
    code = countryInput.value,
    { refresh = false } = {},
  ) {
    if (disposed) return;
    const country = String(code).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) {
      countryInput.setAttribute('aria-invalid', 'true');
      countryStatus.textContent = t(
        'Enter a two-letter country code, for example US or GB.',
      );
      return;
    }
    countryInput.setAttribute('aria-invalid', 'false');
    countryInput.value = country;
    countryRequest?.abort();
    const request = new AbortController();
    countryRequest = request;
    const requestSignal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(refresh ? 45_000 : 30_000),
    ]);
    const abort = () => request.abort();
    lifetime.signal.addEventListener('abort', abort, { once: true });
    empty(countryResults);
    countryStatus.textContent = t('Loading {country} from World Monitor…', {
      country,
    });
    loadButton.disabled = true;
    refreshButton.disabled = true;
    countryResults.setAttribute('aria-busy', 'true');
    try {
      if (refresh) {
        countryStatus.textContent = t('Acquiring news from World Monitor…');
        const digest = await fetchImpl(
          '/api/worldmonitor/feed-digest?variant=full&limit=1',
          { signal: requestSignal },
        );
        await readResponseJsonCapped(digest, 256 * 1024, requestSignal);
        if (!digest.ok) throw new Error('News acquisition unavailable');
        if (disposed || request.signal.aborted || countryRequest !== request)
          return;
      }
      const response = await fetchImpl(
        `/api/worldmonitor/country-brief?country=${encodeURIComponent(country)}`,
        { signal: requestSignal },
      );
      const data = await readResponseJsonCapped(
        response,
        256 * 1024,
        requestSignal,
      );
      if (disposed || request.signal.aborted || countryRequest !== request)
        return;
      if (
        !data ||
        typeof data !== 'object' ||
        (!response.ok && data.status !== 'unavailable')
      )
        throw new Error('unavailable');
      showCountry({ ...data, countryCode: country });
    } catch {
      if (disposed || request.signal.aborted || countryRequest !== request)
        return;
      showCountry({
        countryCode: country,
        status: 'unavailable',
        reason: t(
          'The local World Monitor service could not provide a briefing.',
        ),
      });
    } finally {
      lifetime.signal.removeEventListener('abort', abort);
      if (!disposed && countryRequest === request) {
        loadButton.disabled = false;
        refreshButton.disabled = false;
        countryResults.setAttribute('aria-busy', 'false');
      }
    }
  }

  const open = () => {
    if (disposed) return;
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    countryInput.focus();
  };
  const close = () => {
    if (disposed) return;
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus();
  };
  const destroy = () => {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
    countryRequest?.abort();
    signal?.removeEventListener('abort', destroy);
    panel.remove();
    toggle.remove();
  };
  listen(toggle, 'click', () => (panel.hidden ? open() : close()));
  listen(closeButton, 'click', close);
  listen(panel, 'keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  listen(countryForm, 'submit', (event) => {
    event.preventDefault();
    void loadCountry();
  });
  listen(
    refreshButton,
    'click',
    () => void loadCountry(countryInput.value, { refresh: true }),
  );
  signal?.addEventListener('abort', destroy, { once: true });
  return { open, close, destroy, loadCountry };
}
