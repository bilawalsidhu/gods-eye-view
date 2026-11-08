// Engine-neutral layer colours: the layers' colour constants, with
// Cesium.Color's values but without Cesium.
//
// An Rgba has Cesium.Color's fields and the methods the layers call on their
// colours (`withAlpha`, `clone`, `equals`), so it is accepted wherever a
// Cesium property clones a colour from its fields (Billboard.color,
// Model.color, a billboard graphics' colour), and a renderer on another
// engine reads the same four numbers (`rgba()` gives them as an array).
// Components are 0..1 floats computed exactly as Cesium computes them
// (`fromCssColorString`: byte / 255), so a constant here equals the
// Cesium.Color it replaces bit for bit (color.test.mjs).

export class Rgba {
  constructor(red = 1, green = 1, blue = 1, alpha = 1) {
    this.red = red;
    this.green = green;
    this.blue = blue;
    this.alpha = alpha;
  }

  /** The same colour with `alpha` (Cesium.Color#withAlpha). */
  withAlpha(alpha, result) {
    if (!result) return new Rgba(this.red, this.green, this.blue, alpha);
    result.red = this.red;
    result.green = this.green;
    result.blue = this.blue;
    result.alpha = alpha;
    return result;
  }

  clone(result) {
    return this.withAlpha(this.alpha, result);
  }

  /** Field equality with an Rgba or a Cesium.Color. */
  equals(other) {
    return (
      this === other ||
      (!!other &&
        this.red === other.red &&
        this.green === other.green &&
        this.blue === other.blue &&
        this.alpha === other.alpha)
    );
  }

  /** Cesium's CSS form, including its float-to-byte conversion. */
  toCssColorString() {
    const byte = (v) => (v === 1 ? 255 : (v * 256) | 0);
    const rgb = `${byte(this.red)},${byte(this.green)},${byte(this.blue)}`;
    return this.alpha === 1 ? `rgb(${rgb})` : `rgba(${rgb},${this.alpha})`;
  }

  /** `[red, green, blue, alpha]`, 0..1. */
  rgba() {
    return [this.red, this.green, this.blue, this.alpha];
  }
}

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i;

/**
 * A colour from `#rrggbb` or `#rrggbbaa`, as Cesium.Color.fromCssColorString
 * reads it.
 * @param {string} css
 * @returns {Rgba}
 */
export function rgbaFromCss(css) {
  const functional =
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(
      String(css).trim(),
    );
  if (functional)
    return new Rgba(
      Number(functional[1]) / 255,
      Number(functional[2]) / 255,
      Number(functional[3]) / 255,
      Number(functional[4] ?? 1),
    );
  const match = HEX.exec(String(css).trim());
  if (!match) throw new TypeError(`Unsupported colour: ${css}`);
  return new Rgba(
    parseInt(match[1], 16) / 255.0,
    parseInt(match[2], 16) / 255.0,
    parseInt(match[3], 16) / 255.0,
    parseInt(match[4] ?? 'ff', 16) / 255.0,
  );
}

/** A frozen colour constant. */
export const constantRgba = (red, green, blue, alpha = 1) =>
  Object.freeze(new Rgba(red, green, blue, alpha));

/** Cesium.Color.WHITE. */
export const WHITE = constantRgba(1, 1, 1, 1);
/** Cesium.Color.CYAN (#00FFFF). */
export const CYAN = constantRgba(0, 1, 1, 1);

/**
 * A distance scale for sprites (Cesium.NearFarScalar's fields): the scale is
 * `nearValue` at `near` metres from the camera and `farValue` at `far`.
 * Plain data, accepted by Cesium's billboard setters, which copy the fields.
 */
export function nearFarScale(near, nearValue, far, farValue) {
  return { near, nearValue, far, farValue };
}
