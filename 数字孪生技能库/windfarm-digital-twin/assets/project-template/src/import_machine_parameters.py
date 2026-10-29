"""Read the category/parameter/value turbine specification sheet without inventing units."""
from pathlib import Path
import json
import math
import openpyxl
from project_io import ROOT, write_json

def apply_parameters(site, workbook=None, rotor_override=None, sheet_name="风机参数"):
    workbook = workbook or ROOT / "风场数据/风电场.xlsx"
    book = openpyxl.load_workbook(workbook, read_only=True, data_only=True)
    if sheet_name not in book.sheetnames:
        book.close()
        return site
    rows=list(book[sheet_name].values);book.close()
    items=[];category="基本参数";model=None
    for row in rows:
        a,b,value=(list(row)+[None]*3)[:3]
        if value is None:continue
        if a=="项目" and not b:
            model=str(value);continue
        if b:
            if a:category=str(a)
            name=str(b)
        else:name=str(a)
        if not name or name=="None":continue
        items.append({"category":category,"name":name,"value":value})
    machine=site["machine"]
    if model:machine["model"]=model
    machine["parameters"]={"sheet":sheet_name,"source":Path(workbook).name,"items":items}
    def numeric(keyword):
        values=[i["value"] for i in items if keyword in i["name"]]
        if not values:return None
        v=values[0]
        if not isinstance(v,(int,float)) or not math.isfinite(v) or v<=0:raise ValueError("Invalid machine parameter: "+keyword)
        return float(v)
    diameter=numeric("叶轮直径")
    capacity=numeric("单机容量")
    if capacity and abs(capacity-machine["rated_mw"])>.02:
        raise ValueError("Parameter-sheet capacity differs from turbine energy data")
    if diameter:machine["rotor_d_source_m"]=diameter
    effective=rotor_override if rotor_override is not None else diameter
    if effective is not None:
        machine["rotor_d"]=float(effective)
        machine["rotor_d_override_m"]=rotor_override
        machine["rotor_d_note"]="项目配置覆盖" if rotor_override is not None else "风机参数表"
        site["checks"]["min_spacing_D"]=round(site["checks"]["min_spacing_m"]/effective,2)
        for pair in site.get("pairs",[]):pair["dist_D"]=round(pair["dist"]/effective,2)
    return site

def main():
    path=ROOT/"data/site.json";site=json.loads(path.read_text(encoding="utf-8"))
    config_path=ROOT/"project.config.json"
    if config_path.exists():
        config=json.loads(config_path.read_text(encoding="utf-8"))
        workbook=ROOT/"风场数据"/config["files"]["turbines"]
        override=config["turbine"].get("rotor_d_m")
        sheet=config["sheets"].get("machine","风机参数")
    else:
        workbook=None;override=site["machine"].get("rotor_d_override_m");sheet="风机参数"
    apply_parameters(site,workbook,override,sheet)
    write_json(path,site)
    print("Imported turbine parameter sheet")
if __name__=="__main__":main()
