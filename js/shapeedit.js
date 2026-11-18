/* GeoCanvas web — editing the points of lines and areas, switched on per layer in its ⋯ options ("Edit lines and areas").
   Works on imported GIS layers (KML/KMZ, shapefiles, GeoJSON: lines, areas, points, and their multi-part forms) and on
   shapes drawn with the Shapes tool (lines, arrows, rectangles, freehand polygons). Tap a line or area: its points get
   handles to drag, “+” handles between them add a point; tap a point, then Delete point. Undo steps back. Every change
   is saved and synced as it is made. Freehand pen strokes and ellipses are not edited point by point (use the lasso). */
(function (global) {
  'use strict';
  var GC = global.GC, Ink = global.Ink, map = GC.map, $ = GC.$, esc = GC.esc;
  var E = null; // { lid, t: target, parts, closed, sel: {p, i}, undo: [] }
  var pane = map.createPane('gcEdit'); pane.style.zIndex = 660;
  var outline = L.layerGroup(), handles = L.layerGroup();
  var MAX_HANDLES = 600;

  // ---------- the bar ----------
  var bar = document.createElement('div'); bar.id = 'se-bar'; bar.className = 'panel'; bar.hidden = true;
  bar.innerHTML = '<div class="se-txt"><b id="se-title"></b><small id="se-hint"></small></div>' +
    '<button class="ib" id="se-undo" title="Undo" aria-label="Undo"><svg><use xlink:href="#i-undo"/></svg></button>' +
    '<button class="btn" id="se-delpt">Delete point</button><button class="btn danger" id="se-delshape">Delete shape</button><button class="btn primary" id="se-done">Done</button>';
  document.body.appendChild(bar);
  function layer() { return E && GC.layerById(E.lid); }
  function paintBar() {
    var l = layer(); if (!l) return;
    $('se-title').textContent = 'Editing “' + l.name + '”';
    $('se-hint').textContent = !E.t ? 'Tap a line or area to edit its points.' : E.sel ? 'Drag the point, or Delete point.' : 'Drag a point to move it, drag a + to add one. Tap a point to delete it.';
    $('se-undo').disabled = !E.undo.length;
    $('se-delpt').hidden = !E.sel;
    $('se-delshape').hidden = !(E.t && E.t.kind === 'ink');
  }

  // ---------- a shape's points ----------
  var same = function (a, b) { return a && b && a[0] === b[0] && a[1] === b[1]; };
  /** The editable parts of a geometry: [{ pts, closed }] (rings without their repeated last point). */
  function partsOf(g) {
    var ring = function (r) { var p = r.map(function (q) { return [q[0], q[1]]; }); if (p.length > 1 && same(p[0], p[p.length - 1])) p.pop(); return { pts: p, closed: true }; };
    var line = function (c) { return { pts: c.map(function (q) { return [q[0], q[1]]; }), closed: false }; };
    switch (g && g.type) {
      case 'Point': return [{ pts: [[g.coordinates[0], g.coordinates[1]]], closed: false, point: true }];
      case 'MultiPoint': return g.coordinates.map(function (c) { return { pts: [[c[0], c[1]]], closed: false, point: true }; });
      case 'LineString': return [line(g.coordinates)];
      case 'MultiLineString': return g.coordinates.map(line);
      case 'Polygon': return g.coordinates.map(ring);
      case 'MultiPolygon': var out = []; g.coordinates.forEach(function (poly) { poly.forEach(function (r) { out.push(ring(r)); }); }); return out;
    }
    return null;
  }
  /** Puts edited parts back into the same kind of geometry (keeping any heights). */
  function rebuild(g, parts) {
    var close = function (p) { return p.pts.concat([p.pts[0]]); }, k = 0;
    switch (g.type) {
      case 'Point': return { type: 'Point', coordinates: parts[0].pts[0] };
      case 'MultiPoint': return { type: 'MultiPoint', coordinates: parts.map(function (p) { return p.pts[0]; }) };
      case 'LineString': return { type: 'LineString', coordinates: parts[0].pts };
      case 'MultiLineString': return { type: 'MultiLineString', coordinates: parts.map(function (p) { return p.pts; }) };
      case 'Polygon': return { type: 'Polygon', coordinates: parts.map(close) };
      case 'MultiPolygon': return { type: 'MultiPolygon', coordinates: g.coordinates.map(function (poly) { return poly.map(function () { return close(parts[k++]); }); }) };
    }
    return g;
  }
  function snapshot() { return JSON.parse(JSON.stringify(E.parts)); }

  // ---------- picking a shape ----------
  function pick(e) {
    var l = layer(), v = GC.views[l.id], cp = map.latLngToContainerPoint(e.latlng);
    if (l.kind === 'drawing') {
      var el = GC.hitItem(l, [cp.x, cp.y]);
      if (!el) return null;
      if (el.type !== 'shape' || el.kind === 'ellipse') { GC.toast(el.type === 'stroke' ? 'Pen strokes are edited as a whole: use the lasso to move, resize or rotate them.' : el.kind === 'ellipse' ? 'Ellipses can’t be edited point by point: use the lasso to move or resize them.' : 'Only lines and areas have points to edit.', 'warn', 6000); return false; }
      return { kind: 'ink', id: el.id };
    }
    var hit = null, lp = e.layerPoint;
    var walk = function (x) {
      if (x.eachLayer) { x.eachLayer(walk); return; }
      if (!x.feature) return;
      if (x._containsPoint && (x._parts || x._point)) { try { if (x._containsPoint(lp)) hit = x; } catch (er) { /* not projected */ } }
      else if (x.getLatLng && map.latLngToLayerPoint(x.getLatLng()).distanceTo(lp) < 18) hit = x; // point icons
    };
    if (v) v.group.eachLayer(walk);
    if (!hit) return null;
    var idx = l.geojson.features.indexOf(hit.feature);
    if (idx < 0 || !partsOf(hit.feature.geometry)) { GC.toast('This feature can’t be edited point by point.', 'warn'); return false; }
    return { kind: 'feat', idx: idx };
  }
  function geomOf(t) {
    var l = layer();
    if (t.kind === 'feat') return l.geojson.features[t.idx].geometry;
    var el = l.items.filter(function (x) { return x.id === t.id; })[0];
    return el ? { type: Ink.isClosed(el) ? 'Polygon' : 'LineString', coordinates: Ink.isClosed(el) ? [el.verts.concat([el.verts[0]])] : el.verts } : null;
  }
  function select(t) {
    var g = t && geomOf(t);
    E.t = g ? t : null; E.parts = g ? partsOf(g) : null; E.sel = null; E.undo = [];
    draw(); paintBar();
  }

  // ---------- handles ----------
  var ICON_V = L.divIcon({ className: 'se-v', iconSize: [18, 18], iconAnchor: [9, 9] }), ICON_S = L.divIcon({ className: 'se-v sel', iconSize: [22, 22], iconAnchor: [11, 11] }),
    ICON_M = L.divIcon({ className: 'se-m', iconSize: [16, 16], iconAnchor: [8, 8], html: '+' });
  function drawOutline() {
    outline.clearLayers(); if (!E || !E.parts) return;
    E.parts.forEach(function (p) {
      var lls = p.pts.map(function (q) { return [q[1], q[0]]; });
      if (p.point) return;
      outline.addLayer(p.closed ? L.polygon(lls, { pane: 'gcEdit', color: '#ff6d00', weight: 3, dashArray: '6 4', fillColor: '#ff6d00', fillOpacity: 0.12, interactive: false })
        : L.polyline(lls, { pane: 'gcEdit', color: '#ff6d00', weight: 3, dashArray: '6 4', interactive: false }));
    });
  }
  function draw() {
    handles.clearLayers(); drawOutline(); if (!E || !E.parts) return;
    var view = map.getBounds().pad(0.2), n = 0, many = false;
    E.parts.forEach(function (p, pi) {
      p.pts.forEach(function (q, i) {
        var ll = L.latLng(q[1], q[0]); if (!view.contains(ll)) return;
        if (++n > MAX_HANDLES) { many = true; return; }
        var on = E.sel && E.sel.p === pi && E.sel.i === i;
        var m = L.marker(ll, { icon: on ? ICON_S : ICON_V, draggable: true, pane: 'gcEdit', keyboard: false, bubblingMouseEvents: false });
        m.on('dragstart', function () { E.before = snapshot(); });
        m.on('drag', function () { var c = m.getLatLng(); p.pts[i] = [round(c.lng), round(c.lat)]; drawOutline(); });
        m.on('dragend', function () { E.sel = { p: pi, i: i }; commit(E.before); });
        m.on('click', function () { E.sel = on ? null : { p: pi, i: i }; draw(); paintBar(); });
        handles.addLayer(m);
        // a "+" halfway to the next point adds one there
        var j = i + 1; if (p.point || (j >= p.pts.length && !p.closed)) return;
        var r = p.pts[j % p.pts.length], mid = L.latLng((q[1] + r[1]) / 2, (q[0] + r[0]) / 2);
        var a = L.marker(mid, { icon: ICON_M, draggable: true, pane: 'gcEdit', keyboard: false, bubblingMouseEvents: false });
        a.on('dragstart', function () { E.before = snapshot(); p.pts.splice(j, 0, [round(mid.lng), round(mid.lat)]); });
        a.on('drag', function () { var c = a.getLatLng(); p.pts[j] = [round(c.lng), round(c.lat)]; drawOutline(); });
        a.on('dragend', function () { E.sel = null; commit(E.before); });
        a.on('click', function () { var b = snapshot(); p.pts.splice(j, 0, [round(mid.lng), round(mid.lat)]); E.sel = { p: pi, i: j }; commit(b); });
        handles.addLayer(a);
      });
    });
    if (many && !E.warned) { E.warned = true; GC.toast('This shape has many points: handles are shown for the part in view. Zoom in to edit it.', null, 6000); }
  }
  function round(v) { return Math.round(v * 1e8) / 1e8; }
  map.on('moveend', function () { if (E && E.parts) draw(); });

  // ---------- saving ----------
  /** Writes the edited points into the layer (saved and synced) and records the step for Undo. */
  function commit(before) {
    var l = layer(); if (!l || !E.t) return;
    if (before) E.undo.push(before);
    write(l);
    draw(); paintBar();
  }
  function write(l) {
    if (E.t.kind === 'feat') {
      var fs = l.geojson.features.slice(), f = fs[E.t.idx], nf = {}; for (var k in f) nf[k] = f[k];
      nf.geometry = rebuild(f.geometry, E.parts); fs[E.t.idx] = nf;
      var gj = {}; for (var k2 in l.geojson) gj[k2] = l.geojson[k2]; gj.features = fs; l.geojson = gj; // new objects: the sync sees the change
      GC.renderLayer(l); GC.applyLayerState(); GC.markDirty(l.id);
    } else {
      var id = E.t.id, pts = E.parts[0].pts;
      GC.editLayer(l.id, function (items) {
        return items.map(function (x) { if (x.id !== id) return x; var c = JSON.parse(JSON.stringify(Ink.stripCache(x))); c.verts = pts.map(function (q) { return [q[0], q[1]]; }); if (c.kind === 'rectangle') c.kind = 'polygon'; return c; });
      });
    }
  }
  function undo() {
    var l = layer(); if (!l || !E.undo.length) return;
    E.parts = E.undo.pop(); E.sel = null; write(l); draw(); paintBar();
  }
  $('se-undo').onclick = undo;
  $('se-delpt').onclick = function () {
    if (!E || !E.sel) return;
    var p = E.parts[E.sel.p], min = p.point ? 1 : p.closed ? 3 : 2;
    if (p.pts.length <= min) { GC.toast(p.closed ? 'An area needs at least 3 points.' : p.point ? 'A point can’t be removed this way.' : 'A line needs at least 2 points.', 'warn'); return; }
    var b = snapshot(); p.pts.splice(E.sel.i, 1); E.sel = null; commit(b);
  };
  $('se-delshape').onclick = function () {
    var l = layer(); if (!l || !E.t || E.t.kind !== 'ink') return;
    var id = E.t.id; GC.editLayer(l.id, function (items) { return items.filter(function (x) { return x.id !== id; }); });
    GC.toast('Shape deleted. Undo (top bar) brings it back.'); select(null);
  };
  $('se-done').onclick = function () { stop(); };

  // ---------- on / off ----------
  function start(l) {
    if (l.kind === 'drawing' && l.locked) { GC.toast('“' + l.name + '” is locked: unlock it in the Layers panel first.', 'warn'); return false; }
    if (E) stop();
    if (GC.mode === 'draw') GC.setMode('nav');
    if (GC.closeInspector) GC.closeInspector();
    if (!l.visible) { l.visible = true; GC.applyLayerState(); GC.markDirty(l.id); }
    E = { lid: l.id, t: null, parts: null, sel: null, undo: [] };
    map.addLayer(outline); map.addLayer(handles);
    bar.hidden = false; document.body.classList.add('shape-editing'); paintBar(); GC.refreshLayers();
    return true;
  }
  function stop() {
    if (!E) return;
    E = null; handles.clearLayers(); outline.clearLayers(); map.removeLayer(handles); map.removeLayer(outline);
    bar.hidden = true; document.body.classList.remove('shape-editing'); GC.refreshLayers();
  }
  /** The map's tap handler asks first: while editing, taps pick the shape to edit. */
  function click(e) {
    if (!E) return false;
    if (!layer()) { stop(); return false; }
    var t = pick(e);
    if (t === false) return true;
    if (t && E.t && t.kind === E.t.kind && t.idx === E.t.idx && t.id === E.t.id) { E.sel = null; draw(); paintBar(); return true; }
    select(t);
    return true;
  }
  // the layer went away or another project opened: stop
  setInterval(function () { if (E && !layer()) stop(); }, 1000);

  GC.shapeEdit = { start: start, stop: stop, click: click, isOn: function (lid) { return !!E && (lid == null || E.lid === lid); }, editable: function (l) { return l.kind === 'vector' || l.kind === 'drawing'; } };
})(window);
