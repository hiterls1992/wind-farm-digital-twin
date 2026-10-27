/* =============================================================================
 * 内蒙古凉城 60 MW 陆上风电项目 · 数字孪生（实测机位版）
 * -----------------------------------------------------------------------------
 * 数据来源
 *   机位 / 电量：风场数据/风电场.xlsx「风机数据」表（8 台实测数据）
 *   坐标：CGCS2000 3° 带第 38 带（中央经线 114°E）高斯投影，由 src/coord2000.py 反算经纬度
 *   地形：ASTER GDEM v3（30 m），分级采样后内嵌于 data/site-data.js
 *   影像：Esri World Imagery（公开服务，无需密钥）
 * 说明
 *   1) 风机位置、地面高程、风速、发电量全部来自实测数据表，本文件不含业务硬编码；
 *   2) 唯一非数据给定的机型参数是叶轮直径，由比功率反推，来源与算法写在 machine 字段；
 *   3) 全部实体按绝对海拔定位，与地形网格共用同一套高度函数，避免穿模；
 *   4) 每台风机上方挂 HTML 看板，显示该机组的风速、发电量与等效小时。
 * ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------------------
   * 0. 运行环境检查
   * ------------------------------------------------------------------------ */
  function showFatal(title, html) {
    var ld = document.getElementById('loader');
    if (!ld) return;
    ld.innerHTML = '<div class="err-box"><h3>' + title + '</h3><div>' + html + '</div></div>';
  }

  if (!window.Cesium) {
    showFatal('三维引擎加载失败',
      '未能加载 CesiumJS。请检查 <code>libs/cesium/</code> 是否存在，或确认网络可访问 CDN。');
    return;
  }

  var DATA = window.SITE_DATA;
  if (!DATA || !DATA.site || !DATA.site.turbines) {
    showFatal('工程数据缺失',
      '未找到有效的 <code>data/site-data.js</code>。请依次执行 ' +
      '<code>src/import_windfarm.py</code> → <code>src/fetch_dem.py</code> → ' +
      '<code>src/build_js_data.py</code>。');
    return;
  }

  /* ---------------------------------------------------------------------------
   * 1. 常量（全部来自数据文件）
   * ------------------------------------------------------------------------ */
  var SITE = DATA.site;
  var MACH = SITE.machine;
  var E = SITE.energy;
  var CTR = DATA.center;                                   // WGS-84 场址原点（机位重心）
  var BLEND = DATA.terrainBlend;
  var BASE_ELEV = BLEND.base;

  var A_AXIS = 6378137.0;
  var E2 = 0.00669437999014;

  var ROTOR_R = MACH.rotor_d / 2;                          // 叶轮半径 m
  var BLADE_LEN = ROTOR_R - 2.0;                           // 叶片长度（扣轮毂罩）
  var HUB_H = MACH.hub_h;                                  // 轮毂高度（离地）
  var WIND_AZ = 315;                                       // 主导风向来向（表未给出，取项目区主导 NW）
  var RATED_RPM = 8.4;                                     // 额定转速 r/min（7.5 MW 级机型典型值）

  var DEG_LAT = 111033.0;
  var DEG_LON = 111320.0 * Math.cos(CTR.lat * Math.PI / 180);

  var BOARDS_ON = true;

  /* ---------------------------------------------------------------------------
   * 2. 坐标与地形
   * ------------------------------------------------------------------------ */

  /** 局部 ENU（x 东 / y 北，m）→ WGS-84 经纬度（椭球曲率半径法） */
  function enuToLonLat(x, y) {
    var phi = CTR.lat * Math.PI / 180;
    var s = Math.sin(phi);
    var w = Math.sqrt(1 - E2 * s * s);
    var M = A_AXIS * (1 - E2) / (w * w * w);
    var N = A_AXIS / w;
    return {
      lon: CTR.lon + (x / (N * Math.cos(phi))) * 180 / Math.PI,
      lat: CTR.lat + (y / M) * 180 / Math.PI
    };
  }

  var LV = [DATA.levels.L0, DATA.levels.L1, DATA.levels.L2];
  var LV_NAME = ['L0', 'L1', 'L2'];

  /** 双线性插值；网格约定：行 0 在最北，列 0 在最西 */
  function bilinear(lv, x, y) {
    var n = lv.n, step = lv.step, half = lv.half, rows = lv.rows;
    var fc = (x + half) / step;
    var fr = (half - y) / step;
    if (fc < 0) fc = 0; else if (fc > n - 1.0001) fc = n - 1.0001;
    if (fr < 0) fr = 0; else if (fr > n - 1.0001) fr = n - 1.0001;
    var i0 = fc | 0, j0 = fr | 0;
    var tx = fc - i0, ty = fr - j0;
    var r0 = rows[j0], r1 = rows[j0 + 1];
    return r0[i0] * (1 - tx) * (1 - ty) + r0[i0 + 1] * tx * (1 - ty) +
           r1[i0] * (1 - tx) * ty + r1[i0 + 1] * tx * ty;
  }

  function smooth(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * (3 - 2 * t);
  }

  /** 单级 DEM 的融合权重：r ≤ inner×half 取 1，r ≥ half 取 0，中间平滑过渡 */
  function levelWeight(i, r) {
    var lv = LV[i];
    var half = lv.half;
    var inner = BLEND.inner[LV_NAME[i]] * half;
    if (r <= inner) return 1;
    if (r >= half) return 0;
    return smooth((half - r) / (half - inner));
  }

  /** 分级 DEM 融合高度函数（米，绝对海拔），与 src/build_js_data.py 完全一致 */
  function heightAt(x, y) {
    var r = Math.sqrt(x * x + y * y);
    var h0 = bilinear(LV[0], x, y);
    var h1 = bilinear(LV[1], x, y);
    var h2 = bilinear(LV[2], x, y);

    var w0 = levelWeight(0, r);
    var w1 = levelWeight(1, r);
    var w2 = levelWeight(2, r);

    var inner = w1 * h1 + (1 - w1) * h0;
    var mid = w2 * h2 + (1 - w2) * inner;
    return w0 * mid + (1 - w0) * BASE_ELEV;
  }

  /** 经纬度 → 局部 ENU */
  function lonLatToEnu(lon, lat) {
    return { x: (lon - CTR.lon) * DEG_LON, y: (lat - CTR.lat) * DEG_LAT };
  }

  /* ---------------------------------------------------------------------------
   * 3. 地形服务
   * ------------------------------------------------------------------------ */
  var TILE_N = 32;
  var tilingScheme = new Cesium.GeographicTilingScheme();

  // 瓦片范围判定：以 L0 覆盖半径为界，界外返回常数，省去插值开销
  var L0_HALF = DATA.levels.L0.half;
  var EXT_LON = L0_HALF / DEG_LON;
  var EXT_LAT = L0_HALF / DEG_LAT;

  var terrainProvider = new Cesium.CustomHeightmapTerrainProvider({
    width: TILE_N,
    height: TILE_N,
    tilingScheme: tilingScheme,
    credit: 'Terrain: ASTER GDEM 30m',
    callback: function (x, y, level) {
      var rect = tilingScheme.tileXYToRectangle(x, y, level);
      var west = Cesium.Math.toDegrees(rect.west);
      var east = Cesium.Math.toDegrees(rect.east);
      var south = Cesium.Math.toDegrees(rect.south);
      var north = Cesium.Math.toDegrees(rect.north);

      if (east < CTR.lon - EXT_LON || west > CTR.lon + EXT_LON ||
          north < CTR.lat - EXT_LAT || south > CTR.lat + EXT_LAT) {
        var flat = new Float32Array(TILE_N * TILE_N);
        flat.fill(BASE_ELEV);
        return flat;
      }

      var buf = new Float32Array(TILE_N * TILE_N);
      for (var j = 0; j < TILE_N; j++) {
        var lat = north + (south - north) * (j / (TILE_N - 1));
        var yl = (lat - CTR.lat) * DEG_LAT;
        var base = j * TILE_N;
        for (var i = 0; i < TILE_N; i++) {
          var lon = west + (east - west) * (i / (TILE_N - 1));
          buf[base + i] = heightAt((lon - CTR.lon) * DEG_LON, yl);
        }
      }
      return buf;
    }
  });

  /* ---------------------------------------------------------------------------
   * 4. 场景初始化
   * ------------------------------------------------------------------------ */
  var viewer = new Cesium.Viewer('cesiumContainer', {
    baseLayer: false,
    terrainProvider: terrainProvider,
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    shouldAnimate: true
  });

  var scene = viewer.scene;

  scene.backgroundColor = Cesium.Color.fromCssColorString('#05080f');
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#10161f');
  scene.globe.enableLighting = false;      // 影像自带阴影，再叠实时光照会过暗
  scene.globe.depthTestAgainstTerrain = true;
  scene.globe.showGroundAtmosphere = true;
  scene.fog.enabled = true;
  scene.fog.density = 0.000045;
  scene.skyAtmosphere.show = true;
  scene.skyAtmosphere.hueShift = -0.02;
  scene.postProcessStages.fxaa.enabled = true;

  viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date(Date.UTC(2026, 9, 20, 3, 45, 0)));
  viewer.clock.shouldAnimate = false;

  /* ---------------------------------------------------------------------------
   * 4.1 底图源
   * ------------------------------------------------------------------------- */
  // 天地图密钥从 js/config.js（默认空）/ js/config.local.js（本地私密，不入仓库）读取。
  // 代码中不出现明文 tk；留空时「天地图」相关底图自动置灰。
  // 注意：填在 config.local.js 的 tk 同样会随页面下发到浏览器，务必在控制台按域名做白名单。
  var CFG = window.APP_CONFIG || {};
  var TIANDITU_KEY = CFG.tiandituKey || '';

  var ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  var TDT_SUB = ['0', '1', '2', '3', '4', '5', '6', '7'];

  /** 天地图 WMTS（Web 墨卡托，CGCS2000，无 GCJ-02 偏移） */
  function tdtUrl(layer) {
    return 'https://t{s}.tianditu.gov.cn/' + layer + '_w/wmts' +
           '?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
           '&LAYER=' + layer + '&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles' +
           '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=' + TIANDITU_KEY;
  }

  var BASEMAPS = [
    // ---------------- 影像 ----------------
    {
      group: '影像', id: 'esri-sat', short: '卫星', name: '卫星影像',
      org: 'Esri World Imagery', res: '0.3–0.6 m',
      url: ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}',
      max: 19, bright: 1.30, contrast: 1.08, sat: 1.02,
      credit: 'Imagery © Esri, Maxar, Earthstar Geographics'
    },
    {
      group: '影像', id: 'tdt-sat', short: '天地图', name: '卫星影像 + 中文注记',
      org: '天地图 img + cia', res: '0.5–2 m · 中文',
      url: tdtUrl('img'), subdomains: TDT_SUB,
      max: 18, bright: 1.16, contrast: 1.05, sat: 1.06,
      credit: '© 天地图 国家地理信息公共服务平台',
      labels: { url: tdtUrl('cia'), subdomains: TDT_SUB, max: 18, credit: '© 天地图 注记' },
      disabled: !TIANDITU_KEY,
      disabledNote: '需 tk'
    },
    {
      group: '影像', id: 'esri-sat-lbl', short: '卫星EN', name: '卫星影像 + 英文注记',
      org: 'Esri World Imagery + Reference', res: '0.3–0.6 m · 注记（英文）',
      url: ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}',
      max: 19, bright: 1.30, contrast: 1.08, sat: 1.02,
      credit: 'Imagery © Esri; Labels © Esri',
      labels: {
        url: ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
        max: 18, credit: 'Labels © Esri'
      }
    },
    {
      group: '影像', id: 'eox-s2', short: 'S2', name: 'Sentinel-2 无云合成',
      org: 'EOX · 2020 年', res: '10 m',
      url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg',
      max: 16, bright: 1.26, contrast: 1.06, sat: 1.05,
      credit: 'Sentinel-2 cloudless © EOX IT Services GmbH (CC BY-NC-SA 4.0)'
    },

    // ---------------- 地形 ----------------
    {
      group: '地形', id: 'tdt-ter', short: '天地地形', name: '地形图 · 天地图',
      org: '天地图 ter + cta', res: '中文等高线与地名',
      url: tdtUrl('ter'), subdomains: TDT_SUB,
      max: 18, bright: 0.94, contrast: 1.12, sat: 0.96,
      credit: '© 天地图 国家地理信息公共服务平台',
      labels: { url: tdtUrl('cta'), subdomains: TDT_SUB, max: 18, credit: '© 天地图 注记' },
      disabled: !TIANDITU_KEY,
      disabledNote: '需 tk'
    },
    {
      group: '地形', id: 'esri-relief', short: '晕渲', name: '晕渲地貌',
      org: 'Esri Shaded Relief', res: '30 m 晕渲',
      url: ESRI + 'World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}',
      max: 13, bright: 1.00, contrast: 1.22, sat: 0.86,
      credit: 'Relief © Esri'
    },
    {
      group: '地形', id: 'esri-topo', short: '地形EN', name: '地形图 · Esri',
      org: 'Esri World Topographic', res: '≤13 级 · 县域可用',
      url: ESRI + 'World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
      max: 13, bright: 1.00, contrast: 1.02, sat: 1.00,
      credit: '© Esri, HERE, Garmin, USGS'
    },
    {
      group: '地形', id: 'esri-street', short: '街道', name: '街道图 · Esri',
      org: 'Esri World Street Map', res: '≤13 级 · 县域可用',
      url: ESRI + 'World_Street_Map/MapServer/tile/{z}/{y}/{x}',
      max: 13, bright: 1.00, contrast: 1.02, sat: 1.00,
      credit: '© Esri, HERE, Garmin, USGS'
    }
  ];

  var bmBase = null, bmLabel = null, bmCurrent = null;

  function bmProvider(def) {
    var opt = {
      url: def.url,
      maximumLevel: def.max,
      credit: def.credit,
      hasAlphaChannel: true
    };
    if (def.subdomains) opt.subdomains = def.subdomains;
    return new Cesium.UrlTemplateImageryProvider(opt);
  }

  function clearBasemap() {
    if (bmLabel) { viewer.imageryLayers.remove(bmLabel, true); bmLabel = null; }
    if (bmBase) { viewer.imageryLayers.remove(bmBase, true); bmBase = null; }
  }

  /**
   * 切换底图。
   * @param {Object} def      底图定义
   * @param {Boolean} isRevert 是否由「加载失败回退」触发，避免回退又触发回退
   */
  function applyBasemap(def, isRevert) {
    clearBasemap();

    var errCount = 0;
    var provider = bmProvider(def);
    provider.errorEvent.addEventListener(function () { errCount++; });

    bmBase = viewer.imageryLayers.addImageryProvider(provider, 0);
    bmBase.brightness = def.bright;
    bmBase.contrast = def.contrast;
    bmBase.saturation = def.sat;

    if (def.labels) {
      bmLabel = viewer.imageryLayers.addImageryProvider(bmProvider({
        url: def.labels.url, max: def.labels.max, credit: def.labels.credit,
        subdomains: def.labels.subdomains
      }));
      bmLabel.brightness = 1.0;
    }

    bmCurrent = def.id;
    setText('bmLabel', '底图 · ' + def.short);
    document.querySelectorAll('.bm-item').forEach(function (n) {
      n.classList.toggle('on', n.dataset.bm === def.id);
    });
    setText('bmFoot', '当前：' + def.name + '（' + def.org + '）　' + def.res +
            '　|　影像为公开服务，成像时间以源方为准。');
    try { localStorage.setItem('dt.basemap', def.id); } catch (e) { /* 隐私模式忽略 */ }

    // 8 s 内失败瓦片过多 → 判定该源在本网络不可用，回退并明示，不允许静默失效
    if (!isRevert) {
      setTimeout(function () {
        if (errCount >= 4 && bmCurrent === def.id) {
          toast('底图「' + def.name + '」有 ' + errCount + ' 个瓦片加载失败，已回退到卫星影像。');
          applyBasemap(BASEMAPS[0], true);
        }
      }, 8000);
    }
    scene.requestRender();
  }

  function buildBasemapMenu() {
    var list = document.getElementById('bmList');
    list.innerHTML = '';
    var lastGroup = null;
    BASEMAPS.forEach(function (b) {
      if (b.group && b.group !== lastGroup) {
        var g = document.createElement('div');
        g.className = 'bm-group';
        g.textContent = b.group;
        list.appendChild(g);
        lastGroup = b.group;
      }
      var el = document.createElement('button');
      el.className = 'bm-item' + (b.disabled ? ' dis' : '');
      el.dataset.bm = b.id;
      el.innerHTML =
        '<span class="bm-n"><b><i class="dot"></i>' + b.name + '</b><em>' + b.org + '</em></span>' +
        '<span class="bm-r">' + (b.disabled ? b.disabledNote : b.res) + '</span>';
      el.addEventListener('click', function () {
        if (b.disabled) { toast(b.disabledNote); return; }
        applyBasemap(b);
        closeBasemapMenu();
      });
      list.appendChild(el);
    });
  }

  function openBasemapMenu() {
    var pop = document.getElementById('bmPop');
    var btn = document.getElementById('btnBase');
    pop.classList.add('open');
    var w = pop.offsetWidth;
    var r = btn.getBoundingClientRect();
    var left = r.left + r.width / 2 - w / 2;
    pop.style.left = Math.max(12, Math.min(left, window.innerWidth - w - 12)) + 'px';
    pop.style.top = Math.max(74, r.top - pop.offsetHeight - 10) + 'px';
  }

  function closeBasemapMenu() {
    document.getElementById('bmPop').classList.remove('open');
  }

  function initBasemap() {
    var saved = null;
    try { saved = localStorage.getItem('dt.basemap'); } catch (e) { /* 忽略 */ }
    var def = null;
    for (var i = 0; i < BASEMAPS.length; i++) {
      if (BASEMAPS[i].id === saved && !BASEMAPS[i].disabled) { def = BASEMAPS[i]; break; }
    }
    buildBasemapMenu();
    applyBasemap(def || BASEMAPS[0]);
  }

  initBasemap();

  /* ---------------------------------------------------------------------------
   * 5. 图元分组与工具
   * ------------------------------------------------------------------------ */
  var groups = { boundary: [], roads: [], grid: [], turbine: [], substation: [], metmast: [] };

  function reg(group, opts) {
    var e = viewer.entities.add(opts);
    groups[group].push(e);
    if (opts.wt) {
      // Entity 自定义属性：除构造时赋值外，再登记一次，保证点选时一定能读到
      e.addProperty('wt', opts.wt);
    }
    return e;
  }

  /** 给图元打机位标记（在 reg 中落到实体的 wt 属性上） */
  function tagWt(opts, id) {
    opts.wt = id;
    return opts;
  }

  function xyz(x, y, h) {
    var p = enuToLonLat(x, y);
    return Cesium.Cartesian3.fromDegrees(p.lon, p.lat, h);
  }

  var LINE_STEP = 40;

  /** 生成贴地的三维折线顶点（沿 AB 两点，按地形起伏加密） */
  function groundLine(x1, y1, x2, y2, lift) {
    var len = Math.hypot(x2 - x1, y2 - y1);
    var n = Math.max(2, Math.ceil(len / LINE_STEP));
    var out = [];
    for (var i = 0; i <= n; i++) {
      var u = i / n;
      var x = x1 + (x2 - x1) * u;
      var y = y1 + (y2 - y1) * u;
      var p = enuToLonLat(x, y);
      out.push(p.lon, p.lat, heightAt(x, y) + lift);
    }
    return out;
  }

  /* ---------------------------------------------------------------------------
   * 6. 场区控制范围（机位凸包外扩多边形）
   * ------------------------------------------------------------------------ */
  function buildBoundary() {
    var poly = SITE.boundary_polygon;                 // [[x,y], ...]
    var n = poly.length;
    var ring = [];

    for (var i = 0; i < n; i++) {
      var a = poly[i], b = poly[(i + 1) % n];

      // 边加密，使边框随地形起伏
      var seg = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / LINE_STEP));
      for (var s = 0; s < seg; s++) {
        var u = s / seg;
        var x = a[0] + (b[0] - a[0]) * u;
        var y = a[1] + (b[1] - a[1]) * u;
        var q = enuToLonLat(x, y);
        ring.push(q.lon, q.lat, heightAt(x, y) + 22);
      }
    }
    var p0 = enuToLonLat(poly[0][0], poly[0][1]);
    ring.push(p0.lon, p0.lat, heightAt(poly[0][0], poly[0][1]) + 22);

    // 说明：控制范围跨度约 5 km，若用逐点高程填充多边形，三角面会切穿山体，
    // 故只保留随地形起伏的边框，不做面填充。

    reg('boundary', {
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(ring),
        width: 3.2,
        material: new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString('#ffbe2e'))
      }
    });

    for (var k = 0; k < n; k++) {
      reg('boundary', {
        position: xyz(poly[k][0], poly[k][1], heightAt(poly[k][0], poly[k][1]) + 2),
        point: {
          pixelSize: 4,
          color: Cesium.Color.fromCssColorString('#f5b942'),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
    }

    // 场区范围与面积已在左侧面板给出，场景内不再重复标注，避免与机位看板争位。
  }

  /* ---------------------------------------------------------------------------
   * 7. 风机模型（机型参数全部按 machine 字段换算，不写死尺寸）
   * ------------------------------------------------------------------------ */
  var AZ_RAD = WIND_AZ * Math.PI / 180;
  var N_L = new Cesium.Cartesian3(Math.sin(AZ_RAD), Math.cos(AZ_RAD), 0);   // 来风方向
  var UP_L = new Cesium.Cartesian3(0, 0, 1);
  var T_L = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(UP_L, N_L, new Cesium.Cartesian3()), new Cesium.Cartesian3());

  // 叶片分段按叶长的比例给出：{起, 止, 弦宽, 厚度}
  var BLADE_PROFILE = [
    { f0: 0.020, f1: 0.10, w: 4.00, t: 1.55 },
    { f0: 0.100, f1: 0.42, w: 3.95, t: 1.00 },
    { f0: 0.420, f1: 0.78, w: 2.50, t: 0.52 },
    { f0: 0.780, f1: 1.00, w: 1.20, t: 0.26 }
  ];

  var spin = 0, spinOn = true, spinSpeed = 1.0, lastT = 0;

  scene.preUpdate.addEventListener(function () {
    var now = Date.now();
    var dt = lastT ? (now - lastT) / 1000 : 0;
    lastT = now;
    if (dt > 0.12) dt = 0.12;
    if (spinOn) spin += dt * RATED_RPM * 6 * spinSpeed;
    if (spin > 360) spin -= 360;
  });

  function bladeLocal(phiDeg, outE, outY) {
    var phi = phiDeg * Math.PI / 180;
    var c = Math.cos(phi), s = Math.sin(phi);
    outE.x = c * UP_L.x + s * T_L.x;
    outE.y = c * UP_L.y + s * T_L.y;
    outE.z = c * UP_L.z + s * T_L.z;
    Cesium.Cartesian3.cross(N_L, outE, outY);
    Cesium.Cartesian3.normalize(outY, outY);
  }

  function buildTurbine(t) {
    var ground = t.ground;                    // 数据表实测地面高程（权威值）
    var dem = t.ground_dem;                   // 地形模型高程
    var hubH = t.hub_abs;                     // 轮毂绝对海拔 = Z + 轮毂高度
    var p = enuToLonLat(t.x, t.y);

    var hubPos = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, hubH);
    var enuM = Cesium.Transforms.eastNorthUpToFixedFrame(hubPos);
    var rot3 = Cesium.Matrix4.getMatrix3(enuM, new Cesium.Matrix3());

    var towerColor = Cesium.Color.fromCssColorString('#dde3ea');
    var nacColor = Cesium.Color.fromCssColorString('#dfe7ef');
    var bladeColor = Cesium.Color.fromCssColorString('#ffffff');

    // 塔筒：自实测地面起算，高度取数据表轮毂高度
    reg('turbine', tagWt({
      position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, ground + HUB_H / 2),
      cylinder: {
        length: HUB_H,
        topRadius: 2.2,
        bottomRadius: 4.4,
        slices: 20,
        material: towerColor
      }
    }, t.id));

    // 基座接地段：DEM 与实测高程不一致时补齐，避免塔脚悬空或被埋
    if (dem < ground - 1.5) {
      var hGap = ground - dem + 1.0;
      reg('turbine', tagWt({
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, dem + hGap / 2),
        cylinder: {
          length: hGap,
          topRadius: 4.4,
          bottomRadius: 6.2,
          slices: 16,
          material: Cesium.Color.fromCssColorString('#9aa3ad')
        }
      }, t.id));
    }

    // 机舱
    var nacM = new Cesium.Matrix3.fromColumnMajorArray([
      N_L.x, N_L.y, N_L.z,
      -N_L.y, N_L.x, 0,
      0, 0, 1
    ]);
    var nacWorld = Cesium.Matrix3.multiply(rot3, nacM, new Cesium.Matrix3());
    var nacOff = Cesium.Matrix4.multiplyByPoint(
      enuM, new Cesium.Cartesian3(N_L.x * -6.5, N_L.y * -6.5, 2.0), new Cesium.Cartesian3());

    reg('turbine', tagWt({
      position: nacOff,
      orientation: Cesium.Quaternion.fromRotationMatrix(nacWorld),
      box: {
        dimensions: new Cesium.Cartesian3(13.5, 4.2, 4.2),
        material: nacColor
      }
    }, t.id));

    // 轮毂罩
    reg('turbine', tagWt({
      position: hubPos,
      ellipsoid: {
        radii: new Cesium.Cartesian3(2.4, 2.4, 2.4),
        material: Cesium.Color.fromCssColorString('#f7fafc')
      }
    }, t.id));

    // 三支叶片（分段 box，姿态随 spin 更新）
    for (var b = 0; b < 3; b++) {
      BLADE_PROFILE.forEach(function (seg, si) {
        var r0 = seg.f0 * BLADE_LEN, r1 = seg.f1 * BLADE_LEN;
        var rc = (r0 + r1) / 2, len = r1 - r0;
        var e_ = new Cesium.Cartesian3(), y_ = new Cesium.Cartesian3();
        var m_ = new Cesium.Matrix3(), q_ = new Cesium.Quaternion();
        var p_ = new Cesium.Cartesian3(), v_ = new Cesium.Cartesian3();
        var phase = b;

        var positionProp = new Cesium.CallbackProperty(function () {
          bladeLocal(spin + phase * 120, e_, y_);
          v_.x = e_.x * rc; v_.y = e_.y * rc; v_.z = e_.z * rc;
          return Cesium.Matrix4.multiplyByPoint(enuM, v_, p_);
        }, false);

        var orientProp = new Cesium.CallbackProperty(function () {
          bladeLocal(spin + phase * 120, e_, y_);
          Cesium.Matrix3.fromColumnMajorArray([
            e_.x, e_.y, e_.z,
            y_.x, y_.y, y_.z,
            N_L.x, N_L.y, N_L.z
          ], m_);
          var wm = Cesium.Matrix3.multiply(rot3, m_, m_);
          return Cesium.Quaternion.fromRotationMatrix(wm, q_);
        }, false);

        reg('turbine', tagWt({
          position: positionProp,
          orientation: orientProp,
          box: {
            dimensions: new Cesium.Cartesian3(len, seg.w, seg.t),
            material: bladeColor
          }
        }, t.id));
      });
    }

    // 基础（承台）
    reg('turbine', tagWt({
      position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, ground + 0.8),
      ellipse: {
        semiMajorAxis: 10.0,
        semiMinorAxis: 10.0,
        material: Cesium.Color.fromCssColorString('#c4c9cf').withAlpha(0.95)
      }
    }, t.id));

    // 吊装平台 45 m × 55 m
    var pw = 22.5, pd = 27.5;
    var plat = [];
    [[-pw, -pd], [pw, -pd], [pw, pd], [-pw, pd]].forEach(function (c) {
      var px = t.x + c[0], py = t.y + c[1];
      var q = enuToLonLat(px, py);
      plat.push(q.lon, q.lat, heightAt(px, py) + 1.4);
    });
    reg('turbine', tagWt({
      polygon: {
        hierarchy: Cesium.Cartesian3.fromDegreesArrayHeights(plat),
        material: Cesium.Color.fromCssColorString('#aab0b8').withAlpha(0.38),
        perPositionHeight: true
      }
    }, t.id));

    // 箱式变电站
    var bx = t.x - N_L.x * 24, by = t.y - N_L.y * 24;
    var bp = enuToLonLat(bx, by);
    reg('turbine', tagWt({
      position: Cesium.Cartesian3.fromDegrees(bp.lon, bp.lat, heightAt(bx, by) + 1.4),
      box: {
        dimensions: new Cesium.Cartesian3(6.0, 2.6, 2.8),
        material: Cesium.Color.fromCssColorString('#8f9aa6'),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString('#12181f').withAlpha(0.55)
      }
    }, t.id));

    // 机位地面基准点
    reg('turbine', tagWt({
      position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, ground + 1.0),
      point: {
        pixelSize: 5,
        color: Cesium.Color.fromCssColorString('#22d3ee').withAlpha(0.9),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    }, t.id));
  }

  /* ---------------------------------------------------------------------------
   * 8. 升压站
   * ------------------------------------------------------------------------ */
  function buildSubstation() {
    var st = SITE.substation;
    var g = st.ground;
    var W = 62, D = 46;
    var cs = [[-W / 2, -D / 2], [W / 2, -D / 2], [W / 2, D / 2], [-W / 2, D / 2]];

    var ring = [];
    for (var i = 0; i < 4; i++) {
      var a = cs[i], b = cs[(i + 1) % 4];
      ring = ring.concat(groundLine(st.x + a[0], st.y + a[1],
                                    st.x + b[0], st.y + b[1], 1.6));
    }
    reg('substation', {
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(ring),
        width: 2.2,
        material: Cesium.Color.fromCssColorString('#f5b942')
      }
    });

    var fill = [];
    for (var k = 0; k < 4; k++) {
      var q = enuToLonLat(st.x + cs[k][0], st.y + cs[k][1]);
      fill.push(q.lon, q.lat, heightAt(st.x + cs[k][0], st.y + cs[k][1]) + 0.8);
    }
    reg('substation', {
      polygon: {
        hierarchy: Cesium.Cartesian3.fromDegreesArrayHeights(fill),
        material: Cesium.Color.fromCssColorString('#2a2f38').withAlpha(0.72),
        perPositionHeight: true
      }
    });

    function building(dx, dy, w, d, h, color) {
      var pp = enuToLonLat(st.x + dx, st.y + dy);
      reg('substation', {
        position: Cesium.Cartesian3.fromDegrees(pp.lon, pp.lat, g + h / 2 + 0.8),
        box: {
          dimensions: new Cesium.Cartesian3(w, d, h),
          material: Cesium.Color.fromCssColorString(color),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#0b1220').withAlpha(0.6)
        }
      });
    }

    building(-6, -12, 26, 14, 8.5, '#c8d2dd');
    building(6, 10, 12, 9, 5.5, '#b9c4d0');
    building(22, 10, 9, 8, 6.0, '#b9c4d0');
    building(-16, 12, 9, 7, 8.0, '#8e99a6');
    building(-16, 0, 9, 7, 8.0, '#8e99a6');

    // 出线构架
    var f0 = enuToLonLat(st.x + 26, st.y - 16);
    var f1 = enuToLonLat(st.x + 26, st.y + 2);
    reg('substation', {
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights([
          f0.lon, f0.lat, g, f0.lon, f0.lat, g + 18,
          f1.lon, f1.lat, g, f1.lon, f1.lat, g + 18,
          f0.lon, f0.lat, g + 18, f1.lon, f1.lat, g + 18
        ]),
        width: 1.6,
        material: Cesium.Color.fromCssColorString('#9fb0c4')
      }
    });

    var lp = enuToLonLat(st.x, st.y + D / 2 + 8);
    reg('substation', {
      position: Cesium.Cartesian3.fromDegrees(lp.lon, lp.lat, g + 15),
      label: {
        text: '110 kV 升压站（示意位置）',
        font: '600 12px "Segoe UI","Microsoft YaHei"',
        fillColor: Cesium.Color.fromCssColorString('#f5b942'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
  }

  /* ---------------------------------------------------------------------------
   * 9. 道路与集电线路：以机位 + 升压站为节点做最小生成树
   * ------------------------------------------------------------------------ */
  function mstEdges(nodes) {
    var n = nodes.length;
    var used = new Array(n).fill(false);
    var best = new Array(n).fill(Infinity);
    var from = new Array(n).fill(-1);
    var edges = [];
    best[0] = 0;
    for (var it = 0; it < n; it++) {
      var u = -1;
      for (var i = 0; i < n; i++) {
        if (!used[i] && (u < 0 || best[i] < best[u])) u = i;
      }
      used[u] = true;
      if (from[u] >= 0) edges.push([from[u], u]);
      for (var v = 0; v < n; v++) {
        if (used[v]) continue;
        var d = Math.hypot(nodes[u].x - nodes[v].x, nodes[u].y - nodes[v].y);
        if (d < best[v]) { best[v] = d; from[v] = u; }
      }
    }
    return edges;
  }

  function buildLines() {
    var nodes = [{ x: SITE.substation.x, y: SITE.substation.y }].concat(
      SITE.turbines.map(function (t) { return { x: t.x, y: t.y }; }));
    var edges = mstEdges(nodes);

    edges.forEach(function (e) {
      var a = nodes[e[0]], b = nodes[e[1]];
      var len = Math.hypot(b.x - a.x, b.y - a.y);

      // 道路：沿直线轻微摆动，避免笔直切坡的观感
      var path = [];
      var n = Math.max(6, Math.ceil(len / 60));
      for (var i = 0; i <= n; i++) {
        var u = i / n;
        var dx = (b.x - a.x) / (len || 1), dy = (b.y - a.y) / (len || 1);
        var bend = Math.sin(u * Math.PI) * 10;
        var x = a.x + (b.x - a.x) * u - dy * bend;
        var y = a.y + (b.y - a.y) * u + dx * bend;
        var p = enuToLonLat(x, y);
        path.push(p.lon, p.lat, heightAt(x, y) + 2.6);
      }
      reg('roads', {
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(path),
          width: 3.4,
          material: Cesium.Color.fromCssColorString('#c3ccd8').withAlpha(0.85)
        }
      });

      // 35 kV 集电线路：与道路同走廊，架空 12 m
      var lp = [];
      for (var j = 0; j <= n; j++) {
        var uu = j / n;
        var dx2 = (b.x - a.x) / (len || 1), dy2 = (b.y - a.y) / (len || 1);
        var bend2 = Math.sin(uu * Math.PI) * 10 + 9;
        var xx = a.x + (b.x - a.x) * uu - dy2 * bend2;
        var yy = a.y + (b.y - a.y) * uu + dx2 * bend2;
        var q = enuToLonLat(xx, yy);
        lp.push(q.lon, q.lat, heightAt(xx, yy) + 12);
      }
      reg('grid', {
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(lp),
          width: 1.4,
          material: new Cesium.PolylineDashMaterialProperty({
            color: Cesium.Color.fromCssColorString('#22d3ee').withAlpha(0.85),
            dashLength: 22
          })
        }
      });
    });

    // 终端塔
    SITE.turbines.forEach(function (t) {
      var tx = t.x - N_L.x * 14, ty = t.y - N_L.y * 14;
      var p = enuToLonLat(tx, ty);
      reg('grid', {
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, heightAt(tx, ty) + 7),
        cylinder: {
          length: 14,
          topRadius: 0.4,
          bottomRadius: 1.1,
          material: Cesium.Color.fromCssColorString('#7d95ad')
        }
      });
    });
  }

  /* ---------------------------------------------------------------------------
   * 10. 测风塔（数据表未给出位置，按场区西侧示意布置）
   * ------------------------------------------------------------------------ */
  function buildMetMast() {
    var mx = SITE.substation.x - 520, my = SITE.substation.y + 260;
    var g = heightAt(mx, my);
    var p = enuToLonLat(mx, my);
    var H = HUB_H;

    reg('metmast', {
      position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, g + H / 2),
      cylinder: {
        length: H, topRadius: 0.5, bottomRadius: 1.1, slices: 8,
        material: Cesium.Color.fromCssColorString('#8d9db0')
      }
    });

    [40, 90, HUB_H - 5].forEach(function (hh) {
      var armEnd = enuToLonLat(mx + 4, my);
      reg('metmast', {
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights([
            p.lon, p.lat, g + hh, armEnd.lon, armEnd.lat, g + hh
          ]),
          width: 1.4,
          material: Cesium.Color.fromCssColorString('#8d9db0')
        }
      });
      reg('metmast', {
        position: Cesium.Cartesian3.fromDegrees(armEnd.lon, armEnd.lat, g + hh + 1.2),
        point: {
          pixelSize: 4,
          color: Cesium.Color.fromCssColorString('#f5b942'),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
    });

    reg('metmast', {
      position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, g + H + 20),
      label: {
        text: '测风塔 ' + H + ' m（位置示意）',
        font: '500 11px "Segoe UI","Microsoft YaHei"',
        fillColor: Cesium.Color.fromCssColorString('#f5b942'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
  }

  /* ---------------------------------------------------------------------------
   * 11. 场景内机位看板（HTML 覆盖层，随相机更新屏幕位置）
   * ------------------------------------------------------------------------ */
  var BOARDS = [];          // {t, el, pos, dist}
  var selectedId = null;
  var boardsHost = document.getElementById('boards');
  var tmpWin = new Cesium.Cartesian2();
  var toWindow = Cesium.SceneTransforms.worldToWindowCoordinates ||
                 Cesium.SceneTransforms.wgs84ToWindowCoordinates;

  function fmtNum(v, d) {
    return Number(v).toFixed(d === undefined ? 0 : d);
  }
  function thousands(v) {
    return Math.round(v).toLocaleString('en-US');
  }

  function boardHTML(t) {
    return '' +
      '<div class="bd-head"><span>' + t.id + '</span><em>' + (t.rated_kw / 1000).toFixed(1) + ' MW</em></div>' +
      '<div class="bd-body">' +
        '<div class="bd-l"><span>风速</span><b>' + fmtNum(t.v_mean, 2) + ' / ' + fmtNum(t.v_wake, 2) +
          '<i>m/s</i></b></div>' +
        '<div class="bd-l"><span>上网</span><b class="a">' + thousands(t.net_mwh) + '<i>MWh</i></b></div>' +
        '<div class="bd-l"><span>等效</span><b>' + thousands(t.hours) + '<i>h</i></b></div>' +
        '<div class="bd-l"><span>轮毂海拔</span><b>' + fmtNum(t.hub_abs, 0) + '<i>m</i></b></div>' +
        '<div class="bd-coord">E ' + Math.round(t.e2000) + '<br>N ' + Math.round(t.n2000) + '</div>' +
      '</div>';
  }

  function buildBoards() {
    SITE.turbines.forEach(function (t) {
      var el = document.createElement('div');
      el.className = 'board hide';
      el.innerHTML = boardHTML(t);
      el.addEventListener('click', function (ev) {
        ev.stopPropagation();
        selectTurbine(t.id, true);
      });
      boardsHost.appendChild(el);
      BOARDS.push({
        t: t,
        el: el,
        pos: xyz(t.x, t.y, t.hub_abs + ROTOR_R + 8)
      });
    });
  }

  function updateBoards() {
    if (!BOARDS_ON) {
      for (var k = 0; k < BOARDS.length; k++) BOARDS[k].el.classList.add('hide');
      return;
    }

    var cam = scene.camera.positionWC;
    var cw = scene.canvas.clientWidth, ch = scene.canvas.clientHeight;
    var vis = [];

    for (var i = 0; i < BOARDS.length; i++) {
      var b = BOARDS[i];
      var d = Cesium.Cartesian3.distance(cam, b.pos);
      if (d > 14000) { b.el.classList.add('hide'); continue; }

      var win = toWindow(scene, b.pos, tmpWin);
      if (!win || !isFinite(win.x) || !isFinite(win.y) ||
          win.x < -160 || win.x > cw + 160 || win.y < -80 || win.y > ch + 80) {
        b.el.classList.add('hide');
        continue;
      }
      b.el.classList.remove('hide');

      var mini = d > 2600 && b.t.id !== selectedId;
      b.el.classList.toggle('mini', mini);
      vis.push({
        el: b.el,
        x: win.x, y: win.y,
        w: mini ? 96 : 152,
        h: mini ? 22 : 78
      });
    }

    // 屏幕内避让：按纵坐标自下而上排列，重叠时整体上移，保证 8 块看板互不遮盖
    vis.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    for (var m = 0; m < vis.length; m++) {
      var cur = vis[m];
      for (var pass = 0; pass < 10; pass++) {
        var moved = false;
        for (var n = 0; n < m; n++) {
          var o = vis[n];
          if (Math.abs(cur.x - o.x) < (cur.w + o.w) / 2 + 4 &&
              Math.abs(cur.y - o.y) < (cur.h + o.h) / 2 + 4) {
            cur.y = o.y - (o.h + cur.h) / 2 - 5;
            moved = true;
          }
        }
        if (!moved) break;
      }
      // 纵向限位：不进顶栏，不压底部工具条与图例
      var y = Math.min(Math.max(cur.y, 78 + cur.h), ch - 96);
      var x = Math.min(Math.max(cur.x, 60), cw - 60);
      cur.el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) ' +
                               'translate(-50%,-100%)';
    }
  }

  scene.postRender.addEventListener(updateBoards);

  /* ---------------------------------------------------------------------------
   * 12. 相机
   * ------------------------------------------------------------------------ */
  var HOME = null;
  var selRing = null;

  /** 场区包围球：由控制范围顶点按地形高程生成，用于自动取景 */
  function siteSphere() {
    var pts = SITE.boundary_polygon.map(function (p) {
      return xyz(p[0], p[1], heightAt(p[0], p[1]));
    });
    return Cesium.BoundingSphere.fromPoints(pts);
  }

  function setHome() {
    var sphere = siteSphere();
    HOME = {
      sphere: sphere,
      oblique: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-46), sphere.radius * 2.45),
      top: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-89.5), sphere.radius * 2.85)
    };
  }

  function goHome(duration) {
    viewer.camera.flyToBoundingSphere(HOME.sphere, {
      offset: HOME.oblique,
      duration: duration === undefined ? 1.8 : duration
    });
  }

  function goTop(duration) {
    viewer.camera.flyToBoundingSphere(HOME.sphere, {
      offset: HOME.top,
      duration: duration === undefined ? 1.6 : duration
    });
  }

  function flyToTurbine(t) {
    // 沿叶轮朝向（来风方向）侧后退约 5 倍叶轮半径取景：
    // 相机站在上风向，正对叶轮盘面，叶片不会被看成一个点或一条线
    var dist = ROTOR_R * 4.6;
    var px = t.x + N_L.x * dist;
    var py = t.y + N_L.y * dist;
    var p = enuToLonLat(px, py);
    var camAlt = t.ground + ROTOR_R * 1.0;
    var pitch = Math.atan2(t.hub_abs - camAlt, dist) * 180 / Math.PI;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, camAlt),
      orientation: {
        heading: AZ_RAD + Math.PI,          // 由相机指向机位
        pitch: Cesium.Math.toRadians(pitch),
        roll: 0
      },
      duration: 1.6
    });
  }

  function selectTurbine(id, fly) {
    selectedId = id;
    var t = SITE.turbines.filter(function (x) { return x.id === id; })[0];
    if (!t) return;

    document.querySelectorAll('.wt').forEach(function (n) {
      n.classList.toggle('active', n.dataset.wt === id);
    });
    BOARDS.forEach(function (b) {
      b.el.classList.toggle('sel', b.t.id === id);
      if (b.t.id === id) b.el.classList.remove('mini');
    });

    if (selRing) {
      selRing.position = Cesium.Cartesian3.fromDegrees(
        enuToLonLat(t.x, t.y).lon, enuToLonLat(t.x, t.y).lat, t.ground + 2.0);
      selRing.show = true;
    }

    renderDetail(t);
    if (fly) flyToTurbine(t);
  }

  /* ---------------------------------------------------------------------------
   * 13. UI 渲染
   * ------------------------------------------------------------------------ */
  function setHTML(id, html) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }
  function setText(id, txt) {
    var el = document.getElementById(id);
    if (el) el.textContent = txt;
  }
  function unit(v, u) {
    return v + '<span class="unit">' + u + '</span>';
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, ms || 4500);
  }

  function renderPanel() {
    document.getElementById('projLine').textContent =
      SITE.admin + '　|　' + E.capacity_mw.toFixed(0) + ' MW（' + MACH.count + ' × ' +
      MACH.rated_mw.toFixed(1) + ' MW）· 实测机位';

    setText('csLine', SITE.coord_system);
    setText('origLine', 'E ' + thousands(SITE.center_e2000) + '　N ' + thousands(SITE.center_n2000));

    // 机组
    setHTML('capTotal', E.capacity_mw.toFixed(1) + unit('', 'MW'));
    setText('wtNum', MACH.count + ' 台');
    setHTML('capUnit', MACH.rated_mw.toFixed(2) + unit('', 'MW'));
    setHTML('rotorD', MACH.rotor_d.toFixed(0) + unit('', 'm'));
    setHTML('hubH', HUB_H.toFixed(0) + unit('', 'm'));

    var swept = Math.PI * Math.pow(MACH.rotor_d / 2, 2);
    setHTML('swept', thousands(swept) + unit('', 'm²'));
    setHTML('specPow', (MACH.rated_kw * 1000 / swept).toFixed(0) + unit('', 'W/m²'));
    setText('rotorNote', MACH.rotor_d_note);

    // 场区
    setText('crs', 'CGCS2000 3°带 38 带');
    setHTML('siteExt', (SITE.boundary_m[0] / 1000).toFixed(2) + ' × ' +
                        (SITE.boundary_m[1] / 1000).toFixed(2) + unit('', 'km'));
    setHTML('siteArea', SITE.area_km2.toFixed(2) + unit('', 'km²'));

    var tr = SITE.terrain;
    setHTML('elevRange', tr.min + ' ~ ' + tr.max + unit('', 'm'));
    setHTML('relief', tr.relief + unit('', 'm'));
    setHTML('meanSlope', tr.mean_slope.toFixed(1) + unit('', '°'));
    setHTML('maxSlope', tr.max_slope.toFixed(1) + unit('', '°'));

    // 电量
    setHTML('vMean', E.v_mean.toFixed(2) + unit('', 'm/s'));
    setHTML('vWake', E.v_wake_mean.toFixed(2) + unit('', 'm/s'));
    setHTML('grossAep', thousands(E.gross_mwh) + unit('', 'MWh'));
    setText('wakeL', E.wake_loss_mean.toFixed(1) + ' %');
    setHTML('netAep', thousands(E.net_mwh) + unit('', 'MWh'));
    setHTML('hours', thousands(E.hours_net) + unit('', 'h'));
    setText('cfn', (E.cf_net * 100).toFixed(1) + ' %');
    setText('reduc', '− ' + (E.reduction_mean * 100).toFixed(1) + ' %');

    // 核对
    setText('chkCoord', SITE.checks.coord_roundtrip_max_m.toFixed(3) + ' m');
    setHTML('minDist', SITE.checks.min_spacing_m.toFixed(0) + unit('', 'm'));
    setText('minDistD', SITE.checks.min_spacing_D.toFixed(2) + ' D');
    setText('demDiff', '± ' + SITE.checks.dem_diff_max_m.toFixed(1) + ' m');

    setText('wtCount', MACH.count + ' 台');

    // 机位清单
    var list = document.getElementById('wtList');
    var maxNet = Math.max.apply(null, SITE.turbines.map(function (t) { return t.net_mwh; }));
    list.innerHTML = '';
    SITE.turbines.forEach(function (t) {
      var el = document.createElement('div');
      el.className = 'wt';
      el.dataset.wt = t.id;
      el.innerHTML =
        '<div class="id">' + t.id + '<small>' + fmtNum(t.v_mean, 2) + ' m/s</small></div>' +
        '<div class="mid">' +
          '<div class="meta">上网 <span>' + thousands(t.net_mwh) + '</span> MWh</div>' +
          '<div class="bar"><i style="width:' + (t.net_mwh / maxNet * 100).toFixed(1) + '%"></i></div>' +
        '</div>' +
        '<div class="hrs">' + thousands(t.hours) + ' h</div>';
      el.addEventListener('click', function () {
        selectTurbine(t.id, true);
      });
      list.appendChild(el);
    });
  }

  function renderDetail(t) {
    var host = document.getElementById('wtDetail');
    var r = function (k, v, cls) {
      return '<div class="row"><span class="k">' + k + '</span><span class="v ' +
             (cls || '') + '">' + v + '</span></div>';
    };
    host.innerHTML =
      '<div class="detail-head">' +
        '<span class="d-id">' + t.id + '</span>' +
        '<span class="d-cap">' + (t.rated_kw / 1000).toFixed(2) + ' MW · CF ' +
        (t.cf * 100).toFixed(1) + '%</span>' +
      '</div>' +
      '<div class="detail-grid">' +
        r('E(2000)', Math.round(t.e2000)) +
        r('N(2000)', Math.round(t.n2000)) +
        '<div class="row full"><span class="k">经纬度</span><span class="v">' +
          fmtNum(t.lon, 6) + '°E　' + fmtNum(t.lat, 6) + '°N</span></div>' +
        r('地面高程(实测)', t.ground.toFixed(2) + ' m') +
        r('地形模型', t.ground_dem.toFixed(1) + ' m') +
        r('轮毂高度', t.hub_h.toFixed(0) + ' m') +
        r('轮毂海拔', t.hub_abs.toFixed(1) + ' m') +
        r('平均风速', t.v_mean.toFixed(2) + ' m/s') +
        r('尾流后风速', t.v_wake.toFixed(2) + ' m/s') +
        r('理论发电量', thousands(t.gross_mwh) + ' MWh') +
        r('尾流损失', t.wake_loss.toFixed(1) + ' %', 'warn') +
        r('年上网电量', thousands(t.net_mwh) + ' MWh', 'hl') +
        r('等效满发小时', thousands(t.hours) + ' h', 'hl') +
        r('综合折减', (t.reduction * 100).toFixed(1) + ' %', 'warn') +
        r('机位坡度', t.slope.toFixed(1) + '°',
          t.slope <= 5 ? 'good' : (t.slope <= 10 ? 'warn' : 'bad')) +
      '</div>';
  }

  function bindUI() {
    var btnSpin = document.getElementById('btnSpin');
    btnSpin.addEventListener('click', function () {
      spinOn = !spinOn;
      btnSpin.classList.toggle('on', spinOn);
    });

    document.getElementById('btnBoards').addEventListener('click', function () {
      BOARDS_ON = !BOARDS_ON;
      this.classList.toggle('on', BOARDS_ON);
      scene.requestRender();
    });

    function toggleBtn(id, group) {
      var btn = document.getElementById(id);
      btn.addEventListener('click', function () {
        var on = !btn.classList.contains('on');
        btn.classList.toggle('on', on);
        groups[group].forEach(function (en) { en.show = on; });
        scene.requestRender();
      });
    }
    toggleBtn('btnBoundary', 'boundary');
    toggleBtn('btnRoad', 'roads');
    toggleBtn('btnGrid', 'grid');

    // 底图源菜单
    document.getElementById('btnBase').addEventListener('click', function (ev) {
      ev.stopPropagation();
      var pop = document.getElementById('bmPop');
      if (pop.classList.contains('open')) closeBasemapMenu(); else openBasemapMenu();
    });
    document.addEventListener('click', function (ev) {
      if (!document.getElementById('bmPop').classList.contains('open')) return;
      if (ev.target.closest && ev.target.closest('#bmPop, #btnBase')) return;
      closeBasemapMenu();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeBasemapMenu();
    });
    window.addEventListener('resize', function () {
      if (document.getElementById('bmPop').classList.contains('open')) openBasemapMenu();
    });

    var rg = document.getElementById('rgSpeed');
    var sv = document.getElementById('spdVal');
    rg.addEventListener('input', function () {
      spinSpeed = parseFloat(rg.value);
      sv.textContent = spinSpeed.toFixed(1) + '×';
    });

    document.getElementById('btnHome').addEventListener('click', function () { goHome(); });
    document.getElementById('btnTop').addEventListener('click', function () { goTop(); });

    var handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
    handler.setInputAction(function (click) {
      var picked = scene.pick(click.position);
      if (Cesium.defined(picked) && picked.id && picked.id.wt) {
        selectTurbine(picked.id.wt, false);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  /* ---------------------------------------------------------------------------
   * 14. 加载遮罩
   * ------------------------------------------------------------------------ */
  function setLoad(pct, text) {
    var bar = document.getElementById('ldBar');
    if (bar) bar.style.width = pct + '%';
    if (text) setText('ldSub', text);
  }
  function hideLoader() {
    var ld = document.getElementById('loader');
    if (ld) ld.classList.add('hide');
  }
  function nextFrame() {
    return new Promise(function (r) { setTimeout(r, 24); });
  }

  /* ---------------------------------------------------------------------------
   * 15. 启动
   * ------------------------------------------------------------------------ */
  function boot() {
    return nextFrame()
      .then(function () {
        setLoad(24, '构建场区控制范围…');
        return nextFrame();
      })
      .then(function () {
        buildBoundary();
        setLoad(38, '生成 ' + MACH.count + ' 台 ' + MACH.rated_mw.toFixed(1) +
                    ' MW 风机模型（按实测机位）…');
        return nextFrame();
      })
      .then(function () {
        SITE.turbines.forEach(function (t) { buildTurbine(t); });
        setLoad(58, '布置升压站、道路与集电线路…');
        return nextFrame();
      })
      .then(function () {
        buildSubstation();
        buildLines();
        buildMetMast();

        // 选中环
        selRing = viewer.entities.add({
          show: false,
          position: Cesium.Cartesian3.fromDegrees(CTR.lon, CTR.lat, BASE_ELEV),
          ellipse: {
            semiMajorAxis: 55, semiMinorAxis: 55,
            material: Cesium.Color.fromCssColorString('#22d3ee').withAlpha(0.12)
          }
        });

        buildBoards();
        setLoad(76, '加载卫星影像与地形瓦片…');
        renderPanel();
        bindUI();
        setHome();
        goHome(0);

        // 默认选中装机最大的机位，面板直接有内容
        var best = SITE.turbines.slice().sort(function (a, b) { return b.net_mwh - a.net_mwh; })[0];
        selectTurbine(best.id, false);
        return nextFrame();
      })
      .then(function () {
        var done = false;
        var timer = setTimeout(function () {
          if (!done) { done = true; setLoad(100, '就绪'); hideLoader(); }
        }, 12000);

        var remove = scene.globe.tileLoadProgressEvent.addEventListener(function (queued) {
          if (done) return;
          if (queued > 0) {
            setLoad(92, '加载地形与卫星影像…');
          } else {
            done = true;
            clearTimeout(timer);
            setLoad(100, '就绪');
            setTimeout(hideLoader, 480);
            remove();
          }
        });
        scene.requestRender();
      });
  }

  // 对外调试 / 二次开发接口
  window.__DT = {
    viewer: viewer,
    scene: scene,
    data: DATA,
    enuToLonLat: enuToLonLat,
    lonLatToEnu: lonLatToEnu,
    heightAt: heightAt,
    setBasemap: function (id) {
      var d = BASEMAPS.filter(function (b) { return b.id === id; })[0];
      if (d && !d.disabled) applyBasemap(d);
    },
    goHome: goHome,
    selectTurbine: selectTurbine
  };

  boot();
})();
