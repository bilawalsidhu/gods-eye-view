/**
 * Guided tour playback engine: beat clock, keyframe mapping, pause/skip/stop.
 * @module tours/tourEngine
 */

import * as Cesium from 'cesium';
import { flyToLandmark } from '../locations.js';
import { interruptCameraMotion, flyRoute, moveCamera } from '../cameraVerbs.js';
import { cachedGroundFloor, warmGroundFloor } from '../data/groundFloor.js';
import { pickScript } from './tourSchema.js';
import {
  fetchTourById,
  fetchTourList,
  fetchTourRoute,
  generateTour,
  pickRandomTour,
  resolveTour,
} from './tourCatalog.js';
import {
  createShotDeck,
  framingForShot,
  nextShotInOrder,
  pickShuffledShot,
  shotLabel,
} from './tourCameraShots.js';
import { TourPopup } from './tourPopup.js';
import { TourReviewPanel } from './tourReview.js';
import { getTourLoadingOverlay } from './tourLoading.js';
import {
  collectUpcomingTourPlaces,
  getSpaceApproachParams,
  holdTourPlaybackRender,
  isCloseHoldBeat,
  preloadTourOverlays,
  prefetchTourPlaces,
  probeTourMeshCoverage,
  releaseTourPlaybackRender,
  waitForTourAppReady,
  waitForTourVisuals,
} from './tourTiles.js';

const ESCAPE_KEY = 'Escape';
const DEFAULT_HOLD_RANGE_M = 650;
const DEFAULT_HOLD_BUILDING_HEIGHT_M = 45;

export class TourEngine {
  constructor(viewer, styleManager, { annotations = null } = {}) {
    this.viewer = viewer;
    this.styleManager = styleManager;
    this.annotations = annotations;
    this.running = false;
    this.paused = false;
    this.loading = false;
    this.reviewing = false;
    this.autoplay = false;
    this.approachStatus = '';
    this.tour = null;
    this.beatIndex = 0;
    this._generation = 0;
    this._usedScripts = new Set();
    this._listeners = new Set();
    this._pauseWaiters = [];
    this._parkWaiters = [];
    this._skipEnter = false;
    this._spaceApproachDone = false;
    this._shotDeck = createShotDeck();
    this._shotId = null;
    this._meshQuality = 'ok';
    this._onKeyDown = (event) => {
      if (event.key === ESCAPE_KEY && this.running) this.stop('Stopped');
    };
    this.speakBeat = null;
    this.stopTourVoice = null;
    this._playFromIndex = 0;
    this._overlayPreloadPromise = null;
    this.loadingOverlay = getTourLoadingOverlay();
    this.popup = new TourPopup(this);
    this.reviewPanel = new TourReviewPanel(this);
    this._publishReview({ status: 'idle' });
  }

  setAnnotations(annotations) {
    this.annotations = annotations || null;
  }

  setLoading(state) {
    if (!state || state.active === false) {
      this.loading = false;
      this.loadingOverlay.hide();
      this._emit();
      return;
    }
    this.loading = true;
    const title = state.title || 'Preparing tour';
    const status = state.status || 'Please wait…';
    const progress = Number.isFinite(state.progress) ? state.progress : 0.08;
    if (this.loadingOverlay.active) this.loadingOverlay.update({ title, status, progress });
    else this.loadingOverlay.show({ title, status, progress });
    this._emit();
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this._listeners.add(listener);
    listener(this.getPlaybackStatus());
    return () => this._listeners.delete(listener);
  }

  _emit() {
    const status = this.getPlaybackStatus();
    for (const listener of this._listeners) {
      try { listener(status); } catch { /* ignore */ }
    }
  }

  getPlaybackStatus() {
    const beats = this.tour?.beats || [];
    const beat = beats[this.beatIndex] || null;
    return {
      running: this.running,
      paused: this.paused,
      loading: this.loading,
      reviewing: this.reviewing,
      autoplay: this.autoplay,
      approachStatus: this.approachStatus || '',
      shotId: this._shotId || null,
      shotLabel: this._shotId ? shotLabel(this._shotId) : null,
      tourId: this.tour?.id || null,
      title: this.tour?.title || null,
      city: this.tour?.city || null,
      beatIndex: this.beatIndex,
      beatCount: beats.length,
      beatId: beat?.id || null,
      beatTitle: beat?.title || null,
      beatKind: beat?.kind || null,
    };
  }

