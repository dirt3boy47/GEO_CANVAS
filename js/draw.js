/* GeoCanvas web — drawing tools and input.
   Apple Pencil (pointerType "pen") always draws in Draw mode; fingers keep panning and zooming the map
   unless finger drawing is on (then one finger draws and two fingers pan/zoom). Every sample is turned
   into latitude/longitude the moment it arrives, so ink is pinned to the ground, not to the screen. */
(function (global) {
  'use strict';
  var GC = global.GC, Geo = global.Geo, Ink = global.Ink, map = GC.map, $ = GC.$;
  var C = map.getContainer();
  var D2R = Math.PI / 180;

  var INK_TOOLS = ['ballpoint', 'fountain', 'pencil', 'highlighter', 'marker', 'handwriting'];
  var TOOLS = [
    { id: 'ballpoint', label: 'Ballpoint pen' }, { id: 'fountain', label: 'Fountain pen' }, { id: 'pencil', label: 'Pencil' },
    { id: 'highlighter', label: 'Highlighter' }, { id: 'marker', label: 'Marker' }, { id: 'handwriting', label: 'Handwriting' },
    { id: 'eraser', label: 'Eraser' }, { id: 'lasso', label: 'Lasso select' }, { id: 'shapes', label: 'Shapes' },
    { id: 'text', label: 'Text label' }, { id: 'pin', label: 'Marker / symbol' }
  ];
  var SHAPES = [{ id: 'line', label: 'Line' }, { id: 'arrow', label: 'Arrow' }, { id: 'rectangle', label: 'Rectangle' }, { id: 'ellipse', label: 'Ellipse' }, { id: 'polygon', label: 'Freehand polygon' }];
  var SWATCHES = ['#17201c', '#1e63d6', '#e53935', '#2e9e44', '#fb8c00', '#ffe11a', '#ffffff'];
  var PALETTE = ['#000000', '#17201c', '#5c6862', '#9aa8a0', '#ffffff', '#7a4a1e', '#c62828', '#e53935', '#ff7043', '#fb8c00', '#ffb300', '#ffe11a',
    '#c0ca33', '#7cb342', '#2e9e44', '#00897b', '#00acc1', '#29b6f6', '#1e63d6', '#3949ab', '#5e35b1', '#8e24aa', '#d81b60', '#f48fb1'];

  GC.mode = 'nav';
  GC.tool = INK_TOOLS.concat(['eraser', 'lasso', 'shapes', 'text', 'pin']).indexOf(GC.settings.tool) >= 0 ? GC.settings.tool : 'ballpoint';

  function toolCfg(t) {
    var s = GC.settings.tools[t];
    if (!s) { var d = Ink.INKS[t] || { width: t === 'shapes' ? 3 : 4, opacity: 1 }; s = GC.settings.tools[t] = { width: d.width, opacity: d.opacity }; }
    return s;
  }

  // ---------- live overlay canvas (current stroke, lasso, eraser, selection box) ----------
  var live = document.createElement('canvas');
  live.id = 'live';
  live.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:640';
  C.appendChild(live);
  var lctx = live.getContext('2d'), dpr = 1;
  function sizeLive() {
    var s = map.getSize(); dpr = Math.min(3, window.devicePixelRatio || 1);
    live.width = Math.round(s.x * dpr); live.height = Math.round(s.y * dpr); live.style.width = s.x + 'px'; live.style.height = s.y + 'px';
    queueLive();
  }
  map.on('resize', sizeLive); window.addEventListener('resize', function () { map.invalidateSize(); sizeLive(); });
  sizeLive();

  function mercToCP(m) { var ll = Geo.unmerc(m[0], m[1]), p = map.latLngToContainerPoint([ll[1], ll[0]]); return [p.x, p.y]; }
  function llToMerc(ll) { return Geo.merc(ll.lng, ll.lat); }
  function cpToMerc(p) { return llToMerc(map.containerPointToLatLng(L.point(p[0], p[1]))); }
  function unitAtZoom() { return 1 / (256 * Math.pow(2, map.getZoom())); } // mercator units per screen px

  var g = null; // active gesture
  var liveRAF = 0;
  function queueLive() { if (!liveRAF) liveRAF = requestAnimationFrame(drawLive); }
  map.on('move zoom viewreset', queueLive);
  function drawLive() {
    liveRAF = 0;
    lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.clearRect(0, 0, live.width, live.height);
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (g && g.el) { g.el._g = null; try { Ink.draw(lctx, g.el, mercToCP, map.getZoom(), 1); } catch (e) { /* degenerate */ } }
    if (g && g.ring && g.ring.length > 1) {
      lctx.save(); lctx.setLineDash([6, 5]); lctx.lineWidth = 1.6; lctx.strokeStyle = '#0f7a5f'; lctx.fillStyle = 'rgba(15,122,95,0.08)';
      lctx.beginPath(); g.ring.forEach(function (m, i) { var p = mercToCP(m); if (i) lctx.lineTo(p[0], p[1]); else lctx.moveTo(p[0], p[1]); });
      lctx.closePath(); lctx.fill(); lctx.stroke(); lctx.restore();
    }
    if (g && g.tool === 'eraser' && g.last) {
      var c = mercToCP(g.last); lctx.save(); lctx.beginPath(); lctx.arc(c[0], c[1], GC.settings.eraserSize / 2, 0, 2 * Math.PI);
      lctx.fillStyle = 'rgba(255,255,255,0.35)'; lctx.fill(); lctx.lineWidth = 1.5; lctx.strokeStyle = 'rgba(0,0,0,0.6)'; lctx.stroke(); lctx.restore();
    }
    var sb = selectionBox();
    if (sb) {
      var a = sb.px;
      lctx.save(); lctx.setLineDash([5, 4]); lctx.lineWidth = 1.5; lctx.strokeStyle = '#0f7a5f';
      lctx.strokeRect(a[0], a[1], a[2] - a[0], a[3] - a[1]); lctx.setLineDash([]);
      [[a[0], a[1]], [a[2], a[1]], [a[2], a[3]], [a[0], a[3]]].forEach(function (h) { lctx.beginPath(); lctx.arc(h[0], h[1], 7, 0, 2 * Math.PI); lctx.fillStyle = '#fff'; lctx.fill(); lctx.lineWidth = 2; lctx.strokeStyle = '#0f7a5f'; lctx.stroke(); });
      lctx.restore();
    }
  }
  GC.queueLive = queueLive;

  // ---------- selection ----------
  GC.selection = {}; // layerId -> {itemId: true}
  function selCount() { var n = 0; Object.keys(GC.selection).forEach(function (k) { n += Object.keys(GC.selection[k]).length; }); return n; }
  function selItems() {
    var out = [];
    Object.keys(GC.selection).forEach(function (lid) { var l = GC.layerById(lid); if (!l) return; l.items.forEach(function (el) { if (GC.selection[lid][el.id]) out.push({ l: l, el: el }); }); });
    return out;
  }
  function selectionBox() {
    if (!selCount()) return null;
    var b = [Infinity, Infinity, -Infinity, -Infinity], any = false;
    selItems().forEach(function (x) { var m = Ink.mercBounds(x.el); b[0] = Math.min(b[0], m[0]); b[1] = Math.min(b[1], m[1]); b[2] = Math.max(b[2], m[2]); b[3] = Math.max(b[3], m[3]); any = true; });
    if (!any) return null;
    if (g && g.preview) { var p1 = g.preview([b[0], b[1]]).a, p2 = g.preview([b[2], b[3]]).a; b = [p1[0], p1[1], p2[0], p2[1]]; }
    var a = mercToCP([b[0], b[1]]), c = mercToCP([b[2], b[3]]);
    var px = [Math.min(a[0], c[0]) - 8, Math.min(a[1], c[1]) - 8, Math.max(a[0], c[0]) + 8, Math.max(a[1], c[1]) + 8];
    return { merc: b, px: px };
  }
  GC.setSelection = function (sel) {
    GC.selection = sel || {};
    Object.keys(GC.selection).forEach(function (k) { if (!Object.keys(GC.selection[k]).length) delete GC.selection[k]; });
    var n = selCount();
    $('selbar').hidden = !n;
    $('sel-count').textContent = n + (n === 1 ? ' item' : ' items');
    $('sel-layer').value = '';
    queueLive();
  };
  GC.clearSelection = function () { if (selCount()) GC.setSelection({}); };
  function setPreview(fn) {
    selItems().forEach(function (x) {
      var v = GC.views[x.l.id]; if (!v) return;
      var p = v.paths[x.el.id];
      if (p) { p.preview = fn; p.redraw(); }
      var mk = v.markers[x.el.id];
      if (mk) { var m = Geo.merc(x.el.at[0], x.el.at[1]); var t = fn ? fn(m).a : m; var ll = Geo.unmerc(t[0], t[1]); mk.setLatLng([ll[1], ll[0]]); }
    });
  }
  function transformSelection(f) {
    var changes = [];
    Object.keys(GC.selection).forEach(function (lid) {
      var l = GC.layerById(lid); if (!l) return;
      var ids = GC.selection[lid], before = l.items;
      changes.push({ lid: lid, before: before, after: before.map(function (el) { return ids[el.id] ? f(el) : el; }) });
    });
    GC.commit(changes); queueLive();
  }
  GC.deleteSelection = function () {
    if (!selCount()) return false;
    var changes = Object.keys(GC.selection).map(function (lid) { var l = GC.layerById(lid), ids = GC.selection[lid]; return { lid: lid, before: l.items, after: l.items.filter(function (el) { return !ids[el.id]; }) }; });
    var n = selCount(); GC.setSelection({}); GC.commit(changes); GC.toast(n + (n === 1 ? ' item' : ' items') + ' deleted. Undo is available.');
    return true;
  };
  $('sel-del').onclick = GC.deleteSelection;
  $('sel-clear').onclick = GC.clearSelection;
  $('sel-dup').onclick = function () {
    var off = 18 * unitAtZoom(), newSel = {}, changes = [];
    Object.keys(GC.selection).forEach(function (lid) {
      var l = GC.layerById(lid), ids = GC.selection[lid], copies = [], groups = {};
      l.items.forEach(function (el) { if (!ids[el.id]) return; var c = Ink.translate(el, off, off); c.id = Ink.uid(); c.created = Date.now(); if (c.group) { groups[c.group] = groups[c.group] || Ink.uid(); c.group = groups[c.group]; } copies.push(c); });
      newSel[lid] = {}; copies.forEach(function (c) { newSel[lid][c.id] = true; });
      changes.push({ lid: lid, before: l.items, after: l.items.concat(copies) });
    });
    GC.commit(changes); GC.setSelection(newSel);
  };
  $('sel-layer').onchange = function () {
    var target = GC.layerById($('sel-layer').value); if (!target) return;
    if (target.locked) { GC.toast('“' + target.name + '” is locked.', 'warn'); $('sel-layer').value = ''; return; }
    var moved = [], changes = [];
    Object.keys(GC.selection).forEach(function (lid) {
      if (lid === target.id) return;
      var l = GC.layerById(lid), ids = GC.selection[lid];
      l.items.forEach(function (el) { if (ids[el.id]) moved.push(el); });
      changes.push({ lid: lid, before: l.items, after: l.items.filter(function (el) { return !ids[el.id]; }) });
    });
    if (moved.length) changes.push({ lid: target.id, before: target.items, after: target.items.concat(moved) });
    var sel = {}; sel[target.id] = {}; Object.keys(GC.selection[target.id] || {}).forEach(function (id) { sel[target.id][id] = true; }); moved.forEach(function (el) { sel[target.id][el.id] = true; });
    GC.commit(changes); GC.setSelection(sel);
    GC.toast('Moved to “' + target.name + '”.');
  };
  $('sel-color').onclick = function (e) { e.stopPropagation(); openColors(true, $('sel-color')); };

  // ---------- target layers ----------
  function activeLayer(silent) {
    var p = GC.project, l = GC.layerById(p.activeLayer);
    if (!l || l.kind !== 'drawing') {
      var ds = GC.drawingLayers();
      l = ds.filter(function (x) { return !x.locked; }).pop();
      if (!l) { l = GC.newDrawingLayer('Annotations'); GC.insertLayer(l, true); }
      p.activeLayer = l.id; GC.refreshLayers();
    }
    if (l.locked) { if (!silent) GC.toast('“' + l.name + '” is locked. Unlock it in the Layers panel or choose another layer in the toolbar.', 'warn'); return null; }
    if (!l.visible) { l.visible = true; GC.applyLayerState(); GC.refreshLayers(); GC.toast('“' + l.name + '” was hidden and is now shown.'); }
    return l;
  }
  function editableLayers() { return GC.drawingLayers().filter(function (l) { return l.visible && !l.locked; }); }

  // ---------- input ----------
  function inMap(e) {
    var t = e.target;
    if (!C.contains(t)) return false;
    return !(t.closest && t.closest('.leaflet-control'));
  }
  function samplePoint(e) {
    var r = C.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  function penData(e) {
    var p = -1, alt = Math.PI / 2, az = 0;
    if (e.pointerType === 'pen') {
      p = e.pressure > 0 ? e.pressure : 0.35;
      if (typeof e.altitudeAngle === 'number') { alt = e.altitudeAngle; az = e.azimuthAngle || 0; }
      else if (e.tiltX || e.tiltY) {
        var tx = Math.tan((e.tiltX || 0) * D2R), ty = Math.tan((e.tiltY || 0) * D2R);
        alt = Math.atan(1 / Math.sqrt(tx * tx + ty * ty)); az = Math.atan2(ty, tx);
      }
    } else if (e.force) { p = Math.min(1, e.force); }
    return [p, alt, az];
  }

  var fingers = {}, pinch = null;
  function fingerCount() { return Object.keys(fingers).length; }
  /** True while a pen/finger gesture or pinch is in progress (cloud sync waits for it). */
  GC.gestureActive = function () { return !!g || !!pinch; };

  function onDown(e) {
    if (GC.mode !== 'draw' || !inMap(e)) return;
    var type = e.pointerType;
    if (g && g.type === 'pen' && type !== 'pen') { e.stopPropagation(); e.preventDefault(); return; } // palm rejection
    if (type === 'touch' && !GC.settings.fingerDraw) return; // let Leaflet pan/zoom
    if (type === 'mouse' && e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    if (type === 'touch') {
      fingers[e.pointerId] = samplePoint(e);
      if (fingerCount() === 2) { if (g) cancelGesture(); startPinch(); return; }
      if (fingerCount() > 2 || pinch) return;
    } else if (g) return;
    begin(e);
  }
  function onMove(e) {
    if (GC.mode === 'draw' && (e.pointerType === 'pen' || e.pointerType === 'mouse') && !g && inMap(e)) GC.setHover(map.containerPointToLatLng(L.point(samplePoint(e))));
    if (fingers[e.pointerId]) { fingers[e.pointerId] = samplePoint(e); if (pinch) { e.stopPropagation(); e.preventDefault(); movePinch(); return; } }
    if (!g || e.pointerId !== g.id) { if (g && g.type === 'pen' && e.pointerType === 'touch') e.stopPropagation(); return; }
    e.stopPropagation(); e.preventDefault();
    var evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    if (!evs.length) evs = [e];
    evs.forEach(function (ev) { extend(samplePoint(ev), penData(ev), ev); });
    queueLive();
  }
  function onUp(e) {
    if (fingers[e.pointerId]) { delete fingers[e.pointerId]; if (pinch) { e.stopPropagation(); if (fingerCount() < 2) endPinch(); return; } }
    if (!g || e.pointerId !== g.id) { if (g && g.type === 'pen' && e.pointerType === 'touch') e.stopPropagation(); return; }
    e.stopPropagation(); e.preventDefault();
    if (e.type === 'pointercancel') { cancelGesture(); return; }
    finish(samplePoint(e));
  }
  if (window.PointerEvent) {
    window.addEventListener('pointerdown', onDown, { capture: true, passive: false });
    window.addEventListener('pointermove', onMove, { capture: true, passive: false });
    window.addEventListener('pointerup', onUp, { capture: true, passive: false });
    window.addEventListener('pointercancel', onUp, { capture: true, passive: false });
    // Stop Safari's compatibility mouse/touch events from reaching Leaflet while the Pencil draws.
    ['touchstart', 'touchmove', 'mousedown'].forEach(function (t) {
      window.addEventListener(t, function (e) {
        if (GC.mode !== 'draw' || !inMap(e)) return;
        var stylus = e.touches && Array.prototype.some.call(e.touches, function (x) { return x.touchType === 'stylus'; });
        if (g || stylus || (e.type === 'mousedown' && !('ontouchstart' in window)) || (GC.settings.fingerDraw && e.touches)) { e.stopPropagation(); if (e.cancelable && (g || stylus)) e.preventDefault(); }
      }, { capture: true, passive: false });
    });
  } else {
    // iOS 12 Safari has no Pointer Events: translate touch events (touchType "stylus" = Apple Pencil).
    var fake = function (t, type) { return { pointerId: t.identifier, pointerType: t.touchType === 'stylus' ? 'pen' : 'touch', clientX: t.clientX, clientY: t.clientY, pressure: t.force || 0.5, altitudeAngle: t.altitudeAngle, azimuthAngle: t.azimuthAngle, target: t.target, type: type, button: 0, timeStamp: Date.now(), stopPropagation: function () {}, preventDefault: function () {} }; };
    var wrap = function (fn, type) { return function (e) { if (GC.mode !== 'draw') return; var handled = false; Array.prototype.forEach.call(e.changedTouches, function (t) { var f = fake(t, type); f.stopPropagation = function () { handled = true; }; fn(f); }); if (handled) { e.stopPropagation(); if (e.cancelable) e.preventDefault(); } }; };
    window.addEventListener('touchstart', wrap(onDown, 'pointerdown'), { capture: true, passive: false });
    window.addEventListener('touchmove', wrap(onMove, 'pointermove'), { capture: true, passive: false });
    window.addEventListener('touchend', wrap(onUp, 'pointerup'), { capture: true, passive: false });
    window.addEventListener('touchcancel', wrap(onUp, 'pointercancel'), { capture: true, passive: false });
  }
  C.addEventListener('mouseleave', function () { GC.setHover(null); });

  // Two-finger pan/zoom while finger drawing is on.
  function startPinch() {
    var ids = Object.keys(fingers), a = fingers[ids[0]], b = fingers[ids[1]];
    var mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    pinch = { d0: Math.max(10, Math.hypot(a[0] - b[0], a[1] - b[1])), z0: map.getZoom(), ll: map.containerPointToLatLng(L.point(mid)), snap: map.options.zoomSnap };
    map.options.zoomSnap = 0;
  }
  function movePinch() {
    var ids = Object.keys(fingers); if (ids.length < 2) return;
    var a = fingers[ids[0]], b = fingers[ids[1]], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    var z = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), pinch.z0 + Math.log(Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d0) / Math.LN2));
    var s = map.getSize(), p = map.project(pinch.ll, z), c = p.subtract(L.point(mid[0] - s.x / 2, mid[1] - s.y / 2));
    map.setView(map.unproject(c, z), z, { animate: false });
  }
  function endPinch() { map.options.zoomSnap = pinch.snap; pinch = null; fingers = {}; map.setZoom(Math.round(map.getZoom() * 4) / 4, { animate: false }); }

  function begin(e) {
    var tool = GC.tool, cp = samplePoint(e), m = cpToMerc(cp), z = map.getZoom();
    g = { id: e.pointerId, type: e.pointerType, tool: tool, start: cp, startM: m, last: m, cps: [cp], moved: false, t0: Date.now() };
    closePops();
    if (INK_TOOLS.indexOf(tool) >= 0) {
      var l = activeLayer(); if (!l) { g = null; return; }
      var cfg = toolCfg(tool);
      g.layer = l;
      g.el = { id: Ink.uid(), type: 'stroke', ink: tool, color: GC.settings.color, width: cfg.width, opacity: cfg.opacity, z0: z, pts: [], created: Date.now() };
      extend(cp, penData(e), e);
    } else if (tool === 'shapes') {
      var sl = activeLayer(); if (!sl) { g = null; return; }
      g.layer = sl;
    } else if (tool === 'eraser') {
      g.layers = editableLayers(); g.before = {}; g.layers.forEach(function (x) { g.before[x.id] = x.items; });
      eraseTo(m);
    } else if (tool === 'lasso') {
      var sb = selectionBox();
      if (sb) {
        var a = sb.px, corners = [[a[0], a[1], a[2], a[3]], [a[2], a[1], a[0], a[3]], [a[2], a[3], a[0], a[1]], [a[0], a[3], a[2], a[1]]];
        for (var i = 0; i < 4; i++) if (Math.hypot(cp[0] - corners[i][0], cp[1] - corners[i][1]) < 26) { g.op = 'scale'; g.anchorPx = [corners[i][2], corners[i][3]]; g.cornerPx = [corners[i][0], corners[i][1]]; g.anchorM = cpToMerc(g.anchorPx); break; }
        if (!g.op && cp[0] >= a[0] && cp[0] <= a[2] && cp[1] >= a[1] && cp[1] <= a[3]) g.op = 'move';
      }
      if (!g.op) { g.op = 'lasso'; g.ring = [m]; }
    }
    queueLive();
  }

  function extend(cp, pd, ev) {
    if (!g) return;
    var m = cpToMerc(cp), last = g.cps[g.cps.length - 1];
    if (Math.hypot(cp[0] - g.start[0], cp[1] - g.start[1]) > 3) g.moved = true;
    var tool = g.tool;
    if (g.el && g.el.type === 'stroke') {
      if (g.el.pts.length && Math.hypot(cp[0] - last[0], cp[1] - last[1]) < 0.4) return;
      var ll = Geo.unmerc(m[0], m[1]);
      g.el.pts.push([ll[0], ll[1], pd[0], pd[1], pd[2]]);
    } else if (tool === 'shapes') {
      g.cur = cp; g.el = shapeFrom(g);
    } else if (tool === 'eraser') {
      eraseTo(m);
    } else if (tool === 'lasso') {
      if (g.op === 'lasso') g.ring.push(m);
      else if (g.op === 'move') { var dx = m[0] - g.startM[0], dy = m[1] - g.startM[1]; g.preview = function (a) { return { a: [a[0] + dx, a[1] + dy], k: 1 }; }; setPreview(g.preview); }
      else if (g.op === 'scale') {
        var d0 = Math.hypot(g.cornerPx[0] - g.anchorPx[0], g.cornerPx[1] - g.anchorPx[1]) || 1, d1 = Math.hypot(cp[0] - g.anchorPx[0], cp[1] - g.anchorPx[1]);
        var k = Math.max(0.05, d1 / d0), ax = g.anchorM[0], ay = g.anchorM[1];
        g.k = k; g.preview = function (a) { return { a: [ax + (a[0] - ax) * k, ay + (a[1] - ay) * k], k: k }; }; setPreview(g.preview);
      }
    }
    g.cps.push(cp); g.last = m;
  }

  function shapeFrom(gs) {
    var kind = GC.settings.shapeKind, a = gs.start, b = gs.cur || gs.start, verts;
    var toLL = function (p) { var ll = map.containerPointToLatLng(L.point(p[0], p[1])); return [ll.lng, ll.lat]; };
    if (kind === 'line' || kind === 'arrow') verts = [a, b];
    else if (kind === 'rectangle' || kind === 'ellipse') verts = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
    else verts = Ink.simplify(gs.cps.concat([b]), 2.2);
    var cfg = toolCfg('shapes');
    return { id: gs.shapeId || (gs.shapeId = Ink.uid()), type: 'shape', kind: kind, verts: verts.map(toLL), color: GC.settings.color, width: cfg.width, opacity: cfg.opacity,
      fill: GC.settings.fill, dashed: GC.settings.dashed, z0: map.getZoom(), created: Date.now() };
  }

  function eraseTo(m) {
    var r = GC.settings.eraserSize / 2 * unitAtZoom(), path = [g.last || m, m];
    g.layers.forEach(function (l) {
      var res = Ink.erase(l.items, path, r, GC.settings.eraserMode);
      if (!res.removed.length) return;
      var gone = {}; res.removed.forEach(function (x) { gone[x.id] = true; });
      // Erasing one word of handwriting removes only that stroke (groups stay for lasso selection).
      l.items = l.items.filter(function (x) { return !gone[x.id]; }).concat(res.added);
      GC.syncDrawing(l);
    });
  }

  function finish(cp) {
    var gs = g; if (!gs) return;
    extend(cp, [gs.el && gs.el.pts && gs.el.pts.length ? gs.el.pts[gs.el.pts.length - 1][2] : -1, Math.PI / 2, 0]);
    g = null;
    var tool = gs.tool;
    if (INK_TOOLS.indexOf(tool) >= 0 && gs.el && gs.el.pts.length) {
      var el = gs.el; delete el._g;
      if (tool === 'handwriting') groupHandwriting(gs.layer, el);
      GC.editLayer(gs.layer.id, function (items) { items.push(el); return items; });
    } else if (tool === 'shapes' && gs.moved) {
      var s = shapeFrom(gs); if (s.kind === 'polygon' && s.verts.length < 3) s = null;
      if (s) GC.editLayer(gs.layer.id, function (items) { items.push(s); return items; });
    } else if (tool === 'eraser') {
      GC.commit(gs.layers.map(function (l) { return { lid: l.id, before: gs.before[l.id], after: l.items }; }));
    } else if (tool === 'lasso') {
      if (gs.op === 'lasso') {
        if (!gs.moved) tapSelect(gs.start);
        else {
          var sel = {};
          editableLayers().forEach(function (l) { var s2 = Ink.lasso(l.items, gs.ring); if (Object.keys(s2).length) sel[l.id] = s2; });
          GC.setSelection(sel);
          if (!Object.keys(sel).length) GC.toast('Nothing selected. Circle drawn items on visible, unlocked layers.');
        }
      } else if (gs.op === 'move') {
        setPreview(null);
        if (gs.moved) { var dx = gs.last[0] - gs.startM[0], dy = gs.last[1] - gs.startM[1]; transformSelection(function (el) { return Ink.translate(el, dx, dy); }); }
        else tapSelect(gs.start);
      } else if (gs.op === 'scale') {
        setPreview(null);
        if (gs.k && Math.abs(gs.k - 1) > 1e-3) { var ax = gs.anchorM[0], ay = gs.anchorM[1], k = gs.k; transformSelection(function (el) { return Ink.scale(el, ax, ay, k); }); }
      }
    } else if (tool === 'text' && !gs.moved) {
      placeText(gs.startM);
    } else if (tool === 'pin' && !gs.moved) {
      placeMarker(gs.startM);
    }
    queueLive();
  }
  function cancelGesture() {
    if (!g) return;
    if (g.tool === 'eraser') g.layers.forEach(function (l) { l.items = g.before[l.id]; GC.syncDrawing(l); });
    if (g.tool === 'lasso') setPreview(null);
    g = null; queueLive();
  }

  var lastHW = null;
  function groupHandwriting(l, el) {
    var b = Ink.mercBounds(el), u = unitAtZoom() * 60, now = Date.now();
    if (lastHW && lastHW.lid === l.id && now - lastHW.t < 1800) {
      var p = lastHW.b;
      if (b[0] < p[2] + u && b[2] > p[0] - u && b[1] < p[3] + u && b[3] > p[1] - u) { el.group = lastHW.group; lastHW.b = [Math.min(p[0], b[0]), Math.min(p[1], b[1]), Math.max(p[2], b[2]), Math.max(p[3], b[3])]; lastHW.t = now; return; }
    }
    el.group = Ink.uid(); lastHW = { lid: l.id, group: el.group, b: b, t: now };
  }

  /** Item of one drawing layer under a screen point (topmost first). */
  function hitItem(l, cp) {
    var m = cpToMerc(cp), tol = 12 * unitAtZoom(), items = l.items;
    for (var j = items.length - 1; j >= 0; j--) {
      var el = items[j], b = Ink.mercBounds(el);
      if (m[0] < b[0] - tol || m[0] > b[2] + tol || m[1] < b[1] - tol || m[1] > b[3] + tol) continue;
      if (el.type === 'text' || el.type === 'marker') return el;
      var pts = Ink.mercPoints(el), w = el.width / (256 * Math.pow(2, el.z0)) / 2;
      if (el.type === 'shape' && Ink.isClosed(el)) { pts = pts.concat([pts[0]]); if (el.fill && Ink.inPoly(pts, m)) return el; }
      if (Ink.distToLine(m, pts) <= tol + w) return el;
    }
    return null;
  }
  GC.hitItem = hitItem;
  /** Item under a screen point on visible drawing layers (topmost layer first). */
  function hitTest(cp, editableOnly) {
    var ls = (editableOnly ? editableLayers() : GC.drawingLayers().filter(function (l) { return l.visible; })).slice().reverse();
    for (var i = 0; i < ls.length; i++) { var el = hitItem(ls[i], cp); if (el) return { l: ls[i], el: el }; }
    return null;
  }
  GC.hitTest = hitTest;
  function tapSelect(cp) {
    var h = hitTest(cp, true);
    if (!h) { GC.clearSelection(); return; }
    var sel = {}; sel[h.l.id] = {}; sel[h.l.id][h.el.id] = true;
    if (h.el.group) h.l.items.forEach(function (x) { if (x.group === h.el.group) sel[h.l.id][x.id] = true; });
    GC.setSelection(sel);
  }
  // In Navigate mode a tap on drawn ink or a GIS feature opens its tap card.
  map.on('click', function (e) {
    if (GC.mode === 'draw') return;
    if (GC.georef && GC.georef.click(e)) return; // placing a plan: taps are control points
    if (GC.measure && GC.measure.click(e)) return; // measuring: taps add points
    GC.pickAt(e);
  });

  function placeText(m, existing) {
    var l = existing ? existing.l : activeLayer(); if (!l) return;
    GC.prompt(existing ? 'Edit text label' : 'Text label', existing ? existing.el.text : '', 'e.g. Culvert blocked', existing ? 'Save' : 'Place').then(function (txt) {
      if (!txt) return;
      if (existing) { GC.editLayer(l.id, function (items) { return items.map(function (x) { if (x.id !== existing.el.id) return x; var c = Ink.stripCache(x); c = JSON.parse(JSON.stringify(c)); c.text = txt; return c; }); }); return; }
      var ll = Geo.unmerc(m[0], m[1]);
      var el = { id: Ink.uid(), type: 'text', at: [ll[0], ll[1]], text: txt, size: GC.settings.textSize, color: GC.settings.color, opacity: 1, z0: map.getZoom(), created: Date.now() };
      GC.editLayer(l.id, function (items) { items.push(el); return items; });
    });
  }
  GC.editText = function (l, el) { placeText(null, { l: l, el: el }); };

  function placeMarker(m, existing) {
    var l = existing ? existing.l : activeLayer(); if (!l) return;
    var cur = existing ? existing.el : { symbol: GC.settings.symbol || 'pin', color: GC.settings.color === '#ffffff' ? '#e53935' : GC.settings.color, title: '', note: '' };
    var sym = cur.symbol, color = cur.color, photos = (cur.photos || []).slice();
    var html = '<h2>' + (existing ? 'Edit marker' : 'New marker') + '</h2>' +
      '<div id="mk-syms" style="display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 10px">' + Object.keys(GC.SYMBOLS).map(function (k) { return '<button class="btn" data-s="' + k + '" title="' + GC.SYMBOLS[k].label + '" style="padding:6px;width:46px;height:46px">' + GC.symbolSVG(k, color) + '</button>'; }).join('') + '</div>' +
      '<label class="custom" style="margin:0 0 8px">Colour <input type="color" id="mk-color" value="' + color + '"></label>' +
      '<label class="field" style="margin:8px 0">Name<input type="text" id="mk-title" value="' + GC.esc(cur.title || '') + '" placeholder="e.g. Sample site 4"></label>' +
      '<label class="field" style="margin:8px 0">Note<textarea id="mk-note" rows="4" placeholder="Observations…">' + GC.esc(cur.note || '') + '</textarea></label>' +
      '<div class="field" style="margin:8px 0">Photos<div id="mk-photos"></div></div>' +
      '<div class="actions"><button class="btn" data-a="no">Cancel</button><button class="btn primary" data-a="ok">' + (existing ? 'Save' : 'Place marker') + '</button></div>';
    GC.modal(html, function (el, close) {
      var paint = function () { Array.prototype.forEach.call(el.querySelectorAll('[data-s]'), function (b) { var k = b.getAttribute('data-s'); b.innerHTML = GC.symbolSVG(k, color); b.style.boxShadow = k === sym ? '0 0 0 2.5px var(--accent)' : ''; }); };
      paint();
      var paintPhotos = function () {
        GC.photos.strip(el.querySelector('#mk-photos'), photos, {
          onAdd: function () { GC.photos.pick().then(function (refs) { if (refs.length) { photos = photos.concat(refs); if (sym === 'pin' && !existing && photos.length === refs.length) { sym = 'camera'; paint(); } paintPhotos(); } }); },
          onChange: function (left) { photos = left; paintPhotos(); }
        });
      };
      paintPhotos();
      el.querySelector('#mk-syms').onclick = function (e) { var b = e.target.closest('[data-s]'); if (b) { sym = b.getAttribute('data-s'); paint(); } };
      el.querySelector('#mk-color').oninput = function () { color = el.querySelector('#mk-color').value; paint(); };
      el.querySelector('[data-a=no]').onclick = close;
      el.querySelector('[data-a=ok]').onclick = function () {
        var title = el.querySelector('#mk-title').value.trim(), note = el.querySelector('#mk-note').value.trim();
        GC.settings.symbol = sym; GC.saveSettings(); close();
        if (existing) { GC.editLayer(l.id, function (items) { return items.map(function (x) { if (x.id !== existing.el.id) return x; var c = JSON.parse(JSON.stringify(Ink.stripCache(x))); c.symbol = sym; c.color = color; c.title = title; c.note = note; if (photos.length) c.photos = photos; else delete c.photos; return c; }); }); return; }
        var ll = Geo.unmerc(m[0], m[1]);
        var mk = { id: Ink.uid(), type: 'marker', at: [ll[0], ll[1]], symbol: sym, color: color, title: title, note: note, created: Date.now() };
        if (photos.length) mk.photos = photos;
        GC.editLayer(l.id, function (items) { items.push(mk); return items; });
      };
    });
  }
  GC.editMarker = function (l, el) { placeMarker(null, { l: l, el: el }); };

  // ---------- toolbar ----------
  function iconFor(t) { return t === 'shapes' ? GC.settings.shapeKind : t; }
  function buildTools() {
    $('tools').innerHTML = TOOLS.map(function (t) {
      return '<button class="tool' + (t.id === GC.tool ? ' on' : '') + '" data-tool="' + t.id + '" title="' + t.label + '" aria-label="' + t.label + '">' + GC.icon(iconFor(t.id)) + '<i></i></button>';
    }).join('');
    Array.prototype.forEach.call($('tools').querySelectorAll('.tool i'), function (i) { i.style.color = GC.settings.color; });
  }
  function setTool(t) {
    if (t !== 'lasso') GC.clearSelection();
    GC.tool = t; GC.settings.tool = t; GC.saveSettings(); buildTools(); updateWidthPreview();
  }
  $('tools').addEventListener('click', function (e) {
    var b = e.target.closest('.tool'); if (!b) return;
    e.stopPropagation();
    var t = b.getAttribute('data-tool');
    if (t === 'shapes') { setTool('shapes'); openShapes(); return; }
    if (t === GC.tool && t !== 'lasso' && t !== 'text' && t !== 'pin') { openWidth(); return; }
    setTool(t);
  });
  function buildSwatches() {
    $('swatches').innerHTML = SWATCHES.map(function (c) { return '<button class="swatch' + (c === GC.settings.color ? ' on' : '') + '" data-c="' + c + '" style="background:' + c + '" aria-label="Colour ' + c + '"></button>'; }).join('');
    $('cur-color').style.background = GC.settings.color;
  }
  function setColor(c, forSelection) {
    if (forSelection) { transformSelection(function (el) { var x = JSON.parse(JSON.stringify(Ink.stripCache(el))); x.color = c; return x; }); }
    else { GC.settings.color = c; }
    GC.settings.recent = [c].concat(GC.settings.recent.filter(function (x) { return x !== c; })).slice(0, 8);
    GC.saveSettings(); buildSwatches(); buildTools(); updateWidthPreview();
  }
  $('swatches').addEventListener('click', function (e) { var b = e.target.closest('.swatch'); if (b) setColor(b.getAttribute('data-c'), false); });

  // ---------- popovers ----------
  var pops = ['popover-width', 'popover-colors', 'popover-shapes'];
  function closePops(except) { pops.forEach(function (id) { if (id !== except) $(id).hidden = true; }); }
  GC.closePops = closePops;
  function placePop(pop, anchor) {
    pop.hidden = false;
    var r = anchor.getBoundingClientRect(), w = pop.offsetWidth, x = Math.max(10, Math.min(window.innerWidth - w - 10, r.left + r.width / 2 - w / 2));
    pop.style.left = x + 'px';
    if (r.top > window.innerHeight / 2) { pop.style.top = ''; pop.style.bottom = (window.innerHeight - r.top + 10) + 'px'; }
    else { pop.style.bottom = ''; pop.style.top = (r.bottom + 10) + 'px'; }
  }
  document.addEventListener('pointerdown', function (e) {
    if (e.target.closest && (e.target.closest('.pop') || e.target.closest('#toolbar') || e.target.closest('#selbar'))) return;
    closePops();
  }, true);

  var colorTarget = false;
  function openColors(forSelection, anchor) {
    colorTarget = forSelection;
    $('palette').innerHTML = PALETTE.map(function (c) { return '<button class="swatch" data-c="' + c + '" style="background:' + c + '"></button>'; }).join('');
    $('recent').innerHTML = GC.settings.recent.length ? GC.settings.recent.map(function (c) { return '<button class="swatch" data-c="' + c + '" style="background:' + c + '"></button>'; }).join('') : '<span class="hint" style="grid-column:1/-1;margin:0">None yet</span>';
    $('custom-color').value = GC.settings.color;
    closePops('popover-colors'); placePop($('popover-colors'), anchor || $('btn-colors'));
  }
  $('btn-colors').onclick = function (e) { e.stopPropagation(); if (!$('popover-colors').hidden) { closePops(); return; } openColors(false); };
  $('popover-colors').addEventListener('click', function (e) { var b = e.target.closest('.swatch'); if (b) { setColor(b.getAttribute('data-c'), colorTarget); closePops(); } });
  $('custom-color').onchange = function () { setColor($('custom-color').value, colorTarget); };

  function openShapes() {
    $('shape-tools').innerHTML = SHAPES.map(function (s) { return '<button class="tool' + (s.id === GC.settings.shapeKind ? ' on' : '') + '" data-shape="' + s.id + '" title="' + s.label + '">' + GC.icon(s.id) + '<i></i></button>'; }).join('') +
      '<button class="tool" data-shape="__opts" title="Shape options">' + GC.icon('more') + '<i></i></button>';
    closePops('popover-shapes'); placePop($('popover-shapes'), $('tools').querySelector('[data-tool=shapes]'));
  }
  $('popover-shapes').addEventListener('click', function (e) {
    var b = e.target.closest('[data-shape]'); if (!b) return;
    var s = b.getAttribute('data-shape');
    if (s === '__opts') { openWidth(); return; }
    GC.settings.shapeKind = s; GC.saveSettings(); buildTools(); closePops();
  });

  function updateWidthPreview() {
    var t = GC.tool, line = $('width-line');
    if (t === 'eraser') { line.style.height = '14px'; line.style.width = '14px'; line.style.borderRadius = '50%'; line.style.background = 'transparent'; line.style.border = '2px solid currentColor'; return; }
    line.style.border = ''; line.style.borderRadius = '6px'; line.style.width = '32px';
    var cfg = toolCfg(INK_TOOLS.indexOf(t) >= 0 ? t : 'shapes');
    line.style.height = Math.max(2, Math.min(20, cfg.width)) + 'px';
    line.style.background = GC.settings.color; line.style.opacity = cfg.opacity;
  }
  function openWidth() {
    var t = GC.tool, isInk = INK_TOOLS.indexOf(t) >= 0, isEr = t === 'eraser', key = isInk ? t : 'shapes', cfg = toolCfg(key);
    var range = isInk ? Ink.INKS[t].range : (isEr ? [6, 80] : [0.5, 16]);
    $('width-title').textContent = isInk ? Ink.INKS[t].label : (isEr ? 'Eraser' : (t === 'text' ? 'Text' : 'Shapes'));
    var wr = $('width-range'); wr.min = range[0]; wr.max = range[1]; wr.step = range[1] > 30 ? 1 : 0.5;
    wr.value = isEr ? GC.settings.eraserSize : cfg.width; $('width-val').textContent = wr.value + ' px';
    $('op-range').value = Math.round(cfg.opacity * 100); $('op-val').textContent = $('op-range').value + '%';
    $('op-range').parentNode.hidden = isEr || t === 'text';
    wr.parentNode.hidden = t === 'text' || t === 'pin';
    $('text-size-row').hidden = t !== 'text'; $('ts-range').value = GC.settings.textSize; $('ts-val').textContent = GC.settings.textSize + ' px';
    $('eraser-row').hidden = !isEr;
    Array.prototype.forEach.call($('eraser-row').querySelectorAll('button'), function (b) { b.classList.toggle('on', b.getAttribute('data-er') === GC.settings.eraserMode); });
    $('shape-row').hidden = t !== 'shapes'; $('shape-fill').checked = GC.settings.fill; $('shape-dash').checked = GC.settings.dashed;
    $('ink-hint').textContent = isInk ? 'Thickness is in screen pixels at the zoom you draw at — zoom in and ink grows with the map, like ink on a paper map. Pencil pressure and tilt shape the line.' :
      (isEr ? 'Whole object removes any stroke you touch; Precision cuts strokes where you rub.' : '');
    closePops('popover-width'); placePop($('popover-width'), $('btn-width'));
  }
  $('btn-width').onclick = function (e) { e.stopPropagation(); if (!$('popover-width').hidden) { closePops(); return; } openWidth(); };
  $('width-range').oninput = function () {
    var v = +$('width-range').value; $('width-val').textContent = v + ' px';
    if (GC.tool === 'eraser') GC.settings.eraserSize = v; else toolCfg(INK_TOOLS.indexOf(GC.tool) >= 0 ? GC.tool : 'shapes').width = v;
    GC.saveSettings(); updateWidthPreview();
  };
  $('op-range').oninput = function () { var v = +$('op-range').value; $('op-val').textContent = v + '%'; toolCfg(INK_TOOLS.indexOf(GC.tool) >= 0 ? GC.tool : 'shapes').opacity = v / 100; GC.saveSettings(); updateWidthPreview(); };
  $('ts-range').oninput = function () { GC.settings.textSize = +$('ts-range').value; $('ts-val').textContent = GC.settings.textSize + ' px'; GC.saveSettings(); };
  $('eraser-row').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; GC.settings.eraserMode = b.getAttribute('data-er'); GC.saveSettings(); openWidth(); });
  $('shape-fill').onchange = function () { GC.settings.fill = $('shape-fill').checked; GC.saveSettings(); };
  $('shape-dash').onchange = function () { GC.settings.dashed = $('shape-dash').checked; GC.saveSettings(); };

  // ---------- modes ----------
  GC.setMode = function (m) {
    if (g) cancelGesture();
    if (m === 'draw' && GC.measure && GC.measure.isOn()) GC.measure.close();
    GC.mode = m;
    document.body.classList.toggle('draw', m === 'draw');
    $('mode-nav').classList.toggle('on', m === 'nav'); $('mode-draw').classList.toggle('on', m === 'draw');
    $('toolbar').hidden = m !== 'draw';
    $('crosshair').hidden = !GC.settings.crosshair;
    C.classList.toggle('drawing', m === 'draw');
    if (m === 'nav') { closePops(); GC.clearSelection(); GC.setHover(null); }
    else if (GC.project) activeLayer(true);
  };
  $('mode-nav').onclick = function () { GC.setMode('nav'); };
  $('mode-draw').onclick = function () { GC.setMode('draw'); };
  $('btn-done').onclick = function () { GC.setMode('nav'); };

  buildTools(); buildSwatches(); updateWidthPreview();
})(window);
