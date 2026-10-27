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
import math
import os
import time
import urllib.parse
import urllib.request

SITE_JSON = "data/site.json"
OUT_JSON = "data/dem.json"
CACHE = "data/dem_cache.json"

M_PER_DEG_LAT = 111033.0
API = "https://api.opentopodata.org/v1/aster30m?locations="
BATCH = 100
PAUSE = 1.1

# 三级网格：(名称, 半边长 m, 步长 m)
LEVELS = [
    ("L0", 14000.0, 1750.0),
    ("L1", 6000.0, 300.0),
    ("L2", 2400.0, 40.0),
]


def build_axis(half, step):
    n = int(round(2 * half / step)) + 1
    return [-half + i * step for i in range(n)], n


def fetch(points):
    """points: [(lat, lon)] -> [elev]；失败重试 4 次，逐批校验返回条数"""
    out = []
    for i in range(0, len(points), BATCH):
        chunk = points[i:i + BATCH]
        q = "|".join("%.7f,%.7f" % (la, lo) for la, lo in chunk)
        url = API + urllib.parse.quote(q, safe="|,")
        ok = False
        for attempt in range(4):
            try:
                with urllib.request.urlopen(url, timeout=90) as resp:
                    data = json.load(resp)
                if data.get("status") == "OK" and len(data["results"]) == len(chunk):
                    out.extend([r["elevation"] for r in data["results"]])
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
        if (i // BATCH) % 20 == 0:
            print("    %d / %d 点" % (min(i + BATCH, len(points)), len(points)))
        time.sleep(PAUSE)
    return out


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
        elev = fetch(pts)
        if any(v is None for v in elev):
            raise RuntimeError("%s 存在空值，终止" % name)
        rows = []
        for j in range(n - 1, -1, -1):                  # 转 north-first 行序
            rows.append([round(elev[j * n + i]) for i in range(n)])

        result["levels"][name] = {"half": half, "step": step, "n": n, "rows": rows}
        cache[name] = {"half": half, "step": step, "n": n, "rows": rows,
                       "lat0": lat0, "lon0": lon0}
        with open(CACHE, "w", encoding="utf-8") as f:
            json.dump(cache, f, separators=(",", ":"))
        print("  高程 %.0f ~ %.0f m，均值 %.0f m" % (min(elev), max(elev), sum(elev) / len(elev)))

    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
    print("已写出 %s（%.1f KB）" % (OUT_JSON, os.path.getsize(OUT_JSON) / 1024))


if __name__ == "__main__":
    main()
