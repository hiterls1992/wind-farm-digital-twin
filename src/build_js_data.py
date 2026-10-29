# -*- coding: utf-8 -*-
"""
把 DEM 与机位工程数据打包成前端可直接 <script> 加载的 JS 数据文件

输入：data/dem.json（地形分级网格）、data/site.json（机位与电量，来自实测数据表）
输出：data/site-data.js

本步骤同时完成三件事：
  1) 用与前端完全一致的分级融合高度函数，算出每个机位的地形模型高程与坡度，
     并与数据表给出的实测地面高程 Z 做差，差值一并写盘供前端并列显示（可审计）；
  2) 统计场区控制范围内的地形指标（高程区间、高差、坡度）；
  3) 把分级融合权重写入数据文件，前端不再硬编码任何半径，避免两边参数漂移。
"""
import json
from project_io import ROOT, atomic_text, write_json, finite, validate_levels, validate_assets
import math
import os

DEM_JSON = ROOT / "data/dem.json"
SITE_JSON = ROOT / "data/site.json"
GRID_JSON = ROOT / "data/gridline.json"
TOWER_TYPES = ROOT / "data/tower-types.json"
OUT_JS = ROOT / "data/site-data.js"

# 分级融合权重：某一级在 r <= inner × half 时权重为 1，在 r >= half 时降为 0
# 中间用 smoothstep 过渡。此值由本脚本写入 site-data.js，前端直接读取。
BLEND_INNER = {"L2": 0.85, "L1": 0.70, "L0": 0.95}


def smooth(t):
    if t <= 0:
        return 0.0
    if t >= 1:
        return 1.0
    return t * t * (3 - 2 * t)


def bilinear(lv, x, y):
    n, step, half, rows = lv["n"], lv["step"], lv["half"], lv["rows"]
    fc = (x + half) / step
    fr = (half - y) / step
    fc = min(max(fc, 0.0), n - 1.0001)
    fr = min(max(fr, 0.0), n - 1.0001)
    i0, j0 = int(fc), int(fr)
    tx, ty = fc - i0, fr - j0
    h00, h01 = rows[j0][i0], rows[j0][i0 + 1]
    h10, h11 = rows[j0 + 1][i0], rows[j0 + 1][i0 + 1]
    return (h00 * (1 - tx) * (1 - ty) + h01 * tx * (1 - ty)
            + h10 * (1 - tx) * ty + h11 * tx * ty)


def level_weight(lv, name, r):
    half = lv["half"]
    inner = BLEND_INNER[name] * half
    if r <= inner:
        return 1.0
    if r >= half:
        return 0.0
    return smooth((half - r) / (half - inner))


def make_height(levels, base):
    def height(x, y):
        r = math.hypot(x, y)
        h2 = bilinear(levels["L2"], x, y)
        h1 = bilinear(levels["L1"], x, y)
        h0 = bilinear(levels["L0"], x, y)
        w2 = level_weight(levels["L2"], "L2", r)
        w1 = level_weight(levels["L1"], "L1", r)
        w0 = level_weight(levels["L0"], "L0", r)
        inner = w1 * h1 + (1 - w1) * h0
        mid = w2 * h2 + (1 - w2) * inner
        return w0 * mid + (1 - w0) * base
    return height


def slope_at(height, x, y, d=40.0):
    dzdx = (height(x + d, y) - height(x - d, y)) / (2 * d)
    dzdy = (height(x, y + d) - height(x, y - d)) / (2 * d)
    return math.degrees(math.atan(math.hypot(dzdx, dzdy)))


def point_in_poly(x, y, poly):
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xt = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if xt > x:
                inside = not inside
    return inside


