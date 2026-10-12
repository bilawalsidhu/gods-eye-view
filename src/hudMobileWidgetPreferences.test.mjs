import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

const MGRS_STUB_URL = 'gev-test-stub:mgrs';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'mgrs') return { url: MGRS_STUB_URL, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === MGRS_STUB_URL) {
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export function forward() { return "10SEG55776339"; }\nexport default { forward };\n',
      };
    }
    return next(url, context);
  },
});

const { IntelHUD } = await import('./hud.js');
const { StyleManager } = await import('./ui/applicationShell.js');

function installLocalStorage(value) {
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => value,
    setItem() {},
  };
  return () => {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  };
}

test('HUD mobile widget preference restore normalizes empty and legacy storage safely', () => {
  for (const [stored, expected] of [
    [null, { status: false, coordinates: false }],
    ['null', { status: false, coordinates: false }],
    ['true', { status: false, coordinates: false }],
    ['"legacy"', { status: false, coordinates: false }],
    ['[]', { status: false, coordinates: false }],
    ['{"status":1}', { status: true, coordinates: false }],
    ['{"coordinates":"yes"}', { status: false, coordinates: true }],
  ]) {
    const restore = installLocalStorage(stored);
    try {
      assert.deepEqual(
        StyleManager.prototype._readHudMobileWidgetPreference.call({}),
        expected,
      );
    } finally {
      restore();
    }
  }
});

test('HUD widget collapse restore tolerates null and preserves valid preferences', () => {
  const calls = [];
  const fakeHud = {
    _setWidgetCollapsed(widget, collapsed, { emit }) {
      calls.push({ widget, collapsed, emit });
    },
    _syncWidgetPresentation() {
      calls.push('sync');
    },
  };

  assert.doesNotThrow(() =>
    IntelHUD.prototype.setWidgetCollapseState.call(fakeHud, null),
  );
  assert.doesNotThrow(() =>
    IntelHUD.prototype.setWidgetCollapseState.call(fakeHud, { status: true }),
  );
  assert.deepEqual(calls, [
    { widget: 'status', collapsed: false, emit: false },
    { widget: 'coordinates', collapsed: false, emit: false },
    'sync',
    { widget: 'status', collapsed: true, emit: false },
    { widget: 'coordinates', collapsed: false, emit: false },
    'sync',
  ]);
});

test('right HUD telemetry collapse setter syncs the grouped state', () => {
  const calls = [];
  const fakeHud = {
    _rightTelemetryCollapsed: false,
    _setRightTelemetryCollapsed: IntelHUD.prototype._setRightTelemetryCollapsed,
    _syncRightTelemetryPresentation() {
      calls.push(this._rightTelemetryCollapsed);
    },
  };

  IntelHUD.prototype.setRightTelemetryCollapsed.call(fakeHud, true);
  assert.equal(
    IntelHUD.prototype.getRightTelemetryCollapsed.call(fakeHud),
    true,
  );
  IntelHUD.prototype.setRightTelemetryCollapsed.call(fakeHud, false);
  assert.equal(
    IntelHUD.prototype.getRightTelemetryCollapsed.call(fakeHud),
    false,
  );
  assert.deepEqual(calls, [true, false]);
});
