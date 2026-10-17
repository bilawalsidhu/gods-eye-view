// ORYN Intelligence shell orchestrator.
//
// Installed by src/main.js before the engine starts. Owns the demo session
// gate, the navigation rail, the command bar, page routing, and the wiring
// between the enterprise surfaces (inspector, layer manager, timeline,
// investigations, cameras, reports) and the running engine. The engine is
// composed exactly once by the application; this module only observes it.
import { t } from '../../i18n/index.js';
import { el, button, chip, icon, replaceChildren } from './dom.js';
import {
  createSessionStore,
  DEMO_ORGANIZATIONS,
  DEMO_ROLES,
} from './session.js';
import { createWorkspace } from './workspace.js';
import { createEngineFacade } from './engine.js';
import { createInspector } from './inspector.js';
import { createLayerManager } from './layerManager.js';
import { createTimeline } from './timeline.js';
import { MODES, modeById, applyMode } from './modes.js';
import {
  createCameraRegistry,
  createDemoCameraProvider,
  createUnconfiguredOrganizationProvider,
  createEngineCctvProvider,
} from './cameras.js';
import {
  createInferenceRegistry,
  createUnconfiguredInferenceProvider,
} from './ml.js';
import {
  buildInvestigationReport,
  reportEntitiesCsv,
  downloadText,
  safeFileName,
} from './reports.js';
import { formatTimestamp } from './provenance.js';
import {
  renderOverview,
  renderDomain,
  DOMAIN_PAGE_IDS,
  renderEvents,
  renderAlerts,
  renderSources,
  renderSettings,
  renderAudit,
  renderReports,
} from './pages.js';
import { renderInvestigations } from './investigationsPage.js';
import { renderCameras } from './camerasPage.js';
import { renderScenes } from './scenesPage.js';
import { validateEntityRef } from './models.js';

const PAGE_STORAGE_KEY = 'oryn:page:v1';
const RAIL_STORAGE_KEY = 'oryn:rail:v1';
const FIRST_RUN_SUPPRESS_KEY = 'gev:first-run-mission:v1';

/** Navigation model. `kind` decides how a page is presented over the globe. */
const NAV = Object.freeze([
  {
    group: t('Workspace'),
    items: [
      {
        id: 'overview',
        label: () => t('Intelligence Overview'),
        icon: 'overview',
        kind: 'sheet',
      },
      { id: 'map', label: () => t('Map Workspace'), icon: 'map', kind: 'map' },
      {
        id: 'scenes',
        label: () => t('Saved Scenes'),
        icon: 'pin',
        kind: 'sheet',
      },
    ],
  },
  {
    group: t('Domains'),
    items: [
      {
        id: 'municipal',
        label: () => t('Municipal Intelligence'),
        icon: 'municipal',
        kind: 'drawer',
      },
      {
        id: 'agriculture',
        label: () => t('Agriculture'),
        icon: 'agriculture',
        kind: 'drawer',
      },
      {
        id: 'transportation',
        label: () => t('Transportation'),
        icon: 'transportation',
        kind: 'drawer',
      },
      {
        id: 'infrastructure',
        label: () => t('Infrastructure'),
        icon: 'infrastructure',
        kind: 'drawer',
      },
      {
        id: 'environment',
        label: () => t('Environment'),
        icon: 'globe',
        kind: 'drawer',
      },
    ],
  },
  {
    group: t('Operations'),
    items: [
      {
        id: 'events',
        label: () => t('Public Events'),
        icon: 'events',
        kind: 'drawer',
      },
      {
        id: 'cameras',
        label: () => t('Cameras and Sensors'),
        icon: 'cameras',
        kind: 'sheet',
      },
      {
        id: 'investigations',
        label: () => t('Investigations'),
        icon: 'investigations',
        kind: 'sheet',
      },
      { id: 'alerts', label: () => t('Alerts'), icon: 'alerts', kind: 'sheet' },
      {
        id: 'reports',
        label: () => t('Reports and Exports'),
        icon: 'reports',
        kind: 'sheet',
      },
    ],
  },
  {
    group: t('Administration'),
    items: [
      {
        id: 'sources',
        label: () => t('Data Sources'),
        icon: 'sources',
        kind: 'sheet',
      },
      {
        id: 'settings',
        label: () => t('Settings'),
        icon: 'settings',
        kind: 'sheet',
      },
      {
        id: 'audit',
        label: () => t('Audit Trail'),
        icon: 'audit',
        kind: 'sheet',
      },
    ],
  },
]);
const PAGES = new Map(
  NAV.flatMap((group) => group.items).map((item) => [item.id, item]),
);

