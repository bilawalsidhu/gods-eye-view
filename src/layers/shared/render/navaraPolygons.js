/** GeoJSON features grouped by paint. Swap complete batches so a failed
 * source or layer allocation cannot wipe the last rendered result.
 *
 * Hidden means no layers at all: Navara 0.2.1 sometimes drops the first
 * `layer.update({ show: false })` after a layer is added (a zone turned off
 * right after an engine switch stayed drawn), while a deleted layer always
 * goes. Showing again rebuilds the batches from the last groups. */
export function createNavaraPolygonDisplay(engine, view, style) {
  let visible = false;
  let groups = new Map();
  let batches = [];
  function release(items) {
    for (const { layer, source } of items) {
      layer?.delete();
      source.delete();
    }
  }
  function build(next) {
    const built = [];
    try {
      for (const [css, features] of next) {
        const color = Number.parseInt(css.slice(1), 16);
        const source = view.addSource({
          type: 'geojson',
          data: { type: 'FeatureCollection', features },
        });
        const batch = { source };
        built.push(batch);
        batch.layer = view.addLayer({
          type: 'vector',
          source,
          ...style(color),
        });
      }
    } catch (error) {
      release(built);
      throw error;
    }
    release(batches);
    batches = built;
  }
  return {
    setVisible(show) {
      if (visible === show) return;
      if (show) build(groups);
      else {
        release(batches);
        batches = [];
      }
      visible = show;
      engine.render.request('polygon-visibility');
    },
    replace(next) {
      if (visible) build(next);
      groups = next;
      engine.render.request('polygon-data');
    },
    destroy() {
      release(batches);
      batches = [];
      groups = new Map();
      engine.render.request('polygon-destroy');
    },
  };
}
