import { normalizeFlightIdentity } from '../data/flightIdentity.js';

/** Resolve feed aircraft without browser records; follow only an exact loaded ID. */
export async function lookupVoiceAircraft(
  args,
  { loadCatalog, dataManager, enable, follow, signal, isCurrent },
) {
  const fail = (error, lookup = null) => ({
    ok: false,
    tracking: false,
    action: 'track_entity',
    error,
    lookup,
  });
  const current = () => !signal?.aborted && isCurrent();
  if (!current()) return fail('Aircraft request cancelled');
  try {
    const query = normalizeFlightIdentity(args.query);
    const catalog = await loadCatalog?.();
    if (!current()) return fail('Aircraft request cancelled');
    if (!catalog?.lookupAircraft) return fail('Aircraft feeds unavailable');
    const lookup = await catalog.lookupAircraft(
      /^[a-f0-9]{6}$/i.test(query) ? { icao24: query } : { callsign: query },
      { signal },
    );
    if (!current()) return fail('Aircraft request cancelled');
    const data = lookup.data;
    const rows = data.rows || [];
    const coverage = data.feeds
      .map(
        (feed) =>
          `${feed.feed}: ${feed.source || 'unknown source'}, observed ${feed.observed_at || 'unknown time'}, ${feed.coverage || 'unknown coverage'}`,
      )
      .join('; ');
    const summary =
      lookup.summary + (coverage ? ` Coverage: ${coverage}.` : '');
    const result = {
      ok: true,
      action: 'track_entity',
      lookupOnly: true,
      summary,
      say: summary,
      tracking: false,
      data: { ...data, view: null },
    };
    // Lookup success says nothing about whether the camera is following.
    if (args.lookupOnly) return result;
    if (data.total !== 1 || rows.length !== 1)
      return fail(
        data.total > 1
          ? 'Ambiguous aircraft; select an exact ICAO identifier'
          : 'No aircraft reported in available feed coverage',
        result,
      );
    const id = String(rows[0].id || '').toLowerCase();
    const candidate = data.feeds.filter(
      (feed) =>
        feed.feed ===
        (data.view?.follow?.kind === 'military_aircraft'
          ? 'military'
          : 'civil'),
    );
    if (
      !/^[a-f0-9]{6}$/.test(id) ||
      !candidate.length ||
      candidate.some((feed) => feed.freshness !== 'current')
    )
      return fail(
        'Aircraft observation is stale or freshness is unknown',
        result,
      );
    const observed = Date.parse(candidate[0].observed_at);
    const contact = Date.parse(rows[0].last_contact);
    if (
      !Number.isFinite(contact) ||
      !Number.isFinite(observed) ||
      observed - contact > 120_000
    )
      return fail(
        'Aircraft position is stale or observation time is unknown',
        result,
      );
    if (contact - observed > 120_000)
      return fail(
        'Aircraft position is inconsistent: contact time is future-dated',
        result,
      );
    const layerId = candidate[0].feed === 'military' ? 'military' : 'flights';
    if (args.layerId && args.layerId !== layerId)
      return fail('Aircraft was reported by a different layer', result);
    const enabled = await enable(layerId);
    if (!current()) return fail('Aircraft request cancelled');
    if (!enabled?.ok)
      return fail('Aircraft layer could not be enabled', result);
    const refreshed = await dataManager.refreshLayer?.(layerId, { signal });
    if (!current()) return fail('Aircraft request cancelled');
    if (!refreshed)
      return fail('Aircraft layer refresh unavailable or failed', result);
    const found = dataManager.layers.get(layerId)?.module?.findByQuery?.(id);
    if (String(found?.icao24 || '').toLowerCase() !== id || found?.stale)
      return fail(
        'Exact aircraft is not available in the refreshed layer',
        result,
      );
    const tracked = await follow({ query: id, layerId }, id);
    if (!current()) return fail('Aircraft request cancelled');
    return { ...tracked, tracking: tracked.ok === true, lookup: result };
  } catch (error) {
    return {
      ...fail(
        current()
          ? `Aircraft feed lookup failed: ${error.message}`
          : 'Aircraft request cancelled',
      ),
      code: error.code || null,
      retryAfterSeconds: error.retryAfterSeconds ?? null,
    };
  }
}
