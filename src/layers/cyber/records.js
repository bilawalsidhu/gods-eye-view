const iso = (value) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

function boundedText(value, max = 160) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= max && !/[\u0000-\u001f<>]/.test(text)
    ? text
    : null;
}

function publicIPv4Text(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => {
      const number = Number(part);
      return /^\d{1,3}$/.test(part) && number >= 0 && number <= 255;
    })
  );
}

function normalizeEnrichmentRecord(value, provider) {
  if (!value || value.provider !== provider || !publicIPv4Text(value.ip))
    throw new Error('Malformed Cyber enrichment response');
  const fetchedAt = iso(value.fetchedAt);
  const attribution = boundedText(value.attribution, 120);
  if (!fetchedAt || !attribution)
    throw new Error('Malformed Cyber enrichment response');
  if (provider === 'greynoise')
    return Object.freeze({
      provider,
      ip: value.ip,
      fetchedAt,
      noise: typeof value.noise === 'boolean' ? value.noise : null,
      riot: typeof value.riot === 'boolean' ? value.riot : null,
      classification: boundedText(value.classification, 40),
      organization: boundedText(value.organization, 120),
      lastSeen: iso(value.lastSeen),
      message: boundedText(value.message, 160),
      attribution,
    });
  const coordinatesPresent = value.latitude != null || value.longitude != null;
  const hasCoordinates =
    coordinatesPresent &&
    Number.isFinite(value.latitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    Number.isFinite(value.longitude) &&
    value.longitude >= -180 &&
    value.longitude <= 180 &&
    value.geographicPrecision === 'network-approximate';
  if (coordinatesPresent && !hasCoordinates)
    throw new Error('Malformed Cyber enrichment response');
  const serviceRows = Array.isArray(value.services)
    ? value.services.slice(0, 12)
    : [];
  return Object.freeze({
    provider,
    ip: value.ip,
    fetchedAt,
    ports: Object.freeze(
      (Array.isArray(value.ports) ? value.ports : [])
        .slice(0, 64)
        .filter((port) => Number.isInteger(port) && port >= 0 && port <= 65535),
    ),
    services: Object.freeze(
      serviceRows.map((service) =>
        Object.freeze({
          port:
            Number.isInteger(service?.port) &&
            service.port >= 0 &&
            service.port <= 65535
              ? service.port
              : null,
          transport: boundedText(service?.transport, 12),
          product: boundedText(service?.product, 100),
          version: boundedText(service?.version, 80),
          cpe: Object.freeze(
            (Array.isArray(service?.cpe) ? service.cpe : [])
              .slice(0, 12)
              .map((item) => boundedText(item, 160))
              .filter(Boolean),
          ),
          vulnerabilities: Object.freeze(
            (Array.isArray(service?.vulnerabilities)
              ? service.vulnerabilities
              : []
            )
              .slice(0, 20)
              .map((item) => boundedText(item, 32))
              .filter(Boolean),
          ),
          banner: boundedText(service?.banner, 320),
        }),
      ),
    ),
    hostnames: Object.freeze(
      (Array.isArray(value.hostnames) ? value.hostnames : [])
        .slice(0, 10)
        .map((item) => boundedText(item, 253))
        .filter(Boolean),
    ),
    domains: Object.freeze(
      (Array.isArray(value.domains) ? value.domains : [])
        .slice(0, 10)
        .map((item) => boundedText(item, 253))
        .filter(Boolean),
    ),
    organization: boundedText(value.organization, 120),
    isp: boundedText(value.isp, 120),
    asn: boundedText(value.asn, 24),
    operatingSystem: boundedText(value.operatingSystem, 100),
    city: boundedText(value.city, 100),
    region: boundedText(value.region, 64),
    country: boundedText(value.country, 100),
    latitude: hasCoordinates ? value.latitude : null,
    longitude: hasCoordinates ? value.longitude : null,
    geographicPrecision: hasCoordinates ? 'network-approximate' : null,
    geographicMethod: hasCoordinates
      ? boundedText(value.geographicMethod, 120)
      : null,
    geographicProvenance: hasCoordinates
      ? boundedText(value.geographicProvenance, 200)
      : null,
    attribution,
  });
}

function normalizeShodanSearchResult(value) {
  if (
    !value ||
    value.provider !== 'shodan' ||
    !Array.isArray(value.matches) ||
    value.matches.length > 100
  )
    throw new Error('Malformed Cyber enrichment response');
  const query = boundedText(value.query, 180);
  const fetchedAt = iso(value.fetchedAt);
  if (
    !query ||
    !fetchedAt ||
    !Number.isInteger(value.page) ||
    value.page < 1 ||
    value.page > 3
  )
    throw new Error('Malformed Cyber enrichment response');
  const matches = value.matches.map((row) =>
    normalizeEnrichmentRecord(row, 'shodan'),
  );
  return Object.freeze({
    provider: 'shodan',
    query,
    page: value.page,
    pageLimit: 3,
    pageSize: 100,
    total:
      Number.isSafeInteger(value.total) && value.total >= 0
        ? value.total
        : null,
    fetchedAt,
    attribution: boundedText(value.attribution, 120),
    matches: Object.freeze(matches),
  });
}

/** Validate one normalized, provider-attributed Cyber observation. */
function normalizeObservation(value, provider) {
  if (!value || typeof value !== 'object') return null;
  const id = boundedText(value.id, 120);
  const category = boundedText(value.category, 80);
  const source = boundedText(value.source, 160);
  const observedAt = iso(value.observedAt);
  if (!id || !category || value.provider !== provider || !source) return null;
  const coordinatesPresent = value.latitude != null || value.longitude != null;
  let latitude = null;
  let longitude = null;
  if (coordinatesPresent) {
    if (
      !Number.isFinite(value.latitude) ||
      value.latitude < -90 ||
      value.latitude > 90 ||
      !Number.isFinite(value.longitude) ||
      value.longitude < -180 ||
      value.longitude > 180 ||
      !['country', 'network-approximate'].includes(value.geographicPrecision) ||
      !boundedText(value.geographicMethod, 120) ||
      !boundedText(value.geographicProvenance, 200)
    )
      return null;
    latitude = value.latitude;
    longitude = value.longitude;
  }
  const share =
    Number.isFinite(value.share) && value.share >= 0 && value.share <= 100
      ? value.share
      : null;
  const rank =
    Number.isInteger(value.rank) && value.rank > 0 ? value.rank : null;
  const indicatorType = boundedText(value.indicator?.type, 24);
  const indicatorValue = boundedText(value.indicator?.value, 160);
  return Object.freeze({
    id,
    provider,
    category,
    source,
    observedAt,
    windowStart: iso(value.windowStart),
    windowEnd: iso(value.windowEnd),
    latitude,
    longitude,
    geographicPrecision: coordinatesPresent ? value.geographicPrecision : null,
    geographicMethod: coordinatesPresent ? value.geographicMethod : null,
    geographicProvenance: coordinatesPresent
      ? value.geographicProvenance
      : null,
    locationCode: boundedText(value.locationCode, 2),
    locationName: boundedText(value.locationName, 100),
    share,
    rank,
    hostname: boundedText(value.hostname, 253),
    indicator:
      indicatorType && indicatorValue
        ? Object.freeze({ type: indicatorType, value: indicatorValue })
        : null,
    detail: boundedText(value.detail, 160),
  });
}

/** Normalize a provider snapshot into the Cyber domain and reject raw records. */
export function normalizeCyberSnapshot(value, provider) {
  if (
    !['cloudflare-radar', 'dshield'].includes(provider) ||
    !value ||
    value.schemaVersion !== 1 ||
    value.provider !== provider ||
    !Array.isArray(value.observations) ||
    value.observations.length > 32
  )
    throw new Error('Malformed Cyber provider response');
  const fetchedAt = iso(value.fetchedAt);
  const attribution = boundedText(value.attribution, 200);
  if (!fetchedAt || !attribution)
    throw new Error('Malformed Cyber provider response');
  const observations = value.observations.map((record) =>
    normalizeObservation(record, provider),
  );
  if (observations.some((record) => !record))
    throw new Error('Malformed Cyber provider response');
  const flows =
    provider === 'cloudflare-radar' && Array.isArray(value.flows)
      ? value.flows.slice(0, 10).map((flow) => {
          const id = boundedText(flow?.id, 120);
          const share =
            Number.isFinite(flow?.share) && flow.share >= 0 && flow.share <= 100
              ? flow.share
              : null;
          const rank =
            Number.isInteger(flow?.rank) && flow.rank > 0 ? flow.rank : null;
          const point = (candidate) => {
            const code = boundedText(candidate?.code, 2);
            const name = boundedText(candidate?.name, 100);
            if (
              !/^[A-Z]{2}$/.test(code || '') ||
              !name ||
              !Number.isFinite(candidate?.latitude) ||
              candidate.latitude < -90 ||
              candidate.latitude > 90 ||
              !Number.isFinite(candidate?.longitude) ||
              candidate.longitude < -180 ||
              candidate.longitude > 180
            )
              return null;
            return Object.freeze({
              code,
              name,
              latitude: candidate.latitude,
              longitude: candidate.longitude,
            });
          };
          const origin = point(flow?.origin);
          const target = point(flow?.target);
          const geographicMethod = boundedText(flow?.geographicMethod, 120);
          const geographicProvenance = boundedText(
            flow?.geographicProvenance,
            240,
          );
          if (
            !id ||
            flow?.provider !== provider ||
            share == null ||
            rank == null ||
            !origin ||
            !target ||
            !geographicMethod ||
            !geographicProvenance
          )
            return null;
          return Object.freeze({
            id,
            provider,
            origin,
            target,
            share,
            rank,
            observedAt: iso(flow.observedAt),
            windowStart: iso(flow.windowStart),
            windowEnd: iso(flow.windowEnd),
            geographicPrecision: 'country',
            geographicMethod,
            geographicProvenance,
          });
        })
      : [];
  if (flows.some((flow) => !flow))
    throw new Error('Malformed Cyber provider response');
  const ports =
    provider === 'dshield' && Array.isArray(value.ports)
      ? value.ports.slice(0, 10).map((port) => ({
          rank:
            Number.isInteger(port?.rank) && port.rank > 0 ? port.rank : null,
          port:
            Number.isInteger(port?.port) && port.port >= 0 && port.port <= 65535
              ? port.port
              : null,
          protocol: boundedText(port?.protocol, 16),
          label: boundedText(port?.label, 100),
          sources:
            Number.isInteger(port?.sources) && port.sources >= 0
              ? port.sources
              : null,
        }))
      : [];
  if (
    ports.some((port) => port.rank == null || port.port == null || !port.label)
  )
    throw new Error('Malformed Cyber provider response');
  return Object.freeze({
    provider,
    attribution,
    fetchedAt,
    stale: value.stale === true,
    windowStart: iso(value.windowStart),
    windowEnd: iso(value.windowEnd),
    notice: boundedText(value.notice, 240),
    observations: Object.freeze(observations),
    flows: Object.freeze(flows),
    ports: Object.freeze(ports),
  });
}

export {
  normalizeObservation as normalizeCyberObservation,
  normalizeEnrichmentRecord as normalizeCyberEnrichment,
  normalizeShodanSearchResult,
};