function readStorage(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function writeStorage(key, value) {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Best-effort persistence only.
  }
}

/**
 * Install the ORYN shell around the application.
 * @param {{application:{subscribe:Function,getComponents:Function}}} options
 */
export function installOrynShell({ application }) {
  const body = document.body;
  const session = createSessionStore();
  const workspace = createWorkspace({ session });
  const ml = createInferenceRegistry([createUnconfiguredInferenceProvider()]);
  let engine = null;
  let page = 'map';
  let pageParams = {};
  let modeId = 'globe';
  let activeInvestigationId = null;
  let pendingRef = null;
  let toastTimer = null;

  // The engine's own first-launch mission chooser is replaced by the ORYN
  // workspace; suppress it so the globe boots quietly behind the sign-in.
  writeStorage(FIRST_RUN_SUPPRESS_KEY, 'suppressed');

  const cameras = createCameraRegistry([
    createEngineCctvProvider(
      () => engine?.dataManager.layers.get('cctv')?.module ?? null,
    ),
    createDemoCameraProvider(),
    createUnconfiguredOrganizationProvider(),
  ]);

  const ctx = {};

  // ── Toast ───────────────────────────────────────────────────────────────
  const toastNode = document.getElementById('oryn-toast');
  function toast(text) {
    toastNode.textContent = text;
    toastNode.classList.add('oryn-toast-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(
      () => toastNode.classList.remove('oryn-toast-visible'),
      3200,
    );
  }

  // ── Session gate ────────────────────────────────────────────────────────
  const login = document.getElementById('oryn-login');
  const loginForm = document.getElementById('oryn-login-form');
  const loginName = document.getElementById('oryn-login-name');
  const loginOrg = document.getElementById('oryn-login-org');
  const loginRole = document.getElementById('oryn-login-role');
  for (const organization of DEMO_ORGANIZATIONS)
    loginOrg.append(
      el('option', {
        attrs: { value: organization.id },
        text: organization.name,
      }),
    );
  for (const role of DEMO_ROLES)
    loginRole.append(el('option', { attrs: { value: role }, text: role }));
  loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const user = loginName.value.trim();
    if (!user) return;
    session.signIn({
      user,
      organizationId: loginOrg.value,
      role: loginRole.value,
    });
    workspace.record('session.sign-in', `${user} (demo)`);
    syncSession();
    navigate('map');
    toast(
      t(
        'Demo session started. Pick a visualization mode or open the layer manager.',
      ),
    );
  });

  function syncSession() {
    const current = session.current();
    login.hidden = Boolean(current);
    body.dataset.orynSession = current ? 'active' : 'none';
    renderRailSession(current);
    renderOrgChip(current);
    if (!current) loginName.focus();
  }

  function signOut() {
    const current = session.current();
    workspace.record('session.sign-out', current?.user || '');
    session.signOut();
    activeInvestigationId = null;
    syncSession();
    toast(t('Signed out of the demo session'));
  }

  // ── Rail ────────────────────────────────────────────────────────────────
  const nav = document.getElementById('oryn-nav');
  const railToggle = document.getElementById('oryn-rail-toggle');
  const railSession = document.getElementById('oryn-rail-session');
  const menuButton = document.getElementById('oryn-menu-btn');

  function renderNav() {
    replaceChildren(
      nav,
      NAV.map((group) => [
        el('div', { className: 'oryn-nav-group', text: group.group }),
        group.items.map((item) =>
          el(
            'button',
            {
              className: 'oryn-nav-item',
              attrs: {
                type: 'button',
                'aria-current': page === item.id ? 'page' : null,
                title: item.label(),
              },
              dataset: { page: item.id },
              on: {
                click: () => {
                  navigate(item.id);
                  body.dataset.orynRailOpen = 'false';
                  menuButton.setAttribute('aria-expanded', 'false');
                },
              },
            },
            icon(item.icon),
            el('span', { className: 'oryn-nav-label', text: item.label() }),
          ),
        ),
      ]),
    );
  }

  function setRailCollapsed(collapsed) {
    body.dataset.orynRail = collapsed ? 'collapsed' : 'expanded';
    railToggle.setAttribute('aria-expanded', String(!collapsed));
    railToggle.setAttribute(
      'aria-label',
      collapsed ? t('Expand navigation') : t('Collapse navigation'),
    );
    replaceChildren(
      railToggle,
      icon(collapsed ? 'chevronRight' : 'chevronLeft'),
    );
    writeStorage(RAIL_STORAGE_KEY, collapsed ? 'collapsed' : 'expanded');
  }
  railToggle.addEventListener('click', () =>
    setRailCollapsed(body.dataset.orynRail !== 'collapsed'),
  );
  setRailCollapsed(readStorage(RAIL_STORAGE_KEY) === 'collapsed');
  replaceChildren(menuButton, icon('menu'));
  menuButton.addEventListener('click', () => {
    const open = body.dataset.orynRailOpen !== 'true';
    body.dataset.orynRailOpen = String(open);
    menuButton.setAttribute('aria-expanded', String(open));
  });

  function renderRailSession(current) {
    if (!current) {
      replaceChildren(railSession);
      return;
    }
    const initials = current.user
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
    replaceChildren(
      railSession,
      el('span', {
        className: 'oryn-avatar',
        text: initials,
        attrs: { 'aria-hidden': 'true' },
      }),
      el(
        'div',
        {},
        el('div', { className: 'oryn-session-name', text: current.user }),
        el('div', {
          className: 'oryn-session-meta',
          text: t('{role} · demo session', { role: current.role }),
        }),
      ),
    );
  }

  // ── Top bar ─────────────────────────────────────────────────────────────
  const pageTitle = document.getElementById('oryn-page-title');
  const orgChip = document.getElementById('oryn-org-chip');
  const feedSummary = document.getElementById('oryn-feed-summary');
  const clockNode = document.getElementById('oryn-clock');
  const modeSelect = document.getElementById('oryn-mode-select');
  const topbarButtons = document.getElementById('oryn-topbar-buttons');
  const searchForm = document.getElementById('oryn-search-form');
  const searchInput = document.getElementById('oryn-search');
  const searchResults = document.getElementById('oryn-search-results');

  function renderOrgChip(current) {
    orgChip.title = current
      ? t('{org} · {workspace} workspace · demo session', {
          org: current.organization,
          workspace: current.workspace,
        })
      : '';
    replaceChildren(
      orgChip,
      current
        ? [
            icon('user', { size: 14 }),
            el('span', { text: current.organization }),
          ]
        : [],
    );
  }

  for (const mode of MODES)
    modeSelect.append(
      el('option', { attrs: { value: mode.id }, text: t(mode.label) }),
    );
  modeSelect.addEventListener('change', () => setMode(modeSelect.value));

  const inspector = createInspector({
    engine: () => engine,
    workspace,
    onAddToInvestigation: (ref) => addToInvestigation(ref),
    onAddNote: (ref, text) => {
      workspace.addNote({
        body: text,
        target: ref,
        position: ref.position,
        investigationId: activeInvestigationId,
      });
      toast(t('Note saved locally'));
    },
    onOpenCamera: (ref) => navigate('cameras', { focus: ref.id }),
  });
  const layers = createLayerManager({ engine: () => engine });
  const timeline = createTimeline({ engine: () => engine });

  function renderTopbarButtons() {
    replaceChildren(
      topbarButtons,
      button({
        iconName: 'layers',
        className: 'oryn-btn-icon',
        title: t('Layer manager'),
        pressed: layers.isOpen,
        onClick: () => {
          navigate('map');
          layers.toggle();
          renderTopbarButtons();
        },
      }),
      button({
        iconName: 'inspect',
        className: 'oryn-btn-icon',
        title: t('Inspector'),
        pressed: inspector.isOpen,
        onClick: () => {
          inspector.toggle();
          renderTopbarButtons();
        },
      }),
      button({
        iconName: 'timeline',
        className: 'oryn-btn-icon',
        title: t('Timeline'),
        pressed: timeline.isOpen,
        onClick: () => {
          timeline.toggle();
          renderTopbarButtons();
        },
      }),
      button({
        iconName: 'pin',
        className: 'oryn-btn-icon',
        title: t('Save current view as a scene'),
        disabled: !engine,
        onClick: () => {
          const name = window.prompt(
            t('Scene name'),
            t('Scene {time}', { time: formatTimestamp(new Date()) }),
          );
          if (name && name.trim()) {
            try {
              saveScene(name.trim());
            } catch (error) {
              toast(error?.message || String(error));
            }
          }
        },
      }),
      button({
        iconName: 'home',
        className: 'oryn-btn-icon',
        title: t('Return to globe overview'),
        disabled: !engine,
        onClick: () => {
          navigate('map');
          engine?.resetView();
        },
      }),
      button({
        iconName: 'logout',
        className: 'oryn-btn-icon oryn-btn-ghost',
        title: t('Sign out'),
        onClick: signOut,
      }),
    );
  }

  function renderFeedSummary() {
    if (!engine) {
      replaceChildren(feedSummary, chip(t('ENGINE STARTING'), 'loading'));
      return;
    }
    const feeds = engine.feeds().filter((feed) => feed.enabled);
    const counts = {
      current: 0,
      fallback: 0,
      loading: 0,
      stale: 0,
      partial: 0,
      unavailable: 0,
    };
    for (const feed of feeds)
      counts[feed.state] = (counts[feed.state] || 0) + 1;
    const nodes = [];
    if (!feeds.length)
      nodes.push(
        chip(t('NO LAYERS'), 'neutral', {
          title: t('No data layers are enabled'),
        }),
      );
    for (const [state, count] of Object.entries(counts))
      if (count)
        nodes.push(
          chip(`${count} ${t(state.toUpperCase())}`, state, {
            title: t('{count} enabled layers report {state}', { count, state }),
          }),
        );
    replaceChildren(feedSummary, nodes);
  }

  function tickClock() {
    clockNode.textContent = formatTimestamp(new Date());
  }
  tickClock();
  const clockTimer = setInterval(tickClock, 1000);

  // ── Search ──────────────────────────────────────────────────────────────
  let searchTimer = null;
  let searchAbort = null;
  function closeSearch() {
    searchResults.hidden = true;
    searchInput.setAttribute('aria-expanded', 'false');
  }
  function renderSearch(query) {
    const nodes = [];
    if (engine) {
      const entities = engine.searchEntities(query, { limit: 10 });
      if (entities.length) {
        nodes.push(
          el('div', {
            className: 'oryn-search-section',
            text: t('Loaded entities'),
          }),
        );
        for (const ref of entities)
          nodes.push(
            el(
              'button',
              {
                className: 'oryn-search-result',
                attrs: { type: 'button', role: 'option' },
                on: {
                  click: () => {
                    closeSearch();
                    inspect(ref, { fly: true });
                  },
                },
              },
              icon('focus', { size: 16 }),
              el('span', { text: ref.label }),
              el('small', { text: ref.layerId || '' }),
            ),
          );
      }
    }
    nodes.push(
      el('div', { className: 'oryn-search-section', text: t('Places') }),
    );
    nodes.push(
      el(
        'button',
        {
          className: 'oryn-search-result',
          attrs: { type: 'button', role: 'option' },
          on: { click: () => flyToQuery(query) },
        },
        icon('search', { size: 16 }),
        el('span', { text: t('Fly to "{query}"', { query }) }),
        el('small', {
          text: engine
            ? t('coordinates, bundled places, then geocoder')
            : t('engine starting'),
        }),
      ),
    );
    replaceChildren(searchResults, nodes);
    searchResults.hidden = false;
    searchInput.setAttribute('aria-expanded', 'true');
  }
  async function flyToQuery(query) {
    closeSearch();
    if (!engine) {
      toast(t('The globe is still starting'));
      return;
    }
    searchAbort?.abort();
    searchAbort = new AbortController();
    navigate('map');
    try {
      const result = await engine.searchAndFlyTo(query, {
        signal: searchAbort.signal,
      });
      if (result === null) toast(t('No place found for "{query}"', { query }));
      else {
        workspace.record('search.place', query);
        const ref = validateEntityRef({
          kind: 'place',
          id: `place:${query.toLowerCase()}`,
          label: result?.name || result?.label || query,
          provenance: 'provider',
          source: t('Place search'),
          position:
            Number.isFinite(result?.lat) && Number.isFinite(result?.lng)
              ? { lon: result.lng, lat: result.lat }
              : undefined,
        });
        if (ref) inspector.show(ref);
      }
    } catch (error) {
      if (error?.name !== 'AbortError') toast(error?.message || String(error));
    }
  }
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const query = searchInput.value.trim();
    if (query.length < 2) {
      closeSearch();
      return;
    }
    searchTimer = setTimeout(() => renderSearch(query), 180);
  });
  searchInput.addEventListener('focus', () => {
    const query = searchInput.value.trim();
    if (query.length >= 2) renderSearch(query);
  });
  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = searchInput.value.trim();
    if (query) flyToQuery(query);
  });
  document.addEventListener('click', (event) => {
    if (!searchForm.contains(event.target)) closeSearch();
  });

  // ── Routing ─────────────────────────────────────────────────────────────
  const pages = document.getElementById('oryn-pages');
  const RENDERERS = {
    overview: () => renderOverview(ctx),
    scenes: () => renderScenes(ctx),
    events: (params) => renderEvents(ctx, params),
    cameras: (params) => renderCameras(ctx, params),
    investigations: (params) => renderInvestigations(ctx, params),
    alerts: () => renderAlerts(ctx),
    reports: () => renderReports(ctx),
    sources: () => renderSources(ctx),
    settings: () => renderSettings(ctx),
    audit: () => renderAudit(ctx),
  };
  for (const id of DOMAIN_PAGE_IDS) RENDERERS[id] = () => renderDomain(ctx, id);

  function renderPage() {
    const item = PAGES.get(page) || PAGES.get('map');
    pageTitle.textContent = item.label();
    // i18n-ignore
    document.title = `${item.label()} · ORYN Intelligence`;
    for (const node of nav.querySelectorAll('.oryn-nav-item'))
      if (node.dataset.page === item.id)
        node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    if (item.kind === 'map') {
      pages.hidden = true;
      replaceChildren(pages);
      pages.removeAttribute('data-oryn-sheet');
      return;
    }
    pages.dataset.orynSheet = item.kind;
    if (pendingRef && page === 'investigations' && pageParams.pick)
      replaceChildren(pages, renderPicker());
    else
      replaceChildren(
        pages,
        RENDERERS[item.id]?.(pageParams) ??
          el('div', { className: 'oryn-page', text: item.label() }),
      );
    pages.hidden = false;
    pages.scrollTop = 0;
  }

  function navigate(pageId, params = {}) {
    if (!PAGES.has(pageId)) pageId = 'map';
    page = pageId;
    pageParams = params || {};
    body.dataset.orynPage = pageId;
    writeStorage(PAGE_STORAGE_KEY, pageId);
    renderPage();
  }

  function rerender() {
    renderPage();
    renderFeedSummary();
    renderTopbarButtons();
    inspector.refresh();
  }

  // ── Investigation picker (add evidence) ─────────────────────────────────
  function renderPicker() {
    const ref = pendingRef;
    const list = workspace.investigations
      .list()
      .filter((inv) => inv.status !== 'closed');
    const titleInput = el('input', {
      className: 'oryn-input',
      attrs: {
        type: 'text',
        maxlength: 200,
        placeholder: t('New investigation title'),
        value: ref.label || '',
      },
    });
    return el(
      'div',
      { className: 'oryn-page' },
      el(
        'div',
        { className: 'oryn-page-head' },
        el(
          'div',
          {},
          el('h2', { text: t('Add to investigation') }),
          el('p', { text: ref.label || ref.id }),
        ),
      ),
      list.length
        ? el(
            'ul',
            { className: 'oryn-list' },
            list.map((inv) =>
              el(
                'li',
                { className: 'oryn-list-item' },
                el('span', { text: inv.title }),
                button({
                  label: t('Add here'),
                  className: 'oryn-btn-sm oryn-btn-primary',
                  onClick: () => {
                    workspace.addEntityToInvestigation(inv.id, ref);
                    activeInvestigationId = inv.id;
                    pendingRef = null;
                    toast(t('Added to {title}', { title: inv.title }));
                    navigate('investigations', { id: inv.id });
                  },
                }),
              ),
            ),
          )
        : el('p', {
            className: 'oryn-note',
            text: t('No open investigations. Create one below.'),
          }),
      el(
        'div',
        { className: 'oryn-card oryn-form' },
        el('label', { text: t('Create new') }),
        el(
          'div',
          { className: 'oryn-form-row' },
          titleInput,
          button({
            label: t('Create and add'),
            iconName: 'plus',
            className: 'oryn-btn-primary',
            onClick: () => {
              const title = titleInput.value.trim();
              if (!title) return;
              const inv = workspace.createInvestigation({ title });
              workspace.addEntityToInvestigation(inv.id, ref);
              activeInvestigationId = inv.id;
              pendingRef = null;
              toast(t('Added to {title}', { title: inv.title }));
              navigate('investigations', { id: inv.id });
            },
          }),
        ),
      ),
      el(
        'div',
        { className: 'oryn-actions' },
        button({
          label: t('Cancel'),
          className: 'oryn-btn-ghost',
          onClick: () => {
            pendingRef = null;
            navigate('map');
          },
        }),
      ),
    );
  }

  function addToInvestigation(ref) {
    const clean = validateEntityRef(ref);
    if (!clean) {
      toast(t('This item cannot be added'));
      return;
    }
    if (
      activeInvestigationId &&
      workspace.investigations.get(activeInvestigationId)
    ) {
      const inv = workspace.addEntityToInvestigation(
        activeInvestigationId,
        clean,
      );
      toast(t('Added to {title}', { title: inv.title }));
      return;
    }
    pendingRef = clean;
    navigate('investigations', { pick: true });
  }

  // ── Scenes ──────────────────────────────────────────────────────────────
  function saveScene(name, { id, investigationId } = {}) {
    if (!engine) throw new Error(t('The globe is still starting'));
    const scene = workspace.saveScene(engine, {
      id,
      name,
      mode: modeId,
      selection: inspector.current,
      panels: {
        inspector: inspector.isOpen,
        layers: layers.isOpen,
        timeline: timeline.isOpen,
      },
      investigationId: investigationId ?? activeInvestigationId,
    });
    toast(t('Scene "{name}" saved locally', { name: scene.name }));
    return scene;
  }
  async function openScene(id) {
    const scene = workspace.scenes.get(id);
    if (!scene || !engine) return;
    navigate('map');
    modeId = scene.mode;
    modeSelect.value = MODES.some((mode) => mode.id === modeId)
      ? modeId
      : 'custom';
    if (scene.panels.layers) layers.open();
    else layers.close();
    if (scene.panels.timeline) timeline.open();
    else timeline.close();
    if (scene.selection) inspector.show(scene.selection);
    else inspector.close();
    if (scene.investigationId) activeInvestigationId = scene.investigationId;
    const { missingLayers } = await workspace.applyScene(engine, scene);
    renderTopbarButtons();
    toast(
      missingLayers.length
        ? t('Scene opened; {count} layers are no longer registered', {
            count: missingLayers.length,
          })
        : t('Scene "{name}" opened', { name: scene.name }),
    );
  }

  // ── Modes ───────────────────────────────────────────────────────────────
  async function setMode(id, { navigate: go = false } = {}) {
    if (!engine) {
      toast(t('The globe is still starting'));
      return;
    }
    modeId = modeById(id).id;
    modeSelect.value = modeId;
    if (go) navigate('map');
    const { mode, skipped } = await applyMode(engine, modeId);
    workspace.record('mode.apply', mode.id);
    if (skipped.length)
      toast(
        t('{label}: {count} layers could not be enabled ({reason})', {
          label: t(mode.label),
          count: skipped.length,
          reason: skipped[0].reason,
        }),
      );
    else if (mode.manage)
      toast(t('{label} mode applied', { label: t(mode.label) }));
    rerender();
  }

  // ── Inspection ──────────────────────────────────────────────────────────
  function inspect(ref, { fly = false } = {}) {
    const clean = validateEntityRef(ref);
    if (!clean) return;
    inspector.show(clean);
    renderTopbarButtons();
    if (fly && engine && clean.position) {
      navigate('map');
      engine.flyTo({
        lat: clean.position.lat,
        lon: clean.position.lon,
        range:
          clean.kind === 'fire-perimeter'
            ? 40_000
            : clean.kind === 'earthquake'
              ? 120_000
              : 6000,
      });
    }
  }

  function exportInvestigation(id, format) {
    const investigation = workspace.investigations.get(id);
    if (!investigation) return;
    const report = buildInvestigationReport(investigation, {
      notes: workspace.notes.list(),
      scenes: workspace.scenes.list(),
      feeds: engine ? engine.feeds().filter((feed) => feed.enabled) : [],
      session: session.current(),
    });
    if (format === 'csv')
      downloadText(
        safeFileName(`${investigation.title}-entities`, 'csv'),
        reportEntitiesCsv(report),
        'text/csv',
      );
    else
      downloadText(
        safeFileName(investigation.title, 'json'),
        JSON.stringify(report, null, 2),
        'application/json',
      );
    workspace.record(`export.investigation.${format}`, investigation.title);
    toast(t('Report exported'));
  }

  Object.assign(ctx, {
    engine: () => engine,
    workspace,
    session,
    cameras,
    ml,
    layers,
    inspector,
    timeline,
    navigate,
    rerender,
    toast,
    inspect,
    addToInvestigation,
    exportInvestigation,
    saveScene,
    openScene,
    saveSceneForInvestigation: (investigationId) => {
      const inv = workspace.investigations.get(investigationId);
      const name = window.prompt(t('Scene name'), inv ? inv.title : '');
      if (!name || !name.trim()) return;
      try {
        const scene = saveScene(name.trim(), { investigationId });
        workspace.attachScene(investigationId, scene.id);
        rerender();
      } catch (error) {
        toast(error?.message || String(error));
      }
    },
    setMode,
    signOut,
    get activeInvestigationId() {
      return activeInvestigationId;
    },
    setActiveInvestigation: (id) => {
      activeInvestigationId = id;
    },
  });

  // ── Keyboard ────────────────────────────────────────────────────────────
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    const target = event.target;
    const typing =
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable);
    if (event.key === 'Escape') {
      if (!searchResults.hidden) closeSearch();
      else if (layers.isOpen) layers.close();
      else if (page !== 'map' && PAGES.get(page)?.kind === 'drawer')
        navigate('map');
      renderTopbarButtons();
      return;
    }
    if (typing) return;
    if (event.key === '/') {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  // ── Engine attachment ───────────────────────────────────────────────────
  let activityUnsubscribe = null;
  let summaryFrame = null;
  application.subscribe((state) => {
    if (state.status !== 'ready' || engine) return;
    try {
      engine = createEngineFacade(application.getComponents());
    } catch (error) {
      console.error('[ORYN] engine facade failed', error);
      return;
    }
    adoptCreditsIntoStage();
    layers.attach();
    timeline.attach();
    engine.subscribeSelection((ref) => {
      inspector.update(ref);
      renderTopbarButtons();
    });
    activityUnsubscribe = engine.subscribeActivity(() => {
      if (summaryFrame) return;
      summaryFrame = requestAnimationFrame(() => {
        summaryFrame = null;
        renderFeedSummary();
        if (
          !pages.hidden &&
          [
            'events',
            'sources',
            'alerts',
            'overview',
            ...DOMAIN_PAGE_IDS,
          ].includes(page)
        )
          renderPage();
      });
    });
    cameras
      .refresh()
      .catch((error) => console.warn('[ORYN] camera registry', error));
    applyOperationalDefaults();
    rerender();
  });

  // The engine appends the Cesium attribution element to <body>. Moving it
  // into the stage lets its own (modelled, tested) CSS position it relative
  // to the workspace, so it is never hidden behind the rail or timeline.
  function adoptCreditsIntoStage() {
    const stage = document.getElementById('oryn-stage');
    const credits = document.getElementById('cesium-credits');
    if (stage && credits && credits.parentElement !== stage)
      stage.append(credits);
  }

  // ORYN is an operations console: the engine's cinematic intel HUD and the
  // scope vignette stay available from the DISPLAY panel but start off, unless
  // a share link restored an explicit visual state.
  async function applyOperationalDefaults() {
    const shell = engine?.styleManager;
    if (!shell || shell.hasShareState) return;
    try {
      await shell.initialRestorePromise;
      await shell.applyVisualState({
        hud: { visible: false },
        scope: { enabled: false },
      });
      // Open on a regional overview rather than the engine's street-level
      // Austin approach: an operations console starts wide and zooms in.
      engine.applyCameraState(
        { lat: 31.5, lon: -98.5, alt: 3_200_000, heading: 0, pitch: -88 },
        2.2,
      );
    } catch (error) {
      console.warn('[ORYN] visual defaults', error);
    }
  }

  // ── Boot ────────────────────────────────────────────────────────────────
  renderNav();
  renderTopbarButtons();
  renderFeedSummary();
  syncSession();
  const storedPage = readStorage(PAGE_STORAGE_KEY);
  navigate(
    session.current() && storedPage && PAGES.has(storedPage)
      ? storedPage
      : 'map',
  );

  return Object.freeze({
    navigate,
    get engine() {
      return engine;
    },
    destroy() {
      clearInterval(clockTimer);
      activityUnsubscribe?.();
      engine?.destroy();
      layers.destroy();
      timeline.destroy();
    },
  });
}
