// Page renderers for the ORYN shell. Each renderer receives the shared
// context (see index.js) and returns a DOM node. Pages re-render on demand;
// they hold no state of their own beyond what the stores and engine report.
import { t } from '../../i18n/index.js';
import {
  el,
  button,
  chip,
  emptyState,
  replaceChildren,
  formatCoordinate,
} from './dom.js';
import {
  feedStateDescription,
  formatTimestamp,
  formatAge,
} from './provenance.js';
import { LAYER_GROUPS, GROUP_SWATCHES, groupForLayer } from './layerManager.js';
import { MODES, modeById } from './modes.js';
import { eventsCsv, downloadText, safeFileName } from './reports.js';
import { localizeLayerName } from '../layerNames.js';

function pageHead(title, subtitle, actions = []) {
  return el(
    'div',
    { className: 'oryn-page-head' },
    el(
      'div',
      {},
      el('h2', { text: title }),
      subtitle ? el('p', { text: subtitle }) : null,
    ),
    actions.length ? el('div', { className: 'oryn-actions' }, actions) : null,
  );
}

function stat(value, label) {
  return el(
    'div',
    { className: 'oryn-card oryn-stat' },
    el('span', { className: 'oryn-stat-value oryn-mono', text: String(value) }),
    el('span', { className: 'oryn-stat-label', text: label }),
  );
}

function feedRow(feed, ctx, { withToggle = true } = {}) {
  const engine = ctx.engine();
  const swatch = el('span', { attrs: { 'aria-hidden': 'true' } });
  swatch.style.setProperty('--swatch', GROUP_SWATCHES[groupForLayer(feed.id)]);
  const toggle =
    withToggle && engine
      ? el('button', {
          className: 'oryn-switch',
          attrs: {
            type: 'button',
            role: 'switch',
            'aria-checked': String(feed.enabled),
            'aria-label': t('Toggle {name}', { name: feed.name }),
          },
          on: {
            click: async (event) => {
              const node = event.currentTarget;
              node.setAttribute('aria-busy', 'true');
              try {
                await engine.setLayerEnabled(feed.id, !feed.enabled);
              } catch (error) {
                ctx.toast(error?.message || String(error));
              } finally {
                ctx.rerender();
              }
            },
          },
        })
      : null;
  return el(
    'li',
    { className: 'oryn-list-item' },
    el(
      'div',
      { className: 'oryn-layer-name' },
      swatch,
      el('span', { text: localizeLayerName(feed.name) }),
    ),
    toggle,
    el(
      'span',
      { className: 'oryn-card-meta' },
      [
        feed.label,
        feed.source,
        feed.enabled && feed.lastUpdate
          ? t('retrieved {age}', { age: feed.ageLabel })
          : null,
        feed.enabled ? t('{count} records', { count: feed.count }) : null,
        feed.error && feed.enabled ? feed.error : null,
      ]
        .filter(Boolean)
        .join(' · '),
    ),
  );
}

// ── Overview ─────────────────────────────────────────────────────────────

