import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setMemory,
  readMemory,
  deleteMemory,
  searchMemory,
  getMemoryStats,
  executeTool,
} from '../server/providers/jarvis-tools.js';

test('Persistent memory system operations', async (t) => {
  await t.test('executeTool routes remember, recall, and memory_stats', async () => {
    const memRes = await executeTool('remember', {
      key: 'routed_mission_code',
      value: 'ORBIT_DELTA_9',
      category: 'mission',
      tags: ['orbital', 'classified'],
    });
    assert.equal(memRes.stored, true);
    assert.equal(memRes.category, 'mission');

    const recallRes = await executeTool('recall', { query: 'DELTA_9' });
    assert.ok(recallRes.routed_mission_code);

    const statsRes = await executeTool('memory_stats', {});
    assert.ok(statsRes.totalKeys > 0);

    await deleteMemory('routed_mission_code');
  });
  await t.test('setMemory stores key with category, tags and timestamps', async () => {
    const res = await setMemory('test_recon_target', { lat: 35.6895, lon: 139.6917 }, {
      category: 'tactical',
      tags: ['satellite', 'recon', 'tokyo'],
    });

    assert.equal(res.key, 'test_recon_target');
    assert.equal(res.stored, true);
    assert.equal(res.category, 'tactical');

    const mem = await readMemory();
    assert.ok(mem.test_recon_target);
    assert.equal(mem.test_recon_target.category, 'tactical');
    assert.deepEqual(mem.test_recon_target.tags, ['satellite', 'recon', 'tokyo']);
    assert.ok(mem.test_recon_target.updatedAt);
  });

  await t.test('searchMemory retrieves by key, content, tags, or category', async () => {
    await setMemory('user_favorite_aircraft', 'SR-71 Blackbird', {
      category: 'preferences',
      tags: ['aviation', 'mach3'],
    });

    // Exact key search
    const keyMatch = await searchMemory('user_favorite_aircraft');
    assert.ok(keyMatch.user_favorite_aircraft);
    assert.equal(keyMatch.matches[0].key, 'user_favorite_aircraft');

    // Tag search
    const tagMatch = await searchMemory('mach3');
    assert.ok(tagMatch.user_favorite_aircraft);

    // Value content search
    const valMatch = await searchMemory('Blackbird');
    assert.ok(valMatch.user_favorite_aircraft);

    // Category filter
    const catMatch = await searchMemory('', { category: 'preferences' });
    assert.ok(catMatch.user_favorite_aircraft);

    // Empty query returns results without crashing
    const emptyMatch = await searchMemory('');
    assert.ok(emptyMatch.matches.length > 0);

    // Undefined query handles gracefully
    const undefMatch = await searchMemory(undefined);
    assert.ok(undefMatch.matches.length > 0);
  });

  await t.test('getMemoryStats returns statistics summary', async () => {
    const stats = await getMemoryStats();
    assert.ok(typeof stats.totalKeys === 'number');
    assert.ok(stats.totalKeys >= 2);
    assert.ok(stats.categories.tactical >= 1);
    assert.ok(stats.categories.preferences >= 1);
  });

  await t.test('deleteMemory removes existing key and returns status', async () => {
    const delRes1 = await deleteMemory('test_recon_target');
    assert.equal(delRes1.deleted, true);

    const delRes2 = await deleteMemory('user_favorite_aircraft');
    assert.equal(delRes2.deleted, true);

    const delResNonExistent = await deleteMemory('definitely_non_existent_key_999');
    assert.equal(delResNonExistent.deleted, false);
  });
});
