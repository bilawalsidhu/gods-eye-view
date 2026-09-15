import {
  formatAwarenessLabel,
  formatAwarenessDistance,
  AWARENESS_RADIUS_M,
} from '../../data/militaryAwarenessEngine.js';
import { t } from '../../i18n/index.js';
import { AWARENESS_PAGE_SIZE, AWARENESS_PAGE_ROTATE_MS } from './policy.js';

export function createPanel({ state: layerState, services, parts, source }) {
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
      <strong>${layerState.enabled ? t('layers.awareness.standbyReady') : t('layers.awareness.standbyOff')}</strong>
      <span>${layerState.enabled ? t('layers.awareness.standbySelect') : t('layers.awareness.standbyEnable')}</span>
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
    const count = summary.count === null ? '?' : String(summary.count);
    const page = layerState.cohortPages.get(cohort.id) || 0;
    const nearest = summary.nearest
      .slice(page, page + AWARENESS_PAGE_SIZE)
      .map((item) => {
        const label = formatAwarenessLabel(item);
        const targetId = item.icao24 || item.mmsi || item.id;
        if (!targetId) {
          return `<li><span class="military-awareness-target unavailable" aria-label="${t('layers.awareness.unavailableAria')}">${escapeHtml(label)} <span>${formatAwarenessDistance(item.distanceM)}</span></span></li>`;
        }
        const accessibleLabel =
          label === '—' ? t('layers.awareness.unavailableAria') : label;
        return `<li><button type="button" class="military-awareness-target" data-awareness-layer="${escapeHtml(cohort.id)}" data-awareness-id="${escapeHtml(targetId)}" aria-label="${escapeHtml(t('layers.awareness.focusAria', { label: accessibleLabel }))}">${escapeHtml(label)} <span>${formatAwarenessDistance(item.distanceM)}</span></button></li>`;
      })
      .join('');
    const pageCount = Math.max(
      1,
      Math.ceil(summary.nearest.length / AWARENESS_PAGE_SIZE),
    );
    const pageLabel =
      pageCount > 1
        ? ` · ${Math.floor(page / AWARENESS_PAGE_SIZE) + 1}/${pageCount}`
        : '';
    const coverage = cohort.coverage ? ` · ${escapeHtml(cohort.coverage)}` : '';
    return `<section class="military-awareness-row ${summary.relationship.toLowerCase()}">
    <div><strong>${escapeHtml(cohort.label)}</strong><b aria-live="polite">${count}${pageLabel}</b></div>
    <small>${escapeHtml(cohort.source)}${coverage} · ${escapeHtml(summary.reason)}</small>
    ${nearest ? `<ul>${nearest}</ul>` : ''}
  </section>`;
  }

  function navigationControlsHtml() {
    const canPrevious = layerState.navigationIndex > 0;
    return `<div class="military-awareness-controls" role="group" aria-label="${t('layers.awareness.controlsAria')}">
    <button type="button" data-awareness-action="previous" title="${t('layers.awareness.previousTitle')}"${canPrevious ? '' : ' disabled'}>${t('layers.awareness.previous')}</button>
    <button type="button" data-awareness-action="focus">${t('layers.awareness.focus')}</button>
    <button type="button" data-awareness-action="next" title="${t('layers.awareness.nextTitle')}"${parts.navigation.canNavigateNext() ? '' : ' disabled'}>${t('layers.awareness.next')}</button>
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

  function renderResults() {
    if (!layerState.enabled || !layerState.results) return hidePanel();
    const panel = ensurePanel();
    const { subject, cohorts } = layerState.results;
    const markup = `<div class="military-awareness-subject">${escapeHtml(subject.label)} · ${formatAwarenessDistance(AWARENESS_RADIUS_M)} FLIGHT / VESSEL WINDOW</div>
    ${navigationControlsHtml()}
    ${cohorts.map(rowHtml).join('')}
    <p class="military-awareness-note" tabindex="-1" data-awareness-focus-continuation>${t('layers.awareness.note')}</p>`;
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
