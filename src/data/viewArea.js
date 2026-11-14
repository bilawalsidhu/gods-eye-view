import * as Cesium from 'cesium';

/** Reusable view test with a quarter-viewport warm margin on every edge.
 * Keeps nearby visuals ready during pans without changing the camera frustum.
 * Unknown camera types fail open; tracked objects use their own render path.
 */
export function createViewArea({ padding = 0.25 } = {}) {
  const perspective = new Cesium.PerspectiveOffCenterFrustum();
  const orthographic = new Cesium.OrthographicOffCenterFrustum();
  const sphere = new Cesium.BoundingSphere();
  const volume = new Cesium.CullingVolume();
  let ready = false;
  return {
    update(camera) {
      ready = false;
      const source = camera?.frustum?.offCenterFrustum ?? camera?.frustum;
      if (
        !camera?.positionWC ||
        !camera.directionWC ||
        !camera.upWC ||
        !['left', 'right', 'top', 'bottom', 'near', 'far'].every((key) =>
          Number.isFinite(source?.[key]),
        )
      )
        return;
      const frustum =
        source instanceof Cesium.OrthographicOffCenterFrustum
          ? orthographic
          : perspective;
      const dx = (source.right - source.left) * padding;
      const dy = (source.top - source.bottom) * padding;
      frustum.left = source.left - dx;
      frustum.right = source.right + dx;
      frustum.bottom = source.bottom - dy;
      frustum.top = source.top + dy;
      frustum.near = source.near;
      frustum.far = source.far;
      const computed = frustum.computeCullingVolume(
        camera.positionWC,
        camera.directionWC,
        camera.upWC,
      );
      // Cesium fits multiple depth frusta to its draw commands. Its provisional
      // camera far plane must not reject an otherwise on-screen contact.
      for (let i = 0; i < 5; i++) volume.planes[i] = computed.planes[i];
      ready = true;
    },
    contains(position, radius = 1000) {
      if (!ready || !position) return true;
      sphere.center = position;
      sphere.radius = radius;
      return volume.computeVisibility(sphere) !== Cesium.Intersect.OUTSIDE;
    },
  };
}