export function renderOverview(ctx) {
  const engine = ctx.engine();
  const feeds = engine
    ? engine.feeds().filter((feed) => feed.showInTogglePanel)
    : [];
  const enabled = feeds.filter((feed) => feed.enabled);
  const records = enabled.reduce((sum, feed) => sum + (feed.count || 0), 0);
  const investigations = ctx.workspace.investigations.list();
  const open = investigations.filter((inv) => inv.status !== 'closed');
  const scenes = ctx.workspace.scenes.list();
  const session = ctx.session.current();
  const degraded = enabled.filter((feed) =>
    ['stale', 'partial', 'unavailable'].includes(feed.state),
  );

  return el(
    'div',
    { className: 'oryn-page' },
    pageHead(
      t('Intelligence Overview'),
      session
        ? t('{org} · {workspace} workspace · demo session', {
            org: session.organization,
            workspace: session.workspace,
          })
        : t('No session'),
      [
        button({
          label: t('Open map workspace'),
          iconName: 'map',
          className: 'oryn-btn-primary',
          onClick: () => ctx.navigate('map'),
        }),
        button({
          label: t('New investigation'),
          iconName: 'plus',
          onClick: () => ctx.navigate('investigations', { create: true }),
        }),
      ],
    ),
    el(
      'div',
      { className: 'oryn-grid' },
      stat(enabled.length, t('Layers enabled')),
      stat(records, t('Records loaded')),
      stat(open.length, t('Open investigations')),
      stat(scenes.length, t('Saved scenes')),
    ),
    el(
      'div',
      { className: 'oryn-grid oryn-grid-wide' },
      el(
        'div',
        { className: 'oryn-card' },
        el(
          'div',
          { className: 'oryn-card-head' },
          el('h3', { className: 'oryn-card-title', text: t('Feed health') }),
          button({
            label: t('Data sources'),
            className: 'oryn-btn-sm oryn-btn-ghost',
            onClick: () => ctx.navigate('sources'),
          }),
        ),
        engine
          ? enabled.length
            ? el(
                'ul',
                { className: 'oryn-list' },
                enabled.map((feed) =>
                  feedRow(feed, ctx, { withToggle: false }),
                ),
              )
            : emptyState(
                t('No layers enabled'),
                t(
                  'Enable public layers from the layer manager or pick a visualization mode.',
                ),
                button({
                  label: t('Open layer manager'),
                  className: 'oryn-btn-sm',
                  onClick: () => {
                    ctx.navigate('map');
                    ctx.layers.open();
                  },
                }),
              )
          : emptyState(
              t('Engine starting'),
              t('Feed health appears once the globe has initialized.'),
            ),
        degraded.length
          ? el('p', {
              className: 'oryn-note oryn-note-warn',
              text: t(
                '{count} enabled feeds are stale, partial or unavailable. Values from those feeds are shown with their age.',
                { count: degraded.length },
              ),
            })
          : null,
      ),
      el(
        'div',
        { className: 'oryn-card' },
        el(
          'div',
          { className: 'oryn-card-head' },
          el('h3', { className: 'oryn-card-title', text: t('Investigations') }),
          button({
            label: t('All'),
            className: 'oryn-btn-sm oryn-btn-ghost',
            onClick: () => ctx.navigate('investigations'),
          }),
        ),
        open.length
          ? el(
              'ul',
              { className: 'oryn-list' },
              open.slice(0, 6).map((inv) =>
                el(
                  'li',
                  { className: 'oryn-list-item' },
                  el('a', {
                    className: 'oryn-link',
                    attrs: { href: '#' },
                    text: inv.title,
                    on: {
                      click: (event) => {
                        event.preventDefault();
                        ctx.navigate('investigations', { id: inv.id });
                      },
                    },
                  }),
                  chip(inv.status, inv.status === 'open' ? 'info' : 'warn'),
                  el('span', {
                    className: 'oryn-card-meta',
                    text: t('{count} evidence items · updated {age}', {
                      count: inv.entities.length,
                      age: formatAge(inv.updatedAt),
                    }),
                  }),
                ),
              ),
            )
          : emptyState(
              t('No open investigations'),
              t(
                'Create one from an event, a selected entity, or the Investigations page.',
              ),
            ),
      ),
      el(
        'div',
        { className: 'oryn-card' },
        el(
          'div',
          { className: 'oryn-card-head' },
          el('h3', {
            className: 'oryn-card-title',
            text: t('Visualization modes'),
          }),
        ),
        el(
          'ul',
          { className: 'oryn-list' },
          MODES.filter((mode) => mode.manage).map((mode) =>
            el(
              'li',
              { className: 'oryn-list-item' },
              el('span', { text: t(mode.label) }),
              button({
                label: t('Apply'),
                className: 'oryn-btn-sm',
                onClick: () => ctx.setMode(mode.id, { navigate: true }),
              }),
              el('span', {
                className: 'oryn-card-meta',
                text: t(mode.description),
              }),
            ),
          ),
        ),
      ),
      el(
        'div',
        { className: 'oryn-card' },
        el(
          'div',
          { className: 'oryn-card-head' },
          el('h3', {
            className: 'oryn-card-title',
            text: t('Prototype boundaries'),
          }),
        ),
        el(
          'div',
          { className: 'oryn-card-body' },
          [
            t(
              'Sign-in is a local demo session; there is no identity provider.',
            ),
            t(
              'Scenes, investigations and notes are stored in this browser only.',
            ),
            t(
              'Public feeds are periodic snapshots, not continuous surveillance.',
            ),
            t(
              'No computer-vision model is configured; no detections are generated.',
            ),
            t('Camera records labeled DEMO are placeholders with no stream.'),
          ].map((text) => el('p', { className: 'oryn-note', text })),
        ),
      ),
    ),
  );
}

