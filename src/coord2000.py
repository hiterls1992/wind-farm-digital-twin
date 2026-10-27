# -*- coding: utf-8 -*-
"""
CGCS2000 高斯-克吕格投影坐标与经纬度互转（纯 Python，无第三方依赖）

适用：CGCS2000 国家大地坐标系，3°/6° 带，正形投影（k0 = 1）
说明：
  1) 椭球参数取 CGCS2000（a = 6378137, 1/f = 298.257222101）；
  2) 带号既可由坐标首两位推出，也可显式指定；东坐标是否带带号前缀单独标记；
  3) 正算用 Snyder 级数（3° 带内 < 1 mm）；反算的底点纬度用子午线弧长
     数值积分 + 牛顿迭代求得，避免级数系数符号错位这一类隐蔽错误；
  4) 本模块只做投影换算，不做 GCJ-02 偏移——GCJ-02 与 WGS-84 的差异见 coord_transform.py。

命令行用法：
  python src/coord2000.py                              # 自带往返校验
  python src/coord2000.py 38397196 4480710             # 单点反算
  python src/coord2000.py 397196 4480710 --no-prefix   # 东坐标不含带号
"""
import math
import sys

# ---------------------------------------------------------------- 椭球与投影常数
A_AXIS = 6378137.0                    # 长半轴 m
INV_F = 298.257222101                 # 扁率倒数（CGCS2000）
F = 1.0 / INV_F
E2 = F * (2.0 - F)                    # 第一偏心率平方
EP2 = E2 / (1.0 - E2)                 # 第二偏心率平方
K0 = 1.0                              # 中央子午线尺度因子（3° 带取 1）
FALSE_EASTING = 500000.0              # 东伪偏移 m

_M_INT = 4000                          # 子午线弧长积分分段数（残差 < 0.01 mm）


def central_meridian(zone, width=3):
    """由带号推中央子午线经度：3° 带 L0 = 3 × zone；6° 带 L0 = 6 × zone − 3"""
    if width == 3:
        return 3.0 * zone
    if width == 6:
        return 6.0 * zone - 3.0
    raise ValueError("band width must be 3 or 6")


def _meridian_radius(phi):
    """子午圈曲率半径 M(φ)"""
    s = math.sin(phi)
    return A_AXIS * (1.0 - E2) / (1.0 - E2 * s * s) ** 1.5


def meridian_arc(phi):
    """赤道到纬度 φ 的子午线弧长（m），复合辛普森积分"""
    if phi == 0.0:
        return 0.0
    h = phi / _M_INT
    total = _meridian_radius(0.0) + _meridian_radius(phi)
    for i in range(1, _M_INT):
        total += (4.0 if i % 2 else 2.0) * _meridian_radius(i * h)
    return total * h / 3.0


def footprint_latitude(north):
    """由北坐标反求底点纬度（牛顿迭代，收敛到 1e-12 rad）"""
    phi = north / A_AXIS                      # 初值：球面近似
    for _ in range(12):
        d = (meridian_arc(phi) - north) / _meridian_radius(phi)
        phi -= d
        if abs(d) < 1e-12:
            break
    return phi


def en_to_lonlat(east, north, zone=None, width=3, has_prefix=True):
    """
    高斯投影平面坐标 -> 经纬度
    east/north : 东坐标 / 北坐标（m）。has_prefix=True 时 east 首两位为带号（8 位）
    返回 (lon, lat) 十进制度（CGCS2000 大地坐标，与 WGS-84 差异 < 0.1 m，工程上可直接使用）
    """
    if has_prefix:
        zone = int(east // 1e6)
        east = east - zone * 1e6
    if zone is None:
        raise ValueError("未指定带号，且坐标不含带号前缀")
    lon0 = math.radians(central_meridian(zone, width))

    x = east - FALSE_EASTING
    phi1 = footprint_latitude(north)

    sin1, cos1, tan1 = math.sin(phi1), math.cos(phi1), math.tan(phi1)
    C1 = EP2 * cos1 ** 2
    T1 = tan1 ** 2
    N1 = A_AXIS / math.sqrt(1 - E2 * sin1 ** 2)
    R1 = _meridian_radius(phi1)
    D = x / (N1 * K0)

    lat = phi1 - (N1 * tan1 / R1) * (
        D ** 2 / 2
        - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * EP2) * D ** 4 / 24
        + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * EP2 - 3 * C1 ** 2) * D ** 6 / 720)
    lon = lon0 + (
        D
        - (1 + 2 * T1 + C1) * D ** 3 / 6
        + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * EP2 + 24 * T1 ** 2) * D ** 5 / 120) / cos1

    return math.degrees(lon), math.degrees(lat)


