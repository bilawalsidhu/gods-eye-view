import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPINE_NETWORKS,
  ALPINE_NETWORK_IDS,
  SLF_NETWORK_ID,
  SMN_NETWORK_ID,
  TAWES_NETWORK_ID,
  alpineAttribution,
  alpineNetwork,
  networksMeasuring,
} from './networks.js';
import { STATION_PARAMETER_IDS } from './parameters.js';

test('every network is keyless, openly licensed and names its own attribution', () => {
  // Eligibility for this layer IS the licence: a network that needs a token or
  // forbids redistribution belongs behind the key registry, not here.
  assert.ok(ALPINE_NETWORKS.length >= 3);
  for (const network of ALPINE_NETWORKS) {
    assert.match(network.id, /^[a-z]+(?:-[a-z0-9]+)+$/, network.id);
    assert.equal(network.licence, 'CC BY 4.0', network.id);
    assert.match(network.licenceUrl, /^https:\/\/creativecommons\.org\//);
    assert.ok(network.attribution.length > 2, network.id);
    assert.match(network.homepage, /^https:\/\//);
    assert.match(network.country, /^[A-Z]{2}$/);
    assert.ok(Number.isInteger(network.cadenceMinutes));
    assert.ok(network.cadenceMinutes > 0 && network.cadenceMinutes <= 60);
  }
});

test('ids are unique and every declared parameter is a real view', () => {
  assert.equal(new Set(ALPINE_NETWORK_IDS).size, ALPINE_NETWORK_IDS.length);
  for (const network of ALPINE_NETWORKS) {
    assert.ok(network.parameters.length, `${network.id} measures nothing`);
    for (const id of network.parameters)
      assert.ok(
        STATION_PARAMETER_IDS.includes(id),
        `${network.id} declares unknown parameter ${id}`,
      );
  }
});

test('the two parameters a network cannot publish honestly are withheld', () => {
  // Both exclusions are measured findings, not oversights, and each is stated
  // in the adapter that would otherwise read the column. A regression here
  // would put a map of altitude or an empty layer in front of a visitor.
  assert.ok(
    !alpineNetwork(SMN_NETWORK_ID).parameters.includes('snow'),
    'SwissMetNet publishes no snow depth in the whole-network current file',
  );
  assert.ok(
    !alpineNetwork(TAWES_NETWORK_ID).parameters.includes('pressure'),
    'GeoSphere reduces pressure to a local datum, not to sea level',
  );
  assert.ok(alpineNetwork(SLF_NETWORK_ID).parameters.includes('snow'));
  assert.ok(alpineNetwork(SMN_NETWORK_ID).parameters.includes('pressure'));
});

test('every parameter view is published by at least one network', () => {
  // A view no network feeds would render an empty map with a full legend.
  for (const id of STATION_PARAMETER_IDS)
    assert.ok(networksMeasuring(id).length > 0, `nothing publishes ${id}`);
});

test('an unknown network id resolves to null rather than throwing', () => {
  // Ids arrive inside payloads, so an unexpected one is ordinary input.
  assert.equal(alpineNetwork('not-a-network'), null);
  assert.equal(alpineNetwork(undefined), null);
  assert.equal(alpineNetwork(''), null);
});

test('attribution credits exactly the networks present, and nothing else', () => {
  const one = alpineAttribution([SLF_NETWORK_ID]);
  assert.match(one, /WSL Institute/);
  assert.ok(!one.includes('MeteoSwiss'), 'an absent network is not credited');
  assert.match(one, /CC BY 4\.0/);
  const all = alpineAttribution();
  for (const network of ALPINE_NETWORKS)
    assert.ok(all.includes(network.attribution), network.id);
  assert.equal(alpineAttribution([]), '');
  assert.equal(alpineAttribution(['nope']), '');
});
