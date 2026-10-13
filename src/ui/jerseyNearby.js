import * as Cesium from 'cesium';
import {
  setOverlayEntries,
  clearOverlaySource,
} from '../overlays/worldOverlay.js';
import { JERSEY_PARISHES as PARISHES } from '../sources/jerseyParishes.js';
const FEATURES = [
  [
    'parking',
    'Parking',
    '#8edc91',
    'Spaces available where tracked; facilities island-wide',
  ],
  [
    'roadworks',
    'Roadworks',
    '#ffbd66',
    'Current and next 30 days; tap for dates and restrictions',
  ],
  ['forecast', 'Weather', '#b8cfff', 'Jersey Met forecast, rain, wind and UV'],
  [
    'tides',
    'Tides & coastal access',
    '#82ddec',
    'St Helier predictions and published access information',
  ],
  [
    'toilets',
    'Public toilets',
    '#80dce7',
    'Published facilities across the island',
  ],
  [
    'eatsafe',
    'Food hygiene ratings',
    '#ffa9c1',
    'Eat Safe ratings and inspection dates',
  ],
  ['recycling', 'Recycling', '#98e192', 'What each collection point accepts'],
  [
    'defibrillators',
    'Defibrillators',
    '#ff9393',
    'Listed locations; access may vary',
  ],
  [
    'charging',
    'EV charging locations',
    '#b4e5a7',
    'Car parks with charging bays; availability not live',
  ],
  [
    'marine',
    'Shipping forecast',
    '#a8d6ff',
    'Channel Islands wind, visibility and sea state',
  ],
  [
    'buoy',
    'Offshore observations',
    '#b8dbff',
    'Timestamped wind, waves and pressure',
  ],
  [
    'parish-news',
    'Parish news & notices',
    '#d5dbff',
    'Headlines from all 12 official parish websites',
  ],
  ['deals', 'Deals & offers', '#ffd88c', 'Open current provider listings'],
  [
    'events',
    'Events & culture',
    '#ffbafa',
    'Open local calendars and booking pages',
  ],
  [
    'services',
    'Parish & local services',
    '#cbdbc9',
    'Pharmacies, collections, air quality and public maps',
  ],
];
const LINKS = {
  deals: [
    [
      'Visit Jersey offers',
      'https://www.jersey.com/holidays/package-holidays-offers-hotel-deals/',
    ],
    [
      'Jersey Rewards vouchers',
      'https://www.jtrewards.com/offer-categories/last-chance/?location=jersey',
    ],
    [
      'Liberation pub offers',
      'https://www.liberationgroup.com/post-horn/offers/',
    ],
  ],
  events: [
    ['Visit Jersey events', 'https://www.jersey.com/things-to-do/events'],
    ['Vibrant Jersey calendar', 'https://www.vibrantjersey.je/event-calendar/'],
    ['Jersey Arts Centre', 'https://artscentre.je/'],
    ['Jersey Opera House', 'https://www.jerseyoperahouse.co.uk/events/'],
  ],
  services: [
    [
      'Pharmacy opening hours',
      'https://www.gov.je/Health/DoctorDentist/PharmacistsChemists/pages/pharmacyopeninghours.aspx',
    ],
    ['Parish refuse and recycling', 'https://comite.je/jerseys-12-parishes/'],
    [
      'Jersey air quality',
      'https://www.gov.je/Environment/Air/Pages/AirQuality.aspx',
    ],
    [
      'Public mapping gallery',
      'https://www.gov.je/PlanningBuilding/JerseyMappingService/Pages/Digital.aspx',
    ],
    ['Jersey Water notices', 'https://www.jerseywater.je/'],
    [
      'Jersey Electricity notices',
      'https://www.jec.co.uk/for-home/help/powercuts/powercut-advice/',
    ],
    ['Airport arrivals', 'https://m.gov.je/airport/arrivals/'],
    [
      'Ferries and harbour movements',
      'https://www.ports.je/jerseyharbours/arrivals-departures/',
    ],
    ['LibertyBus diversions', 'https://libertybus.je/'],
  ],
};

