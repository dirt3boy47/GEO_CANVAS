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
    GC.insertLayer(l);
    return storeSources(l, v.files).then(function () { return l; });
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
  function openInspector(title, sub, rows, actions) {
    $('insp-title').textContent = title; $('insp-sub').textContent = sub || '';
    var h = '<table>' + rows.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + (r[2] ? r[1] : esc(r[1])) + '</td></tr>'; }).join('') + '</table>';
    if (actions && actions.length) h += '<div class="row-btns" style="margin:12px 0 0">' + actions.map(function (a, i) { return '<button class="btn' + (a.danger ? ' danger' : '') + '" data-i="' + i + '">' + esc(a.label) + '</button>'; }).join('') + '</div>';
    $('insp-body').innerHTML = h;
    Array.prototype.forEach.call($('insp-body').querySelectorAll('[data-i]'), function (b) { b.onclick = function () { actions[+b.getAttribute('data-i')].fn(); }; });
    $('inspector').hidden = false;
    $('gps-panel').hidden = true;
  }
  GC.closeInspector = function () { $('inspector').hidden = true; if (hl) { map.removeLayer(hl); hl = null; } };
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
      var hit = null;
      var walk = function (x) { if (x.eachLayer) { x.eachLayer(walk); return; } if (x._containsPoint && (x._parts || x._point)) { try { if (x._containsPoint(lp)) hit = x; } catch (er) { /* not projected */ } } };
      v.group.eachLayer(walk);
      if (hit) {
        if (hit.feature) GC.inspectFeature(l, hit.feature, e.latlng);
        else if (hit._gcTrack) GC.inspectTrack(l, hit._gcTrack);
        else if (hit._gcWp) GC.inspectWaypoint(l, hit._gcWp);
        else continue;
        return;
      }
    }
    GC.closeInspector();
  };
  GC.inspectFeature = function (l, f, ll) {
    var rows = measure(f.geometry);
    Object.keys(f.properties || {}).forEach(function (k) {
      if (/^(stroke|fill|marker-|styleUrl|styleHash|styleMapHash|@)/.test(k)) return;
      var v = f.properties[k]; if (v == null || v === '') return;
      rows.push([k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
    });
    if (f.geometry && f.geometry.type !== 'Point' && ll) rows = rows.concat([['Tapped at', ll.lat.toFixed(6) + ', ' + ll.lng.toFixed(6)], ['MGA2020', Geo.fmt([ll.lng, ll.lat], 'mga')]]);
    highlight(f);
    openInspector((f.properties && (f.properties[l.labelField] || f.properties.name || f.properties.NAME)) || 'Feature', l.name + ' · ' + (f.geometry ? f.geometry.type : ''), rows);
  };
  GC.inspectItem = function (l, el) {
    var rows = [['Layer', l.name], ['Created', GC.fmtTime(el.created || Date.now())]], actions = [], title;
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
    }
    if (!l.locked) actions.push({ label: 'Delete', danger: true, fn: function () { GC.closeInspector(); GC.editLayer(l.id, function (items) { return items.filter(function (x) { return x.id !== el.id; }); }); GC.toast('Deleted. Undo is available.'); } });
    if (hl) { map.removeLayer(hl); hl = null; }
    openInspector(title, el.type === 'marker' ? 'Marker' : 'Drawn ' + el.type, rows, actions);
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
    openInspector(w.name || 'Waypoint', l.name, rows, l.locked ? [] : [{ label: 'Delete waypoint', danger: true, fn: function () { l.waypoints = l.waypoints.filter(function (x) { return x !== w; }); GC.renderLayer(l); GC.markDirty(l.id); GC.refreshLayers(true); GC.closeInspector(); } }]);
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
    $('inspector').hidden = true; p.hidden = false; startGPS(); renderGpsData();
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
  $('gps-wp').onclick = function () {
    var useFix = gps.fix && Date.now() - gps.fix.t < 60000, c = map.getCenter();
    var lat = useFix ? gps.fix.lat : c.lat, lon = useFix ? gps.fix.lon : c.lng;
    var l = gpsLayer('waypoints', 'Waypoints');
    var w = { lat: lat, lon: lon, ele: useFix && gps.fix.alt != null ? gps.fix.alt : null, acc: useFix ? gps.fix.acc : null, time: Date.now(), name: $('wp-name').value.trim() || 'WP' + ((l.waypoints.length + 1 < 10 ? '0' : '') + (l.waypoints.length + 1)), note: $('wp-note').value.trim() };
    l.waypoints.push(w); GC.renderLayer(l); GC.applyLayerState(); GC.markDirty(l.id, true); GC.refreshLayers();
    $('wp-name').value = ''; $('wp-note').value = '';
    GC.toast(useFix ? 'Waypoint “' + w.name + '” saved at your GPS position (±' + Math.round(w.acc) + ' m).' : 'No current GPS fix — waypoint “' + w.name + '” placed at the map centre (crosshair).', useFix ? null : 'warn');
  };

  // ======================= search =======================
  var searchMarker = null;
  $('btn-search').onclick = function () {
    GC.modal('<h2>Search</h2><p class="sub">A place or address, or coordinates: “-27.56, 151.95”, “27°33′S 151°57′E” or MGA “56 396000 6951000”.</p>' +
      '<div style="display:flex;gap:8px"><input type="text" id="s-q" placeholder="e.g. Picnic Point, Toowoomba" style="flex:1"><button class="btn primary" id="s-go">Search</button></div><div class="list" id="s-res"></div>',
      function (el, close) {
        var q = el.querySelector('#s-q'), res = el.querySelector('#s-res');
        var go = function () {
          var text = q.value.trim(); if (!text) return;
          var ll = Geo.parseCoordinate(text);
          if (ll) { close(); flyTo(ll[1], ll[0], text); return; }
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
    if (fmt === 'kmz') { var z = new JSZip(); z.file('doc.kml', Exporters.kml(p, ids, outlines)); return z.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: 'application/vnd.google-earth.kmz' }).then(function (b) { return { blob: b, name: base + '.kmz' }; }); }
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
      return Promise.all(p.layers.filter(function (l) { return l.hasSources; }).map(function (l) {
        return Store.getFiles(p.id, l.id).then(function (fs) { return fs.map(function (f) { return { layer: l.id, name: f.name, b64: abToB64(f.data instanceof ArrayBuffer ? f.data : new ArrayBuffer(0)) }; }); });
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
    if (!shared) {
      return GC.confirm('Delete “' + meta.name + '”?', 'The project and all its layers are removed from this iPad. This cannot be undone — make a backup first if unsure.', 'Delete project', true).then(function (ok) {
        if (ok) return Store.deleteProject(id).then(function () { return afterDelete(id); });
      });
    }
    GC.modal('<h2>Delete “' + esc(meta.name) + '”?</h2><p class="sub">This project is shared through cloud sync.</p>' +
      '<p><b>Only from this iPad</b>: it stays in the cloud and on other devices, and you can download it again.</p>' +
      '<p><b>Everywhere</b>: it is removed from the cloud too. Other devices keep their copy but stop sharing it. This cannot be undone.</p>' +
      '<div class="actions"><button class="btn" data-a="no">Cancel</button><span class="spacer"></span><button class="btn" data-a="here">Only from this iPad</button><button class="btn danger" data-a="all">Everywhere</button></div>',
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
    if (cloudOn) GC.busy('Checking the cloud…');
    Promise.all([GC.saveNow().then(Store.listProjects), cloudOn ? GC.cloud.remoteList() : Promise.resolve(null)]).then(function (r) {
      GC.busy(null);
      var list = r[0], remote = r[1] || [], here = {};
      list.forEach(function (p) { here[p.id] = true; });
      var cloudOnly = remote.filter(function (x) { return !here[x.id]; });
      var tag = function (p) { return !cloudOn ? '' : (p.cloudOff ? ' · not shared' : (p.cloud ? ' <span class="cloud-tag">☁ shared</span>' : ' · not uploaded yet')); };
      var html = '<h2>Projects</h2><p class="sub">' + (cloudOn ? 'On this iPad. Shared projects sync with the team cloud.' : 'Stored on this iPad, in this browser. Back up important projects to Files, or turn on cloud sync in Settings.') + '</p><div class="list">' +
        list.map(function (p) { return '<div class="item' + (p.id === GC.project.id ? ' current' : '') + '" data-id="' + p.id + '"><div class="grow" data-a="open"><b>' + esc(p.name) + '</b><small>' + (p.layerOrder || []).length + ' layers · edited ' + GC.fmtTime(p.modified) + tag(p) + '</small></div>' +
          '<button class="ib" data-a="ren" title="Rename">' + GC.icon('text') + '</button><button class="ib" data-a="dup" title="Duplicate">' + GC.icon('copy') + '</button><button class="ib danger" data-a="del" title="Delete">' + GC.icon('trash') + '</button></div>'; }).join('') +
        '</div>' +
        (cloudOnly.length ? '<div class="pop-title small">In the cloud, not on this iPad yet</div><div class="list">' + cloudOnly.map(function (x) {
          return '<div class="item" data-cloud="' + esc(x.id) + '"><div class="grow" data-a="get"><b>' + esc(x.name) + '</b><small>☁ changed ' + GC.fmtTime(x.modified) + (x.device ? ' by ' + esc(x.device) : '') + ' · ' + Math.max(1, Math.round(x.size / 1024)) + ' KB · tap to download</small></div></div>';
        }).join('') + '</div>' : '') +
        (cloudOn && r[1] === null ? '<p class="hint">The cloud could not be reached, so projects from other devices are not listed.</p>' : '') +
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
        Array.prototype.forEach.call(el.querySelectorAll('[data-cloud]'), function (it) {
          it.onclick = function () {
            close(); GC.busy('Downloading from the cloud…');
            GC.saveNow().then(function () { return GC.cloud.download(it.getAttribute('data-cloud')); }).then(function (p) { GC.busy(null); GC.openProject(p); GC.toast('Downloaded “' + p.name + '”.'); }, function (e) { GC.busy(null); GC.toast('Download failed: ' + e.message, 'err'); });
          };
        });
        el.querySelector('.list').onclick = function (e) {
          var it = e.target.closest('[data-id]'), a = e.target.closest('[data-a]'); if (!it || !a) return;
          var id = it.getAttribute('data-id'), act = a.getAttribute('data-a'), meta = list.filter(function (x) { return x.id === id; })[0];
          if (act === 'open') { close(); openOther(id); }
          else if (act === 'ren') { close(); GC.prompt('Rename project', meta.name, 'Name', 'Rename').then(function (n) { if (!n) return; if (id === GC.project.id) { GC.project.name = n; $('project-name').textContent = n; $('proj-name').value = n; GC.markDirty(); } else Store.loadProject(id).then(function (p) { p.name = n; if (GC.cloud) GC.cloud.touch(id); return Store.saveProject(p, {}); }); }); }
          else if (act === 'dup') {
            close(); GC.busy('Duplicating…');
            GC.saveNow().then(function () { return Store.loadProject(id); }).then(function (p) {
              var oldId = p.id; p.id = Ink.uid(); p.name = p.name + ' copy'; p.created = Date.now(); delete p.cloud; delete p.cloudOff;
              return Promise.all(p.layers.filter(function (l) { return l.hasSources; }).map(function (l) { return Store.getFiles(oldId, l.id).then(function (fs) { return Promise.all(fs.map(function (f) { return Store.putFile(p.id, l.id, f.name, f.data); })); }); }))
                .then(function () { return Store.saveProject(p, null); }).then(function () { return p; });
            }).then(function (p) { GC.busy(null); GC.toast('Created “' + p.name + '”.'); }, function (er) { GC.busy(null); GC.toast(er.message, 'err'); });
          } else if (act === 'del') { close(); deleteProject(meta); }
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
      '<div class="pop-title small">Cloud sync</div><div id="st-cloud"></div>' +
      '<div class="pop-title small">Offline imagery</div><p class="hint" style="margin:0 0 6px">Saves Queensland aerial imagery for the area on screen (up to 4 zoom levels closer) so it shows without internet.</p>' +
      '<div class="row-btns" style="margin:0"><button class="btn" id="st-offline">Save this area for offline use</button><button class="btn" id="st-clear">Delete saved imagery</button></div><p class="hint" id="st-off-msg"></p>' +
      '<div class="pop-title small">Storage</div><p class="hint" id="st-store" style="margin:0">Checking…</p>' +
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
      q('#st-offline').onclick = function () { saveOffline(q('#st-off-msg'), q('#st-offline')); };
      q('#st-clear').onclick = function () { if (window.caches) caches.delete('gc-tiles').then(function () { q('#st-off-msg').textContent = 'Saved imagery deleted.'; }); };
      var st = q('#st-store');
      var mem = Store.isMemoryOnly() ? 'Private browsing: projects are NOT kept after closing Safari. ' : '';
      if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(function (e) { st.textContent = mem + 'Using ' + (e.usage / 1048576).toFixed(1) + ' MB of about ' + Math.round(e.quota / 1048576) + ' MB available to GeoCanvas.' + (Store.persistent ? ' Storage is marked persistent.' : ''); }, function () { st.textContent = mem; });
      else st.textContent = mem || 'Storage details are not available in this browser.';
    });
  };
  function tileXY(lat, lon, z) { var n = Math.pow(2, z), m = Geo.merc(lon, lat); return [Math.floor(m[0] * n), Math.floor(m[1] * n)]; }
  function saveOffline(msg, btn) {
    if (!window.caches) { msg.textContent = 'This browser cannot store imagery offline.'; return; }
    var b = map.getBounds(), z0 = Math.max(10, Math.floor(map.getZoom())), z1 = Math.min(20, z0 + 4), urls = [];
    for (var z = z0; z <= z1 && urls.length < 4000; z++) {
      var a = tileXY(b.getNorth(), b.getWest(), z), c = tileXY(b.getSouth(), b.getEast(), z);
      for (var x = a[0]; x <= c[0]; x++) for (var y = a[1]; y <= c[1]; y++) urls.push(GC.QLD_TILES.replace('{z}', z).replace('{x}', x).replace('{y}', y));
    }
    if (urls.length >= 4000) { msg.textContent = 'That area is too large (more than 4000 tiles). Zoom in further and try again.'; return; }
    btn.disabled = true;
    caches.open('gc-tiles').then(function (cache) {
      var i = 0, ok = 0, fail = 0;
      var next = function () {
        if (i >= urls.length) return Promise.resolve();
        var u = urls[i++];
        return cache.match(u).then(function (hit) {
          if (hit) { ok++; return; }
          return fetch(u, { mode: 'cors' }).then(function (r) { if (!r.ok) throw new Error(); ok++; return cache.put(u, r); }).catch(function () { fail++; });
        }).then(function () { msg.textContent = 'Saving imagery… ' + (ok + fail) + ' / ' + urls.length; return next(); });
      };
      return Promise.all([next(), next(), next(), next(), next(), next()]).then(function () {
        btn.disabled = false;
        msg.textContent = fail === urls.length ? 'The Queensland imagery service did not allow offline saving from this browser (or there is no internet).' : 'Saved ' + ok + ' imagery tiles (zoom ' + z0 + '–' + z1 + ')' + (fail ? ', ' + fail + ' failed' : '') + '. Choose “QLD aerial imagery” as the basemap when offline.';
      });
    }).catch(function () { btn.disabled = false; msg.textContent = 'Could not open offline storage.'; });
  }

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
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline support unavailable */ });
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