// ── Domain workspaces (drawers over the map) ─────────────────────────────

const DOMAIN_PAGES = Object.freeze({
  municipal: {
    title: () => t('Municipal Intelligence'),
    mode: 'municipal',
    groups: ['cameras', 'transport', 'infrastructure', 'hazards'],
    intro: () =>
      t(
        'Public camera poses, traffic, transit and infrastructure records around the city. Municipal asset registries, inspection findings and field notes connect here when an organization source is configured.',
      ),
    missing: () => [
      t(
        'Municipal asset inventory: requires an organization GIS or asset-management export.',
      ),
      t(
        'Flood and hazard overlays: requires a configured hazard service for the jurisdiction.',
      ),
      t(
        'Inspection findings and change detection: require an inference backend (see Settings).',
      ),
    ],
  },
  agriculture: {
    title: () => t('Agriculture'),
    mode: 'agriculture',
    groups: ['cameras', 'weather', 'hazards'],
    intro: () =>
      t(
        'Recent satellite imagery and weather for field-level review. Field boundaries and vegetation indices need a configured imagery source; nothing is estimated without one.',
      ),
    missing: () => [
      t(
        'Field boundaries: import an organization boundary file (GeoJSON) through the engine Geo Import tool, or connect a farm-management source.',
      ),
      t(
        'NDVI and NDMI: require a multispectral imagery source. NDMI reflects canopy water content and is not a soil-moisture measurement.',
      ),
      t(
        'Before/after comparison and change candidates: require the change-detection model (not configured).',
      ),
      t(
        'A visual change is never proof of crop disease, irrigation failure or yield loss; analyst review is required.',
      ),
    ],
  },
  transportation: {
    title: () => t('Transportation'),
    mode: 'transportation',
    groups: ['aircraft', 'maritime', 'transport'],
    intro: () =>
      t(
        'Aircraft, vessels and transit from public feeds. Coverage depends on receivers and providers; not every vehicle is visible or precisely tracked.',
      ),
    missing: () => [
      t(
        'Movement history is limited to what each feed retains in memory during this session.',
      ),
      t(
        'Select an aircraft or vessel on the globe to inspect its reported position and timestamps.',
      ),
    ],
  },
  infrastructure: {
    title: () => t('Infrastructure'),
    mode: null,
    groups: ['infrastructure', 'maritime', 'space'],
    intro: () =>
      t(
        'Bundled infrastructure reference layers and public installation records.',
      ),
    missing: () => [
      t(
        'Organization infrastructure records: require an authorized data source.',
      ),
      t(
        'Infrastructure change analysis: requires the change-detection model (not configured).',
      ),
    ],
  },
  environment: {
    title: () => t('Environmental Intelligence'),
    mode: 'environment',
    groups: ['hazards', 'weather'],
    intro: () =>
      t(
        'Earthquakes, fire detections and perimeters, cyclones, air quality and weather, each with its source, observation and retrieval times.',
      ),
    missing: () => [
      t(
        'Alerts are not derived automatically from these feeds; review events in the queue and add them to an investigation.',
      ),
    ],
  },
});

