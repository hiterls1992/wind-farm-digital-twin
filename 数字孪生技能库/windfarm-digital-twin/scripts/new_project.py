"""Create an isolated project without carrying over survey data or secrets."""
import argparse,json,shutil
from pathlib import Path

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--target",required=True);p.add_argument("--config",required=True);p.add_argument("--input-dir",required=True)
    a=p.parse_args();target=Path(a.target).resolve();inputs=Path(a.input_dir).resolve()
    if target.exists():raise SystemExit("Target already exists; choose a new project directory")
    config=json.loads(Path(a.config).read_text(encoding="utf-8"))
    if config["crs"]["datum"]!="CGCS2000" or config["crs"]["band_width"] not in (3,6) or not isinstance(config["crs"]["zone"],int):raise SystemExit("Configure an explicit CGCS2000 zone and band width")
    if config["turbine"].get("rotor_d_m") is not None and (not isinstance(config["turbine"]["rotor_d_m"],(int,float)) or config["turbine"]["rotor_d_m"]<=0):raise SystemExit("Set rotor diameter")
    if config["roads"]["coordinate_unit"]!="m":raise SystemExit("Normalize DXF to metre coordinates first")
    files=config["files"]
    if not files["turbines"]:raise SystemExit("Turbine workbook is required")
    for name in files.values():
        if name and (Path(name).name!=name or not (inputs/name).is_file()):raise SystemExit("Missing or unsafe input filename: "+str(name))
    grid=config["grid"]
    if files["gridline"] and not grid["chains"]:raise SystemExit("Specify grid chains; topology must not be guessed")
    for link in grid["links"]:
        if not all(k in link for k in ("from","to","line","circuit")):raise SystemExit("Grid links need from/to/line/circuit")
    template=Path(__file__).resolve().parents[1]/"assets/project-template"
    shutil.copytree(template,target)
    (target/"风场数据").mkdir()
    for name in files.values():
        if name:shutil.copy2(inputs/name,target/"风场数据"/name)
    (target/"project.config.json").write_text(json.dumps(config,ensure_ascii=False,indent=2),encoding="utf-8")
    print(target)
    print("Next: python src/run_pipeline.py --prepare; then --fetch-dem to sample this project's terrain")
if __name__=="__main__":main()
