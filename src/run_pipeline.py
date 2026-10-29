"""Run from any directory: python src/run_pipeline.py [--offline]."""
import argparse
import subprocess
import sys
from project_io import ROOT

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--offline", action="store_true", help="Only rebuild frontend data from existing JSON")
    args = parser.parse_args()
    steps = ["build_js_data"] if args.offline else ["import_windfarm", "import_machine_parameters", "import_gridline", "import_roads", "import_hourly_energy", "fetch_dem", "make_tower_glb", "build_js_data"]
    for step in steps:
        subprocess.run([sys.executable, str(ROOT / "src" / (step + ".py"))], cwd=ROOT, check=True)
