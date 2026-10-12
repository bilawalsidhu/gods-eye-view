import {
  formatAwarenessLabel,
  formatAwarenessDistance,
  AWARENESS_RADIUS_M,
} from '../../data/militaryAwarenessEngine.js';
import { t, subscribeLocale } from '../../i18n/index.js';
import { AWARENESS_PAGE_SIZE, AWARENESS_PAGE_ROTATE_MS } from './policy.js';

// Cohort labels arrive as stable English data (subject.js builds them and the
// voice tools read the same records); this panel is the presentation edge.
const COHORT_LABEL_KEYS = {
  flights: 'awareness.cohort.flights',
  military: 'awareness.cohort.military',
  'ais-live-vessels': 'awareness.cohort.aisLiveVessels',
  'military-installations': 'awareness.cohort.militaryInstallations',
};

// summarizeAwarenessCohort() reasons are stable English engine messages
// (asserted by the engine's own tests); translate the known set here.
const COHORT_REASON_KEYS = {
  'feed unavailable': 'awareness.reason.feedUnavailable',
  'feed stale': 'awareness.reason.feedStale',
  'observed or mapped nearby context': 'awareness.reason.nearby',
  'no observed or mapped objects in current feeds': 'awareness.reason.none',
};

/** Present a cohort label through the active locale when it is a known cohort. */
function presentCohortLabel(cohort) {
  const key = COHORT_LABEL_KEYS[cohort.id];
  return key ? t(key) : cohort.label;
}

/** Translate known engine reason messages; unknown upstream text passes through. */
function presentCohortReason(reason) {
  const key = COHORT_REASON_KEYS[reason];
  return key ? t(key) : reason;
}

/** Translate the known viewport-coverage token; other coverage text is data. */
function presentCoverage(coverage) {
  return coverage === 'CURRENT VIEWPORT ONLY'
    ? t('awareness.coverage.currentViewportOnly')
    : coverage;
}

/** Format a cohort total without presenting a retained cap as exact. */
export function formatAwarenessCount(summary = {}) {
  if (!Number.isFinite(summary.count)) return '?';
  const count = summary.count.toLocaleString('en-US');
  return summary.complete === false || summary.truncated === true
    ? `At least ${count}`
    : count;
}

/** Locale-aware paint of formatAwarenessCount for panel copy. */
function presentAwarenessCount(summary = {}) {
  if (!Number.isFinite(summary.count)) return '?';
  const count = summary.count.toLocaleString('en-US');
  return summary.complete === false || summary.truncated === true
    ? t('awareness.count.atLeast', { n: count })
    : count;
}

