import * as Cesium from 'cesium';
import { AVALANCHE_OVERLAY_SOURCE_ID } from './cards.js';
import { LAYER_ID } from './policy.js';
import { OBSERVATION_PICK_PREFIX, REGION_PICK_PREFIX } from './rendering.js';

/**
 * Resolve a pick id to this layer's selection.
 * @param {?string} pickId Canonical pick id.
 * @returns {?{kind:'region'|'observation', id:string}}
 */
export function selectionForPick(pickId) {
  if (typeof pickId !== 'string') return null;
  if (pickId.startsWith(OBSERVATION_PICK_PREFIX))
    return {
      kind: 'observation',
      id: pickId.slice(OBSERVATION_PICK_PREFIX.length).split(':')[0],
    };
  if (pickId.startsWith(REGION_PICK_PREFIX))
    return {
      kind: 'region',
      id: pickId.slice(REGION_PICK_PREFIX.length).split(':')[0],
    };
  return null;
}

/**
 * Click selection: an avalanche over a region wins, a region otherwise, and a
 * click on the open card opens its source page.
 *
 * Avalanche markers are registered with the pick-ownership registry so
 * sibling layers yield to them. The large region fills deliberately are not:
 * claiming them would make every other layer's markers inert anywhere over
 * Norway's mountains (the same call the fire-perimeter layer makes).
 */
export function createSelection({ state: layerState, services, parts }) {
  const { picking, pointer, overlay, openExternal } = services;

  function select(next) {
    const same =
      next &&
      layerState.selected?.kind === next.kind &&
      layerState.selected.id === next.id;
    layerState.selected = same ? null : next;
    parts.presenter.invalidateCard();
    parts.rendering.apply(layerState.position);
    parts.presenter.refresh();
  }

  function install(viewer) {
    if (layerState.clickHandler || !picking) return;
    picking.registerPickOwner(LAYER_ID, (id) =>
      String(id).startsWith(OBSERVATION_PICK_PREFIX),
    );
    layerState.clickHandler = new Cesium.ScreenSpaceEventHandler(
      viewer.scene.canvas,
    );
    layerState.clickHandler.setInputAction((click) => {
      if (!layerState.enabled) return;
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlay?.hitTest?.(click.position?.x, click.position?.y, {
        sourceId: AVALANCHE_OVERLAY_SOURCE_ID,
      });
      if (cardHit) {
        const selected = layerState.selected;
        if (selected?.kind === 'observation' && openExternal) {
          const observation = layerState.window?.observations.find(
            (entry) => entry.id === selected.id,
          );
          if (observation) openExternal(observation.url);
        }
        return;
      }
      const picks = viewer.scene.drillPick(click.position, 4);
      const ours = picks
        .map((picked) => selectionForPick(picking.resolvePickId(picked)))
        .filter(Boolean);
      const hit =
        ours.find((entry) => entry.kind === 'observation') ?? ours[0] ?? null;
      if (hit) return select(hit);
      // A pick that belongs to another layer is that layer's click.
      const top = picks[0] ? picking.resolvePickId(picks[0]) : null;
      if (top && picking.isOwnedByOtherLayer(LAYER_ID, top)) return;
      if (layerState.selected) select(null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function uninstall() {
    layerState.clickHandler?.destroy();
    layerState.clickHandler = null;
    picking?.unregisterPickOwner(LAYER_ID);
  }

  return { install, uninstall, select };
}
