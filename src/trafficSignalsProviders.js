// Public feeds are selected by geographic coverage, never by pretending that
// one city's signal network covers the rest of the world.
export const HAMBURG_SIGNAL_SOURCE = 'Free and Hanseatic City of Hamburg';
export const HAMBURG_SIGNAL_URL = 'https://tld.iot.hamburg.de/v1.1/Datastreams';
export const HAMBURG_SIGNAL_LIMIT = 64;
export const PUBLIC_SIGNAL_PROVIDERS = Object.freeze([
  { id: 'hamburg', name: HAMBURG_SIGNAL_SOURCE, region: 'Hamburg, Germany',
    bounds: { south: 53.395, west: 8.421, north: 53.964, east: 10.326 },
    capability: 'reported states; no countdown', requiresKey: false },
]);

export function publicSignalProvidersForBounds(box) {
  return PUBLIC_SIGNAL_PROVIDERS.filter(({ bounds }) => box.south <= bounds.north
    && box.north >= bounds.south && box.west <= bounds.east && box.east >= bounds.west);
}

export async function readSignalJson(response) {
  if (!response.ok || !response.body) throw new Error('Signal feed failed');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 * 1024) throw new Error('Signal feed exceeds size limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function hamburgSignalQuery({ south, west, north, east }) {
  const url = new URL(HAMBURG_SIGNAL_URL);
  const area = `POLYGON((${west} ${south},${east} ${south},${east} ${north},${west} ${north},${west} ${south}))`;
  url.searchParams.set('$filter', "(properties/layerName eq 'primary_signal' or properties/layerName eq 'secondary_signal' or properties/layerName eq 'auxiliary_signal')"
    + ` and geo.intersects(observedArea, geography'${area}')`);
  url.searchParams.set('$top', String(HAMBURG_SIGNAL_LIMIT));
  url.searchParams.set('$select', 'id,name,properties');
  // Use the provider's documented indexed ordering. Implausible future-dated
  // controller reports are rejected by the parser, never treated as current.
  url.searchParams.set('$expand', 'Thing($select=name,properties),Observations($top=1;$orderby=phenomenonTime desc;$expand=FeatureOfInterest)');
  return url;
}

const HAMBURG_STATES = Object.freeze({ 0: 'off', 1: 'red', 2: 'yellow', 3: 'green',
  4: 'red-yellow', 5: 'flashing-yellow', 6: 'flashing-green', 9: 'unknown' });

export function parseHamburgSignals(payload, box, serverTimeEpochMs) {
  if (!Array.isArray(payload?.value) || payload.value.length > HAMBURG_SIGNAL_LIMIT) throw new Error('Invalid Hamburg response');
  const signals = [];
  for (const stream of payload.value) {
    if (!['primary_signal', 'secondary_signal', 'auxiliary_signal'].includes(stream?.properties?.layerName)) continue;
    if (!Number.isSafeInteger(stream['@iot.id']) || stream['@iot.id'] <= 0) continue;
    const observation = stream.Observations?.[0];
    const feature = observation?.FeatureOfInterest?.feature;
    const geometry = feature?.type === 'Feature' ? feature.geometry : feature;
    const [lon, lat] = geometry?.type === 'Point' && Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < box.south || lat > box.north || lon < box.west || lon > box.east) continue;
    const state = Number.isInteger(observation.result) ? HAMBURG_STATES[observation.result] : undefined;
    const observed = typeof observation.phenomenonTime === 'string' ? Date.parse(observation.phenomenonTime) : NaN;
    const received = typeof observation.resultTime === 'string' ? Date.parse(observation.resultTime) : NaN;
    if (!state || !Number.isFinite(observed) || !Number.isFinite(received)
      || observed <= 0 || observed > serverTimeEpochMs + 1000 || received > serverTimeEpochMs + 1000
      || observed > received + 1000) continue;
    const thing = stream.Thing?.properties || {};
    signals.push({ id: `hamburg:${stream['@iot.id']}`, lat, lon,
      name: String(stream.name || `Hamburg ${stream['@iot.id']}`).slice(0, 120),
      movement: `${thing.laneType || 'Lane'} ${thing.ingressLaneID || '?'} → ${thing.egressLaneID || '?'}; group ${stream.properties.signalGroupID || '?'}`,
      source: HAMBURG_SIGNAL_SOURCE, state, observedAtEpochMs: observed,
      observationOnly: true,
      // Deliberately no validity deadline, transition prediction or accuracy
      // bound: the published feed supplies none of those for these reports.
    });
  }
  return { signals, truncated: Boolean(payload['@iot.nextLink']) || payload['@iot.count'] > payload.value.length };
}

export async function fetchPublicSignalSnapshot(box, fetchImpl = fetch) {
  if (!publicSignalProvidersForBounds(box).length) {
    return { serverTimeEpochMs: Date.now(), clockUncertaintyMs: 0, signals: [], pollAfterMs: 30000,
      coverage: 'No connected live provider here; mapped locations only', truncated: false };
  }
  const response = await fetchImpl(hamburgSignalQuery(box), {
    signal: AbortSignal.timeout(6000), redirect: 'error', cache: 'no-store',
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  });
  const payload = await readSignalJson(response);
  const date = Date.parse(response.headers.get('date'));
  const ageValue = response.headers.get('age');
  const age = ageValue == null ? 0 : Number(ageValue);
  // HTTP Date has second resolution. Reject stale caches and large clock
  // disagreement instead of making an old report appear new on the client.
  if (!Number.isFinite(date) || !Number.isFinite(age) || age < 0 || age > 5
    || Math.abs(Date.now() - date - age * 1000) > 10000) throw new Error('Unusable Hamburg feed clock');
  const serverTimeEpochMs = date + age * 1000;
  return { serverTimeEpochMs, clockUncertaintyMs: 1000, ...parseHamburgSignals(payload, box, serverTimeEpochMs),
    pollAfterMs: 2000, coverage: 'Hamburg public reports; no countdown or accuracy guarantee' };
}
