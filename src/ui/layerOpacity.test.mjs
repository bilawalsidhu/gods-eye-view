import test from 'node:test';
import assert from 'node:assert/strict';
import { LayerOpacity } from './layerOpacity.js';

const wait = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** A layer manager whose layers record what the hook was told. */
function fixture({ href = 'https://gev.example/app/?lang=de#v=2&l=f' } = {}) {
  const calls = [];
  const hooked = (id) => ({
    module: { id, setOpacity: (value) => calls.push([id, value]) },
  });
  const manager = {
    layers: new Map([
      ['wind', hooked('wind')],
      ['sea-marks', hooked('sea-marks')],
      ['flights', { module: { id: 'flights' } }],
    ]),
  };
  const location = { href };
  const navigationTarget = new EventTarget();
  const writes = [];
  const history = {
    state: { kept: true },
    replaceState(state, title, url) {
      writes.push({ state, url });
      location.href = url;
    },
  };
  let renders = 0;
  const opacity = new LayerOpacity(manager, {
    locationRef: location,
    historyRef: history,
    navigationTarget,
    requestRender: () => renders++,
    addressDelayMs: 0,
  });
  return {
    opacity,
    manager,
    location,
    history,
    navigationTarget,
    calls,
    writes,
    renders: () => renders,
  };
}

test('only layers with a setOpacity hook have a control', () => {
  const { opacity } = fixture();
  assert.equal(opacity.supports('wind'), true);
  assert.equal(opacity.supports('flights'), false);
  assert.equal(opacity.supports('nope'), false);
  assert.equal(opacity.supports(undefined), false);
});

test('set calls the layer hook with the fraction and asks for a draw', () => {
  const { opacity, calls, renders } = fixture();
  assert.equal(opacity.get('wind'), 1);
  assert.equal(opacity.set('wind', 0.4), true);
  assert.deepEqual(calls, [['wind', 0.4]]);
  assert.equal(opacity.get('wind'), 0.4);
  assert.equal(renders(), 1);
});

test('an unchanged or unsupported value does not reach the layer', () => {
  const { opacity, calls } = fixture();
  assert.equal(opacity.set('wind', 1), false);
  assert.equal(opacity.set('flights', 0.5), false);
  assert.equal(opacity.set('nope', 0.5), false);
  opacity.set('wind', 0.4);
  assert.equal(opacity.set('wind', 0.4), false);
  assert.equal(opacity.set('wind', 0.404), false);
  assert.deepEqual(calls, [['wind', 0.4]]);
  assert.equal(opacity.get('flights'), 1);
});

test('values are clamped and a non-number returns the layer to 100 %', () => {
  const { opacity, calls } = fixture();
  opacity.set('wind', -2);
  assert.equal(opacity.get('wind'), 0);
  opacity.set('wind', 5);
  assert.equal(opacity.get('wind'), 1);
  opacity.set('wind', 0.5);
  opacity.set('wind', Number.NaN);
  assert.equal(opacity.get('wind'), 1);
  assert.deepEqual(
    calls.map(([, value]) => value),
    [0, 1, 0.5, 1],
  );
});

test('reset returns the layer to 100 % and clears its entry', async () => {
  const { opacity, calls, writes } = fixture();
  opacity.set('wind', 0.3);
  await wait();
  assert.equal(writes.length, 1);
  assert.equal(opacity.reset('wind'), true);
  assert.equal(opacity.reset('wind'), false);
  assert.deepEqual(calls, [
    ['wind', 0.3],
    ['wind', 1],
  ]);
  await wait();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].url, 'https://gev.example/app/?lang=de#v=2&l=f');
});

