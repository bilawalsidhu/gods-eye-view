/**
 * ABYSS — Deep-Sea Exploration & Intelligence Layer for God's Eye View.
 * Integrates GEBCO bathymetry, NOAA PMEL hydrothermal vent catalogs,
 * and NOAA Ocean Exploration ROV expedition records.
 */

import {
  ABYSS_LAYER_ID,
  BATHYMETRY_PRODUCTS,
  BATHYMETRY_STOPS,
  formatDepth,
  formatCoordinates,
  formatVentActivity,
} from './model.js';
import { createAbyssRenderer } from './rendering.js';
import { createAbyssInteraction } from './interaction.js';
import { createAbyssSource } from './source.js';

export * from './model.js';
export * from './records.js';
export { createAbyssSource } from './source.js';

export function createAbyssLayer({
  source = createAbyssSource(),
  overlayHost,
  screenSpaceEventHandlerFactory,
} = {}) {
  let _viewer = null;
  let _enabled = false;
  let _loading = false;
  let _request = null;
  let _vents = [];
  let _dives = [];
  let _selectedFeature = null;
  let _selectedTrack = null;
  let _rowControlsListener = null;

  // Layer settings
  let _bathymetryProduct = BATHYMETRY_PRODUCTS.COLOUR_SHADED;
  let _bathymetryEnabled = true;
  let _subseaFeaturesFilter = 'all'; // 'all' | 'vents' | 'dives'

  let _renderer = null;
  let _interaction = null;

  function notifyControlsChanged() {
    _rowControlsListener?.(layer.getRowControls());
  }

  function handleFeatureSelected(record) {
    _selectedFeature = record;
    if (record.kind === 'dive' && record.cruiseDiveId) {
      // Lazy load ROV dive track
      source
        .getDiveTrack({ cruiseDiveId: record.cruiseDiveId })
        .then((track) => {
          if (_selectedFeature === record && track) {
            _selectedTrack = track;
            _renderer?.renderSelectedTrack(track);
            notifyControlsChanged();
          }
        })
        .catch(() => {});
    } else {
      _selectedTrack = null;
      _renderer?.clearSelectedTrack();
    }
    notifyControlsChanged();
  }

  function handleFeatureDeselected() {
    _selectedFeature = null;
    _selectedTrack = null;
    _renderer?.clearSelectedTrack();
    notifyControlsChanged();
  }

  const layer = {
    id: ABYSS_LAYER_ID,
    name: 'ABYSS — Deep Sea',
    icon: '🌊',
    source: 'GEBCO · NOAA PMEL · NOAA OER',
    showInTogglePanel: true,
    updateInterval: 300_000,

    init(viewer) {
      if (_viewer) throw new Error('Abyss layer is already initialized');
      _viewer = viewer;

      _renderer = createAbyssRenderer({ viewer });
      _renderer.init(viewer);

      _interaction = createAbyssInteraction({
        viewer,
        screenSpaceEventHandlerFactory,
        onSelect: handleFeatureSelected,
        onDeselect: handleFeatureDeselected,
      });
      _interaction.init(viewer);

      console.log('[Data:Abyss] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (!_viewer && viewer) layer.init(viewer);

      const config = source.getBathymetryConfig();
      _renderer?.setBathymetryVisible(_bathymetryEnabled, config);
      _renderer?.updateBathymetryLayer(config, _bathymetryProduct);
      _renderer?.setVisibility(true);
      _interaction?.setEnabled(true);

      // Perform initial update if datasets not yet loaded
      if (_vents.length === 0 && _dives.length === 0) {
        layer.update(viewer);
      }
      notifyControlsChanged();
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;

      _renderer?.setVisibility(false);
      _renderer?.clearSelectedTrack();
      _interaction?.setEnabled(false);

      _selectedFeature = null;
      _selectedTrack = null;
      notifyControlsChanged();
    },

    async update(viewer) {
      if (!_enabled) return false;

      _request?.abort();
      const request = new AbortController();
      _request = request;
      _loading = true;
      notifyControlsChanged();

      try {
        const [vents, dives] = await Promise.all([
          source.getVentsSnapshot({ signal: request.signal }),
          source.getExpeditionsSnapshot({ signal: request.signal }),
        ]);

        if (request.signal.aborted || _request !== request || !_enabled) {
          return false;
        }

        _vents = vents || [];
        _dives = dives || [];
        _loading = false;

        applyFeatureFilters();
        notifyControlsChanged();
        return true;
      } catch (err) {
        if (request.signal.aborted) return false;
        _loading = false;
        console.warn('[ABYSS:Layer] Update error:', err);
        notifyControlsChanged();
        return false;
      }
    },

    getRowControls() {
      const activeVentsCount = _vents.filter(
        (v) => v.activity === 'active',
      ).length;
      const totalSites = _vents.length + _dives.length;

      let detail = null;
      if (_selectedFeature) {
        const f = _selectedFeature;
        if (f.kind === 'vent') {
          detail = {
            id: f.id,
            title: f.name,
            badge: formatVentActivity(f.activity),
            depth: formatDepth(f.depthM),
            coordinates: formatCoordinates(f.lon, f.lat),
            setting: `Tectonic: ${f.tectonicSetting} · Spreading: ${f.spreadingRate}`,
            source: f.source,
            link: f.sourceUrl,
          };
        } else if (f.kind === 'dive') {
          detail = {
            id: f.id,
            title: f.name,
            badge: `ROV DIVE · ${f.platform || 'DEEP DISCOVERER'}`,
            depth: formatDepth(f.depthM),
            coordinates: formatCoordinates(f.lon, f.lat),
            vessel: `${f.vessel || 'NOAA Ship Okeanos Explorer'} (${f.year || 'Historical'})`,
            summary: f.summary || f.cruiseTitle,
            trackLength: _selectedTrack?.lengthM
              ? `${_selectedTrack.lengthM.toLocaleString()} m bottom track`
              : null,
            source: f.source,
            link: f.expeditionUrl || f.sourceUrl,
            mediaUrl: f.mediaUrl,
            archiveUrl: f.archiveUrl,
          };
        }
      }

      const chips = [
        {
          id: 'bathymetry-toggle',
          // i18n-ignore: layer chip status toggle
          label: _bathymetryEnabled ? 'Bathymetry ON' : 'Bathymetry OFF',
          active: _bathymetryEnabled,
          params: { bathymetryEnabled: !_bathymetryEnabled },
          // i18n-ignore: chip tooltip
          title: 'Toggle GEBCO bathymetry WMS layer',
        },
        {
          id: 'product-elevation',
          // i18n-ignore: GEBCO elevation product name
          label: 'Elevation',
          active: _bathymetryProduct === BATHYMETRY_PRODUCTS.COLOUR_SHADED,
          params: { bathymetryProduct: BATHYMETRY_PRODUCTS.COLOUR_SHADED },
          // i18n-ignore: chip tooltip
          title: 'GEBCO colour-shaded bathymetry',
        },
        {
          id: 'product-relief',
          // i18n-ignore: GEBCO shaded relief product name
          label: 'Shaded Relief',
          active: _bathymetryProduct === BATHYMETRY_PRODUCTS.SHADED_RELIEF,
          params: { bathymetryProduct: BATHYMETRY_PRODUCTS.SHADED_RELIEF },
          // i18n-ignore: chip tooltip
          title: 'GEBCO shaded relief',
        },
        {
          id: 'product-tid',
          // i18n-ignore: GEBCO TID grid product name
          label: 'Survey Type (TID)',
          active: _bathymetryProduct === BATHYMETRY_PRODUCTS.TID_GRID,
          params: { bathymetryProduct: BATHYMETRY_PRODUCTS.TID_GRID },
          // i18n-ignore: chip tooltip
          title: 'GEBCO Type Identifier Grid (direct survey vs interpolated)',
        },
        {
          id: 'filter-all',
          // i18n-ignore: filter category
          label: 'All Sites',
          active: _subseaFeaturesFilter === 'all',
          params: { subseaFeaturesFilter: 'all' },
          // i18n-ignore: chip tooltip
          title: 'Show hydrothermal vents and ROV dive sites',
        },
        {
          id: 'filter-vents',
          // i18n-ignore: filter category
          label: `Vents (${activeVentsCount} active)`,
          active: _subseaFeaturesFilter === 'vents',
          params: { subseaFeaturesFilter: 'vents' },
          // i18n-ignore: chip tooltip
          title: 'Show hydrothermal vents only',
        },
        {
          id: 'filter-dives',
          // i18n-ignore: filter category
          label: `ROV Dives (${_dives.length})`,
          active: _subseaFeaturesFilter === 'dives',
          params: { subseaFeaturesFilter: 'dives' },
          // i18n-ignore: chip tooltip
          title: 'Show NOAA ROV dive sites only',
        },
      ];

      if (_selectedFeature) {
        chips.push({
          id: 'clear-selection',
          // i18n-ignore: clear selection action
          label: 'Clear Selection',
          active: false,
          onClick: () => layer.clearSelection(),
          // i18n-ignore: chip tooltip
          title: 'Deselect current site',
        });
      }

      return {
        summary: {
          // i18n-ignore: layer title branding
          label: 'ABYSS — Deep Sea',
          coverage: 'Global Bathymetry & Discoveries',
          stats: `${totalSites} Exploration Sites (${_vents.length} Vents, ${_dives.length} Dives)`,
          detail,
          loading: _loading,
        },
        chips,
        legend: BATHYMETRY_STOPS.map((s) => ({
          color: s.color,
          label: s.label,
          // i18n-ignore: legend blurb
          blurb: `Depth: ${s.label}`,
        })),
        info: 'Bathymetry is draped over the reference ellipsoid (2D surface visualization), not physically rendered 3D underwater terrain mesh.',
        infoTitle: 'GEBCO Visualization Semantics',
      };
    },

    setLayerParams(params) {
      if (!params || typeof params !== 'object') return;

      if (typeof params.bathymetryEnabled === 'boolean') {
        _bathymetryEnabled = params.bathymetryEnabled;
        _renderer?.setBathymetryVisible(
          _bathymetryEnabled,
          source.getBathymetryConfig(),
        );
      }

      if (
        params.bathymetryProduct &&
        Object.values(BATHYMETRY_PRODUCTS).includes(params.bathymetryProduct)
      ) {
        _bathymetryProduct = params.bathymetryProduct;
        _renderer?.updateBathymetryLayer(
          source.getBathymetryConfig(),
          _bathymetryProduct,
        );
      }

      if (['all', 'vents', 'dives'].includes(params.subseaFeaturesFilter)) {
        _subseaFeaturesFilter = params.subseaFeaturesFilter;
        applyFeatureFilters();
      }

      notifyControlsChanged();
    },

    getParams() {
      return {
        bathymetryEnabled: _bathymetryEnabled,
        bathymetryProduct: _bathymetryProduct,
        subseaFeaturesFilter: _subseaFeaturesFilter,
      };
    },

    setRowControlsListener(listener) {
      _rowControlsListener = listener;
      if (listener) listener(layer.getRowControls());
    },

    getSelectedFeature() {
      return _selectedFeature;
    },

    clearSelection() {
      _interaction?.clearSelection();
      handleFeatureDeselected();
    },

    destroy() {
      layer.disable(_viewer);
      _renderer?.destroy();
      _renderer = null;
      _interaction?.destroy();
      _interaction = null;
      _viewer = null;
      _rowControlsListener = null;
    },
  };

  function applyFeatureFilters() {
    if (!_renderer) return;

    let filteredVents = _vents;
    let filteredDives = _dives;

    if (_subseaFeaturesFilter === 'vents') {
      filteredDives = [];
    } else if (_subseaFeaturesFilter === 'dives') {
      filteredVents = [];
    }

    _renderer.renderFeatures({ vents: filteredVents, dives: filteredDives });
  }

  return layer;
}
