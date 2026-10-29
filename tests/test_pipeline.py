import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from project_io import atomic_text, validate_assets, validate_levels
from coord2000 import lonlat_to_en, en_to_lonlat
from build_js_data import bilinear
import fetch_dem

class PipelineTests(unittest.TestCase):
    def test_atomic_failure_preserves_original(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "data.json"
            path.write_text("original")
            with self.assertRaises(RuntimeError):
                with atomic_text(path) as stream:
                    stream.write("partial")
                    raise RuntimeError()
            self.assertEqual(path.read_text(), "original")
            self.assertEqual(len(list(Path(folder).iterdir())), 1)

    def test_duplicate_and_invalid_assets(self):
        for items in ([{"id": "a", "x": None}], [{"id": "a", "x": 1}] * 2):
            with self.assertRaises(ValueError):
                validate_assets(items, ("x",))

    def test_projection_origin_and_roundtrip(self):
        e, n = lonlat_to_en(114, 0, zone=38)
        self.assertAlmostEqual(e, 38500000)
        self.assertAlmostEqual(n, 0)
        lon, lat = en_to_lonlat(*lonlat_to_en(112.76, 40.42, zone=38))
        self.assertAlmostEqual(lon, 112.76, places=7)
        self.assertAlmostEqual(lat, 40.42, places=7)

    def test_frontend_python_height_parity(self):
        import subprocess
        from build_js_data import make_height
        root = Path(__file__).resolve().parents[1]
        dem = json.loads((root / "data/dem.json").read_text(encoding="utf-8"))
        payload = {"levels": dem["levels"], "terrainBlend": {"base": 1400, "inner": {"L0": .95, "L1": .70, "L2": .85}}}
        points = [[0, 0], [2000, 100], [2400, 0], [8400, 0], [12000, 0], [14000, 0], [20000, 0]]
        code = "const create=require('./js/terrain.js');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const a=JSON.parse(s);const h=create(a.payload);console.log(JSON.stringify(a.points.map(p=>h(...p))))});"
        result = subprocess.run(["node", "-e", code], input=json.dumps({"payload": payload, "points": points}), text=True, capture_output=True, cwd=root, check=True)
        height = make_height(dem["levels"], 1400)
        for point, actual in zip(points, json.loads(result.stdout)):
            self.assertAlmostEqual(height(*point), actual, places=9)

    def test_grid_orientation(self):
        lv = {"n": 2, "half": 1, "step": 2, "rows": [[20, 30], [0, 10]]}
        validate_levels(dict.fromkeys(("L0", "L1", "L2"), lv))
        self.assertAlmostEqual(bilinear(lv, 0, 0), 15)
        self.assertGreater(bilinear(lv, 0, 1), bilinear(lv, 0, -1))

    def test_fetch_resume_without_network(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "progress.json"
            points = [(40, 112)]
            path.write_text(json.dumps({"signature": {"api": fetch_dem.API, "points": points}, "values": [1500]}))
            with patch("fetch_dem.urllib.request.urlopen") as request:
                self.assertEqual(fetch_dem.fetch(points, path), [1500])
                request.assert_not_called()

    def test_invalid_response_rejected(self):
        from io import StringIO
        response = {"status": "OK", "results": [{"elevation": None}]}
        with patch("fetch_dem.urllib.request.urlopen", side_effect=lambda *a, **k: StringIO(json.dumps(response))), patch("fetch_dem.time.sleep"):
            with self.assertRaises(RuntimeError):
                fetch_dem.fetch([(40, 112)])

if __name__ == "__main__":
    unittest.main()
