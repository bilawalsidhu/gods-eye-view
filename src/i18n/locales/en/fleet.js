/**
 * English pack — fleet layers (flights, military, vessels) plus the shared
 * aircraft-class and AIS-type label vocabularies. Values are verbatim: the
 * layers' registration names stay in source (voice/HUD matching) and the
 * tracked readouts, context lines, HUD AIS lines and feed chips compose
 * through these keys at render time.
 */
export default {
  flights: {
    context: {
      onGround: 'on ground',
      statusStale: 'stale (missed polls)',
      statusLive: 'live',
    },
    tracked: {
      stale: 'STALE',
    },
  },
  military: {
    context: {
      onGround: 'on ground',
      statusStale: 'stale (missed polls)',
      statusLive: 'live',
    },
    tracked: {
      stale: 'STALE',
      typeUnknown: 'Type unknown',
      regUnknown: 'Reg unknown',
      operatorUnknown: 'Operator unknown',
    },
  },
  aircraft: {
    altitudeUnknown: 'Alt unknown',
  },
  aircraftClass: {
    light: 'Light aircraft',
    glider: 'Glider',
    turboprop: 'Turboprop',
    airliner: 'Airliner',
    widebody: 'Widebody',
    quadjet: 'Four-engine jet',
    helicopter: 'Helicopter',
    fastjet: 'Fast jet',
    bizjet: 'Business jet',
    uav: 'Drone',
  },
  vessels: {
    awaitingPositions: 'awaiting usable AIS positions…',
    chip: {
      firstConnect: 'awaiting first AIS position…',
      apiKeyRejected: 'API key rejected — check AISSTREAM_API_KEY',
      feedSilentFor: 'feed silent {n}s — no AIS data',
      feedSilent: 'feed silent — no AIS data',
      feedDown: 'feed down — retrying slowly{suffix}',
      reconnecting: 'reconnecting to feed…{suffix}',
      attemptSuffix: ' (attempt {n})',
      awaitingPositions: 'awaiting usable AIS positions…',
      awaitingFirstMessage: 'awaiting first AIS message…',
      feedUnavailable: 'feed unavailable',
      reasonDetail: '{reason} ({detail})',
    },
    reason: {
      'missing-key': 'AISSTREAM_API_KEY not set',
      unsupported: 'live feed unsupported',
      connecting: 'connecting to feed…',
      closed: 'feed disconnected',
      error: 'feed down',
      idle: 'feed idle',
    },
    hud: {
      line: 'AIS: {name}',
      idle: 'AIS: --',
      typeFallback: 'VESSEL',
      stale: 'STALE',
    },
    card: {
      typeFallback: 'VESSEL',
      unnamed: 'VESSEL',
      stale: 'STALE',
    },
  },
  aisType: {
    fishing: 'FISHING',
    towing: 'TOWING',
    dredger: 'DREDGER',
    diveOps: 'DIVE OPS',
    military: 'MILITARY',
    sailing: 'SAILING',
    pleasure: 'PLEASURE',
    pilot: 'PILOT',
    sar: 'SAR',
    tug: 'TUG',
    portTender: 'PORT TENDER',
    antiPollution: 'ANTI-POLLUTION',
    lawEnforce: 'LAW ENFORCE',
    medical: 'MEDICAL',
    highSpeed: 'HIGH-SPEED',
    passenger: 'PASSENGER',
    cargo: 'CARGO',
    tanker: 'TANKER',
    other: 'OTHER',
  },
};
