/* =============================================================================
 * 凉城 60 MW 陆上风电项目 · 三维数字孪生
 * -----------------------------------------------------------------------------
 * 数据来源
 *   机位 / 电量：风场数据/风电场.xlsx「风机数据」表（8 台实测数据）
 *   坐标：CGCS2000 3° 带第 38 带（中央经线 114°E），由 src/coord2000.py 反算经纬度
 *   地形：ASTER GDEM v3（30 m），分级采样后内嵌于 data/site-data.js
 *   影像：Esri / 天地图 / EOX 公开服务
 * 工程约束（改造时不得改动）
 *   1) 投影反算、局部 ENU 映射、分级融合高度函数为工程基准，公式保持原样；
 *   2) 机位平面位置与地面高程以实测数据表为准，不因视觉需要做任何位移或插值；
 *   3) 塔筒自实测地面起算，轮毂海拔 = 实测地面 + 轮毂高度；
 *   4) 前端不含业务数字硬编码，全部从 SITE_DATA 读取。
 * 状态约定
 *   全部界面状态收敛于唯一的 state 对象，UI 一律由 state 派生，不各存一份。
 * ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------------------
   * 0. 运行环境与数据
   * ------------------------------------------------------------------------ */
  function fatal(title, html) {
    var ld = document.getElementById('loader');
    if (!ld) return;
    ld.classList.remove('hide');
    ld.innerHTML = '<div class="err-box"><h3>' + title + '</h3><div>' + html + '</div></div>';
  }

  if (!window.Cesium) {
    fatal('三维引擎未能加载',
      'CesiumJS 未就绪。请确认 <code>libs/cesium/</code> 目录完整，或网络可访问 CDN 回退地址。');
    return;
  }

  var DATA = window.SITE_DATA;
  if (!DATA || !DATA.site || !DATA.site.turbines) {
    fatal('工程数据缺失',
      '未找到有效的 <code>data/site-data.js</code>。请依次执行 ' +
      '<code>src/import_windfarm.py</code> → <code>src/fetch_dem.py</code> → ' +
      '<code>src/build_js_data.py</code> 生成数据。');
    return;
  }

  var SITE = DATA.site;
  var MACH = SITE.machine;
  var ENERGY = SITE.energy;
  var TERRAIN = SITE.terrain;
  var CHECKS = SITE.checks;
  var CTR = DATA.center;
  var BLEND = DATA.terrainBlend;
  var BASE_ELEV = BLEND.base;

  var A_AXIS = 6378137.0;
  var E2 = 0.00669437999014;

  var ROTOR_R = MACH.rotor_d / 2;
  var BLADE_LEN = ROTOR_R - 2.0;
  var HUB_H = MACH.hub_h;
  var WIND_AZ = 315;                 // 主导风向来向（数据表未给出）
  var RATED_RPM = 8.4;               // 叶轮转速基数（动画用，非数据表值）
  var DEG_LAT = 111033.0;
  var DEG_LON = 111320.0 * Math.cos(CTR.lat * Math.PI / 180);

  /* ---------------------------------------------------------------------------
   * 1. 状态（单一状态源）
   * ------------------------------------------------------------------------ */
  var state = {
    mode: 'view',          // view | present
    tab: 'overview',       // overview | layout (energy) | gridline | roads
    labelMode: 'overview', // overview | layout | detail
    camPreset: 'overview', // overview | top | oblique | unit
    selected: null,        // 机位 id
    sort: 'net',           // net | id
    layers: { turbines: true, turbineLabels: true, towerLabels: true, boundary: false, roads: true, grid: true },
    basemap: null,
    presentIdx: 0,
    energyHour: 0,
    dockTab: 'scene',
    spin: false,          // 叶轮旋转
    spinSpeed: 1.0,      // 转速倍率
    roadStyle: { color: "#ffb020", width_m: 6, widthScale: 1.0, transparency: 0.10 },
    gridScale: 2.0,      // 杆塔、挂点和线路标签的独立显示倍率
    turbineScale: 2.0,   // 风机模型显示放大倍数（仅视觉，不改坐标与高程）
    // 三块面板的收起状态（true = 展开）
    ui: { left: true, dock: true, right: true }
  };

  var TURBINES = SITE.turbines;
  var T_BY_ID = {};
  TURBINES.forEach(function (t) { T_BY_ID[t.id] = t; });

  // 35 kV 集电线路：杆塔（实测塔位）+ 塔型几何参数（由 src/import_gridline.py 与
  // src/make_tower_glb.py 生成，前端不硬编码任何塔型尺寸）
  var GRID = DATA.gridline || null;
  var TOWERS = GRID ? GRID.towers : [];
  var TW_TYPES = DATA.towerTypes || {};
  var TW_BY_ID = {};
  TOWERS.forEach(function (t) { TW_BY_ID[t.id] = t; });

  var NETS = TURBINES.map(function (t) { return t.net_mwh; });
  var MAX_NET = Math.max.apply(null, NETS);
  var MIN_NET = Math.min.apply(null, NETS);

  /* ---------------------------------------------------------------------------
   * 2. 格式化工具
   * ------------------------------------------------------------------------ */
  function $(id) { return document.getElementById(id); }
  function setT(id, v) { var e = $(id); if (e) e.textContent = v; }

  function n0(v) { return Math.round(v).toLocaleString('en-US'); }
  function n1(v) { return Number(v).toFixed(1); }
  function n2(v) { return Number(v).toFixed(2); }
  function signed(v, d) {
    d = d === undefined ? 1 : d;
    if (v === 0) return '±' + (0).toFixed(d);
    return (v > 0 ? '+' : '−') + Math.abs(v).toFixed(d);
  }

  var toastTimer = null;
  function toast(msg, isErr, ms) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, ms || 4200);
  }

  /* ---------------------------------------------------------------------------
   * 3. 坐标与地形（工程基准，公式不得改动）
   * ------------------------------------------------------------------------ */
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

  var heightAt = window.createTerrainHeight(DATA);

  function lonLatToEnu(lon, lat) {
    return { x: (lon - CTR.lon) * DEG_LON, y: (lat - CTR.lat) * DEG_LAT };
  }

  function xyz(x, y, h) {
    var p = enuToLonLat(x, y);
    return Cesium.Cartesian3.fromDegrees(p.lon, p.lat, h);
  }

  /* ---------------------------------------------------------------------------
   * 4. 地形服务
   * ------------------------------------------------------------------------ */
  var TILE_N = 32;
  var tilingScheme = new Cesium.GeographicTilingScheme();
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
   * 5. 场景
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
    shouldAnimate: true,
    // 纯 3D：杆塔用 Primitive 承载（Geometries 在 2D/CV 模式下需要额外的
    // boundingSphereCV，纯 3D 可省去该分支，同时减少内部状态与显存）
    scene3DOnly: true
  });

  var scene = viewer.scene;

  var compassNeedle = document.getElementById('northNeedle');
  var compassAngle = null;
  scene.postRender.addEventListener(function () {
    if (!compassNeedle) return;
    var angle = -Cesium.Math.toDegrees(viewer.camera.heading);
    if (compassAngle !== null && Math.abs(angle-compassAngle) < 0.05) return;
    compassAngle = angle;
    compassNeedle.setAttribute('transform', 'rotate(' + angle.toFixed(2) + ' 40 40)');
  });


  // CAD navigation: middle drag pans, Shift+middle orbits, wheel zooms.
  // In Cesium 3D, rotateEventTypes drives surface panning; tilt drives orbit.
  var cameraControls = scene.screenSpaceCameraController;
  cameraControls.rotateEventTypes = [Cesium.CameraEventType.MIDDLE_DRAG];
  cameraControls.translateEventTypes = [Cesium.CameraEventType.MIDDLE_DRAG];
  cameraControls.tiltEventTypes = [Cesium.CameraEventType.PINCH];
  cameraControls.zoomEventTypes = [Cesium.CameraEventType.WHEEL, Cesium.CameraEventType.PINCH];
  cameraControls.lookEventTypes = [];
  cameraControls.inertiaSpin = 0;
  cameraControls.inertiaTranslate = 0;
  cameraControls.inertiaZoom = 0;
  // Prevent browser middle-click autoscroll without blocking Cesium input.
  scene.canvas.addEventListener('mousedown', function (event) {
    if (event.button === 1) event.preventDefault();
  });


  // Lock a local orbit pivot once per Shift+middle gesture. Cesium's globe
  // tilt changes its pivot near terrain and can swing a close-up out of view.
  var orbitDrag = null;
  var orbitInput = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  function startLocalOrbit(event) {
    var camera = viewer.camera, pivot;
    if (scene.pickPositionSupported) {
      try { pivot = scene.pickPosition(event.position); } catch (ignore) { /* sky */ }
    }
    var center = new Cesium.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
    if (!pivot && scene.pickPositionSupported) {
      try { pivot = scene.pickPosition(center); } catch (ignore) { /* sky */ }
    }
    if (!pivot) {
      var ray = camera.getPickRay(center);
      if (ray) pivot = scene.globe.pick(ray, scene);
    }
    if (!pivot) return;
    camera.cancelFlight();
    var frame = Cesium.Transforms.eastNorthUpToFixedFrame(pivot);
    var inverse = Cesium.Matrix4.inverseTransformation(frame, new Cesium.Matrix4());
    var offset = Cesium.Matrix4.multiplyByPoint(inverse, camera.positionWC, new Cesium.Cartesian3());
    var radius = Cesium.Cartesian3.magnitude(offset);
    if (!Number.isFinite(radius) || radius < 0.1) return;
    orbitDrag = {pivot:Cesium.Cartesian3.clone(pivot), radius:radius,
      azimuth:Math.atan2(offset.y,offset.x), elevation:Math.asin(offset.z/radius),
      x:event.position.x, y:event.position.y};
    cameraControls.enableInputs = false;
  }
  function stopLocalOrbit() {
    if (!orbitDrag) return;
    orbitDrag = null;
    cameraControls.enableInputs = true;
  }
  orbitInput.setInputAction(startLocalOrbit, Cesium.ScreenSpaceEventType.MIDDLE_DOWN, Cesium.KeyboardEventModifier.SHIFT);
  function moveLocalOrbit(event) {
    if (!orbitDrag) return;
    var drag = orbitDrag, point = event.endPosition;
    var dx = point.x-drag.x, dy = point.y-drag.y;
    drag.x=point.x; drag.y=point.y;
    // Fixed angular gain, independent of altitude or distance to the globe.
    drag.azimuth -= dx * 0.002;
    drag.elevation = Math.max(0.02, Math.min(Math.PI/2-0.02, drag.elevation+dy*0.002));
    var horizontal = drag.radius * Math.cos(drag.elevation);
    viewer.camera.lookAt(drag.pivot, new Cesium.Cartesian3(horizontal*Math.cos(drag.azimuth), horizontal*Math.sin(drag.azimuth), drag.radius*Math.sin(drag.elevation)));
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    scene.requestRender();
  }
  orbitInput.setInputAction(moveLocalOrbit, Cesium.ScreenSpaceEventType.MOUSE_MOVE, Cesium.KeyboardEventModifier.SHIFT);
  orbitInput.setInputAction(stopLocalOrbit, Cesium.ScreenSpaceEventType.MIDDLE_UP, Cesium.KeyboardEventModifier.SHIFT);
  orbitInput.setInputAction(stopLocalOrbit, Cesium.ScreenSpaceEventType.MIDDLE_UP);
  window.addEventListener('mouseup', stopLocalOrbit);
  window.addEventListener('blur', stopLocalOrbit);
  window.addEventListener('keyup', function(event){ if(event.key==='Shift') stopLocalOrbit(); });


  scene.backgroundColor = Cesium.Color.fromCssColorString('#05080e');
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#0d141d');
  scene.globe.enableLighting = false;
  // 允许贴近地面观察杆塔（塔高 30.7 m，默认阈值会把相机推高到 300 m 以上），
  // 仍需保留碰撞检测，避免相机钻入地形。
  scene.screenSpaceCameraController.minimumCollisionTerrainHeight = 60;
  scene.globe.depthTestAgainstTerrain = true;
  scene.globe.maximumScreenSpaceError = 1.6;   // 近景地形更细，代价是瓦片请求增多
  scene.globe.showGroundAtmosphere = true;
  scene.fog.enabled = true;
  scene.fog.density = 0.000060;   // 远场雾化，弱化地形边界硬线
  scene.skyAtmosphere.show = true;
  scene.skyAtmosphere.hueShift = -0.02;
  scene.postProcessStages.fxaa.enabled = true;

  viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date(Date.UTC(2026, 9, 20, 3, 45, 0)));
  viewer.clock.shouldAnimate = false;

  /* ---------------------------------------------------------------------------
   * 6. 底图源
   * ------------------------------------------------------------------------ */
  var CFG = window.APP_CONFIG || {};
  var TIANDITU_KEY = CFG.tiandituKey || '';
  var ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  var TDT_SUB = ['0', '1', '2', '3', '4', '5', '6', '7'];

  function tdtUrl(layer) {
    return 'https://t{s}.tianditu.gov.cn/' + layer + '_w/wmts' +
           '?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
           '&LAYER=' + layer + '&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles' +
           '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=' + TIANDITU_KEY;
  }

  var BASEMAPS = [
    {
      group: '影像', id: 'esri-sat', short: '卫星影像', name: '卫星影像',
      org: 'Esri World Imagery', res: '0.3–0.6 m',
      url: ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}',
      max: 19, bright: 1.24, contrast: 1.06, sat: 1.02,
      credit: 'Imagery © Esri, Maxar, Earthstar Geographics'
    },
    {
      group: '影像', id: 'tdt-sat', short: '天地图注记', name: '卫星影像 + 中文注记',
      org: '天地图 img + cia', res: '0.5–2 m',
      url: tdtUrl('img'), subdomains: TDT_SUB,
      max: 18, bright: 1.12, contrast: 1.04, sat: 1.06,
      credit: '© 天地图 国家地理信息公共服务平台',
      labels: { url: tdtUrl('cia'), subdomains: TDT_SUB, max: 18, credit: '© 天地图 注记' },
      disabled: !TIANDITU_KEY, disabledNote: '需 tk'
    },
    {
      group: '影像', id: 'esri-sat-lbl', short: '英文注记', name: '卫星影像 + 英文注记',
      org: 'Esri World Imagery + Reference', res: '英文注记',
      url: ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}',
      max: 19, bright: 1.24, contrast: 1.06, sat: 1.02,
      credit: 'Imagery © Esri; Labels © Esri',
      labels: {
        url: ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
        max: 18, credit: 'Labels © Esri'
      }
    },
    {
      group: '影像', id: 'eox-s2', short: 'Sentinel-2', name: 'Sentinel-2 无云合成',
      org: 'EOX · 2020 年', res: '10 m',
      url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg',
      max: 16, bright: 1.20, contrast: 1.05, sat: 1.04,
      credit: 'Sentinel-2 cloudless © EOX IT Services GmbH (CC BY-NC-SA 4.0)'
    },
    {
      group: '地形', id: 'tdt-ter', short: '天地图地形', name: '地形图 · 天地图',
      org: '天地图 ter + cta', res: '中文地形',
      url: tdtUrl('ter'), subdomains: TDT_SUB,
      max: 18, bright: 0.94, contrast: 1.12, sat: 0.96,
      credit: '© 天地图 国家地理信息公共服务平台',
      labels: { url: tdtUrl('cta'), subdomains: TDT_SUB, max: 18, credit: '© 天地图 注记' },
      disabled: !TIANDITU_KEY, disabledNote: '需 tk'
    },
    {
      group: '地形', id: 'esri-relief', short: '晕渲地貌', name: '晕渲地貌',
      org: 'Esri Shaded Relief', res: '30 m',
      url: ESRI + 'World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}',
      max: 13, bright: 0.98, contrast: 1.20, sat: 0.86,
      credit: 'Relief © Esri'
    },
    {
      group: '地形', id: 'esri-topo', short: '地形图', name: '地形图 · Esri',
      org: 'Esri World Topographic', res: '≤13 级',
      url: ESRI + 'World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
      max: 13, bright: 0.96, contrast: 1.04, sat: 0.98,
      credit: '© Esri, HERE, Garmin, USGS'
    },
    {
      group: '地形', id: 'esri-street', short: '街道图', name: '街道图 · Esri',
      org: 'Esri World Street Map', res: '≤13 级',
      url: ESRI + 'World_Street_Map/MapServer/tile/{z}/{y}/{x}',
      max: 13, bright: 0.96, contrast: 1.04, sat: 0.98,
      credit: '© Esri, HERE, Garmin, USGS'
    }
  ];

  var bmBase = null, bmLabel = null;

  function bmProvider(def) {
    var opt = { url: def.url, maximumLevel: def.max, credit: def.credit, hasAlphaChannel: true };
    if (def.subdomains) opt.subdomains = def.subdomains;
    return new Cesium.UrlTemplateImageryProvider(opt);
  }

  function clearBasemap() {
    if (bmLabel) { viewer.imageryLayers.remove(bmLabel, true); bmLabel = null; }
    if (bmBase) { viewer.imageryLayers.remove(bmBase, true); bmBase = null; }
  }

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
        url: def.labels.url, max: def.labels.max,
        credit: def.labels.credit, subdomains: def.labels.subdomains
      }));
      bmLabel.brightness = 1.0;
    }

    state.basemap = def.id;
    try { localStorage.setItem('dt.basemap', def.id); } catch (e) { /* 隐私模式忽略 */ }

    if (!isRevert) {
      setTimeout(function () {
        if (errCount >= 4 && state.basemap === def.id) {
          toast('底图「' + def.name + '」有 ' + errCount + ' 个瓦片加载失败，已回退到卫星影像', true);
          applyBasemap(BASEMAPS[0], true);
        }
      }, 8000);
    }
    if ($('bmPop')) renderBasemapMenu();
    scene.requestRender();
  }

  function initBasemap() {
    var saved = null;
    try { saved = localStorage.getItem('dt.basemap'); } catch (e) { /* 忽略 */ }
    var def = BASEMAPS[0];
    for (var i = 0; i < BASEMAPS.length; i++) {
      if (BASEMAPS[i].id === saved && !BASEMAPS[i].disabled) { def = BASEMAPS[i]; break; }
    }
    applyBasemap(def);
  }

  /* ---------------------------------------------------------------------------
   * 7. 图元容器
   * ------------------------------------------------------------------------ */
  var groups = { boundary: [], roads: [], grid: [], tower: [], conductor: [],
               turbine: [], substation: [], metmast: [] };

  function reg(group, opts) {
    var e = viewer.entities.add(opts);
    groups[group].push(e);
    if (opts.wt) e.addProperty('wt', opts.wt);
    if (opts.tw) e.addProperty('tw', opts.tw);
    return e;
  }

  function tagWt(opts, id) {
    opts.wt = id;
    return opts;
  }

  function tagTower(opts, id) {
    opts.tw = id;
    return opts;
  }

  var LINE_STEP = 40;

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
   * 8. 场区控制范围
   * ------------------------------------------------------------------------ */
  function buildBoundary() {
    var poly = SITE.boundary_polygon;
    var n = poly.length;
    var ring = [];

    for (var i = 0; i < n; i++) {
      var a = poly[i], b = poly[(i + 1) % n];
      var seg = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / LINE_STEP));
      for (var s = 0; s < seg; s++) {
        var u = s / seg;
        var x = a[0] + (b[0] - a[0]) * u;
        var y = a[1] + (b[1] - a[1]) * u;
        var q = enuToLonLat(x, y);
        ring.push(q.lon, q.lat, heightAt(x, y) + 18);
      }
    }
    var p0 = enuToLonLat(poly[0][0], poly[0][1]);
    ring.push(p0.lon, p0.lat, heightAt(poly[0][0], poly[0][1]) + 18);

    reg('boundary', {
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(ring),
        width: 2.6,
        material: new Cesium.ColorMaterialProperty(
          Cesium.Color.fromCssColorString('#fbbf24').withAlpha(0.9))
      }
    });

    for (var k = 0; k < n; k++) {
      reg('boundary', {
        position: xyz(poly[k][0], poly[k][1], heightAt(poly[k][0], poly[k][1]) + 2),
        point: {
          pixelSize: 3.5,
          color: Cesium.Color.fromCssColorString('#fbbf24'),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.55),
          outlineWidth: 1.5,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
    }
  }

  /* ---------------------------------------------------------------------------
   * 9. 风机模型（尺寸全部由 machine 字段换算）
   * ------------------------------------------------------------------------ */
  var AZ_RAD = WIND_AZ * Math.PI / 180;
  var N_L = new Cesium.Cartesian3(Math.sin(AZ_RAD), Math.cos(AZ_RAD), 0);
  var UP_L = new Cesium.Cartesian3(0, 0, 1);
  var T_L = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(UP_L, N_L, new Cesium.Cartesian3()), new Cesium.Cartesian3());

  var spin = 0, lastT = 0;

  scene.preUpdate.addEventListener(function () {
    var now = Date.now();
    var dt = lastT ? (now - lastT) / 1000 : 0;
    lastT = now;
    if (dt > 0.12) dt = 0.12;
    if (state.spin) spin += dt * RATED_RPM * 6 * state.spinSpeed;
    if (spin > 360) spin -= 360;
  });

  var TOWER_COLOR = Cesium.Color.fromCssColorString('#e2e8f0');
  var NAC_COLOR = Cesium.Color.fromCssColorString('#e8eef5');
  var BLADE_COLOR = Cesium.Color.fromCssColorString('#f2f6fa');

  /**
   * 单台风机建模。
   * SC 为「模型显示放大倍数」：塔筒、机舱、轮毂、叶片、基础按比例放大，
   * 塔基坐标与场地要素（吊装平台、箱变）保持真实尺寸。
   * 放大只影响视觉，机位坐标、高程与发电数据不变。
   */
  var turbineMeshes = [], rotorMeshes = [];
  var headGeometry = window.buildTurbineMesh(ROTOR_R);
  function buildTurbineHead(t, scale, enu, rotation) {
    var basis = Cesium.Matrix3.fromColumnMajorArray([
      T_L.x,T_L.y,T_L.z, 0,0,1, N_L.x,N_L.y,N_L.z
    ]);
    var orientation = Cesium.Matrix3.multiply(rotation,basis,new Cesium.Matrix3());
    var origin = Cesium.Matrix4.multiplyByPoint(enu,new Cesium.Cartesian3(N_L.x*6*scale,N_L.y*6*scale,0),new Cesium.Cartesian3());
    var base = Cesium.Matrix4.fromRotationTranslation(orientation,origin,new Cesium.Matrix4());
    Cesium.Matrix4.multiplyByUniformScale(base,scale,base);
    ['body','rotor'].forEach(function(part){
      var m=headGeometry[part];
      var geometry=new Cesium.Geometry({attributes:{
        position:new Cesium.GeometryAttribute({componentDatatype:Cesium.ComponentDatatype.DOUBLE,componentsPerAttribute:3,values:new Float64Array(m.positions)}),
        normal:new Cesium.GeometryAttribute({componentDatatype:Cesium.ComponentDatatype.FLOAT,componentsPerAttribute:3,values:new Float32Array(m.normals)})
      },indices:new Uint16Array(m.indices),primitiveType:Cesium.PrimitiveType.TRIANGLES,boundingSphere:Cesium.BoundingSphere.fromVertices(m.positions)});
      var primitive=scene.primitives.add(new Cesium.Primitive({geometryInstances:new Cesium.GeometryInstance({geometry:geometry,attributes:{color:Cesium.ColorGeometryInstanceAttribute.fromColor(BLADE_COLOR)}}),modelMatrix:Cesium.Matrix4.clone(base),appearance:new Cesium.PerInstanceColorAppearance({flat:false,translucent:false,closed:true}),asynchronous:false,allowPicking:false}));
      primitive.show=state.layers.turbines;
      turbineMeshes.push(primitive);
      if(part==='rotor')rotorMeshes.push({primitive:primitive,base:base});
    });
  }
  var lastRotorAngle = null;
  var rotorTurn = new Cesium.Matrix4();
  scene.preUpdate.addEventListener(function(){
    if(!state.layers.turbines || (lastRotorAngle===spin && rotorMeshes.length))return;
    lastRotorAngle=spin;
    var turn=Cesium.Matrix4.fromRotationTranslation(Cesium.Matrix3.fromRotationZ(spin*Math.PI/180),Cesium.Cartesian3.ZERO,rotorTurn);
    rotorMeshes.forEach(function(r){Cesium.Matrix4.multiply(r.base,turn,r.primitive.modelMatrix);});
  });

  function buildTurbine(t) {
    var ground = t.ground;
    var dem = t.ground_dem;
    var SC = state.turbineScale || 1;
    var hubH = ground + HUB_H * SC;
    var p = enuToLonLat(t.x, t.y);

    var hubPos = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, hubH);
    var enuM = Cesium.Transforms.eastNorthUpToFixedFrame(hubPos);
    var rot3 = Cesium.Matrix4.getMatrix3(enuM, new Cesium.Matrix3());

    reg('turbine', tagWt({
      position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, ground + HUB_H * SC / 2),
      cylinder: {
        length: HUB_H * SC, topRadius: 2.2 * SC, bottomRadius: 4.4 * SC, slices: 20,
        material: TOWER_COLOR
      }
    }, t.id));

    // Straight steel base section bridges the DEM gap without a flared transition.
    if (dem < ground) {
      var hGap = ground - dem;
      reg('turbine', tagWt({
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, dem + hGap / 2),
        cylinder: {
          length: hGap, topRadius: 4.4 * SC, bottomRadius: 4.4 * SC, slices: 32,
          material: TOWER_COLOR
        }
      }, t.id));
    }

    buildTurbineHead(t, SC, enuM, rot3);

    reg('turbine', tagWt({
      position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, ground + 0.8),
      ellipse: {
        semiMajorAxis: 10.0 * SC, semiMinorAxis: 10.0 * SC,
        material: Cesium.Color.fromCssColorString('#c4c9cf').withAlpha(0.95)
      }
    }, t.id));

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
        material: Cesium.Color.fromCssColorString('#aab0b8').withAlpha(0.35),
        perPositionHeight: true
      }
    }, t.id));

    var bx = t.x - N_L.x * 24, by = t.y - N_L.y * 24;
    var bp = enuToLonLat(bx, by);
    reg('turbine', tagWt({
      position: Cesium.Cartesian3.fromDegrees(bp.lon, bp.lat, heightAt(bx, by) + 1.4),
      box: {
        dimensions: new Cesium.Cartesian3(6.0, 2.6, 2.8),
        material: Cesium.Color.fromCssColorString('#8f9aa6'),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString('#12181f').withAlpha(0.5)
      }
    }, t.id));
  }

  /* ---------------------------------------------------------------------------
   * 10. 升压站 / 道路 / 集电线路 / 测风塔
   * ------------------------------------------------------------------------ */
  function buildSubstation() {
    var st = SITE.substation;
    var g = st.ground;
    var W = 62, D = 46;
    var cs = [[-W / 2, -D / 2], [W / 2, -D / 2], [W / 2, D / 2], [-W / 2, D / 2]];

    var ring = [];
    for (var i = 0; i < 4; i++) {
      var a = cs[i], b = cs[(i + 1) % 4];
      ring = ring.concat(groundLine(st.x + a[0], st.y + a[1], st.x + b[0], st.y + b[1], 1.6));
    }
    reg('substation', {
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(ring),
        width: 1.8,
        material: Cesium.Color.fromCssColorString('#fbbf24').withAlpha(0.85)
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
        material: Cesium.Color.fromCssColorString('#232b36').withAlpha(0.72),
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
          outlineColor: Cesium.Color.fromCssColorString('#0b1220').withAlpha(0.55)
        }
      });
    }

    building(-6, -12, 26, 14, 8.5, '#b8c4d0');
    building(6, 10, 12, 9, 5.5, '#aab6c2');
    building(22, 10, 9, 8, 6.0, '#aab6c2');
    building(-16, 12, 9, 7, 8.0, '#828e9c');
    building(-16, 0, 9, 7, 8.0, '#828e9c');

    var f0 = enuToLonLat(st.x + 26, st.y - 16);
    var f1 = enuToLonLat(st.x + 26, st.y + 2);
    reg('substation', {
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights([
          f0.lon, f0.lat, g, f0.lon, f0.lat, g + 18,
          f1.lon, f1.lat, g, f1.lon, f1.lat, g + 18,
          f0.lon, f0.lat, g + 18, f1.lon, f1.lat, g + 18
        ]),
        width: 1.2,
        material: Cesium.Color.fromCssColorString('#93a3b6')
      }
    });
  }

  function buildLines() {
    var roadData = DATA.roads;
    if (!roadData) return;
    roadData.roads.forEach(function(road){
      reg('roads', {
        name: road.id + ' · 6米山皮石道路',
        corridor: {
          positions: Cesium.Cartesian3.fromDegreesArray([].concat.apply([],road.coordinates)),
          width: state.roadStyle.width_m * state.roadStyle.widthScale,
          cornerType: Cesium.CornerType.ROUNDED,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          material: Cesium.Color.fromCssColorString(state.roadStyle.color).withAlpha(1 - state.roadStyle.transparency),
          classificationType: Cesium.ClassificationType.TERRAIN
        }
      });
    });
  }

  /* ---------------------------------------------------------------------------
   * 9.1 35 kV 集电线路：杆塔与导线
   * ------------------------------------------------------------------------ */
  /**
   * 每基塔的切线方向：取全部相邻塔方向的矢量和。
   * 分歧塔（如 A3 同时连 A2、A4、A3-1）由此得到"分角线"方向，横担取其垂线，
   * 与工程上分歧塔按合力方向布置横担的做法一致。
   * 返回 { tx, ty 切线单位向量; rx, ry 横担单位向量（切线顺时针转 90°） }
   */
  function towerTangents() {
    return window.towerRouteTangents(TOWERS, GRID && GRID.spans ? GRID.spans : []);
  }

  var TAN = towerTangents();

  /** 塔位放置姿态：模型 +y 对齐线路切线，+x 即横担方向 */
  /**
   * 塔位放置姿态：绕天顶旋转，使模型局部 x 轴指向横担方向。
   * extraDeg 为额外绕 z 轴的旋转（四棱台塔身需要棱落在 45° 对角线上）。
   * 返回该姿态的四元数（z 轴保持指向天顶，塔身竖直）。
   */
  function towerOrient(t, extraDeg) {
    var tan = TAN[t.id] || { rx: 1, ry: 0 };
    var theta = Math.atan2(tan.ry, tan.rx) + (extraDeg || 0);
    var p = enuToLonLat(t.x, t.y);
    var pos = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, t.ground);
    var enu = Cesium.Transforms.eastNorthUpToFixedFrame(pos);
    var rot = Cesium.Matrix3.fromRotationZ(theta);
    var m4 = Cesium.Matrix4.multiply(
      enu,
      Cesium.Matrix4.fromRotationTranslation(rot, Cesium.Cartesian3.ZERO, new Cesium.Matrix4()),
      new Cesium.Matrix4());
    return Cesium.Quaternion.fromRotationMatrix(
      Cesium.Matrix4.getMatrix3(m4, new Cesium.Matrix3()));
  }

  /**
   * 杆塔建模：每基用 Entity 四棱台 + 横担 + 基础拼装（不依赖 glTF 模型）。
   * 说明：最初采用单文件 glTF（每基 1 个实体、scale 可直改），但实测
   * Cesium 的 Model 在 SwiftShader 软件渲染下不绘制（模型 ready、位置正确仍不可见），
   * 无法在无头环境验收、也无法保证各环境一致。故改回 Entity 几何拼装：
   * 塔身 = cylinder slices:4 的变截面四棱台，横担 = 细长 box，基础 = 方形 box。
   * 每基 4 个实体，73 基约 290 个实体，可接受。
   */
  /* 杆塔改用图纸级 G081-J1 角钢塔几何（js/tower-j1.js），
     每基一个 Cesium.GeometryInstance，共用同一份几何，合并为一个 Primitive。
     颜色按分层（主材 / 斜材 / 横担）不区分——单塔 5500 三角形，按层拆色会导致
     4 个 Primitive 各存一份 120 万顶点，得不偿失；改用统一的钢材色 + 法线光照。 */
  var TOWER_COLOR = Cesium.Color.fromCssColorString('#8998a7');

  var towerPrimitive = null;      // 单个 Primitive，含全部塔实例
  var TOWER_GEO = {};           // 局部坐标几何（只生成一次）

  /** 把 tower-j1.js 的顶点数据转成 Cesium.Geometry（局部坐标，float 精度足够） */
  function towerGeometry(tower) {
    var doubleCircuit = tower && /^AB/i.test(tower.id);
    var tension = tower && tower.type === 'tension';
    var key = (doubleCircuit ? 'sj1' : 'j1') + (tension ? '-tension' : '');
    if (TOWER_GEO[key]) return TOWER_GEO[key];
    if (!window.TowerJ1) {
      console.warn('tower-j1.js 未加载，杆塔无法建模');
      return null;
    }
    var local = (doubleCircuit ? window.TowerSJ1 : window.TowerJ1).build(tension);
    // 局部包围球：几何范围 x≈±2.8、y≈±2.2、z 0~30.9，取中心 (0,0,15.4)、半径 17
    // （用显式包围球而非 fromVertices，避免 TypedArray 类型差异带来的 undefined）
    var bs = Cesium.BoundingSphere.fromVertices(local.positions);

    TOWER_GEO[key] = {
      geometry: new Cesium.Geometry({
        attributes: {
          position: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.DOUBLE,
            componentsPerAttribute: 3,
            values: new Float64Array(local.positions)
          }),
          normal: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.FLOAT,
            componentsPerAttribute: 3,
            values: local.normals
          })
        },
        indices: local.indices,
        primitiveType: Cesium.PrimitiveType.TRIANGLES,
        boundingSphere: bs
      }),
      triCount: local.triCount,
      hooks: local.hooks,
      height: local.height,
      positions: local.positions,     // 保留原始数组，供每实例复制
      normals: local.normals,
      indices: local.indices
    };
    return TOWER_GEO[key];
  }

  /** 塔位变换矩阵：ENU × 绕天顶旋转（横担对准线路法向）× 均匀缩放 */
  function towerMatrix(t, SC) {
    var tan = TAN[t.id] || { rx: 1, ry: 0 };
    var theta = Math.atan2(tan.ry, tan.rx);
    var p = enuToLonLat(t.x, t.y);
    var base = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, t.ground);
    var enu = Cesium.Transforms.eastNorthUpToFixedFrame(base);
    var rot = Cesium.Matrix3.fromRotationZ(theta);
    var m4 = Cesium.Matrix4.multiply(
      enu,
      Cesium.Matrix4.fromRotationTranslation(rot, Cesium.Cartesian3.ZERO, new Cesium.Matrix4()),
      new Cesium.Matrix4());
    return Cesium.Matrix4.multiplyByUniformScale(m4, SC, m4);
  }

  function destroyTowers() {
    groups.tower.forEach(function(e){viewer.entities.remove(e);});
    groups.tower.length = 0;
    if (towerPrimitive) {
      scene.primitives.remove(towerPrimitive);
      towerPrimitive = null;
    }
  }

  /**
   * 建塔：每个塔位一个 GeometryInstance。
   * 注意——每个实例必须持有**独立的顶点副本**：Primitive 异步创建时会把
   * TypedArray transfer 给 worker，共享同一数组会让后续实例拿到空缓冲。
   * 位置必须使用 Float64：Cesium 合批先乘地心坐标矩阵，再编码高低位；
   * Float32 会在约 640 万米的坐标上丢失厘米级构件，造成杆件扭曲。
   */
  function buildTowers() {
    destroyTowers();
    if (!TOWERS.length) return;


    var SC = state.gridScale;
    var instances = [];

    for (var i = 0; i < TOWERS.length; i++) {
      var t = TOWERS[i];
      var geo = towerGeometry(t);
      if (!geo) continue;
      reg('tower', {
        position: xyz(t.x, t.y, t.ground + (geo.height + 1.5) * SC),
        show: state.layers.grid && state.layers.towerLabels,
        label: {
          text: String(t.id), font: '12px sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#d4e6f2'),
          outlineColor: Cesium.Color.fromCssColorString('#10202e'), outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          showBackground: true, backgroundColor: Cesium.Color.fromCssColorString('#10202e').withAlpha(0.8),
          backgroundPadding: new Cesium.Cartesian2(5, 3),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -6),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 12000)
        }
      });
      instances.push(new Cesium.GeometryInstance({
        geometry: new Cesium.Geometry({
          attributes: {
            position: new Cesium.GeometryAttribute({
              componentDatatype: Cesium.ComponentDatatype.DOUBLE,
              componentsPerAttribute: 3,
              values: new Float64Array(geo.positions)
            }),
            normal: new Cesium.GeometryAttribute({
              componentDatatype: Cesium.ComponentDatatype.FLOAT,
              componentsPerAttribute: 3,
              values: new Float32Array(geo.normals)
            })
          },
          // 顶点数 16500 < 65536，用 Uint16 索引：部分渲染后端（含 SwiftShader）
          // 不支持 OES_element_index_uint，Uint32 索引会静默不绘制。
          indices: geo.positions.length / 3 > 65535 ? new Uint32Array(geo.indices) : new Uint16Array(geo.indices),
          primitiveType: Cesium.PrimitiveType.TRIANGLES,
          // 每个实例必须持有独立的包围球对象：Cesium 合并实例时会用
          // BoundingSphere.transform 就地变换，共享同一对象会让后续实例的球
          // 逐级偏移，最终整批被判为视锥外而不绘制（实测踩过）。
          boundingSphere: Cesium.BoundingSphere.clone(geo.geometry.boundingSphere),
          // 部分 Cesium 版本的 Primitive 会无条件读取 boundingSphereCV，
          // 缺省会抛 "Cannot read properties of undefined (reading 'center')"。
          boundingSphereCV: {
            center: new Cesium.Cartesian3(0, 0, 0),
            radius: 50000.0
          }
        }),
        modelMatrix: towerMatrix(t, SC),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(TOWER_COLOR)
        }
      }));
    }

    towerPrimitive = scene.primitives.add(new Cesium.Primitive({
      geometryInstances: instances,
      appearance: new Cesium.PerInstanceColorAppearance({
        flat: false,
        translucent: false
      }),
      asynchronous: false,
      allowPicking: false
    }));
    towerPrimitive.show = !!state.layers.grid;
  }

  /** 导线挂点的 ENU 坐标：塔基 + 横担方向 × 臂长 × 倍率；高度 = 塔基 + 挂点标高 × 倍率 */
  function hookPoint(t, hook, SC) {
    var tan = TAN[t.id] || { rx: 1, ry: 0 };
    return {
      x: t.x + tan.rx * hook.x * SC,
      y: t.y + tan.ry * hook.x * SC,
      z: t.ground + hook.z * SC
    };
  }

  /**
   * 导线：按档（spans）逐相生成悬链线近似的抛物线，弧垂 f = k × 档距。
   * 35 kV 线路导线为 LGJ 系列，350 m 档距常见弧垂 7～9 m，k 取 0.024。
   */
  var SAG_K = 0.024;
  var SAG_SEG = 12;

  /** 导线挂点：直接取 tower-j1.js 的 HOOKS（横担端部减去绝缘子串长） */
  var TOWER_HOOKS = (window.TowerJ1 && window.TowerJ1.HOOKS) || [];

  var tensionPrimitive = null;
  function buildConductors() {
    if (!GRID || !GRID.spans) return;
    var SC = state.gridScale;
    if (tensionPrimitive) { scene.primitives.remove(tensionPrimitive); tensionPrimitive=null; }
    var insulatorInstances=[], ends={};
    function hardware(t,hook,other,key) {
      if(t.type!=='tension') return hookPoint(t,hook,SC);
      var model=/^AB/i.test(t.id)?window.TowerSJ1:window.TowerJ1;
      var anchor=hookPoint(t,{x:hook.x,z:hook.z+model.INS_LEN},SC);
      var dx=other.x-t.x,dy=other.y-t.y,len=Math.hypot(dx,dy)||1;
      var direction=new Cesium.Cartesian3(dx/len,dy/len,-0.12);
      Cesium.Cartesian3.normalize(direction,direction);
      var end={x:anchor.x+direction.x*model.INS_LEN*SC,y:anchor.y+direction.y*model.INS_LEN*SC,z:anchor.z+direction.z*model.INS_LEN*SC};
      var groupKey=t.id+':'+key;
      (ends[groupKey]||(ends[groupKey]=[])).push({point:end,anchor:anchor});
      var u=Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(direction,Cesium.Cartesian3.UNIT_Z,new Cesium.Cartesian3()),new Cesium.Cartesian3());
      var v=Cesium.Cartesian3.cross(direction,u,new Cesium.Cartesian3());
      var rotation=Cesium.Matrix3.fromColumnMajorArray([u.x,u.y,u.z,v.x,v.y,v.z,direction.x,direction.y,direction.z]);
      function piece(distance,radius,length,color){
        var pos=xyz(anchor.x+direction.x*distance*SC,anchor.y+direction.y*distance*SC,anchor.z+direction.z*distance*SC);
        var enu=Cesium.Transforms.eastNorthUpToFixedFrame(pos);
        var matrix=Cesium.Matrix4.multiply(enu,Cesium.Matrix4.fromRotationTranslation(rotation,Cesium.Cartesian3.ZERO,new Cesium.Matrix4()),new Cesium.Matrix4());
        insulatorInstances.push(new Cesium.GeometryInstance({geometry:Cesium.CylinderGeometry.createGeometry(new Cesium.CylinderGeometry({length:length*SC,topRadius:radius*SC,bottomRadius:radius*SC,slices:16,vertexFormat:Cesium.PerInstanceColorAppearance.VERTEX_FORMAT})),modelMatrix:matrix,attributes:{color:Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString(color))}}));
      }
      piece(model.INS_LEN/2,.018,model.INS_LEN,'#8896a3');
      for(var disc=0;disc<4;disc++)piece(.085+(disc+.5)*.146,.126,.045,'#b8ccd1');
      return end;
    }

    GRID.spans.forEach(function (sp) {
      var a = TW_BY_ID[sp.from], b = TW_BY_ID[sp.to];
      if (!a || !b) return;
      // 挂点取 J1 塔的真实横担标高（下横担 ±2550 @24.0 m、上横担 +2000 @27.6 m）
      var hooksA = /^AB/i.test(a.id) ? window.TowerSJ1.HOOKS : TOWER_HOOKS;
      var hooksB = /^AB/i.test(b.id) ? window.TowerSJ1.HOOKS : TOWER_HOOKS;
      var hooks = hooksA.length === 6 && hooksB.length === 6 ? hooksA : hooksA.slice(0,3);
      if (!hooks || !hooks.length) return;

      var L = sp.length_m || Math.hypot(b.x - a.x, b.y - a.y);
      var f = SAG_K * L;
      var n = hooks.length;

      for (var k = 0; k < n; k++) {
        var offsetA = hooksA.length === 6 && hooksB.length === 3 && sp.circuit === 2 ? 3 : 0;
        var offsetB = hooksB.length === 6 && hooksA.length === 3 && sp.circuit === 2 ? 3 : 0;
        var p1 = hardware(a,hooksA[k + offsetA],b,k + offsetA);
        var p2 = hardware(b,hooksB[k + offsetB],a,k + offsetB);
        var pts = [];
        for (var i = 0; i <= SAG_SEG; i++) {
          var u = i / SAG_SEG;
          var x = p1.x + (p2.x - p1.x) * u;
          var y = p1.y + (p2.y - p1.y) * u;
          var z = p1.z + (p2.z - p1.z) * u - 4 * f * u * (1 - u);
          var q = enuToLonLat(x, y);
          pts.push(q.lon, q.lat, z);
        }
        var e = viewer.entities.add({
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArrayHeights(pts),
            width: 1.6,
            material: Cesium.Color.fromCssColorString('#2fe0a0').withAlpha(0.92),
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 24000)
          }
        });
        groups.conductor.push(e);
      }
    });
    Object.keys(ends).forEach(function(key){
      var terminals=ends[key];
      if(terminals.length<2)return;
      var a=terminals[0].point;
      for(var j=1;j<terminals.length;j++){
        var b=terminals[j].point, pts=[];
        for(var step=0;step<=16;step++){
          var u=step/16;
          pts.push(xyz(a.x+(b.x-a.x)*u,a.y+(b.y-a.y)*u,a.z+(b.z-a.z)*u-1.1*SC*4*u*(1-u)));
        }
        groups.conductor.push(viewer.entities.add({polyline:{positions:pts,width:1.6,material:Cesium.Color.fromCssColorString('#2fe0a0')}}));
      }
    });
    if(insulatorInstances.length)tensionPrimitive=scene.primitives.add(new Cesium.Primitive({geometryInstances:insulatorInstances,appearance:new Cesium.PerInstanceColorAppearance({flat:false,translucent:false}),asynchronous:false,allowPicking:false}));
    if(tensionPrimitive)tensionPrimitive.show=!!state.layers.grid;
  }

  function buildGridline() {
    buildTowers();
    buildConductors();
  }

  function buildMetMast() {
    var mx = SITE.substation.x - 520, my = SITE.substation.y + 260;
    var g = heightAt(mx, my);
    var p = enuToLonLat(mx, my);
    reg('metmast', {
      position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, g + HUB_H / 2),
      cylinder: {
        length: HUB_H, topRadius: 0.5, bottomRadius: 1.0, slices: 8,
        material: Cesium.Color.fromCssColorString('#8494a7')
      }
    });
  }

  /* ---------------------------------------------------------------------------
   * 11. 选中高亮环
   * ------------------------------------------------------------------------ */
  var selRing = viewer.entities.add({
    show: false,
    position: Cesium.Cartesian3.fromDegrees(CTR.lon, CTR.lat, BASE_ELEV),
    ellipse: {
      semiMajorAxis: 52, semiMinorAxis: 52,
      material: Cesium.Color.fromCssColorString('#4cc2f1').withAlpha(0.10)
    }
  });

  /* ---------------------------------------------------------------------------
   * 12. 机位标签（chip）与选中数据卡（card）
   * ------------------------------------------------------------------------ */
  var labelsHost = $('boards');
  var LABELS = [];
  var win2 = new Cesium.Cartesian2();
  var toWindow = Cesium.SceneTransforms.worldToWindowCoordinates ||
                 Cesium.SceneTransforms.wgs84ToWindowCoordinates;

  function buildLabels() {
    TURBINES.forEach(function (t) {
      var chip = document.createElement('div');
      chip.className = 'chip hide';
      chip.innerHTML = '<span class="c-id"></span><span class="c-cap"></span>' +
                       '<span class="c-power" hidden></span><span class="c-sub">等效 ' + n0(t.hours) + ' h</span>';
      chip.querySelector('.c-id').textContent = t.id;
      var modelName = t.model || MACH.model || '';
      var capacity = Number((t.rated_kw || MACH.rated_kw) / 1000);
      var containsCapacity = Array.from(modelName.matchAll(/(\d+(?:\.\d+)?)\s*(?:MW|兆瓦)/gi)).some(function(match){return Math.abs(Number(match[1])-capacity)<0.001;});
      chip.querySelector('.c-cap').textContent = ' · ' + modelName + (containsCapacity ? '' : (modelName ? ' ' : '') + capacity.toFixed(1) + ' MW');
      chip.addEventListener('click', function (ev) {
        ev.stopPropagation();
        select(t.id, { fly: false });
      });
      chip.addEventListener('dblclick', function (ev) {
        ev.stopPropagation();
        select(t.id, { fly: true });
      });
      labelsHost.appendChild(chip);

      var card = document.createElement('div');
      card.className = 'card-pop hide';
      card.innerHTML =
        '<div class="cd-head"><span>' + t.id + '</span><em>' +
          (t.rated_kw / 1000).toFixed(2) + ' MW</em></div>' +
        '<div class="cd-l cd-hour" hidden><span>估算功率</span><b class="a"></b></div>' +
        '<div class="cd-l"><span>上网电量</span><b class="a">' + n0(t.net_mwh) + '<i>MWh</i></b></div>' +
        '<div class="cd-l"><span>等效满发</span><b>' + n0(t.hours) + '<i>h</i></b></div>' +
        '<div class="cd-l"><span>轮毂海拔</span><b>' + n0(t.hub_abs) + '<i>m</i></b></div>' +
        '<div class="cd-sep"></div>' +
        '<div class="cd-co">E ' + Math.round(t.e2000) + '<br>N ' + Math.round(t.n2000) + '</div>';
      card.addEventListener('click', function (ev) {
        ev.stopPropagation();
        select(t.id, { fly: false });
      });
      labelsHost.appendChild(card);

      LABELS.push({
        t: t,
        chip: chip,
        card: card,
        pos: xyz(t.x, t.y, t.ground + (HUB_H + ROTOR_R) * state.turbineScale + 8)
      });
    });
  }

  /** 标签安全区：画布已不含面板，左右各留 10 px */
  function labelBounds() {
    var w = scene.canvas.clientWidth;
    return { left: 10, right: w - 10 };
  }

  function updateLabels() {
    if (!state.layers.turbineLabels) {
      LABELS.forEach(function (L) { L.chip.classList.add('hide'); L.card.classList.add('hide'); });
      return;
    }

    var cam = scene.camera.positionWC;
    var ch = scene.canvas.clientHeight;
    var bound = labelBounds();
    var vis = [];

    for (var i = 0; i < LABELS.length; i++) {
      var L = LABELS[i];
      var isSel = state.selected === L.t.id;
      var d = Cesium.Cartesian3.distance(cam, L.pos);
      var win = toWindow(scene, L.pos, win2);
      var off = !win || !isFinite(win.x) || !isFinite(win.y) ||
                win.x < bound.left - 60 || win.x > bound.right + 40 ||
                win.y < 4 || win.y > ch - 56 || d > 16000;

      if (off) {
        L.chip.classList.add('hide');
        L.card.classList.add('hide');
        continue;
      }

      if (isSel) {
        L.chip.classList.add('hide');
        L.card.classList.remove('hide');
        var cy = win.y;
        var cTop = 92;                             // 卡片高度余量
        var clamped = cy - cTop < 92;              // 顶栏 + 内边距
        if (clamped) cy = 92 + cTop;
        cy = Math.min(cy, ch - 56);
        L.card.classList.toggle('clamped', clamped);

        // 卡片水平限位：打开抽屉时贴到抽屉左缘，而不是被整块隐藏
        var cx = win.x;
        var halfW = 86;
        if (cx + halfW > bound.right) cx = bound.right - halfW;
        if (cx - halfW < bound.left) cx = bound.left + halfW;

        // 单机视角：卡片固定贴右下角，避免压在叶轮上
        if (state.camPreset === 'unit') {
          cx = bound.right - halfW - 6;
          cy = ch - 22;
        }

        L.card.style.transform = 'translate(' + cx.toFixed(1) + 'px,' + cy.toFixed(1) +
                                 'px) translate(-50%,-100%)';
      } else {
        L.card.classList.add('hide');
        L.chip.classList.remove('hide');
        L.chip.classList.toggle('dim', state.labelMode === 'detail');
        vis.push({ el: L.chip, x: win.x, y: win.y, h: state.tab === 'layout' ? 48 : 19, w: 128 });
      }
    }

    vis.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    for (var m = 0; m < vis.length; m++) {
      var cur = vis[m];
      for (var pass = 0; pass < 8; pass++) {
        var moved = false;
        for (var n = 0; n < m; n++) {
          var o = vis[n];
          if (Math.abs(cur.x - o.x) < (cur.w + o.w) / 2 + 4 &&
              Math.abs(cur.y - o.y) < (cur.h + o.h) / 2 + 4) {
            cur.y = o.y - (cur.h + o.h) / 2 - 5;
            moved = true;
          }
        }
        if (!moved) break;
      }
      var y = Math.min(Math.max(cur.y, 24 + cur.h), ch - 56);
      var x = Math.min(Math.max(cur.x, bound.left + 28), bound.right - 28);
      cur.el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) +
                               'px) translate(-50%,-100%)';
    }
  }

  var labelSnapshot = '', lastLabelUpdate = 0;
  scene.postRender.addEventListener(function(){
    var now=performance.now();
    if(now-lastLabelUpdate<33)return;
    var camera=viewer.camera,p=camera.positionWC,d=camera.directionWC,u=camera.upWC;
    var snapshot=[p.x,p.y,p.z,d.x,d.y,d.z,u.x,u.y,u.z,scene.canvas.clientWidth,scene.canvas.clientHeight,state.selected,state.labelMode,state.layers.turbineLabels,state.turbineScale].join('|');
    if(snapshot===labelSnapshot)return;
    labelSnapshot=snapshot;lastLabelUpdate=now;updateLabels();
  });

  /* ---------------------------------------------------------------------------
   * 13. 相机
   * ------------------------------------------------------------------------ */
  var SITE_CENTER = null;
  var FIT_PTS = null;

  /** 场址中心（ENU 原点对应的地面点） */
  function siteCenter() {
    if (!SITE_CENTER) SITE_CENTER = xyz(0, 0, heightAt(0, 0));
    return SITE_CENTER;
  }

  /** 参与取景的点：场区控制范围顶点（略抬高，避免被地形吞掉） */
  function fitPoints() {
    if (!FIT_PTS) {
      FIT_PTS = SITE.boundary_polygon.map(function (p) {
        return xyz(p[0], p[1], heightAt(p[0], p[1]) + 60);
      });
    }
    return FIT_PTS;
  }

  /** 可视安全区：画布本身即三侧面板之间的区域，只需留一圈内边距 */
  function usableRect() {
    var w = scene.canvas.clientWidth;
    var h = scene.canvas.clientHeight;
    var m = 10;
    return { x0: m, y0: m, x1: w - m, y1: h - m };
  }

  /**
   * 把相机摆到 (sx, sy) 局部坐标目标点的指定方位/俯角/距离，返回位姿并解除锁定。
   * sx/sy 用于把场址从画布中心挪到"可视安全区"中心（左侧有面板时不能用画布中心）。
   */
  function cameraFor(range, heading, pitch, sx, sy) {
    var target = xyz(sx || 0, sy || 0, heightAt(sx || 0, sy || 0));
    viewer.camera.lookAt(target, new Cesium.HeadingPitchRange(heading, pitch, range));
    var out = {
      destination: Cesium.Cartesian3.clone(viewer.camera.positionWC),
      heading: viewer.camera.heading,
      pitch: viewer.camera.pitch
    };
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    return out;
  }

  function projectBBox(pts) {
    var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, n = 0;
    var v = new Cesium.Cartesian2();
    for (var i = 0; i < pts.length; i++) {
      var w = toWindow(scene, pts[i], v);
      if (!w || !isFinite(w.x) || !isFinite(w.y)) continue;
      x0 = Math.min(x0, w.x); x1 = Math.max(x1, w.x);
      y0 = Math.min(y0, w.y); y1 = Math.max(y1, w.y);
      n++;
    }
    return n >= 2 ? { x0: x0, x1: x1, y0: y0, y1: y1 } : null;
  }

  /**
   * 自动取景：迭代求解「距离 + 视点偏移」，使场区投影尺寸贴合安全区、中心对齐安全区中心。
   * 全部由当前视口与真实地理范围推算，不写死相机数值；场区或屏幕变化后仍然成立。
   */
  function fitCamera(heading, pitch) {
    var pts = fitPoints();
    var U = usableRect();
    var availW = Math.max(220, U.x1 - U.x0);
    var availH = Math.max(180, U.y1 - U.y0);
    var wantCx = (U.x0 + U.x1) / 2;
    var wantCy = (U.y0 + U.y1) / 2;

    var range = 9000;
    var sx = 0, sy = 0;
    var sinP = Math.max(0.18, Math.sin(-pitch));
    var fovX = viewer.camera.frustum.fov;

    for (var i = 0; i < 10; i++) {
      cameraFor(range, heading, pitch, sx, sy);
      scene.render();                       // 投影矩阵需在 render 后更新
      var bb = projectBBox(pts);
      if (!bb) break;

      var wPix = bb.x1 - bb.x0, hPix = bb.y1 - bb.y0;
      var need = Math.max(wPix / (availW * 0.88), hPix / (availH * 0.88));
      var cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
      var dx = wantCx - cx, dy = wantCy - cy;

      if (need > 0.97 && need < 1.03 && Math.abs(dx) < 8 && Math.abs(dy) < 8) break;

      var mpp = 2 * range * Math.tan(fovX / 2) / scene.canvas.clientWidth;
      range = Math.max(600, Math.min(range * Math.min(Math.max(need, 0.6), 1.8), 60000));
      // 相机西移 → 画面内容东移（故 sx 取负增量）；相机北移 → 画面内容南移（sy 取正增量）
      sx -= dx * mpp * 0.85;
      sy += dy * mpp / sinP * 0.85;
      var lim = 12000;
      sx = Math.max(-lim, Math.min(lim, sx));
      sy = Math.max(-lim, Math.min(lim, sy));
    }
    return { range: range, sx: sx, sy: sy };
  }

  var PRESETS = {
    overview: { heading: 0, pitch: Cesium.Math.toRadians(-42) },
    top: { heading: 0, pitch: Cesium.Math.toRadians(-89.5) },
    oblique: { heading: 0, pitch: Cesium.Math.toRadians(-26) }
  };

  function flyPreset(name, duration) {
    var P = PRESETS[name] || PRESETS.overview;
    var before = {
      destination: Cesium.Cartesian3.clone(viewer.camera.positionWC),
      heading: viewer.camera.heading,
      pitch: viewer.camera.pitch,
      roll: viewer.camera.roll
    };

    var fit = fitCamera(P.heading, P.pitch);
    var cam = cameraFor(fit.range, P.heading, P.pitch, fit.sx, fit.sy);

    // 拟合过程会移动相机，先回原位，保证切换视角有飞行动画
    viewer.camera.setView({
      destination: before.destination,
      orientation: { heading: before.heading, pitch: before.pitch, roll: before.roll }
    });

    state.camPreset = name;
    if (!duration) {
      viewer.camera.setView({
        destination: cam.destination,
        orientation: { heading: cam.heading, pitch: cam.pitch, roll: 0 }
      });
    } else {
      viewer.camera.flyTo({
        destination: cam.destination,
        orientation: { heading: cam.heading, pitch: cam.pitch, roll: 0 },
        duration: duration
      });
    }
    syncSeg();
    syncFocusBtn();
    applyLabelMode();
  }

  /**
   * 单机视角取景：按「扣除底部控制台后的可用高度」反算距离与俯角，
   * 保证塔基到叶尖完整入画、且居中于可见区域，而不是被控制台压住。
   */
  function flyUnit(t, duration) {
    var cw = scene.canvas.clientWidth;
    var ch = scene.canvas.clientHeight;

    // 画布只包含三侧面板之间的区域，上下各留 14 px 即可
    var availH = Math.max(200, ch - 28);
    var availMid = ch / 2;

    // Cesium 的 frustum.fov 是水平视场角，垂直方向要按画布比例换算
    var vFov = 2 * Math.atan(Math.tan(viewer.camera.frustum.fov / 2) * ch / cw);

    var SC = state.turbineScale || 1;
    var objH = (HUB_H + ROTOR_R) * SC;              // 塔基到叶尖（含模型放大）
    var halfAngle = (availH / ch) * (vFov / 2) * 0.86;
    var dist = (objH / 2) / Math.tan(Math.max(0.06, halfAngle));
    dist = Math.max(ROTOR_R * 3.4, Math.min(dist, ROTOR_R * 14));

    var px = t.x + N_L.x * dist;
    var py = t.y + N_L.y * dist;
    var p = enuToLonLat(px, py);

    var camAlt = t.ground + HUB_H * 0.62 * SC;
    var aim = t.ground + objH * 0.48;               // 瞄准整机高度中点
    var pitchDeg = Math.atan2(aim - camAlt, dist) * 180 / Math.PI;

    // 视线中心需从画布中心上移到可用区中心，俯角相应压低
    var dy = (ch / 2 - availMid) / ch;
    pitchDeg -= dy * (vFov * 180 / Math.PI);

    state.camPreset = 'unit';
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, camAlt),
      orientation: {
        heading: AZ_RAD + Math.PI,
        pitch: Cesium.Math.toRadians(pitchDeg),
        roll: 0
      },
      duration: duration === undefined ? 1.5 : duration
    });
    syncSeg();
    syncFocusBtn();
    applyLabelMode();
  }

  /** 单机视角下隐藏「进入单机视角」按钮，避免无效操作 */
  function syncFocusBtn() {
    var b = $('btnFocus');
    if (!b) return;
    var hide = !state.selected || state.camPreset === 'unit';
    b.style.display = hide ? 'none' : '';
  }

  function syncSeg() {
    document.querySelectorAll('#segView button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.view === state.camPreset);
    });
  }

  /* ---------------------------------------------------------------------------
   * 14. 选中
   * ------------------------------------------------------------------------ */
  var clickTimer = null;

  function labelModeFor() {
    if (state.selected && state.camPreset === 'unit') return 'detail';
    if (state.tab === 'layout') return 'layout';
    return 'overview';
  }

  function applyLabelMode() {
    state.labelMode = labelModeFor();
    document.body.dataset.view = state.labelMode;
  }

  function select(id, opts) {
    opts = opts || {};
    var t = id ? T_BY_ID[id] : null;
    if (id && !t) return;

    state.selected = t ? t.id : null;

    if (t) {
      var pp = enuToLonLat(t.x, t.y);
      selRing.position = Cesium.Cartesian3.fromDegrees(pp.lon, pp.lat, t.ground + 1.6);
      selRing.show = !!state.layers.turbines;
    } else {
      selRing.show = false;
    }

    document.querySelectorAll('.wt').forEach(function (n) {
      n.classList.toggle('on', n.dataset.wt === state.selected);
    });

    if (t) {
      renderDrawer(t);
      $('rightEmpty').style.display = 'none';
      $('rightDetail').style.display = '';
      state.ui.right = true;          // 新选中时自动展开右栏（此前可能被收起）
    } else {
      $('rightEmpty').style.display = '';
      $('rightDetail').style.display = 'none';
    }
    applyChrome();

    if (opts.fly && t) flyUnit(t);

    syncFocusBtn();
    applyLabelMode();
    scene.requestRender();
  }

  /* ---------------------------------------------------------------------------
   * 15. 左侧面板
   * ------------------------------------------------------------------------ */
  function renderMachineParameters() {
    var host=$('machineParameterTable');if(!host)return;host.textContent='';
    if(!MACH.parameters){host.textContent='未提供风机参数表';return;}
    var heading=document.createElement('div');heading.textContent=MACH.model||'风机参数';heading.style.cssText='color:var(--cyan);padding:5px 0;font-weight:bold';host.appendChild(heading);
    MACH.parameters.items.forEach(function(item){
      var row=document.createElement('div');row.style.cssText='display:flex;justify-content:space-between;gap:12px;font-size:11px;padding:6px 0;border-bottom:1px solid var(--line)';
      var key=document.createElement('span'),value=document.createElement('span');key.textContent=item.name;value.textContent=String(item.value);value.style.textAlign='right';row.appendChild(key);row.appendChild(value);host.appendChild(row);
    });
    if(MACH.rotor_d_source_m && MACH.rotor_d_source_m!==MACH.rotor_d){var note=document.createElement('div');note.style.cssText='font-size:11px;color:var(--warn);padding-top:8px';note.textContent='模型叶轮直径 '+MACH.rotor_d+' m（项目指定）；表内 '+MACH.rotor_d_source_m+' m。扫风面积按原表展示。';host.appendChild(note);}
  }
  function renderOverview() {
    renderMachineParameters();
    setT('kCap', n1(ENERGY.capacity_mw));
    setT('kNum', String(MACH.count));
    setT('kAep', n1(ENERGY.net_gwh));
    setT('kHours', n0(ENERGY.hours_net));

    setT('vExtent', (SITE.boundary_m[0] / 1000).toFixed(2) + ' × ' +
                    (SITE.boundary_m[1] / 1000).toFixed(2) + ' km');
    setT('vArea', SITE.area_km2.toFixed(2));
    setT('vElev', TERRAIN.min + ' – ' + TERRAIN.max);
    setT('vSlope', n1(TERRAIN.mean_slope));

    setT('tMinDist', n0(CHECKS.min_spacing_m));
    setT('tMinD', n2(CHECKS.min_spacing_D));
    setT('tMinPair', (CHECKS.min_spacing_pair || []).join(' – '));

    setT('vUnit', n2(MACH.rated_mw));
    setT('vHub', String(HUB_H));
    setT('vRotor', String(MACH.rotor_d));
    setT('vDensity', n2(ENERGY.capacity_mw / SITE.area_km2));
  }

  function renderLayout() {
    var arr = TURBINES.slice();
    if (state.sort === 'net') {
      arr.sort(function (a, b) { return b.net_mwh - a.net_mwh; });
      setT('listHint', '按电量');
    } else {
      arr.sort(function (a, b) { return a.id.localeCompare(b.id, 'zh'); });
      setT('listHint', '按编号');
    }

    var host = $('wtList');
    host.innerHTML = '';
    arr.forEach(function (t) {
      var li = document.createElement('li');
      li.className = 'wt' + (state.selected === t.id ? ' on' : '');
      li.dataset.wt = t.id;
      li.setAttribute('tabindex', '0');
      li.setAttribute('role', 'button');
      li.innerHTML =
        '<span class="wt-id">' + t.id + '</span>' +
        '<span class="wt-mid">' +
          '<span class="wt-val">' + n0(t.net_mwh) + '<span>MWh</span></span>' +
          '<span class="wt-bar"><i style="width:' +
            (14 + 86 * (t.net_mwh - MIN_NET) / Math.max(1, MAX_NET - MIN_NET)).toFixed(1) + '%"></i></span>' +
        '</span>' +
        '<span class="wt-h">' + n0(t.hours) + '<em>h</em></span>';

      function act() { select(t.id, { fly: true }); }
      li.addEventListener('click', act);
      li.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); }
      });
      host.appendChild(li);
    });

    var pairTxt2 = (CHECKS.min_spacing_pair || []).join(' – ');
    setT('tMinDist2', n0(CHECKS.min_spacing_m));
    setT('tMinD2', n2(CHECKS.min_spacing_D));
    setT('tMinPair2', pairTxt2);

    var best = TURBINES.slice().sort(function (a, b) { return b.hours - a.hours; })[0];
    var worst = TURBINES.slice().sort(function (a, b) { return a.hours - b.hours; })[0];
    $('listStat').innerHTML =
      '<div><span>等效小时最高</span><b>' + best.id + '</b><em>' + n0(best.hours) + ' h</em></div>' +
      '<div><span>最低</span><b>' + worst.id + '</b><em>' + n0(worst.hours) + ' h</em></div>' +
      '<div><span>全场上网电量区间</span><b>' + n0(MIN_NET) + ' – ' + n0(MAX_NET) + '</b><em>MWh</em></div>';
  }

  function updateRoadStyle() {
    var style = state.roadStyle;
    var color = Cesium.Color.fromCssColorString(style.color).withAlpha(1 - style.transparency);
    groups.roads.forEach(function(entity){
      if (!entity.corridor) return;
      entity.corridor.width = style.width_m * style.widthScale;
      entity.corridor.material = color;
    });
    setT('roadScaleVal', style.widthScale.toFixed(1) + '×');
    setT('roadTransparencyVal', Math.round(style.transparency * 100) + '%');
    setT('roadDisplayWidth', (style.width_m * style.widthScale).toFixed(1) + ' m');
    scene.requestRender();
  }

  function renderRoads() {
    var data = DATA.roads;
    setT('roadLength', data ? n2(data.stats.length_m / 1000) + ' km' : '暂无数据');
    setT('roadCount', data ? data.stats.count + ' 段' : '—');
    setT('roadWidth', data ? data.width_m + ' m' : '—');
    var host = $('roadList'); host.textContent = '';
    if (data) data.roads.forEach(function(road){
      var row = document.createElement('div'); row.style.cssText='padding:8px;border-bottom:1px solid rgba(140,180,200,.15)';
      row.textContent = road.id + ' · ' + n0(road.length_m) + ' m'; host.appendChild(row);
    });
  }

  function renderGridline() {
    var summary = $('gridSummary'), routes = $('gridRoutes'), towers = $('gridTowerList');
    summary.textContent = ''; routes.textContent = ''; towers.textContent = '';
    if (!GRID || !GRID.stats) { summary.textContent = '暂无集电线路数据'; return; }
    var stats = GRID.stats;
    function metric(label, value) {
      var row = document.createElement('div'), key = document.createElement('dt'), val = document.createElement('dd');
      key.textContent = label; val.textContent = value; row.appendChild(key); row.appendChild(val); summary.appendChild(row);
    }
    metric('电压等级', '35 kV');
    if (GRID.conductor) {
      metric('导线型号', GRID.conductor.model);
      metric('导线类型', GRID.conductor.name);
    }
    metric('线路总长', n2(stats.length_total_m / 1000) + ' km');
    metric('杆塔总数', stats.count + ' 基');
    metric('耐张 / 直线', stats.tension + ' / ' + stats.suspension + ' 基');
    metric('档距范围', n1(stats.span_min_m) + ' – ' + n1(stats.span_max_m) + ' m');
    metric('平均档距', n1(stats.span_mean_m) + ' m');
    metric('风机接入', stats.feeds + ' 台');
    metric('展示塔型', '06B1-J1 · 呼高 24 m');
    function line(host, text) {
      var row = document.createElement('div'); row.style.cssText = 'padding:8px 0;border-bottom:1px solid rgba(140,180,200,.15);font-size:12px;line-height:1.7';
      row.textContent = text; host.appendChild(row);
    }
    (GRID.lines || []).forEach(function (route) {
      line(routes, route.name + ' · ' + n2(route.length_m / 1000) + ' km · ' + route.span_count + ' 档 · 耐张 ' + route.tension_count + ' 基');
    });
    TOWERS.forEach(function (tower) {
      line(towers, tower.id + ' · ' + (tower.type === 'tension' ? '耐张塔' : '直线塔') +
        ' · 塔基 ' + (Number.isFinite(tower.ground) ? n1(tower.ground) + ' m' : '暂无高程') +
        (Number.isFinite(tower.span_next_m) ? ' · 后档 ' + n1(tower.span_next_m) + ' m' : ''));
    });
  }

  function renderTab(tab) {
    state.tab = tab;
    document.querySelectorAll('#tabs .tab').forEach(function (b) {
      b.classList.toggle('on', b.dataset.tab === tab);
    });
    document.querySelectorAll('.lp').forEach(function (p) {
      p.classList.toggle('on', p.dataset.lp === tab);
    });

    var meta = {
      overview: { t: '场址信息', e: 'SITE INFO' },
      layout:   { t: '电量分析', e: 'ENERGY ANALYSIS' },
      gridline: { t: '集电线路', e: 'COLLECTION LINES' },
      roads: { t: '道路', e: 'ROADS' }
    };
    var m = meta[tab] || meta.overview;
    setT('panelTitle', m.t);
    setT('panelSub', m.e);
    setT('panelCount', MACH.count + ' 台 · ' + n1(ENERGY.capacity_mw) + ' MW');

    if (tab === 'overview') renderOverview();
    if (tab === 'layout') renderLayout();
    if (tab === 'gridline') renderGridline();
    if (tab === 'roads') renderRoads();

    renderDockContext();
    applyLabelMode();
    scene.requestRender();
  }

  /* ---------------------------------------------------------------------------
   * 16. 详情抽屉
   * ------------------------------------------------------------------------ */
  function renderDrawer(t) {
    setT('dId', t.id);
    setT('dCap', n2(t.rated_kw / 1000) + ' MW · CF ' + (t.cf * 100).toFixed(1) + '%');
    setT('dSub', n2(t.rated_kw / 1000) + ' MW');
    setT('dGround', t.ground.toFixed(2));
    setT('dHub', n0(t.hub_abs));
    setT('dV', n2(t.v_mean));
    setT('dNet', n0(t.net_mwh));

    setT('dVw', n2(t.v_wake));
    setT('dGross', n0(t.gross_mwh));
    setT('dWake', Number(t.wake_loss).toFixed(1));
    setT('dHours', n0(t.hours));
    setT('dCf', (t.cf * 100).toFixed(1));
    setT('dRed', (t.reduction * 100).toFixed(1));

    setT('dE', String(Math.round(t.e2000)));
    setT('dN', String(Math.round(t.n2000)));
    setT('dLon', Number(t.lon).toFixed(6));
    setT('dLat', Number(t.lat).toFixed(6));
    setT('dHubH', String(t.hub_h));
    setT('dDem', n1(t.ground_dem));
    setT('dDiff', signed(t.dem_diff));
    setT('dSlope', n1(t.slope));
  }

  /* ---------------------------------------------------------------------------
   * 17. 底部控制台（底图 + 图层 + 场景，唯一入口）
   * ------------------------------------------------------------------------ */
  var GRID_STATS = (GRID && GRID.stats) ? GRID.stats : null;

  var LAYER_DEFS = [
    { k: 'turbines', n: '风机模型', d: '机组实体' },
    { k: 'turbineLabels', n: '风机标签', d: '编号与机组容量' },
    { k: 'towerLabels', n: '杆塔编号', d: '显示每基铁塔编号' },
    { k: 'boundary', n: '场区控制范围', d: '机位凸包外扩' },
    { k: 'roads', n: '场内新建道路', d: '' },
    {
      k: 'grid', n: '35 kV 杆塔与导线',
      d: GRID_STATS
        ? (GRID_STATS.count + ' 基 · ' + (GRID_STATS.length_total_m / 1000).toFixed(1) + ' km')
        : '无杆塔数据'
    }
  ];

  /** 底图源下拉（顶栏）：8 个源两列排布，当前源高亮 */
  function renderBasemapMenu() {
    var host = $('bmPop');
    if (!host) return;

    var cur = null;
    for (var i = 0; i < BASEMAPS.length; i++) {
      if (BASEMAPS[i].id === state.basemap) { cur = BASEMAPS[i]; break; }
    }
    setT('bmCur', cur ? cur.name : '底图源');

    var html = '<div class="bm-head"><b>底图源</b><span>BASEMAP · ' +
               BASEMAPS.length + '</span></div>';
    BASEMAPS.forEach(function (bm) {
      html += '<button class="bm-opt' + (state.basemap === bm.id ? ' on' : '') +
              (bm.disabled ? ' dis' : '') + '" data-bm="' + bm.id + '" title="' +
              bm.name + ' · ' + bm.org + '">' +
              '<b>' + bm.short + '</b><em>' +
              (bm.disabled ? bm.disabledNote : bm.res) + '</em></button>';
    });
    host.innerHTML = html;

    host.querySelectorAll('[data-bm]').forEach(function (el) {
      el.addEventListener('click', function () {
        var def = null;
        for (var k = 0; k < BASEMAPS.length; k++) {
          if (BASEMAPS[k].id === el.dataset.bm) { def = BASEMAPS[k]; break; }
        }
        if (!def) return;
        if (def.disabled) {
          toast('该底图需要天地图 tk，请在 js/config.local.js 中配置');
          return;
        }
        applyBasemap(def);
        closeBaseMenu();
      });
    });
  }

  function openBaseMenu() {
    renderBasemapMenu();
    var w = $('bmWrap');
    if (w) w.classList.add('open');
  }

  function closeBaseMenu() {
    var w = $('bmWrap');
    if (w) w.classList.remove('open');
  }

  /** 图层开关列表 */
  function renderLayerList() {
    var hosts = {wind:$('windLayerList'),grid:$('gridLayerList'),road:$('roadLayerList')};
    Object.keys(hosts).forEach(function(key){hosts[key].textContent='';});

    LAYER_DEFS.forEach(function (L) {
      var host = L.k === 'roads' ? hosts.road : (L.k === 'grid' || L.k === 'towerLabels' ? hosts.grid : hosts.wind);
      var row = document.createElement('button');
      row.className = 'sw-row';
      row.dataset.layer = L.k;
      row.innerHTML = '<span class="sr-l"><b>' + L.n + '</b><em>' + L.d + '</em></span>' +
                      '<span class="sw' + (state.layers[L.k] ? ' on' : '') + '"></span>';
      row.addEventListener('click', function () {
        state.layers[L.k] = !state.layers[L.k];
        row.querySelector('.sw').classList.toggle('on', state.layers[L.k]);
        applyLayers();
      });
      host.appendChild(row);
    });
  }

  /** 场景开关（叶轮旋转；转速滑块单独绑定） */
  function renderSceneList() {
    var host = $('sceneList');
    if (!host) return;
    host.innerHTML = '';

    var row = document.createElement('button');
    row.className = 'sw-row';
    row.dataset.spin = '1';
    row.innerHTML = '<span class="sr-l"><b>叶轮旋转</b><em>动画演示</em></span>' +
                    '<span class="sw' + (state.spin ? ' on' : '') + '"></span>';
    row.addEventListener('click', function () {
      state.spin = !state.spin;
      row.querySelector('.sw').classList.toggle('on', state.spin);
    });
    host.appendChild(row);
  }

  /**
   * 模型放大后重建全部风机。
   * Cesium 的 Entity 几何没有统一 scale，只能按新尺寸重新生成；
   * 8 台 × 约 20 个实体，重建耗时在几十毫秒量级，可接受。
   */
  function rebuildTurbines() {
    turbineMeshes.forEach(function(p){scene.primitives.remove(p);});
    turbineMeshes.length=0; rotorMeshes.length=0; lastRotorAngle=null;
    groups.turbine.forEach(function (e) { viewer.entities.remove(e); });
    groups.turbine.length = 0;
    TURBINES.forEach(buildTurbine);

    var sc = state.turbineScale;
    LABELS.forEach(function (L) {
      L.pos = xyz(L.t.x, L.t.y, L.t.ground + (HUB_H + ROTOR_R) * sc + 8);
    });

    applyLayers();
    updateLabels();
    scene.requestRender();
  }

  /** Only rebuild collection-line geometry; turbine scale is independent. */
  function applyGridScale() {
    buildTowers();
    groups.conductor.forEach(function (e) { viewer.entities.remove(e); });
    groups.conductor.length = 0;
    buildConductors();
    applyLayers();
    scene.requestRender();
  }

  /** 底栏电量条：按年上网电量降序，最高项用绿色强调 */
  function renderTrendBars() {
    var host = $('trendBars');
    if (!host) return;
    host.innerHTML = '';

    var arr = TURBINES.slice().sort(function (a, b) { return b.net_mwh - a.net_mwh; });
    var max = arr.length ? arr[0].net_mwh : 1;
    var min = arr.length ? arr[arr.length - 1].net_mwh : 0;

    arr.forEach(function (t, i) {
      var pct = 12 + 88 * (t.net_mwh - min) / Math.max(1, max - min);
      var row = document.createElement('div');
      row.className = 'bar-row';
      row.innerHTML =
        '<span class="bar-id">' + t.id + '</span>' +
        '<span class="bar-track"><i class="' + (i === 0 ? 'g' : '') +
          '" style="width:' + pct.toFixed(1) + '%"></i></span>' +
        '<span class="bar-v">' + n0(t.net_mwh) + '</span>';
      host.appendChild(row);
    });
  }

  var hourlyPowerNodes = null;
  function updateHourlyTimeline() {
    var source=DATA.hourlyEnergy;
    if(!source)return;
    var i=Math.max(0,Math.min(source.values.length-1,state.energyHour));state.energyHour=i;
    var result=window.allocateHourlyPower(source.values[i],TURBINES);
    $('hourTimeline').max=source.values.length-1;$('hourTimeline').value=i;
    var axis=$('annualAxis'), percent=i/(source.values.length-1)*100;
    axis.style.setProperty('--axis-progress',percent.toFixed(3)+'%');
    axis.style.setProperty('--axis-bubble-left',percent.toFixed(3)+'%');
    setT('axisBubble',source.labels[i]);
    document.querySelectorAll('#axisMonths button').forEach(function(button){
      var active=Number(button.dataset.month)===source.months[i];
      button.classList.toggle('active',active);
      if(active)button.setAttribute('aria-current','date');else button.removeAttribute('aria-current');
    });
    setT('hourFarmPower','全场 '+(source.values[i]/1000).toFixed(2)+' MW');
    if(!hourlyPowerNodes){
      hourlyPowerNodes=[];var host=$('hourTurbinePower');host.textContent='';
      TURBINES.forEach(function(t){
        var row=document.createElement('span');row.className='hour-power-card';
        var heading=document.createElement('span');heading.className='hour-card-heading';
        var name=document.createElement('b');name.textContent=t.id;
        var value=document.createElement('span');heading.appendChild(name);heading.appendChild(value);
        var track=document.createElement('span');track.className='hour-card-track';track.setAttribute('role','progressbar');
        track.setAttribute('aria-label',t.id+'功率占额定容量比例');track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');
        var bar=document.createElement('i');track.appendChild(bar);
        var ratio=document.createElement('span');ratio.className='hour-card-ratio';
        row.appendChild(heading);row.appendChild(track);row.appendChild(ratio);host.appendChild(row);
        hourlyPowerNodes.push({value:value,bar:bar,ratio:ratio,track:track});
      });
    }
    TURBINES.forEach(function(t,index){
      var text=(result.power_kw[index]/1000).toFixed(2)+' MW';
      var percent=Math.max(0,Math.min(100,result.power_kw[index]/t.rated_kw*100));
      var node=hourlyPowerNodes[index];
      node.value.textContent=text;node.bar.style.width=percent.toFixed(2)+'%';
      node.ratio.textContent=percent.toFixed(1)+'%';
      node.track.setAttribute('aria-valuenow',percent.toFixed(1));
      var label=LABELS[index],power=label && label.chip.querySelector('.c-power');
      if(power){power.hidden=state.tab!=='layout' && state.dockTab!=='hourly';power.textContent='估算功率 '+text;}
      var card=label && label.card.querySelector('.cd-hour');
      if(card){card.hidden=state.tab!=='layout' && state.dockTab!=='hourly';card.querySelector('b').textContent=text;}
    });
    if(state.selected){var index=TURBINES.findIndex(function(t){return t.id===state.selected;});
      if(index>=0)setT('hourSelectedPower', (result.power_kw[index]/1000).toFixed(2)+' MW');}
    updateLabels();scene.requestRender();
  }

  function renderDockContext() {
    var isGrid=state.tab==='gridline', isRoad=state.tab==='roads', contextual=isGrid||isRoad;
    var isEnergy=state.tab==='layout';
    $('hourlyEnergyPanel').hidden=!isEnergy;
    LABELS.forEach(function(label){var power=label.chip.querySelector('.c-power');if(power)power.hidden=!isEnergy && state.dockTab!=='hourly';var card=label.card.querySelector('.cd-hour');if(card)card.hidden=!isEnergy && state.dockTab!=='hourly';});
    $('trendBars').hidden=isEnergy;
    if(isEnergy){
      $('turbineSceneControls').hidden=true;
      var energyStats=$('dockContextStats');energyStats.hidden=false;energyStats.textContent='';
      setT('dockContextTitle','8760电量概况');setT('dockContextSub','ENERGY');
      setT('dockChartTitle','风场发电量曲线');setT('dockChartUnit','MWh');
      var hourly=DATA.hourlyEnergy;
      if(!hourly){energyStats.textContent='暂无8760电量数据';return;}
      var entries=[['全年发电量',n2(hourly.stats.total_kwh/1e6)+' GWh'],['有效记录',hourly.stats.hours+' 小时'],['最大小时电量',n1(hourly.stats.max_kwh/1000)+' MWh'],['首次峰值',hourly.stats.peak_time],['零电量时数',hourly.stats.zero_hours+' 小时']];
      entries.forEach(function(entry){var row=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=entry[0];dd.textContent=entry[1];row.appendChild(dt);row.appendChild(dd);energyStats.appendChild(row);});
      window.renderHourlyChart(hourly);updateHourlyTimeline();return;
    }

    $('turbineSceneControls').hidden=contextual;
    var statsHost=$('dockContextStats'), host=$('trendBars');
    statsHost.hidden=!contextual;statsHost.textContent='';
    host.classList.toggle('context-bars',contextual);
    if(!contextual){
      setT('dockContextTitle','场景');setT('dockContextSub','SCENE');
      setT('dockChartTitle','机位年上网电量');setT('dockChartUnit','MWh');
      renderTrendBars();return;
    }
    setT('dockContextTitle',isGrid?'线路概况':'道路概况');
    setT('dockContextSub',isGrid?'GRID':'ROADS');
    setT('dockChartTitle',isGrid?'分线长度与杆塔数量':'道路分段长度');
    setT('dockChartUnit','km');host.textContent='';
    function metric(label,value){
      var row=document.createElement('div'),key=document.createElement('dt'),val=document.createElement('dd');
      key.textContent=label;val.textContent=value;row.appendChild(key);row.appendChild(val);statsHost.appendChild(row);
    }
    var data=isGrid?GRID:DATA.roads;
    if(!data){metric('数据状态','暂无数据');return;}
    var rows;
    if(isGrid){
      metric('线路总长',n2(data.stats.length_total_m/1000)+' km');
      if(data.conductor) metric('导线型号',data.conductor.model);
      metric('杆塔数量',data.stats.count+' 基');
      metric('耐张 / 直线',data.stats.tension+' / '+data.stats.suspension+' 基');
      metric('档距范围',n0(data.stats.span_min_m)+'–'+n0(data.stats.span_max_m)+' m');
      rows=(data.lines||[]).map(function(r){return {id:r.id,length:r.length_m,detail:r.chain.length+' 基塔'};});
    }else{
      metric('道路总长',n2(data.stats.length_m/1000)+' km');
      metric('道路分段',data.stats.count+' 段');
      metric('设计宽度',data.width_m+' m');metric('路面做法',data.surface);
      rows=data.roads.map(function(r){return {id:r.id,length:r.length_m,detail:''};});
    }
    rows.sort(function(a,b){return b.length-a.length;});
    var max=Math.max.apply(null,rows.map(function(r){return r.length;}))||1;
    rows.forEach(function(r){
      var row=document.createElement('div');row.className='bar-row';
      var id=document.createElement('span');id.className='bar-id';id.textContent=r.id;
      var track=document.createElement('span');track.className='bar-track';
      var bar=document.createElement('i');bar.style.width=(r.length/max*100).toFixed(1)+'%';track.appendChild(bar);
      var value=document.createElement('span');value.className='bar-v';value.textContent=n2(r.length/1000);
      row.title=r.id+' · '+n2(r.length/1000)+' km'+(r.detail?' · '+r.detail:'');
      if(r.detail)id.textContent+=' / '+r.detail;
      row.appendChild(id);row.appendChild(track);row.appendChild(value);host.appendChild(row);
    });
  }

  function renderDock() {
    renderBasemapMenu();
    renderLayerList();
    renderSceneList();
    renderDockContext();
  }

  function initDockControls() {
    var sp = $('spinSpeed');
    if (!sp) return;
    sp.value = state.spinSpeed;
    sp.addEventListener('input', function () {
      state.spinSpeed = parseFloat(sp.value);
      setT('spinVal', state.spinSpeed.toFixed(1) + '×');
    });
  }

  /**
   * 三侧面板的显隐统一落地。
   * 布局由 CSS Grid 承担：body 上的 lh-off / rh-off / dh-off 改列宽与行高，
   * 画布尺寸随之变化，必须延时调用 viewer.resize()，否则投影矩阵仍是旧的。
   */
  function applyChrome() {
    document.body.classList.toggle('lh-off', !state.ui.left);
    document.body.classList.toggle('rh-off', !state.ui.right);
    document.body.classList.toggle('dh-off', !state.ui.dock);

    var dk = $('dock');
    if (dk) dk.classList.toggle('collapsed', !state.ui.dock);

    var bl = $('btnLayers');
    if (bl) bl.classList.toggle('on', state.ui.dock);

    // grid 列宽有 .22s 过渡，结束后再 resize 一次，避免画布尺寸与实际容器不一致
    [260, 520].forEach(function (ms) {
      window.setTimeout(function () {
        if (viewer) { viewer.resize(); scene.requestRender(); }
      }, ms);
    });
    scene.requestRender();
  }

  function togglePanel(side) {
    if (side === 'left') state.ui.left = !state.ui.left;
    else if (side === 'right') state.ui.right = !state.ui.right;
    else state.ui.dock = !state.ui.dock;
    applyChrome();
  }

  function applyLayers() {
    turbineMeshes.forEach(function(p){p.show=state.layers.turbines;});
    groups.turbine.forEach(function (e) { e.show = state.layers.turbines; });
    groups.boundary.forEach(function (e) { e.show = state.layers.boundary; });
    groups.roads.forEach(function (e) { e.show = state.layers.roads; });
    groups.grid.forEach(function (e) { e.show = state.layers.grid; });
    groups.tower.forEach(function(e){e.show=state.layers.grid && state.layers.towerLabels;});
    if (towerPrimitive) towerPrimitive.show = !!state.layers.grid;
    if (tensionPrimitive) tensionPrimitive.show = !!state.layers.grid;
    groups.conductor.forEach(function (e) { e.show = state.layers.grid; });
    selRing.show = !!(state.selected && state.layers.turbines);
    updateLabels();
    scene.requestRender();
  }

  /* ---------------------------------------------------------------------------
   * 18. 演示模式
   * ------------------------------------------------------------------------ */
  var SCENES = [
    { title: '项目总览', sub: '全场 8 台机位与场址范围',
      enter: function () { select(null); flyPreset('overview', 1.6); } },
    { title: '场址与地形', sub: '低角度观察地形起伏与场址空间关系',
      enter: function () { select(null); flyPreset('oblique', 1.8); } },
    { title: '机位分布', sub: '顶视查看 8 台机位的相对位置与间距',
      enter: function () { select(null); flyPreset('top', 1.8); } },
    { title: '典型机位', sub: '单机视角：地面高程、轮毂海拔与发电指标',
      enter: function () {
        var best = TURBINES.slice().sort(function (a, b) { return b.net_mwh - a.net_mwh; })[0];
        select(best.id, { fly: true });
      } },
    { title: '回到全场', sub: '结束展示，恢复全场视角',
      enter: function () { select(null); flyPreset('overview', 1.8); } }
  ];

  function buildPresentKpi() {
    $('presentKpi').innerHTML =
      '<div class="pk"><span class="pk-k">装机容量</span><span class="pk-v">' +
        n1(ENERGY.capacity_mw) + '<i>MW</i></span></div>' +
      '<div class="pk"><span class="pk-k">机组台数</span><span class="pk-v">' +
        MACH.count + '<i>台</i></span></div>' +
      '<div class="pk"><span class="pk-k">等效满发</span><span class="pk-v">' +
        n0(ENERGY.hours_net) + '<i>h</i></span></div>' +
      '<div class="pk"><span class="pk-k">年上网电量</span><span class="pk-v">' +
        n1(ENERGY.net_gwh) + '<i>GWh</i></span></div>';
  }

  function presentGo(idx) {
    state.presentIdx = Math.max(0, Math.min(SCENES.length - 1, idx));
    var s = SCENES[state.presentIdx];
    setT('pTitle', s.title);
    setT('pSub', s.sub);
    setT('pIdx', (state.presentIdx + 1) + ' / ' + SCENES.length);
    $('pPrev').disabled = state.presentIdx === 0;
    $('pNext').disabled = state.presentIdx === SCENES.length - 1;
    s.enter();
  }

  function enterPresent() {
    state.mode = 'present';
    document.body.dataset.present = '1';
    presentGo(0);
    window.setTimeout(function () { viewer.resize(); }, 60);
  }

  function exitPresent() {
    state.mode = 'view';
    document.body.dataset.present = '0';
    select(null);
    applyChrome();
    flyPreset('overview', 1.2);
    window.setTimeout(function () { viewer.resize(); }, 60);
  }

  /* ---------------------------------------------------------------------------
   * 19. 交互绑定
   * ------------------------------------------------------------------------ */
  function bind() {
    if(DATA.hourlyEnergy){
      var monthlyAxis=$('axisMonths'),hours=DATA.hourlyEnergy.months,total=hours.length;
      for(var month=1;month<=12;month++){
        var start=hours.indexOf(month),end=hours.lastIndexOf(month)+1;
        if(start<0)continue;
        var tick=document.createElement('button');tick.type='button';tick.className='axis-month';
        tick.textContent=month+'月';tick.dataset.month=month;tick.dataset.hour=start;
        tick.style.left=(start/total*100)+'%';tick.style.width=((end-start)/total*100)+'%';
        tick.title='跳转到'+month+'月1日';
        tick.addEventListener('click',function(){state.energyHour=Number(this.dataset.hour);updateHourlyTimeline();});
        monthlyAxis.appendChild(tick);
      }
    }
    $('hourTimeline').addEventListener('input',function(){state.energyHour=Number(this.value);updateHourlyTimeline();});

    document.querySelectorAll('#dockTabs button').forEach(function(button){
      button.addEventListener('click',function(){
        state.dockTab=button.dataset.dock;
        document.querySelectorAll('#dockTabs button').forEach(function(tab){
          var active=tab===button;tab.classList.toggle('on',active);tab.setAttribute('aria-selected',String(active));
        });
        document.querySelectorAll('[data-dock-pane]').forEach(function(pane){pane.hidden=pane.dataset.dockPane!==button.dataset.dock;});
        updateHourlyTimeline();
      });
    });

    var roadColor = $('roadColor'), roadScale = $('roadScale'), roadTransparency = $('roadTransparency');
    var roadWidthInput = $('roadWidthInput');
    roadWidthInput.value = state.roadStyle.width_m;
    function setRoadWidth() {
      var width = Number(roadWidthInput.value);
      if (!Number.isFinite(width) || width < 1 || width > 60) {
        roadWidthInput.setCustomValidity('请输入1至60米的道路宽度');
        return;
      }
      roadWidthInput.setCustomValidity('');
      state.roadStyle.width_m = width;
      updateRoadStyle();
    }
    roadWidthInput.addEventListener('input', setRoadWidth);
    roadWidthInput.addEventListener('change', function(){
      setRoadWidth();
      if (!roadWidthInput.checkValidity()) {
        roadWidthInput.value = state.roadStyle.width_m;
        roadWidthInput.setCustomValidity('');
      }
    });
    roadColor.value = state.roadStyle.color;
    roadScale.value = state.roadStyle.widthScale;
    roadTransparency.value = Math.round(state.roadStyle.transparency * 100);
    roadColor.addEventListener('input', function(){state.roadStyle.color=roadColor.value;updateRoadStyle();});
    roadScale.addEventListener('input', function(){state.roadStyle.widthScale=parseFloat(roadScale.value);updateRoadStyle();});
    roadTransparency.addEventListener('input', function(){state.roadStyle.transparency=Number(roadTransparency.value)/100;updateRoadStyle();});
    updateRoadStyle();

    document.querySelectorAll('#tabs .tab').forEach(function (b) {
      b.addEventListener('click', function () { renderTab(b.dataset.tab); });
    });

    $('btnHome').addEventListener('click', function () {
      select(null);
      flyPreset('overview');
    });

    $('btnFull').addEventListener('click', function () {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(function () {
          toast('浏览器拒绝了全屏请求', true);
        });
      }
    });

    // 顶栏按钮：展开/收起底部控制台（收起时点它先展开）
    $('btnLayers').addEventListener('click', function () { togglePanel('dock'); });

    // 顶栏底图下拉
    $('btnBase').addEventListener('click', function (ev) {
      ev.stopPropagation();
      if ($('bmWrap').classList.contains('open')) closeBaseMenu();
      else openBaseMenu();
    });
    document.addEventListener('click', function (ev) {
      if (!$('bmWrap').classList.contains('open')) return;
      if (ev.target.closest && ev.target.closest('#bmWrap')) return;
      closeBaseMenu();
    });

    // 风机模型放大：拖动时只更新数值，停手后重建模型（几何体无法整体缩放）
    var sr = $('scaleRange');
    if (sr) {
      sr.value = state.turbineScale;
      setT('scaleVal', state.turbineScale.toFixed(1) + '×');
      var scTimer = null;
      sr.addEventListener('input', function () {
        state.turbineScale = parseFloat(sr.value);
        setT('scaleVal', state.turbineScale.toFixed(1) + '×');
        if (scTimer) clearTimeout(scTimer);
        scTimer = setTimeout(rebuildTurbines, 180);
      });
      sr.addEventListener('change', function () {
        // 键盘方向键或脚本赋值时可能只有 change 没有 input，这里再同步一次
        state.turbineScale = parseFloat(sr.value);
        setT('scaleVal', state.turbineScale.toFixed(1) + '×');
        if (scTimer) clearTimeout(scTimer);
        rebuildTurbines();
      });
    }

    var gridRange = $('gridScaleRange');
    if (gridRange) {
      gridRange.value = state.gridScale;
      setT('gridScaleVal', state.gridScale.toFixed(1) + '×');
      var gridTimer = null;
      function syncGridScale() {
        state.gridScale = parseFloat(gridRange.value);
        setT('gridScaleVal', state.gridScale.toFixed(1) + '×');
      }
      gridRange.addEventListener('input', function () {
        syncGridScale();
        clearTimeout(gridTimer);
        gridTimer = setTimeout(applyGridScale, 180);
      });
      gridRange.addEventListener('change', function () {
        syncGridScale();
        clearTimeout(gridTimer);
        applyGridScale();
      });
    }

    $('panelCollapse').addEventListener('click', function () { togglePanel('left'); });
    $('panelCollapseR').addEventListener('click', function () { togglePanel('right'); });
    $('panelReveal').addEventListener('click', function () { togglePanel('left'); });
    $('panelRevealR').addEventListener('click', function () { togglePanel('right'); });
    $('dockCollapse').addEventListener('click', function () { togglePanel('dock'); });

    $('btnPresent').addEventListener('click', enterPresent);
    $('pExit').addEventListener('click', exitPresent);
    $('pPrev').addEventListener('click', function () { presentGo(state.presentIdx - 1); });
    $('pNext').addEventListener('click', function () { presentGo(state.presentIdx + 1); });

    document.querySelectorAll('#segView button').forEach(function (b) {
      b.addEventListener('click', function () {
        if (state.selected) select(null);
        flyPreset(b.dataset.view);
      });
    });

    $('dClose').addEventListener('click', function () { select(null); });
    $('btnFocus').addEventListener('click', function () {
      if (state.selected) flyUnit(T_BY_ID[state.selected]);
    });

    $('btnSort').addEventListener('click', function () {
      state.sort = state.sort === 'net' ? 'id' : 'net';
      renderLayout();
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        if ($('bmWrap').classList.contains('open')) { closeBaseMenu(); return; }
        if (state.mode === 'present') { exitPresent(); return; }
        if (state.selected) { select(null); return; }
        if (!state.ui.left) { togglePanel('left'); return; }
      }
      if (state.mode === 'present') {
        if (ev.key === 'ArrowRight') presentGo(state.presentIdx + 1);
        if (ev.key === 'ArrowLeft') presentGo(state.presentIdx - 1);
        return;
      }
      if (ev.key === 'r' || ev.key === 'R') { select(null); flyPreset('overview'); }
      if (ev.key === 'f' || ev.key === 'F') { $('btnFull').click(); }
      if (ev.key === 'l' || ev.key === 'L') { togglePanel('left'); }
      if (ev.key === 'c' || ev.key === 'C') { togglePanel('dock'); }
    });

    document.addEventListener('fullscreenchange', function () {
      window.setTimeout(function () { viewer.resize(); }, 120);
    });
    window.addEventListener('resize', function () {
      viewer.resize();
      scene.requestRender();
    });

    // 单击：选中（不移动相机）；双击：选中并进入单机视角
    var handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);

    handler.setInputAction(function (click) {
      var picked = scene.pick(click.position);
      if (Cesium.defined(picked) && picked.id && picked.id.wt) {
        var id = picked.id.wt;
        if (clickTimer) clearTimeout(clickTimer);
        clickTimer = window.setTimeout(function () {
          clickTimer = null;
          select(id, { fly: false });
        }, 240);
      } else {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        if (state.selected) select(null);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    handler.setInputAction(function (dbl) {
      var picked = scene.pick(dbl.position);
      if (Cesium.defined(picked) && picked.id && picked.id.wt) {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        select(picked.id.wt, { fly: true });
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  }

  /* ---------------------------------------------------------------------------
   * 20. 加载
   * ------------------------------------------------------------------------ */
  function setLoad(pct, text) {
    var bar = $('ldBar');
    if (bar) bar.style.width = pct + '%';
    if (text) setT('ldSub', text);
  }
  function hideLoader() {
    var ld = $('loader');
    if (ld) ld.classList.add('hide');
  }
  function nextFrame() {
    return new Promise(function (r) { setTimeout(r, 24); });
  }

  /* ---------------------------------------------------------------------------
   * 21. 启动
   * ------------------------------------------------------------------------ */
  function boot() {
    return nextFrame()
      .then(function () {
        setLoad(18, '初始化三维引擎…');
        return nextFrame();
      })
      .then(function () {
        initBasemap();
        setLoad(34, '构建场区范围与地形…');
        return nextFrame();
      })
      .then(function () {
        buildBoundary();
        setLoad(52, '载入 ' + MACH.count + ' 台机组（实测机位）…');
        return nextFrame();
      })
      .then(function () {
        TURBINES.forEach(buildTurbine);
        setLoad(68, '布置升压站、道路与集电线路…');
        return nextFrame();
      })
      .then(function () {
        // 升压站位置暂取消，保留原始数据及建模函数供后续恢复。
        buildLines();
        buildGridline();
        buildMetMast();
        buildLabels();
        setLoad(82, '准备面板与标签…');
        return nextFrame();
      })
      .then(function () {
        renderTab('overview');
        buildPresentKpi();
        renderDock();
        initDockControls();
        bind();
        applyChrome();
        $('btnLayers').classList.add('on');
        flyPreset('overview', 0);
        var inspectTower = new URLSearchParams(window.location.search).get('tower');
        var focusedTower = inspectTower && (TW_BY_ID[inspectTower] || TOWERS[0]);
        if (focusedTower) {
          var towerCenter = xyz(focusedTower.x, focusedTower.y, focusedTower.ground + 15.35 * state.gridScale);
          viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(towerCenter, 18 * state.gridScale), {
            duration: 0,
            offset: new Cesium.HeadingPitchRange(0.5, -0.18, 50 * state.gridScale)
          });
        }
        applyLayers();
        setLoad(92, '加载地形与影像瓦片…');
        return nextFrame();
      })
      .then(function () {
        // 瓦片未齐时在底坞提示，避免把"正在加载"误认为影像缺陷
        var metaBusy = false;
        scene.globe.tileLoadProgressEvent.addEventListener(function (queued) {
          var busy = queued > 0;
          if (busy === metaBusy) return;
          metaBusy = busy;
          var el = $('dockMeta');
          if (!el) return;
          el.textContent = busy ? '影像加载中…' : '实测机位数据 · ASTER 30 m 地形';
          el.style.color = busy ? 'var(--warn)' : '';
        });

        var done = false;
        var timer = setTimeout(function () {
          if (!done) { done = true; off(); setLoad(100, '部分影像尚未就绪'); hideLoader(); setT('dockMeta', '部分影像尚未就绪，请检查网络或切换底图'); }
        }, 18000);

        var off = scene.globe.tileLoadProgressEvent.addEventListener(function (queued) {
          if (done) return;
          if (queued === 0) {
            done = true;
            clearTimeout(timer);
            setLoad(100, '就绪');
            setTimeout(hideLoader, 420);
            off();
          }
        });
        scene.requestRender();
      });
  }

  /* 诊断接口（浏览器控制台可用） */
  window.__DT = {
    viewer: viewer,
    scene: scene,
    data: DATA,
    state: state,
    towerModel: { id: "06B1-J1-24m-v2", callHeight: 24, height: 30.7, positionPrecision: "float64" },
    heightAt: heightAt,
    enuToLonLat: enuToLonLat,
    select: select,
    flyPreset: flyPreset,
    setBasemap: function (id) {
      var d = BASEMAPS.filter(function (b) { return b.id === id; })[0];
      if (d && !d.disabled) applyBasemap(d);
    }
  };

  boot().catch(function (error) {
    console.error('场景启动失败', error);
    var step = $('ldSub');
    var message = (step ? step.textContent : '初始化') + '：' + (error.message || String(error));
    fatal('场景启动失败', '<p id="bootError"></p><button onclick="location.reload()">重新加载</button>');
    setT('bootError', message);
  });
})();
