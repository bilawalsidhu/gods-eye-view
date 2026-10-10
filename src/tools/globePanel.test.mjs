import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GLOBE_PANEL_URI,
  MCP_APP_MIME_TYPE,
  createGlobePanelResource,
} from './globePanel.js';
import { panelRuntime } from '../app/globePanelRuntime.js';
import { composeCatalog, coreTools } from './index.js';
import { MAPILLARY_GRAPH_HOST } from '../layers/streetLevel/providers/mapillary/policy.js';

/** Whether a CSP source list allows a URL (exact origin or `https://*.host`). */
function allows(sources, url) {
  const { origin, protocol, hostname } = new URL(url);
  return sources.some((source) => {
    if (source === origin) return true;
    const wildcard = source.match(/^(https:)\/\/\*\.(.+)$/);
    return (
      Boolean(wildcard) &&
      protocol === wildcard[1] &&
      hostname.endsWith(`.${wildcard[2]}`)
    );
  });
}

test('the globe panel is an MCP Apps resource that loads the app through its server', () => {
  const resource = createGlobePanelResource({
    runtime: panelRuntime,
    panelKey: 'test-key',
  });
  assert.equal(resource.uri, GLOBE_PANEL_URI);
  assert.equal(resource.mimeType, MCP_APP_MIME_TYPE);
  assert.equal(MCP_APP_MIME_TYPE, 'text/html;profile=mcp-app');
  const { csp } = resource._meta.ui;
  // The panel reaches only map and font providers; the app's own files
  // and data come through the MCP server, so no app address is declared.
  assert.deepEqual(csp.connectDomains, csp.resourceDomains);
  assert.ok(csp.resourceDomains.includes('https://tile.googleapis.com'));
  assert.ok(
    csp.resourceDomains.every((origin) => origin.startsWith('https://')),
  );
  assert.equal(csp.frameDomains, undefined);
  assert.equal(csp.baseUriDomains, undefined);
  assert.match(resource.text, /"toolName":"panel_request"/);
  // The page carries the key its requests need, and sends it with each one.
  assert.match(resource.text, /"panelKey":"test-key"/);
  assert.match(resource.text, /key: config\.panelKey/);
  assert.match(resource.text, /"panelBase":"\/panel\/"/);
  assert.match(resource.text, /'ui\/initialize'/);
  assert.match(resource.text, /'ui\/notifications\/tool-result'/);
  assert.match(resource.text, /"protocolVersion":"2026-01-26"/);
  // The MCP Apps SDK's initialize parameters; hosts reject anything else.
  assert.match(resource.text, /appInfo: \{/);
  assert.doesNotMatch(resource.text, /clientInfo/);
  // Fullscreen where the host offers it.
  assert.match(resource.text, /'ui\/request-display-mode'/);
  assert.match(resource.text, /<button id="expand" type="button" hidden>/);
  assert.doesNotMatch(resource.text, /<iframe|createElement\('base'\)/);
  const script = resource.text.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));
});

test('the panel lets Street Level reach Mapillary from inside the embed', () => {
  const { csp } = createGlobePanelResource({
    runtime: panelRuntime,
    panelKey: 'test-key',
  })._meta.ui;
  // Graph API lookups (nearest image, sequences) and MapillaryJS photo loads.
  for (const url of [
    `${MAPILLARY_GRAPH_HOST}/images?fields=id&bbox=1,2,3,4`,
    'https://scontent-man2-1.xx.fbcdn.net/m1/v/t6/photo.jpg',
    'https://scontent-iad3-2.xx.fbcdn.net/m1/v/t6/photo.jpg',
  ]) {
    assert.ok(allows(csp.connectDomains, url), `connect-src allows ${url}`);
    assert.ok(allows(csp.resourceDomains, url), `img-src allows ${url}`);
  }
  assert.equal(allows(csp.connectDomains, 'https://evil.example/x'), false);
  assert.equal(
    allows(csp.connectDomains, 'https://fbcdn.net.evil.example/'),
    false,
  );
});

test('the globe panel needs a request key', () => {
  for (const panelKey of [undefined, '', 42])
    assert.throws(
      () => createGlobePanelResource({ runtime: panelRuntime, panelKey }),
      TypeError,
    );
});

test('show_in_gods_eye_view names the panel and shows a view another answer returned', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { app: { baseUrl: 'http://localhost:5173/' } },
  });
  assert.deepEqual(catalog.get('show_in_gods_eye_view').ui, {
    resourceUri: GLOBE_PANEL_URI,
  });
  const earlier = {
    camera: {
      lat: 25,
      lon: 121,
      altitude_m: 300000,
      heading_deg: 0,
      pitch_deg: -90,
    },
    layers: ['ais-live-vessels'],
    style: null,
    map: null,
    follow: null,
    annotations: [],
    url: 'http://localhost:5173/#v=2',
  };
  const shown = await catalog.call('show_in_gods_eye_view', {
    view: earlier,
    layers: ['ais-live-vessels', 'military'],
    style: 'thermal',
  });
  assert.deepEqual(shown.data.view.camera, earlier.camera);
  assert.deepEqual(shown.data.view.layers, ['ais-live-vessels', 'military']);
  assert.equal(shown.data.view.style, 'thermal');
  await assert.rejects(
    catalog.call('show_in_gods_eye_view', { view: { camera: { lat: 'x' } } }),
    (error) => error.code === 'invalid_arguments',
  );
});

test('a view that only follows an aircraft is framed where the aircraft is', async () => {
  const { resolveViewArguments } = await import('./queries/share.js');
  const tools = {
    has: (name) => name === 'find_aircraft',
    call: async (name, args) => ({
      data: {
        rows:
          args.icao24 === 'ae1234'
            ? [{ id: 'ae1234', lat: 32.7, lon: -117.2 }]
            : [],
      },
    }),
  };
  const { view, label } = await resolveViewArguments(
    { follow: { kind: 'military_aircraft', id: 'ae1234', cockpit: true } },
    { services: {}, tools },
  );
  assert.deepEqual(
    [view.camera.lat, view.camera.lon, view.follow.cockpit],
    [32.7, -117.2, true],
  );
  assert.equal(label, 'military aircraft ae1234');
  await assert.rejects(
    resolveViewArguments(
      { follow: { kind: 'aircraft', id: 'abc999' } },
      { services: {}, tools },
    ),
    (error) =>
      error.code === 'invalid_arguments' &&
      /not reported now/.test(error.message),
  );
});

test('the package exports the panel resource and its runtime together', async () => {
  const panel = await import('gods-eye-view/tools/panel');
  const resource = panel.createGlobePanelResource({
    runtime: panel.panelRuntime,
    panelKey: 'key',
  });
  assert.equal(resource.uri, panel.GLOBE_PANEL_URI);
  assert.equal(panel.PANEL_BASE, '/panel/');
  assert.match(resource.text, /panelRuntime|function/);
});
