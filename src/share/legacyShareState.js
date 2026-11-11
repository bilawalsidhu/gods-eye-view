/**
 * Conversion between the long share-link form's parsed state (what
 * `ShareLinkManager.parseInitialHash()` returns for `#v=2&lat=…`) and the
 * compact share-view state of viewCodec.js.
 *
 * The two use the same field names, so the conversion is small: the compact
 * form adds `view`, and the long form keeps a followed entity as a tracking
 * selection inside the layer options instead.
 */

import {
  SHARE_TRACKING_RESTORE_POLICIES,
  createDefaultLayerState,
  normalizeLayerState,
} from '../data/layerState.js';
import {
  SHARE_VIEW_ENTITY_KINDS,
  normalizeShareViewState,
} from './viewCodec.js';

/** Fields of the long form's parsed state, in its own order. */
export const LEGACY_SHARE_STATE_KEYS = Object.freeze([
  'lat',
  'lon',
  'alt',
  'heading',
  'pitch',
  'roll',
  'style',
  'styleParams',
  'bloom',
  'sharpen',
  'bloomIntensity',
  'bloomVersion',
  'sharpenIntensity',
  'hudVariant',
  'hudVisible',
  'detectionMode',
  'detectionDensity',
  'detectionAllocation',
  'detectionFadePct',
  'detectionOutsideOpacityPct',
  'celestialRing',
  'scopeEnabled',
  'scopeFeatherPct',
  'scopeTerminusPct',
  'mapStack',
  'layerState',
  'layerStateInvalid',
  'panelState',
  'sharedAtMs',
]);

/**
 * A compact share-view state from a parsed long-form state. A tracking
 * selection in the layer options becomes a thing view with no offset or
 * last-known fix, since the long form records neither. Restore bookkeeping
 * (`restoreAuthority`, `layerStateInvalid`) is not part of a view.
 */
export function fromLegacyShareState(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const picked = {};
  for (const key of LEGACY_SHARE_STATE_KEYS) {
    if (key !== 'layerStateInvalid' && Object.hasOwn(parsed, key))
      picked[key] = parsed[key];
  }
  return normalizeShareViewState(picked);
}

/**
 * The parsed long-form state for a compact share-view state, ready for
 * `ShareLinkManager.applyState`. A thing view's layer is on (in a fresh layer
 * set when the view has none), and a followed aircraft, military aircraft or
 * satellite goes back into its layer's tracking selection. The long form
 * cannot express the rest of a thing view (a vessel, the follow offset, the
 * last-known fix); callers that need them read `state.view` directly.
 */
export function toLegacyShareState(input) {
  const state = normalizeShareViewState(input);
  const entry =
    state.view.kind === 'thing'
      ? SHARE_VIEW_ENTITY_KINDS.find((e) => e.kind === state.view.entity.kind)
      : null;
  let layerState =
    entry && !state.layerState
      ? normalizeLayerState({
          ...createDefaultLayerState(),
          enabledLayerIds: [entry.layerId],
        })
      : state.layerState;
  const policy = entry?.tracking
    ? SHARE_TRACKING_RESTORE_POLICIES[entry.tracking]
    : null;
  if (
    layerState &&
    policy &&
    layerState.enabledLayerIds.includes(entry.layerId)
  ) {
    const id =
      entry.kind === 'satellite'
        ? Number(state.view.entity.id)
        : state.view.entity.id;
    layerState = normalizeLayerState({
      ...layerState,
      options: {
        ...layerState.options,
        [policy.optionOwner]: {
          ...layerState.options[policy.optionOwner],
          [policy.optionKey]: id,
        },
      },
    });
  }
  const legacy = {};
  for (const key of LEGACY_SHARE_STATE_KEYS) legacy[key] = state[key];
  legacy.layerState = layerState;
  legacy.layerStateInvalid = false;
  return legacy;
}
