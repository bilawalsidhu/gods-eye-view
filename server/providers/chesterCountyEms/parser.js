/** Decode text only; upstream HTML is never forwarded or executed. */
function text(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (all, entity) => {
        if (entity[0] === '#') {
          const hex = entity[1].toLowerCase() === 'x';
          const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
          return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
        }
        return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[
          entity.toLowerCase()
        ];
      },
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Accept only the county's category-specific detail link for this incident. */
export function webCadDetailUrl(href, { category, incidentNumber }) {
  try {
    const url = new URL(text(href), 'https://webcad.chesco.org/WebCad/');
    if (
      !['fire', 'ems', 'traffic'].includes(category) ||
      url.origin !== 'https://webcad.chesco.org' ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== `/WebCad/livecadcomments-${category}.asp` ||
      url.searchParams.get('incidentno') !== incidentNumber ||
      !/^\d{1,12}$/.test(url.searchParams.get('eid') || '') ||
      [...url.searchParams].some(
        ([key, value]) =>
          ![
            'eid',
            'incidentno',
            'incidenttype',
            'location',
            'mun',
            'station',
          ].includes(key) ||
          url.searchParams.getAll(key).length !== 1 ||
          value.length > 500,
      )
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Parse public unit status rows, including the county's unclosed header tr. */
export function parseWebCadDetails(html, { category, incidentNumber }) {
  const plain = text(html);
  if (!plain.match(new RegExp(`Incident No\\.\\s*${incidentNumber}\\b`)))
    throw new Error('Wrong incident detail page');
  const updated = plain.match(
    /Last Updated\s+(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}\s+[AP]M)/i,
  );
  if (!updated) throw new Error('Missing detail timestamp');
  const units = [];
  if (category !== 'traffic') {
    const table = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)]
      .map((m) => m[1])
      .find((body) => /Date\/Time Entered/i.test(text(body)));
    if (!table) throw new Error('Missing unit status table');
    const rows = table
      .split(/<tr\b[^>]*>/i)
      .slice(1)
      .map((row) =>
        [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
          text(m[1]),
        ),
      );
    if (
      JSON.stringify(rows.shift()) !==
      JSON.stringify(['Date/Time Entered', 'Unit', 'Status'])
    )
      throw new Error('Unknown unit status schema');
    if (rows.length > 128) throw new Error('Too many unit statuses');
    for (const fields of rows) {
      if (fields.length !== 3 || fields.some((s) => !s || s.length > 200))
        throw new Error('Invalid unit status');
      const [entered, unit, rawStatus] = fields;
      units.push({
        unit,
        status: rawStatus.replace(/^>\s*/, ''),
        entered,
        enteredAt: easternTime(entered),
      });
    }
  }
  return { incidentNumber, observedAt: easternTime(updated[1]), units };
}

/** Convert the county's Eastern wall clock to UTC, checking DST round trips. */
export function easternTime(value) {
  const m = value.match(
    /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s+(AM|PM))?$/i,
  );
  if (!m) throw new Error('Invalid county timestamp');
  let hour = Number(m[4]);
  if (m[7]) hour = (hour % 12) + (m[7].toUpperCase() === 'PM' ? 12 : 0);
  const parts = [
    Number(m[3]),
    Number(m[1]),
    Number(m[2]),
    hour,
    Number(m[5]),
    Number(m[6]),
  ];
  const wall = Date.UTC(parts[0], parts[1] - 1, ...parts.slice(2));
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  });
  for (const offset of [4, 5]) {
    const time = wall + offset * 3600000;
    const got = Object.fromEntries(
      formatter.formatToParts(time).map((p) => [p.type, p.value]),
    );
    if (
      ['year', 'month', 'day', 'hour', 'minute', 'second'].every(
        (key, i) => Number(got[key]) === parts[i],
      )
    )
      return time;
  }
  throw new Error('Invalid county timestamp');
}

/** Parse all three complete public incident tables, refusing schema changes instead of clearing good data. */
export function parseWebCad(html) {
  const updated = text(html).match(
    /Last Updated\s+(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}\s+[AP]M)/i,
  );
  if (!updated) throw new Error('Invalid WebCAD snapshot');
  const seen = new Set();
  const rows = [];
  for (const [heading, category, lastColumn] of [
    ['Fire', 'fire', 'Station'],
    ['EMS', 'ems', 'Station'],
    ['Traffic', 'traffic', 'Agency'],
  ]) {
    const section = html.match(
      new RegExp(
        `<b>\\s*${heading} Incidents\\s*<\\/b>[\\s\\S]*?<table\\b[^>]*>([\\s\\S]*?)<\\/table>`,
        'i',
      ),
    );
    if (!section) throw new Error('Invalid WebCAD snapshot');
    const tableRows = [...section[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    const cells = (row) =>
      [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
        text(m[1]),
      );
    if (
      JSON.stringify(cells(tableRows.shift()?.[1] || '')) !==
      JSON.stringify([
        'Incident No.',
        'Incident Type',
        'Incident Location',
        'Municipality',
        'Dispatch Time',
        lastColumn,
      ])
    )
      throw new Error('Unknown incident table schema');
    for (const row of tableRows) {
      const fields = cells(row[1]);
      if (fields.length !== 6 || fields.some((f) => !f || f.length > 500))
        throw new Error('Invalid incident row');
      const [
        incidentNumber,
        type,
        location,
        municipality,
        dispatched,
        station,
      ] = fields;
      const id = `${category}:${incidentNumber}`;
      if (!/^[FP]\d{8}$/.test(incidentNumber) || seen.has(id))
        throw new Error('Invalid incident identity');
      seen.add(id);
      const href = row[1].match(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
      const detailUrl =
        href && webCadDetailUrl(href, { category, incidentNumber });
      rows.push({
        id,
        incidentNumber,
        category,
        type,
        location,
        municipality,
        dispatched,
        dispatchedAt: easternTime(dispatched),
        station,
        ...(detailUrl ? { detailUrl } : {}),
      });
    }
  }
  if (rows.length > 500) throw new Error('Too many incidents');
  return { observedAt: easternTime(updated[1]), rows };
}
