import { positionMarkerGlyph, viewConeMarkerGlyph } from './glyphs.js';
import { COLORS, POSITION_PICK_ID } from './policy.js';
import { createHorizonCull } from './view.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf } from '../../render/rendererOf.js';

const SET_ID = 'street-level:marker';

/** Draw-set ids of the markers made so far, so every layer instance has its own. */
let markerSets = 0;

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
 * The marker's icon: clamped to the ground, turned to the bearing, drawn
 * over everything near it (the horizon cull hides it past the horizon).
 */
function markerIcon(position, bearing, look) {
  return {
    id: POSITION_PICK_ID,
    pos: { lon: position.lon, lat: position.lat },
    height: 'clampGround',
    image: look.image,
    size: [look.size, look.size],
    rotationMode: 'course',
    course: bearing || 0,
    anchor: 'center',
    disableDepthTest: Number.POSITIVE_INFINITY,
  };
}

/** On-globe marker for the open image, clamped to the ground. */
export function createMarker({ state }) {
  const { render } = state.services;

  function requestRender() {
    render?.governorRequestRender?.('street-level-marker');
  }

  /** The drawn marker: `{icon, position, show}`, or null. */
  const placed = () => state.marker.placed;

  // It skips the depth test: hide it while it is behind the globe.
  const horizon = createHorizonCull({
    getViewer: () => state.viewer,
    items: () => (placed() ? [placed()] : []),
    onChange: () => {
      const marker = placed();
      if (!marker) return;
      state.marker.set?.upsert([{ ...marker.icon, show: marker.show }]);
      requestRender();
    },
  });

  function ensure(viewer) {
    if (state.marker.set) return;
    state.marker.set = drawOf(viewer).icons({
      id: `${SET_ID}:${++markerSets}`,
    });
    // Drawn from now, empty: the marker keeps its place by when it was made
    // (before the cones), whichever is first given something to draw.
    state.marker.set.set([]);
  }

  /** Move (or create) the marker; null removes it. `style`: the provider's `marker`. */
  function set(position, bearing, style = null) {
    const markers = state.marker.set;
    if (!markers) return;
    if (!position) {
      markers.clear();
      state.marker.placed = null;
      horizon.stop();
      requestRender();
      return;
    }
    const look = markerLook(style);
    state.marker.look = look.key;
    // Culled before it is drawn, so a marker past the horizon never shows.
    const marker = {
      position: fromDegrees(position.lon, position.lat),
      show: placed()?.show ?? true,
      icon: markerIcon(position, bearing, look),
    };
    state.marker.placed = marker;
    horizon.update([marker], { quiet: true });
    markers.upsert([{ ...marker.icon, show: marker.show }]);
    requestRender();
  }

  function setVisible(visible) {
    if (state.marker.set) state.marker.set.show = visible;
    requestRender();
  }

  function destroy() {
    horizon.stop();
    const markers = state.marker.set;
    if (!markers) return;
    markers.dispose();
    state.marker.set = null;
    state.marker.placed = null;
  }

  return {
    ensure,
    set,
    clear: () => set(null),
    setVisible,
    destroy,
  };
}
