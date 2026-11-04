/**
 * Dim what a layer has drawn: the colours of its entities.
 *
 * Duck-typed (no Cesium import), so a layer package that uses it gains no
 * dependency. It works on the constant colour properties Cesium keeps on an
 * entity graphic (`color`, `outlineColor`, `fillColor`, `backgroundColor` and
 * the colour of a `material`). Graphics with no explicit colour, colours that
 * are time-dynamic (`CallbackProperty`, sampled), textured or image materials,
 * and anything outside an entity (primitives, imagery, labels in the
 * world-overlay host) are left as they are; a layer that draws those dims
 * them itself.
 *
 * The rule that keeps repeated calls exact: a property remembers the colour it
 * had before it was dimmed (`base`) and the colour this module wrote
 * (`applied`). When the colour found on the property is still the one written
 * here, the base is kept and re-scaled; when it differs, the layer wrote a new
 * colour and that becomes the base. Back at 1 the base is written back and the
 * memory is dropped, so a layer at its default is exactly as it drew itself.
 */

const GRAPHICS = [
  'billboard',
  'box',
  'corridor',
  'cylinder',
  'ellipse',
  'ellipsoid',
  'label',
  'model',
  'path',
  'plane',
  'point',
  'polygon',
  'polyline',
  'polylineVolume',
  'rectangle',
  'wall',
];
const COLOR_KEYS = ['color', 'outlineColor', 'fillColor', 'backgroundColor'];

/**
 * An opacity fraction held to 0-1; anything that is not a finite number is 1,
 * the layer as it draws itself.
 * @param {unknown} value
 * @returns {number}
 */
export function clampOpacity(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 1;
}

/** property -> { base, applied } for the colours this module has dimmed. */
const dimmed = new WeakMap();

const isColor = (value) =>
  Boolean(value) &&
  typeof value.red === 'number' &&
  typeof value.alpha === 'number' &&
  typeof value.clone === 'function';

const sameColor = (a, b) =>
  a.red === b.red &&
  a.green === b.green &&
  a.blue === b.blue &&
  a.alpha === b.alpha;

/**
 * Scale one constant colour property toward `fraction`.
 * @returns {boolean} Whether the property was written.
 */
function dimProperty(property, fraction) {
  if (
    !property ||
    typeof property.getValue !== 'function' ||
    typeof property.setValue !== 'function'
  )
    return false;
  let current;
  try {
    current = property.getValue();
  } catch {
    return false;
  }
  if (!isColor(current)) return false;
  const memory = dimmed.get(property);
  const ours = Boolean(memory) && sameColor(current, memory.applied);
  const base = ours ? memory.base : current.clone();
  if (fraction >= 1) {
    if (!ours) return false;
    property.setValue(base.clone());
    dimmed.delete(property);
    return true;
  }
  const applied = base.clone();
  applied.alpha = base.alpha * fraction;
  if (ours && sameColor(current, applied)) return false;
  property.setValue(applied);
  // Read back what the property kept: a setter may quantise.
  const kept = property.getValue();
  dimmed.set(property, {
    base,
    applied: isColor(kept) ? kept.clone() : applied.clone(),
  });
  return true;
}

function dimGraphic(graphic, fraction) {
  let written = 0;
  for (const key of COLOR_KEYS)
    if (dimProperty(graphic[key], fraction)) written++;
  // `material` is a property whose `color` is the constant colour property;
  // a bare colour or a non-colour material has no `color` property to write.
  const material = graphic.material;
  if (material && !isColor(material) && dimProperty(material.color, fraction))
    written++;
  return written;
}

/**
 * Scale the colours of every entity in a data source to `fraction` of what
 * the layer drew (1 restores them). Cheap to repeat: a colour already at the
 * requested opacity is not rewritten. One change notification covers the
 * whole pass.
 * @param {{entities?: {values?: object[], suspendEvents?: Function, resumeEvents?: Function}}|null|undefined} dataSource
 * @param {number} fraction Opacity from 0 to 1.
 * @returns {number} Colour properties written.
 */
export function dimEntityColors(dataSource, fraction) {
  const store = dataSource?.entities;
  const entities = store?.values;
  if (!entities) return 0;
  const target = clampOpacity(fraction);
  let written = 0;
  store.suspendEvents?.();
  try {
    for (const entity of entities)
      for (const name of GRAPHICS) {
        const graphic = entity[name];
        if (graphic) written += dimGraphic(graphic, target);
      }
  } finally {
    store.resumeEvents?.();
  }
  return written;
}
