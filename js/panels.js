/* GeoCanvas web — import, inspector, GPS, search, export, projects, settings and start-up. */
(function (global) {
  'use strict';
  var GC = global.GC, Geo = global.Geo, Ink = global.Ink, Store = global.Store, Importers = global.Importers, Exporters = global.Exporters;
  var map = GC.map, $ = GC.$, esc = GC.esc;

  // ======================= import =======================
  $('btn-import').onclick = function () { $('file-input').value = ''; $('file-input').click(); };
  $('file-input').onchange = function () { var f = Array.prototype.slice.call($('file-input').files); if (f.length) importFiles(f); };
  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('drop', function (e) { e.preventDefault(); var f = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []); if (f.length) importFiles(f); });

  function guessLabel(gj) {
    var f = (gj.features || [])[0]; if (!f || !f.properties) return null;
    var keys = Object.keys(f.properties);
    for (var i = 0; i < keys.length; i++) if (/^(name|label|title|id|site|lot_?plan|lotplan)$/i.test(keys[i])) return keys[i];
    return null;
  }
  function blobToDataURL(b) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsDataURL(b); }); }
  function storeSources(l, files) {
    if (!files || !files.length) return Promise.resolve();
    l.hasSources = true; l.sourceNames = files.map(function (f) { return f.name; });
    return Promise.all(files.map(function (f) { return Store.putFile(GC.project.id, l.id, f.name, f.buf); })).catch(function () { l.hasSources = false; });
  }

  function addVector(v) {
    var l = { id: Ink.uid(), name: v.name, kind: 'vector', visible: true, opacity: 1, locked: true, geojson: v.geojson, crs: v.crs, assumed: !!v.assumed, format: v.format,
      warnings: v.warnings || [], style: { color: GC.nextLayerColor(), width: 2, fillOpacity: 0.2, useFileStyle: true }, labelField: v.geojson.features.length <= 300 ? guessLabel(v.geojson) : null, created: Date.now() };
    if (v.kml) { // Google Earth structure: folder tree, per-placemark visibility, balloons
      l.tree = v.tree; l.hiddenFeats = v.hiddenFeats || {};
      if (v.balloons) { l.balloons = v.balloons; l.featBalloon = v.featBalloon; }
      if (v.displayNames) l.displayNames = v.displayNames;
      if (v.geojson.features.some(function (f) { return f.properties && f.properties.name; })) l.labelField = 'name';
    }
    var icons = v.iconBlobs ? Object.keys(v.iconBlobs) : [];
    return Promise.all(icons.map(function (h) { return blobToDataURL(v.iconBlobs[h]).then(function (u) { (l.icons = l.icons || {})[h] = u; }); })).then(function () {
      GC.insertLayer(l);
      return storeSources(l, v.files);
    }).then(function () { return l; });
  }
  function addRaster(r) {
    var l = { id: Ink.uid(), name: r.name, kind: 'raster', visible: true, opacity: 0.85, locked: true, dataURL: r.dataURL, bounds: r.bounds, crs: r.crs, format: r.format || 'GeoTIFF', warnings: r.warnings || [], created: Date.now() };
    GC.insertLayer(l);
    return Promise.resolve(l);
  }
  function addOverlay(o) {
    return blobToDataURL(o.blob).then(function (url) {
      var w = o.rotation ? ['The overlay is rotated ' + o.rotation + '° in the KMZ; it is shown unrotated.'] : [];
      return addRaster({ name: o.name, dataURL: url, bounds: o.bounds, crs: 4326, format: 'KMZ overlay', warnings: w });
    });
  }

  /** Asks for the coordinate system of a dataset. Resolves an EPSG code or null. */
  GC.pickCRS = function (title, explanation, suggestions, current) {
    return new Promise(function (res) {
      var done = false;
      var opts = suggestions.filter(function (c) { return Geo.CRS[c]; }).map(function (c) { return '<option value="' + c + '"' + (c === current ? ' selected' : '') + '>' + esc(Geo.crsLabel(c)) + '</option>'; }).join('');
      GC.modal('<h2>' + esc(title) + '</h2><p class="sub">' + esc(explanation) + '</p>' +
        '<label class="field" style="margin:8px 0">Coordinate system<select id="crs-sel">' + opts + '<option value="other">Other EPSG code…</option></select></label>' +
        '<label class="field" style="margin:8px 0" id="crs-other-row" hidden>EPSG code<input type="text" id="crs-other" inputmode="numeric" placeholder="e.g. 7856"></label>' +
        '<p class="hint" style="margin:6px 0">Toowoomba and the Darling Downs are in <b>MGA zone 56</b> (GDA2020: EPSG 7856, GDA94: EPSG 28356). Western Downs is zone 55 west of 150°E. Older data may use AMG84/AMG66.</p>' +
        '<div class="actions"><button class="btn" data-a="skip">Skip this file</button><button class="btn primary" data-a="ok">Use this system</button></div>',
        function (el, close) {
          var sel = el.querySelector('#crs-sel');
          sel.onchange = function () { el.querySelector('#crs-other-row').hidden = sel.value !== 'other'; };
          el.querySelector('[data-a=skip]').onclick = close;
          el.querySelector('[data-a=ok]').onclick = function () {
            var code = sel.value === 'other' ? parseInt(el.querySelector('#crs-other').value, 10) : +sel.value;
            if (!Geo.CRS[code]) { GC.toast('EPSG:' + (code || '?') + ' is not in GeoCanvas’s list. Reproject the file to GDA2020 / MGA zone 56 (EPSG 7856) or WGS84 in QGIS.', 'warn', 7000); return; }
            done = true; close(); res(code);
          };
        }, function () { if (!done) res(null); });
    });
  };

  function importFiles(files, opts) {
    // DXF drawings become reference layers (js/cad.js), one at a time.
    var dxfs = GC.cad ? files.filter(function (f) { return /\.dxf$/i.test(f.name); }) : [];
    if (dxfs.length) {
      files = files.filter(function (f) { return dxfs.indexOf(f) < 0; });
      dxfs.reduce(function (chain, f) { return chain.then(function () { return GC.cad.importDxf(f); }); }, Promise.resolve());
      if (!files.length) return Promise.resolve();
    }
    if (files.some(function (f) { return /\.dwg$/i.test(f.name); })) {
      GC.toast('DWG files can’t be opened directly. In CAD use File › Save As › DXF (Civil 3D: Export to AutoCAD first), then import the DXF.', 'warn', 10000);
      files = files.filter(function (f) { return !/\.dwg$/i.test(f.name); });
      if (!files.length) return Promise.resolve();
    }
    // Plans (PDF or images that are not GeoTIFFs) open in the georeferencer.
    var plans = GC.georef ? files.filter(function (f) { return GC.georef.isPlan(f.name); }) : [];
    if (plans.length) {
      files = files.filter(function (f) { return plans.indexOf(f) < 0; });
      GC.georef.start(plans[0]);
      if (plans.length > 1) GC.toast('Plans are placed one at a time. Import the others after this one.', 'warn');
      if (!files.length) return Promise.resolve();
    }
    GC.busy('Reading ' + files.length + (files.length === 1 ? ' file' : ' files') + '…');
    var added = [], report = { failures: [], warnings: [], skipped: [] };
    return new Promise(function (r) { setTimeout(r, 30); }).then(function () {
      return Importers.importFiles(files, Object.assign({ maxRaster: 3000 }, opts || {}));
    }).then(function (r) {
      report.failures = r.failures;
      var jobs = [];
      r.vectors.forEach(function (v) { jobs.push(addVector(v).then(function (l) { added.push(l); if (v.warnings && v.warnings.length) report.warnings.push({ name: v.name, w: v.warnings }); })); });
      r.rasters.forEach(function (x) { jobs.push(addRaster(x).then(function (l) { added.push(l); })); });
      r.overlays.forEach(function (o) { jobs.push(addOverlay(o).then(function (l) { added.push(l); })); });
      return Promise.all(jobs).then(function () {
        GC.busy(null);
        // Datasets with projected coordinates and no CRS: ask, one at a time.
        return r.pending.reduce(function (chain, p) {
          return chain.then(function () {
            return GC.pickCRS('Which coordinate system?', p.explanation, p.suggestions).then(function (code) {
              if (!code) { report.skipped.push(p.name); return; }
              GC.busy('Converting ' + p.name + '…');
              try {
                var res = Importers.resolvePending(p, code);
                return Promise.all((res.vectors || []).map(addVector).concat((res.rasters || []).map(addRaster))).then(function (ls) { added = added.concat(ls); GC.busy(null); });
              } catch (e) { GC.busy(null); report.failures.push({ file: p.name, error: e.message }); }
            });
          });
        }, Promise.resolve());
      });
    }).then(function () {
      GC.busy(null);
      if (added.length) {
        var b = null; added.forEach(function (l) { var lb = GC.layerBounds(l); if (lb) { if (b) b.extend(lb); else b = L.latLngBounds(lb.getSouthWest(), lb.getNorthEast()); } });
        if (b) map.fitBounds(b, { padding: [60, 60], maxZoom: 18 });
        if (document.body.classList.contains('no-sidebar')) document.body.classList.remove('no-sidebar');
      }
      if (report.failures.length || report.warnings.length || report.skipped.length) showReport(added, report);
      else if (added.length) GC.toast('Imported ' + added.map(function (l) { return '“' + l.name + '”'; }).join(', ') + '.');
      GC.saveNow();
    }).catch(function (e) { GC.busy(null); GC.toast('Import failed: ' + e.message, 'err'); });
  }
  GC.importFiles = importFiles;
  function showReport(added, rep) {
    var h = '<h2>Import report</h2>';
    if (added.length) h += '<p class="ok">✓ Imported: ' + added.map(function (l) { return esc(l.name); }).join(', ') + '</p>';
    rep.warnings.forEach(function (w) { h += '<div class="warn"><b>' + esc(w.name) + ':</b> ' + w.w.map(esc).join(' ') + '</div>'; });
    rep.skipped.forEach(function (n) { h += '<p class="hint">Skipped (no coordinate system chosen): ' + esc(n) + '</p>'; });
    rep.failures.forEach(function (f) { h += '<p class="fail">✗ <b>' + esc(f.file) + '</b> — ' + esc(f.error) + '</p>'; });
    GC.modal(h + '<div class="actions"><button class="btn primary" data-a="ok">OK</button></div>', function (el, close) { el.querySelector('[data-a=ok]').onclick = close; });
  }

  /** Re-reads a layer's original files in another coordinate system. */
  GC.changeCRS = function (l) {
    var sugg = Geo.pickerOptions(56);
    GC.pickCRS('Change coordinate system', 'Choose the system “' + l.name + '” was really made in. GeoCanvas re-reads the original files, so nothing is lost. Currently: ' + Geo.crsLabel(l.crs) + '.', sugg, l.crs).then(function (code) {
      if (!code) return;
      GC.busy('Re-reading ' + l.name + '…');
      Store.getFiles(GC.project.id, l.id).then(function (recs) {
        if (!recs.length) throw new Error('The original files are not stored for this layer.');
        var files = recs.map(function (r) { return new File([r.data], r.name); });
        return Importers.importFiles(files, { forceCRS: code });
      }).then(function (r) {
        GC.busy(null);
        var v = r.vectors[0], src = r.pending.length ? r.pending[0].raw : null;
        if (!v && !src) throw new Error((r.failures[0] && r.failures[0].error) || 'The file could not be re-read.');
        v = src ? { geojson: Importers.project(src, code) } : { geojson: v.crs === code ? v.geojson : Importers.project(v.geojson, code) };
        l.geojson = v.geojson; l.crs = code; l.assumed = false; l.warnings = (l.warnings || []).filter(function (w) { return !/treated as WGS84|No coordinate system/.test(w); });
        GC.renderLayer(l); GC.applyLayerState(); GC.markDirty(l.id); GC.refreshLayers(); GC.zoomToLayer(l);
        GC.toast('“' + l.name + '” is now read as ' + Geo.crsLabel(code) + '.');
      }).catch(function (e) { GC.busy(null); GC.toast(e.message, 'err'); });
    });
  };

  // ======================= inspector =======================
  /** photos: { refs, onChange(refs) } shows a photo strip (with Add when the point is editable). */
  function openInspector(title, sub, rows, actions, photos) {
    $('insp-title').textContent = title; $('insp-sub').textContent = sub || '';
    var h = '<table>' + rows.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + (r[2] ? r[1] : esc(r[1])) + '</td></tr>'; }).join('') + '</table>';
    if (actions && actions.length) h += '<div class="row-btns" style="margin:12px 0 0">' + actions.map(function (a, i) { return '<button class="btn' + (a.danger ? ' danger' : '') + '" data-i="' + i + '">' + esc(a.label) + '</button>'; }).join('') + '</div>';
    $('insp-body').innerHTML = (photos ? '<div id="insp-photos"></div>' : '') + h;
    Array.prototype.forEach.call($('insp-body').querySelectorAll('[data-i]'), function (b) { b.onclick = function () { actions[+b.getAttribute('data-i')].fn(); }; });
    if (photos) {
      var paint = function (refs) {
        GC.photos.strip($('insp-photos'), refs, photos.onChange ? {
          onAdd: function () { GC.photos.pick().then(function (more) { if (more.length) { refs = refs.concat(more); photos.onChange(refs); paint(refs); } }); },
          onChange: function (left) { refs = left; photos.onChange(left); paint(left); }
        } : {});
      };
      paint(photos.refs || []);
    }
    $('inspector').hidden = false;
    $('gps-panel').hidden = true;
  }
  GC.closeInspector = function () { $('inspector').hidden = true; if (balloon) map.closePopup(balloon); if (hl) { map.removeLayer(hl); hl = null; } };
  $('insp-close').onclick = GC.closeInspector;
  var hl = null;
  function highlight(geojson) {
    if (hl) map.removeLayer(hl);
    hl = L.geoJSON(geojson, { interactive: false, style: { color: '#ffff00', weight: 5, opacity: 0.9, fillOpacity: 0.1, fillColor: '#ffff00' }, pointToLayer: function (f, ll) { return L.circleMarker(ll, { radius: 11, color: '#ffff00', weight: 3, fill: false, interactive: false }); } }).addTo(map);
  }
  function posRows(lon, lat) { return [['Position', lat.toFixed(6) + ', ' + lon.toFixed(6)], ['MGA2020', Geo.fmt([lon, lat], 'mga')]]; }
  function measure(g) {
    var rows = [];
    if (!g) return rows;
    var len = 0, area = 0;
    var lines = g.type === 'LineString' ? [g.coordinates] : (g.type === 'MultiLineString' ? g.coordinates : []);
    lines.forEach(function (c) { len += Geo.pathLength(c); });
    var polys = g.type === 'Polygon' ? [g.coordinates] : (g.type === 'MultiPolygon' ? g.coordinates : []);
    polys.forEach(function (p) { p.forEach(function (r, i) { var a = Math.abs(Geo.ringArea(r)); area += i ? -a : a; len += Geo.pathLength(r); }); });
    if (lines.length) rows.push(['Length', GC.fmtDist(len)]);
    if (polys.length) { rows.push(['Area', GC.fmtArea(area)]); rows.push(['Perimeter', GC.fmtDist(len)]); }
    if (g.type === 'Point') rows = rows.concat(posRows(g.coordinates[0], g.coordinates[1]));
    return rows;
  }
  /** Finds what was tapped, honouring the layer order (canvases do not take pointer events). */
  GC.pickAt = function (e) {
    var cp = [e.containerPoint.x, e.containerPoint.y], lp = e.layerPoint, ls = GC.project.layers.slice().reverse();
    for (var i = 0; i < ls.length; i++) {
      var l = ls[i], v = GC.views[l.id]; if (!l.visible || !v) continue;
      if (l.kind === 'drawing') { var el = GC.hitItem(l, cp); if (el && el.type !== 'marker') { GC.inspectItem(l, el); return; } continue; }
      var hit = null, hitPt = null; // a placemark icon wins over the lines and areas under it
      var walk = function (x) {
        if (x.eachLayer) { x.eachLayer(walk); return; }
        if (x instanceof L.Marker && x.feature) { // placemark icons: hit their drawn box
          var io = (x.options.icon && x.options.icon.options) || {}, sz = io.iconSize || [20, 20], an = io.iconAnchor || [sz[0] / 2, sz[1] / 2], mp = map.latLngToLayerPoint(x.getLatLng());
          if (Math.abs(lp.x - (mp.x - an[0] + sz[0] / 2)) <= sz[0] / 2 + 7 && Math.abs(lp.y - (mp.y - an[1] + sz[1] / 2)) <= sz[1] / 2 + 7) hitPt = x;
          return;
        }
        if (x._containsPoint && (x._parts || x._point)) { try { if (x._containsPoint(lp)) hit = x; } catch (er) { /* not projected */ } } };
      v.group.eachLayer(walk);
      hit = hitPt || hit;
      if (hit) {
        if (hit.feature) GC.inspectFeature(l, hit.feature, e.latlng);
        else if (hit._gcTrack) GC.inspectTrack(l, hit._gcTrack);
        else if (hit._gcWp) GC.inspectWaypoint(l, hit._gcWp);
        else continue;
        return;
      }
    }
    if (GC.cadastre && GC.cadastre.identify(e.latlng)) return; // a lot, when lot boundaries are on
    GC.closeInspector();
  };
  // ---------- Google Earth style balloons ----------
  var balloon = null, kmzCache = {};
  function descText(d) { return d == null ? '' : (typeof d === 'object' ? (d.value || '') : String(d)); }
  function looksHtml(t) { return /<\/?[a-z][\s\S]*?>|&[a-z#0-9]+;/i.test(t); }
  function linkify(t) { return esc(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>'); }
  var INTERNAL = /^(stroke|stroke-opacity|stroke-width|fill|fill-opacity|marker-.*|styleUrl|styleHash|styleMapHash|icon|icon-.*|label-.*|visibility|open|coordinateProperties|@.*)$/;
  /** Attribute rows of a feature: KML ExtendedData, or every attribute of a shapefile/GeoJSON feature. */
  function dataRows(l, p) {
    var dn = l.displayNames || {}, kml = !!l.tree;
    return Object.keys(p).filter(function (k) {
      if (INTERNAL.test(k) || (kml && (k === 'name' || k === 'description' || k === 'address' || k === 'phoneNumber' || k === 'timespan' || k === 'timestamp'))) return false;
      var v = p[k]; return v != null && v !== '';
    }).map(function (k) { var v = p[k]; return [dn[k] || k, typeof v === 'object' ? JSON.stringify(v) : String(v)]; });
  }
  /** Google Earth BalloonStyle text: $[name], $[description], $[field], $[field/displayName], $[Schema/field]. */
  function expandBalloon(tpl, l, p, name) {
    var dn = l.displayNames || {};
    return tpl.replace(/\$\[([^\]]+)\]/g, function (m, key) {
      if (key === 'name') return esc(name);
      if (key === 'description') return descText(p.description);
      if (key === 'geDirections') return '';
      var parts = key.split('/'), disp = parts[parts.length - 1] === 'displayName';
      if (disp) parts.pop();
      var field = parts[parts.length - 1];
      if (disp) return esc(dn[field] || field);
      var v = p[field] != null ? p[field] : p[key];
      return v == null ? '' : String(v);
    });
  }
  /** Images inside a KMZ (e.g. <img src="files/photo.jpg">) are read from the stored KMZ. */
  function resolveKmz(l, html) {
    if (!/(src|background)\s*=\s*["']?(?!https?:|data:|\/\/|#)[^"'\s>]+/i.test(html) || !l.hasSources || !global.JSZip) return Promise.resolve(html);
    var zipP = kmzCache[l.id] || (kmzCache[l.id] = Store.getFiles(GC.project.id, l.id).then(function (fs) {
      var k = fs.filter(function (f) { return /\.kmz$/i.test(f.name); })[0]; return k ? JSZip.loadAsync(k.data) : null;
    }));
    return zipP.then(function (zip) {
      if (!zip) return html;
      var doc = new DOMParser().parseFromString(html, 'text/html'), jobs = [];
      Array.prototype.forEach.call(doc.querySelectorAll('[src],[background]'), function (el) {
        var attr = el.hasAttribute('src') ? 'src' : 'background', u = el.getAttribute(attr);
        if (/^(https?:|data:|\/\/|#)/i.test(u)) return;
        var e = zip.file(u) || zip.file(decodeURIComponent(u)) || zip.file(u.replace(/^\.\//, ''));
        if (!e) return;
        var mime = /\.png$/i.test(u) ? 'image/png' : /\.gif$/i.test(u) ? 'image/gif' : /\.svg$/i.test(u) ? 'image/svg+xml' : 'image/jpeg';
        jobs.push(e.async('base64').then(function (b) { el.setAttribute(attr, 'data:' + mime + ';base64,' + b); }));
      });
      return Promise.all(jobs).then(function () { return doc.head.innerHTML + doc.body.innerHTML; });
    }).catch(function () { return html; });
  }
  /** HTML from the file is shown in a sandboxed frame: it looks as authored but cannot run scripts or reach the app. */
  function htmlFrame(html, maxW, onSize) {
    var fr = document.createElement('iframe');
    fr.className = 'gb-frame';
    fr.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    fr.style.width = maxW + 'px'; fr.style.height = '24px';
    var fit = function () {
      try {
        var d = fr.contentDocument, r = d && d.getElementById('gc-root'); if (!r) return;
        var w = Math.ceil(Math.max(r.getBoundingClientRect().width, r.scrollWidth)) + 2;
        fr.style.width = Math.max(140, Math.min(maxW, w)) + 'px';
        fr.style.height = Math.ceil(Math.max(r.getBoundingClientRect().height + (w > maxW ? 14 : 0), d.documentElement.scrollHeight - 2)) + 'px'; // + room for a sideways scrollbar
        onSize();
      } catch (e) { /* not readable */ }
    };
    fr.onload = function () {
      fit();
      try { Array.prototype.forEach.call(fr.contentDocument.images, function (im) { if (!im.complete) im.addEventListener('load', fit); }); } catch (e) { /* ignore */ }
    };
    fr.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>html,body{margin:0;padding:0;background:#fff}' +
      'body{font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#202124;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch}' +
      '#gc-root{display:inline-block;max-width:100%;vertical-align:top}img{max-width:100%;height:auto}a{color:#1a73e8}</style></head>' +
      '<body><div id="gc-root">' + html + '</div></body></html>';
    return fr;
  }
  function anchorOf(f) {
    var g = f.geometry; if (!g) return null;
    if (g.type === 'GeometryCollection') g = g.geometries[0];
    if (!g) return null;
    if (g.type === 'Point') return L.latLng(g.coordinates[1], g.coordinates[0]);
    if (g.type === 'MultiPoint') return L.latLng(g.coordinates[0][1], g.coordinates[0][0]);
    var line = g.type === 'LineString' ? g.coordinates : g.type === 'MultiLineString' ? g.coordinates[0] : null;
    if (line && line.length) { // halfway along the line
      var half = Geo.pathLength(line) / 2, run = 0;
      for (var i = 1; i < line.length; i++) { var d = Geo.pathLength([line[i - 1], line[i]]); if (run + d >= half) { var t = d ? (half - run) / d : 0; return L.latLng(line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t, line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t); } run += d; }
      return L.latLng(line[0][1], line[0][0]);
    }
    var bb = Importers.bounds({ type: 'FeatureCollection', features: [f] });
    return isFinite(bb[0]) ? L.latLng((bb[1] + bb[3]) / 2, (bb[0] + bb[2]) / 2) : null;
  }
  function footer(l, f, ll) {
    var g = f.geometry, bits = [];
    measure(g && g.type === 'GeometryCollection' ? g.geometries[0] : g).forEach(function (r) { if (r[0] !== 'Position') bits.push(r[0] === 'MGA2020' ? r[1] : r[0] + ' ' + r[1]); });
    if (g && g.type === 'Point') bits.unshift(g.coordinates[1].toFixed(6) + ', ' + g.coordinates[0].toFixed(6));
    else if (ll && g) bits.push('Tapped at ' + Geo.fmt([ll.lng, ll.lat], 'mga'));
    return '<div class="gb-foot">' + esc(bits.join(' · ')) + (bits.length ? '<br>' : '') + esc(l.name) + '<br><button data-a="zoom">Zoom to</button><button data-a="hide">Hide</button></div>';
  }
  /** Opens the balloon of a vector feature, as Google Earth does when a placemark is clicked. */
  function openBalloon(l, f, ll, tapped) {
    GC.closeInspector();
    var idx = l.geojson.features.indexOf(f), p = f.properties || {}, name = idx >= 0 ? GC.featName(l, idx) : (p.name || 'Feature');
    var tplI = l.featBalloon && idx >= 0 ? l.featBalloon[idx] : null, tpl = tplI != null && l.balloons ? l.balloons[tplI] : null;
    var desc = descText(p.description), rows = dataRows(l, p), sz = map.getSize(), side = document.body.classList.contains('no-sidebar') ? 0 : 350;
    var maxW = Math.max(220, Math.min(560, sz.x - side - 110)); // room beside the sidebar
    var root = document.createElement('div'), html = tpl ? expandBalloon(tpl, l, p, name) : (desc && looksHtml(desc) ? desc : null);
    var pop = L.popup({ className: 'gc-balloon', maxWidth: maxW + 40, minWidth: 180, maxHeight: Math.round(sz.y * 0.62), autoPanPaddingTopLeft: L.point(side + 20, 140), autoPanPaddingBottomRight: L.point(30, 70) });
    var refit = function () { if (!map.hasLayer(pop)) return; pop._updateLayout(); pop._updatePosition(); pop._adjustPan(); };
    var table = '<table class="gb-data">' + rows.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + linkify(r[1]) + '</td></tr>'; }).join('') + '</table>';
    // No separate heading when the description already opens with the name (it would show twice).
    var opensWithName = html && new DOMParser().parseFromString(html, 'text/html').body.textContent.trim().indexOf(name) === 0;
    root.innerHTML = (tpl || opensWithName ? '' : '<div class="gb-title">' + esc(name) + '</div>') + '<div class="gb-html"></div>' +
      (!tpl && rows.length ? (html ? '<details class="gb-more"><summary>Data (' + rows.length + ')</summary>' + table + '</details>' : table) : '') +
      (!html && desc ? '<div class="gb-text' + (rows.length ? ' note' : '') + '">' + linkify(desc) + '</div>' : '') +
      '<div class="gb-photos"></div>' + footer(l, f, tapped ? ll : null);
    if (html) resolveKmz(l, html).then(function (h) { root.querySelector('.gb-html').appendChild(htmlFrame(h, maxW, refit)); });
    var det = root.querySelector('details'); if (det) det.addEventListener('toggle', refit);
    var paintPhotos = function () {
      var refs = (l.featPhotos && l.featPhotos[idx]) || [], box = root.querySelector('.gb-photos');
      var save = function (left) { l.featPhotos = l.featPhotos || {}; if (left.length) l.featPhotos[idx] = left; else delete l.featPhotos[idx]; GC.markDirty(l.id); GC.refreshLayers(); paintPhotos(); };
      GC.photos.strip(box, refs, idx < 0 ? {} : { onAdd: function () { GC.photos.pick().then(function (more) { if (more.length) save(refs.concat(more)); }); }, onChange: save });
      Array.prototype.forEach.call(box.querySelectorAll('img'), function (im) { im.addEventListener('load', refit); });
      setTimeout(refit, 250);
    };
    paintPhotos();
    root.querySelector('[data-a=zoom]').onclick = function () { var b = GC.folderBounds(l, idx); if (b) { if (b.getNorthEast().equals(b.getSouthWest())) map.setView(b.getCenter(), Math.max(map.getZoom(), 18)); else map.fitBounds(b, { padding: [80, 80], maxZoom: 19 }); } };
    root.querySelector('[data-a=hide]').onclick = function () { map.closePopup(pop); l.hiddenFeats = l.hiddenFeats || {}; l.hiddenFeats[idx] = 1; GC.renderLayer(l); GC.markDirty(l.id); GC.refreshLayers(); };
    highlight(f);
    GC.selFeat = { lid: l.id, idx: idx };
    Array.prototype.forEach.call(document.querySelectorAll('#layer-list .tn.sel'), function (x) { x.classList.remove('sel'); });
    var row = document.querySelector('#layer-list .layer[data-id="' + l.id + '"] [data-n="p' + idx + '"]'); if (row) row.classList.add('sel');
    pop.on('remove', function () { if (balloon === pop) { balloon = null; GC.selFeat = null; if (hl) { map.removeLayer(hl); hl = null; } if (row) row.classList.remove('sel'); } });
    balloon = pop;
    pop.setLatLng(ll || anchorOf(f) || map.getCenter()).setContent(root).openOn(map);
  }
  GC.inspectFeature = function (l, f, ll) { openBalloon(l, f, ll, true); };
  /** From the Places tree: fly to a placemark and open its balloon. */
  GC.showFeature = function (l, idx) {
    var f = l.geojson.features[idx]; if (!f) return;
    if (l.hiddenFeats && l.hiddenFeats[idx]) { delete l.hiddenFeats[idx]; GC.renderLayer(l); GC.markDirty(l.id); GC.refreshLayers(); }
    var b = GC.folderBounds(l, idx), a = anchorOf(f);
    if (b) { if (b.getNorthEast().equals(b.getSouthWest())) map.setView(b.getCenter(), Math.max(map.getZoom(), 17), { animate: false }); else if (!map.getBounds().contains(b)) map.fitBounds(b, { padding: [80, 80], maxZoom: 18, animate: false }); }
    openBalloon(l, f, a);
  };
  GC.inspectItem = function (l, el) {
    var rows = [['Layer', l.name], ['Created', GC.fmtTime(el.created || Date.now())]], actions = [], title, photos = null;
    if (el.type === 'stroke') {
      title = Ink.INKS[el.ink].label + ' stroke';
      rows.push(['Length', GC.fmtDist(Geo.pathLength(el.pts))], ['Ink width', (el.width * Geo.metersPerPixel(el.z0, el.pts[0][1])).toFixed(2) + ' m on the ground'], ['Points', String(el.pts.length)]);
      rows = rows.concat(posRows(el.pts[0][0], el.pts[0][1]).map(function (r) { r[0] = 'Starts at' + (r[0] === 'MGA2020' ? ' (MGA)' : ''); return r; }));
    } else if (el.type === 'shape') {
      title = el.kind.charAt(0).toUpperCase() + el.kind.slice(1);
      var o = Ink.shapeOutline(el).map(function (m) { return Geo.unmerc(m[0], m[1]); });
      if (Ink.isClosed(el)) { var ring = o.concat([o[0]]); rows.push(['Area', GC.fmtArea(Math.abs(Geo.ringArea(ring)))], ['Perimeter', GC.fmtDist(Geo.pathLength(ring))]); }
      else rows.push(['Length', GC.fmtDist(Geo.pathLength(o))]);
      if (el.kind === 'line' || el.kind === 'arrow') { var a = o[0], b = o[o.length - 1], y = Math.sin((b[0] - a[0]) * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180), x = Math.cos(a[1] * Math.PI / 180) * Math.sin(b[1] * Math.PI / 180) - Math.sin(a[1] * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180) * Math.cos((b[0] - a[0]) * Math.PI / 180); rows.push(['Bearing', ((Math.atan2(y, x) * 180 / Math.PI + 360) % 360).toFixed(1) + '° true']); }
    } else if (el.type === 'text') {
      title = '“' + el.text + '”'; rows = rows.concat(posRows(el.at[0], el.at[1]));
      if (!l.locked) actions.push({ label: 'Edit text', fn: function () { GC.closeInspector(); GC.editText(l, el); } });
    } else {
      title = el.title || (GC.SYMBOLS[el.symbol] || GC.SYMBOLS.pin).label;
      if (el.note) rows.push(['Note', el.note]);
      rows = rows.concat(posRows(el.at[0], el.at[1]));
      if (!l.locked) actions.push({ label: 'Edit marker', fn: function () { GC.closeInspector(); GC.editMarker(l, el); } });
      photos = { refs: el.photos || [], onChange: l.locked ? null : function (refs) { // markers are immutable: replace it (undoable)
        var cur = l.items.filter(function (x) { return x.id === el.id; })[0]; if (!cur) return;
        GC.editLayer(l.id, function (items) { return items.map(function (x) { if (x !== cur) return x; var c = JSON.parse(JSON.stringify(Ink.stripCache(x))); if (refs.length) c.photos = refs; else delete c.photos; el = c; return c; }); });
      } };
    }
    if (!l.locked) actions.push({ label: 'Delete', danger: true, fn: function () { GC.closeInspector(); GC.editLayer(l.id, function (items) { return items.filter(function (x) { return x.id !== el.id; }); }); GC.toast('Deleted. Undo is available.'); } });
    if (hl) { map.removeLayer(hl); hl = null; }
    openInspector(title, el.type === 'marker' ? 'Marker' : 'Drawn ' + el.type, rows, actions, photos);
  };
  GC.inspectTrack = function (l, t) {
    var dur = t.points.length > 1 ? (t.points[t.points.length - 1][2] - t.points[0][2]) / 1000 : 0;
    highlight({ type: 'LineString', coordinates: t.points.map(function (p) { return [p[0], p[1]]; }) });
    openInspector(t.name, l.name, [['Distance', GC.fmtDist(t.distance || 0)], ['Points', String(t.points.length)], ['Started', GC.fmtTime(t.points[0] ? t.points[0][2] : Date.now())], ['Duration', Math.floor(dur / 3600) + ' h ' + Math.round(dur / 60) % 60 + ' min']]);
  };
  GC.inspectWaypoint = function (l, w) {
    var rows = [['Time', GC.fmtTime(w.time)]].concat(posRows(w.lon, w.lat));
    if (w.note) rows.unshift(['Note', w.note]);
    if (w.acc != null) rows.push(['GPS accuracy', '±' + Math.round(w.acc) + ' m']);
    if (w.ele != null) rows.push(['Altitude', Math.round(w.ele) + ' m']);
    openInspector(w.name || 'Waypoint', l.name, rows, l.locked ? [] : [{ label: 'Delete waypoint', danger: true, fn: function () { l.waypoints = l.waypoints.filter(function (x) { return x !== w; }); GC.renderLayer(l); GC.markDirty(l.id); GC.refreshLayers(true); GC.closeInspector(); } }],
      { refs: w.photos || [], onChange: l.locked ? null : function (refs) { if (refs.length) w.photos = refs; else delete w.photos; GC.renderLayer(l); GC.markDirty(l.id); } });
  };

  // ======================= GPS =======================
  var gps = { watch: null, fix: null, marker: null, circle: null, follow: false, rec: null, heading: null, wake: null, started: 0 };
  function gpsLayer(kind, name) {
    var l = GC.project.layers.filter(function (x) { return x.kind === kind; }).pop();
    if (!l) { l = { id: Ink.uid(), name: name, kind: kind, visible: true, opacity: 1, locked: false, color: kind === 'track' ? '#ff3d00' : '#e8590c', created: Date.now() }; l[kind === 'track' ? 'tracks' : 'waypoints'] = []; GC.insertLayer(l, true); }
    return l;
  }
  function quality(acc) { return acc <= 10 ? ['good', 'Good'] : (acc <= 30 ? ['fair', 'Fair'] : ['poor', 'Poor']); }
  function startGPS() {
    if (gps.watch != null) return;
    if (!navigator.geolocation) { GC.toast('This browser has no location services.', 'err'); return; }
    if (!window.isSecureContext) { GC.toast('Location needs a secure (https://) address. Open GeoCanvas from its https link.', 'err', 8000); return; }
    gps.started = Date.now();
    $('gps-badge').textContent = 'Searching…'; $('gps-badge').className = 'badge';
    gps.watch = navigator.geolocation.watchPosition(onFix, onGpsError, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    setTimeout(function () { if (!gps.fix && gps.watch != null) showWarn('No position yet. Go outside with a clear view of the sky. Wi-Fi-only iPads have no GPS chip and can only estimate position from nearby Wi-Fi.'); }, 15000);
  }
  function onGpsError(err) {
    var msg = err.code === 1 ? 'Location permission was denied. On the iPad: Settings › Privacy & Security › Location Services › Safari Websites › “While Using”, then reload.' :
      (err.code === 3 ? 'Still waiting for a GPS fix…' : 'Position unavailable. Check that Location Services are on.');
    showWarn(msg);
    if (err.code === 1) { navigator.geolocation.clearWatch(gps.watch); gps.watch = null; $('gps-badge').textContent = 'Denied'; $('gps-badge').className = 'badge poor'; }
  }
  function showWarn(m) { $('gps-warn').hidden = !m; $('gps-warn').textContent = m || ''; }
  function onFix(pos) {
    var c = pos.coords, ll = [c.latitude, c.longitude];
    gps.fix = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, alt: c.altitude, altAcc: c.altitudeAccuracy, speed: c.speed, heading: c.heading, t: pos.timestamp || Date.now() };
    var q = quality(c.accuracy);
    $('gps-badge').textContent = q[1] + ' ±' + Math.round(c.accuracy) + ' m'; $('gps-badge').className = 'badge ' + q[0];
    showWarn(c.accuracy > 100 ? 'Accuracy is ±' + Math.round(c.accuracy) + ' m — this looks like a Wi-Fi/network estimate, not satellite GPS. Wi-Fi-only iPads have no GPS; a cellular iPad or an external GPS receiver is needed for accurate positions.' :
      (c.accuracy > 30 ? 'Accuracy is only ±' + Math.round(c.accuracy) + ' m. Wait in the open for a better fix before recording.' : ''));
    if (!gps.marker) {
      gps.circle = L.circle(ll, { radius: c.accuracy, color: '#1e63d6', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
      gps.marker = L.marker(ll, { icon: L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9], html: '<div class="gps-dot"></div>' }), interactive: false, zIndexOffset: 1000 }).addTo(map);
      if (!gps.follow) map.setView(ll, Math.max(map.getZoom(), 17));
    } else { gps.marker.setLatLng(ll); gps.circle.setLatLng(ll); gps.circle.setRadius(c.accuracy); }
    if (gps.follow) map.panTo(ll, { animate: true });
    if (gps.rec) recordPoint(gps.fix);
    renderGpsData();
  }
  function renderGpsData() {
    var f = gps.fix; if (!f) { $('gps-data').innerHTML = ''; return; }
    var age = Math.round((Date.now() - f.t) / 1000);
    var rows = [['Latitude', f.lat.toFixed(7)], ['Longitude', f.lon.toFixed(7)], ['MGA2020', Geo.fmt([f.lon, f.lat], 'mga').replace(/^MGA\d+\s+/, '')], ['Zone', 'MGA ' + Geo.utmZone(f.lon)],
      ['Accuracy', '±' + f.acc.toFixed(1) + ' m'], ['Altitude', f.alt != null ? Math.round(f.alt) + ' m' + (f.altAcc ? ' ±' + Math.round(f.altAcc) : '') : '—'],
      ['Speed', f.speed != null && f.speed >= 0 ? (f.speed * 3.6).toFixed(1) + ' km/h' : '—'], ['Heading', gps.heading != null ? Math.round(gps.heading) + '° (compass)' : (f.heading != null && !isNaN(f.heading) ? Math.round(f.heading) + '° (travel)' : '—')], ['Fix age', age + ' s']];
    $('gps-data').innerHTML = rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('');
  }
  setInterval(function () { if (!$('gps-panel').hidden) renderGpsData(); if (gps.fix && Date.now() - gps.fix.t > 30000 && gps.watch != null) showWarn('No new position for ' + Math.round((Date.now() - gps.fix.t) / 1000) + ' s. The fix may be stale.'); }, 2000);

  $('btn-gps').onclick = function () {
    var p = $('gps-panel');
    if (!p.hidden) { p.hidden = true; return; }
    $('inspector').hidden = true; if (GC.measure && GC.measure.isOn()) GC.measure.close(); p.hidden = false; startGPS(); renderGpsData();
    if (gps.fix) map.setView([gps.fix.lat, gps.fix.lon], Math.max(map.getZoom(), 16));
  };
  $('gps-follow').onclick = function () {
    gps.follow = !gps.follow; $('gps-follow').classList.toggle('primary', gps.follow); $('gps-follow').textContent = gps.follow ? 'Following' : 'Follow me';
    if (gps.follow && gps.fix) map.panTo([gps.fix.lat, gps.fix.lon]);
  };
  map.on('dragstart', function () { if (gps.follow) { gps.follow = false; $('gps-follow').classList.remove('primary'); $('gps-follow').textContent = 'Follow me'; } });
  $('gps-compass').onclick = function () {
    var on = function () {
      window.addEventListener('deviceorientation', function (e) {
        var h = e.webkitCompassHeading != null ? e.webkitCompassHeading : (e.absolute && e.alpha != null ? 360 - e.alpha : null);
        if (h == null) return;
        gps.heading = h;
        if (gps.marker) { var el = gps.marker.getElement(); if (el) el.firstChild.style.boxShadow = '0 0 0 2px rgba(30,99,214,.35), ' + Math.round(Math.sin(h * Math.PI / 180) * 7) + 'px ' + Math.round(-Math.cos(h * Math.PI / 180) * 7) + 'px 0 -2px #1e63d6'; }
      }, true);
      $('gps-compass').classList.add('primary'); $('gps-compass').textContent = 'Compass on';
    };
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') DeviceOrientationEvent.requestPermission().then(function (s) { if (s === 'granted') on(); else GC.toast('Compass permission was not granted.', 'warn'); }, function () { GC.toast('Compass is not available.', 'warn'); });
    else if (window.DeviceOrientationEvent) on(); else GC.toast('This device has no compass.', 'warn');
  };
  function recordPoint(f) {
    var t = gps.rec.track, pts = t.points, last = pts[pts.length - 1];
    if (f.acc > 50) return; // filter poor fixes
    if (last) { var d = Geo.haversine([last[0], last[1]], [f.lon, f.lat]); if (d < Math.max(2, f.acc / 2)) return; t.distance += d; }
    pts.push([f.lon, f.lat, f.t, f.alt != null ? Math.round(f.alt * 10) / 10 : null, Math.round(f.acc * 10) / 10]);
    var v = GC.views[gps.rec.layer.id], line = v && v.trackLines[t.started];
    if (line && pts.length > 1) line.addLatLng([f.lat, f.lon]); else GC.renderLayer(gps.rec.layer);
    $('gps-track-info').textContent = 'Recording “' + t.name + '”: ' + GC.fmtDist(t.distance) + ', ' + pts.length + ' points.';
    GC.markDirty(gps.rec.layer.id); GC.refreshLayers(true);
  }
  $('gps-rec').onclick = function () {
    if (gps.rec) {
      var t = gps.rec.track; gps.rec = null;
      $('gps-rec').classList.remove('on'); $('gps-rec').textContent = 'Start recording';
      $('gps-track-info').textContent = 'Saved “' + t.name + '” (' + GC.fmtDist(t.distance) + '). Export it as GPX or KML from Export.';
      if (gps.wake) { gps.wake.release().catch(function () {}); gps.wake = null; }
      GC.saveNow(); return;
    }
    startGPS();
    var l = gpsLayer('track', 'GPS tracks');
    var now = new Date(), track = { name: 'Track ' + now.toLocaleDateString('en-AU') + ' ' + now.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }), points: [], distance: 0, started: Date.now() };
    l.tracks.push(track); gps.rec = { layer: l, track: track };
    GC.renderLayer(l); GC.applyLayerState(); GC.refreshLayers();
    $('gps-rec').classList.add('on'); $('gps-rec').textContent = 'Stop recording';
    $('gps-track-info').textContent = 'Recording… keep GeoCanvas open and the screen on (Safari pauses location when the screen locks or you switch apps).';
    if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request('screen').then(function (w) { gps.wake = w; }, function () {});
    if (gps.fix) recordPoint(gps.fix);
  };
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && gps.rec && navigator.wakeLock && !gps.wake) navigator.wakeLock.request('screen').then(function (w) { gps.wake = w; }, function () {}); });
  /** Position for a new waypoint: a fresh GPS fix, else the photo's own location, else the map centre. */
  function dropWaypoint(photos) {
    var useFix = gps.fix && Date.now() - gps.fix.t < 60000, c = map.getCenter(), geo = !useFix && photos && photos.filter(function (r) { return r.lat != null; })[0];
    var lat = useFix ? gps.fix.lat : geo ? geo.lat : c.lat, lon = useFix ? gps.fix.lon : geo ? geo.lon : c.lng;
    var l = gpsLayer('waypoints', 'Waypoints');
    var w = { lat: lat, lon: lon, ele: useFix && gps.fix.alt != null ? gps.fix.alt : null, acc: useFix ? gps.fix.acc : null, time: Date.now(), name: $('wp-name').value.trim() || (photos ? 'Photo ' : 'WP') + ((l.waypoints.length + 1 < 10 ? '0' : '') + (l.waypoints.length + 1)), note: $('wp-note').value.trim() };
    if (photos && photos.length) w.photos = photos;
    l.waypoints.push(w); GC.renderLayer(l); GC.applyLayerState(); GC.markDirty(l.id, true); GC.refreshLayers();
    $('wp-name').value = ''; $('wp-note').value = '';
    GC.toast(useFix ? 'Waypoint “' + w.name + '” saved at your GPS position (±' + Math.round(w.acc) + ' m).' : geo ? 'Waypoint “' + w.name + '” placed where the photo was taken.' : 'No current GPS fix — waypoint “' + w.name + '” placed at the map centre (crosshair).', useFix || geo ? null : 'warn');
  }
  $('gps-wp').onclick = function () { dropWaypoint(null); };
  $('gps-photo').onclick = function () { GC.photos.pick().then(function (refs) { if (refs.length) dropWaypoint(refs); }); };

  // ======================= search =======================
  var searchMarker = null;
  $('btn-search').onclick = function () {
    GC.modal('<h2>Search</h2><p class="sub">A place or address, a lot/plan (“3RP123456” or “Lot 3 on RP123456”), or coordinates: “-27.56, 151.95”, “27°33′S 151°57′E” or MGA “56 396000 6951000”.</p>' +
      '<div style="display:flex;gap:8px"><input type="text" id="s-q" placeholder="e.g. Picnic Point, Toowoomba" style="flex:1"><button class="btn primary" id="s-go">Search</button></div><div class="list" id="s-res"></div>',
      function (el, close) {
        var q = el.querySelector('#s-q'), res = el.querySelector('#s-res');
        var go = function () {
          var text = q.value.trim(); if (!text) return;
          var ll = Geo.parseCoordinate(text);
          if (ll) { close(); flyTo(ll[1], ll[0], text); return; }
          var lot = GC.cadastre && GC.cadastre.find(text); // lot/plan, e.g. 3RP123456 or "Lot 3 on RP123456"
          if (lot) { res.innerHTML = '<p class="hint">Looking up the lot…</p>'; lot.then(function () { close(); }, function (e) { res.innerHTML = '<p class="fail">' + esc(e.message) + '</p>'; }); return; }
          res.innerHTML = '<p class="hint">Searching…</p>';
          var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&countrycodes=au&viewbox=151.3,-27.0,152.6,-28.1&q=' + encodeURIComponent(text);
          fetch(url, { headers: { 'Accept': 'application/json' } }).then(function (r) { return r.json(); }).then(function (list) {
            if (!list.length) { res.innerHTML = '<p class="hint">No results. Try adding “Toowoomba” or “QLD”.</p>'; return; }
            res.innerHTML = list.map(function (x, i) { return '<button class="item" data-i="' + i + '"><div class="grow"><b>' + esc(x.name || x.display_name.split(',')[0]) + '</b><small>' + esc(x.display_name) + '</small></div></button>'; }).join('');
            Array.prototype.forEach.call(res.querySelectorAll('[data-i]'), function (b) { b.onclick = function () { var x = list[+b.getAttribute('data-i')]; close(); flyTo(+x.lat, +x.lon, x.name || x.display_name, x.boundingbox); }; });
          }).catch(function () { res.innerHTML = '<p class="fail">Search needs an internet connection. Coordinates work offline.</p>'; });
        };
        el.querySelector('#s-go').onclick = go; q.onkeydown = function (e) { if (e.key === 'Enter') go(); };
        setTimeout(function () { q.focus(); }, 50);
      });
  };
  function flyTo(lat, lon, label, bbox) {
    if (searchMarker) map.removeLayer(searchMarker);
    searchMarker = L.circleMarker([lat, lon], { radius: 9, color: '#fff', weight: 3, fillColor: '#e53935', fillOpacity: 1 }).addTo(map).bindTooltip(esc(label), { permanent: true, direction: 'top', offset: [0, -10], className: 'gc-label' });
    searchMarker.on('click', function () { map.removeLayer(searchMarker); searchMarker = null; });
    if (bbox) map.fitBounds([[+bbox[0], +bbox[2]], [+bbox[1], +bbox[3]]], { maxZoom: 18 }); else map.setView([lat, lon], Math.max(map.getZoom(), 17));
  }

  // ======================= export =======================
  function slug(s) { return String(s).replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'GeoCanvas'; }
  var FORMATS = [
    { id: 'kml', label: 'KML', note: 'Google Earth, QGIS, ArcGIS' },
    { id: 'kmz', label: 'KMZ', note: 'Zipped KML' },
    { id: 'geojson', label: 'GeoJSON', note: 'QGIS, web maps' },
    { id: 'gpx', label: 'GPX', note: 'Tracks, waypoints and markers for GPS units' },
    { id: 'tif', label: 'GeoTIFF overlay', note: 'Transparent image of your drawings (EPSG:3857)' },
    { id: 'png', label: 'PNG + world file', note: '.png, .pgw and .prj in a ZIP' },
    { id: 'pdf', label: 'PDF / print map', note: 'Uses the iPad print sheet (Save as PDF)' },
    { id: 'backup', label: 'Project backup', note: 'Everything, to restore later or on another device' }
  ];
  GC.openExport = function (onlyIds) {
    var p = GC.project, sel = {};
    p.layers.forEach(function (l) { sel[l.id] = onlyIds ? onlyIds.indexOf(l.id) >= 0 : l.visible; });
    var fmt = 'kml';
    var html = '<h2>Export</h2><p class="sub">Exports are georeferenced and open in the right place in QGIS and Google Earth. Basemap imagery is never included.</p>' +
      '<div id="ex-fmts" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px">' + FORMATS.map(function (f) { return '<button class="item" data-f="' + f.id + '" style="flex-direction:column;align-items:flex-start;gap:2px"><b>' + f.label + '</b><small>' + f.note + '</small></button>'; }).join('') + '</div>' +
      '<div id="ex-opts"></div><div class="pop-title small">Layers</div><div id="ex-layers">' +
      p.layers.slice().reverse().map(function (l) { return '<label class="opt"><input type="checkbox" data-l="' + l.id + '"' + (sel[l.id] ? ' checked' : '') + '> ' + esc(l.name) + ' <small class="hint" style="margin:0">' + esc(GC.kindLabel(l) + ' · ' + GC.layerCount(l)) + '</small></label>'; }).join('') +
      '</div><div class="actions"><span id="ex-msg" class="hint" style="flex:1;margin:0"></span><button class="btn" data-a="close">Close</button><button class="btn primary" data-a="make">Create file</button></div>';
    GC.modal(html, function (el, close) {
      var q = function (s) { return el.querySelector(s); }, made = null;
      var paintFmt = function () {
        Array.prototype.forEach.call(el.querySelectorAll('[data-f]'), function (b) { b.classList.toggle('current', b.getAttribute('data-f') === fmt); });
        var o = '';
        if (fmt === 'kml' || fmt === 'kmz' || fmt === 'geojson') o = '<label class="opt"><input type="checkbox" id="ex-outline"> Export pen strokes as exact ink outlines (polygons) instead of centre-lines</label>';
        if (fmt === 'tif' || fmt === 'png') o = '<label class="field" style="margin:8px 0">Ground resolution<select id="ex-res"><option value="0.1">0.1 m per pixel</option><option value="0.25" selected>0.25 m per pixel</option><option value="0.5">0.5 m per pixel</option><option value="1">1 m per pixel</option><option value="2">2 m per pixel</option><option value="5">5 m per pixel</option></select></label><p class="hint" style="margin:0">Only annotation layers are rasterised. Very large areas are capped at 6000 px.</p>';
        if (fmt === 'backup') o = '<p class="hint">The backup contains the whole project including the original imported files. Keep it in Files › iCloud Drive or On My iPad. Restore it from the Project tab.</p>';
        if (fmt === 'pdf') o = '<p class="hint">Closes this window and opens the print sheet for the current map view. In the print sheet, pinch out on the preview (or tap Share › Save to Files) to save a PDF.</p>';
        q('#ex-opts').innerHTML = o; q('#ex-layers').style.display = (fmt === 'backup' || fmt === 'pdf') ? 'none' : '';
        resetMade();
      };
      var resetMade = function () { made = null; q('[data-a=make]').textContent = fmt === 'pdf' ? 'Print…' : 'Create file'; q('#ex-msg').textContent = ''; };
      q('#ex-fmts').onclick = function (e) { var b = e.target.closest('[data-f]'); if (b) { fmt = b.getAttribute('data-f'); paintFmt(); } };
      q('#ex-layers').onchange = resetMade;
      paintFmt();
      q('[data-a=close]').onclick = close;
      q('[data-a=make]').onclick = function () {
        if (made) { GC.saveBlob(made.blob, made.name); return; }
        if (fmt === 'pdf') { close(); printMap(); return; }
        var ids = Array.prototype.filter.call(el.querySelectorAll('[data-l]'), function (c) { return c.checked; }).map(function (c) { return c.getAttribute('data-l'); });
        if (fmt !== 'backup' && !ids.length) { q('#ex-msg').textContent = 'Choose at least one layer.'; return; }
        var outlines = q('#ex-outline') && q('#ex-outline').checked;
        q('#ex-msg').textContent = 'Creating…';
        build(fmt, ids, outlines, q('#ex-res') ? +q('#ex-res').value : 0.25).then(function (r) {
          made = r;
          q('#ex-msg').textContent = r.name + ' (' + (r.blob.size > 1048576 ? (r.blob.size / 1048576).toFixed(1) + ' MB' : Math.ceil(r.blob.size / 1024) + ' KB') + ')' + (r.note ? ' — ' + r.note : '');
          q('[data-a=make]').textContent = 'Save / Share';
        }, function (e) { q('#ex-msg').textContent = ''; GC.toast(e.message, 'err'); });
      };
    });
  };
  $('btn-export').onclick = function () { GC.openExport(null); };
  GC.buildExport = function (fmt, ids, outlines, res) { return build(fmt, ids, outlines, res); };

  function build(fmt, ids, outlines, res) {
    var p = GC.project, base = slug(p.name);
    if (fmt === 'kml') return Promise.resolve({ blob: new Blob([Exporters.kml(p, ids, outlines)], { type: 'application/vnd.google-earth.kml+xml' }), name: base + '.kml' });
    if (fmt === 'kmz') {
      var z = new JSZip(), photoIds = Object.keys(GC.photos.refsIn(p.layers.filter(function (l) { return ids.indexOf(l.id) >= 0; })));
      z.file('doc.kml', Exporters.kml(p, ids, outlines, { kmz: true }));
      // Images and icons inside imported KMZs (description photos, placemark icons) travel with them.
      var carry = p.layers.filter(function (l) { return ids.indexOf(l.id) >= 0 && l.kind === 'vector' && l.hasSources && /kmz/i.test(l.format || ''); }).map(function (l) {
        return Store.getFiles(p.id, l.id).then(function (fs) {
          var k = fs.filter(function (f) { return /\.kmz$/i.test(f.name); })[0]; if (!k) return;
          return JSZip.loadAsync(k.data).then(function (src) {
            return Promise.all(Object.keys(src.files).filter(function (n) { return !src.files[n].dir && !/\.kml$/i.test(n) && !z.file(n); }).map(function (n) { return src.files[n].async('uint8array').then(function (d) { z.file(n, d); }); }));
          });
        }).catch(function () { /* original not available: skip */ });
      });
      p.layers.forEach(function (l) { if (ids.indexOf(l.id) >= 0 && l.kind === 'raster' && l.dataURL) z.file(Exporters.overlayFile(l), l.dataURL.split(',')[1], { base64: true }); });
      return Promise.all(carry.concat(photoIds.map(function (id) { return GC.photos.blob(id).then(function (b) { if (b) z.file('files/' + id + '.jpg', b); }); })))
        .then(function () { return z.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: 'application/vnd.google-earth.kmz' }); })
        .then(function (b) { return { blob: b, name: base + '.kmz', note: photoIds.length ? photoIds.length + ' photo' + (photoIds.length === 1 ? '' : 's') + ' included; they show in the Google Earth balloons.' : undefined }; });
    }
    if (fmt === 'geojson') return Promise.resolve({ blob: new Blob([Exporters.geojson(p, ids, outlines)], { type: 'application/geo+json' }), name: base + '.geojson' });
    if (fmt === 'gpx') {
      var hasGpx = p.layers.some(function (l) { return ids.indexOf(l.id) >= 0 && (l.kind === 'track' || l.kind === 'waypoints' || (l.kind === 'vector' && l.geojson.features.some(function (f) { return f.geometry && /Point|LineString/.test(f.geometry.type); })) || (l.kind === 'drawing' && l.items.some(function (x) { return x.type === 'marker' || x.type === 'text'; }))); });
      if (!hasGpx) return Promise.reject(new Error('GPX holds points, lines, tracks, waypoints and markers — the chosen layers have none.'));
      return Promise.resolve({ blob: new Blob([Exporters.gpx(p, ids)], { type: 'application/gpx+xml' }), name: base + '.gpx' });
    }
    if (fmt === 'tif' || fmt === 'png') {
      var items = []; p.layers.forEach(function (l) { if (l.kind === 'drawing' && ids.indexOf(l.id) >= 0) items = items.concat(l.items); });
      var ex = Exporters.rasterExtent(items, res);
      if (!ex) return Promise.reject(new Error('The chosen annotation layers have nothing drawn on them.'));
      var cv = Exporters.renderCanvas(p, ids, ex), note = ex.w + '×' + ex.h + ' px';
      if (fmt === 'tif') return Promise.resolve({ blob: Exporters.geotiff(cv, ex), name: base + '_annotations.tif', note: note });
      return new Promise(function (ok) { cv.toBlob(ok, 'image/png'); }).then(function (png) {
        var zz = new JSZip(); zz.file(base + '_annotations.png', png); zz.file(base + '_annotations.pgw', Exporters.worldFile(ex)); zz.file(base + '_annotations.prj', Exporters.WKT3857); zz.file(base + '_annotations.png.aux.xml', '<PAMDataset><SRS>' + esc(Exporters.WKT3857) + '</SRS></PAMDataset>\n');
        return zz.generateAsync({ type: 'blob' }).then(function (b) { return { blob: b, name: base + '_annotations_png.zip', note: note }; });
      });
    }
    if (fmt === 'backup') return makeBackup(p).then(function (b) { return { blob: b, name: base + '.geocanvas.json' }; });
    return Promise.reject(new Error('Unknown format'));
  }

  function printMap() {
    var t = document.getElementById('print-title');
    if (!t) { t = document.createElement('div'); t.id = 'print-title'; document.body.appendChild(t); }
    var c = map.getCenter(), b = map.getBounds();
    t.innerHTML = '<b>' + esc(GC.project.name) + '</b><br>Centre ' + c.lat.toFixed(5) + ', ' + c.lng.toFixed(5) + ' · ' + esc(Geo.fmt([c.lng, c.lat], 'mga')) +
      '<br>Extent ' + b.getSouth().toFixed(4) + '…' + b.getNorth().toFixed(4) + ', ' + b.getWest().toFixed(4) + '…' + b.getEast().toFixed(4) + ' · ' + GC.fmtTime(Date.now()) +
      '<br>Layers: ' + GC.project.layers.filter(function (l) { return l.visible; }).map(function (l) { return esc(l.name); }).join(', ') + '<div class="north">N ↑</div>';
    setTimeout(function () { window.print(); }, 250);
  }

  // ======================= backup / restore =======================
  function abToB64(buf) { var u8 = new Uint8Array(buf), s = '', CH = 0x8000; for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }
  function b64ToAb(b) { var s = atob(b), u8 = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8.buffer; }
  function makeBackup(p) {
    return GC.saveNow().then(function () {
      var ids = p.layers.filter(function (l) { return l.hasSources; }).map(function (l) { return l.id; });
      if (Object.keys(GC.photos.refsIn(p.layers)).length) ids.push('_photos');
      return Promise.all(ids.map(function (lid) {
        return Store.getFiles(p.id, lid).then(function (fs) { return fs.map(function (f) { return { layer: lid, name: f.name, b64: abToB64(f.data instanceof ArrayBuffer ? f.data : new ArrayBuffer(0)) }; }); });
      }));
    }).then(function (groups) {
      var proj = {}; for (var k in p) if (k !== 'layers' && k !== 'cloud' && k !== 'cloudOff') proj[k] = p[k];
      proj.layers = p.layers.map(GC.stripLayer);
      var files = []; groups.forEach(function (g) { files = files.concat(g); });
      return new Blob([JSON.stringify({ format: 'geocanvas-web-backup', version: 1, saved: new Date().toISOString(), project: proj, files: files })], { type: 'application/json' });
    });
  }
  $('btn-backup').onclick = function () {
    GC.busy('Preparing backup…');
    makeBackup(GC.project).then(function (b) {
      GC.busy(null);
      var name = slug(GC.project.name) + '_' + new Date().toISOString().slice(0, 10) + '.geocanvas.json';
      GC.modal('<h2>Backup ready</h2><p class="sub">' + esc(name) + ' (' + Math.ceil(b.size / 1024) + ' KB). Save it to Files (iCloud Drive or On My iPad), or AirDrop/email it.</p><div class="actions"><button class="btn" data-a="no">Close</button><button class="btn primary" data-a="ok">Save / Share</button></div>',
        function (el, close) { el.querySelector('[data-a=no]').onclick = close; el.querySelector('[data-a=ok]').onclick = function () { GC.saveBlob(b, name); }; });
    }, function (e) { GC.busy(null); GC.toast('Backup failed: ' + e.message, 'err'); });
  };
  $('btn-restore').onclick = function () { $('restore-input').value = ''; $('restore-input').click(); };
  $('restore-input').onchange = function () {
    var f = $('restore-input').files[0]; if (!f) return;
    GC.busy('Restoring…');
    var r = new FileReader();
    r.onload = function () {
      var data;
      try { data = JSON.parse(r.result); } catch (e) { GC.busy(null); GC.toast('That file is not a GeoCanvas backup.', 'err'); return; }
      if (!data || data.format !== 'geocanvas-web-backup' || !data.project) { GC.busy(null); GC.toast('That file is not a GeoCanvas backup.', 'err'); return; }
      Store.listProjects().then(function (list) {
        var p = data.project;
        delete p.cloud; delete p.cloudOff; // a restored project is shared again (merged with the cloud copy, if there is one)
        if (list.some(function (x) { return x.id === p.id; })) {
          p.id = Ink.uid(); p.name = p.name + ' (restored)';
        }
        return Promise.all(data.files.map(function (fl) { return Store.putFile(p.id, fl.layer, fl.name, b64ToAb(fl.b64)); })).then(function () { return Store.saveProject(p, null); }).then(function () { return Store.loadProject(p.id); });
      }).then(function (p) { GC.busy(null); GC.openProject(p); GC.toast('Restored “' + p.name + '”.'); }, function (e) { GC.busy(null); GC.toast('Restore failed: ' + e.message, 'err'); });
    };
    r.readAsText(f);
  };

  // ======================= projects =======================
  function openOther(id) {
    if (id === GC.project.id) return;
    GC.busy('Opening…');
    GC.saveNow().then(function () { return Store.loadProject(id); }).then(function (p) { GC.busy(null); GC.openProject(p); }, function (er) { GC.busy(null); GC.toast(er.message, 'err'); });
  }
  function afterDelete(id) {
    if (id !== GC.project.id) { GC.toast('Project deleted.'); return; }
    return Store.listProjects().then(function (rest) {
      if (rest.length) return Store.loadProject(rest[0].id).then(GC.openProject);
      var p = GC.newProject(); return Store.saveProject(p, null).then(function () { GC.openProject(p); });
    }).then(function () { GC.toast('Project deleted.'); });
  }
  function deleteProject(meta) {
    var id = meta.id, shared = GC.cloud && GC.cloud.linked(meta);
    if (meta.remoteOnly) { // in the team cloud, not on this iPad
      return GC.confirm('Delete “' + meta.name + '” for everyone?', 'It is removed from the team cloud. Devices that have a copy keep it, but it stops being shared. This cannot be undone.', 'Delete for everyone', true).then(function (ok) {
        if (ok) GC.cloud.deleteEverywhere(id).then(function () { GC.toast('Deleted for everyone.'); }, function (e) { GC.toast('Could not delete it: ' + e.message, 'err'); });
      });
    }
    if (!shared) {
      return GC.confirm('Delete “' + meta.name + '”?', 'The project and all its layers are removed from this iPad. This cannot be undone — make a backup first if unsure.', 'Delete project', true).then(function (ok) {
        if (ok) return Store.deleteProject(id).then(function () { return afterDelete(id); });
      });
    }
    GC.modal('<h2>Delete “' + esc(meta.name) + '”?</h2><p class="sub">This is a team project.</p>' +
      '<p><b>Only from this iPad</b>: it stays in the team cloud for everyone, and you can open it again from Projects.</p>' +
      '<p><b>For everyone</b>: it is removed from the team cloud. Other devices keep their copy but stop sharing it. This cannot be undone.</p>' +
      '<div class="actions"><button class="btn" data-a="no">Cancel</button><span class="spacer"></span><button class="btn" data-a="here">Only from this iPad</button><button class="btn danger" data-a="all">For everyone</button></div>',
      function (el, close) {
        el.querySelector('[data-a=no]').onclick = close;
        el.querySelector('[data-a=here]').onclick = function () { close(); Store.deleteProject(id).then(function () { return afterDelete(id); }); };
        el.querySelector('[data-a=all]').onclick = function () {
          close(); GC.busy('Deleting…');
          GC.cloud.deleteEverywhere(id).then(function () { return Store.deleteProject(id); }).then(function () { GC.busy(null); return afterDelete(id); },
            function (e) { GC.busy(null); GC.toast('Could not delete it from the cloud (' + e.message + '). Nothing was deleted.', 'err'); });
        };
      });
  }
  $('btn-projects').onclick = function () {
    var cloudOn = GC.cloud && GC.cloud.on();
    if (cloudOn) GC.busy('Checking the team cloud…');
    Promise.all([GC.saveNow().then(Store.listProjects), cloudOn ? GC.cloud.remoteList() : Promise.resolve(null)]).then(function (r) {
      GC.busy(null);
      var local = r[0], remote = r[1] || [], byId = {}, rows = [];
      remote.forEach(function (x) { byId[x.id] = x; });
      // One list: every team project, whether or not it is on this iPad yet.
      local.forEach(function (m) {
        var x = byId[m.id], state = !cloudOn ? '' : m.cloudOff ? 'removed' : GC.cloud.otherTeam(m) ? 'foreign' : (m.cloud ? 'team' : 'new');
        rows.push({ id: m.id, name: m.name, here: true, state: state, layers: (m.layerOrder || []).length, t: Math.max(m.modified || 0, x ? x.modified || 0 : 0), by: x && x.modified > (m.modified || 0) ? x.device : null, meta: m });
        delete byId[m.id];
      });
      Object.keys(byId).forEach(function (id) { var x = byId[id]; rows.push({ id: id, name: x.name, here: false, state: 'cloud', t: x.modified, by: x.device, size: x.size }); });
      rows.sort(function (a, b) { return (b.id === GC.project.id) - (a.id === GC.project.id) || b.t - a.t; });
      var tag = function (r) {
        if (r.state === 'cloud') return '<span class="cloud-tag">☁ tap to open</span>';
        if (r.state === 'team') return '<span class="cloud-tag">☁</span>';
        if (r.state === 'new') return ' · uploads when there is something in it';
        if (r.state === 'removed') return ' · <b>removed from the team cloud</b>';
        if (r.state === 'foreign') return ' · from a team this iPad has left (kept here only)';
        return '';
      };
      var html = '<h2>Projects</h2><p class="sub">' + (cloudOn ? (GC.cloud.team() ? '<b>' + esc(GC.cloud.team().name) + '</b>: every' : 'Every') + ' team project, on any device. Tap one to open it; changes save by themselves.' : 'On this iPad only. Tap ☁ in the top bar to join your team and keep projects in the cloud.') + (cloudOn && r[1] === null ? ' <b>Offline: only projects on this iPad are shown.</b>' : '') + '</p><div class="list">' +
        rows.map(function (x) {
          return '<div class="item' + (x.id === GC.project.id ? ' current' : '') + '" data-id="' + esc(x.id) + '"><div class="grow" data-a="open"><b>' + esc(x.name) + '</b><small>' +
            (x.here ? x.layers + ' layers · ' : '') + 'edited ' + GC.fmtTime(x.t) + (x.by ? ' by ' + esc(x.by) : '') + ' ' + tag(x) + '</small></div>' +
            (x.state === 'removed' ? '<button class="btn" data-a="reup">Upload again</button>' : '') +
            (x.here ? '<button class="ib" data-a="ren" title="Rename">' + GC.icon('text') + '</button><button class="ib" data-a="dup" title="Duplicate">' + GC.icon('copy') + '</button>' : '') +
            '<button class="ib danger" data-a="del" title="Delete">' + GC.icon('trash') + '</button></div>';
        }).join('') + '</div>' +
        '<div class="actions"><button class="btn" data-a="close">Close</button><button class="btn primary" data-a="new">New project</button></div>';
      GC.modal(html, function (el, close) {
        el.querySelector('[data-a=close]').onclick = close;
        el.querySelector('[data-a=new]').onclick = function () {
          close();
          GC.prompt('New project', 'Toowoomba ' + new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }), 'Project name', 'Create').then(function (name) {
            if (!name) return;
            var p = GC.newProject(name), c = map.getCenter(); p.view = { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
            Store.saveProject(p, null).then(function () { GC.openProject(p); });
          });
        };
        el.querySelector('.list').onclick = function (e) {
          var it = e.target.closest('[data-id]'), a = e.target.closest('[data-a]'); if (!it || !a) return;
          var id = it.getAttribute('data-id'), act = a.getAttribute('data-a'), row = rows.filter(function (x) { return x.id === id; })[0], meta = row.meta;
          if (act === 'open') {
            close();
            if (row.here) { openOther(id); return; }
            GC.busy('Opening “' + row.name + '”…');
            GC.saveNow().then(function () { return GC.cloud.download(id); }).then(function (p) { GC.busy(null); GC.openProject(p); }, function (er) { GC.busy(null); GC.toast('Could not open it: ' + er.message, 'err'); });
          } else if (act === 'reup') {
            close();
            Store.loadProject(id).then(function (p) { delete p.cloudOff; delete p.cloud; return Store.saveProject(p, {}).then(function () { if (GC.project.id === id) { delete GC.project.cloudOff; delete GC.project.cloud; } GC.cloud.touch(id); GC.cloud.run(true); GC.toast('“' + p.name + '” will be uploaded to the team cloud again.'); }); });
          } else if (act === 'ren') { close(); GC.prompt('Rename project', meta.name, 'Name', 'Rename').then(function (n) { if (!n) return; if (id === GC.project.id) { GC.project.name = n; $('project-name').textContent = n; $('proj-name').value = n; GC.markDirty(); } else Store.loadProject(id).then(function (p) { p.name = n; if (GC.cloud) GC.cloud.touch(id); return Store.saveProject(p, {}); }); }); }
          else if (act === 'dup') {
            close(); GC.busy('Duplicating…');
            GC.saveNow().then(function () { return Store.loadProject(id); }).then(function (p) {
              var oldId = p.id; p.id = Ink.uid(); p.name = p.name + ' copy'; p.created = Date.now(); delete p.cloud; delete p.cloudOff;
              return Promise.all(p.layers.filter(function (l) { return l.hasSources; }).map(function (l) { return l.id; }).concat(['_photos']).map(function (lid) { return Store.getFiles(oldId, lid).then(function (fs) { return Promise.all(fs.map(function (f) { return Store.putFile(p.id, lid, f.name, f.data); })); }); }))
                .then(function () { return Store.saveProject(p, null); }).then(function () { return p; });
            }).then(function (p) { GC.busy(null); GC.toast('Created “' + p.name + '”.'); }, function (er) { GC.busy(null); GC.toast(er.message, 'err'); });
          } else if (act === 'del') { close(); deleteProject(row.here ? meta : { id: id, name: row.name, cloud: {}, remoteOnly: true }); }
        };
      });
    });
  };

  // ======================= settings =======================
  $('btn-settings').onclick = function () {
    var s = GC.settings;
    var html = '<h2>Settings</h2>' +
      '<label class="opt"><input type="checkbox" id="st-finger"' + (s.fingerDraw ? ' checked' : '') + '> Draw with finger in Draw mode (two fingers pan and zoom). Off: only Apple Pencil draws and fingers move the map.</label>' +
      '<label class="opt"><input type="checkbox" id="st-cross"' + (s.crosshair ? ' checked' : '') + '> Show centre crosshair</label>' +
      '<label class="field" style="margin:8px 0">Coordinate format<select id="st-fmt"><option value="dd">Decimal degrees</option><option value="dms">Degrees minutes seconds</option><option value="mga">MGA2020 grid (easting/northing)</option></select></label>' +
      '<div class="pop-title small">Team & cloud</div><div id="st-cloud"></div>' +
      '<div class="pop-title small">Offline maps</div><p class="hint" style="margin:0 0 6px">Select areas of the map to save, so imagery and lot boundaries show with no signal.</p>' +
      '<div class="row-btns" style="margin:0"><button class="btn" id="st-offline">Offline maps…</button></div>' +
      '<div class="pop-title small">Storage</div><p class="hint" id="st-store" style="margin:0">Checking…</p>' +
      '<div class="pop-title small">Version</div><p class="hint" style="margin:0">GeoCanvas ' + GC.VERSION + '</p>' +
      '<div class="pop-title small">Tips</div><p class="hint" style="margin:0">Add GeoCanvas to your Home Screen (Share › Add to Home Screen) so it opens full screen and Safari keeps its data. Back up projects regularly — clearing Safari website data deletes them.</p>' +
      '<div class="actions"><button class="btn primary" data-a="ok">Done</button></div>';
    GC.modal(html, function (el, close) {
      var q = function (x) { return el.querySelector(x); };
      q('#st-fmt').value = s.coordFmt;
      q('#st-finger').onchange = function () { s.fingerDraw = q('#st-finger').checked; GC.saveSettings(); };
      q('#st-cross').onchange = function () { s.crosshair = q('#st-cross').checked; $('crosshair').hidden = !s.crosshair; GC.saveSettings(); };
      q('#st-fmt').onchange = function () { s.coordFmt = q('#st-fmt').value; GC.saveSettings(); GC.updateHud(); };
      q('[data-a=ok]').onclick = close;
      if (GC.cloud) GC.cloud.renderSettings(q('#st-cloud'));
      q('#st-offline').onclick = function () { close(); GC.offline.open(); };
      var st = q('#st-store');
      var mem = Store.isMemoryOnly() ? 'Private browsing: projects are NOT kept after closing Safari. ' : '';
      if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(function (e) { st.textContent = mem + 'Using ' + (e.usage / 1048576).toFixed(1) + ' MB of about ' + Math.round(e.quota / 1048576) + ' MB available to GeoCanvas.' + (Store.persistent ? ' Storage is marked persistent.' : ''); }, function () { st.textContent = mem; });
      else st.textContent = mem || 'Storage details are not available in this browser.';
    });
  };
  // ======================= start-up =======================
  function storageNote() {
    var n = $('storage-note');
    if (Store.isMemoryOnly()) n.innerHTML = '<b style="color:var(--danger)">Private browsing: nothing is saved after Safari closes.</b> Open GeoCanvas in a normal tab.';
    else n.textContent = 'Projects save automatically on this iPad. Safari can clear website data, so add GeoCanvas to the Home Screen and make backups of important work.';
  }
  function boot() {
    try { Geo.init(); } catch (e) { GC.toast('Coordinate systems failed to load: ' + e.message, 'err'); }
    GC.setMode('nav');
    Store.open().then(function () {
      storageNote();
      var last = null; try { last = localStorage.getItem('gc.lastProject'); } catch (e) { /* ignore */ }
      return Store.listProjects().then(function (list) {
        var pick = list.filter(function (p) { return p.id === last; })[0] || list[0];
        if (pick) return Store.loadProject(pick.id);
        var p = GC.newProject(); return Store.saveProject(p, null).then(function () { return p; });
      });
    }).then(function (p) {
      GC.openProject(p);
      if (window.matchMedia && window.matchMedia('(max-width: 700px)').matches) document.body.classList.add('no-sidebar');
      try { if (!localStorage.getItem('gc.welcomed')) { localStorage.setItem('gc.welcomed', '1'); welcome(); } } catch (e) { /* ignore */ }
    }).catch(function (e) {
      GC.toast('Could not open storage (' + e.message + '). Working without saving.', 'err', 10000);
      GC.openProject(GC.newProject());
    });
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      // A new version takes over as soon as it is installed: save, then reload once into it.
      var hadController = !!navigator.serviceWorker.controller, reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!hadController || reloading) return;
        reloading = true;
        GC.toast('GeoCanvas has been updated. Reloading…');
        var go = function () { if (GC.gestureActive && GC.gestureActive()) { setTimeout(go, 1000); return; } GC.saveNow().then(function () { location.reload(); }, function () { location.reload(); }); };
        setTimeout(go, 800);
      });
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        // A Home Screen app can stay open for days: look for a new version whenever it comes back to the front.
        document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') reg.update().catch(function () {}); });
      }, function () { /* offline support unavailable */ });
    }
  }
  function welcome() {
    GC.modal('<h2>Welcome to GeoCanvas</h2><p class="sub">Draw on the map of Toowoomba with Apple Pencil — your notes stay pinned to the ground.</p>' +
      '<p><b>Navigate</b> mode: drag and pinch to move the map. Tap features to inspect them.</p>' +
      '<p><b>Draw</b> mode: the Pencil writes; your fingers still move and zoom the map. Pick pens, highlighter, shapes, text and markers in the bottom toolbar. Tap the active tool again for thickness and opacity.</p>' +
      '<p><b>Import</b> (⤓ at the top) KML, KMZ, shapefiles (select the .shp, .dbf, .shx and .prj together, or a ZIP), GeoJSON, GPX and GeoTIFF from the Files app. Files in MGA zone 56 / GDA2020 / GDA94 are converted automatically.</p>' +
      '<p><b>Export</b> (⤒) to KML/KMZ, GeoJSON, GPX, GeoTIFF or PNG for QGIS and Google Earth.</p>' +
      '<p class="hint">Tip: Share › Add to Home Screen makes GeoCanvas open full screen like an app and work offline.</p>' +
      '<div class="actions"><button class="btn primary" data-a="ok">Start</button></div>', function (el, close) { el.querySelector('[data-a=ok]').onclick = close; });
  }
  boot();
})(window);
