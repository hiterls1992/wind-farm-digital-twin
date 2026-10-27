# -*- coding: utf-8 -*-
"""
【已停用，仅作方案对比保留】
机位改为实测数据（风场数据/风电场.xlsx）后，本脚本不再参与数据流水线。
现行流水线：import_windfarm.py -> fetch_dem.py -> build_js_data.py
若需重新比较"模板法自动布置"与"实测机位"的差异，可单独运行本脚本，但
输出会覆盖 data/site.json，运行前请先备份。

------------------------------------------------------------------
基于实测 DEM 的风机机位初选（模板布置 + 局部坡度优化）
约束：场区内退让 150 m、机间距 >= 660 m（3D）、地面坡度尽量小
输出：data/site.json
"""
import json
import math

A_AXIS = 6378137.0
E2 = 0.00669437999014
D_TURBINE = 220.0
HUB_H = 140.0
RATED_KW = 10000.0
N_TURBINE = 5
SITE_HALF = 1000.0
SETBACK = 150.0
MIN_SPACING = 660.0       # 3.0 D
WIND_DIR_FROM = 315.0     # 主导风向来向（NW）

# 模板：两排错位布置。a = 沿主风向坐标（SE 为正），b = 横风向坐标（NE 为正）
TEMPLATE = [
    (-430.0, -680.0), (-430.0, 0.0), (-430.0, 680.0),   # 上风向排 3 台
    (430.0, -340.0), (430.0, 340.0),                     # 下风向排 2 台（错开半间距）
]


def load():
    with open("data/dem.json", encoding="utf-8") as f:
        return json.load(f)


def bilinear(level, x, y):
    n, step, half, rows = level["n"], level["step"], level["half"], level["rows"]
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


def slope_at(level, x, y, d=40.0):
    dzdx = (bilinear(level, x + d, y) - bilinear(level, x - d, y)) / (2 * d)
    dzdy = (bilinear(level, x, y + d) - bilinear(level, x, y - d)) / (2 * d)
    return math.degrees(math.atan(math.hypot(dzdx, dzdy)))


def ab_to_xy(a, b):
    """沿风向/横风向坐标 -> 局部 ENU（x 东, y 北）"""
    ux, uy = math.sin(math.radians(WIND_DIR_FROM + 180)), math.cos(math.radians(WIND_DIR_FROM + 180))
    vx, vy = uy, -ux          # 横风向（顺时针 90°）
    return a * ux + b * vx, a * uy + b * vy


def xy_to_ab(x, y):
    ux, uy = math.sin(math.radians(WIND_DIR_FROM + 180)), math.cos(math.radians(WIND_DIR_FROM + 180))
    vx, vy = uy, -ux
    return x * ux + y * uy, x * vx + y * vy


def enu_to_wgs84(lat0, lon0, x, y):
    phi = math.radians(lat0)
    s = math.sin(phi)
    w = math.sqrt(1 - E2 * s * s)
    M = A_AXIS * (1 - E2) / (w ** 3)
    N = A_AXIS / w
    return lat0 + math.degrees(y / M), lon0 + math.degrees(x / (N * math.cos(phi)))


def power_curve(v):
    """气动功率曲线（MW）：P = 1/2 rho A Cp v^3，达到额定后恒功率
    rho=1.05 kg/m3（海拔 1560 m），A=38013 m2（D=220 m），Cp=0.45（含传动与发电损失后的等效值）
    解得额定风速约 10.2 m/s，与 263 W/m2 的低比功率机型相符
    """
    if v < 3.0 or v >= 25.0:
        return 0.0
    p = 0.5 * 1.05 * 38013.0 * 0.45 * v ** 3 / 1e6
    return min(p, RATED_KW / 1000.0)


def weibull_cf(v_mean=7.2, k=2.0, dv=0.05):
    A = v_mean / math.gamma(1 + 1 / k)
    cf, v = 0.0, 0.0
    while v < 30.0:
        f = (k / A) * (v / A) ** (k - 1) * math.exp(-(v / A) ** k)
        cf += f * power_curve(v) / (RATED_KW / 1000.0) * dv
        v += dv
    return cf


