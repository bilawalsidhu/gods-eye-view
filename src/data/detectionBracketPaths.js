import { appendCornerBracket } from './detectionDraw.js';

/** Reuse exact batched geometry between aircraft ticks; no pixel quantization. */
export class DetectionBracketPaths {
  constructor(steps, createPath = () => new Path2D()) {
    this.steps = steps;
    this.createPath = createPath;
    this.clear();
  }

  clear() {
    this.positions = new Float64Array(0);
    this.bands = new Uint8Array(0);
    this.colors = [];
    this.paths = new Map();
    this.previousCount = 0;
    this.count = 0;
    this.dirty = false;
    this.buildCount = 0;
    this.reuseCount = 0;
  }

  begin() {
    this.count = 0;
    this.dirty = false;
  }

  add(color, alpha, x, y, halfW, halfH) {
    const index = this.count++;
    if (index >= this.bands.length) {
      const capacity = Math.max(128, this.bands.length * 2);
      const positions = new Float64Array(capacity * 4);
      positions.set(this.positions);
      this.positions = positions;
      const bands = new Uint8Array(capacity);
      bands.set(this.bands);
      this.bands = bands;
    }
    const band = Math.max(
      1,
      Math.min(this.steps, Math.ceil(alpha * this.steps)),
    );
    const offset = index * 4;
    if (
      this.colors[index] !== color ||
      this.bands[index] !== band ||
      this.positions[offset] !== x ||
      this.positions[offset + 1] !== y ||
      this.positions[offset + 2] !== halfW ||
      this.positions[offset + 3] !== halfH
    )
      this.dirty = true;
    this.colors[index] = color;
    this.bands[index] = band;
    this.positions[offset] = x;
    this.positions[offset + 1] = y;
    this.positions[offset + 2] = halfW;
    this.positions[offset + 3] = halfH;
  }

  finish() {
    if (this.count === 0) {
      this.clear();
      return this.paths;
    }
    if (this.dirty || this.count !== this.previousCount) {
      this.buildCount++;
      this.paths = new Map();
      for (let i = 0; i < this.count; i++) {
        const color = this.colors[i],
          band = this.bands[i];
        let bands = this.paths.get(color);
        if (!bands) {
          bands = new Array(this.steps + 1);
          this.paths.set(color, bands);
        }
        const entry = (bands[band] ??= {
          color,
          alpha: band / this.steps,
          path: this.createPath(),
        });
        const offset = i * 4;
        appendCornerBracket(
          entry.path,
          this.positions[offset],
          this.positions[offset + 1],
          this.positions[offset + 2],
          this.positions[offset + 3],
        );
      }
    } else this.reuseCount++;
    this.previousCount = this.count;
    this.colors.length = this.count;
    return this.paths;
  }
}
