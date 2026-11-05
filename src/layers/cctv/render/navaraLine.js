/** Mutable CCTV line backed by the existing engine ribbon renderer. */
export function createCctvNavaraLine(engine, id, initial, points = []) {
  let style = { ...initial };
  let positions = points;
  let visible = false;
  let destroyed = false;
  let line = null;
  const build = () => {
    line?.destroy();
    line = engine.lines.createLine({
      id,
      pickId: id,
      widthPx: style.width,
      color: style.tint.rgba(),
      depthFailAlpha: style.depthFail
        ? style.depthFail.alpha / Math.max(style.tint.alpha, 1e-6)
        : 0,
      dash: style.dashed ? { lengthPx: 8, gapPx: 8 } : null,
      arrow: Boolean(style.arrow),
      order: style.order ?? 0,
    });
    line.setPositions(positions);
    line.show(visible);
  };
  build();
  return {
    id,
    get show() {
      return !destroyed && visible;
    },
    set show(value) {
      if (destroyed || visible === Boolean(value)) return;
      visible = Boolean(value);
      line.show(visible);
    },
    polyline: {
      get positions() {
        return positions;
      },
      set positions(value) {
        if (destroyed) return;
        positions = value;
        line.setPositions(value);
      },
    },
    style(next) {
      if (destroyed) return;
      const depth = (s) =>
        s.depthFail ? s.depthFail.alpha / Math.max(s.tint.alpha, 1e-6) : 0;
      const rebuild =
        next.width !== style.width ||
        Boolean(next.dashed) !== Boolean(style.dashed) ||
        depth(next) !== depth(style);
      const colorChanged = next.tint
        .rgba()
        .some((v, i) => v !== style.tint.rgba()[i]);
      style = { ...style, ...next };
      if (rebuild) build();
      else if (colorChanged) line.setColor(style.tint.rgba());
      this.show = next.visible;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      line.destroy();
    },
  };
}
