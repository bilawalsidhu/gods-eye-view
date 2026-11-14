import {
  formatAwarenessLabel,
  AWARENESS_RADIUS_M,
} from '../../data/militaryAwarenessEngine.js';
import {
  formatNumber,
  onLocaleChange,
  t,
  translateKnown,
} from '../../i18n/index.js';
import { sourceStatusLabel } from '../../ui/layerNames.js';
import { formatQuantity } from '../../ui/unitLabels.js';
import { AWARENESS_PAGE_SIZE, AWARENESS_PAGE_ROTATE_MS } from './policy.js';
import { distanceParts } from '../../data/distanceFormat.js';

/** Format a cohort total without presenting a retained cap as exact. */
export function formatAwarenessCount(summary = {}) {
  if (!Number.isFinite(summary.count)) return '?';
  const count = summary.count.toLocaleString('en-US');
  return summary.complete === false || summary.truncated === true
    ? `At least ${count}`
    : count;
}

/** The count as the panel shows it, in the UI language. */
function presentAwarenessCount(summary = {}) {
  if (!Number.isFinite(summary.count)) return '?';
  const count = formatNumber(summary.count);
  return summary.complete === false || summary.truncated === true
    ? t('At least {count}', { count })
    : count;
}

/** A distance as the panel shows it: 850 m, 4.6 km, 120 km, in the UI language. */
export function presentAwarenessDistance(meters) {
  const parts = distanceParts(meters);
  if (!parts) return '—';
  return formatQuantity(parts.value, parts.unit, {
    minimumFractionDigits: parts.digits,
    maximumFractionDigits: parts.digits,
  });
}

/** The cohort's reason, kept English in data, shown in the UI language. */
function presentAwarenessReason(summary = {}) {
  return summary.reasonTemplate
    ? t(summary.reasonTemplate, summary.reasonValues)
    : translateKnown(summary.reason || '');
}

/**
 * The Contacts panel as a view renders it. The layer presents a plain view
 * object (`standby`, `results` or `empty`) and publishes it to subscribers;
 * Core's AwarenessPanel component renders it and calls the layer's
 * navigation methods. Text arrives in the UI language.
 */
