# -*- coding: utf-8 -*-
"""
生成 35 kV 集电线路铁塔的 glTF 二进制模型（.glb），并输出塔型参数表

输出：
  libs/models/tower_susp.glb     直线塔
  libs/models/tower_tens.glb     耐张塔
  data/tower-types.json          塔型几何参数（前端据此算导线挂点，保证与模型一致）

为什么用 glTF 而不是用 Entity 拼装：
  73 基杆塔若每基用 5～8 个 Entity（塔身/横担/基础/绝缘子），总量超过 400 个实体，
  且 Cesium 的 Entity 几何没有统一 scale，调放大倍率必须整批重建。
  改为单文件 glTF 后：每基 1 个 Entity，倍率直接改 ModelGraphics.scale，不重建。

塔型依据：
  《国家电网公司输变电工程通用设计 35kV 输电线路分册》典型单回路塔型，
  取常用呼高与根开作为几何参数。**本表数据未给出塔型，下列尺寸为典型值**，
  接入施工图后应按实际塔型替换 TYPES 中的数值并重新生成本文件。

局部坐标（模型空间，单位 m）：
  原点 = 塔基中心地面；x = 横担方向（垂直线路）；y = 线路方向；z = 向上。
  前端按线路切线方位角绕 z 轴旋转后放置，故模型自身不需知道线路走向。
"""
import json
from project_io import ROOT, atomic_text, write_json, finite, validate_levels, validate_assets
import math
import os
import struct

OUT_DIR = ROOT / "libs/models"
OUT_JSON = ROOT / "data/tower-types.json"

# ---------------------------------------------------------------------------
# 塔型参数（典型值，非本工程实测）
#   h_body   塔身顶标高（地线支架底）
#   h_total  全高
#   b_bot    根开：基础中心正方形边长
#   b_top    塔口：塔身顶部正方形边长
#   bays     横隔与斜材的分段标高
#   arms     横担：[{z 挂点标高, arm 单侧臂长, gw 是否地线支架}]
#   ins      绝缘子串长度（直线塔悬垂串竖直，耐张塔耐张串水平）
# ---------------------------------------------------------------------------
TYPES = {
    "suspension": {
        "id": "suspension",
        "name": "35 kV 单回路直线塔",
        "note": "典型值，参照国网 35kV 通用设计单回路直线塔",
        "h_body": 19.0,
        "h_total": 20.9,
        "b_bot": 4.0,
        "b_top": 1.2,
        "bays": [4.5, 9.0, 13.5, 17.5],
        "arms": [
            {"z": 12.0, "arm": 3.2, "role": "side"},
            {"z": 15.2, "arm": 1.3, "role": "mid"},
            {"z": 19.0, "arm": 1.5, "role": "gw", "rise": 1.9},
        ],
        "ins": 1.0,
        "base_size": 2.0,
        "base_h": 0.5,
    },
    "tension": {
        "id": "tension",
        "name": "35 kV 单回路耐张塔",
        "note": "典型值，参照国网 35kV 通用设计单回路耐张转角塔",
        "h_body": 21.0,
        "h_total": 23.1,
        "b_bot": 5.0,
        "b_top": 1.4,
        "bays": [5.0, 10.0, 15.0, 19.5],
        "arms": [
            {"z": 12.0, "arm": 3.8, "role": "side"},
            {"z": 15.2, "arm": 1.5, "role": "mid"},
            {"z": 21.0, "arm": 1.8, "role": "gw", "rise": 2.1},
        ],
        "ins": 1.2,
        "base_size": 2.4,
        "base_h": 0.6,
    },
}

# 构件截面（m）：主材 / 斜材 / 横隔 / 横担 / 绝缘子
SEC_LEG = 0.26
SEC_BRACE = 0.13
SEC_DIAG = 0.11
SEC_ARM = 0.20
SEC_INS = 0.16


