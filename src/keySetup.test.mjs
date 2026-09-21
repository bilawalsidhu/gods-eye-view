import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectKeyUpdates,
  keySetupChipLabel,
  stripKeylessBasemapFromHash,
} from './keySetup.js';

test('the chip counts what is missing, and retires the count at zero', () => {
  assert.equal(keySetupChipLabel({ setCount: 0, total: 8 }), 'POWER UP · 8 KEYS WAITING');
  assert.equal(keySetupChipLabel({ setCount: 7, total: 8 }), 'POWER UP · 1 KEY WAITING');
  assert.equal(keySetupChipLabel({ setCount: 8, total: 8 }), 'POWERED UP');
  assert.equal(keySetupChipLabel(null), 'POWERED UP', 'no status is not a broken label');
});

test('collectKeyUpdates keeps only non-empty trimmed values', () => {
  const updates = collectKeyUpdates([
    { envVar: 'OPENAI_API_KEY', value: '  sk-abc  ' },
    { envVar: 'FIRMS_MAP_KEY', value: '' },
    { envVar: 'TOMTOM_API_KEY', value: '   ' },
    { envVar: '', value: 'orphan' },
    null,
  ]);
  assert.deepEqual(updates, { OPENAI_API_KEY: 'sk-abc' });
  assert.deepEqual(collectKeyUpdates([]), {});
  assert.deepEqual(collectKeyUpdates(null), {});
});

test('the first Google key strips ONLY the keyless OSM basemap from the share hash', () => {
  const stripped = stripKeylessBasemapFromHash('lat=30.2&lon=-97.7&map=osm&style=normal');
  assert.ok(stripped !== null);
  const params = new URLSearchParams(stripped);
  assert.equal(params.get('map'), null, 'osm basemap removed');
  assert.equal(params.get('lat'), '30.2', 'camera survives');
  assert.equal(params.get('style'), 'normal', 'style survives');
  // A stack under any other name was chosen or shared on purpose.
  assert.equal(stripKeylessBasemapFromHash('map=bing-aerial&lat=1'), null);
  assert.equal(stripKeylessBasemapFromHash('lat=1&lon=2'), null, 'no stack, nothing to do');
  assert.equal(stripKeylessBasemapFromHash(''), null);
  assert.equal(stripKeylessBasemapFromHash(undefined), null);
});

test('aborting pending setup removes its surface and ignores a late response', async () => {
  const { initKeySetup } = await import('./keySetup.js');
  const removed = [];
  const chip = { remove: () => removed.push('chip') };
  const root = { dataset: {}, remove: () => removed.push('root') };
  let resolveResponse;
  let requestSignal;
  const controller = new AbortController();
  const pending = initKeySetup({
    documentRef: { getElementById: (id) => id === 'key-setup-chip' ? chip : root },
    signal: controller.signal,
    fetchImpl: (_url, { signal }) => {
      requestSignal = signal;
      return new Promise((resolve) => { resolveResponse = resolve; });
    },
  });
  controller.abort();
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(removed, ['chip', 'root']);
  resolveResponse({ ok: true, json: async () => ({ keys: [] }) });
  assert.equal(await pending, null);
});