def lonlat_to_en(lon, lat, zone=None, width=3, with_prefix=True):
    """经纬度 -> 高斯投影平面坐标；返回 (east, north)，with_prefix 时 east 含带号前缀"""
    if zone is None:
        zone = int((lon + 1.5) // width) if width == 3 else int(lon // 6) + 1
    lon0 = math.radians(central_meridian(zone, width))
    phi = math.radians(lat)
    dlon = math.radians(lon) - lon0

    sinf, cosf, tanf = math.sin(phi), math.cos(phi), math.tan(phi)
    N = A_AXIS / math.sqrt(1 - E2 * sinf ** 2)
    T = tanf ** 2
    C = EP2 * cosf ** 2
    Aa = dlon * cosf

    east = K0 * N * (Aa
                     + (1 - T + C) * Aa ** 3 / 6
                     + (5 - 18 * T + T ** 2 + 72 * C - 58 * EP2) * Aa ** 5 / 120) + FALSE_EASTING
    north = K0 * (meridian_arc(phi)
                  + N * tanf * (Aa ** 2 / 2
                                + (5 - T + 9 * C + 4 * C ** 2) * Aa ** 4 / 24
                                + (61 - 58 * T + T ** 2 + 600 * C - 330 * EP2) * Aa ** 6 / 720))
    if with_prefix:
        east += zone * 1e6
    return east, north


def _residual_m(lon1, lat1, lon2, lat2):
    dx = (lon2 - lon1) * 111320.0 * math.cos(math.radians(lat1))
    dy = (lat2 - lat1) * 111033.0
    return math.hypot(dx, dy)


def self_test():
    """往返校验：CGCS2000 3° 带 38 带，中心经线 114°E；并校验已知大地坐标弧长"""
    print("子午线弧长校验：M(0)=%.3f  M(90°)=%.3f m（理论 10001965.729）"
          % (meridian_arc(0.0), meridian_arc(math.pi / 2)))
    cases = [(112.76058197, 40.4223831), (112.7800, 40.4500), (112.7000, 40.5000)]
    worst = 0.0
    for lon, lat in cases:
        e, n = lonlat_to_en(lon, lat, zone=38)
        lon2, lat2 = en_to_lonlat(e, n)
        r = _residual_m(lon, lat, lon2, lat2)
        worst = max(worst, r)
        print("  (%.8f, %.8f) -> E %.3f  N %.3f -> (%.8f, %.8f)  残差 %.4f m"
              % (lon, lat, e, n, lon2, lat2, r))
    print("往返校验最大残差 %.4f m" % worst)
    return worst


if __name__ == "__main__":
    if len(sys.argv) == 1:
        self_test()
    else:
        args = [a for a in sys.argv[1:] if not a.startswith("--")]
        east, north = float(args[0]), float(args[1])
        zone = None
        for i, a in enumerate(sys.argv):
            if a.startswith("--zone"):
                zone = int(a.split("=")[1]) if "=" in a else int(sys.argv[i + 1])
        prefix = "--no-prefix" not in sys.argv
        lon, lat = en_to_lonlat(east, north, zone=zone, has_prefix=prefix)
        print("E %.3f  N %.3f  ->  %.8f°E  %.8f°N" % (east, north, lon, lat))
