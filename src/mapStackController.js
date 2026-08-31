import * as Cesium from 'cesium';
import { governorRequestRender } from './renderGovernor.js';

export const MAP_STACKS = [
  {
    id: 'photoreal',
    label: 'Google 3D',
    shortLabel: '3D',
    kind: 'photoreal',
    requiresIon: false,
  },
  {
    id: 'bing-aerial',
    label: 'Bing Aerial',
    shortLabel: 'Aerial',
    kind: 'ion',
    style: Cesium.IonWorldImageryStyle.AERIAL,
    requiresIon: true,
  },
  {
    id: 'bing-labels',
    label: 'Bing Labels',
    shortLabel: 'Labels',
    kind: 'ion',
    style: Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS,
    requiresIon: true,
  },
  {
    id: 'esri-imagery',
    label: 'Esri Satellite',
    shortLabel: 'SAT',
    kind: 'esri-imagery',
    requiresIon: false,
  },
  {
    id: 'osm',
    label: 'OSM',
    shortLabel: 'OSM',
    kind: 'osm',
    requiresIon: false,
  },
];

const DEFAULT_OSM_CREDIT = '© OpenStreetMap contributors';

// Esri World Imagery — the keyless satellite basemap and the default keyless
// landing (a spy-satellite simulator should open on satellite imagery, not a
// street map). The classic ArcGIS Online tile service answers without a key;
// attribution is required and the provider carries the service's own credit
// line. Terms note in DATA_SOURCES.md.
const ESRI_WORLD_IMAGERY_URL =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
const ESRI_IMAGERY_CREDIT =
  'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
// The on-screen notice Esri requires when a third-party library draws its
// service. Rendered via an explicit static credit (see _syncEsriAttribution) —
// the provider's own `credit` option is ignored for tiled ArcGIS servers.
const ESRI_ATTRIBUTION_HTML =
  '<a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a>';

// Keyless global ellipsoidal terrain (Re:Earth Terrain / Mapterhorn, CC BY 4.0,
// EGM2008 geoid via NGA) — quantized-mesh 1.0, `ellipsoid` data-type. Fixes
// regime C (keyless globe stacks previously rendered a flat
// EllipsoidTerrainProvider — see docs/superpowers/specs/2026-07-05-entity-height-datum-design.md
// §1a). Constructed via `.fromUrl()`, never a hand-built `{z}/{x}/{y}.terrain`
// URL (review correction, spec §1a).
const REEARTH_TERRAIN_URL = 'https://terrain.reearth.land/cesium-mesh/ellipsoid';

/**
 * Controls the active globe/map stack. Google Photorealistic 3D Tiles remain
 * the cinematic default, while Cesium ion world imagery and OSM run as globe
 * imagery stacks.
 */
export class MapStackController {
  constructor(viewer, {
    googleTileset = null,
    cesiumToken = '',
    initialStack = 'photoreal',
    onChange = null,
    onError = null,
  } = {}) {
    this.viewer = viewer;
    this.googleTileset = googleTileset;
    this.cesiumToken = String(cesiumToken || '').trim();
    this._onChange = onChange;
    this._onError = onError;
    this._activeId = googleTileset ? initialStack : 'esri-imagery';
    this._imageryLayer = null;
    this._activeImageryProvider = null;
    this._removeImageryErrorListener = null;
    this._esriFallbackPending = false;
    this._imageryProviders = new Map();
    this._isSwitching = false;
    this._lastError = null;
    // Tracks which terrain PROVIDER is actually installed on the scene, not
    // just an ion-available boolean: 'world' (Cesium World Terrain, ion
    // token), 'keyless' (Re:Earth or its Ellipsoid fallback), or null (never
    // set yet — Cesium's own startup default). Using a tri-state here (rather
    // than the `enabled` boolean `_setWorldTerrainEnabled` receives) matters
    // because both the "never set" and "keyless" states pass `enabled=false`;
    // collapsing them to a boolean would make the first real keyless switch
    // a no-op against the initial `false` default and leave Cesium's built-in
    // provider in place instead of installing Re:Earth terrain.
    this._terrainMode = null;
    // Cache of the constructed keyless Re:Earth CesiumTerrainProvider, so
    // repeat switches into a keyless globe stack don't refetch `layer.json`.
    // Lives independently of `_switchGen` — construction is async and racy
    // switches are guarded where it's awaited (`_setWorldTerrainEnabled`).
    this._reearthTerrainProvider = null;
    // Monotonic switch counter. setStack() awaits network-bound provider
    // creation; a rapid A→B switch where A (e.g. slow Bing) resolves AFTER B
    // (fast OSM) would otherwise revert the user's last choice (M7). Each call
    // captures a generation and aborts its own commit once superseded.
    this._switchGen = 0;

    if (!this.getStack(this._activeId) || !this.isStackAvailable(this._activeId)) {
      this._activeId = googleTileset ? 'photoreal' : 'esri-imagery';
    }
  }

