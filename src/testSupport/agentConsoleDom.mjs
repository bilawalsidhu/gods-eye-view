import { t } from '../i18n/index.js';
import {
  providerOptionLabel,
  modelOptionLabel,
} from '../agent/agentConsole.js';
import { formatCommandCostUsd } from '../agent/cost.js';
import { readFileSync } from 'node:fs';

/**
 * A minimal document holding the ids `agent-console.html` declares, so the
 * typed console can be mounted and driven under `node --test`.
 *
 * The id list is READ from the template rather than restated, so a renamed
 * element fails the test that mounts the console instead of silently handing
 * it a stub the real page would not have.
 */

/** Element ids the shipped console template declares. */
export function consoleTemplateIds() {
  const html = readFileSync(
    new URL('../ui/views/AgentConsoleView.vue', import.meta.url),
    'utf8',
  );
  return [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
}

function createElement(tag) {
  const node = new EventTarget();
  Object.assign(node, {
    tagName: String(tag).toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    attributes: new Map(),
    className: '',
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    open: false,
    focused: false,
    scrollTop: 0,
    scrollHeight: 0,
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    },
    appendChild(child) {
      this.children.push(child);
      child.parent = this;
      this.scrollHeight = this.children.length * 10;
      return child;
    },
    replaceChildren(...nodes) {
      this.children = [];
      for (const child of nodes) this.appendChild(child);
    },
    remove() {
      const siblings = this.parent?.children;
      if (!siblings) return;
      const index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
      this.parent = null;
    },
    isConnected: true,
    focus() {
      this.focused = true;
      if (this.ownerDocument) this.ownerDocument.activeElement = this;
    },
    blur() {
      this.focused = false;
    },
    getClientRects() {
      return [{ width: 10, height: 10 }];
    },
    hasAttribute(name) {
      return this.attributes.has(name);
    },
    matches(selector) {
      if (selector.startsWith('[') && selector.endsWith(']')) {
        const name = selector.slice(1, -1).replace(/^data-/, '');
        const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        return this.dataset[key] !== undefined;
      }
      if (selector.startsWith('.')) {
        return this.classList.contains(selector.slice(1));
      }
      return this.tagName === selector.toUpperCase();
    },
    closest(selector) {
      for (let node = this; node; node = node.parent) {
        if (node.matches?.(selector.split(',')[0].trim())) return node;
      }
      return null;
    },
    querySelector(selector) {
      const find = (node) => {
        for (const child of node.children) {
          if (child.matches?.(selector)) return child;
          const nested = find(child);
          if (nested) return nested;
        }
        return null;
      };
      return find(this);
    },
    querySelectorAll() {
      return [];
    },
    show() {
      this.open = true;
    },
    showModal() {
      this.open = true;
      this.modal = true;
    },
    close() {
      this.open = false;
    },
  });
  // Defined here, not through Object.assign, which would copy the getter's
  // value once instead of the getter itself.
  Object.defineProperties(node, {
    lastElementChild: { get: () => node.children.at(-1) ?? null },
    options: { get: () => node.children },
  });
  const classes = () => new Set(node.className.split(' ').filter(Boolean));
  node.classList = {
    contains: (name) => classes().has(name),
    add(...names) {
      const next = classes();
      for (const name of names) next.add(name);
      node.className = [...next].join(' ');
    },
    remove(...names) {
      const next = classes();
      for (const name of names) next.delete(name);
      node.className = [...next].join(' ');
    },
  };
  return node;
}

/**
 * Build the fake document plus named handles for the console's elements.
 *
 * @param {{ids?: string[]}} [options]
 */
