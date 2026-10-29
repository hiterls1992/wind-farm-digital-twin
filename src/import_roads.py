"""Import surveyed DXF road axes as 6 m terrain-clamped gravel roads."""
import math
import ezdxf
from ezdxf.path import make_path
from coord2000 import en_to_lonlat, lonlat_to_en
from project_io import ROOT, write_json


def main():
    doc = ezdxf.readfile(ROOT / "风场数据/道路.dxf")
    roads = []
    worst = 0.0
    for entity in doc.modelspace():
        if entity.dxftype() not in ("LWPOLYLINE", "POLYLINE", "LINE", "ARC", "SPLINE"):
            continue
        points = [(float(p.x), float(p.y)) for p in make_path(entity).flattening(distance=0.1)]
        points = [p for i, p in enumerate(points) if not i or math.dist(p, points[i-1]) > 1e-6]
        if len(points) < 2:
            continue
        coordinates = []
        for east, north in points:
            if not (300000 < east < 500000 and 4400000 < north < 4600000):
                raise ValueError(f"Unexpected road coordinate: {east}, {north}")
            lon, lat = en_to_lonlat(east, north, zone=38, has_prefix=False)
            e, n = lonlat_to_en(lon, lat, zone=38, with_prefix=False)
            worst = max(worst, math.hypot(e-east, n-north))
            coordinates.append([round(lon, 9), round(lat, 9)])
        length = sum(math.dist(a,b) for a,b in zip(points, points[1:]))
        roads.append({"id": f"R{len(roads)+1:02d}", "layer": entity.dxf.layer,
                      "length_m": round(length, 2), "coordinates": coordinates})
    if not roads or worst > .02:
        raise ValueError(f"Road import validation failed: count={len(roads)}, residual={worst}")
    total = sum(r["length_m"] for r in roads)
    result = {"source": "风场数据/道路.dxf", "crs": "CGCS2000 / 3-degree GK zone 38, unprefixed easting, metres",
              "unit_note": "DXF INSUNITS=1 ignored: metre coordinates match project survey range",
              "width_m": 6, "surface": "山皮石", "roads": roads,
              "stats": {"count": len(roads), "length_m": round(total, 2),
                        "nominal_area_m2": round(total*6, 1), "roundtrip_max_m": round(worst, 6)}}
    write_json(ROOT / "data/roads.json", result)
    print(result["stats"])

if __name__ == "__main__":
    main()