  getStacks() {
    return MAP_STACKS.map((stack) => {
      const available = this.isStackAvailable(stack.id);
      return {
        ...stack,
        available,
        // Why this stack can't be picked, from the ONE place that decides it.
        // A stack can be unavailable for reasons other than a missing ion
        // token (photoreal is unavailable when the Google tileset failed to
        // load), so callers must not infer the reason from `available` alone.
        unavailableReason: available ? null : this._unavailableReason(stack),
      };
    });
  }

  /**
   * Human-readable reason a stack can't be activated. Shared by `getStacks()`
   * and `setStack()` so the tooltip and the toast never drift apart.
   * @param {object} stack - Stack descriptor.
   * @returns {string}
   */
  _unavailableReason(stack) {
    return stack?.requiresIon
      ? 'Cesium ion token required for Bing stacks'
      : `${stack?.label || 'This map stack'} is unavailable`;
  }

  getStack(id) {
    return MAP_STACKS.find((stack) => stack.id === id) || null;
  }

  getActiveId() {
    return this._activeId;
  }

  /**
   * Monotonic id of the most recently STARTED switch.
   *
   * A switch is only superseded by another `setStack()` — nothing else moves
   * this number — so a caller that must know whether the globe it is looking
   * at is still the one IT asked for can compare this across its own await.
   * Unchanged (or advanced by exactly its own call) means no newer switch has
   * claimed the globe.
   * @returns {number}
   */
  getSwitchGeneration() {
    return this._switchGen;
  }

  getActiveStack() {
    return this.getStack(this._activeId);
  }

  isStackAvailable(id) {
    const stack = this.getStack(id);
    if (!stack) return false;
    if (stack.kind === 'photoreal') return !!this.googleTileset;
    if (stack.requiresIon) return !!this.cesiumToken;
    return true;
  }

  async setStack(id, { silent = false } = {}) {
    const stack = this.getStack(id) || this.getStack('photoreal');
    if (!stack) return null;

    if (!this.isStackAvailable(stack.id)) {
      const message = this._unavailableReason(stack);
      this._lastError = message;
      this._onError?.(message, stack);
      return this.getState();
    }

    const gen = ++this._switchGen;
    this._isSwitching = true;
    this._lastError = null;
    if (!silent) this._emitChange('switching');

    try {
      let activation = null;
      if (stack.kind === 'photoreal') {
        await this._activatePhotoreal(gen);
      } else {
        activation = await this._activateGlobeStack(stack, gen);
      }
      // A newer switch started while we were awaiting the provider — that call
      // owns the final state now, so don't commit ours or emit a stale 'ready'.
      if (gen !== this._switchGen) return this.getState();
      this._activeId = activation?.effectiveStackId || stack.id;
      if (activation?.fallbackMessage) {
        this._lastError = activation.fallbackMessage;
        this._onError?.(activation.fallbackMessage, stack);
      }
      // Show/hide of tilesets + imagery swaps need a frame in idle mode;
      // subsequent tile loads self-request via Cesium. (perf wave 2)
      governorRequestRender('map-stack');
      if (!silent) this._emitChange('ready');
    } catch (error) {
      if (gen !== this._switchGen) return this.getState();
      const message = error?.message || String(error);
      this._lastError = message;
      this._onError?.(message, stack);
      if (this.googleTileset) {
        await this._activatePhotoreal(gen);
        if (gen !== this._switchGen) return this.getState();
        this._activeId = 'photoreal';
      }
      if (!silent) this._emitChange('error');
    } finally {
      // Only the latest switch clears the switching flag; a superseded call
      // must not stomp a newer switch that is still in progress.
      if (gen === this._switchGen) this._isSwitching = false;
    }

    return this.getState();
  }

  getState(status = this._isSwitching ? 'switching' : 'ready') {
    return {
      activeId: this._activeId,
      activeStack: this.getActiveStack(),
      stacks: this.getStacks(),
      status,
      lastError: this._lastError,
      hasCesiumIonToken: !!this.cesiumToken,
    };
  }

