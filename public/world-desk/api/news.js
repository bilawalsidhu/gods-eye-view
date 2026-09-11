const QUERY = '(theme:NATURAL_DISASTER OR theme:TERROR OR theme:PROTEST OR theme:ELECTION OR theme:UNREST OR theme:ARMEDCONFLICT)';

function clean(value, max = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=120');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method && req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }
  const params = new URLSearchParams({
    query: QUERY,
    mode: 'artlist',
    format: 'json',
    maxrecords: '50',
    sort: 'datedesc',
    timespan: '24h',
  });
  try {
    const upstream = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, {
      headers: { 'User-Agent': 'GodsEyeView-WorldDesk/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)' },
    });
    if (!upstream.ok) {
      res.status(502).json({ error: 'World news unavailable' });
      return;
    }
    const payload = await upstream.json();
    const articles = [];
    for (const row of payload.articles || []) {
      const url = safeUrl(row.url || row.url_mobile);
      const title = clean(row.title);
      if (!url || !title) continue;
      articles.push({
        title,
        url,
        domain: clean(row.domain, 80),
        sourceCountry: clean(row.sourcecountry, 60) || null,
      });
      if (articles.length >= 40) break;
    }
    res.status(200).json({ source: 'GDELT DOC 2.0', articles });
  } catch {
    res.status(502).json({ error: 'World news unavailable' });
  }
}