  listTours() {
    return fetchTourList();
  }

  /**
   * Load a tour for framing review without starting narration playback.
   */
  async loadForReview(query) {
    const tour = typeof query === 'object' && query?.beats
      ? query
      : await resolveTour(query) || await fetchTourById(query);
    if (!tour?.beats?.length) {
      return { ok: false, error: `No saved tour matched "${query || ''}"` };
    }
    this.stop('Review load', { silent: true });
    this.tour = tour;
    this.beatIndex = 0;
    this.running = false;
    this.paused = false;
    this.reviewing = true;
    this._publishReview({
      status: 'loaded',
      tourId: tour.id,
      title: tour.title,
      beatIndex: 0,
      beat: summarizeBeat(tour.beats[0]),
      camera: tour.beats[0]?.camera || null,
    });
    this._emit();
    return { ok: true, tourId: tour.id, title: tour.title, beatCount: tour.beats.length };
  }

  /**
   * Apply camera for one beat without narration / duration clock.
   * Publishes window.__gevTourReview for agent screenshots.
   */
  async previewBeat(index, { holdMs = 1200 } = {}) {
    if (!this.tour?.beats?.length) {
      return { ok: false, error: 'No tour loaded for review' };
    }
    if (!this._claimCamera()) {
      return { ok: false, error: 'Camera unavailable — exit cockpit first' };
    }
    const beats = this.tour.beats;
    const beatIndex = Math.max(0, Math.min(beats.length - 1, Number(index) || 0));
    const beat = beats[beatIndex];
    this.beatIndex = beatIndex;
    this.reviewing = true;
    this.running = false;
    this.paused = false;
    this._generation += 1;
    const generation = this._generation;
    this._publishReview({
      status: 'flying',
      tourId: this.tour.id,
      title: this.tour.title,
      beatIndex,
      beat: summarizeBeat(beat),
      camera: beat.camera || null,
    });
    this._emit();
    try {
      if (beat.kind === 'establish') await this._showEstablishAnnotations(beat);
      else this._clearTourAnnotations();
      await this._applyBeat(beat);
      await waitForTourVisuals(this.viewer, {
        timeoutMs: 12000,
        stableMs: 450,
        isCancelled: () => generation !== this._generation,
      });
      if (beat.kind === 'establish') {
        void this._prefetchFrom(0, generation, { timeoutMs: 9000 });
      }
    } catch (error) {
      console.warn('[TourEngine] previewBeat failed', error);
      this._publishReview({
        status: 'error',
        tourId: this.tour.id,
        beatIndex,
        beat: summarizeBeat(beat),
        camera: beat.camera || null,
        error: error?.message || 'preview failed',
      });
      return { ok: false, error: error?.message || 'preview failed' };
    }
    if (generation !== this._generation) return { ok: false, error: 'superseded' };
    if (holdMs > 0) await sleep(holdMs);
    if (generation !== this._generation) return { ok: false, error: 'superseded' };
    this._publishReview({
      status: 'settled',
      tourId: this.tour.id,
      title: this.tour.title,
      beatIndex,
      beat: summarizeBeat(beat),
      camera: beat.camera || null,
      viewerCamera: captureViewerCamera(this.viewer),
    });
    this._emit();
    return {
      ok: true,
      tourId: this.tour.id,
      beatIndex,
      beatId: beat.id,
      beatTitle: beat.title,
      camera: beat.camera || null,
    };
  }

