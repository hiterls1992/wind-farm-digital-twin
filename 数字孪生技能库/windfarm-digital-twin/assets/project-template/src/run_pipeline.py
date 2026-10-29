"""Config-driven imports; DEM acquisition is explicit and resumable."""
import argparse,subprocess,sys
from project_io import ROOT,PROJECT
if __name__=="__main__":
 p=argparse.ArgumentParser();p.add_argument("--prepare",action="store_true");p.add_argument("--offline",action="store_true");p.add_argument("--fetch-dem",action="store_true");a=p.parse_args()
 if sum([a.prepare,a.offline,a.fetch_dem])!=1:p.error("Choose --prepare, --fetch-dem or --offline")
 files=PROJECT["files"]
 steps=[]
 if a.prepare:
  if (ROOT/"data/site.json").exists():raise SystemExit("Derived site already exists; use a fresh target for replacing project data")
  steps=["import_windfarm","import_machine_parameters"]
  for key,script in [("gridline","import_gridline"),("roads","import_roads"),("hourly_energy","import_hourly_energy")]:
   if files.get(key):steps.append(script)
 elif a.fetch_dem:steps=["fetch_dem","build_js_data"]
 else:
  if not (ROOT/"data/dem.json").exists():raise SystemExit("No project DEM. Run --fetch-dem or provide a validated DEM with matching origin")
  steps=["build_js_data"]
 for step in steps:subprocess.run([sys.executable,str(ROOT/"src"/(step+".py"))],cwd=ROOT,check=True)
