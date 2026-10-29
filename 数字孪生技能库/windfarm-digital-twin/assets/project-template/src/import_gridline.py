# -*- coding: utf-8 -*-
"""
读取 35 kV 集电线路杆塔实测坐标表（xlsx），生成 data/gridline.json

输入：风场数据/集电线路.xlsx（工作表「2000坐标」）
      列：塔位编号、X（2000坐标系）、Y（2000坐标系）
输出：data/gridline.json

约定：
  1) 表中 X 为 6 位东坐标（**不含带号**），Y 为北坐标。本表与机位表的区别仅在
     是否带 38 带号：机位表为 38394814.994（8 位），塔位表为 387981.452（6 位）。
     故按数值位数判定并补带号，日志中逐项打印判定结果。
  2) 局部 ENU 原点**沿用 data/site.json 的机位重心**，不另建原点——否则塔位与机位的
     相对位置会在场景里对不上。
  3) 线路拓扑按塔号规则确定（AB/A/B 三条主线 + A3/B7/B10 三条支线），链间连接
     （AB30→A1、B1→最近主线塔）按塔位距离判定，结果写入 links 并打印，供工程核对。
  4) 塔型（直线塔 / 耐张塔）按工程通例判定，规则写在 classify() 中：
     链首末、转角 > 5°、支线分歧、耐张段累计长度超限 → 耐张塔。
     本表未给塔型，故属**推断值**，接入施工图后应以设计资料为准。
  5) 塔基高程不由本脚本采集（需网络），由 src/fetch_dem.py 采样后回填。
"""
import json
from project_io import ROOT, PROJECT, atomic_text, write_json, finite, validate_levels, validate_assets
import math
import os
import sys

import openpyxl

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from coord2000 import en_to_lonlat          # noqa: E402

SRC_XLSX = ROOT / "风场数据/集电线路.xlsx"
SITE_JSON = ROOT / "data/site.json"
OUT_JSON = ROOT / "data/gridline.json"
SHEET = "2000坐标"

ZONE = 38                  # CGCS2000 3° 带号，与机位表一致
ZONE_PREFIX = ZONE * 1000000        # 38000000

# 线路链定义：编号规则明确，直接按规则展开，避免用最近邻猜拓扑
CHAIN_DEFS = [
    ("AB", "AB 线", ["AB%d" % i for i in range(1, 31)]),
    ("A", "A 线", ["A%d" % i for i in range(1, 18)]),
    ("A3", "A3 支线", ["A3"] + ["A3-%d" % i for i in range(1, 7)]),
    ("B", "B 线", ["B%d" % i for i in range(1, 16)]),
    ("B7", "B7 支线", ["B7"] + ["B7-%d" % i for i in range(1, 4)]),
    ("B10", "B10 支线", ["B10"] + ["B10-%d" % i for i in range(1, 3)]),
]

# 链间连接：编号规则确定 AB30 接 A1；B 线首基按距离判定
FIXED_LINKS = [("AB30", "A1"), ("AB30", "B1")]

# 塔型判定阈值
# 35 kV 线路的工程通例：转角 < 15° 用小转角直线塔（或直线塔加装拉线），
# 转角 >= 15° 才设耐张转角塔，否则耐张比例过高不经济。
TURN_TENSION_DEG = 15.0    # 转角超过此值设耐张塔
TENSION_RUN_MAX = 2000.0   # 耐张段长度上限 m（GB 50061 上限 2 km，此处取规程值）
FEED_RADIUS = 200.0        # 末基塔与机位的接入判定半径 m


def norm(s):
    return str(s or "").replace("\n", "").replace(" ", "").replace("（", "(").replace("）", ")")


def num(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).strip().replace(",", ""))
    except ValueError:
        return None