  async play(query, { fromIndex = 0 } = {}) {
    const queryLabel = typeof query === 'object' && query?.title
      ? query.title
      : String(query || '');
    const tour = typeof query === 'object' && query?.beats
      ? query
      : await resolveTour(query);
    if (!tour) {
      return {
        ok: false,
        action: 'control_tour',
        query: queryLabel,
        error: `No saved tour matched "${queryLabel}"`,
        tours: await fetchTourList(),
      };
    }
    if (!this._claimCamera()) {
      this.setLoading({ active: false });
      return { ok: false, action: 'control_tour', error: 'Camera unavailable — exit cockpit first' };
    }
    this.stop('Replaced', { silent: true, keepLoading: true });
    this.setLoading({
      title: tour.title || `Tour of ${tour.city || queryLabel}`,
      status: `Approaching ${tour.city || queryLabel || 'the city'}…`,
      progress: 0.55,
    });
    this.tour = tour;
    this.beatIndex = Math.max(0, Math.min(fromIndex, tour.beats.length - 1));
    this._playFromIndex = this.beatIndex;
    this.running = true;
    this.paused = false;
    this.autoplay = false;
    this.reviewing = false;
    this._skipEnter = false;
    this._spaceApproachDone = false;
    this._shotDeck = createShotDeck();
    this._shotId = null;
    this._meshQuality = 'ok';
    this.approachStatus = `Approaching ${tour.city || queryLabel || 'the city'}…`;
    this._usedScripts = new Set();
    this._generation += 1;
    const generation = this._generation;
    holdTourPlaybackRender();
    document.addEventListener('keydown', this._onKeyDown);
    document.body.classList.add('tour-playback-mode');
    this._emit();

    // Overlay preload runs in parallel with the opening space zoom.
    this._overlayPreloadPromise = preloadTourOverlays({
      tour,
      annotations: this.annotations,
      buildAnnotationRequests: buildEstablishAnnotationRequests,
      fetchTourRoute,
      isCancelled: () => generation !== this._generation || !this.running,
    }).catch((error) => {
      console.warn('[TourEngine] overlay preload failed', error);
      return null;
    });
    void this._prefetchFrom(this.beatIndex, generation, { timeoutMs: 12000 });
    void this._run(generation);
    const beat = tour.beats[this.beatIndex];
    return {
      ok: true,
      action: 'control_tour',
      playing: tour.title,
      tourId: tour.id,
      city: tour.city,
      beatCount: tour.beats.length,
      beatTitle: beat?.title || null,
      speakScript: beat?.script || '',
      loadingSpoken: true,
      autoplay: false,
    };
  }

  /**
   * Stub path for callers that still expect generate — generation is not enabled.
   * @param {string} [query]
   * @returns {Promise<{ ok: false, action: string, error: string }>}
   */
  async generateAndPrepare(query) {
    const result = await generateTour(query);
    return { action: 'generate_tour', ...result };
  }

  async random() {
    const excludeId = this.running ? this.tour?.id : null;
    const picked = await pickRandomTour(excludeId);
    if (!picked.ok || !picked.tour) {
      return {
        ok: false,
        action: 'control_tour',
        empty: true,
        error: 'No saved tours on disk yet',
        tours: picked.tours || [],
      };
    }
    const result = await this.play(picked.tour);
    return {
      ...result,
      action: 'control_tour',
      random: true,
      only: picked.only,
      tourId: picked.tour.id,
      title: picked.tour.title,
      city: picked.tour.city,
    };
  }

  pause(reason = 'Paused') {
    if (!this.running) return { ok: false, action: 'control_tour', error: 'No tour is playing' };
    this._cancelTourVoice();
    this.paused = true;
    if (this.autoplay) interruptCameraMotion('tour-pause');
    this._emit();
    return { ok: true, action: 'control_tour', paused: true, autoplay: this.autoplay, reason, ...this.getPlaybackStatus() };
  }

  resume() {
    if (!this.running || !this.tour) return { ok: false, action: 'control_tour', error: 'No tour is playing' };
    if (!this.paused) return { ok: true, action: 'control_tour', paused: false, ...this.getPlaybackStatus() };
    this.paused = false;
    this._speakCurrentBeat();
    this._resolvePauseWaiters();
    if (this.autoplay) this._wakePark('resume');
    this._emit();
    return { ok: true, action: 'control_tour', paused: false, autoplay: this.autoplay, ...this.getPlaybackStatus() };
  }

  setAutoplay(enabled) {
    if (!this.running || !this.tour) {
      this.autoplay = !!enabled;
      return { ok: false, action: 'control_tour', error: 'No tour is playing', autoplay: this.autoplay };
    }
    const on = !!enabled;
    if (on === this.autoplay) {
      return { ok: true, action: 'control_tour', autoplay: this.autoplay, ...this.getPlaybackStatus() };
    }
    this.autoplay = on;
    if (on) {
      this.paused = false;
      if (this._parkWaiters.length) {
        this._skipEnter = true;
        this._wakePark('autoplay');
      }
    } else {
      // Cancel the hold clock and stay on this beat. Do not re-frame or
      // cancel the in-progress sentence — the user is taking over from here.
      this._skipEnter = true;
    }
    this._emit();
    return { ok: true, action: 'control_tour', autoplay: this.autoplay, ...this.getPlaybackStatus() };
  }

