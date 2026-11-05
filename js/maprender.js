/* GeoCanvas web — draws the project's visible layers into a canvas, for PDF maps (the photo report's overview map
   and drawing pictures). The canvas is a Web Mercator pixel grid at zoom z with its top-left at (ox, oy).
   Drawn in the map's layer order: placed plans and GeoPDFs, online map services (asked from their servers for this
   exact view), CAD drawings (their DXF layers as switched on), GIS/KML layers, GPS tracks and waypoints, drawings,
   then the lot boundaries when they are on. The actions layer is left to the report (numbered pins). */
(function (global) {
  'use strict';
  var GC = global.GC, Geo = global.Geo, Ink = global.Ink;

  function loadImg(src, cors) {
    return new Promise(function (res) {
      var im = new Image(), done = false, t = setTimeout(function () { fin(null); }, 15000);
      var fin = function (v) { if (done) return; done = true; clearTimeout(t); res(v); };
      if (cors) im.crossOrigin = 'anonymous';
      im.onload = function () { fin(im); }; im.onerror = function () { fin(null); };
      im.src = src;
    });
  }
  /** Draws an image so that its top-left, top-right and bottom-left corners land on a, b, c (pixels). */
  function affine(x, im, a, b, c, clip, alpha) {
    var w = im.naturalWidth || im.width, h = im.naturalHeight || im.height; if (!w || !h) return;
    x.save(); x.globalAlpha = alpha;
    x.transform((b[0] - a[0]) / w, (b[1] - a[1]) / w, (c[0] - a[0]) / h, (c[1] - a[1]) / h, a[0], a[1]);
    if (clip && clip.length > 2) { x.beginPath(); clip.forEach(function (p, i) { var px = p[0] / 100 * w, py = p[1] / 100 * h; if (i) x.lineTo(px, py); else x.moveTo(px, py); }); x.closePath(); x.clip(); }
    x.drawImage(im, 0, 0, w, h); x.restore();
  }
  function fourth(c) { return [c[1][0] + c[2][0] - c[0][0], c[1][1] + c[2][1] - c[0][1]]; }

  /**
   * v: { z, ox, oy, w, h, k (line-width factor) }. opt: { skip(layer) → true to leave a layer out }.
   * Resolves to { drawn: [names], missed: [{ name, why }] }.
   */
  function draw(x, v, opt) {
    opt = opt || {};
    var ws = 256 * Math.pow(2, v.z), k = v.k || 1, W = v.w, H = v.h;
    var px = function (lat, lon) { var m = Geo.merc(lon, lat); return [m[0] * ws - v.ox, m[1] * ws - v.oy]; };
    var pm = function (m) { return [m[0] * ws - v.ox, m[1] * ws - v.oy]; };
    var lb = function (m) { var ll = Geo.unmerc(m[0], m[1]); return L.latLng(ll[1], ll[0]); };
    var view = L.latLngBounds(lb([v.ox / ws, (v.oy + H) / ws]), lb([(v.ox + W) / ws, v.oy / ws]));
    var mpp = Geo.metersPerPixel(v.z, view.getCenter().lat);
    var drawn = [], missed = [];
    var bbox3857 = function () { var h = 20037508.342789244, s = 2 * h / ws; return [v.ox * s - h, h - (v.oy + H) * s, (v.ox + W) * s - h, h - v.oy * s].map(function (q) { return q.toFixed(2); }).join(','); };
    var path = function (pts) { pts.forEach(function (q, i) { var p = px(q[1], q[0]); if (i) x.lineTo(p[0], p[1]); else x.moveTo(p[0], p[1]); }); };
    var label = function (t, p, col) {
      x.save(); x.font = '600 ' + Math.round(11 * k) + 'px Helvetica, Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.lineWidth = 3 * k; x.strokeStyle = 'rgba(0,0,0,.7)'; x.strokeText(String(t), p[0], p[1]); x.fillStyle = col || '#fff'; x.fillText(String(t), p[0], p[1]); x.restore();
    };
    var images = function (l, list, alpha) { // [{url, c (3 corners), clip}]
      var on = list.filter(function (p) { return p && p.url && p.c && L.latLngBounds([p.c[0], p.c[1], p.c[2], fourth(p.c)]).intersects(view); });
      return Promise.all(on.map(function (p) { return loadImg(p.url, !/^(data|blob):/.test(p.url)); })).then(function (ims) {
        var ok = 0;
        ims.forEach(function (im, i) { if (!im) return; var c = on[i].c; try { affine(x, im, px(c[0][0], c[0][1]), px(c[1][0], c[1][1]), px(c[2][0], c[2][1]), on[i].clip, alpha); ok++; } catch (e) { /* tainted or broken */ } });
        if (on.length && !ok) missed.push({ name: l.name, why: 'its picture is not on this device' }); else if (ok) drawn.push(l.name);
      });
    };
    var mapImage = function (l, url, why) {
      return loadImg(url, true).then(function (im) {
        if (!im) { missed.push({ name: l.name, why: why }); return; }
        x.save(); x.globalAlpha = l.opacity == null ? 1 : l.opacity; x.drawImage(im, 0, 0, W, H); x.restore();
        try { x.getImageData(0, 0, 1, 1); drawn.push(l.name); } catch (e) { missed.push({ name: l.name, why: why }); }
      });
    };
    var cad = function (l, src) {
      var o = Object.assign({}, src, { mono: l.mono, hideFills: l.hideFills, cadOff: l.cadOff, showText: l.showText != null ? l.showText : src.showText });
      if (!o.cad) return;
      x.save(); x.globalAlpha = l.opacity == null ? 1 : l.opacity;
      GC.cadPaint(x, o, GC.cadPrep(o.cad), ws, v.ox, v.oy, W, H, mpp, 1.4 * k);
      x.restore(); drawn.push(l.name);
    };
    var vector = function (l) {
      var vis = GC.featVisibility(l), fs = (l.geojson.features || []).filter(function (f, i) { return vis[i] && f.geometry; });
      var bb = global.Importers ? global.Importers.bounds({ type: 'FeatureCollection', features: fs }) : null;
      if (bb && isFinite(bb[0]) && !L.latLngBounds([bb[1], bb[0]], [bb[3], bb[2]]).intersects(view)) return;
      x.save(); x.globalAlpha = l.opacity == null ? 1 : l.opacity; x.lineJoin = 'round'; x.lineCap = 'round';
      var labels = [];
      fs.forEach(function (f) {
        var g = f.geometry, gs = g.type === 'GeometryCollection' ? g.geometries : [g];
        gs.forEach(function (gg) {
          var t = gg.type, pt = /Point/.test(t), st = GC.featStyle(l, f, pt);
          if (pt) {
            (t === 'Point' ? [gg.coordinates] : gg.coordinates).forEach(function (c) { var p = px(c[1], c[0]); x.beginPath(); x.arc(p[0], p[1], 5 * k, 0, 7); x.fillStyle = st.fillColor; x.fill(); x.lineWidth = 1.5 * k; x.strokeStyle = '#fff'; x.stroke(); });
            return;
          }
          var polys = t === 'Polygon' ? [gg.coordinates] : t === 'MultiPolygon' ? gg.coordinates : null, lines = t === 'LineString' ? [gg.coordinates] : t === 'MultiLineString' ? gg.coordinates : null;
          x.beginPath();
          if (polys) polys.forEach(function (poly) { poly.forEach(function (r) { path(r); x.closePath(); }); });
          if (lines) lines.forEach(path);
          if (polys && st.fillOpacity > 0) { x.save(); x.globalAlpha *= st.fillOpacity; x.fillStyle = st.fillColor; x.fill('evenodd'); x.restore(); }
          x.lineWidth = (st.weight || 2) * k; x.strokeStyle = st.color; x.globalAlpha = (l.opacity == null ? 1 : l.opacity) * (st.opacity == null ? 1 : st.opacity); x.stroke(); x.globalAlpha = l.opacity == null ? 1 : l.opacity;
        });
        var p = f.properties || {}, tx = l.labelField ? p[l.labelField] : (l.tree ? p.name : null);
        if (tx != null && tx !== '' && fs.length <= 400) { var b = L.geoJSON(f).getBounds(); if (view.contains(b.getCenter())) labels.push([tx, px(b.getCenter().lat, b.getCenter().lng)]); }
      });
      labels.forEach(function (a) { label(a[0], a[1]); });
      x.restore(); drawn.push(l.name);
    };
    var tracks = function (l) {
      x.save(); x.lineJoin = 'round'; x.lineCap = 'round';
      (l.tracks || []).forEach(function (t) {
        if (t.points.length < 2) return;
        x.beginPath(); path(t.points); x.strokeStyle = 'rgba(255,255,255,.8)'; x.lineWidth = 7 * k; x.stroke(); x.strokeStyle = l.color || '#ff3d00'; x.lineWidth = 4 * k; x.stroke();
      });
      x.restore(); drawn.push(l.name);
    };
    var waypoints = function (l) {
      (l.waypoints || []).forEach(function (w) {
        var p = px(w.lat, w.lon); if (p[0] < -20 || p[1] < -20 || p[0] > W + 20 || p[1] > H + 20) return;
        x.beginPath(); x.arc(p[0], p[1], 6 * k, 0, 7); x.fillStyle = l.color || '#e8590c'; x.fill(); x.lineWidth = 2 * k; x.strokeStyle = '#fff'; x.stroke();
        if (w.name) { x.save(); x.font = '600 ' + Math.round(11 * k) + 'px Helvetica, Arial, sans-serif'; x.textBaseline = 'middle'; x.lineWidth = 3 * k; x.strokeStyle = 'rgba(0,0,0,.7)'; x.strokeText(w.name, p[0] + 9 * k, p[1]); x.fillStyle = '#fff'; x.fillText(w.name, p[0] + 9 * k, p[1]); x.restore(); }
      });
      drawn.push(l.name);
    };
    var ink = function (l) {
      x.save();
      l.items.forEach(function (el) {
        if (el.type === 'marker') {
          var p = px(el.at[1], el.at[0]); x.beginPath(); x.arc(p[0], p[1], 7 * k, 0, 7); x.fillStyle = el.color || '#e53935'; x.fill(); x.lineWidth = 2 * k; x.strokeStyle = '#fff'; x.stroke();
          if (el.title) label(el.title, [p[0], p[1] - 14 * k]);
          return;
        }
        var c = {}; for (var key in el) if (key !== '_g') c[key] = el[key];
        try { Ink.draw(x, c, pm, v.z, l.opacity == null ? 1 : l.opacity); } catch (e) { /* degenerate */ }
      });
      x.restore(); drawn.push(l.name);
    };
    var steps = (GC.project ? GC.project.layers : []).filter(function (l) { return l.visible && !(opt.skip && opt.skip(l)); }).map(function (l) {
      return function () {
        var alpha = l.opacity == null ? 1 : l.opacity;
        if (l.kind === 'raster') return images(l, [{ url: l.dataURL, c: l.corners || [[l.bounds[1][0], l.bounds[0][1]], [l.bounds[1][0], l.bounds[1][1]], [l.bounds[0][0], l.bounds[0][1]]] }], alpha);
        if (l.kind === 'geopdf') return images(l, l.pieces || [], alpha);
        if (l.kind === 'libmap') {
          var src = GC.mymaps && GC.mymaps.get(l.ref); if (!src) return;
          if (src.kind === 'cad') { cad(l, src); return; }
          if (src.kind === 'service') return service(Object.assign({}, src, { name: l.name, opacity: l.opacity }));
          var list = src.overview ? [src.overview] : src.pieces ? src.pieces : src.img ? [src.img] : src.dataURL ? [{ url: src.dataURL, c: src.corners || [[src.bounds[1][0], src.bounds[0][1]], [src.bounds[1][0], src.bounds[1][1]], [src.bounds[0][0], src.bounds[0][1]]] }] : [];
          return images(l, list, alpha);
        }
        if (l.kind === 'cad') { cad(l, l); return; }
        if (l.kind === 'service') return service(l);
        if (l.kind === 'vector') { vector(l); return; }
        if (l.kind === 'track') { tracks(l); return; }
        if (l.kind === 'waypoints') { waypoints(l); return; }
        if (l.kind === 'drawing') { ink(l); return; }
      };
    });
    function service(l) {
      var s = l.service; if (!s) return;
      if (l.bounds && !L.latLngBounds(l.bounds).intersects(view)) return;
      var url = s.url + (s.image ? '/exportImage?bbox=' + bbox3857() + '&bboxSR=3857&imageSR=3857&size=' + W + ',' + H + '&format=png&f=image'
        : '/export?bbox=' + bbox3857() + '&bboxSR=3857&imageSR=3857&size=' + W + ',' + H + '&dpi=' + Math.round(96 * k) + '&format=png32&transparent=true' + (s.show ? '&layers=show:' + s.show.join(',') : '') + '&f=image');
      return mapImage(l, url, 'its server could not be reached or does not allow it');
    }
    if (opt.cadastre !== false && GC.cadastre && GC.cadastre.on()) steps.push(function () {
      return mapImage({ name: 'Lot boundaries', opacity: 1 }, GC.cadastre.BASE + '/export?bbox=' + bbox3857() + '&bboxSR=3857&imageSR=3857&size=' + W + ',' + H + '&dpi=' + Math.round(96 * k) + '&format=png32&transparent=true&layers=show:4&f=image', 'the Queensland cadastre could not be reached');
    });
    return steps.reduce(function (ch, f) { return ch.then(f).catch(function () { /* one layer failing does not stop the rest */ }); }, Promise.resolve()).then(function () { return { drawn: drawn, missed: missed }; });
  }

  GC.mapRender = { draw: draw };
})(window);
