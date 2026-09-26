import * as Cesium from 'cesium';
import { positionMarkerGlyph } from './glyphs.js';
import { COLORS, POSITION_PICK_ID } from './policy.js';

const SPRITE_ID = 'street-level:marker';

/** The on-globe marker for the image the viewer currently shows. */
export function createMarker({ state }) {
  const { render, sprites } = state.services;

  function requestRender() {
    render?.governorRequestRender?.('street-level-marker');
  }

  function ensure(viewer) {
    if (state.marker.collection) return;
    state.marker.collection = new Cesium.BillboardCollection({
      scene: viewer.scene,
    });
    viewer.scene.primitives.add(state.marker.collection);
    sprites?.registerSpriteCollection?.(SPRITE_ID, state.marker.collection);
  }

  /** Move (or create) the marker; a null position removes it. */
  function set(position, bearing) {
    const collection = state.marker.collection;
    if (!collection) return;
    if (!position) {
      collection.removeAll();
      state.marker.billboard = null;
      requestRender();
      return;
    }
    const cartesian = Cesium.Cartesian3.fromDegrees(position.lon, position.lat);
    if (!state.marker.billboard) {
      state.marker.billboard = collection.add({
        id: POSITION_PICK_ID,
        position: cartesian,
        image: positionMarkerGlyph({ color: COLORS.position }),
        imageId: 'sl-position',
        width: 40,
        height: 40,
        alignedAxis: Cesium.Cartesian3.UNIT_Z,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
      });
    } else state.marker.billboard.position = cartesian;
    state.marker.billboard.rotation = -Cesium.Math.toRadians(bearing || 0);
    requestRender();
  }

  function setVisible(visible) {
    if (state.marker.collection) state.marker.collection.show = visible;
    requestRender();
  }

  function destroy(viewer) {
    const collection = state.marker.collection;
    if (!collection) return;
    sprites?.unregisterSpriteCollection?.(SPRITE_ID, collection);
    viewer?.scene?.primitives?.remove(collection);
    state.marker.collection = null;
    state.marker.billboard = null;
  }

  return { ensure, set, clear: () => set(null), setVisible, destroy };
}
