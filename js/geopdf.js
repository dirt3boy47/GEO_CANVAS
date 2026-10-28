/* GeoCanvas web — GeoPDF maps (Vicmap, NSW and QLD topographic sheets, Avenza-style maps): placed on the map by themselves.
   Reads the geospatial data inside the PDF: ISO 32000 "Measure/GEO" viewports (Adobe/Esri/GDAL) or the OGC/TerraGo
   LGIDict. Control points give latitude/longitude; the page is fitted to a local plane centred on the sheet (centimetre
   agreement with any map projection over a map sheet), so MGA, VicGrid, Lambert… all work without knowing the projection.
   Only the datum matters (GDA94/AGD shifted to GDA2020≈WGS84). The map is rendered in large JPEG pieces, each placed by
   its own corners and clipped to the map frame (the collar with legend and margins is left off the map). */
(function (global) {
  'use strict';
  var GC = global.GC, Geo = global.Geo, map = GC.map;
  var TILE = 2048, SUB = 512, MAX_PIXELS = 32e6, MAX_SCALE = 3;

  // ---------- inflate (zlib, RFC 1950/1951), for compressed object streams ----------
  var LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  function huff(lengths, n) {
    var count = new Uint16Array(16), symbol = new Uint16Array(n), offs = new Uint16Array(16), i;
    for (i = 0; i < n; i++) count[lengths[i]]++;
    count[0] = 0;
    for (i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
    for (i = 0; i < n; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
    return { count: count, symbol: symbol };
  }
  var FIXED = (function () {
    var l = new Uint8Array(288), i;
    for (i = 0; i < 144; i++) l[i] = 8; for (; i < 256; i++) l[i] = 9; for (; i < 280; i++) l[i] = 7; for (; i < 288; i++) l[i] = 8;
    var d = new Uint8Array(30); for (i = 0; i < 30; i++) d[i] = 5;
    return { lit: huff(l, 288), dist: huff(d, 30) };
  })();
  function inflate(src) {
    var pos = (src[0] & 15) === 8 && ((src[0] << 8) | src[1]) % 31 === 0 ? 2 : 0; // zlib header, or raw deflate
    var bitbuf = 0, bitcnt = 0, out = new Uint8Array(Math.max(1024, src.length * 4)), op = 0;
    function need(n) { if (op + n > out.length) { var o = new Uint8Array(Math.max(out.length * 2, op + n)); o.set(out); out = o; } }
    function bits(n) {
      while (bitcnt < n) { if (pos >= src.length) throw new Error('Compressed data ended early.'); bitbuf |= src[pos++] << bitcnt; bitcnt += 8; }
      var v = bitbuf & ((1 << n) - 1); bitbuf >>>= n; bitcnt -= n; return v;
    }
    function decode(h) {
      var code = 0, first = 0, index = 0;
      for (var len = 1; len < 16; len++) {
        code |= bits(1); var c = h.count[len];
        if (code - c < first) return h.symbol[index + (code - first)];
        index += c; first = (first + c) << 1; code <<= 1;
      }
      throw new Error('Bad compressed data.');
    }
    var last;
    do {
      last = bits(1); var type = bits(2);
      if (type === 0) {
        bitbuf = 0; bitcnt = 0;
        var len = src[pos] | (src[pos + 1] << 8); pos += 4;
        need(len); out.set(src.subarray(pos, pos + len), op); op += len; pos += len;
      } else {
        var lit, dist;
        if (type === 1) { lit = FIXED.lit; dist = FIXED.dist; }
        else if (type === 2) {
          var nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4, lengths = new Uint8Array(320), i;
          for (i = 0; i < ncode; i++) lengths[CLORDER[i]] = bits(3);
          var lencode = huff(lengths, 19), idx = 0, all = new Uint8Array(nlen + ndist);
          while (idx < nlen + ndist) {
            var sym = decode(lencode);
            if (sym < 16) all[idx++] = sym;
            else { var rep = 0, val = 0; if (sym === 16) { val = all[idx - 1]; rep = 3 + bits(2); } else if (sym === 17) rep = 3 + bits(3); else rep = 11 + bits(7); while (rep--) all[idx++] = val; }
          }
          lit = huff(all.subarray(0, nlen), nlen); dist = huff(all.subarray(nlen), ndist);
        } else throw new Error('Bad compressed block.');
        for (;;) {
          var s = decode(lit);
          if (s < 256) { need(1); out[op++] = s; }
          else if (s === 256) break;
          else {
            s -= 257; var l = LBASE[s] + bits(LEXT[s]), ds = decode(dist), d = DBASE[ds] + bits(DEXT[ds]);
            need(l); for (var k = 0; k < l; k++, op++) out[op] = out[op - d];
          }
        }
      }
    } while (!last);
    return out.subarray(0, op);
  }

  // ---------- reading PDF objects ----------
  function latin1(u8) {
    if (global.TextDecoder) try { return new TextDecoder('windows-1252').decode(u8); } catch (e) { /* below */ }
    var s = '', CH = 0x8000; for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return s;
  }
  var WS = /[\s\0]/, DELIM = /[\s\0()<>\[\]{}\/%]/;
  /** Parses one PDF value at text[pos]: numbers, names (as '/Name'), strings, arrays, dicts, refs ({ref: n}). */
  function parse(t, pos) {
    function skip() { for (;;) { while (pos < t.length && WS.test(t[pos])) pos++; if (t[pos] === '%') { while (pos < t.length && t[pos] !== '\n' && t[pos] !== '\r') pos++; } else return; } }
    function value() {
      skip();
      var c = t[pos];
      if (c === '<' && t[pos + 1] === '<') {
        pos += 2; var d = {};
        for (;;) { skip(); if (t[pos] === '>' && t[pos + 1] === '>') { pos += 2; return d; } if (t[pos] !== '/') throw new Error('bad dict'); var k = value().slice(1); d[k] = value(); }
      }
      if (c === '[') { pos++; var a = []; for (;;) { skip(); if (t[pos] === ']') { pos++; return a; } a.push(value()); } }
      if (c === '(') {
        pos++; var s = '', depth = 1;
        while (pos < t.length) {
          var ch = t[pos++];
          if (ch === '\\') {
            var e = t[pos++], map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
            if (map[e]) s += map[e]; else if (/[0-7]/.test(e)) { var o = e; while (o.length < 3 && /[0-7]/.test(t[pos])) o += t[pos++]; s += String.fromCharCode(parseInt(o, 8)); } else if (e === '\r') { if (t[pos] === '\n') pos++; } else if (e !== '\n') s += e;
          } else if (ch === '(') { depth++; s += ch; } else if (ch === ')') { if (!--depth) break; s += ch; } else s += ch;
        }
        if (s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) { var u = ''; for (var i = 2; i + 1 < s.length; i += 2) u += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1)); s = u; }
        return s;
      }
      if (c === '<') { var end = t.indexOf('>', pos), hex = t.slice(pos + 1, end).replace(/\s/g, ''), r = ''; pos = end + 1; if (hex.length % 2) hex += '0'; for (var h = 0; h < hex.length; h += 2) r += String.fromCharCode(parseInt(hex.substr(h, 2), 16)); return r; }
      if (c === '/') { var n = '/'; pos++; while (pos < t.length && !DELIM.test(t[pos])) n += t[pos++]; return n.replace(/#([0-9a-f]{2})/gi, function (m, x) { return String.fromCharCode(parseInt(x, 16)); }); }
      var m = /^[+-]?(\d+\.?\d*|\.\d+)/.exec(t.slice(pos, pos + 40));
      if (m) {
        var ref = /^(\d+)\s+(\d+)\s+R(?![A-Za-z])/.exec(t.slice(pos, pos + 40));
        if (ref) { pos += ref[0].length; return { ref: +ref[1] }; }
        pos += m[0].length; return parseFloat(m[0]);
      }
      var w = /^[a-z]+/.exec(t.slice(pos, pos + 10));
      if (w) { pos += w[0].length; return w[0] === 'true' ? true : w[0] === 'false' ? false : null; }
      throw new Error('PDF syntax not understood at ' + pos);
    }
    var v = value(); return { v: v, pos: pos };
  }
  /** Indexes every object in the file, including those packed in compressed object streams. */
  function indexPdf(u8) {
    var text = latin1(u8), objs = {}, re = /(\d+)\s+(\d+)\s+obj\b/g, m;
    while ((m = re.exec(text))) objs[+m[1]] = { t: text, p: re.lastIndex };
    var pdf = { text: text, objs: objs };
    pdf.get = function (n) {
      var o = objs[n]; if (!o) return null;
      if (!('v' in o)) { try { o.v = parse(o.t, o.p).v; } catch (e) { o.v = null; } }
      return o.v;
    };
    pdf.res = function (v) { var k = 0; while (v && typeof v === 'object' && 'ref' in v && k++ < 20) v = pdf.get(v.ref); return v; };
    if (/\/ObjStm/.test(text)) {
      Object.keys(objs).forEach(function (n) {
        var o = objs[n], head = o.t.slice(o.p, o.p + 400);
        if (!/\/Type\s*\/ObjStm/.test(head)) return;
        try {
          var d = parse(o.t, o.p), dict = d.v, s = text.indexOf('stream', d.pos);
          s += 6; if (text[s] === '\r') s++; if (text[s] === '\n') s++;
          var len = pdf.res(dict.Length), endAt = typeof len === 'number' ? s + len : text.indexOf('endstream', s);
          var f = pdf.res(dict.Filter); if (f && f !== '/FlateDecode' && !(f.length === 1 && f[0] === '/FlateDecode')) return;
          var body = latin1(f ? inflate(u8.subarray(s, endAt)) : u8.subarray(s, endAt)), first = pdf.res(dict.First), cnt = pdf.res(dict.N);
          var nums = body.slice(0, first).trim().split(/\s+/).map(Number);
          for (var i = 0; i < cnt; i++) if (!objs[nums[2 * i]]) objs[nums[2 * i]] = { t: body, p: first + nums[2 * i + 1] };
        } catch (e) { /* a damaged stream: skip it */ }
      });
    }
    return pdf;
  }
  function nums(a) { return (a || []).map(function (x) { return typeof x === 'string' ? parseFloat(x) : +x; }); }
  function name(v) { return typeof v === 'string' ? v.replace(/^\//, '') : ''; }

  /** The geospatial description of the first georeferenced page, or null when the PDF has none. */
  function readGeo(u8) {
    var head = latin1(u8.subarray(0, 8));
    if (head.indexOf('%PDF') < 0) return null;
    var pdf = indexPdf(u8), best = null;
    Object.keys(pdf.objs).forEach(function (n) {
      var o = pdf.objs[n];
      var peek = o.t.slice(o.p, o.p + 3000);
      if (!/\/(VP|LGIDict)\b/.test(peek) && !/\/Type\s*\/Page\b/.test(peek)) return;
      var d = pdf.get(+n); if (!d || d.Type !== '/Page' || !(d.VP || d.LGIDict)) return;
      var g = d.VP ? iso(pdf, d) : null;
      if (!g && d.LGIDict) g = lgi(pdf, d);
      if (g && (!best || g.area > best.area)) { g.page = +n; best = g; }
    });
    return best;
  }
  function iso(pdf, page) {
    var vps = pdf.res(page.VP); if (!Array.isArray(vps)) vps = [vps];
    var best = null;
    vps.forEach(function (v) {
      v = pdf.res(v); if (!v) return;
      var m = pdf.res(v.Measure); if (!m || name(m.Subtype) !== 'GEO') return;
      var bb = nums(pdf.res(v.BBox)), gp = nums(pdf.res(m.GPTS)), bounds = nums(pdf.res(m.Bounds)), lp = nums(pdf.res(m.LPTS));
      if (bb.length < 4 || gp.length < 6) return;
      if (!bounds.length) bounds = [0, 0, 0, 1, 1, 1, 1, 0];
      if (!lp.length) lp = bounds;
      var x0 = Math.min(bb[0], bb[2]), x1 = Math.max(bb[0], bb[2]), y0 = Math.min(bb[1], bb[3]), y1 = Math.max(bb[1], bb[3]);
      var P = function (u, w) { return [x0 + u * (x1 - x0), y0 + w * (y1 - y0)]; };
      var gcs = pdf.res(m.GCS) || {}, wkt = typeof pdf.res(gcs.WKT) === 'string' ? pdf.res(gcs.WKT) : '', epsg = pdf.res(gcs.EPSG);
      var pts = [];
      for (var i = 0; i + 1 < gp.length && i + 1 < lp.length; i += 2) {
        var a = gp[i], b = gp[i + 1], lat = a, lon = b;
        if (Math.abs(a) > 90 && Math.abs(b) <= 90) { lat = b; lon = a; } // some producers write lon/lat
        var pp = P(lp[i], lp[i + 1]);
        pts.push({ x: pp[0], y: pp[1], lon: lon, lat: lat });
      }
      var frame = []; for (i = 0; i + 1 < bounds.length; i += 2) frame.push(P(bounds[i], bounds[i + 1]));
      var area = (x1 - x0) * (y1 - y0);
      if (!best || area > best.area) best = { kind: 'ISO 32000', area: area, pts: pts, frame: frame, datum: datumOf(wkt, epsg), crs: crsName(wkt, epsg) };
    });
    return best;
  }
  function lgi(pdf, page) {
    var L0 = pdf.res(page.LGIDict); if (Array.isArray(L0)) L0 = L0.map(pdf.res).filter(function (x) { return x && (x.CTM || x.Registration); })[0];
    if (!L0) return null;
    var pr = pdf.res(L0.Projection) || {}, type = String(name(pr.ProjectionType) || pr.ProjectionType || '').toUpperCase();
    var datum = String(name(pr.Datum) || pr.Datum || '').toUpperCase(), zone = parseInt(pdf.res(pr.Zone), 10), south = /S/i.test(String(name(pr.Hemisphere) || pr.Hemisphere || 'S'));
    var neat = nums(pdf.res(L0.Neatline)), frame = []; for (var i = 0; i + 1 < neat.length; i += 2) frame.push([neat[i], neat[i + 1]]);
    var code = null;
    if (type === 'UT' && zone) code = /GDA.?2020|GDA20/.test(datum) ? 7800 + zone : /GDA|AUS|GD9/.test(datum) ? 28300 + zone : (south ? 32700 : 32600) + zone;
    else if (type !== 'GEOGRAPHIC' && type !== 'GEO' && type !== 'GD') return null; // other projections: not supported here
    var toLL = function (X, Y) { if (code) { var ll = Geo.CRS[code] ? Geo.toWGS84(code, [X, Y]) : null; return ll ? { lon: ll[0], lat: ll[1] } : null; } return Math.abs(X) <= 90 && Math.abs(Y) > 90 ? { lon: Y, lat: X } : { lon: X, lat: Y }; };
    var pts = [], reg = pdf.res(L0.Registration);
    if (Array.isArray(reg) && reg.length >= 3) reg.forEach(function (r) { r = nums(pdf.res(r)); var g = toLL(r[2], r[3]); if (g) pts.push({ x: r[0], y: r[1], lon: g.lon, lat: g.lat }); });
    else {
      var c = nums(pdf.res(L0.CTM)); if (c.length < 6) return null;
      var corners = frame.length >= 3 ? frame : [[0, 0], [600, 0], [600, 600], [0, 600]];
      corners.forEach(function (p) { var g = toLL(c[0] * p[0] + c[2] * p[1] + c[4], c[1] * p[0] + c[3] * p[1] + c[5]); if (g) pts.push({ x: p[0], y: p[1], lon: g.lon, lat: g.lat }); });
    }
    if (pts.length < 3) return null;
    return { kind: 'OGC (LGIDict)', area: 1, pts: pts, frame: frame, datum: code ? 'wgs' : (/GDA.?2020/.test(datum) ? 'wgs' : /GDA|GD9/.test(datum) ? 'gda94' : 'wgs'), crs: code ? Geo.crsLabel(code) : 'Geographic' };
  }
  function datumOf(wkt, epsg) {
    var N = String(wkt).toUpperCase().replace(/\s/g, '_'), e = +epsg || 0;
    if (/GDA_?2020|DATUM_OF_AUSTRALIA_2020/.test(N) || (e >= 7842 && e <= 7899) || e === 8058 || e === 9473) return 'wgs';
    if (/GDA_?1994|GDA94|DATUM_OF_AUSTRALIA_1994/.test(N) || (e > 28300 && e < 28400) || e === 4283 || e === 3111 || e === 3308 || e === 3577) return 'gda94';
    if (/AUSTRALIAN_1984|AGD_?84|AGD84/.test(N) || (e > 20300 && e < 20400) || e === 4203) return 'agd84';
    if (/AUSTRALIAN_1966|AGD_?66|AGD66/.test(N) || (e > 20200 && e < 20300) || e === 4202 || e === 3110) return 'agd66';
    return N || e ? 'wgs' : 'unknown';
  }
  function crsName(wkt, epsg) {
    var n = (/^\w+\["([^"]+)"/.exec(String(wkt).trim()) || [])[1];
    return n ? n.replace(/_/g, ' ') + (epsg ? ' (EPSG:' + epsg + ')' : '') : epsg ? 'EPSG:' + epsg : 'not stated';
  }
  var DATUM_CODE = { gda94: 4283, agd84: 4203, agd66: 4202 };

  // ---------- page → map: least-squares affine onto a stereographic plane centred on the sheet ----------
  var R = 6371008.8, D2R = Math.PI / 180;
  function stereo(lat0, lon0) {
    var s0 = Math.sin(lat0 * D2R), c0 = Math.cos(lat0 * D2R);
    return {
      fwd: function (lon, lat) {
        var p = lat * D2R, dl = (lon - lon0) * D2R, sp = Math.sin(p), cp = Math.cos(p), k = 2 * R / (1 + s0 * sp + c0 * cp * Math.cos(dl));
        return [k * cp * Math.sin(dl), k * (c0 * sp - s0 * cp * Math.cos(dl))];
      },
      inv: function (x, y) {
        var r = Math.sqrt(x * x + y * y); if (r < 1e-9) return [lon0, lat0];
        var c = 2 * Math.atan(r / (2 * R)), sc = Math.sin(c), cc = Math.cos(c);
        var lat = Math.asin(cc * s0 + y * sc * c0 / r), lon = lon0 * D2R + Math.atan2(x * sc, r * c0 * cc - y * s0 * sc);
        return [lon / D2R, lat / D2R];
      }
    };
  }
  function solve3(A, b) {
    var M = A.map(function (r, i) { return r.concat([b[i]]); });
    for (var c = 0; c < 3; c++) {
      var piv = c; for (var r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-12) return null;
      var t = M[c]; M[c] = M[piv]; M[piv] = t;
      for (r = 0; r < 3; r++) if (r !== c) { var k = M[r][c] / M[c][c]; for (var j = c; j < 4; j++) M[r][j] -= k * M[c][j]; }
    }
    return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
  }
  /** {f(x, y) → [lon, lat] WGS84 for a page point, rms in metres}. */
  function transform(g) {
    var pts = g.pts.map(function (p) {
      var ll = DATUM_CODE[g.datum] ? Geo.toWGS84(DATUM_CODE[g.datum], [p.lon, p.lat]) : [p.lon, p.lat];
      return { x: p.x, y: p.y, lon: ll[0], lat: ll[1] };
    });
    var lat0 = 0, lon0 = 0; pts.forEach(function (p) { lat0 += p.lat / pts.length; lon0 += p.lon / pts.length; });
    var st = stereo(lat0, lon0), mx = 0, my = 0;
    pts.forEach(function (p) { var q = st.fwd(p.lon, p.lat); p.e = q[0]; p.n = q[1]; mx += p.x / pts.length; my += p.y / pts.length; });
    var A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], be = [0, 0, 0], bn = [0, 0, 0];
    pts.forEach(function (p) { var r = [1, p.x - mx, p.y - my]; for (var i = 0; i < 3; i++) { be[i] += r[i] * p.e; bn[i] += r[i] * p.n; for (var j = 0; j < 3; j++) A[i][j] += r[i] * r[j]; } });
    var ae = solve3(A, be), an = solve3(A, bn);
    if (!ae || !an) throw new Error('The map’s control points are in a line, so it cannot be placed.');
    var plane = function (x, y) { x -= mx; y -= my; return [ae[0] + ae[1] * x + ae[2] * y, an[0] + an[1] * x + an[2] * y]; };
    var ss = 0; pts.forEach(function (p) { var q = plane(p.x, p.y); ss += Math.pow(q[0] - p.e, 2) + Math.pow(q[1] - p.n, 2); });
    return { f: function (x, y) { var q = plane(x, y); return st.inv(q[0], q[1]); }, rms: pts.length > 3 ? Math.sqrt(ss / pts.length) : null, n: pts.length,
      metresPerPoint: Math.sqrt(Math.abs(ae[1] * an[2] - ae[2] * an[1])) };
  }

  // ---------- rendering into placed pieces ----------
  function inside(pt, poly) {
    var ins = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) { var a = poly[i], b = poly[j]; if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) ins = !ins; }
    return ins;
  }
  function render(page, g, tf, progress) {
    var v1 = page.getViewport({ scale: 1 });
    var frame = (g.frame.length >= 3 ? g.frame : g.pts.map(function (p) { return [p.x, p.y]; }));
    var fpx = frame.map(function (p) { return v1.convertToViewportPoint(p[0], p[1]); });
    var x0 = Math.max(0, Math.min.apply(null, fpx.map(function (p) { return p[0]; }))), x1 = Math.min(v1.width, Math.max.apply(null, fpx.map(function (p) { return p[0]; })));
    var y0 = Math.max(0, Math.min.apply(null, fpx.map(function (p) { return p[1]; }))), y1 = Math.min(v1.height, Math.max.apply(null, fpx.map(function (p) { return p[1]; })));
    var s = Math.min(MAX_SCALE, Math.sqrt(MAX_PIXELS / Math.max(1, (x1 - x0) * (y1 - y0))));
    var vp = page.getViewport({ scale: s }), poly = fpx.map(function (p) { return [p[0] * s, p[1] * s]; });
    var X0 = Math.floor(x0 * s), Y0 = Math.floor(y0 * s), X1 = Math.ceil(x1 * s), Y1 = Math.ceil(y1 * s), jobs = [];
    // Rendered in large blocks (each pass draws the whole page, so fewer is faster), then cut into small pieces:
    // each piece is placed by its own corners, and small pieces keep the Web Mercator bend negligible (~0.3 m).
    // Neighbouring pieces overlap by 2 px so no hairline shows where they meet.
    for (var ty = Y0; ty < Y1; ty += TILE) for (var tx = X0; tx < X1; tx += TILE) jobs.push([tx, ty, Math.min(TILE + 2, X1 - tx), Math.min(TILE + 2, Y1 - ty)]);
    var corner = function (px, py) { var p = vp.convertToPdfPoint(px, py), ll = tf.f(p[0], p[1]); return [+ll[1].toFixed(8), +ll[0].toFixed(8)]; };
    var rect = function (x, y, w, h) { return [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]; };
    var pieces = [], k = 0, tk = 200 / Math.max(X1 - X0, Y1 - Y0), thumb = document.createElement('canvas');
    thumb.width = Math.max(1, Math.round((X1 - X0) * tk)); thumb.height = Math.max(1, Math.round((Y1 - Y0) * tk));
    var next = function () {
      if (k >= jobs.length) return Promise.resolve(pieces);
      var j = jobs[k++], cv = document.createElement('canvas'); cv.width = j[2]; cv.height = j[3];
      if (progress) progress(k, jobs.length);
      var ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, j[2], j[3]);
      var tvp = page.getViewport({ scale: s, offsetX: -j[0], offsetY: -j[1] });
      return page.render({ canvasContext: ctx, viewport: tvp }).promise.then(function () {
        var bw = Math.min(TILE, j[2]), bh = Math.min(TILE, j[3]);
        for (var sy = 0; sy < bh; sy += SUB) for (var sx = 0; sx < bw; sx += SUB) {
          var w = Math.min(SUB + 2, j[2] - sx), h = Math.min(SUB + 2, j[3] - sy), x = j[0] + sx, y = j[1] + sy, cs = rect(x, y, w, h);
          var ins = cs.filter(function (c) { return inside(c, poly); }).length;
          if (!ins && !inside([x + w / 2, y + h / 2], poly) && !poly.some(function (q) { return q[0] >= x && q[0] <= x + w && q[1] >= y && q[1] <= y + h; })) continue; // outside the map frame
          var pc = document.createElement('canvas'); pc.width = w; pc.height = h;
          pc.getContext('2d').drawImage(cv, sx, sy, w, h, 0, 0, w, h);
          pieces.push({ url: pc.toDataURL('image/jpeg', 0.86), c: [corner(x, y), corner(x + w, y), corner(x, y + h)],
            clip: ins === 4 ? null : poly.map(function (q) { return [+((q[0] - x) / w * 100).toFixed(3), +((q[1] - y) / h * 100).toFixed(3)]; }) });
          pc.width = pc.height = 0;
        }
        thumb.getContext('2d').drawImage(cv, 0, 0, j[2], j[3], (j[0] - X0) * tk, (j[1] - Y0) * tk, j[2] * tk, j[3] * tk);
        cv.width = cv.height = 0; // free the memory now (iPad)
        return next();
      });
    };
    return next().then(function (pc) { var t = thumb.toDataURL('image/jpeg', 0.7); thumb.width = 0; return { pieces: pc, thumb: t, dpi: Math.round(72 * s), frame: poly.map(function (p) { return corner(p[0], p[1]); }) }; });
  }

  // ---------- import ----------
  /** Imports a GeoPDF; resolves false when the PDF has no geospatial data (it is then a plan to place by hand). */
  function importFile(file) {
    var nm = file.name.replace(/\.[^.]+$/, '');
    GC.busy('Reading ' + file.name + '…');
    return (file.arrayBuffer ? file.arrayBuffer() : new Response(file).arrayBuffer()).then(function (buf) {
      var u8 = new Uint8Array(buf), g;
      try { g = readGeo(u8); } catch (e) { g = null; }
      if (!g) { GC.busy(null); return false; }
      var tf = transform(g);
      return GC.georef.loadPdfJs().then(function (pdfjs) { return pdfjs.getDocument({ data: u8 }).promise; }).then(function (doc) {
        // the georeferenced page (single-page maps: page 1)
        var find = function (i) {
          return doc.getPage(i).then(function (p) { if (doc.numPages === 1 || (p.ref && p.ref.num === g.page)) return p; return i < doc.numPages ? find(i + 1) : doc.getPage(1); });
        };
        return find(1);
      }).then(function (page) {
        return render(page, g, tf, function (k, n) { GC.busy('Drawing “' + nm + '”… ' + Math.round(100 * (k - 1) / n) + '%'); });
      }).then(function (r) {
        GC.busy(null);
        var b = L.latLngBounds(r.frame);
        var l = { id: global.Ink.uid(), name: nm, kind: 'geopdf', visible: true, opacity: 1, locked: true, format: 'GeoPDF', pieces: r.pieces,
          frame: r.frame, bounds: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]], crs: g.crs, encoding: g.kind, dpi: r.dpi,
          rms: tf.rms, datum: g.datum, created: Date.now() };
        if (g.datum === 'unknown') l.warnings = ['The PDF does not say which datum its coordinates use; they were taken as GDA2020/WGS84.'];
        if (r.thumb) l.thumb = r.thumb;
        var placed = function (pl) {
          GC.zoomToLayer(pl);
          GC.toast('“' + nm + '” placed from its GeoPDF data (' + g.crs + ')' + (pl.kind === 'libmap' ? ' and saved in My maps' + (GC.mymaps.importFolder() ? ' › ' + GC.mymaps.importFolder().replace(/\//g, ' › ') : '') : '') + '.' + (tf.rms != null && tf.rms > 5 ? ' Its control points disagree by ' + Math.round(tf.rms) + ' m.' : ''), tf.rms > 5 ? 'warn' : null, 8000);
          return true;
        };
        // GeoPDF sheets go into My maps (shared, in folders) and are shown in this project from there
        if (GC.mymaps) return GC.mymaps.addMap(l).then(function (res) { return placed(res.layer); }, function () { GC.insertLayer(l, true); return placed(l); });
        GC.insertLayer(l, true); return placed(l);
      });
    }).catch(function (e) { GC.busy(null); GC.toast('Could not open “' + file.name + '”: ' + e.message, 'err', 9000); return true; });
  }

  GC.geopdf = { importFile: importFile, readGeo: readGeo, transform: transform, inflate: inflate, parse: parse };
})(window);
