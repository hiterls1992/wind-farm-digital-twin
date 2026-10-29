# -*- coding: utf-8 -*-
"""
读取风电场实测机位数据表（xlsx），生成 data/site.json

输入：风场数据/风电场.xlsx（工作表「风机数据」）
      列：风机编号、X（2000坐标系）、Y（2000坐标系）、Z、轮毂高度、平均风速、
          考虑尾流下的平均风速、理论发电量、尾流损失、年上网电量、等效满发小时数
输出：data/site.json

约定：
  1) 表中 X 列为 8 位东坐标（含 38 带带号），Y 列为北坐标。测量习惯常把
     北坐标写作 X，本表相反，故按「数值特征」判定而非按列名判定，并在日志中打印确认。
  2) 所有坐标先换算到 CGCS2000 经纬度（见 coord2000.py），再以机位重心为原点
     建立局部 ENU（x 向东、y 向北），供三维场景使用。经纬度与 ENU 同时写盘，
     二者可互相校核。
  3) 单机容量由「年上网电量 / 等效满发小时数」反算，不写死。
"""
import json
from project_io import ROOT, atomic_text, write_json, finite, validate_levels, validate_assets
import math
import os
import sys

import openpyxl

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from coord2000 import en_to_lonlat, lonlat_to_en          # noqa: E402
from coord_transform import wgs84_to_gcj02                # noqa: E402

SRC_XLSX = ROOT / "风场数据/风电场.xlsx"
OUT_JSON = ROOT / "data/site.json"
SHEET = "电量数据"

ZONE = 38                  # CGCS2000 3° 带号，中央经线 114°E
BAND_WIDTH = 3

# 机型参数中数据表未给出的部分，集中在此，便于一处修改
ROTOR_D = 220.0            # 叶轮直径默认值，随后由风机参数表更新


def norm(s):
    """表头归一化：去空白、换行、括号全角半角差异"""
    return str(s or "").replace("\n", "").replace(" ", "").replace("（", "(").replace("）", ")")


def num(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


def read_rows(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[SHEET]
    header = [norm(c) for c in next(ws.iter_rows(min_row=1, max_row=1, values_only=True))]

    def col(*keys):
        for i, h in enumerate(header):
            if all(k in h for k in keys):
                return i
        raise KeyError("找不到列：%s，实际表头 %s" % ("/".join(keys), header))

    idx = {
        "id": col("风机编号"),
        "x": col("X", "2000"),
        "y": col("Y", "2000"),
        "z": col("Z"),
        "hub": col("轮毂高度"),
        "v": col("平均风速"),
        "v_wake": col("尾流", "平均风速"),
        "gross": col("理论发电量"),
        "wake": col("尾流损失"),
        "net": col("年上网电量"),
        "hours": col("等效满发"),
    }
    rows = []
    for r in ws.iter_rows(min_row=2, values_only=True):
        tid = r[idx["id"]]
        e, n = num(r[idx["x"]]), num(r[idx["y"]])
        if not tid or not isinstance(tid, str) or n is None:
            continue                                  # 跳过「平均」「总计」行
        rows.append({
            "id": tid.strip(),
            "e": e, "n": n,
            "z": num(r[idx["z"]]),
            "hub": num(r[idx["hub"]]),
            "v": num(r[idx["v"]]),
            "v_wake": num(r[idx["v_wake"]]),
            "gross": num(r[idx["gross"]]),
            "wake": num(r[idx["wake"]]),
            "net": num(r[idx["net"]]),
            "hours": num(r[idx["hours"]]),
        })
    return rows


def convex_hull(pts):
    """Andrew 单调链，返回逆时针顶点序列（pts 为 (x, y) 列表）"""
    p = sorted(set(pts))
    if len(p) <= 3:
        return p

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for q in p:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], q) <= 0:
            lower.pop()
        lower.append(q)
    for q in reversed(p):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], q) <= 0:
            upper.pop()
        upper.append(q)
    return lower[:-1] + upper[:-1]


