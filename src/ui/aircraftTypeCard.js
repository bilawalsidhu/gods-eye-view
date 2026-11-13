import { h, shallowRef } from 'vue';
import AircraftTypeCard from './views/panels/AircraftTypeCard.vue';
import { aircraftTypeCardModel } from '../layers/flights/typeCard.js';

/**
 * @module aircraftTypeCard
 * @description Shell for the selected-aircraft card: a licensed photo and the
 * specs of its TYPE, plus live telemetry, in the faction accent (cyan civil,
 * amber military). It shows while a flight layer tracks an aircraft and hides
 * when tracking clears. The card itself is `views/panels/AircraftTypeCard.vue`;
 * this keeps the selection events, the telemetry refresh and the placement.
 */

const LAYER_IDS = new Set(['flights', 'military']);
const REFRESH_MS = 1000;
const GAP_PX = 12;
const SIDE_MARGIN_PX = 16;

/**
 * Mount the card. `getTracked` returns the tracked contact's descriptor, with
 * a `military` flag, or null when nothing is tracked.
 * @param {object} options
 * @param {() => object|null} options.getTracked
 * @param {{mount: Function}} options.ui Vue runtime the card mounts into.
 * @param {(url: string) => string} [options.resolveAsset] Public-file URL resolver.
 * @returns {{destroy: () => void}}
 */
export function createAircraftTypeCard({
  getTracked,
  ui,
  resolveAsset = (url) => url,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
}) {
  if (!documentRef?.body || !windowRef) return { destroy() {} };

  const model = shallowRef(null);
  const host = documentRef.createElement('aside');
  host.dataset.aircraftTypeCardHost = '';
  host.hidden = true;
  Object.assign(host.style, {
    position: 'fixed',
    top: '64px',
    right: `${SIDE_MARGIN_PX}px`,
    zIndex: '88',
  });
  documentRef.body.append(host);

  const unmount = ui.mount(
    {
      setup: () => () =>
        model.value
          ? h(AircraftTypeCard, { model: model.value, resolveAsset })
          : null,
    },
    host,
  );

  let timer = null;

  function keepClearOfRightPanels() {
    const stack = documentRef.getElementById('right-panel-stack');
    const rect = stack?.getBoundingClientRect?.();
    const visible = rect && rect.width > 0 && rect.height > 0;
    host.style.right = `${
      visible
        ? Math.max(SIDE_MARGIN_PX, windowRef.innerWidth - rect.left + GAP_PX)
        : SIDE_MARGIN_PX
    }px`;
  }

  function refresh() {
    const info = getTracked();
    if (!info) {
      hide();
      return;
    }
    model.value = aircraftTypeCardModel(info, {
      isMilitary: info.military === true,
    });
    keepClearOfRightPanels();
    host.hidden = false;
  }

  function show() {
    refresh();
    if (!timer && !host.hidden)
      timer = windowRef.setInterval(refresh, REFRESH_MS);
  }

  function hide() {
    if (timer) windowRef.clearInterval(timer);
    timer = null;
    model.value = null;
    host.hidden = true;
  }

  const onSelected = (event) => {
    if (LAYER_IDS.has(event.detail?.layerId)) show();
  };
  const onCleared = (event) => {
    if (LAYER_IDS.has(event.detail?.layerId)) hide();
  };
  windowRef.addEventListener('gev:awareness-subject-selected', onSelected);
  windowRef.addEventListener('gev:awareness-subject-cleared', onCleared);

  return {
    /** Release the card, its selection listeners and the telemetry timer. */
    destroy() {
      windowRef.removeEventListener(
        'gev:awareness-subject-selected',
        onSelected,
      );
      windowRef.removeEventListener('gev:awareness-subject-cleared', onCleared);
      hide();
      unmount();
      host.remove();
    },
  };
}