test('render displays active provider pill and differentiates chips with NO KEY vs ACTIVE', async () => {
  // Test that buildRow differentiates providers cleanly
  const mockStatus = {
    keys: [
      {
        id: 'nvidia',
        title: 'FREE AI ENGINES (13 PROVIDERS)',
        unlocks: 'Access 82+ models',
        getUrl: 'https://build.nvidia.com',
        envVars: ['NVIDIA_API_KEY'],
        tier: 'free',
        set: true,
      },
    ],
    providerSummary: {
      activeId: 'requesty',
      providers: {
        nvidia: { set: false, envVar: 'NVIDIA_API_KEY' },
        requesty: { set: true, envVar: 'REQUESTY_API_KEY' },
        groq: { set: false, envVar: 'GROQ_API_KEY' },
      },
    },
    setCount: 1,
    total: 1,
  };

  const elements = [];
  const createMockElement = (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      className: '',
      children: [],
      dataset: {},
      style: {},
      textContent: '',
      innerHTML: '',
      append: (...children) => el.children.push(...children),
      setAttribute: (k, v) => { el[k] = v; },
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      classList: {
        add: (cls) => { el.className = `${el.className} ${cls}`.trim(); },
        remove: (cls) => {
          el.className = el.className.split(' ').filter((c) => c !== cls).join(' ');
        },
        contains: (cls) => el.className.includes(cls),
      },
    };
    elements.push(el);
    return el;
  };

  const mockDoc = {
    createElement: createMockElement,
    getElementById: () => null,
  };

  const { initKeySetup } = await import('./keySetup.js');
  // Initialize with our mock DOM
  const chipEl = createMockElement('button');
  chipEl.id = 'key-setup-chip';
  const rootEl = createMockElement('div');
  rootEl.id = 'key-setup';
  const rowsHostEl = createMockElement('div');
  rowsHostEl.setAttribute('data-key-setup-rows', 'true');
  rootEl.append(rowsHostEl);
  rootEl.querySelector = (sel) => {
    if (sel === '[data-key-setup-rows]') return rowsHostEl;
    return createMockElement('div');
  };

  const instance = await initKeySetup({
    documentRef: {
      getElementById: (id) => (id === 'key-setup-chip' ? chipEl : rootEl),
      createElement: createMockElement,
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => mockStatus,
    }),
  });

  assert.ok(instance !== null);
  // Verify rowsHost received the row
  assert.ok(rowsHostEl.children.length > 0);
  const row = rowsHostEl.children[0];
  assert.equal(row.dataset.keyId, 'nvidia');
  assert.equal(row.dataset.set, 'true');

  // Verify that an element inside the row contains '🟢 ACTIVE: Requesty'
  const hasActivePill = elements.some((el) =>
    typeof el.innerHTML === 'string' && el.innerHTML.includes('🟢 ACTIVE: Requesty')
  );
  assert.equal(hasActivePill, true, 'Active pill must name Requesty');

  // Verify that Requesty chip shows ⚡ ACTIVE
  const hasActiveTag = elements.some((el) =>
    typeof el.innerHTML === 'string' && el.innerHTML.includes('⚡ ACTIVE') && el.innerHTML.includes('Requesty')
  );
  assert.equal(hasActiveTag, true, 'Requesty chip must display ⚡ ACTIVE');

  // Verify that other chips show ⚪ NO KEY
  const hasNoKeyTag = elements.some((el) =>
    typeof el.innerHTML === 'string' && el.innerHTML.includes('⚪ NO KEY')
  );
  assert.equal(hasNoKeyTag, true, 'Unconfigured chips must display ⚪ NO KEY');

  // Verify that all providers have dedicated input fields with their respective envVars
  const providerInputs = elements.filter(
    (el) => el.tagName === 'INPUT' && el.dataset?.envVar && el.type === 'password'
  );
  assert.equal(providerInputs.length, 14, 'Must render exactly 14 segregated password inputs');

  const expectedVars = [
    'NVIDIA_API_KEY',
    'MANIFEST_API_KEY',
    'REQUESTY_API_KEY',
    'GROQ_API_KEY',
    'GEMINI_API_KEY',
    'CEREBRAS_API_KEY',
    'MISTRAL_API_KEY',
    'COHERE_API_KEY',
    'AION_API_KEY',
    'ZHIPU_API_KEY',
    'SAMBANOVA_API_KEY',
    'TOGETHER_API_KEY',
    'CLOUDFLARE_API_KEY',
    'OPENROUTER_API_KEY',
  ];
  const renderedVars = providerInputs.map((i) => i.dataset.envVar);
  for (const expectedVar of expectedVars) {
    assert.ok(
      renderedVars.includes(expectedVar),
      `Input field for ${expectedVar} must be present and segregated`
    );
  }
});