def main():
    with open(DEM_JSON, encoding="utf-8") as f:
        dem = json.load(f)
    with open(SITE_JSON, encoding="utf-8") as f:
        site = json.load(f)

    validate_levels(dem["levels"])
    validate_assets(site["turbines"], ("x", "y", "ground", "net_mwh"))
    if site["machine"]["count"] != len(site["turbines"]):
        raise ValueError("机组数量不一致")
    levels = dem["levels"]
    # 远场基准高程：取 L0 四边均值，避免把某一角的山头当作基准
    l0 = levels["L0"]
    n0 = l0["n"]
    edge = (l0["rows"][0] + l0["rows"][-1]
            + [r[0] for r in l0["rows"]] + [r[-1] for r in l0["rows"]])
    base = int(round(sum(edge) / len(edge)))
    height = make_height(levels, base)

    # ---------- 机位：地形模型高程、坡度、与实测 Z 的差值
    diffs = []
    for t in site["turbines"]:
        t["ground_dem"] = round(height(t["x"], t["y"]), 1)
        t["slope"] = round(slope_at(height, t["x"], t["y"]), 1)
        t["dem_diff"] = round(t["ground_dem"] - t["ground"], 1)
        diffs.append(abs(t["dem_diff"]))

    st = site["substation"]
    st["ground"] = round(height(st["x"], st["y"]), 1)
    st["slope"] = round(slope_at(height, st["x"], st["y"]), 1)

    # ---------- 场区地形统计（在控制范围多边形内按 50 m 网格采样）
    poly = site["boundary_polygon"]
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    step = 50.0
    sub, slopes = [], []
    x = min(xs)
    while x <= max(xs):
        y = min(ys)
        while y <= max(ys):
            if point_in_poly(x, y, poly):
                sub.append(height(x, y))
                slopes.append(slope_at(height, x, y))
            y += step
        x += step

    site["terrain"] = {
        "min": round(min(sub)),
        "max": round(max(sub)),
        "mean": round(sum(sub) / len(sub)),
        "relief": round(max(sub) - min(sub)),
        "mean_slope": round(sum(slopes) / len(slopes), 1),
        "max_slope": round(max(slopes), 1),
        "samples": len(sub),
        "base_elev": base,
        "dem_note": "ASTER GDEM v3 30 m，30 m 栅格插值；机位高程以数据表 Z 为准",
    }
    site["checks"]["dem_diff_max_m"] = round(max(diffs), 1)
    site["checks"]["dem_diff_mean_m"] = round(sum(diffs) / len(diffs), 1)

    # ---------- 集电线路杆塔（若存在 gridline.json）
    grid = None
    if os.path.exists(GRID_JSON):
        with open(GRID_JSON, encoding="utf-8") as f:
            grid = json.load(f)
        validate_assets(grid["towers"], ("x", "y", "lat", "lon"))
        tground = dem.get("towerGround", {})
        tdiffs = []
        for t in grid["towers"]:
            # ground：分级网格高度——场景里塔基就落在这个高度上，保证与地形面严格贴合；
            # ground_aster：ASTER 30 m 源数据点值——独立校核值，两者差值并列显示。
            t["ground"] = round(height(t["x"], t["y"]), 1)
            t["ground_aster"] = None if t.get("position_adjustment") else tground.get(t["id"])
            if t["ground_aster"] is not None:
                t["dem_diff"] = round(t["ground"] - t["ground_aster"], 1)
                tdiffs.append(abs(t["dem_diff"]))
            else:
                t["dem_diff"] = None
            t["slope"] = round(slope_at(height, t["x"], t["y"]), 1)

        grounds = [t["ground"] for t in grid["towers"]]
        grid["stats"]["ground_min"] = round(min(grounds))
        grid["stats"]["ground_max"] = round(max(grounds))
        grid["stats"]["ground_mean"] = round(sum(grounds) / len(grounds))
        if tdiffs:
            grid["stats"]["grid_vs_aster_max_m"] = round(max(tdiffs), 1)
            grid["stats"]["grid_vs_aster_mean_m"] = round(sum(tdiffs) / len(tdiffs), 1)
        grid["stats"]["ground_source"] = ("塔基落地高程取分级 DEM 网格（保证与地形面贴合）；"
                                          "ASTER 30 m 点采样值作为独立校核")

    payload = {
        "center": {"lat": dem["center"]["lat"], "lon": dem["center"]["lon"]},
        "centerGcj02": dem["center_gcj02"],
        "source": dem["source"],
        "levels": levels,
        "terrainBlend": {"inner": BLEND_INNER, "base": base},
        "site": site,
    }
    hourly_path = ROOT / "data/hourly-energy.json"
    if hourly_path.exists():
        with hourly_path.open(encoding="utf-8") as stream:
            payload["hourlyEnergy"] = json.load(stream)
    roads_path = ROOT / "data/roads.json"
    if roads_path.exists():
        with roads_path.open(encoding="utf-8") as stream:
            payload["roads"] = json.load(stream)
    if grid:
        payload["gridline"] = grid
        if os.path.exists(TOWER_TYPES):
            with open(TOWER_TYPES, encoding="utf-8") as f:
                payload["towerTypes"] = json.load(f)["types"]

    with atomic_text(OUT_JS) as f:
        f.write("/* 自动生成，勿手工编辑 —— 由 src/build_js_data.py 生成 */\n")
        f.write("window.SITE_DATA = ")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    print("场区地形 %.0f ~ %.0f m，高差 %.0f m，平均坡度 %.1f°，最大 %.1f°（%d 个采样）"
          % (site["terrain"]["min"], site["terrain"]["max"], site["terrain"]["relief"],
             site["terrain"]["mean_slope"], site["terrain"]["max_slope"], len(sub)))
    print("机位地形模型高程 vs 实测 Z：最大差 %.1f m，平均 %.1f m"
          % (site["checks"]["dem_diff_max_m"], site["checks"]["dem_diff_mean_m"]))
    for t in site["turbines"]:
        print("  %-6s 实测 %7.2f m  DEM %7.1f m  差 %+5.1f m  坡度 %4.1f°"
              % (t["id"], t["ground"], t["ground_dem"], t["dem_diff"], t["slope"]))

    if grid:
        gs = grid["stats"]
        print("集电线路杆塔 %d 基（耐张 %d / 直线 %d），线路 %.2f km，档距 %.0f ~ %.0f m"
              % (gs["count"], gs["tension"], gs["suspension"],
                 gs["length_total_m"] / 1000, gs["span_min_m"], gs["span_max_m"]))
        print("  塔基高程 %.0f ~ %.0f m（均 %.0f）；与 ASTER 点采样最大差 %.1f m、平均 %.1f m"
              % (gs["ground_min"], gs["ground_max"], gs["ground_mean"],
                 gs.get("grid_vs_aster_max_m", 0), gs.get("grid_vs_aster_mean_m", 0)))
    print("已生成 %s，%.1f KB" % (OUT_JS, os.path.getsize(OUT_JS) / 1024))


if __name__ == "__main__":
    main()
