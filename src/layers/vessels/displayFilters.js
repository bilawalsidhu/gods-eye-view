import { t } from '../../i18n/index.js';
import { createViewArea } from '../../data/viewArea.js';
import {
  normalizeVesselFilters,
  vesselMatchesFilters,
  vesselFilterType,
  vesselSpeedKn,
  selectVesselDisplay,
} from '../../data/vesselDisplayFilters.js';

/** Display state stays separate from authoritative AIS records and ingestion. */
export function createVesselDisplayFilters({ vesselState, parts, services }) {
  const { state } = vesselState;
  let filters = normalizeVesselFilters(),
    allowed = null,
    listener = null,
    openPanel = null;
  const view = createViewArea(),
    candidates = [];
  const get = () => normalizeVesselFilters({}, filters);
  function prepare() {
    const camera = state.viewer?.camera;
    if (!camera) {
      allowed = null;
      return;
    }
    view.update(camera);
    const height = camera.positionCartographic?.height ?? 0;
    const pixels = state.viewer.scene?.canvas?.clientHeight || 900;
    const metresPerPixel =
      (2 *
        Math.max(0, height) *
        Math.tan((camera.frustum?.fovy || Math.PI / 3) / 2)) /
      pixels;
    candidates.length = 0;
    for (const record of state.records.all) {
      const position = parts.rendering.getVisual(record).position;
      const protectedContact = record === state.selectedRecord;
      if (!position || (!protectedContact && !view.contains(position)))
        continue;
      candidates.push({ record, position, protected: protectedContact });
    }
    allowed = selectVesselDisplay(candidates, {
      filters,
      altitudeM: height,
      metresPerPixel,
    });
  }
  function allows(record) {
    return (
      record === state.selectedRecord ||
      (vesselMatchesFilters(record, filters) &&
        (!allowed || allowed.has(record)))
    );
  }
  function set(patch) {
    filters = normalizeVesselFilters(patch, filters);
    allowed = null;
    parts.rendering?.updateVisibility(true);
    services.render?.governorRequestRender?.('vessel-display-filters');
    listener?.();
  }
  function getVesselList({ search = '', page = 0, pageSize = 50 } = {}) {
    const needle = String(search).trim().toLowerCase();
    const rows = [];
    for (const record of state.records.all) {
      if (
        !record.mmsi ||
        (!vesselMatchesFilters(record, filters) &&
          record !== state.selectedRecord)
      )
        continue;
      if (
        needle &&
        ![
          record.name,
          record.mmsi,
          record.imo,
          record.destination,
          record.type,
          vesselFilterType(record.type),
        ].some((value) =>
          String(value || '')
            .toLowerCase()
            .includes(needle),
        )
      )
        continue;
      rows.push({
        id: String(record.mmsi),
        label: String(record.name || '').trim() || String(record.mmsi),
        type: vesselFilterType(record.type),
        speedKn: vesselSpeedKn(record),
        destination: record.destination || '',
        selected: record === state.selectedRecord,
        visible: parts.rendering.getVisual(record).billboard?.show === true,
      });
    }
    rows.sort(
      (a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
    );
    pageSize = Math.max(1, Math.min(100, Math.floor(pageSize) || 50));
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    page = Math.max(0, Math.min(pages - 1, Math.floor(page) || 0));
    return {
      total: state.records.all.length,
      matching: rows.length,
      page,
      pages,
      rows: rows.slice(page * pageSize, (page + 1) * pageSize),
    };
  }
  const toggle = (key) => ({ displayFilters: { [key]: !filters[key] } });
  return {
    get,
    set,
    prepare,
    allows,
    resetVisuals() {
      allowed = null;
      candidates.length = 0;
    },
    methods: {
      getParams: () => ({ displayFilters: get() }),
      setParams(params = {}) {
        if (params.displayFilters) set(params.displayFilters);
      },
      getVesselList,
      attachVesselPanel(handler) {
        openPanel = typeof handler === 'function' ? handler : null;
      },
      setRowControlsListener(handler) {
        listener = handler;
      },
      getRowControls() {
        return {
          chips: [
            {
              id: 'vessel-declutter',
              label: t('Declutter'),
              active: filters.declutterEnabled,
              params: toggle('declutterEnabled'),
            },
            {
              id: 'vessel-underway',
              label: t('Underway only'),
              active: filters.underwayOnly,
              params: toggle('underwayOnly'),
            },
            {
              id: 'vessel-types',
              label: t('Vessel types'),
              active: filters.typeFilterEnabled,
              params: toggle('typeFilterEnabled'),
            },
            {
              id: 'vessel-speed',
              label: t('Speed range'),
              active: filters.speedFilterEnabled,
              params: toggle('speedFilterEnabled'),
            },
            {
              id: 'vessel-list',
              label: t('List & filters'),
              active: false,
              onClick: () => openPanel?.(),
            },
          ],
        };
      },
    },
  };
}