  seekTo(index, { wrap = !this.autoplay } = {}) {
    if (!this.running || !this.tour?.beats?.length) {
      return { ok: false, action: 'control_tour', error: 'No tour is playing' };
    }
    const last = this.tour.beats.length - 1;
    let nextIndex = Number(index);
    if (!Number.isFinite(nextIndex)) nextIndex = this.beatIndex;
    if (wrap && last >= 0) {
      const span = last + 1;
      nextIndex = ((Math.round(nextIndex) % span) + span) % span;
    } else {
      nextIndex = Math.max(0, Math.min(last, Math.round(nextIndex)));
    }
    this._cancelTourVoice();
    interruptCameraMotion('tour-seek');
    this.paused = false;
    this.beatIndex = nextIndex;
    this._skipEnter = false;
    this._generation += 1;
    this._wakePark('seek');
    this._emit();
    return { ok: true, action: 'control_tour', seek: true, ...this.getPlaybackStatus() };
  }

  stop(reason = 'Stopped', { silent = false, keepLoading = false, keepTour = false } = {}) {
    this._cancelTourVoice();
    this._generation += 1;
    this.running = false;
    this.paused = false;
    this.approachStatus = '';
    if (!keepLoading) this.setLoading({ active: false });
    if (!keepTour) {
      this.reviewing = false;
      this.autoplay = false;
      this._shotId = null;
      this._meshQuality = 'ok';
      this._clearTourAnnotations();
      releaseTourPlaybackRender();
    }
    this._resolvePauseWaiters();
    this._wakePark('stop');
    interruptCameraMotion('tour-stop');
    document.removeEventListener('keydown', this._onKeyDown);
    document.body.classList.remove('tour-playback-mode');
    const status = this.getPlaybackStatus();
    if (!keepTour) {
      this.tour = null;
      this.beatIndex = 0;
      this._publishReview({ status: 'idle' });
    }
    this._emit();
    if (silent) return { ok: true, action: 'control_tour', running: false };
    return { ok: true, action: 'control_tour', running: false, reason, ...status, tourId: status.tourId };
  }

  async next() {
    if (!this.running || !this.tour) return { ok: false, action: 'control_tour', error: 'No tour is playing' };
    return this.seekTo(this.beatIndex + 1, { wrap: !this.autoplay });
  }

  async prev() {
    if (!this.running || !this.tour) return { ok: false, action: 'control_tour', error: 'No tour is playing' };
    return this.seekTo(this.beatIndex - 1, { wrap: !this.autoplay });
  }

  /**
   * HUD camera button: cycle shot type on the current beat without seeking or re-speaking.
   */
  async cycleCameraShot() {
    if (!this.running || !this.tour) {
      return { ok: false, action: 'control_tour', error: 'No tour is playing' };
    }
    const beat = this.tour.beats[this.beatIndex];
    if (!beat) return { ok: false, action: 'control_tour', error: 'No beat' };
    const nextId = nextShotInOrder(this._shotId);
    await this._startShot(nextId, beat, { meshQuality: this._meshQuality, durationSec: 1.6 });
    this._emit();
    return { ok: true, action: 'control_tour', shot: true, ...this.getPlaybackStatus() };
  }

  _claimCamera() {
    if (typeof this.styleManager?.runImmediateNavigation !== 'function') return true;
    const claimed = this.styleManager.runImmediateNavigation('tour', () => true);
    return claimed !== false;
  }

  async _run(_startGeneration) {
    while (this.running && this.tour) {
      const generation = this._generation;
      const beat = this.tour.beats[this.beatIndex];
      if (!beat) {
        this.setLoading({ active: false });
        this.stop('Finished');
        return;
      }

      const skipEnter = this._skipEnter;
      this._skipEnter = false;
      if (!skipEnter) {
        await this._enterBeat(beat, generation);
        if (!this.running) return;
        if (this._generation !== generation) continue;
      }

      if (this.autoplay && !this.paused) {
        const holdMs = beat.kind === 'establish' && !skipEnter
          ? Math.max(2500, (beat.durationSec || 8) * 400)
          : (beat.durationSec || 8) * 1000;
        await this._hold(holdMs, generation);
        if (!this.running) return;
        if (this._generation !== generation) continue;
        if (!this.autoplay || this.paused) continue;
        if (this.beatIndex >= this.tour.beats.length - 1) {
          this.stop('Finished');
          return;
        }
        this.seekTo(this.beatIndex + 1, { wrap: false });
        continue;
      }

      await this._waitPark(generation);
    }
  }

