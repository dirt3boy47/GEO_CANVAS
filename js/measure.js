/* GeoCanvas web — Measure tool (like Google Earth's ruler).
   Line: tap points, or trace freehand with the Pencil (a winding track, a creek, a fence line).
   Area: tap the corners, or trace the outline freehand; it closes itself.
   Lengths are on the GRS80 ellipsoid (GDA2020); areas use an equal-area projection centred on the shape. */
(function (global) {
  'use strict';
  var GC = global.GC, Geo = global.Geo, Ink = global.Ink, map = GC.map, $ = GC.$, esc = GC.esc;

  var M = { on: false, mode: 'line', free: false, pts: [], trace: null, lastTrace: 0 };
  var group = L.layerGroup(), handles = [];
  var LINE = { color: '#ffd400', weight: 3, opacity: 1, dashArray: '8 6', interactive: false };
  var CASING = { color: '#000', weight: 6, opacity: 0.45, interactive: false };

  // ---------- numbers ----------
  function fmtLen(m) {
    if (m >= 1000) return (m / 1000).toFixed(m >= 100000 ? 1 : 3) + ' km';
    return (m >= 100 ? m.toFixed(1) : m.toFixed(2)) + ' m';
  }
  function fmtArea(a) {
    if (a >= 1e6) return (a / 1e6).toFixed(3) + ' km²';
    if (a >= 1e4) return (a / 1e4).toFixed(3) + ' ha';
    return a.toFixed(a >= 100 ? 0 : 1) + ' m²';
  }
  function grouped(n, d) { return n.toFixed(d).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function coords() { return M.pts.map(function (p) { return [p.ll.lng, p.ll.lat]; }); }
  function stats() {
    var c = coords(), s = { n: c.length, length: Geo.pathLength(c) };
    if (c.length >= 2) { var a = c[c.length - 2], b = c[c.length - 1]; s.seg = Geo.geodesic(a, b); s.bearing = Geo.bearing(a, b); }
    if (M.mode === 'area' && c.length >= 3) { s.area = Geo.ringArea(c); s.perimeter = s.length + Geo.geodesic(c[c.length - 1], c[0]); }
    return s;
  }

  // ---------- drawing the measurement ----------
  function render() {
    group.clearLayers(); handles = [];
    var lls = M.pts.map(function (p) { return p.ll; }), s = stats();
    if (M.mode === 'area' && lls.length >= 3) {
      group.addLayer(L.polygon(lls, Object.assign({}, CASING, { fill: false })));
      group.addLayer(L.polygon(lls, Object.assign({}, LINE, { fillColor: '#ffd400', fillOpacity: 0.18 })));
    } else if (lls.length >= 2) {
      group.addLayer(L.polyline(lls, CASING)); group.addLayer(L.polyline(lls, LINE));
    }
    M.pts.forEach(function (p, i) {
      var end = i === 0 || i === M.pts.length - 1;
      if (!p.h && !end) return; // traced points: only the ends get handles
      var mk = L.marker(p.ll, { draggable: true, keyboard: false, zIndexOffset: 1000,
        icon: L.divIcon({ className: 'ms-vertex' + (i === 0 ? ' first' : ''), iconSize: [18, 18], iconAnchor: [9, 9] }) });
      mk.on('drag', function () { p.ll = mk.getLatLng(); redrawLines(); update(); });
      mk.on('dragend', function () { M.lastTrace = Date.now(); render(); });
      mk.on('click', function (e) { L.DomEvent.stopPropagation(e); if (M.mode === 'area' && i === 0 && M.pts.length >= 3) GC.toast('Area closed: ' + fmtArea(stats().area) + '.'); });
      group.addLayer(mk); handles.push(mk);
    });
    if (lls.length >= 2) {
      var at = M.mode === 'area' && lls.length >= 3 ? L.polygon(lls).getBounds().getCenter() : lls[lls.length - 1];
      var txt = M.mode === 'area' && s.area != null ? fmtArea(s.area) : fmtLen(s.length);
      group.addLayer(L.marker(at, { interactive: false, keyboard: false, icon: L.divIcon({ className: 'ms-label' + (M.mode === 'area' && lls.length >= 3 ? ' mid' : ''), iconSize: null, html: '<span>' + esc(txt) + '</span>' }) }));
    }
    update();
  }
  function redrawLines() { // cheap redraw while dragging a handle
    var lls = M.pts.map(function (p) { return p.ll; });
    group.eachLayer(function (x) { if (x instanceof L.Polyline) x.setLatLngs(lls); });
  }
  function update() {
    var s = stats(), out = $('ms-out'), rows = [];
    if (M.mode === 'line') {
      rows.push(['Length', s.n >= 2 ? fmtLen(s.length) : '—', s.n >= 2 ? grouped(s.length, 2) + ' m' : '']);
      if (s.seg != null && M.pts.length > 2) rows.push(['Last segment', fmtLen(s.seg), '']);
      if (s.bearing != null) rows.push(['Bearing', s.bearing.toFixed(1) + '° true', '']);
    } else {
      rows.push(['Area', s.area != null ? fmtArea(s.area) : '—', s.area != null ? grouped(s.area, 1) + ' m²' + (s.area >= 1e4 ? '' : ' · ' + (s.area / 1e4).toFixed(4) + ' ha') : '']);
      rows.push(['Perimeter', s.perimeter != null ? fmtLen(s.perimeter) : '—', '']);
    }
    rows.push(['Points', String(s.n), '']);
    out.innerHTML = rows.map(function (r, i) { return '<div class="ms-row' + (i ? '' : ' big') + '"><span>' + r[0] + '</span><b>' + esc(r[1]) + '</b>' + (r[2] ? '<small>' + esc(r[2]) + '</small>' : '') + '</div>'; }).join('');
    $('ms-hint').textContent = M.free
      ? (GC.settings.fingerDraw ? 'Trace with a finger or the Pencil; two fingers move the map. Taps add straight segments.' : 'Trace with the Apple Pencil; fingers still move the map. Taps add straight segments.')
      : (M.mode === 'area' ? 'Tap the corners of the area. Drag a point to move it.' : 'Tap along the line to add points. Drag a point to move it.');
    if (M.action) $('ms-hint').textContent += ' Then Create action.';
    $('ms-undo').disabled = !M.pts.length; $('ms-clear').disabled = !M.pts.length;
    $('ms-save').disabled = $('ms-action').disabled = M.mode === 'area' ? M.pts.length < 3 : M.pts.length < 2;
    $('ms-save').hidden = !!M.action; $('ms-title').textContent = M.action ? (M.mode === 'area' ? 'Draw the action area' : 'Draw the action line') : 'Measure';
    Array.prototype.forEach.call($('ms-mode').children, function (b) { b.classList.toggle('on', b.getAttribute('data-m') === M.mode); });
    $('ms-free').checked = M.free;
  }

  // ---------- input ----------
  /** Called by the map's click handler; returns true when the tap was used for measuring. */
  function click(e) {
    if (!M.on) return false;
    if (Date.now() - M.lastTrace < 450) return true; // the click that ends a trace or a handle drag
    var snapped = (GC.cadastre && GC.cadastre.snap(e.latlng, 14)) || (GC.cad && GC.cad.snap(e.latlng, 14)); // lot corners or drawing vertices
    M.pts.push({ ll: snapped || e.latlng, h: true, cut: true });
    render();
    return true;
  }
  function inMap(e) { var t = e.target; return map.getContainer().contains(t) && !(t.closest && (t.closest('.leaflet-control') || t.closest('.leaflet-marker-icon') || t.closest('.leaflet-popup'))); }
  function cp(e) { var r = map.getContainer().getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function canTrace(e) { return M.on && M.free && inMap(e) && (e.pointerType === 'pen' || e.pointerType === 'mouse' || (e.pointerType === 'touch' && GC.settings.fingerDraw)); }
  var touches = {};
  window.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'touch') touches[e.pointerId] = true;
    if (M.trace && Object.keys(touches).length > 1) { cancelTrace(); return; } // second finger: pinch the map instead
    if (!canTrace(e) || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.pointerType !== 'touch') { e.stopPropagation(); e.preventDefault(); } // keep the map still under the Pencil
    M.trace = { id: e.pointerId, start: M.pts.length, cps: [cp(e)], moved: false };
  }, { capture: true, passive: false });
  window.addEventListener('pointermove', function (e) {
    var t = M.trace; if (!t || e.pointerId !== t.id) return;
    if (e.pointerType !== 'touch') { e.stopPropagation(); e.preventDefault(); }
    var evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || []; if (!evs.length) evs = [e];
    evs.forEach(function (ev) { var p = cp(ev), q = t.cps[t.cps.length - 1]; if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= 2.5) { t.cps.push(p); t.moved = true; } });
    if (!t.moved) return;
    M.pts.length = t.start;
    t.cps.forEach(function (p, i) { M.pts.push({ ll: map.containerPointToLatLng(L.point(p[0], p[1])), h: false, cut: i === 0 }); });
    render();
  }, { capture: true, passive: false });
  function endTrace(e) {
    if (e && e.pointerType === 'touch') delete touches[e.pointerId];
    var t = M.trace; if (!t || (e && e.pointerId !== t.id)) return;
    M.trace = null;
    if (!t.moved) return; // a tap: the map's click handler adds the point
    M.lastTrace = Date.now();
    // Remove hand jitter (under 1 px) without shortening real bends.
    var simple = Ink.simplify(t.cps, 1);
    M.pts.length = t.start;
    simple.forEach(function (p, i) { M.pts.push({ ll: map.containerPointToLatLng(L.point(p[0], p[1])), h: false, cut: i === 0 }); });
    render();
  }
  function cancelTrace() { var t = M.trace; if (!t) return; M.trace = null; M.pts.length = t.start; render(); }
  window.addEventListener('pointerup', endTrace, true);
  window.addEventListener('pointercancel', function (e) { if (e.pointerType === 'touch') delete touches[e.pointerId]; if (M.trace && e.pointerId === M.trace.id) cancelTrace(); }, true);
  // Safari's compatibility mouse/touch events must not reach the map while the Pencil traces.
  ['touchstart', 'touchmove', 'mousedown'].forEach(function (type) {
    window.addEventListener(type, function (e) {
      if (!M.on || !M.free || !inMap(e)) return;
      var stylus = e.touches && Array.prototype.some.call(e.touches, function (x) { return x.touchType === 'stylus'; });
      if (M.trace && M.trace.id != null && (stylus || e.type === 'mousedown')) { e.stopPropagation(); if (e.cancelable) e.preventDefault(); }
      else if (stylus) { e.stopPropagation(); if (e.cancelable) e.preventDefault(); }
    }, { capture: true, passive: false });
  });

  // ---------- panel ----------
  function setFree(v) {
    M.free = v;
    if (v && GC.settings.fingerDraw) map.dragging.disable(); else map.dragging.enable();
    update();
  }
  function open() {
    if (GC.mode === 'draw') GC.setMode('nav');
    if (GC.closeInspector) GC.closeInspector();
    $('gps-panel').hidden = true;
    M.on = true; group.addTo(map);
    document.body.classList.add('measuring');
    $('measure-panel').hidden = false; $('btn-measure').classList.add('on');
    setFree(M.free); render();
  }
  function close() {
    M.on = false; M.trace = null; M.pts = []; M.action = false;
    group.clearLayers(); map.removeLayer(group); map.dragging.enable();
    document.body.classList.remove('measuring');
    $('measure-panel').hidden = true; $('btn-measure').classList.remove('on');
  }
  $('btn-measure').onclick = function () { if (M.on) close(); else open(); };
  $('ms-close').onclick = close;
  $('ms-mode').onclick = function (e) { var b = e.target.closest('[data-m]'); if (!b) return; M.mode = b.getAttribute('data-m'); render(); };
  $('ms-free').onchange = function () { setFree($('ms-free').checked); };
  $('ms-undo').onclick = function () {
    // Undo removes the last tapped point, or the whole last traced stretch.
    var i = M.pts.length - 1; while (i > 0 && !M.pts[i].cut) i--;
    M.pts.length = Math.max(0, i); render();
  };
  $('ms-clear').onclick = function () { M.pts = []; render(); };
  $('ms-save').onclick = function () {
    var p = GC.project, l = GC.layerById(p.activeLayer);
    if (!l || l.kind !== 'drawing' || l.locked) l = GC.drawingLayers().filter(function (x) { return !x.locked; }).pop();
    if (!l) { l = GC.newDrawingLayer('Measurements'); GC.insertLayer(l, true); }
    var s = stats(), c = coords(), area = M.mode === 'area', z = map.getZoom(), color = GC.settings.color === '#ffffff' ? '#ffd400' : GC.settings.color;
    var shape = { id: Ink.uid(), type: 'shape', kind: area ? 'polygon' : 'line', verts: c, color: color, width: 4, opacity: 1, fill: area, dashed: false, z0: z, created: Date.now() };
    var at = area ? (function () { var b = L.polygon(M.pts.map(function (q) { return q.ll; })).getBounds().getCenter(); return [b.lng, b.lat]; })() : c[c.length - 1];
    var text = area ? fmtArea(s.area) + ' · ' + fmtLen(s.perimeter) + ' perimeter' : fmtLen(s.length);
    var label = { id: Ink.uid(), type: 'text', at: at, text: text, size: 18, color: color, opacity: 1, z0: z, created: Date.now() };
    GC.editLayer(l.id, function (items) { return items.concat([shape, label]); });
    if (!l.visible) { l.visible = true; GC.applyLayerState(); GC.refreshLayers(); }
    GC.toast('Saved to “' + l.name + '”: ' + text + '. Undo is available.');
    M.pts = []; render();
  };

  /** Draw an area or line that becomes an action (the action sheet opens on Create action). */
  function drawAction(mode) {
    if (M.on) close();
    M.mode = mode === 'line' ? 'line' : 'area'; M.action = true; open();
    GC.toast(M.mode === 'area' ? 'Tap the corners of the area (or trace it with the Pencil), then Create action.' : 'Tap along the line (or trace it with the Pencil), then Create action.', null, 6000);
  }
  $('ms-action').onclick = function () {
    var c = coords(), area = M.mode === 'area';
    if (c.length < (area ? 3 : 2)) return;
    var r = function (q) { return [Math.round(q[0] * 1e7) / 1e7, Math.round(q[1] * 1e7) / 1e7]; };
    var geom = area ? { type: 'Polygon', coordinates: [c.map(r).concat([r(c[0])])] } : { type: 'LineString', coordinates: c.map(r) };
    close();
    if (GC.camera) GC.camera.newAction({ geom: geom });
  };
  GC.measure = { drawAction: drawAction, click: click, open: open, close: close, isOn: function () { return M.on; }, fmtLen: fmtLen, fmtArea: fmtArea };
})(window);
