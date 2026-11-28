import assert from 'node:assert/strict';
import test from 'node:test';
import { ShellFacade } from './shellFacade.js';

// A shell assembled without its navigation owner (as unit tests build one
// from the prototype) has no handoffs to report, like the facade's other
// optional owners; the voice runner subscribes as it is created.
test('camera handoffs without a navigation owner subscribe to nothing', () => {
  const shell = Object.create(ShellFacade.prototype);
  assert.equal(
    shell.subscribeCameraHandoff(() => {}),
    undefined,
  );
});

test('camera handoffs reach listeners through the navigation owner', () => {
  const listeners = new Set();
  const shell = Object.create(ShellFacade.prototype);
  shell._navigation = {
    subscribeCameraHandoff(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  let handoffs = 0;
  const unsubscribe = shell.subscribeCameraHandoff(() => {
    handoffs += 1;
  });
  for (const listener of listeners) listener();
  assert.equal(handoffs, 1);
  unsubscribe();
  assert.equal(listeners.size, 0);
});

// Startup chrome, the loader status and the first-run launcher read
// `hasShareState` on the shell; the flag itself lives on the share owner.
test('hasShareState reports the share owner’s flag', () => {
  const shell = Object.create(ShellFacade.prototype);
  shell._shareRestoration = { _hasShareState: true };
  assert.equal(shell.hasShareState, true);
  shell._shareRestoration._hasShareState = false;
  assert.equal(shell.hasShareState, false);
});
