/**
 * Australian fire incidents proxy — aggregates public GeoJSON feeds from
 * NSW Rural Fire Service and Victoria Emergency Management Victoria (EMV).
 *
 * No API keys required — both are public feeds.
 * TTL: 2 minutes. Single-flight refresh per source. Serve stale on failure.
 *
 * Route:
 *   GET /api/au-fire → { fetchedAt, incidents: Array }
 *
 * Coverage:
 *   NSW — NSW Rural Fire Service major incidents
 *   VIC — Emergency Management Victoria (all fire-category incidents)
 *
 * @returns {import('vite').Plugin}
 */
export function auFireProxy() {
  const TTL_MS = 120_000;

  const SOURCES = {
    nsw: {
      url: 'https://www.rfs.nsw.gov.au/feeds/majorIncidents.json',
      state: 'NSW',
    },
    vic: {
      url: 'https://emergency.vic.gov.au/public/osom-geojson.json',
      state: 'VIC',
    },
  };

  /** @type {?{at: number, incidents: Array}} */
  let mem = null;
  /** @type {?Promise<?{at: number, incidents: Array}>} */
  let inflight = null;

  /** Parse HTML description into key-value pairs (NSW RFS format). */
  function parseNswDescription(html) {
    if (!html) return {};
    const parts = html
      .split(/<br\s*\/?>/i)
      .map((s) =>
        s
          .replace(/<[^>]*>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&nbsp;/g, ' ')
          .trim(),
      )
      .filter(Boolean);
    const out = {};
    for (const part of parts) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      out[part.slice(0, colon).trim().toUpperCase()] = part
        .slice(colon + 1)
        .trim();
    }
    return out;
  }

  /** Parse size strings like "3,062 ha" or "9.57 Ha." → hectares or null. */
  function parseSizeHa(str) {
    if (!str) return null;
    const cleaned = str.replace(/,/g, '').replace(/ha\.?/i, '').trim();
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Extract lon/lat point and optional perimeter from a feature geometry.
   * Recurses into nested GeometryCollections (NSW and VIC both use this nesting).
   */
  function extractGeometry(geometry, depth = 0) {
    if (!geometry || depth > 4)
      return { lon: null, lat: null, perimeter: null };
    if (geometry.type === 'Point') {
      const [lon, lat] = geometry.coordinates;
      return { lon, lat, perimeter: null };
    }
    if (geometry.type === 'GeometryCollection') {
      let lon = null,
        lat = null,
        perimeter = null;
      for (const g of geometry.geometries || []) {
        if (g.type === 'Point' && lon == null) {
          [lon, lat] = g.coordinates;
        } else if (
          (g.type === 'Polygon' || g.type === 'MultiPolygon') &&
          !perimeter
        ) {
          perimeter = g;
        } else if (g.type === 'GeometryCollection') {
          const inner = extractGeometry(g, depth + 1);
          if (inner.lon != null && lon == null) {
            lon = inner.lon;
            lat = inner.lat;
          }
          if (inner.perimeter && !perimeter) perimeter = inner.perimeter;
        }
      }
      return { lon, lat, perimeter };
    }
    return { lon: null, lat: null, perimeter: null };
  }

  /** Normalize one NSW RFS GeoJSON feature → incident record. */
  function normalizeNsw(feature) {
    const p = feature.properties || {};
    const { lon, lat, perimeter } = extractGeometry(feature.geometry);
    if (lon == null || lat == null) return null;
    const desc = parseNswDescription(p.description || '');
    return {
      id: `nsw:${String(p.guid || feature.id || '')}`,
      state: 'NSW',
      title: String(p.title || p.name || '').trim(),
      alertLevel: String(p.category || desc['ALERT LEVEL'] || '').trim(),
      link: String(p.link || '').trim(),
      pubDate: String(p.pubDate || '').trim(),
      status: String(desc['STATUS'] || '').trim(),
      type: String(desc['TYPE'] || '').trim(),
      fireActive: (desc['FIRE'] || '').toLowerCase() === 'yes',
      sizeHa: parseSizeHa(desc['SIZE']),
      council: String(desc['COUNCIL AREA'] || '').trim(),
      location: String(desc['LOCATION'] || '').trim(),
      agency: String(desc['RESPONSIBLE AGENCY'] || '').trim(),
      updated: String(desc['UPDATED'] || '').trim(),
      lon,
      lat,
      perimeter: perimeter || null,
    };
  }

  /**
   * Map VIC category1 to the same alert level vocabulary as NSW.
   * VIC uses 'Emergency Warning', 'Watch and Act', 'Advice', 'Community Update'.
   */
  function mapVicAlertLevel(category1, action) {
    if (category1 === 'Emergency Warning') return 'Emergency Warning';
    if (category1 === 'Watch and Act') return 'Watch and Act';
    if (category1 === 'Advice') return 'Advice';
    if (action === 'Emergency Warning') return 'Emergency Warning';
    if (action === 'Watch and Act') return 'Watch and Act';
    if (action === 'Advice') return 'Advice';
    return 'Advice'; // Community Update, Planned Burn etc.
  }

  /** Normalize one VIC Emergency GeoJSON feature → incident record. */
  function normalizeVic(feature) {
    const p = feature.properties || {};
    // Only include fire-category incidents
    if (
      p.cap?.category !== 'Fire' &&
      p.category2 !== 'Fire' &&
      p.category2 !== 'Burn Area' &&
      p.category2 !== 'Planned Burn'
    ) {
      return null;
    }
    const { lon, lat, perimeter } = extractGeometry(feature.geometry);
    if (lon == null || lat == null) return null;
    const id = `vic:${String(p.id || p.sourceId || '')}`;
    const title = String(p.name || p.location || '').trim();
    return {
      id,
      state: 'VIC',
      title,
      alertLevel: mapVicAlertLevel(p.category1, p.action),
      link: p.sourceId
        ? `https://emergency.vic.gov.au/#${p.sourceId}`
        : 'https://emergency.vic.gov.au',
      pubDate: String(p.created || '').trim(),
      status: String(p.status || p.category2 || '').trim(),
      type: String(p.cap?.event || p.category2 || '').trim(),
      fireActive: p.category2 !== 'Planned Burn',
      sizeHa: parseSizeHa(p.sizeFmt),
      council: '',
      location: String(p.location || '').trim(),
      agency: String(p.cap?.senderName || p.sourceOrg || '').trim(),
      updated: String(p.updated || '').trim(),
      lon,
      lat,
      perimeter: perimeter || null,
    };
  }

  /** Fetch and normalize a single source. Returns [] on failure (non-fatal). */
  async function fetchSource(key) {
    const { url, state } = SOURCES[key];
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: {
          Accept: 'application/json, application/geo+json',
          'Accept-Encoding': 'gzip',
        },
      });
      if (!res.ok) throw new Error(`AU Fire [${state}] HTTP ${res.status}`);
      const geojson = await res.json();
      if (!Array.isArray(geojson?.features))
        throw new Error(`AU Fire [${state}] unexpected response shape`);
      const normalize = key === 'nsw' ? normalizeNsw : normalizeVic;
      return geojson.features.map(normalize).filter(Boolean);
    } catch (err) {
      console.warn(
        `[au-fire-proxy] ${state} fetch failed:`,
        err?.message || err,
      );
      return [];
    }
  }

  /** Fetch all sources in parallel and merge. */
  async function fetchUpstream() {
    const [nsw, vic] = await Promise.all([
      fetchSource('nsw'),
      fetchSource('vic'),
    ]);
    return { at: Date.now(), incidents: [...nsw, ...vic] };
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/au-fire', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };

      try {
        const entry = mem;
        if (entry && Date.now() - entry.at < TTL_MS) {
          sendJson(200, { fetchedAt: entry.at, incidents: entry.incidents });
          return;
        }

        if (!inflight) {
          inflight = fetchUpstream()
            .then((fresh) => {
              mem = fresh;
              return fresh;
            })
            .catch((err) => {
              console.warn(
                '[au-fire-proxy] refresh failed:',
                err?.message || err,
              );
              return null;
            })
            .finally(() => {
              inflight = null;
            });
        }

        const fresh = await inflight;
        if (fresh) {
          sendJson(200, { fetchedAt: fresh.at, incidents: fresh.incidents });
        } else if (entry) {
          sendJson(200, {
            fetchedAt: entry.at,
            incidents: entry.incidents,
            stale: true,
          });
        } else {
          sendJson(502, {
            error: 'AU fire fetch failed and no cache available',
          });
        }
      } catch (err) {
        console.warn('[au-fire-proxy] error:', err?.message || err);
        sendJson(500, { error: 'au-fire proxy error' });
      }
    });
  };

  return {
    name: 'au-fire-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
