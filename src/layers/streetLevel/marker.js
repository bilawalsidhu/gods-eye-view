import * as Cesium from 'cesium';
import { positionMarkerGlyph } from './glyphs.js';
import { COLORS, POSITION_PICK_ID } from './policy.js';
import { refineHeights } from './groundCast.js';

const SPRITE_ID = 'street-level:marker';

/**
 * The on-globe marker for the image the viewer currently shows. In terrain
 * mode (Google 3D at street zoom) it stands on the bare earth instead of
 * clamping to the top of the photoreal mesh.
 */
export function createMarker({ state, parts }) {
  const { render, sprites } = state.services;
  let last = null;

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

  /**
   * Height for the position in terrain mode: bare earth, refined by the
   * sampled Google 3D surface where it is known; null to clamp. Fetches a
   * missing terrain cell and asks for a mesh sample under the marker.
   */
  function castHeight(position) {
    const ground = parts?.groundCaster;
    if (state.surface !== 'terrain' || !ground) return null;
    const { lon, lat } = position;
    const dem = ground.groundAt(lon, lat);
    if (dem === null) {
      ground.prepare([[lon, lat]]).then((ready) => {
        if (ready && last?.position === position) set(position, last.bearing);
      });
      return null;
    }
    const mesh = parts.meshSampler?.meshAt(lon, lat);
    if (mesh === undefined) parts.meshSampler?.request([[lon, lat]]);
    return refineHeights([{ dem, mesh }])[0];
  }

  // A new mesh sample may move the marker onto (or off) the road surface.
  parts?.meshSampler?.onSampled(() => {
    if (last && state.surface === 'terrain') set(last.position, last.bearing);
  });

  /** Move (or create) the marker; a null position removes it. */
  function set(position, bearing) {
    const collection = state.marker.collection;
    if (!collection) return;
    last = position ? { position, bearing } : null;
    if (!position) {
      collection.removeAll();
      state.marker.billboard = null;
      requestRender();
      return;
    }
    const height = castHeight(position);
    const cartesian = Cesium.Cartesian3.fromDegrees(
      position.lon,
      position.lat,
      height ?? 0,
    );
    const heightReference =
      height === null
        ? Cesium.HeightReference.CLAMP_TO_GROUND
        : Cesium.HeightReference.NONE;
    if (!state.marker.billboard) {
      state.marker.billboard = collection.add({
        id: POSITION_PICK_ID,
        position: cartesian,
        image: positionMarkerGlyph({ color: COLORS.position }),
        imageId: 'sl-position',
        width: 40,
        height: 40,
        alignedAxis: Cesium.Cartesian3.UNIT_Z,
        heightReference,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
      });
    } else {
      state.marker.billboard.heightReference = heightReference;
      state.marker.billboard.position = cartesian;
    }
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

  /** Re-place the marker after the surface mode changes. */
  function setSurface() {
    if (last) set(last.position, last.bearing);
  }

  return {
    ensure,
    set,
    clear: () => set(null),
    setVisible,
    setSurface,
    destroy,
  };
}
