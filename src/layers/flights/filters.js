const clean = (value) =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');

/** Session display filters; acquisition and the underlying live records stay intact. */
export function createFlightFilters({ flightState, parts, layer }) {
  let airline = '',
    flight = '',
    selected = '',
    operators = [],
    callsigns = [];
  let generation = 0,
    revision = 0,
    busy = false,
    message = '';
  let listener = null,
    cacheKey = '',
    options = [],
    matched = 0;
  let matchCache = new WeakMap();
  let pending = null;
  const active = () => Boolean(airline || flight || selected);
  const notify = () => {
    cacheKey = '';
    listener?.();
  };

  function matches(id, info) {
    if (!active()) return true;
    if (!info) return false;
    if (selected && id !== selected) return false;
    const cached = matchCache.get(info);
    if (cached && cached.callsign === info.callsign) return cached.matches;
    const cs = clean(info.callsign);
    const result =
      (!airline ||
        operators.some(
          (code) => cs.startsWith(code) && /^[A-Z0-9]{1,7}$/.test(cs.slice(3)),
        )) &&
      (!flight || callsigns.includes(cs));
    matchCache.set(info, { callsign: info.callsign, matches: result });
    return result;
  }

  function refreshOptions() {
    const key = `${revision}:${flightState.feed._trackingRefreshEpoch}:${flightState.feed._lastUpdate}:${flightState.feed._count}:${flightState.records.data.size}`;
    if (key === cacheKey) return;
    cacheKey = key;
    matched = 0;
    const rows = [];
    for (const [id, info] of flightState.records.data) {
      if (!matches(id, info)) continue;
      matched++;
      if (rows.length < 200)
        rows.push({
          value: id,
          label: `${clean(info.callsign) || info.registration || id}${info.airline ? ` · ${info.airline}` : ''}`,
        });
    }
    rows.sort((a, b) => a.label.localeCompare(b.label));
    options = [{ value: '', label: 'Choose a loaded flight…' }, ...rows];
  }

  function commit(
    nextAirline,
    nextFlight,
    nextOperators,
    nextCallsigns,
    detail,
    selectedId = '',
  ) {
    airline = nextAirline;
    flight = nextFlight;
    selected = selectedId;
    operators = nextOperators;
    callsigns = nextCallsigns;
    revision++;
    matchCache = new WeakMap();
    message = detail;
    parts.tracking._cancelPendingTrackingRestore?.();
    // A tracker has its own entity/model: release a subject excluded by the
    // new filter instead of letting it bypass the requested display cohort.
    const tracked = flightState._trackedIcao;
    if (tracked && !matches(tracked, flightState.records.data.get(tracked)))
      parts.tracking._clearTracking(false, { origin: 'user' });
    for (const [id, bb] of flightState._billboards) {
      if (!matches(id, flightState.records.data.get(id))) {
        bb.show = false;
        parts.rendering._releaseModel(id);
      }
    }
    flightState._lastFleetTickMs = 0;
    flightState._viewer?.scene?.requestRender();
    notify();
  }

  async function apply(values = {}) {
    const nextAirline = clean(values.airline),
      nextFlight = clean(values.flight);
    const intent = ++generation;
    pending?.abort();
    pending = new AbortController();
    const signal = pending.signal;
    if (nextAirline && !/^(?:[A-Z0-9]{2}|[A-Z]{3})$/.test(nextAirline)) {
      message = 'Enter a 2-character IATA or 3-letter ICAO airline code.';
      busy = false;
      notify();
      return false;
    }
    if (nextFlight && !/^[A-Z0-9]{2,10}$/.test(nextFlight)) {
      message =
        'Enter a full callsign or IATA flight number, e.g. BAW123 or BA123.';
      busy = false;
      notify();
      return false;
    }
    busy = true;
    message = 'Resolving flight filter…';
    notify();
    const lookup = (kind, id) =>
      flightState.feed._source.getEnrichment?.({ kind, id }, { signal });
    try {
      let nextOperators = [],
        names = [];
      if (nextAirline) {
        let result;
        try {
          result = await lookup('airline', nextAirline);
        } catch {
          /* ICAO can work directly */
        }
        if (intent !== generation || signal.aborted) return false;
        const rows = result?.found
          ? (result.airlines || []).filter(
              (row) =>
                /^[A-Z]{3}$/.test(row.icao) &&
                (row.icao === nextAirline || row.iata === nextAirline),
            )
          : [];
        nextOperators = rows.map((row) => row.icao);
        names = rows.map(
          (row) => `${row.name} (${row.iata || '—'} / ${row.icao})`,
        );
        if (!nextOperators.length) {
          if (/^[A-Z]{3}$/.test(nextAirline)) {
            nextOperators = [nextAirline];
            names = [`ICAO callsign prefix ${nextAirline}`];
          } else
            throw new Error(
              'IATA code unavailable in adsbdb. Try the airline’s ICAO code.',
            );
        }
      }
      let nextCallsigns = [];
      if (nextFlight) {
        // An observed exact callsign is sufficient evidence. Otherwise ask the
        // provider for its published IATA↔ICAO alias; never splice a scheduled
        // number onto an ICAO prefix (ATC callsigns can be different).
        const observed = [...flightState.records.data.values()].some(
          (info) => clean(info.callsign) === nextFlight,
        );
        if (observed || /^[A-Z]{3}[0-9]/.test(nextFlight))
          nextCallsigns = [nextFlight];
        else {
          const route = await lookup('route', nextFlight);
          if (intent !== generation || signal.aborted) return false;
          if (
            !route?.found ||
            clean(route.callsignIata) !== nextFlight ||
            !/^[A-Z]{3}[A-Z0-9]{1,7}$/.test(clean(route.callsignIcao))
          )
            throw new Error(
              'Flight number unavailable in adsbdb. Use its observed callsign or choose a loaded flight.',
            );
          nextCallsigns = [clean(route.callsignIcao)];
        }
      }
      if (intent !== generation || signal.aborted) return false;
      commit(
        nextAirline,
        nextFlight,
        nextOperators,
        nextCallsigns,
        [
          names.join('; '),
          nextFlight ? `${nextFlight} → ${nextCallsigns.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      );
      return true;
    } catch (error) {
      if (intent === generation && !signal.aborted)
        message =
          error?.message ||
          'Lookup unavailable. Try an ICAO code or observed callsign.';
      return false;
    } finally {
      if (intent === generation) {
        busy = false;
        notify();
      }
    }
  }

  function clear() {
    generation++;
    pending?.abort();
    busy = false;
    commit('', '', [], [], '');
  }

  function choose(values) {
    const id = values.selected;
    const info = flightState.records.data.get(id);
    if (!info || !matches(id, info)) {
      message = 'Choose a flight from the current loaded results.';
      notify();
      return false;
    }
    // Selecting a listed flight filters by its observed callsign, or by stable
    // transponder identity when it has no callsign, then uses normal tracking.
    const cs = clean(info.callsign);
    commit(airline, cs, operators, cs ? [cs] : [], `${cs || id} selected`, id);
    return layer.trackById(id, { origin: 'user' });
  }

  return {
    matches,
    active,
    cancel() {
      generation++;
      pending?.abort();
      busy = false;
    },
    countLabel() {
      if (!active()) return undefined;
      refreshOptions();
      return `${matched} / ${flightState.feed._count}`;
    },
    count() {
      refreshOptions();
      return matched;
    },
    methods: {
      setFlightFilters: apply,
      clearFlightFilters: clear,
      getFlightFilters: () => ({
        airline,
        flight,
        selected,
        operators: [...operators],
        callsigns: [...callsigns],
      }),
      setRowControlsListener(fn) {
        listener = typeof fn === 'function' ? fn : null;
      },
      getRowControls() {
        refreshOptions();
        return {
          form: {
            revision,
            label: 'Filter airline / flight',
            fields: [
              {
                id: 'airline',
                label: 'Airline · IATA / ICAO',
                value: airline,
                placeholder: 'BA / BAW',
                maxLength: 3,
              },
              {
                id: 'flight',
                label: 'Flight number / callsign',
                value: flight,
                placeholder: 'BA123 / BAW123',
                maxLength: 10,
              },
              {
                id: 'selected',
                label: 'Loaded flights',
                value: selected,
                options,
              },
            ],
            actions: [
              {
                id: 'apply',
                label: busy ? 'Resolving…' : 'Apply filter',
                disabled: busy,
                onClick: apply,
              },
              {
                id: 'choose',
                label: 'Select & follow',
                disabled: busy || matched === 0,
                onClick: choose,
              },
              { id: 'clear', label: 'Show all', onClick: clear },
            ],
          },
          info:
            active() || message
              ? `${message ? `${message} · ` : ''}${matched} matching loaded aircraft${matched > 200 ? ' · first 200 listed; narrow the filter' : ''}. Live coverage only; absent flights may be outside the feed.`
              : 'Filter by airline or flight; choose from loaded contacts.',
        };
      },
    },
  };
}
