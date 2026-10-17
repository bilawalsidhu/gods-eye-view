// Context inspector: renders the selected entity, event, camera or place
// with its provenance. Only fields present on the record are shown; nothing
// is inferred. Measured, provider-reported, model and analyst statements are
// visually distinct (see .oryn-field[data-provenance]).
import { t } from '../../i18n/index.js';
import {
  el,
  button,
  chip,
  field,
  emptyState,
  replaceChildren,
  formatCoordinate,
} from './dom.js';
import {
  formatAge,
  formatTimestamp,
  provenanceLabel,
  feedStateDescription,
} from './provenance.js';

const FIELD_LABELS = Object.freeze({
  magnitude: () => t('Magnitude'),
  depthKm: () => t('Depth (km)'),
  frp: () => t('Fire radiative power (MW)'),
  confidence: () => t('Detection confidence'),
  sensor: () => t('Sensor'),
  acres: () => t('Acres'),
  containedPct: () => t('Contained (%)'),
  state: () => t('State'),
  cause: () => t('Cause'),
  classification: () => t('Classification'),
  basin: () => t('Basin'),
  windKt: () => t('Wind (kt)'),
  pressureHpa: () => t('Pressure (hPa)'),
  mmsi: () => t('MMSI'),
  callsign: () => t('Callsign'),
  registration: () => t('Registration'),
  operator: () => t('Operator'),
  type: () => t('Type'),
  altitude: () => t('Altitude'),
  speed: () => t('Speed'),
  speedKt: () => t('Speed (kt)'),
  course: () => t('Course'),
  heading: () => t('Heading'),
  destination: () => t('Destination'),
  route: () => t('Route'),
  icao24: () => t('ICAO 24-bit address'),
  status: () => t('Status'),
  name: () => t('Name'),
  aqi: () => t('Air quality index'),
  pollutant: () => t('Pollutant'),
  level: () => t('Level'),
});

