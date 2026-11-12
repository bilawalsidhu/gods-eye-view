/**
 * @module render/vectorBase/expressions
 * @description The part of the MapLibre style specification's expressions,
 * filters and legacy functions that the vector base painter evaluates. A
 * value is compiled once into a function of `{zoom, properties, type, id}`
 * (`type` is `'Point'`, `'LineString'` or `'Polygon'`). Compiling throws an
 * {@link Unsupported} for what is not covered, so the caller skips the layer;
 * a compiled function that meets a value it cannot handle throws one too, so
 * the caller skips the feature. Nothing here guesses.
 */

/** What the painter does not evaluate: the layer or feature is skipped. */
export class Unsupported extends Error {}

const unsupported = (what) => {
  throw new Unsupported(what);
};

/** A feature with no properties, at a zoom: what a zoom-only value sees. */
const constant = (value) => () => value;

const COMPARE = {
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
};

const ARITHMETIC = {
  '+': (args) => args.reduce((a, b) => a + b, 0),
  '*': (args) => args.reduce((a, b) => a * b, 1),
  '-': (args) => (args.length === 1 ? -args[0] : args[0] - args[1]),
  '/': (args) => args[0] / args[1],
  '%': (args) => args[0] % args[1],
  '^': (args) => args[0] ** args[1],
  min: (args) => Math.min(...args),
  max: (args) => Math.max(...args),
  abs: (args) => Math.abs(args[0]),
  floor: (args) => Math.floor(args[0]),
  ceil: (args) => Math.ceil(args[0]),
  round: (args) => Math.round(args[0]),
  sqrt: (args) => Math.sqrt(args[0]),
  ln: (args) => Math.log(args[0]),
  log10: (args) => Math.log10(args[0]),
  log2: (args) => Math.log2(args[0]),
};

const NAMED_COLORS = {
  black: [0, 0, 0, 1],
  white: [255, 255, 255, 1],
  red: [255, 0, 0, 1],
  green: [0, 128, 0, 1],
  blue: [0, 0, 255, 1],
  yellow: [255, 255, 0, 1],
  gray: [128, 128, 128, 1],
  grey: [128, 128, 128, 1],
  transparent: [0, 0, 0, 0],
};

/**
 * A CSS colour as `[r, g, b, a]` (0..255, alpha 0..1): hex, `rgb()`,
 * `rgba()`, `hsl()`, `hsla()` and a few names; null for anything else.
 * @param {unknown} text
 */
export function parseColor(text) {
  if (Array.isArray(text) && text.length === 4) return text;
  if (typeof text !== 'string') return null;
  const s = text.trim().toLowerCase();
  if (NAMED_COLORS[s]) return NAMED_COLORS[s].slice();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a = 'f'] = h;
      return [
        parseInt(r + r, 16),
        parseInt(g + g, 16),
        parseInt(b + b, 16),
        parseInt(a + a, 16) / 255,
      ];
    }
    if (h.length === 6 || h.length === 8)
      return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
        h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      ];
    return null;
  }
  m = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
  if (!m) return null;
  const parts = m[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const num = (p, scale) =>
    p.endsWith('%') ? (parseFloat(p) / 100) * scale : parseFloat(p);
  const alpha = parts[3] === undefined ? 1 : num(parts[3], 1);
  if (m[1].startsWith('rgb')) {
    const rgb = parts.slice(0, 3).map((p) => num(p, 255));
    return rgb.concat(alpha).some((v) => !Number.isFinite(v))
      ? null
      : [...rgb, alpha];
  }
  const hue = (((parseFloat(parts[0]) % 360) + 360) % 360) / 360;
  const sat = parseFloat(parts[1]) / 100;
  const light = parseFloat(parts[2]) / 100;
  if (![hue, sat, light, alpha].every(Number.isFinite)) return null;
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const channel = (t) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    channel(hue + 1 / 3) * 255,
    channel(hue) * 255,
    channel(hue - 1 / 3) * 255,
    alpha,
  ];
}

/** `[r, g, b, a]` as a CSS colour. */
export function cssOf(color) {
  const [r, g, b, a] = color;
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
}

/** Between `a` and `b` (numbers, colours, or arrays of numbers) at `t`. */
function mix(a, b, t) {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length)
    return a.map((v, i) => mix(v, b[i], t));
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (ca && cb) return cssOf(ca.map((v, i) => v + (cb[i] - v) * t));
  return unsupported(`interpolate between ${a} and ${b}`);
}