def main():
    dem = load()
    l2 = dem["levels"]["L2"]
    lat0, lon0 = dem["center"]["lat"], dem["center"]["lon"]

    # 初值：模板 -> ENU
    pts = [list(ab_to_xy(a, b)) for a, b in TEMPLATE]
    lim = SITE_HALF - SETBACK

    def min_dist(i, pts):
        return min((math.hypot(pts[i][0] - p[0], pts[i][1] - p[1]) for j, p in enumerate(pts) if j != i),
                   default=1e9)

    # 坐标下降：每台在 ±50 m 邻域内找坡度最小且满足间距约束的位置，
    # 并对偏离模板的距离加权惩罚，避免机位被推散、保持成排布置
    for _ in range(3):
        for i in range(len(pts)):
            base = list(pts[i])
            best = None
            for dx in range(-50, 51, 10):
                for dy in range(-50, 51, 10):
                    x, y = base[0] + dx, base[1] + dy
                    if abs(x) > lim or abs(y) > lim:
                        continue
                    pts[i] = [x, y]
                    if min_dist(i, pts) < MIN_SPACING:
                        continue
                    s = slope_at(l2, x, y) + 0.06 * math.hypot(dx, dy)
                    if best is None or s < best[0]:
                        best = (s, x, y)
            pts[i] = [best[1], best[2]] if best else base

    pts.sort(key=lambda p: (-p[1], p[0]))

    turbines = []
    for i, (x, y) in enumerate(pts):
        lat, lon = enu_to_wgs84(lat0, lon0, x, y)
        h = bilinear(l2, x, y)
        turbines.append({
            "id": "WT%02d" % (i + 1),
            "x": round(x, 1), "y": round(y, 1),
            "lat": round(lat, 8), "lon": round(lon, 8),
            "ground": round(h, 1),
            "slope": round(slope_at(l2, x, y), 1),
            "hub_abs": round(h + HUB_H, 1),
        })

    def uvec():
        return math.sin(math.radians(WIND_DIR_FROM + 180)), math.cos(math.radians(WIND_DIR_FROM + 180))

    pairs = []
    for i in range(len(turbines)):
        for j in range(i + 1, len(turbines)):
            a, b = turbines[i], turbines[j]
            dx, dy = b["x"] - a["x"], b["y"] - a["y"]
            d = math.hypot(dx, dy)
            ux, uy = uvec()
            along = abs(dx * ux + dy * uy)
            cross = abs(dx * uy - dy * ux)
            pairs.append({
                "a": a["id"], "b": b["id"],
                "dist": round(d), "dist_D": round(d / D_TURBINE, 2),
                "along_D": round(along / D_TURBINE, 2),
                "cross_D": round(cross / D_TURBINE, 2),
            })

    sub = [bilinear(l2, xx, yy) for xx in range(-1000, 1001, 50) for yy in range(-1000, 1001, 50)]
    slopes = [slope_at(l2, xx, yy) for xx in range(-1000, 1001, 50) for yy in range(-1000, 1001, 50)]

    cf = weibull_cf()
    wake = 0.12          # 2x2 km 内 5 x 10MW 的密度下，尾流损失按 12% 计
    avail, curtail = 0.97, 0.03
    net_cf = cf * (1 - wake) * avail * (1 - curtail)
    annual_mwh = N_TURBINE * RATED_KW * 8760 * net_cf / 1000.0

    # 升压站：场区西侧靠边界、坡度平缓处
    best_st = None
    for xi in range(int(-lim), int(-lim) + 200, 10):
        x = float(xi)
        for yi in range(-300, 301, 10):
            y = float(yi)
            s = slope_at(l2, x, y)
            if best_st is None or s < best_st[0]:
                best_st = (s, x, y)
    st_x, st_y = best_st[1], best_st[2]
    st_lat, st_lon = enu_to_wgs84(lat0, lon0, st_x, st_y)

    site = {
        "center_wgs84": dem["center"],
        "center_gcj02": dem["center_gcj02"],
        "admin": "内蒙古自治区 乌兰察布市 凉城县 六苏木镇",
        "boundary_m": [SITE_HALF * 2, SITE_HALF * 2],
        "terrain": {
            "min": round(min(sub)), "max": round(max(sub)),
            "mean": round(sum(sub) / len(sub)),
            "relief": round(max(sub) - min(sub)),
            "mean_slope": round(sum(slopes) / len(slopes), 1),
            "max_slope": round(max(slopes), 1),
        },
        "turbines": turbines,
        "pairs": pairs,
        "substation": {
            "x": round(st_x, 1), "y": round(st_y, 1),
            "lat": round(st_lat, 8), "lon": round(st_lon, 8),
            "ground": round(bilinear(l2, st_x, st_y), 1),
            "slope": round(best_st[0], 1),
        },
        "energy": {
            "v_mean_hub": 7.2, "weibull_k": 2.0, "air_density": 1.05,
            "rotor_d": D_TURBINE, "swept_area": round(math.pi * (D_TURBINE / 2) ** 2),
            "specific_power": round(RATED_KW * 1000 / (math.pi * (D_TURBINE / 2) ** 2)),
            "v_rated": round((RATED_KW * 1000 / (0.5 * 1.05 * math.pi * (D_TURBINE / 2) ** 2 * 0.47)) ** (1 / 3), 2),
            "cf_gross": round(cf, 4),
            "wake_loss": wake, "availability": avail, "curtailment": curtail,
            "cf_net": round(net_cf, 4),
            "hours_net": round(net_cf * 8760),
            "annual_mwh": round(annual_mwh, 1),
            "annual_gwh": round(annual_mwh / 1000.0, 1),
        },
    }
    with open("data/site.json", "w", encoding="utf-8") as f:
        json.dump(site, f, ensure_ascii=False, indent=1)

    print("场区地形 %(min)s~%(max)s m  起伏 %(relief)s m  平均坡度 %(mean_slope)s  最大 %(max_slope)s" % site["terrain"])
    for t in turbines:
        print("  %s x=%+7.1f y=%+7.1f 地面%7.1f 坡度%5.1f  轮毂绝对%7.1f  %.7f,%.7f"
              % (t["id"], t["x"], t["y"], t["ground"], t["slope"], t["hub_abs"], t["lat"], t["lon"]))
    print(" 最小机间距 %.0f m (%.2fD)" % (min(p["dist"] for p in pairs), min(p["dist_D"] for p in pairs)))
    print(" 升压站 x=%+.0f y=%+.0f 地面 %.0f m 坡度 %.1f°" % (st_x, st_y, site["substation"]["ground"], best_st[0]))
    print(" CF毛 %.3f -> 净 %.3f, 年利用 %d h, 年发电量 %.1f GWh"
          % (cf, net_cf, site["energy"]["hours_net"], annual_mwh / 1000.0))


if __name__ == "__main__":
    main()
