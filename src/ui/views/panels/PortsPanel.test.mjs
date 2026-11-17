import '../../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { usePortsStore } from '../../stores/ports.js';
import PortsPanel from './PortsPanel.vue';
import { normalizePort } from '../../../layers/ports/source.js';

test('profile keeps throughput separate from capacity, cites facts, and sends filter/selection actions', async (test) => {
  document.body.replaceChildren();
  const pinia = createPinia();
  const store = usePortsStore(pinia);
  const calls = [];
  store.connect({
    filter: (p) => calls.push(p),
    select: (id) => calls.push(id),
  });
  const app = createApp(PortsPanel).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  test.after(() => app.unmount());
  assert.equal(document.querySelector('#ports-panel'), null);
  const row = normalizePort({
    geometry: { type: 'Point', coordinates: [55, 25] },
    properties: {
      wpinumber: 48276,
      main_port_name: 'Mina Jabal Ali',
      wpi_cc: 'United Arab Emirates',
      fac_container: 'Yes',
    },
  });
  store.publish({
    country: '',
    facility: '',
    countries: ['United Arab Emirates'],
    rows: [row],
    total: 1,
    selected: row,
    sourceUpdatedAt: Date.UTC(2026, 3, 20),
    fetchedAt: Date.UTC(2026, 10, 17),
  });
  await nextTick();
  const el = document.querySelector('#ports-panel');
  assert.match(el.textContent, /15,500,000 TEU/);
  assert.match(el.textContent, /19,400,000 TEU\/year/);
  assert.match(el.textContent, /2024/);
  assert.match(el.textContent, /Not provided by source/);
  assert.match(el.textContent, /2026-04-20/);
  assert.match(el.textContent, /2026-11-17/);
  const anchors = [...el.querySelectorAll('a')];
  assert.ok(anchors.some((a) => a.href.includes('dpworld.com')));
  assert.ok(
    anchors.every(
      (a) => a.rel.includes('noopener') && a.href.startsWith('https://'),
    ),
  );
  const selects = el.querySelectorAll('select');
  selects[0].value = 'United Arab Emirates';
  selects[0].dispatchEvent(new Event('change'));
  selects[1].value = 'container';
  selects[1].dispatchEvent(new Event('change'));
  selects[2].value = row.id;
  selects[2].dispatchEvent(new Event('change'));
  assert.deepEqual(calls, [
    { country: 'United Arab Emirates' },
    { facility: 'container' },
    row.id,
  ]);
  // Failure and exclusion states are visible, even with previously retained records.
  store.publish({...store.panel, error: 'offline', partial: true, excluded: 4});
  await nextTick();
  assert.match(el.querySelector('[role="alert"]').textContent, /Port reference unavailable/);
  assert.match(el.textContent, /Some source records could not be displayed: 4/);
  assert.equal(el.querySelector('h3').textContent, 'Mina Jabal Ali');
  store.publish(null);
  await nextTick();
  assert.equal(document.querySelector('#ports-panel'), null);
});
