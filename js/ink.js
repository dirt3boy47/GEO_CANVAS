/* GeoCanvas web — georeferenced ink.
   Elements store geographic coordinates. Geometry is built once in a local frame whose unit is one
   screen pixel at the zoom the element was drawn at (z0), anchored at its first point; drawing at
   zoom z only needs translate(anchor) · scale(2^(z − z0)). Ink therefore scales with the map like
   ink on paper and never drifts from its coordinates. */
(function (global) {
  'use strict';
  var Geo = global.Geo;
  var uid = function () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 9); };

  var INKS = {
    ballpoint: { label: 'Ballpoint', width: 2.5, opacity: 1, range: [0.5, 16] },
    fountain: { label: 'Fountain pen', width: 4, opacity: 1, range: [1, 20] },
    pencil: { label: 'Pencil', width: 3, opacity: 0.9, range: [1, 20] },
    highlighter: { label: 'Highlighter', width: 22, opacity: 0.38, range: [6, 80] },
    marker: { label: 'Marker', width: 8, opacity: 0.92, range: [3, 40] },
    handwriting: { label: 'Handwriting', width: 3.2, opacity: 1, range: [1, 14] }
  };

  // ---------- geometry helpers ----------
  function dist(a, b) { var dx = a[0] - b[0], dy = a[1] - b[1]; return Math.sqrt(dx * dx + dy * dy); }
  function distToSeg(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    if (!l2) return dist(p, a);
    var t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    return dist(p, [a[0] + t * dx, a[1] + t * dy]);
  }
  function distToLine(p, pts) { if (pts.length === 1) return dist(p, pts[0]); var m = Infinity; for (var i = 1; i < pts.length; i++) m = Math.min(m, distToSeg(p, pts[i - 1], pts[i])); return m; }
  function inPoly(ring, p) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var a = ring[i], b = ring[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  function simplify(pts, tol) { // Ramer–Douglas–Peucker
    if (pts.length < 3) return pts.slice();
    var keep = new Array(pts.length).fill(false); keep[0] = keep[pts.length - 1] = true;
    var stack = [[0, pts.length - 1]];
    while (stack.length) {
      var se = stack.pop(), s = se[0], e = se[1], md = -1, idx = s;
      for (var i = s + 1; i < e; i++) { var d = distToSeg(pts[i], pts[s], pts[e]); if (d > md) { md = d; idx = i; } }
      if (md > tol) { keep[idx] = true; stack.push([s, idx], [idx, e]); }
    }
    return pts.filter(function (_, i) { return keep[i]; });
  }

  // ---------- stroke outline (same algorithm as the native GeoCanvasCore) ----------
  function radius(ink, w, s, dir) {
    var p = s.p;
    switch (ink) {
      case 'ballpoint': return w / 2 * (0.82 + 0.3 * p);
      case 'handwriting': return w / 2 * (0.35 + 1.15 * Math.pow(p, 0.75));
      case 'pencil': { var tilt = 1 - Math.min(1, Math.max(0, s.alt / (Math.PI / 2))); return w / 2 * (0.55 + 0.6 * p) * (1 + 2.2 * tilt * tilt); }
      case 'fountain': {
        var nib = s.alt < 1.4 ? s.az + Math.PI / 2 : 40 * Math.PI / 180;
        var k = Math.abs(Math.sin(Math.atan2(dir[1], dir[0]) - nib));
        return w / 2 * (0.28 + 0.95 * k) * (0.7 + 0.6 * p);
      }
      default: return w / 2;
    }
  }

  function samples(el, anchor, unit) {
    var out = [], last = null;
    for (var i = 0; i < el.pts.length; i++) {
      var q = el.pts[i], m = Geo.merc(q[0], q[1]);
      var s = { x: (m[0] - anchor[0]) / unit, y: (m[1] - anchor[1]) / unit, p: q[2] < 0 ? 0.5 : Math.min(1, q[2]), alt: q[3], az: q[4] };
      if (!last || Math.hypot(s.x - last.x, s.y - last.y) >= 0.2 || i === el.pts.length - 1) { out.push(s); last = s; }
    }
    // [1 2 1] smoothing
    if (out.length > 2) {
      var sm = out.map(function (o) { return Object.assign({}, o); });
      for (var j = 1; j < out.length - 1; j++) {
        sm[j].x = (out[j - 1].x + 2 * out[j].x + out[j + 1].x) / 4; sm[j].y = (out[j - 1].y + 2 * out[j].y + out[j + 1].y) / 4;
        sm[j].p = (out[j - 1].p + 2 * out[j].p + out[j + 1].p) / 4;
      }
      out = sm;
    }
    // Catmull-Rom subdivision
    if (out.length > 2) {
      var res = [out[0]];
      for (var a = 0; a < out.length - 1; a++) {
        var p0 = out[Math.max(0, a - 1)], p1 = out[a], p2 = out[a + 1], p3 = out[Math.min(out.length - 1, a + 2)];
        var n = Math.min(16, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2));
        for (var kk = 1; kk < n; kk++) {
          var t = kk / n, t2 = t * t, t3 = t2 * t;
          var f = function (c) { return 0.5 * (2 * p1[c] + (p2[c] - p0[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * t3); };
          res.push({ x: f('x'), y: f('y'), p: p1.p + (p2.p - p1.p) * t, alt: p1.alt + (p2.alt - p1.alt) * t, az: p1.az });
        }
        res.push(p2);
      }
      out = res;
    }
    return out;
  }

  function circle(c, r, n) { var o = []; for (var i = 0; i < n; i++) { var a = i / n * 2 * Math.PI; o.push([c.x + r * Math.cos(a), c.y + r * Math.sin(a)]); } return o; }

  function outline(S, ink, w) {
    if (!S.length) return [];
    if (S.length === 1) return circle(S[0], Math.max(0.4, radius(ink, w, S[0], [1, 0])), 20);
    var n = S.length, total = 0, i;
    for (i = 1; i < n; i++) total += Math.hypot(S[i].x - S[i - 1].x, S[i].y - S[i - 1].y);
    var taper = Math.min(total * 0.25, w * (ink === 'ballpoint' ? 1 : 3));
    var r = [], nx = [], ny = [], d = 0;
    for (i = 0; i < n; i++) {
      if (i) d += Math.hypot(S[i].x - S[i - 1].x, S[i].y - S[i - 1].y);
      var pv = S[Math.max(0, i - 1)], nv = S[Math.min(n - 1, i + 1)];
      var dx = nv.x - pv.x, dy = nv.y - pv.y, L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      var rr = radius(ink, w, S[i], [dx, dy]);
      if (taper > 0 && ink !== 'pencil') { var ease = function (t) { return 1 - (1 - t) * (1 - t); }; rr *= 0.45 + 0.55 * Math.min(ease(Math.min(1, d / taper)), ease(Math.min(1, (total - d) / taper))); }
      r.push(Math.max(0.25, rr)); nx.push(-dy); ny.push(dx);
    }
    var rs = r.slice(); for (i = 1; i < n - 1; i++) rs[i] = (r[i - 1] + 2 * r[i] + r[i + 1]) / 4;
    var left = [], right = [];
    for (i = 0; i < n; i++) { left.push([S[i].x + nx[i] * rs[i], S[i].y + ny[i] * rs[i]]); right.push([S[i].x - nx[i] * rs[i], S[i].y - ny[i] * rs[i]]); }
    function arc(c, ax, ay, rad) { var st = Math.atan2(ay, ax), o = []; for (var k = 1; k < 8; k++) { var t = st - k / 8 * Math.PI; o.push([c.x + rad * Math.cos(t), c.y + rad * Math.sin(t)]); } return o; }
    return left.concat(arc(S[n - 1], nx[n - 1], ny[n - 1], rs[n - 1]), right.reverse(), arc(S[0], -nx[0], -ny[0], rs[0]));
  }

  function shapeOutline(el) { // mercator points of a shape's outline
    var m = el.verts.map(function (v) { return Geo.merc(v[0], v[1]); });
    if (el.kind === 'ellipse' && m.length === 4) {
      var c = [(m[0][0] + m[2][0]) / 2, (m[0][1] + m[2][1]) / 2], u = [(m[1][0] - m[0][0]) / 2, (m[1][1] - m[0][1]) / 2], v = [(m[3][0] - m[0][0]) / 2, (m[3][1] - m[0][1]) / 2], o = [];
      for (var i = 0; i < 72; i++) { var t = i / 72 * 2 * Math.PI; o.push([c[0] + u[0] * Math.cos(t) + v[0] * Math.sin(t), c[1] + u[1] * Math.cos(t) + v[1] * Math.sin(t)]); }
      return o;
    }
    return m;
  }
  function isClosed(el) { return el.kind === 'rectangle' || el.kind === 'ellipse' || el.kind === 'polygon'; }

  /** Builds the cached render geometry of an element: {anchor (mercator), unit, kind, path, bounds (local)} */
  function build(el) {
    var unit = 1 / (256 * Math.pow(2, el.z0));
    if (el.type === 'stroke') {
      var a = Geo.merc(el.pts[0][0], el.pts[0][1]);
      var S = samples(el, a, unit), path = new Path2D(), pts;
      var line = el.ink === 'highlighter' || el.ink === 'marker';
      if (line) { pts = S.map(function (s) { return [s.x, s.y]; }); } else { pts = outline(S, el.ink, el.width); }
      pts.forEach(function (p, i) { if (i) path.lineTo(p[0], p[1]); else path.moveTo(p[0], p[1]); });
      if (!line) path.closePath();
      if (line && pts.length === 1) path.lineTo(pts[0][0] + 0.01, pts[0][1]);
      return { anchor: a, unit: unit, line: line, path: path, local: pts, bounds: bbox(pts, el.width * (line ? 0.6 : 1.6)) };
    }
    if (el.type === 'shape') {
      var mo = shapeOutline(el), an = mo[0], lp = mo.map(function (m) { return [(m[0] - an[0]) / unit, (m[1] - an[1]) / unit]; });
      var sp = new Path2D(); lp.forEach(function (p, i) { if (i) sp.lineTo(p[0], p[1]); else sp.moveTo(p[0], p[1]); });
      if (isClosed(el)) sp.closePath();
      var all = lp.slice();
      if (el.kind === 'arrow' && lp.length >= 2) {
        var A = lp[lp.length - 2], B = lp[lp.length - 1], dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1;
        var hl = Math.min(Math.max(el.width * 4.5, 12), L * 0.45); dx /= L; dy /= L;
        var back = [B[0] - dx * hl, B[1] - dy * hl], side = [-dy * hl * 0.55, dx * hl * 0.55];
        var w1 = [back[0] + side[0], back[1] + side[1]], w2 = [back[0] - side[0], back[1] - side[1]];
        sp.moveTo(w1[0], w1[1]); sp.lineTo(B[0], B[1]); sp.lineTo(w2[0], w2[1]); all.push(w1, w2);
      }
      return { anchor: an, unit: unit, path: sp, local: lp, bounds: bbox(all, el.width * 2) };
    }
    if (el.type === 'text') {
      var ta = Geo.merc(el.at[0], el.at[1]), w = el.text.length * el.size * 0.62 + el.size * 0.7, h = el.size * 1.5;
      return { anchor: ta, unit: unit, bounds: [-w / 2, -h / 2, w / 2, h / 2] };
    }
    return null;
  }
  function bbox(pts, pad) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    pts.forEach(function (p) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); });
    return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
  }

  /** Mercator bounds of an element (for hit tests, culling, selection boxes). */
  function mercBounds(el) {
    if (el.type === 'marker') { var m = Geo.merc(el.at[0], el.at[1]); return [m[0], m[1], m[0], m[1]]; }
    var g = el._g || (el._g = build(el)); var b = g.bounds, u = g.unit, a = g.anchor;
    return [a[0] + b[0] * u, a[1] + b[1] * u, a[0] + b[2] * u, a[1] + b[3] * u];
  }

  var grainCache = {};
  function pencilPattern(ctx, color) {
    if (grainCache[color]) return grainCache[color];
    var c = document.createElement('canvas'); c.width = c.height = 48;
    var x = c.getContext('2d'), rgb = hexRgb(color);
    for (var i = 0; i < 48; i++) for (var j = 0; j < 48; j++) { var n = Math.random(); x.fillStyle = 'rgba(' + rgb.join(',') + ',' + (0.35 + 0.65 * n * n).toFixed(2) + ')'; x.fillRect(i, j, 1, 1); }
    return (grainCache[color] = ctx.createPattern(c, 'repeat'));
  }
  function hexRgb(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }

  /** Draws an element into a 2D context whose transform maps layer pixels; `pt(merc)` gives that pixel; `s` = zoom ratio. */
  function draw(ctx, el, pt, zoom, layerOpacity, preview) {
    if (el.type === 'marker') return;
    var g = el._g || (el._g = build(el)); if (!g) return;
    var s = Math.pow(2, zoom - el.z0);
    var a = g.anchor;
    if (preview) { var tm = preview(a); a = tm.a; s *= tm.k; }
    var o = pt(a);
    ctx.save();
    ctx.translate(o[0], o[1]); ctx.scale(s, s);
    var alpha = (el.opacity == null ? 1 : el.opacity) * layerOpacity;
    ctx.globalAlpha = alpha;
    if (el.type === 'stroke') {
      if (g.line) {
        ctx.strokeStyle = el.color; ctx.lineWidth = el.width; ctx.lineJoin = 'round'; ctx.lineCap = el.ink === 'marker' ? 'round' : 'butt';
        ctx.stroke(g.path);
      } else {
        ctx.fillStyle = el.ink === 'pencil' ? pencilPattern(ctx, el.color) : el.color;
        ctx.fill(g.path, 'nonzero');
      }
    } else if (el.type === 'shape') {
      if (isClosed(el) && el.fill) { ctx.fillStyle = el.color; ctx.globalAlpha = alpha * 0.25; ctx.fill(g.path); ctx.globalAlpha = alpha; }
      ctx.strokeStyle = el.color; ctx.lineWidth = el.width; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      if (el.dashed && ctx.setLineDash) ctx.setLineDash([el.width * 3, el.width * 2]);
      ctx.stroke(g.path);
    } else if (el.type === 'text') {
      ctx.font = '600 ' + el.size + 'px -apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif';
      var w = ctx.measureText(el.text).width, h = el.size * 1.35;
      ctx.fillStyle = 'rgba(15,20,18,0.55)';
      roundRect(ctx, -w / 2 - el.size * 0.35, -h / 2, w + el.size * 0.7, h, el.size * 0.3); ctx.fill();
      ctx.fillStyle = el.color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(el.text, 0, el.size * 0.04);
    }
    ctx.restore();
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  // ---------- Leaflet integration: one canvas path per element ----------
  var InkPath = L.Path.extend({
    options: { interactive: false },
    initialize: function (el, layerOpacity) { this.el = el; this.layerOpacity = layerOpacity == null ? 1 : layerOpacity; L.setOptions(this, { interactive: false }); },
    setElement: function (el) { this.el = el; el._g = null; return this.redraw(); },
    _project: function () {
      var map = this._map, z = map.getZoom(), el = this.el;
      var W = 256 * Math.pow(2, z), origin = map.getPixelOrigin();
      this._pt = function (m) { return [m[0] * W - origin.x, m[1] * W - origin.y]; };
      var b = mercBounds(el), pad = el.type === 'marker' ? 30 : 2;
      var p1 = this._pt([b[0], b[1]]), p2 = this._pt([b[2], b[3]]);
      if (this.preview) { var t1 = this.preview([b[0], b[1]]), t2 = this.preview([b[2], b[3]]); p1 = this._pt(t1.a); p2 = this._pt(t2.a); }
      this._pxBounds = L.bounds([Math.min(p1[0], p2[0]) - pad, Math.min(p1[1], p2[1]) - pad], [Math.max(p1[0], p2[0]) + pad, Math.max(p1[1], p2[1]) + pad]);
    },
    _update: function () { if (this._map) this._updatePath(); },
    _updatePath: function () {
      var r = this._renderer; if (!r || !r._drawing || this.hidden) return;
      draw(r._ctx, this.el, this._pt, this._map.getZoom(), this.layerOpacity, this.preview);
    },
    _containsPoint: function () { return false; }
  });

  // ---------- editing operations (mercator space) ----------
  function mapCoords(el, f) {
    var c = JSON.parse(JSON.stringify(stripCache(el)));
    var g = function (ll) { var m = Geo.merc(ll[0], ll[1]), r = f(m), u = Geo.unmerc(r[0], r[1]); ll[0] = u[0]; ll[1] = u[1]; };
    if (c.pts) c.pts.forEach(g); if (c.verts) c.verts.forEach(g); if (c.at) g(c.at);
    return c;
  }
  function stripCache(el) { var c = {}; for (var k in el) if (k !== '_g') c[k] = el[k]; return c; }
  function translate(el, dx, dy) { return mapCoords(el, function (m) { return [m[0] + dx, m[1] + dy]; }); }
  function scale(el, ax, ay, k) {
    var c = mapCoords(el, function (m) { return [ax + (m[0] - ax) * k, ay + (m[1] - ay) * k]; });
    if (c.type !== 'marker') c.z0 = el.z0 - Math.log(k) / Math.LN2; // widths scale with the element
    return c;
  }

  function mercPoints(el) {
    if (el.type === 'stroke') return el.pts.map(function (q) { return Geo.merc(q[0], q[1]); });
    if (el.type === 'shape') return shapeOutline(el);
    return [Geo.merc(el.at[0], el.at[1])];
  }

  /** Erase along a mercator path. mode 'object' removes whole items; 'precision' splits strokes. */
  function erase(items, path, radius, mode) {
    var removed = [], added = [];
    items.forEach(function (el) {
      var b = mercBounds(el);
      var pb = bboxM(path, radius + 1e-12);
      if (b[2] < pb[0] || b[0] > pb[2] || b[3] < pb[1] || b[1] > pb[3]) return;
      if (el.type === 'stroke') {
        var unit = 1 / (256 * Math.pow(2, el.z0)), thr = radius + el.width * unit / 2;
        var mp = mercPoints(el), hit = mp.map(function (m) { return distToLine(m, path) <= thr; });
        if (!hit.some(Boolean)) {
          // Sparse strokes (e.g. drawn with a mouse): test segments, not only sample points.
          var touched = false;
          for (var s1 = 1; s1 < mp.length && !touched; s1++) for (var s2 = 1; s2 < path.length; s2++) if (segDist(mp[s1 - 1], mp[s1], path[s2 - 1], path[s2]) <= thr) { touched = true; break; }
          if (!touched) return;
          if (mode === 'precision') { el = densify(el, thr / 2); mp = mercPoints(el); hit = mp.map(function (m) { return distToLine(m, path) <= thr; }); }
        }
        removed.push(items.filter(function (x) { return x.id === el.id; })[0] || el);
        if (mode === 'precision') {
          var run = [];
          var flush = function () { if (run.length >= 2) { var p = stripCache(el); p = JSON.parse(JSON.stringify(p)); p.id = uid(); p.pts = run; added.push(p); } run = []; };
          el.pts.forEach(function (q, i) { if (hit[i]) flush(); else run.push(q); });
          flush();
        }
      } else if (el.type === 'shape') {
        var o = shapeOutline(el); if (isClosed(el)) o = o.concat([o[0]]);
        var u2 = 1 / (256 * Math.pow(2, el.z0));
        if (path.some(function (p) { return distToLine(p, o) <= radius + el.width * u2 / 2; }) || (el.fill && isClosed(el) && path.some(function (p) { return inPoly(o, p); }))) removed.push(el);
      } else {
        var mb = mercBounds(el);
        if (path.some(function (p) { return p[0] >= mb[0] - radius * 3 && p[0] <= mb[2] + radius * 3 && p[1] >= mb[1] - radius * 3 && p[1] <= mb[3] + radius * 3; })) removed.push(el);
      }
    });
    return { removed: removed, added: added };
  }
  function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
  function segDist(a, b, c, d) {
    var d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
    return Math.min(distToSeg(a, c, d), distToSeg(b, c, d), distToSeg(c, a, b), distToSeg(d, a, b));
  }
  /** Copy of a stroke with extra samples so no segment is longer than `step` (mercator units). */
  function densify(el, step) {
    var c = JSON.parse(JSON.stringify(stripCache(el))), out = [c.pts[0]];
    for (var i = 1; i < c.pts.length; i++) {
      var a = c.pts[i - 1], b = c.pts[i], ma = Geo.merc(a[0], a[1]), mb = Geo.merc(b[0], b[1]), n = Math.min(400, Math.ceil(dist(ma, mb) / step));
      for (var k = 1; k < n; k++) { var t = k / n, u = Geo.unmerc(ma[0] + (mb[0] - ma[0]) * t, ma[1] + (mb[1] - ma[1]) * t); out.push([u[0], u[1], a[2] + (b[2] - a[2]) * t, a[3], a[4]]); }
      out.push(b);
    }
    c.pts = out; return c;
  }
  function bboxM(pts, pad) { var b = [Infinity, Infinity, -Infinity, -Infinity]; pts.forEach(function (p) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); }); return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad]; }

  /** Items selected by a lasso (mercator ring): ≥ half their points inside; handwriting groups together. */
  function lasso(items, ring) {
    var sel = {}, groups = {};
    items.forEach(function (el) {
      var pts = mercPoints(el), inside = pts.filter(function (p) { return inPoly(ring, p); }).length;
      if (pts.length && inside >= pts.length * 0.5) { sel[el.id] = true; if (el.group) groups[el.group] = true; }
    });
    items.forEach(function (el) { if (el.group && groups[el.group]) sel[el.id] = true; });
    return sel;
  }

  global.Ink = { INKS: INKS, uid: uid, build: build, draw: draw, InkPath: InkPath, mercBounds: mercBounds, translate: translate, scale: scale,
    erase: erase, lasso: lasso, simplify: simplify, shapeOutline: shapeOutline, isClosed: isClosed, outline: outline, samples: samples,
    stripCache: stripCache, mercPoints: mercPoints, inPoly: inPoly, distToLine: distToLine };
})(typeof window !== 'undefined' ? window : global);
