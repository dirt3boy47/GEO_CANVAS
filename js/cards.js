/* GeoCanvas web — tap cards, "Go" guidance and searching your own data.
   Everything you can tap (GIS features, drawings, markers, waypoints, GPS tracks, lots, geology results) opens the same
   card: a title, what it is, its details, and one action bar — Go · Measure · Photo · Note · Copy · More.
   Go guides you from your GPS position to the thing (its nearest point for a line or an area) with a live distance,
   bearing and turn hint, and says when you are within 5 m. Search finds features, markers and waypoints in the project. */
(function (global) {
  'use strict';
  var GC = global.GC, Geo = global.Geo, map = GC.map, $ = GC.$, esc = GC.esc;

  // ---------- geometry helpers ----------
  function pt(ll) { return ll && ll.lng != null ? [ll.lng, ll.lat] : ll; }
  /** Nearest point of a GeoJSON geometry to [lon, lat]: {p: [lon, lat], d: metres, inside: bool}. */
  function nearest(g, from) {
    var lat0 = from[1] * Math.PI / 180, kx = 111320 * Math.cos(lat0), ky = 110540;
    var P = function (c) { return [(c[0] - from[0]) * kx, (c[1] - from[1]) * ky]; }, U = function (x, y) { return [from[0] + x / kx, from[1] + y / ky]; };
    var best = null, consider = function (x, y) { var d = Math.sqrt(x * x + y * y); if (!best || d < best.d) best = { p: U(x, y), d: d }; };
    var seg = function (a, b) {
      var A = P(a), B = P(b), dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, -(A[0] * dx + A[1] * dy) / L2)) : 0;
      consider(A[0] + t * dx, A[1] + t * dy);
    };
    var line = function (cs) { if (cs.length === 1) { var q = P(cs[0]); consider(q[0], q[1]); } for (var i = 1; i < cs.length; i++) seg(cs[i - 1], cs[i]); };
    var inside = false;
    var ring = function (r) { var ins = false; for (var i = 0, j = r.length - 1; i < r.length; j = i++) { var a = P(r[i]), b = P(r[j]); if ((a[1] > 0) !== (b[1] > 0) && 0 < (b[0] - a[0]) * (0 - a[1]) / (b[1] - a[1]) + a[0]) ins = !ins; } return ins; };
    var walk = function (g) {
      if (!g) return;
      var c = g.coordinates;
      if (g.type === 'Point') line([c]);
      else if (g.type === 'MultiPoint' || g.type === 'LineString') line(c);
      else if (g.type === 'MultiLineString') c.forEach(line);
      else if (g.type === 'Polygon') { c.forEach(line); if (ring(c[0]) && !c.slice(1).some(ring)) inside = true; }
      else if (g.type === 'MultiPolygon') c.forEach(function (poly) { poly.forEach(line); if (ring(poly[0]) && !poly.slice(1).some(ring)) inside = true; });
      else if (g.type === 'GeometryCollection') g.geometries.forEach(walk);
    };
    walk(g);
    if (!best) return null;
    if (inside) { best.d = 0; best.inside = true; best.p = from; }
    return best;
  }
  function boundsOf(g) {
    var b = null, add = function (c) { var ll = L.latLng(c[1], c[0]); if (!b) b = L.latLngBounds(ll, ll); else b.extend(ll); };
    var walk = function (x) { if (!x) return; if (typeof x[0] === 'number') add(x); else x.forEach(walk); };
    if (g.type === 'GeometryCollection') g.geometries.forEach(function (h) { walk(h.coordinates); }); else walk(g.coordinates);
    return b;
  }
  function fmtCoords(p) { return { ll: p[1].toFixed(6) + ', ' + p[0].toFixed(6), mga: Geo.fmt(p, 'mga') }; }

  // ---------- small dialogs ----------
  function noteEditor(title, text) {
    return new Promise(function (res) {
      var done = false;
      GC.modal('<h2>' + esc(title) + '</h2><textarea id="nt-in" rows="5" placeholder="What did you see? Condition, measurements, who to tell…">' + esc(text || '') + '</textarea>' +
        '<div class="actions"><button class="btn" data-a="no">Cancel</button><button class="btn primary" data-a="yes">Save note</button></div>',
        function (el, close) {
          var t = el.querySelector('#nt-in');
          el.querySelector('[data-a=no]').onclick = close;
          el.querySelector('[data-a=yes]').onclick = function () { done = true; var v = t.value.trim(); close(); res(v); };
          setTimeout(function () { t.focus(); }, 50);
        }, function () { if (!done) res(null); });
    });
  }
  function copy(text) {
    var ok = function () { GC.toast('Copied: ' + text); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, function () { manual(text); });
    else manual(text);
  }
  function manual(text) { GC.prompt('Copy this', text, '', 'Done'); }

  /** Drops a waypoint (for things that can't hold a photo or note themselves, e.g. a lot or a geology unit). */
  function pin(name, p, extra) {
    var ls = GC.project.layers, l = ls.filter(function (x) { return x.kind === 'waypoints'; }).pop();
    if (!l) { l = { id: global.Ink.uid(), name: 'Waypoints', kind: 'waypoints', visible: true, opacity: 1, locked: false, color: '#e8590c', waypoints: [], created: Date.now() }; GC.insertLayer(l, true); }
    var w = Object.assign({ lat: p[1], lon: p[0], time: Date.now(), name: name }, extra || {});
    l.waypoints.push(w); GC.renderLayer(l); GC.applyLayerState(); GC.markDirty(l.id, true); GC.refreshLayers();
    return { l: l, w: w };
  }

  // ---------- the card ----------
  var cur = null, hl = null;
  function clearHl() { if (hl) { map.removeLayer(hl); hl = null; } }
  function close() { if (cur && cur.shell.isOpen()) cur.shell.close(); clearHl(); }
  // On phones the card is a bottom sheet (the map stays visible above it); elsewhere a balloon on the map.
  var sheetEl = null, sheetGone = null;
  function sheetShell(root, ll, onRemove) {
    if (!sheetEl) {
      sheetEl = document.createElement('div'); sheetEl.id = 'card-sheet'; sheetEl.hidden = true;
      sheetEl.innerHTML = '<div class="cs-grab"></div><button class="cs-x" aria-label="Close">&times;</button><div class="cs-body"></div>';
      document.body.appendChild(sheetEl);
      sheetEl.querySelector('.cs-x').onclick = function () { close(); };
      var y0 = null; // swipe down to close
      sheetEl.addEventListener('touchstart', function (e) { y0 = sheetEl.querySelector('.cs-body').scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
      sheetEl.addEventListener('touchend', function (e) { if (y0 != null && e.changedTouches[0].clientY - y0 > 70) close(); y0 = null; }, { passive: true });
    }
    if (sheetGone) { var g = sheetGone; sheetGone = null; g(); }
    var open = true, body = sheetEl.querySelector('.cs-body');
    body.innerHTML = ''; body.scrollTop = 0; body.appendChild(root); sheetEl.hidden = false;
    var me = {
      isOpen: function () { return open; },
      close: function () { if (!open) return; open = false; sheetGone = null; sheetEl.hidden = true; body.innerHTML = ''; onRemove(); },
      refit: function () {}
    };
    sheetGone = function () { open = false; onRemove(); };
    // keep the place visible above the sheet
    setTimeout(function () {
      if (!open) return;
      var sz = map.getSize(), r = sheetEl.getBoundingClientRect(), mr = map.getContainer().getBoundingClientRect(), pt = map.latLngToContainerPoint(ll), want;
      if (r.left - mr.left > sz.x * 0.3) { // docked on the right (phone held sideways): keep the place in the left part
        want = L.point((r.left - mr.left) / 2, sz.y / 2);
        if (pt.x > r.left - mr.left - 30 || pt.x < 20 || pt.y < 70 || pt.y > sz.y - 80) map.panBy(pt.subtract(want), { animate: true });
      } else { // along the bottom: keep it above the sheet
        want = L.point(sz.x / 2, Math.max(90, (r.top - mr.top) / 2 + 20));
        if (pt.y > r.top - mr.top - 20 || pt.y < 80 || pt.x < 20 || pt.x > sz.x - 20) map.panBy(pt.subtract(want), { animate: true });
      }
    }, 60);
    return me;
  }
  function popupShell(pop) {
    return { isOpen: function () { return map.hasLayer(pop); }, close: function () { map.closePopup(pop); }, refit: function () { if (!map.hasLayer(pop)) return; pop._updateLayout(); pop._updatePosition(); pop._adjustPan(); } };
  }
  var ICON = { go: '<path d="M12 3 20 20 12 16 4 20z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    measure: '<use xlink:href="#i-ruler"/>', photo: '<use xlink:href="#i-camera"/>',
    note: '<path d="M5 4h10l4 4v12H5z M15 4v4h4 M8 12h8 M8 16h6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>',
    copy: '<use xlink:href="#i-copy"/>', more: '<use xlink:href="#i-more"/>' };
  function btn(a, label) { return '<button class="ca-b" data-a="' + a + '"><svg viewBox="0 0 24 24">' + ICON[a] + '</svg><span>' + label + '</span></button>'; }
  /**
   * Opens a card. spec: { ll (where it points), title, sub, body (HTML string or element), target (GeoJSON geometry for Go,
   * default the point), at ([lon, lat] for Copy, default ll), photos {refs, onChange} | null, note {text, save(text)} | null,
   * more [{label, fn, danger}], zoom (bounds), highlight (GeoJSON), onClose, onSize (popup re-layout hook) }.
   */
  function open(spec) {
    close();
    if (GC.measure && GC.measure.isOn()) GC.measure.close();
    var sz = map.getSize(), side = document.body.classList.contains('no-sidebar') ? 0 : 350;
    var maxW = spec.maxW || Math.max(240, Math.min(560, sz.x - side - 110));
    var ll = L.latLng(spec.ll), at = spec.at || [ll.lng, ll.lat], target = spec.target || { type: 'Point', coordinates: at };
    var nm = function () { return spec.name || spec.title || 'this place'; };
    var root = document.createElement('div'); root.className = 'gc-card';
    root.innerHTML = (spec.title && !spec.hideTitle ? '<div class="gb-title">' + esc(spec.title) + '</div>' : '') + (spec.sub ? '<div class="gc-sub">' + esc(spec.sub) + '</div>' : '') +
      '<div class="gc-body"></div><div class="gc-note" hidden></div><div class="gb-photos"></div>' +
      '<div class="gc-acts">' + btn('go', 'Go') + btn('measure', 'Measure') + btn('photo', 'Photo') + btn('note', 'Note') + btn('copy', 'Copy') + btn('more', 'More') + '</div>' +
      '<div class="gc-panel" hidden></div>';
    var body = root.querySelector('.gc-body');
    if (spec.body) { if (typeof spec.body === 'string') body.innerHTML = spec.body; else body.appendChild(spec.body); }
    var pop = L.popup({ className: 'gc-balloon', maxWidth: maxW + 40, minWidth: 260, maxHeight: Math.round(sz.y * 0.66), autoPanPaddingTopLeft: L.point(side + 20, 140), autoPanPaddingBottomRight: L.point(30, 70) });
    var phone = document.body.classList.contains('phone'), shell = null;
    var refit = function () { if (shell) shell.refit(); };
    var me = cur = { pop: phone ? null : pop, root: root, refit: refit, spec: spec };
    root.addEventListener('load', function () { refit(); }, true); // pictures arriving later (photo, balloon images) grow the card
    // photos and note
    var paintPhotos = function () {
      var box = root.querySelector('.gb-photos');
      if (!spec.photos || !(spec.photos.refs || []).length && !spec.photos.onChange) { box.innerHTML = ''; return; }
      var refs = spec.photos.refs || [];
      GC.photos.strip(box, refs, spec.photos.onChange ? { onAdd: addPhoto, onChange: function (left) { spec.photos.refs = left; spec.photos.onChange(left); paintPhotos(); } } : {});
      [].forEach.call(box.querySelectorAll('img'), function (im) { im.addEventListener('load', refit); });
      setTimeout(refit, 250);
    };
    var paintNote = function () { var n = root.querySelector('.gc-note'), t = spec.note && spec.note.text; n.hidden = !t; n.textContent = t || ''; refit(); };
    var addPhoto = function () {
      GC.photos.pick().then(function (more) {
        if (!more.length) return;
        if (spec.photos && spec.photos.onChange) { spec.photos.refs = (spec.photos.refs || []).concat(more); spec.photos.onChange(spec.photos.refs); paintPhotos(); }
        else { var r = pin(nm(), at, { photos: more }); GC.toast('Photo pinned here as waypoint “' + r.w.name + '”.'); }
      });
    };
    paintPhotos(); paintNote();
    var panel = root.querySelector('.gc-panel');
    var togglePanel = function (kind, html, bind) {
      if (!panel.hidden && panel.getAttribute('data-k') === kind) { panel.hidden = true; refit(); return; }
      panel.setAttribute('data-k', kind); panel.innerHTML = html; panel.hidden = false; bind(panel); refit();
    };
    var q = function (a) { return root.querySelector('[data-a=' + a + ']'); };
    q('go').onclick = function () { nav.go({ name: nm(), geometry: target }); };
    q('measure').onclick = function () {
      var start = target.type === 'Point' ? target.coordinates : at;
      shell.close();
      GC.measure.open(); GC.measure.click({ latlng: L.latLng(start[1], start[0]) });
      GC.toast('Measuring from “' + nm() + '”: tap the next points.');
    };
    q('photo').onclick = addPhoto;
    q('note').onclick = function () {
      var has = spec.note && spec.note.save;
      noteEditor(has ? 'Note · ' + nm() : 'Pin a note here', has ? spec.note.text : '').then(function (t) {
        if (t == null) return;
        if (has) { spec.note.text = t; spec.note.save(t); if (shell.isOpen()) paintNote(); GC.toast(t ? 'Note saved.' : 'Note removed.'); }
        else if (t) { var r = pin(nm(), at, { note: t }); GC.toast('Note pinned here as waypoint “' + r.w.name + '”.'); }
      });
    };
    q('copy').onclick = function () {
      var c = fmtCoords(at);
      togglePanel('copy', '<div class="gc-copy"><button data-c="ll"><small>Lat, long</small><b>' + esc(c.ll) + '</b></button><button data-c="mga"><small>MGA2020</small><b>' + esc(c.mga) + '</b></button></div>' +
        (target.type !== 'Point' ? '<p class="gc-hint">Coordinates of where you tapped.</p>' : ''), function (p) {
        [].forEach.call(p.querySelectorAll('[data-c]'), function (b) { b.onclick = function () { copy(c[b.getAttribute('data-c')]); }; });
      });
    };
    q('more').onclick = function () {
      var acts = (spec.zoom ? [{ label: 'Zoom to', fn: function () { var b = spec.zoom; if (b.getNorthEast().equals(b.getSouthWest())) map.setView(b.getCenter(), Math.max(map.getZoom(), 18)); else map.fitBounds(b, { padding: [80, 80], maxZoom: 19 }); } }] : []).concat(spec.more || []);
      togglePanel('more', '<div class="gc-more">' + acts.map(function (a, i) { return '<button class="btn' + (a.danger ? ' danger' : '') + '" data-i="' + i + '">' + esc(a.label) + '</button>'; }).join('') + (acts.length ? '' : '<span class="gc-hint">Nothing else for this one.</span>') + '</div>', function (p) {
        [].forEach.call(p.querySelectorAll('[data-i]'), function (b) { b.onclick = function () { acts[+b.getAttribute('data-i')].fn(); }; });
      });
    };
    clearHl();
    if (spec.highlight) hl = L.geoJSON(spec.highlight, { interactive: false, style: { color: '#ffff00', weight: 5, opacity: 0.9, fillOpacity: 0.1, fillColor: '#ffff00' }, pointToLayer: function (f, p) { return L.circleMarker(p, { radius: 11, color: '#ffff00', weight: 3, fill: false, interactive: false }); } }).addTo(map);
    var gone = function () { if (cur === me) { cur = null; clearHl(); } if (spec.onClose) spec.onClose(); };
    if (phone) { map.closePopup(); shell = sheetShell(root, ll, gone); }
    else { shell = popupShell(pop); pop.on('remove', gone); pop.setLatLng(ll).setContent(root).openOn(map); }
    me.shell = shell;
    me.refit = refit; me.paintPhotos = paintPhotos;
    return me;
  }

  // ---------- Go: guidance from your GPS position ----------
  var nav = (function () {
    var N = null, ARRIVE = 5;
    var CARD = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    function bar() {
      var b = $('nav-bar');
      if (!b) {
        b = document.createElement('div'); b.id = 'nav-bar'; b.className = 'panel';
        b.innerHTML = '<div class="nv-arrow" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3 19 20 12 16 5 20z" fill="currentColor"/></svg></div>' +
          '<div class="nv-txt"><div class="nv-to"></div><div class="nv-dist"></div><div class="nv-dir"></div></div>' +
          '<div class="nv-btns"><button class="btn" data-a="both">Show both</button><button class="btn" data-a="stop">Stop</button></div>';
        document.body.appendChild(b);
        b.querySelector('[data-a=stop]').onclick = stop;
        b.querySelector('[data-a=both]').onclick = function () { fit(true); };
      }
      return b;
    }
    function go(t) {
      stop();
      N = { name: t.name, g: t.geometry, arrived: false, fitted: false, line: null, ring: null };
      var b = bar(); b.hidden = false; b.className = 'panel'; document.body.classList.add('nav-on');
      b.querySelector('.nv-to').textContent = 'Going to ' + t.name;
      if (GC.gps) { GC.gps.start(); GC.gps.compass(); }
      update();
      N.timer = setInterval(update, 1000);
      if (GC.closeInspector) GC.closeInspector();
    }
    function fit(force) {
      if (!N) return;
      var f = GC.gps && GC.gps.fix(), b = boundsOf(N.g);
      if (f) b = b ? b.extend([f.lat, f.lon]) : L.latLngBounds([f.lat, f.lon], [f.lat, f.lon]);
      if (b && (force || !N.fitted)) { N.fitted = true; map.fitBounds(b, { padding: [90, 90], maxZoom: 19 }); }
    }
    function update() {
      if (!N) return;
      var b = bar(), f = GC.gps && GC.gps.fix(), fresh = f && Date.now() - f.t < 30000;
      var dist = b.querySelector('.nv-dist'), dir = b.querySelector('.nv-dir'), arrow = b.querySelector('.nv-arrow');
      if (!fresh) { dist.textContent = 'Waiting for GPS…'; dir.textContent = 'Go outside with a clear view of the sky.'; arrow.style.transform = ''; return; }
      var me = [f.lon, f.lat], np = nearest(N.g, me); if (!np) return;
      var d = np.d, brg = Geo.bearing(me, np.p), heading = GC.gps.heading();
      if (heading == null && f.heading != null && !isNaN(f.heading) && f.speed > 0.6) heading = f.heading;
      if (!N.ring) N.ring = L.circleMarker([np.p[1], np.p[0]], { radius: 10, color: '#e8590c', weight: 3, fill: false, interactive: false }).addTo(map);
      N.ring.setLatLng([np.p[1], np.p[0]]);
      if (!N.line) N.line = L.polyline([], { color: '#e8590c', weight: 3, dashArray: '8 7', interactive: false }).addTo(map);
      N.line.setLatLngs([[f.lat, f.lon], [np.p[1], np.p[0]]]);
      if (!N.fitted) fit(false);
      var here = d <= ARRIVE || !!np.inside;
      dist.textContent = np.inside ? 'You’re inside it' : here ? 'You’re there · ' + Math.round(d) + ' m' : GC.fmtDist(d);
      var card = CARD[Math.round(brg / 22.5) % 16], rel = heading != null ? ((brg - heading + 540) % 360) - 180 : null;
      var turn = '';
      if (rel != null) { var a = Math.abs(rel), side = rel > 0 ? 'right' : 'left'; turn = a <= 15 ? ' · straight ahead' : a <= 60 ? ' · ahead-' + side : a <= 110 ? ' · to your ' + side : a < 160 ? ' · behind-' + side : ' · behind you'; }
      dir.textContent = here ? 'Within ' + ARRIVE + ' m' + (f.acc > ARRIVE ? ' (GPS ±' + Math.round(f.acc) + ' m)' : '') : 'Bearing ' + Math.round(brg) + '° ' + card + turn + (f.acc > 15 ? ' · GPS ±' + Math.round(f.acc) + ' m' : '');
      arrow.style.transform = 'rotate(' + Math.round(rel != null ? rel : brg) + 'deg)';
      b.classList.toggle('here', here);
      if (here && !N.arrived) { N.arrived = true; if (navigator.vibrate) navigator.vibrate([200, 100, 200]); GC.toast('You’re at ' + N.name + '.'); }
      if (!here && d > ARRIVE * 2) N.arrived = false;
    }
    function stop() {
      if (!N) return;
      clearInterval(N.timer);
      if (N.line) map.removeLayer(N.line); if (N.ring) map.removeLayer(N.ring);
      N = null; var b = $('nav-bar'); if (b) b.hidden = true; document.body.classList.remove('nav-on');
    }
    return { go: go, stop: stop, update: update, isOn: function () { return !!N; }, nearest: nearest };
  })();

  // ---------- searching your own data ----------
  function featureText(l, f) {
    var p = f.properties || {}, out = [];
    Object.keys(p).forEach(function (k) { var v = p[k]; if (v != null && typeof v !== 'object' && !/^(stroke|fill|marker-|styleUrl|icon|label-)/.test(k)) out.push(String(v)); else if (k === 'description' && v && v.value) out.push(String(v.value)); });
    return out.join(' ').replace(/<[^>]+>/g, ' ');
  }
  /** Things in the open project matching the text: [{name, sub, score, open(), target}]. */
  function find(text) {
    var words = String(text || '').toLowerCase().split(/\s+/).filter(Boolean); if (!words.length || !GC.project) return [];
    var res = [], all = function (h) { h = h.toLowerCase(); return words.every(function (w) { return h.indexOf(w) >= 0; }); };
    var score = function (name, rest) {
      var n = String(name || '').toLowerCase(), q = words.join(' ');
      if (n === q) return 100; if (n.indexOf(q) === 0) return 85; if (all(n)) return 70; if (all(n + ' ' + rest)) return 40; return 0;
    };
    GC.project.layers.forEach(function (l) {
      if (l.kind === 'vector') {
        // folder path of each feature, so "thrust block 13" finds PHW-TB-013 in "Thrust Block Register"
        var path = {};
        if (l.tree) (function walk(nodes, p) { nodes.forEach(function (nd) { if (typeof nd === 'number') path[nd] = p; else walk(nd.c || [], p.concat(nd.n)); }); })(l.tree, []);
        (l.geojson.features || []).forEach(function (f, i) {
        var name = GC.featName(l, i), fp = path[i] || [], s = score(name, featureText(l, f) + ' ' + fp.join(' ')); if (!s || !f.geometry) return;
        res.push({ name: name, sub: (fp.length ? fp[fp.length - 1] : l.name) + (l.visible ? '' : ' (hidden layer)'), score: s, target: f.geometry, open: function () { if (!l.visible) { l.visible = true; GC.applyLayerState(); GC.refreshLayers(); GC.markDirty(l.id); } GC.showFeature(l, i); } });
      });
      }
      else if (l.kind === 'drawing') (l.items || []).forEach(function (el) {
        if (el.type !== 'marker' && el.type !== 'text') return;
        var name = el.type === 'text' ? el.text : (el.title || 'Marker'), s = score(name, el.note || ''); if (!s) return;
        res.push({ name: name, sub: l.name + ' · ' + (el.type === 'text' ? 'text' : 'marker'), score: s, target: { type: 'Point', coordinates: el.at }, open: function () { map.setView([el.at[1], el.at[0]], Math.max(map.getZoom(), 18)); GC.inspectItem(l, el, L.latLng(el.at[1], el.at[0])); } });
      });
      else if (l.kind === 'waypoints') (l.waypoints || []).forEach(function (w) {
        var s = score(w.name, (w.note || '') + (GC.camera && GC.camera.isPhotoPt(l, w) ? ' ' + GC.camera.label(l, w) + (w.chk ? ' checked' : ' to-check unchecked') : '')); if (!s) return; // no "photo": its "to" would match "to check"
        res.push({ name: w.name || 'Waypoint', sub: l.name + ' · ' + (GC.camera && GC.camera.isPhotoPt(l, w) ? GC.camera.label(l, w) : 'waypoint'), score: s, target: w.geom || { type: 'Point', coordinates: [w.lon, w.lat] }, open: function () { map.setView([w.lat, w.lon], Math.max(map.getZoom(), 18)); GC.inspectWaypoint(l, w); } });
      });
      else if (l.kind === 'track') (l.tracks || []).forEach(function (t) {
        var s = score(t.name, ''); if (!s || !t.points.length) return;
        var g = { type: 'LineString', coordinates: t.points.map(function (p) { return [p[0], p[1]]; }) };
        res.push({ name: t.name, sub: l.name + ' · GPS track', score: s, target: g, open: function () { map.fitBounds(boundsOf(g), { padding: [60, 60] }); GC.inspectTrack(l, t); } });
      });
    });
    res.sort(function (a, b) { return b.score - a.score || a.name.length - b.name.length; });
    return res.slice(0, 40);
  }

  GC.card = { open: open, close: close, pin: pin, current: function () { return cur; }, boundsOf: boundsOf };
  GC.nav = nav;
  GC.findInProject = find;
})(window);
