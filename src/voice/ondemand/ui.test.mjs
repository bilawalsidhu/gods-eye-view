import test from 'node:test';
import assert from 'node:assert/strict';
import { createOdVoiceUi, bindOdVoiceUi, placeBesideGevMic } from './ui.js';

/** Minimal element good enough for ui.js (no innerHTML parsing: the template markup is pre-built). */
function el(doc, tag, { id = '', className = '' } = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    id,
    children: [],
    parentElement: null,
    attributes: {},
    dataset: {},
    textContent: '',
    title: '',
    listeners: {},
    classList: {
      list: new Set(className ? className.split(' ') : []),
      add(name) {
        this.list.add(name);
      },
      contains(name) {
        return this.list.has(name);
      },
    },
    get nextSibling() {
      const siblings = node.parentElement?.children || [];
      return siblings[siblings.indexOf(node) + 1] || null;
    },
    setAttribute(name, value) {
      node.attributes[name] = String(value);
    },
    getAttribute(name) {
      return node.attributes[name] ?? null;
    },
    appendChild(child) {
      child.parentElement?.removeChild(child);
      child.parentElement = node;
      node.children.push(child);
      doc._mutated();
      return child;
    },
    insertBefore(child, ref) {
      child.parentElement?.removeChild(child);
      child.parentElement = node;
      const index = ref ? node.children.indexOf(ref) : -1;
      if (index === -1) node.children.push(child);
      else node.children.splice(index, 0, child);
      doc._mutated();
      return child;
    },
    removeChild(child) {
      node.children = node.children.filter((c) => c !== child);
      child.parentElement = null;
    },
    querySelector(selector) {
      return find(node, selector)[0] || null;
    },
    addEventListener(type, fn) {
      (node.listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      node.listeners[type] = (node.listeners[type] || []).filter((f) => f !== fn);
    },
    click() {
      for (const fn of node.listeners.click || []) fn();
    },
  };
  return node;
}