  async _enterBeat(beat, generation) {
    const cancelled = () => generation !== this._generation || !this.running;
    const statusUpdate = (status, progress) => {
      this.approachStatus = status || '';
      if (this.loading) {
        this.setLoading({
          title: this.tour?.title || 'Guided tour',
          status,
          progress: progress ?? 0.7,
        });
      } else {
        this._emit();
      }
    };
    this._emit();

    const firstEstablish = this.tour.beats.findIndex((item) => item.kind === 'establish');
    const doSpaceApproach = !this._spaceApproachDone
      && beat.kind === 'establish'
      && this.beatIndex === firstEstablish
      && (this._playFromIndex ?? 0) <= firstEstablish;

    try {
      if (doSpaceApproach) {
        await this._runSpaceEstablish(beat, generation, { cancelled, statusUpdate });
        this._spaceApproachDone = true;
      } else {
        if (beat.kind === 'establish') await this._showEstablishAnnotations(beat);
        else this._clearTourAnnotations();
        await this._applyBeat(beat);
        if (cancelled()) return;

        await waitForTourVisuals(this.viewer, {
          timeoutMs: 12000,
          stableMs: 500,
          isCancelled: cancelled,
          onSlow: (msg) => statusUpdate(msg, 0.72),
        });
        if (cancelled()) return;

        let meshQuality = 'ok';
        if (isCloseHoldBeat(beat)) {
          const probe = await probeTourMeshCoverage(this.viewer, {
            lat: beat.camera?.lat ?? beat.place?.lat,
            lon: beat.camera?.lon ?? beat.place?.lon,
          });
          meshQuality = probe.quality || 'ok';
          this._meshQuality = meshQuality;
          this._publishReview({
            status: 'mesh_probe',
            tourId: this.tour.id,
            beatIndex: this.beatIndex,
            mesh: probe.quality,
            probe,
          });
          if (probe.quality === 'missing' || probe.quality === 'sparse') {
            await this._applyOverheadFallback(beat);
            this._publishReview({
              status: 'settled',
              tourId: this.tour.id,
              beatIndex: this.beatIndex,
              mesh: 'overhead_fallback',
              probe,
            });
            await waitForTourVisuals(this.viewer, {
              timeoutMs: 8000,
              stableMs: 400,
              isCancelled: cancelled,
            });
          }
        } else {
          this._meshQuality = 'ok';
        }
        if (cancelled()) return;

        const shotId = pickShuffledShot(this._shotDeck, { meshQuality: this._meshQuality });
        await this._startShot(shotId, beat, { meshQuality: this._meshQuality });
        if (cancelled()) return;

        void this._prefetchFrom(this.beatIndex + 1, generation, { timeoutMs: 6000 });
        if (this.loading) this.setLoading({ active: false });
        this.approachStatus = '';
        this._speakCurrentBeat();
      }
    } catch (error) {
      console.warn('[TourEngine] beat failed', error);
      if (this.loading) this.setLoading({ active: false });
    }
  }

  _speakCurrentBeat() {
    if (!this.tour || this.paused) return;
    const beat = this.tour.beats[this.beatIndex];
    if (!beat) return;
    const script = pickScript(beat, this._usedScripts);
    try {
      this.speakBeat?.({
        script,
        title: beat.title,
        index: this.beatIndex,
        total: this.tour.beats.length,
        tourTitle: this.tour.title,
      });
    } catch { /* voice optional */ }
  }

  _cancelTourVoice() {
    try { this.stopTourVoice?.(); } catch { /* optional */ }
  }

