import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AtcRadioCard } from './atcRadioCard.js';
import { AtcRadioSystem } from './atcRadio.js';
import { AtcAudioController } from './atcAudio.js';

// Minimal DOM mock for Node environment testing
class MockElement {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.id = '';
    this.className = '';
    this.hidden = false;
    this.attributes = new Map();
    this.children = [];
    this.listeners = new Map();
    this.textContent = '';
    this.value = '80';
    this.classList = {
      _classes: new Set(),
      add: (cls) => this.classList._classes.add(cls),
      remove: (cls) => this.classList._classes.delete(cls),
      toggle: (cls, force) => {
        if (force === undefined) {
          if (this.classList._classes.has(cls)) this.classList._classes.delete(cls);
          else this.classList._classes.add(cls);
        } else if (force) {
          this.classList._classes.add(cls);
        } else {
          this.classList._classes.delete(cls);
        }
      },
      contains: (cls) => this.classList._classes.has(cls),
    };
  }

  set innerHTML(html) {
    this.children = [];
    const idMatches = [...html.matchAll(/id="([^"]+)"/g)];
    for (const match of idMatches) {
      const el = new MockElement();
      el.id = match[1];
      this.children.push(el);
    }
    const dataFreqMatches = [...html.matchAll(/data-freq-type="([^"]+)"/g)];
    for (const match of dataFreqMatches) {
      const el = new MockElement('button');
      el.setAttribute('data-freq-type', match[1]);
      this.children.push(el);
    }
  }

  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k) {
    return this.attributes.get(k) || null;
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  remove() {
    this.children = [];
  }
  addEventListener(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(cb);
  }
  _trigger(event, data = {}) {
    for (const cb of this.listeners.get(event) || []) cb(data);
  }
  querySelector(sel) {
    if (sel.startsWith('#')) {
      const id = sel.slice(1);
      return this._find((el) => el.id === id);
    }
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      return this._find((el) => el.classList.contains(cls));
    }
    return null;
  }
  querySelectorAll(sel) {
    const results = [];
    this._findAll(sel, results);
    return results;
  }
  _find(predicate) {
    if (predicate(this)) return this;
    for (const ch of this.children) {
      const found = ch._find(predicate);
      if (found) return found;
    }
    return null;
  }
  _findAll(sel, out) {
    if (sel === '[data-freq-type]' && this.attributes.has('data-freq-type')) {
      out.push(this);
    }
    for (const ch of this.children) ch._findAll(sel, out);
  }
}

test('atcRadioCard: renders and updates DOM elements on state changes', () => {
  const container = new MockElement('body');
  const audio = new AtcAudioController();
  const radio = new AtcRadioSystem({ audioController: audio });

  // Mock global document
  const originalDoc = globalThis.document;
  globalThis.document = {
    getElementById: (id) => container.querySelector(`#${id}`),
    createElement: (tag) => new MockElement(tag),
  };

  try {
    const card = new AtcRadioCard({ atcRadio: radio, container });
    assert.ok(card.element);
    assert.equal(card.element.hidden, true);

    card.show();
    assert.equal(card.element.hidden, false);

    // Feed aircraft telemetry approaching KAUS
    radio.updateAircraftTelemetry({
      lat: 30.15,
      lon: -97.66,
      altitudeM: 900,
      verticalRateMps: -3.0,
      groundSpeedKts: 140,
    });

    const airportLabel = card.element.querySelector('#atc-airport-label');
    const freqDisplay = card.element.querySelector('#atc-frequency-display');
    const phaseBadge = card.element.querySelector('#atc-phase-badge');

    assert.ok(airportLabel.textContent.includes('KAUS'));
    assert.equal(freqDisplay.textContent, '121.000');
    assert.equal(phaseBadge.textContent, 'FINAL APPROACH');

    card.hide();
    assert.equal(card.element.hidden, true);
    card.destroy();
    radio.destroy();
  } finally {
    globalThis.document = originalDoc;
  }
});
