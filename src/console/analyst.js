/**
 * Scene analyst.
 *
 * A text channel onto the same OpenAI credential the voice control already
 * brokers: the key stays on the server, the browser posts a question plus a
 * snapshot of what the console can see, and the answer comes back as plain
 * text. Without a key the endpoint answers 503 and the panel says so instead
 * of failing silently — the deployment, not the operator, owns that gap.
 */

const ENDPOINT = '/api/openai/analyst';
const HISTORY_TURNS = 6;

const SUGGESTIONS = Object.freeze([
  'What am I looking at?',
  'Summarise the active feeds',
  'What is unusual in this view?',
  'Which layers would help here?',
]);

/** Read a JSON body, tolerating an upstream that answers with anything else. */
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

/**
 * @param {object} options
 * @param {Document} [options.documentRef]
 * @param {() => object} options.collectContext Scene snapshot for each question.
 * @param {(state: 'ready'|'offline'|'busy'|'error') => void} [options.onStatus]
 * @param {(entry: {role:string, text:string}) => void} [options.onTurn]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createAnalystPanel({
  documentRef = document,
  collectContext = () => ({}),
  onStatus,
  onTurn,
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  const log = documentRef.getElementById('gev-console-analyst-log');
  const form = documentRef.getElementById('gev-console-analyst-form');
  const input = documentRef.getElementById('gev-console-analyst-input');
  const send = documentRef.getElementById('gev-console-analyst-send');
  const note = documentRef.getElementById('gev-console-analyst-note');
  const suggestionBar = documentRef.getElementById(
    'gev-console-analyst-suggestions',
  );
  if (!log || !form || !input) {
    return { probe: async () => false, focus() {}, destroy() {} };
  }

  const removers = [];
  const listen = (target, type, handler) => {
    target?.addEventListener(type, handler);
    removers.push(() => target?.removeEventListener(type, handler));
  };

  const history = [];
  let configured = false;
  let pending = false;
  let destroyed = false;

  function setNote(text, tone = '') {
    if (!note) return;
    note.textContent = text;
    note.dataset.tone = tone;
  }

  function appendTurn(role, text, { tone = '' } = {}) {
    const entry = documentRef.createElement('article');
    entry.className = `gc-turn gc-turn-${role}`;
    if (tone) entry.dataset.tone = tone;
    const who = documentRef.createElement('span');
    who.className = 'gc-turn-role';
    who.textContent = role === 'operator' ? 'OPERATOR' : 'ANALYST';
    const body = documentRef.createElement('p');
    body.className = 'gc-turn-body';
    body.textContent = text;
    entry.appendChild(who);
    entry.appendChild(body);
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
    onTurn?.({ role, text });
    return entry;
  }

  function renderSuggestions() {
    if (!suggestionBar) return;
    suggestionBar.textContent = '';
    if (!configured) return;
    for (const suggestion of SUGGESTIONS) {
      const chip = documentRef.createElement('button');
      chip.type = 'button';
      chip.className = 'gc-suggestion';
      chip.textContent = suggestion;
      chip.addEventListener('click', () => {
        input.value = suggestion;
        submit();
      });
      suggestionBar.appendChild(chip);
    }
  }

  function setAvailability(available, detail) {
    configured = available;
    form.dataset.available = String(available);
    input.disabled = !available || pending;
    if (send) send.disabled = !available || pending;
    input.placeholder = available
      ? 'Ask about what is on screen…'
      : 'Analyst offline';
    setNote(
      detail ||
        (available
          ? 'Answers describe only what the console can see.'
          : 'Set OPENAI_API_KEY on the server to enable the analyst.'),
      available ? '' : 'warn',
    );
    renderSuggestions();
    onStatus?.(available ? 'ready' : 'offline');
  }

  /** Ask the server whether a credential is present, without spending one. */
  async function probe() {
    try {
      const response = await fetchImpl(ENDPOINT, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const payload = await readJson(response);
      if (destroyed) return false;
      setAvailability(response.ok && payload.configured === true);
      return configured;
    } catch {
      if (!destroyed) setAvailability(false, 'Analyst endpoint unreachable.');
      return false;
    }
  }

  async function submit() {
    if (pending || !configured || destroyed) return;
    const question = input.value.trim();
    if (!question) return;

    input.value = '';
    input.style.height = '';
    appendTurn('operator', question);
    history.push({ role: 'user', text: question });

    pending = true;
    input.disabled = true;
    if (send) send.disabled = true;
    onStatus?.('busy');
    const thinking = appendTurn('analyst', 'WORKING…', { tone: 'pending' });

    try {
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          history: history.slice(-HISTORY_TURNS - 1, -1),
          context: collectContext(),
        }),
      });
      const payload = await readJson(response);
      if (destroyed) return;
      thinking.remove();
      if (!response.ok || !payload.answer) {
        const reason =
          payload.error ||
          `Analyst request failed (${response.status || 'network'})`;
        appendTurn('analyst', reason, { tone: 'error' });
        onStatus?.('error');
        if (response.status === 503) setAvailability(false);
        return;
      }
      appendTurn('analyst', payload.answer);
      history.push({ role: 'assistant', text: payload.answer });
      onStatus?.('ready');
    } catch (error) {
      if (destroyed) return;
      thinking.remove();
      appendTurn('analyst', error?.message || 'Analyst request failed', {
        tone: 'error',
      });
      onStatus?.('error');
    } finally {
      if (!destroyed) {
        pending = false;
        input.disabled = !configured;
        if (send) send.disabled = !configured;
        if (configured) input.focus({ preventScroll: true });
      }
    }
  }

  listen(form, 'submit', (event) => {
    event.preventDefault();
    submit();
  });
  listen(input, 'keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });
  // Grow the field with the question, up to the cap the stylesheet sets.
  listen(input, 'input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  });

  setAvailability(false, 'Checking analyst availability…');
  appendTurn(
    'analyst',
    'Console analyst standing by. I read the live camera position, the enabled feeds and their health — ask about the scene in front of you.',
  );

  return {
    probe,
    focus: () => input.focus({ preventScroll: true }),
    destroy() {
      destroyed = true;
      for (const remove of removers.splice(0)) remove();
    },
  };
}

export { SUGGESTIONS };