  _resolvePauseWaiters() {
    const waiters = this._pauseWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  _wakePark(reason = 'seek') {
    const waiters = this._parkWaiters.splice(0);
    for (const resolve of waiters) resolve(reason);
  }

  async _waitPark(generation) {
    if (!this.running || generation !== this._generation) return 'seek';
    return new Promise((resolve) => {
      this._parkWaiters.push(resolve);
    });
  }

  /**
   * Slow space-to-city zoom with establish narration during the approach,
   * then gate on tiles + overlays + soft app layer readiness.
   */
  async _runSpaceEstablish(beat, generation, { cancelled, statusUpdate }) {
    const cam = beat.camera || {};
    const lat = cam.lat ?? beat.place?.lat;
    const lon = cam.lon ?? beat.place?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      await this._applyBeat(beat);
      this._speakCurrentBeat();
      return;
    }
    const approach = getSpaceApproachParams(cam);
    const city = this.tour?.city || beat.place?.name || 'the city';
    statusUpdate(`Approaching ${city}…`, 0.58);

    interruptCameraMotion('tour-space-snap');
    try {
      this.viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, approach.spaceAlt),
        orientation: {
          heading: Cesium.Math.toRadians(approach.heading),
          pitch: Cesium.Math.toRadians(-85),
          roll: 0,
        },
      });
    } catch { /* continue into fly */ }

    await sleep(350);
    if (cancelled()) return;

    // Unlock the full-screen lock once the zoom is the hero motion; HUD can seek.
    if (this.loading) this.setLoading({ active: false });
    this.approachStatus = `Approaching ${city}…`;
    this._emit();

    this._speakCurrentBeat();

    const zoomPromise = flyToDestination(this.viewer, {
      lat,
      lon,
      alt: approach.establishAlt,
      heading: approach.heading,
      pitch: approach.pitch,
      duration: approach.approachSec,
    });

    // Reveal annotations once descent is underway.
    void (async () => {
      await sleep(Math.min(4000, approach.approachSec * 400));
      if (cancelled()) return;
      await this._showEstablishAnnotations(beat);
    })();

    // Overlays + layer gate overlap the zoom.
    const gatePromise = (async () => {
      await Promise.race([
        this._overlayPreloadPromise || Promise.resolve(null),
        sleep(12000),
      ]);
      if (cancelled()) return;
      statusUpdate('Preparing layers…', 0.68);
      await waitForTourAppReady({
        styleManager: this.styleManager,
        timeoutMs: 5500,
        isCancelled: cancelled,
        onStatus: (msg) => statusUpdate(msg, 0.74),
      });
    })();

    await zoomPromise;
    if (cancelled()) return;

    statusUpdate('Loading the view…', 0.8);
    await waitForTourVisuals(this.viewer, {
      timeoutMs: 16000,
      stableMs: 550,
      isCancelled: cancelled,
      onSlow: (msg) => statusUpdate(msg, 0.84),
    });
    if (cancelled()) return;

    await gatePromise;
    if (cancelled()) return;

    // Ensure annotations landed even if mid-zoom reveal raced.
    await this._showEstablishAnnotations(beat);
    void this._prefetchFrom(this.beatIndex + 1, generation, { timeoutMs: 10000 });
    this._meshQuality = 'ok';
    const shotId = pickShuffledShot(this._shotDeck, { meshQuality: 'ok' });
    await this._startShot(shotId, beat, { meshQuality: 'ok', durationSec: 2.8 });
    this.approachStatus = '';
    this._emit();
  }

  async _applyOverheadFallback(beat) {
    const lat = beat.camera?.lat ?? beat.place?.lat;
    const lon = beat.camera?.lon ?? beat.place?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    interruptCameraMotion('tour-overhead-fallback');
    await flyToDestination(this.viewer, {
      lat,
      lon,
      alt: 10000,
      heading: beat.camera?.heading || 20,
      pitch: -42,
      duration: 3.2,
    });
  }

  async _prefetchFrom(fromIndex, generation, { timeoutMs = 7000 } = {}) {
    if (!this.tour || generation !== this._generation) return;
    const places = collectUpcomingTourPlaces(this.tour, fromIndex, { count: 5, routeSamples: 5 });
    if (!places.length) return;
    try {
      await prefetchTourPlaces(this.viewer, places, {
        timeoutMs,
        isCancelled: () => generation !== this._generation || !this.running,
      });
    } catch (error) {
      console.warn('[TourEngine] prefetch failed', error);
    }
  }

  async _waitIfPaused(generation) {
    while (this.paused && this.running && generation === this._generation) {
      await new Promise((resolve) => this._pauseWaiters.push(resolve));
    }
  }

  async _hold(ms, generation) {
    const endAt = Date.now() + Math.max(0, ms);
    while (Date.now() < endAt) {
      if (generation !== this._generation || !this.running) return;
      if (!this.autoplay) return;
      await this._waitIfPaused(generation);
      if (generation !== this._generation) return;
      if (!this.autoplay) return;
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
  }

  async _applyBeat(beat) {
    interruptCameraMotion('tour-beat');
    const cam = beat.camera || {};
    const lat = cam.lat ?? beat.place?.lat;
    const lon = cam.lon ?? beat.place?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    // Gallery: jump-cut to the place (no route dolly). Living shot starts after settle.
    const framing = resolveHoldFraming(cam);
    try {
      warmGroundFloor?.([{ lat, lon }]);
      cachedGroundFloor?.(lat, lon);
    } catch { /* optional */ }
    await sleep(200);
    flyToLandmark(this.viewer, lat, lon, {
      range: framing.rangeM,
      heading: framing.heading,
      pitch: framing.pitch,
      buildingHeight: framing.buildingHeight,
      duration: Math.min(3.2, Math.max(1.2, (beat.durationSec || 8) * 0.35)),
    });
    await sleep(Math.min(3200, Math.max(1200, ((beat.durationSec || 8) * 0.35) * 1000) + 200));
  }

  /**
   * Frame (unless skipFrame) and optionally start a continuous camera verb for the shot.
   */
  async _startShot(shotId, beat, { meshQuality = 'ok', durationSec = null, skipFrame = false } = {}) {
    if (!beat || !this.running) return;
    const lat = beat.camera?.lat ?? beat.place?.lat;
    const lon = beat.camera?.lon ?? beat.place?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    let id = shotId || 'orbit';
    if ((meshQuality === 'missing' || meshQuality === 'sparse')
      && (id === 'lowAngle' || id === 'pushIn')) {
      id = 'birdsEye';
    }

    interruptCameraMotion('tour-shot');
    const base = resolveHoldFraming(beat.camera || {});
    const framing = framingForShot(id, base);
    this._shotId = id;
    this._emit();

    if (!skipFrame) {
      try {
        warmGroundFloor?.([{ lat, lon }]);
        cachedGroundFloor?.(lat, lon);
      } catch { /* optional */ }
      const duration = durationSec ?? Math.min(2.4, Math.max(1.0, (beat.durationSec || 8) * 0.22));
      flyToLandmark(this.viewer, lat, lon, {
        range: framing.rangeM,
        heading: framing.heading,
        pitch: framing.pitch,
        buildingHeight: framing.buildingHeight,
        duration,
      });
      await sleep(duration * 1000 + 180);

      // Push-in: second, closer frame after the first settle.
      if (id === 'pushIn' && Number.isFinite(framing.secondaryRange)) {
        flyToLandmark(this.viewer, lat, lon, {
          range: framing.secondaryRange,
          heading: framing.heading,
          pitch: framing.pitch,
          buildingHeight: framing.buildingHeight,
          duration: 2.2,
        });
        await sleep(2400);
      }
    }

    if (this.paused || !this.running) return;
    if (!framing.motion) return;

    const runNav = (navigate) => {
      if (typeof this.styleManager?.runImmediateNavigation === 'function') {
        return this.styleManager.runImmediateNavigation('tour', navigate);
      }
      return navigate();
    };
    try {
      moveCamera({ ...framing.motion }, runNav);
    } catch (error) {
      console.warn('[TourEngine] shot motion failed', error);
    }
  }

  async _showEstablishAnnotations(beat) {
    if (!this.annotations?.annotate) return;
    const authored = Array.isArray(beat.annotations) ? beat.annotations : null;
    const requests = authored?.length
      ? authored
      : buildEstablishAnnotationRequests(this.tour, beat);
    if (!requests.length) return;
    try {
      await this.annotations.annotate(requests, {
        persist: true,
        flyTo: false,
        clearPrevious: true,
      });
    } catch (error) {
      console.warn('[TourEngine] establish annotations failed', error);
    }
  }

  _clearTourAnnotations() {
    if (!this.annotations?.clear) return;
    try { this.annotations.clear(); } catch { /* ignore */ }
  }

  _publishReview(payload) {
    if (typeof window === 'undefined') return;
    window.__gevTourReview = {
      updatedAt: Date.now(),
      ...payload,
    };
  }

  async _dolly(beat) {
    let path = beat.travel?.polyline;
    if (!Array.isArray(path) || path.length < 2) {
      const from = this._placeFor(this.beatIndex - 1) || beat.place;
      const to = beat.place;
      if (from && to) {
        const routed = await fetchTourRoute(from, to);
        if (routed?.ok && Array.isArray(routed.polyline) && routed.polyline.length >= 2) {
          path = routed.polyline;
          if (routed.mode && beat.travel) beat.travel.mode = routed.mode;
        }
      }
    }
    if (!Array.isArray(path) || path.length < 2) {
      const from = this._placeFor(this.beatIndex - 1);
      const to = beat.place;
      if (from && to) path = [from, to];
    }
    if (!Array.isArray(path) || path.length < 2) return;
    const compress = beat.camera?.compressToSec || beat.travel?.durationPlaySec || beat.durationSec || 5;
    flyRoute(
      [{ type: 'route', path, label: beat.id }],
      { speed: 'fast', durationS: compress },
      (lat, lon) => cachedGroundFloor(lat, lon),
      (navigate) => (typeof this.styleManager?.runImmediateNavigation === 'function'
        ? this.styleManager.runImmediateNavigation('tour', navigate)
        : navigate()),
      (cells) => warmGroundFloor(cells),
    );
  }

  _placeFor(index) {
    const beat = this.tour?.beats?.[index];
    if (!beat) return null;
    const lat = beat.place?.lat ?? beat.camera?.lat;
    const lon = beat.place?.lon ?? beat.camera?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  }
}

