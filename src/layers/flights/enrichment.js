import { classifyAircraft } from '../../data/aircraftClass.js';
import { horizonOccluder } from '../../data/iconOrientation.js';
import * as Cesium from 'cesium';
import {
  ENRICH_MAX_INFLIGHT,
  ENRICH_DISPATCH_GAP_MS,
  ENRICH_AMBIENT_BUDGET_CEIL,
  ENRICH_AMBIENT_REFILL_TOKENS,
  ENRICH_AMBIENT_REFILL_WINDOW_MS,
  ENRICH_AMBIENT_PER_SWEEP,
} from './policy.js';

export function createEnrichment({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  function _enqueueEnrich(key, query, onData, priority = false) {
    if (flightState.lifetime.signal.aborted) return;
    if (flightState._enrichSeen.has(key)) return;
    flightState._enrichSeen.add(key);
    const job = { query, onData };
    // Priority (tracked / model-eligible) goes to the FRONT so a deep ambient
    // backlog can never delay the plane the user just clicked or zoomed into.
    if (priority) flightState._enrichQueue.unshift(job);
    else flightState._enrichQueue.push(job);
    _drainEnrich();
  }

  function _drainEnrich() {
    if (flightState.lifetime.signal.aborted) return;
    while (
      flightState._enrichActive < ENRICH_MAX_INFLIGHT &&
      flightState._enrichQueue.length
    ) {
      // Drip: at most one dispatch per ENRICH_DISPATCH_GAP_MS. When the gap
      // hasn't elapsed yet, park a single wake-up timer and stop — completions
      // and enqueues in the meantime re-enter here harmlessly.
      const wait =
        ENRICH_DISPATCH_GAP_MS -
        (Date.now() - flightState._enrichLastDispatchMs);
      if (wait > 0) {
        if (!flightState._enrichDripTimer) {
          flightState._enrichDripTimer = setTimeout(() => {
            flightState._enrichDripTimer = null;
            _drainEnrich();
          }, wait);
        }
        return;
      }
      flightState._enrichLastDispatchMs = Date.now();
      const job = flightState._enrichQueue.shift();
      flightState._enrichActive += 1;
      const lifetime = flightState.lifetime;
      Promise.resolve()
        .then(() => {
          lifetime.signal.throwIfAborted();
          return flightState.feed._source.getEnrichment?.(job.query, {
            signal: lifetime.signal,
          });
        })
        .then((data) => {
          if (!lifetime.signal.aborted && data && data.found) job.onData(data);
        })
        .catch(() => {
          /* enrichment never surfaces errors */
        })
        .finally(() => {
          if (lifetime.signal.aborted) return;
          flightState._enrichActive -= 1;
          _drainEnrich();
        });
    }
  }

  function _requestTypeEnrichment(icao24, priority = false) {
    if (!/^[0-9a-f]{6}$/i.test(icao24)) return;
    _enqueueEnrich(
      `t:${icao24}`,
      { kind: 'type', id: icao24.toLowerCase() },
      (data) => {
        const meta = flightState.records.data.get(icao24);
        if (!meta) return; // evicted while the lookup was in flight
        meta.typeCode = data.typeCode || meta.typeCode;
        meta.typeName = data.typeName || meta.typeName;
        meta.registration = data.registration || meta.registration;
        if (meta.typeCode) {
          const klass = classifyAircraft({
            typeCode: meta.typeCode,
            category: meta.category,
          });
          if (klass !== meta.klass) {
            meta.klass = klass;
            const bb = flightState._billboards.get(icao24);
            if (bb)
              parts.rendering._applyFleetBillboardPresentation(icao24, bb);
            // Hangar fleet: the class's GLB/scale may have changed — resync the
            // live model, any in-flight load, and the tracked standalone model.
            parts.rendering._syncModelToClass(icao24);
          }
        }
        if (icao24 === flightState._trackedIcao && flightState._trackedEntity)
          parts.tracking._updateTrackedLabelModel(icao24);
      },
      priority,
    );
  }

  function _requestRouteEnrichment(icao24) {
    const cs = String(flightState.records.data.get(icao24)?.callsign || '')
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{3}\d/.test(cs)) return; // airline-style callsigns only (LLL + digit); GA tails won't resolve
    _enqueueEnrich(
      `r:${cs}`,
      { kind: 'route', id: cs },
      (data) => {
        const meta = flightState.records.data.get(icao24);
        if (!meta) return;
        meta.airline = data.airline || meta.airline;
        if (data.origin && data.destination)
          meta.route = { origin: data.origin, destination: data.destination };
        if (icao24 === flightState._trackedIcao && flightState._trackedEntity)
          parts.tracking._updateTrackedLabelModel(icao24);
      },
      true,
    ); // route lookups only fire for the TRACKED plane — front of the queue
  }

  /** QA seam: headless harnesses (scripts/qa-enrich-ambient.mjs) shrink the
   *  bucket knobs via window.__GEV_ENRICH_AMBIENT_QA = {ceil, refillTokens,
   *  windowMs} — they cannot wait out a real 5-minute window. Read lazily each
   *  refill so a pre-boot override (or a mid-run windowMs swap) applies.
   *  Production never sets this; the constants above are the defaults. */

  function _ambientBudgetKnobs() {
    const o =
      (typeof window !== 'undefined' && window.__GEV_ENRICH_AMBIENT_QA) || null;
    return {
      ceil:
        Number.isFinite(o?.ceil) && o.ceil > 0
          ? o.ceil
          : ENRICH_AMBIENT_BUDGET_CEIL,
      refillTokens:
        Number.isFinite(o?.refillTokens) && o.refillTokens > 0
          ? o.refillTokens
          : ENRICH_AMBIENT_REFILL_TOKENS,
      windowMs:
        Number.isFinite(o?.windowMs) && o.windowMs > 0
          ? o.windowMs
          : ENRICH_AMBIENT_REFILL_WINDOW_MS,
    };
  }

  /** Advance the token bucket: add refillTokens per FULLY elapsed window since
   *  the anchor, clamp at the ceiling, and move the anchor forward by the whole
   *  windows consumed (while the bucket sits full this still advances, so idle
   *  time never banks more than one bucket's worth of burst). */

  function _refillAmbientBudget(nowMs) {
    const { ceil, refillTokens, windowMs } = _ambientBudgetKnobs();
    if (!flightState._enrichAmbientRefillAnchorMs) {
      flightState._enrichAmbientRefillAnchorMs = nowMs;
      return;
    }
    const windows = Math.floor(
      (nowMs - flightState._enrichAmbientRefillAnchorMs) / windowMs,
    );
    if (windows <= 0) return;
    flightState._enrichAmbientBudget = Math.min(
      ceil,
      flightState._enrichAmbientBudget + windows * refillTokens,
    );
    flightState._enrichAmbientRefillAnchorMs += windows * windowMs;
  }

  function _sweepAmbientEnrichment() {
    _refillAmbientBudget(Date.now());
    if (
      flightState._enrichAmbientBudget <= 0 ||
      !flightState._viewer ||
      !flightState._billboardCollection ||
      !flightState._billboardCollection.show
    )
      return;
    try {
      const camera = flightState._viewer.camera;
      const camPos = camera.positionWC;
      const occluder = horizonOccluder(camera);
      const cull = camera.frustum.computeCullingVolume(
        camPos,
        camera.directionWC,
        camera.upWC,
      );
      const cand = [];
      for (const [icao24, bb] of flightState._billboards) {
        if (flightState._enrichSeen.has(`t:${icao24}`)) continue; // answered / queued / negative this session
        if (!/^[0-9a-f]{6}$/i.test(icao24)) continue; // adsbdb keys are 6-char hex only
        if (flightState.records.data.get(icao24)?.onGround) continue; // ground traffic never spends ambient budget (click-to-enrich still works)
        if (!bb.position || !occluder.isPointVisible(bb.position)) continue; // beyond the limb
        Cesium.Cartesian3.clone(
          bb.position,
          flightState._scratchModelBS.center,
        );
        if (
          cull.computeVisibility(flightState._scratchModelBS) ===
          Cesium.Intersect.OUTSIDE
        )
          continue; // off-screen
        cand.push([
          icao24,
          Cesium.Cartesian3.distanceSquared(camPos, bb.position),
        ]);
      }
      cand.sort((a, b) => a[1] - b[1]); // nearest first — what the user is looking at resolves first
      const n = Math.min(
        cand.length,
        ENRICH_AMBIENT_PER_SWEEP,
        flightState._enrichAmbientBudget,
      );
      for (let i = 0; i < n; i++) {
        flightState._enrichAmbientBudget -= 1;
        _requestTypeEnrichment(cand[i][0]); // non-priority: fills the back of the queue
      }
    } catch {
      /* ambient enrichment is best-effort — never disturb the poll loop */
    }
  }
  return {
    _enqueueEnrich,
    _drainEnrich,
    _requestTypeEnrichment,
    _requestRouteEnrichment,
    _ambientBudgetKnobs,
    _refillAmbientBudget,
    _sweepAmbientEnrichment,
  };
}
