import { cameraOf } from '../../render/rendererOf.js';
import { entityFollowTarget, stopFollowing } from '../../data/followed.js';
import { satelliteClassText } from '../../data/satelliteClass.js';
import { fromDegrees, fromDegreesInto } from '../../geo/ellipsoid.js';
import { clone, distance, scale } from '../../geo/vector.js';
import { t } from '../../i18n/index.js';
import { formatQuantity, unitLabel } from '../../ui/unitLabels.js';
import {
  CONTEXT_REFRESH_INTERVAL_MS,
  HIGH_ORBIT_ALTITUDE_M,
  ISS_NORAD,
  STATIONS,
  TRACK_VIEW_FROM_HIGH_SCALE,
  TRACK_VIEW_FROM_LEO,
  TRACKED_ORBIT_COLOR,
} from './policy.js';
import { entityRecord, readEntityRecord } from '../../data/entityRecords.js';
import { modelFor } from './stationModels.js';

export function createTracking({ state: layerState, services, parts, source }) {
  const { clearFocusTarget } = services.focus;
  const {
    clearTrackedSubjectContext,
    getContextStore,
    refreshTrackedSubjectContext,
    selectTrackedSubjectContext,
  } = services.context;
  const { refreshTrackedReadout } = services.readout;

  function _normalizeTrackedNorad(candidate) {
    const numeric = Number(candidate);
    if (!Number.isFinite(numeric)) return null;
    const rounded = Math.trunc(numeric);
    return rounded > 0 ? rounded : null;
  }

  function _emitAwarenessEvent(type, detail) {
    if (
      typeof window === 'undefined' ||
      !window.dispatchEvent ||
      typeof CustomEvent === 'undefined'
    )
      return;
    window.dispatchEvent(new CustomEvent(type, { detail }));
  }

  function _applyPendingTrackingRestore() {
    const pending = layerState._pendingTrackingRestore;
    if (
      !pending ||
      pending.generation !== layerState._trackingIntentGeneration ||
      !layerState._enabled
    )
      return false;
    if (
      !layerState._viewer ||
      !layerState._catalog.has(pending.id) ||
      !layerState._points.has(pending.id)
    )
      return false;
    layerState._pendingTrackingRestore = null;
    _trackSatellite(pending.id, { origin: pending.origin });
    return layerState._trackedNorad === pending.id;
  }

  function _cancelPendingTrackingRestore() {
    layerState._trackingIntentGeneration += 1;
    layerState._pendingTrackingRestore = null;
  }

  /**
   * Stop tracking the currently followed satellite.
   * @param {boolean} [skipViewerUntrack=false] - When ANOTHER layer just grabbed
   *   the follow-camera (viewer.trackedEntityChanged), tear down our own state
   *   but do NOT clear viewer.trackedEntity — the new owner controls it now,
   *   and clearing it would yank the camera off their target (mirror of flights).
   */

  function _clearTracking(
    skipViewerUntrack = false,
    { origin = 'programmatic' } = {},
  ) {
    // Untracking dissolves the cluster: every companion returns to its own
    // ambient label on the next collection.
    layerState._dockedCompanions = new Set();
    layerState._lastDockedScanMs = Number.NEGATIVE_INFINITY;
    if (!layerState._trackedNorad) {
      clearFocusTarget('satellites');
      parts.labels._syncIssOverlay();
      return;
    }
    const clearedNorad = layerState._trackedNorad;
    clearFocusTarget('satellites', layerState._trackedNorad);

    // Re-show the dot (hidden while the tracked dot drew it) and
    // restore the original group palette from the shared style table (WS-D3)
    parts.rendering._restorePoint(
      layerState._trackedNorad,
      parts.controls._pointStyleFor(
        layerState._trackedNorad,
        layerState._catalog.get(layerState._trackedNorad)?.group,
      ),
      // Back to its class's visibility: a hidden class stays hidden.
      parts.controls._classVisible(layerState._trackedNorad),
    );

    // Invalidate the per-frame tracked-position cache (WS-D2)
    layerState._trackedFrameNumber = -1;
    layerState._trackedFrameGeo = null;

    // Remove the tracked dot and orbit path (unless ISS — keep its path)
    if (layerState._trackedNorad !== ISS_NORAD) {
      parts.rendering._hideOrbitPath(layerState._trackedNorad);
    }
    if (layerState._viewer && !skipViewerUntrack)
      stopFollowing(layerState._viewer);
    layerState._followTarget = null;
    if (layerState._trackedEntity) {
      parts.rendering._removeTrackedEntity(layerState._trackedEntity);
      layerState._trackedEntity = null;
    }
    layerState._trackedNorad = null;
    layerState._trackedDockedToStation = null;
    layerState._trackedDockedToIss = false;
    parts.controls._syncIssOrbit?.();
    // A held Cockpit subject that stops being tracked gets its marks back.
    if (layerState._cockpitSubjectNorad !== null)
      parts.cockpit?._syncCockpitSubjectVisuals();
    parts.labels._syncIssOverlay();
    clearTrackedSubjectContext('satellites');
    layerState._contextRefreshedAtMs = 0;
    _emitAwarenessEvent('gev:awareness-subject-cleared', {
      layerId: 'satellites',
      id: clearedNorad,
      origin,
    });
  }

  /**
   * Get the tracked satellite's geodetic position, propagated at most once per
   * rendered frame (WS-D2). All tracked-satellite consumers (the tracked dot
   * and follow camera, host model, the hidden dot, getTrackedInfo) share this
   * single `new Date()` epoch per frame, so they can never diverge by the old
   * 200ms throttle. The matching ECEF position is left in
   * `_trackedFrameCartesian`. SGP4 for one satellite per frame is cheap.
   * @returns {{ longitude: number, latitude: number, altitude: number }|null}
   */

  function _getTrackedFramePosition() {
    if (layerState._trackedNorad === null) return null;
    const sat = layerState._catalog.get(layerState._trackedNorad);
    if (!sat) return null;

    const frameNumber = parts.rendering._drawnFrameNumber();
    if (
      frameNumber === -1 ||
      frameNumber !== layerState._trackedFrameNumber ||
      layerState._trackedFrameGeo === null
    ) {
      const atMs = layerState._trackedFrameNowForTest
        ? layerState._trackedFrameNowForTest()
        : layerState.now();
      const pos = parts.orbits.propagatePosition(sat.satrec, new Date(atMs));
      if (!pos) return layerState._trackedFrameGeo; // propagation hiccup — keep last good sample
      // The time the sample is at: the world clock's, not the wall clock's.
      pos.atMs = atMs;
      layerState._trackedFrameGeo = pos;
      fromDegreesInto(
        pos.longitude,
        pos.latitude,
        pos.altitude,
        layerState._trackedFrameCartesian,
      );
      layerState._trackedFrameNumber = frameNumber;
      // Throttled inside; membership changes are rare, so resync the ISS ambient
      // gate only when the cluster actually changed.
      const clusterChanged = parts.labels._refreshDockedCompanions(
        layerState._trackedFrameNowForTest
          ? layerState._trackedFrameNowForTest()
          : Date.now(),
      );
      _updateTrackedSatelliteLabelModel();
      // The card and the context slot describe the same satellite — keep them
      // together so voice never narrates a fix the card has already replaced.
      _refreshTrackedSubjectContext();
      if (clusterChanged) parts.labels._syncIssOverlay();
      const name = sat.name?.trim() || `SAT-${layerState._trackedNorad}`;
      const altitudeText = `${Math.round(pos.altitude / 1000)} km · NORAD ${layerState._trackedNorad}`;
      const labelWidthPx =
        Math.max(name.length, altitudeText.length) * 7.8 + 20;
      const labelHeightPx = 2 * 13 + 12;
      const trackedPointDiameterPx = 14 + 4; // point plus its 2 px outline on both sides
      // Exact SGP4 frame cache only: dot, host readout, camera, and focus rectangle all
      // share one epoch, avoiding a second propagation phase and its old jitter.
      parts.rendering._publishTrackedFocus({
        ownerLayer: 'satellites',
        id: layerState._trackedNorad,
        displayPosition: layerState._trackedFrameCartesian,
        widthPx: Math.max(trackedPointDiameterPx, Math.min(260, labelWidthPx)),
        // Union of the 14 px point and the two-line label shifted 18 px upward.
        heightPx: trackedPointDiameterPx + 18 + labelHeightPx,
      });
    }
    return layerState._trackedFrameGeo;
  }

  /** Cached ECEF display point only; never propagates a fresh SGP4 sample. */

  function _trackedDisplayCached() {
    return layerState._trackedFrameGeo
      ? layerState._trackedFrameCartesian
      : null;
  }

  /**
   * Describe the tracked satellite for the shared context slot the voice tools
   * read. Values come from the live per-frame propagation, not a selection-time
   * snapshot, so a long follow never narrates a position the satellite has left.
   * @param {number} noradId Catalog identity.
   * @param {{latitude: number, longitude: number, altitude: number}|null} [position]
   *   Explicit position; defaults to the current per-frame propagation.
   * @returns {object|null} Context metadata, or null when the satellite is gone.
   */

  function _contextSubjectMetadata(noradId, position = null) {
    const sat = layerState._catalog.get(noradId);
    if (!sat) return null;
    const pos = position || _getTrackedFramePosition();
    if (!pos) return null;
    const name = sat.name?.trim() || `SAT-${noradId}`;
    const altitudeKm = Number.isFinite(pos.altitude)
      ? Math.round(pos.altitude / 1000)
      : null;
    return {
      id: String(noradId),
      layerId: 'satellites',
      layerName: 'Satellites',
      source: 'CelesTrak',
      label: name,
      latitude: pos.latitude,
      longitude: pos.longitude,
      // Flat text only: the voice payload compacts properties through a string
      // cleaner that drops nested objects.
      properties: {
        name,
        operator: '',
        noradId: String(noradId),
        class: satelliteClassText(sat.satelliteClass, sat.group, {
          isIss: noradId === ISS_NORAD,
          localize: false,
        }),
        altitude:
          altitudeKm === null ? '' : `${altitudeKm.toLocaleString('en-US')} km`,
      },
    };
  }

  /**
   * Reconcile the published subject with a freshly rebuilt catalog.
   *
   * A rebuild (dense↔core toggle, TLE refresh) clears and repopulates the
   * catalog, so the tracked satellite's entry is a NEW object with a new satrec.
   * A surviving subject is simply re-resolved against it. A subject that is GONE
   * must release the slot: the per-frame refresh cannot do this itself, because
   * `_getTrackedFramePosition` returns early once the satellite has no catalog
   * entry — so without this the record would linger and voice would narrate a
   * satellite the catalog no longer carries, frozen at its last position.
   *
   * Releasing is gated on PROOF. The subject is preserved unless it is absent
   * from a catalog that is both complete (`accepted`, no failed CelesTrak group)
   * and applicable (dense settled, when dense is the requested catalog). A
   * partial refresh, a failed dense load, or an empty catalog is unproven
   * absence, and unproven absence is not absence — the same honesty rule the
   * tracking-restore path already applies.
   * @returns {Promise<void>} Resolves once the applicable catalog has settled.
   */

  async function _reconcileTrackedSubjectContext() {
    const subjectAtStart = layerState._trackedNorad;
    if (subjectAtStart === null) return;
    // Dense extras land AFTER the core rebuild resolves. Deciding before they
    // settle called a dense subject missing and deleted its record; the record
    // then stayed gone, because a refresh can update an existing record but
    // cannot recreate one.
    const denseSettlement =
      layerState._params.catalog === 'dense'
        ? layerState._denseLoadPromise
        : null;
    if (denseSettlement) {
      try {
        await denseSettlement;
      } catch {
        // A failed dense load proves nothing about the subject; fall through and
        // let the outcome check below preserve it.
      }
    }
    // The operator may have moved on while we waited.
    if (layerState._trackedNorad !== subjectAtStart) return;

    const metadata = _contextSubjectMetadata(subjectAtStart);
    if (metadata) {
      const store = getContextStore();
      const key = String(subjectAtStart);
      if (store.entities.has(key)) {
        refreshTrackedSubjectContext(metadata);
      } else if (!store.selectedEntityId) {
        // The record was dropped while the subject was briefly unresolvable.
        // Restore it — but only into an EMPTY slot: a satellite reappearing must
        // never yank the subject away from something the operator selected since.
        selectTrackedSubjectContext(metadata);
      }
      layerState._contextRefreshedAtMs = Date.now();
      return;
    }

    // Absence only counts when EVERY catalog that could carry the subject
    // actually loaded. Unproven absence is not absence — the same honesty rule
    // the tracking-restore path applies.
    //
    // Deliberately NOT scoped to the group the subject was last seen in:
    // CelesTrak reclassifies satellites between groups, so a subject missing
    // from its old group may simply have moved to one that failed this refresh.
    // Believing the old group alone would drop it. Any failed or empty group is
    // therefore a reason to wait — and `accepted` already means every group
    // returned entries.
    if (layerState._catalog.size === 0) return;
    if (layerState._lastTrackingRefreshOutcome?.status !== 'accepted') return;
    // Dense is a potential carrier too whenever it was REQUESTED — and the
    // request is read from `denseSettlement`, captured before the await, not
    // from `_params.catalog` now. A failed dense load reverts the mode to 'core'
    // as part of settling (an ACTIVE chip over an empty sky would be a lie), so
    // by the time we get here the intent that made dense a carrier has been
    // erased. Re-reading it would skip this guard on exactly the runs that need
    // it and delete a subject the dense catalog might have carried.
    if (denseSettlement && layerState._denseStatus !== 'ready') return;
    clearTrackedSubjectContext('satellites');
    layerState._contextRefreshedAtMs = 0;
  }

  /**
   * Keep the shared context slot current with the tracked satellite, on the
   * propagation beat rather than the frame clock.
   * @returns {void}
   */

  function _refreshTrackedSubjectContext() {
    if (layerState._trackedNorad === null) return;
    const now = Date.now();
    if (now - layerState._contextRefreshedAtMs < CONTEXT_REFRESH_INTERVAL_MS)
      return;
    layerState._contextRefreshedAtMs = now;
    refreshTrackedSubjectContext(
      _contextSubjectMetadata(layerState._trackedNorad),
    );
  }

  function _updateTrackedSatelliteLabelModel(fallbackAltitudeM = null) {
    if (!layerState._trackedEntity || layerState._trackedNorad === null) return;
    const sat = layerState._catalog.get(layerState._trackedNorad);
    const title = sat?.name?.trim() || `SAT-${layerState._trackedNorad}`;
    const altitudeM =
      layerState._trackedFrameGeo?.altitude ?? fallbackAltitudeM;
    // The card is display only (the voice context slot keeps its own English
    // copy), so the altitude unit and the companions line follow the language.
    const altitudeText = Number.isFinite(altitudeM)
      ? formatQuantity(Math.round(altitudeM / 1000), 'km')
      : `?\u00a0${unitLabel('km')}`;
    const detail = `${altitudeText} · NORAD ${layerState._trackedNorad}`;
    // Class leads the detail block: it is what tells the operator WHAT they are
    // looking at, and it stays readable under the IR styles that flatten the
    // dot colors to a single channel (the card is painted above post-FX).
    const details = [
      satelliteClassText(sat?.satelliteClass, sat?.group, {
        isIss: layerState._trackedNorad === ISS_NORAD,
      }),
      detail,
    ];
    // Docked companions are consolidated onto the tracked card as SECONDARY info
    // instead of competing with it as separate ambient labels. Identities are
    // preserved: the catalog is untouched and every companion returns to its own
    // label the moment the cluster is no longer tracked.
    const companions = parts.labels._dockedCompanionNames();
    if (companions.length > 0) {
      const extra = companions.length - 1;
      details.push(
        extra > 0
          ? t('DOCKED · {name} · +{extra}', { name: companions[0], extra })
          : t('DOCKED · {name}', { name: companions[0] }),
      );
    }
    // While a station's model shows, the card keeps clear of it: the gap
    // follows the station's size on screen, in steps so the card is not
    // republished every frame.
    const clearPx =
      modelFor(parts, layerState._trackedNorad)?._cardClearPx?.() ?? null;
    const current = readEntityRecord(layerState._trackedEntity)?.labelModel;
    // The overlay's gap is twice the anchor radius, so half the clearance,
    // in 4 px steps. The step kept stands until the clearance has moved a
    // pixel past the step's edge: at an edge, sub-pixel jitter in the range
    // would otherwise flip it, and republish the card, every frame.
    const kept = current?.anchorRadiusPx ?? null;
    const anchorRadiusPx = !clearPx
      ? null
      : kept !== null && Math.abs(clearPx / 2 - kept) < 3
        ? kept
        : Math.round(clearPx / 8) * 4;
    // Compare the WHOLE detail array: comparing only `details[0]` swallowed any
    // change confined to the companions line, so the card would never republish.
    const unchanged =
      current?.title === title &&
      (current?.anchorRadiusPx ?? null) === anchorRadiusPx &&
      current?.details?.length === details.length &&
      details.every((line, index) => current.details[index] === line);
    if (unchanged) return;
    entityRecord(layerState._trackedEntity).labelModel = {
      title,
      details,
      accent: '#ffd84d',
      ...(anchorRadiusPx ? { anchorRadiusPx, anchorRadiusScale: null } : {}),
    };
    refreshTrackedReadout(layerState._trackedEntity);
  }

  /**
   * The station a satellite is docked to: both orbits, propagated to one
   * instant, within the station's companion radius (dots are moved at
   * different moments, so their spacing cannot say). A station is docked to
   * nothing, and the dense group never is.
   * @param {number} noradId
   * @returns {number|null} The station's NORAD number, or null.
   */
  function _dockedToStation(noradId) {
    if (STATIONS.some((station) => station.norad === noradId)) return null;
    const sat = layerState._catalog.get(noradId);
    if (!sat?.satrec || sat.group === 'dense') return null;
    const date = new Date(layerState.now());
    const at = (p) => fromDegrees(p.longitude, p.latitude, p.altitude);
    let own = null;
    for (const station of STATIONS) {
      const entry = layerState._catalog.get(station.norad);
      if (!entry?.satrec) continue;
      own ??= parts.orbits.propagatePosition(sat.satrec, date);
      if (!own) return null;
      const there = parts.orbits.propagatePosition(entry.satrec, date);
      if (there && distance(at(own), at(there)) <= station.companionRadiusM)
        return station.norad;
    }
    return null;
  }

  function _trackSatellite(noradId, { origin = 'programmatic' } = {}) {
    _clearTracking(false, { origin });

    const sat = layerState._catalog.get(noradId);
    if (!layerState._points.has(noradId) || !sat) return;

    layerState._trackedNorad = noradId;
    layerState._trackedFrameNumber = -1;
    layerState._trackedFrameGeo = null;
    parts.labels._syncIssOverlay();

    // Hide the dot — the tracked dot draws it, larger and over everything.
    parts.rendering._hidePoint(noradId);

    // Show orbital path. An object docked to the ISS (Nauka, a Progress…)
    // flies the station's orbit under elements of its own: its ring would
    // run beside the ISS's, a second line through the same station. The
    // ISS's ring stands for it instead. Another station's ring is drawn only
    // while that station is tracked, so its docked objects keep their own.
    layerState._trackedDockedToStation = _dockedToStation(noradId);
    layerState._trackedDockedToIss =
      layerState._trackedDockedToStation === ISS_NORAD;
    if (!layerState._trackedDockedToIss)
      parts.rendering._showOrbitPath(noradId, TRACKED_ORBIT_COLOR);
    if (noradId === ISS_NORAD || layerState._trackedDockedToIss)
      parts.controls._syncIssOrbit?.();

    // The tracked position propagates per evaluation through the per-frame
    // cache (WS-D2) — dot, host readout, and camera share one SGP4 epoch per frame.
    // Falls back to the dot's reckoned position if SGP4 fails.
    const trackedPosition = () => {
      const pos = _getTrackedFramePosition();
      return pos
        ? layerState._trackedFrameCartesian
        : parts.rendering._pointPosition(noradId);
    };

    const name = sat.name.trim();

    // Comfortable tracking landing: ~726 km back for LEO (user-validated
    // "slightly zoomed out" framing — no stutter, label reads cleanly), scaled
    // up for MEO/GEO so the camera doesn't land on top of a high-orbit dot.
    const initialPos = parts.orbits.propagatePosition(
      sat.satrec,
      new Date(layerState.now()),
    );
    const viewScale =
      initialPos && initialPos.altitude > HIGH_ORBIT_ALTITUDE_M
        ? TRACK_VIEW_FROM_HIGH_SCALE
        : 1;
    const viewFrom = scale(TRACK_VIEW_FROM_LEO, viewScale);

    layerState._trackedEntity = parts.rendering._addTrackedEntity({
      position: trackedPosition,
      viewFrom,
    });
    entityRecord(layerState._trackedEntity).selectionOrigin = origin;
    entityRecord(layerState._trackedEntity).trackedId = `satellites:${noradId}`;
    entityRecord(layerState._trackedEntity).displayPosition =
      _trackedDisplayCached;
    // Up close a station is a 3D model: the card welds to where it is drawn.
    // So does the card of an object docked to it, which the model stands in
    // for.
    entityRecord(layerState._trackedEntity).visualPosition = () =>
      modelFor(parts, noradId)?._visualPosition?.() ?? null;
    _updateTrackedSatelliteLabelModel(initialPos?.altitude ?? null);

    const dotPosition = parts.rendering._pointPosition(noradId);
    _emitAwarenessEvent('gev:awareness-subject-selected', {
      layerId: 'satellites',
      id: noradId,
      label: name,
      position: dotPosition ? clone(dotPosition) : undefined,
      origin,
    });
    selectTrackedSubjectContext(_contextSubjectMetadata(noradId, initialPos));
    layerState._contextRefreshedAtMs = Date.now();

    // The renderer's own frame for a fast mover (autodetect), as the tracked
    // entity had; no close-range rules at orbital distances. The carrier is
    // what the tracked card reads (its entity record).
    layerState._followTarget = entityFollowTarget(layerState._trackedEntity, {
      position: trackedPosition,
      frame: 'autodetect',
      viewFrom,
    });
    cameraOf(layerState._viewer).follow(layerState._followTarget);
    console.log(`[Data:Satellites] Tracking ${name} (NORAD ${noradId})`);
  }
  return {
    _normalizeTrackedNorad,
    _emitAwarenessEvent,
    _applyPendingTrackingRestore,
    _cancelPendingTrackingRestore,
    _clearTracking,
    _getTrackedFramePosition,
    _trackedDisplayCached,
    _contextSubjectMetadata,
    _reconcileTrackedSubjectContext,
    _refreshTrackedSubjectContext,
    _updateTrackedSatelliteLabelModel,
    _trackSatellite,
  };
}