/** Hold framing defaults — pull back for taller massing when range omitted. */
export function resolveHoldFraming(cam = {}) {
  const buildingHeight = Number.isFinite(cam.buildingHeight)
    ? Math.max(cam.buildingHeight, 35)
    : DEFAULT_HOLD_BUILDING_HEIGHT_M;
  let rangeM = cam.rangeM;
  if (!Number.isFinite(rangeM)) {
    rangeM = Math.min(1400, Math.max(DEFAULT_HOLD_RANGE_M, 480 + buildingHeight * 4.2));
  }
  return {
    rangeM,
    buildingHeight,
    heading: Number.isFinite(cam.heading) ? cam.heading : 0,
    pitch: Number.isFinite(cam.pitch) ? cam.pitch : -26,
  };
}

export function buildEstablishAnnotationRequests(tour, beat) {
  const requests = [];
  const cityName = tour?.city || beat?.place?.name || tour?.title || 'Tour area';
  const areaLat = beat?.place?.lat ?? beat?.camera?.lat ?? boundsCenter(tour?.bounds)?.lat;
  const areaLon = beat?.place?.lon ?? beat?.camera?.lon ?? boundsCenter(tour?.bounds)?.lon;
  requests.push({
    type: 'area',
    target: cityName,
    label: cityName,
    latitude: areaLat,
    longitude: areaLon,
    footprint: true,
    entityKind: 'district',
    intent: 'the_thing',
    color: 'primary',
  });
  const holds = (tour?.beats || []).filter((item) => item.kind === 'hold' && item.place?.name);
  holds.slice(0, 6).forEach((hold, index) => {
    requests.push({
      type: 'pin',
      target: hold.place.name,
      label: hold.title || hold.place.name,
      latitude: hold.place.lat,
      longitude: hold.place.lon,
      color: index % 2 === 0 ? 'amber' : 'cyan',
    });
  });
  return requests.filter((item) => (
    item.target
    || (Number.isFinite(item.latitude) && Number.isFinite(item.longitude))
  ));
}

