/** Shared bounded JSON and field checks for scene formats. */
export const SCENE_DOCUMENT_LIMITS = Object.freeze({
  bytes: 5 * 1024 * 1024,
  scenes: 256,
  shots: 10000,
  collection: 10000,
  depth: 24,
  nodes: 200000,
  string: 65536,
});

/** A project error identifies a field without echoing its supplied value. */
export class SceneDocumentError extends Error {
  constructor(path, reason) {
    super(`${path}: ${reason}`);
    this.name = 'SceneDocumentError';
    this.path = path;
  }
}
export const fail = (path, reason) => {
  throw new SceneDocumentError(path, reason);
};
export const object = (value, path) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(path, 'expected an object');
};
export function fields(value, path, allowed) {
  object(value, path);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, 'unsupported field');
  }
}
export function string(value, path, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    fail(path, `expected nonempty text, at most ${max} characters`);
}
export function number(value, path, min, max, legacy) {
  const numeric =
    legacy && typeof value === 'string' && value.trim() ? Number(value) : value;
  if (
    typeof numeric !== 'number' ||
    !Number.isFinite(numeric) ||
    numeric < min ||
    numeric > max
  )
    fail(path, `expected a number from ${min} to ${max}`);
}
export function optional(value, key, path, check) {
  if (Object.hasOwn(value, key)) check(value[key], `${path}.${key}`);
}
export function array(value, path, max = SCENE_DOCUMENT_LIMITS.collection) {
  if (!Array.isArray(value) || value.length > max)
    fail(path, `expected an array of at most ${max} entries`);
}
export function ids(value, path) {
  array(value, path);
  value.forEach((id, index) => string(id, `${path}[${index}]`));
}
export function uniqueId(value, path, seen) {
  if (!Object.hasOwn(value, 'id')) return; // Legacy omissions receive an ID once during migration.
  string(value.id, `${path}.id`);
  if (seen.has(value.id)) fail(`${path}.id`, 'duplicate ID');
  seen.add(value.id);
}
export function jsonTree(value, path, budget, depth = 0) {
  if (
    ++budget.nodes > SCENE_DOCUMENT_LIMITS.nodes ||
    depth > SCENE_DOCUMENT_LIMITS.depth
  )
    fail(path, 'project complexity limit exceeded');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > SCENE_DOCUMENT_LIMITS.string)
      fail(path, 'text is too long');
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object') fail(path, 'expected a JSON value');
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== null
  )
    fail(path, 'expected a JSON object');
  const entries = Object.entries(value);
  if (entries.length > SCENE_DOCUMENT_LIMITS.collection)
    fail(path, 'too many entries');
  for (const [key, child] of entries) {
    if (['__proto__', 'constructor', 'prototype'].includes(key))
      fail(path, 'unsafe object key');
    if (key.length > 256) fail(path, 'field name is too long');
    jsonTree(child, `${path}.${key}`, budget, depth + 1);
  }
}
