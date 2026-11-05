/** GeoJSON features grouped by paint. Swap complete batches so a failed
 * source or layer allocation cannot wipe the last rendered result. */
export function createNavaraPolygonDisplay(engine, view, style) {
  let visible = false;
  let batches = [];
  function release(items) {
    for (const { layer, source } of items) {
      layer?.delete();
      source.delete();
    }
  }
  return {
    setVisible(show) {
      if (visible === show) return;
      visible = show;
      for (const { color, source, layer } of batches) {
        layer.update({ type: 'vector', source, ...style(color, show) });
      }
      engine.render.request('polygon-visibility');
    },
    replace(groups) {
      const next = [];
      try {
        for (const [css, features] of groups) {
          const color = Number.parseInt(css.slice(1), 16);
          const source = view.addSource({
            type: 'geojson',
            data: { type: 'FeatureCollection', features },
          });
          const batch = { source, color };
          next.push(batch);
          batch.layer = view.addLayer({
            type: 'vector',
            source,
            ...style(color, visible),
          });
        }
      } catch (error) {
        release(next);
        throw error;
      }
      release(batches);
      batches = next;
      engine.render.request('polygon-data');
    },
    destroy() {
      release(batches);
      batches = [];
      engine.render.request('polygon-destroy');
    },
  };
}