  async _activatePhotoreal(gen) {
    this._removeImageryLayer();
    this._syncEsriAttribution(null); // Esri is no longer on screen.
    if (this.googleTileset) this.googleTileset.show = true;
    this.viewer.scene.globe.show = false;
    // Terrain is left UNTOUCHED here. The photoreal globe is hidden
    // (`globe.show = false`), so the terrain provider is inert — it renders and
    // streams nothing. Routing this through `_setWorldTerrainEnabled(false)`
    // would make the DEFAULT startup stack await a keyless Re:Earth `layer.json`
    // fetch it can't use, delaying photoreal boot on a slow/blocked network and
    // (on failure) caching the flat `EllipsoidTerrainProvider` fallback for
    // later OSM switches. The Re:Earth fetch is therefore lazy: it happens on
    // the first switch to an actual globe stack (`_activateGlobeStack`).
    // `_terrainMode` is intentionally not changed — every globe-stack transition
    // re-derives the correct provider from it (null/'world'/'keyless'), so
    // leaving it as-is keeps the next switch correct without a photoreal fetch.
    void gen;
  }

  async _activateGlobeStack(stack, gen) {
    const resolution = await this._getImageryProvider(stack);
    // A newer switch started while the provider was resolving — don't touch the
    // scene's imagery layers, the winning switch already owns them (M7).
    if (gen != null && gen !== this._switchGen) return;
    this._removeImageryLayer();

    this._imageryLayer = new Cesium.ImageryLayer(resolution.provider);
    this._activeImageryProvider = resolution.provider;
    this.viewer.imageryLayers.add(this._imageryLayer, 0);
    this._syncEsriAttribution(resolution.effectiveStackId);
    this._watchEsriProvider(resolution, gen);

    if (this.googleTileset) this.googleTileset.show = false;
    this.viewer.scene.globe.show = true;
    await this._setWorldTerrainEnabled(!!this.cesiumToken, gen);
    return resolution;
  }

  /**
   * Show or hide the required "Powered by Esri" notice with the Esri layer's
   * own lifecycle.
   *
   * This cannot ride on the provider's `credit` option: Cesium IGNORES that
   * option for tiled ArcGIS MapServer sources, so passing it there displays
   * nothing and the app would be using the service without the attribution
   * Esri requires of third-party libraries. It is an ON-SCREEN credit (not the
   * lightbox, where per-layer data credits live) because that is what the
   * requirement asks for, and it is removed when another stack takes over so
   * the globe never claims a source it is not showing.
   */
  _syncEsriAttribution(activeStackId) {
    const creditDisplay = this.viewer?.scene?.frameState?.creditDisplay;
    if (!creditDisplay) return;
    const wanted = activeStackId === 'esri-imagery';
    if (wanted === !!this._esriCreditShown) return;
    if (!this._esriCredit) {
      this._esriCredit = new Cesium.Credit(ESRI_ATTRIBUTION_HTML, true);
    }
    try {
      if (wanted) creditDisplay.addStaticCredit(this._esriCredit);
      else creditDisplay.removeStaticCredit(this._esriCredit);
      this._esriCreditShown = wanted;
    } catch {
      // A Cesium build without static-credit removal must not break switching.
    }
  }

  async _getImageryProvider(stack) {
    if (this._imageryProviders.has(stack.id)) {
      return this._imageryProviders.get(stack.id);
    }

    let provider;
    let effectiveStackId = stack.id;
    let fallbackMessage = null;
    if (stack.kind === 'ion') {
      provider = await Cesium.createWorldImageryAsync({ style: stack.style });
    } else if (stack.kind === 'esri-imagery') {
      try {
        provider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_WORLD_IMAGERY_URL, {
          credit: ESRI_IMAGERY_CREDIT,
          enablePickFeatures: false,
        });
      } catch (error) {
        // The keyless DEFAULT landing must never strand a first run on a blank
        // globe because Esri is unreachable — fall back to OSM tiles for this
        // session. (The fallback is cached under this stack id like any other
        // provider, so the session won't re-probe Esri; a restart does.)
        console.warn('[MapStack] Esri World Imagery unavailable, falling back to OSM:', error?.message || error);
        provider = new Cesium.OpenStreetMapImageryProvider({
          url: 'https://tile.openstreetmap.org/',
          credit: DEFAULT_OSM_CREDIT,
        });
        effectiveStackId = 'osm';
        fallbackMessage = 'Esri Satellite is unavailable; using OSM';
      }
    } else if (stack.kind === 'osm') {
      provider = new Cesium.OpenStreetMapImageryProvider({
        url: 'https://tile.openstreetmap.org/',
        credit: DEFAULT_OSM_CREDIT,
      });
    } else {
      throw new Error(`Unsupported map stack: ${stack.id}`);
    }

