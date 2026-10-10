const D = { maxBytes: 2097152, maxItems: 512, maxText: 32768 };
const tn = (s) =>
  s
    .slice(1)
    .replace(/^\/?/, '')
    .split(/\s|>/)[0]
    .split(':')
    .pop()
    .toLowerCase();
const dec = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(
    /&lt;|&gt;|&quot;|&apos;|&amp;/g,
    (m) =>
      ({
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': "'",
        '&amp;': '&',
      })[m],
  );
function tree(x, o) {
  if (/<!DOCTYPE|<!ENTITY|<html[\s>]/i.test(x)) throw Error('invalid_cap');
  const r = { n: 'root', c: [], t: '' },
    s = [r];
  let p = 0,
    k = 0;
  for (const m of x.matchAll(
    /<!--[\s\S]*?-->|<\?[^>]*>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>/g,
  )) {
    if (++k > o.maxItems * 30) throw Error('cap_limit');
    s.at(-1).t += x.slice(p, m.index);
    p = m.index + m[0].length;
    const z = m[0];
    if (z.startsWith('<!--') || z.startsWith('<?')) continue;
    if (z.startsWith('<![CDATA[')) {
      s.at(-1).t += z;
      continue;
    }
    if (z.startsWith('</')) {
      if (s.length === 1 || tn(z) !== s.at(-1).n) throw Error('malformed_xml');
      s.pop();
      continue;
    }
    if (z.startsWith('<!')) throw Error('invalid_cap');
    const n = tn(z),
      q = { n, c: [], t: '' };
    if (!/^[a-z_][\w.-]*$/.test(n)) throw Error('malformed_xml');
    s.at(-1).c.push(q);
    if (!z.endsWith('/>')) s.push(q);
  }
  if (s.length !== 1 || x.slice(p).trim()) throw Error('malformed_xml');
  return r;
}
const cs = (n, k) => n.c.filter((x) => x.n === k),
  val = (n, k, o) => {
    const x = cs(n, k)[0];
    return x
      ? dec((x.t + x.c.map((y) => y.t).join('')).trim()).slice(0, o.maxText)
      : null;
  };
const geo = (a) => {
  const p = val(a, 'polygon', D);
  if (p) {
    const v = p.split(/\s+/).map((q) => q.split(',').map(Number));
    return v.length >= 3 &&
      v.every(
        (q) =>
          q.length === 2 &&
          q.every(Number.isFinite) &&
          q[0] >= -90 &&
          q[0] <= 90 &&
          q[1] >= -180 &&
          q[1] <= 180,
      )
      ? { type: 'polygon', coordinates: v }
      : null;
  }
  const c = val(a, 'circle', D)?.split(/[ ,]+/).map(Number);
  return c?.length === 3 &&
    c.every(Number.isFinite) &&
    c[0] >= -90 &&
    c[0] <= 90 &&
    c[1] >= -180 &&
    c[1] <= 180 &&
    c[2] >= 0
    ? { type: 'circle', center: c.slice(0, 2), radiusKm: c[2] }
    : null;
};
export function parseCap(xml, opt = {}) {
  const o = { ...D, ...opt };
  if (
    typeof xml !== 'string' ||
    new TextEncoder().encode(xml).length > o.maxBytes
  )
    throw Error('invalid_cap');
  const a = cs(tree(xml, o), 'alert');
  if (!a.length || a.length > o.maxItems) throw Error('invalid_cap');
  return a.map((x) => ({
    identifier: val(x, 'identifier', o),
    sender: val(x, 'sender', o),
    sent: val(x, 'sent', o),
    msgType: val(x, 'msgtype', o),
    status: val(x, 'status', o),
    scope: val(x, 'scope', o),
    references: val(x, 'references', o),
    info: cs(x, 'info').map((i) => ({
      language: val(i, 'language', o),
      category: val(i, 'category', o),
      event: val(i, 'event', o),
      urgency: val(i, 'urgency', o),
      severity: val(i, 'severity', o),
      certainty: val(i, 'certainty', o),
      headline: val(i, 'headline', o),
      description: val(i, 'description', o),
      instruction: val(i, 'instruction', o),
      onset: val(i, 'onset', o),
      expires: val(i, 'expires', o),
      areas: cs(i, 'area').map((a) => ({
        description: val(a, 'areadesc', o),
        geometry: geo(a),
        geocode: val(a, 'value', o),
      })),
    })),
  }));
}
