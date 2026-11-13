import { aircraftTypeCardModel } from '../layers/flights/typeCard.js';
import { formatNumber, msg, t } from '../i18n/index.js';
import { roundHeadingDegrees } from '../data/headingDegrees.js';

/**
 * @module aircraftTypeCard
 * @description HTML card for the selected aircraft: a licensed photo and the
 * specs of its TYPE, plus live telemetry, in the faction accent (cyan civil,
 * amber military). It shows while a flight layer tracks an aircraft and hides
 * when tracking clears.
 */

const LAYER_IDS = new Set(['flights', 'military']);
const FT_PER_M = 3.28084;
const KT_PER_MS = 1.944;
const REFRESH_MS = 1000;
const GAP_PX = 12;
const STYLE_ID = 'gev-aircraft-type-card-style';

const CLASS_LABELS = Object.freeze({
  light: msg('Light aircraft'),
  turboprop: msg('Turboprop'),
  bizjet: msg('Business jet'),
  airliner: msg('Airliner'),
  widebody: msg('Widebody airliner'),
  quadjet: msg('Four-engine airliner'),
  fastjet: msg('Fast jet'),
  helicopter: msg('Helicopter'),
  uav: msg('Unmanned aircraft'),
});

const ENGINE_LABELS = Object.freeze({
  jet: msg('Jet'),
  turbine: msg('Turbine'),
  piston: msg('Piston'),
});

const STYLE = `
.gev-type-card { --acc: #00ffff; position: fixed; top: 64px; right: 16px; z-index: 88; width: 320px;
  max-width: calc(100vw - 32px); color: #d8f6ff; font-size: 12px; background: rgba(4, 14, 22, 0.88);
  border: 1px solid color-mix(in srgb, var(--acc) 55%, transparent);
  box-shadow: 0 0 24px color-mix(in srgb, var(--acc) 25%, transparent), inset 0 0 30px color-mix(in srgb, var(--acc) 8%, transparent);
  clip-path: polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 18px 100%, 0 calc(100% - 18px));
  backdrop-filter: blur(3px); }
.gev-type-card[hidden] { display: none; }
.gev-type-card.is-military { --acc: #ffb800; }
.gev-type-card header { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px;
  font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--acc);
  border-bottom: 1px solid color-mix(in srgb, var(--acc) 35%, transparent); }
.gev-type-card .dot { display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%;
  background: var(--acc); box-shadow: 0 0 8px var(--acc); animation: gev-type-card-blink 1.2s infinite; }
@keyframes gev-type-card-blink { 50% { opacity: 0.25; } }
.gev-type-card .photo { position: relative; margin: 10px 12px 0; aspect-ratio: 16 / 8; overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--acc) 40%, transparent); }
.gev-type-card .photo img { display: block; width: 100%; height: 100%; object-fit: cover; filter: saturate(0.85) contrast(1.05); }
.gev-type-card .photo::after { content: ''; position: absolute; inset: 0; pointer-events: none;
  background: repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.18) 0 1px, transparent 1px 3px); }
.gev-type-card .credit { margin: 3px 12px 0; font-size: 9px; line-height: 1.3; color: #7fa9b8; }
.gev-type-card .credit a { color: #99ffdd; }
.gev-type-card h2 { margin: 8px 12px 0; font-size: 17px; font-weight: 600; letter-spacing: 0.02em; color: #fff;
  text-shadow: 0 0 10px color-mix(in srgb, var(--acc) 60%, transparent); }
.gev-type-card .cls { margin: 2px 12px 0; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--acc); }
.gev-type-card dl { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; margin: 10px 12px 12px; }
.gev-type-card dt { font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase; color: #7fa9b8; }
.gev-type-card dd { margin: 0; font-size: 14px; color: #eaffff; }
.gev-type-card .wide { grid-column: 1 / -1; }
.gev-type-card footer { padding: 6px 12px; font-size: 9px; color: #5f8b99;
  border-top: 1px solid color-mix(in srgb, var(--acc) 25%, transparent); }
`;

const DASH = '--';

