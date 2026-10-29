/* =============================================================================
 * 06B1-J1 单回路 35 kV 角钢塔 —— 几何生成模块
 * -----------------------------------------------------------------------------
 * 来源：JNHY-2024-14-021Z-L0202 J1 杆塔竣工图，2025.03，24 m 呼高
 *   全高 30.70 m、呼高（地面→下横担）24.00 m、根开 4.372 m、顶宽 0.400 m
 *   下横担 ±2.550 m @24.00 m；上横担 +2.000 m（单侧）@27.60 m
 *   塔身主材 L100×10 ~ L56×5 变规格，斜材/水平材 L50×4 / L45×4
 *
 * 输出（供 Cesium 直接使用）：
 *   TowerJ1.build() -> {
 *     positions : Float32Array  // 局部坐标，x=横担方向, y=北(线路), z=向上
 *     normals   : Float32Array
 *     indices   : Uint32Array
 *     triCount  : Number
 *     hooks     : [{x, z, phase}]   // 导线挂点（模型局部坐标）
 *     height    : Number            // 全高 30.70
 *   }
 *
 * 坐标约定：
 *   原 Three.js 模型为 y 向上；此处统一绕 x 轴 +90° 变换为 (x, -z, y)，
 *   使高度落在 Cesium 的 z 轴（天顶）。该变换行列式为 +1，三角形绕序不变。
 *
 * 与塔位无关：几何只生成一次，各塔通过 modelMatrix 实例化。
 * ========================================================================== */
