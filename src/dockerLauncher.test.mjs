import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  defaultGatewayFromRouteTable,
  resolveAllowedHosts,
  resolveTrustedPeers,
} from '../scripts/docker-start.mjs';

// The shape of /proc/net/route inside a bridge-networked container:
// little-endian hex addresses, the default route first, an interface route
// after.
const BRIDGE_ROUTES = [
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
  'eth0\t00000000\t0100A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0',
  'eth0\t0000A8C0\t00000000\t0001\t0\t0\t0\t00F0FFFF\t0\t0\t0',
  '',
].join('\n');

test('the container gateway is decoded from the kernel routing table', () => {
  assert.equal(defaultGatewayFromRouteTable(BRIDGE_ROUTES), '192.168.0.1', 'little-endian hex, default route only');
  assert.equal(
    defaultGatewayFromRouteTable(BRIDGE_ROUTES.replace('0100A8C0', '011FAC')),
    null,
    'a malformed gateway field is not an address',
  );
  assert.equal(
    defaultGatewayFromRouteTable(BRIDGE_ROUTES.replace('\t0003\t', '\t0002\t')),
    null,
    'a default route that is not up is ignored',
  );
  assert.equal(
    defaultGatewayFromRouteTable(BRIDGE_ROUTES.replace('0100A8C0', '00000000')),
    null,
    'a zero gateway is not an address',
  );
  assert.equal(
    defaultGatewayFromRouteTable(
      BRIDGE_ROUTES.split('\n').filter((line) => !line.includes('00000000\t0100A8C0')).join('\n'),
    ),
    null,
    '--network none has no default route and must not invent one',
  );
  assert.equal(defaultGatewayFromRouteTable(''), null);
  assert.equal(defaultGatewayFromRouteTable(undefined), null);
});

test('an operator list wins, and no gateway trusts nothing', () => {
  assert.equal(resolveTrustedPeers({ env: {}, routeTable: BRIDGE_ROUTES }), '192.168.0.1');
  assert.equal(resolveTrustedPeers({ env: { GEV_KEY_SETUP_TRUSTED_PEERS: ' 10.9.8.7 ' }, routeTable: BRIDGE_ROUTES }), '10.9.8.7');
  assert.equal(
    resolveTrustedPeers({ env: { GEV_KEY_SETUP_TRUSTED_PEERS: '  ' }, routeTable: BRIDGE_ROUTES }),
    '192.168.0.1',
    'a blank override falls through to the gateway',
  );
  assert.equal(resolveTrustedPeers({ env: {}, routeTable: '' }), '', 'loopback-only when there is no gateway');
});

test('the container answers the same host names as the native launcher', () => {
  assert.deepEqual(resolveAllowedHosts({}), ['localhost', '127.0.0.1', '.local'], 'a wildcard bind never means "any Host header"');
  assert.deepEqual(
    resolveAllowedHosts({ GEV_ALLOWED_HOSTS: ' globe.lan , nas.internal ' }),
    ['localhost', '127.0.0.1', '.local', 'globe.lan', 'nas.internal'],
    'an operator can still add a LAN hostname',
  );
  assert.deepEqual(
    resolveAllowedHosts({ GEV_ALLOWED_HOSTS: ' , localhost , ' }),
    ['localhost', '127.0.0.1', '.local'],
    'blank and duplicate entries change nothing',
  );
});

test('the Docker install path keeps its loopback-only, launcher-owned contract', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /^CMD \["node", "scripts\/docker-start\.mjs"\]$/m, 'the launcher is the container entry point');

  const compose = readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');
  assert.match(compose, /^\s+- "127\.0\.0\.1:4173:4173"$/m, 'the port is published on the host loopback only');
  assert.doesNotMatch(compose, /GEV_KEY_SETUP_TRUSTED_PEERS/, 'trust is derived at launch, never hard-coded');
  assert.doesNotMatch(compose, /network_mode/, 'the container keeps its own network namespace');
});