export function createPanel({ state: layerState, services, parts, source }) {
  // A locale switch repaints whichever state the panel currently holds —
  // standby chrome or the live results snapshot. The subscription is released
  // by the layer's destroy path (lifecycle.destroy).
  layerState.localeUnsubscribe = subscribeLocale(() => {
    if (!layerState.panel) return;
    if (layerState.enabled && layerState.results) renderResults();
    else hidePanel();
  });

  function ensurePanel() {
    if (layerState.panel) return layerState.panel;
    const existing = document.getElementById('military-awareness-panel');
    const panel = existing || document.createElement('aside');
    layerState.panelOwned = !existing;
    if (!existing) {
      panel.id = 'military-awareness-panel';
    }
    layerState.panelClickListener = (event) => {
      const action = event.target.closest('button[data-awareness-action]');
      if (action) {
        event.preventDefault();
        if (action.dataset.awarenessAction === 'previous')
          parts.history.navigateHistory(-1, { origin: 'user' });
        if (action.dataset.awarenessAction === 'next')
          parts.history.navigateHistory(1, { origin: 'user' });
        if (action.dataset.awarenessAction === 'focus')
          parts.focus.focusCurrentSubject({ origin: 'user' });
        return;
      }
      const target = event.target.closest(
        'button[data-awareness-layer][data-awareness-id]',
      );
      if (!target) return;
      event.preventDefault();
      parts.focus.requestFocus(
        target.dataset.awarenessLayer,
        target.dataset.awarenessId,
        false,
        { origin: 'user' },
      );
    };
    panel.addEventListener('click', layerState.panelClickListener);
    if (!existing) document.body.appendChild(panel);
    layerState.panel = panel;
    return panel;
  }

  function hidePanel() {
    if (layerState.panel) {
      const markup = `<div class="military-awareness-standby">
      <strong>${layerState.enabled ? t('awareness.standby.ready') : t('awareness.standby.off')}</strong>
      <span>${layerState.enabled ? t('awareness.standby.selectPrompt') : t('awareness.standby.enablePrompt')}</span>
    </div>`;
      layerState.panel.hidden = false;
      if (layerState.panelMarkup !== markup) {
        layerState.panel.innerHTML = markup;
        layerState.panelMarkup = markup;
      }
    }
    if (layerState.directionRoot) layerState.directionRoot.hidden = true;
  }

  function rowHtml(cohort) {
    const summary = cohort.summary;
    const count = presentAwarenessCount(summary);
    const page = layerState.cohortPages.get(cohort.id) || 0;
    const nearest = summary.nearest
      .slice(page, page + AWARENESS_PAGE_SIZE)
      .map((item) => {
        const label = formatAwarenessLabel(item);
        const targetId = item.icao24 || item.mmsi || item.id;
        if (!targetId) {
          return `<li><span class="military-awareness-target unavailable" aria-label="${escapeHtml(t('awareness.row.unavailableAria'))}">${escapeHtml(label)} <span>${formatAwarenessDistance(item.distanceM)}</span></span></li>`;
        }
        const accessibleLabel =
          label === '—' ? t('awareness.row.unavailableAria') : label;
        return `<li><button type="button" class="military-awareness-target" data-awareness-layer="${escapeHtml(cohort.id)}" data-awareness-id="${escapeHtml(targetId)}" aria-label="${escapeHtml(t('awareness.row.focusAria', { label: accessibleLabel }))}">${escapeHtml(label)} <span>${formatAwarenessDistance(item.distanceM)}</span></button>${namedAreasHtml(item.memberNames)}</li>`;
      })
      .join('');
    const pageCount = Math.max(
      1,
      Math.ceil(summary.nearest.length / AWARENESS_PAGE_SIZE),
    );
    const pageLabel =
      pageCount > 1
        ? t('awareness.row.pageLabel', {
            page: Math.floor(page / AWARENESS_PAGE_SIZE) + 1,
            pages: pageCount,
          })
        : '';
    const coverage = cohort.coverage
      ? ` · ${escapeHtml(presentCoverage(cohort.coverage))}`
      : '';
    return `<section class="military-awareness-row ${summary.relationship.toLowerCase()}">
    <div><strong>${escapeHtml(presentCohortLabel(cohort))}</strong><b aria-live="polite">${count}${pageLabel}</b></div>
    <small>${escapeHtml(cohort.source)}${coverage} · ${escapeHtml(presentCohortReason(summary.reason))}</small>
    ${nearest ? `<ul>${nearest}</ul>` : ''}
  </section>`;
  }

  function navigationControlsHtml() {
    const canPrevious = layerState.navigationIndex > 0;
    return `<div class="military-awareness-controls" role="group" aria-label="${escapeHtml(t('awareness.nav.aria'))}">
    <button type="button" data-awareness-action="previous" title="${escapeHtml(t('awareness.nav.prevTitle'))}"${canPrevious ? '' : ' disabled'}>${escapeHtml(t('awareness.nav.prev'))}</button>
    <button type="button" data-awareness-action="focus">${escapeHtml(t('awareness.nav.focus'))}</button>
    <button type="button" data-awareness-action="next" title="${escapeHtml(t('awareness.nav.nextTitle'))}"${parts.navigation.canNavigateNext() ? '' : ' disabled'}>${escapeHtml(t('awareness.nav.next'))}</button>
  </div>`;
  }

  /** Stable identity for a delegated Contacts-panel button across live repaints. */

  function awarenessPanelControlKey(element) {
    const control = element?.closest?.(
      'button[data-awareness-action], button[data-awareness-layer][data-awareness-id]',
    );
    if (!control) return null;
    if (control.dataset.awarenessAction)
      return `action:${control.dataset.awarenessAction}`;
    return `target:${control.dataset.awarenessLayer}:${control.dataset.awarenessId}`;
  }

  /** Capture stable identity so a live repaint can restore only the same control. */

  function captureAwarenessPanelFocus(
    panel,
    activeElement = document.activeElement,
  ) {
    if (!panel?.contains?.(activeElement)) return null;
    if (activeElement?.matches?.('[data-awareness-focus-continuation]')) {
      return { key: 'continuation' };
    }
    const key = awarenessPanelControlKey(activeElement);
    if (!key) return null;
    return { key };
  }

  /** Restore the same control, or continue beyond the list when it is no longer rendered. */

  function restoreAwarenessPanelFocus(panel, snapshot) {
    if (!panel || !snapshot) return null;
    const continuation = panel.querySelector(
      '[data-awareness-focus-continuation]',
    );
    const controls = [
      ...panel.querySelectorAll(
        'button[data-awareness-action], button[data-awareness-layer][data-awareness-id]',
      ),
    ].filter((control) => !control.disabled);
    const retained =
      snapshot.key === 'continuation'
        ? continuation
        : controls.find(
            (control) => awarenessPanelControlKey(control) === snapshot.key,
          );
    const target = retained || continuation;
    target?.focus?.({ preventScroll: true });
    return target || null;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(
      /[&<>'"]/g,
      (char) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          "'": '&#39;',
          '"': '&quot;',
        })[char],
    );
  }

  function namedAreasHtml(names) {
    return names?.length
      ? `<details class="military-awareness-names"><summary>${escapeHtml(t('awareness.namedAreas', { n: names.length }))}</summary><div>${names.map((name) => escapeHtml(name)).join('<br>')}</div></details>`
      : '';
  }

  function renderResults() {
    if (!layerState.enabled || !layerState.results) return hidePanel();
    const panel = ensurePanel();
    const { subject, cohorts } = layerState.results;
    const markup = `<div class="military-awareness-subject">${escapeHtml(
      t('awareness.subject.window', {
        subject: subject.label,
        distance: formatAwarenessDistance(AWARENESS_RADIUS_M),
      }),
    )}</div>
    ${namedAreasHtml(subject.memberNames)}
    ${navigationControlsHtml()}
    ${cohorts.map(rowHtml).join('')}
    <p class="military-awareness-note" tabindex="-1" data-awareness-focus-continuation>${escapeHtml(t('awareness.note.disclaimer'))}</p>`;
    panel.hidden = false;
    if (layerState.panelMarkup !== markup) {
      const focusSnapshot = captureAwarenessPanelFocus(panel);
      panel.innerHTML = markup;
      layerState.panelMarkup = markup;
      restoreAwarenessPanelFocus(panel, focusSnapshot);
    }
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
    ensurePanel,
    hidePanel,
    rowHtml,
    navigationControlsHtml,
    awarenessPanelControlKey,
    captureAwarenessPanelFocus,
    restoreAwarenessPanelFocus,
    escapeHtml,
    renderResults,
    rotateAwarenessPages,
    startAwarenessPageRotation,
    stopAwarenessPageRotation,
    awarenessResultsAreLive,
  };
}
