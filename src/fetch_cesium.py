# -*- coding: utf-8 -*-
"""
从 jsDelivr 下载 CesiumJS 1.118 的 Build/Cesium 目录到本地 libs/cesium，
使三维引擎不依赖运行时 CDN。仅保留运行必需文件（不含 npm 入口 index.js / index.cjs）。
"""
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

LIST = "C:/Users/lishuo/AppData/Local/Temp/cs_list.json"
BASE = "https://cdn.jsdelivr.net/npm/cesium@1.118.0/Build/Cesium/"
DST = "libs/cesium"
SKIP = {"/Build/Cesium/index.js", "/Build/Cesium/index.cjs"}


def load_files():
    d = json.load(open(LIST, encoding="utf-8"))
    out = []
    for f in d["files"]:
        name = f["name"]
        if not name.startswith("/Build/Cesium/") or name in SKIP:
            continue
        rel = name[len("/Build/Cesium/"):]
        out.append((rel, f["size"]))
    return out


def fetch(rel):
    path = os.path.join(DST, rel.replace("/", os.sep))
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return rel, 0, "cached"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    url = BASE + rel
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=45) as r:
                data = r.read()
            with open(path, "wb") as f:
                f.write(data)
            return rel, len(data), "ok"
        except Exception as e:
            if attempt == 3:
                return rel, 0, "FAIL: %s" % e
            time.sleep(1.5 * (attempt + 1))


def main():
    files = load_files()
    total = sum(s for _, s in files)
    print("待下载 %d 个文件，%.2f MB" % (len(files), total / 1024 / 1024))

    done_bytes, fails = 0, []
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(fetch, rel): rel for rel, _ in files}
        for i, fu in enumerate(as_completed(futs), 1):
            rel, n, st = fu.result()
            done_bytes += n
            if st.startswith("FAIL"):
                fails.append((rel, st))
            if i % 40 == 0 or i == len(files):
                print("  %d/%d  已完成 %.1f MB" % (i, len(files), done_bytes / 1024 / 1024))

    if fails:
        print("失败 %d 个：" % len(fails))
        for r, s in fails[:10]:
            print("   ", r, s)
        sys.exit(1)
    print("完成")


if __name__ == "__main__":
    main()
