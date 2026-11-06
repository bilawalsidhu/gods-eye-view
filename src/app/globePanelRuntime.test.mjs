import assert from 'node:assert/strict';
import test from 'node:test';
import { panelRuntime } from './globePanelRuntime.js';

const element = () => ({
  isConnected: true,
  hidden: true,
  textContent: '',
  addEventListener() {},
  remove() {
    this.isConnected = false;
  },
});

test('every view the panel posts says whether its result was issued just now', async () => {
  const savedWindow = globalThis.window;
  const savedDocument = globalThis.document;
  const views = [];
  const parent = { postMessage() {} };
  const windowRef = new EventTarget();
  Object.assign(windowRef, {
    parent,
    postMessage: (message) => {
      if (message?.type === 'gev:view') views.push(message);
    },
  });
  const elements = { status: element(), open: element(), expand: element() };
  globalThis.window = windowRef;
  globalThis.document = {
    getElementById: (id) => elements[id] ?? null,
    addEventListener() {},
    baseURI: 'https://host.example/panel',
    body: { clientWidth: 600 },
  };
  const deliver = (source, data) => {
    const event = new Event('message');
    Object.assign(event, { source, data });
    windowRef.dispatchEvent(event);
  };
  const result = (issuedAt) => ({
    jsonrpc: '2.0',
    method: 'ui/notifications/tool-result',
    params: {
      structuredContent: {
        url: 'http://localhost:4173/#sl=google,48.85840,2.29450',
        issued_at: issuedAt,
        view: { camera: { lat: 48.8584, lon: 2.2945 } },
      },
    },
  });
  try {
    panelRuntime({
      appBaseUrl: 'http://localhost:4173/',
      panelBase: '/panel/',
      protocolVersion: '2025-06-18',
      panelHeight: 480,
    });
    deliver(windowRef, { type: 'gev:ready' });
    deliver(parent, result(Date.now()));
    // A host replaying an old result on the same mount.
    deliver(parent, result(Date.now() - 60 * 60 * 1000));
    deliver(parent, result(undefined));
  } finally {
    globalThis.window = savedWindow;
    globalThis.document = savedDocument;
  }
  assert.deepEqual(
    views.map((message) => message.fresh),
    [true, false, false],
  );
});