test('subscribers hear changes; one that throws does not stop the others', () => {
  const { opacity } = fixture();
  const heard = [];
  const warn = console.warn;
  console.warn = () => {};
  try {
    opacity.subscribe(() => {
      throw new Error('listener failed');
    });
    const off = opacity.subscribe((id, value) => heard.push([id, value]));
    opacity.set('wind', 0.5);
    off();
    opacity.set('wind', 0.6);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(heard, [['wind', 0.5]]);
});

test('a hook that throws still leaves the control in step', () => {
  const { opacity, manager } = fixture();
  manager.layers.get('wind').module.setOpacity = () => {
    throw new Error('hook failed');
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(opacity.set('wind', 0.5), true);
  } finally {
    console.warn = warn;
  }
  assert.equal(opacity.get('wind'), 0.5);
});

test('changes reach the address once, debounced, keeping the rest of it', async () => {
  const { opacity, writes, history } = fixture();
  opacity.set('wind', 0.9);
  opacity.set('wind', 0.5);
  opacity.set('sea-marks', 0.25);
  assert.equal(writes.length, 0);
  await wait();
  assert.equal(writes.length, 1);
  assert.equal(
    writes[0].url,
    'https://gev.example/app/?lang=de&lop=sea-marks:25,wind:50#v=2&l=f',
  );
  assert.equal(writes[0].state, history.state);
  opacity.reset('wind');
  opacity.reset('sea-marks');
  await wait();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].url, 'https://gev.example/app/?lang=de#v=2&l=f');
});

test('a browser that refuses the address write costs the slider nothing', async () => {
  const { opacity, history } = fixture();
  history.replaceState = () => {
    throw new DOMException('too many calls', 'SecurityError');
  };
  const warn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    assert.equal(opacity.set('wind', 0.5), true);
    await wait();
  } finally {
    console.warn = warn;
  }
  assert.equal(opacity.get('wind'), 0.5);
  assert.deepEqual(warned, ['[Opacity] address update failed']);
});

test('exception diagnostics do not expose untrusted values', async () => {
  const secret = 'synthetic-secret-ABC123';
  const { opacity, manager, history } = fixture();
  const error = new Error(secret, { cause: { token: secret } });
  error.name = secret;
  manager.layers.get('wind').module.setOpacity = () => {
    throw error;
  };
  history.replaceState = () => {
    throw error;
  };
  opacity.subscribe(() => {
    throw error;
  });
  const oldWarn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args);
  try {
    assert.equal(opacity.set('wind', 0.5), true);
    await wait();
  } finally {
    console.warn = oldWarn;
    opacity.destroy();
  }
  assert.deepEqual(warned, [
    ['[Opacity] setOpacity error'],
    ['[Opacity] listener error'],
    ['[Opacity] address update failed'],
  ]);
});

test('restore applies the address to layers that can be dimmed', () => {
  const { opacity, calls } = fixture({
    href: 'https://gev.example/?lop=wind:40,flights:20,nope:10,sea-marks:100',
  });
  opacity.restore();
  assert.deepEqual(calls, [['wind', 0.4]]);
  assert.equal(opacity.get('wind'), 0.4);
  assert.equal(opacity.get('flights'), 1);
});

test('restore survives a hostile address', () => {
  for (const href of [
    'https://gev.example/?lop=' + 'a:5,'.repeat(5000),
    'https://gev.example/?lop=__proto__:50,wind:%ZZ',
    'https://gev.example/?lop=wind:40:50',
    'https://gev.example/?lop[]=wind:40',
  ]) {
    const { opacity, calls } = fixture({ href });
    assert.doesNotThrow(() => opacity.restore());
    assert.deepEqual(calls, [], href.slice(0, 40));
  }
});

test('restore does not rewrite an address that already says the same', async () => {
  const { opacity, writes } = fixture({
    href: 'https://gev.example/?lop=sea-marks:25,wind:40',
  });
  opacity.restore();
  await wait();
  assert.deepEqual(writes, []);
});

test('with no address or history the control still works', () => {
  const calls = [];
  const opacity = new LayerOpacity(
    {
      layers: new Map([
        ['wind', { module: { setOpacity: (v) => calls.push(v) } }],
      ]),
    },
    { locationRef: null, historyRef: null },
  );
  assert.doesNotThrow(() => opacity.restore());
  assert.equal(opacity.set('wind', 0.5), true);
  assert.deepEqual(calls, [0.5]);
});

