/**
 * @module testSupport/viewerAccess
 * @description What `src/render/viewerAccess.test.mjs` and
 * `scripts/viewer-access-baseline.mjs` count: Cesium-shaped access through
 * a viewer, in runtime files that neither import Cesium (they are not on
 * `src/render/cesiumAllowList.json`) nor are the Cesium adapter
 * (`src/render/cesium/`).
 *
 * A hit is one of:
 * - a viewer member Cesium owns, on anything named `viewer` (`viewer`,
 *   `_viewer`, `this.viewer`, `state.mainViewer`): `entities`,
 *   `dataSources`, `scene`, `camera`, `clock`, `imageryLayers`,
 *   `terrainProvider`, `trackedEntity`, `canvas`, plain, optional (`?.`),
 *   in brackets (`viewer['scene']`) or off a call (`getViewer().scene`),
 *   and any bracket access with a computed key (`viewer[name]`);
 * - a scene member Cesium owns, on anything named `scene`
 *   (`viewer.scene.globe`, `scene?.pick`): `primitives`, `pick`,
 *   `drillPick`, `pickPosition`, `globe`, `preRender`, `postRender`,
 *   `preUpdate`, `postUpdate`, `canvas`, `requestRender`, `camera`;
 * - any of those names taken out by destructuring
 *   (`const { scene } = viewer`, `({ globe } = viewer.scene)`,
 *   `({ viewer: { scene } }) => ...`).
 *
 * Not hits: `viewer.container` (a DOM element; `canvasOf(viewer)` is the
 * way to the canvas), comments, and access through another name
 * (`const v = viewer; v.scene`), which only a type checker could follow.
 * Names are matched by their ending, so a viewer that is not Cesium's
 * (`panoViewer.camera`) counts too: name it otherwise.
 * Runtime files are every `.js`, `.mjs`, `.cjs` and `.vue` file under
 * `src/`, `server/` and `dev/`, except tests and test support (the same
 * set the Cesium allow-list reads).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsers } from 'prettier/plugins/babel.mjs';
import { parse as parseSfc } from 'vue/compiler-sfc';

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
export const CESIUM_LIST = 'src/render/cesiumAllowList.json';
export const BASELINE = 'src/render/viewerAccessAllowList.json';
/** How to lower the baseline once files stop reaching through the viewer. */
export const UPDATE_COMMAND = 'node scripts/viewer-access-baseline.mjs';

/** Viewer members Cesium owns. */
export const VIEWER_MEMBERS = new Set([
  'entities',
  'dataSources',
  'scene',
  'camera',
  'clock',
  'imageryLayers',
  'terrainProvider',
  'trackedEntity',
  'canvas',
]);
/** Scene members Cesium owns. */
export const SCENE_MEMBERS = new Set([
  'primitives',
  'pick',
  'drillPick',
  'pickPosition',
  'globe',
  'preRender',
  'postRender',
  'preUpdate',
  'postUpdate',
  'canvas',
  'requestRender',
  'camera',
]);

const SCOPES = ['src', 'server', 'dev'];
/** Not runtime code, though not named `.test`: imported by tests only. */
const TEST_ONLY = new Set([
  'src/layers/recentImagery/testDoubles.mjs',
  'src/layers/weather/shellFixture.mjs',
  'src/overlays/worldOverlayAllocation.worker.mjs',
]);
const isTestSupport = (file) =>
  /\.test\.[cm]?js$/.test(file) ||
  file.startsWith('src/testSupport/') ||
  file.startsWith('src/tooling/') ||
  TEST_ONLY.has(file);
const isAdapter = (file) => file.startsWith('src/render/cesium/');

const VIEWER_NAME = /viewer$/i;
const SCENE_NAME = /scene$/i;

/** A member's name when it is written out: `.x`, `['x']`, `` [`x`] ``. */
function staticKey(node, computed) {
  if (!node) return undefined;
  if (!computed) return node.name ?? node.value;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0]?.value?.cooked;
  return undefined;
}

/**
 * The name an expression ends in: `viewer`, `x._viewer`, `this.scene`, and
 * a call's callee (`getViewer()`).
 */
function tailName(node) {
  if (!node) return undefined;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression')
    return tailName(node.callee);
  if (
    node.type === 'MemberExpression' ||
    node.type === 'OptionalMemberExpression'
  )
    return staticKey(node.property, node.computed);
  if (
    node.type === 'TSNonNullExpression' ||
    node.type === 'ParenthesizedExpression'
  )
    return tailName(node.expression);
  return undefined;
}