function el(documentRef, tag, className, text) {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const whole = (value) => formatNumber(Math.round(value), { useGrouping: true });

/** Flat label/value pairs for the specs and telemetry grids. Pure over the model. */
export function aircraftTypeCardFields(model) {
  const { telemetry, identity, specs, type } = model;
  const orDash = (value, format) =>
    value === null || value === undefined ? DASH : format(value);
  const telemetryRows = [
    {
      key: 'callsign',
      label: t('Callsign'),
      value: identity.callsign ?? identity.registration ?? DASH,
    },
    {
      key: 'typeCode',
      label: t('Type code'),
      value: identity.typeCode ?? DASH,
    },
    {
      key: 'altitude',
      label: t('Altitude'),
      value: orDash(telemetry.altitudeM, (m) =>
        t('{value} ft', { value: whole(m * FT_PER_M) }),
      ),
    },
    {
      key: 'speed',
      label: t('Speed'),
      value: orDash(telemetry.speedMs, (ms) =>
        t('{value} kt', { value: whole(ms * KT_PER_MS) }),
      ),
    },
    {
      key: 'heading',
      label: t('Heading'),
      value: orDash(telemetry.headingDeg, (deg) =>
        t('{value}°', { value: roundHeadingDegrees(deg) }),
      ),
    },
    {
      key: 'position',
      label: t('Position'),
      value:
        telemetry.lat === null || telemetry.lon === null
          ? DASH
          : `${telemetry.lat.toFixed(3)}, ${telemetry.lon.toFixed(3)}`,
    },
  ];
  if (telemetry.origin || telemetry.destination)
    telemetryRows.push({
      key: 'route',
      label: t('Route'),
      value: `${telemetry.origin ?? DASH} → ${telemetry.destination ?? DASH}`,
      wide: true,
    });

  const specRows = [];
  if (type?.manufacturer)
    specRows.push({
      key: 'manufacturer',
      label: t('Manufacturer'),
      value: type.manufacturer,
      wide: true,
    });
  if (specs) {
    if (specs.lengthM !== null)
      specRows.push({
        key: 'length',
        label: t('Length'),
        value: t('{value} m', { value: formatNumber(specs.lengthM) }),
      });
    if (specs.spanM !== null)
      specRows.push({
        key: 'span',
        label: t('Wingspan'),
        value: t('{value} m', { value: formatNumber(specs.spanM) }),
      });
    if (specs.engines !== null)
      specRows.push({
        key: 'engines',
        label: t('Engines'),
        value: specs.engineType
          ? t('{count} × {type}', {
              count: specs.engines,
              type: ENGINE_LABELS[specs.engineType]
                ? t(ENGINE_LABELS[specs.engineType])
                : specs.engineType,
            })
          : String(specs.engines),
      });
    if (specs.firstFlightYear !== null)
      specRows.push({
        key: 'firstFlight',
        label: t('First flight'),
        value: String(specs.firstFlightYear),
      });
  }
  return { specRows, telemetryRows };
}

function classLine(model) {
  const faction = model.faction === 'military' ? t('Military') : t('Civil');
  const label = CLASS_LABELS[model.type?.class];
  return label ? `${faction} · ${t(label)}` : faction;
}

function creditNode(documentRef, photo) {
  const credit = el(documentRef, 'div', 'credit');
  const author = photo.author ?? t('Unknown author');
  const authorNode = photo.sourceUrl
    ? Object.assign(el(documentRef, 'a', '', author), {
        href: photo.sourceUrl,
        target: '_blank',
        rel: 'noopener noreferrer',
      })
    : documentRef.createTextNode(author);
  credit.append(documentRef.createTextNode(`${t('Photo')}: `), authorNode);
  if (photo.licence) {
    credit.append(documentRef.createTextNode(' · '));
    credit.append(
      photo.licenceUrl
        ? Object.assign(el(documentRef, 'a', '', photo.licence), {
            href: photo.licenceUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
          })
        : documentRef.createTextNode(photo.licence),
    );
  }
  if (photo.cropped)
    credit.append(documentRef.createTextNode(` · ${t('cropped')}`));
  return credit;
}

function gridNodes(documentRef, rows, valueNodes) {
  return rows.map((row) => {
    const cell = el(documentRef, 'div', row.wide ? 'wide' : '');
    const value = el(documentRef, 'dd', '', row.value);
    valueNodes?.set(row.key, value);
    cell.append(el(documentRef, 'dt', '', row.label), value);
    return cell;
  });
}

/**
 * Mount the card. `getTracked` returns the tracked contact's descriptor, with
 * a `military` flag, or null when nothing is tracked.
 * @param {object} options
 * @param {() => object|null} options.getTracked
 * @param {(url: string) => string} [options.resolveAsset] Public-file URL resolver.
 * @returns {{destroy: () => void}}
 */
export function createAircraftTypeCard({
  getTracked,
  resolveAsset = (url) => url,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
}) {
  if (!documentRef?.body || !windowRef) return { destroy() {} };

  if (!documentRef.getElementById(STYLE_ID)) {
    const style = el(documentRef, 'style');
    style.id = STYLE_ID;
    style.textContent = STYLE;
    documentRef.head.append(style);
  }

  const host = el(documentRef, 'aside', 'gev-type-card');
  host.hidden = true;
  host.dataset.aircraftTypeCard = '';
  documentRef.body.append(host);

  let timer = null;
  let renderedKey = null;
  let telemetryNodes = new Map();

  function keepClearOfRightPanels() {
    const stack = documentRef.getElementById('right-panel-stack');
    const rect = stack?.getBoundingClientRect?.();
    const visible = rect && rect.width > 0 && rect.height > 0;
    host.style.right = `${visible ? Math.max(16, windowRef.innerWidth - rect.left + GAP_PX) : 16}px`;
  }

  function build(model) {
    const { specRows, telemetryRows } = aircraftTypeCardFields(model);
    host.replaceChildren();
    host.classList.toggle('is-military', model.faction === 'military');

    const header = el(documentRef, 'header');
    const title = el(documentRef, 'span');
    title.append(
      el(documentRef, 'span', 'dot'),
      documentRef.createTextNode(t('Selected aircraft')),
    );
    header.append(
      title,
      el(documentRef, 'span', '', model.identity.icao24?.toUpperCase() ?? ''),
    );
    host.append(header);

    if (model.photo) {
      const photo = el(documentRef, 'div', 'photo');
      const image = el(documentRef, 'img');
      image.alt = model.type.name;
      image.loading = 'lazy';
      image.src = resolveAsset(model.photo.path);
      photo.append(image);
      host.append(photo, creditNode(documentRef, model.photo));
    }

    host.append(
      el(
        documentRef,
        'h2',
        '',
        model.type?.name ??
          model.identity.typeCode ??
          t('Unidentified aircraft'),
      ),
      el(documentRef, 'div', 'cls', classLine(model)),
    );

    const grid = el(documentRef, 'dl');
    telemetryNodes = new Map();
    grid.append(
      ...gridNodes(documentRef, specRows),
      ...gridNodes(documentRef, telemetryRows, telemetryNodes),
    );
    host.append(grid);

    host.append(
      el(
        documentRef,
        'footer',
        '',
        model.type
          ? t('Photo shows the aircraft type, not the tracked airframe.')
          : t('This aircraft type is not in the type library yet.'),
      ),
    );
  }

  function refresh() {
    const info = getTracked();
    if (!info) {
      hide();
      return;
    }
    const model = aircraftTypeCardModel(info, {
      isMilitary: info.military === true,
    });
    const key = `${model.faction}|${model.identity.icao24}|${model.identity.typeCode}`;
    if (key !== renderedKey) {
      build(model);
      renderedKey = key;
    } else {
      for (const row of aircraftTypeCardFields(model).telemetryRows) {
        const node = telemetryNodes.get(row.key);
        if (node && node.textContent !== row.value)
          node.textContent = row.value;
      }
    }
    keepClearOfRightPanels();
    host.hidden = false;
  }

  function show() {
    refresh();
    if (!timer && !host.hidden)
      timer = windowRef.setInterval(refresh, REFRESH_MS);
  }

  function hide() {
    if (timer) windowRef.clearInterval(timer);
    timer = null;
    renderedKey = null;
    host.hidden = true;
    host.replaceChildren();
  }

  const onSelected = (event) => {
    if (LAYER_IDS.has(event.detail?.layerId)) show();
  };
  const onCleared = (event) => {
    if (LAYER_IDS.has(event.detail?.layerId)) hide();
  };
  windowRef.addEventListener('gev:awareness-subject-selected', onSelected);
  windowRef.addEventListener('gev:awareness-subject-cleared', onCleared);

  return {
    destroy() {
      windowRef.removeEventListener(
        'gev:awareness-subject-selected',
        onSelected,
      );
      windowRef.removeEventListener('gev:awareness-subject-cleared', onCleared);
      hide();
      host.remove();
    },
  };
}
