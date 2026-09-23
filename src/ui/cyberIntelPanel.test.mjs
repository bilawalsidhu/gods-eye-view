import test from 'node:test';
import assert from 'node:assert/strict';
import { CyberIntelPanel } from './cyberIntelPanel.js';

class FakeNode {
  constructor(tag = 'div', className = '') {
    this.tagName = tag;
    this.className = className;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
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
  addEventListener() {}
  removeEventListener() {}
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  remove() {
    this.removed = true;
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
  const documentBody = new FakeNode('body');
  const disclosure = new FakeNode('button');
  disclosure.click = () => panel.classList.remove('collapsed');
  panel.disclosure = disclosure;
  const documentRef = {
    body: documentBody,
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => ({ textContent: String(text) }),
    getElementById: (id) =>
      ({ 'cyber-intel-panel': panel, 'cyber-intel-body': body })[id] || null,
  };
  return {
    panel,
    body,
    documentRef,
    disclosure,
  };
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
        id: 'dshield',
        label: 'SANS ISC / DShield',
        status: 'updated 2026-09-20T01:00:00Z',
        fetchedAt: '2026-09-20T01:00:00Z',
        attribution: 'SANS ISC / DShield',
        notice: 'Reports may include false positives.',
        observations: [
          {
            rank: 1,
            indicator: { type: 'ipv4', value: '192.0.2.1' },
            hostname: null,
          },
        ],
        ports: [{ port: 23, protocol: 'tcp', label: 'Telnet' }],
        enrichmentResults: {},
        enrichmentPending: [],
        shodanAreaSearch: {
          matches: [
            {
              ip: '8.8.4.4',
              city: 'Example City',
              country: 'Example Country',
              organization: 'Example Org',
              latitude: 37.7,
              longitude: -97.8,
              geographicPrecision: 'network-approximate',
            },
          ],
        },
      },
    ],
  };
  layer.listener(layer.state);
  assert.equal(f.panel.hidden, false);
  assert.equal(f.panel.classList.contains('collapsed'), false);
  assert.match(f.body.textContent, /192\.0\.2\.1/);
  assert.match(f.body.textContent, /Current Top 10 malicious sources/);
  assert.match(f.body.textContent, /IP Address/);
  assert.match(f.body.textContent, /Domain Name/);
  assert.match(f.body.textContent, /Unavailable/);
  assert.match(f.body.textContent, /Current Top 10 Targeted Ports/);
  assert.match(f.body.textContent, /23\/tcp/);
  assert.match(f.body.textContent, /Optional Shodan search/);
  assert.match(f.body.textContent, /query credit/);
  assert.match(f.body.textContent, /Search Shodan in current map area/);
  assert.match(f.body.textContent, /optional query/);
  assert.match(f.body.textContent, /IPwho\.is approximate network geolocation/);
  assert.match(f.body.textContent, /8\.8\.4\.4/);
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

test('Shodan device selection shows the approximate network location and provenance', () => {
  const f = fixture();
  const layer = {
    state: {
      enabled: true,
      selectedRadar: null,
      selectedShodan: {
        ip: '8.8.4.4',
        organization: 'Example Org',
        services: [{ port: 443, transport: 'tcp', product: 'HTTPS' }],
        hostnames: ['example.net'],
        domains: [],
        city: 'Example City',
        country: 'Example Country',
        latitude: 1,
        longitude: 2,
        geographicMethod: 'IPwho.is IP geolocation',
        geographicProvenance:
          'Approximate network location; not a device or person location.',
        visualOffsetMeters: 42,
        popupPosition: { x: 100, y: 120 },
        attribution: 'Shodan',
        fetchedAt: '2026-09-20T01:00:00Z',
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
  assert.equal(panel.devicePopup.hidden, false);
  assert.equal(panel.devicePopup.style.left, '114px');
  assert.equal(panel.devicePopup.style.top, '134px');
  assert.match(panel.devicePopup.textContent, /SELECTED SHODAN DEVICE/);
  assert.match(panel.devicePopup.textContent, /8\.8\.4\.4/);
  assert.match(panel.devicePopup.textContent, /443\/tcp/);
  assert.match(panel.devicePopup.textContent, /IPwho\.is IP geolocation/);
  assert.match(
    panel.devicePopup.textContent,
    /not a device or person location/,
  );
  assert.match(panel.devicePopup.textContent, /offset about 42 m/);
  const detailCard = panel.devicePopup.children.find(
    (node) => node.className === 'cyber-intel-selection',
  );
  const shodanLink = detailCard.children.find(
    (node) => node.className === 'cyber-shodan-host-link',
  );
  assert.equal(shodanLink.href, 'https://www.shodan.io/host/8.8.4.4');
  assert.equal(shodanLink.target, '_blank');
  assert.equal(shodanLink.rel, 'noopener noreferrer');
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