/** Whether `name` read off something named `owner` is a hit. */
function isHit(owner, name, computedUnknown = false) {
  if (owner === undefined) return false;
  if (VIEWER_NAME.test(owner))
    return computedUnknown || VIEWER_MEMBERS.has(name);
  if (SCENE_NAME.test(owner)) return SCENE_MEMBERS.has(name);
  return false;
}

/**
 * The hits in a script's source, each with its line and what it reads.
 * @param {string} source
 * @returns {Array<{line: number, access: string}>}
 */
export function viewerAccessHits(source) {
  const hits = [];
  const note = (node, owner, name) =>
    hits.push({ line: node.loc?.start?.line ?? 0, access: `${owner}.${name}` });
  /** Names a destructuring pattern takes out of something named `owner`. */
  const destructured = (pattern, owner) => {
    if (pattern?.type !== 'ObjectPattern' || owner === undefined) return;
    for (const property of pattern.properties) {
      if (property.type === 'RestElement') continue;
      const name = staticKey(property.key, property.computed);
      if (isHit(owner, name, property.computed && name === undefined))
        note(property, owner, name ?? '[computed]');
    }
  };
  /** A viewer or scene taken out and destructured in turn:
   *  `{ viewer: { scene } }`, `{ scene: { globe } = {} }`. */
  const nested = (pattern) => {
    for (const property of pattern.properties) {
      if (property.type === 'RestElement') continue;
      const name = staticKey(property.key, property.computed);
      if (!name || !(VIEWER_NAME.test(name) || SCENE_NAME.test(name))) continue;
      const value =
        property.value?.type === 'AssignmentPattern'
          ? property.value.left
          : property.value;
      destructured(value, name);
    }
  };
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    switch (node.type) {
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const owner = tailName(node.object);
        const name = staticKey(node.property, node.computed);
        if (isHit(owner, name, node.computed && name === undefined))
          note(node, owner, name ?? '[computed]');
        break;
      }
      case 'VariableDeclarator':
        destructured(node.id, tailName(node.init));
        break;
      case 'AssignmentExpression':
      // A default: `function f({ camera } = viewer)`.
      case 'AssignmentPattern':
        destructured(node.left, tailName(node.right));
        break;
      case 'ObjectPattern':
        nested(node);
        break;
    }
    for (const [key, value] of Object.entries(node)) {
      if (
        ['loc', 'comments', 'tokens', 'extra', 'leadingComments'].includes(key)
      )
        continue;
      if (value && typeof value === 'object') walk(value);
    }
  }
  walk(parsers.babel.parse(source));
  return hits.sort((a, b) => a.line - b.line);
}

/** The hits in a single-file component's scripts, read by Vue's own
 *  parser, at their lines in the file. */
function vueHits(file, source) {
  const { descriptor, errors } = parseSfc(source, { filename: file });
  if (errors.length) throw errors[0];
  return [descriptor.script, descriptor.scriptSetup]
    .filter(Boolean)
    .flatMap((block) =>
      viewerAccessHits(block.content).map((hit) => ({
        ...hit,
        line: hit.line + block.loc.start.line - 1,
      })),
    );
}

/** The hits in a repository file. */
export function fileHits(file, root = ROOT) {
  const source = readFileSync(path.join(root, file), 'utf8');
  return file.endsWith('.vue')
    ? vueHits(file, source)
    : viewerAccessHits(source);
}

/**
 * The runtime files the count covers: off the Cesium list, outside the
 * adapter, not tests.
 */
export function countedFiles(root = ROOT) {
  const cesiumList = new Set(
    JSON.parse(readFileSync(path.join(root, CESIUM_LIST), 'utf8')),
  );
  return execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ...SCOPES,
    ],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(
      (file) =>
        file &&
        /\.(?:[cm]?js|vue)$/.test(file) &&
        !isTestSupport(file) &&
        !isAdapter(file) &&
        !cesiumList.has(file) &&
        existsSync(path.join(root, file)),
    );
}

/** Each counted file with hits: file → its hits. */
export function currentHits(root = ROOT) {
  const out = new Map();
  for (const file of countedFiles(root)) {
    const hits = fileHits(file, root);
    if (hits.length) out.set(file, hits);
  }
  return out;
}

/** The committed baseline: file → hits allowed. */
export function readBaseline(root = ROOT) {
  return JSON.parse(readFileSync(path.join(root, BASELINE), 'utf8'));
}
