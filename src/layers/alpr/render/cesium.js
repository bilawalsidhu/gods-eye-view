import * as Cesium from 'cesium';
import { alprCreditMarkup } from '../model.js';
import { createAlprPresentation } from './cesiumPresentation.js';

/** Native scene resources; shared requests and records never own the viewer. */
export function createAlprCesiumRenderer({ state, services, source }) {
  const native = {
    viewer: null,
    dataSource: null,
    credit: null,
    creditTimer: null,
    creditPresented: false,
    clickHandler: null,
  };
  let removeMove = null;
  let removeFrame = null;
  const presentation = createAlprPresentation({
    state,
    native,
    services,
    source,
  });
  return {
    ...presentation,
    get ready() {
      return Boolean(native.viewer);
    },
    count: () => native.dataSource?.entities.values.length || 0,
    following: () => Boolean(native.viewer?.trackedEntity),
    init(viewer, { onMove }) {
      native.viewer = viewer;
      native.dataSource = new Cesium.CustomDataSource('alpr-cameras');
      const markup = alprCreditMarkup(source.attribution);
      native.credit = markup ? new Cesium.Credit(markup, true) : null;
      viewer.dataSources.add(native.dataSource);
      removeMove = viewer.camera.moveEnd.addEventListener(onMove);
      removeFrame = viewer.scene.postRender?.addEventListener(
        presentation.updateSelectedAnchor,
      );
      presentation.initOverlay();
      presentation.installInteraction(viewer);
    },
    setVisible(visible) {
      if (visible) native.creditPresented = false;
      if (native.dataSource) native.dataSource.show = visible;
    },
    destroy(options) {
      presentation.destroyOverlay();
      removeMove?.();
      removeMove = null;
      removeFrame?.();
      removeFrame = null;
      native.clickHandler?.destroy();
      native.clickHandler = null;
      presentation.clearRendered(options);
      if (native.dataSource && native.viewer)
        native.viewer.dataSources.remove(native.dataSource, true);
      native.dataSource = null;
      native.credit = null;
      native.creditPresented = false;
      native.viewer = null;
    },
  };
}
