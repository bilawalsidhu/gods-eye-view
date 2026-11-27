import { shallowRef } from 'vue';
import { RADIO_SOUNDING } from './radioContext.js';

/**
 * The pinned station that could not play because the station catalogue
 * has no stream for it, `{id, name}`, or null. Its tile and Context's
 * station list say so until a station sounds or another one is chosen.
 */
export const pinnedStationMiss = shallowRef(null);

let releaseMiss = null;

function clearMiss() {
  releaseMiss?.();
  releaseMiss = null;
  pinnedStationMiss.value = null;
}

// The notice stays only while it still describes what Radio is doing.
function holdMiss(module, miss) {
  clearMiss();
  pinnedStationMiss.value = miss;
  let ready = false;
  let selectedId = null;
  const off = module.subscribe?.((state) => {
    if (!ready) {
      selectedId = state?.selected?.id ?? null;
      return;
    }
    const sounding = RADIO_SOUNDING.includes(state?.audioState);
    const moved = (state?.selected?.id ?? null) !== selectedId;
    if (sounding || moved) clearMiss();
  });
  ready = true;
  releaseMiss = () => off?.();
}

/**
 * Play a pinned station. The Radio layer is never turned on for it: with
 * the layer off the stream starts from the station catalogue already read,
 * with no station markers drawn, and only the mini player shows it. A
 * station the catalogue does not hold sets `pinnedStationMiss`. The station
 * already heard plays on rather than starting over. With the local receiver
 * chosen no internet station plays, and nothing says it is missing.
 *
 * @param {{id: string, name: string}} station
 * @param {{module: () => object | null}} deps
 * @returns {'playing' | 'missing' | 'unavailable'}
 */
export function playPinnedStation(station, { module }) {
  clearMiss();
  const radio = module();
  if (typeof radio?.playStation !== 'function') return 'unavailable';
  const state = radio.getUIState?.();
  if (state?.source === 'local') return 'unavailable';
  if (
    state?.playingStationId === station.id &&
    RADIO_SOUNDING.includes(state.audioState)
  )
    return 'playing';
  if (radio.playStation(station.id, { origin: 'user' }) === false) {
    holdMiss(radio, { id: station.id, name: station.name });
    return 'missing';
  }
  return 'playing';
}

/** Clears the state between tests. */
export function _resetPinnedStationForTest() {
  clearMiss();
}