export function renderDomain(ctx, pageId) {
  const spec = DOMAIN_PAGES[pageId];
  const engine = ctx.engine();
  const feeds = engine ? engine.feeds() : [];
  const byId = new Map(feeds.map((feed) => [feed.id, feed]));
  const groups = LAYER_GROUPS.filter((group) => spec.groups.includes(group.id));
  return el(
    'div',
    { className: 'oryn-page' },
    pageHead(
      spec.title(),
      spec.intro(),
      [
        spec.mode
          ? button({
              label: t('Apply mode'),
              iconName: 'layers',
              className: 'oryn-btn-sm oryn-btn-primary',
              onClick: () => ctx.setMode(spec.mode),
            })
          : null,
        button({
          label: t('Events'),
          iconName: 'events',
          className: 'oryn-btn-sm',
          onClick: () => ctx.navigate('events'),
        }),
      ].filter(Boolean),
    ),
    groups.map((group) => {
      const members = group.ids.map((id) => byId.get(id)).filter(Boolean);
      return el(
        'section',
        { className: 'oryn-section' },
        el('h4', { className: 'oryn-section-title', text: t(group.label) }),
        members.length
          ? el(
              'ul',
              { className: 'oryn-list' },
              members.map((feed) => feedRow(feed, ctx)),
            )
          : el('p', {
              className: 'oryn-note',
              text: engine
                ? t('No layers registered in this group.')
                : t('Engine starting.'),
            }),
      );
    }),
    el(
      'section',
      { className: 'oryn-section' },
      el('h4', {
        className: 'oryn-section-title',
        text: t('Needs configuration'),
      }),
      spec.missing().map((text) => el('p', { className: 'oryn-note', text })),
    ),
  );
}

export const DOMAIN_PAGE_IDS = Object.freeze(Object.keys(DOMAIN_PAGES));

// ── Event queue ──────────────────────────────────────────────────────────