export function createPanel({ state: layerState, parts }) {
  /** Publish a fresh view unless it is the one already shown. */
  function publish(view) {
    const signature = JSON.stringify(view);
    if (layerState.panelSignature === signature) return;
    layerState.panelSignature = signature;
    layerState.panelView = view;
    for (const listener of [...layerState.panelListeners]) listener(view);
  }

  /**
   * Receive every published view, starting with the current one.
   * @param {(view: object) => void} listener
   * @returns {() => void} Unsubscribe.
   */
  function subscribePanel(listener) {
    layerState.panelListeners.add(listener);
    if (layerState.panelView) listener(layerState.panelView);
    return () => layerState.panelListeners.delete(listener);
  }

  /** The panel shows layer views from the first enable or result onwards. */
  function ensurePanel() {
    layerState.panelShown = true;
    // A shown view is worded again in a new locale.
    layerState.offPanelLocale ??= onLocaleChange(() => {
      const kind = layerState.panelView?.kind;
      if (kind === 'results') renderResults();
      else if (kind === 'standby') hidePanel();
    });
  }

  function hidePanel() {
    if (layerState.panelShown)
      publish({
        kind: 'standby',
        title: layerState.enabled
          ? t('CONTEXT READY')
          : t('GLOBAL CONTEXT OFF'),
        text: layerState.enabled
          ? t('SELECT A FLIGHT, VESSEL, OR MAPPED INSTALLATION')
          : t('ENABLE TO LOAD OBSERVED / MAPPED PROXIMITY'),
      });
    parts.rendering.hideDirectionOverlay();
  }

  /** Clear the panel when the layer is destroyed. */
  function clearPanel() {
    if (layerState.panelShown) publish({ kind: 'empty' });
    layerState.offPanelLocale?.();
    layerState.offPanelLocale = null;
    layerState.panelShown = false;
    layerState.panelView = null;
    layerState.panelSignature = '';
  }

  function presentRow(cohort) {
    const summary = cohort.summary;
    const page = layerState.cohortPages.get(cohort.id) || 0;
    const nearest = summary.nearest
      .slice(page, page + AWARENESS_PAGE_SIZE)
      .map((item, index) => {
        const label = formatAwarenessLabel(item);
        const targetId = item.icao24 || item.id || item.mmsi;
        const distance = presentAwarenessDistance(item.distanceM);
        if (!targetId)
          return {
            key: `unavailable:${page + index}`,
            label,
            distance,
            ariaLabel: t('Unavailable'),
          };
        const accessibleLabel = label === '—' ? t('Unavailable') : label;
        return {
          key: `target:${cohort.id}:${targetId}`,
          layer: cohort.id,
          targetId: String(targetId),
          label,
          distance,
          ariaLabel: t('Focus {label}', { label: accessibleLabel }),
          names: presentNames(item.memberNames),
        };
      });
    const pageCount = Math.max(
      1,
      Math.ceil(summary.nearest.length / AWARENESS_PAGE_SIZE),
    );
    const pageLabel =
      pageCount > 1
        ? ` · ${Math.floor(page / AWARENESS_PAGE_SIZE) + 1}/${pageCount}`
        : '';
    const coverage = cohort.coverage ? ` · ${cohort.coverage}` : '';
    return {
      id: cohort.id,
      relationship: summary.relationship.toLowerCase(),
      label: cohort.label,
      count: `${presentAwarenessCount(summary)}${pageLabel}`,
      detail: `${sourceStatusLabel(cohort.source, cohort.sourceStatus)}${coverage} · ${presentAwarenessReason(summary)}`,
      nearest,
    };
  }

  function presentNavigation() {
    return {
      label: t('Global Context navigation'),
      previous: {
        text: t('PREVIOUS'),
        title: t('Previous — prior visited contact in the 250 km window'),
        disabled: !(layerState.navigationIndex > 0),
      },
      focus: { text: t('FOCUS') },
      next: {
        text: t('NEXT'),
        title: t('Next — nearest unvisited contact in the 250 km window'),
        disabled: !parts.navigation.canNavigateNext(),
      },
    };
  }

  function presentNames(names) {
    return names?.length
      ? {
          summary: t('Named areas ({n})', { n: formatNumber(names.length) }),
          names: [...names].map((name) => String(name ?? '')),
        }
      : null;
  }

  /** The credit line: the photographer, and an open photo's licence. A
   *  photo whose answer names no photographer shows no photographer. */
  function photoCredit(photo) {
    if (photo.licence)
      return photo.photographer
        ? t('Photo: {photographer} · {licence}', {
            photographer: photo.photographer,
            licence: photo.licence,
          })
        : t('Photo · {licence}', { licence: photo.licence });
    return photo.photographer
      ? t('Photo © {photographer}', { photographer: photo.photographer })
      : '';
  }

  /** The subject's photo with its credit, or null. The subject
   *  refresh resolves it; only the subject it was resolved for shows it. */
  function presentPhoto(subject) {
    const held = layerState.subjectPhoto;
    if (
      !held ||
      held.layerId !== subject.layerId ||
      String(held.id) !== String(subject.id)
    )
      return null;
    const { photo } = held;
    return {
      src: photo.src,
      width: photo.width ?? null,
      height: photo.height ?? null,
      link: photo.link,
      credit: photoCredit(photo),
    };
  }

  function renderResults() {
    if (!layerState.enabled || !layerState.results) return hidePanel();
    ensurePanel();
    layerState.panelRenders += 1;
    const { subject, cohorts } = layerState.results;
    publish({
      kind: 'results',
      subject: `${subject.label} · ${t('{distance} FLIGHT / VESSEL WINDOW', { distance: presentAwarenessDistance(AWARENESS_RADIUS_M) })}`,
      subjectNames: presentNames(subject.memberNames),
      photo: presentPhoto(subject),
      navigation: presentNavigation(),
      rows: cohorts.map(presentRow),
      note: t(
        'Open-source mapped/observed context. Missing broadcasts, unloaded map areas, or unmapped sites are not evidence of absence.',
      ),
    });
  }

  function rotateAwarenessPages() {
    if (!layerState.enabled || !layerState.results) return;
    let changed = false;
    for (const cohort of layerState.results.cohorts) {
      const pageCount = Math.max(
        1,
        Math.ceil(cohort.summary.nearest.length / AWARENESS_PAGE_SIZE),
      );
      if (pageCount <= 1) continue;
      const current = layerState.cohortPages.get(cohort.id) || 0;
      layerState.cohortPages.set(
        cohort.id,
        ((Math.floor(current / AWARENESS_PAGE_SIZE) + 1) % pageCount) *
          AWARENESS_PAGE_SIZE,
      );
      changed = true;
    }
    if (changed) {
      renderResults();
      parts.rendering.scheduleDirectionOverlayUpdate(true);
    }
  }

  function startAwarenessPageRotation() {
    if (!layerState.pageTimer)
      layerState.pageTimer = window.setInterval(
        rotateAwarenessPages,
        AWARENESS_PAGE_ROTATE_MS,
      );
  }

  function stopAwarenessPageRotation() {
    if (layerState.pageTimer) window.clearInterval(layerState.pageTimer);
    layerState.pageTimer = null;
  }

  /**
   * Whether an evaluation actually has a contact to point an arrow at.
   *
   * A cohort reports `count: null` when its feed is unavailable or stale, and `0`
   * when the feed is healthy but empty. Only a positive count puts a marker on
   * the compass rim, so anything else means there is nothing to animate.
   * @param {?{cohorts?: Array<{summary?: {count: ?number}}>}} results
   * @returns {boolean}
   */

  function awarenessResultsAreLive(results) {
    const cohorts = Array.isArray(results?.cohorts) ? results.cohorts : [];
    return cohorts.some((cohort) => Number(cohort?.summary?.count) > 0);
  }
  return {
    subscribePanel,
    ensurePanel,
    hidePanel,
    clearPanel,
    renderResults,
    rotateAwarenessPages,
    startAwarenessPageRotation,
    stopAwarenessPageRotation,
    awarenessResultsAreLive,
  };
}
