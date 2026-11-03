/**
 * Voice area handles: `resolve_area` and the area scopes of `analyst_query`.
 *
 * One area store per action runner holds every area a turn can name — places
 * resolved by name, landmark areas drawn "around X", and annotation outlines
 * (the draw tool's areas and voice outlines). The model gets an `areaId` and a
 * summary; the geometry stays here.
 *
 * Names resolve through the same outline ladder as `annotate_map` (bundled
 * packs, the guarded Nominatim outline route, OpenFreeMap tiles, and
 * Overpass only when an operator configured it) — see data/areaResolver.js.
 *
 * Drawing uses the annotation engine with a simplified display copy. Counting
 * always reads the stored geometry, so a simplified outline never changes a
 * count.
 *
 * @module voice/areaActions
 */

import { createAreaStore, summarizeArea } from '../data/areaStore.js';
import { createAreaResolver } from '../data/areaResolver.js';
import { circleRing, displayParts } from '../data/areaGeometry.js';
import { findNaturalRegion } from '../data/naturalEarthRegions.js';
import { findAdminCandidates as findBundledAdminCandidates } from '../data/adminBoundaries.js';
import {
  NATURAL_EARTH_CREDIT,
  US_CENSUS_CREDIT,
  WOF_CREDIT,
  registerDynamicCredit,
} from '../data/dataCredits.js';
import { isUnavailableCapability } from '../sources/capability.js';
import { unavailablePlaceSearch } from '../search/placeSearch.js';

/** A spoken resolve waits this long before answering "still looking". */
const RESOLVE_BUDGET_MS = 8_000;
/** An analyst region scope waits this long (the base region-scope budget). */
const REGION_BUDGET_MS = 3_000;
/** Finding the landmark itself gives up after this. */
const AROUND_BUDGET_MS = 10_000;
/** The enclosing area gets this long before the buffer is used instead. */
const AROUND_OUTLINE_MS = 6_000;
/** Buffer radius around a landmark with no enclosing polygon. */
const AROUND_DEFAULT_RADIUS_M = 250;
const AROUND_MAX_RADIUS_M = 20_000;

/** What the annotation resolver should treat a named area as. */
const ENTITY_KIND = Object.freeze({
  country: 'country',
  admin1: 'state',
  admin2: 'county',
  district: 'district',
  site: 'compound',
});

/** How each area source is named on screen. */
const SOURCE_LABELS = Object.freeze({
  'natural-earth': 'Natural Earth',
  'us-census': 'US Census',
  wof: "Who's On First",
  datasf: 'DataSF',
  osm: 'OpenStreetMap',
  openfreemap: 'OpenStreetMap via OpenFreeMap',
  drawn: 'drawn by hand',
  annotation: 'map outline',
  approximate: 'approximate outline',
});

const ADMIN_IDENTITY_LEVEL = Object.freeze({
  country: 'country',
  nation: 'country',
  province: 'admin1',
  state: 'admin1',
  region: 'admin1',
  oblast: 'admin1',
  prefecture: 'admin1',
  canton: 'admin1',
  governorate: 'admin1',
  county: 'admin2',
  district: 'admin2',
  department: 'admin2',
  zone: 'retired',
});

function administrativeIdentity(value) {
  const normalized = String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
  const match = normalized.match(
    /\b(country|nation|province|state|region|zone|oblast|prefecture|canton|governorate|county|district|department)$/,
  );
  return {
    name: match ? normalized.slice(0, -match[0].length).trim() : normalized,
    level: match ? ADMIN_IDENTITY_LEVEL[match[1]] || null : null,
  };
}

/** Outline ladder source → area source and rung. */
function outlineOrigin(outlineSource) {
  switch (outlineSource) {
    case 'natural-earth':
    case 'us-census':
    case 'wof':
    case 'datasf':
      return { source: outlineSource, rung: 'bundled' };
    case 'openfreemap':
      return { source: 'openfreemap', rung: 'openfreemap' };
    case 'nominatim':
      return { source: 'osm', rung: 'nominatim' };
    default:
      // The base ladder's own OSM rungs run only on an operator Overpass.
      return { source: 'osm', rung: 'overpass' };
  }
}

/** Round an area for speech: "about 20,300 km²". */
export function spokenArea(km2) {
  if (!Number.isFinite(km2) || km2 <= 0) return null;
  if (km2 < 1) return `about ${Math.round(km2 * 100) / 100} km²`;
  const digits = Math.max(0, Math.floor(Math.log10(km2)) - 1);
  const rounded = Math.round(km2 / 10 ** digits) * 10 ** digits;
  return `about ${rounded.toLocaleString('en-US')} km²`;
}