export function renderEvents(ctx, params = {}) {
  const engine = ctx.engine();
  const events = engine ? engine.collectEvents({ limit: 300 }) : [];
  const layerFilter = params.layer || 'all';
  const layers = [...new Set(events.map((event) => event.layerId))];
  const visible =
    layerFilter === 'all'
      ? events
      : events.filter((event) => event.layerId === layerFilter);
  const feeds = engine ? engine.feedsById() : new Map();

  const select = el('select', {
    className: 'oryn-select',
    attrs: { 'aria-label': t('Filter by layer') },
    on: {
      change: (event) => ctx.navigate('events', { layer: event.target.value }),
    },
  });
  select.append(
    el('option', { attrs: { value: 'all' }, text: t('All layers') }),
  );
  for (const id of layers) {
    const option = el('option', {
      attrs: { value: id },
      text: feeds.get(id)?.name || id,
    });
    if (id === layerFilter) option.selected = true;
    select.append(option);
  }

  const rows = visible.slice(0, 200).map((event) => {
    const feed = feeds.get(event.layerId);
    const tr = el(
      'tr',
      {
        attrs: { tabindex: '0' },
        on: {
          click: () => ctx.inspect(event, { fly: true }),
          keydown: (keyEvent) => {
            if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
              keyEvent.preventDefault();
              ctx.inspect(event, { fly: true });
            }
          },
        },
      },
      el('td', { text: event.label }),
      el(
        'td',
        {},
        feed
          ? chip(feed.label, feed.state, {
              title: feedStateDescription(feed.state),
            })
          : null,
        el('div', { className: 'oryn-card-meta', text: event.source || '' }),
      ),
      el('td', {
        className: 'oryn-mono',
        text: event.observedAt
          ? formatAge(event.observedAt)
          : t('no observation time'),
      }),
      el('td', {
        className: 'oryn-mono',
        text: event.retrievedAt ? formatAge(event.retrievedAt) : '',
      }),
      el('td', {
        className: 'oryn-mono',
        text: event.position
          ? formatCoordinate(event.position.lat, event.position.lon)
          : '',
      }),
      el(
        'td',
        {},
        button({
          iconName: 'investigations',
          className: 'oryn-btn-sm oryn-btn-icon oryn-btn-ghost',
          title: t('Add to investigation'),
          onClick: (click) => {
            click.stopPropagation();
            ctx.addToInvestigation(event);
          },
        }),
      ),
    );
    return tr;
  });

  return el(
    'div',
    { className: 'oryn-page' },
    pageHead(
      t('Public Events'),
      t(
        'Records from enabled event feeds, newest observation first. Select a row to inspect it and fly there. Nothing here is an ORYN alert until an analyst adds it to an investigation.',
      ),
      [
        select,
        button({
          label: t('Export CSV'),
          iconName: 'download',
          className: 'oryn-btn-sm',
          disabled: !visible.length,
          onClick: () => {
            const rows = visible.map((event) => ({
              layerId: event.layerId,
              id: event.id,
              label: event.label,
              lat: event.position?.lat ?? null,
              lon: event.position?.lon ?? null,
              observedAt: event.observedAt,
              retrievedAt: event.retrievedAt,
              source: event.source,
              sourceUrl: event.sourceUrl,
              fields: event.fields || {},
            }));
            downloadText(
              safeFileName('oryn-events', 'csv'),
              eventsCsv(rows),
              'text/csv',
            );
            ctx.workspace.record('export.events', `${rows.length} rows`);
          },
        }),
      ],
    ),
    !engine
      ? emptyState(
          t('Engine starting'),
          t('Events appear once the globe has initialized.'),
        )
      : !events.length
        ? emptyState(
            t('No event feeds enabled'),
            t(
              'Enable Earthquakes, Fires, Perimeters or Cyclones to populate the queue.',
            ),
            button({
              label: t('Apply Live Operations mode'),
              className: 'oryn-btn-sm',
              onClick: () => ctx.setMode('live-ops'),
            }),
          )
        : el(
            'div',
            { className: 'oryn-table-wrap' },
            el(
              'table',
              { className: 'oryn-table' },
              el(
                'thead',
                {},
                el(
                  'tr',
                  {},
                  [
                    t('Event'),
                    t('Feed'),
                    t('Observed'),
                    t('Retrieved'),
                    t('Position'),
                    '',
                  ].map((label) => el('th', { text: label })),
                ),
              ),
              el('tbody', {}, rows),
            ),
          ),
    visible.length > 200
      ? el('p', {
          className: 'oryn-note',
          text: t(
            'Showing the first 200 of {count} events. Use the filter or export the full set.',
            { count: visible.length },
          ),
        })
      : null,
  );
}

// ── Alerts ───────────────────────────────────────────────────────────────

