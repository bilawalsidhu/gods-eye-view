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
    const tagMatches = [...html.matchAll(/<([a-z0-9]+)\s+([^>]*id="([^"]+)"[^>]*)>/gi)];
    for (const match of tagMatches) {
      const tag = match[1];
      const attrs = match[2];
      const id = match[3];
      const el = new MockElement(tag);
      el.id = id;
      if (/\bhidden\b/.test(attrs)) el.hidden = true;
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
  const mockStore = new Map();
  const mockStorage = {
    getItem: (k) => mockStore.get(k) || null,
    setItem: (k, v) => mockStore.set(k, String(v)),
    removeItem: (k) => mockStore.delete(k),
  };
  const audio = new AtcAudioController();
  const radio = new AtcRadioSystem({ audioController: audio, storage: mockStorage });

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
    const liveatcBtn = card.element.querySelector('#atc-liveatc-btn');
    const feedBtn = card.element.querySelector('#atc-feed-btn');
    const customDrawer = card.element.querySelector('#atc-custom-feed-drawer');
    const customUrlInput = card.element.querySelector('#atc-custom-url-input');
    const customSaveBtn = card.element.querySelector('#atc-custom-save-btn');
    const customClearBtn = card.element.querySelector('#atc-custom-clear-btn');
    const customFeedback = card.element.querySelector('#atc-custom-feedback');

    assert.ok(airportLabel.textContent.includes('KAUS'));
    assert.equal(freqDisplay.textContent, '121.000');
    assert.equal(phaseBadge.textContent, 'FINAL APPROACH');
    assert.equal(liveatcBtn.href, 'https://www.liveatc.net/search/?icao=kaus');

    // Toggle custom feed drawer
    assert.equal(customDrawer.hidden, true);
    feedBtn._trigger('click');
    assert.equal(customDrawer.hidden, false);
    assert.equal(feedBtn.getAttribute('aria-expanded'), 'true');

    // Save custom stream URL
    customUrlInput.value = 'https://stream.test/kaus.mp3';
    customSaveBtn._trigger('click');
    assert.equal(customFeedback.textContent, 'Custom stream saved');
    assert.equal(radio.hasCustomStream, true);

    // Clear custom stream URL
    customClearBtn._trigger('click');
    assert.equal(customFeedback.textContent, 'Custom stream removed');
    assert.equal(radio.hasCustomStream, false);

    card.hide();
    assert.equal(card.element.hidden, true);
    card.destroy();
    radio.destroy();
  } finally {
    globalThis.document = originalDoc;
  }
});
