"""Fixture checks: python -m unittest discover -s scripts/transmission -p 'test_*.py'."""
import unittest
from shapely.geometry import LineString, Point, Polygon, box, shape
from extract import BBOX, make_pack, voltage_state


class ExtractionTest(unittest.TestCase):
    def test_voltage_lists_and_missing_malformed(self):
        self.assertEqual(voltage_state(None), ('unknown', []))
        for raw in ['', 'medium', '132000;medium', '132 kV', '-132000']:
            self.assertEqual(voltage_state(raw), ('malformed', []))
        self.assertEqual(voltage_state('66000; 132000,400000'), ('known', [66000, 132000, 400000]))
        self.assertEqual(voltage_state('66000'), ('below', [66000]))

    def test_clipping_unknown_records_and_overlap_provenance(self):
        area = Polygon([(18.5, -34), (18.6, -34), (18.6, -33.9), (18.5, -33.9), (18.5, -34)])
        records = [
            {'id':'way/1','kind':'line','tags':{'voltage':'132000'},'geometry':LineString([(18.1,-34.1),(18.8,-34.1),(19.2,-34.1)])},
            {'id':'way/2','kind':'substation','tags':{'voltage':'66000'},'geometry':area},
            {'id':'node/3','kind':'substation','tags':{},'geometry':Point(18.55,-33.95)},
            {'id':'way/4','kind':'line','tags':{},'geometry':LineString([(18.4,-34),(18.5,-34)])},
            {'id':'way/5','kind':'substation','tags':{'voltage':'66000;132000'},'geometry':area},
        ]
        region = box(*BBOX)
        pack, overlaps = make_pack(records, region)
        features = {f['id']:f for f in pack['features']}
        self.assertEqual(set(features), {'way/1','node/3','way/5'})
        self.assertTrue(all(region.buffer(1e-8).covers(shape(f['geometry'])) for f in features.values()))
        self.assertTrue(features['way/1']['properties']['clipped'])
        self.assertEqual(features['way/5']['properties']['voltages'], [66000,132000])
        self.assertTrue(area.covers(shape(features['way/5']['geometry'])))
        self.assertEqual(features['node/3']['properties']['voltageState'], 'unknown')
        self.assertEqual(overlaps, [{'id':'node/3','areas':['way/2','way/5']}])
        self.assertEqual(make_pack(list(reversed(records)), region)[0], pack)


if __name__ == '__main__':
    unittest.main()
