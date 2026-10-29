# -*- coding: utf-8 -*-
"""
采集场址分级 DEM 高程网格（数据源：ASTER GDEM 30m，经 opentopodata.org 公开 API）
输入：data/site.json（读取机位重心作为网格原点，保证三级网格与场区同心）
输出：data/dem.json

坐标系：WGS-84 经纬度；网格为等间距米制网格（原点为机位重心，x 向东、y 向北）
分级思路：
  L0 覆盖 ±14 km，用于远场山形过渡；
  L1 覆盖 ±6 km，用于场区外围台地；
  L2 覆盖 ±2.4 km，40 m 步长，用于机位周边精细地形。

为避免网络中断丢工，每采完一级即写 data/dem_cache.json；重复运行自动续采。
"""
import json
from project_io import ROOT, PROJECT, atomic_text, write_json, finite, validate_levels, validate_assets
import math
import os
import time
import urllib.parse
import urllib.request

SITE_JSON = ROOT / "data/site.json"
GRID_JSON = ROOT / "data/gridline.json"
OUT_JSON = ROOT / "data/dem.json"
CACHE = ROOT / "data/dem_cache.json"
POINT_CACHE = ROOT / "data/dem_points_cache.json"

M_PER_DEG_LAT = 111033.0
API = "https://api.opentopodata.org/v1/aster30m?locations="
BATCH = 100
PAUSE = 1.1

# 三级网格：(名称, 半边长 m, 步长 m)
# L1 的半边长由 6000 扩到 12000：集电线路最远塔位距原点 8.3 km，
# 原先该处只剩 L0（1750 m 步长）可用，塔基高程与 ASTER 点采样最大差达 50 m；
# 扩到 12000 m 后 8.3 km 处 L1 权重为 1，塔基高程回到 300 m 网格精度。
LEVELS = [
    ("L0", 14000.0, 1750.0),
    ("L1", 12000.0, 300.0),
    ("L2", 2400.0, 40.0),
]


def build_axis(half, step):
    n = int(round(2 * half / step)) + 1
    return [-half + i * step for i in range(n)], n


