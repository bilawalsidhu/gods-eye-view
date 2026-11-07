import { positionMarkerGlyph, viewConeMarkerGlyph } from './glyphs.js';
import { COLORS, MARKER_SPRITE_ORDER, POSITION_PICK_ID } from './policy.js';

const SPRITE_ID = 'street-level:marker';

function markerLook(style) {
  if (style?.kind === 'view-cone') {
    const color = style.color || COLORS.position;
    return {
      key: `view-cone:${color}`,
      image: viewConeMarkerGlyph({ color }),
      size: 48,
    };
  }
  return {
    key: 'pin',
    image: positionMarkerGlyph({ color: COLORS.position }),
    size: 40,
  };
}

/**
 * On-globe marker for the open image, on the ground, turned to its bearing
 * (a sprite of the display, render/display.js).
 */
export function createMarker({ state }) {
  const { render } = state.services;

  function requestRender() {
    render?.governorRequestRender?.('street-level-marker', state.map?.engine);
  }

  function ensure(view) {
    if (state.marker.collection || !view?.sprites) return;
    state.marker.collection = view.sprites(SPRITE_ID, {
      order: MARKER_SPRITE_ORDER,
    });
  }

  /** Move (or create) the marker; null removes it. `style`: the provider's `marker`. */
  function set(position, bearing, style = null) {
    const collection = state.marker.collection;
    if (!collection) return;
    if (!position) {
      collection.removeAll();
      state.marker.billboard = null;
      requestRender();
      return;
    }
    const look = markerLook(style);
    if (state.marker.billboard && state.marker.look !== look.key) {
      collection.remove(state.marker.billboard);
      state.marker.billboard = null;
    }
    const place = {
      lon: position.lon,
      lat: position.lat,
      bearing: bearing || 0,
    };
    if (!state.marker.billboard) {
      state.marker.look = look.key;
      state.marker.billboard = collection.add({
        pickId: POSITION_PICK_ID,
        image: look.image,
        imageKey: `sl-position:${look.key}`,
        sizePx: look.size,
        ...place,
      });
    } else collection.move(state.marker.billboard, place);
    requestRender();
  }

  function setVisible(visible) {
    state.marker.collection?.show(visible);
    requestRender();
  }

  function destroy() {
    state.marker.collection?.destroy();
    state.marker.collection = null;
    state.marker.billboard = null;
  }

  return {
    ensure,
    set,
    clear: () => set(null),
    setVisible,
    destroy,
  };
}