window.TowerJ1 = (function () {
  'use strict';

  /* ---------------------------------------------------------------------------
   * 1. 图纸参数
   * ------------------------------------------------------------------------ */
  var DWG = {
    H_TOP: 30.70,          // 全高
    W_BASE: 4.372,         // 塔脚根开（全宽）
    W_TOP: 0.400,          // 塔顶宽度

    ARM_LOW: { h: 24.00, half: 2.550, root: 1.300 },            // 下横担：标高 / 半伸出 / 根部高
    ARM_HIGH: { h: 27.60, half: 2.000, root: 1.000, side: 1 },  // 上横担：单侧 +x

    SEG: [0, 3.0, 6.0, 12.0, 16.0, 17.0, 18.0, 24.0],

    // Drawing 01, 04–07: 3 m legs, 3 m transition, two 6 m body sections.
    PANELS: [
      [0,3], [3,6], [6,8], [8,10], [10,12],
      [12,14], [14,16], [16,17], [17,18],
      [18,19.5], [19.5,21], [21,22.5], [22.5,24],
      [24,25.3], [25.3,26.5], [26.5,27.6],
      [27.6,28.6], [28.6,29.3], [29.3,30], [30,30.7]
    ],
    SINGLE_FROM: 16,
    // Widths at structural joints, metres; drawing centreline dimensions.
    WIDTHS: [[0,4.372],[3,3.982],[6,3.592],[12,2.812],
             [16,2.292],[17,2.162],[18,2.043],[24,1.271],
             [25.3,1.102],[27.6,.803],[28.6,.673],[30.7,.400]],
    source: 'JNHY-2024-14-021Z-L0202 / 01–07',
    callHeight: 24

  };

  // 角钢规格：[肢宽 a, 肢厚 t]（m）
  var ANGLE = {
    'L100×10': [0.100, 0.010],
    'L90×8': [0.090, 0.008],
    'L80×7': [0.080, 0.007],
    'L80×6': [0.080, 0.006],
    'L75×6': [0.075, 0.006],
    'L70×6': [0.070, 0.006],
    'L63×5': [0.063, 0.005],
    'L56×5': [0.056, 0.005],
    'L50×4': [0.050, 0.004],
    'L45×4': [0.045, 0.004]
  };

  // 主材分段规格
  var LEG_SPEC = [
    { to: 6.0, spec: 'L100×10' },
    { to: 12.0, spec: 'L90×8' },
    { to: 16.0, spec: 'L80×7' },
    { to: 18.0, spec: 'L75×6' },
    { to: 24.0, spec: 'L70×6' },
    { to: 27.6, spec: 'L63×5' },
    { to: 30.7, spec: 'L56×5' }
  ];

  var SPEC = {
    brace: 'L50×4',
    horiz: 'L45×4',
    diag: 'L45×4',
    armMain: 'L56×5',
    armWeb: 'L45×4'
  };

  // 截面显示放大：真实角钢肢宽 45~100 mm，在全景缩放下不可辨。
  // 真实比例；总览的可读性由场景显示倍率控制。
  var SECTION_SCALE = 1.0;

  /* 绝缘子串（35 kV 悬垂串，4 片 XWP-70）
     真实片结构高度 146 mm、盘径 252 mm；使用真实尺度。 */
  var INS = { n: 4, pitch: 0.146, upper: 0.085, lower: 0.105, scale: 1.0 };
  var INS_LEN = (INS.upper + INS.n * INS.pitch + INS.lower) * INS.scale;   // ≈1.005 m

  /* 导线挂点（局部坐标，x 为横担方向、z 为标高）
     取绝缘子串下端：下横担 ±half、上横担 +half（单侧）。
     第三相（中相）挂在单侧上横担，与图纸一致。 */
  var HOOKS = [
    { x: -DWG.ARM_LOW.half, z: DWG.ARM_LOW.h - INS_LEN, phase: 'side' },
    { x: DWG.ARM_LOW.half, z: DWG.ARM_LOW.h - INS_LEN, phase: 'side' },
    { x: DWG.ARM_HIGH.half * DWG.ARM_HIGH.side, z: DWG.ARM_HIGH.h - INS_LEN, phase: 'mid' }
  ];

  /* ---------------------------------------------------------------------------
   * 2. 几何工具
   * ------------------------------------------------------------------------ */
  function widthAt(h) {
    var stations = DWG.WIDTHS;
    for (var i = 1; i < stations.length; i++) {
      if (h <= stations[i][0]) {
        var a = stations[i - 1], b = stations[i];
        return a[1] + (b[1] - a[1]) * (h - a[0]) / (b[0] - a[0]);
      }
    }
    return DWG.W_TOP;
  }

  /** 标高 h 处四个角点，顺序：(-,-) (+,-) (+,+) (-,+) */
  function cornerAt(h) {
    var r = widthAt(h) / 2;
    return [[-r, h, -r], [r, h, -r], [r, h, r], [-r, h, r]];
  }

  function unit(v) {
    var L = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / L, v[1] / L, v[2] / L];
  }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function len3(a) { return Math.hypot(a[0], a[1], a[2]); }

  /* ---------------------------------------------------------------------------
   * 3. 构件集合（275 个：主材 / 斜材 / 水平材 / 横隔 / 横担）
   * ------------------------------------------------------------------------ */
  function buildMembers() {
    var list = [];

    // ---- 3.1 塔身主材：四角通长，按分段截断以体现变规格
    for (var si = 0; si < LEG_SPEC.length; si++) {
      var h1 = si === 0 ? 0 : LEG_SPEC[si - 1].to;
      var h2 = LEG_SPEC[si].to;
      var spec = LEG_SPEC[si].spec;
      var cuts = [h1].concat(DWG.WIDTHS.map(function (v) { return v[0]; }).filter(function (h) { return h > h1 && h < h2; }), [h2]);
      for (var cut = 1; cut < cuts.length; cut++) {
        var a = cornerAt(cuts[cut-1]), b = cornerAt(cuts[cut]);
        for (var ci = 0; ci < 4; ci++) {
          var sx = (ci === 1 || ci === 2) ? 1 : -1;
          var sz = ci >= 2 ? 1 : -1;
          list.push({p0:a[ci], p1:b[ci], spec:spec, type:'leg', refU:[-sx,0,0], refV:[0,0,-sz]});
        }
      }
    }

    // ---- 3.2 塔身斜材与水平材
    for (var pi = 0; pi < DWG.PANELS.length; pi++) {
      var pz = DWG.PANELS[pi];
      var hh1 = pz[0], hh2 = pz[1];
      var c1 = cornerAt(hh1), c2 = cornerAt(hh2);
      var single = pi >= DWG.SINGLE_FROM;
      var isLegPanel = (pi === 0);

      for (var f = 0; f < 4; f++) {
        var f2 = (f + 1) % 4;
        var nrm = [[0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0]][f];
        var refU = [-nrm[0], 0, -nrm[2]];
        var refV = [nrm[2], 0, -nrm[0]];

        var A = c1[f], B = c1[f2], C = c2[f], D = c2[f2];

        if (isLegPanel) {
          // 塔腿段：人字撑
          var mid = [(C[0] + D[0]) / 2, hh2, (C[2] + D[2]) / 2];
          list.push({ p0: A, p1: mid, spec: SPEC.brace, type: 'brace', refU: refU, refV: refV });
          list.push({ p0: B, p1: mid, spec: SPEC.brace, type: 'brace', refU: refU, refV: refV });
        } else if (single) {
          if (pi % 2 === 0) {
            list.push({ p0: A, p1: D, spec: SPEC.brace, type: 'brace', refU: refU, refV: refV });
          } else {
            list.push({ p0: B, p1: C, spec: SPEC.brace, type: 'brace', refU: refU, refV: refV });
          }
        } else {
          list.push({ p0: A, p1: D, spec: SPEC.brace, type: 'brace', refU: refU, refV: refV });
          list.push({ p0: B, p1: C, spec: SPEC.brace, type: 'brace', refU: refU, refV: refV });
        }

        // 节间顶部水平材
        list.push({
          p0: c2[f], p1: c2[f2], spec: SPEC.horiz, type: 'horiz',
          refU: [0, -1, 0], refV: [nrm[0], 0, nrm[2]]
        });
      }
    }

    // ---- 3.3 横隔（水平面交叉），只设于主要分段标高
    var DIAPHRAGM_AT = [3, 6, 12, 16, 17, 18, 24, 25.3, 26.5, 27.6, 28.6, 30.7];
    for (var di = 0; di < DIAPHRAGM_AT.length; di++) {
      var c = cornerAt(DIAPHRAGM_AT[di]);
      list.push({ p0: c[0], p1: c[2], spec: SPEC.diag, type: 'horiz', refU: [0, -1, 0], refV: [1, 0, 0] });
      list.push({ p0: c[1], p1: c[3], spec: SPEC.diag, type: 'horiz', refU: [0, -1, 0], refV: [0, 0, 1] });
    }

    // ---- 3.4 横担：四棱台空间桁架
    function armOneSide(h, half, rootH, tipH, tipZ, dir) {
      var hs = h + rootH;
      var rB = widthAt(h) / 2;
      var rT = widthAt(hs) / 2;

      function node(t, top, s) {
        var x0 = top ? rT : rB;
        var z0 = top ? rT : rB;
        return [
          dir * (x0 + (half - x0) * t),
          top ? (h + rootH * (1 - t) + tipH * t) : h,
          s * (z0 + (tipZ - z0) * t)
        ];
      }

      for (var s = -1; s <= 1; s += 2) {
        list.push({ p0: node(0, false, s), p1: node(1, false, s), spec: SPEC.armMain,
                    type: 'arm', refU: [0, -1, 0], refV: [0, 0, -s] });
        list.push({ p0: node(0, true, s), p1: node(1, true, s), spec: SPEC.armMain,
                    type: 'arm', refU: [0, -1, 0], refV: [0, 0, -s] });
      }

      for (var s2 = -1; s2 <= 1; s2 += 2) {
        list.push({ p0: node(1, false, s2), p1: node(1, true, s2), spec: SPEC.armWeb,
                    type: 'arm', refU: [-dir, 0, 0], refV: [0, 0, -s2] });
      }
      list.push({ p0: node(1, true, -1), p1: node(1, true, 1), spec: SPEC.armWeb, type: 'arm',
                  refU: [0, -1, 0], refV: [-dir, 0, 0] });
      list.push({ p0: node(1, false, -1), p1: node(1, false, 1), spec: SPEC.armWeb, type: 'arm',
                  refU: [0, -1, 0], refV: [-dir, 0, 0] });

      for (var s3 = -1; s3 <= 1; s3 += 2) {
        list.push({ p0: node(0.5, false, s3), p1: node(0.5, true, s3), spec: SPEC.armWeb,
                    type: 'arm', refU: [-dir, 0, 0], refV: [0, 0, -s3] });
      }
      list.push({ p0: node(0.5, true, -1), p1: node(0.5, true, 1), spec: SPEC.armWeb, type: 'arm',
                  refU: [0, -1, 0], refV: [-dir, 0, 0] });

      for (var s4 = -1; s4 <= 1; s4 += 2) {
        list.push({ p0: node(0, false, s4), p1: node(0.5, true, s4), spec: SPEC.armWeb, type: 'arm',
                    refU: [0, 0, -s4], refV: [-dir, 0, 0] });
        list.push({ p0: node(0.5, false, s4), p1: node(1, true, s4), spec: SPEC.armWeb, type: 'arm',
                    refU: [0, 0, -s4], refV: [-dir, 0, 0] });
      }
    }

    armOneSide(DWG.ARM_LOW.h, DWG.ARM_LOW.half, DWG.ARM_LOW.root, 0.0, 0.160, +1);
    armOneSide(DWG.ARM_LOW.h, DWG.ARM_LOW.half, DWG.ARM_LOW.root, 0.0, 0.160, -1);
    armOneSide(DWG.ARM_HIGH.h, DWG.ARM_HIGH.half, DWG.ARM_HIGH.root, 0.0, 0.060, DWG.ARM_HIGH.side);

    return list;
  }

  /* ---------------------------------------------------------------------------
   * 4. 角钢 L 形截面拉伸
   *    返回 [x,y,z, nx,ny,nz] 扁平数组（每顶点 6 分量），直接拼接到总缓冲
   * ------------------------------------------------------------------------ */
  function pushAngle(out, p0, p1, a, t, refU, refV) {
    var ax = unit(sub(p1, p0));

    var u = sub(refU, [ax[0] * dot(refU, ax), ax[1] * dot(refU, ax), ax[2] * dot(refU, ax)]);
    if (len3(u) < 1e-6) u = cross(ax, [0, 1, 0]);
    u = unit(u);

    var v = sub(refV, [ax[0] * dot(refV, ax), ax[1] * dot(refV, ax), ax[2] * dot(refV, ax)]);
    v = sub(v, [u[0] * dot(v, u), u[1] * dot(v, u), u[2] * dot(v, u)]);
    if (len3(v) < 1e-6) v = cross(ax, u);
    v = unit(v);

    var sec = [[0, 0], [a, 0], [a, t], [t, t], [t, a], [0, a]];
    var N = sec.length;

    function P(o, s) {
      return [
        o[0] + u[0] * s[0] + v[0] * s[1],
        o[1] + u[1] * s[0] + v[1] * s[1],
        o[2] + u[2] * s[0] + v[2] * s[1]
      ];
    }
    var A = [], B = [];
    for (var q = 0; q < N; q++) { A.push(P(p0, sec[q])); B.push(P(p1, sec[q])); }

    function quad(p, n) {
      // 两个三角形，分开写顶点以保留硬边法线
      out.push(p[0][0], p[0][1], p[0][2], n[0], n[1], n[2]);
      out.push(p[1][0], p[1][1], p[1][2], n[0], n[1], n[2]);
      out.push(p[2][0], p[2][1], p[2][2], n[0], n[1], n[2]);
      out.push(p[0][0], p[0][1], p[0][2], n[0], n[1], n[2]);
      out.push(p[2][0], p[2][1], p[2][2], n[0], n[1], n[2]);
      out.push(p[3][0], p[3][1], p[3][2], n[0], n[1], n[2]);
    }

    // 侧面
    for (var i = 0; i < N; i++) {
      var j = (i + 1) % N;
      var e1 = sub(A[j], A[i]);
      var e2 = sub(B[i], A[i]);
      var nn = unit(cross(e1, e2));
      quad([A[i], A[j], B[j], B[i]], nn);
    }

    // 两端封口（六边形扇形三角化）
    var capTris = [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5]];
    for (var c1i = 0; c1i < capTris.length; c1i++) {
      var tr = capTris[c1i];
      out.push(A[tr[0]][0], A[tr[0]][1], A[tr[0]][2], -ax[0], -ax[1], -ax[2]);
      out.push(A[tr[1]][0], A[tr[1]][1], A[tr[1]][2], -ax[0], -ax[1], -ax[2]);
      out.push(A[tr[2]][0], A[tr[2]][1], A[tr[2]][2], -ax[0], -ax[1], -ax[2]);
    }
    for (var c2i = 0; c2i < capTris.length; c2i++) {
      var tr2 = capTris[c2i];
      out.push(B[tr2[2]][0], B[tr2[2]][1], B[tr2[2]][2], ax[0], ax[1], ax[2]);
      out.push(B[tr2[1]][0], B[tr2[1]][1], B[tr2[1]][2], ax[0], ax[1], ax[2]);
      out.push(B[tr2[0]][0], B[tr2[0]][1], B[tr2[0]][2], ax[0], ax[1], ax[2]);
    }
  }

  /* ---------------------------------------------------------------------------
   * 5. 绝缘子串（简化：芯棒 + 3 个扁盘，低多边形）
   *    真实串体在全景不可辨，这里只保留"悬垂串"的视觉符号。
   * ------------------------------------------------------------------------ */
  /** 六棱柱：平面 (x, z)，沿高度 y 轴拉伸。参数与 Three.js 的 (x, y=高, z) 一致 */
  function pushDiscHex(out, cx, cz, yCenter, r, thick) {
    var seg = 16, ang, i;
    var top = [], bot = [];
    for (i = 0; i < seg; i++) {
      ang = i / seg * Math.PI * 2;
      var px = cx + Math.cos(ang) * r;
      var pz = cz + Math.sin(ang) * r;
      top.push([px, yCenter + thick / 2, pz]);
      bot.push([px, yCenter - thick / 2, pz]);
    }
    for (i = 0; i < seg; i++) {
      var j = (i + 1) % seg;
      var nx = Math.cos((i + 0.5) / seg * Math.PI * 2);
      var nz = Math.sin((i + 0.5) / seg * Math.PI * 2);
      var L = Math.hypot(nx, nz) || 1;
      var n = [nx / L, 0, nz / L];
      out.push(bot[i][0], bot[i][1], bot[i][2], n[0], n[1], n[2]);
      out.push(bot[j][0], bot[j][1], bot[j][2], n[0], n[1], n[2]);
      out.push(top[j][0], top[j][1], top[j][2], n[0], n[1], n[2]);
      out.push(bot[i][0], bot[i][1], bot[i][2], n[0], n[1], n[2]);
      out.push(top[j][0], top[j][1], top[j][2], n[0], n[1], n[2]);
      out.push(top[i][0], top[i][1], top[i][2], n[0], n[1], n[2]);
    }
    // 上下封口
    for (i = 0; i < seg; i++) {
      var k = (i + 1) % seg;
      out.push(cx, yCenter + thick / 2, cz, 0, 1, 0);
      out.push(top[i][0], top[i][1], top[i][2], 0, 1, 0);
      out.push(top[k][0], top[k][1], top[k][2], 0, 1, 0);
      out.push(cx, yCenter - thick / 2, cz, 0, -1, 0);
      out.push(bot[k][0], bot[k][1], bot[k][2], 0, -1, 0);
      out.push(bot[i][0], bot[i][1], bot[i][2], 0, -1, 0);
    }
  }

  // Revolved porcelain skirt: narrow neck, sloped canopy and rounded lower lip.
  function pushShed(out, cx, cy, scale) {
    var profile = [[-.045,.036],[-.028,.112],[-.014,.126],[.002,.120],[.035,.048],[.045,.032]];
    var segments = 16;
    for (var ring = 0; ring < profile.length - 1; ring++) {
      for (var i = 0; i < segments; i++) {
        var a = i * Math.PI * 2 / segments, b = (i + 1) * Math.PI * 2 / segments;
        function point(row, angle) {
          return [cx + row[1] * scale * Math.cos(angle), cy + row[0] * scale, row[1] * scale * Math.sin(angle)];
        }
        var p = point(profile[ring], a), q = point(profile[ring], b);
        var r = point(profile[ring + 1], b), t = point(profile[ring + 1], a);
        var n = unit(cross(sub(q, p), sub(r, p)));
        [p,q,r,p,r,t].forEach(function (v) { out.push(v[0],v[1],v[2],n[0],n[1],n[2]); });
      }
    }
  }

  function pushInsulators(out) {
    var K = INS.scale;
    var pitch = INS.pitch * K;
    var upper = INS.upper * K;

    for (var hi = 0; hi < HOOKS.length; hi++) {
      var hk = HOOKS[hi];
      var x = hk.x;
      var top = hk.z + INS_LEN;          // 横担端部挂点
      // 芯棒
      pushDiscHex(out, x, 0, top - INS_LEN / 2 + 0.02, 0.019 * K, INS_LEN - 0.04);
      // 四片伞裙
      for (var p = 0; p < INS.n; p++) {
        var zc = top - upper - p * pitch - pitch / 2;
        pushShed(out, x, zc, K);
      }
    }
  }

  /* ---------------------------------------------------------------------------
   * 6. 构建（含坐标轴变换）
   * ------------------------------------------------------------------------ */
  var CACHE = {};

  function build(tension) {
    var key = tension ? 'tension' : 'suspension';
    if (CACHE[key]) return CACHE[key];

    var members = buildMembers();

    // 先按 Three.js 坐标（y 向上）累积
    var flat = [];
    for (var i = 0; i < members.length; i++) {
      var mb = members[i];
      var at = ANGLE[mb.spec];
      pushAngle(flat, mb.p0, mb.p1, at[0] * SECTION_SCALE, at[1] * SECTION_SCALE, mb.refU, mb.refV);
    }
    if (!tension) pushInsulators(flat);

    // Make winding agree with the supplied outward normals, including end caps.
    for (var face = 0; face < flat.length; face += 18) {
      var ab = [flat[face+6]-flat[face], flat[face+7]-flat[face+1], flat[face+8]-flat[face+2]];
      var ac = [flat[face+12]-flat[face], flat[face+13]-flat[face+1], flat[face+14]-flat[face+2]];
      if (dot(cross(ab, ac), flat.slice(face+3, face+6)) < 0) {
        for (var component = 0; component < 6; component++) {
          var temporary = flat[face+6+component];
          flat[face+6+component] = flat[face+12+component];
          flat[face+12+component] = temporary;
        }
      }
    }

    // 变换：(x, y, z)_three -> (x, -z, y)_cesium，绕 x 轴 +90°，绕序不变
    var vCount = flat.length / 6;
    var positions = new Float32Array(vCount * 3);
    var normals = new Float32Array(vCount * 3);
    for (var k = 0; k < vCount; k++) {
      var o = k * 6;
      positions[k * 3] = flat[o];
      positions[k * 3 + 1] = -flat[o + 2];
      positions[k * 3 + 2] = flat[o + 1];

      normals[k * 3] = flat[o + 3];
      normals[k * 3 + 1] = -flat[o + 5];
      normals[k * 3 + 2] = flat[o + 4];
    }

    // 顶点不共享（硬边法线），索引即 0..N-1
    var indices = new Uint32Array(vCount);
    for (var m = 0; m < vCount; m++) indices[m] = m;

    var hooks = HOOKS.map(function (h) {
      // 挂点同样变换：x 不变，z(高度) 保持为 Cesium 的 z
      return { x: h.x, z: h.z, phase: h.phase };
    });

    CACHE[key] = {
      positions: positions,
      normals: normals,
      indices: indices,
      triCount: vCount / 3,
      hooks: hooks,
      height: DWG.H_TOP,
      memberCount: members.length
    };
    return CACHE[key];
  }

  return {
    build: build,
    DWG: DWG,
    HOOKS: HOOKS,
    INS_LEN: INS_LEN,
    HEIGHT: DWG.H_TOP,
    widthAt: widthAt,
    members: buildMembers
  };
})();
