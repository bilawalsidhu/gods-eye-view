import { createLocalChatSession } from '../voice/localChatSession.js';
import { readResponseJsonCapped } from '../sources/httpBody.js';

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
  if (value == null || value === '') return 'Time unavailable';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : 'Time unavailable';
}

const text = (value, fallback = '') =>
  typeof value === 'string' && value.trim() ? value : fallback;
const empty = (node) => {
  while (node.firstChild || node.children?.length) {
    (node.firstChild || node.children[0]).remove();
  }
};

/**
 * Opt-in local intelligence surface. Mount once; the application owns CSS and
 * supplies its existing action runner. Without a runner, chat answers only.
 * No network requests occur until opened or a country is explicitly loaded.
 */
export function createHybridIntelligence({
  container = globalThis.document?.body,
  fetchImpl = (...args) => globalThis.fetch(...args),
  createSession = createLocalChatSession,
  runAction,
  signal,
} = {}) {
  const doc = container?.ownerDocument;
  if (!doc?.createElement || signal?.aborted) return null;
  const lifetime = new AbortController();
  let disposed = false;
  let modelReady = false;
  let modelChecked = false;
  let checkingModel = false;
  let chatBusy = false;
  let session = null;
  let countryRequest = null;
  let countryData = null;
  let generation = 0;
  let sessionEpoch = 0;

  const make = (tag, className, content) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (content != null) node.textContent = content;
    return node;
  };
  const listen = (node, event, callback) =>
    node.addEventListener(event, callback, { signal: lifetime.signal });
  const button = (content, label) => {
    const node = make('button', 'panel-surface-control', content);
    node.type = 'button';
    if (label) node.setAttribute('aria-label', label);
    return node;
  };

  const toggle = button('Intelligence');
  toggle.id = 'hybrid-intelligence-toggle';
  toggle.setAttribute('aria-controls', 'hybrid-intelligence');
  toggle.setAttribute('aria-expanded', 'false');
  const panel = make('aside', 'hybrid-intelligence');
  panel.id = 'hybrid-intelligence';
  panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'hybrid-intelligence-title');
  const surface = make('div');
  surface.setAttribute('data-panel-surface', '');
  const header = make('header');
  header.setAttribute('data-panel-header', '');
  const heading = make('h2', 'panel-surface-title', 'Intelligence');
  heading.id = 'hybrid-intelligence-title';
  const closeButton = button('Close', 'Close Intelligence');
  header.append(heading, closeButton);
  const body = make('div', 'hybrid-intelligence-body');
  body.setAttribute('data-panel-body', '');

  const countrySection = make('section', 'hybrid-intelligence-section');
  countrySection.setAttribute('aria-labelledby', 'hybrid-country-title');
  const countryTitle = make('h3', '', 'Country briefing');
  countryTitle.id = 'hybrid-country-title';
  const countryForm = make('form', 'hybrid-country-form');
  const countryLabel = make('label', '', 'Country code');
  countryLabel.htmlFor = 'hybrid-country-code';
  const countryInput = make('input', 'panel-surface-control');
  countryInput.id = 'hybrid-country-code';
  countryInput.name = 'country';
  countryInput.value = 'US';
  countryInput.maxLength = 2;
  countryInput.required = true;
  countryInput.pattern = '[A-Za-z]{2}';
  countryInput.autocomplete = 'off';
  countryInput.spellcheck = false;
  countryInput.setAttribute('aria-describedby', 'hybrid-country-help');
  const loadButton = button('Load briefing');
  loadButton.type = 'submit';
  const refreshButton = button('Refresh news');
  const countryHelp = make(
    'p',
    'hybrid-intelligence-muted',
    'Two-letter country code, for example US or GB. Refresh news to acquire feeds when the cache is empty or old.',
  );
  countryHelp.id = 'hybrid-country-help';
  countryForm.append(countryLabel, countryInput, loadButton, refreshButton);
  const countryStatus = make(
    'p',
    'hybrid-intelligence-status',
    'Load a country to request headlines and risk from World Monitor (local).',
  );
  countryStatus.setAttribute('role', 'status');
  countryStatus.setAttribute('aria-live', 'polite');
  const countryResults = make('div', 'hybrid-country-results');
  countrySection.append(
    countryTitle,
    countryForm,
    countryHelp,
    countryStatus,
    countryResults,
  );

  const chatSection = make('section', 'hybrid-intelligence-section');
  chatSection.setAttribute('aria-labelledby', 'hybrid-chat-title');
  const chatTitle = make('h3', '', 'Local text assistant');
  chatTitle.id = 'hybrid-chat-title';
  const chatHelp = make(
    'p',
    'hybrid-intelligence-muted',
    runAction
      ? 'Text chat with globe tools. Loaded country data is included as context.'
      : 'Text answers using the loaded country data. Globe controls are unavailable in this panel.',
  );
  const modelStatus = make(
    'p',
    'hybrid-intelligence-status',
    'Local model has not been checked.',
  );
  modelStatus.setAttribute('role', 'status');
  modelStatus.setAttribute('aria-live', 'polite');
  const retryButton = button('Check model');
  const transcript = make('div', 'hybrid-chat-transcript');
  transcript.setAttribute('role', 'log');
  transcript.setAttribute('aria-label', 'Local text conversation');
  transcript.setAttribute('aria-live', 'polite');
  transcript.setAttribute('aria-relevant', 'additions text');
  const chatForm = make('form', 'hybrid-chat-form');
  const questionLabel = make('label', '', 'Ask a question');
  questionLabel.htmlFor = 'hybrid-chat-question';
  const question = make('textarea', 'panel-surface-control');
  question.id = 'hybrid-chat-question';
  question.rows = 3;
  question.maxLength = 4000;
  question.required = true;
  question.placeholder = 'What stands out in this country briefing?';
  const actions = make('div', 'hybrid-chat-actions');
  const sendButton = button('Send');
  sendButton.type = 'submit';
  sendButton.disabled = true;
  const stopButton = button('Stop');
  stopButton.disabled = true;
  actions.append(sendButton, stopButton);
  chatForm.append(questionLabel, question, actions);
  const chatStatus = make(
    'p',
    'hybrid-intelligence-status',
    'No conversation yet.',
  );
  chatStatus.setAttribute('role', 'status');
  chatStatus.setAttribute('aria-live', 'polite');
  chatSection.append(
    chatTitle,
    chatHelp,
    modelStatus,
    retryButton,
    transcript,
    chatForm,
    chatStatus,
  );
  body.append(countrySection, chatSection);
  surface.append(header, body);
  panel.append(surface);
  container.append(toggle, panel);

  const updateChatControls = () => {
    sendButton.disabled = !modelReady || chatBusy;
    stopButton.disabled = !chatBusy;
    question.disabled = chatBusy;
    chatForm.setAttribute('aria-busy', String(chatBusy));
  };
  const addMessage = (role, content) => {
    if (!text(content)) return;
    const message = make('article', 'hybrid-chat-message');
    message.dataset.role = role;
    message.append(
      make('h4', '', role === 'user' ? 'You' : 'Local assistant'),
      make('p', '', content),
    );
    transcript.append(message);
    while (transcript.children.length > 24) transcript.children[0].remove();
    transcript.scrollTop = transcript.scrollHeight;
  };
  const showCountry = (data) => {
    empty(countryResults);
    const source = text(data.source, 'World Monitor (local)');
    const state = ['complete', 'partial', 'stale', 'unavailable'].includes(
      data.status,
    )
      ? data.status
      : 'unavailable';
    countryStatus.dataset.state = state;
    countryStatus.textContent = `${source} · ${state} · Retrieved ${intelligenceTime(data.retrievedAt)}${data.reason ? ` · ${text(data.reason)}` : ''}`;
    countryResults.append(
      make('h4', '', text(data.countryName, data.countryCode)),
    );
    if (text(data.summary))
      countryResults.append(make('p', 'hybrid-country-summary', data.summary));
    const risk = data.risk || {};
    const score =
      typeof risk.score === 'number' && Number.isFinite(risk.score)
        ? String(risk.score)
        : null;
    const riskLine =
      score !== null
        ? `Risk score ${score}${text(risk.level) ? ` · ${risk.level}` : ''}${text(risk.trend) ? ` · ${risk.trend}` : ''}`
        : 'Risk score unavailable';
    countryResults.append(make('p', 'hybrid-risk-score', riskLine));
    countryResults.append(
      make(
        'p',
        'hybrid-intelligence-muted',
        `Risk ${text(risk.status, 'unavailable')} · Computed ${intelligenceTime(risk.computedAt)}`,
      ),
    );
    const coverage = data.headlineCoverage;
    if (coverage) {
      const counts =
        Number.isFinite(coverage.feedCached) &&
        Number.isFinite(coverage.feedTotal)
          ? ` · ${coverage.feedCached}/${coverage.feedTotal} feeds cached`
          : '';
      countryResults.append(
        make(
          'p',
          'hybrid-intelligence-muted',
          `Headlines ${text(coverage.state, 'coverage unknown')}${counts}`,
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
          'hybrid-intelligence-muted',
          'No headlines returned. This does not establish that no events occurred.',
        ),
      );
      return;
    }
    const list = make('ul', 'hybrid-headlines');
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
          'hybrid-intelligence-muted',
          `${text(item.source, 'Source unavailable')} · ${intelligenceTime(item.publishedAt)}`,
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
      countryStatus.textContent =
        'Enter a two-letter country code, for example US or GB.';
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
    countryData = null;
    empty(countryResults);
    countryStatus.textContent = `Loading ${country} from World Monitor (local)…`;
    loadButton.disabled = true;
    refreshButton.disabled = true;
    countryResults.setAttribute('aria-busy', 'true');
    try {
      if (refresh) {
        countryStatus.textContent =
          'Acquiring news from World Monitor (local)…';
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
      countryData = { ...data, countryCode: country };
      showCountry(countryData);
    } catch {
      if (disposed || request.signal.aborted || countryRequest !== request)
        return;
      showCountry({
        countryCode: country,
        status: 'unavailable',
        reason: 'The local World Monitor service could not provide a briefing.',
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

  async function checkModel() {
    if (disposed || checkingModel) return;
    checkingModel = true;
    modelChecked = true;
    retryButton.disabled = true;
    modelStatus.textContent = 'Checking local model configuration…';
    try {
      const requestSignal = AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(10_000),
      ]);
      const response = await fetchImpl('/api/local-model/status', {
        signal: requestSignal,
      });
      const data = await readResponseJsonCapped(
        response,
        16 * 1024,
        requestSignal,
      );
      if (disposed) return;
      modelReady =
        response.ok && data?.selected === true && data?.configured === true;
      modelStatus.textContent = modelReady
        ? `Local model configured${text(data.model) ? ` · ${data.model}` : ''}. Connection is checked when you send.`
        : 'Local model unavailable. Configure the local inference service to enable text chat.';
    } catch {
      if (disposed) return;
      modelReady = false;
      modelStatus.textContent =
        'Local model status unavailable. Check the local inference service, then retry.';
    } finally {
      checkingModel = false;
      if (!disposed) {
        retryButton.disabled = false;
        updateChatControls();
      }
    }
  }

  async function sendQuestion() {
    if (disposed || chatBusy || !modelReady || !question.value.trim()) return;
    chatBusy = true;
    updateChatControls();
    const current = ++generation;
    if (!session) {
      const epoch = ++sessionEpoch;
      session = createSession({
        signal: lifetime.signal,
        fetchImpl,
        runAction,
        allowTools: Boolean(runAction),
        emit(event) {
          if (disposed || epoch !== sessionEpoch) return;
          if (event.type === 'transcript' && event.final)
            addMessage(event.role, event.text);
          if (event.type === 'state') {
            const stateDescription =
              event.state === 'error'
                ? text(
                    event.detail,
                    'The local model could not complete this answer.',
                  )
                : event.state === 'executing'
                  ? 'Local assistant is working…'
                  : 'Ready for a text question.';
            chatStatus.textContent = stateDescription;
          }
        },
      });
    }
    const activeSession = session;
    const submitted = question.value.trim();
    chatStatus.textContent = 'Local assistant is working…';
    try {
      await activeSession.start();
      if (disposed || current !== generation) return;
      activeSession.sendMapEvent({
        type: 'country_briefing',
        countryCode: countryData?.countryCode || null,
        briefing: countryData
          ? {
              source: text(countryData.source).slice(0, 200),
              status: countryData.status,
              retrievedAt: countryData.retrievedAt,
              summary: text(countryData.summary).slice(0, 4000),
              risk: countryData.risk,
              headlineCoverage: countryData.headlineCoverage,
              headlines: (Array.isArray(countryData.headlines)
                ? countryData.headlines
                : []
              )
                .slice(0, 12)
                .map((item) => ({
                  title: text(item?.title).slice(0, 350),
                  source: text(item?.source).slice(0, 100),
                  publishedAt: item?.publishedAt,
                  url: intelligenceLink(item?.url)?.slice(0, 500) || null,
                })),
              contextLimit:
                'At most 12 headlines; long text may be shortened. This is not complete coverage.',
            }
          : null,
      });
      await activeSession.sendText(submitted);
      if (!disposed && current === generation) {
        question.value = '';
        chatStatus.textContent =
          'Answer complete. Check the cited source coverage and dates.';
      }
    } catch {
      if (!disposed && current === generation)
        chatStatus.textContent =
          'The local assistant could not complete the answer. Check the local model and try again.';
    } finally {
      if (!disposed && current === generation) {
        chatBusy = false;
        updateChatControls();
        if (!panel.hidden) question.focus();
      }
    }
  }

  const open = () => {
    if (disposed) return;
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    countryInput.focus();
    if (!modelChecked) void checkModel();
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
    generation++;
    sessionEpoch++;
    lifetime.abort();
    countryRequest?.abort();
    session?.stop();
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
  listen(retryButton, 'click', () => void checkModel());
  listen(chatForm, 'submit', (event) => {
    event.preventDefault();
    void sendQuestion();
  });
  listen(stopButton, 'click', () => {
    generation++;
    sessionEpoch++;
    session?.stop();
    session = null;
    chatBusy = false;
    chatStatus.textContent =
      'Stopped. Your next question starts a new conversation.';
    updateChatControls();
  });
  signal?.addEventListener('abort', destroy, { once: true });
  return { open, close, destroy, loadCountry };
}
