/** Hazard layers — cyclone advisories (src/layers/cyclones), active fires
 * (src/layers/firms) and fire perimeters (src/layers/perimeters). Layer
 * registration names/sources stay English (voice/HUD matching); the `row`
 * entries name their display form. */
export default {
  row: {
    cyclones: 'Cyclone advisories',
    cyclonesSource: 'NOAA NHC / CPHC',
    perimeters: 'Fire Perimeters',
    perimetersSource: 'NIFC WFIGS',
  },
  cyclones: {
    error: { unavailable: 'Cyclone advisories unavailable' },
    coverage:
      'Atlantic and eastern/central North Pacific; not worldwide cyclone coverage.',
    classification: {
      ptc: 'Potential tropical cyclone',
      hu: 'Hurricane',
      ts: 'Tropical storm',
      td: 'Tropical depression',
      ss: 'Subtropical storm',
      sd: 'Subtropical depression',
    },
    geometry: {
      current: 'Track and cone match this advisory',
      pending: 'Track/cone awaiting advisory {n}',
      unavailable: 'Track/cone unavailable',
    },
    status: {
      stale: 'Cached advisory · stale source',
      loading: 'Loading advisories…',
    },
    detail: '{name} · {class} · Advisory {n} · issued {time}',
    empty: 'No active NHC/CPHC systems',
    activeStorms: {
      one: '{count} active storm',
      other: '{count} active storms',
    },
    activeStormsSelected: {
      one: '{count} active storm · {name} selected',
      other: '{count} active storms · {name} selected',
    },
    unavailable: 'Advisories unavailable',
    summary: {
      label: 'Cyclones · NHC / CPHC',
      coverage: 'Atlantic · E/C Pacific',
      officialAdvisory: 'Official advisory ↗',
    },
    lines: {
      position: 'Position as of {time}',
      intensity: 'Maximum sustained wind: {wind} · Pressure: {pressure}',
    },
    item: '{name} · {class} · {wind}',
    windUnavailable: 'Wind unavailable',
    list: { aria: 'Active NHC and CPHC cyclone advisories' },
    legend: {
      track: 'Advisory center / forecast track',
      cone: 'Center-track uncertainty cone',
    },
    infoTitle:
      'Select a storm on the map, or choose a storm in the list to select it and move the camera. Click empty map space to clear the selection. NOAA NHC/CPHC advisory context. The cone describes forecast center-track uncertainty, not storm size or the full hazard area. Forecast point labels are source lead hours, not times computed from advisory issuance. Geometry follows the surface; height is not weather altitude. Consult the official advisory.',
  },
  firms: {
    fire: 'FIRE',
    confidence: { high: 'high', nominal: 'nominal', low: 'low' },
    confSuffix: '{bucket} conf',
    agoSuffix: '{age} ago',
    sensorNA: 'sensor n/a',
    selectedTitle: 'FIRE · {frp} MW',
    night: ' · NIGHT',
    ambientTitle: '▲ {frp} MW',
    cellTitle: { one: '{count} FIRE', other: '{count} FIRES' },
    maxFrp: 'max {frp} MW',
    newAge: 'new {age}',
    age: { underHour: '<1h', hours: '{n}h', days: '{n}d' },
    agoUnderMinute: '<1m ago',
    unknown: 'unknown',
    focusAria: 'Focus fire detection {title}, {details}',
    label: 'Fire · FRP {frp} MW',
    status: {
      staleCached: 'STALE · cached {age}',
      stale: 'STALE',
      refreshing: 'refreshing...',
      loading: 'loading...',
      keyRequired: 'KEY REQUIRED',
      live: 'LIVE · updated {ago}',
    },
    error: { liveFeed: 'live feed unavailable' },
  },
  perimeters: {
    error: { source: 'Perimeter source unavailable' },
    age: { minutes: '{m}m', hours: '{h}h', days: '{n}d' },
    card: {
      acres: '{acres} ac',
      contained: '{pct}% contained',
      containmentUnknown: 'containment unknown',
      cause: '{cause} cause',
      personnel: '{n} personnel',
      county: '{county} County',
      costToDate: '{cost} to date',
      discovered: 'discovered {age} ago',
      updated: 'updated {age} ago',
      partOf: 'part of {name}',
      inciweb: 'InciWeb ↗ · click card to open',
      title: 'FIRE · {name}',
      unnamed: 'Unnamed incident',
      openAria: 'Open {title} on InciWeb',
    },
    legend: {
      none: 'Not contained or unknown',
      under50: 'Under 50% contained',
      mid: '50–99% contained',
      full: 'Fully contained',
      blurb:
        'Colour shows reported containment. Perimeters are simplified to about 100 m.',
    },
  },
};
