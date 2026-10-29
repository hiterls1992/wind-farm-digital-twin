/* Tower +x is the crossarm; +y follows the route. */
(function (root) {
  function tangents(towers, spans) {
    var byId = {}, directions = {}, result = {};
    towers.forEach(function (t) { byId[t.id] = t; directions[t.id] = []; });
    spans.forEach(function (span) {
      var a = byId[span.from], b = byId[span.to];
      if (!a || !b) return;
      var dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
      if (length < 1e-6) return;
      var d = {x: dx / length, y: dy / length};
      directions[a.id].push(d); directions[b.id].push(d);
    });
    towers.forEach(function (t) {
      var ds = directions[t.id], x = 0, y = 0, ref = ds[0];
      ds.forEach(function (d) {
        // Route directions are axes: align signs before averaging, otherwise
        // incoming and outgoing spans cancel and yield a transverse bisector.
        var sign = d.x * ref.x + d.y * ref.y < 0 ? -1 : 1;
        x += sign * d.x; y += sign * d.y;
      });
      var length = Math.hypot(x, y);
      var tx = length > 1e-6 ? x / length : 0;
      var ty = length > 1e-6 ? y / length : 1;
      result[t.id] = {tx: tx, ty: ty, rx: ty, ry: -tx};
    });
    return result;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = tangents;
  else root.towerRouteTangents = tangents;
})(typeof window !== 'undefined' ? window : globalThis);
