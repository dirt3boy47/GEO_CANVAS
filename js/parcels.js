/* GeoCanvas web — Parcels along an alignment.
   Pick a line (a CAD drawing's alignment layers, a drawn or imported line, or a measured line): every Queensland
   cadastre parcel it crosses (or that lies within a corridor width of it) is looked up and coloured by tenure —
   private (freehold), State lease, State land / reserve, road / rail / water, easement — and stretches of the line in no
   parcel at all (in Queensland usually road reserve) are shown too. The result is a project layer (it syncs, exports
   and its parcels can be tapped) and a list with lot/plan, tenure, metres of alignment in each lot and chainages.
   The cadastre is a guide only, not a survey: check tenure and ownership with a title search. */
(function (global) {
  'use strict';
  var GC = global.GC, Geo = global.Geo, map = GC.map, esc = GC.esc;

  var CLS = [
    { k: 'esmt', n: 'Easement', c: '#fb8c00' },
    { k: 'private', n: 'Private (freehold)', c: '#e53935', t: /freehold/i },
    { k: 'lease', n: 'State lease', c: '#8e24aa', t: /lease/i },
    { k: 'road', n: 'Road / rail / water', c: '#1e88e5', t: /\broad|rail|water|river|creek|stream|channel/i },
    { k: 'state', n: 'State land / reserve', c: '#2e9e44', t: /state|reserve|national park|forest|unallocated|crown|park|conservation|usl/i },
    { k: 'other', n: 'Other / unknown tenure', c: '#757575' }
  ];
  var GAP = { k: 'gap', n: 'No parcel (road reserve / unparcelled)', c: '#00bcd4' };
  var BUFFERS = [0, 5, 10, 20, 50];
  var LAST = 'gc.parcelOpts';

  function C() { return GC.cadastre; }
  /** Tenure of a parcel: the tenure field, else any attribute that reads like one. */
  function tenureOf(p) {
    var t = C().prop(p, ['tenure', 'tenure_desc', 'tenure_type', 'tenure_cat']);
    if (t) return String(t).trim();
    var hit = null; Object.keys(p || {}).some(function (k) { var v = p[k]; if (typeof v === 'string' && /freehold|lands? lease|state land|reserve|national park|state forest/i.test(v)) { hit = v.trim(); return true; } return false; });
    return hit || '';
  }
  function classify(p) {
    var typ = [C().prop(p, ['parcel_typ', 'parcel_type', 'par_ind']), C().prop(p, ['cover_typ', 'cover_type']), C().prop(p, ['feat_name'])].join(' ');
    if (/easement|esmt/i.test(typ)) return CLS[0];
    var t = tenureOf(p);
    for (var i = 1; i < CLS.length - 1; i++) if (CLS[i].t.test(t)) return CLS[i];
    return CLS[CLS.length - 1];
  }

  // ---------- geometry (a local metric grid around the alignment) ----------
  function grid(paths) {
    var a = paths[0][0], lat0 = a[1] * Math.PI / 180;
    var kx = 111320 * Math.cos(lat0), ky = 110574;
    return { xy: function (q) { return [(q[0] - a[0]) * kx, (q[1] - a[1]) * ky]; }, ll: function (x, y) { return [a[0] + x / kx, a[1] + y / ky]; }, kx: kx, ky: ky };
  }
  function bboxOf(pts) { var b = [Infinity, Infinity, -Infinity, -Infinity]; pts.forEach(function (q) { b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[0]); b[3] = Math.max(b[3], q[1]); }); return b; }
  function overlaps(a, b, pad) { return a[0] - pad <= b[2] && b[0] - pad <= a[2] && a[1] - pad <= b[3] && b[1] - pad <= a[3]; }
  function inRings(x, y, rings) { var ins = false; rings.forEach(function (r) { for (var i = 0, j = r.length - 1; i < r.length; j = i++) { var a = r[i], b = r[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) ins = !ins; } }); return ins; }
  /** Where segment p→q crosses segment a→b, as t along p→q (or null). */
  function cross(p, q, a, b) {
    var rx = q[0] - p[0], ry = q[1] - p[1], sx = b[0] - a[0], sy = b[1] - a[1], d = rx * sy - ry * sx;
    if (Math.abs(d) < 1e-12) return null;
    var t = ((a[0] - p[0]) * sy - (a[1] - p[1]) * sx) / d, u = ((a[0] - p[0]) * ry - (a[1] - p[1]) * rx) / d;
    return t > 0 && t < 1 && u >= 0 && u <= 1 ? t : null;
  }
  function ptSeg(p, a, b) { var dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0; return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); }
  function segSeg(p, q, a, b) { return cross(p, q, a, b) != null ? 0 : Math.min(ptSeg(p, a, b), ptSeg(q, a, b), ptSeg(a, p, q), ptSeg(b, p, q)); }

  /** The alignment as metric segments with chainage: [{a, b, ch0, len, path}] (paths joined end to end when they touch). */
  function joinPaths(paths) {
    var left = paths.filter(function (p) { return p.length > 1; }).map(function (p) { return p.slice(); }), out = [];
    var close = function (a, b) { return Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5; }; // about a metre
    while (left.length) {
      left.sort(function (a, b) { return Geo.pathLength(b) - Geo.pathLength(a); });
      var cur = left.shift(), grew = true;
      while (grew) {
        grew = false;
        for (var i = 0; i < left.length; i++) {
          var p = left[i], h = cur[0], t = cur[cur.length - 1];
          if (close(t, p[0])) cur = cur.concat(p.slice(1));
          else if (close(t, p[p.length - 1])) cur = cur.concat(p.slice().reverse().slice(1));
          else if (close(h, p[p.length - 1])) cur = p.concat(cur.slice(1));
          else if (close(h, p[0])) cur = p.slice().reverse().concat(cur.slice(1));
          else continue;
          left.splice(i, 1); grew = true; break;
        }
      }
      out.push(cur);
    }
    return out;
  }

  // ---------- fetching parcels along the line ----------
  function chunks(paths, pad) {
    var boxes = [], seen = {};
    paths.forEach(function (path) {
      var cur = [path[0]], len = 0;
      for (var i = 1; i < path.length; i++) {
        cur.push(path[i]); len += Geo.geodesic(path[i - 1], path[i]);
        if (len > 400 || cur.length > 60 || i === path.length - 1) {
          var b = bboxOf(cur), k = b.map(function (v) { return v.toFixed(5); }).join(',');
          if (!seen[k]) { seen[k] = 1; boxes.push([b[0] - pad[0], b[1] - pad[1], b[2] + pad[0], b[3] + pad[1]]); }
          cur = [path[i]]; len = 0;
        }
      }
    });
    return boxes;
  }
  function fetchParcels(paths, buffer) {
    var lat = paths[0][0][1], pad = [(buffer + 3) / (111320 * Math.cos(lat * Math.PI / 180)), (buffer + 3) / 110574];
    var boxes = chunks(paths, pad), got = {}, list = [], done = 0, i = 0, failed = null, partial = false;
    var next = function () {
      if (failed || i >= boxes.length) return Promise.resolve();
      var b = boxes[i++];
      return C().query({ where: '1=1', geometry: b.map(function (v) { return v.toFixed(7); }).join(','), geometryType: 'esriGeometryEnvelope', inSR: 4326, spatialRel: 'esriSpatialRelIntersects', resultRecordCount: 2000 }).then(function (g) {
        if (g.exceeded) partial = true;
        (g.features || []).forEach(function (f) {
          if (!f.geometry) return;
          var r = C().rings(f.geometry), k = (C().prop(f.properties || {}, ['objectid']) || C().lotplan(f.properties || {})) + '|' + (r[0] && r[0][0] && r[0][0][0] ? r[0][0][0].join(',') : '');
          if (!got[k]) { got[k] = 1; list.push(f); }
        });
        done++; GC.busy('Looking up parcels along the line… ' + Math.round(done / boxes.length * 100) + '%');
        return next();
      }, function (e) { failed = e; });
    };
    var workers = []; for (var w = 0; w < Math.min(4, boxes.length); w++) workers.push(next());
    return Promise.all(workers).then(function () { if (failed) throw failed; return { feats: list, partial: partial }; });
  }

  // ---------- the analysis ----------
  /** paths: [[[lon, lat], …], …]. opt: { buffer (m), ch0 (start chainage, m), reverse }. */
  function analyse(paths, feats, opt) {
    var G = grid(paths), segs = [], ch = opt.ch0 || 0;
    paths.forEach(function (path, pi) {
      var xy = path.map(G.xy);
      for (var i = 1; i < xy.length; i++) { var a = xy[i - 1], b = xy[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 1e-6) continue; segs.push({ a: a, b: b, ch0: ch, len: len, path: pi, bb: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] }); ch += len; }
    });
    var total = ch - (opt.ch0 || 0), hits = [];
    feats.forEach(function (f) {
      var polys = C().rings(f.geometry).map(function (poly) { return poly.map(function (r) { return r.map(G.xy); }); });
      var all = []; polys.forEach(function (poly) { poly.forEach(function (r) { all.push(r); }); });
      var bb = bboxOf([].concat.apply([], all)), ivs = [], inLen = 0, near = Infinity;
      segs.forEach(function (s) {
        if (!overlaps(s.bb, bb, opt.buffer + 1)) return;
        var ts = [0, 1];
        all.forEach(function (r) { for (var i = 1; i < r.length; i++) { var t = cross(s.a, s.b, r[i - 1], r[i]); if (t != null) ts.push(t); } });
        ts.sort(function (x, y) { return x - y; });
        for (var k = 1; k < ts.length; k++) {
          var t0 = ts[k - 1], t1 = ts[k]; if (t1 - t0 < 1e-9) continue;
          var tm = (t0 + t1) / 2, mx = s.a[0] + (s.b[0] - s.a[0]) * tm, my = s.a[1] + (s.b[1] - s.a[1]) * tm;
          if (inRings(mx, my, all)) { var c0 = s.ch0 + t0 * s.len, c1 = s.ch0 + t1 * s.len, last = ivs[ivs.length - 1]; inLen += c1 - c0; if (last && Math.abs(last[1] - c0) < 0.01) last[1] = c1; else ivs.push([c0, c1]); }
        }
        if (opt.buffer > 0 && !inLen) all.forEach(function (r) { for (var i = 1; i < r.length; i++) near = Math.min(near, segSeg(s.a, s.b, r[i - 1], r[i])); });
      });
      if (inLen > 0.05 || near <= opt.buffer) hits.push({ f: f, cls: classify(f.properties || {}), tenure: tenureOf(f.properties || {}), len: inLen, ivs: ivs, near: inLen > 0.05 ? 0 : near });
    });
    // stretches of the line in no parcel (easements sit on top of lots, so they don't count as cover)
    var cover = []; hits.forEach(function (h) { if (h.cls.k !== 'esmt') h.ivs.forEach(function (v) { cover.push(v); }); });
    cover.sort(function (a, b) { return a[0] - b[0]; });
    var gaps = [], pathRanges = [];
    segs.forEach(function (s) { var r = pathRanges[s.path]; if (!r) pathRanges[s.path] = [s.ch0, s.ch0 + s.len]; else r[1] = s.ch0 + s.len; });
    pathRanges.forEach(function (r) {
      var at = r[0];
      cover.forEach(function (v) { if (v[1] <= at || v[0] >= r[1]) return; if (v[0] > at + 1) gaps.push([at, Math.min(v[0], r[1])]); at = Math.max(at, v[1]); });
      if (r[1] > at + 1) gaps.push([at, r[1]]);
    });
    var gapLines = gaps.map(function (g) { // the gap's own piece of line, for the map
      var pts = [];
      segs.forEach(function (s) {
        if (s.ch0 + s.len < g[0] || s.ch0 > g[1]) return;
        var t0 = Math.max(0, (g[0] - s.ch0) / s.len), t1 = Math.min(1, (g[1] - s.ch0) / s.len);
        var at = function (t) { return G.ll(s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t).map(function (v) { return Math.round(v * 1e7) / 1e7; }); };
        if (!pts.length) pts.push(at(t0)); pts.push(at(t1));
      });
      return { ch: g, len: g[1] - g[0], pts: pts };
    });
    hits.sort(function (a, b) { return (a.ivs[0] ? a.ivs[0][0] : 1e12) - (b.ivs[0] ? b.ivs[0][0] : 1e12); });
    return { hits: hits, gaps: gapLines, total: total, pieces: paths.length };
  }

  // ---------- output ----------
  function fmtCh(v) { v = Math.round(v); var neg = v < 0 ? '-' : ''; v = Math.abs(v); return 'CH ' + neg + Math.floor(v / 1000) + '+' + ('00' + (v % 1000)).slice(-3); }
  function chRange(a, b) { return fmtCh(a) + '–' + fmtCh(b).slice(3); }
  function chText(ivs) { return ivs.map(function (v) { return chRange(v[0], v[1]); }).join(', '); }
  function m(v) { return GC.fmtDist(v); }
  function toLayer(name, res, opt) {
    var feats = res.hits.map(function (h) {
      var p = h.f.properties || {}, out = { name: C().title(p), lotplan: C().lotplan(p), tenure: h.tenure || '(not given)', class: h.cls.n,
        alignment_in_lot_m: Math.round(h.len * 10) / 10, chainage: res.pieces === 1 ? chText(h.ivs) : '', area_m2: Math.round(Math.abs(C().areaOf(h.f.geometry))),
        stroke: h.cls.c, 'stroke-width': 3, fill: h.cls.c, 'fill-opacity': h.cls.k === 'esmt' ? 0.15 : 0.3 };
      if (!h.len) out.within_m = Math.round(h.near * 10) / 10;
      ['locality', 'shire_name', 'parcel_typ', 'lot_area'].forEach(function (k) { var v = C().prop(p, [k]); if (v != null) out[k] = v; });
      return { type: 'Feature', properties: out, geometry: h.f.geometry };
    }).concat(res.gaps.filter(function (g) { return g.pts.length > 1; }).map(function (g) {
      return { type: 'Feature', properties: { name: 'No parcel ' + (res.pieces === 1 ? chRange(g.ch[0], g.ch[1]) : m(g.len)), class: GAP.n, length_m: Math.round(g.len * 10) / 10, stroke: GAP.c, 'stroke-width': 7 }, geometry: { type: 'LineString', coordinates: g.pts } };
    }));
    var p = GC.project, l = p.layers.filter(function (x) { return x.kind === 'vector' && x.format === 'Parcels' && x.name === name; })[0];
    var gj = { type: 'FeatureCollection', features: feats };
    if (l) { l.geojson = gj; l.hiddenFeats = {}; GC.renderLayer(l); GC.markDirty(l.id); }
    else {
      l = { id: global.Ink.uid(), name: name, kind: 'vector', visible: true, opacity: 1, locked: true, geojson: gj, crs: 4326, format: 'Parcels',
        warnings: ['Parcels from the Queensland cadastre (DCDB), © State of Queensland, CC BY 4.0. A guide only, not a survey: confirm tenure and ownership with a title search.'],
        style: { color: '#ffb300', width: 2.5, fillOpacity: 0.3, useFileStyle: true }, labelField: 'lotplan', created: Date.now() };
      GC.insertLayer(l, true);
    }
    l.parcelRun = { opt: opt, total: res.total, pieces: res.pieces, t: Date.now() };
    GC.applyLayerState(); GC.refreshLayers();
    return l;
  }
  function csv(res) {
    var q = function (v) { v = v == null ? '' : String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var rows = [['Lot/plan', 'Lot', 'Plan', 'Tenure', 'Class', 'Alignment in lot (m)', 'Chainage', 'Within (m)', 'Lot area (m²)', 'Locality']];
    res.hits.forEach(function (h) { var p = h.f.properties || {}; rows.push([C().lotplan(p), C().prop(p, ['lot']), C().prop(p, ['plan']), h.tenure, h.cls.n, h.len.toFixed(1), res.pieces === 1 ? chText(h.ivs) : '', h.len ? '' : h.near.toFixed(1), Math.round(Math.abs(C().areaOf(h.f.geometry))), C().prop(p, ['locality']) || '']); });
    res.gaps.forEach(function (g) { rows.push(['', '', '', '', GAP.n, g.len.toFixed(1), res.pieces === 1 ? chRange(g.ch[0], g.ch[1]) : '', '', '', '']); });
    return '﻿' + rows.map(function (r) { return r.map(q).join(','); }).join('\r\n') + '\r\n';
  }
  function summary(res) {
    var by = {}; res.hits.forEach(function (h) { var s = by[h.cls.k] = by[h.cls.k] || { c: h.cls, n: 0, len: 0 }; s.n++; s.len += h.len; });
    var gl = res.gaps.reduce(function (a, g) { return a + g.len; }, 0);
    return CLS.filter(function (c) { return by[c.k]; }).map(function (c) { return { c: c, n: by[c.k].n, len: by[c.k].len }; }).concat(gl > 0 ? [{ c: GAP, n: res.gaps.length, len: gl, gap: true }] : []);
  }
  function showResults(name, res, l, opt, partial) {
    var sm = summary(res), chain = res.pieces === 1;
    GC.modal('<h2>Parcels along ' + esc(name) + '</h2><p class="sub">' + res.hits.length + ' parcel' + (res.hits.length === 1 ? '' : 's') + ' along ' + m(res.total) + ' of alignment' + (opt.buffer ? ' (and within ' + opt.buffer + ' m of it)' : '') + '. Shown on the map as the layer “' + esc(l.name) + '”.</p>' +
      '<div class="pa-sum">' + sm.map(function (s) { return '<div class="pa-chip"><i style="background:' + s.c.c + '"></i><b>' + esc(s.c.n) + '</b><span>' + (s.gap ? s.n + ' stretch' + (s.n === 1 ? '' : 'es') : s.n + ' lot' + (s.n === 1 ? '' : 's')) + ' · ' + m(s.len) + '</span></div>'; }).join('') + '</div>' +
      (partial ? '<p class="warn">Some areas had more parcels than the service returns at once; zoom the line into smaller pieces if lots look missing.</p>' : '') +
      (!chain ? '<p class="hint">The line is in ' + res.pieces + ' separate pieces, so chainages are not given.</p>' : '') +
      '<div class="pa-list">' + res.hits.map(function (h, i) {
        var p = h.f.properties || {};
        return '<button class="pa-row" data-i="' + i + '"><i style="background:' + h.cls.c + '"></i><div class="grow"><b>' + esc(C().lotplan(p)) + '</b><small>' + esc((h.tenure || 'Tenure not given') + ' · ' + h.cls.n) + '</small></div>' +
          '<div class="pa-len"><b>' + (h.len ? m(h.len) : 'beside') + '</b><small>' + esc(h.len ? (chain ? chText(h.ivs) : '') : 'within ' + m(h.near)) + '</small></div></button>';
      }).join('') + res.gaps.map(function (g) {
        return '<div class="pa-row gap"><i style="background:' + GAP.c + '"></i><div class="grow"><b>No parcel</b><small>Road reserve or unparcelled land</small></div><div class="pa-len"><b>' + m(g.len) + '</b><small>' + (chain ? chRange(g.ch[0], g.ch[1]) : '') + '</small></div></div>';
      }).join('') + '</div>' +
      '<p class="hint">From the Queensland cadastre: a guide only, not a survey. Freehold is private land; confirm owners and interests with a title search.</p>' +
      '<div class="actions"><button class="btn" data-a="csv">Export CSV</button><span class="spacer"></span><button class="btn primary" data-a="ok">Done</button></div>',
    function (el, close) {
      el.querySelector('[data-a=ok]').onclick = close;
      el.querySelector('[data-a=csv]').onclick = function () { GC.saveBlob(new Blob([csv(res)], { type: 'text/csv' }), name.replace(/[^\w\- ]+/g, '').trim() + ' parcels.csv'); };
      [].forEach.call(el.querySelectorAll('.pa-row[data-i]'), function (b) {
        b.onclick = function () { close(); var i = +b.getAttribute('data-i'); GC.showFeature(l, i); };
      });
    });
  }

  // ---------- running it ----------
  function remember(o) { try { localStorage.setItem(LAST, JSON.stringify({ buffer: o.buffer })); } catch (e) { /* ignore */ } }
  function lastOpts() { try { return JSON.parse(localStorage.getItem(LAST) || '{}'); } catch (e) { return {}; } }
  /** The setup sheet: corridor width, start chainage, direction (and which DXF layers, for a CAD drawing). */
  function setup(name, getPaths, extraHtml, bindExtra) {
    var lo = lastOpts(), buf = BUFFERS.indexOf(lo.buffer) >= 0 ? lo.buffer : 0;
    GC.modal('<h2>Parcels along ' + esc(name) + '</h2><p class="sub">Finds every lot this line passes through, coloured by tenure: private (freehold), State land, leases, roads and easements, plus stretches in no lot (road reserve).</p>' +
      (extraHtml || '') +
      '<div class="cam-lbl">Also list lots within</div><div class="seg small" id="pa-buf">' + BUFFERS.map(function (b) { return '<button data-b="' + b + '"' + (b === buf ? ' class="on"' : '') + '>' + (b ? b + ' m' : 'On the line') + '</button>'; }).join('') + '</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end"><label class="field" style="flex:1;min-width:140px">Start chainage (m)<input type="number" id="pa-ch0" value="0" step="1" inputmode="decimal"></label>' +
      '<label class="opt" style="margin-bottom:10px"><input type="checkbox" id="pa-rev"> Chainage runs the other way</label></div>' +
      '<p class="fail" hidden></p><div class="actions"><button class="btn" data-a="no">Cancel</button><button class="btn primary" data-a="go">Find parcels</button></div>',
    function (el, close) {
      var msg = function (t) { var f = el.querySelector('.fail'); f.hidden = !t; f.textContent = t || ''; };
      el.querySelector('#pa-buf').onclick = function (e) { var b = e.target.closest('[data-b]'); if (!b) return; buf = +b.getAttribute('data-b'); [].forEach.call(this.children, function (x) { x.classList.toggle('on', x === b); }); };
      el.querySelector('[data-a=no]').onclick = close;
      if (bindExtra) bindExtra(el);
      el.querySelector('[data-a=go]').onclick = function () {
        var paths = getPaths(el);
        if (!paths || !paths.length) { msg('Choose the line (or the drawing layers) to follow first.'); return; }
        var opt = { buffer: buf, ch0: +el.querySelector('#pa-ch0').value || 0, reverse: el.querySelector('#pa-rev').checked };
        remember(opt); close(); run(name, paths, opt);
      };
    });
  }
  function run(name, paths, opt) {
    paths = joinPaths(paths);
    if (opt.reverse) paths = paths.slice().reverse().map(function (p) { return p.slice().reverse(); });
    var total = paths.reduce(function (a, p) { return a + Geo.pathLength(p); }, 0);
    if (total < 1) { GC.toast('The line is too short.', 'warn'); return Promise.resolve(null); }
    if (total > 200000) { GC.toast('The line is ' + m(total) + ' long. Split it into pieces under 200 km.', 'warn'); return Promise.resolve(null); }
    GC.busy('Looking up parcels along the line…');
    return fetchParcels(paths, opt.buffer).then(function (got) {
      GC.busy('Working out the parcels…');
      return new Promise(function (r) { setTimeout(r, 30); }).then(function () {
        var res = analyse(paths, got.feats, opt);
        GC.busy(null);
        var l = toLayer('Parcels along ' + name, res, opt);
        showResults(name, res, l, opt, got.partial);
        GC.lastParcels = res; // for tests
        return res;
      });
    }, function (e) {
      GC.busy(null);
      GC.toast('Could not reach the Queensland cadastre (' + e.message + '). This needs an internet connection.', 'err', 8000);
      return null;
    });
  }

  // ---------- where it starts from ----------
  /** A line: GeoJSON LineString / MultiLineString, or lists of [lon, lat]. */
  function forLine(name, g) {
    var paths = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates[0]] : null;
    if (!paths) { GC.toast('Parcels along a line need a line.', 'warn'); return; }
    paths = paths.map(function (p) { return p.map(function (q) { return [q[0], q[1]]; }); });
    setup(name, function () { return paths; });
  }
  var ALIGN = /align|centre ?line|center ?line|\bc\/?l\b|_cl\b|-cl\b|chainage|pipe|main\b|route/i;
  /** A CAD drawing: choose its alignment's DXF layers. */
  function forCad(l) {
    var cad = l.kind === 'libmap' ? (GC.mymaps.get(l.ref) || {}).cad : l.cad;
    if (!cad) { GC.toast('This drawing is not loaded.', 'warn'); return; }
    var names = cad.layers || [], d = GC.cad.decode(cad), count = {};
    d.lines.forEach(function (x) { if (x.ly >= 0) count[x.ly] = (count[x.ly] || 0) + 1; });
    var idx = Object.keys(count).map(Number).sort(function (a, b) { return String(names[a]).localeCompare(String(names[b])); });
    if (!names.length || !idx.length) { GC.toast('This drawing was imported before its DXF layers were kept: import it again to choose its alignment layer.', 'warn', 8000); return; }
    var pre = idx.filter(function (i) { return ALIGN.test(names[i]); });
    var html = '<div class="cam-lbl">The alignment: tick its DXF layer(s)</div><input type="search" id="pa-q" placeholder="Find a layer…" class="cl-q" style="width:100%;margin-bottom:6px"><div class="list pa-dxf">' +
      idx.map(function (i) { return '<label class="item"><input type="checkbox" data-ly="' + i + '"' + (pre.indexOf(i) >= 0 ? ' checked' : '') + '><div class="grow"><b>' + esc(names[i]) + '</b><small>' + count[i] + ' line' + (count[i] === 1 ? '' : 's') + '</small></div></label>'; }).join('') + '</div>';
    setup(l.name, function (el) {
      var on = {}; [].forEach.call(el.querySelectorAll('.pa-dxf input:checked'), function (c) { on[c.getAttribute('data-ly')] = 1; });
      var paths = [];
      d.lines.forEach(function (x) { if (!on[x.ly]) return; var p = []; for (var k = 0; k < x.p.length; k += 2) p.push([x.p[k], x.p[k + 1]]); if (p.length > 1) paths.push(p); });
      return paths;
    }, html, function (el) {
      var q = el.querySelector('#pa-q');
      q.oninput = function () { var t = q.value.trim().toLowerCase(); [].forEach.call(el.querySelectorAll('.pa-dxf .item'), function (it) { it.style.display = !t || it.textContent.toLowerCase().indexOf(t) >= 0 ? '' : 'none'; }); };
    });
  }

  GC.parcels = { forLine: forLine, forCad: forCad, run: run, analyse: analyse, classify: classify, CLS: CLS };
})(window);