/** How far `x` is from `lower` to `upper`, at an exponential `base`. */
function factor(x, base, lower, upper) {
  const range = upper - lower;
  if (range === 0) return 0;
  const progress = x - lower;
  if (base === 1) return progress / range;
  return (base ** progress - 1) / (base ** range - 1);
}

/** The value of `stops` (`[input, output]`, rising) at `x`. */
function interpolateStops(stops, x, base, interpolate = true) {
  if (x <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (x >= last[0]) return last[1];
  let i = 0;
  while (i < stops.length - 1 && x >= stops[i + 1][0]) i++;
  if (!interpolate) return stops[i][1];
  const [x0, y0] = stops[i];
  const [x1, y1] = stops[i + 1];
  return mix(y0, y1, factor(x, base, x0, x1));
}

/** Whether a value is an expression (an array naming an operator). */
const isExpression = (value) =>
  Array.isArray(value) && typeof value[0] === 'string';

/**
 * Whether a filter is in the expression syntax rather than the legacy one,
 * as the style specification tells them apart.
 */
export function isExpressionFilter(filter) {
  if (filter === true || filter === false) return true;
  if (!Array.isArray(filter) || filter.length === 0) return false;
  switch (filter[0]) {
    case 'has':
      return filter.length >= 2 && filter[1] !== '$id' && filter[1] !== '$type';
    case 'in':
      return (
        filter.length >= 3 &&
        (typeof filter[1] !== 'string' || Array.isArray(filter[2]))
      );
    case '!in':
    case '!has':
    case 'none':
      return false;
    case '==':
    case '!=':
    case '>':
    case '>=':
    case '<':
    case '<=':
      return (
        filter.length !== 3 ||
        Array.isArray(filter[1]) ||
        Array.isArray(filter[2])
      );
    case 'any':
    case 'all':
      return filter
        .slice(1)
        .every((f) => typeof f === 'boolean' || isExpressionFilter(f));
    default:
      return true;
  }
}

/** A legacy filter's key on a feature: `$type`, `$id` or a property. */
const legacyKey = (key) => {
  if (key === '$type') return (f) => f.type;
  if (key === '$id') return (f) => f.id;
  return (f) => f.properties[key];
};

/** A legacy filter, compiled. */
function compileLegacyFilter(filter) {
  if (!Array.isArray(filter)) return unsupported(`filter ${filter}`);
  const [op, ...args] = filter;
  switch (op) {
    case 'all':
    case 'any':
    case 'none': {
      const parts = args.map(compileLegacyFilter);
      if (op === 'all') return (f) => parts.every((p) => p(f));
      if (op === 'any') return (f) => parts.some((p) => p(f));
      return (f) => !parts.some((p) => p(f));
    }
    case 'has':
    case '!has': {
      const has = (f) =>
        args[0] === '$type' || args[0] === '$id'
          ? legacyKey(args[0])(f) !== undefined
          : args[0] in f.properties;
      return op === 'has' ? has : (f) => !has(f);
    }
    case 'in':
    case '!in': {
      const get = legacyKey(args[0]);
      const values = new Set(args.slice(1));
      return op === 'in'
        ? (f) => values.has(get(f))
        : (f) => !values.has(get(f));
    }
    default: {
      const compare = COMPARE[op];
      if (!compare || args.length !== 2) return unsupported(`filter ${op}`);
      const get = legacyKey(args[0]);
      const value = args[1];
      if (op === '==') return (f) => get(f) === value;
      if (op === '!=') return (f) => get(f) !== value;
      // Ordered comparisons hold only between values of one type.
      return (f) => {
        const v = get(f);
        return typeof v === typeof value && compare(v, value);
      };
    }
  }
}

/**
 * A layer's `filter`, compiled to `(feature) => boolean` (none: every
 * feature).
 * @param {unknown} filter
 */
export function compileFilter(filter) {
  if (filter === undefined || filter === null) return () => true;
  if (!isExpressionFilter(filter)) return compileLegacyFilter(filter);
  const fn = compileExpression(filter);
  return (f) => fn(f) === true;
}

/** A legacy `{stops, base, property, type, default}` function, compiled. */
function compileFunction(fn) {
  const stops = fn.stops;
  const base = fn.base ?? 1;
  const type =
    fn.type ??
    (fn.property !== undefined && typeof stops?.[0]?.[1] === 'string'
      ? 'categorical'
      : 'exponential');
  if (type === 'identity') {
    if (fn.property === undefined) return unsupported('identity of zoom');
    return (f) => f.properties[fn.property] ?? fn.default;
  }
  if (!Array.isArray(stops) || stops.length === 0)
    return unsupported('a function without stops');
  // Zoom-and-property stops: `[{zoom, value}, output]`.
  if (typeof stops[0][0] === 'object') return unsupported('zoom and property');
  const input =
    fn.property === undefined
      ? (f) => f.zoom
      : (f) => f.properties[fn.property];
  if (type === 'categorical') {
    const map = new Map(stops.map(([k, v]) => [k, v]));
    return (f) => {
      const v = input(f);
      return map.has(v) ? map.get(v) : fn.default;
    };
  }
  if (type !== 'exponential' && type !== 'interval')
    return unsupported(`function type ${type}`);
  return (f) => {
    const x = input(f);
    if (typeof x !== 'number') return fn.default;
    return interpolateStops(stops, x, base, type === 'exponential');
  };
}

/**
 * A layout or paint value, compiled: a constant, a legacy function, or an
 * expression.
 * @param {unknown} value
 * @returns {(feature: object) => unknown}
 */
export function compileValue(value, { array = false } = {}) {
  // An array property's own value (`text-font`, `line-dasharray`): a
  // literal unless it names an operator.
  if (
    array &&
    Array.isArray(value) &&
    value.every((v) => !Array.isArray(v)) &&
    !OPERATORS.has(value[0])
  )
    return constant(value);
  if (isExpression(value)) return compileExpression(value);
  if (value && typeof value === 'object' && !Array.isArray(value))
    return compileFunction(value);
  return constant(value);
}

/** The operators {@link compileExpression} evaluates. */
export const OPERATORS = new Set([
  'literal',
  'zoom',
  'geometry-type',
  'id',
  'properties',
  'get',
  'has',
  '!',
  'all',
  'any',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  'case',
  'match',
  'coalesce',
  'step',
  'interpolate',
  'interpolate-hcl',
  'interpolate-lab',
  'to-string',
  'to-number',
  'to-boolean',
  'number',
  'string',
  'boolean',
  'to-color',
  'rgb',
  'rgba',
  'concat',
  'format',
  'upcase',
  'downcase',
  'length',
  'at',
  ...Object.keys(ARITHMETIC),
]);

/**
 * An expression, compiled.
 * @param {unknown} expr
 * @returns {(feature: object) => unknown}
 */
export function compileExpression(expr) {
  if (!Array.isArray(expr)) return constant(expr);
  if (!isExpression(expr)) return unsupported('an array that is not literal');
  const [op, ...raw] = expr;
  const args = () => raw.map(compileExpression);
  switch (op) {
    case 'literal':
      return constant(raw[0]);
    case 'zoom':
      return (f) => f.zoom;
    case 'geometry-type':
      return (f) => f.type;
    case 'id':
      return (f) => f.id ?? null;
    case 'properties':
      return (f) => f.properties;
    case 'get': {
      if (raw.length !== 1) return unsupported('get from an object');
      const [key] = args();
      return (f) => f.properties[key(f)] ?? null;
    }
    case 'has': {
      if (raw.length !== 1) return unsupported('has in an object');
      const [key] = args();
      return (f) => key(f) in f.properties;
    }
    case '!': {
      const [a] = args();
      return (f) => !a(f);
    }
    case 'all': {
      const parts = args();
      return (f) => parts.every((p) => p(f) === true);
    }
    case 'any': {
      const parts = args();
      return (f) => parts.some((p) => p(f) === true);
    }
    case '==':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=': {
      if (raw.length !== 2) return unsupported(`${op} with a collator`);
      const [a, b] = args();
      const compare = COMPARE[op];
      if (op === '==' || op === '!=')
        return (f) => compare(a(f) ?? null, b(f) ?? null);
      return (f) => {
        const x = a(f);
        const y = b(f);
        return typeof x === typeof y && x !== null && compare(x, y);
      };
    }
    case 'in': {
      const [needle, haystack] = args();
      return (f) => {
        const h = haystack(f);
        const n = needle(f);
        if (typeof h === 'string') return h.includes(n);
        if (Array.isArray(h)) return h.includes(n);
        return unsupported('in over this value');
      };
    }
    case 'case': {
      const parts = args();
      const fallback = parts.pop();
      return (f) => {
        for (let i = 0; i < parts.length; i += 2)
          if (parts[i](f) === true) return parts[i + 1](f);
        return fallback(f);
      };
    }
    case 'match': {
      const input = compileExpression(raw[0]);
      const fallback = compileExpression(raw[raw.length - 1]);
      const arms = [];
      for (let i = 1; i < raw.length - 1; i += 2)
        arms.push([new Set([raw[i]].flat()), compileExpression(raw[i + 1])]);
      return (f) => {
        const v = input(f);
        for (const [labels, out] of arms) if (labels.has(v)) return out(f);
        return fallback(f);
      };
    }
    case 'coalesce': {
      const parts = args();
      return (f) => {
        for (const p of parts) {
          const v = p(f);
          if (v !== null && v !== undefined) return v;
        }
        return null;
      };
    }
    case 'step': {
      const input = compileExpression(raw[0]);
      const first = compileExpression(raw[1]);
      const steps = [];
      for (let i = 2; i < raw.length; i += 2)
        steps.push([raw[i], compileExpression(raw[i + 1])]);
      return (f) => {
        const x = input(f);
        let out = first;
        for (const [at, value] of steps) if (x >= at) out = value;
        return out(f);
      };
    }
    case 'interpolate':
    case 'interpolate-hcl':
    case 'interpolate-lab': {
      const [kind, base = 1] = raw[0];
      if (kind !== 'linear' && kind !== 'exponential')
        return unsupported(`interpolate ${kind}`);
      const b = kind === 'linear' ? 1 : base;
      const input = compileExpression(raw[1]);
      const stops = [];
      for (let i = 2; i < raw.length; i += 2)
        stops.push([raw[i], compileExpression(raw[i + 1])]);
      return (f) => {
        const x = input(f);
        if (typeof x !== 'number')
          return unsupported('interpolate a non-number');
        return interpolateStops(
          stops.map(([at, value]) => [at, value(f)]),
          x,
          b,
        );
      };
    }
    case 'to-string': {
      const [a] = args();
      return (f) => {
        const v = a(f);
        return v === null || v === undefined ? '' : String(v);
      };
    }
    case 'to-number': {
      const parts = args();
      return (f) => {
        for (const p of parts) {
          const v = Number(p(f));
          if (Number.isFinite(v)) return v;
        }
        return unsupported('to-number of a non-number');
      };
    }
    case 'to-boolean': {
      const [a] = args();
      return (f) => Boolean(a(f));
    }
    case 'number':
    case 'string':
    case 'boolean': {
      const parts = args();
      return (f) => {
        for (const p of parts) {
          const v = p(f);
          if (typeof v === op) return v;
        }
        return unsupported(`${op} assertion failed`);
      };
    }
    case 'to-color': {
      const parts = args();
      return (f) => {
        for (const p of parts) {
          const v = p(f);
          if (parseColor(v)) return v;
        }
        return unsupported('to-color of a non-colour');
      };
    }
    case 'rgb':
    case 'rgba': {
      const parts = args();
      return (f) => {
        const [r, g, b, a = 1] = parts.map((p) => p(f));
        return cssOf([r, g, b, a]);
      };
    }
    case 'concat': {
      const parts = args();
      return (f) => parts.map((p) => textOf(p(f))).join('');
    }
    case 'format': {
      // Text and its per-section options: the text alone.
      const parts = [];
      for (const item of raw)
        if (!(item && typeof item === 'object' && !Array.isArray(item)))
          parts.push(compileExpression(item));
      return (f) => parts.map((p) => textOf(p(f))).join('');
    }
    case 'upcase':
    case 'downcase': {
      const [a] = args();
      return (f) =>
        op === 'upcase'
          ? textOf(a(f)).toUpperCase()
          : textOf(a(f)).toLowerCase();
    }
    case 'length': {
      const [a] = args();
      return (f) => a(f)?.length ?? 0;
    }
    case 'at': {
      const [i, a] = args();
      return (f) => a(f)?.[i(f)] ?? null;
    }
    default: {
      const arithmetic = ARITHMETIC[op];
      if (!arithmetic) return unsupported(`expression ${op}`);
      const parts = args();
      return (f) => {
        const values = parts.map((p) => p(f));
        if (!values.every((v) => typeof v === 'number'))
          return unsupported(`${op} of a non-number`);
        return arithmetic(values);
      };
    }
  }
}

/** A value as label text. */
function textOf(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

/**
 * A legacy `text-field` string's `{property}` tokens, filled from the
 * feature.
 */
export function fillTokens(text, properties) {
  return text.replace(/{([^{}]+)}/g, (_, key) => textOf(properties[key]));
}
