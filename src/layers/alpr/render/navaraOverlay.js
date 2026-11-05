import * as geo from '../../../geo/index.js';
import { createAlprOverlayCore } from '../overlay.js';

/** Canvas artwork over Navara pick sprites, with bounded surface refinement. */
export function createAlprNavaraOverlay({
  engine,
  state,
  markers,
  sampleHeight,
  syncMarker,
  services,
  onSurfaceChange = () => {},
}) {
  const location = (record) =>
    geo.cartographic.fromDegrees(record.longitude, record.latitude);
  return createAlprOverlayCore({
    state,
    services,
    onSurfaceChange,
    engine: {
      marker: (id) => markers.get(id),
      markers: () => markers.values(),
      canvasOwned(marker, owned) {
        if (marker.canvasOwned === owned) return;
        marker.canvasOwned = owned;
        syncMarker(marker);
      },
      setShown(marker, visible) {
        if (marker.shown === visible) return;
        marker.shown = visible;
        syncMarker(marker);
      },
      setDisplayPosition(marker, position) {
        marker.displayPosition = position;
      },
      placeAnchor(marker, record, height) {
        marker.gevAlprCanvasPosition = geo.cartesian3.fromDegrees(
          record.longitude,
          record.latitude,
          height,
        );
        marker.resolved = true;
        syncMarker(marker);
      },
      surfaceSupported: () => engine.surface.supported,
      // Navara raycasts the loaded surface.
      sampleHeight: (record) => sampleHeight(location(record)),
      terrainHeight: (record) =>
        engine.surface.terrainHeightSupported
          ? engine.surface.terrainHeight(location(record))
          : undefined,
      surfaceSettled: () => engine.surface.tilesLoaded(),
      cameraPose: () => engine.camera.pose(),
      cameraPosition: () => engine.camera.livePosition,
      projector: ({ width, height, viewProjectionMatrix: matrix }) => ({
        horizonVisible: (point) => engine.projector.horizonVisible(point),
        // The host already captured the camera and CSS viewport for this
        // frame; reuse it for every wedge vertex instead of rereading DOM
        // geometry.
        project({ x, y, z }) {
          const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
          if (!(w > 0)) return null;
          return {
            x:
              (((matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) /
                w +
                1) *
                width) /
              2,
            y:
              ((1 -
                (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) /
                  w) *
                height) /
              2,
          };
        },
      }),
      cullOffscreenWedges: true,
      createId: () => crypto.randomUUID(),
    },
  });
}
