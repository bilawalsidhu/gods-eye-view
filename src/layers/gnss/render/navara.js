import * as geo from '../../../geo/index.js';
import { GNSS_LEVEL_COLORS } from '../records.js';
import { rgbaFromCss } from '../../shared/color.js';
import { viewRectangleCenter } from '../../shared/viewRectangle.js';
import { createGroundCellDisplay } from '../../shared/render/navaraGroundCells.js';

export function createGnssNavaraRenderer(engine, options) {
  const cells = createGroundCellDisplay(engine, options, 0);
  const { camera } = engine;
  function anchor() {
    const { width, height } = engine.host.size();
    const centre =
      width && height && camera.pickEllipsoid({ x: width / 2, y: height / 2 });
    let position = centre && geo.cartographic.fromCartesian(centre);
    if (!position) {
      const rect = camera.viewRectangle();
      position = rect ? viewRectangleCenter(rect) : camera.pose().cartographic;
    }
    return {
      latitude: geo.math.toDegrees(position.latitude),
      longitude: geo.math.toDegrees(position.longitude),
    };
  }
  return {
    camera,
    anchor,
    setVisible: cells.setVisible,
    destroy: cells.destroy,
    replace(rows, alpha) {
      cells.replace(
        rows.map((row) => ({
          ...row,
          color: rgbaFromCss(GNSS_LEVEL_COLORS[row.level]).withAlpha(
            alpha[row.level],
          ),
        })),
      );
    },
  };
}