function fieldLabel(key) {
  const known = FIELD_LABELS[key];
  if (known) return known();
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

function kindLabel(kind) {
  switch (kind) {
    case 'aircraft':
      return t('Aircraft');
    case 'vessel':
      return t('Vessel');
    case 'satellite':
      return t('Satellite');
    case 'camera':
      return t('Camera');
    case 'earthquake':
      return t('Earthquake');
    case 'fire-detection':
      return t('Fire detection');
    case 'fire-perimeter':
      return t('Fire perimeter');
    case 'cyclone':
      return t('Tropical cyclone');
    case 'place':
      return t('Place');
    case 'installation':
      return t('Installation');
    default:
      return t('Entity');
  }
}

/**
 * @param {{engine:()=>object|null, workspace:object, onAddToInvestigation:Function, onAddNote:Function, onOpenCamera:Function}} deps
 */
export function createInspector(deps) {
  const root = document.getElementById('oryn-inspector');
  const body = document.getElementById('oryn-inspector-body');
  const closeButton = document.getElementById('oryn-inspector-close');
  let current = null;

  function setOpen(open) {
    root.hidden = !open;
    document.body.dataset.orynInspector = open ? 'open' : 'closed';
  }

  closeButton.replaceChildren();
  closeButton.append(
    button({ iconName: 'close', className: 'oryn-btn-ghost oryn-btn-icon' })
      .firstChild,
  );
  closeButton.addEventListener('click', () => setOpen(false));

  function provenanceLegend() {
    const items = [
      ['measured', 'var(--oryn-ok)'],
      ['provider', 'var(--oryn-accent)'],
      ['model', '#d8b4fe'],
      ['analyst', 'var(--oryn-warn)'],
      ['unverified', 'var(--oryn-text-3)'],
    ];
    return el(
      'div',
      { className: 'oryn-provenance-legend' },
      items.map(([kind, swatch]) => {
        const node = el('span', { text: provenanceLabel(kind) });
        node.style.setProperty('--swatch', swatch);
        return node;
      }),
    );
  }

  function renderRef(ref) {
    const engine = deps.engine();
    const feed = ref.layerId ? engine?.feedsById().get(ref.layerId) : null;
    const notes = deps.workspace.notesFor(ref);
    const sections = [];

    sections.push(
      el(
        'div',
        { className: 'oryn-entity-head' },
        el('h3', { className: 'oryn-entity-title', text: ref.label || ref.id }),
        el(
          'div',
          { className: 'oryn-entity-sub' },
          chip(kindLabel(ref.kind), 'neutral'),
          feed
            ? chip(feed.label, feed.state, {
                title: feedStateDescription(feed.state),
              })
            : null,
          ref.demo ? chip(t('DEMO'), 'demo') : null,
        ),
      ),
    );

    const facts = [];
    facts.push(field(t('Identifier'), ref.id, { provenance: 'provider' }));
    if (ref.position)
      facts.push(
        field(
          t('Coordinates'),
          formatCoordinate(ref.position.lat, ref.position.lon),
          {
            provenance: ref.kind === 'place' ? 'provider' : 'provider',
          },
        ),
      );
    if (Number.isFinite(ref.position?.height))
      facts.push(
        field(t('Altitude (m)'), String(Math.round(ref.position.height)), {
          provenance: 'provider',
        }),
      );
    if (ref.source)
      facts.push(
        field(t('Source'), ref.source, {
          provenance: 'provider',
          mono: false,
          href: ref.sourceUrl || undefined,
        }),
      );
    if (ref.observedAt)
      facts.push(
        field(
          t('Observed'),
          `${formatTimestamp(ref.observedAt)} (${formatAge(ref.observedAt)})`,
          { provenance: 'provider' },
        ),
      );
    if (ref.retrievedAt)
      facts.push(
        field(
          t('Retrieved by ORYN'),
          `${formatTimestamp(ref.retrievedAt)} (${formatAge(ref.retrievedAt)})`,
          { provenance: 'measured' },
        ),
      );
    if (feed?.lastUpdate && !ref.retrievedAt)
      facts.push(
        field(t('Layer refreshed'), formatAge(feed.lastUpdate), {
          provenance: 'measured',
        }),
      );
    sections.push(
      el(
        'section',
        { className: 'oryn-section' },
        el('h4', {
          className: 'oryn-section-title',
          text: t('Identity and provenance'),
        }),
        facts,
      ),
    );

    const fieldEntries = Object.entries(ref.fields || {});
    if (fieldEntries.length)
      sections.push(
        el(
          'section',
          { className: 'oryn-section' },
          el('h4', {
            className: 'oryn-section-title',
            text: t('Reported values'),
          }),
          fieldEntries.map(([key, value]) =>
            field(
              fieldLabel(key),
              typeof value === 'number' ? String(value) : String(value),
              {
                provenance: ref.provenance || 'provider',
              },
            ),
          ),
        ),
      );

    if (feed) {
      const limitations = [];
      limitations.push(feedStateDescription(feed.state));
      if (feed.error) limitations.push(feed.error);
      limitations.push(
        t(
          'Public feeds refresh periodically. Values are reproduced as the provider reported them.',
        ),
      );
      sections.push(
        el(
          'section',
          { className: 'oryn-section' },
          el('h4', { className: 'oryn-section-title', text: t('Limitations') }),
          limitations.map((text) => el('p', { className: 'oryn-note', text })),
        ),
      );
    }

    sections.push(
      el(
        'section',
        { className: 'oryn-section' },
        el('h4', { className: 'oryn-section-title', text: t('Analyst notes') }),
        notes.length
          ? el(
              'ul',
              { className: 'oryn-list' },
              notes.map((note) =>
                el(
                  'li',
                  { className: 'oryn-list-item' },
                  el('span', { text: note.body }),
                  button({
                    iconName: 'trash',
                    className: 'oryn-btn-ghost oryn-btn-sm oryn-btn-icon',
                    title: t('Delete note'),
                    onClick: () => {
                      deps.workspace.deleteNote(note.id);
                      render();
                    },
                  }),
                  el('span', {
                    className: 'oryn-card-meta',
                    text: `${note.author} · ${formatTimestamp(note.createdAt)} · ${provenanceLabel('analyst')}`,
                  }),
                ),
              ),
            )
          : el('p', {
              className: 'oryn-note',
              text: t('No notes for this item yet.'),
            }),
        (() => {
          const textarea = el('textarea', {
            className: 'oryn-textarea',
            attrs: {
              placeholder: t('Add an analyst note (stored locally)'),
              rows: 2,
              maxlength: 8000,
            },
          });
          return el(
            'div',
            { className: 'oryn-form' },
            textarea,
            el(
              'div',
              { className: 'oryn-actions' },
              button({
                label: t('Save note'),
                iconName: 'edit',
                className: 'oryn-btn-sm',
                onClick: () => {
                  const text = textarea.value.trim();
                  if (!text) return;
                  deps.onAddNote(ref, text);
                  render();
                },
              }),
            ),
          );
        })(),
      ),
    );

    const actions = [];
    if (ref.position && engine)
      actions.push(
        button({
          label: t('Focus'),
          iconName: 'focus',
          className: 'oryn-btn-sm',
          onClick: () =>
            engine.flyTo({
              lat: ref.position.lat,
              lon: ref.position.lon,
              range: ref.kind === 'satellite' ? 4_000_000 : 6000,
            }),
        }),
      );
    actions.push(
      button({
        label: t('Add to investigation'),
        iconName: 'investigations',
        className: 'oryn-btn-sm',
        onClick: () => deps.onAddToInvestigation(ref),
      }),
    );
    if (ref.kind === 'camera' && deps.onOpenCamera)
      actions.push(
        button({
          label: t('Open in camera workspace'),
          iconName: 'cameras',
          className: 'oryn-btn-sm',
          onClick: () => deps.onOpenCamera(ref),
        }),
      );
    if (ref.sourceUrl)
      actions.push(
        el('a', {
          className: 'oryn-btn oryn-btn-sm',
          attrs: {
            href: ref.sourceUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
          },
          text: t('Open source record'),
        }),
      );
    sections.push(el('div', { className: 'oryn-actions' }, actions));
    sections.push(provenanceLegend());
    return sections;
  }

  function render() {
    if (!current) {
      replaceChildren(
        body,
        emptyState(
          t('Nothing selected'),
          t(
            'Select an aircraft, vessel, camera or event on the globe, or pick an item from the event queue.',
          ),
        ),
      );
      return;
    }
    replaceChildren(body, renderRef(current));
  }

  render();

  return Object.freeze({
    show(ref) {
      current = ref;
      render();
      setOpen(true);
    },
    update(ref) {
      if (ref === null && current && !current.pinned) {
        current = null;
        render();
        return;
      }
      if (ref) {
        current = ref;
        render();
        setOpen(true);
      }
    },
    refresh: render,
    toggle() {
      setOpen(root.hidden);
    },
    get isOpen() {
      return !root.hidden;
    },
    get current() {
      return current;
    },
    close: () => setOpen(false),
  });
}
