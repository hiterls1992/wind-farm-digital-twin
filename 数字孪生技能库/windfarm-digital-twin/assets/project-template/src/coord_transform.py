# -*- coding: utf-8 -*-
"""火星坐标(GCJ-02) 与 WGS-84 互转，用于把用户提供的 GCJ-02 场址中心换算到底图可用的 WGS-84"""
import math

A = 6378245.0
EE = 0.00669342162296594323


def _out_of_china(lng, lat):
    return not (73.66 < lng < 135.05 and 3.86 < lat < 53.55)


def _transform_lat(x, y):
    ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (160.0 * math.sin(y / 12.0 * math.pi) + 320 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    return ret


def _transform_lng(x, y):
    ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
    return ret


def wgs84_to_gcj02(lng, lat):
    if _out_of_china(lng, lat):
        return lng, lat
    dlat = _transform_lat(lng - 105.0, lat - 35.0)
    dlng = _transform_lng(lng - 105.0, lat - 35.0)
    radlat = lat / 180.0 * math.pi
    magic = math.sin(radlat)
    magic = 1 - EE * magic * magic
    sqrtmagic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((A * (1 - EE)) / (magic * sqrtmagic) * math.pi)
    dlng = (dlng * 180.0) / (A / sqrtmagic * math.cos(radlat) * math.pi)
    return lng + dlng, lat + dlat


def gcj02_to_wgs84(lng, lat):
    """迭代反解，残差 < 1e-9 度（约 0.1 m）"""
    wlng, wlat = lng, lat
    for _ in range(30):
        glng, glat = wgs84_to_gcj02(wlng, wlat)
        dlng, dlat = glng - lng, glat - lat
        if abs(dlng) < 1e-10 and abs(dlat) < 1e-10:
            break
        wlng -= dlng
        wlat -= dlat
    return wlng, wlat


if __name__ == "__main__":
    g_lng, g_lat = 112.76741906, 40.42359231
    w_lng, w_lat = gcj02_to_wgs84(g_lng, g_lat)
    print("GCJ-02 : %.8f, %.8f" % (g_lng, g_lat))
    print("WGS-84 : %.8f, %.8f" % (w_lng, w_lat))
    mlat = 111033.0
    mlon = 111320.0 * math.cos(math.radians(g_lat))
    print("偏移量 : 东向 %+.1f m, 北向 %+.1f m" % ((w_lng - g_lng) * mlon, (w_lat - g_lat) * mlat))
    print("往返校验: %.10f, %.10f" % wgs84_to_gcj02(w_lng, w_lat))