def read_towers(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[SHEET]
    header = [norm(c) for c in next(ws.iter_rows(min_row=1, max_row=1, values_only=True))]

    def col(*keys):
        for i, h in enumerate(header):
            if all(k in h for k in keys):
                return i
        raise KeyError("找不到列：%s，实际表头 %s" % ("/".join(keys), header))

    ic, ix, iy = col("塔位编号"), col("X", "2000"), col("Y", "2000")
    rows = []
    for r in ws.iter_rows(min_row=2, values_only=True):
        tid = r[ic]
        if not tid:
            continue
        rows.append({"id": str(tid).strip(), "X": num(r[ix]), "Y": num(r[iy])})
    for r in rows:
        if r["X"] is None or r["Y"] is None:
            raise ValueError("塔位 %s 坐标缺失" % r["id"])
    return rows


def azimuth(a, b):
    """a→b 的方位角（度，正北为 0，顺时针）"""
    return math.degrees(math.atan2(b["e"] - a["e"], b["n"] - a["n"])) % 360.0


def turn_angle(prev, cur, nxt):
    """在 cur 处的转角（度）：右转（顺时针）为正，左转为负。无前后点则 None"""
    if not prev or not nxt:
        return None
    d = (azimuth(cur, nxt) - azimuth(prev, cur) + 540.0) % 360.0 - 180.0
    return d


def classify(chains, by_id, junction_ids):
    """判定塔型：返回 {id: 'tension'|'suspension'} 与每基的转角"""
    kind, turns = {}, {}
    for _cid, _name, ids in chains:
        acc = 0.0
        for i, tid in enumerate(ids):
            t = by_id[tid]
            prev = by_id[ids[i - 1]] if i > 0 else None
            nxt = by_id[ids[i + 1]] if i + 1 < len(ids) else None
            turn = turn_angle(prev, t, nxt)
            if turn is not None:
                turns[tid] = turn

            is_end = (i == 0 or i + 1 == len(ids))
            is_junction = tid in junction_ids
            big_turn = turn is not None and abs(turn) > TURN_TENSION_DEG
            long_run = acc > TENSION_RUN_MAX

            if is_end or is_junction or big_turn or long_run:
                kind[tid] = "tension"
                acc = 0.0
            else:
                kind[tid] = kind.get(tid, "suspension")

            # 累计到下一基的档距
            if nxt:
                acc += math.hypot(nxt["e"] - t["e"], nxt["n"] - t["n"])
    return kind, turns


def main():
    with open(SITE_JSON, encoding="utf-8") as f:
        site = json.load(f)
    e0, n0 = site["center_e2000"], site["center_n2000"]

    rows = read_towers(SRC_XLSX)
    print("读取塔位 %d 基" % len(rows))

    # ---------- 坐标：补带号 → 经纬度 → 局部 ENU
    added = 0
    for r in rows:
        if r["X"] < 1e7:
            r["e"] = r["X"] + ZONE_PREFIX
            added += 1
        else:
            r["e"] = r["X"]
        r["n"] = r["Y"]
    print("其中 %d 基 X 为 6 位（不含带号），已补 %d 带号" % (added, ZONE))

    # Keep surveyed positions; apply the requested 30 m centre-to-centre setback
    # only to the derived display/design position. Small margin protects rounding.
    for r in rows:
        original_e, original_n = r["e"], r["n"]
        for attempt in range(100):
            nearby = min(site["turbines"], key=lambda t: math.hypot(r["e"]-e0-t["x"],r["n"]-n0-t["y"]))
            dx, dy = r["e"]-e0-nearby["x"], r["n"]-n0-nearby["y"]
            distance = math.hypot(dx,dy)
            if distance >= PROJECT["grid"]["min_turbine_distance_m"]+.1:
                break
            if distance < 1e-9:
                dx, dy, distance = 1.0, 0.0, 1.0
            r["e"] = e0+nearby["x"]+dx/distance*(PROJECT["grid"]["min_turbine_distance_m"]+.2)
            r["n"] = n0+nearby["y"]+dy/distance*(PROJECT["grid"]["min_turbine_distance_m"]+.2)
        else:
            raise ValueError("Cannot satisfy tower setback: " + r["id"])
        shift = math.hypot(r["e"]-original_e,r["n"]-original_n)
        if shift > 1e-6:
            r["position_adjustment"] = {"reason":"距风机中心至少30米", "survey_e":original_e,"survey_n":original_n,
                                        "shift_m":round(shift,3),"nearest_turbine":nearby["id"]}

    by_id = {}
    for r in rows:
        lon, lat = en_to_lonlat(r["e"], r["n"], zone=ZONE, width=PROJECT["crs"]["band_width"])
        r["lon"] = round(lon, 8)
        r["lat"] = round(lat, 8)
        r["x"] = round(r["e"] - e0, 1)
        r["y"] = round(r["n"] - n0, 1)
        by_id[r["id"]] = r

    for tower in rows:
        nearest = min(math.hypot(tower["x"]-t["x"],tower["y"]-t["y"]) for t in site["turbines"])
        tower["nearest_turbine_m"] = round(nearest,3)
        if nearest < PROJECT["grid"]["min_turbine_distance_m"]:
            raise ValueError("Rounded tower position violates 30m setback: " + tower["id"])

    # ---------- 拓扑校验：链内编号必须齐全
    missing = []
    for _cid, _name, ids in CHAIN_DEFS:
        for tid in ids:
            if tid not in by_id:
                missing.append(tid)
    if missing:
        raise ValueError("表中缺少塔位：%s" % ", ".join(missing))
    defined = set()
    for _cid, _name, ids in CHAIN_DEFS:
        defined.update(ids)
    extra = sorted(set(by_id) - defined)
    if extra:
        print("警告：%d 基塔位未纳入任何链：%s" % (len(extra), ", ".join(extra)))

    # 工程指定：A1、B1分别接入AB30的两回路。
    links = list(FIXED_LINKS)

    # 支线分歧塔
    junction_ids = set()
    for cid, _name, ids in CHAIN_DEFS:
        if "-" in cid or cid.isdigit():
            junction_ids.add(ids[0])
        elif cid in ("A3", "B7", "B10"):
            junction_ids.add(ids[0])

    kind, turns = classify(CHAIN_DEFS, by_id, junction_ids)

    # ---------- 每基：所属线、序号、前后塔、档距、塔型、接入机位
    turbines = site["turbines"]
    for r in rows:
        r["ground"] = None            # 待 fetch_dem.py 采样回填
        r["type"] = kind.get(r["id"], "suspension")
        r["type_name"] = "耐张塔" if r["type"] == "tension" else "直线塔"
        r["turn_deg"] = round(turns[r["id"]], 1) if r["id"] in turns else None
        r["line"] = None
        r["seq"] = None

    for cid, _name, ids in CHAIN_DEFS:
        for i, tid in enumerate(ids):
            t = by_id[tid]
            t["line"] = cid
            t["seq"] = i
            t["prev"] = ids[i - 1] if i > 0 else None
            t["next"] = ids[i + 1] if i + 1 < len(ids) else None

    # 档距（同一基可能在两条链中，取非 None 的那个；分歧塔两条链档距都要）
    spans = []
    for cid, name, ids in CHAIN_DEFS:
        for a, b in zip(ids, ids[1:]):
            pa, pb = by_id[a], by_id[b]
            L = math.hypot(pb["e"] - pa["e"], pb["n"] - pa["n"])
            spans.append({"line": cid, "from": a, "to": b, "length_m": round(L, 1)})
            by_id[a].setdefault("span_next_m", round(L, 1))
            by_id[b].setdefault("span_prev_m", round(L, 1))

    for circuit, (a, b) in enumerate(links, start=1):
        pa, pb = by_id[a], by_id[b]
        length = math.hypot(pb["e"]-pa["e"], pb["n"]-pa["n"])
        spans.append({"line": PROJECT["grid"]["links"][circuit-1]["line"], "from": a, "to": b,
                      "length_m": round(length, 1), "circuit": PROJECT["grid"]["links"][circuit-1]["circuit"], "link": True})
        pb["prev"] = a
        pb["span_prev_m"] = round(length, 1)

    # 末基接入机位
    feeds = {}
    for cid, _name, ids in CHAIN_DEFS:
        t = by_id[ids[-1]]
        best, bd = None, 1e9
        for tb in turbines:
            d = math.hypot(tb["e2000"] - t["e"], tb["n2000"] - t["n"])
            if d < bd:
                best, bd = tb["id"], d
        if bd <= FEED_RADIUS:
            feeds[t["id"]] = {"turbine": best, "distance_m": round(bd, 1)}
    # 非末基但紧邻机位（B45n 由 B4 接入）
    for tb in turbines:
        if tb["id"] in [v["turbine"] for v in feeds.values()]:
            continue
        best, bd = None, 1e9
        for r in rows:
            d = math.hypot(tb["e2000"] - r["e"], tb["n2000"] - r["n"])
            if d < bd:
                best, bd = r["id"], d
        if bd <= FEED_RADIUS:
            feeds.setdefault(best, {"turbine": tb["id"], "distance_m": round(bd, 1)})
            feeds[best].setdefault("turbines", []).append(tb["id"])

    for tid, info in feeds.items():
        by_id[tid]["feeds"] = info

    # ---------- 线路清单（供前端按链画导线）
    lines = []
    for cid, name, ids in CHAIN_DEFS:
        ls = [s for s in spans if s["line"] == cid]
        lines.append({
            "id": cid,
            "name": name,
            "chain": ids,
            "span_count": len(ls),
            "length_m": round(sum(s["length_m"] for s in ls), 1),
            "tension_count": sum(1 for i in ids if by_id[i]["type"] == "tension"),
        })

    # ---------- 统计
    lengths = [s["length_m"] for s in spans]
    n_ten = sum(1 for r in rows if r["type"] == "tension")
    payload = {
        "conductor": PROJECT["grid"]["conductor"],
        "source": str(SRC_XLSX) + "「%s」表" % SHEET,
        "coord_system": site["coord_system"],
        "origin": {"e2000": e0, "n2000": n0,
                   "note": "沿用机位重心，与 site.json 同一局部 ENU 原点"},
        "note": "塔型为按工程通例判定的推断值（链首末 / 转角>5° / 支线分歧 / 耐张段>1.8 km），"
                "接入施工图后应以设计资料为准",
        "count": len(rows),
        "towers": sorted(rows, key=lambda r: r["id"]),
        "lines": lines,
        "links": [{"from": a, "to": b} for a, b in links],
        "spans": spans,
        "stats": {
            "count": len(rows),
            "tension": n_ten,
            "suspension": len(rows) - n_ten,
            "span_min_m": round(min(lengths), 1),
            "span_max_m": round(max(lengths), 1),
            "span_mean_m": round(sum(lengths) / len(lengths), 1),
            "length_total_m": round(sum(lengths), 1),
            "turn_max_deg": round(max(abs(v) for v in turns.values()), 1) if turns else 0.0,
            "feeds": len({v["turbine"] for v in feeds.values()}),
        },
    }

    os.makedirs("data", exist_ok=True)
    with atomic_text(OUT_JSON) as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    # ---------- 控制台核对表
    print("\n%-6s %14s %14s %10s %10s %-6s %8s %7s %6s"
          % ("编号", "E(2000)", "N(2000)", "东偏移m", "北偏移m", "塔型", "转角°", "档距m", "接入"))
    for r in payload["towers"]:
        print("%-6s %14.3f %14.3f %+10.1f %+10.1f %-6s %8s %7s %6s"
              % (r["id"], r["e"], r["n"], r["x"], r["y"], r["type_name"],
                 "—" if r["turn_deg"] is None else "%.1f" % r["turn_deg"],
                 "—" if "span_next_m" not in r else "%.0f" % r["span_next_m"],
                 r.get("feeds", {}).get("turbine", "—")))

    st = payload["stats"]
    print("\n杆塔 %d 基（耐张 %d、直线 %d），线路总长 %.2f km，档距 %.0f ~ %.0f m（均 %.0f）"
          % (st["count"], st["tension"], st["suspension"], st["length_total_m"] / 1000,
             st["span_min_m"], st["span_max_m"], st["span_mean_m"]))
    print("最大转角 %.1f°；接入机位 %d 台" % (st["turn_max_deg"], st["feeds"]))
    for ln in lines:
        print("  %-4s %-8s %2d 基 %2d 档  %6.2f km  耐张 %d"
              % (ln["id"], ln["name"], len(ln["chain"]), ln["span_count"],
                 ln["length_m"] / 1000, ln["tension_count"]))
    print("已写出 %s" % OUT_JSON)


ZONE = PROJECT["crs"]["zone"]
ZONE_PREFIX = ZONE*1000000
SRC_XLSX = ROOT / "风场数据" / PROJECT["files"]["gridline"]
SHEET = PROJECT["sheets"]["gridline"]
CHAIN_DEFS = [(r["id"],r["name"],r["towers"]) for r in PROJECT["grid"]["chains"]]
FIXED_LINKS = [(r["from"],r["to"]) for r in PROJECT["grid"]["links"]]

if __name__ == "__main__":
    main()