def fetch(points, checkpoint=None):
    """points: [(lat, lon)] -> [elev]；失败重试 4 次，逐批校验返回条数"""
    saved = {}
    if checkpoint and checkpoint.exists():
        saved = json.loads(checkpoint.read_text(encoding="utf-8"))
    signature = {"api": API, "points": points}
    out = saved.get("values", []) if saved.get("signature") == json.loads(json.dumps(signature)) else []
    if len(out) > len(points) or not all(finite(v) for v in out):
        out = []
    for i in range(len(out), len(points), BATCH):
        chunk = points[i:i + BATCH]
        q = "|".join("%.7f,%.7f" % (la, lo) for la, lo in chunk)
        url = API + urllib.parse.quote(q, safe="|,")
        ok = False
        for attempt in range(4):
            try:
                with urllib.request.urlopen(url, timeout=90) as resp:
                    data = json.load(resp)
                if data.get("status") == "OK" and len(data["results"]) == len(chunk):
                    values = [r["elevation"] for r in data["results"]]
                    if not all(finite(v) for v in values):
                        raise ValueError("高程包含空值或非有限数值")
                    for expected, row in zip(chunk, data["results"]):
                        loc = row["location"]
                        if abs(loc["lat"] - expected[0]) > 1e-5 or abs(loc["lng"] - expected[1]) > 1e-5:
                            raise ValueError("响应坐标与请求不一致")
                    out.extend(values)
                    ok = True
                    break
                raise RuntimeError("status=%s n=%d/%d"
                                   % (data.get("status"), len(data.get("results", [])), len(chunk)))
            except Exception as exc:
                if attempt == 3:
                    raise RuntimeError("第 %d 批采集失败：%s" % (i // BATCH, exc))
                print("  重试 %d/%d：%s" % (attempt + 1, 4, exc))
                time.sleep(3 + attempt * 4)
        if not ok:
            raise RuntimeError("第 %d 批采集失败" % (i // BATCH))
        if checkpoint:
            write_json(checkpoint, {"signature": signature, "values": out})
        if (i // BATCH) % 20 == 0:
            print("    %d / %d 点" % (min(i + BATCH, len(points)), len(points)))
        time.sleep(PAUSE)
    return out


def fetch_tower_ground(result):
    """
    采集集电线路杆塔塔位高程（ASTER 30 m 点采样），写入 result["towerGround"]。

    为什么要单独采点：分级网格最粗一级 L0 步长 1750 m，而最远塔位距原点 8.3 km，
    该处网格插值误差可达数十米。故对每基塔单独取源数据点值，作为**塔基高程校核值**；
    而场景内塔基仍取分级网格高度（heightAt），以保证塔基与地形面严格贴合、不悬空。
    两者差值写入 site-data.js，界面并列显示。
    """
    if not os.path.exists(GRID_JSON):
        print("未发现 %s，跳过杆塔高程采样" % GRID_JSON)
        return
    with open(GRID_JSON, encoding="utf-8") as f:
        grid = json.load(f)

    cache = {}
    if os.path.exists(POINT_CACHE):
        with open(POINT_CACHE, encoding="utf-8") as f:
            cache = json.load(f)

    need = []
    for t in grid["towers"]:
        sig = "%.7f,%.7f" % (t["lat"], t["lon"])
        old = cache.get(t["id"])
        if old and old.get("sig") == sig and finite(old.get("elev")):
            continue
        need.append((t["id"], sig, t["lat"], t["lon"]))

    if need:
        print("杆塔塔位高程：需采 %d 基（其余复用缓存）" % len(need))
        elev = fetch([(la, lo) for _tid, _sig, la, lo in need], ROOT / "data/dem_tower_progress.json")
        for (tid, sig, _la, _lo), h in zip(need, elev):
            cache[tid] = {"sig": sig, "elev": h}
        with atomic_text(POINT_CACHE) as f:
            json.dump(cache, f, separators=(",", ":"))
    else:
        print("杆塔塔位高程：%d 基全部复用缓存" % len(grid["towers"]))

    result["towerGround"] = {t["id"]: cache[t["id"]]["elev"]
                             for t in grid["towers"] if t["id"] in cache}
    vals = list(result["towerGround"].values())
    if vals:
        print("  塔位高程 %.0f ~ %.0f m，均值 %.0f m（%d 基）"
              % (min(vals), max(vals), sum(vals) / len(vals), len(vals)))


def main():
    with open(SITE_JSON, encoding="utf-8") as f:
        site = json.load(f)
    lat0 = site["center_wgs84"]["lat"]
    lon0 = site["center_wgs84"]["lon"]
    m_per_deg_lon = 111320.0 * math.cos(math.radians(lat0))

    result = {
        "center": {"lat": lat0, "lon": lon0},
        "center_gcj02": site["center_gcj02"],
        "source": "ASTER GDEM v3 (30m), opentopodata.org",
        "levels": {},
    }

    cache = {}
    if os.path.exists(CACHE):
        with open(CACHE, encoding="utf-8") as f:
            cache = json.load(f)
        print("发现缓存，已采级别：%s" % ", ".join(sorted(cache)))

    for name, half, step in LEVELS:
        if name in cache and cache[name].get("half") == half and cache[name].get("step") == step \
                and cache[name].get("lat0") == lat0 and cache[name].get("lon0") == lon0:
            result["levels"][name] = {k: cache[name][k] for k in ("half", "step", "n", "rows")}
            print("%s 复用缓存（%d × %d）" % (name, cache[name]["n"], cache[name]["n"]))
            continue

        xs, n = build_axis(half, step)
        pts = [(lat0 + y / M_PER_DEG_LAT, lon0 + x / m_per_deg_lon)
               for y in xs for x in xs]                 # 行优先：第 0 行为最南
        print("%s: %d × %d = %d 点，步长 %.0f m" % (name, n, n, len(pts), step))
        elev = fetch(pts, ROOT / f"data/dem_{name}_progress.json")
        if any(v is None for v in elev):
            raise RuntimeError("%s 存在空值，终止" % name)
        rows = []
        for j in range(n - 1, -1, -1):                  # 转 north-first 行序
            rows.append([round(elev[j * n + i]) for i in range(n)])

        result["levels"][name] = {"half": half, "step": step, "n": n, "rows": rows}
        cache[name] = {"half": half, "step": step, "n": n, "rows": rows,
                       "lat0": lat0, "lon0": lon0}
        with atomic_text(CACHE) as f:
            json.dump(cache, f, separators=(",", ":"))
        print("  高程 %.0f ~ %.0f m，均值 %.0f m" % (min(elev), max(elev), sum(elev) / len(elev)))

    # 杆塔塔位高程（若已有集电线路数据）
    fetch_tower_ground(result)

    with atomic_text(OUT_JSON) as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
    print("已写出 %s（%.1f KB）" % (OUT_JSON, os.path.getsize(OUT_JSON) / 1024))


if __name__ == "__main__":
    main()
