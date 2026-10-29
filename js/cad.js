/* GeoCanvas web — DXF drawings as reference layers.
   A DXF (AutoCAD's open exchange format) is read in the browser and shown as one reference layer: the model-space
   linework in its CAD colours, plus its text, with no per-CAD-layer features. Blocks (INSERT, with arrays), arcs and
   polyline bulges, ellipses, splines, solids, leaders and dimension graphics are drawn; hatches and other fills
   are left out. CAD layers that are switched off or frozen in the drawing stay hidden.
   Placement: drawings in MGA coordinates (most civil design) land in place after confirming the zone/datum;
   drawings in local coordinates are turned into an image and placed like a plan (georeferencer). */
(function (global) {
  'use strict';
  var GC = global.GC, Geo = global.Geo, Ink = global.Ink, $ = GC.$, esc = GC.esc;
  var MAX_VERTICES = 2500000, MAX_DEPTH = 8; // points kept are stored compactly (see encode) and drawn with level of detail

  // ---------- AutoCAD colour index → RGB ----------
  var ACI = (function () {
    var t = [null, '#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ffffff', '#808080', '#c0c0c0'];
    var lv = [1, 1, 0.65, 0.65, 0.5, 0.5, 0.3, 0.3, 0.15, 0.15];
    for (var i = 10; i < 250; i++) {
      var h = Math.floor((i - 10) / 10) * 15, k = (i - 10) % 10, v = lv[k], s = k % 2 ? 0.5 : 1;
      var c = (1 - Math.abs((h / 60) % 2 - 1)), rgb = h < 60 ? [1, c, 0] : h < 120 ? [c, 1, 0] : h < 180 ? [0, 1, c] : h < 240 ? [0, c, 1] : h < 300 ? [c, 0, 1] : [1, 0, c];
      t[i] = '#' + rgb.map(function (x) { var y = Math.round(255 * v * (1 - s + s * x)); return (y < 16 ? '0' : '') + y.toString(16); }).join('');
    }
    [51, 91, 132, 173, 214, 255].forEach(function (g, j) { var h = (g < 16 ? '0' : '') + g.toString(16); t[250 + j] = '#' + h + h + h; });
    return t;
  })();
  function trueColor(n) { var s = (n & 0xffffff).toString(16); while (s.length < 6) s = '0' + s; return '#' + s; }

  // ---------- reading group codes ----------
  /** Splits a DXF into entities: [{type, codes: [[code, value], …]}] per section, plus layer table and blocks. */
  function parse(text) {
    var L = text.split(/\r\n|\r|\n/), n = L.length, i = 0;
    var next = function () { if (i + 1 >= n) return null; var c = parseInt(L[i], 10), v = L[i + 1]; i += 2; return [c, v]; };
    var out = { header: {}, layers: {}, blocks: {}, entities: [] }, section = null, pair, ent = null, block = null, hvar = null;
    var flush = function () {
      if (!ent) return;
      if (section === 'ENTITIES') out.entities.push(ent);
      else if (section === 'BLOCKS') {
        if (ent.type === 'BLOCK') { block = { name: g(ent, 2), base: [num(ent, 10), num(ent, 20)], ents: [] }; out.blocks[block.name] = block; }
        else if (ent.type === 'ENDBLK') block = null;
        else if (block) block.ents.push(ent);
      } else if (section === 'TABLES' && ent.type === 'LAYER') {
        var c = parseInt(g(ent, 62), 10), tc = g(ent, 420);
        out.layers[g(ent, 2)] = { color: tc != null ? trueColor(+tc) : ACI[Math.abs(c)] || '#ffffff', off: c < 0, frozen: (parseInt(g(ent, 70), 10) & 1) === 1 };
      }
      ent = null;
    };
    while ((pair = next())) {
      var code = pair[0], val = pair[1].trim();
      if (code === 0) {
        flush();
        if (val === 'SECTION') { pair = next(); section = pair ? pair[1].trim() : null; continue; }
        if (val === 'ENDSEC') { section = null; continue; }
        if (val === 'EOF') break;
        if (section === 'TABLES' && (val === 'TABLE' || val === 'ENDTAB')) continue;
        if (section === 'ENTITIES' || section === 'BLOCKS' || section === 'TABLES') ent = { type: val, codes: [] };
        continue;
      }
      if (section === 'HEADER') { if (code === 9) hvar = val; else if (hvar) out.header[hvar + ':' + code] = val; continue; }
      if (ent) ent.codes.push([code, pair[1]]);
    }
    flush();
    return out;
  }
  function g(e, code) { for (var k = 0; k < e.codes.length; k++) if (e.codes[k][0] === code) return e.codes[k][1].trim(); return null; }
  function num(e, code, d) { var v = g(e, code); return v == null || v === '' ? (d == null ? 0 : d) : parseFloat(v); }

  // ---------- 2D affine transforms [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f ----------
  function mul(m, k) { return [m[0] * k[0] + m[2] * k[1], m[1] * k[0] + m[3] * k[1], m[0] * k[2] + m[2] * k[3], m[1] * k[2] + m[3] * k[3], m[0] * k[4] + m[2] * k[5] + m[4], m[1] * k[4] + m[3] * k[5] + m[5]]; }
  var I = [1, 0, 0, 1, 0, 0];
  function ocs(e) { return num(e, 230, 1) < 0 ? [-1, 0, 0, 1, 0, 0] : I; } // entities drawn with extrusion (0,0,-1) are mirrored in x

  /** Turns parsed entities into world-coordinate polylines and texts (drawing units). */
  function geometry(d) {
    var lines = [], texts = [], fills = [], skipped = {}, vcount = 0, truncated = false;
    var layerOf = function (e, ctx) { var l = g(e, 8) || '0'; return l === '0' && ctx.layer ? ctx.layer : l; };
    var colorOf = function (e, ctx, layer) {
      var tc = g(e, 420); if (tc != null) return trueColor(+tc);
      var c = parseInt(g(e, 62), 10);
      if (c === 0) return ctx.color || '#ffffff';                       // BYBLOCK
      if (!isNaN(c) && c !== 256 && ACI[Math.abs(c)]) return ACI[Math.abs(c)];
      return (d.layers[layer] && d.layers[layer].color) || ctx.layerColor || '#ffffff'; // BYLAYER
    };
    var hidden = function (layer) { var l = d.layers[layer]; return l && (l.off || l.frozen); };
    var poly = function (m, pts, color, closed) {
      if (truncated || pts.length < 2) return;
      var a = [];
      pts.forEach(function (p) { a.push(m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]); });
      if (closed) a.push(a[0], a[1]);
      vcount += a.length / 2; if (vcount > MAX_VERTICES) { truncated = true; return; }
      lines.push({ c: color, p: a });
    };
    /** A filled area (hatch, MPOLYGON): rings of points, drawn even-odd. solid: a solid fill (else a pattern, shown as a tint). */
    var fill = function (m, rings, color, solid) {
      if (truncated) return;
      var rs = [];
      rings.forEach(function (pts) {
        if (pts.length < 3) return;
        var a = []; pts.forEach(function (p) { a.push(m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]); });
        vcount += a.length / 2; rs.push(a);
      });
      if (vcount > MAX_VERTICES) { truncated = true; return; }
      if (rs.length) fills.push({ c: color, s: !!solid, r: rs });
    };
    var arcPts = function (cx, cy, r, a0, a1) { // radians, counter-clockwise
      while (a1 <= a0) a1 += 2 * Math.PI;
      var n = Math.max(6, Math.ceil((a1 - a0) / (Math.PI / 36))), out = [];
      for (var k = 0; k <= n; k++) { var t = a0 + (a1 - a0) * k / n; out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
      return out;
    };
    var bulgePts = function (v) { // polyline vertices [x, y, bulge] → points, arcs expanded
      var out = [];
      for (var k = 0; k < v.length; k++) {
        out.push([v[k][0], v[k][1]]);
        var b = v[k][2], nx = v[(k + 1) % v.length];
        if (b && k + 1 < v.length + (v.closed ? 1 : 0) && nx) {
          var x1 = v[k][0], y1 = v[k][1], x2 = nx[0], y2 = nx[1], th = 4 * Math.atan(b), ch = Math.hypot(x2 - x1, y2 - y1);
          if (ch === 0) continue;
          var r = ch / (2 * Math.sin(Math.abs(th) / 2)), mx = (x1 + x2) / 2, my = (y1 + y2) / 2, h = Math.sqrt(Math.max(0, r * r - ch * ch / 4));
          var ux = -(y2 - y1) / ch, uy = (x2 - x1) / ch, sgn = (b > 0) === (Math.abs(th) < Math.PI) ? 1 : -1;
          var cx = mx + sgn * h * ux, cy = my + sgn * h * uy, s = Math.atan2(y1 - cy, x1 - cx), e = Math.atan2(y2 - cy, x2 - cx);
          var arc = b > 0 ? arcPts(cx, cy, r, s, e) : arcPts(cx, cy, r, e, s).reverse();
          for (var q = 1; q < arc.length - 1; q++) out.push(arc[q]);
        }
      }
      return out;
    };
    var text = function (m, s, x, y, h, rot, ax, ay, color) {
      s = String(s || '').trim(); if (!s || !h) return;
      var p = [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]], sc = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
      var dir = Math.atan2(m[1] * Math.cos(rot) + m[3] * Math.sin(rot), m[0] * Math.cos(rot) + m[2] * Math.sin(rot));
      texts.push({ c: color, x: p[0], y: p[1], h: h * sc, r: dir * 180 / Math.PI, ax: ax, ay: ay, s: s });
    };
    var mtext = function (s) {
      return s.replace(/\\P/g, '\n').replace(/\\U\+([0-9a-f]{4})/gi, function (x, h) { return String.fromCharCode(parseInt(h, 16)); })
        .replace(/\\[ACcFfHhQqTtWw][^;]*;/g, '').replace(/\\[LlOoKk]/g, '').replace(/\\S([^;]*);/g, function (x, f) { return f.replace(/[#^]/, '/'); })
        .replace(/[{}]/g, '').replace(/\\\\/g, '\\').replace(/\\~/g, ' ');
    };
    var special = function (s) { return s.replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[uUoO]/g, ''); };

    /** Boundary rings of a HATCH or MPOLYGON: polyline paths (with bulges) or edge paths (lines, arcs, ellipse arcs, splines). */
    var hatchRings = function (e) {
      var c = e.codes, i = 0, rings = [], D = Math.PI / 180;
      while (i < c.length && c[i][0] !== 91) i++;
      if (i >= c.length) return rings;
      var np = parseInt(c[i][1], 10) || 0; i++;
      var at = function (code) { return i < c.length && c[i][0] === code; };
      var read = function (code, d) { // the next value with this code, but never past the next path or the end of the boundaries
        while (i < c.length && c[i][0] !== code) { var k = c[i][0]; if (k === 92 || k === 75 || k === 76 || k === 98) return d; i++; }
        if (i >= c.length) return d; var v = parseFloat(c[i][1]); i++; return isNaN(v) ? d : v;
      };
      for (var p = 0; p < np && i < c.length; p++) {
        while (i < c.length && c[i][0] !== 92) { if (c[i][0] === 75 || c[i][0] === 76 || c[i][0] === 98) return rings; i++; }
        if (i >= c.length) break;
        var flag = parseInt(c[i][1], 10) || 0; i++;
        var pts = [];
        if (flag & 2) { // polyline path
          var hasB = read(72, 0), nv = (read(73, 1), read(93, 0)), v = [];
          for (var k = 0; k < nv; k++) { var x = read(10, 0), y = read(20, 0), b = hasB && at(42) ? read(42, 0) : 0; v.push([x, y, b]); }
          v.closed = true; pts = bulgePts(v);
        } else { // edge path
          var ne = read(93, 0);
          for (var k2 = 0; k2 < ne; k2++) {
            var et = read(72, 0) | 0, seg = [];
            if (et === 1) seg = [[read(10, 0), read(20, 0)], [read(11, 0), read(21, 0)]];
            else if (et === 2) {
              var cx = read(10, 0), cy = read(20, 0), r = read(40, 0), a0 = read(50, 0) * D, a1 = read(51, 0) * D, ccw = read(73, 1);
              seg = ccw ? arcPts(cx, cy, r, a0, a1) : arcPts(cx, cy, r, -a1, -a0).reverse(); // clockwise arcs are stored mirrored
            } else if (et === 3) {
              var ex = read(10, 0), ey = read(20, 0), mx = read(11, 0), my = read(21, 0), ratio = read(40, 1), s0 = read(50, 0) * D, s1 = read(51, 360) * D, eccw = read(73, 1);
              if (!eccw) { var t0 = -s1; s1 = -s0; s0 = t0; }
              while (s1 <= s0) s1 += 2 * Math.PI;
              var nn = Math.max(8, Math.ceil((s1 - s0) / (Math.PI / 36)));
              for (var q = 0; q <= nn; q++) { var t = s0 + (s1 - s0) * q / nn; seg.push([ex + mx * Math.cos(t) - ratio * my * Math.sin(t), ey + my * Math.cos(t) + ratio * mx * Math.sin(t)]); }
              if (!eccw) seg.reverse();
            } else if (et === 4) {
              var deg = read(94, 3), rat = (read(73, 0)), nk = (read(74, 0), read(95, 0)), nc = read(96, 0), codes = [[71, String(deg)]];
              for (var kk = 0; kk < nk; kk++) codes.push([40, String(read(40, 0))]);
              for (var cc = 0; cc < nc; cc++) { codes.push([10, String(read(10, 0))], [20, String(read(20, 0))]); if (rat && at(42)) codes.push([41, String(read(42, 1))]); }
              if (at(97) && i + 1 < c.length && c[i + 1][0] === 11) { var nf = read(97, 0); for (var ff = 0; ff < nf; ff++) codes.push([11, String(read(11, 0))], [21, String(read(21, 0))]); }
              seg = spline({ codes: codes });
            }
            seg.forEach(function (pt, j) { var last = pts[pts.length - 1]; if (j === 0 && last && Math.abs(last[0] - pt[0]) < 1e-9 && Math.abs(last[1] - pt[1]) < 1e-9) return; pts.push(pt); });
          }
        }
        if (pts.length >= 3) rings.push(pts);
      }
      return rings;
    };

    function draw(ents, m, ctx, depth) {
      for (var k = 0; k < ents.length; k++) {
        var e = ents[k], t = e.type;
        if (g(e, 67) === '1') continue; // paper space
        var layer = layerOf(e, ctx); if (hidden(layer)) continue;
        var color = colorOf(e, ctx, layer), mo = mul(m, ocs(e));
        switch (t) {
          case 'LINE': poly(m, [[num(e, 10), num(e, 20)], [num(e, 11), num(e, 21)]], color); break;
          case 'LWPOLYLINE': {
            var v = [], cur = null;
            e.codes.forEach(function (c) { if (c[0] === 10) { cur = [parseFloat(c[1]), 0, 0]; v.push(cur); } else if (c[0] === 20 && cur) cur[1] = parseFloat(c[1]); else if (c[0] === 42 && cur) cur[2] = parseFloat(c[1]); });
            v.closed = (parseInt(g(e, 70), 10) & 1) === 1;
            poly(mo, bulgePts(v), color, v.closed); break;
          }
          case 'POLYLINE': {
            var fl = parseInt(g(e, 70), 10) || 0; if (fl & (16 | 64)) { skipped['mesh'] = (skipped['mesh'] || 0) + 1; break; }
            var vs = (e.vertices || []).filter(function (x) { return !((parseInt(g(x, 70), 10) || 0) & 128); }).map(function (x) { return [num(x, 10), num(x, 20), num(x, 42)]; });
            vs.closed = (fl & 1) === 1;
            poly(fl & 8 ? m : mo, bulgePts(vs), color, vs.closed); break;
          }
          case 'ARC': poly(mo, arcPts(num(e, 10), num(e, 20), num(e, 40), num(e, 50) * Math.PI / 180, num(e, 51) * Math.PI / 180), color); break;
          case 'CIRCLE': poly(mo, arcPts(num(e, 10), num(e, 20), num(e, 40), 0, 2 * Math.PI), color); break;
          case 'ELLIPSE': {
            var cx = num(e, 10), cy = num(e, 20), mx = num(e, 11), my = num(e, 21), ra = num(e, 40, 1), p0 = num(e, 41, 0), p1 = num(e, 42, 2 * Math.PI), pts = [];
            while (p1 <= p0) p1 += 2 * Math.PI;
            var n = Math.max(12, Math.ceil((p1 - p0) / (Math.PI / 36)));
            for (var q = 0; q <= n; q++) { var u = p0 + (p1 - p0) * q / n; pts.push([cx + mx * Math.cos(u) - my * ra * Math.sin(u), cy + my * Math.cos(u) + mx * ra * Math.sin(u)]); }
            poly(mo, pts, color); break;
          }
          case 'SPLINE': poly(m, spline(e), color); break;
          case 'SOLID': case 'TRACE': case '3DFACE': {
            var c4 = [[num(e, 10), num(e, 20)], [num(e, 11), num(e, 21)], [num(e, 12), num(e, 22)], [num(e, 13, num(e, 12)), num(e, 23, num(e, 22))]];
            poly(t === '3DFACE' ? m : mo, t === '3DFACE' ? c4 : [c4[0], c4[1], c4[3], c4[2]], color, true); break;
          }
          case 'LEADER': { var lp = [], lc = null; e.codes.forEach(function (c) { if (c[0] === 10) { lc = [parseFloat(c[1]), 0]; lp.push(lc); } else if (c[0] === 20 && lc) lc[1] = parseFloat(c[1]); }); poly(m, lp, color); break; }
          case 'TEXT': case 'ATTRIB': {
            if (t === 'ATTRIB' && (parseInt(g(e, 70), 10) & 1)) break; // invisible attribute
            var hj = parseInt(g(e, 72), 10) || 0, vj = parseInt(g(e, t === 'TEXT' ? 73 : 74), 10) || 0, al = (hj || vj) && g(e, 11) != null;
            text(mo, special(g(e, 1) || ''), al ? num(e, 11) : num(e, 10), al ? num(e, 21) : num(e, 20), num(e, 40, 1), num(e, 50) * Math.PI / 180,
              [0, 0.5, 1, 0, 0.5, 0][hj] || 0, [0, 0, 0.5, 1][vj] || 0, color); break;
          }
          case 'MTEXT': {
            var s = ''; e.codes.forEach(function (c) { if (c[0] === 3) s += c[1]; }); s += g(e, 1) || '';
            var att = (parseInt(g(e, 71), 10) || 1) - 1, rot = g(e, 11) != null ? Math.atan2(num(e, 21), num(e, 11)) : num(e, 50) * Math.PI / 180;
            text(m, special(mtext(s)), num(e, 10), num(e, 20), num(e, 40, 1), rot, [0, 0.5, 1][att % 3], [1, 0.5, 0][Math.floor(att / 3)], color); break;
          }
          case 'INSERT': case 'DIMENSION': {
            var b = d.blocks[g(e, 2)]; if (!b || depth >= MAX_DEPTH) break;
            var sub = { layer: layer, color: color, layerColor: (d.layers[layer] || {}).color };
            if (t === 'DIMENSION') { draw(b.ents, m, sub, depth + 1); break; } // dimension blocks are already in world coordinates
            var sx = num(e, 41, 1), sy = num(e, 42, 1), r = num(e, 50) * Math.PI / 180, cols = Math.max(1, num(e, 70, 1)), rows = Math.max(1, num(e, 71, 1)), dx = num(e, 44), dy = num(e, 45);
            for (var ci = 0; ci < Math.min(cols, 200); ci++) for (var ri = 0; ri < Math.min(rows, 200); ri++) {
              var bm = mul(mo, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), num(e, 10), num(e, 20)]);
              bm = mul(bm, [1, 0, 0, 1, ci * dx, ri * dy]);
              bm = mul(bm, [sx, 0, 0, sy, -b.base[0] * sx, -b.base[1] * sy]);
              draw(b.ents, bm, sub, depth + 1);
            }
            if (e.attribs) draw(e.attribs, m, ctx, depth + 1);
            break;
          }
          case 'HATCH': case 'MPOLYGON': {
            var rings = hatchRings(e), solid = g(e, 70) === '1' || /^SOLID$/i.test(g(e, 2) || '');
            fill(mo, rings, color, solid);
            if (!solid) rings.forEach(function (rg) { poly(mo, rg, color, true); }); // patterns: their outline, and a light tint
            break;
          }
          case 'POINT': case 'VIEWPORT': case 'SEQEND': case 'VERTEX': case 'ATTDEF': break;
          default: skipped[t] = (skipped[t] || 0) + 1;
        }
      }
    }
    // POLYLINE/INSERT entities own the VERTEX/ATTRIB entities that follow them (up to SEQEND).
    var group = function (ents) {
      var out = [];
      for (var k = 0; k < ents.length; k++) {
        var e = ents[k];
        if ((e.type === 'POLYLINE' || (e.type === 'INSERT' && g(e, 66) === '1'))) {
          var kids = []; while (k + 1 < ents.length && ents[k + 1].type !== 'SEQEND' && (ents[k + 1].type === 'VERTEX' || ents[k + 1].type === 'ATTRIB')) kids.push(ents[++k]);
          if (k + 1 < ents.length && ents[k + 1].type === 'SEQEND') k++;
          if (e.type === 'POLYLINE') e.vertices = kids; else e.attribs = kids;
        }
        out.push(e);
      }
      return out;
    };
    Object.keys(d.blocks).forEach(function (k) { d.blocks[k].ents = group(d.blocks[k].ents); });
    draw(group(d.entities), I, {}, 0);
    return { lines: lines, texts: texts, fills: fills, skipped: skipped, truncated: truncated, points: vcount };
  }
  /** B-spline (with weights) from control points and knots; fit points when there are no control points. */
  function spline(e) {
    var deg = parseInt(g(e, 71), 10) || 3, knots = [], cp = [], w = [], fit = [], cur = null, fcur = null;
    e.codes.forEach(function (c) {
      if (c[0] === 40) knots.push(parseFloat(c[1])); else if (c[0] === 41) w.push(parseFloat(c[1]));
      else if (c[0] === 10) { cur = [parseFloat(c[1]), 0]; cp.push(cur); } else if (c[0] === 20 && cur) cur[1] = parseFloat(c[1]);
      else if (c[0] === 11) { fcur = [parseFloat(c[1]), 0]; fit.push(fcur); } else if (c[0] === 21 && fcur) fcur[1] = parseFloat(c[1]);
    });
    if (cp.length < deg + 1 || knots.length !== cp.length + deg + 1) return fit.length ? fit : cp;
    var out = [], lo = knots[deg], hi = knots[knots.length - deg - 1], N = Math.max(16, cp.length * 8);
    for (var s = 0; s <= N; s++) {
      var u = lo + (hi - lo) * s / N, k = deg;
      while (k < knots.length - deg - 2 && u >= knots[k + 1]) k++;
      var dpts = [];
      for (var j = 0; j <= deg; j++) { var P = cp[k - deg + j], ww = w.length ? w[k - deg + j] : 1; dpts.push([P[0] * ww, P[1] * ww, ww]); }
      for (var r = 1; r <= deg; r++) for (j = deg; j >= r; j--) {
        var i = k - deg + j, den = knots[i + deg - r + 1] - knots[i], a = den ? (u - knots[i]) / den : 0;
        dpts[j] = [(1 - a) * dpts[j - 1][0] + a * dpts[j][0], (1 - a) * dpts[j - 1][1] + a * dpts[j][1], (1 - a) * dpts[j - 1][2] + a * dpts[j][2]];
      }
      out.push([dpts[deg][0] / dpts[deg][2], dpts[deg][1] / dpts[deg][2]]);
    }
    return out;
  }

  // ---------- placing on the map ----------
  function extent(geo) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    geo.lines.forEach(function (l) { for (var k = 0; k < l.p.length; k += 2) { if (l.p[k] < b[0]) b[0] = l.p[k]; if (l.p[k] > b[2]) b[2] = l.p[k]; if (l.p[k + 1] < b[1]) b[1] = l.p[k + 1]; if (l.p[k + 1] > b[3]) b[3] = l.p[k + 1]; } });
    (geo.fills || []).forEach(function (f) { f.r.forEach(function (p) { for (var k = 0; k < p.length; k += 2) { if (p[k] < b[0]) b[0] = p[k]; if (p[k] > b[2]) b[2] = p[k]; if (p[k + 1] < b[1]) b[1] = p[k + 1]; if (p[k + 1] > b[3]) b[3] = p[k + 1]; } }); });
    geo.texts.forEach(function (t) { b[0] = Math.min(b[0], t.x); b[2] = Math.max(b[2], t.x); b[1] = Math.min(b[1], t.y); b[3] = Math.max(b[3], t.y); });
    return b;
  }
  /** 'mga' (metres), 'mga-mm' (millimetres), 'geo' (lon/lat) or 'local'. */
  function kindOf(b) {
    var inMga = function (k) { return b[0] >= 100000 * k && b[2] <= 900000 * k && b[1] >= 6000000 * k && b[3] <= 10000000 * k; };
    if (inMga(1)) return 'mga'; if (inMga(1000)) return 'mga-mm';
    if (b[0] >= -180 && b[2] <= 180 && b[1] >= -90 && b[3] <= 90 && b[2] - b[0] < 5) return 'geo';
    return 'local';
  }
  // ---------- compact storage ----------
  // Linework is kept as one string: varints (base64) of 1e-7° integer coordinates, each point stored as the difference
  // from the previous one (about 5 bytes a point instead of ~24 as JSON numbers), so big surveys fit, sync and load.
  // Lines: [colour, n, (dx, dy) × n]; fills: [colour, solid, rings, (n, (dx, dy) × n) × rings].
  function Enc() { this.b = new Uint8Array(1 << 16); this.n = 0; this.x = 0; this.y = 0; }
  Enc.prototype.u = function (v) { // unsigned varint (arithmetic: values exceed 2^31)
    if (this.n + 10 > this.b.length) { var nb = new Uint8Array(this.b.length * 2); nb.set(this.b); this.b = nb; }
    while (v >= 128) { this.b[this.n++] = (v % 128) + 128; v = Math.floor(v / 128); }
    this.b[this.n++] = v;
  };
  Enc.prototype.s = function (v) { this.u(v >= 0 ? v * 2 : -v * 2 - 1); };
  Enc.prototype.pt = function (lon, lat) { var X = Math.round(lon * 1e7), Y = Math.round(lat * 1e7); this.s(X - this.x); this.s(Y - this.y); this.x = X; this.y = Y; };
  Enc.prototype.str = function () { var s = '', u = this.b.subarray(0, this.n); for (var i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  function Dec(b64) { var s = atob(b64 || ''); this.b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) this.b[i] = s.charCodeAt(i); this.i = 0; this.x = 0; this.y = 0; }
  Dec.prototype.u = function () { var v = 0, m = 1, c; do { c = this.b[this.i++]; v += (c & 127) * m; m *= 128; } while (c >= 128); return v; };
  Dec.prototype.s = function () { var v = this.u(); return v % 2 ? -(v + 1) / 2 : v / 2; };
  Dec.prototype.more = function () { return this.i < this.b.length; };
  var decoded = new WeakMap();
  /** Linework of a CAD layer: { lines: [{c, p: Float64Array lon,lat,…}], fills: [{c, s, r: [Float64Array]}] } (cached). Reads both storage forms. */
  function decode(cad) {
    var hit = decoded.get(cad); if (hit) return hit;
    var out = { lines: [], fills: [] };
    if (cad.data != null) {
      var d = new Dec(cad.data), rd = function (n) { var a = new Float64Array(n * 2); for (var k = 0; k < n; k++) { d.x += d.s(); d.y += d.s(); a[2 * k] = d.x / 1e7; a[2 * k + 1] = d.y / 1e7; } return a; };
      for (var li = 0; li < (cad.n || 0); li++) { var c = d.u(), n = d.u(); out.lines.push({ c: c, p: rd(n) }); }
      d = new Dec(cad.fillData); // fills: their own stream
      for (var fi = 0; fi < (cad.nf || 0); fi++) { var fc = d.u(), fs = d.u(), nr = d.u(), rs = []; for (var ri = 0; ri < nr; ri++) rs.push(rd(d.u())); out.fills.push({ c: fc, s: !!fs, r: rs }); }
    } else (cad.lines || []).forEach(function (a) { out.lines.push({ c: a[0], p: Float64Array.from(a.slice(1)) }); });
    decoded.set(cad, out);
    return out;
  }
  function counts(cad) { return { lines: cad.n != null ? cad.n : (cad.lines || []).length, fills: cad.nf || 0, texts: (cad.texts || []).length }; }
  function build(name, geo, toLL, unit) {
    var colors = [], ci = {}, cidx = function (c) { if (!(c in ci)) { ci[c] = colors.length; colors.push(c); } return ci[c]; };
    var r7 = function (v) { return Math.round(v * 1e7) / 1e7; }, bb = L.latLngBounds([]);
    var le = new Enc(), fe = new Enc();
    var put = function (enc, p) { enc.u(p.length / 2); for (var k = 0; k < p.length; k += 2) { var ll = toLL(p[k], p[k + 1]); enc.pt(ll[0], ll[1]); bb.extend([ll[1], ll[0]]); } };
    geo.lines.forEach(function (l) { le.u(cidx(l.c)); put(le, l.p); });
    (geo.fills || []).forEach(function (f) { fe.u(cidx(f.c)); fe.u(f.s ? 1 : 0); fe.u(f.r.length); f.r.forEach(function (p) { put(fe, p); }); });
    var texts = geo.texts.map(function (t) { var ll = toLL(t.x, t.y); bb.extend([ll[1], ll[0]]); return [cidx(t.c), r7(ll[0]), r7(ll[1]), Math.round(t.h * unit * 1000) / 1000, Math.round(t.r * 10) / 10, t.ax, t.ay, t.s]; });
    if (!bb.isValid()) throw new Error('The drawing has no linework in model space.');
    return { id: Ink.uid(), name: name, kind: 'cad', visible: true, opacity: 1, locked: true, format: 'DXF', showText: true,
      cad: { v: 2, colors: colors, n: geo.lines.length, data: le.str(), nf: (geo.fills || []).length, fillData: fe.str(), points: geo.points, texts: texts },
      bounds: [[bb.getSouth(), bb.getWest()], [bb.getNorth(), bb.getEast()]], warnings: [], created: Date.now() };
  }
  /** Local-coordinate drawings become an image, placed with the georeferencer like any plan. */
  function asPlan(name, geo) {
    var b = extent(geo), W = b[2] - b[0], H = b[3] - b[1], k = 4000 / Math.max(W, H), pad = 40;
    var cv = document.createElement('canvas'); cv.width = Math.ceil(W * k) + 2 * pad; cv.height = Math.ceil(H * k) + 2 * pad;
    var x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, cv.width, cv.height); x.lineWidth = 4; x.lineJoin = 'round';
    var X = function (v) { return pad + (v - b[0]) * k; }, Y = function (v) { return pad + (b[3] - v) * k; };
    var ink = function (c) { return /^#(f[a-f0-9]){3}$/i.test(c) || c === '#ffffff' ? '#000000' : c; }; // white CAD lines on white paper → black
    (geo.fills || []).forEach(function (f) { x.fillStyle = ink(f.c); x.globalAlpha = f.s ? 0.5 : 0.14; x.beginPath(); f.r.forEach(function (p) { for (var q = 0; q < p.length; q += 2) { if (q) x.lineTo(X(p[q]), Y(p[q + 1])); else x.moveTo(X(p[q]), Y(p[q + 1])); } x.closePath(); }); x.fill('evenodd'); x.globalAlpha = 1; });
    geo.lines.forEach(function (l) { x.strokeStyle = ink(l.c); x.beginPath(); for (var q = 0; q < l.p.length; q += 2) { if (q) x.lineTo(X(l.p[q]), Y(l.p[q + 1])); else x.moveTo(X(l.p[q]), Y(l.p[q + 1])); } x.stroke(); });
    geo.texts.forEach(function (t) { var px = t.h * k; if (px < 4) return; x.save(); x.translate(X(t.x), Y(t.y)); x.rotate(-t.r * Math.PI / 180); x.fillStyle = ink(t.c); x.font = px + 'px sans-serif'; var rows = t.s.split('\n'), lh = px * 1.35, top = -(1 - t.ay) * (rows.length - 1) * lh; rows.forEach(function (row, i) { x.fillText(row, -t.ax * x.measureText(row).width, t.ay * px + top + i * lh); }); x.restore(); });
    GC.georef.openPlan({ name: name, url: cv.toDataURL('image/jpeg', 0.92), w: cv.width, h: cv.height, pairs: [] });
  }

  /** Import entry point (from the Import button). */
  function importDxf(file) {
    var name = file.name.replace(/\.[^.]+$/, '');
    GC.busy('Reading ' + file.name + '…');
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = function () { rej(new Error('Could not read ' + file.name)); }; r.readAsText(file); })
      .then(function (text) {
        if (/^AC10\d\d/.test(text.slice(0, 6))) throw new Error('This is a DWG file renamed as DXF. Save it as DXF from CAD (File › Save As › DXF).');
        if (!/SECTION/.test(text.slice(0, 5000))) throw new Error('This is not a text DXF. Save it as an ASCII DXF from CAD.');
        return new Promise(function (r) { setTimeout(r, 20); }).then(function () { var d = parse(text), geo = geometry(d); geo.units = parseInt(d.header['$INSUNITS:70'], 10) || 0; return geo; });
      }).then(function (geo) {
        GC.busy(null);
        if (!geo.lines.length && !geo.texts.length) throw new Error('No linework found in model space (Civil 3D objects need “Export to AutoCAD” first).');
        var b = extent(geo), kind = kindOf(b), notes = [];
        var sk = Object.keys(geo.skipped); if (sk.length) notes.push('Not drawn: ' + sk.map(function (k) { return k.toLowerCase() + ' ×' + geo.skipped[k]; }).join(', ') + '.');
        if (geo.truncated) notes.push('Very large drawing: only the first ' + MAX_VERTICES.toLocaleString() + ' points were kept.');
        if (kind === 'local') {
          return GC.confirm('Place “' + name + '” like a plan?', 'The drawing is in local coordinates (not MGA), so it cannot place itself. It will open beside the map: tap 2 or more matching points on the drawing and the map, as for a plan.', 'Place it').then(function (ok) { if (ok) asPlan(name, geo); });
        }
        var add = function (code, scale) {
          GC.busy('Placing ' + name + '…');
          return new Promise(function (r) { setTimeout(r, 20); }).then(function () {
            var toLL = kind === 'geo' ? function (x, y) { return [x, y]; } : function (x, y) { return Geo.toWGS84(code, [x * scale, y * scale]); };
            var l = build(name, geo, toLL, kind === 'geo' ? 111000 : scale);
            l.crs = code; l.warnings = notes;
            GC.insertLayer(l, true); GC.busy(null); GC.zoomToLayer(l);
            var cn = counts(l.cad);
            GC.toast('“' + name + '” added as a reference drawing (' + cn.lines.toLocaleString() + ' lines' + (cn.fills ? ', ' + cn.fills.toLocaleString() + ' hatches' : '') + (cn.texts ? ', ' + cn.texts.toLocaleString() + ' texts' : '') + ').' + (notes.length ? ' ' + notes.join(' ') : ''), notes.length ? 'warn' : null, 9000);
          });
        };
        if (kind === 'geo') return add(4326, 1);
        var scale = kind === 'mga-mm' ? 0.001 : 1, m = /(?:mga|zone|z)[ _-]?(\d{2})/i.exec(file.name);
        return GC.pickCRS('Which coordinate system is the drawing in?',
          '“' + name + '” uses map coordinates (E ' + Math.round(b[0] * scale).toLocaleString() + ', N ' + Math.round(b[1] * scale).toLocaleString() + (scale !== 1 ? ', in millimetres' : '') + '). Civil drawings around Toowoomba are usually GDA2020 MGA zone 56; check the title block if unsure.',
          Geo.pickerOptions(m ? +m[1] : 56), 7800 + (m ? +m[1] : 56)).then(function (code) { if (code) return add(code, scale); });
      }).catch(function (e) { GC.busy(null); GC.toast('Could not import the DXF: ' + e.message, 'err', 9000); });
  }

  /** Nearest drawing vertex within tol screen pixels (measuring and plan placing snap to CAD linework too). */
  function snap(ll, tol) {
    var map = GC.map, p = map.latLngToContainerPoint(ll), best = null, bd = tol || 14, view = map.getBounds().pad(0.2);
    if (!GC.project) return null;
    GC.project.layers.forEach(function (l) {
      if (l.kind !== 'cad' || !l.visible) return;
      var S = view.getSouth(), N = view.getNorth(), W = view.getWest(), E = view.getEast();
      decode(l.cad).lines.forEach(function (ln) {
        var a = ln.p;
        for (var k = 0; k < a.length; k += 2) {
          if (a[k + 1] < S || a[k + 1] > N || a[k] < W || a[k] > E) continue;
          var q = map.latLngToContainerPoint([a[k + 1], a[k]]), dd = Math.hypot(q.x - p.x, q.y - p.y);
          if (dd < bd) { bd = dd; best = L.latLng(a[k + 1], a[k]); }
        }
      });
    });
    return best;
  }

  GC.cad = { importDxf: importDxf, parse: parse, geometry: geometry, snap: snap, ACI: ACI, decode: decode, counts: counts, build: build };
})(window);
