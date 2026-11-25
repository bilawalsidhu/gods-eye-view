import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { perfBudgetTestOptions } from '../../scripts/run-perf-tests.mjs';
import { useEntityCardStore } from './stores/entityCard.js';

const GLOBE = { center: { lat: 0, lon: 0 }, heightM: 20_000_000, rect: null };

test(
  'one pass over 50,000 records costs about what the trigonometry alone does',
  perfBudgetTestOptions(),
  () => {
    const records = Array.from({ length: 50_000 }, (_, i) => ({
      id: `f${i}`,
      latitude: ((i * 37) % 170) - 85,
      longitude: ((i * 53) % 360) - 180,
    }));
    const fires = {
      id: 'local-firms',
      name: 'Fires',
      enabled: true,
      stats: { lastUpdate: 1 },
      module: { getAnalystRecords: () => records },
    };
    const store = useEntityCardStore(createPinia());
    const manager = {
      layers: new Map([[fires.id, fires]]),
      isEnabled: (id) => id === fires.id,
      getAll: () => [fires],
    };
    store.connect({ dataManager: () => manager });
    store.setView({ ...GLOBE });
    store.inView(); // warm the code path
    // The floor: the same four trigonometric calls per record, nothing else,
    // timed on this machine now (a loaded machine slows both alike).
    let sink = 0;
    let started = performance.now();
    for (const record of records) {
      const phi = (record.latitude * Math.PI) / 180;
      const lambda = (record.longitude * Math.PI) / 180;
      const cosPhi = Math.cos(phi);
      sink +=
        cosPhi * Math.cos(lambda) + cosPhi * Math.sin(lambda) + Math.sin(phi);
    }
    const floor = performance.now() - started;
    store.setView({ ...GLOBE, center: { lat: 5, lon: 5 } });
    started = performance.now();
    const [group] = store.inView();
    const ms = performance.now() - started;
    assert.equal(group.items.length, 3);
    assert.ok(Number.isFinite(sink));
    console.log(
      `[inView] 50,000 records: ${ms.toFixed(1)} ms (bare trigonometry ${floor.toFixed(1)} ms)`,
    );
    assert.ok(
      // Leave room for scheduler stalls beyond the timed trigonometry.
      ms < floor * 5 + 100,
      `took ${ms.toFixed(1)} ms against a ${floor.toFixed(1)} ms floor`,
    );
  },
);
