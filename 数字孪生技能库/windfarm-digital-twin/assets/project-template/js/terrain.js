(function (root) {
  function create(DATA) {
    var BLEND = DATA.terrainBlend, BASE_ELEV = BLEND.base;
  var LV = [DATA.levels.L0, DATA.levels.L1, DATA.levels.L2];
  var LV_NAME = ['L0', 'L1', 'L2'];

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

  function levelWeight(i, r) {
    var lv = LV[i];
    var half = lv.half;
    var inner = BLEND.inner[LV_NAME[i]] * half;
    if (r <= inner) return 1;
    if (r >= half) return 0;
    return smooth((half - r) / (half - inner));
  }

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

    return heightAt;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = create;
  else root.createTerrainHeight = create;
})(typeof window !== "undefined" ? window : globalThis);