export function renderAlerts(ctx) {
  const engine = ctx.engine();
  const feeds = engine ? engine.feeds().filter((feed) => feed.enabled) : [];
  const systemAlerts = feeds.filter((feed) =>
    ['stale', 'partial', 'unavailable'].includes(feed.state),
  );
  const investigations = ctx.workspace.investigations
    .list()
    .filter((inv) => inv.status === 'in-review');
  return el(
    'div',
    { className: 'oryn-page' },
    pageHead(
      t('Alerts'),
      t(
        'ORYN does not turn public events into alerts automatically and assigns no threat levels. This page lists feed-health conditions the engine reports and investigations awaiting review.',
      ),
    ),
    el(
      'section',
      { className: 'oryn-section' },
      el('h4', { className: 'oryn-section-title', text: t('Feed health') }),
      systemAlerts.length
        ? el(
            'ul',
            { className: 'oryn-list' },
            systemAlerts.map((feed) =>
              el(
                'li',
                { className: 'oryn-list-item' },
                el('span', { text: localizeLayerName(feed.name) }),
                chip(feed.label, feed.state),
                el('span', {
                  className: 'oryn-card-meta',
                  text: [
                    feedStateDescription(feed.state),
                    feed.error,
                    feed.lastUpdate
                      ? t('last retrieval {age}', { age: feed.ageLabel })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                }),
              ),
            ),
          )
        : emptyState(
            t('No feed-health alerts'),
            engine
              ? t('Every enabled feed reports a current or fallback state.')
              : t('Engine starting.'),
          ),
    ),
    el(
      'section',
      { className: 'oryn-section' },
      el('h4', { className: 'oryn-section-title', text: t('Awaiting review') }),
      investigations.length
        ? el(
            'ul',
            { className: 'oryn-list' },
            investigations.map((inv) =>
              el(
                'li',
                { className: 'oryn-list-item' },
                el('a', {
                  className: 'oryn-link',
                  attrs: { href: '#' },
                  text: inv.title,
                  on: {
                    click: (event) => {
                      event.preventDefault();
                      ctx.navigate('investigations', { id: inv.id });
                    },
                  },
                }),
                chip(inv.status, 'warn'),
              ),
            ),
          )
        : el('p', {
            className: 'oryn-note',
            text: t('No investigations are marked in review.'),
          }),
    ),
    el(
      'section',
      { className: 'oryn-section' },
      el('h4', { className: 'oryn-section-title', text: t('Alert rules') }),
      emptyState(
        t('No alert rules configured'),
        t(
          'Rule-based alerting (geofences, thresholds, model findings) needs an organization backend to evaluate rules continuously. The prototype has none, so no rules can be created yet.',
        ),
      ),
    ),
  );
}

// ── Data sources ─────────────────────────────────────────────────────────

export function renderSources(ctx) {
  const engine = ctx.engine();
  const feeds = engine ? engine.feeds() : [];
  return el(
    'div',
    { className: 'oryn-page' },
    pageHead(
      t('Data Sources'),
      t(
        'Every layer the engine registered, with its provider, state and last retrieval time as reported by the layer itself. Terms and attribution for each source are listed in DATA_SOURCES.md.',
      ),
      [
        button({
          label: t('Open layer manager'),
          iconName: 'layers',
          className: 'oryn-btn-sm',
          onClick: () => {
            ctx.navigate('map');
            ctx.layers.open();
          },
        }),
      ],
    ),
    !engine
      ? emptyState(
          t('Engine starting'),
          t('Sources appear once the globe has initialized.'),
        )
      : el(
          'div',
          { className: 'oryn-table-wrap' },
          el(
            'table',
            { className: 'oryn-table' },
            el(
              'thead',
              {},
              el(
                'tr',
                {},
                [
                  t('Layer'),
                  t('Provider'),
                  t('State'),
                  t('Last retrieval'),
                  t('Records'),
                  t('Notes'),
                ].map((label) => el('th', { text: label })),
              ),
            ),
            el(
              'tbody',
              {},
              feeds.map((feed) =>
                el(
                  'tr',
                  {},
                  el('td', { text: localizeLayerName(feed.name) }),
                  el('td', { text: feed.source || t('bundled or local') }),
                  el(
                    'td',
                    {},
                    chip(feed.label, feed.state, {
                      title: feedStateDescription(feed.state),
                    }),
                  ),
                  el('td', {
                    className: 'oryn-mono',
                    text: feed.lastUpdate
                      ? `${formatTimestamp(feed.lastUpdate)} (${feed.ageLabel})`
                      : t('none'),
                  }),
                  el('td', {
                    className: 'oryn-mono',
                    text: feed.enabled ? String(feed.count) : '',
                  }),
                  el('td', {
                    text: [
                      feed.requiresKeyId ? t('Provider key required') : null,
                      feed.error,
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  }),
                ),
              ),
            ),
          ),
        ),
    el('p', {
      className: 'oryn-note',
      text: t(
        'Retrieval time is when ORYN last fetched the feed. Observation time is per record and is shown in the inspector when the provider supplies it.',
      ),
    }),
  );
}

// ── Settings ─────────────────────────────────────────────────────────────

export function renderSettings(ctx) {
  const session = ctx.session.current();
  const stores = [
    ctx.workspace.scenes,
    ctx.workspace.investigations,
    ctx.workspace.notes,
    ctx.workspace.audit,
  ];
  return el(
    'div',
    { className: 'oryn-page' },
    pageHead(
      t('Settings'),
      t('Session, provider keys and local data for this prototype.'),
    ),
    el(
      'div',
      { className: 'oryn-grid oryn-grid-wide' },
      el(
        'div',
        { className: 'oryn-card' },
        el('h3', { className: 'oryn-card-title', text: t('Session') }),
        session
          ? el(
              'div',
              { className: 'oryn-card-body' },
              el('p', { text: `${session.user} · ${session.role}` }),
              el('p', { text: session.organization }),
              el('p', {
                className: 'oryn-card-meta',
                text: t('Started {time} · DEMO session, not authenticated', {
                  time: formatTimestamp(session.startedAt),
                }),
              }),
            )
          : el('p', { className: 'oryn-note', text: t('No session') }),
        el(
          'div',
          { className: 'oryn-actions' },
          button({
            label: t('Sign out'),
            iconName: 'logout',
            className: 'oryn-btn-sm',
            onClick: () => ctx.signOut(),
          }),
        ),
      ),
      el(
        'div',
        { className: 'oryn-card' },
        el('h3', { className: 'oryn-card-title', text: t('Provider keys') }),
        el('p', {
          className: 'oryn-card-body',
          text: t(
            'Optional keys (Cesium ion, Google Maps, NASA FIRMS, OpenAI voice) are managed by the engine and stored in the local .env file, never in this browser.',
          ),
        }),
        el(
          'div',
          { className: 'oryn-actions' },
          button({
            label: t('Open provider settings'),
            iconName: 'settings',
            className: 'oryn-btn-sm',
            onClick: () => {
              ctx.navigate('map');
              document.getElementById('key-setup-chip')?.click();
            },
          }),
        ),
      ),
      el(
        'div',
        { className: 'oryn-card' },
        el('h3', { className: 'oryn-card-title', text: t('Local data') }),
        el(
          'ul',
          { className: 'oryn-list' },
          stores.map((store) =>
            el(
              'li',
              { className: 'oryn-list-item' },
              el('span', { text: store.name }),
              el('span', {
                className: 'oryn-mono',
                text: String(store.list().length),
              }),
              store.droppedCount
                ? el('span', {
                    className: 'oryn-card-meta',
                    text: t('{count} invalid records were ignored', {
                      count: store.droppedCount,
                    }),
                  })
                : null,
            ),
          ),
        ),
        el(
          'div',
          { className: 'oryn-actions' },
          button({
            label: t('Clear all local ORYN data'),
            iconName: 'trash',
            className: 'oryn-btn-sm oryn-btn-danger',
            onClick: () => {
              if (
                window.confirm(
                  t(
                    'Delete all scenes, investigations, notes and audit entries stored in this browser?',
                  ),
                )
              ) {
                for (const store of stores) store.clear();
                ctx.toast(t('Local data cleared'));
                ctx.rerender();
              }
            },
          }),
        ),
      ),
      el(
        'div',
        { className: 'oryn-card' },
        el('h3', {
          className: 'oryn-card-title',
          text: t('Analytics backend'),
        }),
        el(
          'ul',
          { className: 'oryn-list' },
          ctx.ml.models.map((model) => {
            const info = ctx.ml.describe(model.id);
            return el(
              'li',
              { className: 'oryn-list-item' },
              el('span', { text: model.name }),
              chip(
                info.status === 'ready' ? t('READY') : t('NOT CONFIGURED'),
                info.status === 'ready' ? 'ok' : 'neutral',
              ),
              el('span', {
                className: 'oryn-card-meta',
                text: model.description,
              }),
            );
          }),
        ),
        el('p', {
          className: 'oryn-note',
          text: ctx.ml.providers[0]?.setupHint
            ? t(ctx.ml.providers[0].setupHint)
            : '',
        }),
      ),
    ),
  );
}

// ── Audit trail ──────────────────────────────────────────────────────────

export function renderAudit(ctx) {
  const entries = ctx.workspace.audit
    .list()
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return el(
    'div',
    { className: 'oryn-page' },
    pageHead(
      t('Audit Trail'),
      t(
        'Actions taken in this browser during demo sessions. A production deployment would write these to an organization audit service.',
      ),
    ),
    entries.length
      ? el(
          'div',
          { className: 'oryn-table-wrap' },
          el(
            'table',
            { className: 'oryn-table' },
            el(
              'thead',
              {},
              el(
                'tr',
                {},
                [t('Time'), t('Actor'), t('Action'), t('Subject')].map(
                  (label) => el('th', { text: label }),
                ),
              ),
            ),
            el(
              'tbody',
              {},
              entries.slice(0, 300).map((entry) =>
                el(
                  'tr',
                  {},
                  el('td', {
                    className: 'oryn-mono',
                    text: formatTimestamp(entry.at),
                  }),
                  el('td', { text: entry.actor }),
                  el('td', { className: 'oryn-mono', text: entry.action }),
                  el('td', { text: entry.subject }),
                ),
              ),
            ),
          ),
        )
      : emptyState(
          t('No audit entries yet'),
          t(
            'Saving a scene, creating an investigation or exporting a report records an entry.',
          ),
        ),
  );
}

// ── Reports ──────────────────────────────────────────────────────────────

export function renderReports(ctx) {
  const investigations = ctx.workspace.investigations.list();
  return el(
    'div',
    { className: 'oryn-page' },
    pageHead(
      t('Reports and Exports'),
      t(
        'Exports are generated from records held by this prototype. JSON and CSV are implemented; PDF export is not, because it would need a new dependency.',
      ),
    ),
    el(
      'section',
      { className: 'oryn-section' },
      el('h4', {
        className: 'oryn-section-title',
        text: t('Investigation reports'),
      }),
      investigations.length
        ? el(
            'ul',
            { className: 'oryn-list' },
            investigations.map((inv) =>
              el(
                'li',
                { className: 'oryn-list-item' },
                el('span', { text: inv.title }),
                el(
                  'div',
                  { className: 'oryn-actions' },
                  button({
                    label: t('JSON'),
                    iconName: 'download',
                    className: 'oryn-btn-sm',
                    onClick: () => ctx.exportInvestigation(inv.id, 'json'),
                  }),
                  button({
                    label: t('Entities CSV'),
                    iconName: 'download',
                    className: 'oryn-btn-sm',
                    onClick: () => ctx.exportInvestigation(inv.id, 'csv'),
                  }),
                ),
                el('span', {
                  className: 'oryn-card-meta',
                  text: t('{count} evidence items · {status} · updated {age}', {
                    count: inv.entities.length,
                    status: inv.status,
                    age: formatAge(inv.updatedAt),
                  }),
                }),
              ),
            ),
          )
        : emptyState(
            t('No investigations to report on'),
            t('Create an investigation and add evidence first.'),
          ),
    ),
    el(
      'section',
      { className: 'oryn-section' },
      el('h4', { className: 'oryn-section-title', text: t('Other exports') }),
      el(
        'div',
        { className: 'oryn-actions' },
        button({
          label: t('Event queue CSV'),
          iconName: 'download',
          className: 'oryn-btn-sm',
          onClick: () => ctx.navigate('events'),
        }),
        button({
          label: t('Audit trail JSON'),
          iconName: 'download',
          className: 'oryn-btn-sm',
          onClick: () => {
            downloadText(
              safeFileName('oryn-audit', 'json'),
              JSON.stringify(
                {
                  format: 'oryn-audit',
                  generatedAt: new Date().toISOString(),
                  entries: ctx.workspace.audit.list(),
                },
                null,
                2,
              ),
              'application/json',
            );
          },
        }),
      ),
    ),
    el('p', {
      className: 'oryn-note',
      text: t(
        'Every report lists its data limitations and separates provider-reported values, analyst notes and (absent) model findings.',
      ),
    }),
  );
}

export { pageHead, stat, feedRow, replaceChildren, modeById };