export function agentConsoleDom({ ids = consoleTemplateIds() } = {}) {
  // A stand-in window: the box controller listens for pointer and resize
  // events here, not on the document.
  const view = Object.assign(new EventTarget(), {
    innerWidth: 1440,
    innerHeight: 900,
  });
  let pointerClock = 0;
  // An EventTarget, because the shared surface keyboard listens for Escape on
  // the document in the capture phase rather than on the surface.
  const document = Object.assign(new EventTarget(), {
    createElement,
    activeElement: null,
  });
  const elements = new Map(
    ids.map((id) => {
      const element = createElement('div');
      element.ownerDocument = document;
      return [id, element];
    }),
  );
  document.getElementById = (id) => elements.get(id) ?? null;
  // The console drags by its header, which the real template nests inside the
  // dialog. The fixture's elements are flat by id, so the one structural
  // relationship the console depends on is built explicitly.
  const header = createElement('header');
  header.ownerDocument = document;
  header.dataset.panelHeader = '';
  elements.get('agent-console')?.appendChild(header);
  const byId = (id) => {
    const element = elements.get(id);
    if (!element) throw new Error(`The console template has no #${id}`);
    return element;
  };
  return {
    // A synchronous presentation sink for controller-only tests. The actual
    // Vue renderer is covered separately by agentConsoleView.test.mjs/browser QA.
    publish(state) {
      const set = (id, key, value) => {
        const el = elements.get(id);
        if (el) el[key] = value;
      };
      set('agent-console-chip', 'hidden', !state.available);
      elements
        .get('agent-console-chip')
        ?.setAttribute('aria-expanded', String(state.expanded));
      const options = (id, items, label, value) => {
        const el = elements.get(id);
        if (!el) return;
        el.replaceChildren(
          ...items.map((item) => {
            const opt = createElement('option');
            opt.value = item.id;
            opt.textContent = label(item);
            return opt;
          }),
        );
        el.value = value;
      };
      options(
        'agent-provider',
        state.providers,
        providerOptionLabel,
        state.provider,
      );
      options('agent-model', state.models, modelOptionLabel, state.model);
      for (const id of ['agent-input', 'agent-send', 'agent-model'])
        set(id, 'disabled', state.busy);
      set('agent-provider', 'disabled', state.providerDisabled);
      set('agent-stop', 'disabled', state.stopDisabled);
      const detail =
        typeof state.detail === 'object'
          ? t(state.detail.key, state.detail.args)
          : t(state.detail);
      set(
        'agent-status',
        'textContent',
        t(state.status) + (detail ? ' · ' + detail : ''),
      );
      elements.get('agent-console').dataset.agentStatus =
        state.status.toLowerCase();
      const cost =
        state.provider === 'chatgpt'
          ? t('ChatGPT plan limits')
          : formatCommandCostUsd(
              state.models.find((m) => m.id === state.model)?.costPerCommandUsd,
            );
      set('agent-cost', 'textContent', cost);
      set(
        'agent-cost',
        'title',
        state.provider === 'chatgpt'
          ? t('ChatGPT plan limits')
          : t('Estimated cost per command'),
      );
      elements.get('agent-transcript').replaceChildren(
        ...state.entries.map((entry) => {
          const el = createElement('li');
          el.className = `agent-entry agent-entry-${entry.kind}`;
          el.textContent = entry.text;
          el.setAttribute('dir', entry.kind === 'tool' ? 'ltr' : 'auto');
          if (entry.outcome) el.dataset.outcome = entry.outcome;
          return el;
        }),
      );
    },
    publishChatgpt(state) {
      if (!state) return;
      const el = (id) => elements.get(id);
      el('agent-chatgpt').hidden = !state.visible;
      const select = el('agent-chatgpt-account');
      select.replaceChildren(
        ...[
          ...state.accounts,
          { id: '', label: t('Add a ChatGPT account') },
        ].map((a) => {
          const option = createElement('option');
          option.value = a.id;
          option.textContent = a.label;
          return option;
        }),
      );
      select.value = state.selected;
      select.disabled = el('agent-chatgpt-login').disabled = state.disabled;
      el('agent-chatgpt-logout').disabled = state.logoutDisabled;
      const status = el('agent-chatgpt-status');
      status.textContent = state.pending
        ? t('Complete sign-in in your browser.')
        : state.error ||
          t(
            state.connected
              ? 'ChatGPT account connected'
              : 'Sign in to use your ChatGPT plan.',
          );
      if (state.signInPath) {
        const link = createElement('a');
        link.href = state.signInPath;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        status.replaceChildren(link);
      }
    },
    document,
    elements,
    dialog: byId('agent-console'),
    header,
    chip: byId('agent-console-chip'),
    closeButton: byId('agent-console-close'),
    providerSelect: byId('agent-provider'),
    modelSelect: byId('agent-model'),
    transcript: byId('agent-transcript'),
    form: byId('agent-form'),
    input: byId('agent-input'),
    sendButton: byId('agent-send'),
    status: byId('agent-status'),
    cost: byId('agent-cost'),
    /** Click an element the way the browser would. */
    click(element) {
      element.dispatchEvent(new Event('click'));
    },
    /** Submit the console's form. */
    submit() {
      const event = new Event('submit');
      event.preventDefault = () => {};
      byId('agent-form').dispatchEvent(event);
    },
    /** Change a select and fire the event the console listens for. */
    select(element, value) {
      element.value = value;
      element.dispatchEvent(new Event('change'));
    },
    /** Press a pointer button on an element, as the window sees it. */
    pointer(element, type, { x = 0, y = 0, button = 0, pointerId = 1 } = {}) {
      const event = new Event(type);
      Object.assign(event, { clientX: x, clientY: y, button, pointerId });
      // `target` and `timeStamp` are getter-only on a real Event.
      for (const [name, value] of [
        ['target', element],
        ['currentTarget', element],
        ['timeStamp', pointerClock],
      ]) {
        Object.defineProperty(event, name, { configurable: true, value });
      }
      event.preventDefault = () => {};
      event.stopPropagation = () => {};
      // A press is delivered to the element; the rest of the gesture is
      // tracked on the window, as the controller listens for it there.
      if (type === 'pointerdown') element.dispatchEvent(event);
      else view.dispatchEvent(event);
      return event;
    },
    /** Advance the clock the double-press detector reads. */
    advance(ms) {
      pointerClock += ms;
    },
    view,

    /** Press a key, as the document-level surface keyboard sees it. */
    /**
     * Dispatch a key in the capture phase and report whether the surface
     * claimed it, which is how "the console no longer eats Escape" is
     * observable at all.
     *
     * @returns {{prevented: boolean, stopped: boolean}}
     */
    keydown(key) {
      const claimed = { prevented: false, stopped: false };
      const event = new Event('keydown');
      event.key = key;
      event.preventDefault = () => {
        claimed.prevented = true;
      };
      event.stopPropagation = () => {
        claimed.stopped = true;
      };
      document.dispatchEvent(event);
      return claimed;
    },
    /** The transcript as [kind, text] pairs. */
    entries() {
      return byId('agent-transcript').children.map((child) => [
        child.className.replace('agent-entry agent-entry-', ''),
        child.textContent,
      ]);
    },
  };
}

/** A storage stand-in, optionally one that throws like a privacy mode does. */
export function fakeStorage({ throws = false } = {}) {
  const map = new Map();
  return {
    getItem(key) {
      if (throws) throw new Error('storage is unavailable');
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (throws) throw new Error('storage is unavailable');
      map.set(key, String(value));
    },
    removeItem(key) {
      if (throws) throw new Error('storage is unavailable');
      map.delete(key);
    },
    get size() {
      return map.size;
    },
  };
}
