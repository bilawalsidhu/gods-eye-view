/** Exact geometry reuse; live styling, labels and opacity are never cached. */
export class DetectionProjectionCache {
  constructor() {
    this.clear();
  }

  clear() {
    this.entries = new WeakMap();
    this.inputs = new Float64Array(22).fill(NaN);
    this.revision = 0;
  }

  begin(frame, mode) {
    const matrix = frame.viewProjectionMatrix;
    const camera = frame.cameraPosition;
    let changed = false;
    for (let i = 0; i < 22; i++) {
      const value =
        i < 16
          ? matrix[i]
          : i === 16
            ? camera.x
            : i === 17
              ? camera.y
              : i === 18
                ? camera.z
                : i === 19
                  ? frame.width
                  : i === 20
                    ? frame.height
                    : mode;
      if (this.inputs[i] !== value) changed = true;
      this.inputs[i] = value;
    }
    if (changed) this.revision++;
  }

  get(object, frame, project) {
    let row = this.entries.get(object);
    if (!row) {
      row = {};
      this.entries.set(object, row);
    }
    const p = object.position;
    if (
      row.revision !== this.revision ||
      row.px !== p.x ||
      row.py !== p.y ||
      row.pz !== p.z ||
      row.type !== object.type ||
      row.tier !== object.tier ||
      row.tracked !== object.skipLabel ||
      row.width !== object.bracketHalfWidth ||
      row.height !== object.bracketHalfHeight
    ) {
      row.revision = this.revision;
      row.px = p.x;
      row.py = p.y;
      row.pz = p.z;
      row.type = object.type;
      row.tier = object.tier;
      row.tracked = object.skipLabel;
      row.width = object.bracketHalfWidth;
      row.height = object.bracketHalfHeight;
      project(object, frame, row);
    }
    return row;
  }
}
