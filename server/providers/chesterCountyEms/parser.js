/** Decode text only; upstream HTML is never forwarded or executed. */
function text(html) {
  return html
    .replace(/<[^>]*>/g, '')
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
      });
    }
  }
  if (rows.length > 500) throw new Error('Too many incidents');
  return { observedAt: easternTime(updated[1]), rows };
}