def polygon_area(pts):
    s = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def buffer_polygon(pts, center, dist):
    """以重心为中心的径向外扩（前期方案示意足够，非严格等距缓冲）"""
    out = []
    for x, y in pts:
        dx, dy = x - center[0], y - center[1]
        r = math.hypot(dx, dy)
        if r < 1e-6:
            out.append((x + dist, y))
        else:
            k = (r + dist) / r
            out.append((center[0] + dx * k, center[1] + dy * k))
    return out


def main():
    rows = read_rows(SRC_XLSX)
    if not rows:
        raise SystemExit("未读到有效机位记录")

    # ---------- 按数值特征判定东/北坐标，避免列名与实际含义相反导致整体错位
    sample_e, sample_n = rows[0]["e"], rows[0]["n"]
    if sample_e > 1e6 and sample_n < 1e7:
        pass                                   # X 列为东坐标（含带号）
    elif sample_n > 1e6 and sample_e < 1e7:
        for r in rows:
            r["e"], r["n"] = r["n"], r["e"]
        print("注意：检测到 X/Y 列含义与测量习惯相反，已按数值特征互换")
    else:
        raise SystemExit("无法判定东北坐标列：E=%s N=%s" % (sample_e, sample_n))

    print("带号校验：东坐标前两位 = %d，中央经线 %.0f°E"
          % (int(rows[0]["e"] // 1e6), 3.0 * ZONE))

    # ---------- 坐标换算
    for r in rows:
        if int(r["e"] // 1e6) != ZONE:
            raise SystemExit("%s 东坐标带号 %d 与本项目 %d 带不符"
                             % (r["id"], int(r["e"] // 1e6), ZONE))
        r["lon"], r["lat"] = en_to_lonlat(r["e"], r["n"], zone=ZONE, width=BAND_WIDTH)
        # 往返校验：经纬度正算回平面坐标，残差应 < 1 cm
        e2, n2 = lonlat_to_en(r["lon"], r["lat"], zone=ZONE, width=BAND_WIDTH)
        r["chk"] = math.hypot(e2 - r["e"], n2 - r["n"])
        if r["chk"] > 0.02:
            raise SystemExit("%s 坐标往返残差 %.3f m，超出容差" % (r["id"], r["chk"]))

    # ---------- 原点：机位重心（WGS-84）
    cx = sum(r["e"] for r in rows) / len(rows)
    cn = sum(r["n"] for r in rows) / len(rows)
    lon0, lat0 = en_to_lonlat(cx, cn, zone=ZONE, width=BAND_WIDTH)

    # 平面 -> 局部 ENU 的换算尺度（以原点纬度为基准，3° 带内误差 < 0.1 m/km）
    phi = math.radians(lat0)
    A_AXIS, E2 = 6378137.0, 0.00669437999014
    s = math.sin(phi)
    w = math.sqrt(1 - E2 * s * s)
    k_lon = A_AXIS / w * math.cos(phi) * math.pi / 180.0   # 每度经度对应的米数
    k_lat = A_AXIS * (1 - E2) / (w ** 3) * math.pi / 180.0 # 每度纬度对应的米数

    for r in rows:
        r["x"] = r["e"] - cx                     # 东向偏移 m
        r["y"] = r["n"] - cn                     # 北向偏移 m
        # 交叉校核：由经纬度反推的 ENU 与由平面坐标相减的 ENU 应一致（< 0.5 m）
        r["enu_chk"] = math.hypot((r["lon"] - lon0) * k_lon - r["x"],
                                  (r["lat"] - lat0) * k_lat - r["y"])

    # ---------- 单机容量与派生指标
    caps = [r["net"] * 1000.0 / r["hours"] for r in rows]
    rated_kw = round(sum(caps) / len(caps), 1)
    rated_mw = rated_kw / 1000.0
    spread = max(caps) - min(caps)
    if spread > 1.0:
        print("注意：各机位反算容量不一致，极差 %.1f kW，取均值" % spread)

    turbines = []
    for r in rows:
        gross, net = r["gross"], r["net"]
        turbines.append({
            "id": r["id"],
            "e2000": round(r["e"], 3),
            "n2000": round(r["n"], 3),
            "lon": round(r["lon"], 8),
            "lat": round(r["lat"], 8),
            "x": round(r["x"], 1),
            "y": round(r["y"], 1),
            "ground": round(r["z"], 2),           # 数据表 Z：机位地面高程 m（绝对）
            "hub_h": r["hub"],                    # 轮毂高度（离地）
            "hub_abs": round(r["z"] + r["hub"], 2),
            "v_mean": r["v"],
            "v_wake": r["v_wake"],
            "gross_mwh": round(gross, 2),
            "wake_loss": r["wake"],               # 数据表原值（负值表示损失），单位 %
            "net_mwh": round(net, 2),
            "hours": round(r["hours"], 2),
            "rated_kw": rated_kw,
            "cf": round(r["hours"] / 8760.0, 4),  # 等效小时 / 8760 = 净容量系数
            "reduction": round(1.0 - net / gross, 4),
            "chk_m": round(r["chk"], 4),
        })

    # ---------- 机间距
    pairs = []
    for i in range(len(turbines)):
        for j in range(i + 1, len(turbines)):
            a, b = turbines[i], turbines[j]
            d = math.hypot(b["x"] - a["x"], b["y"] - a["y"])
            pairs.append({
                "a": a["id"], "b": b["id"],
                "dist": round(d, 1),
                "dist_D": round(d / ROTOR_D, 2),
            })
    dmin = min(p["dist"] for p in pairs)
    dmin_pair = min(pairs, key=lambda p: p["dist"])

    # ---------- 场区控制范围：机位凸包外扩 250 m
    hull = convex_hull([(t["x"], t["y"]) for t in turbines])
    ctr = (sum(p[0] for p in hull) / len(hull), sum(p[1] for p in hull) / len(hull))
    boundary = buffer_polygon(hull, ctr, 250.0)
    area_km2 = polygon_area(boundary) / 1e6
    xs = [p[0] for p in boundary]
    ys = [p[1] for p in boundary]

    # ---------- 升压站：置于机位重心，若与最近机位距离不足 320 m 则外移
    st_x, st_y = ctr
    for _ in range(20):
        near = min(turbines, key=lambda t: math.hypot(t["x"] - st_x, t["y"] - st_y))
        d = math.hypot(near["x"] - st_x, near["y"] - st_y)
        if d >= 320.0:
            break
        ux = (st_x - near["x"]) / (d or 1.0)
        uy = (st_y - near["y"]) / (d or 1.0)
        st_x += ux * 40.0
        st_y += uy * 40.0
    st_lon, st_lat = 0.0, 0.0
    st_e = cx + st_x
    st_n = cn + st_y
    st_lon, st_lat = en_to_lonlat(st_e, st_n, zone=ZONE, width=BAND_WIDTH)

    # ---------- 汇总电量
    tot_gross = sum(t["gross_mwh"] for t in turbines)
    tot_net = sum(t["net_mwh"] for t in turbines)
    cap_total = rated_mw * len(turbines)

    site = {
        "project": "内蒙古凉城陆上风电项目",
        "admin": "内蒙古自治区 乌兰察布市 凉城县 六苏木镇",
        "coord_system": "CGCS2000 3°带 第%d带（中央经线 %.0f°E），高斯投影" % (ZONE, 3.0 * ZONE),
        "center_wgs84": {"lat": round(lat0, 8), "lon": round(lon0, 8)},
        "center_gcj02": dict(zip(("lon", "lat"), wgs84_to_gcj02(lon0, lat0))),
        "center_e2000": round(cx, 3),
        "center_n2000": round(cn, 3),
        "origin": {"x_east": round(cx, 3), "n_north": round(cn, 3),
                   "note": "局部 ENU 原点 = 8 台机位重心；x = E − 原点E，y = N − 原点N"},
        "boundary_m": [round(max(xs) - min(xs), 1), round(max(ys) - min(ys), 1)],
        "boundary_polygon": [[round(x, 1), round(y, 1)] for x, y in boundary],
        "area_km2": round(area_km2, 3),
        "turbines": turbines,
        "pairs": pairs,
        "machine": {
            "rated_kw": rated_kw,
            "rated_mw": round(rated_mw, 3),
            "rotor_d": ROTOR_D,
            "rotor_d_override_m": None,
            "rotor_d_note": "按风机参数表更新",
            "hub_h": turbines[0]["hub_h"],
            "count": len(turbines),
        },
        "substation": {
            "x": round(st_x, 1),
            "y": round(st_y, 1),
            "e2000": round(st_e, 3),
            "n2000": round(st_n, 3),
            "lon": round(st_lon, 8),
            "lat": round(st_lat, 8),
            "note": "机位重心附近示意位置，接入系统方案确定后修正",
        },
        "energy": {
            "capacity_mw": round(cap_total, 2),
            "gross_mwh": round(tot_gross, 1),
            "net_mwh": round(tot_net, 1),
            "gross_gwh": round(tot_gross / 1000.0, 1),
            "net_gwh": round(tot_net / 1000.0, 1),
            "hours_net": round(tot_net / cap_total, 1),
            "wake_loss_mean": round(sum(t["wake_loss"] for t in turbines) / len(turbines), 2),
            "reduction_mean": round(1.0 - tot_net / tot_gross, 4),
            "cf_net": round(tot_net / cap_total / 8760.0, 4),
            "v_mean": round(sum(t["v_mean"] for t in turbines) / len(turbines), 2),
            "v_wake_mean": round(sum(t["v_wake"] for t in turbines) / len(turbines), 2),
            "source": "风场数据/风电场.xlsx「风机数据」表",
        },
        "checks": {
            "min_spacing_m": round(dmin, 1),
            "min_spacing_D": round(dmin / ROTOR_D, 2),
            "min_spacing_pair": [dmin_pair["a"], dmin_pair["b"]],
            "coord_roundtrip_max_m": round(max(t["chk_m"] for t in turbines), 4),
        },
    }

    os.makedirs("data", exist_ok=True)
    with atomic_text(OUT_JSON) as f:
        json.dump(site, f, ensure_ascii=False, indent=1)

    # ---------- 控制台核对表
    print("\n%-6s %14s %14s %12s %12s %8s %9s %9s %8s"
          % ("编号", "E(2000)", "N(2000)", "东偏移m", "北偏移m", "地面m", "风速m/s", "尾流m/s", "上网MWh"))
    for t in turbines:
        print("%-6s %14.3f %14.3f %+12.1f %+12.1f %8.2f %9.2f %9.2f %8.0f"
              % (t["id"], t["e2000"], t["n2000"], t["x"], t["y"],
                 t["ground"], t["v_mean"], t["v_wake"], t["net_mwh"]))
    print("\n单机容量 %.1f kW × %d 台 = %.1f MW" % (rated_kw, len(turbines), cap_total))
    print("理论发电量 %.1f MWh  上网电量 %.1f MWh  等效小时 %.1f h  综合折减 %.2f%%"
          % (tot_gross, tot_net, site["energy"]["hours_net"], site["energy"]["reduction_mean"] * 100))
    print("最小间距 %.0f m（%s） = %.2f D" % (dmin, "-".join(site["checks"]["min_spacing_pair"]),
                                          dmin / ROTOR_D))
    print("场区控制范围 %.2f × %.2f km，面积 %.2f km²"
          % (site["boundary_m"][0] / 1000, site["boundary_m"][1] / 1000, area_km2))
    print("坐标往返最大残差 %.4f m" % site["checks"]["coord_roundtrip_max_m"])
    print("已写出 %s" % OUT_JSON)


if __name__ == "__main__":
    main()