const cancelledResult = () => ({
  ok: false,
  code: 'CANCELLED',
  cancelled: true,
  error: 'Superseded.',
});

/**
 * Build the runner's area services.
 * @param {object} options
 * @param {object} options.viewer
 * @param {object|null} options.annotations Annotation engine.
 * @param {object} [options.placeSearch]
 * @param {object} [options.annotationResolver] The annotation outline ladder.
 */
export function createVoiceAreas({
  viewer,
  annotations = null,
  placeSearch = unavailablePlaceSearch,
  annotationResolver = null,
  findRegion = findNaturalRegion,
  findAdminCandidates = findBundledAdminCandidates,
  aroundOutlineMs = AROUND_OUTLINE_MS,
} = {}) {
  // An area an outline on the map still refers to is never evicted: its
  // counting geometry must outlive the display copy drawn from it.
  const store = createAreaStore({
    isPinned: (areaId) =>
      typeof annotations?.list === 'function' &&
      annotations.list().some((anno) => anno?.areaId === areaId),
  });

  /** The ground at the centre of the view, else the camera's position. */
  function viewCenter() {
    const picked = annotationResolver?.pickWorldFromScreen?.(viewer, 0.5, 0.5);
    if (Number.isFinite(picked?.lat) && Number.isFinite(picked?.lon))
      return picked;
    const carto = viewer?.camera?.positionCartographic;
    return carto
      ? {
          lat: (carto.latitude * 180) / Math.PI,
          lon: (carto.longitude * 180) / Math.PI,
        }
      : null;
  }

  /**
   * The outline ladder for one resolved anchor, awaited with a budget.
   * Resolves the resolver's tri-state outline, or `{timeout: true}`.
   */
  async function awaitOutline(resolved, budgetMs) {
    if (resolved?.ring && !resolved.resolveOutline) return resolved;
    if (typeof resolved?.resolveOutline !== 'function') return null;
    if (!Number.isFinite(budgetMs))
      return resolved.resolveOutline().catch(() => undefined);
    let timer;
    try {
      return await Promise.race([
        resolved.resolveOutline().catch(() => undefined),
        new Promise((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout({ timeout: true }), budgetMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A named place through the annotation outline ladder: bundled packs near
   * the view or confirmed by the geocoder, then the guarded Nominatim
   * outline, then an operator Overpass when configured.
   */
  async function resolveNamedOutline(query, { level, levelHint, signal }) {
    if (typeof annotationResolver?.resolveAnnotationTarget !== 'function')
      return {
        ok: false,
        code: 'AREA_UNAVAILABLE',
        error: 'Boundary lookup is unavailable here.',
      };
    let resolved;
    try {
      resolved = await annotationResolver.resolveAnnotationTarget({
        placeSearch,
        viewer,
        target: query,
        footprint: true,
        deferFootprint: true,
        entityKind: ENTITY_KIND[level || levelHint] || null,
        allowDistant: true,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      resolved = null;
    }
    if (!resolved)
      return {
        ok: false,
        code: 'AREA_NOT_FOUND',
        error: `Could not find "${query}".`,
      };
    const directBundledOutline = Boolean(
      resolved?.ring &&
      !resolved.resolveOutline &&
      resolved.source === 'bundled',
    );
    const outline = await awaitOutline(resolved, Infinity);
    signal?.throwIfAborted?.();
    if (!outline?.ring || outline.ring.length < 3) {
      if (outline === null)
        return {
          ok: false,
          code: 'AREA_NOT_FOUND',
          error: `No boundary found for "${query}".`,
        };
      return {
        ok: false,
        code: 'AREA_UNAVAILABLE',
        error: isUnavailableCapability(outline)
          ? `No outline source can trace "${query}" here — it stays a point.`
          : `The boundary for "${query}" is not available right now — try again shortly.`,
      };
    }
    const { source, rung } = outlineOrigin(outline.outlineSource);
    const primaryLabel =
      String(resolved.label || query)
        .split(',')[0]
        .trim() || query;
    const requestedLabel = String(query).split(',')[0].trim();
    const requestedLevel = level || levelHint || null;
    const administrativeRequest = ['country', 'admin1', 'admin2'].includes(
      requestedLevel,
    );
    const administrativeLabel =
      /\b(country|nation|province|state|region|zone|oblast|prefecture|canton|governorate|county|district|department)$/i.test(
        primaryLabel,
      );
    const sourceIdentity = String(
      outline.adminArea || (directBundledOutline ? resolved.label : ''),
    )
      .split(',')[0]
      .trim();
    const sourceLevel = String(outline.adminLevel || '').trim();
    const sourceAdmin = administrativeIdentity(sourceIdentity);
    const primaryAdmin = administrativeIdentity(primaryLabel);
    const requestedAdmin = administrativeIdentity(requestedLabel);
    const sourceClaimsAdministrative = Boolean(
      administrativeRequest ||
      administrativeLabel ||
      outline.adminArea ||
      sourceAdmin.level,
    );
    const expectedAdministrativeLevel =
      requestedLevel || primaryAdmin.level || requestedAdmin.level || '';
    const verifiedSourceLevel =
      sourceLevel ||
      (directBundledOutline &&
      sourceAdmin.level &&
      sourceAdmin.level !== 'retired'
        ? sourceAdmin.level
        : '');
    if (sourceAdmin.level === 'retired') {
      return {
        ok: false,
        code: 'AREA_IDENTITY_MISMATCH',
        error: `The boundary source returned ${sourceIdentity}, a retired administrative identity.`,
      };
    }
    if (outline.synthesized && sourceClaimsAdministrative) {
      return {
        ok: false,
        code: 'AREA_IDENTITY_UNVERIFIED',
        error: `The available outline for "${query}" is only an approximation, not a verified administrative boundary.`,
      };
    }
    if (sourceClaimsAdministrative && !sourceIdentity) {
      return {
        ok: false,
        code: 'AREA_IDENTITY_UNVERIFIED',
        error: `The boundary source did not verify which administrative area "${query}" names.`,
      };
    }
    if (sourceIdentity && sourceAdmin.name !== primaryAdmin.name) {
      return {
        ok: false,
        code: 'AREA_IDENTITY_MISMATCH',
        error: `The boundary source returned ${sourceIdentity}, not ${primaryLabel}.`,
      };
    }
    if (
      administrativeRequest &&
      sourceIdentity &&
      sourceAdmin.name !== requestedAdmin.name
    ) {
      return {
        ok: false,
        code: 'AREA_IDENTITY_MISMATCH',
        error: `The boundary source returned ${sourceIdentity}, not ${requestedLabel}.`,
      };
    }
    if (
      sourceClaimsAdministrative &&
      sourceAdmin.level &&
      expectedAdministrativeLevel &&
      sourceAdmin.level !== expectedAdministrativeLevel
    ) {
      return {
        ok: false,
        code: 'AREA_IDENTITY_MISMATCH',
        error: `The boundary source returned ${sourceIdentity}, not ${expectedAdministrativeLevel}.`,
      };
    }
    if (sourceClaimsAdministrative && !verifiedSourceLevel) {
      return {
        ok: false,
        code: 'AREA_IDENTITY_UNVERIFIED',
        error: `The boundary source did not verify the administrative level for "${query}".`,
      };
    }
    if (
      sourceClaimsAdministrative &&
      expectedAdministrativeLevel &&
      verifiedSourceLevel !== expectedAdministrativeLevel
    ) {
      return {
        ok: false,
        code: 'AREA_IDENTITY_MISMATCH',
        error: `The boundary source returned ${sourceLevel}, not ${expectedAdministrativeLevel}.`,
      };
    }
    const polygons =
      Array.isArray(outline.polygons) && outline.polygons.length
        ? outline.polygons
        : [[outline.ring]];
    return {
      ok: true,
      name: sourceIdentity || primaryLabel,
      ...(sourceIdentity ? { adminName: sourceIdentity } : {}),
      ...(verifiedSourceLevel ? { adminLevel: verifiedSourceLevel } : {}),
      polygons,
      source,
      rung,
      approximate: Boolean(outline.synthesized),
      ...(outline.synthesized ? { basis: 'buffer sized to the place' } : {}),
    };
  }

  const resolver = createAreaResolver({
    store,
    findNaturalRegion: findRegion,
    findAdminCandidates,
    resolveNamedOutline,
    viewCenter,
    onCredit: (source) => {
      const credit = {
        'natural-earth': NATURAL_EARTH_CREDIT,
        'us-census': US_CENSUS_CREDIT,
        wof: WOF_CREDIT,
      }[source];
      if (credit) registerDynamicCredit(viewer, credit);
    },
  });

  const boardGeneration = () =>
    typeof annotations?.generation === 'function'
      ? annotations.generation()
      : 0;

  /** Draw a stored area through the annotation engine. */
  async function drawArea(
    record,
    {
      flyTo = true,
      color = 'cyan',
      signal = null,
      isCurrent = () => true,
    } = {},
  ) {
    if (signal?.aborted || !isCurrent())
      return { drawn: false, cancelled: true };
    if (typeof annotations?.annotate !== 'function')
      return { drawn: false, reason: 'Annotation engine unavailable' };
    const shown = displayParts(record.geometry, {
      // Draped outlines are tessellated against the terrain and tiles; a few
      // hundred vertices per area keeps drawing fast. Counting is unaffected.
      maxVertices: 1200,
      maxParts: 24,
    });
    if (!shown.parts.length) return { drawn: false, reason: 'Nothing to draw' };
    const polygons = shown.parts.map((part) => [part.outer, ...part.holes]);
    const result = await annotations.annotate(
      [
        {
          type: 'area',
          manual: true,
          origin: 'area',
          areaId: record.areaId,
          ring: polygons[0][0],
          polygons,
          label: record.name,
          color,
          approximate: record.approximate,
        },
      ],
      {
        persist: true,
        flyTo,
        clearPrevious: false,
        signal,
        isCurrent,
      },
    );
    if (signal?.aborted || !isCurrent() || result?.aborted)
      return { drawn: false, cancelled: true };
    const item = (result?.results || [])[0];
    const drawn = Boolean(item?.ok);
    const reason = drawn
      ? null
      : result?.capped
        ? 'annotation limit reached'
        : item?.error || result?.error || 'the outline could not be added';
    return {
      drawn,
      annotationId: item?.id || null,
      ...(reason ? { reason } : {}),
      ...(shown.drawnParts < shown.totalParts
        ? { drawnParts: shown.drawnParts, totalParts: shown.totalParts }
        : {}),
    };
  }

  /** Area-like annotations, newest first. */
  function areaAnnotations(predicate = () => true) {
    const list =
      typeof annotations?.list === 'function' ? annotations.list() : [];
    return list
      .filter(
        (anno) =>
          Array.isArray(anno?.ring) && anno.ring.length >= 3 && predicate(anno),
      )
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  /**
   * The area an outline on the map stands for. An outline drawn from an area
   * handle counts over that handle's full geometry, never over its simplified
   * drawing; when the handle is gone (the page reloaded, so the store is
   * new while the persisted outline remains) the answer is AREA_EXPIRED,
   * not a count over the drawing. A hand-drawn outline IS its geometry. A
   * voice annotation outline counts over every part it drew and is marked
   * approximate when it was a buffer.
   * @returns {object} A stored record, or a refusal with `code`.
   */
  function areaForAnnotation(anno) {
    if (anno.areaId) {
      const stored = store.get(anno.areaId);
      if (stored) return stored;
      return {
        code: 'AREA_EXPIRED',
        error: `The outline of ${anno.label || 'that area'} was drawn before this page loaded — resolve it again to count inside it.`,
      };
    }
    const drawn = anno.origin === 'drawn';
    const geometry =
      Array.isArray(anno.polygons) && anno.polygons.length
        ? anno.polygons
        : [[anno.ring]];
    return (
      store.put({
        geometry,
        name: anno.label || (drawn ? 'the drawn area' : 'the outlined area'),
        source: drawn ? 'drawn' : 'annotation',
        level: drawn ? 'drawn' : null,
        sourceId: `anno:${anno.id}`,
        approximate: Boolean(anno.synthesized),
      }) || {
        code: 'AREA_UNKNOWN',
        error: 'That outline is not a usable area.',
      }
    );
  }

  /**
   * Provider for analyst_query's `area`, `drawn` and `annotation` scopes.
   * @param {{kind: string, areaId?: string, id?: string}} scope
   */
  async function resolveAreaScope(scope) {
    const found = (record) =>
      record?.code
        ? { ok: false, code: record.code, error: record.error }
        : record
          ? {
              ok: true,
              area: {
                areaId: record.areaId,
                name: record.name,
                prepared: record.prepared,
                source: record.source,
                sourceLabel: SOURCE_LABELS[record.source] || record.source,
                approximate: record.approximate,
              },
            }
          : null;
    if (scope.kind === 'area') {
      return (
        found(store.get(scope.areaId)) || {
          ok: false,
          code: 'AREA_UNKNOWN',
          error: `No area "${scope.areaId}" on this page — call resolve_area again.`,
        }
      );
    }
    if (scope.kind === 'drawn') {
      const anno = areaAnnotations((a) => a.origin === 'drawn')[0];
      return (
        found(anno && areaForAnnotation(anno)) || {
          ok: false,
          code: 'NO_DRAWN_AREA',
          error:
            'Nothing is drawn on the map — draw an area with the draw tool first.',
        }
      );
    }
    const anno = scope.id
      ? areaAnnotations((a) => a.id === scope.id)[0]
      : areaAnnotations()[0];
    return (
      found(anno && areaForAnnotation(anno)) || {
        ok: false,
        code: 'NO_AREA_ANNOTATION',
        error: scope.id
          ? `Annotation ${scope.id} is not an outlined area.`
          : 'No outlined area is on the map.',
      }
    );
  }

  /**
   * Provider for analyst_query's `region` scope: the same ladder, the base
   * 3 s budget, answers in the engine's region shape.
   */
  async function resolveRegion(name, { signal } = {}) {
    const result = await resolver.resolve(
      { query: name },
      { signal, budgetMs: REGION_BUDGET_MS },
    );
    if (result.ok)
      return {
        name: result.record.name,
        prepared: result.record.prepared,
        geometry: result.record.geometry,
        source: result.record.source,
        sourceLabel:
          SOURCE_LABELS[result.record.source] || result.record.source,
        areaId: result.record.areaId,
        approximate: result.record.approximate,
      };
    if (result.needsClarification) return result;
    if (result.code === 'AREA_TIMEOUT')
      return { name, ring: null, error: 'region-timeout' };
    return null;
  }

  /** "An area around <landmark>": its enclosing area, else a buffer. */
  async function resolveAround(args, { signal }) {
    const target = String(args.query || '').trim();
    if (
      !target ||
      typeof annotationResolver?.resolveAnnotationTarget !== 'function'
    )
      return { ok: false, code: 'BAD_AREA', error: 'Name a landmark.' };
    const budget = AbortSignal.timeout(AROUND_BUDGET_MS);
    const combined = signal ? AbortSignal.any([signal, budget]) : budget;
    let resolved;
    let outline = null;
    try {
      // The anchor first; the enclosing outline (Nominatim grounds, then the
      // OpenFreeMap area holding it) is a bounded extra.
      resolved = await annotationResolver.resolveAnnotationTarget({
        placeSearch,
        viewer,
        target,
        footprint: true,
        deferFootprint: true,
        entityKind: 'compound',
        allowDistant: true,
        signal: combined,
      });
      outline = resolved ? await awaitOutline(resolved, aroundOutlineMs) : null;
    } catch {
      resolved = null;
    }
    if (signal?.aborted) return cancelledResult();
    if (!resolved) {
      return budget.aborted
        ? {
            ok: false,
            code: 'AREA_TIMEOUT',
            error: `Finding ${target} is taking a while — ask again in a moment.`,
          }
        : {
            ok: false,
            code: 'AREA_NOT_FOUND',
            error: `Could not find ${target}.`,
          };
    }
    const explicitRadius =
      args.radiusM !== undefined &&
      args.radiusM !== null &&
      Number.isFinite(Number(args.radiusM));
    const radiusM = Math.max(
      50,
      Math.min(
        AROUND_MAX_RADIUS_M,
        Number(args.radiusM) || AROUND_DEFAULT_RADIUS_M,
      ),
    );
    // A real enclosing outline counts with every part it came with; anything
    // else (no outline, a sized buffer, a slow lookup) is a labelled buffer.
    const exact =
      !explicitRadius &&
      Array.isArray(outline?.ring) &&
      outline.ring.length >= 3 &&
      !outline.synthesized;
    const origin = exact ? outlineOrigin(outline.outlineSource) : null;
    const geometry = exact
      ? Array.isArray(outline.polygons) && outline.polygons.length
        ? outline.polygons
        : [[outline.ring]]
      : [[circleRing(resolved.lat, resolved.lon, radiusM)]];
    // The landmark as the user named it ("Ferry Building"), not the geocoder's
    // street address.
    const name = String(target.split(',')[0].trim() || target).slice(0, 120);
    const record = store.put({
      geometry,
      name,
      source: exact ? origin.source : 'approximate',
      level: 'site',
      approximate: !exact,
      meta: {
        around: target,
        rung: exact ? origin.rung : 'buffer',
        ...(exact ? {} : { radiusM }),
        basis: exact
          ? 'enclosing mapped area'
          : `${radiusM} m around the landmark`,
      },
    });
    if (!record)
      return {
        ok: false,
        code: 'AREA_NOT_FOUND',
        error: `Could not outline ${target}.`,
      };
    return {
      ok: true,
      record,
      confidence: exact ? 0.8 : 0.5,
      rung: exact ? origin.rung : 'buffer',
    };
  }

  /**
   * The `resolve_area` action.
   * @param {object} args Tool arguments.
   * @param {{signal?: AbortSignal, isCurrent?: () => boolean, progress?: Function}} [runOptions]
   *   `progress(step, label)` reports `resolve` then `draw` for narration.
   */
  async function resolveAreaAction(args = {}, runOptions = {}) {
    const current = () =>
      !runOptions.signal?.aborted &&
      (typeof runOptions.isCurrent !== 'function' || runOptions.isCurrent());
    const progress = (step, label) => {
      if (current()) runOptions.progress?.(step, label);
    };
    progress('resolve', String(args.query || ''));
    const started = Date.now();
    // The board as it was when the user asked: a clear while the lookup runs
    // means the outline (and its camera move) is no longer wanted.
    const boardAtStart = boardGeneration();
    const result = args.around
      ? await resolveAround(args, { signal: runOptions.signal })
      : await resolver.resolve(
          {
            query: args.query,
            level: args.level,
            within: args.within,
            candidateId: args.candidateId,
          },
          { signal: runOptions.signal, budgetMs: RESOLVE_BUDGET_MS },
        );
    if (!current())
      return {
        ok: false,
        action: 'resolve_area',
        code: 'CANCELLED',
        cancelled: true,
        error: 'This request was superseded.',
      };
    if (!result.ok) {
      return {
        ok: false,
        action: 'resolve_area',
        code: result.code || 'AREA_NOT_FOUND',
        error: result.error,
        ...(result.needsClarification
          ? {
              needsClarification: true,
              query: String(args.query || ''),
              candidates: result.candidates,
            }
          : {}),
      };
    }
    const { record } = result;
    const draw = args.draw === true || Boolean(args.around);
    const boardCleared = draw && boardGeneration() !== boardAtStart;
    if (draw && !boardCleared) progress('draw', record.name);
    const drawing =
      draw && !boardCleared
        ? await drawArea(record, {
            flyTo: args.flyTo !== false,
            signal: runOptions.signal,
            isCurrent: current,
          })
        : null;
    if (!current() || drawing?.cancelled)
      return {
        ok: false,
        action: 'resolve_area',
        code: 'CANCELLED',
        cancelled: true,
        error: 'This request was superseded.',
      };
    const size = spokenArea(record.areaKm2);
    const basis = record.meta.basis;
    const baseSay = record.approximate
      ? `Rough area around ${record.name}${size ? ` — ${size}` : ''}`
      : `${record.name}${record.meta.country ? `, ${record.meta.country}` : ''}${size ? ` — ${size}` : ''}`;
    const notDrawn = boardCleared
      ? 'the map was cleared while looking it up'
      : drawing && !drawing.drawn
        ? drawing.reason
        : null;
    const drawFailed = Boolean(notDrawn);
    return {
      ok: true,
      action: 'resolve_area',
      ...summarizeArea(record),
      ...(record.meta.adminName
        ? { sourceIdentity: record.meta.adminName }
        : {}),
      confidence: result.confidence,
      cached: Boolean(result.cached),
      ms: Date.now() - started,
      resolveMs: result.ms ?? null,
      ...(drawing ? { drawn: drawing.drawn } : {}),
      ...(drawFailed
        ? {
            partial: true,
            notDrawn,
          }
        : {}),
      ...(boardCleared ? { drawn: false } : {}),
      say: drawFailed
        ? `${baseSay}. I resolved the area, but couldn't draw the outline: ${notDrawn}.`
        : baseSay,
      display: {
        source: SOURCE_LABELS[record.source] || record.source,
        ...(basis ? { basis } : {}),
        ...(record.parts > 1 ? { parts: `${record.parts} parts` } : {}),
        ...(drawing?.totalParts
          ? {
              drawnParts: `${drawing.drawnParts} of ${drawing.totalParts} parts drawn`,
            }
          : {}),
      },
    };
  }

  return {
    store,
    resolver,
    resolveAreaAction,
    resolveAreaScope,
    resolveRegion,
    drawArea,
    dispose: () => resolver.dispose(),
  };
}
