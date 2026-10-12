const DAY = 86400000;
export function boundedArea(value) {
  const area = {
    west: value?.west,
    south: value?.south,
    east: value?.east,
    north: value?.north,
  };
  if (
    !Object.values(area).every(Number.isFinite) ||
    Math.abs(area.west) > 180 ||
    Math.abs(area.east) > 180 ||
    Math.abs(area.south) > 90 ||
    Math.abs(area.north) > 90 ||
    area.east <= area.west ||
    area.north <= area.south ||
    area.east - area.west > 5 ||
    area.north - area.south > 5
  )
    throw Error(
      'Select a smaller rectangle, up to five degrees per side. Date-line crossing is not supported.',
    );
  return area;
}
export function safeArticleUrl(value) {
  try {
    const u = new URL(value);
    if (
      !['https:', 'http:'].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.hostname === 'localhost' ||
      u.hostname.endsWith('.localhost') ||
      /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/.test(u.hostname) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(u.hostname)
    )
      return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}
function phrase(value, max, required) {
  const p = String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (
    (required && p.length < 3) ||
    p.length > max ||
    !/^[\p{L}\p{N} ,.'’()\-]*$/u.test(p)
  )
    throw Error(
      'Use a city/region name and optional plain-text topic, without search operators.',
    );
  return p;
}
/** DOC2 searches article text. The area is local context only; no geographic filtering or pins. */
export function newsRequest(input, now = Date.now()) {
  const area = boundedArea(input?.area),
    place = phrase(input?.place, 80, true),
    topic = phrase(input?.topic, 100, false);
  const start = Date.parse(input?.start),
    end = Date.parse(input?.end);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end - start < 15 * 60000 ||
    end - start > 31 * DAY ||
    start < now - 89 * DAY ||
    end > now + 120000
  )
    throw Error(
      'Choose a range of 15 minutes to 31 days, within the last 89 days, ending no later than now.',
    );
  return {
    area,
    place,
    topic,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    query: `"${place}"${topic ? ` "${topic}"` : ''}`,
  };
}
export function gdeltSeenAt(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(
    String(value || ''),
  );
  const text = match
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`
    : String(value || '');
  return Number.isFinite(Date.parse(text))
    ? new Date(text).toISOString()
    : null;
}
/** Bounded metadata only; article bodies and publisher images are never acquired. */
export function normalizeNews(payload, request) {
  if (!payload || !Array.isArray(payload.articles))
    throw Error(
      'GDELT returned an unsupported response, not a verified empty result.',
    );
  const seen = new Set(),
    rows = [];
  for (const a of payload.articles.slice(0, 100)) {
    const url = safeArticleUrl(a?.url),
      seenAt = gdeltSeenAt(a?.seendate);
    if (
      !url ||
      seen.has(url) ||
      !seenAt ||
      seenAt < request.start ||
      seenAt > request.end ||
      typeof a.title !== 'string' ||
      !a.title.trim()
    )
      continue;
    seen.add(url);
    rows.push({
      url,
      title: a.title.slice(0, 500),
      seenAt,
      publisher: new URL(url).hostname,
      language: typeof a.language === 'string' ? a.language.slice(0, 40) : '',
      placement: 'unverified-place-name-match',
    });
    if (rows.length === 25) break;
  }
  return rows;
}