class Builder(object):
    """把若干长方体累积成一个三角形网格（每面独立顶点，法线硬边）"""

    def __init__(self):
        self.pos = []
        self.nrm = []
        self.idx = []

    # ---------- 基础图元：沿 p0→p1 的棱柱，截面 w × h
    def add_box(self, p0, p1, w, h):
        ax = (p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
        L = math.sqrt(sum(c * c for c in ax))
        if L < 1e-6:
            return
        d = (ax[0] / L, ax[1] / L, ax[2] / L)
        # 选一个与 d 不平行的参考轴构造截面基
        ref = (0.0, 0.0, 1.0) if abs(d[2]) < 0.9 else (1.0, 0.0, 0.0)
        u = cross(ref, d)
        u = norm(u)
        v = norm(cross(d, u))

        hw, hh = w / 2.0, h / 2.0
        corners = []
        for p in (p0, p1):
            for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                corners.append((p[0] + u[0] * su * hw + v[0] * sv * hh,
                                p[1] + u[1] * su * hw + v[1] * sv * hh,
                                p[2] + u[2] * su * hw + v[2] * sv * hh))
        a = corners[0:4]      # p0 端
        b = corners[4:8]      # p1 端

        # 端面法线（-d / +d）
        self._quad(a[0], a[3], a[2], a[1], (-d[0], -d[1], -d[2]))
        self._quad(b[0], b[1], b[2], b[3], d)
        # 侧面
        for i in range(4):
            j = (i + 1) % 4
            n = norm(cross(sub(b[i], a[i]), sub(a[j], a[i])))
            self._quad(a[i], a[j], b[j], b[i], n)

    def _quad(self, p0, p1, p2, p3, n):
        base = len(self.pos)
        for p in (p0, p1, p2, p3):
            self.pos.append(p)
            self.nrm.append(n)
        self.idx += [base, base + 1, base + 2, base, base + 2, base + 3]

    # ---------- 便捷：轴对齐方盒（中心 + 尺寸）
    def box_at(self, cx, cy, cz, sx, sy, sz):
        self.add_box((cx - sx / 2, cy, cz), (cx + sx / 2, cy, cz), sy, sz)

    def stats(self):
        return len(self.pos), len(self.idx) // 3


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def norm(a):
    L = math.sqrt(sum(c * c for c in a)) or 1.0
    return (a[0] / L, a[1] / L, a[2] / L)


def half_width(b_bot, b_top, h_body, z):
    """塔身在标高 z 处的半边长（线性变截面）"""
    t = min(max(z / h_body, 0.0), 1.0)
    return (b_bot + (b_top - b_bot) * t) / 2.0


def build_tower(P):
    b = Builder()
    B, bt, hb = P["b_bot"], P["b_top"], P["h_body"]

    # ---------- 1) 四根主材（角钢，从基础顶到塔口）
    for sx in (-1, 1):
        for sy in (-1, 1):
            p0 = (sx * B / 2, sy * B / 2, 0.0)
            p1 = (sx * bt / 2, sy * bt / 2, hb)
            b.add_box(p0, p1, SEC_LEG, SEC_LEG)

    # ---------- 2) 横隔（水平杆）+ 斜材（每段四个侧面各一条对角）
    levels = [0.0] + list(P["bays"]) + [hb]
    for k in range(len(levels) - 1):
        z0, z1 = levels[k], levels[k + 1]
        w0 = half_width(B, bt, hb, z0)
        w1 = half_width(B, bt, hb, z1)

        # 上端横隔
        for sx in (-1, 1):
            b.add_box((sx * w1, -w1, z1), (sx * w1, w1, z1), SEC_BRACE, SEC_BRACE)
            b.add_box((-w1, sx * w1, z1), (w1, sx * w1, z1), SEC_BRACE, SEC_BRACE)

        # 四个侧面的斜撑（X 形取一条，避免三角形过多）
        for s in (-1, 1):
            b.add_box((s * w0, -w0, z0), (s * w1, w1, z1), SEC_DIAG, SEC_DIAG)
            b.add_box((s * w0, w0, z0), (s * w1, -w1, z1), SEC_DIAG, SEC_DIAG)
            b.add_box((-w0, s * w0, z0), (w1, s * w1, z1), SEC_DIAG, SEC_DIAG)
            b.add_box((w0, s * w0, z0), (-w1, s * w1, z1), SEC_DIAG, SEC_DIAG)

    # ---------- 3) 横担与地线支架（沿 ±x 双向伸出）
    ins = P["ins"]
    for arm in P["arms"]:
        z, L = arm["z"], arm["arm"]
        role = arm.get("role", "side")
        w = half_width(B, bt, hb, z)

        for s in (-1, 1):
            root = (s * w, 0.0, z)

            if role == "gw":
                # 地线支架：自塔身顶斜向外上扬（"羊角"），不是水平横担
                rise = arm.get("rise", 1.9)
                tip = (s * L, 0.0, z + rise)
                b.add_box(root, tip, SEC_ARM * 0.8, SEC_ARM * 0.8)
                # 内侧再补一根短撑，避免单杆像天线
                b.add_box((s * w, 0.0, z - 1.4), (s * L * 0.62, 0.0, z + rise * 0.62),
                          SEC_DIAG, SEC_DIAG)
                continue

            tip = (s * L, 0.0, z)
            b.add_box(root, tip, SEC_ARM, SEC_ARM)                   # 上弦
            b.add_box(root, tip, SEC_ARM * 0.85, SEC_ARM * 0.85)     # 下弦（贴合，视觉加粗）
            # 斜撑：从塔身下侧接到横担端部
            z_lo = max(0.0, z - 2.6)
            w_lo = half_width(B, bt, hb, z_lo)
            b.add_box((s * w_lo, 0.0, z_lo), tip, SEC_BRACE, SEC_BRACE)

            if role == "side":
                # 边相绝缘子串挂在横担端部
                if P["id"] == "tension":
                    for sy in (-1, 1):
                        b.add_box((s * L, 0.0, z - 0.4), (s * L, sy * 0.95, z - 0.4),
                                  SEC_INS, SEC_INS)
                else:
                    b.add_box((s * L, 0.0, z), (s * L, 0.0, z - ins), SEC_INS, SEC_INS)

        if role == "mid":
            # 中相：挂在塔轴线（x=0），横担只作结构，绝缘子串在轴线中心垂下
            if P["id"] == "tension":
                for sy in (-1, 1):
                    b.add_box((0.0, 0.0, z - 0.4), (0.0, sy * 0.95, z - 0.4),
                              SEC_INS, SEC_INS)
            else:
                b.add_box((0.0, 0.0, z), (0.0, 0.0, z - ins), SEC_INS, SEC_INS)

    # ---------- 4) 四个基础（混凝土墩，露出地面 base_h）
    bs, bh = P["base_size"], P["base_h"]
    for sx in (-1, 1):
        for sy in (-1, 1):
            b.box_at(sx * B / 2, sy * B / 2, bh / 2.0, bs, bs, bh)

    return b


# ---------------------------------------------------------------------------
# glTF 2.0 写出（单 buffer + 单 mesh，二进制 .glb）
# ---------------------------------------------------------------------------
def write_glb(path, b):
    pos, nrm, idx = b.pos, b.nrm, b.idx

    pos_f = [c for p in pos for c in p]
    nrm_f = [c for n in nrm for c in n]
    idx_u32 = idx

    vcount = len(pos)
    use_u16 = vcount < 65536
    if use_u16:
        idx_bin = struct.pack("<%dH" % len(idx_u32), *idx_u32)
        idx_type = 5123
    else:
        idx_bin = struct.pack("<%dI" % len(idx_u32), *idx_u32)
        idx_type = 5125

    pos_bin = struct.pack("<%df" % len(pos_f), *pos_f)
    nrm_bin = struct.pack("<%df" % len(nrm_f), *nrm_f)

    # 4 字节对齐
    def pad4(d):
        return d + b"\x00" * ((4 - len(d) % 4) % 4)

    pos_bin, nrm_bin, idx_bin = pad4(pos_bin), pad4(nrm_bin), pad4(idx_bin)
    blobs = [pos_bin, nrm_bin, idx_bin]
    offsets, acc = [], 0
    for d in blobs:
        offsets.append(acc)
        acc += len(d)
    bin_all = b"".join(blobs)

    xs = pos_f[0::3]
    ys = pos_f[1::3]
    zs = pos_f[2::3]

    gltf = {
        "asset": {"version": "2.0", "generator": "make_tower_glb.py"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "tower"}],
        "meshes": [{
            "name": "tower",
            "primitives": [{
                "attributes": {"POSITION": 0, "NORMAL": 1},
                "indices": 2,
                "material": 0,
                "mode": 4,
            }],
        }],
        "materials": [{
            "name": "tower_steel",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.62, 0.66, 0.71, 1.0],
                "metallicFactor": 0.30,
                "roughnessFactor": 0.62,
            },
            "doubleSided": False,
        }],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": vcount, "type": "VEC3",
             "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]},
            {"bufferView": 1, "componentType": 5126, "count": vcount, "type": "VEC3"},
            {"bufferView": 2, "componentType": idx_type, "count": len(idx_u32),
             "type": "SCALAR"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": offsets[0], "byteLength": len(pos_bin),
             "target": 34962},
            {"buffer": 0, "byteOffset": offsets[1], "byteLength": len(nrm_bin),
             "target": 34962},
            {"buffer": 0, "byteOffset": offsets[2], "byteLength": len(idx_bin),
             "target": 34963},
        ],
        "buffers": [{"byteLength": len(bin_all)}],
    }

    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * ((4 - len(js) % 4) % 4)          # JSON chunk 用空格补齐
    bin_all += b"\x00" * ((4 - len(bin_all) % 4) % 4)

    total = 12 + 8 + len(js) + 8 + len(bin_all)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A))
        f.write(js)
        f.write(struct.pack("<II", len(bin_all), 0x004E4942))
        f.write(bin_all)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs("data", exist_ok=True)

    out_types = {}
    for key, P in TYPES.items():
        b = build_tower(P)
        path = os.path.join(OUT_DIR, "tower_%s.glb" % ("susp" if key == "suspension" else "tens"))
        write_glb(path, b)
        nv, nt = b.stats()
        print("%-10s %-22s %5d 顶点 %5d 三角形  %.1f KB -> %s"
              % (key, P["name"], nv, nt, os.path.getsize(path) / 1024, path))

        # 导线挂点（模型空间，前端按同一套参数换算，两端一致）
        # 导线挂点（模型空间）：边相在横担端部 ±x，中相在塔轴线 x=0
        drop = 0.4 if P["id"] == "tension" else P["ins"]
        hooks = []
        for arm in P["arms"]:
            if arm.get("role") == "gw":
                continue
            if arm.get("role") == "side":
                hooks.append({"z": round(arm["z"] - drop, 2), "x": arm["arm"], "phase": "side"})
                hooks.append({"z": round(arm["z"] - drop, 2), "x": -arm["arm"], "phase": "side"})
            else:
                hooks.append({"z": round(arm["z"] - drop, 2), "x": 0.0, "phase": "mid"})
        out_types[key] = {
            "id": P["id"], "name": P["name"], "note": P["note"],
            "h_body": P["h_body"], "h_total": P["h_total"],
            "b_bot": P["b_bot"], "b_top": P["b_top"],
            "arms": P["arms"],
            "base_size": P["base_size"],
            "base_h": P["base_h"],
            "model": "libs/models/" + os.path.basename(path),
            "hooks": hooks,
            "ins": P["ins"],
        }

    with atomic_text(OUT_JSON) as f:
        json.dump({"types": out_types,
                   "note": "塔型尺寸为典型值（国网 35kV 通用设计单回路塔），非本工程实测；"
                           "接入施工图后须按实际塔型替换并重新生成模型"},
                  f, ensure_ascii=False, indent=1)
    print("已写出 %s" % OUT_JSON)


if __name__ == "__main__":
    main()