    const resolution = { provider, effectiveStackId, fallbackMessage };
    this._imageryProviders.set(stack.id, resolution);
    if (effectiveStackId === 'osm' && !this._imageryProviders.has('osm')) {
      this._imageryProviders.set('osm', { provider, effectiveStackId: 'osm', fallbackMessage: null });
    }
    return resolution;
  }

  /**
   * Esri provider construction can succeed while its first tile requests fail.
   * Two failures for the active provider trigger the same truthful OSM fallback
   * as a construction failure; one transient error is left to Cesium's retry.
   */
  _watchEsriProvider(resolution, gen) {
    if (resolution.effectiveStackId !== 'esri-imagery') return;
    const errorEvent = resolution.provider?.errorEvent;
    if (!errorEvent?.addEventListener) return;
    let failures = 0;
    this._removeImageryErrorListener = errorEvent.addEventListener((error) => {
      if (gen !== this._switchGen || this._activeImageryProvider !== resolution.provider) return;
      const retryCount = Number(error?.timesRetried);
      failures = Number.isInteger(retryCount) && retryCount >= 0
        ? Math.max(failures + 1, retryCount + 1)
        : failures + 1;
      if (failures < 2 || this._esriFallbackPending) return;
      this._esriFallbackPending = true;
      const message = 'Esri Satellite tile requests failed; using OSM';
      this._onError?.(message, this.getStack('esri-imagery'));
      void this.setStack('osm', { silent: true }).then((state) => {
        if (state?.activeId === 'osm') {
          this._lastError = message;
          this._emitChange('error');
        }
      }).finally(() => {
        this._esriFallbackPending = false;
      });
    });
  }

  _removeImageryLayer() {
    if (this._removeImageryErrorListener) {
      this._removeImageryErrorListener();
      this._removeImageryErrorListener = null;
    }
    if (!this._imageryLayer) return;
    this.viewer.imageryLayers.remove(this._imageryLayer, false);
    this._imageryLayer = null;
    this._activeImageryProvider = null;
  }

  /**
   * Sets the scene's terrain provider for the current globe stack.
   *
   * `enabled` selects Cesium World Terrain (ion token present — regime B,
   * unchanged). Disabled/keyless (regime C: OSM or any globe stack without an
   * ion token) now tries the keyless Re:Earth ellipsoidal terrain instead of
   * the flat `EllipsoidTerrainProvider`, falling back to the flat provider
   * (today's behavior) if construction fails — no worse than before this fix.
   *
   * `CesiumTerrainProvider.fromUrl()` is async (fetches `layer.json`), so this
   * method is async-safe: `gen` is the caller's switch generation (from
   * `setStack`'s `_switchGen`, threaded through `_activatePhotoreal` /
   * `_activateGlobeStack`, mirroring the M7 pattern in `_activateGlobeStack`
   * for imagery providers). If a newer switch starts while the Re:Earth
   * fetch is in flight, this call's result is discarded instead of
   * clobbering the newer switch's terrain.
   * @param {boolean} enabled
   * @param {number} [gen] — switch generation this call belongs to
   */
  async _setWorldTerrainEnabled(enabled, gen) {
    const targetMode = enabled ? 'world' : 'keyless';
    if (targetMode === this._terrainMode) return;
    if (enabled) {
      this.viewer.scene.setTerrain(Cesium.Terrain.fromWorldTerrain({
        requestVertexNormals: true,
      }));
    } else {
      const provider = await this._getKeylessTerrainProvider();
      // A newer switch started while the Re:Earth layer.json fetch was in
      // flight — that call owns terrain now; don't stomp it (M7 pattern).
      if (gen != null && gen !== this._switchGen) return;
      this.viewer.terrainProvider = provider;
    }
    this._terrainMode = targetMode;
  }

  /**
   * Resolves (and caches) the keyless terrain provider for globe stacks
   * without an ion token: Re:Earth ellipsoidal quantized-mesh terrain, or
   * `EllipsoidTerrainProvider` (flat — current/prior behavior) if the
   * Re:Earth endpoint can't be constructed. Never throws.
   * @returns {Promise<Cesium.TerrainProvider>}
   */
  async _getKeylessTerrainProvider() {
    if (this._reearthTerrainProvider) return this._reearthTerrainProvider;
    try {
      this._reearthTerrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(REEARTH_TERRAIN_URL);
    } catch (error) {
      console.warn('[mapStackController] Re:Earth terrain unavailable, falling back to flat ellipsoid terrain:', error);
      this._reearthTerrainProvider = new Cesium.EllipsoidTerrainProvider();
    }
    return this._reearthTerrainProvider;
  }

  _emitChange(status) {
    this._onChange?.(this.getState(status));
  }
}
