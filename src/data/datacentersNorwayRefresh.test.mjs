import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('../../scripts/build-datacenters-norway.py', import.meta.url),
);

function python(t, source) {
  const result = spawnSync('python3', ['-c', source, SCRIPT], {
    encoding: 'utf8',
  });
  if (result.error?.code === 'ENOENT') return t.skip('python3 is not installed');
  assert.equal(result.status, 0, result.stderr);
}

test('Norway refresh compares rings, not vertex sets', (t) => {
  python(
    t,
    String.raw`
import runpy, sys
same = runpy.run_path(sys.argv[1])['same_geometry']
poly = lambda *rings: {'type': 'Polygon', 'coordinates': list(rings)}
multi = lambda *polys: {'type': 'MultiPolygon', 'coordinates': [p['coordinates'] for p in polys]}
a, b, c, d, e = [0, 0], [4, 0], [4, 4], [0, 4], [2, 1]
assert not same(poly([a, b, c, d, e, a]), poly([a, b, e, c, d, a])), 'reordered edges'
assert same(poly([a, b, c, d, e, a]), poly([c, b, a, e, d, c])), 'ring start and winding'
assert same(poly([a, b, c, d, a]), poly([[0, 1e-7], b, c, d, [0, 1e-7]])), 'tolerance'
outer = [[0, 0], [9, 0], [9, 9], [0, 9], [0, 0]]
one, two = [[1, 1], [2, 1], [2, 2], [1, 1]], [[5, 5], [6, 5], [6, 6], [5, 5]]
assert same(poly(outer, one, two), poly(outer, two, one)), 'hole order'
assert not same(poly(outer, one), poly(one, outer)), 'outer and inner roles swapped'
assert same(multi(poly(one), poly(two)), multi(poly(two), poly(one))), 'part order'
p, q, r, s, u, v = [0, 0], [1, 0], [0, 1], [5, 5], [6, 5], [5, 6]
assert not same(multi(poly([p, q, r, p]), poly([s, u, v, s])),
                multi(poly([p, q, s, p]), poly([r, u, v, r]))), 'vertices moved between parts'
`,
  );
});

test('Norway refresh keeps a still-tagged feature osmium did not export', (t) => {
  python(
    t,
    String.raw`
import json, runpy, sys
merge = runpy.run_path(sys.argv[1])['merge']
square = [[[10, 60], [10.01, 60], [10.01, 60.01], [10, 60.01], [10, 60]]]
def line(osm_id, sequence):
    return json.dumps({'id': osm_id, 'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': square},
                       'properties': {'id': sequence, 'tags': {'building': 'data_center'},
                                      'type': 'data_center', 'osm_id': osm_id}})
norway = [([(0, 0), (20, 0), (20, 80), (0, 80)], False)]
lines = [line(7, 1), line(8, 2)]
out, report = merge(lines, {}, norway, {'w7'})
assert out == [lines[0]], out
assert report['unexported'] == ['w7'] and report['removed'] == ['w8'], report
`,
  );
});

test('Norway refresh lists tagged objects apart from the exported geometry', (t) => {
  python(
    t,
    String.raw`
import json, runpy, subprocess, sys, tempfile
from pathlib import Path
export = runpy.run_path(sys.argv[1])['export']
tags = {'building': 'data_center'}
ring = [[10, 60], [10.01, 60], [10.01, 60.01], [10, 60]]
features = [
    {'id': 'n1', 'properties': {'telecom': 'data_center'}, 'geometry': {'type': 'Point', 'coordinates': [10, 60]}},
    {'id': 'w5', 'properties': tags, 'geometry': {'type': 'LineString', 'coordinates': ring}},
    {'id': 'a10', 'properties': tags, 'geometry': {'type': 'MultiPolygon', 'coordinates': [[ring]]}},
    {'id': 'w7', 'properties': tags, 'geometry': {'type': 'LineString', 'coordinates': ring[:3]}},
]
outputs = {
    '.opl': 'n1 v1 Ttelecom=data_center x10 y60\nw5 v1 Tbuilding=data_center Nn2,n3,n4,n2\n'
            'w7 v1 Tbuilding=data_center Nn2,n3,n4\nr9 v1 Ttelecom=data_center Mw8@outer\n',
    '.geojsonseq': ''.join(chr(30) + json.dumps({'type': 'Feature', **f}) + '\n' for f in features),
}
def run(args, check=False):
    target = Path(args[args.index('-o') + 1])
    target.write_text(outputs.get(target.suffix, ''), encoding='utf-8')
subprocess.run = run
with tempfile.TemporaryDirectory() as cache:
    fresh, tagged = export('osmium', Path(cache) / 'norway-test.osm.pbf', Path(cache), 'norway-test')
assert sorted(fresh) == ['n1', 'w5'], fresh
assert fresh['w5']['geometry'] == {'type': 'Polygon', 'coordinates': [ring]}, fresh['w5']
assert tagged == {'n1', 'w5', 'w7', 'r9'}, tagged
`,
  );
});
