"""Read 8760 hourly farm generation, preserving kWh and yearless timestamps."""
import datetime as dt
import math
import re
import openpyxl
from project_io import ROOT, PROJECT, write_json

def main():
    book = openpyxl.load_workbook(ROOT / "风场数据" / PROJECT["files"]["hourly_energy"], read_only=True, data_only=True)
    sheet = book.worksheets[0]
    rows = list(sheet.values)
    if rows[0][1] != "kWh":
        raise ValueError("Expected kWh source unit")
    values, labels, months = [], [], []
    start = dt.datetime(2001,1,1)  # Non-leap reference only, never shown as source year.
    for i, row in enumerate(rows[1:]):
        match = re.fullmatch(r"\s*(\d+)/(\d+)\s+(\d+):00\s*", str(row[0]))
        if not match:
            raise ValueError(f"Invalid time in row {i+2}: {row[0]}")
        month, day, hour = map(int, match.groups())
        expected = start + dt.timedelta(hours=i)
        if (month,day,hour) != (expected.month,expected.day,expected.hour):
            raise ValueError(f"Missing or duplicated hour in row {i+2}")
        value = row[1]
        if not isinstance(value,(int,float)) or not math.isfinite(value) or value < 0:
            raise ValueError(f"Invalid generation in row {i+2}")
        values.append(float(value));labels.append(f"{month:02d}/{day:02d} {hour:02d}:00");months.append(month)
    book.close()
    if len(values)!=8760:
        raise ValueError(f"Expected 8760 records, got {len(values)}")
    monthly=[sum(v for v,m in zip(values,months) if m==month) for month in range(1,13)]
    daily=[sum(values[i:i+24]) for i in range(0,8760,24)]
    assert abs(sum(monthly)-sum(values))<.01
    payload={"source":"风场数据/"+PROJECT["files"]["hourly_energy"],"unit":"kWh","year":None,"labels":labels,"months":months,"values":values,"daily":daily,"monthly":monthly,
             "stats":{"hours":8760,"total_kwh":sum(values),"max_kwh":max(values),"peak_time":labels[values.index(max(values))],"zero_hours":values.count(0)}}
    write_json(ROOT / "data/hourly-energy.json",payload)
    print(payload["stats"])
if __name__ == "__main__":main()