function boundsCenter(bounds) {
  if (!bounds) return null;
  const { south, north, west, east } = bounds;
  if (![south, north, west, east].every(Number.isFinite)) return null;
  return { lat: (south + north) / 2, lon: (west + east) / 2 };
}

function summarizeBeat(beat) {
  if (!beat) return null;
  return {
    id: beat.id || null,
    kind: beat.kind || null,
    title: beat.title || null,
    place: beat.place || null,
    durationSec: beat.durationSec || null,
  };
}

function captureViewerCamera(viewer) {
  try {
    const cam = viewer?.camera;
    const carto = cam?.positionCartographic;
    if (!carto) return null;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
      alt: carto.height,
      heading: Cesium.Math.toDegrees(cam.heading),
      pitch: Cesium.Math.toDegrees(cam.pitch),
      roll: Cesium.Math.toDegrees(cam.roll),
    };
  } catch {
    return null;
  }
}

function flyToDestination(viewer, { lat, lon, alt, heading, pitch, roll, duration }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
      orientation: {
        heading: Cesium.Math.toRadians(heading || 0),
        pitch: Cesium.Math.toRadians(pitch || -40),
        roll: Cesium.Math.toRadians(roll || 0),
      },
      duration: Math.max(0.4, duration || 4),
      complete: finish,
      cancel: finish,
    });
    setTimeout(finish, ((duration || 4) + 0.8) * 1000);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