/** Great-circle distance in metres, including across the antimeridian. */
export function jerseyNearbyDistance(a, b) {
  const r = Math.PI / 180,
    h =
      Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
      Math.cos(a.lat * r) *
        Math.cos(b.lat * r) *
        Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

/** Refuse stale, flagged or non-finite buoy observations. */
export function currentBuoyValue(value, now = Date.now()) {
  if (
    !value ||
    value.alert ||
    !Number.isFinite(value.value) ||
    !Number.isFinite(value.timestamp)
  )
    return null;
  const age = now / 1000 - value.timestamp;
  return age >= -120 && age <= Math.min(Number(value.timeout) || 900, 1800)
    ? `${value.text || value.value} ${value.units || ''}`
    : null;
}

const clean = (value) =>
  String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .slice(0, 2000);
const escape = (value) =>
  clean(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const inArea = (point) =>
  point &&
  point.lat >= 49.05 &&
  point.lat <= 49.3 &&
  point.lon >= -2.3 &&
  point.lon <= -2;
const date = (value) =>
  /^\d{8}/.test(value || '')
    ? `${value.slice(6, 8)}/${value.slice(4, 6)}/${value.slice(0, 4)} ${value.slice(9, 11)}:${value.slice(11, 13)}`
    : clean(value);

/** Add opt-in Jersey overlays and cards to an existing Nearby sheet. */
export function installJerseyNearby({
  panel,
  before,
  app,
  getArea,
  setLocation,
  open,
  fetchImpl = fetch,
}) {
  const C = Cesium,
    controls = new Map(),
    data = new Map(),
    pending = new Map(),
    sources = new Map();
  const box = document.createElement('div');
  box.id = 'gev-jersey-nearby';
  const intro = document.createElement('p');
  intro.textContent =
    'Jersey · island-wide public sources. Choose only what you need.';
  const selector = document.createElement('select');
  selector.setAttribute('aria-label', 'Jersey parish or whole island');
  selector.add(new Option('Your location / chosen area', ''));
  selector.add(new Option('All Jersey · all 12 parishes', 'all'));
  for (const [name] of PARISHES) selector.add(new Option(name, name));
  selector.style.cssText = 'width:100%;margin:8px 0';
  selector.addEventListener('change', () => {
    if (!selector.value) return;
    const choice = PARISHES.find((item) => item[0] === selector.value);
    setLocation(
      choice
        ? { lat: choice[1], lon: choice[2] }
        : { lat: 49.214, lon: -2.135 },
      choice ? 5000 : 50000,
    );
    update();
  });
  const details = document.createElement('div');
  details.id = 'gev-jersey-selection';
  details.hidden = true;
  details.setAttribute('role', 'status');
  const summary = document.createElement('div');
  summary.id = 'gev-jersey-cards';
  box.append(intro, selector, details);
  const extra = document.createElement('details');
  const extraTitle = document.createElement('summary');
  extraTitle.textContent =
    'More Jersey options · facilities, parish notices, offers';
  extraTitle.style.cssText = 'padding:14px 0;cursor:pointer';
  extra.append(extraTitle);
  for (const [index, [id, name, color, hint]] of FEATURES.entries()) {
    const row = document.createElement('div');
    row.className = 'gev-nearby-layer';
    const label = document.createElement('div');
    label.textContent = name;
    const note = document.createElement('small');
    note.textContent = hint;
    label.append(note);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'OFF';
    button.setAttribute('aria-label', name);
    button.setAttribute('aria-pressed', 'false');
    const control = {
      enabled: false,
      generation: 0,
      note,
      button,
      hint,
      color,
      name,
      visible: [],
    };
    controls.set(id, control);
    button.addEventListener('click', () => {
      control.enabled = !control.enabled;
      control.generation++;
      button.textContent = control.enabled ? 'ON' : 'OFF';
      button.setAttribute('aria-pressed', String(control.enabled));
      if (!control.enabled) {
        sources.get(id)?.entities.removeAll();
        clearOverlaySource('jersey-nearby-' + id);
        note.textContent = hint;
      } else refresh(id);
      renderCards();
      app.requestRender?.('jersey-nearby');
    });
    row.append(label, button);
    (index < 4 ? box : extra).append(row);
  }
  box.append(extra, summary);
  panel.insertBefore(box, before);
  const read = async (type) => {
    const old = data.get(type),
      ttl = ['spaces', 'departures'].includes(type)
        ? 60000
        : ['forecast', 'marine', 'buoy'].includes(type)
          ? 300000
          : type === 'roadworks'
            ? 900000
            : 3600000;
    if (old && Date.now() - old.fetchedAt < ttl) return old;
    if (pending.has(type)) return pending.get(type);
    const promise = (async () => {
      const response = await fetchImpl(
        '/api/transit/jersey-local?type=' + type,
        { signal: AbortSignal.timeout(20000) },
      );
      if (!response.ok) throw new Error('Unavailable');
      const body = await response.json();
      if (body.type !== type) throw new Error('Invalid feed');
      data.set(type, body);
      return body;
    })();
    pending.set(type, promise);
    try {
      return await promise;
    } finally {
      pending.delete(type);
    }
  };
  const sourceFor = (id) => {
    if (!sources.has(id)) {
      const source = new C.CustomDataSource('Jersey ' + id);
      sources.set(id, source);
      app.viewer.dataSources.add(source);
    }
    return sources.get(id);
  };
  const describe = (id, row) => {
    if (id === 'parking' || id === 'charging') {
      const live = data
        .get('spaces')
        ?.results?.find((item) => item.code === row.liveTrackingCode);
      const recent = live && Date.now() - data.get('spaces').fetchedAt < 120000;
      return [
        recent
          ? `${live.open ? live.spaces + ' spaces available' : 'Closed'} (updated ${new Date(data.get('spaces').fetchedAt).toLocaleTimeString()})`
          : 'Live availability not provided',
        `${row.spaces ?? '?'} total bays · ${row.disabledSpaces ?? '?'} disabled · ${row.electricChargingSpaces ?? '?'} charging`,
        row.payByPhoneCode ? 'PayByPhone ' + row.payByPhoneCode : '',
        clean(row.notes),
      ]
        .filter(Boolean)
        .join(' · ');
    }
    if (id === 'eatsafe')
      return `Eat Safe ${row.rating}/5 · inspected ${clean(row.createdAt)} · ${[row.address1, row.address2, row.postCode].filter(Boolean).map(clean).join(', ')}`;
    if (id === 'roadworks')
      return `${row.status} · ${date(row.start)} to ${date(row.end)} · ${row.description}`;
    return [
      row.parish,
      ...(row.facilities || row.services || []).map((value) =>
        value.replaceAll('_', ' ').toLowerCase(),
      ),
      row.notes,
      row.streetName,
    ]
      .filter(Boolean)
      .map(clean)
      .join(' · ');
  };
  function draw(id) {
    const control = controls.get(id),
      source = sourceFor(id);
    source.entities.removeAll();
    clearOverlaySource('jersey-nearby-' + id);
    control.visible = [];
    const area = getArea();
    if (!control.enabled || !inArea(area?.anchor)) return;
    const type = id === 'charging' ? 'parking' : id,
      rows = data.get(type)?.results;
    if (!Array.isArray(rows)) return;
    const nearby = rows
      .filter((row) => id !== 'charging' || row.electricChargingSpaces > 0)
      .map((row) => ({
        ...row,
        distance: jerseyNearbyDistance(area.anchor, {
          lat: row.latitude,
          lon: row.longitude,
        }),
      }))
      .filter((row) => row.distance <= area.radius)
      .sort((a, b) => a.distance - b.distance);
    control.visible = nearby;
    const labels = [];
    for (const row of nearby.slice(0, 500)) {
      const name = clean(row.name || row.location),
        text = describe(id, row);
      const entity = source.entities.add({
        id: `jersey-${id}-${row.id || name}`,
        name,
        position: C.Cartesian3.fromDegrees(row.longitude, row.latitude, 2),
        description: `<p>${escape(text)}</p>`,
        point: {
          pixelSize: id === 'roadworks' ? 13 : 10,
          color: C.Color.fromCssColorString(control.color),
          outlineColor: C.Color.BLACK,
          outlineWidth: 2,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Infinity,
        },
      });
      entity._gevJerseyRecord = { name, text };
      if (labels.length < 128)
        labels.push({
          id: entity.id,
          position: C.Cartesian3.fromDegrees(row.longitude, row.latitude, 3),
          title: id === 'eatsafe' ? row.rating + '/5 · ' + name : name,
          variant: 'label',
          accent: control.color,
          interactive: false,
          collisionGroup: 'ambient-label',
          maxDistance: 1800,
          priority: 128 - labels.length,
        });
      for (const [index, path] of (row.paths || []).entries())
        source.entities.add({
          id: `jersey-roadline-${row.id}-${index}`,
          polyline: {
            positions: C.Cartesian3.fromDegreesArray(path.flat()),
            width: 5,
            material: C.Color.fromCssColorString(control.color),
            clampToGround: true,
          },
        });
    }
    setOverlayEntries('jersey-nearby-' + id, labels, {
      cohortLimit: 128,
      collisionCapacity: 24,
      moving: false,
    });
    const missing =
      id === 'eatsafe' ? ' · entries without coordinates omitted' : '';
    control.note.textContent = `${nearby.length} within ${area.radius / 1000} km${nearby.length > 500 ? ' · nearest 500 on map' : ''}${missing}`;
    app.requestRender?.('jersey-nearby');
  }
  async function refresh(id) {
    const control = controls.get(id),
      area = getArea();
    if (!control.enabled || document.hidden) return;
    if (!inArea(area?.anchor)) {
      control.note.textContent = 'Jersey source · choose a Jersey location';
      sources.get(id)?.entities.removeAll();
      clearOverlaySource('jersey-nearby-' + id);
      return;
    }
    if (LINKS[id]) {
      control.note.textContent = control.hint;
      renderCards();
      return;
    }
    const token = control.generation;
    control.note.textContent = 'Loading…';
    try {
      const type =
        id === 'tides' ? 'marine' : id === 'charging' ? 'parking' : id;
      await read(type);
      if (id === 'parking') {
        try {
          await read('spaces');
        } catch {
          /* Facilities remain useful without live occupancy. */
        }
      }
      if (!control.enabled || token !== control.generation) return;
      if (['forecast', 'tides', 'marine', 'buoy', 'parish-news'].includes(id))
        control.note.textContent =
          'Published data · checked ' +
          new Date(data.get(type).fetchedAt).toLocaleTimeString();
      else draw(id);
      renderCards();
    } catch {
      if (control.enabled && token === control.generation) {
        control.note.textContent = 'Feed unavailable · retrying shortly';
        sources.get(id)?.entities.removeAll();
        clearOverlaySource('jersey-nearby-' + id);
        data.delete(id === 'tides' ? 'marine' : id);
        renderCards();
        app.requestRender?.('jersey-nearby');
      }
    }
  }
  function card(title, lines, sourceUrl, sourceName) {
    const el = document.createElement('article');
    el.style.cssText = 'padding:12px 0;border-top:1px solid #396270';
    const heading = document.createElement('strong');
    heading.textContent = title;
    el.append(heading);
    for (const line of lines.filter(Boolean)) {
      const p = document.createElement('p');
      p.style.margin = '6px 0';
      p.textContent = clean(line);
      el.append(p);
    }
    if (sourceUrl) {
      const a = document.createElement('a');
      a.href = sourceUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = sourceName || 'Source';
      el.append(a);
    }
    summary.append(el);
    return el;
  }
  function renderCards() {
    summary.replaceChildren();
    if (!inArea(getArea()?.anchor)) return;
    for (const [id, control] of controls) {
      if (!control.enabled) continue;
      if (LINKS[id]) {
        for (const [name, url] of LINKS[id])
          card(name, [], url, 'Open provider listing');
        if (id === 'services')
          for (const [name, , , domain] of PARISHES)
            card(
              name + ' parish services',
              [],
              'https://' + domain + '/',
              'Open official parish website',
            );
        continue;
      }
      if (id === 'parish-news') {
        const body = data.get(id);
        if (!body) continue;
        const rows = body.results.filter(
          (row) =>
            !selector.value ||
            selector.value === 'all' ||
            row.parish === selector.value,
        );
        if (body.unavailable.length)
          card(
            'Some parish feeds are unavailable',
            [body.unavailable.join(', ')],
            body.sourceUrl,
            body.source,
          );
        if (!rows.length)
          card(
            'Parish notices',
            ['No headlines currently reported for this parish.'],
            body.sourceUrl,
            body.source,
          );
        for (const row of rows.slice(0, 12))
          card(
            row.parish + ' · ' + row.title,
            [new Date(row.publishedAt).toLocaleDateString()],
            row.url,
            'Read on parish website',
          );
      } else if (id === 'forecast') {
        const body = data.get('forecast');
        if (!body) continue;
        const forecast = body.results;
        card(
          'Jersey weather',
          [
            `${forecast.forecastDate} · issued ${forecast.issuetime} · current ${forecast.currentTemprature}`,
            ...forecast.forecastDay
              .slice(0, 3)
              .map(
                (day) =>
                  `${day.dayName}: ${day.summary} ${day.minTemp}–${day.maxTemp} · ${day.windDirection} ${day.windSpeedMPH} mph · rain ${day.rainProbMorning}/${day.rainProbAfternoon}/${day.rainProbEvening}% · UV ${day.uvIndex}`,
              ),
          ],
          body.sourceUrl,
          body.source,
        );
      } else if (id === 'tides') {
        const body = data.get('marine');
        if (!body) continue;
        const t = body.results.CurrentTide;
        card(
          'St Helier tides & coastal access',
          [
            t.firstTideDescription,
            t.secondTideDescription,
            `Published ${body.results.TimeStamp}`,
            `St Helier marina: ${t.marinaStatus} · change ${t.marinaTime}`,
            `Elizabeth marina: ${t.ElizabethMarinaStatus} · change ${t.ElizabethMarinaTime}`,
            `St Aubin causeway: ${t.StAubinsStatus} · change ${t.StAubinsTime}`,
            `Corbière causeway: ${t.CorbiereStatus} · change ${t.CorbiereTime}`,
            'Predictions are a guide. Check the official source and conditions before crossing.',
          ],
          body.sourceUrl,
          body.source,
        );
      } else if (id === 'marine') {
        const body = data.get('marine');
        if (!body) continue;
        const f = body.results.ShippingForecast;
        card(
          'Channel Islands shipping forecast',
          [
            f.From,
            f.forecastTimeToday,
            f.winddescToday,
            f.seastateToday,
            f.weatherToday,
            f.visibilityToday,
          ],
          body.sourceUrl,
          body.source,
        );
      } else if (id === 'buoy') {
        const body = data.get('buoy');
        if (!body) continue;
        const site = body.results.latest['171'];
        const lines = [];
        for (const [group, key, label] of [
          ['met', 'wind_speed', 'Wind'],
          ['met', 'gust_speed', 'Gust'],
          ['met', 'wind_direction', 'Direction'],
          ['met', 'atmos_pressure', 'Pressure'],
          ['waves', 'wave_height_sig', 'Significant wave height'],
          ['waves', 'wave_period_peak', 'Wave period'],
        ]) {
          const value = site?.[group]?.[key],
            text = currentBuoyValue(value);
          if (text)
            lines.push(
              `${label}: ${text} · ${new Date(value.timestamp * 1000).toLocaleTimeString()}`,
            );
        }
        card(
          'Jersey offshore buoy',
          lines.length
            ? lines
            : ['No current valid observations; expired readings omitted.'],
          body.sourceUrl,
          body.source,
        );
      } else {
        const type = id === 'charging' ? 'parking' : id,
          body = data.get(type);
        if (!body) continue;
        const rows = control.visible.slice(0, 5);
        card(
          control.name + ' · nearest results',
          rows.map(
            (row) =>
              `${clean(row.name || row.location)} · ${(row.distance / 1000).toFixed(1)} km · ${describe(id, row)}`,
          ),
          body.sourceUrl,
          body.source,
        );
      }
    }
  }
  const pick = new C.ScreenSpaceEventHandler(app.viewer.canvas);
  let selectionGeneration = 0;
  pick.setInputAction(async (event) => {
    const entity = app.viewer.scene.pick(event.position)?.id;
    if (!entity) return;
    const stop = entity._gevJerseyStop;
    if (!entity._gevJerseyRecord && !stop) return;
    const token = ++selectionGeneration;
    details.hidden = false;
    details.replaceChildren();
    open('gev-mobile-nearby');
    const heading = document.createElement('strong');
    heading.textContent = entity.name;
    details.append(heading);
    const p = document.createElement('p');
    p.textContent = entity._gevJerseyRecord?.text || 'Loading next departures…';
    details.append(p);
    if (stop) {
      try {
        const response = await fetchImpl(
          '/api/transit/jersey-local?type=departures&stop=' +
            encodeURIComponent(stop),
          { signal: AbortSignal.timeout(20000) },
        );
        if (!response.ok) throw new Error('Unavailable');
        const body = await response.json();
        if (token !== selectionGeneration) return;
        p.textContent = body.results.departures.length
          ? body.results.departures
              .slice(0, 8)
              .map(
                (item) =>
                  `Bus ${item.serviceNumber} to ${item.destination} · ${new Date(item.eta).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
              )
              .join('\n')
          : 'No departures currently reported for this stop.';
        p.style.whiteSpace = 'pre-line';
      } catch {
        if (token === selectionGeneration)
          p.textContent =
            'Departure feed unavailable. Check LibertyBus for this stop.';
      }
    }
  }, C.ScreenSpaceEventType.LEFT_CLICK);
  const update = () => {
    for (const [id, control] of controls)
      if (control.enabled) {
        if (
          !['forecast', 'tides', 'marine', 'buoy', 'parish-news'].includes(
            id,
          ) &&
          !LINKS[id]
        )
          draw(id);
        refresh(id);
      }
    renderCards();
  };
  const timer = setInterval(() => {
    if (!document.hidden) update();
  }, 60000);
  const visibility = () => {
    if (!document.hidden) update();
  };
  document.addEventListener('visibilitychange', visibility);
  (
    app.viewer.cesiumWidget.creditDisplay ||
    app.viewer.scene.frameState?.creditDisplay
  )?.addStaticCredit(
    new C.Credit(
      'Jersey: <a href="https://opendata.je/">OpenData.je</a> · <a href="https://www.gov.je/">Government of Jersey</a> · <a href="https://www.ports.je/">Ports of Jersey</a>',
      true,
    ),
  );
  return {
    update,
    destroy() {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
      pick.destroy();
      for (const [id, source] of sources) {
        clearOverlaySource('jersey-nearby-' + id);
        app.viewer.dataSources.remove(source, true);
      }
      box.remove();
    },
  };
}
