const BODIES = Object.freeze({
  earth: { id: 'Q2', radiusKm: 6371.0088 },
  moon: { id: 'Q405', radiusKm: 1737.4 },
  mars: { id: 'Q111', radiusKm: 3389.5 },
});
const KINDS = new Set([
  'place',
  'landmark',
  'landform',
  'vehicle-type',
  'planetary-feature',
  'mission-site',
]);
const normalize = (text) =>
  String(text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();
function values(entity, property) {
  return (entity.claims?.[property] ?? [])
    .filter(
      (claim) =>
        claim.rank !== 'deprecated' && claim.mainsnak?.snaktype === 'value',
    )
    .sort((a, b) => (b.rank === 'preferred') - (a.rank === 'preferred'))
    .map((claim) => claim.mainsnak.datavalue?.value)
    .filter((value) => value != null);
}
export function safeDiscoveryLink(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      host === 'localhost' ||
      host.endsWith('.local') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
      host.includes(':') ||
      url.href.length > 2048
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
/** Minimize CC0 structured entity data, preserving coordinate body and revision. */
export function cardFromEntity(
  entity,
  {
    kind = 'place',
    body,
    aliases = [],
    retrievedAt = new Date().toISOString(),
  } = {},
) {
  if (
    !/^Q[1-9]\d*$/.test(entity?.id) ||
    !KINDS.has(kind) ||
    values(entity, 'P31').some((value) => value.id === 'Q5')
  )
    return null;
  const coordinate = values(entity, 'P625')[0];
  const coordinateBody = coordinate
    ? Object.entries(BODIES).find(([, value]) =>
        [
          `http://www.wikidata.org/entity/${value.id}`,
          `https://www.wikidata.org/entity/${value.id}`,
        ].includes(coordinate.globe),
      )?.[0]
    : null;
  if (
    coordinate &&
    (!coordinateBody ||
      !Number.isFinite(coordinate.latitude) ||
      Math.abs(coordinate.latitude) > 90 ||
      !Number.isFinite(coordinate.longitude) ||
      Math.abs(coordinate.longitude) > 360)
  )
    return null;
  const resolvedBody = body ?? coordinateBody ?? 'earth';
  if (
    !BODIES[resolvedBody] ||
    (body && coordinateBody && body !== coordinateBody) ||
    (kind !== 'vehicle-type' && !coordinate)
  )
    return null;
  const labelEn = entity.labels?.en?.value;
  if (typeof labelEn !== 'string' || !labelEn.trim()) return null;
  const labels = {
    en: labelEn.slice(0, 200),
    fr: String(entity.labels?.fr?.value ?? labelEn).slice(0, 200),
  };
  const descriptions = {
    en: String(entity.descriptions?.en?.value ?? '').slice(0, 1200),
    fr: String(
      entity.descriptions?.fr?.value ?? entity.descriptions?.en?.value ?? '',
    ).slice(0, 1200),
  };
  const articles = {};
  for (const language of ['en', 'fr']) {
    const title = entity.sitelinks?.[`${language}wiki`]?.title;
    if (typeof title === 'string' && title.length < 300)
      articles[language] =
        `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
  }
  const facts = [];
  for (const [property, label] of [
    ['P571', 'Inception / Création'],
    ['P2048', 'Height / Hauteur'],
    ['P2046', 'Area / Surface'],
  ]) {
    const value = values(entity, property)[0];
    if (value?.time && value.precision >= 9)
      facts.push({
        property,
        label,
        value: sourceTimeLabel(value),
      });
    else if (
      value?.amount &&
      [
        'http://www.wikidata.org/entity/Q11573',
        'http://www.wikidata.org/entity/Q25343',
      ].includes(value.unit)
    )
      facts.push({
        property,
        label,
        value: `${value.amount.replace(/^\+/, '')} ${value.unit.endsWith('/Q11573') ? 'm' : 'm²'}`,
      });
  }
  return {
    id: entity.id,
    kind,
    body: resolvedBody,
    labels,
    descriptions,
    aliases: aliases.filter((value) => typeof value === 'string').slice(0, 20),
    coordinate: coordinate
      ? {
          lat: coordinate.latitude,
          lon: coordinate.longitude,
          globe: coordinate.globe,
          precision: coordinate.precision ?? null,
        }
      : null,
    articles,
    officialSite:
      values(entity, 'P856').map(safeDiscoveryLink).find(Boolean) ?? null,
    facts,
    provenance: {
      source: 'Wikidata',
      sourceUrl: `https://www.wikidata.org/wiki/${entity.id}`,
      revision: Number.isSafeInteger(entity.lastrevid)
        ? entity.lastrevid
        : null,
      retrievedAt,
      license: 'CC0-1.0',
    },
    association:
      kind === 'vehicle-type'
        ? 'Vehicle family/type, not identification of an observed vehicle.'
        : 'Entity selected by its source ID, not inferred from imagery.',
  };
}
function sourceTimeLabel(value) {
  const match = /^([+-])(\d{4,16})-(\d{2})-(\d{2})/.exec(value.time);
  if (!match) return value.time.slice(0, 40);
  const year =
    (match[1] === '-' ? '-' : '') + match[2].replace(/^0+(?=\d)/, '');
  return value.precision >= 11 ? `${year}-${match[3]}-${match[4]}` : year;
}
/** Validate public packs before they enter the local library; no HTML or private workflow fields. */
export function validateDiscoveryPack(pack) {
  if (
    pack?.format !== 'gods-eye-view/discovery-pack' ||
    pack.version !== 1 ||
    !Array.isArray(pack.cards) ||
    pack.cards.length > 500 ||
    pack.license !== 'CC0-1.0' ||
    typeof pack.title !== 'string' ||
    pack.title.length > 200
  )
    throw new TypeError('Unsupported discovery pack.');
  const ids = new Set();
  const cards = pack.cards.map((card) => {
    if (
      !/^Q[1-9]\d*$/.test(card?.id) ||
      ids.has(card.id) ||
      !KINDS.has(card.kind) ||
      !BODIES[card.body] ||
      card.provenance?.license !== 'CC0-1.0' ||
      card.provenance?.source !== 'Wikidata' ||
      card.provenance?.sourceUrl !==
        `https://www.wikidata.org/wiki/${card.id}` ||
      !Number.isFinite(Date.parse(card.provenance.retrievedAt))
    )
      throw new TypeError('Invalid discovery card provenance.');
    ids.add(card.id);
    for (const language of ['en', 'fr'])
      if (
        typeof card.labels?.[language] !== 'string' ||
        card.labels[language].length > 200 ||
        typeof card.descriptions?.[language] !== 'string' ||
        card.descriptions[language].length > 1200
      )
        throw new TypeError('Invalid card text.');
    const c = card.coordinate;
    if (
      c &&
      (!Number.isFinite(c.lat) ||
        Math.abs(c.lat) > 90 ||
        !Number.isFinite(c.lon) ||
        Math.abs(c.lon) > 360 ||
        ![
          `http://www.wikidata.org/entity/${BODIES[card.body].id}`,
          `https://www.wikidata.org/entity/${BODIES[card.body].id}`,
        ].includes(c.globe))
    )
      throw new TypeError('Invalid coordinate body.');
    if (card.kind !== 'vehicle-type' && !c)
      throw new TypeError('A mapped card needs coordinates.');
    const articles = {};
    for (const language of ['en', 'fr'])
      if (card.articles?.[language]) {
        const url = safeDiscoveryLink(card.articles[language]);
        if (
          !url ||
          new URL(url).hostname !== `${language}.wikipedia.org` ||
          !new URL(url).pathname.startsWith('/wiki/')
        )
          throw new TypeError('Invalid encyclopedia link.');
        articles[language] = url;
      }
    return {
      id: card.id,
      kind: card.kind,
      body: card.body,
      labels: { en: card.labels.en, fr: card.labels.fr },
      descriptions: { en: card.descriptions.en, fr: card.descriptions.fr },
      coordinate: c
        ? {
            lat: c.lat,
            lon: c.lon,
            globe: c.globe,
            precision: Number.isFinite(c.precision) ? c.precision : null,
          }
        : null,
      articles,
      officialSite: card.officialSite
        ? safeDiscoveryLink(card.officialSite)
        : null,
      aliases: (card.aliases ?? [])
        .filter((value) => typeof value === 'string' && value.length < 100)
        .slice(0, 20),
      facts: (card.facts ?? [])
        .filter(
          (value) =>
            ['P571', 'P2048', 'P2046'].includes(value.property) &&
            typeof value.label === 'string' &&
            value.label.length < 80 &&
            typeof value.value === 'string' &&
            value.value.length < 100,
        )
        .slice(0, 3),
      provenance: {
        source: 'Wikidata',
        sourceUrl: card.provenance.sourceUrl,
        revision: Number.isSafeInteger(card.provenance.revision)
          ? card.provenance.revision
          : null,
        retrievedAt: card.provenance.retrievedAt,
        license: 'CC0-1.0',
      },
      association:
        card.kind === 'vehicle-type'
          ? 'Vehicle family/type, not identification of an observed vehicle.'
          : 'Entity selected by its source ID, not inferred from imagery.',
    };
  });
  return {
    format: pack.format,
    version: 1,
    title: pack.title,
    license: pack.license,
    selection: String(pack.selection ?? 'User-selected public entities').slice(
      0,
      500,
    ),
    cards,
  };
}
export function discoveryDistanceKm(a, b, body = 'earth') {
  const rad = (value) => (value * Math.PI) / 180;
  const deltaLat = rad(b.lat - a.lat),
    deltaLon = rad(b.lon - a.lon);
  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(deltaLon / 2) ** 2;
  return (
    BODIES[body].radiusKm *
    2 *
    Math.atan2(Math.sqrt(Math.max(0, h)), Math.sqrt(Math.max(0, 1 - h)))
  );
}
/** Deterministic local lookup: exact IDs, text and optional distance, never an AI match. */
export function searchDiscovery(
  cards,
  {
    query = '',
    body = 'earth',
    center = null,
    radiusKm = 10000,
    kind = 'all',
    limit = 30,
  } = {},
) {
  if (
    !BODIES[body] ||
    !Number.isFinite(radiusKm) ||
    radiusKm <= 0 ||
    radiusKm > 25000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new TypeError('Invalid discovery scope.');
  if (
    center &&
    (!Number.isFinite(center.lat) ||
      Math.abs(center.lat) > 90 ||
      !Number.isFinite(center.lon) ||
      Math.abs(center.lon) > 360)
  )
    throw new TypeError('Invalid discovery center.');
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  return cards
    .filter(
      (card) => card.body === body && (kind === 'all' || card.kind === kind),
    )
    .map((card) => ({
      card,
      distanceKm:
        center && card.coordinate
          ? discoveryDistanceKm(center, card.coordinate, body)
          : null,
    }))
    .filter(
      ({ card, distanceKm }) =>
        (!center || (distanceKm !== null && distanceKm <= radiusKm)) &&
        terms.every((term) =>
          normalize(
            [
              card.id,
              ...Object.values(card.labels),
              ...Object.values(card.descriptions),
              ...card.aliases,
            ].join(' '),
          ).includes(term),
        ),
    )
    .sort(
      (a, b) =>
        (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) ||
        a.card.labels.en.localeCompare(b.card.labels.en),
    )
    .slice(0, limit);
}
/** Remote discovery is an explicit geographic lookup with two bounded public requests. */
export function createNearbyKnowledgeSource({
  fetchImpl = (...args) => fetch(...args),
  now = () => new Date().toISOString(),
} = {}) {
  async function request(url, signal) {
    const response = await fetchImpl(url, {
      signal: AbortSignal.any(
        [signal, AbortSignal.timeout(15000)].filter(Boolean),
      ),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Discovery source unavailable.');
    const text = await response.text();
    if (new TextEncoder().encode(text).length > 2 * 1024 * 1024)
      throw new Error('Source response too large.');
    signal?.throwIfAborted();
    const data = JSON.parse(text);
    if (data.error) throw new Error('Discovery source unavailable.');
    return data;
  }
  return {
    async nearby(
      { lat, lon, radiusKm = 10, language = 'en' },
      { signal } = {},
    ) {
      if (
        !Number.isFinite(lat) ||
        Math.abs(lat) > 90 ||
        !Number.isFinite(lon) ||
        Math.abs(lon) > 180 ||
        !Number.isFinite(radiusKm) ||
        radiusKm < 0.1 ||
        radiusKm > 10 ||
        !['en', 'fr'].includes(language)
      )
        throw new TypeError('Web lookup supports Earth areas of 0.1–10 km.');
      const url = new URL(`https://${language}.wikipedia.org/w/api.php`);
      for (const [key, value] of Object.entries({
        action: 'query',
        generator: 'geosearch',
        ggscoord: `${lat}|${lon}`,
        ggsradius: String(Math.round(radiusKm * 1000)),
        ggslimit: '10',
        ggsnamespace: '0',
        prop: 'pageprops',
        ppprop: 'wikibase_item',
        format: 'json',
        origin: '*',
        maxlag: '5',
      }))
        url.searchParams.set(key, value);
      const nearby = await request(url.href, signal);
      const ids = [
        ...new Set(
          Object.values(nearby.query?.pages ?? {})
            .map((page) => page.pageprops?.wikibase_item)
            .filter((id) => /^Q[1-9]\d*$/.test(id)),
        ),
      ].slice(0, 10);
      if (!ids.length) return [];
      const entitiesUrl = new URL('https://www.wikidata.org/w/api.php');
      for (const [key, value] of Object.entries({
        action: 'wbgetentities',
        ids: ids.join('|'),
        props: 'info|labels|descriptions|claims|sitelinks',
        languages: 'en|fr',
        sitefilter: 'enwiki|frwiki',
        format: 'json',
        origin: '*',
        maxlag: '5',
      }))
        entitiesUrl.searchParams.set(key, value);
      const result = await request(entitiesUrl.href, signal);
      return Object.values(result.entities ?? {})
        .map((entity) => cardFromEntity(entity, { retrievedAt: now() }))
        .filter(
          (card) =>
            card &&
            card.body === 'earth' &&
            card.coordinate &&
            discoveryDistanceKm({ lat, lon }, card.coordinate) <= radiusKm,
        );
    },
  };
}
