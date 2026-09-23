import test from 'node:test';
import assert from 'node:assert/strict';
import { CyberIntelPanel } from './cyberIntelPanel.js';

class FakeNode {
  constructor(tag = 'div', className = '') {
    this.tagName = tag;
    this.className = className;
    this.children = [];
    this.attributes = new Map();
    this.hidden = false;
    this.inert = false;
    this.classList = {
      contains: (value) => this.className.split(/\s+/).includes(value),
      add: (value) => {
        if (!this.classList.contains(value)) this.className += ` ${value}`;
      },
      remove: (value) => {
        this.className = this.className
          .split(/\s+/)
          .filter((item) => item !== value)
          .join(' ');
      },
    };
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  querySelector(selector) {
    return selector === '[data-collapse-target="cyber-intel-panel"]'
      ? this.disclosure
      : null;
  }
  get textContent() {
    return [
      this._text || '',
      ...this.children.map((node) => node?.textContent || ''),
    ].join('');
  }
  set textContent(value) {
    this._text = String(value);
  }
}

function fixture() {
  const panel = new FakeNode('section', 'panel-collapsible collapsed');
  const body = new FakeNode('div');
  const disclosure = new FakeNode('button');
  disclosure.click = () => panel.classList.remove('collapsed');
  panel.disclosure = disclosure;
  const documentRef = {
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => ({ textContent: String(text) }),
    getElementById: (id) =>
      ({ 'cyber-intel-panel': panel, 'cyber-intel-body': body })[id] || null,
  };
  return { panel, body, documentRef, disclosure };
}

test('Cyber Threat Intel remains hidden unless Cyber Activity is enabled', () => {
  const f = fixture();
  const layer = {
    state: { enabled: false, selectedRadar: null, nonGeographicProviders: [] },
    setThreatIntelListener(listener) {
      this.listener = listener;
    },
    getThreatIntelState() {
      return this.state;
    },
  };
  const panel = new CyberIntelPanel({ documentRef: f.documentRef });
  panel.mount(layer);
  assert.equal(f.panel.hidden, true);
  layer.state = {
    enabled: true,
    selectedRadar: null,
    nonGeographicProviders: [
      {
        label: 'SANS ISC / DShield',
        status: 'updated 2026-09-20T01:00:00Z',
        fetchedAt: '2026-09-20T01:00:00Z',
        attribution: 'SANS ISC / DShield',
        notice: 'Reports may include false positives.',
        observations: [
          { rank: 1, indicator: { value: '192.0.2.1' }, hostname: null },
        ],
        ports: [{ port: 23, protocol: 'tcp', label: 'Telnet' }],
      },
    ],
  };
  layer.listener(layer.state);
  assert.equal(f.panel.hidden, false);
  assert.equal(f.panel.classList.contains('collapsed'), false);
  assert.match(f.body.textContent, /192\.0\.2\.1/);
  assert.match(f.body.textContent, /23\/tcp/);
  layer.state = {
    enabled: false,
    selectedRadar: null,
    nonGeographicProviders: [],
  };
  layer.listener(layer.state);
  assert.equal(f.panel.hidden, true);
  assert.equal(f.panel.inert, true);
  panel.destroy();
});

test('Radar selection details expand the panel and identify the country pair', () => {
  const f = fixture();
  const layer = {
    state: {
      enabled: true,
      selectedRadar: {
        type: 'flow',
        origin: { code: 'US', name: 'United States' },
        target: { code: 'BE', name: 'Belgium' },
        share: 3.6,
        rank: 2,
        windowStart: '2026-09-19T00:00:00Z',
        windowEnd: '2026-09-20T00:00:00Z',
        geographicProvenance: 'Cloudflare Radar country-level pair',
      },
      nonGeographicProviders: [],
    },
    setThreatIntelListener(listener) {
      this.listener = listener;
    },
    getThreatIntelState() {
      return this.state;
    },
  };
  const panel = new CyberIntelPanel({ documentRef: f.documentRef });
  panel.mount(layer);
  assert.equal(f.panel.hidden, false);
  assert.equal(f.panel.classList.contains('collapsed'), false);
  assert.match(f.body.textContent, /United States/);
  assert.match(f.body.textContent, /Belgium/);
  assert.match(f.body.textContent, /3\.6%/);
  assert.match(f.body.textContent, /country-level pair/);
  panel.destroy();
});