function find(root, selector) {
  const out = [];
  const walk = (n) => {
    for (const child of n.children) {
      if (
        (selector.startsWith('#') && child.id === selector.slice(1)) ||
        (selector.startsWith('.') && child.classList.contains(selector.slice(1)))
      )
        out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function makeDoc({ withTemplate = true, withGevMic = true } = {}) {
  const doc = {
    mutations: 0,
    _mutated() {
      doc.mutations += 1;
    },
  };
  doc.body = el(doc, 'body');
  doc.documentElement = doc.body;
  doc.createElement = (tag) => el(doc, tag);
  doc.getElementById = (id) => find(doc.body, `#${id}`)[0] || null;
  const dock = el(doc, 'div', { id: 'command-dock' });
  doc.body.appendChild(dock);
  const controlPanel = el(doc, 'div', { id: 'control-panel' });
  if (withTemplate) {
    const root = el(doc, 'div', { id: 'od-voice-control', className: 'od-voice' });
    const heading = el(doc, 'div', { className: 'od-voice-heading' });
    heading.appendChild(el(doc, 'span', { className: 'od-voice-kicker' }));
    heading.appendChild(el(doc, 'button', { id: 'od-voice-route', className: 'od-voice-route' }));
    root.appendChild(heading);
    const row = el(doc, 'div', { className: 'od-voice-row' });
    const button = el(doc, 'button', { id: 'od-voice-button', className: 'od-voice-btn' });
    button.appendChild(el(doc, 'span', { className: 'od-voice-btn-label' }));
    row.appendChild(button);
    const meta = el(doc, 'div', { className: 'od-voice-meta' });
    meta.appendChild(el(doc, 'span', { id: 'od-voice-status', className: 'od-voice-chip' }));
    meta.appendChild(el(doc, 'span', { id: 'od-voice-detail', className: 'od-voice-detail' }));
    row.appendChild(meta);
    root.appendChild(row);
    root.appendChild(el(doc, 'div', { id: 'od-voice-transcript', className: 'od-voice-line' }));
    root.appendChild(el(doc, 'div', { id: 'od-voice-answer', className: 'od-voice-line' }));
    root.appendChild(el(doc, 'div', { id: 'od-voice-workflow', className: 'od-voice-line' }));
    dock.appendChild(root);
  }
  dock.appendChild(el(doc, 'div', { id: 'location-bar' }));
  if (withGevMic) dock.appendChild(el(doc, 'div', { id: 'gev-voice-control' }));
  dock.appendChild(controlPanel);
  return { doc, dock };
}

function fakePipeline() {
  const listeners = new Set();
  let state = 'idle';
  let mode = 'auto';
  const pipeline = {
    presses: 0,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(event) {
      if (event.type === 'state') state = event.state;
      for (const fn of listeners) fn(event);
    },
    getState: () => state,
    getDetail: () => '',
    getMode: () => mode,
    setMode(next) {
      mode = next;
      pipeline.emit({ type: 'mode', mode: next });
      return mode;
    },
    async press() {
      pipeline.presses += 1;
      return 'listen';
    },
  };
  return pipeline;
}

test('the template control is adopted and moved right beside #gev-voice-control (existing button untouched)', () => {
  const { doc, dock } = makeDoc();
  const ui = createOdVoiceUi({ doc });
  assert.equal(ui.root.id, 'od-voice-control');
  assert.ok(ui.button && ui.status && ui.route && ui.transcript && ui.answer && ui.workflow);
  assert.deepEqual(
    dock.children.map((c) => c.id),
    ['location-bar', 'gev-voice-control', 'od-voice-control', 'control-panel'],
  );
  assert.equal(placeBesideGevMic(ui.root, doc), 'beside-gev-mic');
  assert.deepEqual(
    dock.children.map((c) => c.id),
    ['location-bar', 'gev-voice-control', 'od-voice-control', 'control-panel'],
    'idempotent',
  );
});

test('without a GEV MIC control the OD VOICE control stays in the dock', () => {
  const { doc, dock } = makeDoc({ withGevMic: false });
  const ui = createOdVoiceUi({ doc });
  assert.equal(ui.root.parentElement, dock);
});

test('bindOdVoiceUi mirrors pipeline events: state chip, detail, transcript/answer lines, workflow telemetry, route toggle, button press', () => {
  const { doc } = makeDoc();
  const ui = createOdVoiceUi({ doc });
  const pipeline = fakePipeline();
  const unbind = bindOdVoiceUi(ui, pipeline, { doc });
  assert.equal(ui.status.textContent, 'IDLE');
  assert.equal(ui.root.dataset.state, 'idle');
  assert.equal(ui.root.dataset.route, 'auto');
  assert.equal(ui.route.textContent, 'AUTO');

  pipeline.emit({ type: 'state', state: 'listening', detail: 'Listening…' });
  assert.equal(ui.status.textContent, 'LISTENING');
  assert.equal(ui.root.dataset.state, 'listening');
  assert.equal(ui.button.getAttribute('aria-pressed'), 'true');
  assert.equal(ui.buttonLabel.textContent, 'SEND');

  pipeline.emit({ type: 'transcript', text: 'show military flights near me' });
  assert.equal(ui.transcript.textContent, '› show military flights near me');
  pipeline.emit({ type: 'answer', text: 'Military flights layer is on.', partial: true, source: 'chat' });
  assert.equal(ui.answer.textContent, '‹ Military flights layer is on.');
  assert.equal(ui.answer.dataset.partial, 'true');
  pipeline.emit({ type: 'workflow', phase: 'done', executionId: 'exec-1', status: 'success', timeToFirstLogMs: 1400, totalMs: 9000, actionCount: 2 });
  assert.equal(ui.workflow.textContent, 'workflow exec-1: success · first log 1400 ms · total 9000 ms · 2 action(s)');
  pipeline.emit({ type: 'state', state: 'error', detail: 'Transcription failed: OnDemand is not configured on this deployment' });
  assert.equal(ui.status.textContent, 'ERROR');
  assert.equal(ui.detail.textContent, 'Transcription failed: OnDemand is not configured on this deployment');
  assert.equal(ui.buttonLabel.textContent, 'RETRY');

  ui.route.click();
  assert.equal(pipeline.getMode(), 'workflow');
  assert.equal(ui.route.textContent, 'WF');
  assert.equal(ui.root.dataset.route, 'workflow');
  ui.route.click();
  assert.equal(ui.route.textContent, 'CHAT');
  ui.route.click();
  assert.equal(ui.route.textContent, 'AUTO');

  ui.button.click();
  assert.equal(pipeline.presses, 1);
  unbind();
  ui.button.click();
  assert.equal(pipeline.presses, 1, 'unbound');
});
