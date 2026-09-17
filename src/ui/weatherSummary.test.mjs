import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherSummary } from './weatherSummary.js';

function fixture() {
  const document = {
    createElement: () => {
      const element = new EventTarget();
      Object.assign(element, {
        ownerDocument: document,
        children: [],
        dataset: {},
        style: {},
        setAttribute() {},
        appendChild(child) {
          this.children.push(child);
          child.parent = this;
        },
        remove() {
          this.parent.children = this.parent.children.filter(
            (child) => child !== this,
          );
        },
      });
      return element;
    },
  };
  return document.createElement('body');
}

test('weather summary preserves buttons during refresh and removes inactive products and owner', () => {
  const container = fixture();
  const view = createWeatherSummary({ container });
  const root = container.children[0];
  assert.equal(root.hidden, true);
  const entry = {
    id: 'wind',
    summary: {
      label: 'Temperature',
      detail: 'Forecast · 20:00 UTC',
      units: '°C',
    },
    legend: [
      { label: '-40', color: '#0000ff' },
      { label: '50+', color: '#ff0000' },
    ],
  };
  view.update([entry]);
  assert.equal(root.hidden, false);
  const button = root.children[1];
  assert.equal(button.children[0].textContent, 'Temperature');
  assert.equal(
    button.children[3].style.background,
    'linear-gradient(to right, #0000ff,#ff0000)',
  );
  view.update([
    {
      ...entry,
      summary: { ...entry.summary, status: '<img onerror=alert(1)>' },
    },
  ]);
  assert.equal(root.children[1], button, 'keyboard focus target is stable');
  assert.equal(button.children[2].textContent, '<img onerror=alert(1)>');
  assert.equal(
    button.children[2].children.length,
    0,
    'source status remains plain text',
  );
  view.update([]);
  assert.equal(root.hidden, true);
  assert.equal(root.children.length, 1);
  view.destroy();
  assert.equal(container.children.length, 0);
});

test('weather summary excludes arbitrary CSS from legend and supports missing DOM', () => {
  assert.equal(createWeatherSummary(), null);
  const container = fixture();
  const view = createWeatherSummary({ container });
  view.update([
    {
      id: 'wind',
      summary: { label: 'Wind', detail: 'Forecast' },
      legend: [{ color: 'url(https://invalid.example)' }, { color: '#ffffff' }],
    },
  ]);
  const ramp = container.children[0].children[1].children[3];
  assert.equal(ramp.style.background, '');
  assert.equal(ramp.hidden, true);
  view.destroy();
});

test('temperature freezing anchor follows its physical legend position, not its midpoint', () => {
  const container = fixture();
  const view = createWeatherSummary({ container });
  const legend = Array.from({ length: 10 }, (_, index) => ({
    label: String(-40 + index * 10),
    color: '#abcdef',
  }));
  view.update([
    { id: 'wind', summary: { label: 'Temperature', units: '°C' }, legend },
  ]);
  const zero = container.children[0].children[1].children[3].children[0];
  assert.equal(zero.hidden, false);
  assert.ok(Math.abs(parseFloat(zero.style.left) - 44.444444) < 0.001);
  view.update([
    { id: 'wind', summary: { label: 'Speed', units: 'km/h' }, legend },
  ]);
  assert.equal(zero.hidden, true);
  view.destroy();
});