test('destroy stops the pending address write and the control', async () => {
  const { opacity, writes } = fixture();
  const heard = [];
  opacity.subscribe((id) => heard.push(id));
  opacity.set('wind', 0.5);
  opacity.destroy();
  opacity.destroy();
  await wait();
  assert.deepEqual(writes, []);
  assert.equal(opacity.supports('wind'), false);
  assert.equal(opacity.set('wind', 0.3), false);
  assert.deepEqual(heard, ['wind']);
});

test('share navigation resets omitted opacity and pending writes', async () => {
  const { opacity, location, navigationTarget, calls, writes } = fixture({
    href: 'https://gev.example/app/?lop=wind:40,sea-marks:25#lat=1&lon=2',
  });
  opacity.restore();
  assert.equal(opacity.get('wind'), 0.4);
  assert.equal(opacity.get('sea-marks'), 0.25);

  // Back/Forward changes the page address without reconstructing the app.
  location.href = 'https://gev.example/app/?lop=sea-marks:50#lat=3&lon=4';
  navigationTarget.dispatchEvent(new Event('popstate'));
  navigationTarget.dispatchEvent(new Event('hashchange'));
  assert.equal(opacity.get('wind'), 1, 'an omitted layer returns to default');
  assert.equal(opacity.get('sea-marks'), 0.5);
  assert.deepEqual(calls, [
    ['wind', 0.4],
    ['sea-marks', 0.25],
    ['wind', 1],
    ['sea-marks', 0.5],
  ]);

  // A link with no lop means all layers are at 100%.
  location.href = 'https://gev.example/app/#lat=5&lon=6';
  navigationTarget.dispatchEvent(new Event('hashchange'));
  assert.equal(opacity.get('sea-marks'), 1);
  await wait();
  assert.deepEqual(
    writes,
    [],
    'the old debounced state must not rewrite a new link',
  );

  const count = calls.length;
  opacity.destroy();
  location.href = 'https://gev.example/app/?lop=wind:20#lat=7&lon=8';
  navigationTarget.dispatchEvent(new Event('popstate'));
  assert.equal(calls.length, count, 'destroy removes navigation listeners');
});

test('a navigation event that leaves lop alone keeps what the user set', async () => {
  const { opacity, location, navigationTarget, calls, writes } = fixture();
  opacity.restore();
  opacity.set('wind', 0.4); // address still has no lop: write is pending
  location.href = 'https://gev.example/app/?lang=de#v=2&l=f&lat=9'; // anchor
  navigationTarget.dispatchEvent(new Event('hashchange'));
  assert.equal(opacity.get('wind'), 0.4, 'a hash edit must not undo a drag');
  assert.deepEqual(calls, [['wind', 0.4]], 'no hook call for a no-op event');
  await wait();
  assert.equal(writes.length, 1, 'the pending write still lands');
});

test('an incoming link is applied once and its own address is not rewritten', async () => {
  const { opacity, location, navigationTarget, calls, writes } = fixture();
  opacity.restore();
  location.href = 'https://gev.example/app/?lop=wind:35,sea-marks:50#lat=1';
  navigationTarget.dispatchEvent(new Event('popstate'));
  assert.deepEqual(calls, [
    ['wind', 0.35],
    ['sea-marks', 0.5],
  ]);
  await wait();
  assert.deepEqual(writes, [], 'a non-canonical incoming lop is left as is');
  navigationTarget.dispatchEvent(new Event('hashchange')); // same entry
  assert.equal(calls.length, 2, 'the entry is reconciled once');
});

test('an inline instance keeps user values across host hashchange', () => {
  const { manager, navigationTarget } = fixture();
  const inline = new LayerOpacity(manager, {
    locationRef: { href: 'https://host.example/page#a' },
    historyRef: null,
    navigationTarget,
    addressDelayMs: 0,
  });
  inline.set('wind', 0.6);
  navigationTarget.dispatchEvent(new Event('hashchange'));
  assert.equal(inline.get('wind'), 0.6);
  inline.destroy();
});
